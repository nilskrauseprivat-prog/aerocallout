/*
 * AeroCallout - power-up self test.
 * Stages (hard cuts, no effects):
 *   POST    - checks of the functions the system relies on. Waits until every check has a result
 *             (or a time limit is reached), so a slow / failed connection keeps the page up longer.
 *   PATTERN - display test pattern (TCAS symbols, WX colour bands, annunciators) and aural test.
 *   RESULT  - "SELF TEST PASS" briefly, or a fault page that stays up longer and is announced.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;

  const LINE_DT = 300;        // ms between POST lines
  const TYPE_MS = 230;        // typing time of one POST line
  const CHAR_W = 1;           // cursor / result positions in monospace cells
  const RES_X = 23;           // column of the check results
  const POST_MIN = 2600;      // minimum time on the POST page
  const POST_MAX = 15000;     // give up waiting for checks after this
  const PATTERN = 4500;
  const RESULT_OK = 1400;
  const RESULT_FAULT = 7500;

  const ITEMS = [
    { key: 'gps', label: 'GPS POSITION .........', fault: 'NO GPS POSITION' },
    { key: 'adsb', label: 'ADS-B TRAFFIC LINK ...', fault: 'NO TRAFFIC DATA (ADS-B)' },
    { key: 'terr', label: 'TERRAIN DATABASE .....', fault: 'NO TERRAIN DATA - TERRAIN ALERTS LIMITED' },
    { key: 'obs', label: 'OBSTACLE DATABASE ....', fault: 'NO OBSTACLE DATA - OBSTACLE ALERTS LIMITED' },
    { key: 'wx', label: 'WEATHER RADAR DATA ...', fault: 'NO WEATHER DATA' },
    { key: 'audio', label: 'AUDIO / VOICE ........', fault: 'NO VOICE OUTPUT - ALERT TONES ONLY' },
  ];
  const GOOD = ['PASS', 'SIM', 'OFF'];

  const SelfTest = {
    active: false,
    stage: 'post',
    stageT0: 0,
    results: {},
    faults: [],
    spoke: {},
    onDone: null,

    run(onDone) {
      this.onDone = onDone;
      this.active = true;
      this.stage = 'post';
      this.stageT0 = performance.now();
      this.spoke = {};
      this.faults = [];
      const S = AC.settings;
      const hasSpeech = 'speechSynthesis' in window;
      this.results = {
        gps: S.simEnabled ? 'SIM' : 'PEND',
        adsb: 'PEND',
        terr: 'PEND',
        obs: S.osmObstacles ? 'PEND' : 'OFF',
        wx: 'PEND',
        // Voice output is shown green whenever a speech engine is present.
        audio: hasSpeech ? 'PASS' : 'FAIL',
      };
      this._check('adsb', () => fetch(AC.Adsb.url('adsbfi', 50, 8.5, 5), { cache: 'no-store' }).then((r) => r.ok));
      this._check('terr', () => fetch(AC.Terrain.url.replace('{z}', '3').replace('{x}', '4').replace('{y}', '2')).then((r) => r.ok));
      this._check('wx', () => fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' }).then((r) => r.ok));
      if (S.osmObstacles) {
        this._check('obs', async () => {
          if (AC.Obstacles.list.length) return true;
          if ('caches' in window) {
            const c = await caches.open('ac-obstacles-v1').catch(() => null);
            if (c && await c.match('/__obstacles_latest')) return true;
          }
          const r = await fetch('https://overpass-api.de/api/status', { cache: 'no-store' });
          return r.ok;
        }, 'N/A');
      }
    },

    _check(key, fn, failText) {
      const timer = new Promise((res) => setTimeout(() => res(false), 9000));
      Promise.race([Promise.resolve().then(fn).catch(() => false), timer]).then((ok) => {
        if (this.results[key] === 'PEND') this.results[key] = ok ? 'PASS' : (failText || 'FAIL');
      });
    },

    skip() {
      if (!this.active) return;
      this._finish();
    },

    _finish() {
      this.active = false;
      const cb = this.onDone;
      this.onDone = null;
      if (cb) cb();
    },

    _say(key, text) {
      if (this.spoke[key]) return;
      this.spoke[key] = true;
      AC.Voice.say(text, 10, { level: 'info', force: true });
    },

    /** Progress is time / result driven and also runs from the logic loop (independent of screen refresh). */
    update() {
      if (!this.active) return;
      const t = performance.now() - this.stageT0;
      const r = this.results;

      // GPS result follows the live receiver state.
      if (r.gps === 'PEND') {
        if (AC.Gps.status === 'denied' || AC.Gps.status === 'unavailable') r.gps = 'FAIL';
        else if (AC.Gps.state && AC.Gps.state.acc < 300) r.gps = 'PASS';
      }

      if (this.stage === 'post') {
        const allLinesShown = t >= LINE_DT * (ITEMS.length + 2);
        const resolved = ITEMS.every((it) => r[it.key] !== 'PEND');
        if ((t >= POST_MIN && allLinesShown && resolved) || t >= POST_MAX) {
          ITEMS.forEach((it) => { if (r[it.key] === 'PEND') r[it.key] = it.key === 'gps' ? 'NO FIX' : (it.key === 'obs' ? 'N/A' : 'FAIL'); });
          this.stage = 'pattern';
          this.stageT0 = performance.now();
        }
      } else if (this.stage === 'pattern') {
        if (t > 400) this._say('tfc', AC.Voice.phr().test);
        if (t > 2600) this._say('terr', AC.Voice.phr().testTerr);
        if (t >= PATTERN) {
          this.faults = ITEMS.filter((it) => !GOOD.includes(r[it.key]));
          this.stage = 'result';
          this.stageT0 = performance.now();
          if (this.faults.length) {
            this._say('fault', AC.Voice.effectiveLang() === 'de'
              ? 'Selbsttest beendet. Achtung, Systemeinschränkungen.'
              : 'Self test complete. Caution, system degraded.');
          }
        }
      } else if (this.stage === 'result') {
        if (t >= (this.faults.length ? RESULT_FAULT : RESULT_OK)) this._finish();
      }
    },

    resultColor(D, res) {
      const C = D.COL;
      if (GOOD.includes(res)) return C.green;
      if (res === 'FAIL') return C.red;
      return C.amber;
    },

    draw(D) {
      this.update();
      if (this.stage === 'post') this.drawPost(D);
      else if (this.stage === 'pattern') this.drawPattern(D, false);
      else if (this.faults.length) this.drawFaults(D);
      else this.drawPattern(D, true);
    },

    /**
     * POST page layout as a list of text runs for time t (ms since the stage began). Used by the phone
     * display AND the car display (which draws it natively at full frame rate), so both look identical.
     * Each check line is typed character by character, then its result appears; pending checks show
     * running dots; a block cursor sits at the typing position. No fades - hard cuts only.
     * Coordinates: x in units of the font size from the left margin, row = line number.
     */
    postRuns(t) {
      const runs = [];
      const HEAD = 'AEROCALLOUT TAS-1    SW 0.3.0', TITLE = 'POWER ON SELF TEST';
      runs.push({ txt: HEAD, x: 0, row: 0, col: 'white' });
      const titleN = Math.min(TITLE.length, Math.floor(t / TYPE_MS * TITLE.length / 1.2));
      runs.push({ txt: TITLE.slice(0, titleN), x: 0, row: 1.4, col: 'green', bold: true });
      let cursor = titleN < TITLE.length ? { x: titleN * CHAR_W, row: 1.4 } : null;
      ITEMS.forEach((it, i) => {
        const tLine = t - LINE_DT * (i + 1);           // this line starts typing at (i+1) * LINE_DT
        if (tLine < 0) return;
        const row = 2.6 + i * 1.05;
        const n = Math.min(it.label.length, Math.floor(tLine / TYPE_MS * it.label.length));
        runs.push({ txt: it.label.slice(0, n), x: 0, row, col: 'green' });
        if (n < it.label.length) { cursor = { x: n * CHAR_W, row }; return; }
        const res = this.results[it.key];
        if (res === 'PEND') {
          const dots = '....'.slice(0, 1 + Math.floor(t / 160) % 4);
          runs.push({ txt: dots, x: RES_X, row, col: 'amber', bold: true });
        } else {
          runs.push({ txt: res, x: RES_X, row, col: GOOD.includes(res) ? 'green' : res === 'FAIL' ? 'red' : 'amber', bold: true });
        }
        if (i === ITEMS.length - 1) cursor = null;
        else if (t - LINE_DT * (i + 2) < 0) cursor = { x: 0, row: row + 1.05 };   // waiting for the next line
      });
      const allTyped = t >= LINE_DT * (ITEMS.length + 1) + TYPE_MS;
      const waiting = allTyped && ITEMS.some((it) => this.results[it.key] === 'PEND');
      if (waiting) {
        const left = Math.max(0, Math.ceil((POST_MAX - t) / 1000));
        runs.push({ txt: `WAITING FOR CHECKS ... ${left} s`, x: 0, row: 2.6 + ITEMS.length * 1.05 + 0.6, col: 'amber', small: true });
      }
      if (cursor && Math.floor(t / 260) % 2 === 0) runs.push({ txt: '█', x: cursor.x, row: cursor.row, col: 'green' });
      return runs;
    },

    drawPost(D) {
      const t = performance.now() - this.stageT0;
      const W = D.W, H = D.H, C = D.COL;
      const u = Math.min(W, H) / 500;
      const fs = Math.round(15 * u);
      const x0 = W * 0.08, y0 = H * 0.16, lh = fs * 1.55;
      D.g.font = `${fs}px ${D.FONT}`;
      const cw = D.g.measureText('M').width;           // monospace cell width
      for (const r of this.postRuns(t)) {
        D.text(r.txt, x0 + r.x * cw, y0 + r.row * lh, C[r.col], r.small ? Math.round(12 * u) : fs, 'left', 'alphabetic', !!r.bold);
      }
    },

    /** Self-test state for the car display (it draws the POST page itself, smoothly). */
    carInfo() {
      return {
        stage: this.active ? this.stage : 'done',
        t: Math.round(performance.now() - this.stageT0),
        items: ITEMS.map((it) => ({ label: it.label, res: this.results[it.key] || 'PEND' })),
        lineDt: LINE_DT, typeMs: TYPE_MS, resX: RES_X, postMax: POST_MAX,
      };
    },

    drawFaults(D) {
      const t = performance.now() - this.stageT0;
      const W = D.W, H = D.H, C = D.COL;
      const u = Math.min(W, H) / 500;
      const fs = Math.round(15 * u);
      const x = W * 0.08;
      let y = H * 0.14;
      D.box('SELF TEST - FAULTS', W / 2, y - fs, C.amber, Math.round(17 * u), Math.floor(t / 500) % 2 === 0, 'center');
      y += fs * 3;
      ITEMS.forEach((it) => {
        const res = this.results[it.key];
        D.text(it.label, x, y, GOOD.includes(res) ? C.dim : C.white, fs);
        D.text(res, x + fs * 13.6, y, this.resultColor(D, res), fs, 'left', 'alphabetic', true);
        y += fs * 1.6;
      });
      y += fs;
      this.faults.forEach((it) => {
        D.text('▲ ' + it.fault, x, y, this.results[it.key] === 'FAIL' ? C.red : C.amber, Math.round(13 * u), 'left', 'alphabetic', true);
        y += fs * 1.4;
      });
      y += fs * 0.6;
      D.text('SYSTEM OPERATES WITH LIMITATIONS', x, y, C.amber, Math.round(13 * u));
      y += fs * 1.4;
      const left = Math.max(0, Math.ceil((RESULT_FAULT - t) / 1000));
      D.text(`TAP DISPLAY TO CONTINUE (${left} s)`, x, y, C.grey, Math.round(12 * u));
    },

    drawPattern(D, passed) {
      const t = performance.now() - this.stageT0;
      const g = D.g, W = D.W, H = D.H, C = D.COL;
      const u = Math.min(W, H) / 500;
      const geo = { cx: W / 2, cy: H * 0.515, R: Math.min(W, H) * 0.40, arc: false, u };
      geo.k = geo.R / (6 * AC.U.NM);
      const bands = [[C.green, 0.50, 0.62], ['#ffff00', 0.62, 0.74], ['#ff0000', 0.74, 0.86], ['#ff00ff', 0.86, 0.98]];
      for (const [col, a, b] of bands) {
        g.fillStyle = col;
        g.globalAlpha = 0.85;
        g.beginPath();
        g.arc(geo.cx, geo.cy, geo.R * b, G().toRad(-150), G().toRad(-30));
        g.arc(geo.cx, geo.cy, geo.R * a, G().toRad(-30), G().toRad(-150), true);
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
      }
      D.rose(geo, 0);
      const s = 8 * u;
      const place = (clock, nm) => {
        const a = G().toRad(clock * 30);
        const r = nm * AC.U.NM * geo.k;
        return { x: geo.cx + Math.sin(a) * r, y: geo.cy - Math.cos(a) * r };
      };
      for (const [k, clk, nm, alt, vs, col] of [
        ['warn', 3, 2, -200, 800, C.red], ['ta', 9, 2, 200, -800, C.amber],
        ['prox', 1, 3.6, -1000, 0, C.cyan], ['other', 11, 3.6, 1000, -900, C.cyan]]) {
        const p = place(clk, nm);
        D.symbol(k, p.x, p.y, s, col);
        D.dataTag(alt, vs, p.x, p.y, s, col);
      }
      D.ownship(geo);
      D.box('TEST', W / 2, geo.cy - geo.R * 0.35, C.cyan, Math.round(22 * u), false, 'center');
      D.text('TFC TEST', 10 * u, 22 * u, C.cyan, Math.round(13 * u), 'left', 'alphabetic', true);
      D.text('WX TEST', W - 10 * u, 22 * u, C.green, Math.round(13 * u), 'right', 'alphabetic', true);
      const flags = [['TRAFFIC', C.amber], ['PULL UP', C.red], ['NO GPS', C.amber], ['NO TFC DATA', C.amber]];
      const sm = Math.round(11 * u);
      g.font = `bold ${sm}px ${D.FONT}`;
      const widths = flags.map((f) => g.measureText(f[0]).width + sm * 1.4);
      let fx = W / 2 - widths.reduce((a, b) => a + b, 0) / 2;
      flags.forEach((f, i) => { D.box(f[0], fx, H - 30 * u, f[1], sm, Math.floor(t / 400) % 2 === 0); fx += widths[i]; });
      if (passed) D.box('SELF TEST PASS', W / 2, geo.cy + geo.R * 0.3, C.green, Math.round(15 * u), true, 'center');
    },
  };

  AC.SelfTest = SelfTest;
})(window.AC = window.AC || {});
