/*
 * AeroCallout iOS bridge (injected before the page scripts).
 * Provides the same window.AndroidTTS / AndroidGPS / AndroidSensors / AndroidPower objects as the Android app,
 * so the web app runs unchanged. Calls that return a value use a synchronous prompt() round trip
 * (answered natively in WKUIDelegate); calls without a result use a message handler.
 */
(function () {
  'use strict';
  if (window.__acBridge) return;
  window.__acBridge = true;
  window.AC_IOS = true;

  function call(obj, method, args) {
    try {
      const r = window.prompt('__ac__' + JSON.stringify({ o: obj, m: method, a: args || [] }));
      return r === null || r === undefined ? '' : r;
    } catch (e) { return ''; }
  }
  function post(obj, method, args) {
    try { window.webkit.messageHandlers.ac.postMessage({ o: obj, m: method, a: args || [] }); } catch (e) { /* ignore */ }
  }
  const bool = (s) => s === 'true';

  window.AndroidTTS = {
    ready: () => bool(call('tts', 'ready')),
    voices: () => call('tts', 'voices') || '[]',
    speak: (text, voice, lang, rate, pitch, volume, id) =>
      bool(call('tts', 'speak', [String(text), voice || '', lang || '', +rate || 1, +pitch || 1, volume === undefined ? 1 : +volume, String(id)])),
    stop: () => post('tts', 'stop'),
  };
  window.AndroidGPS = {
    start: () => post('gps', 'start'),
    stop: () => post('gps', 'stop'),
    status: () => call('gps', 'status') || '{}',
  };
  window.AndroidSensors = {
    start: () => post('sensors', 'start'),
    stop: () => post('sensors', 'stop'),
    available: () => call('sensors', 'available') || '{}',
  };
  window.AndroidPower = {
    startTicker: () => post('power', 'startTicker'),
    startMonitoring: () => post('power', 'startMonitoring'),
    stopMonitoring: () => post('power', 'stopMonitoring'),
    setKeepScreenOn: (on) => post('power', 'setKeepScreenOn', [!!on]),
    wake: (text) => post('power', 'wake', [String(text || '')]),
    insets: () => call('power', 'insets') || '{"l":0,"r":0,"b":0}',
    state: () => call('power', 'state') || '{}',
  };

  // Settings snapshot for the native background warner (the page is suspended by iOS in the background).
  window.__acSnapshot = function () {
    try {
      const S = (window.AC && AC.settings) || {};
      const A = (window.AC && AC.App) || {};
      return JSON.stringify({
        phase: A.phase || 'off', lang: S.lang, muted: !!S.muted, traffic: S.trafficEnabled !== false,
        sens: S.sens, sensGain: S.sensGain, minSpeedKt: S.minSpeedKt, radiusNM: S.radiusNM,
        ownHex: S.ownHex || (window.AC && AC.Adsb && AC.Adsb.autoOwnHex) || '',
        closure: S.calloutClosure !== false, distUnit: S.distUnit, speedUnit: S.speedUnit,
        geoidM: S.geoidM, sim: !!S.simEnabled, rate: S.voiceRate || 1, volume: S.volume === undefined ? 1 : S.volume,
      });
    } catch (e) { return '{}'; }
  };
})();
