/* AeroCallout - geodesy helpers. Local tangent plane: x = east, y = north (meters). */
(function (AC) {
  'use strict';

  const R = 6371008.8;
  const U = {
    FT: 0.3048,          // m per ft
    KT: 1852 / 3600,     // m/s per kt
    FPM: 0.3048 / 60,    // m/s per ft/min
    NM: 1852,            // m per NM
  };

  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;

  function norm360(d) { d %= 360; return d < 0 ? d + 360 : d; }
  function norm180(d) { d = norm360(d); return d > 180 ? d - 360 : d; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /** East/north offset (m) of point relative to origin. Accurate to <0.5 % within ~100 km. */
  function enu(lat0, lon0, lat, lon) {
    const dLat = toRad(lat - lat0);
    const dLon = toRad(norm180(lon - lon0));
    const m = toRad(lat0) + dLat / 2;
    return { x: dLon * Math.cos(m) * R, y: dLat * R };
  }

  /** Coordinate reached from origin by moving east/north meters. */
  function offset(lat0, lon0, east, north) {
    const lat = lat0 + toDeg(north / R);
    const m = toRad((lat0 + lat) / 2);
    const lon = lon0 + toDeg(east / (R * Math.max(Math.cos(m), 1e-6)));
    return { lat, lon: norm180(lon) };
  }

  /** Great-circle distance (m). */
  function dist(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(norm180(lon2 - lon1));
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingOf(x, y) { return norm360(toDeg(Math.atan2(x, y))); }

  /** Velocity vector (m/s) from ground speed (m/s), track (deg true), vertical speed (m/s). */
  function vel(gs, trk, vs) {
    const t = toRad(trk);
    return { x: gs * Math.sin(t), y: gs * Math.cos(t), z: vs || 0 };
  }

  /** Clock position 1..12 for a bearing relative to the nose. */
  function clock(relBearing) {
    const c = Math.round(norm360(relBearing) / 30) % 12;
    return c === 0 ? 12 : c;
  }

  /** Closest point on segment a-b to p (2D). */
  function segClosest(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const l2 = abx * abx + aby * aby;
    let f = 0;
    if (l2 > 0) f = clamp(((px - ax) * abx + (py - ay) * aby) / l2, 0, 1);
    const x = ax + f * abx, y = ay + f * aby;
    return { x, y, f, d: Math.hypot(px - x, py - y) };
  }

  /**
   * Predicts a trajectory with constant ground speed, turn rate and vertical speed.
   * Returns points {t, x, y, z} relative to the start (m), every dt seconds up to horizon.
   * Total predicted turn is limited to 360 degrees.
   */
  function predictPath(gs, trk, vs, turnRate, horizon, dt) {
    const pts = [];
    let x = 0, y = 0, z = 0, h = trk, turned = 0;
    const tr = clamp(turnRate || 0, -20, 20);
    for (let t = 0; t <= horizon + 1e-9; t += dt) {
      pts.push({ t, x, y, z });
      const step = Math.abs(turned) < 360 ? tr * dt : 0;
      const hr = toRad(h + step / 2);
      x += gs * Math.sin(hr) * dt;
      y += gs * Math.cos(hr) * dt;
      z += (vs || 0) * dt;
      h += step;
      turned += step;
    }
    return pts;
  }

  /** Advances a position along a (possibly turning) path for dt seconds. */
  function advance(lat, lon, trk, gs, turnRate, dt) {
    if (dt <= 0 || !gs) return { lat, lon, trk };
    const steps = Math.max(1, Math.ceil(dt));
    const h = dt / steps;
    let x = 0, y = 0, t = trk;
    const tr = clamp(turnRate || 0, -20, 20);
    for (let i = 0; i < steps; i++) {
      const hr = toRad(t + tr * h / 2);
      x += gs * Math.sin(hr) * h;
      y += gs * Math.cos(hr) * h;
      t += tr * h;
    }
    const p = offset(lat, lon, x, y);
    return { lat: p.lat, lon: p.lon, trk: norm360(t) };
  }

  /** Web-Mercator tile coordinates (fractional). */
  function tileXY(lat, lon, z) {
    const n = 2 ** z;
    const la = clamp(lat, -85.05112878, 85.05112878);
    const r = toRad(la);
    return {
      x: (norm180(lon) + 180) / 360 * n,
      y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n,
    };
  }

  /** Unit formatting according to the user's unit settings (aviation or metric). */
  const Fmt = {
    distM() { return AC.settings.distUnit === 'km' ? 1000 : U.NM; },
    distLabel() { return AC.settings.distUnit === 'km' ? 'km' : 'NM'; },
    dist(m, dec) { return (m / Fmt.distM()).toFixed(dec === undefined ? 1 : dec); },
    rangeOverride: null,   // set by auto-range during traffic alerts (in the selected distance unit)
    rangeVal() { return Fmt.rangeOverride !== null ? Fmt.rangeOverride : AC.settings.rangeNM; },
    rangeM() { return Fmt.rangeVal() * Fmt.distM(); },
    rangeNMeq() { return Fmt.rangeM() / U.NM; },
    speedF() { return AC.settings.speedUnit === 'kmh' ? 3.6 : 1 / U.KT; },   // per m/s
    speedLabel() { return AC.settings.speedUnit === 'kmh' ? 'km/h' : 'kt'; },
    speed(mps) { return Math.round(mps * Fmt.speedF()); },
    altF() { return AC.settings.altUnit === 'm' ? 1 : 1 / U.FT; },           // per m
    altLabel() { return AC.settings.altUnit === 'm' ? 'm' : 'ft'; },
    alt(m) { return Math.round(m * Fmt.altF()); },
    vsF() { return AC.settings.vsUnit === 'mps' ? 1 : 1 / U.FPM; },          // per m/s
    vsLabel() { return AC.settings.vsUnit === 'mps' ? 'm/s' : 'ft/min'; },
    vs(mps) { return AC.settings.vsUnit === 'mps' ? (Math.round(mps * 10) / 10).toFixed(1) : String(Math.round(mps / U.FPM / 10) * 10); },
  };

  AC.Fmt = Fmt;
  AC.U = U;
  AC.Geo = { R, toRad, toDeg, norm360, norm180, clamp, enu, offset, dist, bearingOf, vel, clock, segClosest, predictPath, advance, tileXY };
})(window.AC = window.AC || {});
