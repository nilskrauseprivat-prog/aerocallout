/*
 * AeroCallout - obstacles (masts, towers, wind turbines, power lines, cable cars) and aerodromes
 * from OpenStreetMap via the Overpass API, plus obstacle alerting along the predicted flight path.
 * Note: OSM is crowd-sourced and not an official obstacle database.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  // Load radius (m): adjustable, 10-60 km. Refetch when 40 % of it has been flown.
  const radius = () => Math.min(60000, Math.max(10000, (AC.settings.obsRadiusKm || 40) * 1000));

  function parseHeight(v) {
    if (!v) return null;
    const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    let h = parseFloat(m[0]);
    if (/ft|'/.test(v)) h *= U().FT;
    return h > 0 ? h : null;
  }

  function voltageHeight(v) {
    const kv = parseFloat(String(v || '').split(';')[0]) / 1000;
    if (kv >= 220) return 60;
    if (kv >= 110) return 45;
    return 25;
  }

  function classify(tags) {
    const mm = tags.man_made;
    const h = parseHeight(tags.height);
    if (tags['generator:source'] === 'wind') {
      const rotor = parseHeight(tags['rotor:diameter']);
      return { kind: 'wind', h: h ? h + (rotor ? rotor / 2 : 40) : 200 };
    }
    if (mm === 'communications_tower') return { kind: 'tower', h: h || 120 };
    if (mm === 'mast') return { kind: 'mast', h: h || 60 };
    if (mm === 'chimney') return { kind: 'chimney', h: h || 60 };
    if (mm === 'tower') return { kind: 'tower', h: h || 30 };
    if (mm === 'crane') return { kind: 'crane', h: h || 40 };
    if (tags.power === 'line') return { kind: 'line', h: h || voltageHeight(tags.voltage) };
    if (tags.aerialway) return { kind: 'cable', h: h || 40 };
    return null;
  }

  const Obstacles = {
    list: [],            // {id, kind, name, pts:[{lat,lon}], h (m AGL)}
    aerodromes: [],      // {id, name, lat, lon}
    synthetic: [],       // simulation obstacles
    status: 'IDLE',
    err: '',
    lastCenter: null,
    lastAttempt: 0,
    fetching: false,

    all() {
      // With simulated terrain only simulated obstacles make sense (real ones would sit on fake ground).
      if (AC.Terrain.override || !AC.settings.osmObstacles) return this.synthetic;
      return this.list.concat(this.synthetic);
    },

    update(own) {
      if (!AC.settings.osmObstacles || this.fetching) return;
      if (this.lastCenter && G().dist(this.lastCenter.lat, this.lastCenter.lon, own.lat, own.lon) < radius() * 0.4 && this.lastRadius === radius()) return;
      if (Date.now() - this.lastAttempt < 90000) return;
      this.lastAttempt = Date.now();
      this._fetch(own.lat, own.lon);
    },

    async _fetch(lat, lon) {
      this.fetching = true;
      this.status = 'LOADING';
      const R = radius();
      this.lastRadius = R;
      const a = `(around:${R},${lat.toFixed(4)},${lon.toFixed(4)})`;
      const q = `[out:json][timeout:90];(` +
        `node["man_made"~"^(mast|tower|chimney|communications_tower|crane)$"]${a};` +
        `node["power"="generator"]["generator:source"="wind"]${a};` +
        `way["power"="line"]${a};` +
        `way["aerialway"~"^(cable_car|gondola|chair_lift|mixed_lift|zip_line|goods)$"]${a};` +
        `nw["aeroway"~"^(aerodrome|airstrip|heliport)$"]${a};` +
        `);out geom;`;
      for (const ep of ENDPOINTS) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 100000);
          const r = await fetch(ep, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(q),
          });
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          this._apply(j, lat, lon);
          this.lastCenter = { lat, lon };
          this.status = 'OK';
          this.err = '';
          this.fetching = false;
          this._saveCache(j, lat, lon);
          return;
        } catch (e) {
          this.err = e.name === 'AbortError' ? 'Timeout' : (/^HTTP 50/.test(e.message) ? e.message + ' (Server ausgelastet)' : e.message);
        }
      }
      // Server unavailable: fall back to the last stored data set if it covers this area.
      const cached = await this._loadCache();
      if (cached && G().dist(cached.lat, cached.lon, lat, lon) < radius() * 0.75) {
        this._apply(cached.json, cached.lat, cached.lon);
        this.lastCenter = { lat: cached.lat, lon: cached.lon };
        this.status = 'CACHE';
      } else {
        this.status = 'ERR';
      }
      this.fetching = false;
    },

    async _saveCache(json, lat, lon) {
      try {
        if (!('caches' in window)) return;
        const c = await caches.open('ac-obstacles-v1');
        await c.put('/__obstacles_latest', new Response(JSON.stringify({ lat, lon, t: Date.now(), json })));
      } catch (e) { /* ignore */ }
    },

    async _loadCache() {
      try {
        if (!('caches' in window)) return null;
        const c = await caches.open('ac-obstacles-v1');
        const r = await c.match('/__obstacles_latest');
        return r ? await r.json() : null;
      } catch (e) { return null; }
    },

    _apply(j, lat0, lon0) {
      const obs = [], aero = [];
      for (const el of j.elements || []) {
        const tags = el.tags || {};
        if (tags.aeroway) {
          let la = el.lat, lo = el.lon;
          if (el.geometry && el.geometry.length) {
            la = el.geometry.reduce((s, p) => s + p.lat, 0) / el.geometry.length;
            lo = el.geometry.reduce((s, p) => s + p.lon, 0) / el.geometry.length;
          }
          if (typeof la === 'number') aero.push({ id: el.type + el.id, name: tags.icao || tags.name || '', lat: la, lon: lo });
          continue;
        }
        const c = classify(tags);
        if (!c) continue;
        if (el.type === 'node') {
          obs.push({ id: 'n' + el.id, kind: c.kind, name: tags.name || '', pts: [{ lat: el.lat, lon: el.lon }], h: c.h });
        } else if (el.geometry && el.geometry.length >= 2) {
          for (let i = 0; i < el.geometry.length - 1; i++) {
            const p = el.geometry[i], q = el.geometry[i + 1];
            if (!p || !q) continue;
            if (G().dist(lat0, lon0, p.lat, p.lon) > radius() * 1.6 && G().dist(lat0, lon0, q.lat, q.lon) > radius() * 1.6) continue;
            obs.push({ id: `w${el.id}-${i}`, kind: c.kind, name: tags.name || '', pts: [p, q], h: c.h });
          }
        }
      }
      this.list = obs;
      this.aerodromes = aero;
    },

    nearAerodrome(lat, lon, m) {
      return this.aerodromes.some((a) => G().dist(lat, lon, a.lat, a.lon) < m);
    },

    /**
     * Checks the predicted path against obstacles. Cable/line tops are interpolated between the supports.
     * @returns array of {id, level: 'warning'|'caution', t, relBrg, clock, obs, d}
     */
    evaluate(own) {
      const out = [];
      if (own.altMSL === null) return out;
      const look = 45, warnT = 20, cautT = 40;
      const warnH = 150, warnV = 60, cautH = 300, cautV = 120;
      const path = G().predictPath(own.gs, own.trk, own.vs, own.turnRate || 0, look, 1);
      const reach = own.gs * look + cautH + 300;
      for (const o of this.all()) {
        const pts = o.pts.map((p) => G().enu(own.lat, own.lon, p.lat, p.lon));
        const near = nearest(0, 0, pts);
        if (near.d > reach) continue;
        const tops = o.pts.map((p) => {
          const g = AC.Terrain.elevation(p.lat, p.lon);
          return g === null ? null : g + o.h;
        });
        if (tops.some((v) => v === null)) continue;
        let level = null, when = null;
        for (const p of path) {
          if (p.t > cautT) break;
          const n = nearest(p.x, p.y, pts);
          const top = pts.length === 1 ? tops[0] : tops[n.i] + (tops[n.i + 1] - tops[n.i]) * n.f;
          const clr = own.altMSL + p.z - top;
          if (p.t <= warnT && n.d <= warnH && clr <= warnV) { level = 'warning'; when = p.t; break; }
          if (!level && n.d <= cautH && clr <= cautV) { level = 'caution'; when = p.t; }
        }
        if (!level) continue;
        const brg = G().bearingOf(near.x, near.y);
        const relBrg = G().norm180(brg - own.trk);
        out.push({ id: 'obs-' + o.id, level, t: when, relBrg, clock: G().clock(relBrg), obs: o, d: near.d });
      }
      out.sort((a, b) => (a.level === b.level ? a.t - b.t : a.level === 'warning' ? -1 : 1));
      return out;
    },
  };

  function nearest(px, py, pts) {
    if (pts.length === 1) return { d: Math.hypot(px - pts[0].x, py - pts[0].y), x: pts[0].x, y: pts[0].y, i: 0, f: 0 };
    let best = { d: Infinity };
    for (let i = 0; i < pts.length - 1; i++) {
      const c = G().segClosest(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (c.d < best.d) best = { d: c.d, x: c.x, y: c.y, i, f: c.f };
    }
    return best;
  }

  AC.Obstacles = Obstacles;
})(window.AC = window.AC || {});
