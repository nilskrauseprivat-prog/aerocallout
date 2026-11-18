/*
 * AeroCallout - flight simulator and test scenarios.
 * Simulated traffic is injected into the same ADS-B pipeline as live data.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  const PRESETS = {
    frankfurt: { name: 'Frankfurt (viel Live-Verkehr)', lat: 50.10, lon: 8.35, altFt: 5000, hdg: 70, gsKt: 120 },
    munich: { name: 'München', lat: 48.30, lon: 11.55, altFt: 4500, hdg: 80, gsKt: 110 },
    hamburg: { name: 'Hamburg', lat: 53.55, lon: 9.80, altFt: 3000, hdg: 90, gsKt: 110 },
    innsbruck: { name: 'Innsbruck (Gebirge, echtes Gelände)', lat: 47.255, lon: 11.20, altFt: 6500, hdg: 85, gsKt: 100 },
    zugspitze: { name: 'Zugspitze (echtes Gelände)', lat: 47.47, lon: 10.88, altFt: 8000, hdg: 100, gsKt: 100 },
  };

  const SCENARIOS = [
    { id: 'headon', name: 'Frontal, gleiche Höhe', expect: 'Proximate → TA ~40 s → Warnung ~15 s vor CPA' },
    { id: 'cross-right', name: 'Kreuzend von rechts', expect: 'TA „2–3 Uhr“, dann Warnung' },
    { id: 'cross-left-desc', name: 'Von links, sinkend von oben', expect: 'TA „high“ mit Abwärtspfeil' },
    { id: 'overtake', name: 'Überholer von hinten', expect: 'TA „6 Uhr“' },
    { id: 'climb-below', name: 'Steigend von unten', expect: 'TA „low“ mit Aufwärtspfeil' },
    { id: 'near-miss', name: 'Vorbeiflug 0,6 NM', expect: 'TA, aber keine Warnung' },
    { id: 'parallel', name: 'Parallelflug 1 NM / +500 ft', expect: 'nur Proximate, keine Ansage (Fehlalarmtest)' },
    { id: 'above', name: 'Frontal, 1500 ft höher', expect: 'kein TA (vertikal getrennt)' },
    { id: 'glider', name: 'Kreisender Segelflieger voraus', expect: 'TA mit Kurvenvorhersage' },
    { id: 'multi', name: 'Mehrere Ziele', expect: 'Priorisierung, Ansage des dringendsten Ziels' },
    { id: 'terrain-ridge', name: 'Gelände: Bergrücken voraus', expect: '„Caution Terrain“ → „Terrain, Pull up“' },
    { id: 'terrain-descent', name: 'Gelände: Sinkflug ins Gelände', expect: 'Caution → Warning' },
    { id: 'obstacle-mast', name: 'Hindernis: Sendemast voraus', expect: '„Obstacle, Obstacle, Pull up“' },
    { id: 'powerline', name: 'Hindernis: Hochspannungsleitung (tief)', expect: 'Obstacle-Warnung' },
    { id: 'mixed', name: 'Gelände + Verkehr gleichzeitig', expect: 'Terrain hat Vorrang, Verkehr wird unterdrückt' },
    { id: 'terrain-complex', name: 'Gebirgsflug mit Kursänderungen (≈ 2,5 min)', expect: 'Autopilot: Rechtskurve auf Bergmassiv → Caution/Pull up → Ausweichen mit Steigflug → Grat mit Sendemast → Obstacle → Überflug' },
    { id: 'wx-cell', name: 'WX: Gewitterzelle voraus', expect: 'grün/gelb/rot/magenta + Blitzsymbol, WX AHEAD' },
    { id: 'wx-line', name: 'WX: Gewitterlinie', expect: 'Zellenlinie im Sektor' },
    { id: 'wx-rain', name: 'WX: großflächiger Regen', expect: 'grün, GAIN-Test' },
    { id: 'gps-fail', name: 'Ausfall: GPS (20 s)', expect: 'GPS FAIL, Warnungen gesperrt' },
    { id: 'adsb-fail', name: 'Ausfall: ADS-B-Daten (30 s)', expect: 'TFC FAIL nach 15 s' },
  ];

  const Sim = {
    PRESETS, SCENARIOS,
    own: null,
    intruders: [],
    scenario: null,
    paused: false,
    gpsFailUntil: 0,
    _last: 0,

    reset(presetId, gps) {
      const p = presetId === 'gps' && gps
        ? { lat: gps.lat, lon: gps.lon, altFt: (gps.altMSL || 1000) / U().FT + 2000, hdg: gps.trk || 0, gsKt: 110 }
        : (PRESETS[presetId] || PRESETS.frankfurt);
      this.own = { lat: p.lat, lon: p.lon, altFt: p.altFt, hdg: p.hdg, gsKt: p.gsKt, vsFpm: 0, turn: 0 };
      this.clearScenario();
    },

    ensure() { if (!this.own) this.reset('frankfurt'); },

    // ------------------------------------------------------------ live test at the real position
    /**
     * Live test: a traffic / weather scenario around the REAL ownship (GPS, car or aircraft). The test
     * aircraft appear for the duration of the scenario, trigger the normal alerts and callouts and then
     * disappear again. Terrain / obstacle / GPS-failure scenarios are not offered here (they would replace
     * real data) - they run in the full simulation only.
     */
    live: null,             // {id, until}
    LIVE_OK: /^(headon|cross-right|cross-left-desc|overtake|climb-below|near-miss|parallel|above|glider|multi|wx-cell|wx-line|wx-rain|adsb-fail)$/,

    startLive(id, real) {
      if (!this.LIVE_OK.test(id) || !real) return false;
      // scenario geometry is built around the real position, track, speed and altitude
      this.own = {
        lat: real.lat, lon: real.lon, altFt: (real.altMSL || 0) / U().FT,
        hdg: real.trk || 0, gsKt: (real.gs || 0) / U().KT, vsFpm: 0, turn: 0,
      };
      this.load(id);
      const now = Date.now();
      const dur = id.startsWith('wx') ? 60 : id === 'adsb-fail' ? 35 : Math.max(60, (this.maxTca || 60) + 35);
      this.live = { id, until: now + dur * 1000, start: now };
      this._last = now;
      return true;
    },

    /** Called from the logic cycle while the system runs on real data. */
    stepLive(now) {
      if (!this.live) return;
      if (now >= this.live.until) { this.endLive(); return; }
      const dt = this._last ? Math.min(2, (now - this._last) / 1000) : 0;
      this._last = now;
      for (const it of this.intruders) {
        const q = G().advance(it.lat, it.lon, it.trk, it.gsKt * U().KT, it.turn || 0, dt);
        it.lat = q.lat; it.lon = q.lon; it.trk = q.trk;
        it.altFt += it.vsFpm * dt / 60;
      }
      if (this.intruders.length) AC.Adsb.injectSim(this.records(now), true);
    },

    endLive() {
      this.live = null;
      this.clearScenario();      // removes the test aircraft and synthetic weather
    },

    liveLeft() { return this.live ? Math.max(0, Math.ceil((this.live.until - Date.now()) / 1000)) : 0; },

    step(now) {
      this.ensure();
      const dt = this._last ? Math.min(2, (now - this._last) / 1000) : 0;
      this._last = now;
      if (this.paused || dt <= 0) return;
      const o = this.own;
      // Scripted autopilot: apply the legs whose start time has been reached (pilot inputs stay possible).
      if (this.script) {
        this.scriptElapsed += dt;
        while (this.scriptIdx < this.script.length && this.script[this.scriptIdx].at <= this.scriptElapsed) {
          const s = this.script[this.scriptIdx++];
          if ('turn' in s) o.turn = s.turn;
          if ('vs' in s) o.vsFpm = s.vs;
          this.scriptLabel = s.label;
        }
      }
      const p = G().advance(o.lat, o.lon, o.hdg, o.gsKt * U().KT, o.turn, dt);
      o.lat = p.lat; o.lon = p.lon; o.hdg = p.trk;
      o.altFt = Math.max(0, o.altFt + o.vsFpm * dt / 60);
      for (const it of this.intruders) {
        const q = G().advance(it.lat, it.lon, it.trk, it.gsKt * U().KT, it.turn || 0, dt);
        it.lat = q.lat; it.lon = q.lon; it.trk = q.trk;
        it.altFt += it.vsFpm * dt / 60;
      }
    },

    /** Ownship in the same format as AC.Gps.state, or null during a simulated GPS failure. */
    ownState(now) {
      this.ensure();
      if (now < this.gpsFailUntil) return null;
      const o = this.own;
      const geoid = AC.settings.geoidM;
      return {
        lat: o.lat, lon: o.lon,
        altMSL: o.altFt * U().FT,
        altHAE: o.altFt * U().FT + geoid,
        gs: o.gsKt * U().KT, trk: o.hdg, vs: o.vsFpm * U().FPM, turnRate: o.turn,
        acc: 5, altAcc: 8, t: now, source: 'sim',
      };
    },

    /** ADS-B records for the simulated intruders. */
    records(now) {
      const geoidFt = AC.settings.geoidM / U().FT;
      return this.intruders.map((it) => ({
        hex: it.hex, flight: it.label, reg: '', type: it.type || '', category: it.category || 'A1', mil: !!it.mil, sim: true,
        lat: it.lat, lon: it.lon, posTime: now, ground: false,
        altGeomFt: it.altFt + geoidFt, altBaroFt: it.altFt,
        gsKt: it.gsKt, trk: it.trk, trackRate: it.turn || 0, vsFpm: it.vsFpm,
        nacp: 10, nic: 8, mlat: false, tisb: false, squawk: '7000', emergency: '',
      }));
    },

    clearScenario() {
      this.intruders = [];
      this.scenario = null;
      this.script = null;
      this.scriptLabel = '';
      this.scriptElapsed = 0;
      this.scriptIdx = 0;
      this.gpsFailUntil = 0;
      AC.Adsb.blockedUntil = 0;
      AC.Terrain.override = null;
      AC.Obstacles.synthetic = [];
      AC.Weather.synthetic = [];
      AC.Weather.syntheticThunder = [];
      for (const k of [...AC.Adsb.targets.keys()]) if (k.startsWith('sim')) AC.Adsb.targets.delete(k);
    },

    /**
     * Builds an intruder that reaches the closest point of approach after `tca` seconds.
     * relTrk: intruder track relative to own heading; missNM: lateral miss distance; relAltFt: altitude difference at CPA.
     */
    conflict(o) {
      const own = this.own;
      const vo = G().vel(own.gsKt * U().KT, own.hdg, 0);
      const trk = G().norm360(own.hdg + o.relTrk);
      const vi = G().vel(o.gsKt * U().KT, trk, 0);
      const miss = (o.missNM || 0) * U().NM;
      const perp = { x: Math.cos(G().toRad(trk)) * miss, y: -Math.sin(G().toRad(trk)) * miss };
      const sx = vo.x * o.tca + perp.x - vi.x * o.tca;
      const sy = vo.y * o.tca + perp.y - vi.y * o.tca;
      const p = G().offset(own.lat, own.lon, sx, sy);
      const altCpa = own.altFt + own.vsFpm * o.tca / 60 + (o.relAltFt || 0);
      return {
        hex: o.hex, label: o.label, lat: p.lat, lon: p.lon, trk, gsKt: o.gsKt,
        altFt: altCpa - (o.vsFpm || 0) * o.tca / 60, vsFpm: o.vsFpm || 0, turn: o.turn || 0,
      };
    },

    ahead(distM, lateralM) {
      const own = this.own;
      const h = G().toRad(own.hdg);
      const e = Math.sin(h) * distM + Math.cos(h) * (lateralM || 0);
      const n = Math.cos(h) * distM - Math.sin(h) * (lateralM || 0);
      return G().offset(own.lat, own.lon, e, n);
    },

    /**
     * Synthetic terrain relative to the current position/heading: rolling base plus optional ridge.
     * Detailed outlines: several noise layers (valleys, spurs, saddles, single summits) so the terrain picture
     * looks like real mountains. The base stays below the scenario's safety margins, the ridge crest
     * varies along its length but never drops below 85 % of the requested height (the alerts still happen).
     */
    terrainProfile(baseM, ridge) {
      const own = this.own;
      const o = { lat: own.lat, lon: own.lon }, h = G().toRad(own.hdg);
      const n2 = (x, y) =>                                   // smooth pseudo noise, -1 .. 1 (km-scale + fine detail)
        0.40 * Math.sin(x / 4300 + 1.3) * Math.cos(y / 5200 + 0.7) +
        0.28 * Math.sin(x / 1900 + y / 2300 + 2.1) +
        0.17 * Math.sin(x / 780 - y / 950 + 0.4) +
        0.10 * Math.cos(x / 310 + y / 370) +
        0.05 * Math.sin(x / 120 - y / 90);
      AC.Terrain.override = (lat, lon) => {
        const e = G().enu(o.lat, o.lon, lat, lon);
        const along = e.x * Math.sin(h) + e.y * Math.cos(h);
        const lateral = e.x * Math.cos(h) - e.y * Math.sin(h);
        // rolling hills and valleys in the foreland (up to ~180 m relief), staying below the alert margins
        let z = baseM - 90 + 90 * n2(e.x, e.y);
        if (!ridge) return z;
        // massif: strongly curving crest line (km scale), varying width, spurs reaching out, individual summits
        const bend = 1500 * Math.sin(lateral / 4200) + 550 * Math.sin(lateral / 1350 + 1.1) + 180 * Math.sin(lateral / 420);
        const width = ridge.width * (0.8 + 0.6 * (0.5 + 0.5 * Math.sin(lateral / 2600 + 0.8)));
        const spur = Math.max(0, Math.sin(lateral / 1900 + 2.0)) * 1200;      // spurs reaching towards the ownship
        const u = (along - ridge.start - bend + spur * 0.5) / (width + spur);
        if (u <= 0 || u >= 1) return z;
        const shape = Math.pow(Math.sin(u * Math.PI), u < 0.45 ? 0.7 : 1.3);
        const summits = 0.07 * Math.max(0, Math.sin(lateral / 900)) + 0.05 * n2(lateral * 2, along * 2);
        const crest = ridge.height * Math.max(0.85, 0.92 + summits + 0.06 * Math.sin(lateral / 3100));
        return Math.max(z, baseM + crest * shape + 35 * n2(along * 3, lateral * 3) * shape);
      };
    },

    // ------------------------------------------------------------ terrain / obstacle / GPS tests
    /**
     * Test flight from the real position: these scenarios need a moving aircraft and synthetic terrain, so a
     * short simulated flight starts exactly at the real position and track, runs the scenario and switches
     * back to live data automatically when it is over.
     */
    testRun: null,          // {id, until}

    startTest(id, real) {
      if (!real) return false;
      AC.App.toggleSim(true);
      this.reset('gps', real);
      this.load(id);
      const dur = id === 'terrain-complex' ? 160 : id === 'gps-fail' ? 32 : 50;
      this.testRun = { id, until: Date.now() + dur * 1000 };
      return true;
    },

    checkTest(now) {
      if (this.testRun && now >= this.testRun.until) this.endTest();
    },

    endTest() {
      if (!this.testRun) return;
      this.testRun = null;
      this.clearScenario();
      AC.App.toggleSim(false);
    },

    testLeft() {
      const t = this.live || this.testRun;
      return t ? Math.max(0, Math.ceil((t.until - Date.now()) / 1000)) : 0;
    },

    load(id) {
      this.ensure();
      this.clearScenario();
      this.scenario = id;
      const own = this.own;
      const ownAltM = own.altFt * U().FT;
      const now = Date.now();
      this.maxTca = 0;
      const add = (o) => { this.maxTca = Math.max(this.maxTca, o.tca || 0); this.intruders.push(this.conflict(o)); };
      switch (id) {
        case 'headon':
          add({ hex: 'sim001', label: 'SIM001', relTrk: 180, gsKt: 120, tca: 75 }); break;
        case 'cross-right':
          add({ hex: 'sim002', label: 'SIM002', relTrk: 270, gsKt: 110, tca: 60, relAltFt: 100 }); break;
        case 'cross-left-desc':
          add({ hex: 'sim003', label: 'SIM003', relTrk: 90, gsKt: 130, tca: 60, missNM: 0.1, vsFpm: -700 }); break;
        case 'overtake':
          add({ hex: 'sim004', label: 'SIM004', relTrk: 0, gsKt: own.gsKt + 70, tca: 70, relAltFt: 50 }); break;
        case 'climb-below':
          add({ hex: 'sim005', label: 'SIM005', relTrk: 140, gsKt: 100, tca: 60, vsFpm: 1200 }); break;
        case 'near-miss':
          add({ hex: 'sim006', label: 'SIM006', relTrk: 180, gsKt: 120, tca: 70, missNM: 0.6 }); break;
        case 'parallel': {
          const p = this.ahead(0, 1 * U().NM);
          this.intruders.push({ hex: 'sim007', label: 'SIM007', lat: p.lat, lon: p.lon, trk: own.hdg, gsKt: own.gsKt, altFt: own.altFt + 500, vsFpm: 0, turn: 0 });
          break;
        }
        case 'above':
          add({ hex: 'sim008', label: 'SIM008', relTrk: 180, gsKt: 120, tca: 70, relAltFt: 1500 }); break;
        case 'glider': {
          const p = this.ahead(2.2 * U().NM, 150);
          this.intruders.push({ hex: 'sim009', label: 'D-KXYZ', type: 'GLID', lat: p.lat, lon: p.lon, trk: 0, gsKt: 45, altFt: own.altFt + 100, vsFpm: 300, turn: 18 });
          break;
        }
        case 'multi':
          add({ hex: 'sim011', label: 'SIM011', relTrk: 270, gsKt: 110, tca: 55, relAltFt: 200 });
          add({ hex: 'sim012', label: 'SIM012', relTrk: 180, gsKt: 130, tca: 90, relAltFt: 1500 });
          add({ hex: 'sim013', label: 'SIM013', relTrk: 20, gsKt: own.gsKt + 60, tca: 80, relAltFt: -300, vsFpm: 300 });
          add({ hex: 'sim014', label: 'SIM014', relTrk: 100, gsKt: 90, tca: 120, missNM: 3 });
          add({ hex: 'sim015', label: 'SIM015', relTrk: 200, gsKt: 140, tca: 45, missNM: 0.3, relAltFt: -100 });
          break;
        case 'terrain-ridge':
          this.terrainProfile(ownAltM - 600, { start: 4500, width: 3000, height: 600 + 250 }); break;
        case 'terrain-descent':
          own.vsFpm = -1500;
          this.terrainProfile(ownAltM - 1200 * U().FT); break;
        case 'obstacle-mast': {
          this.terrainProfile(ownAltM - 800 * U().FT);
          const p = this.ahead(3500, 0);
          AC.Obstacles.synthetic = [{ id: 'sim-mast', kind: 'mast', name: 'SIM MAST', pts: [p], h: 900 * U().FT }];
          break;
        }
        case 'powerline': {
          // Flying 350 ft AGL towards a 380 kV line spanning a valley (cable ~105 m above ground)
          this.terrainProfile(ownAltM - 350 * U().FT);
          const a = this.ahead(3000, -3000), b = this.ahead(3000, 3000);
          AC.Obstacles.synthetic = [{ id: 'sim-line', kind: 'line', name: 'SIM 380kV', pts: [a, b], h: 105 }];
          break;
        }
        case 'mixed':
          this.terrainProfile(ownAltM - 600, { start: 4500, width: 3000, height: 850 });
          add({ hex: 'sim021', label: 'SIM021', relTrk: 270, gsKt: 110, tca: 55 });
          break;
        case 'wx-cell': {
          const c = this.ahead(15 * U().NM, 1 * U().NM);
          AC.Weather.synthetic = [{ lat: c.lat, lon: c.lon, r: 5 * U().NM, peak: 58 }];
          AC.Weather.syntheticThunder = [{ lat: c.lat, lon: c.lon, code: 95 }];
          break;
        }
        case 'wx-line': {
          const cells = [];
          for (let i = -3; i <= 3; i++) {
            const c = this.ahead(25 * U().NM + i * 1.5 * U().NM, i * 6 * U().NM);
            cells.push({ lat: c.lat, lon: c.lon, r: (3 + Math.abs(i % 2)) * U().NM, peak: 44 + ((i + 3) * 7) % 18 });
          }
          AC.Weather.synthetic = cells;
          AC.Weather.syntheticThunder = [cells[2], cells[4]].map((c) => ({ lat: c.lat, lon: c.lon, code: 96 }));
          break;
        }
        case 'wx-rain': {
          const c = this.ahead(12 * U().NM, -4 * U().NM);
          AC.Weather.synthetic = [{ lat: c.lat, lon: c.lon, r: 22 * U().NM, peak: 36 }];
          break;
        }
        case 'terrain-complex':
          this.loadMountainFlight();
          break;
        case 'gps-fail':
          this.gpsFailUntil = now + 20000; break;
        case 'adsb-fail':
          AC.Adsb.blockedUntil = now + 30000; break;
        default: break;
      }
    },

    /**
     * Mountain flight: scripted course and altitude changes over synthetic, structured terrain.
     *  - rolling hills well below the aircraft, wind turbines on the hills (visible, not dangerous)
     *  - a 60° right turn points the aircraft at a mountain massif -> Caution Terrain -> Pull up
     *  - the "pilot" turns left 90° and climbs -> alert clears
     *  - later a ridge with a transmitter mast on the flight path -> Caution / Warning Obstacle -> climb over it
     * The terrain is built around the pre-computed scripted trajectory, so the events always happen.
     */
    loadMountainFlight() {
      const own = this.own;
      const FT = U().FT;
      own.vsFpm = 0;
      own.turn = 0;
      const A = own.altFt * FT;                      // start altitude (m MSL)
      const O = { lat: own.lat, lon: own.lon };

      const script = [
        { at: 0, turn: 0, vs: 0, label: 'Geradeaus über hügeliges Gelände' },
        { at: 25, turn: 3, label: 'Rechtskurve 60° – neuer Kurs zeigt auf ein Bergmassiv' },
        { at: 45, turn: 0, label: 'Geradeaus auf das Bergmassiv zu' },
        { at: 72, turn: -3, vs: 2000, label: 'Reaktion auf PULL UP: Linkskurve 90° und Steigflug' },
        { at: 102, turn: 0, label: 'Geradeaus, weiter im Steigflug' },
        { at: 112, vs: 0, label: 'Horizontalflug – voraus ein Grat mit Sendemast' },
        { at: 125, vs: 2500, label: 'Reaktion auf OBSTACLE: Steigflug über den Mast' },
        { at: 150, vs: 0, label: 'Horizontalflug – Szenario beendet' },
      ];

      // Pre-compute the scripted trajectory in local coordinates around O.
      const traj = [];
      let lat = own.lat, lon = own.lon, hdg = own.hdg, altFt = own.altFt, turn = 0, vs = 0, k = 0;
      for (let t = 0; t <= 220; t += 0.5) {
        while (k < script.length && script[k].at <= t) {
          if ('turn' in script[k]) turn = script[k].turn;
          if ('vs' in script[k]) vs = script[k].vs;
          k++;
        }
        const e = G().enu(O.lat, O.lon, lat, lon);
        traj.push({ x: e.x, y: e.y, hdg, altFt });
        const p = G().advance(lat, lon, hdg, own.gsKt * U().KT, turn, 0.5);
        lat = p.lat; lon = p.lon; hdg = p.trk;
        altFt += vs * 0.5 / 60;
      }
      const at = (t) => traj[Math.round(t * 2)];

      const base0 = A - 1500 * FT;                   // valley floor 1500 ft below start altitude
      // Mountain massif 4.5 km ahead of the aircraft after the right turn, peak 1500 ft above it.
      const p45 = at(45), hM = G().toRad(p45.hdg);
      const M = { x: p45.x + Math.sin(hM) * 4500, y: p45.y + Math.cos(hM) * 4500 };
      const mtnH = (A + 1500 * FT) - base0;
      // Secondary peak beside the massif (off the flight path), for a more realistic picture.
      const M2 = { x: M.x + Math.cos(hM) * 3500 + Math.sin(hM) * 1500, y: M.y - Math.sin(hM) * 3500 + Math.cos(hM) * 1500 };
      // Ridge across the track at t = 140 s, 700 ft below the aircraft's level flight altitude there.
      const p140 = at(140), hR = G().toRad(at(115).hdg);
      const levelFt = at(115).altFt;
      const ridgeH = (levelFt - 700) * FT - base0;

      const fn = (x, y) => {
        let e = base0 + 25 * Math.sin(x / 1300) * Math.cos(y / 1700) + 20 * Math.sin((x + 2 * y) / 2300);
        e += mtnH * Math.exp(-(((x - M.x) ** 2 + (y - M.y) ** 2) / (2000 ** 2)));
        e += 0.75 * mtnH * Math.exp(-(((x - M2.x) ** 2 + (y - M2.y) ** 2) / (1600 ** 2)));
        const rx = x - p140.x, ry = y - p140.y;
        const along = rx * Math.sin(hR) + ry * Math.cos(hR);
        const across = rx * Math.cos(hR) - ry * Math.sin(hR);
        e += ridgeH * Math.exp(-((along / 450) ** 2)) * Math.exp(-((across / 6000) ** 2));
        return e;
      };
      AC.Terrain.override = (la, lo) => { const e = G().enu(O.lat, O.lon, la, lo); return fn(e.x, e.y); };

      // Transmitter mast on the ridge, top 250 ft above the level flight altitude.
      const mastPos = G().offset(O.lat, O.lon, p140.x, p140.y);
      const mastTop = (levelFt + 250) * FT;
      const obs = [{ id: 'sim-ridge-mast', kind: 'mast', name: 'SIM Sendemast', pts: [mastPos], h: mastTop - fn(p140.x, p140.y) }];
      // Wind turbines on the hills beside the first leg (well below - shown, but no alert).
      for (let i = 0; i < 4; i++) {
        const p = at(6 + i * 5);
        const h = G().toRad(p.hdg);
        const side = i % 2 ? 1 : -1;
        const x = p.x + Math.cos(h) * 1400 * side, y = p.y - Math.sin(h) * 1400 * side;
        obs.push({ id: 'sim-wind-' + i, kind: 'wind', name: 'SIM Windrad', pts: [G().offset(O.lat, O.lon, x, y)], h: 200 });
      }
      AC.Obstacles.synthetic = obs;

      this.script = script;
      this.scriptIdx = 0;
      this.scriptElapsed = 0;
      this.scriptLabel = script[0].label;
    },

    key(e) {
      if (!AC.settings.simEnabled) return false;
      this.ensure();
      const o = this.own;
      switch (e.key) {
        case 'ArrowLeft': o.turn = Math.max(-3, o.turn - 1.5); break;
        case 'ArrowRight': o.turn = Math.min(3, o.turn + 1.5); break;
        case 'ArrowUp': o.vsFpm = Math.min(3000, o.vsFpm + 500); break;
        case 'ArrowDown': o.vsFpm = Math.max(-3000, o.vsFpm - 500); break;
        case 'PageUp': o.gsKt = Math.min(400, o.gsKt + 10); break;
        case 'PageDown': o.gsKt = Math.max(0, o.gsKt - 10); break;
        case 'l': case 'L': o.turn = 0; o.vsFpm = 0; break;
        case 'p': case 'P': this.paused = !this.paused; break;
        default: return false;
      }
      return true;
    },
  };

  AC.Sim = Sim;
})(window.AC = window.AC || {});
