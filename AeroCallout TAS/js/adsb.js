/*
 * AeroCallout - ADS-B data fusion.
 *
 * Reliability measures:
 *  - Two independent open aggregators (adsb.lol, adsb.fi) polled alternately -> ~1 s effective update rate,
 *    and redundancy if one fails.
 *  - Exact position time per target: request midpoint minus "seen_pos" (independent of clock skew).
 *  - Only the freshest position per aircraft is kept (by position time, not arrival time).
 *  - Dead reckoning to "now" including turn rate (track_rate), so turning traffic is predicted on its arc.
 *  - Position uncertainty from NACp / MLAT / TIS-B plus extrapolation error -> enlarges protection volume.
 *  - GNSS altitude preferred; pressure-only targets corrected by learned (GNSS - baro) offset
 *    from nearby aircraft at similar altitude (compensates QNH and temperature).
 *  - Own transponder echo filtered (configured hex or automatic detection).
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  const SOURCES = {
    adsblol: { name: 'adsb.lol', host: 'https://api.adsb.lol', path: (la, lo, r) => `v2/point/${la}/${lo}/${r}`, key: 'srcAdsblol' },
    adsbfi: { name: 'adsb.fi', host: 'https://opendata.adsb.fi/api', path: (la, lo, r) => `v2/lat/${la}/lon/${lo}/dist/${r}`, key: 'srcAdsbfi' },
  };

  // Estimated position uncertainty (95 %) in meters by NACp.
  const NACP_EPU = { 11: 3, 10: 10, 9: 30, 8: 93, 7: 185, 6: 556, 5: 926, 4: 1852, 3: 3704, 2: 7408, 1: 18520 };

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  function parseAircraft(a, refTime, src) {
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number') return null;
    const hex = String(a.hex || '').toLowerCase();
    if (!hex) return null;
    const seenPos = num(a.seen_pos) ?? num(a.seen) ?? 0;
    return {
      hex,
      src,
      flight: String(a.flight || '').trim(),
      reg: a.r || '',
      type: a.t || '',
      category: a.category || '',
      mil: (num(a.dbFlags) & 1) === 1,          // readsb database flag: military
      lat: a.lat,
      lon: a.lon,
      posTime: refTime - seenPos * 1000,
      ground: a.alt_baro === 'ground',
      altBaroFt: num(a.alt_baro),
      altGeomFt: num(a.alt_geom),
      gsKt: num(a.gs),
      trk: num(a.track) ?? num(a.true_heading),
      trackRate: num(a.track_rate) ?? 0,
      vsFpm: num(a.geom_rate) ?? num(a.baro_rate) ?? 0,
      nacp: num(a.nac_p),
      nic: num(a.nic),
      mlat: Array.isArray(a.mlat) && a.mlat.includes('lat'),
      tisb: Array.isArray(a.tisb) && a.tisb.includes('lat'),
      squawk: a.squawk || '',
      emergency: a.emergency && a.emergency !== 'none' ? a.emergency : '',
    };
  }

  const Adsb = {
    SOURCES,
    targets: new Map(),
    src: {},
    offsets: [],          // {d: geom - baro (ft), alt: baro ft, t}
    blockedUntil: 0,      // simulation of a data loss
    autoOwnHex: '',
    _ownCand: {},
    running: false,
    posProvider: null,
    lastData: 0,          // time of last successful ingest (any source)

    start(posProvider) {
      this.posProvider = posProvider;
      this.running = true;
      let offset = 0;
      Object.keys(SOURCES).forEach((id) => {
        this.src[id] = this.src[id] || { status: 'IDLE', lastOk: 0, err: '', count: 0, rtt: 0, inflight: false, nextAt: 0 };
        this.src[id].nextAt = Date.now() + offset;   // stagger sources
        offset += 1000;
      });
    },

    stop() {
      this.running = false;
      Object.values(this.src).forEach((s) => { s.status = 'IDLE'; });
    },

    proxyBase() {
      const p = AC.settings.proxyBase;
      if (p === 'auto') {
        // built-in proxy of the Android / iOS app
        if (location.hostname === 'appassets.androidplatform.net' || location.protocol === 'aerocallout:') return 'proxy';
        const local = location.protocol.startsWith('http') && ['localhost', '127.0.0.1'].includes(location.hostname);
        return local ? '/proxy' : '';
      }
      return String(p || '').replace(/\/+$/, '');
    },

    url(id, lat, lon, r) {
      const s = SOURCES[id];
      const path = s.path(lat.toFixed(4), lon.toFixed(4), Math.round(r));
      const pb = this.proxyBase();
      return pb ? `${pb}/${id}/${path}` : `${s.host}/${path}`;
    },

    tick(now) {
      if (!this.running) return;
      const S = AC.settings;
      if (AC.settings.simEnabled && !S.simLiveTraffic) {
        Object.values(this.src).forEach((s) => { s.status = 'SIM'; });
        return;
      }
      this.offline = navigator.onLine === false;
      if (this.offline) {
        Object.values(this.src).forEach((s) => { s.status = 'OFFLINE'; s.err = 'keine Internetverbindung'; });
        return;
      }
      Object.keys(SOURCES).forEach((id) => {
        const st = this.src[id];
        if (!S[SOURCES[id].key]) { st.status = 'OFF'; return; }
        // Watchdog on the (natively clocked) logic tick: in the background (phone locked, Android Auto) the
        // WebView throttles JavaScript timers to about once a minute, so the 7 s abort timer cannot be relied on.
        if (st.inflight && now - st.inflightSince > 8000) {
          try { st.ctrl.abort(); } catch (e) { /* ignore */ }
          st.inflight = false; st.req = (st.req || 0) + 1;
          st.status = 'ERR'; st.err = 'Zeitüberschreitung'; st.fails = (st.fails || 0) + 1;
          st.nextAt = Math.min(st.nextAt, now + 1000);
        }
        if (st.inflight || now < st.nextAt) return;
        this._fetch(id, st);
      });
    },

    /** Sources that are enabled and currently usable (not in rate-limit backoff). */
    _healthyCount(now) {
      const S = AC.settings;
      return Object.keys(SOURCES).filter((id) => S[SOURCES[id].key] && !(this.src[id].backoffUntil > now)).length;
    },

    /**
     * One request to one source. Reliability:
     *  - rate limit (HTTP 429): exponential backoff 15 s -> 30 s -> 60 s -> 120 s, the other source takes over
     *  - network errors / timeouts: quick retry after 2 s, then 4 s, 8 s (max 15 s)
     *  - the poll interval adapts: with one usable source it is polled at the full rate (min. 1.5 s)
     */
    async _fetch(id, st) {
      const pos = this.posProvider && this.posProvider();
      const S = AC.settings;
      if (!pos) { st.status = 'NO POS'; st.nextAt = Date.now() + 2000; return; }
      st.inflight = true;
      const t0 = Date.now();
      const ctrl = new AbortController();
      const req = st.req = (st.req || 0) + 1;
      st.ctrl = ctrl; st.inflightSince = t0;
      const timer = setTimeout(() => ctrl.abort(), 7000);
      try {
        const r = await fetch(this.url(id, pos.lat, pos.lon, S.radiusNM), { signal: ctrl.signal, cache: 'no-store' });
        const rtt = Date.now() - t0;
        if (!r.ok) { const err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
        const j = await r.json();
        const n = this.ingest(id, j, t0 + rtt / 2);
        st.status = 'OK';
        st.lastOk = Date.now();
        st.rtt = rtt;
        st.count = n;
        st.err = '';
        st.fails = 0;
        st.backoff = 0;
        st.backoffUntil = 0;
        // Combined update rate = pollMs, spread over the usable sources (each source at most every 1.5 s).
        const healthy = Math.max(1, this._healthyCount(Date.now()));
        st.nextAt = t0 + Math.max(1500, S.pollMs * healthy);
      } catch (e) {
        const now = Date.now();
        st.status = 'ERR';
        st.fails = (st.fails || 0) + 1;
        if (e.status === 429) {
          st.backoff = Math.min(120000, st.backoff ? st.backoff * 2 : 15000);
          st.backoffUntil = now + st.backoff;
          st.err = `Abfragelimit erreicht – Pause ${Math.round(st.backoff / 1000)} s`;
          st.nextAt = st.backoffUntil;
          // let the other source(s) take over immediately
          Object.keys(SOURCES).forEach((o) => { if (o !== id && this.src[o] && !this.src[o].inflight) this.src[o].nextAt = Math.min(this.src[o].nextAt, now + 500); });
        } else {
          st.err = e.name === 'AbortError' ? 'Zeitüberschreitung' : (e.status ? 'HTTP ' + e.status : 'Netzwerkfehler');
          st.nextAt = now + Math.min(15000, 2000 * 2 ** Math.min(3, st.fails - 1));
        }
      } finally {
        clearTimeout(timer);
        if (st.req === req) st.inflight = false;   // (a request given up by the watchdog no longer counts)
      }
    },

    ingest(src, json, refTime) {
      if (Date.now() < this.blockedUntil) return 0;
      const list = json.ac || json.aircraft || [];
      let n = 0;
      for (const a of list) {
        const rec = parseAircraft(a, refTime, src);
        if (rec) { this.update(rec); n++; }
      }
      this.lastData = Date.now();
      return n;
    },

    /** Simulated targets go through exactly the same pipeline. */
    /** Simulated aircraft. live = test at the real position: real data freshness is not touched. */
    injectSim(records, live) {
      if (Date.now() < this.blockedUntil) return;
      records.forEach((r) => this.update(Object.assign({ src: 'sim' }, r)));
      if (records.length && !live) this.lastData = Date.now();
    },

    update(rec) {
      const cur = this.targets.get(rec.hex);
      if (rec.altGeomFt !== null && rec.altBaroFt !== null && !rec.ground) {
        this.offsets.push({ d: rec.altGeomFt - rec.altBaroFt, alt: rec.altBaroFt, t: Date.now() });
        if (this.offsets.length > 600) this.offsets.splice(0, this.offsets.length - 600);
      }
      const sources = new Set(cur ? cur.sources : []);
      sources.add(rec.src);
      if (cur && cur.posTime >= rec.posTime) {
        cur.sources = sources;
        cur.lastHeard = Date.now();
        return;
      }
      rec.sources = sources;
      rec.firstSeen = cur ? cur.firstSeen : Date.now();
      rec.lastHeard = Date.now();
      // Keep last known values for fields a source may omit.
      if (cur) {
        if (rec.trk === null) rec.trk = cur.trk;
        if (rec.gsKt === null) rec.gsKt = cur.gsKt;
        if (!rec.flight) rec.flight = cur.flight;
        if (!rec.type) rec.type = cur.type;
        if (!rec.category) rec.category = cur.category;
        rec.mil = rec.mil || cur.mil;
      }
      this.targets.set(rec.hex, rec);
    },

    /** (GNSS - baro) offset in ft for a pressure altitude, learned from nearby traffic. */
    baroOffsetFt(altBaroFt) {
      const now = Date.now();
      this.offsets = this.offsets.filter((o) => now - o.t < 600000);
      let pool = this.offsets.filter((o) => Math.abs(o.alt - altBaroFt) < 3000);
      if (pool.length < 3) pool = this.offsets;
      if (pool.length < 3) return { ft: AC.settings.geoidM / U().FT, learned: false };
      const v = pool.map((o) => o.d).sort((a, b) => a - b);
      return { ft: v[Math.floor(v.length / 2)], learned: true };
    },

    health(now) {
      const okSources = Object.values(this.src).filter((s) => now - s.lastOk < 10000).length;
      return { okSources, fresh: now - this.lastData < 15000 };
    },

    /** Returns all valid targets dead-reckoned to `now`. */
    getTargets(now, own) {
      const S = AC.settings;
      const out = [];
      const ownHex = (S.ownHex || '').toLowerCase().trim();
      for (const [hex, r] of this.targets) {
        const age = (now - r.posTime) / 1000;
        if (age > 60) { this.targets.delete(hex); continue; }
        if (age > S.maxAgeS) continue;
        if (hex === ownHex || hex === this.autoOwnHex) continue;

        const gs = (r.gsKt || 0) * U().KT;
        const hasTrk = r.trk !== null;
        const p = hasTrk ? G().advance(r.lat, r.lon, r.trk, gs, r.trackRate, Math.max(0, age)) : { lat: r.lat, lon: r.lon, trk: 0 };

        let altFt = null, altEst = false, altUncFt = 50;
        if (r.altGeomFt !== null) {
          altFt = r.altGeomFt;
        } else if (r.altBaroFt !== null) {
          const o = this.baroOffsetFt(r.altBaroFt);
          altFt = r.altBaroFt + o.ft;
          altEst = true;
          altUncFt = o.learned ? 150 : 400;
        }
        if (altFt !== null) altFt += r.vsFpm * age / 60;

        const epu = (r.nacp !== null && NACP_EPU[r.nacp]) ? NACP_EPU[r.nacp] : (r.mlat ? 150 : r.tisb ? 250 : 300);
        const extrap = 2 * age + 0.5 * age * age + (hasTrk ? 0 : gs * age);
        const uncertM = Math.min(3000, epu + extrap);

        const t = {
          hex, rec: r,
          lat: p.lat, lon: p.lon, trk: p.trk,
          gs, vs: r.vsFpm * U().FPM, turn: hasTrk ? r.trackRate : 0,
          altFt, altEst, altUncFt,
          baroFt: r.altBaroFt !== null && !r.ground ? r.altBaroFt + r.vsFpm * age / 60 : null,   // pressure altitude
          age, uncertM, stale: age > 6,
          ground: r.ground,
          label: r.flight || r.reg || hex.toUpperCase(),
          src: r.src, sources: r.sources,
        };

        if (own && !S.simEnabled) this._checkOwnEcho(t, own);
        out.push(t);
      }
      return out;
    },

    /** Detects the own transponder in the data (same position, altitude and velocity). */
    _checkOwnEcho(t, own) {
      if (t.altFt === null || own.altHAE === null) return;
      const d = G().dist(own.lat, own.lon, t.lat, t.lon);
      const dAlt = Math.abs(t.altFt - own.altHAE / U().FT);
      const dGs = Math.abs(t.gs - own.gs);
      const dTrk = Math.abs(G().norm180(t.trk - own.trk));
      const c = this._ownCand;
      if (d < 300 && dAlt < 300 && dGs < 8 && (own.gs < 15 || dTrk < 20)) {
        c[t.hex] = (c[t.hex] || 0) + 1;
        if (c[t.hex] >= 6) this.autoOwnHex = t.hex;
      } else if (c[t.hex]) {
        c[t.hex] = 0;
      }
    },

    clear() { this.targets.clear(); this.offsets = []; this.autoOwnHex = ''; this._ownCand = {}; },
  };

  AC.Adsb = Adsb;
})(window.AC = window.AC || {});
