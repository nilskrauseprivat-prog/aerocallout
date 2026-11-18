/*
 * AeroCallout - Android Auto support.
 * The car screen is drawn natively (Android Car App Library, navigation template surface). It polls
 * AC.Car.state() about 10 times per second; everything is already formatted and projected here, so the
 * native side only draws. Track-up, coordinates normalised to the selected range (1.0 = range ring).
 *
 * Car mode: while the car screen is connected, traffic is evaluated for a car on the ground - every aircraft
 * is shown and altitude is not used for alerts or callouts (see TrafficLogic / Voice / App). Terrain and
 * obstacle alerts are off. The phone switches to a remote control for the car display.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  const Car = {
    _v: null,
    lastPoll: 0,
    remoteDismissed: false,

    /** Car display connected (polled within the last 3 s). */
    active() { return Date.now() - this.lastPoll < 3000; },

    keys() {
      const S = AC.settings;
      return [
        { k: 'rngUp', t: 'RNG ▲', s: 'Bereich +', c: '#3fd7ff' },
        { k: 'rngDn', t: 'RNG ▼', s: 'Bereich −', c: '#3fd7ff' },
        { k: 'terr', t: 'WX/TERR', s: S.wxOn && S.terrOn ? 'BEIDE' : S.terrOn ? 'TERR' : S.wxOn ? 'WX' : 'AUS', c: '#d9893a', on: S.wxOn || S.terrOn },
        { k: 'sens', t: 'SENS', s: S.sensGain.toUpperCase(), c: '#ffb000' },
        { k: 'carAlt', t: 'HÖHE', s: this.altLabel(), c: '#3fd7ff', on: S.carAltM > 0 },
        { k: 'mute', t: 'TON', s: S.muted ? 'STUMM' : 'AN', c: '#6aa8ff', warn: S.muted },
      ];
    },

    ALT_STEPS: [0, 500, 1000, 2000, 3000, 5000],
    altLabel() {
      const m = AC.settings.carAltM;
      if (!m) return 'ALLE';
      return AC.settings.altUnit === 'ft' ? `≤${Math.round(m / AC.U.FT / 100) * 100} FT` : `≤${m} M`;
    },

    // ------------------------------------------------------------ tap an aircraft: info card
    sel: null,              // {hex, t}

    select(hex) {
      this.sel = hex ? { hex, t: Date.now() } : null;
      return 'ok';
    },

    /** Info card for the selected aircraft (type, operator, route, altitude, speed, position). */
    card(own, items) {
      if (!this.sel || Date.now() - this.sel.t > 25000) { this.sel = null; return null; }
      const it = items.find((x) => x.hex === this.sel.hex);
      if (!it) return null;
      const S = AC.settings, F = AC.Fmt, Db = AC.AircraftDb, t = it.t || {}, rec = t.rec || {};
      const cs = rec.flight || '';
      const route = cs ? Db.route(cs, t.lat || own.lat, t.lon || own.lon) : null;
      const kind = this.kind(rec);
      const altFt = rec.altBaroFt !== null && rec.altBaroFt !== undefined ? rec.altBaroFt : t.altFt;
      const vs = Math.round((it.vsFpm || 0) / 100) * 100;
      return {
        hex: it.hex,
        title: cs || rec.reg || it.hex.toUpperCase(),
        badge: kind === 'mil' ? 'MIL' : kind === 'uav' ? 'UAV' : Db.isHeli(rec.type, rec.category) ? 'HELI' : rec.sim ? 'SIM' : '',
        airline: Db.airline(cs),
        type: [Db.typeName(rec.type), rec.reg && rec.reg !== cs ? rec.reg : ''].filter(Boolean).join(' · '),
        route: route ? `${route.from} → ${route.to}` : '',
        routeNames: route ? `${route.fromName} → ${route.toName}` : (cs && Db._pending.has(cs.toUpperCase()) ? 'Route wird geladen …' : ''),
        alt: altFt !== null && altFt !== undefined
          ? `${F.alt(altFt * AC.U.FT)} ${F.altLabel()}` + (it.relAltFt !== null ? ` (${it.relAltFt >= 0 ? '+' : '−'}${F.alt(Math.abs(it.relAltFt) * AC.U.FT)})` : '')
          : 'Höhe unbekannt',
        speed: `${F.speed(t.gs || 0)} ${F.speedLabel()}` + (Math.abs(vs) >= 200 ? ` · ${vs > 0 ? '↑' : '↓'}${F.vs(Math.abs(vs) * AC.U.FPM)} ${F.vsLabel()}` : ''),
        pos: `${F.dist(it.r)} ${F.distLabel()} · ${it.clock} Uhr` + (rec.squawk ? ` · SQ ${rec.squawk}` : ''),
      };
    },

    // ------------------------------------------------------------ "passing overhead" callout (car mode)
    _ohSaid: new Map(),     // hex -> time announced
    _ohLast: 0,
    OH_STEPS: ['all', 'special', 'off'],
    ohLabel() { return { all: 'ALLE', special: 'BESONDERE', off: 'AUS' }[AC.settings.carOverhead] || 'ALLE'; },

    /**
     * Called from the logic cycle in car mode: announces aircraft that will pass (almost) overhead within the
     * next ~40 s - type, operator and height above us, e.g. "Airbus A320 von Lufthansa, 3000 Fuß, überfliegt
     * dich gleich". Every aircraft once; at most one such callout every 10 s. 'special' = only military,
     * helicopters, drones and aircraft without an airline (private / general aviation).
     */
    overhead(own, tfc, now) {
      const S = AC.settings;
      if (!this.active() || S.carOverhead === 'off' || !own || !tfc || S.muted) return;
      for (const [k, t] of this._ohSaid) if (now - t > 20 * 60000) this._ohSaid.delete(k);
      if (now - this._ohLast < 10000) return;
      const G2 = AC.Geo, U2 = AC.U, Db = AC.AircraftDb;
      const vo = G2.vel(own.gs || 0, own.trk || 0, 0);
      let best = null;
      for (const it of tfc.items) {
        if (this._ohSaid.has(it.hex) || !it.t || it.t.ground) continue;
        const tv = G2.vel(it.t.gs || 0, it.t.trk || 0, 0);
        const rvx = tv.x - vo.x, rvy = tv.y - vo.y, v2 = rvx * rvx + rvy * rvy;
        if (v2 < 1) continue;
        const tc = -(it.x * rvx + it.y * rvy) / v2;                   // time of closest approach (s)
        if (tc < 0 || tc > 40) continue;
        const dmin = Math.hypot(it.x + rvx * tc, it.y + rvy * tc);   // horizontal miss distance (m)
        if (dmin > 1500) continue;
        const rec = it.t.rec || {}, kind = this.kind(rec);
        if (S.carOverhead === 'special' && !(kind || Db.isHeli(rec.type, rec.category) || !Db.airline(rec.flight))) continue;
        if (!best || tc < best.tc) best = { it, tc, rec, kind };
      }
      if (!best) return;
      this._ohSaid.set(best.it.hex, now);
      this._ohLast = now;
      AC.Voice.say(this.overheadText(best.it, best.rec, best.kind), 25, { level: 'info' });
    },

    overheadText(it, rec, kind) {
      const de = AC.Voice.effectiveLang() === 'de', S = AC.settings, Db = AC.AircraftDb;
      const heli = Db.isHeli(rec.type, rec.category);
      const tn = rec.type && Db.typeName(rec.type) !== rec.type.toUpperCase() ? Db.typeName(rec.type) : '';
      const what = kind === 'uav' ? (de ? 'Drohne' : 'Drone')
        : tn || (heli ? (de ? 'Hubschrauber' : 'Helicopter') : (de ? 'Flugzeug' : 'Aircraft'));
      const op = Db.airline(rec.flight) || (kind === 'mil' ? (de ? 'Militär' : 'military') : '');
      let h = '';
      if (it.relAltFt !== null && it.relAltFt !== undefined && it.relAltFt >= 150) {
        h = S.altUnit === 'm' ? `${Math.max(0, Math.round(it.relAltFt * U().FT / 50) * 50)} ${de ? 'Meter' : 'meters'}`
          : `${Math.max(0, Math.round(it.relAltFt / 100) * 100)} ${de ? 'Fuß' : 'feet'}`;
      }
      if (de) return `${what}${op ? ' von ' + op : ''}${h ? ', ' + h : ''}, überfliegt dich gleich.`;
      return `${op ? op + ' ' : ''}${what}${h ? ', ' + h : ''}, passing overhead shortly.`;
    },

    /** Drone (UAV category or type) / military marking for the car display. */
    kind(rec) {
      if (!rec) return '';
      if (rec.category === 'B6' || /^(UAV|DRON|DJI|UAS)/i.test(rec.type || '')) return 'uav';
      if (rec.mil) return 'mil';
      return '';
    },

    state() {
      const wasActive = this.active();
      this.lastPoll = Date.now();
      if (!wasActive) this.onConnect();
      const App = AC.App, S = AC.settings, F = AC.Fmt, D = AC.Display;
      const out = { phase: App.phase, t: Date.now(), keys: this.keys() };
      if (App.phase === 'boot') out.selftest = AC.SelfTest.carInfo();   // POST page is drawn natively (smooth)
      if (App.phase !== 'run') return JSON.stringify(out);
      // own smoothing state (independent of the phone display)
      if (!this._v) this._v = Object.create(D);
      const v = this._v.view({ own: App.own, tfc: App.tfc, tickAt: App._tickAt });
      const own = v.own;
      const f = App.flags || {};
      out.tfc = !S.trafficEnabled ? 'off' : (f.tfcFail || f.offline || f.gpsFail) ? 'red' : f.tfcDelayed ? 'amber' : 'green';
      out.rng = `RNG ${F.rangeVal()} ${S.distUnit === 'km' ? 'KM' : 'NM'}`;
      out.sl = App.tfc ? `SL${App.tfc.sl} ${S.sensGain.toUpperCase()}` : '';
      out.muted = !!S.muted;
      out.sim = !!S.simEnabled && !AC.Sim.testRun;
      out.test = AC.AlertTest.active ? `WARNTEST ${AC.AlertTest.left()} s` : (AC.Sim.live || AC.Sim.testRun) ? `TEST ${AC.Sim.testLeft()} s` : '';
      out.testStep = AC.AlertTest.stepName();
      // weather hidden during auto range / alerts; terrain pops up during terrain / obstacle alerts
      out.wx = !!S.wxOn && !App.wxSuppressed(); out.terr = !!(S.terrOn || D.terrPopup);
      out.map = { mode: S.mapMode, alpha: S.mapAlpha || 0.6, style: S.mapStyle || 'dark' };
      const last = AC.Adsb.lastData;
      const age = last ? (Date.now() - last) / 1000 : null;
      out.age = S.simEnabled && !S.simLiveTraffic ? 'ADS-B SIM' : last ? `ADS-B ${age < 10 ? age.toFixed(1) : Math.round(age)} s` : 'ADS-B --';
      out.ageLvl = age === null ? 2 : age >= 15 ? 2 : age >= 10 ? 1 : 0;
      // weather picture age (timer like ADS-B), auto range active
      if (S.wxOn) { const w = D.wxAgeInfo(); out.wxAge = w.txt; out.wxAgeLvl = w.lvl; }
      out.autoRng = F.rangeOverride !== null;
      this._stepUnderlay(12);                                 // background work on the WX / terrain picture
      out.underId = this._under ? this._under.id : 0;
      out.underBusy = !!this._ub;
      if (!own) { out.noPos = true; return JSON.stringify(out); }
      out.trk = own.trk;
      out.lat = own.lat; out.lon = own.lon;
      out.rangeM = F.rangeM();
      // coarse road map for orientation (loaded for the whole wide display)
      AC.Roads.update(own, out.rangeM * 3.5);
      out.roadsVer = AC.Roads.ver;
      if (S.wxOn && !AC.Weather.frame && !AC.Weather.synthetic.length) out.wxLoading = true;
      out.trkTxt = `TRK ${String(Math.round(G().norm360(own.trk)) % 360).padStart(3, '0')}°`;
      out.gs = `GS ${F.speed(own.gs || 0)} ${F.speedLabel()}`;
      const rangeM = F.rangeM();
      const t = G().toRad(own.trk), c = Math.cos(t), s = Math.sin(t);
      out.items = [];
      for (const it of (v.items || [])) {        // car: every aircraft, no altitude filter
        const alert = it.level === 'ta' || it.level === 'warn';
        const x = (it.x * c - it.y * s) / rangeM, y = (it.x * s + it.y * c) / rangeM;
        if (!alert && Math.hypot(x, y) > 3.5) continue;
        let tag = '';
        if (it.relAltFt !== null && it.relAltFt !== undefined) {
          const h = S.altUnit === 'm' ? Math.round(Math.abs(it.relAltFt) * AC.U.FT / 10) : Math.round(Math.abs(it.relAltFt) / 100);
          tag = (it.relAltFt >= 0 ? '+' : '-') + String(Math.min(h, 99)).padStart(2, '0');
        }
        const tt = it.t || {}, rec = tt.rec || {};
        const kind = this.kind(rec);
        out.items.push({
          hex: it.hex, selected: !!(this.sel && this.sel.hex === it.hex),
          x: +x.toFixed(4), y: +y.toFixed(4), lv: it.level, tag, above: it.relAltFt === null || it.relAltFt >= 0,
          vs: Math.abs(it.vsFpm) >= 500 ? Math.sign(it.vsFpm) : 0,
          dir: tt.gs >= 8 ? G().norm180(tt.trk - own.trk) : null,
          kt: Math.round((tt.gs || 0) / AC.U.KT),                     // for the speed-scaled direction line
          lbl: rec.flight || rec.reg || tt.label || '',
          info: [kind === 'uav' ? 'UAV' : kind === 'mil' ? 'MIL' : '', /^(UAV|UAS)$/i.test(rec.type || '') ? '' : rec.type || '', tt.gs >= 3 ? `${F.speed(tt.gs)}${S.speedUnit === 'kmh' ? 'KMH' : 'KT'}` : '']
            .filter(Boolean).join(' '),
          kind,
          sim: !!rec.sim,
          cl: alert && AC.Display.closureTxt(it) || '',
          stale: !!tt.stale,
        });
      }
      out.card = this.card(own, v.items || []);
      // main alert (same wording as the phone display)
      const top = (App.alerts || [])[0];
      if (top) {
        const warning = top.level === 'warning' || top.level === 'warn';
        if (top.kind === 'traffic' && (top.level === 'ta' || warning)) out.alert = { label: 'TRAFFIC', lower: AC.Display.closureTxt(top.item) || '', red: warning };
        else if (top.kind === 'terrain') out.alert = { label: warning ? 'PULL UP' : 'CAUTION', lower: 'TERRAIN', red: warning };
        else if (top.kind === 'obstacle') out.alert = { label: warning ? 'PULL UP' : 'CAUTION', lower: 'OBSTACLE', red: warning };
      }
      // obstacle causing an alert (the car display shows only this one)
      out.obs = [];
      for (const a of (App.alerts || [])) {
        if (a.kind !== 'obstacle' || !a.obs || !a.obs.obs) continue;
        const ob = a.obs.obs, p0 = ob.pts[0];
        const e = G().enu(own.lat, own.lon, p0.lat, p0.lon);
        const d = (App.obsDisp || []).find((x) => x.o.id === ob.id);
        out.obs.push({
          x: +((e.x * c - e.y * s) / rangeM).toFixed(4), y: +((e.x * s + e.y * c) / rangeM).toFixed(4), red: a.level === 'warning',
          lbl: d ? `▲${F.alt(d.topFt * AC.U.FT)} ${F.altLabel()}` + (ob.sim ? ' SIM' : '') : (ob.sim ? 'SIM' : ''),
        });
      }
      const faults = [];
      if (f.gpsFail) faults.push('NO POSITION');
      else if (f.gpsDegraded) faults.push('GPS DEGRADED');
      if (f.tfcFail) faults.push('NO TRAFFIC DATA');
      else if (f.offline) faults.push('NO INTERNET');
      if (S.wxOn && f.wxNA) faults.push(f.wxNA === 'old' ? 'WX DATA OLD' : 'NO WX DATA');
      out.faults = faults;
      return JSON.stringify(out);
    },

    /**
     * Weather / terrain picture for the car display. The native side asks for a new one with underlayReq();
     * it is a square around the ownship that covers the whole display at ANY heading, so turning never shows
     * edges. It is computed in small steps (during the state polls), so the display never stutters; when
     * ready, state() reports a new underId and the native side fetches it with underlayGet().
     * size, R: pixels of the requested (reduced resolution) picture; the ownship is in its centre.
     */
    underlayReq(size, R) {
      const App = AC.App, S = AC.settings, D = AC.Display;
      const terrOn = S.terrOn || D.terrPopup;
      const wxOn = S.wxOn && !App.wxSuppressed();
      if (this._ub || App.phase !== 'run' || !App.own || !(wxOn || terrOn)) return;
      if (!this._v) this._v = Object.create(D);
      const own = Object.assign({}, this._v.view({ own: App.own, tfc: null, tickAt: App._tickAt }).own);
      const c = size / 2;
      const geo = { cx: c, cy: c, R, k: R / AC.Fmt.rangeM(), arc: false, u: size / 500 };
      const V = Object.create(D);   // renderer on the car geometry (same code as the phone display)
      V.W = size; V.H = size; V.dpr = 1;
      V.geom = () => geo;
      V.wx = { ahead: false, maxDbz: -128 };
      const far = c * Math.SQRT2 / geo.k;
      AC.Terrain.prefetch(own.lat, own.lon, Math.min(60000, far));
      if (wxOn) AC.Weather.update(own, far / AC.U.NM);
      this._ub = {
        own, geo, size, terr: terrOn, wx: wxOn,
        jobs: [terrOn ? V.makeJob('terr', own, geo) : null, wxOn ? V.makeJob('wx', own, geo) : null].filter(Boolean),
      };
    },

    /** Work on the pending picture for at most budget ms. */
    _stepUnderlay(budget) {
      const b = this._ub;
      if (!b) return;
      const t0 = performance.now();
      for (const j of b.jobs) {
        if (j.done) continue;
        AC.Display.stepJob.call(j._v || AC.Display, j, Math.max(1, budget - (performance.now() - t0)));
        if (!j.done) return;
      }
      // all parts ready: compose and encode
      const cv = document.createElement('canvas');
      cv.width = cv.height = b.size;
      const g = cv.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, b.size, b.size);
      for (const j of b.jobs) {
        if (j.kind === 'terr') {
          for (const key in (j.cv.paths || {})) {
            const [r, gg, bb, dense] = key.split(',').map(Number);
            g.fillStyle = `rgba(${r},${gg},${bb},${dense ? 0.55 : 0.3})`;   // EGPWS density as solid tint (no moire)
            g.fill(j.cv.paths[key]);
          }
        } else {
          g.globalAlpha = AC.settings.wxAlpha || 0.5;      // weather opacity setting
          g.drawImage(j.cv, 0, 0);
          g.globalAlpha = 1;
        }
      }
      this._under = {
        id: (this._under ? this._under.id : 0) + 1,
        img: cv.toDataURL('image/jpeg', 0.8),
        pose: { lat: b.own.lat, lon: b.own.lon, trk: b.own.trk, k: b.geo.k, cx: b.geo.cx, cy: b.geo.cy },
      };
      this._ub = null;
    },

    underlayGet() { return JSON.stringify(this._under || {}); },

    /**
     * Self test on the car display: drawn with the same code as on the phone, into a picture of the car
     * display size (w x h), returned as a JPEG data URL (the native side shows it while phase = boot).
     */
    bootFrame(w, h) {
      if (AC.App.phase !== 'boot') return '';
      const D = AC.Display;
      if (!this._bv || this._bv.W !== w || this._bv.H !== h) {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const V = Object.create(D);
        V.c = cv; V.g = cv.getContext('2d'); V.W = w; V.H = h; V.dpr = 1; V._ring = null;
        this._bv = V;
      }
      const V = this._bv, g = V.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
      V.flash = Math.floor(performance.now() / 500) % 2 === 0;
      AC.SelfTest.draw(V);
      return V.c.toDataURL('image/jpeg', 0.85);
    },

    /**
     * Road geometry for the native side, in chunks of 1500 ways (results of evaluateJavascript must stay small).
     * Compact text: ways separated by ";", each "class:x0,y0,dx1,dy1,..." in units of 10 m (first point absolute).
     */
    roads(chunk) {
      const R = AC.Roads;
      const N = 1500;
      if (!R.ref) return JSON.stringify({ ver: R.ver, n: 0 });
      const n = Math.ceil(R.ways.length / N);
      const parts = [];
      for (const w of R.ways.slice(chunk * N, (chunk + 1) * N)) {
        const p = w.p, s = [];
        let px = 0, py = 0;
        for (let i = 0; i < p.length; i += 2) {
          const x = Math.round(p[i] / 10), y = Math.round(p[i + 1] / 10);
          s.push(i === 0 ? x : x - px, i === 0 ? y : y - py);
          px = x; py = y;
        }
        parts.push(w.c + ':' + s.join(','));
      }
      const out = { ver: R.ver, ref: R.ref, n, i: chunk, d: parts.join(';') };
      if (chunk === 0) out.ap = (R.airports || []).map((a) => [a.x, a.y, a.code, a.big ? 1 : 0]);   // aerodrome markers
      return JSON.stringify(out);
    },

    /** Buttons on the car screen (and the phone remote). */
    key(k) {
      if (AC.App.phase === 'off') { if (k === 'pwr') AC.App.powerOn(); return; }
      if (k === 'carOverhead') {
        const st = this.OH_STEPS, i = st.indexOf(AC.settings.carOverhead);
        AC.Settings.set('carOverhead', st[(i + 1) % st.length]);
      }
      if (k === 'carAlt') {
        const st = this.ALT_STEPS, i = st.indexOf(AC.settings.carAltM);
        AC.Settings.set('carAltM', st[(i + 1) % st.length]);
        AC.TrafficLogic.reset();
      }
      if (['rngUp', 'rngDn', 'terr', 'sens', 'mute', 'mode'].includes(k)) AC.App.softkey(k);
      AC.App.syncForm && AC.App.syncForm();
    },

    onConnect() {
      this.remoteDismissed = false;
      if (AC.App.updateRemote) AC.App.updateRemote();
    },
  };

  AC.Car = Car;
})(window.AC = window.AC || {});
