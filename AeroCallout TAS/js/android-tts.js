/*
 * AeroCallout - Android bridge.
 * Android's WebView has no working Web Speech engine. When the app runs inside the AeroCallout Android app,
 * window.AndroidTTS (native text-to-speech) is available; this file maps the standard speechSynthesis API onto it,
 * so the rest of the app works unchanged. In a normal browser this file does nothing.
 */
(function () {
  'use strict';
  if (!window.AndroidTTS) return;

  const listeners = {};
  const utts = {};
  let seq = 0;
  let voicesCache = [];

  function loadVoices() {
    try {
      voicesCache = JSON.parse(window.AndroidTTS.voices()).map((v) => ({
        name: v.name, lang: v.lang, localService: !v.network, default: false, voiceURI: v.name,
      }));
    } catch (e) { voicesCache = []; }
    return voicesCache;
  }

  function Utterance(text) {
    this.text = text;
    this.lang = '';
    this.voice = null;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }

  const synth = {
    pending: false,
    paused: false,
    get speaking() { return Object.keys(utts).length > 0; },
    getVoices() { return voicesCache.length ? voicesCache : loadVoices(); },
    speak(u) {
      const id = 'u' + (++seq);
      utts[id] = u;
      let ok = false;
      try {
        ok = window.AndroidTTS.speak(String(u.text), u.voice ? u.voice.name : '', u.lang || '',
          Number(u.rate) || 1, Number(u.pitch) || 1, u.volume === undefined ? 1 : Number(u.volume), id);
      } catch (e) { ok = false; }
      if (!ok) {
        delete utts[id];
        setTimeout(() => { if (u.onerror) u.onerror({ error: 'synthesis-failed' }); }, 0);
      }
    },
    cancel() {
      try { window.AndroidTTS.stop(); } catch (e) { /* ignore */ }
      Object.keys(utts).forEach((id) => {
        const u = utts[id];
        delete utts[id];
        if (u.onerror) u.onerror({ error: 'interrupted' });
      });
    },
    pause() {},
    resume() {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
  };

  // Events from the native side: start / done / error per utterance, 'voices' when the engine is ready.
  window.__ttsEvent = function (id, type, err) {
    if (type === 'voices') {
      loadVoices();
      (listeners.voiceschanged || []).forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
      return;
    }
    const u = utts[id];
    if (!u) return;
    if (type === 'start') { if (u.onstart) u.onstart({}); }
    else if (type === 'done') { delete utts[id]; if (u.onend) u.onend({}); }
    else if (type === 'error') { delete utts[id]; if (u.onerror) u.onerror({ error: err || 'synthesis-failed' }); }
  };

  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = Utterance;
  window.AC_ANDROID = true;
})();
