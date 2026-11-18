/*
 * AeroCallout - weather radar data.
 *  - Precipitation: RainViewer composite radar (observed, ~10 min update). Tile colours ("Universal Blue")
 *    are converted back to reflectivity (dBZ) with RainViewer's published colour table.
 *  - Thunderstorms: Open-Meteo current weather codes 95-99 on a grid around the aircraft (model-based).
 * Weather data is delayed by several minutes and is for strategic avoidance only.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  // RainViewer "Universal Blue" rain palette: dBZ -> RGB (from rainviewer_api_colors_table.csv)
  const PALETTE = {
    '-10': '636159', '-9': '66635a', '-8': '69665c', '-7': '6c685d', '-6': '6f6b5f', '-5': '726e61', '-4': '757062',
    '-3': '787364', '-2': '7c7565', '-1': '7f7867', '0': '827b69', '1': '857d6a', '2': '88806c', '3': '8b826d',
    '4': '8e856f', '5': '928871', '6': '9e9375', '7': 'aa9e79', '8': 'b6a97e', '9': 'c2b482', '10': 'cec087',
    '11': 'd2c48b', '12': 'd6c88f', '13': 'dacc93', '14': 'ded097', '15': '88ddee', '16': '6cd1eb', '17': '51c5e8',
    '18': '36bae5', '19': '1baee2', '20': '00a3e0', '21': '009ad5', '22': '0091ca', '23': '0088bf', '24': '007fb4',
    '25': '0077aa', '26': '0070a3', '27': '00699c', '28': '006295', '29': '005b8e', '30': '005588', '31': '005180',
    '32': '004e78', '33': '004a70', '34': '004768', '35': 'ffee00', '36': 'ffe000', '37': 'ffd200', '38': 'ffc500',
    '39': 'ffb700', '40': 'ffaa00', '41': 'ff9f00', '42': 'ff9500', '43': 'ff8b00', '44': 'ff8100', '45': 'ff4400',
    '46': 'f23600', '47': 'e62800', '48': 'd91b00', '49': 'cd0d00', '50': 'c10000', '51': 'a80000', '52': '8f0000',
    '53': '760000', '54': '5d0000', '55': 'ffaaff', '56': 'ff9fff', '57': 'ff95ff', '58': 'ff8bff', '59': 'ff81ff',
    '60': 'ff77ff', '61': 'ff6cff', '62': 'ff62ff', '63': 'ff58ff', '64': 'ff4eff', '65': 'ffffff',
  };
  const PAL = Object.entries(PALETTE).map(([d, h]) => ({ dbz: +d, r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }));
  const exact = new Map(PAL.map((p) => [(p.r << 16) | (p.g << 8) | p.b, p.dbz]));
  const nearCache = new Map();

  function rgbToDbz(r, g, b) {
    const k = (r << 16) | (g << 8) | b;
    let v = exact.get(k);
    if (v !== undefined) return v;
    v = nearCache.get(k);
    if (v !== undefined) return v;
    let best = null, bd = Infinity;
    for (const p of PAL) {
      const d = (p.r - r) ** 2 + (p.g - g) ** 2 + (p.b - b) ** 2;
      if (d < bd) { bd = d; best = p.dbz; }
    }
    if (bd > 1200) best = -128;
    nearCache.set(k, best);
    return best;
  }

  const Z = 7; // RainViewer free API: max zoom 7

  const Weather = {
    status: 'IDLE',
    err: '',
    host: '',
    frame: null,          // {time, path}
    tiles: new Map(),     // key -> Int8Array | 'pending' | {fail}
    thunder: [],          // [{lat, lon, code}]
    thunderStatus: 'IDLE',
    synthetic: [],        // [{lat, lon, r (m), peak (dBZ)}]
    syntheticThunder: [],
    _lastMeta: 0,
    _lastThunder: 0,
    _thunderCenter: null,
    _canvas: null,

    ageMin() { return this.frame ? Math.round((Date.now() / 1000 - this.frame.time) / 60) : null; },
    /** Age of the radar picture in seconds (time of the radar scan), null without data. */
    ageS() { return this.frame ? Math.max(0, Date.now() / 1000 - this.frame.time) : null; },

    /** @param rangeNM display range expressed in nautical miles */
    update(own, rangeNM) {
      const now = Date.now();
      if (now - this._lastMeta > 300000) { this._lastMeta = now; this._loadMeta(); }
      if (this.frame) this._prefetch(own.lat, own.lon, Math.min(rangeNM, 100) * U().NM * 1.2);
      if (AC.settings.wxThunder) {
        const moved = !this._thunderCenter || G().dist(this._thunderCenter.lat, this._thunderCenter.lon, own.lat, own.lon) > 20000;
        if (now - this._lastThunder > 600000 || (moved && now - this._lastThunder > 60000)) {
          this._lastThunder = now;
          this._loadThunder(own.lat, own.lon, Math.max(20, Math.min(rangeNM, 60)));
        }
      }
    },

    async _loadMeta() {
      try {
        this.status = this.frame ? this.status : 'LOADING';
        const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const past = j.radar && j.radar.past;
        if (!past || !past.length) throw new Error('keine Radardaten');
        const last = past[past.length - 1];
        if (!this.frame || this.frame.path !== last.path) {
          this.frame = last;
          this.host = j.host;
          this.tiles.clear();
        }
        this.status = 'OK';
        this.err = '';
      } catch (e) {
        this.status = 'ERR';
        this.err = e.message;
      }
    },

    _prefetch(lat, lon, radiusM) {
      const nw = G().offset(lat, lon, -radiusM, radiusM);
      const se = G().offset(lat, lon, radiusM, -radiusM);
      const a = G().tileXY(nw.lat, nw.lon, Z), b = G().tileXY(se.lat, se.lon, Z);
      for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
        for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) this._tile(x, y);
      }
    },

    _tile(x, y) {
      const n = 2 ** Z;
      x = ((x % n) + n) % n;
      if (y < 0 || y >= n || !this.frame) return null;
      const key = `${x}/${y}`;
      const t = this.tiles.get(key);
      if (t instanceof Int8Array) return t;
      if (t === 'pending' || (t && t.fail && Date.now() - t.fail < 60000)) return null;
      this.tiles.set(key, 'pending');
      const url = `${this.host}${this.frame.path}/256/${Z}/${x}/${y}/2/0_0.png`;
      this._loadTile(url).then((grid) => this.tiles.set(key, grid || { fail: Date.now() }));
      return null;
    },

    async _loadTile(url) {
      try {
        const r = await fetch(url, { mode: 'cors' });
        if (!r.ok) return null;
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        if (!this._canvas) this._canvas = document.createElement('canvas');
        const c = this._canvas;
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const grid = new Int8Array(c.width * c.height);
        for (let i = 0, j = 0; i < grid.length; i++, j += 4) {
          grid[i] = d[j + 3] < 8 ? -128 : rgbToDbz(d[j], d[j + 1], d[j + 2]);
        }
        if (bmp.close) bmp.close();
        return grid;
      } catch (e) {
        return null;
      }
    },

    /** Reflectivity (dBZ) at a position, or -128 if none / unknown. */
    dbz(lat, lon) {
      let v = -128;
      if (this.frame) {
        const p = G().tileXY(lat, lon, Z);
        const grid = this._tile(Math.floor(p.x), Math.floor(p.y));
        if (grid) {
          const px = Math.min(255, Math.floor((p.x - Math.floor(p.x)) * 256));
          const py = Math.min(255, Math.floor((p.y - Math.floor(p.y)) * 256));
          v = grid[py * 256 + px];
        }
      }
      for (const c of this.synthetic) {
        const d = G().dist(lat, lon, c.lat, c.lon);
        if (d < c.r) {
          // Convective cell: core with sharp gradient plus small-scale texture
          const n = Math.sin(lat * 9000) * Math.cos(lon * 7000) * 3;
          const s = c.peak - 38 * (d / c.r) ** 1.6 + n;
          if (s > v) v = s;
        }
      }
      return v;
    },

    allThunder() { return this.thunder.concat(this.syntheticThunder); },

    async _loadThunder(lat, lon, rangeNM) {
      const N = 5;
      const span = rangeNM * U().NM;
      const lats = [], lons = [];
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const p = G().offset(lat, lon, (j / (N - 1) - 0.5) * 2 * span, (i / (N - 1) - 0.5) * 2 * span);
          lats.push(p.lat.toFixed(3)); lons.push(p.lon.toFixed(3));
        }
      }
      try {
        this.thunderStatus = 'LOADING';
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=weather_code,precipitation`;
        const r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        let j = await r.json();
        if (!Array.isArray(j)) j = [j];
        this.thunder = j.filter((p) => p.current && p.current.weather_code >= 95)
          .map((p) => ({ lat: p.latitude, lon: p.longitude, code: p.current.weather_code }));
        this._thunderCenter = { lat, lon };
        this.thunderStatus = 'OK';
      } catch (e) {
        this.thunderStatus = 'ERR';
      }
    },
  };

  AC.Weather = Weather;
})(window.AC = window.AC || {});
