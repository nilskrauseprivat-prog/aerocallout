/* AeroCallout - persistent settings (localStorage). */
(function (AC) {
  'use strict';

  const KEY = 'aerocallout.settings.v1';

  const DEFAULTS = {
    disclaimerAccepted: false,

    // Units ('nm' | 'km', 'kt' | 'kmh', 'ft' | 'm', 'fpm' | 'mps')
    distUnit: 'nm',
    speedUnit: 'kt',
    altUnit: 'ft',
    vsUnit: 'fpm',

    // Display
    rangeNM: 10,            // display range in the selected distance unit: 2, 5, 10, 20, 40, 80
    autoRange: true,
    autoHide: true,         // hide non-essential keys after 8 s without interaction (bigger radar picture)        // zoom to the most important threat during TA / conflict, restore afterwards
    mode: '360',            // '360' (TCAS classic) | 'arc' (ND expanded)
    altBand: 'norm',        // norm | abv | blw | unr
    showCallsigns: false,
    screenMode: 'wake',     // 'on' = screen always on, 'wake' = standby allowed, switched on for alerts (Android app)
    fontScale: 1,           // size of the info texts on the display (0.85 / 1 / 1.2 / 1.4)

    // Traffic logic
    trafficEnabled: true,
    sens: 'auto',           // auto | sl2..sl7
    sensGain: 'norm',       // lo | norm | hi | max
    minSpeedKt: 40,         // below: on-ground, alerts inhibited
    maxAgeS: 12,            // targets older than this are dropped
    ownHex: '',             // own ICAO address (to hide own transponder)

    // Callouts
    lang: 'en',             // en | de
    style: 'garmin',        // garmin | tcas
    voiceProfile: 'male',   // female | friendly | firm | male | custom
    voiceName: '',          // only used with voiceProfile 'custom'
    voiceRate: 1.05,
    volume: 1.0,
    wxAlpha: 0.5,           // weather radar opacity (0.2 .. 1)
    mapMode: 'on',          // road map: 'on' always, 'terr' only together with the terrain picture, 'off'
    mapAlpha: 0.6,          // road map opacity (0.2 .. 1)
    mapStyle: 'dark',       // road map colours: 'dark' (radar green) or 'light' (pale grey)
    carOverhead: 'all',    // car mode: "passing overhead" callout: 'all', 'special' (military, helicopter, drone, private), 'off'
    carAltM: 0,            // car mode: show / warn only aircraft up to this height above us (m), 0 = all
    autoStart: true,       // system (traffic warner) starts with the app, incl. self test
    calloutClosure: true,  // closure rate ("closing 180 knots") in traffic callouts and on the display
    warnTone: true,        // short attention tone before warnings + fallback if speech fails
    announceProx: false,    // also announce proximate traffic (advisory)
    repeatTA: false,        // repeat TA every 20 s while active
    clearOfConflict: false,
    muted: false,

    // Terrain / obstacles
    terrainEnabled: true,
    obstacleEnabled: true,
    osmObstacles: true,
    obsShow: true,          // draw obstacles on the display (the obstacle causing an alert is always shown)
    obsRadiusKm: 40,        // OSM obstacle load radius (10-60 km)

    // Sensors (Android app): attitude (gyro/accel/compass, GPS-aided), barometer, dead reckoning
    ahrsOn: true,
    attShow: false,         // attitude indicator on the display (option)
    baroOn: true,           // barometer for vertical speed / altitude hold / traffic altitude comparison
    drOn: true,             // dead reckoning when GPS is lost
    mount: null,            // phone mounting calibration (rotation phone -> aircraft)
    terrOn: false,          // TERR overlay on display
    terrInhibit: false,
    terrLookahead: 60,      // s
    terrCautionFt: 300,     // required clearance for caution

    // Weather
    wxOn: false,
    wxGain: 0,              // dB, -10..+10 (0 = CAL)
    wxSector: 'arc',        // arc (±60°) | full
    wxThunder: true,        // thunderstorm symbols (Open-Meteo)

    // Data sources
    srcAdsblol: true,
    srcAdsbfi: true,
    radiusNM: 30,
    pollMs: 2000,
    proxyBase: 'auto',      // auto | '' (direct) | custom URL, e.g. https://my-worker.example.workers.dev
    gpsAltRef: 'ellipsoid', // ellipsoid (W3C spec) | msl
    geoidM: 47,             // geoid undulation (Central Europe ≈ 45–50 m)

    // Simulation
    simEnabled: false,
    simLiveTraffic: true,
  };

  function load() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { stored = {}; }
    const s = Object.assign({}, DEFAULTS);
    Object.keys(stored).forEach((k) => { if (k in DEFAULTS) s[k] = stored[k]; });  // drop removed settings
    return s;
  }

  const listeners = [];
  const S = load();

  AC.settings = S;
  AC.Settings = {
    DEFAULTS,
    set(key, value) {
      if (!(key in DEFAULTS)) return;
      S[key] = value;
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage full / private mode */ }
      listeners.forEach((fn) => fn(key, value));
    },
    onChange(fn) { listeners.push(fn); },
    reset() {
      Object.keys(DEFAULTS).forEach((k) => { if (k !== 'disclaimerAccepted') S[k] = DEFAULTS[k]; });
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
      listeners.forEach((fn) => fn('*', null));
    },
  };
})(window.AC = window.AC || {});
