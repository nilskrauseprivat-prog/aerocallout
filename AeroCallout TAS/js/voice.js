/*
 * AeroCallout - aural alerts (speech synthesis) with aviation-style phraseology and prioritisation:
 *   terrain/obstacle warnings > traffic warnings > terrain/obstacle cautions > traffic advisories.
 * Like TCAS, traffic callouts are inhibited while a terrain/obstacle warning is active.
 *
 * Robustness (browser speech engines differ a lot):
 *  - voice chosen explicitly for the language, local (offline) voices preferred;
 *    if no voice for the selected language is installed, callouts switch to the other language;
 *  - strong references to utterances (Chrome drops events of garbage-collected utterances);
 *  - small delay after cancel() (Chrome may drop an utterance spoken right after cancel);
 *  - watchdog + retry with the default voice; if speech still fails, an alert tone is played;
 *  - diagnostics for the status page.
 */
(function (AC) {
  'use strict';
  const U = () => AC.U;
  const hasSpeech = 'speechSynthesis' in window;

  const P = {
    en: {
      oclock: (c) => `${c} o'clock`,
      high: 'high', low: 'low', same: 'same altitude', unknown: 'altitude unknown',
      lessNm: 'less than one mile', nm: (n) => (n === 1 ? 'one mile' : `${n} miles`),
      lessKm: 'less than one kilometer', km: (n) => (n === 1 ? 'one kilometer' : `${n} kilometers`),
      traffic: 'Traffic', tcasTA: 'Traffic, Traffic.', tcasWarn: 'Traffic! Traffic!',
      terrCaution: 'Caution, Terrain! Caution, Terrain!', terrWarning: 'Terrain, Terrain! Pull up! Pull up!',
      obsCaution: 'Caution, Obstacle! Caution, Obstacle!', obsWarning: 'Obstacle, Obstacle! Pull up!',
      clear: 'Clear of conflict.', test: 'Traffic system test, OK.', testTerr: 'Terrain test, OK.',
      audioTest: 'Audio test. Traffic! Two o\'clock, high, three miles.',
      closing: (n, kmh) => `closing ${n} ${kmh ? 'kilometers per hour' : 'knots'}`,
    },
    de: {
      oclock: (c) => `${c} Uhr`,
      high: 'höher', low: 'tiefer', same: 'gleiche Höhe', unknown: 'Höhe unbekannt',
      lessNm: 'unter einer Meile', nm: (n) => (n === 1 ? 'eine Meile' : `${n} Meilen`),
      lessKm: 'unter einem Kilometer', km: (n) => (n === 1 ? 'ein Kilometer' : `${n} Kilometer`),
      traffic: 'Verkehr', tcasTA: 'Verkehr, Verkehr.', tcasWarn: 'Verkehr! Verkehr!',
      terrCaution: 'Vorsicht, Gelände! Vorsicht, Gelände!', terrWarning: 'Gelände, Gelände! Hochziehen! Hochziehen!',
      obsCaution: 'Vorsicht, Hindernis! Vorsicht, Hindernis!', obsWarning: 'Hindernis, Hindernis! Hochziehen!',
      clear: 'Konflikt beendet.', test: 'Verkehrssystem Test, in Ordnung.', testTerr: 'Geländetest, in Ordnung.',
      audioTest: 'Audiotest. Verkehr! 2 Uhr, höher, 3 Meilen.',
      closing: (n, kmh) => `Annäherung ${n} ${kmh ? 'Kilometer pro Stunde' : 'Knoten'}`,
    },
  };

  // ------------------------------------------------------------------ voices
  function voices() { return hasSpeech ? speechSynthesis.getVoices() : []; }
  function voicesFor(lang) { return voices().filter((v) => v.lang && v.lang.toLowerCase().startsWith(lang)); }

  /** Language actually used for callouts (falls back if no voice is installed for the selection). */
  function effectiveLang() {
    const sel = AC.settings.lang === 'de' ? 'de' : 'en';
    const all = voices();
    if (!all.length || voicesFor(sel).length) return sel;
    const other = sel === 'en' ? 'de' : 'en';
    return voicesFor(other).length ? other : sel;
  }

  // Voice profiles: preferred voice names (in order), gender, and speaking style (rate / pitch factors).
  const PROFILES = {
    female: { label: 'Weiblich', gender: 'f', rate: 1.0, pitch: 1.0,
      pref: ['hedda', 'zira', 'sonia', 'aria', 'katja', 'jenny', 'susan', 'hazel', '-x-tpf-', '-x-dea-'] },
    friendly: { label: 'Weiblich freundlich', gender: 'f', rate: 0.93, pitch: 1.15,
      pref: ['katja', 'jenny', 'aria', 'libby', 'amala', 'zira', 'emma', 'hedda', '-x-iob-', '-x-tpc-', '-x-deb-'] },
    firm: { label: 'Weiblich bestimmt', gender: 'f', rate: 1.12, pitch: 0.85,
      pref: ['hedda', 'hazel', 'susan', 'sonia', 'michelle', 'zira', 'katja', '-x-sfg-', '-x-iog-', '-x-nfh-'] },
    male: { label: 'Männlich', gender: 'm', rate: 1.0, pitch: 0.95,
      pref: ['stefan', 'conrad', 'killian', 'david', 'mark', 'george', 'guy', 'ryan', 'christopher', '-x-iom-', '-x-iol-', '-x-tpd-', '-x-deg-'] },
    custom: { label: 'Bestimmte Stimme', gender: null, rate: 1.0, pitch: 1.0, pref: [] },
  };
  // Includes Google (Android) voice codes, e.g. "en-us-x-iol-local" (male), "de-de-x-deb-local" (female).
  const FEMALE_RE = /-x-(iob|iog|sfg|tpc|tpf|gba|gbc|gbg|dea|deb|nfh)-|female|hedda|katja|zira|hazel|susan|aria|jenny|sonia|libby|amala|seraphina|michelle|emma|anna|vicki|helena|samantha|karen|moira|tessa|google deutsch/i;
  const MALE_RE = /-x-(iol|iom|tpd|gbb|gbd|rjs|deg)-|\bmale\b|stefan|conrad|killian|david|mark|george|guy|ryan|daniel|thomas|markus|james|christopher|eric|roger|florian/i;
  function gender(v) {
    if (FEMALE_RE.test(v.name)) return 'f';
    if (MALE_RE.test(v.name)) return 'm';
    return '?';
  }

  function profile() { return PROFILES[AC.settings.voiceProfile] || PROFILES.male; }

  function pickVoice(lang) {
    const S = AC.settings;
    const list = voicesFor(lang);
    if (!list.length) return null;
    if (S.voiceProfile === 'custom' && S.voiceName) {
      const v = list.find((x) => x.name === S.voiceName);
      if (v) return v;
    }
    const P = profile();
    const local = list.filter((v) => v.localService);
    let pool = local.length ? local : list;
    if (P.gender) {
      const g = pool.filter((v) => gender(v) === P.gender);
      if (g.length) pool = g;
    }
    const rank = (v) => { const i = P.pref.findIndex((p) => v.name.toLowerCase().includes(p)); return i < 0 ? 99 : i; };
    return pool.slice().sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  function phr() { return P[effectiveLang()] || P.en; }

  function vertWord(relAltFt) {
    const p = phr();
    if (relAltFt === null || relAltFt === undefined) return p.unknown;
    if (relAltFt > 200) return p.high;
    if (relAltFt < -200) return p.low;
    return p.same;
  }

  function distWords(m) {
    const p = phr();
    if (AC.settings.distUnit === 'km') {
      const k = m / 1000;
      return k < 1 ? p.lessKm : p.km(Math.round(k));
    }
    const n = m / U().NM;
    return n < 1 ? p.lessNm : p.nm(Math.round(n));
  }

  /** Closure rate ("closing 180 knots") when enabled and the target is converging noticeably. */
  function closureWords(it) {
    if (!AC.settings.calloutClosure || !(it.closureMs > 5)) return '';   // > ~10 kt
    const kmh = AC.settings.speedUnit === 'kmh';
    const v = AC.Fmt.speed(it.closureMs);
    const n = Math.max(10, Math.round(v / 10) * 10);                     // rounded to 10 for speech
    return phr().closing(n, kmh);
  }

  /** Text for an alert object built by the app. */
  function text(a) {
    const p = phr();
    const S = AC.settings;
    switch (a.kind) {
      case 'traffic': {
        const it = a.item;
        // car mode (Android Auto): altitude is not part of the callout
        const car = AC.Car && AC.Car.active();
        let detail = car ? `${p.oclock(it.clock)}, ${distWords(it.r)}` : `${p.oclock(it.clock)}, ${vertWord(it.relAltFt)}, ${distWords(it.r)}`;
        const cl = closureWords(it);
        if (cl && (a.level === 'warn' || a.level === 'ta')) detail += `, ${cl}`;
        if (a.level === 'warn') return S.style === 'tcas' ? `${p.tcasWarn}${cl ? ' ' + cl + '.' : ''}` : `${p.traffic}! ${p.traffic}! ${detail}!`;
        if (a.level === 'ta') return S.style === 'tcas' ? `${p.tcasTA}${cl ? ' ' + cl + '.' : ''}` : `${p.traffic}! ${detail}.`;
        return `${p.traffic}, ${detail}.`;
      }
      case 'terrain': return a.level === 'warning' ? p.terrWarning : p.terrCaution;
      case 'obstacle': return a.level === 'warning' ? p.obsWarning : p.obsCaution;
      default: return a.text || '';
    }
  }

  // ------------------------------------------------------------------ alert tones (WebAudio)
  const Tone = {
    ctx: null,
    unlock() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { this.ctx = null; }
    },
    beep(freq, start, dur, vol) {
      const c = this.ctx;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vol, start + 0.01);
      g.gain.setValueAtTime(vol, start + dur - 0.02);
      g.gain.linearRampToValueAtTime(0, start + dur);
      o.connect(g); g.connect(c.destination);
      o.start(start); o.stop(start + dur + 0.02);
    },
    play(level) {
      if (!this.ctx) return false;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const t = this.ctx.currentTime + 0.02;
      const vol = 0.12 * AC.settings.volume;
      if (level === 'warn' || level === 'warning') {
        for (let i = 0; i < 3; i++) this.beep(1050, t + i * 0.2, 0.13, vol);
      } else if (level === 'ta' || level === 'caution') {
        this.beep(880, t, 0.18, vol);
        this.beep(660, t + 0.22, 0.18, vol);
      } else {
        this.beep(760, t, 0.15, vol);
      }
      return true;
    },
  };

  // ------------------------------------------------------------------ speech manager
  const Voice = {
    speaking: false,
    currentPrio: -1,
    spoken: new Map(),     // key -> {prio, time, lastActive}
    log: [],               // [{t, text, level, ok}]
    diag: { status: hasSpeech ? 'BEREIT' : 'NICHT VERFÜGBAR', voice: '', lang: '', lastOk: 0, lastErr: '', errors: 0, fallback: false },
    _keep: [],
    _queue: [],
    _vkey: '',
    _vcache: null,
    _seq: 0,
    PROFILES,
    profile,
    _startedAt: 0,
    _hadConflict: false,
    phr,
    text,
    effectiveLang,
    pickVoice,
    voices,
    Tone,

    /** Must be called from a user gesture (PWR button) - unlocks speech and WebAudio in all browsers. */
    unlock() {
      Tone.unlock();
      if (!hasSpeech) return;
      try {
        if (speechSynthesis.paused) speechSynthesis.resume();
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        this._keep.push(u);
        speechSynthesis.speak(u);
      } catch (e) { /* ignore */ }
    },

    /**
     * Speaks a callout. Only ONE utterance is ever handed to the browser at a time (own queue),
     * and always with the same voice for the selected profile - so voices never overlap or mix.
     * Higher priority interrupts lower priority; lower/equal priority waits in the queue.
     */
    say(txt, prio, opts) {
      opts = opts || {};
      const entry = { t: Date.now(), text: txt, level: opts.level || '', ok: null };
      this.log.unshift(entry);
      if (this.log.length > 40) this.log.pop();
      if (AC.settings.muted && !opts.force) { entry.ok = 'stumm'; return; }
      if (!hasSpeech) { Tone.play(opts.level); entry.ok = 'nur Ton'; return; }

      const job = { txt, prio, opts, entry, retried: false };
      const interrupt = opts.interrupt || (this.speaking && prio > this.currentPrio);
      if (this.speaking && !interrupt) {
        // wait for the current callout; keep only the two most important pending ones
        this._queue = this._queue.filter((j) => j.txt !== txt);
        this._queue.push(job);
        this._queue.sort((a, b) => b.prio - a.prio);
        this._queue.slice(2).forEach((j) => { j.entry.ok = 'verworfen'; });
        this._queue = this._queue.slice(0, 2);
        entry.ok = 'wartet';
        return;
      }
      if (interrupt) this._queue = this._queue.filter((j) => j.prio > prio);
      this._start(job, interrupt);
    },

    /** Voice for the current language/profile, cached so that every callout uses the same voice. */
    _voice() {
      const lang = effectiveLang();
      const key = `${lang}|${AC.settings.voiceProfile}|${AC.settings.voiceName}|${voices().length}`;
      if (this._vkey !== key) { this._vkey = key; this._vcache = pickVoice(lang); }
      return { v: this._vcache, lang };
    },

    _start(job, afterCancel) {
      const S = AC.settings;
      const P = profile();
      const id = ++this._seq;
      this.speaking = true;
      this.currentPrio = job.prio;
      this._startedAt = Date.now();
      if (afterCancel) speechSynthesis.cancel();
      if (speechSynthesis.paused) speechSynthesis.resume();
      const urgent = ['warn', 'warning'].includes(job.opts.level);
      if (S.warnTone && urgent && !job.retried) Tone.play(job.opts.level);

      const { v, lang } = this._voice();
      const u = new SpeechSynthesisUtterance(job.txt);
      if (v) u.voice = v;
      u.lang = v ? v.lang : (lang === 'de' ? 'de-DE' : 'en-US');
      u.rate = Math.min(2, S.voiceRate * P.rate);
      u.pitch = P.pitch;
      u.volume = S.volume;
      this.diag.voice = v ? `${v.name}${v.localService ? '' : ' (online)'}` : 'Standardstimme';
      this.diag.profile = P.label;
      this.diag.lang = lang;
      this.diag.fallback = lang !== (S.lang === 'de' ? 'de' : 'en');

      let started = false;
      this._keep.push(u);
      if (this._keep.length > 6) this._keep.shift();
      const finish = () => {
        if (this._seq !== id) return;
        this.speaking = false;
        this.currentPrio = -1;
        this._next();
      };
      const fail = (msg) => {
        this.diag.lastErr = msg;
        this.diag.errors++;
        this.diag.status = 'FEHLER';
        job.entry.ok = msg;
        if (this._seq !== id) return;
        if (!job.retried) { job.retried = true; this._start(job, true); }   // retry once, SAME voice
        else { Tone.play(job.opts.level); finish(); }
      };
      u.onstart = () => {
        started = true;
        job.entry.ok = 'gesprochen';
        this.diag.lastOk = Date.now();
        this.diag.status = 'OK';
      };
      u.onend = finish;
      u.onerror = (e) => {
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        fail('Fehler: ' + (e.error || 'unbekannt'));
      };
      const go = () => { if (this._seq === id) speechSynthesis.speak(u); };
      if (afterCancel) setTimeout(go, 80); else go();

      // Watchdog: the engine is idle but our utterance never started.
      setTimeout(() => {
        if (started || this._seq !== id || speechSynthesis.speaking) return;
        speechSynthesis.cancel();
        fail('nicht gestartet');
      }, 3000);
    },

    _next() {
      const job = this._queue.shift();
      if (job) this._start(job, false);
    },

    /** Called every logic cycle with all active alerts. */
    process(alerts, now) {
      const S = AC.settings;
      if (this.speaking && now - this._startedAt > 9000) { this._seq++; this.speaking = false; this.currentPrio = -1; this._next(); }

      const ground = alerts.some((a) => (a.kind === 'terrain' || a.kind === 'obstacle') && a.level === 'warning');
      let list = ground ? alerts.filter((a) => a.kind !== 'traffic') : alerts.slice();
      if (!S.announceProx) list = list.filter((a) => !(a.kind === 'traffic' && a.level === 'prox'));
      list.sort((a, b) => b.prio - a.prio);

      const conflict = alerts.some((a) => a.kind === 'traffic' && (a.level === 'ta' || a.level === 'warn'));
      if (this._hadConflict && !conflict && S.clearOfConflict) this.say(phr().clear, 20, { level: 'info' });
      this._hadConflict = conflict;

      for (const a of list) {
        const rec = this.spoken.get(a.key);
        if (rec) rec.lastActive = now;
      }

      let spokeThisCycle = false;
      for (let i = 0; i < list.length && !spokeThisCycle; i++) {
        const a = list[i];
        const rec = this.spoken.get(a.key);
        const isNew = !rec;
        const escalated = rec && a.prio > rec.prio;
        const due = rec && a.repeatMs > 0 && now - rec.time >= a.repeatMs && !this.speaking;
        if (isNew || escalated) {
          if (this.speaking && a.prio <= this.currentPrio) break; // wait until the higher callout finished
          this.say(text(a), a.prio, { level: a.level });
          this.spoken.set(a.key, { prio: a.prio, time: now, lastActive: now });
          spokeThisCycle = true;
        } else if (due && i === 0) {
          this.say(text(a), a.prio, { level: a.level });
          rec.time = now;
          spokeThisCycle = true;
        } else if (rec && a.prio < rec.prio) {
          rec.prio = a.prio;   // de-escalated: allow re-announcement when it escalates again
        }
      }

      for (const [k, rec] of this.spoken) {
        if (now - rec.lastActive > 15000) this.spoken.delete(k);
      }
    },

    /** Audio test: tone + speech, result reported via callback after a few seconds. */
    test(cb) {
      this.unlock();
      const toneOk = Tone.play('ta');
      const before = this.diag.lastOk;
      setTimeout(() => this.say(phr().audioTest, 99, { interrupt: true, force: true, level: 'test' }), 600);
      setTimeout(() => {
        const ok = this.diag.lastOk > before;
        let msg = ok ? `✔ Sprache OK – Stimme: ${this.diag.voice}` : `✘ Keine Sprachausgabe (${this.diag.lastErr || 'kein Start'})`;
        if (this.diag.fallback) msg += ' · Keine Stimme für die gewählte Sprache installiert – Ansagen erfolgen in der anderen Sprache.';
        if (!toneOk) msg += ' · Warnton nicht verfügbar';
        cb(msg, ok);
      }, 4000);
    },

    reset() {
      this._queue = [];
      this.spoken.clear();
      this._hadConflict = false;
      this._seq++;
      if (hasSpeech) speechSynthesis.cancel();
      this.speaking = false;
      this.currentPrio = -1;
    },
  };

  AC.Voice = Voice;
})(window.AC = window.AC || {});
