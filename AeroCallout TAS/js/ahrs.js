/*
 * AeroCallout - attitude & heading reference (AHRS), barometer and dead reckoning using the phone sensors.
 *
 * Attitude filter (Mahony type complementary filter, body frame NED: x forward, y right, z down):
 *  - integrates the RAW gyro rates (bias-corrected by our own estimate)
 *  - roll/pitch corrected towards the accelerometer, with the centripetal acceleration of a turn removed
 *    using GPS ground speed (otherwise the horizon would level itself in a steady turn)
 *  - heading corrected towards the GPS track with HIGH priority when moving (> 12 m/s),
 *    towards the magnetic compass (+ declination) when slow, and gyro-only when neither is available
 *  - gyro drift (bias) estimation:
 *      * at standstill: the mean gyro output IS the bias (fast, all axes)
 *      * in flight: the integral terms of the accelerometer and GPS-track corrections continuously
 *        learn the remaining bias (incl. temperature drift), so that pure gyro operation drifts as little as possible
 * Phone mounting: a calibration (aircraft level, phone in its holder) determines the rotation phone -> aircraft.
 *
 * Dead reckoning: if the GPS position is lost, the position is propagated with the last ground speed along
 * the gyro heading (plus the last measured wind correction angle) and the barometric altitude change.
 * The uncertainty grows with time; alerts are inhibited after 20 s, DR ends after 60 s.
 */
