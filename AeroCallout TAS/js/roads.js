/*
 * AeroCallout - coarse road network for orientation on the car display (Android Auto).
 * Only major roads (motorway, trunk, primary) from OpenStreetMap via the Overpass API, no names or details.
 * Geometry is simplified and kept in local metres around a reference point; the native car screen turns it
 * into faint radar-style lines.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const CLASS = { motorway: 0, motorway_link: 0, trunk: 1, trunk_link: 1, primary: 2 };

  /** Short label for an aerodrome without ICAO code: drop generic words, keep the place name (max 12 chars). */
  function shortName(name) {
    const glider = /segelflug|glider|gliding/i.test(name);
    const rest = name.replace(/(Segelfluggelände|Segelfluggelande|Segelflugplatz|Sonderlandeplatz|Verkehrslandeplatz|Flugplatz|Flughafen|Landeplatz|Modellflugplatz|Airfield|Airport|Gliding\s*Site|Glider\s*Field|UL-?Gelände|Ultraleicht\w*)/gi, '')
      .replace(/[()]/g, ' ').trim().split(/[\s/-]+/).filter(Boolean)[0] || '';
    const s = rest.slice(0, 12);
    return glider ? (s ? s + ' ⛬' : 'GLD') : s;
  }

  /** Douglas-Peucker on a flat [x0,y0,x1,y1,...] array. */
  function simplify(p, tol) {
    const n = p.length / 2;
    if (n <= 2) return p;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / len;
        if (d > md) { md = d; mi = i; }
      }
      if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
    return out;
  }

  const Roads = {
    ref: null,          // {lat, lon} origin of the local coordinates
    ways: [],           // [{c: class, p: [x,y,...] metres east/north of ref}]
    ver: 0,
    status: 'IDLE',
    loadedRadius: 0,
    fetching: false,
    lastAttempt: 0,

    /** Keep road data around the position, for the needed radius (m). */
    update(own, needM) {
      if (this.fetching || !own) return;
      const R = Math.min(50000, Math.max(8000, needM));
      const moved = this.ref ? G().dist(this.ref.lat, this.ref.lon, own.lat, own.lon) : Infinity;
      if (this.ref && moved < this.loadedRadius * 0.35 && R <= this.loadedRadius * 1.3) return;
      if (Date.now() - this.lastAttempt < 60000) return;
      this.lastAttempt = Date.now();
      this._fetch(own.lat, own.lon, R);
    },

    async _fetch(lat, lon, R) {
      this.fetching = true;
      this.status = 'LOADING';
      const a = `(around:${Math.round(R)},${lat.toFixed(4)},${lon.toFixed(4)})`;
      const q = `[out:json][timeout:60];(way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary)$"]${a};` +
        `way["aeroway"="runway"]${a};nw["aeroway"~"^(aerodrome|airstrip)$"]${a};);out geom qt;`;
      for (const ep of ENDPOINTS) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 70000);
          const r = await fetch(ep, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(q),
          });
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          this._apply(j, lat, lon, R);
          this.status = 'OK';
          this.fetching = false;
          return;
        } catch (e) { this.err = e.message; }
      }
      this.status = 'ERR';
      this.fetching = false;
    },

    _apply(j, lat, lon, R) {
      const kLat = G().R * Math.PI / 180, kLon = kLat * Math.cos(G().toRad(lat));
      const tol = Math.max(15, R / 1500);
      const ways = [], airports = [];
      for (const el of (j.elements || [])) {
        const tags = el.tags || {};
        // aerodromes: a marker with the ICAO code (or a short name) at the centre of the area
        if (tags.aeroway === 'aerodrome' || tags.aeroway === 'airstrip') {
          let la = el.lat, lo = el.lon;
          if (la === undefined && el.geometry && el.geometry.length) {
            la = el.geometry.reduce((s, g) => s + g.lat, 0) / el.geometry.length;
            lo = el.geometry.reduce((s, g) => s + g.lon, 0) / el.geometry.length;
          }
          if (la === undefined) continue;
          const code = tags.icao || tags.iata || shortName(tags.name || '');
          const big = !!(tags.iata || (tags.icao && /^E[DT]D|^E[A-Z]{3}$/.test(tags.icao) && tags.aerodrome === 'international'));
          airports.push({ x: Math.round((lo - lon) * kLon), y: Math.round((la - lat) * kLat), code: code.toUpperCase(), big });
          continue;
        }
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        const c = tags.aeroway === 'runway' ? 3 : CLASS[tags.highway];
        if (c === undefined) continue;
        const p = [];
        for (const g of el.geometry) p.push(Math.round((g.lon - lon) * kLon), Math.round((g.lat - lat) * kLat));
        ways.push({ c, p: c === 3 ? p : simplify(p, tol) });
      }
      this.ref = { lat, lon };
      this.ways = ways;
      this.airports = airports;
      this.loadedRadius = R;
      this.ver++;
    },
  };

  AC.Roads = Roads;
})(window.AC = window.AC || {});
