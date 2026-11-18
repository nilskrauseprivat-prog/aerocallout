/* AeroCallout - device GPS with alpha-beta filtering for smooth position / velocity / turn rate. */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;

  const Gps = {
    state: null,      // ownship: {lat, lon, altHAE, altMSL, gs, trk, vs, turnRate, acc, altAcc, t, source}
    status: 'off',    // off | search | ok | denied | unavailable
    error: '',
    fixes: 0,
    _watch: null,
    _f: null,

    native: false,
    sats: null,
    satsVisible: null,
    provider: '',

    start() {
      // Android app: native GNSS receiver (1-2 Hz, Doppler speed/track, satellite count).
      if (window.AndroidGPS) {
        this.native = true;
        this.status = 'search';
        window.__gpsFix = (f) => {
          this.sats = f.sats; this.satsVisible = f.satsVisible; this.provider = f.provider;
          this._onFix({
            coords: {
              latitude: f.lat, longitude: f.lon,
              altitude: f.alt === undefined ? null : f.alt,
              accuracy: f.acc === undefined ? 999 : f.acc,
              altitudeAccuracy: f.altAcc === undefined ? null : f.altAcc,
              speed: f.speed === undefined ? null : f.speed,
              heading: f.bearing === undefined ? null : f.bearing,
            },
            timestamp: f.t,
          });
        };
        try { window.AndroidGPS.start(); } catch (e) { this.status = 'unavailable'; }
        return;
      }
      if (this._watch !== null) return;
      if (!('geolocation' in navigator)) { this.status = 'unavailable'; return; }
      this.status = 'search';
      this._watch = navigator.geolocation.watchPosition(
        (p) => this._onFix(p),
        (e) => { this.error = e.message; this.status = e.code === 1 ? 'denied' : 'search'; },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
      );
    },

    /** Android: receiver / settings state for diagnostics. */
    nativeStatus() {
      if (!window.AndroidGPS) return null;
      try { return JSON.parse(window.AndroidGPS.status()); } catch (e) { return null; }
    },

    stop() {
      if (this.native && window.AndroidGPS) { try { window.AndroidGPS.stop(); } catch (e) { /* ignore */ } }
      if (this._watch !== null) navigator.geolocation.clearWatch(this._watch);
      this._watch = null;
      this._f = null;
      this.state = null;
      this.status = 'off';
    },

    _onFix(p) {
      const c = p.coords;
      const S = AC.settings;
      const now = Date.now();
      const t = Math.min(p.timestamp || now, now);
      this.fixes++;
      this.status = 'ok';

      // Altitude: W3C specifies height above the WGS-84 ellipsoid; some platforms deliver MSL.
      let altHAE = null;
      if (c.altitude !== null && c.altitude !== undefined && !isNaN(c.altitude)) {
        altHAE = S.gpsAltRef === 'msl' ? c.altitude + S.geoidM : c.altitude;
      }
      const hasDoppler = c.speed !== null && c.speed !== undefined && !isNaN(c.speed) && c.speed >= 0 &&
        c.heading !== null && c.heading !== undefined && !isNaN(c.heading);

      let f = this._f;
      if (!f) {
        f = this._f = { lat0: c.latitude, lon0: c.longitude, x: 0, y: 0, vx: 0, vy: 0, z: altHAE, vz: 0, t, turn: 0 };
        if (hasDoppler) { const v = G().vel(c.speed, c.heading, 0); f.vx = v.x; f.vy = v.y; }
      } else {
        const dt = (t - f.t) / 1000;
        if (dt < 0.05) return;
        const m = G().enu(f.lat0, f.lon0, c.latitude, c.longitude);
        // Measurement weight depends on reported accuracy.
        const acc = c.accuracy || 30;
        const a = acc < 15 ? 0.7 : acc < 50 ? 0.5 : 0.3;
        const b = a * a / (2 - a) * 0.8;
        const px = f.x + f.vx * dt, py = f.y + f.vy * dt;
        const rx = m.x - px, ry = m.y - py;
        f.x = px + a * rx; f.y = py + a * ry;
        f.vx += b * rx / dt; f.vy += b * ry / dt;
        if (hasDoppler) {
          // Doppler velocity from the GNSS chip is far more accurate than position differences.
          const v = G().vel(c.speed, c.heading, 0);
          f.vx = 0.85 * v.x + 0.15 * f.vx;
          f.vy = 0.85 * v.y + 0.15 * f.vy;
        }
        if (altHAE !== null) {
          if (f.z === null) { f.z = altHAE; f.vz = 0; }
          else {
            const pz = f.z + f.vz * dt;
            const rz = altHAE - pz;
            f.z = pz + 0.45 * rz;
            f.vz += 0.12 * rz / dt;
          }
        }
        const prevTrk = this.state ? this.state.trk : null;
        const gsNow = Math.hypot(f.vx, f.vy);
        if (prevTrk !== null && gsNow > 10) {
          const trkNow = G().bearingOf(f.vx, f.vy);
          const rate = G().norm180(trkNow - prevTrk) / dt;
          f.turn += (rate - f.turn) * Math.min(1, dt / 2.5);
        } else {
          f.turn = 0;
        }
        f.t = t;
        if (Math.hypot(f.x, f.y) > 20000) {
          const o = G().offset(f.lat0, f.lon0, f.x, f.y);
          f.lat0 = o.lat; f.lon0 = o.lon; f.x = 0; f.y = 0;
        }
      }

      const gs = Math.hypot(f.vx, f.vy);
      const trk = gs > 1.5 ? G().bearingOf(f.vx, f.vy) : (this.state ? this.state.trk : 0);
      const pos = G().offset(f.lat0, f.lon0, f.x, f.y);
      this.state = {
        lat: pos.lat,
        lon: pos.lon,
        altHAE: f.z,
        altMSL: f.z === null ? null : f.z - S.geoidM,
        gs,
        trk,
        vs: f.vz || 0,
        turnRate: G().clamp(f.turn, -10, 10),
        acc: c.accuracy,
        altAcc: c.altitudeAccuracy,
        t: now,
        source: 'gps',
        // Only a satellite fix (native GNSS, or a browser fix better than 50 m) is good enough for alerts.
        gnss: this.native ? this.provider === 'gnss' : c.accuracy <= 50,
        sats: this.sats,
      };
      // Network positions have no Doppler speed: never treat them as flying.
      if (!this.state.gnss && !hasDoppler) { this.state.gs = 0; this.state.vs = 0; this.state.turnRate = 0; }
    },
  };

  AC.Gps = Gps;
})(window.AC = window.AC || {});
