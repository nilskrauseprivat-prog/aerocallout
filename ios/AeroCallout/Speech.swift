import Foundation
import AVFoundation

/// Native text to speech (iOS voices, offline). Used by the web app through window.AndroidTTS
/// and by the background warner directly.
final class Speech: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = Speech()

    /// (utterance id, "start" | "done" | "error", error text) -> forwarded to the page
    var onEvent: ((String, String, String) -> Void)?

    private let synth = AVSpeechSynthesizer()
    private var ids: [ObjectIdentifier: String] = [:]
    private var deactivate: DispatchWorkItem?

    override init() {
        super.init()
        synth.delegate = self
    }

    /// English and German voices; name is unique ("Daniel (en-GB)"), the best quality first.
    func voices() -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") || $0.language.hasPrefix("de") }
            .sorted { $0.quality.rawValue > $1.quality.rawValue }
    }

    static func displayName(_ v: AVSpeechSynthesisVoice) -> String { "\(v.name) (\(v.language))" }

    func voicesJSON() -> String {
        var seen = Set<String>()
        var arr: [[String: Any]] = []
        for v in voices() {
            let n = Speech.displayName(v)
            if seen.contains(n) { continue }
            seen.insert(n)
            arr.append(["name": n, "lang": v.language, "network": false])
        }
        let d = (try? JSONSerialization.data(withJSONObject: arr)) ?? Data("[]".utf8)
        return String(data: d, encoding: .utf8) ?? "[]"
    }

    /// Speak (replaces anything still being spoken). rate/pitch/volume like the Web Speech API (1 = normal).
    @discardableResult
    func speak(_ text: String, voiceName: String = "", lang: String = "", rate: Double = 1, pitch: Double = 1,
               volume: Double = 1, id: String = "") -> Bool {
        let u = AVSpeechUtterance(string: text)
        if !voiceName.isEmpty, let v = voices().first(where: { Speech.displayName($0) == voiceName || $0.name == voiceName }) {
            u.voice = v
        } else if !lang.isEmpty {
            u.voice = voices().first(where: { $0.language.lowercased().hasPrefix(lang.lowercased()) })
                ?? AVSpeechSynthesisVoice(language: lang)
        }
        let r = AVSpeechUtteranceDefaultSpeechRate * Float(max(0.3, min(rate, 2.5)))
        u.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(r, AVSpeechUtteranceMaximumSpeechRate))
        u.pitchMultiplier = Float(max(0.5, min(pitch, 2)))
        u.volume = Float(max(0, min(volume, 1)))
        u.preUtteranceDelay = 0
        deactivate?.cancel()
        try? AVAudioSession.sharedInstance().setActive(true)
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        if !id.isEmpty { ids[ObjectIdentifier(u)] = id }
        synth.speak(u)
        return true
    }

    func stop() {
        synth.stopSpeaking(at: .immediate)
    }

    var isSpeaking: Bool { synth.isSpeaking }

    // MARK: - delegate

    private func event(_ u: AVSpeechUtterance, _ type: String, _ err: String = "", remove: Bool) {
        let key = ObjectIdentifier(u)
        guard let id = ids[key] else { return }
        if remove { ids.removeValue(forKey: key) }
        onEvent?(id, type, err)
    }

    /// Give the audio back to music etc. shortly after the last callout.
    private func releaseAudioSoon() {
        deactivate?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, !self.synth.isSpeaking else { return }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        deactivate = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: w)
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        event(u, "start", remove: false)
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        event(u, "done", remove: true)
        releaseAudioSoon()
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        event(u, "error", "interrupted", remove: true)
        releaseAudioSoon()
    }
}
