/*
 * AeroCallout - terrain database (open "Terrarium" elevation tiles, AWS Open Data / Mapzen)
 * and Forward Looking Terrain Avoidance (FLTA) style alerting.
 * Tiles are cached with the Cache API, so a region can be pre-loaded before flight.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  const CACHE_NAME = 'ac-terrain-v1';
  const MAX_TILES = 500;
  const MAX_INFLIGHT = 6;

  const Terrain = {
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    tiles: new Map(),     // key -> {size, data} | {fail: time} | 'pending'
    queue: [],
    inflight: 0,
    loaded: 0,
    failed: 0,
    override: null,       // simulation: function(lat, lon) -> elevation (m MSL)
    _canvas: null,

    /** Terrain elevation in meters MSL (highest of the 4 surrounding samples), or null if unavailable. */
    elevation(lat, lon, z) {
      if (this.override) return this.override(lat, lon);
      z = z || 11;
      const p = G().tileXY(lat, lon, z);
      const n = 2 ** z;
      const tx = Math.min(n - 1, Math.max(0, Math.floor(p.x)));
      const ty = Math.min(n - 1, Math.max(0, Math.floor(p.y)));
      const key = `${z}/${tx}/${ty}`;
      const tile = this.tiles.get(key);
      if (!tile || tile === 'pending' || tile.fail) { this._request(key, tile); return null; }
      const s = tile.size;
      const px = (p.x - tx) * s - 0.5, py = (p.y - ty) * s - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const v = (x, y) => tile.data[Math.min(s - 1, Math.max(0, y)) * s + Math.min(s - 1, Math.max(0, x))];
      return Math.max(v(x0, y0), v(x0 + 1, y0), v(x0, y0 + 1), v(x0 + 1, y0 + 1));
    },

    /** Requests all tiles in a radius (m) around a position. */
    prefetch(lat, lon, radiusM, z) {
      if (this.override) return 0;
      z = z || 11;
      const nw = G().offset(lat, lon, -radiusM, radiusM);
      const se = G().offset(lat, lon, radiusM, -radiusM);
      const a = G().tileXY(nw.lat, nw.lon, z), b = G().tileXY(se.lat, se.lon, z);
      const n = 2 ** z;
      let count = 0;
      for (let y = Math.max(0, Math.floor(a.y)); y <= Math.min(n - 1, Math.floor(b.y)); y++) {
        let x = Math.floor(a.x);
        for (let i = 0; i < 80; i++) {
          const key = `${z}/${((x % n) + n) % n}/${y}`;
          this._request(key, this.tiles.get(key));
          count++;
          if (x === Math.floor(b.x)) break;
          x++;
        }
      }
      return count;
    },

    _request(key, tile) {
      if (tile === 'pending') return;
      if (tile && tile.fail && Date.now() - tile.fail < 30000) return;
      if (tile && tile.data) return;
      this.tiles.set(key, 'pending');
      this.queue.push(key);
      this._pump();
    },

    _pump() {
      while (this.inflight < MAX_INFLIGHT && this.queue.length) {
        const key = this.queue.shift();
        this.inflight++;
        this._load(key).then((tile) => {
          if (tile) { this.tiles.set(key, tile); this.loaded++; }
          else { this.tiles.set(key, { fail: Date.now() }); this.failed++; }
        }).finally(() => {
          this.inflight--;
          this._evict();
          this._pump();
        });
      }
    },

    _evict() {
      if (this.tiles.size <= MAX_TILES) return;
      for (const k of this.tiles.keys()) {
        if (this.tiles.size <= MAX_TILES * 0.8) break;
        if (this.tiles.get(k) !== 'pending') this.tiles.delete(k);
      }
    },

    async _load(key) {
      const [z, x, y] = key.split('/');
      const url = this.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      try {
        let resp = null;
        const cache = ('caches' in window) ? await caches.open(CACHE_NAME).catch(() => null) : null;
        if (cache) resp = await cache.match(url);
        if (!resp) {
          resp = await fetch(url, { mode: 'cors' });
          if (!resp.ok) return null;
          if (cache) cache.put(url, resp.clone()).catch(() => {});
        }
        const blob = await resp.blob();
        return await this._decode(blob);
      } catch (e) {
        return null;
      }
    },

    async _decode(blob) {
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const s = bmp.width;
      if (!this._canvas) this._canvas = document.createElement('canvas');
      const c = this._canvas;
      c.width = s; c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, s, bmp.height);
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, s, bmp.height).data;
      const data = new Float32Array(s * bmp.height);
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        data[i] = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
      }
      if (bmp.close) bmp.close();
      return { size: s, data };
    },

    async clearCache() {
      this.tiles.clear();
      if ('caches' in window) await caches.delete(CACHE_NAME);
    },

    /**
     * FLTA: projects the flight path (incl. turn rate and vertical speed) ahead and checks the clearance
     * against the highest terrain within ±lateral margin.
     * @returns {level: 'warning'|'caution'|null, tImpact, aglFt, available}
     */
    evaluate(own) {
      const S = AC.settings;
      const res = { level: null, tImpact: null, aglFt: null, available: false, groundFt: null };
      if (own.altMSL === null) return res;
      const gHere = this.elevation(own.lat, own.lon);
      if (gHere !== null) { res.aglFt = (own.altMSL - gHere) / U().FT; res.groundFt = gHere / U().FT; }
      const look = S.terrLookahead;
      const step = 2;
      const path = G().predictPath(own.gs, own.trk, own.vs, own.turnRate || 0, look, step);
      const cautionClr = S.terrCautionFt * U().FT;
      const warnClr = 15;  // m
      const warnTime = Math.min(30, look);
      let total = 0, missing = 0, tWarn = null, tCaut = null;
      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        const hdg = G().toRad(own.trk + (own.turnRate || 0) * p.t);
        const rx = Math.cos(hdg), ry = -Math.sin(hdg);
        const lateral = 100 + p.t * 2;
        let hi = null;
        for (const k of [-1, 0, 1]) {
          const c = G().offset(own.lat, own.lon, p.x + rx * lateral * k, p.y + ry * lateral * k);
          const e = this.elevation(c.lat, c.lon);
          total++;
          if (e === null) missing++;
          else hi = hi === null ? e : Math.max(hi, e);
        }
        if (hi === null) continue;
        const clr = own.altMSL + p.z - hi;
        if (tWarn === null && clr < warnClr) tWarn = p.t;
        if (tCaut === null && clr < cautionClr) tCaut = p.t;
      }
      res.available = gHere !== null && total > 0 && missing * 2 < total;
      if (tWarn !== null && tWarn <= warnTime) { res.level = 'warning'; res.tImpact = tWarn; }
      else if (tCaut !== null) { res.level = 'caution'; res.tImpact = tCaut; }
      return res;
    },
  };

  AC.Terrain = Terrain;
})(window.AC = window.AC || {});
