/*
 * AeroCallout - warning test ("Warnungstest"): all alert types in quick succession at the REAL position,
 * each with the matching radar picture and callout:
 *   traffic advisory -> traffic warning -> caution terrain -> terrain pull up -> caution obstacle -> obstacle pull up
 * Test aircraft, synthetic terrain and a test mast exist only for the duration of their step; afterwards
 * everything is removed again. Works on the phone and on the car display (also in car mode, where terrain /
 * obstacle alerts are otherwise off). Test objects are marked "SIM".
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;
  const STEP_S = 6.5;
  const STEPS = ['ta', 'warn', 'tcaution', 'twarning', 'ocaution', 'owarning'];
  const NAMES = { ta: 'VERKEHRSHINWEIS', warn: 'VERKEHRSWARNUNG', tcaution: 'GELÄNDE VORSICHT', twarning: 'GELÄNDE PULL UP', ocaution: 'HINDERNIS VORSICHT', owarning: 'HINDERNIS PULL UP' };

  const AlertTest = {
    active: false,
    t0: 0,
    ref: null,       // real position at the start of each step {lat, lon, trk, altM}
    stepIdx: -1,

    start(own) {
      if (!own) return false;
      if (AC.Sim.live) AC.Sim.endLive();
      this.active = true;
      this.t0 = Date.now();
      this.stepIdx = -1;
      AC.TrafficLogic.reset();
      AC.Voice.reset();
      return true;
    },

    stop() {
      if (!this.active) return;
      this.active = false;
      this.stepIdx = -1;
      this._clearWorld();
      AC.Voice.reset();
    },

    left() { return this.active ? Math.max(0, Math.ceil((this.t0 + STEPS.length * STEP_S * 1000 - Date.now()) / 1000)) : 0; },
    stepName() { return this.active && this.stepIdx >= 0 ? NAMES[STEPS[this.stepIdx]] : ''; },

    _clearWorld() {
      AC.Terrain.override = null;
      AC.Obstacles.synthetic = [];
      AC.Display.terr.img = null;
      AC.Display.terr.keep = null;
    },

    /** Synthetic terrain around the reference point: base well below us, a ridge across the track ahead. */
    _terrain(ref, ridgeTopM) {
      const baseM = ref.altM - 450;
      const h = G().toRad(ref.trk);
      AC.Terrain.override = (lat, lon) => {
        const e = G().enu(ref.lat, ref.lon, lat, lon);
        const along = e.x * Math.sin(h) + e.y * Math.cos(h);
        const u = (along - 1200) / 3000;
        if (u <= 0 || u >= 1) return baseM;
        return baseM + (ridgeTopM - baseM) * Math.sin(u * Math.PI);
      };
      AC.Display.terr.img = null;
      AC.Display.terr.keep = null;
    },

    /** Prepare the world for a step (called once when the step begins). */
    _enter(step, own) {
      this._clearWorld();
      const altM = own.altMSL || 0;
      this.ref = { lat: own.lat, lon: own.lon, trk: own.trk || 0, altM };
      const ref = this.ref;
      if (step === 'tcaution') this._terrain(ref, altM - 60);        // ridge just below us: yellow / caution
      if (step === 'twarning') this._terrain(ref, altM + 750);       // ridge > 2000 ft above us: red / pull up
      if (step === 'ocaution' || step === 'owarning') {
        this._terrain(ref, ref.altM - 450 + 1);                      // flat ground 450 m below
        const d = step === 'ocaution' ? 2600 : 1300;
        const h = G().toRad(ref.trk);
        const p = G().offset(ref.lat, ref.lon, Math.sin(h) * d, Math.cos(h) * d);
        AC.Obstacles.synthetic = [{ id: 'test-mast', kind: 'mast', name: 'SIM MAST', pts: [p], h: 450 + 120, sim: true }];
      }
    },

    /** Test aircraft for the traffic steps, positioned relative to the real ownship (moving towards us). */
    _trafficItem(step, own, el) {
      const ta = step === 'ta';
      const relBrg = ta ? 60 : 0;                              // 2 o'clock / 12 o'clock
      const gsKt = ta ? 140 : 180;
      const r = Math.max(150, (ta ? 1.7 : 0.75) * U().NM - gsKt * U().KT * el);
      const brg = G().norm360((own.trk || 0) + relBrg);
      const x = Math.sin(G().toRad(brg)) * r, y = Math.cos(G().toRad(brg)) * r;
      const trk = G().norm360(brg + 180);
      const relAltFt = ta ? 300 : 0;
      const vo = G().vel(own.gs || 0, own.trk || 0, 0), vt = G().vel(gsKt * U().KT, trk, 0);
      const closureMs = -(((vt.x - vo.x) * x + (vt.y - vo.y) * y) / r);
      const label = ta ? 'SIM101' : 'SIM102';
      const t = {
        hex: ta ? 'simt01' : 'simt02', label, gs: gsKt * U().KT, trk, vs: 0, stale: false, ground: false,
        rec: { sim: true, flight: label, type: ta ? 'C172' : 'PC12', category: 'A1' },
      };
      return {
        hex: t.hex, t, x, y, r, brg, relBrg, clock: G().clock(relBrg), relAltFt, closureMs, vsFpm: 0,
        level: ta ? 'ta' : 'warn', hmd: 0, tCpa: r / Math.max(1, closureMs), unc: 30,
      };
    },

    /**
     * Called from the logic cycle: adds the test aircraft to the traffic picture and returns the alert list
     * of the current step (replacing the computed alerts), or null when the test is over.
     */
    run(own, tfc, now) {
      if (!this.active || !own) return null;
      const el = (now - this.t0) / 1000;
      const idx = Math.floor(el / STEP_S);
      if (idx >= STEPS.length) { this.stop(); return null; }
      const step = STEPS[idx];
      if (idx !== this.stepIdx) { this.stepIdx = idx; this._enter(step, own); }
      const sEl = el - idx * STEP_S;
      const alerts = [];
      if (step === 'ta' || step === 'warn') {
        const it = this._trafficItem(step, own, sEl);
        if (tfc) tfc.items.unshift(it);
        alerts.push(step === 'warn'
          ? { key: 'test-tfc-warn', kind: 'traffic', level: 'warn', prio: 90, repeatMs: 0, item: it }
          : { key: 'test-tfc-ta', kind: 'traffic', level: 'ta', prio: 60, repeatMs: 0, item: it });
      } else if (step === 'tcaution' || step === 'twarning') {
        const w = step === 'twarning';
        alerts.push({ key: 'test-terrain-' + step, kind: 'terrain', level: w ? 'warning' : 'caution', prio: w ? 100 : 70, repeatMs: w ? 2500 : 0 });
      } else {
        const w = step === 'owarning';
        const o = AC.Obstacles.synthetic[0];
        if (o) {
          const d = G().dist(own.lat, own.lon, o.pts[0].lat, o.pts[0].lon);
          const e = G().enu(own.lat, own.lon, o.pts[0].lat, o.pts[0].lon);
          const relBrg = G().norm180(G().bearingOf(e.x, e.y) - (own.trk || 0));
          alerts.push({ key: 'test-obstacle-' + step, kind: 'obstacle', level: w ? 'warning' : 'caution', prio: w ? 95 : 65, repeatMs: w ? 2500 : 0,
            obs: { id: 'obs-' + o.id, level: w ? 'warning' : 'caution', t: 5, relBrg, clock: G().clock(relBrg), obs: o, d } });
        }
      }
      return alerts;
    },
  };

  AC.AlertTest = AlertTest;
})(window.AC = window.AC || {});
