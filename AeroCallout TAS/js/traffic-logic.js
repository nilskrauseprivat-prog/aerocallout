/*
 * AeroCallout - traffic advisory logic modelled on TCAS II (v7.1) TA criteria.
 *
 * Levels:  other  -> proximate (within 6 NM / ±1200 ft)  -> TA (traffic advisory)  -> WARN (imminent conflict)
 * IMPORTANT: no resolution advisories / avoidance manoeuvres are ever generated.
 *
 * TA = range test (modified tau with DMOD) AND altitude test (ZTHR or vertical tau)
 *      AND predicted horizontal miss distance filter (reduces nuisance alerts from non-converging traffic).
 * WARN = predicted trajectories (incl. turn rates) come within the protection volume inside the warning time.
 * Uncertainty of position and altitude enlarges the protection volume (conservative).
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  // TCAS II sensitivity levels. TA: tau (s), DMOD (NM), ZTHR (ft). W*: imminent-conflict values (RA table based).
  const SL_TABLE = {
    2: { taTau: 20, taDmod: 0.30, taZ: 850, wTau: 12, wDmod: 0.15, wZ: 400 },
    3: { taTau: 25, taDmod: 0.33, taZ: 850, wTau: 15, wDmod: 0.20, wZ: 600 },
    4: { taTau: 30, taDmod: 0.48, taZ: 850, wTau: 20, wDmod: 0.35, wZ: 600 },
    5: { taTau: 40, taDmod: 0.75, taZ: 850, wTau: 25, wDmod: 0.55, wZ: 600 },
    6: { taTau: 45, taDmod: 1.00, taZ: 850, wTau: 30, wDmod: 0.80, wZ: 600 },
    7: { taTau: 48, taDmod: 1.30, taZ: 850, wTau: 35, wDmod: 1.10, wZ: 700 },
  };
  const GAIN = { lo: 0.75, norm: 1.0, hi: 1.25, max: 1.5 };

  const holds = new Map(); // hex -> {level, until}
  const RANK = { other: 0, prox: 1, ta: 2, warn: 3 };

  function selectSL(ownAltMSLft, aglFt) {
    const S = AC.settings;
    if (S.sens && S.sens.startsWith('sl')) return parseInt(S.sens.slice(2), 10);
    const agl = aglFt === null || aglFt === undefined ? ownAltMSLft : aglFt;
    if (agl < 1000) return 2;
    if (agl < 2350) return 3;
    if (ownAltMSLft < 5000) return 4;
    if (ownAltMSLft < 10000) return 5;
    if (ownAltMSLft < 20000) return 6;
    return 7;
  }

  function params(sl) {
    const base = SL_TABLE[sl] || SL_TABLE[4];
    const g = GAIN[AC.settings.sensGain] || 1;
    return {
      sl,
      gain: g,
      taTau: base.taTau * g,
      taDmodM: base.taDmod * g * U().NM,
      taZ: base.taZ * Math.min(g, 1.3),
      wTau: base.wTau * g,
      wHorM: Math.max(base.wDmod * U().NM, 250) * g,
      wZ: base.wZ * Math.min(g, 1.3),
      hmdTaM: Math.max(2.5 * base.taDmod * U().NM, 1000) * g,
    };
  }

  /**
   * @param own ownship state
   * @param targets from AC.Adsb.getTargets
   * @param aglFt ownship height above terrain (ft) or null
   */
  function evaluate(own, targets, now, aglFt) {
    const S = AC.settings;
    const ownAltFt = own.altHAE !== null ? own.altHAE / U().FT : null;
    const ownMSLft = own.altMSL !== null ? own.altMSL / U().FT : (ownAltFt || 0);
    const sl = selectSL(ownMSLft, aglFt);
    const P = params(sl);
    // Car mode (Android Auto connected): the "ownship" is a car on the ground - altitude is ignored for alerts
    // (every aircraft counts as level with us) and the ground-speed gate for alerts is not applied.
    const car = !!(AC.Car && AC.Car.active());
    const airborne = car || own.gs >= S.minSpeedKt * U().KT;
    const H = 60;
    const ownPath = G().predictPath(own.gs, own.trk, own.vs, own.turnRate || 0, H, 1);
    const ov = G().vel(own.gs, own.trk, own.vs);
    const ownUnc = Math.max(10, Math.min(own.acc || 10, 100));
    const items = [];

    for (const t of targets) {
      if (airborne && t.ground) continue;
      const e = G().enu(own.lat, own.lon, t.lat, t.lon);
      const r = Math.hypot(e.x, e.y);
      if (r > 120 * U().NM) continue;
      const brg = G().bearingOf(e.x, e.y);
      const relBrg = G().norm180(brg - own.trk);
      // Relative altitude: preferably pressure altitude vs. own barometer (no QNH / temperature error),
      // otherwise GNSS heights.
      const baroCmp = own.pressAltFt !== undefined && own.pressAltFt !== null && t.baroFt !== null && t.baroFt !== undefined;
      const altAvail = baroCmp || (t.altFt !== null && ownAltFt !== null);
      const relAltFt = baroCmp ? t.baroFt - own.pressAltFt : altAvail ? t.altFt - ownAltFt : null;
      const altKnown = altAvail && !car;   // car mode: relative altitude shown, but not used for alerts
      // car mode height filter: aircraft higher than the chosen limit above us are left out completely
      if (car && S.carAltM > 0 && relAltFt !== null && relAltFt * U().FT > S.carAltM) continue;
      const unc = t.uncertM + ownUnc;
      const altUnc = baroCmp ? 100 : altKnown ? t.altUncFt + 75 : 0;

      const tv = G().vel(t.gs, t.trk, t.vs);
      const rvx = tv.x - ov.x, rvy = tv.y - ov.y;
      const rdot = (e.x * rvx + e.y * rvy) / Math.max(r, 1);
      const hdot = (t.vs - own.vs) / U().FT; // ft/s

      let level = 'other';
      let hmd = r, tCpa = 0, vsepCpa = relAltFt, warnT = null;

      if (airborne && !t.ground && r < 15 * U().NM) {
        // --- Trajectory prediction (incl. turn rates) ---
        const tp = G().predictPath(t.gs, t.trk, t.vs, t.turn || 0, H, 1);
        for (let k = 0; k < tp.length; k++) {
          const dx = e.x + tp[k].x - ownPath[k].x;
          const dy = e.y + tp[k].y - ownPath[k].y;
          const hd = Math.hypot(dx, dy);
          const dz = altKnown ? relAltFt + (tp[k].z - ownPath[k].z) / U().FT : 0;
          if (hd < hmd) { hmd = hd; tCpa = tp[k].t; vsepCpa = altKnown ? dz : null; }
        }
        // Imminent conflict: closest approach within the warning time and inside the protection volume,
        // or already inside the protection volume now.
        const vOk = (dz) => !altKnown || Math.abs(dz) - altUnc < P.wZ;
        if (tCpa <= P.wTau && hmd - unc < P.wHorM && vOk(vsepCpa)) warnT = tCpa;
        else if (r - unc < P.wHorM && vOk(relAltFt)) warnT = 0;

        // --- TCAS-style TA tests ---
        const rEff = Math.max(0, r - unc);
        let rangeOk = rEff <= P.taDmodM;
        let tauR = null;
        if (!rangeOk && rdot < -0.5) {
          tauR = (P.taDmodM * P.taDmodM - rEff * rEff) / (rEff * rdot);
          rangeOk = tauR <= P.taTau;
        }
        let altOk = true;
        if (altKnown) {
          const hEff = Math.max(0, Math.abs(relAltFt) - altUnc);
          altOk = hEff <= P.taZ || (relAltFt * hdot < 0 && hEff / Math.abs(hdot) <= P.taTau);
        }
        const hmdOk = rEff <= P.taDmodM || hmd - unc < P.hmdTaM;

        if (warnT !== null && r < 5 * U().NM) level = 'warn';
        else if (rangeOk && altOk && hmdOk) level = 'ta';
      }

      if (level === 'other' && r < 6 * U().NM && (!altKnown || Math.abs(relAltFt) < 1200)) level = 'prox';

      // Hysteresis: keep TA / WARN for a short time to avoid flicker.
      if (RANK[level] >= RANK.ta) {
        holds.set(t.hex, { level, until: now + (level === 'warn' ? 4000 : 10000) });
      } else {
        const h = holds.get(t.hex);
        if (h && now < h.until && airborne) level = h.level;
        else if (h) holds.delete(t.hex);
      }

      items.push({
        hex: t.hex, t, x: e.x, y: e.y, r, brg, relBrg,
        clock: G().clock(relBrg),
        relAltFt,
        closureMs: -rdot,           // closure rate (m/s), positive = converging
        vsFpm: t.vs / U().FPM,
        level,
        hmd, tCpa, vsepCpa, warnT, unc,
      });
    }

    items.sort((a, b) => (RANK[b.level] - RANK[a.level]) || (a.r - b.r));
    return { items, sl, P, airborne };
  }

  AC.TrafficLogic = { evaluate, selectSL, params, SL_TABLE, RANK, reset() { holds.clear(); } };
})(window.AC = window.AC || {});
