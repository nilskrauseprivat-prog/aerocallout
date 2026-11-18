import Foundation
import CoreLocation
import UserNotifications

/// Native traffic warner for the background.
///
/// iOS suspends the web page (and with it the normal AeroCallout logic) as soon as the app is no longer on screen
/// or the phone is locked. While the system is running, this class takes over: it fetches ADS-B traffic itself,
/// evaluates it with the same TCAS-style criteria as traffic-logic.js (straight-line prediction) and speaks the
/// callouts natively. When the app is back on screen, the web app continues as usual.
final class BackgroundWarner {
    static let shared = BackgroundWarner()

    private(set) var active = false
    private var cfg: [String: Any] = [:]
    private var timer: Timer?
    private var inflight = false
    private var source = 0
    private var fails = 0
    private var announced: [String: (level: Int, at: Date)] = [:]
    private var own: (lat: Double, lon: Double, gs: Double, trk: Double, altM: Double?, vs: Double, t: Date)?
    private var lastAlt: (alt: Double, t: Date)?
    private var lastDataOk = Date()
    private var lostAnnounced = false

    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 6
        c.timeoutIntervalForResource = 7
        c.httpAdditionalHeaders = ["User-Agent": "AeroCallout/0.3 (open-source traffic awareness; iOS background)"]
        return URLSession(configuration: c)
    }()

    // MARK: - control

    func start(config: [String: Any]) {
        cfg = config
        guard (cfg["phase"] as? String) == "run", (cfg["traffic"] as? Bool) ?? true, !((cfg["sim"] as? Bool) ?? false) else { return }
        active = true
        announced = [:]
        lastDataOk = Date()
        lostAnnounced = false
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.tick() }
        tick()
    }

    func stop() {
        active = false
        timer?.invalidate()
        timer = nil
    }

    /// Own position from the GNSS receiver (also called while the page is suspended).
    func update(_ l: CLLocation) {
        var alt: Double? = nil
        if l.verticalAccuracy >= 0 {
            if #available(iOS 15, *) { alt = l.ellipsoidalAltitude } else { alt = l.altitude + num("geoidM", 47) }
        }
        var vs = own?.vs ?? 0
        if let a = alt {
            if let p = lastAlt, l.timestamp.timeIntervalSince(p.t) > 0.5 {
                let raw = (a - p.alt) / l.timestamp.timeIntervalSince(p.t)
                vs = vs + (raw - vs) * 0.3
            }
            lastAlt = (a, l.timestamp)
        }
        own = (l.coordinate.latitude, l.coordinate.longitude, max(0, l.speed), l.course >= 0 ? l.course : (own?.trk ?? 0),
               alt, vs, l.timestamp)
    }

    // MARK: - settings helpers

    private func num(_ k: String, _ d: Double) -> Double { (cfg[k] as? NSNumber)?.doubleValue ?? d }
    private func str(_ k: String, _ d: String) -> String { (cfg[k] as? String) ?? d }
    private var de: Bool { str("lang", "en") == "de" }

    // MARK: - polling

    private func tick() {
        guard active, !inflight, let o = own, Date().timeIntervalSince(o.t) < 10 else { return }
        if Date().timeIntervalSince(lastDataOk) > 30 && !lostAnnounced {
            lostAnnounced = true
            say(de ? "Verkehrsdaten verloren." : "Traffic data lost.", notify: true)
        }
        let r = Int(max(10, min(num("radiusNM", 30), 60)))
        let la = String(format: "%.4f", o.lat), lo = String(format: "%.4f", o.lon)
        let urls = ["https://api.adsb.lol/v2/point/\(la)/\(lo)/\(r)",
                    "https://opendata.adsb.fi/api/v2/lat/\(la)/lon/\(lo)/dist/\(r)"]
        guard let url = URL(string: urls[source % 2]) else { return }
        inflight = true
        let t0 = Date()
        session.dataTask(with: url) { [weak self] data, resp, _ in
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            var list: [[String: Any]]? = nil
            if code == 200, let data = data,
               let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                list = (j["ac"] as? [[String: Any]]) ?? (j["aircraft"] as? [[String: Any]]) ?? []
            }
            let mid = t0.addingTimeInterval(Date().timeIntervalSince(t0) / 2)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.inflight = false
                guard let list = list else {
                    self.fails += 1
                    self.source += 1          // try the other source next time
                    return
                }
                self.fails = 0
                self.lastDataOk = Date()
                if self.lostAnnounced {
                    self.lostAnnounced = false
                    self.say(self.de ? "Verkehrsdaten wieder verfügbar." : "Traffic data restored.", notify: false)
                }
                self.evaluate(list, refTime: mid)
            }
        }.resume()
    }

    // MARK: - traffic logic (TCAS II TA criteria as in traffic-logic.js)

    private static let slTable: [Int: (taTau: Double, taDmod: Double, taZ: Double, wTau: Double, wDmod: Double, wZ: Double)] = [
        2: (20, 0.30, 850, 12, 0.15, 400), 3: (25, 0.33, 850, 15, 0.20, 600), 4: (30, 0.48, 850, 20, 0.35, 600),
        5: (40, 0.75, 850, 25, 0.55, 600), 6: (45, 1.00, 850, 30, 0.80, 600), 7: (48, 1.30, 850, 35, 1.10, 700),
    ]
    private static let NM = 1852.0, FT = 0.3048, KT = 0.514444

    private struct Hit {
        let hex: String; let level: Int; let r: Double; let clock: Int; let relAltFt: Double?; let closureKt: Double
    }

    private func evaluate(_ list: [[String: Any]], refTime: Date) {
        guard let o = own else { return }
        let airborne = o.gs >= num("minSpeedKt", 40) * BackgroundWarner.KT
        guard airborne else { return }

        let ownMSLft = o.altM.map { ($0 - num("geoidM", 47)) / BackgroundWarner.FT }
        var sl = 4
        let sens = str("sens", "auto")
        if sens.hasPrefix("sl"), let v = Int(sens.dropFirst(2)) { sl = v }
        else if let a = ownMSLft { sl = a < 1000 ? 2 : a < 2350 ? 3 : a < 5000 ? 4 : a < 10000 ? 5 : a < 20000 ? 6 : 7 }
        let base = BackgroundWarner.slTable[sl] ?? BackgroundWarner.slTable[4]!
        let gain = ["lo": 0.75, "norm": 1.0, "hi": 1.25, "max": 1.5][str("sensGain", "norm")] ?? 1
        let NM = BackgroundWarner.NM, FT = BackgroundWarner.FT, KT = BackgroundWarner.KT
        let taTau = base.taTau * gain, taDmod = base.taDmod * gain * NM, taZ = base.taZ * min(gain, 1.3)
        let wTau = base.wTau * gain, wHor = max(base.wDmod * NM, 250) * gain, wZ = base.wZ * min(gain, 1.3)
        let hmdTa = max(2.5 * base.taDmod * NM, 1000) * gain
        let ownHex = str("ownHex", "").lowercased()

        let cosLat = cos(o.lat * .pi / 180)
        let ovx = o.gs * sin(o.trk * .pi / 180), ovy = o.gs * cos(o.trk * .pi / 180)
        let ownAge = Date().timeIntervalSince(o.t)
        var hits: [Hit] = []

        for a in list {
            guard let lat = a["lat"] as? Double, let lon = a["lon"] as? Double else { continue }
            let hex = ((a["hex"] as? String) ?? "").lowercased()
            if hex.isEmpty || hex == ownHex { continue }
            if (a["alt_baro"] as? String) == "ground" { continue }
            let seen = (a["seen_pos"] as? Double) ?? (a["seen"] as? Double) ?? 0
            let age = Date().timeIntervalSince(refTime) + seen
            if age > 12 { continue }
            let gs = ((a["gs"] as? Double) ?? 0) * KT
            let trk = ((a["track"] as? Double) ?? (a["true_heading"] as? Double) ?? 0) * .pi / 180
            let tvx = gs * sin(trk), tvy = gs * cos(trk)
            // positions brought to "now" (straight line)
            let x = (lon - o.lon) * cosLat * 111_320 + tvx * age - ovx * ownAge
            let y = (lat - o.lat) * 110_540 + tvy * age - ovy * ownAge
            let r = (x * x + y * y).squareRoot()
            if r > 15 * NM { continue }

            var relAltFt: Double? = nil
            if let g = a["alt_geom"] as? Double, let oa = o.altM { relAltFt = g - oa / FT }
            else if let b = a["alt_baro"] as? Double, let m = ownMSLft { relAltFt = b - m }
            let tvs = ((a["geom_rate"] as? Double) ?? (a["baro_rate"] as? Double) ?? 0) / 60 // ft/s
            let hdot = tvs - o.vs / FT
            let altUnc = relAltFt == nil ? 0.0 : 175
            let unc = 60.0 + min(50, gs * 0.5)

            let rvx = tvx - ovx, rvy = tvy - ovy
            let v2 = rvx * rvx + rvy * rvy
            let rdot = (x * rvx + y * rvy) / max(r, 1)
            var tCpa = v2 > 0.01 ? -(x * rvx + y * rvy) / v2 : 0
            tCpa = max(0, min(tCpa, 60))
            let hx = x + rvx * tCpa, hy = y + rvy * tCpa
            let hmd = (hx * hx + hy * hy).squareRoot()
            let vsep = relAltFt.map { $0 + hdot * tCpa }
            func vOk(_ dz: Double?) -> Bool { dz == nil || abs(dz!) - altUnc < wZ }

            var warn = false
            if tCpa <= wTau && hmd - unc < wHor && vOk(vsep) { warn = true }
            else if r - unc < wHor && vOk(relAltFt) { warn = true }

            let rEff = max(0, r - unc)
            var rangeOk = rEff <= taDmod
            if !rangeOk && rdot < -0.5 && rEff > 0 {
                rangeOk = (taDmod * taDmod - rEff * rEff) / (rEff * rdot) <= taTau
            }
            var altOk = true
            if let ra = relAltFt {
                let hEff = max(0, abs(ra) - altUnc)
                altOk = hEff <= taZ || (ra * hdot < 0 && abs(hdot) > 0.01 && hEff / abs(hdot) <= taTau)
            }
            let hmdOk = rEff <= taDmod || hmd - unc < hmdTa

            var level = 0
            if warn && r < 5 * NM { level = 3 } else if rangeOk && altOk && hmdOk { level = 2 }
            if level == 0 { continue }

            var brg = atan2(x, y) * 180 / .pi
            brg = (brg - o.trk).truncatingRemainder(dividingBy: 360)
            if brg < 0 { brg += 360 }
            var clock = Int((brg / 30).rounded()) % 12
            if clock == 0 { clock = 12 }
            hits.append(Hit(hex: hex, level: level, r: r, clock: clock, relAltFt: relAltFt, closureKt: -rdot / KT))
        }

        // forget aircraft that are no longer a threat
        let now = Date()
        let current = Set(hits.map { $0.hex })
        announced = announced.filter { current.contains($0.key) || now.timeIntervalSince($0.value.at) < 20 }

        // announce the most important new / escalated threat
        let sorted = hits.sorted { $0.level != $1.level ? $0.level > $1.level : $0.r < $1.r }
        for h in sorted {
            if let prev = announced[h.hex], prev.level >= h.level, now.timeIntervalSince(prev.at) < 45 { continue }
            announced[h.hex] = (h.level, now)
            say(callout(h), notify: true)
            break
        }
    }

    private func callout(_ h: Hit) -> String {
        let km = str("distUnit", "nm") == "km"
        var parts: [String] = []
        parts.append(h.level == 3 ? (de ? "Verkehr! Verkehr!" : "Traffic! Traffic!") : (de ? "Verkehr!" : "Traffic!"))
        parts.append(de ? "\(h.clock) Uhr" : "\(h.clock) o'clock")
        if let ra = h.relAltFt {
            parts.append(abs(ra) < 300 ? (de ? "gleiche Höhe" : "same altitude") : ra > 0 ? (de ? "höher" : "high") : (de ? "tiefer" : "low"))
        }
        let d = km ? h.r / 1000 : h.r / BackgroundWarner.NM
        if d < 1 {
            parts.append(km ? (de ? "unter einem Kilometer" : "less than one kilometer") : (de ? "unter einer Meile" : "less than one mile"))
        } else {
            let n = Int(d.rounded())
            if km { parts.append(de ? (n == 1 ? "ein Kilometer" : "\(n) Kilometer") : (n == 1 ? "one kilometer" : "\(n) kilometers")) }
            else { parts.append(de ? (n == 1 ? "eine Meile" : "\(n) Meilen") : (n == 1 ? "one mile" : "\(n) miles")) }
        }
        if (cfg["closure"] as? Bool) ?? true, h.closureKt >= 40 {
            let kmh = str("speedUnit", "kt") == "kmh"
            let v = kmh ? h.closureKt * 1.852 : h.closureKt
            let n = Int((v / 10).rounded()) * 10
            parts.append(de ? "Annäherung \(n) \(kmh ? "Kilometer pro Stunde" : "Knoten")" : "closing \(n) \(kmh ? "kilometers per hour" : "knots")")
        }
        return parts.joined(separator: ", ")
    }

    // MARK: - output

    private func say(_ text: String, notify: Bool) {
        if !((cfg["muted"] as? Bool) ?? false) {
            Speech.shared.speak(text, lang: de ? "de-DE" : "en-US", rate: num("rate", 1.05), volume: num("volume", 1))
        }
        if notify {
            let c = UNMutableNotificationContent()
            c.title = "AeroCallout"
            c.body = text
            c.sound = nil      // the callout itself is the sound
            let req = UNNotificationRequest(identifier: "ac-alert", content: c, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        }
    }
}
