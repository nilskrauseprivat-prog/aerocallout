/* AeroCallout - application controller: logic cycle, softkeys, options menu, panels. */
(function (AC) {
  'use strict';
  const U = AC.U, S = AC.settings, F = AC.Fmt;
  const $ = (q) => document.querySelector(q);
  const $$ = (q) => Array.from(document.querySelectorAll(q));

  const DISCLAIMER =
    'AeroCallout ist KEIN zertifiziertes Kollisionswarn- (TCAS/ACAS), Gelände- (TAWS) oder Wetterradarsystem und ' +
    'ersetzt weder Luftraumbeobachtung noch zugelassene Avionik. ADS-B-Internetdaten sind unvollständig: viele ' +
    'Luftfahrzeuge (z. B. Segelflugzeuge, Ultraleichte, Gleitschirme, Flugzeuge nur mit FLARM oder Mode-S ohne ADS-B) ' +
    'werden NICHT angezeigt. Mobilfunkabdeckung, Datenverzögerung, GPS-Fehler sowie unvollständige Gelände-, Hindernis- ' +
    'und Wetterdaten können zu fehlenden oder falschen Warnungen führen. Das System gibt bewusst keine ' +
    'Ausweichempfehlungen. Die Verantwortung für die sichere Flugdurchführung liegt allein beim Piloten.';

  const RANGES = [2, 5, 10, 20, 40, 80];

  // Conversion of settings stored in aviation base units (kt, ft, NM) to the selected display unit.
  const CONV = {
    speed: () => (S.speedUnit === 'kmh' ? 1.852 : 1),
    alt: () => (S.altUnit === 'm' ? U.FT : 1),
    dist: () => (S.distUnit === 'km' ? 1.852 : 1),
  };
  const UNIT_LABEL = { speed: () => F.speedLabel(), alt: () => F.altLabel(), dist: () => F.distLabel() };

  const App = {
    phase: 'off',
    own: null,
    tfc: null,
    terrain: null,
    alerts: [],
    flags: {},
    _lastPrefetch: 0,
    _lastPanel: 0,
    _wakeLock: null,

    init() {
      AC.Display.init($('#scr'));
      $('#disclaimerText').textContent = DISCLAIMER;
      $('#modalText').textContent = DISCLAIMER;
      this.bindSoftkeys();
      this.bindTabs();
      this.bindSettings();
      this.bindMenu();
      this.bindSim();
      AC.Settings.onChange(() => this.syncForm());
      this.syncForm();
      // Any interaction shows all keys again; they hide after a while (see touch()).
      document.addEventListener('pointerdown', () => this.touch(), true);
      AC.Settings.onChange((k) => { if (k === 'autoHide' || k === '*') this.setUiLevel(this.uiLevel === 2 ? 2 : 1); });
      $('#hKeys').addEventListener('click', () => this.setUiLevel(this.uiLevel === 0 ? 1 : 0));
      $('#hPanel').addEventListener('click', () => this.setUiLevel(this.uiLevel === 2 ? 1 : 2));
      this.setUiLevel(1);
      document.addEventListener('keydown', (e) => {
        this.touch();
        if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if (e.key === 'Escape') { this.menu(false); return; }
        if (AC.Sim.key(e)) e.preventDefault();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.phase !== 'off') this.requestWakeLock();
      });
      // remote control for the car display
      $$('[data-rk]').forEach((b) => b.addEventListener('click', () => {
        const k = b.dataset.rk;
        if (k === 'sim') {
          this.toggleSim(!S.simEnabled);
          if (!S.simEnabled) $$('[data-rscen]').forEach((x) => x.classList.remove('on'));
        } else if (k === 'audiotest') {
          AC.Voice.test(() => {});
        } else if (k === 'alerttest') {
          this.alertTest();
        } else if (k === 'carAlt' || k === 'carOverhead') {
          AC.Car.key(k);
        } else this.softkey(k);
        this.updateRemote();
      }));
      $('#rmExit').addEventListener('click', () => { AC.Car.remoteDismissed = true; this.updateRemote(); });
      const draw = () => {
        if (this._remote) { requestAnimationFrame(draw); return; }   // phone radar hidden: save power
        AC.Display.frame({ phase: this.phase, own: this.own, tfc: this.tfc, tickAt: this._tickAt, terrain: this.terrain, alerts: this.alerts, flags: this.flags, obsDisp: this.obsDisp }, performance.now());
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
      // Android app: logic clocked natively (keeps running with the screen off); browser: timer.
      if (window.AndroidPower) window.AndroidPower.startTicker();
      else setInterval(() => this.tick(), 500);
      if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.AC_ANDROID) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      }
      // Traffic warner is on as soon as the app starts (incl. self test). In a browser the audio may only be
      // unlocked by a user gesture, so the first touch/key unlocks it.
      const unlock = () => { AC.Voice.unlock(); document.removeEventListener('pointerdown', unlock, true); document.removeEventListener('keydown', unlock, true); };
      document.addEventListener('pointerdown', unlock, true);
      document.addEventListener('keydown', unlock, true);
      if (S.autoStart) setTimeout(() => { if (this.phase === 'off') this.powerOn(); }, 300);
    },

    /**
     * Landscape: the keys float over the radar. The display keeps its edge texts beside the key columns:
     * insL / insR = width covered by visible keys on the left / right (0 in portrait).
     */
    updateInsets() {
      const D = AC.Display;
      // Android: areas covered by the system navigation area (e.g. bottom edge in landscape) -> CSS variables
      if (window.AndroidPower && window.AndroidPower.insets) {
        try {
          const i = JSON.parse(window.AndroidPower.insets());
          const key = `${i.l},${i.r},${i.b}`;
          if (key !== this._insKey) {
            this._insKey = key;
            const st = document.documentElement.style;
            st.setProperty('--sal', i.l + 'px'); st.setProperty('--sar', i.r + 'px'); st.setProperty('--sab', i.b + 'px');
          }
        } catch (e) { /* ignore */ }
      }
      const land = window.matchMedia && window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches;
      let L = 0, R = 0;
      if (land && D.c) {
        const sb = D.c.getBoundingClientRect();
        $$('.bezel .sk, .ui-handle button').forEach((k) => {
          if (!k.offsetParent) return;
          const b = k.getBoundingClientRect();
          if (b.width === 0) return;
          if (b.right < sb.left + sb.width / 2) L = Math.max(L, b.right - sb.left + 4);
          else R = Math.max(R, sb.right - b.left + 4);
        });
      }
      D.insL = L; D.insR = R;
      // iPhone: the radar may reach up beside the Dynamic Island / notch. Its top edge texts start low enough
      // to clear the rounded screen corners (safe area top = 0 on other devices -> no change).
      let T = 0;
      if (!land && D.c) {
        if (!this._safeProbe) {
          this._safeProbe = document.createElement('div');
          this._safeProbe.className = 'safe-probe';
          document.body.appendChild(this._safeProbe);
        }
        const sat = parseFloat(getComputedStyle(this._safeProbe).paddingTop) || 0;
        if (sat > 0) T = Math.max(0, sat - 24 - D.c.getBoundingClientRect().top);
      }
      D.insT = T;
    },

    /** Weather picture is hidden while auto range is active or an alert / advisory is up (traffic, terrain, obstacle). */
    wxSuppressed() {
      if (F.rangeOverride !== null) return true;
      return (this.alerts || []).some((a) => a.kind !== 'traffic' || a.level === 'ta' || a.level === 'warn');
    },

    /** Warning test: all alert types in quick succession at the current position (toggle). */
    alertTest() {
      if (AC.AlertTest.active) { AC.AlertTest.stop(); return; }
      if (this.phase !== 'run' || !this.own) { $('#hint').textContent = 'Warnungstest braucht ein laufendes System mit Position.'; return; }
      AC.Voice.unlock();
      AC.AlertTest.start(this.own);
      $('#hint').textContent = 'Warnungstest läuft: alle Warnungen im Schnelldurchlauf (≈ 40 s).';
    },

    /** Phone as remote control while the car display (Android Auto) is connected. */
    updateRemote() {
      const on = !!(AC.Car && AC.Car.active() && !AC.Car.remoteDismissed);
      if (on !== this._remote) {
        this._remote = on;
        $('#remote').classList.toggle('hidden', !on);
        document.body.classList.toggle('remote', on);
        if (!on) AC.Display.resize();
      }
      if (!on) return;
      const F2 = AC.Fmt, f = this.flags || {};
      const last = AC.Adsb.lastData, age = last ? (Date.now() - last) / 1000 : null;
      const tfcCls = (f.tfcFail || f.offline || f.gpsFail) ? 'r' : f.tfcDelayed ? 'a' : 'g';
      const ov = S.wxOn && S.terrOn ? 'WX+TERR' : S.terrOn ? 'TERR' : S.wxOn ? 'WX' : 'AUS';
      $('#rmStatus').innerHTML = `<span class="${tfcCls}">TFC</span> · RNG ${F2.rangeVal()} ${S.distUnit === 'km' ? 'KM' : 'NM'} · ` +
        `<span class="w">${ov}</span> · SENS ${S.sensGain.toUpperCase()}<br>` +
        `<span class="${age === null || age >= 15 ? 'r' : age >= 10 ? 'a' : 'g'}">ADS-B ${age === null ? '--' : Math.round(age) + ' s'}</span>` +
        (S.simEnabled ? ' · <span class="a">SIM</span>' : '') + (S.muted ? ' · <span class="a">TON AUS</span>' : '') +
        ((AC.Sim.live || AC.Sim.testRun) ? ` · <span style="color:#ff5cf0">TEST ${AC.Sim.testLeft()} s</span>` : '') +
        (AC.AlertTest.active ? `<br><span style="color:#ff5cf0">WARNUNGSTEST ${AC.AlertTest.left()} s · ${AC.AlertTest.stepName()}</span>` : '');
      $$('[data-rk=alerttest]').forEach((b) => b.classList.toggle('on', AC.AlertTest.active));
      if (!AC.Sim.live && !S.simEnabled) $$('[data-rscen]').forEach((x) => x.classList.remove('on'));
      const top = (this.alerts || [])[0];
      const ra = $('#rmAlert');
      const isT = top && top.kind === 'traffic' && (top.level === 'ta' || top.level === 'warn');
      ra.className = 'rm-alert' + (isT ? ' ' + top.level : '');
      ra.textContent = isT ? `TRAFFIC ${top.item.clock} UHR ${F2.dist(top.item.r)} ${F2.distLabel()}` + (AC.Display.closureTxt(top.item) ? ' · ' + AC.Display.closureTxt(top.item) : '') : '';
      const sub = {
        terr: S.wxOn && S.terrOn ? 'BEIDE' : S.terrOn ? 'TERR' : S.wxOn ? 'WX' : 'AUS',
        sens: S.sensGain.toUpperCase(),
        gain: S.wxGain === 0 ? 'CAL' : (S.wxGain > 0 ? '+' : '') + S.wxGain + ' dB',
        mute: S.muted ? 'STUMM' : 'AN',
        sim: S.simEnabled ? 'AN' : 'AUS',
        carAlt: AC.Car.altLabel(),
        carOverhead: AC.Car.ohLabel(),
      };
      $$('[data-rsub]').forEach((el) => { el.textContent = sub[el.dataset.rsub] || ''; });
      $$('[data-rk]').forEach((b) => {
        const k = b.dataset.rk;
        b.classList.toggle('on', (k === 'terr' && (S.wxOn || S.terrOn)) || (k === 'sim' && S.simEnabled) || (k === 'carAlt' && S.carAltM > 0) || (k === 'carOverhead' && S.carOverhead !== 'off'));
        b.classList.toggle('warn', k === 'mute' && S.muted);
      });
    },

    // ------------------------------------------------------------ power
    powerOn() {
      if (!S.disclaimerAccepted) {
        $('#modal').classList.remove('hidden');
        return;
      }
      AC.Voice.unlock();                 // must happen inside the click (browser audio policy)
      AC.Settings.set('muted', false);   // like real avionics: audio is on after power-up
      this.phase = 'boot';
      $('#pwrLed').classList.add('on');
      $('#hint').textContent = 'Selbsttest läuft … (Bildschirm antippen zum Überspringen)';
      if (!S.simEnabled) { AC.Gps.start(); if (S.ahrsOn) AC.Ahrs.start(); }
      AC.Adsb.start(() => this.own);
      this.requestWakeLock();
      if (window.AndroidPower) window.AndroidPower.startMonitoring();   // background service + notification
      this.applyScreenMode();
      AC.SelfTest.run(() => {
        this.phase = 'run';
        this._runSince = Date.now();
        this.touch();
        $('#hint').textContent = S.simEnabled ? 'Simulation aktiv – Szenarien im Reiter „Simulation“.' : 'System aktiv.';
      });
      this.syncForm();
    },

    powerOff() {
      this.phase = 'off';
      this.setUiLevel(1);
      this.menu(false);
      $('#pwrLed').classList.remove('on');
      $('#hint').textContent = 'PWR drücken, um das System zu starten.';
      AC.Gps.stop();
      AC.Ahrs.stop();
      AC.Adsb.stop();
      AC.Voice.reset();
      AC.TrafficLogic.reset();
      this.alerts = [];
      this.setRangeOverride(null);
      this._autoCancelled = false;
      AC.Display.terrPopup = false;
      this.obsDisp = [];
      this.updateLamps();
      if (this._wakeLock) { this._wakeLock.release().catch(() => {}); this._wakeLock = null; }
      if (window.AndroidPower) { window.AndroidPower.stopMonitoring(); window.AndroidPower.setKeepScreenOn(false); }
      this.syncForm();
    },

    /** Screen: 'on' = always on while the system runs, 'wake' = may sleep, switched on for alerts. */
    applyScreenMode() {
      if (window.AndroidPower) window.AndroidPower.setKeepScreenOn(this.phase !== 'off' && S.screenMode === 'on');
    },

    /** New traffic advisory / warning or terrain / obstacle alert: switch the screen on (also over the lock screen). */
    wakeOnAlert(alerts, now) {
      if (!window.AndroidPower || this.phase !== 'run') return;
      const top = alerts.find((a) => a.level === 'ta' || a.level === 'warn' || a.level === 'caution' || a.level === 'warning');
      if (!top) return;
      if (now - (this._lastWake || 0) < 4000) return;
      this._lastWake = now;
      const txt = top.kind === 'traffic' ? (top.level === 'warn' ? 'TRAFFIC - Konfliktwarnung' : 'TRAFFIC - Verkehrshinweis')
        : top.kind === 'terrain' ? 'TERRAIN - Geländewarnung' : 'OBSTACLE - Hinderniswarnung';
      window.AndroidPower.wake(txt);
    },

    async requestWakeLock() {
      try { if ('wakeLock' in navigator) this._wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ }
    },

    // ------------------------------------------------------------ logic cycle (2 Hz)
    tick() {
      const now = Date.now();
      this.updateRemote();
      this.updateInsets();
      AC.Sim.checkTest(now);   // terrain / obstacle / GPS test flight over: back to live data
      if (this.phase === 'off') { this.updatePanel(now); return; }
      if (this.phase === 'boot') AC.SelfTest.update();

      let own = null;
      if (S.simEnabled) {
        AC.Sim.step(now);
        own = AC.Sim.ownState(now);
        if (AC.Sim.intruders.length) AC.Adsb.injectSim(AC.Sim.records(now));
        if (!S.simLiveTraffic && now >= AC.Adsb.blockedUntil) AC.Adsb.lastData = now;
      } else {
        // Position for display and data requests: up to 10 s old and 2 km accuracy (also network position).
        const g = AC.Gps.state;
        own = g && now - g.t < 10000 && (g.acc === null || g.acc < 2000) ? g : null;
        // Dead reckoning (gyro heading + last speed + barometer) when the satellite fix is lost.
        const dr = S.ahrsOn && AC.Ahrs.running ? AC.Ahrs.navigate(g, now) : null;
        if (dr && !(own && own.gnss && now - own.t < 3000)) own = dr;
        // Phone sensors improve the ownship state.
        if (own && AC.Ahrs.ready()) {
          own = Object.assign({}, own);
          if (own.gs < 3) own.trk = AC.Ahrs.heading;                       // standing / taxiing: sensor heading
          if (S.baroOn && AC.Ahrs.baroOk() && AC.Ahrs.baroVs !== null) own.vs = AC.Ahrs.baroVs;   // smooth vertical speed
        }
        if (own && S.baroOn && AC.Ahrs.baroOk()) { own = Object.assign({}, own); own.pressAltFt = AC.Ahrs.pressAltFt; }
        AC.Sim.stepLive(now);   // live test: test aircraft around the real position (if one is running)
      }
      if (S.simEnabled && own) AC.Ahrs.simulate(own);
      this.own = own;
      this._tickAt = now;
      AC.Adsb.tick(now);

      // Alerts only with a real satellite fix: fresh (< 4 s) and better than 300 m.
      let gpsLimit = false;
      if (own && own.source === 'dr') {
        // dead reckoning: alerts stay active for 20 s, then the position is too uncertain
        if (own.drAge > 20) gpsLimit = `GPS LOST - DEAD RECKONING ${Math.round(own.drAge)} s - ALERTS INHIBITED`;
      } else if (own && !S.simEnabled) {
        if (!own.gnss) gpsLimit = 'GPS: NO SATELLITE FIX - ALERTS INHIBITED';
        else if (own.acc > 300) gpsLimit = 'GPS ACCURACY LOW - ALERTS INHIBITED';
        else if (now - own.t > 4000) gpsLimit = 'GPS DATA STALE - ALERTS INHIBITED';
      }

      const health = AC.Adsb.health(now);
      const running = this.phase === 'run';
      this.flags = {
        sim: S.simEnabled,
        gpsFail: !own,
        gpsDegraded: gpsLimit,
        dr: own && own.source === 'dr' && own.drAge <= 20 ? Math.round(own.drAge) : false,
        offline: AC.Adsb.offline && !S.simEnabled,
        // Without a position no traffic can be requested - then only the GPS failure is shown (root cause).
        tfcFail: S.trafficEnabled && !!own && !health.fresh && running && now - (this._runSince || now) > 15000,
      };
      // ADS-B data older than 10 s (but not yet "lost"): clearly marked as delayed
      const adsbAge = AC.Adsb.lastData ? (now - AC.Adsb.lastData) / 1000 : null;
      this.flags.tfcDelayed = S.trafficEnabled && !!own && running && !this.flags.tfcFail &&
        adsbAge !== null && adsbAge >= 10 ? Math.round(adsbAge) : false;
      this.announceLoss(now);
      if (!own) {
        this.tfc = null;
        this.alerts = [];
        this.updateLamps();
        AC.Voice.process([], now);
        this.updatePanel(now);
        return;
      }

      if (now - this._lastPrefetch > 5000) {
        this._lastPrefetch = now;
        AC.Terrain.prefetch(own.lat, own.lon, Math.min(30000, Math.max(12000, own.gs * 150, F.rangeM() * AC.Display.extent())));
      }
      AC.Obstacles.update(own);
      if (S.mapMode !== 'off') AC.Roads.update(own, F.rangeM() * AC.Display.extent() * 1.3);   // road map for the radar
      if (S.wxOn || S.wxThunder) AC.Weather.update(own, F.rangeNMeq() * AC.Display.extent());

      const terr = AC.Terrain.evaluate(own);
      this.terrain = terr;
      const targets = AC.Adsb.getTargets(now, own);
      const tfc = AC.TrafficLogic.evaluate(own, targets, now, terr.aglFt);
      this.tfc = tfc;
      // warning test: adds its test aircraft to the picture and dictates the alerts of the current step
      const testAlerts = AC.AlertTest.active ? AC.AlertTest.run(own, tfc, now) : null;

      // Car mode (Android Auto): traffic alerts always on, terrain / obstacle alerts off (we drive on the ground).
      const car = AC.Car && AC.Car.active();
      const airborne = tfc.airborne && !car;
      const nearApt = terr.aglFt !== null && terr.aglFt < 1000 && AC.Obstacles.nearAerodrome(own.lat, own.lon, 4000);
      this.flags.ground = !airborne;
      this.flags.terrNA = S.terrainEnabled && airborne && !terr.available;
      // Weather: no data at all, or the latest radar picture is older than 30 min.
      const wxAge = AC.Weather.ageMin();
      this.flags.wxNA = !S.wxOn ? false
        : (AC.Weather.status === 'ERR' && !AC.Weather.frame) || (!AC.Weather.frame && now - (this._runSince || now) > 20000) ? 'none'
        : wxAge !== null && wxAge > 30 ? 'old' : false;
      this.flags.obsNA = S.obstacleEnabled && S.osmObstacles && airborne && !AC.Terrain.override &&
        AC.Obstacles.status === 'ERR' && AC.Obstacles.list.length === 0;
      this.flags.terrAero = nearApt && airborne;

      const alerts = [];
      if (S.trafficEnabled && (airborne || car)) {
        for (const it of tfc.items) {
          if (it.level === 'warn') alerts.push({ key: 'tfc-' + it.hex, kind: 'traffic', level: 'warn', prio: 90, repeatMs: 6000, item: it });
          else if (it.level === 'ta') alerts.push({ key: 'tfc-' + it.hex, kind: 'traffic', level: 'ta', prio: 60, repeatMs: S.repeatTA ? 20000 : 0, item: it });
          else if (it.level === 'prox' && S.announceProx) alerts.push({ key: 'tfc-' + it.hex, kind: 'traffic', level: 'prox', prio: 30, repeatMs: 0, item: it });
        }
      }
      if (S.terrainEnabled && airborne && !S.terrInhibit && !nearApt && terr.level) {
        alerts.push({ key: 'terrain', kind: 'terrain', level: terr.level, prio: terr.level === 'warning' ? 100 : 70, repeatMs: terr.level === 'warning' ? 800 : 9000 });
      }
      if (S.obstacleEnabled && airborne) {
        const obs = AC.Obstacles.evaluate(own);
        if (obs.length) {
          const o = obs[0];
          alerts.push({ key: 'obstacle', kind: 'obstacle', level: o.level, prio: o.level === 'warning' ? 95 : 65, repeatMs: o.level === 'warning' ? 1500 : 9000, obs: o });
        }
      }
      if (testAlerts) { alerts.length = 0; alerts.push(...testAlerts); }
      else if (gpsLimit) alerts.length = 0;   // never warn on an uncertain own position
      this.wakeOnAlert(alerts, now);
      alerts.sort((a, b) => b.prio - a.prio);
      this.alerts = alerts;
      this.updateAutoRange(own, now);
      this.updateLamps();
      if (now - (this._lastObsDisp || 0) > 1000 || alerts.some((a) => a.kind === 'obstacle')) {
        this._lastObsDisp = now;
        this.obsDisp = this.buildObstacleDisplay(own);
      }
      if (this.phase === 'run') AC.Voice.process(alerts, now);
      if (this.phase === 'run' && car) AC.Car.overhead(own, tfc, now);   // car mode: "passing overhead" callouts
      this.updatePanel(now);
    },

    /**
     * Control levels:
     *   0 - compact: only RNG ▲/▼, SENS, TERR, TON below the radar (maximum radar area)
     *   1 - all radar keys
     *   2 - all radar keys + panel (Status / Simulation / Einstellungen / Hilfe)
     * Level 1 falls back to 0 after 8 s without interaction (if auto-hide is on).
     * Using the visible keys in level 0 does NOT expand anything.
     */
    setUiLevel(level) {
      this.uiLevel = level;
      const b = document.body.classList;
      b.toggle('ui-l0', level === 0);
      b.toggle('ui-l1', level === 1);
      b.toggle('ui-l2', level === 2);
      $('#hKeys').textContent = level === 0 ? '▲ Alle Tasten' : '▼ Weniger Tasten';
      $('#hPanel').textContent = level === 2 ? '✕ Menü schließen' : '☰ Status & Einstellungen';
      if (level === 0) window.scrollTo(0, 0);
      if (level === 2) setTimeout(() => $('#panel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      this.armIdle();
    },

    armIdle() {
      clearTimeout(this._idleTimer);
      if (this.uiLevel !== 1 || !S.autoHide) return;
      this._idleTimer = setTimeout(() => {
        const menuOpen = !$('#menu').classList.contains('hidden');
        if (this.phase === 'run' && this.uiLevel === 1 && !menuOpen) this.setUiLevel(0);
        else this.armIdle();
      }, 8000);
    },

    /** Interaction: keeps level 1 open a bit longer; never expands by itself. */
    touch() {
      if (this.uiLevel === 0 && !S.autoHide) this.setUiLevel(1);
      else this.armIdle();
    },

    /** Spoken once when the position or the traffic data is lost (and again after recovery + new loss). */
    announceLoss(now) {
      if (this.phase !== 'run') return;
      const en = AC.Voice.effectiveLang() !== 'de';
      const check = (key, lost, textEn, textDe) => {
        const was = this._lost[key];
        if (lost && was === false) AC.Voice.say(en ? textEn : textDe, 40, { level: 'caution' });   // only on a real loss
        this._lost[key] = lost;
      };
      this._lost = this._lost || {};
      check('gps', this.flags.gpsFail || !!(this.own && this.own.source === 'dr'), 'GPS position lost.', 'GPS-Position verloren.');
      check('tfc', this.flags.tfcFail, 'Traffic data lost.', 'Verkehrsdaten ausgefallen.');
      this.gpsQualityCallouts(now, en);
    },

    /**
     * Longer GPS problems are announced (and repeated every 2 min):
     *  - no satellite fix for 30 s  -> "GPS signal lost for 30 seconds. Position accuracy 450 meters."
     *  - satellite fix, but accuracy worse than 100 m for 15 s -> "Caution, GPS accuracy degraded."
     *  - recovery after such an announcement -> "GPS position restored."
     */
    gpsQualityCallouts(now, en) {
      if (S.simEnabled) { this._gq = null; return; }
      const g = this._gq || (this._gq = { lostSince: null, poorSince: null, last: {}, announced: false });
      const own = this.own;
      const fix = own && own.gnss && now - own.t < 4000;
      const say = (kind, e, d) => { AC.Voice.say(en ? e : d, 40, { level: 'caution' }); g.last[kind] = now; g.announced = true; };
      const fmtDur = (ms) => {
        const s = Math.round(ms / 1000);
        if (s < 90) return en ? `${s} seconds` : `${s} Sekunden`;
        const m = Math.round(s / 60);
        return en ? `${m} minutes` : `${m} Minuten`;
      };
      const accWords = () => {
        if (!own) return en ? ' No position available.' : ' Keine Position verfügbar.';
        const a = own.acc < 1000 ? Math.round(own.acc / 10) * 10 : Math.round(own.acc / 100) * 100;
        return en ? ` Position accuracy ${a} meters.` : ` Positionsgenauigkeit ${a} Meter.`;
      };
      const repeatOk = (kind) => now - (g.last[kind] || 0) > 120000;   // each message at most every 2 min

      if (!fix) {
        g.lostSince = g.lostSince || now;
        g.poorSince = null;
        const dur = now - g.lostSince;
        if (dur >= 30000 && repeatOk('lost')) {
          say('lost', `GPS signal lost for ${fmtDur(dur)}.${accWords()}`, `GPS-Signal seit ${fmtDur(dur)} nicht verfügbar.${accWords()}`);
        }
        return;
      }
      if (g.lostSince && g.announced) say('restored', 'GPS position restored.', 'GPS-Position wieder verfügbar.');
      if (g.lostSince) { g.lostSince = null; g.announced = false; }

      if (own.acc > 100) {
        g.poorSince = g.poorSince || now;
        if (now - g.poorSince >= 15000 && repeatOk('poor')) say('poor', `Caution, GPS accuracy degraded.${accWords()}`, `Achtung, GPS-Genauigkeit stark eingeschränkt.${accWords()}`);
      } else {
        if (g.poorSince && g.announced) say('ok', 'GPS accuracy restored.', 'GPS-Genauigkeit wieder normal.');
        g.poorSince = null;
        g.announced = false;
      }
    },

    // ------------------------------------------------------------ auto range
    /**
     * During a TA / conflict the display zooms to the smallest range step that shows the most
     * important threat at ≤ 75 % of the radius (other TAs outside appear as half symbols at the edge).
     * Zooming out happens immediately (threat must stay visible), zooming in after 2.5 s of stability.
     * 6 s after the last alert the pilot-selected range is restored. Pressing RNG cancels it until the alert ends.
     */
    updateAutoRange(own, now) {
      // Most important alert (alerts are sorted by priority): traffic TA/conflict, terrain or obstacle.
      const a = this.alerts.find((x) => x.kind !== 'traffic' || x.level === 'ta' || x.level === 'warn');
      let distM = null;
      if (a && a.kind === 'traffic') distM = a.item.r;
      else if (a && a.kind === 'terrain') distM = Math.max(1500, own.gs * ((this.terrain && this.terrain.tImpact) || 30));
      else if (a && a.kind === 'obstacle') distM = Math.max(800, a.obs.d);
      // Terrain picture pops up automatically during terrain / obstacle alerts (like EGPWS).
      if (a && a.kind !== 'traffic') { AC.Display.terrPopup = true; this._popupLast = now; }
      else if (AC.Display.terrPopup && now - (this._popupLast || 0) > 6000) { AC.Display.terrPopup = false; AC.Display.terr.img = null; }

      if (!S.autoRange) {
        if (F.rangeOverride !== null) this.setRangeOverride(null);
        this._autoCancelled = false;
        return;
      }
      if (distM !== null) {
        this._autoLastThreat = now;
        if (this._autoCancelled) return;
        const d = distM / F.distM();
        const target = RANGES.find((r) => d <= r * 0.75) || RANGES[RANGES.length - 1];
        const cur = F.rangeVal();
        if (target > cur) { this.setRangeOverride(target); this._autoLowerSince = 0; }
        else if (target < cur) {
          if (!this._autoLowerSince) this._autoLowerSince = now;
          else if (now - this._autoLowerSince >= 2500) { this.setRangeOverride(target); this._autoLowerSince = 0; }
        } else {
          this._autoLowerSince = 0;
        }
      } else if ((F.rangeOverride !== null || this._autoCancelled) && now - (this._autoLastThreat || 0) > 6000) {
        this._autoCancelled = false;
        this._autoLowerSince = 0;
        this.setRangeOverride(null);
      }
    },

    /** Obstacles to draw: within the display range and with a top no more than 1500 ft below own altitude. */
    buildObstacleDisplay(own) {
      if (own.altMSL === null) return [];
      const maxM = F.rangeM() * AC.Display.extent() * 1.05;   // whole display, not only the rose
      const ownFt = own.altMSL / U.FT;
      const out = [];
      for (const o of AC.Obstacles.all()) {
        const pts = o.pts.map((p) => AC.Geo.enu(own.lat, own.lon, p.lat, p.lon));
        const d = pts.length === 1 ? Math.hypot(pts[0].x, pts[0].y)
          : AC.Geo.segClosest(0, 0, pts[0].x, pts[0].y, pts[1].x, pts[1].y).d;
        if (d > maxM) continue;
        let top = null;
        for (const p of o.pts) {
          const g = AC.Terrain.elevation(p.lat, p.lon);
          if (g !== null) top = Math.max(top === null ? -1e9 : top, g + o.h);
        }
        if (top === null) continue;
        const topFt = top / U.FT;
        const rel = topFt - ownFt;
        if (rel < -1500) continue;
        out.push({ o, d, topFt, rel });
      }
      out.sort((x, y) => x.d - y.d);
      return out.slice(0, 300);
    },

/** Red glow around the screen - only while a red warning (traffic conflict, pull up) is active. */
    updateLamps() {
      const red = this.alerts.some((a) => a.level === 'warn' || a.level === 'warning');
      document.querySelector('.screen').classList.toggle('alert-red', red);
    },

    setRangeOverride(v) {
      if (F.rangeOverride === v) return;
      F.rangeOverride = v;
      AC.Display.wx.a = null;
      AC.Display.terr.img = null;
    },

    // ------------------------------------------------------------ softkeys
    bindSoftkeys() {
      $$('[data-sk]').forEach((b) => b.addEventListener('click', () => this.softkey(b.dataset.sk)));
      $('#scr').addEventListener('click', () => { if (this.phase === 'boot') AC.SelfTest.skip(); else if (this.phase === 'off') this.powerOn(); });
      // Double tap on the artificial horizon: re-calibrate it to the current phone attitude.
      $('#scr').addEventListener('pointerup', (e) => {
        const r = AC.Display._attRect;
        if (this.phase !== 'run' || !r) return;
        const box = $('#scr').getBoundingClientRect();
        const x = e.clientX - box.left, y = e.clientY - box.top;
        if (Math.hypot(x - r.cx, y - r.cy) > r.r * 1.15) { this._attTap = 0; return; }
        const now = Date.now();
        if (this._attTap && now - this._attTap < 400) {
          this._attTap = 0;
          const ok = AC.Ahrs.running && AC.Ahrs.calibrateMount();
          AC.Display.attNotice = { text: ok ? 'ATT CAL ✓' : 'ATT CAL N/A', until: performance.now() + 2000, ok };
        } else {
          this._attTap = now;
        }
      });
      $('#modalOk').addEventListener('click', () => {
        AC.Settings.set('disclaimerAccepted', true);
        $('#modal').classList.add('hidden');
        this.powerOn();
      });
    },

    softkey(k) {
      const set = AC.Settings.set;
      if (k === 'pwr') { this.phase === 'off' ? this.powerOn() : this.powerOff(); return; }
      if (k === 'menu') { this.menu($('#menu').classList.contains('hidden')); return; }
      if (k === 'sim') { this.toggleSim(!S.simEnabled); return; }
      if (this.phase === 'off') { $('#hint').textContent = 'Zuerst PWR drücken.'; return; }
      if ((k === 'rngUp' || k === 'rngDn') && F.rangeOverride !== null) {
        // Pilot takes over: continue from the currently shown range, auto-range pauses until the alert ends.
        set('rangeNM', F.rangeOverride);
        this.setRangeOverride(null);
        this._autoCancelled = true;
      }
      const ri = RANGES.indexOf(S.rangeNM);
      switch (k) {
        case 'rngUp': set('rangeNM', RANGES[Math.min(RANGES.length - 1, (ri < 0 ? 2 : ri) + 1)]); break;
        case 'rngDn': set('rangeNM', RANGES[Math.max(0, (ri < 0 ? 2 : ri) - 1)]); break;
        case 'mode': set('mode', S.mode === '360' ? 'arc' : '360'); break;
        case 'alt': { const o = ['norm', 'abv', 'blw', 'unr']; set('altBand', o[(o.indexOf(S.altBand) + 1) % o.length]); break; }
        case 'sens': { const o = ['lo', 'norm', 'hi', 'max']; set('sensGain', o[(o.indexOf(S.sensGain) + 1) % o.length]); break; }
        case 'wx': set('wxOn', !S.wxOn); break;
        case 'terr': {
          // Overlay key: OFF -> WX -> TERR -> BOTH -> OFF
          const mode = S.wxOn && S.terrOn ? 'both' : S.terrOn ? 'terr' : S.wxOn ? 'wx' : 'off';
          const next = { off: [true, false], wx: [false, true], terr: [true, true], both: [false, false] }[mode];
          set('wxOn', next[0]); set('terrOn', next[1]);
          break;
        }
        case 'gainUp': set('wxGain', Math.min(10, S.wxGain + 2)); break;
        case 'gainDn': set('wxGain', Math.max(-10, S.wxGain - 2)); break;
        case 'test': this.alertTest(); break;   // TEST key: all warnings in quick succession (warning test)
        case 'mute': set('muted', !S.muted); if (S.muted) AC.Voice.reset(); else AC.Voice.unlock(); break;
        case 'inhb': set('terrInhibit', !S.terrInhibit); break;
        default: break;
      }
      AC.Display.wx.a = null;
      AC.Display.terr.img = null;
    },

    toggleSim(on) {
      if (AC.Sim.live) AC.Sim.endLive();
      if (!on && AC.Sim.testRun) { AC.Sim.testRun = null; AC.Sim.clearScenario(); }
      AC.Settings.set('simEnabled', on);
      AC.Adsb.clear();
      AC.TrafficLogic.reset();
      AC.Voice.reset();
      if (on) { AC.Gps.stop(); AC.Ahrs.stop(); AC.Sim.ensure(); }
      else { AC.Sim.clearScenario(); if (this.phase !== 'off') { AC.Gps.start(); if (S.ahrsOn) AC.Ahrs.start(); } }
      AC.Display.wx.a = null;
    },

    // ------------------------------------------------------------ options menu
    menu(open) {
      $('#menu').classList.toggle('hidden', !open);
      $$('[data-sk="menu"]').forEach((b) => b.classList.toggle('on', open));
    },

    bindMenu() {
      $('#menuClose').addEventListener('click', () => this.menu(false));
      $$('[data-seg]').forEach((seg) => {
        const key = seg.dataset.seg;
        seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
          let v = b.dataset.val;
          if (v === 'true' || v === 'false') v = v === 'true';
          else if (v !== '' && !isNaN(Number(v))) v = Number(v);
          AC.Settings.set(key, v);
          AC.Display.wx.a = null;
          AC.Display.terr.img = null;
        }));
      });
      $$('[data-calib]').forEach((b) => b.addEventListener('click', () => {
        let msg;
        if (!AC.Ahrs.running) msg = 'Lagesensoren sind nur in der Android-App verfügbar (und System muss eingeschaltet sein).';
        else if (AC.Ahrs.calibrateMount()) msg = '✔ Halterung kalibriert – Lage wird neu ausgerichtet.';
        else msg = 'Noch keine Sensordaten – bitte kurz warten und erneut versuchen.';
        $$('[data-calibresult]').forEach((r) => { r.textContent = msg; });
      }));
      AC.Settings.onChange((k) => {
        if (k === 'osmObstacles' && S.osmObstacles) { AC.Obstacles.lastAttempt = 0; AC.Obstacles.lastCenter = null; }
        if (k === 'obsRadiusKm') { AC.Obstacles.lastAttempt = 0; }
        if (k === 'screenMode') this.applyScreenMode();
        if (k === 'ahrsOn' && this.phase !== 'off' && !S.simEnabled) { if (S.ahrsOn) AC.Ahrs.start(); else AC.Ahrs.stop(); }
      });
      $$('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        const m = b.dataset.preset === 'metric';
        AC.Settings.set('distUnit', m ? 'km' : 'nm');
        AC.Settings.set('speedUnit', m ? 'kmh' : 'kt');
        AC.Settings.set('altUnit', m ? 'm' : 'ft');
        AC.Settings.set('vsUnit', m ? 'mps' : 'fpm');
      }));
      $$('[data-voiceprobe]').forEach((b) => b.addEventListener('click', () => {
        AC.Voice.unlock();
        const sample = { kind: 'traffic', level: 'ta', item: { clock: 2, relAltFt: 400, r: 2.6 * U.NM } };
        AC.Voice.say(AC.Voice.text(sample), 99, { interrupt: true, force: true, level: 'test' });
        setTimeout(() => this.syncForm(), 300);
      }));
      $$('[data-audiotest]').forEach((b) => b.addEventListener('click', () => {
        $$('[data-audioresult]').forEach((r) => { r.textContent = 'Test läuft – du solltest einen Doppelton und dann eine Ansage hören …'; r.className = 'audio-result'; });
        AC.Voice.test((msg, ok) => {
          $$('[data-audioresult]').forEach((r) => { r.textContent = msg; r.className = 'audio-result ' + (ok ? 'ok' : 'bad'); });
        });
      }));
    },

    // ------------------------------------------------------------ panels
    bindTabs() {
      $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
        $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
        $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
      }));
    },

    bindSettings() {
      $$('[data-set]').forEach((el) => {
        const key = el.dataset.set;
        const ev = el.type === 'range' || el.type === 'text' ? 'input' : 'change';
        el.addEventListener(ev, () => {
          let v = el.type === 'checkbox' ? el.checked : el.value;
          if ('num' in el.dataset) v = parseFloat(v);
          if (el.dataset.conv) {
            v = parseFloat(v);
            if (isNaN(v)) return;
            v = v / CONV[el.dataset.conv]();
          }
          if (key === 'simEnabled') { this.toggleSim(v); return; }
          if (key === 'voiceName') AC.Settings.set('voiceProfile', v ? 'custom' : 'male');
          if (key === 'ownHex') v = String(v).toLowerCase().trim();
          AC.Settings.set(key, v);
          AC.Display.wx.a = null;
          AC.Display.terr.img = null;
        });
      });
      const fillVoices = () => {
        const sel = $('#voiceSelect');
        const all = AC.Voice.voices().filter((v) => /^(en|de)/i.test(v.lang));
        sel.innerHTML = '<option value="">Automatisch (beste Stimme für die Sprache)</option>' +
          all.map((v) => `<option value="${v.name.replace(/"/g, '&quot;')}">${v.name} – ${v.lang}${v.localService ? '' : ' (online)'}</option>`).join('');
        sel.value = S.voiceName;
        this.voiceHint();
      };
      fillVoices();
      if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fillVoices);

      const sample = { clock: 2, relAltFt: 400, r: 2.6 * U.NM, vsFpm: 0 };
      $$('[data-test]').forEach((b) => b.addEventListener('click', () => {
        AC.Voice.unlock();
        const map = {
          ta: { kind: 'traffic', level: 'ta', item: sample },
          warn: { kind: 'traffic', level: 'warn', item: Object.assign({}, sample, { r: 0.6 * U.NM, relAltFt: 0 }) },
          tcaut: { kind: 'terrain', level: 'caution' },
          twarn: { kind: 'terrain', level: 'warning' },
          obs: { kind: 'obstacle', level: 'warning' },
        };
        const a = map[b.dataset.test];
        AC.Voice.say(AC.Voice.text(a), 99, { interrupt: true, force: true, level: a.level });
      }));
      $('#resetSettings').addEventListener('click', () => { AC.Settings.reset(); });
      $('#terrDownload').addEventListener('click', () => {
        const p = this.own || AC.Gps.state;
        if (!p) { $('#terrDlInfo').textContent = 'Keine Position – erst System starten.'; return; }
        const n = AC.Terrain.prefetch(p.lat, p.lon, 60000, 11) + AC.Terrain.prefetch(p.lat, p.lon, 150000, 9);
        $('#terrDlInfo').textContent = `${n} Kacheln angefordert …`;
      });
    },

    voiceHint() {
      const el = $('#voiceHint');
      if (!el) return;
      const sel = S.lang === 'de' ? 'de' : 'en';
      const n = AC.Voice.voices().filter((v) => v.lang.toLowerCase().startsWith(sel)).length;
      if (!('speechSynthesis' in window)) el.textContent = '⚠ Dieser Browser hat keine Sprachausgabe – es kommen nur Warntöne.';
      else if (!AC.Voice.voices().length) el.textContent = 'Stimmen werden geladen …';
      else if (!n) el.textContent = `⚠ Keine ${sel === 'en' ? 'englische' : 'deutsche'} Stimme installiert – Ansagen erfolgen deshalb in der anderen Sprache. Windows: Einstellungen → Zeit und Sprache → Sprache → ${sel === 'en' ? 'Englisch' : 'Deutsch'} hinzufügen (mit Sprachausgabe).`;
      else el.textContent = `${n} passende Stimme(n) installiert.`;
    },

    syncForm() {
      $$('[data-set]').forEach((el) => {
        const v = S[el.dataset.set];
        if (document.activeElement === el && (el.type === 'text' || el.type === 'number')) return;
        if (el.type === 'checkbox') el.checked = !!v;
        else if (el.dataset.conv) el.value = Math.round(v * CONV[el.dataset.conv]());
        else el.value = v;
      });
      $$('[data-seg]').forEach((seg) => {
        const v = String(S[seg.dataset.seg]);
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.val === v));
      });
      $$('[data-unit]').forEach((el) => { el.textContent = UNIT_LABEL[el.dataset.unit](); });
      const gv = $('#wxGainVal');
      if (gv) gv.textContent = S.wxGain === 0 ? 'CAL (Standard)' : (S.wxGain > 0 ? '+' : '') + S.wxGain + ' dB';

      // softkey state subtitles
      const sub = {
        mode: S.mode === 'arc' ? 'ARC' : '360°',
        alt: S.altBand.toUpperCase(),
        sens: S.sensGain.toUpperCase(),
        wx: S.wxOn ? 'AN' : 'AUS',
        gain: S.wxGain === 0 ? 'CAL' : (S.wxGain > 0 ? '+' : '') + S.wxGain + ' dB',
        terr: S.wxOn && S.terrOn ? 'BEIDE' : S.terrOn ? 'TERR' : S.wxOn ? 'WX' : 'AUS',
        pwr: this.phase === 'off' ? 'AUS' : 'EIN',
        mute: S.muted ? 'STUMM' : 'AN',
        inhb: S.terrInhibit ? 'GESPERRT' : 'AKTIV',
        sim: S.simEnabled ? 'AN' : 'AUS',
      };
      $$('[data-sub]').forEach((el) => { el.textContent = sub[el.dataset.sub] || ''; });
      $$('[data-sk]').forEach((b) => {
        const k = b.dataset.sk;
        const on = (k === 'wx' && S.wxOn) || (k === 'terr' && S.terrOn) || (k === 'sim' && S.simEnabled);
        const warn = (k === 'mute' && S.muted) || (k === 'inhb' && S.terrInhibit);
        b.classList.toggle('on', on);
        b.classList.toggle('warn', warn);
      });

      // sim step buttons in the selected units
      const st = this.simSteps();
      const lbl = { gsDn: `−${st.gs.disp}`, gsUp: `+${st.gs.disp}`, altDn: `−${st.alt.disp}`, altUp: `+${st.alt.disp}`, vsDn: `−${st.vs.disp}`, vsUp: `+${st.vs.disp}` };
      $$('[data-simlbl]').forEach((b) => { b.textContent = lbl[b.dataset.simlbl]; });
      this.voiceHint();
      const vv = AC.Voice.pickVoice(AC.Voice.effectiveLang());
      $$('[data-voicename]').forEach((el) => {
        el.textContent = vv ? `verwendet: ${vv.name.replace(/^Microsoft |- .*$/g, '').trim()}` : '';
      });
    },

    /** Sim control step sizes: internal units (kt / ft / fpm) and display text. */
    simSteps() {
      const kmh = S.speedUnit === 'kmh', m = S.altUnit === 'm', mps = S.vsUnit === 'mps';
      return {
        gs: kmh ? { kt: 20 / 1.852, disp: '20 km/h' } : { kt: 10, disp: '10 kt' },
        alt: m ? { ft: 150 / U.FT, disp: '150 m' } : { ft: 500, disp: '500 ft' },
        vs: mps ? { fpm: 2.5 / U.FPM, disp: '2,5 m/s' } : { fpm: 500, disp: '500 ft/min' },
      };
    },

    bindSim() {
      const sel = $('#simPreset');
      sel.innerHTML = Object.entries(AC.Sim.PRESETS).map(([k, p]) => `<option value="${k}">${p.name}</option>`).join('') +
        '<option value="gps">Aktuelle GPS-Position</option>';
      $('#simReset').addEventListener('click', () => {
        AC.Sim.reset(sel.value, AC.Gps.state);
        AC.Adsb.clear();
        AC.TrafficLogic.reset();
        AC.Voice.reset();
        AC.Display.wx.a = null;
      });
      $('#simPause').addEventListener('click', () => { AC.Sim.paused = !AC.Sim.paused; });
      $('#scenarios').innerHTML = AC.Sim.SCENARIOS.map((s) =>
        `<button data-scen="${s.id}"><b>${s.name}</b><span>${s.expect}</span></button>`).join('');
      $$('[data-scen]').forEach((b) => b.addEventListener('click', () => {
        AC.Voice.unlock();
        // Live test at the real position (system running on real GPS): test aircraft appear around us,
        // trigger the normal alerts and disappear again when the scenario is over.
        if (!S.simEnabled && this.phase === 'run' && this.own && this.own.source !== 'dr' && AC.Sim.LIVE_OK.test(b.dataset.scen)) {
          AC.TrafficLogic.reset();
          AC.Voice.reset();
          if (AC.Sim.startLive(b.dataset.scen, this.own)) {
            if (b.dataset.scen.startsWith('wx') && !S.wxOn) { AC.Settings.set('wxOn', true); }
            AC.Display.wx.a = null;
            $$('[data-scen]').forEach((x) => x.classList.toggle('active', x === b));
            $('#hint').textContent = `Live-Test an deiner Position: ${b.querySelector('b').textContent}`;
            return;
          }
        }
        // Terrain / obstacle / GPS scenarios: test flight starting at the real position, back to live data afterwards.
        if (!S.simEnabled && this.phase === 'run' && this.own && this.own.source !== 'dr') {
          AC.TrafficLogic.reset();
          AC.Voice.reset();
          if (AC.Sim.startTest(b.dataset.scen, this.own)) {
            if (b.dataset.scen.startsWith('terrain') && S.rangeNM > 10) AC.Settings.set('rangeNM', 10);
            AC.Display.wx.a = null;
            AC.Display.terr.img = null;
            AC.Display.terr.keep = null;
            $$('[data-scen]').forEach((x) => x.classList.toggle('active', x === b));
            $('#hint').textContent = `Testflug ab deiner Position: ${b.querySelector('b').textContent}`;
            return;
          }
        }
        if (!S.simEnabled) this.toggleSim(true);
        if (this.phase === 'off') this.powerOn();
        AC.TrafficLogic.reset();
        AC.Voice.reset();
        AC.Sim.load(b.dataset.scen);
        if (b.dataset.scen.startsWith('wx') && !S.wxOn) { AC.Settings.set('wxOn', true); AC.Settings.set('terrOn', false); }
        if (b.dataset.scen.startsWith('terrain') && S.rangeNM > 10) AC.Settings.set('rangeNM', 10);
        AC.Display.wx.a = null;
        AC.Display.terr.img = null;
        $$('[data-scen]').forEach((x) => x.classList.toggle('active', x === b));
      }));
      // remote control: the traffic / weather / failure scenarios (terrain + obstacle alerts are off in the car)
      $('#rmScen').innerHTML = AC.Sim.SCENARIOS.filter((s) => AC.Sim.LIVE_OK.test(s.id)).map((s) =>
        `<button data-rscen="${s.id}">${s.name}</button>`).join('');
      $$('[data-rscen]').forEach((b) => b.addEventListener('click', () => {
        const src = document.querySelector(`#scenarios [data-scen="${b.dataset.rscen}"]`);
        if (src) src.click();
        $$('[data-rscen]').forEach((x) => x.classList.toggle('on', x === b));
        this.updateRemote();
      }));
      $('#alertTestBtn').addEventListener('click', () => this.alertTest());
      $('#scenClear').addEventListener('click', () => {
        if (AC.AlertTest.active) AC.AlertTest.stop();
        if (AC.Sim.live) AC.Sim.endLive();
        if (AC.Sim.testRun) { AC.Sim.endTest(); $$('[data-scen]').forEach((x) => x.classList.remove('active')); return; }
        AC.Sim.clearScenario();
        $$('[data-scen]').forEach((x) => x.classList.remove('active'));
      });
      $$('[data-sim]').forEach((b) => b.addEventListener('click', () => {
        AC.Sim.ensure();
        const o = AC.Sim.own, st = this.simSteps();
        switch (b.dataset.sim) {
          case 'turnL': o.turn = Math.max(-3, o.turn - 1.5); break;
          case 'turnR': o.turn = Math.min(3, o.turn + 1.5); break;
          case 'turn0': o.turn = 0; break;
          case 'gsUp': o.gsKt = Math.min(400, o.gsKt + st.gs.kt); break;
          case 'gsDn': o.gsKt = Math.max(0, o.gsKt - st.gs.kt); break;
          case 'altUp': o.altFt += st.alt.ft; break;
          case 'altDn': o.altFt = Math.max(0, o.altFt - st.alt.ft); break;
          case 'vsUp': o.vsFpm = Math.min(3000, o.vsFpm + st.vs.fpm); break;
          case 'vsDn': o.vsFpm = Math.max(-3000, o.vsFpm - st.vs.fpm); break;
          case 'vs0': o.vsFpm = 0; break;
          default: break;
        }
      }));
    },

    updatePanel(now) {
      if (now - this._lastPanel < 900) return;
      this._lastPanel = now;
      const ago = (t) => (t ? `${((now - t) / 1000).toFixed(1)} s` : '–');
      const cls = (ok) => (ok ? 'ok' : 'bad');

      // Sources
      const rows = [];
      const vd = AC.Voice.diag;
      const audioState = S.muted ? 'STUMM' : vd.status;
      rows.push(['Sprachausgabe', audioState, audioState === 'OK' || audioState === 'BEREIT',
        `${vd.profile ? vd.profile + ': ' : ''}${vd.voice || 'noch keine Ansage'}${vd.lang ? ', ' + (vd.lang === 'de' ? 'Deutsch' : 'Englisch') : ''}` +
        (vd.fallback ? ' (gewählte Sprache nicht installiert)' : '') +
        (vd.lastErr ? `, letzter Fehler: ${vd.lastErr}` : '') + (S.muted ? ' – Taste TON drücken' : '')]);
      if (S.simEnabled) {
        rows.push(['Position', 'SIM', true, AC.Sim.paused ? 'pausiert' : 'simuliertes Flugzeug']);
      } else {
        const g = AC.Gps.state;
        const ns = AC.Gps.nativeStatus();
        let hint = AC.Gps.error || 'warte auf Fix';
        if (ns && !ns.permission) hint = 'Standort-Berechtigung fehlt';
        else if (ns && !ns.gpsEnabled) hint = 'Standort/GPS am Handy ausgeschaltet';
        else if (ns && !g) hint = `suche Satelliten (${ns.sats}/${ns.satsVisible} sichtbar) – freie Sicht zum Himmel nötig`;
        const src = g ? (g.gnss ? `Satelliten-Fix, ${AC.Gps.sats != null ? AC.Gps.sats + ' Sat.' : ''}` : 'nur Netzwerk-Ortung') : '';
        rows.push(['GPS', g ? (g.gnss ? 'OK' : 'NETZ') : AC.Gps.status.toUpperCase(), !!this.own && !!g && g.gnss,
          g ? `${src}, ±${Math.round(g.acc)} m, vor ${ago(g.t)}${g.altAcc ? `, Höhe ±${Math.round(g.altAcc)} m` : ''}` : hint]);
      }
      if (!S.simEnabled) {
        const A = AC.Ahrs;
        const bias = A.bias.map((b) => Math.abs(b * 180 / Math.PI)).reduce((m, b) => Math.max(m, b), 0);
        rows.push(['Lage (AHRS)', A.status, A.status === 'OK',
          A.running ? `Querlage ${A.roll.toFixed(0)}°, Längsneigung ${A.pitch.toFixed(0)}°, Kurs ${Math.round(A.heading)}° (${A.headingRef})` +
            `, Kreiseldrift ${bias.toFixed(3)} °/s ausgeglichen (${A.biasSource})` : (A.status === 'NO SENSORS' ? 'nur in der Android-App' : 'aus')]);
        rows.push(['Barometer', A.baroOk() ? 'OK' : '–', A.baroOk(),
          A.baroOk() ? `${A.pressure.toFixed(1)} hPa, Druckhöhe ${F.alt(A.pressAltFt * U.FT)} ${F.altLabel()}, Steigrate ${F.vs(A.baroVs || 0)} ${F.vsLabel()}` : 'kein Barometer / aus']);
        if (A.dr) rows.push(['Koppelnavigation', 'AKTIV', false, `seit ${Math.round((now - A.lastGood.t) / 1000)} s ohne GPS`]);
      }
      for (const [id, src] of Object.entries(AC.Adsb.SOURCES)) {
        const st = AC.Adsb.src[id] || { status: 'IDLE' };
        rows.push([src.name, st.status, st.status === 'OK', st.status === 'OK' ? `${st.count} Flugzeuge, Antwortzeit ${st.rtt} ms, vor ${ago(st.lastOk)}` : (st.err || '')]);
      }
      const off = AC.Adsb.offsets.length >= 3 ? AC.Adsb.baroOffsetFt(this.own && this.own.altMSL ? this.own.altMSL / U.FT : 5000) : null;
      rows.push(['Höhenabgleich', off ? 'OK' : '–', !!off, off ? `GNSS − Druckhöhe ${F.alt(off.ft * U.FT)} ${F.altLabel()} (aus ${AC.Adsb.offsets.length} Messungen)` : 'noch keine Daten']);
      rows.push(['Gelände', AC.Terrain.override ? 'SIM' : (this.terrain && this.terrain.available ? 'OK' : '–'), !!(this.terrain && this.terrain.available),
        `${AC.Terrain.loaded} Kacheln geladen, ${AC.Terrain.inflight} aktiv, ${AC.Terrain.failed} Fehler` +
        (this.terrain && this.terrain.aglFt !== null ? `, Höhe über Grund ${F.alt(this.terrain.aglFt * U.FT)} ${F.altLabel()}` : '')]);
      rows.push(['Hindernisse', AC.Obstacles.status, AC.Obstacles.status === 'OK',
        `${AC.Obstacles.list.length} OSM-Objekte, ${AC.Obstacles.aerodromes.length} Flugplätze${AC.Obstacles.err ? ', ' + AC.Obstacles.err : ''}`]);
      rows.push(['Wetterradar', AC.Weather.status, AC.Weather.status === 'OK',
        AC.Weather.frame ? `Bild vor ${AC.Weather.ageMin()} min, ${AC.Weather.tiles.size} Kacheln, Gewitter ${AC.Weather.thunderStatus}` : (AC.Weather.err || (S.wxOn ? 'lädt' : 'aus'))]);
      $('#statusSources').innerHTML = '<table class="t"><tbody>' + rows.map((r) =>
        `<tr><td>${r[0]}</td><td class="${cls(r[2])}">${r[1]}</td><td>${r[3]}</td></tr>`).join('') + '</tbody></table>';

      // Traffic list
      const items = this.tfc ? this.tfc.items.slice(0, 14) : [];
      const lvl = { warn: 'WARNUNG', ta: 'TA', prox: 'NAH', other: '' };
      $('#statusTraffic').innerHTML = items.length ? `<table class="t"><thead><tr><th>Ziel</th><th>Stufe</th><th>Dist ${F.distLabel()}</th><th>Uhr</th><th>Höhe ${F.altLabel()}</th><th>VS ${F.vsLabel()}</th><th>Alter s</th><th>±m</th><th>Quelle</th></tr></thead><tbody>` +
        items.map((it) => `<tr class="lv-${it.level}"><td>${it.t.label}</td><td>${lvl[it.level]}</td><td>${F.dist(it.r)}</td><td>${it.clock}</td>` +
          `<td>${it.relAltFt === null ? '?' : (it.relAltFt > 0 ? '+' : '') + F.alt(it.relAltFt * U.FT)}${it.t.altEst ? '*' : ''}</td>` +
          `<td>${F.vs(it.t.vs)}</td><td>${it.t.age.toFixed(1)}</td><td>${Math.round(it.unc)}</td><td>${[...it.t.sources].join('+')}</td></tr>`).join('') +
        '</tbody></table><p class="small">Höhe relativ zu dir. * = aus Druckhöhe geschätzt. ±m = Positionsunsicherheit inkl. Vorausberechnung.</p>'
        : '<p class="small">Kein Verkehr im Bereich.</p>';

      // Log
      $('#statusLog').innerHTML = AC.Voice.log.slice(0, 14).map((l) =>
        `<div class="lv-${l.level}"><span>${new Date(l.t).toLocaleTimeString()}</span> ${l.text}${l.ok && l.ok !== 'gesprochen' ? ` <em>(${l.ok})</em>` : ''}</div>`).join('') || '<div class="small">–</div>';

      // Sim readouts
      if (AC.Sim.own) {
        const o = AC.Sim.own;
        $('#simHdg').textContent = `${String(Math.round(o.hdg)).padStart(3, '0')}° ${o.turn ? (o.turn > 0 ? '↻' : '↺') : ''}`;
        $('#simGs').textContent = `${F.speed(o.gsKt * U.KT)} ${F.speedLabel()}`;
        $('#simAlt').textContent = `${F.alt(o.altFt * U.FT)} ${F.altLabel()}`;
        $('#simVs').textContent = `${F.vs(o.vsFpm * U.FPM)} ${F.vsLabel()}`;
        $('#simScript').textContent = AC.Sim.script ? `✈ Autopilot (${Math.round(AC.Sim.scriptElapsed)} s): ${AC.Sim.scriptLabel}` : '';
      }
    },
  };

  AC.App = App;
  window.addEventListener('DOMContentLoaded', () => App.init());
})(window.AC = window.AC || {});