(function (AC) {
  'use strict';
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, GRAV = 9.80665;

  // ---------------------------------------------------------------- small vector / matrix / quaternion helpers
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: (a) => Math.hypot(a[0], a[1], a[2]),
    unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
  };
  const M = {
    mulV: (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]],
    tMulV: (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]],
  };
  const Q = {
    mul: (a, b) => [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]],
    norm: (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; },
    // body -> NED rotation matrix (row-major)
    toM: (q) => {
      const [w, x, y, z] = q;
      return [
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    },
    fromEuler: (roll, pitch, yaw) => {
      const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
      const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
      return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
    },
    toEuler: (q) => {
      const [w, x, y, z] = q;
      const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
      const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
      const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
      return [roll, pitch, yaw];
    },
  };
  const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  const Ahrs = {
    available: false,       // sensors present (Android app)
    running: false,
    status: 'OFF',          // OFF | NO SENSORS | ALIGN | OK | GYRO ONLY
    q: [1, 0, 0, 0],
    bias: [0, 0, 0],        // body frame, rad/s
    biasSource: '-',
    aligned: false,
    roll: 0, pitch: 0, heading: 0, turnRate: 0,   // deg, deg, deg true, deg/s
    headingRef: '-',        // GPS / MAG / GYRO
    magHeading: null,       // deg true
    decl: 0,
    mount: null,            // phone -> body (row-major 3x3)
    pressure: null,         // hPa
    pressAltFt: null,       // pressure altitude (1013.25 hPa)
    baroVs: null,           // m/s
    stillTime: 0,
    lastImu: 0,
    _accLp: null,
    _gyroLp: null,
    _baro: null,

    start() {
      if (!window.AndroidSensors) { this.status = 'NO SENSORS'; this.available = false; return; }
      try {
        const av = JSON.parse(window.AndroidSensors.available());
        this.available = !!(av.gyro && av.accel);
        this.hasBaro = !!av.baro;
        this.hasMag = !!av.mag;
      } catch (e) { this.available = false; }
      if (!this.available) { this.status = 'NO SENSORS'; return; }
      this.mount = AC.settings.mount || null;
      this.status = 'ALIGN';
      this.aligned = false;
      this.running = true;
      window.__imu = (d) => this.onImu(d);
      window.AndroidSensors.start();
    },

    stop() {
      if (window.AndroidSensors) { try { window.AndroidSensors.stop(); } catch (e) { /* ignore */ } }
      this.running = false;
      this.status = 'OFF';
    },

    /** Calibrate the phone mounting: aircraft level (on ground or straight-and-level flight), phone in its holder. */
    calibrateMount() {
      const a = this._accLp;
      if (!a) return false;
      const down = V.unit(V.mul(a, -1));                     // gravity direction in phone coordinates
      let f = V.sub([0, 0, -1], V.mul(down, -down[2]));      // out of the back of the phone (screen faces the pilot)
      if (V.norm(f) < 0.5) f = V.sub([0, 1, 0], V.mul(down, down[1]));   // phone lying flat: top edge = forward
      const fwd = V.unit(f);
      const right = V.cross(down, fwd);
      this.mount = [fwd[0], fwd[1], fwd[2], right[0], right[1], right[2], down[0], down[1], down[2]];
      AC.Settings.set('mount', this.mount);
      this.aligned = false;     // re-initialise attitude with the new mounting
      return true;
    },

    _toBody(v) { return this.mount ? M.mulV(this.mount, v) : [v[1], v[0], -v[2]]; },

    onImu(d) {
      const now = d.t || Date.now();
      const dt = Math.min(0.5, Math.max(0.01, d.dt || 0.1));
      this.lastImu = now;
      if (d.decl !== undefined) this.decl = d.decl;
      if (d.p !== undefined) this.onPressure(d.p, now);
      if (!d.g || !d.a) return;
      // low-passed raw values (for calibration and standstill detection)
      this._accLp = this._accLp ? V.add(V.mul(this._accLp, 0.9), V.mul(d.a, 0.1)) : d.a.slice();
      if (!this.mount) this.calibrateMount();   // first start: assume the aircraft is level

      const wB = this._toBody(d.g);               // raw rates, body frame
      // Specific force in body (NED): at rest (0,0,-g). gravity vector = acceleration - specific force.
      const f = this._toBody(d.a);

      // Magnetic heading of the aircraft nose (Android rotation matrix: device -> east/north/up)
      if (d.rm && this.mount) {
        const fwdPhone = [this.mount[0], this.mount[1], this.mount[2]];
        const w = M.mulV(d.rm, fwdPhone);
        if (Math.hypot(w[0], w[1]) > 0.3) this.magHeading = (Math.atan2(w[0], w[1]) * R2D + this.decl + 360) % 360;
      }

      const gps = AC.Gps.state;
      const gpsFresh = gps && gps.gnss && Date.now() - gps.t < 3000;
      const V_gs = gpsFresh ? gps.gs : (AC.App.own && AC.App.own.source === 'dr' ? AC.App.own.gs : 0);

      // ---- initial alignment from accelerometer + best heading source
      if (!this.aligned) {
        const g = V.unit(V.mul(f, -1));             // gravity direction (down) in body
        const roll = Math.atan2(g[1], g[2]);
        const pitch = Math.atan2(-g[0], Math.hypot(g[1], g[2]));
        let yaw = 0;
        if (gpsFresh && gps.gs > 12) { yaw = gps.trk * D2R; this.headingRef = 'GPS'; }
        else if (this.magHeading !== null) { yaw = this.magHeading * D2R; this.headingRef = 'MAG'; }
        this.q = Q.fromEuler(roll, pitch, yaw);
        if (!this.biasInit && d.gb) { this.bias = this._toBody(d.gb); this.biasInit = true; this.biasSource = 'Android'; }
        this.aligned = true;
        this.status = 'ALIGN';
        this.alignedAt = now;
      }

      // ---- standstill: gyro output = drift -> estimate bias directly (all three axes)
      const gyroMag = V.norm(V.sub(wB, this.bias));
      const accErr = Math.abs(V.norm(f) - GRAV);
      // Only when the aircraft is known to stand still (GPS speed ~0, or last known speed ~0 without GPS) -
      // a steady straight flight looks "still" to the sensors too and must not be taken as drift.
      const knownStill = gpsFresh ? gps.gs < 0.7 : (!this.lastGood || this.lastGood.gs < 1);
      const still = gyroMag < 0.03 && accErr < 0.3 && knownStill;
      this.stillTime = still ? this.stillTime + dt : 0;
      if (this.stillTime > 2) {
        this.bias = V.add(V.mul(this.bias, 0.97), V.mul(wB, 0.03));
        this.biasSource = 'Stillstand';
      }

      let w = V.sub(wB, this.bias);
      const R = Q.toM(this.q);

      // ---- roll/pitch correction: accelerometer minus centripetal acceleration of the turn
      const aCent = [0, V_gs * w[2], -V_gs * w[1]];            // body: lateral = V*r, vertical = -V*q
      const gMeas = V.sub(aCent, f);                            // measured gravity (down) direction in body
      const gEst = M.tMulV(R, [0, 0, 1]);                       // estimated down direction in body
      const gNorm = V.norm(gMeas);
      let corr = [0, 0, 0];
      let iTerm = [0, 0, 0];
      if (Math.abs(gNorm - GRAV) < 0.25 * GRAV) {
        const e = V.cross(V.unit(gMeas), gEst);
        const kp = V_gs > 10 ? 0.25 : 0.8, ki = 0.004;
        corr = V.add(corr, V.mul(e, kp));
        iTerm = V.add(iTerm, V.mul(e, ki * dt));
      }

      // ---- heading correction: GPS track (high priority) > magnetic compass > none (gyro only)
      const eul = Q.toEuler(this.q);
      let refHdg = null, kpsi = 0, kipsi = 0;
      if (gpsFresh && gps.gs > 12) { refHdg = gps.trk * D2R; kpsi = 0.6; kipsi = 0.02; this.headingRef = 'GPS'; }
      else if (this.magHeading !== null && (!gpsFresh || gps.gs < 5)) { refHdg = this.magHeading * D2R; kpsi = 0.15; kipsi = 0.002; this.headingRef = 'MAG'; }
      else this.headingRef = 'GYRO';
      if (refHdg !== null) {
        const err = wrapPi(refHdg - eul[2]);
        const eB = M.tMulV(R, [0, 0, err]);                     // earth yaw error -> body
        corr = V.add(corr, V.mul(eB, kpsi));
        if (Math.abs(err) < 15 * D2R) iTerm = V.add(iTerm, V.mul(eB, kipsi * dt));
      }
      // learned bias (integral of the corrections) = drift compensation in flight
      if (this.stillTime <= 2) {
        this.bias = V.sub(this.bias, iTerm);
        if (refHdg !== null && this.headingRef === 'GPS') this.biasSource = 'GPS-gestützt';
      }

      // ---- integrate attitude
      w = V.add(w, corr);
      const dq = [1, w[0] * dt / 2, w[1] * dt / 2, w[2] * dt / 2];
      this.q = Q.norm(Q.mul(this.q, dq));

      const [r, p, y] = Q.toEuler(this.q);
      this.roll = r * R2D;
      this.pitch = p * R2D;
      this.heading = (y * R2D + 360) % 360;
      this.turnRate = M.mulV(Q.toM(this.q), V.sub(wB, this.bias))[2] * R2D;   // earth-frame yaw rate
      if (now - (this.alignedAt || now) > 5000) this.status = this.headingRef === 'GYRO' ? 'GYRO ONLY' : 'OK';
    },

    // ---------------------------------------------------------------- barometer
    onPressure(hPa, now) {
      this.pressure = hPa;
      const altM = 44330.77 * (1 - Math.pow(hPa / 1013.25, 0.190263));
      const prev = this._baro;
      if (prev && now - prev.t < 95) return;   // sensors arrive at 20 Hz; the barometer is evaluated at 10 Hz
      if (prev) {
        const dt = (now - prev.t) / 1000;
        if (dt > 0.05) {
          const raw = (altM - prev.alt) / dt;
          this.baroVs = this.baroVs === null ? raw : this.baroVs + (raw - this.baroVs) * Math.min(1, dt / 2.5);
          this._baroAlt = this._baroAlt + (altM - this._baroAlt) * Math.min(1, dt / 1.0);
        }
      } else {
        this._baroAlt = altM;
      }
      this._baro = { alt: altM, t: now };
      this.pressAltFt = this._baroAlt / AC.U.FT;
      this.baroTime = now;
    },

    baroOk() { return this.pressAltFt !== null && Date.now() - (this.baroTime || 0) < 3000; },
    ready() { return this.running && this.aligned && Date.now() - this.lastImu < 1500; },

    /** Simulator: synthetic attitude from the simulated flight (coordinated turn, flight path angle). */
    simulate(own) {
      const v = own.gs, w = (own.turnRate || 0) * D2R;
      this.roll = Math.atan(v * w / GRAV) * R2D;
      this.pitch = v > 1 ? Math.atan(own.vs / v) * R2D + 2 : 0;
      this.heading = own.trk;
      this.turnRate = own.turnRate || 0;
      this.headingRef = 'SIM';
      this.status = 'SIM';
    },

    // ---------------------------------------------------------------- dead reckoning
    dr: null,

    /** Called every logic cycle with the latest GPS state; returns the ownship to use (GPS, DR or null). */
    navigate(g, now) {
      const S = AC.settings;
      const fresh = g && g.gnss && now - g.t < 3000 && g.acc < 300;
      if (fresh) {
        // remember everything needed to continue without GPS
        this.lastGood = {
          lat: g.lat, lon: g.lon, t: now, gs: g.gs, trk: g.trk, vs: g.vs, altMSL: g.altMSL, altHAE: g.altHAE, acc: g.acc,
          crab: this.ready() ? wrapPi((g.trk - this.heading) * D2R) * R2D : 0,
          pressAltFt: this.baroOk() ? this.pressAltFt : null,
        };
        this.dr = null;
        return null;
      }
      const lg = this.lastGood;
      if (!S.drOn || !lg || !this.ready() || lg.gs < 8 || now - lg.t > 60000) { this.dr = null; return null; }
      if (!this.dr) this.dr = { lat: lg.lat, lon: lg.lon, t: lg.t };
      const dt = (now - this.dr.t) / 1000;
      const trk = (this.heading + lg.crab + 360) % 360;
      if (dt > 0) {
        const p = AC.Geo.advance(this.dr.lat, this.dr.lon, trk, lg.gs, this.turnRate, dt);
        this.dr = { lat: p.lat, lon: p.lon, t: now };
      }
      const age = (now - lg.t) / 1000;
      let altMSL = lg.altMSL, altHAE = lg.altHAE, vs = 0;
      if (S.baroOn && this.baroOk() && lg.pressAltFt !== null) {
        const dAlt = (this.pressAltFt - lg.pressAltFt) * AC.U.FT;
        altMSL = lg.altMSL === null ? null : lg.altMSL + dAlt;
        altHAE = lg.altHAE === null ? null : lg.altHAE + dAlt;
        vs = this.baroVs || 0;
      }
      return {
        lat: this.dr.lat, lon: this.dr.lon, altMSL, altHAE,
        gs: lg.gs, trk, vs, turnRate: this.turnRate,
        // position uncertainty: GPS accuracy + speed/wind error (5 %) + heading drift
        acc: lg.acc + 0.05 * lg.gs * age + 0.5 * age * age * 0.3,
        altAcc: null, t: now, source: 'dr', gnss: false, drAge: age,
      };
    },
  };

  AC.Ahrs = Ahrs;
})(window.AC = window.AC || {});
