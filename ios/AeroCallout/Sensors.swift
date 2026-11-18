import Foundation
import CoreLocation
import CoreMotion

/// GNSS position + compass declination. Fixes are delivered in the same JSON format as the Android app.
final class Location: NSObject, CLLocationManagerDelegate {
    static let shared = Location()

    let manager = CLLocationManager()
    var onFix: ((CLLocation, [String: Any]) -> Void)?
    private(set) var wanted = false
    private(set) var last: CLLocation?
    private(set) var lastGoodFix: Date?
    private(set) var declination: Double?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .airborne
        manager.pausesLocationUpdatesAutomatically = false
        manager.headingFilter = 1
    }

    var authorized: Bool {
        let s = manager.authorizationStatus
        return s == .authorizedWhenInUse || s == .authorizedAlways
    }

    func start() {
        wanted = true
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
    }

    func stop() {
        wanted = false
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    /// Keep receiving positions with the screen locked / app in the background (blue status indicator).
    func setBackground(_ on: Bool) {
        manager.allowsBackgroundLocationUpdates = on
        manager.showsBackgroundLocationIndicator = on
    }

    func statusJSON() -> [String: Any] {
        [
            "permission": authorized,
            "gpsEnabled": CLLocationManager.locationServicesEnabled(),
            "networkEnabled": CLLocationManager.locationServicesEnabled(),
            "running": wanted,
            "lastGnssFixAgeMs": lastGoodFix.map { Int(Date().timeIntervalSince($0) * 1000) } ?? -1,
        ]
    }

    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        if wanted && authorized { m.startUpdatingLocation() }
    }

    func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for l in locations {
            guard l.horizontalAccuracy >= 0 else { continue }
            last = l
            // iOS does not tell which positions come from satellites: a good accuracy is taken as a GNSS fix.
            let gnss = l.horizontalAccuracy <= 40
            if gnss { lastGoodFix = Date() }
            var o: [String: Any] = [
                "lat": l.coordinate.latitude,
                "lon": l.coordinate.longitude,
                "acc": l.horizontalAccuracy,
                "t": Int64(l.timestamp.timeIntervalSince1970 * 1000),
                "provider": gnss ? "gnss" : "network",
            ]
            if l.verticalAccuracy >= 0 {
                if #available(iOS 15, *) { o["alt"] = l.ellipsoidalAltitude } else { o["alt"] = l.altitude + 47 }
                o["altAcc"] = l.verticalAccuracy
            }
            if l.speed >= 0 { o["speed"] = l.speed }
            if l.course >= 0 { o["bearing"] = l.course }
            onFix?(l, o)
        }
    }

    func locationManager(_ m: CLLocationManager, didUpdateHeading h: CLHeading) {
        guard h.headingAccuracy >= 0, h.trueHeading >= 0 else { return }
        var d = h.trueHeading - h.magneticHeading
        if d > 180 { d -= 360 }
        if d < -180 { d += 360 }
        declination = d
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) { }
}

/// Motion sensors, averaged and sent to the page at 20 Hz in the Android format (m/s², rad/s, rotation matrix).
final class Motion {
    static let shared = Motion()

    var onSample: (([String: Any]) -> Void)?
    private let mm = CMMotionManager()
    private let alt = CMAltimeter()
    private var timer: Timer?
    private var gSum = [0.0, 0.0, 0.0], aSum = [0.0, 0.0, 0.0]
    private var n = 0
    private var rm: [Double]?
    private var pressure: Double?
    private var lastPump: Date?
    private(set) var running = false

    func availableJSON() -> [String: Any] {
        [
            "gyro": mm.isGyroAvailable, "gyroRaw": false, "accel": mm.isAccelerometerAvailable,
            "mag": mm.isMagnetometerAvailable && mm.isDeviceMotionAvailable,
            "baro": CMAltimeter.isRelativeAltitudeAvailable(),
        ]
    }

    func start() {
        if running { return }
        running = true
        mm.deviceMotionUpdateInterval = 1.0 / 50
        let frames = CMMotionManager.availableAttitudeReferenceFrames()
        let frame: CMAttitudeReferenceFrame = frames.contains(.xMagneticNorthZVertical) ? .xMagneticNorthZVertical : .xArbitraryCorrectedZVertical
        mm.startDeviceMotionUpdates(using: frame, to: .main) { [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            let gr = dm.gravity, ua = dm.userAcceleration, rr = dm.rotationRate
            // iOS: acceleration in g, pointing opposite to Android's convention.
            let k = -9.80665
            self.aSum[0] += (gr.x + ua.x) * k; self.aSum[1] += (gr.y + ua.y) * k; self.aSum[2] += (gr.z + ua.z) * k
            self.gSum[0] += rr.x; self.gSum[1] += rr.y; self.gSum[2] += rr.z
            self.n += 1
            // Rotation matrix device -> (east, north, up) like Android's SensorManager.getRotationMatrix().
            let mf = dm.magneticField
            if mf.accuracy != .uncalibrated {
                let A = Motion.unit([-gr.x, -gr.y, -gr.z])
                let E = [mf.field.x, mf.field.y, mf.field.z]
                let H = Motion.unit(Motion.cross(E, A))
                if !H.isEmpty && !A.isEmpty {
                    let M = Motion.cross(A, H)
                    self.rm = [H[0], H[1], H[2], M[0], M[1], M[2], A[0], A[1], A[2]]
                }
            }
        }
        if CMAltimeter.isRelativeAltitudeAvailable() {
            alt.startRelativeAltitudeUpdates(to: .main) { [weak self] d, _ in
                if let d = d { self?.pressure = d.pressure.doubleValue * 10 }   // kPa -> hPa
            }
        }
        lastPump = nil
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.pump() }
    }

    func stop() {
        running = false
        mm.stopDeviceMotionUpdates()
        alt.stopRelativeAltitudeUpdates()
        timer?.invalidate()
        timer = nil
    }

    private func pump() {
        let now = Date()
        var o: [String: Any] = ["dt": lastPump.map { now.timeIntervalSince($0) } ?? 0.05,
                                "gb": [0.0, 0.0, 0.0], "t": Int64(now.timeIntervalSince1970 * 1000)]
        if n > 0 {
            let d = Double(n)
            o["g"] = gSum.map { $0 / d }
            o["a"] = aSum.map { $0 / d }
        }
        if let rm = rm { o["rm"] = rm }
        if let p = pressure { o["p"] = p }
        if let decl = Location.shared.declination { o["decl"] = decl }
        gSum = [0, 0, 0]; aSum = [0, 0, 0]; n = 0
        lastPump = now
        onSample?(o)
    }

    static func cross(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    }

    static func unit(_ v: [Double]) -> [Double] {
        let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).squareRoot()
        return l < 1e-6 ? [] : v.map { $0 / l }
    }
}
