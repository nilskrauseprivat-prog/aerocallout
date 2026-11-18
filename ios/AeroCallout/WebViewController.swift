import UIKit
import WebKit
import UserNotifications
import CoreLocation

/// Hosts the AeroCallout web app (bundled in the app) and connects it to the native services.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var web: WKWebView!
    private var ticker: Timer?
    private var monitoring = false
    private var lastFix: (CLLocation, [String: Any])?

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(SchemeHandler(), forURLScheme: SchemeHandler.scheme)
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.websiteDataStore = .default()
        let ucc = WKUserContentController()
        if let url = Bundle.main.url(forResource: "bridge", withExtension: "js"),
           let src = try? String(contentsOf: url) {
            ucc.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        ucc.add(self, name: "ac")
        cfg.userContentController = ucc

        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }   // remote debugging (Safari / pymobiledevice3)
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        Speech.shared.onEvent = { [weak self] id, type, err in
            DispatchQueue.main.async { self?.js("window.__ttsEvent && window.__ttsEvent(\(Self.q(id)),\(Self.q(type)),\(Self.q(err)))") }
        }
        Location.shared.onFix = { [weak self] loc, fix in
            BackgroundWarner.shared.update(loc)
            self?.lastFix = (loc, fix)
            // The page is suspended in the background: calls would pile up and run all at once on return.
            guard UIApplication.shared.applicationState != .background else { return }
            self?.js("window.__gpsFix && window.__gpsFix(\(Self.json(fix)))")
        }
        Motion.shared.onSample = { [weak self] o in
            guard UIApplication.shared.applicationState != .background else { return }
            self?.js("window.__imu && window.__imu(\(Self.json(o)))")
        }

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)

        web.load(URLRequest(url: SchemeHandler.startURL))
    }

    // MARK: - lifecycle: background warner

    private var snapshot: [String: Any] = [:]

    @objc private func willResignActive() {
        // Last chance to read the settings before iOS suspends the page.
        web.evaluateJavaScript("window.__acSnapshot ? window.__acSnapshot() : '{}'") { [weak self] r, _ in
            if let s = r as? String, let d = s.data(using: .utf8),
               let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { self?.snapshot = o }
        }
    }

    @objc private func didEnterBackground() {
        guard monitoring else { return }
        // Give the snapshot request a moment, then take over.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self = self, UIApplication.shared.applicationState == .background else { return }
            BackgroundWarner.shared.start(config: self.snapshot)
        }
    }

    @objc private func willEnterForeground() {
        BackgroundWarner.shared.stop()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        // Hand the page the current position first, otherwise its last fix is as old as the time in the
        // background and it announces "GPS position lost" (Android keeps the page running, iOS does not).
        if let last = lastFix, Date().timeIntervalSince(last.0.timestamp) < 3 {
            js("window.__gpsFix && window.__gpsFix(\(Self.json(last.1)))")
        }
        js("window.AC && AC.App && AC.App.tick && AC.App.tick()")
    }

    // MARK: - JavaScript helpers

    private func js(_ s: String) {
        if Thread.isMainThread { web?.evaluateJavaScript(s, completionHandler: nil) }
        else { DispatchQueue.main.async { self.web?.evaluateJavaScript(s, completionHandler: nil) } }
    }

    static func json(_ o: Any) -> String {
        guard JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o) else { return "null" }
        return String(data: d, encoding: .utf8) ?? "null"
    }

    static func q(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let a = String(data: d, encoding: .utf8) ?? "[\"\"]"
        return String(a.dropFirst().dropLast())
    }

    // MARK: - bridge: calls without result

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let obj = m["o"] as? String, let method = m["m"] as? String else { return }
        let args = m["a"] as? [Any] ?? []
        switch (obj, method) {
        case ("tts", "stop"): Speech.shared.stop()
        case ("gps", "start"): Location.shared.start()
        case ("gps", "stop"): Location.shared.stop()
        case ("sensors", "start"): Motion.shared.start()
        case ("sensors", "stop"): Motion.shared.stop()
        case ("power", "startTicker"): startTicker()
        case ("power", "startMonitoring"): monitoring = true; Location.shared.setBackground(true)
        case ("power", "stopMonitoring"): monitoring = false; Location.shared.setBackground(false); BackgroundWarner.shared.stop()
        case ("power", "setKeepScreenOn"): UIApplication.shared.isIdleTimerDisabled = (args.first as? Bool) ?? false
        case ("power", "wake"): wake((args.first as? String) ?? "")
        default: break
        }
    }

    private func startTicker() {
        guard ticker == nil else { return }
        var n = 0
        ticker = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.js("window.AC && AC.App && AC.App.tick && AC.App.tick()")
            n += 1
            // settings for the background warner, kept current while the page runs
            if n % 10 == 0 && UIApplication.shared.applicationState == .active { self.willResignActive() }
        }
    }

    /// iOS cannot switch the screen on: a notification is shown instead (the callout is spoken anyway).
    private func wake(_ text: String) {
        guard UIApplication.shared.applicationState != .active, !text.isEmpty else { return }
        let c = UNMutableNotificationContent()
        c.title = "AeroCallout"
        c.body = text
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "ac-alert", content: c, trigger: nil))
    }

    // MARK: - bridge: calls with result (synchronous prompt round trip)

    private func sync(_ payload: String) -> String {
        guard let d = payload.data(using: .utf8),
              let m = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let obj = m["o"] as? String, let method = m["m"] as? String else { return "" }
        let a = m["a"] as? [Any] ?? []
        func s(_ i: Int) -> String { i < a.count ? (a[i] as? String ?? "") : "" }
        func n(_ i: Int) -> Double { i < a.count ? ((a[i] as? NSNumber)?.doubleValue ?? 1) : 1 }
        switch (obj, method) {
        case ("tts", "ready"): return "true"
        case ("tts", "voices"): return Speech.shared.voicesJSON()
        case ("tts", "speak"):
            // While the native background warner speaks, the (possibly still running) page stays quiet.
            if BackgroundWarner.shared.active {
                let id = s(6)
                DispatchQueue.main.async { self.js("window.__ttsEvent && window.__ttsEvent(\(Self.q(id)),'done','')") }
                return "true"
            }
            return Speech.shared.speak(s(0), voiceName: s(1), lang: s(2), rate: n(3), pitch: n(4), volume: n(5), id: s(6)) ? "true" : "false"
        case ("gps", "status"): return Self.json(Location.shared.statusJSON())
        case ("sensors", "available"): return Self.json(Motion.shared.availableJSON())
        case ("power", "insets"):
            let i = view.safeAreaInsets
            return Self.json(["l": Int(i.left.rounded()), "r": Int(i.right.rounded()), "b": Int(i.bottom.rounded())])
        case ("power", "state"):
            let st = UIApplication.shared.applicationState
            return Self.json(["screenOn": st != .background, "locked": st == .background, "resumed": st == .active, "batteryExempt": true])
        default: return ""
        }
    }

    // MARK: - WKUIDelegate

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        if prompt.hasPrefix("__ac__") {
            completionHandler(sync(String(prompt.dropFirst(6))))
            return
        }
        let ac = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        ac.addTextField { $0.text = defaultText }
        ac.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completionHandler(nil) })
        ac.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(ac.textFields?.first?.text) })
        present(ac, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(ac, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let ac = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in completionHandler(false) })
        ac.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(ac, animated: true)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        if url?.scheme == SchemeHandler.scheme || action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)
        } else {
            if let u = url, action.navigationType == .linkActivated { UIApplication.shared.open(u) }
            decisionHandler(.cancel)                     // stay inside the app
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        js("window.__ttsEvent && window.__ttsEvent('','voices','')")
    }

    /// The page's process was ended by iOS (memory pressure): load it again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: SchemeHandler.startURL))
    }
}
