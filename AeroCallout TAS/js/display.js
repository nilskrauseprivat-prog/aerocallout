/*
 * AeroCallout - cockpit display: TCAS-style traffic display (TA only, no resolution advisories)
 * with weather radar (WX) or terrain (TERR) underlay, in 360° or expanded ARC format.
 * Symbology follows TCAS conventions:
 *   ◇ other traffic, ◆ proximate traffic, ● traffic advisory (amber), ■ imminent conflict (red),
 *   data tag = relative altitude in hundreds of feet (+ above / - below), arrow = climbing/descending ≥ 500 fpm.
 */
(function (AC) {
  'use strict';
  const G = () => AC.Geo;
  const U = () => AC.U;

  const COL = {
    cyan: '#00e5ff', white: '#eef2f5', amber: '#ffb000', red: '#ff2b2b', green: '#2bff4a',
    magenta: '#ff4dff', grey: '#8a919c', dim: '#4a515c', yellow: '#ffff3a', orange: '#ff8a1a', black: '#000',
  };
  const FONT = '"Consolas","Lucida Console","Menlo","DejaVu Sans Mono",monospace';
  const WX_LEVELS = [
    { min: 50, rgb: [255, 0, 255] },
    { min: 40, rgb: [255, 0, 0] },
    { min: 30, rgb: [255, 255, 0] },
    { min: 20, rgb: [0, 205, 0] },
  ];

  const D = {
    COL, FONT,
    c: null, g: null, W: 0, H: 0, dpr: 1,
    wx: { a: null, b: null, angle: -60, dir: 1, passStart: -60, lastT: 0, ahead: false, maxDbz: -128 },
    terr: { img: null, last: 0 },
    terrPopup: false,
    flash: false,

    init(canvas) {
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.resize();
      if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(canvas);
      window.addEventListener('resize', () => this.resize());
    },

    resize() {
      const r = this.c.getBoundingClientRect();
      // Internal resolution at most 2x: on high-density phones (2.75x) this halves the pixel work per frame
      // with no visible loss, and keeps the display fluid even when the phone throttles (heat).
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.W = Math.max(200, r.width);
      this.H = Math.max(200, r.height);
      this.c.width = Math.round(this.W * this.dpr);
      this.c.height = Math.round(this.H * this.dpr);
      this.wx.a = this.wx.b = null;
      this.terr.img = null;
    },

    geom() {
      const S = AC.settings;
      const W = this.W, H = this.H;
      let cx, cy, R;
      if (S.mode === 'arc') { cx = W / 2; cy = H * 0.84; R = Math.min(H * 0.70, W * 0.55); }
      else if (W > H * 1.25) { cx = W / 2; cy = H * 0.53; R = Math.min(H * 0.43, W * 0.36); }   // wide display (phone sideways)
      else { cx = W / 2; cy = H * 0.515; R = Math.min(W * 0.46, H * 0.40); }   // tall display (phone): wider radar
      return { cx, cy, R, k: R / AC.Fmt.rangeM(), arc: S.mode === 'arc', u: Math.min(W, H) / 500 };
    },

    project(geo, trk, x, y) {
      const t = G().toRad(trk), c = Math.cos(t), s = Math.sin(t);
      const sx = x * c - y * s, sy = x * s + y * c;
      return { px: geo.cx + sx * geo.k, py: geo.cy - sy * geo.k };
    },

    /**
     * Smooth motion between the 2 Hz logic cycles: per display frame the ownship position is advanced along its
     * track, traffic is advanced with its relative velocity and the track/heading is predicted with the turn rate
     * and low-pass filtered. Only the picture uses this - alerts are computed in the logic cycle as before.
     */
    view(st) {
      const own = st.own;
      const nowMs = Date.now();
      const tf = performance.now();
      const dtF = this._vT ? Math.min(0.25, (tf - this._vT) / 1000) : 0;
      this._vT = tf;
      if (!own) { this._vHdg = null; return { own: null, items: null }; }
      const A = AC.Ahrs, sim = AC.settings.simEnabled;
      const dtO = Math.max(0, Math.min(1.5, (nowMs - (own.t || st.tickAt || nowMs)) / 1000));
      const dtT = Math.max(0, Math.min(1.5, (nowMs - (st.tickAt || nowMs)) / 1000));

      // turn rate (deg/s): phone gyro (earth frame), simulator, or from successive GPS tracks
      if (own.t && own.t !== this._vFixT) {
        if (this._vFixT && own.gs > 3 && this._vFixTrk != null) {
          const dts = (own.t - this._vFixT) / 1000;
          if (dts > 0.2 && dts < 3) {
            const r = G().norm180(own.trk - this._vFixTrk) / dts;
            this._vRate = this._vRate == null ? r : this._vRate * 0.5 + r * 0.5;
          }
        }
        this._vFixT = own.t; this._vFixTrk = own.trk;
      }
      let target;
      const ahrsOk = !sim && A.ready && A.ready();
      if (ahrsOk && own.gs < 3) {
        // standing / taxiing: rose follows the phone heading (gyro-smooth between sensor samples)
        const dtI = A.lastImu ? Math.max(0, Math.min(0.2, (nowMs - A.lastImu) / 1000)) : 0;
        target = A.heading + (A.turnRate || 0) * dtI;
      } else {
        const rate = sim ? (own.turnRate || 0) : ahrsOk ? (A.turnRate || 0) : (this._vRate || 0);
        target = own.trk + Math.max(-10, Math.min(10, rate)) * dtO;
      }
      target = G().norm360(target);
      if (this._vHdg == null || Math.abs(G().norm180(target - this._vHdg)) > 60) this._vHdg = target;
      else this._vHdg = G().norm360(this._vHdg + G().norm180(target - this._vHdg) * (1 - Math.exp(-dtF / 0.12)));

      // ownship position advanced along the track
      const tr = G().toRad(own.trk), d = (own.gs || 0) * dtO;
      const p = d > 0.5 ? G().offset(own.lat, own.lon, Math.sin(tr) * d, Math.cos(tr) * d) : own;
      const vOwn = Object.assign({}, own, { lat: p.lat, lon: p.lon, trk: this._vHdg });

      // traffic: relative position advanced with target velocity minus own velocity
      let items = null;
      if (st.tfc && st.tfc.items) {
        const ovx = Math.sin(tr) * (own.gs || 0), ovy = Math.cos(tr) * (own.gs || 0);
        items = st.tfc.items.map((it) => {
          const t = it.t, gs = t && !t.ground && !t.stale ? (t.gs || 0) : 0;
          const ta = G().toRad((t && t.trk) || 0);
          const x = it.x + Math.sin(ta) * gs * dtT - ovx * dtO;
          const y = it.y + Math.cos(ta) * gs * dtT - ovy * dtO;
          return Object.assign({}, it, { x, y });
        });
      }
      return { own: vOwn, items };
    },

    /** Font scale for info texts (setting 'Schriftgröße'). */
    fk() { return AC.settings.fontScale || 1; },

    // ---------------------------------------------------------------- primitives
    /**
     * Text with a dark outline ("halo"), so it stays readable on weather / terrain colours and over symbols.
     * Black text (on filled boxes) is drawn without halo.
     */
    text(str, x, y, color, size, align, base, bold) {
      const g = this.g;
      g.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
      g.textAlign = align || 'left';
      g.textBaseline = base || 'alphabetic';
      if (color !== '#000') {
        g.save();
        g.strokeStyle = 'rgba(0,0,0,0.9)';
        g.lineWidth = Math.max(2.5, size * 0.32);
        g.lineJoin = 'round';
        g.miterLimit = 2;
        g.strokeText(str, x, y);
        g.restore();
      }
      g.fillStyle = color;
      g.fillText(str, x, y);
    },

    box(str, x, y, color, size, filled, align) {
      const g = this.g;
      g.font = `bold ${size}px ${FONT}`;
      const w = g.measureText(str).width + size * 0.7, h = size * 1.35;
      const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      if (filled) { g.fillStyle = color; g.fillRect(x0, y, w, h); }
      else {
        g.fillStyle = 'rgba(0,0,0,0.72)';      // dark backing so outlined boxes stay readable on any background
        g.fillRect(x0, y, w, h);
        g.strokeStyle = color; g.lineWidth = 1.5; g.strokeRect(x0, y, w, h);
      }
      this.text(str, x0 + w / 2, y + h / 2 + 1, filled ? '#000' : color, size, 'center', 'middle', true);
      return h;
    },

    symbol(kind, x, y, s, color, alpha) {
      const g = this.g;
      g.save();
      g.globalAlpha = alpha === undefined ? 1 : alpha;
      g.fillStyle = color; g.strokeStyle = color; g.lineWidth = Math.max(1.5, s * 0.18);
      g.beginPath();
      if (kind === 'other' || kind === 'prox') {
        g.moveTo(x, y - s); g.lineTo(x + s * 0.75, y); g.lineTo(x, y + s); g.lineTo(x - s * 0.75, y); g.closePath();
        if (kind === 'prox') g.fill(); else g.stroke();
      } else if (kind === 'ta') {
        g.arc(x, y, s * 0.78, 0, Math.PI * 2); g.fill();
      } else if (kind === 'warn') {
        g.rect(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6); g.fill();
      }
      g.restore();
    },

    dataTag(relAltFt, vsFpm, x, y, s, color, alpha) {
      if (relAltFt === null || relAltFt === undefined) return;
      const g = this.g;
      g.save();
      g.globalAlpha = alpha === undefined ? 1 : alpha;
      // TCAS convention: hundreds of feet. Metric: tens of metres.
      const h = AC.settings.altUnit === 'm' ? Math.round(Math.abs(relAltFt) * U().FT / 10) : Math.round(Math.abs(relAltFt) / 100);
      const tag = (relAltFt >= 0 ? '+' : '-') + String(Math.min(h, 99)).padStart(2, '0');
      const above = relAltFt >= 0;
      const fs = Math.round(s * 1.25 * this.fk());
      this.text(tag, x, above ? y - s - 3 : y + s + fs, color, fs, 'center', 'alphabetic', true);
      if (Math.abs(vsFpm) >= 500) {
        const ax = x + s * 1.35, up = vsFpm > 0;
        g.strokeStyle = color; g.fillStyle = color; g.lineWidth = Math.max(1.5, s * 0.18);
        g.beginPath(); g.moveTo(ax, y + (up ? s : -s)); g.lineTo(ax, y + (up ? -s : s)); g.stroke();
        g.beginPath();
        const tip = y + (up ? -s - 2 : s + 2);
        g.moveTo(ax, tip); g.lineTo(ax - s * 0.4, tip + (up ? s * 0.6 : -s * 0.6)); g.lineTo(ax + s * 0.4, tip + (up ? s * 0.6 : -s * 0.6));
        g.closePath(); g.fill();
      }
      g.restore();
    },

    ownship(geo, color) {
      const g = this.g, u = geo.u * 1.1;
      g.save();
      g.translate(geo.cx, geo.cy);
      g.fillStyle = color || COL.white;
      g.beginPath();
      g.moveTo(0, -12 * u); g.lineTo(2 * u, -4 * u); g.lineTo(11 * u, 1 * u); g.lineTo(11 * u, 3 * u); g.lineTo(2 * u, 1 * u);
      g.lineTo(1.5 * u, 7 * u); g.lineTo(4.5 * u, 10 * u); g.lineTo(4.5 * u, 11.5 * u); g.lineTo(0, 10.5 * u);
      g.lineTo(-4.5 * u, 11.5 * u); g.lineTo(-4.5 * u, 10 * u); g.lineTo(-1.5 * u, 7 * u); g.lineTo(-2 * u, 1 * u);
      g.lineTo(-11 * u, 3 * u); g.lineTo(-11 * u, 1 * u); g.lineTo(-2 * u, -4 * u); g.closePath();
      g.fill();
      g.restore();
    },

    /** Cached north-up compass ring (circle, 5° ticks, labels) in device pixels. */
    roseRing(geo) {
      const u = geo.u, R = geo.R, dpr = this.dpr, fs = Math.round(13 * u * this.fk());
      const key = `${R.toFixed(2)}|${u.toFixed(4)}|${fs}|${dpr}`;
      if (this._ring && this._ring.key === key) return this._ring;
      const half = R + 6 * u;
      const cv = document.createElement('canvas');
      cv.width = cv.height = Math.ceil(half * 2 * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, half * dpr, half * dpr);   // origin = rose centre, units = CSS px
      g.strokeStyle = COL.white; g.lineWidth = 1.4;
      g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.stroke();
      const mainG = this.g; this.g = g;               // reuse text() with halo on the cache canvas
      for (let h = 0; h < 360; h += 5) {
        const a = G().toRad(h);
        const len = h % 10 === 0 ? 9 * u : 5 * u;
        g.beginPath();
        g.moveTo(Math.sin(a) * R, -Math.cos(a) * R);
        g.lineTo(Math.sin(a) * (R - len), -Math.cos(a) * (R - len));
        g.stroke();
        if (h % 30 === 0) {
          const lbl = h === 0 ? 'N' : h === 90 ? 'E' : h === 180 ? 'S' : h === 270 ? 'W' : String(h / 10);
          const lr = R - 20 * u;
          g.save();
          g.translate(Math.sin(a) * lr, -Math.cos(a) * lr);
          g.rotate(a);
          this.text(lbl, 0, 0, COL.white, fs, 'center', 'middle', true);
          g.restore();
          g.strokeStyle = COL.white; g.lineWidth = 1.4;
        }
      }
      this.g = mainG;
      this._ring = { key, cv, half };
      return this._ring;
    },

    /** Compass rose / arc with range rings. */
    rose(geo, trk) {
      const g = this.g, u = geo.u, S = AC.settings;
      const { cx, cy, R } = geo;
      g.save();
      const a0 = geo.arc ? -60 : -180, a1 = geo.arc ? 60 : 180;
      // The scale ring (ticks + labels) is drawn once into a cached picture and only rotated per frame.
      const ring = this.roseRing(geo);
      g.save();
      if (geo.arc) {
        g.beginPath(); g.moveTo(cx, cy);
        g.arc(cx, cy, R + 4 * u, G().toRad(a0 - 90), G().toRad(a1 - 90)); g.closePath(); g.clip();
      }
      g.translate(cx, cy);
      g.rotate(G().toRad(-trk));
      g.drawImage(ring.cv, -ring.half, -ring.half, ring.half * 2, ring.half * 2);
      g.restore();
      // half-range ring: 12 dots (TCAS style)
      g.fillStyle = COL.white;
      const rh = R / 2;
      for (let i = 0; i < 12; i++) {
        const a = i * 30;
        if (geo.arc && Math.abs(G().norm180(a)) > 60) continue;
        const ar = G().toRad(a);
        g.beginPath(); g.arc(cx + Math.sin(ar) * rh, cy - Math.cos(ar) * rh, 1.8 * u, 0, Math.PI * 2); g.fill();
      }
      if (geo.arc) {
        g.setLineDash([4 * u, 6 * u]); g.strokeStyle = COL.dim;
        g.beginPath(); g.arc(cx, cy, rh, G().toRad(-150), G().toRad(-30)); g.stroke();
        g.setLineDash([]);
      }
      // range labels
      const half = AC.Fmt.rangeVal() / 2;
      this.text(String(half), cx - rh * 0.72 - 4 * u, cy - rh * 0.72, COL.cyan, Math.round(12 * u * this.fk()), 'right', 'middle');
      // heading pointer and box
      g.fillStyle = COL.white;
      g.beginPath(); g.moveTo(cx, cy - R + 1); g.lineTo(cx - 6 * u, cy - R - 9 * u); g.lineTo(cx + 6 * u, cy - R - 9 * u); g.closePath(); g.fill();
      const box = `TRK ${String(Math.round(G().norm360(trk)) % 360).padStart(3, '0')}°`;
      const hb = Math.round(14 * u * this.fk());
      g.font = `bold ${hb}px ${FONT}`;
      const bw = g.measureText(box).width + 12 * u;
      const bh = hb * 1.45, by = cy - R - 12 * u - bh;
      this._trkBox = { x: cx - bw / 2, y: by, w: bw, h: bh };
      g.fillStyle = '#000'; g.fillRect(cx - bw / 2, by, bw, bh);
      g.strokeStyle = COL.white; g.lineWidth = 1.2; g.strokeRect(cx - bw / 2, by, bw, bh);
      this.text(box, cx, by + bh / 2 + 1, COL.green, hb, 'center', 'middle', true);
      g.restore();
    },

    // ---------------------------------------------------------------- underlays
    /**
     * Overlay pictures are computed incrementally: a job works through the rows within a small time budget per
     * display frame, so computing a new weather / terrain picture never makes the display stutter.
     */
    /**
     * Geometry of a square overlay picture centred on the ownship that covers the whole display at ANY heading
     * (side = twice the distance to the farthest display corner). Turning then only rotates the picture -
     * no uncovered corners, no waiting for a new picture.
     */
    sq(geo) {
      const far = Math.max(Math.hypot(geo.cx, geo.cy), Math.hypot(this.W - geo.cx, geo.cy),
        Math.hypot(geo.cx, this.H - geo.cy), Math.hypot(this.W - geo.cx, this.H - geo.cy));
      const size = Math.ceil(far * 2.06);
      return Object.assign({}, geo, { cx: size / 2, cy: size / 2, size });
    },

    makeJob(kind, own, geo) {
      const W = geo.size || Math.ceil(this.W), H = geo.size || Math.ceil(this.H);
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const job = { kind, cv, g, W, H, py: 0, done: false, own: Object.assign({}, own), geo: Object.assign({}, geo) };
      job.B = kind === 'wx' ? 2 : 4;
      if (kind === 'wx') job.img = g.createImageData(W, H);
      else {
        // terrain: colour cells only (1 pixel per 4x4 cell), dense and sparse class separately; the EGPWS dot
        // pattern is applied later in screen space, so it never rotates or shimmers (no moire).
        cv.width = Math.ceil(W / job.B); cv.height = Math.ceil(H / job.B);
        const sp = document.createElement('canvas');
        sp.width = cv.width; sp.height = cv.height;
        cv.sparse = sp; cv.cssW = W; cv.cssH = H; cv.cellB = job.B;
        job.dImg = g.createImageData(cv.width, cv.height);
        job.sImg = sp.getContext('2d').createImageData(cv.width, cv.height);
        job.finish = () => { cv.paths = this.terrPaths(job.dImg, job.sImg, cv.width, cv.height, job.B); };
      }
      job.row = kind === 'wx' ? this.wxRows(job) : this.terrRows(job);
      cv.pose = { lat: own.lat, lon: own.lon, trk: own.trk, alt: own.altMSL || 0, k: geo.k, cx: geo.cx, cy: geo.cy };
      return job;
    },

    /** Work on a job for at most budgetMs (Infinity = finish now). Returns true when the picture is complete. */
    stepJob(job, budgetMs) {
      if (job.done) return true;
      const t0 = performance.now();
      while (job.py < job.H) {
        job.row(job.py);
        job.py += job.B;
        if (performance.now() - t0 > budgetMs) break;
      }
      if (job.py >= job.H) {
        if (job.img) job.g.putImageData(job.img, 0, 0);
        if (job.finish) job.finish();
        job.done = true;
      }
      return job.done;
    },

    renderWx(own, geo) { const j = this.makeJob('wx', own, geo); this.stepJob(j, Infinity); return j.cv; },
    renderTerr(own, geo) { const j = this.makeJob('terr', own, geo); this.stepJob(j, Infinity); return j.cv; },

    wxRows(job) {
      const { W, H, B, own, geo } = job;
      const d = job.img.data;
      const S = AC.settings;
      const t = G().toRad(own.trk), c = Math.cos(t), s = Math.sin(t);
      const sector = geo.arc || S.wxSector === 'arc';
      let ahead = false, maxDbz = -128;
      job.finish = () => { this.wx.ahead = ahead; this.wx.maxDbz = maxDbz; };
      return (py) => {
        for (let px = 0; px < W; px += B) {
          const dx = (px + B / 2 - geo.cx) / geo.k, dy = (geo.cy - (py + B / 2)) / geo.k;
          const rr = Math.hypot(dx, dy);
          const ang = G().toDeg(Math.atan2(dx, dy));
          if (sector && Math.abs(ang) > 60) continue;
          const p = G().offset(own.lat, own.lon, dx * c + dy * s, -dx * s + dy * c);
          const z = AC.Weather.dbz(p.lat, p.lon);
          if (z <= -100) continue;
          if (z > maxDbz) maxDbz = z;
          const zg = z + S.wxGain;
          const lvl = WX_LEVELS.find((l) => zg >= l.min);
          if (!lvl) continue;
          if (z >= 40 && rr < 15 * U().NM && Math.abs(ang) < 25) ahead = true;
          for (let yy = py; yy < Math.min(H, py + B); yy++) {
            for (let xx = px; xx < Math.min(W, px + B); xx++) {
              const i = (yy * W + xx) * 4;
              d[i] = lvl.rgb[0]; d[i + 1] = lvl.rgb[1]; d[i + 2] = lvl.rgb[2]; d[i + 3] = 235;
            }
          }
        }
      };
    },

    /**
     * An overlay picture was computed for the position / track at that moment. Before drawing it, transform it
     * to the CURRENT position and track, so weather and terrain never appear shifted or rotated
     * (the sweep keeps a picture for up to 8 s; in a standard-rate turn that would be 24 degrees).
     */
    applyPose(ctx, img, own, geo) {
      const p = img.pose;
      if (!p) return;
      const e = G().enu(own.lat, own.lon, p.lat, p.lon);          // old own position seen from the current one
      const s = this.project(geo, own.trk, e.x, e.y);              // ...on today's screen
      ctx.translate(s.px, s.py);
      ctx.rotate(G().toRad(p.trk - own.trk));
      if (p.k && Math.abs(geo.k / p.k - 1) > 1e-6) ctx.scale(geo.k / p.k, geo.k / p.k);
      ctx.translate(-p.cx, -p.cy);
    },

    drawWx(own, geo, now, alpha) {
      const S = AC.settings, g = this.g, w = this.wx;
      const sector = geo.arc || S.wxSector === 'arc';
      const lo = sector ? -60 : 0, hi = sector ? 60 : 360;
      const speed = sector ? 30 : 90; // deg/s
      const dt = w.lastT ? Math.min(0.2, (now - w.lastT) / 1000) : 0;
      w.lastT = now;
      const q = this.sq(geo);   // square picture: covers the display at any heading
      if (!w.a) {
        const k = w.keep;
        if (k && k.width === q.size && k.height === q.size) {
          // range / setting changed: keep showing the last picture (pose-corrected, also scaled) until the new one is ready
          w.a = w.b = k; w.swapAsap = true;
        } else {
          w.a = w.b = this.renderWx(own, q); w.swapAsap = false;
        }
        w.job = this.makeJob('wx', own, q);
        if (w.angle === undefined || w.angle < lo || w.angle > hi) { w.angle = lo; w.dir = 1; }
        w.passStart = w.angle;
      }
      // The next picture is computed in the background while the current pass runs: a small time slice per
      // frame, a bigger one if the work falls behind the sweep (so it is ready in time, without a hitch).
      if (w.job) {
        const passFrac = Math.min(1, Math.abs(w.angle - w.passStart) / (hi - lo));
        const budget = w.swapAsap ? 4 : (w.job.py / w.job.H < passFrac + 0.2 ? 3 : 1);
        if (this.stepJob(w.job, budget) && w.swapAsap) {
          w.a = w.b = w.keep = w.job.cv; w.swapAsap = false; w.passStart = w.angle;
          w.job = this.makeJob('wx', own, q);
        }
      }
      w.angle += w.dir * speed * dt;
      let wrapped = false;
      if (sector) {
        if (w.angle > hi) { w.angle = hi; w.dir = -1; wrapped = true; }
        else if (w.angle < lo) { w.angle = lo; w.dir = 1; wrapped = true; }
      } else if (w.angle >= hi) { w.angle -= 360; wrapped = true; }
      if (wrapped) {
        this.stepJob(w.job, Infinity);          // normally already complete
        w.a = w.b; w.b = w.keep = w.job.cv; w.passStart = w.angle;
        w.job = this.makeJob('wx', own, q);
      }

      // Compose: previous picture outside, the fresh picture inside the area already swept in this pass.
      // (No sweep line - only the picture updates.) Both are drawn straight onto the display in disjoint
      // regions, so a semi-transparent weather picture over the terrain looks the same as before.
      const from = Math.min(w.passStart, w.angle), to = Math.max(w.passStart, w.angle);
      const al = alpha === undefined ? 1 : alpha;
      const far = Math.hypot(this.W, this.H) * 2;
      const wedge = (ctx) => {
        ctx.moveTo(geo.cx, geo.cy);
        ctx.arc(geo.cx, geo.cy, far, G().toRad(from - 90), G().toRad(to - 90));
        ctx.closePath();
      };
      const swept = to - from > 0.5 && w.b !== w.a;
      g.save();
      g.globalAlpha = al;
      if (swept && al < 1) {   // old picture: everything except the swept wedge (opaque: simply overdrawn)
        g.beginPath(); g.rect(0, 0, this.W, this.H); wedge(g); g.clip('evenodd');
      }
      this.applyPose(g, w.a, own, geo); g.drawImage(w.a, 0, 0);
      g.restore();
      if (swept) {
        g.save();
        g.globalAlpha = al;
        g.beginPath(); wedge(g); g.clip();
        this.applyPose(g, w.b, own, geo); g.drawImage(w.b, 0, 0);
        g.restore();
      }
    },

    terrRows(job) {
      const { W, B, own, geo } = job;
      const dd = job.dImg.data, sd = job.sImg.data, cw = job.cv.width;
      const rn = AC.Fmt.rangeNMeq() * this.extent();
      // (terrain zoom level follows the displayed range, including auto-range)
      const z = rn <= 10 ? 11 : rn <= 20 ? 10 : rn <= 40 ? 9 : 8;
      const t = G().toRad(own.trk), c = Math.cos(t), s = Math.sin(t);
      const ownFt = (own.altMSL || 0) / U().FT;
      return (py) => {
        for (let px = 0; px < W; px += B) {
          const dx = (px + B / 2 - geo.cx) / geo.k, dy = (geo.cy - (py + B / 2)) / geo.k;
          if (geo.arc && Math.abs(G().toDeg(Math.atan2(dx, dy))) > 60) continue;
          const p = G().offset(own.lat, own.lon, dx * c + dy * s, -dx * s + dy * c);
          const e = AC.Terrain.elevation(p.lat, p.lon, z);
          if (e === null) { job.cv.pose.incomplete = true; continue; }   // tile still loading: redo soon
          const diff = e / U().FT - ownFt;
          let rgb = null, dense = false;
          if (diff > 2000) { rgb = [255, 0, 0]; dense = true; }
          else if (diff > 1000) { rgb = [255, 255, 0]; dense = true; }
          else if (diff > -500) { rgb = [255, 255, 0]; }
          else if (diff > -1000) { rgb = [0, 200, 0]; dense = true; }
          else if (diff > -2000) { rgb = [0, 200, 0]; }
          if (!rgb) continue;
          const d = dense ? dd : sd;
          const i = ((py / B) * cw + px / B) * 4;
          d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
        }
      };
    },

    /**
     * Terrain cells -> one area (Path2D) per colour class, built from horizontal runs of equal cells
     * (picture coordinates, CSS px). Per frame these areas are only transformed and filled.
     */
    terrPaths(dImg, sImg, cw, ch, B) {
      const paths = {};
      const scan = (data, dense) => {
        for (let j = 0; j < ch; j++) {
          let runKey = null, runStart = 0;
          for (let i = 0; i <= cw; i++) {
            let key = null;
            if (i < cw) {
              const o = (j * cw + i) * 4;
              if (data[o + 3]) key = `${data[o]},${data[o + 1]},${data[o + 2]},${dense ? 1 : 0}`;
            }
            if (key !== runKey) {
              if (runKey) (paths[runKey] = paths[runKey] || new Path2D()).rect(runStart * B, j * B, (i - runStart) * B, B);
              runKey = key; runStart = i;
            }
          }
        }
      };
      scan(dImg.data, true);
      scan(sImg.data, false);
      return paths;
    },

    /** Screen-aligned EGPWS dot pattern for a colour class (dense = checkerboard, sparse = every other dot). */
    terrPattern(key) {
      const p = Math.max(1, Math.round(this.dpr));
      this._pats = this._pats && this._pats.p === p ? this._pats : { p };
      if (this._pats[key]) return this._pats[key];
      const [r, gg, b, dense] = key.split(',').map(Number);
      const c = document.createElement('canvas');
      c.width = c.height = 2 * p;
      const x = c.getContext('2d');
      x.fillStyle = `rgb(${r},${gg},${b})`;
      x.fillRect(0, 0, p, p);
      if (dense) x.fillRect(p, p, p, p);
      return (this._pats[key] = this.g.createPattern(c, 'repeat'));
    },

    /**
     * Road map (motorways, trunk and primary roads, runways, aerodromes) from AC.Roads - the same data as on
     * the car display. Kept as Path2D in metres and only transformed per frame. Style: 'dark' = faint radar
     * green, 'light' = pale grey; opacity from the settings.
     */
    drawMap(own, geo) {
      const R = AC.Roads, S = AC.settings;
      if (!R.ref || !R.ways.length) return;
      if (!this._map || this._map.ver !== R.ver) {
        const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
        for (const w of R.ways) {
          const p = paths[Math.max(0, Math.min(3, w.c))], a = w.p;
          p.moveTo(a[0], -a[1]);
          for (let i = 2; i < a.length; i += 2) p.lineTo(a[i], -a[i + 1]);
        }
        this._map = { ver: R.ver, paths };
      }
      const g = this.g, k = geo.k, u = geo.u, al = S.mapAlpha || 0.6, light = S.mapStyle === 'light';
      const kLat = G().R * Math.PI / 180, kLon = kLat * Math.cos(G().toRad(R.ref.lat));
      const ox = (own.lon - R.ref.lon) * kLon, oy = (own.lat - R.ref.lat) * kLat;
      const cols = light ? ['rgba(236,240,244,', 'rgba(214,220,226,', 'rgba(190,197,205,'] : ['rgba(70,209,160,', 'rgba(56,184,138,', 'rgba(47,156,118,'];
      const base = [0.75, 0.6, 0.45], wid = [2.4, 1.8, 1.25];
      g.save();
      g.translate(geo.cx, geo.cy);
      g.rotate(G().toRad(-own.trk));
      g.scale(k, k);
      g.translate(-ox, oy);
      g.lineJoin = 'round'; g.lineCap = 'round';
      for (let i = 2; i >= 0; i--) {
        g.strokeStyle = cols[i] + (base[i] * al).toFixed(3) + ')';
        g.lineWidth = wid[i] * u / k;
        g.stroke(this._map.paths[i]);
      }
      g.lineCap = 'butt';
      g.strokeStyle = `rgba(220,228,236,${(0.85 * al).toFixed(3)})`;
      g.lineWidth = 3.2 * u / k;
      g.stroke(this._map.paths[3]);                 // runways
      g.restore();
      // aerodromes: small ring + code (screen space)
      for (const a of (R.airports || [])) {
        const e = { x: a.x - ox, y: a.y - oy };
        const p = this.project(geo, own.trk, e.x, e.y);
        if (!this.onScreen(p.px, p.py, 10)) continue;
        g.save(); g.globalAlpha = Math.min(1, al + 0.2);
        g.strokeStyle = 'rgba(175,196,210,0.9)'; g.lineWidth = 1.3;
        g.beginPath(); g.arc(p.px, p.py, (a.big ? 7 : 5) * u, 0, Math.PI * 2); g.stroke();
        if (a.code) this.text(a.code, p.px + (a.big ? 9 : 7) * u, p.py - 5 * u, '#b4c8d6', Math.round((a.big ? 11 : 9.5) * u * this.fk()), 'left', 'alphabetic', a.big);
        g.restore();
      }
    },

    /**
     * Does the terrain picture need recomputing? Small moves and turns are corrected by applyPose; a new picture is
     * only needed when the uncovered display edge or the colour bands (own altitude) would visibly change.
     */
    terrStale(p, own, geo, ageMs) {
      if (!p || p.incomplete || ageMs > 8000) return true;
      // (turning needs no new picture: the square picture covers every heading; ARC mode renders only the sector)
      if (geo.arc && Math.abs(G().norm180(own.trk - p.trk)) > 1.5) return true;
      if (Math.abs(geo.k / p.k - 1) > 0.01 || p.cx !== geo.cx || p.cy !== geo.cy) return true;
      const e = G().enu(p.lat, p.lon, own.lat, own.lon);
      if (Math.hypot(e.x, e.y) * geo.k > 8) return true;                       // moved more than 8 px
      if (Math.abs(((own.altMSL || 0) - (p.alt || 0)) / U().FT) > 50) return true;
      return false;
    },

    drawTerr(own, geo, now) {
      const T = this.terr;
      const q = this.sq(geo);   // square picture: covers the display at any heading
      if (!T.img && T.keep && T.keep.cssW === q.size && T.keep.cssH === q.size) {
        T.img = T.keep; T.last = -1e9; T.job = null;   // keep the last picture, compute the new one right away
      }
      if (!T.img) { T.img = T.keep = this.renderTerr(own, q); T.last = now; T.job = null; }
      else {
        // refresh about every 1.5 s, computed in the background; the old picture stays until the new one is ready
        if (!T.job && now - T.last > 1500 && this.terrStale(T.img.pose, own, q, now - T.last)) T.job = this.makeJob('terr', own, q);
        if (T.job && this.stepJob(T.job, 2)) { T.img = T.keep = T.job.cv; T.last = now; T.job = null; }
      }
      // colour cells (rotated / moved to the current pose, blocky like before), then the dot pattern
      // cut out in fixed screen pixels on a layer, then onto the display
      // The colour areas follow the current pose (moved / rotated), the dot pattern stays fixed to the screen
      // pixels - so the picture never shimmers (moire) when the heading changes slightly.
      const img = T.img, paths = img.paths;
      if (!paths) return;
      const g = this.g;
      g.save();
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.applyPose(g, img, own, geo);
      const m = g.getTransform();
      g.setTransform(1, 0, 0, 1, 0, 0);
      for (const key in paths) {
        const p = new Path2D();
        p.addPath(paths[key], m);
        g.fillStyle = this.terrPattern(key);
        g.fill(p);
      }
      g.restore();
    },

    thunder(own, geo) {
      const g = this.g, u = geo.u;
      for (const t of AC.Weather.allThunder()) {
        const e = G().enu(own.lat, own.lon, t.lat, t.lon);
        const p = this.project(geo, own.trk, e.x, e.y);
        if (!this.onScreen(p.px, p.py, -10)) continue;
        if (geo.arc && Math.abs(G().toDeg(Math.atan2(p.px - geo.cx, geo.cy - p.py))) > 60) continue;
        g.save();
        g.translate(p.px, p.py);
        g.fillStyle = COL.magenta; g.strokeStyle = '#000'; g.lineWidth = 1;
        g.beginPath();
        g.moveTo(2 * u, -9 * u); g.lineTo(-4 * u, 1 * u); g.lineTo(0, 1 * u); g.lineTo(-2 * u, 9 * u);
        g.lineTo(5 * u, -2 * u); g.lineTo(1 * u, -2 * u); g.lineTo(3 * u, -9 * u); g.closePath();
        g.fill(); g.stroke();
        g.restore();
      }
    },

    // ---------------------------------------------------------------- whole-display helpers
    onScreen(x, y, margin) {
      return x >= margin && x <= this.W - margin && y >= margin && y <= this.H - margin;
    },

    /** Point where the ray from the ownship towards (x, y) leaves the display (inset). */
    edgePoint(geo, x, y, inset) {
      const dx = x - geo.cx, dy = y - geo.cy;
      const tx = dx > 0 ? (this.W - inset - geo.cx) / dx : dx < 0 ? (inset - geo.cx) / dx : Infinity;
      const ty = dy > 0 ? (this.H - inset - geo.cy) / dy : dy < 0 ? (inset - geo.cy) / dy : Infinity;
      const f = Math.min(tx, ty, 1);
      return { px: geo.cx + dx * f, py: geo.cy + dy * f };
    },

    /** How far the display reaches, as a multiple of the selected range (distance to the farthest corner). */
    extent() {
      const geo = this.geom();
      const far = Math.max(
        Math.hypot(geo.cx, geo.cy), Math.hypot(this.W - geo.cx, geo.cy),
        Math.hypot(geo.cx, this.H - geo.cy), Math.hypot(this.W - geo.cx, this.H - geo.cy));
      return Math.max(1, far / geo.R);
    },

    /** Additional dashed range rings beyond the compass rose, labelled with their distance. */
    outerRings(geo) {
      const g = this.g, u = geo.u;
      const ext = this.extent();
      const rng = AC.Fmt.rangeVal();
      g.save();
      g.setLineDash([3 * u, 7 * u]);
      g.strokeStyle = 'rgba(138,145,156,0.55)';
      g.lineWidth = 1.2;
      for (const f of [1.5, 2, 3, 4]) {
        if (f > ext + 0.05) break;
        const r = geo.R * f;
        g.beginPath(); g.arc(geo.cx, geo.cy, r, 0, Math.PI * 2); g.stroke();
        const lbl = String(Math.round(rng * f * 10) / 10);
        const a = G().toRad(-35);
        let lx = geo.cx + Math.sin(a) * r, ly = geo.cy - Math.cos(a) * r;
        if (!this.onScreen(lx, ly, 14 * u)) { lx = geo.cx; ly = geo.cy + r - 4 * u; }
        if (this.onScreen(lx, ly, 8 * u)) this.text(lbl, lx, ly, COL.cyan, Math.round(11 * u * this.fk()), 'center', 'middle');
      }
      g.restore();
    },

    // ---------------------------------------------------------------- traffic
    traffic(own, geo, items) {
      const S = AC.settings, u = geo.u;
      const band = { norm: [-2700, 2700], abv: [-2700, 9900], blw: [-9900, 2700], unr: [-1e9, 1e9] }[S.altBand] || [-2700, 2700];
      const order = { other: 0, prox: 1, ta: 2, warn: 3 };
      const list = items.slice().sort((a, b) => order[a.level] - order[b.level]);
      const s = 8 * u;
      this._symPts = this._symPts || [];   // screen points of symbols/vectors (keeps the alert box off them)
      for (const it of list) {
        const alert = it.level === 'ta' || it.level === 'warn';
        if (!alert && it.relAltFt !== null && (it.relAltFt < band[0] || it.relAltFt > band[1])) continue;
        let p = this.project(geo, own.trk, it.x, it.y);
        // Traffic is shown anywhere on the display (also outside the compass rose).
        let offscale = !this.onScreen(p.px, p.py, 10 * u);
        if (offscale) {
          if (!alert) continue;
          // off-scale advisory: half symbol at the display edge in the direction of the target
          p = this.edgePoint(geo, p.px, p.py, 2 * u);
        }
        const color = it.level === 'warn' ? COL.red : it.level === 'ta' ? COL.amber : COL.cyan;
        const alpha = it.t.stale ? 0.45 : 1;
        if (offscale) {
          this.symbol(it.level, p.px, p.py, s * 1.3, color, alpha);
          this._symPts.push({ x: p.px, y: p.py, r: s * 2.2 });
        } else {
          if (it.level === 'warn') this.threatEmphasis(geo, it, p, s);
          this.motionVector(own, geo, it, p, s, color, alpha, alert);
          this.symbol(it.level, p.px, p.py, s, color, alpha);
          this._symPts.push({ x: p.px, y: p.py, r: s * 2.2 });
          this.dataTag(it.relAltFt, it.vsFpm, p.px, p.py, s, color, alpha);
          if (S.showCallsigns || alert) {
            this.text(it.t.label, p.px + s * 1.4 + (Math.abs(it.vsFpm) >= 500 ? s : 0), p.py + s * 0.4, alert ? color : COL.grey, Math.round(10 * u * this.fk()), 'left', 'alphabetic');
          }
          // simulated (test) aircraft: small, unobtrusive marker
          if (it.t.rec && it.t.rec.sim) {
            this.g.save(); this.g.globalAlpha = 0.75;
            this.text('SIM', p.px - s * 1.3, p.py + s * 1.9, COL.magenta, Math.round(8.5 * u * this.fk()), 'right', 'alphabetic');
            this.g.restore();
          }
          // closure rate next to alerting traffic (option)
          const cl = alert ? this.closureTxt(it) : null;
          if (cl) {
            const fz = Math.round(10 * u * this.fk());
            this.text(cl, p.px + s * 1.4 + (Math.abs(it.vsFpm) >= 500 ? s : 0), p.py + s * 0.4 + fz * 1.2, color, fz, 'left', 'alphabetic', true);
          }
        }
      }
    },

    /** "CLOSING 180 KT" for a converging target when the closure-rate option is on, otherwise null. */
    closureTxt(it) {
      if (!AC.settings.calloutClosure || !it || !(it.closureMs > 5)) return null;
      return `CLOSING ${AC.Fmt.speed(it.closureMs)} ${AC.Fmt.speedLabel().toUpperCase()}`;
    },

    /**
     * Age of the weather radar picture (time of the radar scan; new scans come about every 10 min):
     * green < 15 min, white < 20 min, amber (filled) < 30 min, red (blinking) from 30 min. lvl: 0..3, -1 = sim.
     */
    wxAgeInfo() {
      if (AC.Weather.synthetic && AC.Weather.synthetic.length && !AC.Weather.frame) return { txt: 'WX SIM', lvl: -1 };
      const a = AC.Weather.ageS();
      if (a === null) return { txt: 'WX --', lvl: 2 };
      const m = Math.floor(a / 60), s = Math.floor(a % 60);
      const txt = `WX ${m}:${String(s).padStart(2, '0')}`;
      return { txt, lvl: a >= 1800 ? 3 : a >= 1200 ? 2 : a >= 900 ? 1 : 0 };
    },

    wxAge(x, y, size) {
      const S = AC.settings;
      if (!S.wxOn) return false;
      const w = this.wxAgeInfo();
      if (w.lvl === -1) this.text(w.txt, x, y, COL.magenta, size, 'left', 'alphabetic', true);
      else if (w.lvl === 3) this.box(w.txt, x, y - size, COL.red, size, this.flash, 'left');
      else if (w.lvl === 2) this.box(w.txt, x, y - size, COL.amber, size, true, 'left');
      else this.text(w.txt, x, y, w.lvl === 0 ? COL.green : COL.white, size, 'left', 'alphabetic', true);
      return true;
    },

    /**
     * Age of the latest ADS-B data (any source): green < 5 s, white < 10 s, amber < 15 s, red (blinking) above.
     */
    adsbAge(x, y, size) {
      const S = AC.settings;
      if (!S.trafficEnabled) return;
      if (S.simEnabled && !S.simLiveTraffic) { this.text('ADS-B SIM', x, y, COL.magenta, size, 'left', 'alphabetic', true); return; }
      const last = AC.Adsb.lastData;
      if (!last) { this.text('ADS-B --', x, y, COL.amber, size, 'left', 'alphabetic', true); return; }
      const age = (Date.now() - last) / 1000;
      const txt = `ADS-B ${age < 10 ? age.toFixed(1) : Math.round(age)} s`;
      if (age >= 15) this.box(txt, x, y - size, COL.red, size, this.flash, 'left');        // lost: red, blinking
      else if (age >= 10) this.box(txt, x, y - size, COL.amber, size, true, 'left');       // delayed: amber filled
      else this.text(txt, x, y, age < 5 ? COL.green : COL.white, size, 'left', 'alphabetic', true);
    },

    /**
     * Quality of the own position: good (<= 30 m satellite fix) / ok (<= 100 m) / caution (<= 300 m or dead reckoning)
     * / bad (> 300 m, network position only, dead reckoning > 20 s, no position).
     */
    accLevel(own) {
      const S = AC.settings;
      if (!own) return { level: 'bad', acc: null, src: 'N/A' };
      if (S.simEnabled) return { level: 'good', acc: own.acc, src: 'SIM' };
      const dr = own.source === 'dr';
      const src = dr ? `DR ${Math.round(own.drAge)}s` : own.gnss ? (own.sats != null ? `${own.sats} SAT` : window.AC_IOS ? 'GPS' : '? SAT') : 'NETZ';
      const acc = own.acc;
      let level = 'good';
      if ((dr && own.drAge > 20) || acc > 300 || (!own.gnss && !dr)) level = 'bad';
      else if (dr || acc > 100) level = 'caution';
      else if (acc > 30) level = 'ok';
      return { level, acc, src };
    },

    /** Uncertainty circle around the own aircraft (true scale) - only drawn when it is visible. */
    accuracyRing(own, geo) {
      const q = this.accLevel(own);
      if (!own || q.acc === null) return;
      const r = q.acc * geo.k;
      if (r < 6) return;
      const col = { good: COL.green, ok: COL.white, caution: COL.amber, bad: COL.red }[q.level];
      const g = this.g, u = geo.u;
      g.save();
      g.setLineDash([5 * u, 4 * u]);
      g.strokeStyle = col; g.lineWidth = 1.6 * u; g.globalAlpha = 0.85;
      g.beginPath(); g.arc(geo.cx, geo.cy, Math.min(r, Math.hypot(this.W, this.H)), 0, Math.PI * 2); g.stroke();
      if (q.level === 'bad') { g.globalAlpha = 0.10; g.fillStyle = COL.red; g.fill(); }
      g.restore();
    },

    /** Accuracy read-out (bottom right, above GS/ALT/VS). Amber box / blinking red box when poor. */
    accuracyText(own, geo, y) {
      const q = this.accLevel(own);
      const u = geo.u, size = Math.round(11 * u * this.fk()), x = this.W - 8 * u - (this.insR || 0);
      const accTxt = q.acc === null ? '---' : q.acc < 1000 ? `${Math.round(q.acc)} m` : `${(q.acc / 1000).toFixed(1)} km`;
      const txt = own ? `POS ±${accTxt} ${q.src}` : 'POS N/A';
      if (q.level === 'bad') this.box(txt, x, y - size, COL.red, size, this.flash, 'right');
      else if (q.level === 'caution') this.box(txt, x, y - size, COL.amber, size, false, 'right');
      else this.text(txt, x, y, q.level === 'good' ? COL.green : COL.white, size, 'right', 'alphabetic', true);
    },

    /**
     * Attitude indicator (artificial horizon) from the phone sensors, bottom-left corner.
     * Shows bank and pitch, a bank scale and the heading reference (GPS / MAG / GYRO).
     */
    attitude(st, geo) {
      const S = AC.settings, A = AC.Ahrs;
      this._attRect = null;
      if (!S.attShow || !st.own) return;
      const sim = S.simEnabled;
      if (!sim && !A.ready()) return;
      const g = this.g, u = geo.u;
      const r = Math.min(this.W, this.H) * 0.13;
      const cx = 10 * u + r + (this.insL || 0), cy = this.H - 84 * u - r;
      const D2R = Math.PI / 180;
      const roll = A.roll, pitch = A.pitch;
      const ppd = r / 28;                       // pixels per degree of pitch
      g.save();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
      g.translate(cx, cy);
      g.rotate(-roll * D2R);
      const off = pitch * ppd;
      g.fillStyle = '#1d5fa8'; g.fillRect(-2 * r, -3 * r + off, 4 * r, 3 * r);
      g.fillStyle = '#6b4420'; g.fillRect(-2 * r, off, 4 * r, 3 * r);
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-2 * r, off); g.lineTo(2 * r, off); g.stroke();
      g.lineWidth = 1;
      for (const p of [-20, -10, -5, 5, 10, 20]) {
        const y = off - p * ppd, w = Math.abs(p) % 10 === 0 ? r * 0.38 : r * 0.18;
        g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
        if (Math.abs(p) % 10 === 0) this.text(String(Math.abs(p)), w + 3 * u, y, '#fff', Math.round(8 * u), 'left', 'middle');
      }
      // bank pointer (moves with the horizon)
      g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(0, -r + 4 * u); g.lineTo(-4 * u, -r + 11 * u); g.lineTo(4 * u, -r + 11 * u); g.closePath(); g.fill();
      g.restore();
      // fixed bank scale
      g.save();
      g.translate(cx, cy);
      g.strokeStyle = '#fff'; g.lineWidth = 1.5;
      for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
        const a = (b - 90) * D2R, l = b % 30 === 0 ? 8 * u : 5 * u;
        g.beginPath(); g.moveTo(Math.cos(a) * r, Math.sin(a) * r); g.lineTo(Math.cos(a) * (r - l), Math.sin(a) * (r - l)); g.stroke();
      }
      // fixed aircraft symbol
      g.strokeStyle = COL.yellow; g.lineWidth = 3 * u; g.lineCap = 'round';
      g.beginPath(); g.moveTo(-r * 0.55, 0); g.lineTo(-r * 0.18, 0); g.lineTo(-r * 0.08, r * 0.1); g.stroke();
      g.beginPath(); g.moveTo(r * 0.55, 0); g.lineTo(r * 0.18, 0); g.lineTo(r * 0.08, r * 0.1); g.stroke();
      g.fillStyle = COL.yellow; g.beginPath(); g.arc(0, 0, 2.5 * u, 0, Math.PI * 2); g.fill();
      g.restore();
      g.strokeStyle = COL.grey; g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
      const ref = sim ? 'SIM' : A.headingRef;
      const n = this.attNotice;
      if (n && performance.now() < n.until) {
        this.box(n.text, cx, cy + r + 4 * u, n.ok ? COL.green : COL.amber, Math.round(10 * u), true, 'center');
      } else {
        this.text(`ATT ${ref}`, cx, cy + r + 11 * u, ref === 'GYRO' ? COL.amber : COL.grey, Math.round(10 * u), 'center', 'middle', true);
      }
      this._attRect = { cx, cy, r };
      if (this._symPts) this._symPts.push({ x: cx, y: cy, r: r + 6 * u });
    },

    /** Extra emphasis for alerting traffic: pulsing rings (red) / steady ring (amber) and a red bearing line. */
    threatEmphasis(geo, it, p, s) {
      const g = this.g, u = geo.u;
      g.save();
      if (it.level === 'warn') {
        const ph = (performance.now() % 900) / 900;
        g.setLineDash([6 * u, 5 * u]);
        g.strokeStyle = 'rgba(255,43,43,0.8)';
        g.lineWidth = 2 * u;
        g.beginPath(); g.moveTo(geo.cx, geo.cy); g.lineTo(p.px, p.py); g.stroke();
        g.setLineDash([]);
        for (const k of [0, 0.5]) {
          const f = (ph + k) % 1;
          g.globalAlpha = 1 - f;
          g.strokeStyle = COL.red;
          g.lineWidth = 2.5 * u;
          g.beginPath(); g.arc(p.px, p.py, s * 1.4 + f * s * 2.8, 0, Math.PI * 2); g.stroke();
        }
      } else {
        g.globalAlpha = 0.85;
        g.strokeStyle = COL.amber;
        g.lineWidth = 1.6 * u;
        g.beginPath(); g.arc(p.px, p.py, s * 1.9, 0, Math.PI * 2); g.stroke();
      }
      g.restore();
    },

    /** Display border: pulsing red - only for red warnings (no frame for amber advisories / cautions). */
    alertFrame(st, geo) {
      const warning = st.alerts.some((a) => a.level === 'warn' || a.level === 'warning');
      if (!warning) return;
      const g = this.g, u = geo.u;
      g.save();
      const a = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(performance.now() / 140));
      g.strokeStyle = `rgba(255,30,30,${a})`;
      g.lineWidth = 7 * u;
      g.shadowColor = 'rgba(255,0,0,0.9)';
      g.shadowBlur = 14 * u;
      g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, this.W - g.lineWidth, this.H - g.lineWidth);
      g.restore();
    },

    /**
     * Obstacles: aviation chart style symbol (inverted V with base dot), lines dashed.
     * Colour by height of the obstacle top relative to own altitude: amber = above you,
     * yellow = less than 500 ft below, grey = lower. The obstacle causing an alert is red/amber,
     * pulses and is labelled with its top altitude.
     */
    /** Rough test whether a polyline crosses the display (both ends may be off-screen). */
    segOnScreen(pts) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of pts) { x0 = Math.min(x0, q.px); x1 = Math.max(x1, q.px); y0 = Math.min(y0, q.py); y1 = Math.max(y1, q.py); }
      return x1 >= 0 && x0 <= this.W && y1 >= 0 && y0 <= this.H;
    },

    obstacles(own, geo, st) {
      const list = st.obsDisp || [];
      if (!list.length) return;
      const g = this.g, u = geo.u, F = AC.Fmt;
      const threat = st.alerts.find((a) => a.kind === 'obstacle');
      const tid = threat ? threat.obs.obs.id : null;
      const tcol = threat && threat.level === 'warning' ? COL.red : COL.amber;
      // Fast projection (local flat earth around the ownship - plenty accurate within the display range).
      const R0 = G().R, kLat = R0 * Math.PI / 180, kLon = kLat * Math.cos(G().toRad(own.lat));
      const tr = G().toRad(own.trk), c = Math.cos(tr), s = Math.sin(tr), k = geo.k;
      const proj = (p) => {
        const x = (p.lon - own.lon) * kLon, y = (p.lat - own.lat) * kLat;
        return { px: geo.cx + (x * c - y * s) * k, py: geo.cy - (x * s + y * c) * k };
      };
      const W = this.W, H = this.H, m = 12 * u;
      const vis = (q) => q.px > -m && q.px < W + m && q.py > -m && q.py < H + m;
      // Normal obstacles are batched per style: one path for all towers / lines of the same colour (few draw calls).
      const styles = [
        { col: COL.amber, alpha: 0.9, test: (r) => r > 0 },
        { col: '#e8d870', alpha: 0.9, test: (r) => r <= 0 && r > -500 },
        { col: COL.grey, alpha: 0.55, test: (r) => r <= -500 },
      ];
      const sz = u;
      for (const st2 of styles) {
        const towers = new Path2D(), dots = new Path2D(), lines = new Path2D();
        let nT = 0, nL = 0;
        for (const d of list) {
          if (d.o.id === tid || !AC.settings.obsShow || !st2.test(d.rel)) continue;
          if (d.o.pts.length === 1) {
            const q = proj(d.o.pts[0]);
            if (!vis(q)) continue;
            towers.moveTo(q.px - 5 * sz, q.py + 4 * sz); towers.lineTo(q.px, q.py - 8 * sz); towers.lineTo(q.px + 5 * sz, q.py + 4 * sz);
            dots.moveTo(q.px + 1.6 * sz, q.py + 4 * sz); dots.arc(q.px, q.py + 4 * sz, 1.6 * sz, 0, Math.PI * 2);
            nT++;
          } else {
            const pts = d.o.pts.map(proj);
            if (!pts.some(vis) && !this.segOnScreen(pts)) continue;
            lines.moveTo(pts[0].px, pts[0].py);
            for (let i = 1; i < pts.length; i++) lines.lineTo(pts[i].px, pts[i].py);
            nL++;
          }
        }
        if (!nT && !nL) continue;
        g.save();
        g.globalAlpha = st2.alpha;
        g.strokeStyle = st2.col; g.fillStyle = st2.col;
        g.lineWidth = 1.5 * u;
        if (nT) { g.stroke(towers); g.fill(dots); }
        if (nL) { g.setLineDash([6 * u, 4 * u]); g.stroke(lines); g.setLineDash([]); }
        g.restore();
      }
      // the obstacle causing an alert: drawn individually (pulsing ring, height label)
      for (const d of list) {
        if (d.o.id !== tid) continue;
        const pts = d.o.pts.map(proj);
        const isT = true;
        const col = isT ? tcol : d.rel > 0 ? COL.amber : d.rel > -500 ? '#e8d870' : COL.grey;
        g.save();
        g.globalAlpha = isT ? 1 : d.rel > -500 ? 0.9 : 0.55;
        g.strokeStyle = col; g.fillStyle = col;
        g.lineWidth = (isT ? 2.6 : 1.5) * u;
        const sz = (isT ? 1.5 : 1) * u;
        const tower = (x, y) => {
          g.beginPath(); g.moveTo(x - 5 * sz, y + 4 * sz); g.lineTo(x, y - 8 * sz); g.lineTo(x + 5 * sz, y + 4 * sz); g.stroke();
          g.beginPath(); g.arc(x, y + 4 * sz, 1.6 * sz, 0, Math.PI * 2); g.fill();
        };
        if (pts.length === 1) {
          tower(pts[0].px, pts[0].py);
        } else {
          g.setLineDash([6 * u, 4 * u]);
          g.beginPath(); g.moveTo(pts[0].px, pts[0].py); for (const q of pts.slice(1)) g.lineTo(q.px, q.py); g.stroke();
          g.setLineDash([]);
          if (isT) pts.forEach((q) => tower(q.px, q.py));
        }
        if (isT) {
          const c = pts.length === 1 ? pts[0] : { px: (pts[0].px + pts[1].px) / 2, py: (pts[0].py + pts[1].py) / 2 };
          if (this._symPts) {
            this._symPts.push({ x: c.px, y: c.py, r: 16 * u });                 // symbol + ring
            this._symPts.push({ x: c.px + 45 * u, y: c.py - 14 * u, r: 14 * u }); // height label
            pts.forEach((q) => this._symPts.push({ x: q.px, y: q.py, r: 10 * u }));
          }
          const f = (performance.now() % 900) / 900;
          g.globalAlpha = 1 - f;
          g.beginPath(); g.arc(c.px, c.py, 10 * u + f * 22 * u, 0, Math.PI * 2); g.stroke();
          g.globalAlpha = 1;
          this.text(`▲${F.alt(d.topFt * U().FT)} ${F.altLabel()}`, c.px + 12 * u, c.py - 10 * u, col, Math.round(12 * u), 'left', 'alphabetic', true);
        }
        g.restore();
      }
    },

    /**
     * Direction of movement: line from the symbol along the target's ground track (track-up display).
     * Length = distance flown in 60 s (alerts) or 30 s (others), clamped for readability.
     * Alerts get a thick line with arrowhead and a dark outline so it stands out.
     */
    motionVector(own, geo, it, p, s, color, alpha, alert) {
      const t = it.t;
      if (!t.gs || t.gs < 8) return;
      const u = geo.u;
      const secs = alert ? 60 : 30;
      const len = G().clamp(t.gs * secs * geo.k, alert ? 22 * u : 10 * u, alert ? 75 * u : 32 * u);
      const a = G().toRad(t.trk - own.trk);
      const dx = Math.sin(a), dy = -Math.cos(a);
      const x0 = p.px + dx * s * 0.9, y0 = p.py + dy * s * 0.9;
      const x1 = p.px + dx * (s + len), y1 = p.py + dy * (s + len);
      if (this._symPts) {
        for (let f = 0.33; f <= 1.001; f += 0.33) this._symPts.push({ x: p.px + dx * (s + len) * f, y: p.py + dy * (s + len) * f, r: 6 * u });
      }
      const g = this.g;
      g.save();
      g.globalAlpha = alert ? alpha : alpha * 0.7;
      g.lineCap = 'round';
      if (alert) {
        g.strokeStyle = '#000'; g.lineWidth = 5.5 * u;
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      g.strokeStyle = color;
      g.lineWidth = alert ? 3 * u : 1.4 * u;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      if (alert) {
        const h = 9 * u, w = 5.5 * u;
        g.fillStyle = color;
        g.beginPath();
        g.moveTo(x1 + dx * h * 0.6, y1 + dy * h * 0.6);
        g.lineTo(x1 - dx * h * 0.6 - dy * w, y1 - dy * h * 0.6 + dx * w);
        g.lineTo(x1 - dx * h * 0.6 + dy * w, y1 - dy * h * 0.6 - dx * w);
        g.closePath();
        g.fill();
      }
      g.restore();
    },

    // ---------------------------------------------------------------- annunciations
    annunciations(st, geo) {
      const S = AC.settings, u = geo.u, W = this.W, H = this.H;
      const fs = Math.round(13 * u * this.fk()), sm = Math.round(11 * u * this.fk());
      const pad = 8 * u;
      // left / right margins: in landscape the key columns float over the radar, texts stay beside them
      const padL = pad + (this.insL || 0), padR = pad + (this.insR || 0);
      const padT = pad + (this.insT || 0);   // iPhone: clear of the rounded corners beside the Dynamic Island
      // left column: traffic system state
      let y = padT + fs;
      // TFC: green = traffic data current; red = ADS-B data lost / no position (traffic picture not current);
      // amber = delayed (>= 10 s) or traffic function switched off.
      const f = st.flags || {};
      if (!S.trafficEnabled) this.text('TFC OFF', padL, y, COL.amber, fs, 'left', 'alphabetic', true);
      else if (f.tfcFail || f.offline || (f.gpsFail && st.phase === 'run')) this.box('TFC', padL, y - fs, COL.red, fs, true, 'left');
      else if (f.tfcDelayed) this.text('TFC', padL, y, COL.amber, fs, 'left', 'alphabetic', true);
      else this.text('TFC', padL, y, COL.green, fs, 'left', 'alphabetic', true);
      y += fs * 1.2;
      this.text('TA ONLY', padL, y, COL.white, sm);
      y += sm * 1.3;
      const sl = st.tfc ? st.tfc.sl : '-';
      this.text(`SL${sl} ${S.sens === 'auto' ? 'AUTO' : 'MAN'} ${S.sensGain.toUpperCase()}`, padL, y, COL.cyan, sm);
      y += sm * 1.3;
      this.text(S.altBand.toUpperCase(), padL, y, COL.cyan, sm, 'left', 'alphabetic', true);
      y += sm * 1.3;
      this.text(S.altUnit === 'm' ? 'ALT ×10 m' : 'ALT ×100 ft', padL, y, COL.grey, sm);

      // right column: WX / TERR
      let ry = padT + fs;
      if (S.wxOn) {
        this.text('WX', W - padR, ry, COL.green, fs, 'right', 'alphabetic', true);
        ry += fs * 1.2;
        const gn = S.wxGain === 0 ? 'GAIN CAL' : `GAIN ${S.wxGain > 0 ? '+' : ''}${S.wxGain}`;
        this.text(gn, W - padR, ry, S.wxGain === 0 ? COL.cyan : COL.amber, sm, 'right');
        ry += sm * 1.3;
        // (age of the radar picture: timer bottom left, next to the ADS-B age)
      }
      if (S.terrOn || this.terrPopup) {
        this.text(this.terrPopup && !S.terrOn ? 'TERR AUTO' : 'TERR', W - padR, ry, COL.amber, fs, 'right', 'alphabetic', true);
        ry += fs * 1.2;
      }
      const F = AC.Fmt;
      if (st.own && st.terrain && st.terrain.aglFt !== null) {
        this.text(`AGL ${Math.round(F.alt(st.terrain.aglFt * U().FT) / 10) * 10} ${F.altLabel()}`, W - padR, ry, COL.grey, sm, 'right');
      }

      // bottom left: range
      const auto = F.rangeOverride !== null;
      this.text(`RNG ${F.rangeVal()} ${F.distLabel()}`, padL, H - pad, auto ? COL.amber : COL.cyan, fs, 'left', 'alphabetic', true);
      this.text(S.mode === 'arc' ? 'ARC' : '360°', padL, H - pad - fs * 1.3, COL.grey, sm);
      this.adsbAge(padL, H - pad - fs * 2.6, sm);
      const wxShown = this.wxAge(padL, H - pad - fs * 3.75, sm);         // weather picture age, timer like ADS-B
      if (auto) this.box('AUTO RNG', padL, H - pad - fs * (wxShown ? 6.05 : 4.9), COL.amber, sm, false);

      // bottom right: ownship data
      if (st.own) {
        const o = st.own;
        this.text(`GS ${F.speed(o.gs)} ${F.speedLabel()}`, W - padR, H - pad - sm * 2.6, COL.white, sm, 'right');
        this.text(`ALT ${o.altMSL === null ? '----' : F.alt(o.altMSL)} ${F.altLabel()}`, W - padR, H - pad - sm * 1.3, COL.white, sm, 'right');
        const vs = F.vs(o.vs);
        this.text(`VS ${parseFloat(vs) > 0 ? '+' : ''}${vs} ${F.vsLabel()}`, W - padR, H - pad, COL.white, sm, 'right');
      }
      this.accuracyText(st.own, geo, H - pad - sm * 4.1);

      // centre bottom: flags
      // status flags (outlined)
      const flags = [];
      if (AC.Sim.live || AC.Sim.testRun) flags.push([`TEST ${AC.Sim.testLeft()}s`, COL.magenta]);
      else if (st.flags.sim) flags.push(['SIM', COL.magenta]);
      if (AC.AlertTest && AC.AlertTest.active) flags.push([`WARNTEST ${AC.AlertTest.left()}s`, COL.magenta]);
      if (S.terrInhibit) flags.push(['TERR INHB', COL.amber]);
      if (st.flags.terrAero) flags.push(['TERR APT', COL.grey]);
      if (S.muted) flags.push(['AUDIO OFF', COL.amber]);
      if (st.flags.ground) flags.push(['GND', COL.grey]);
      if (this.wx.ahead && S.wxOn) flags.push(['WX AHEAD', COL.amber]);
      const fy = H - pad - fs * (geo.arc ? 1.4 : 1.6);
      this.boxRow(flags, fy, sm, false);

      // data / sensor failures (filled amber, one line each, clearly worded)
      this.faultMessages(st, geo, fy - sm * 0.6);

      this.mainAlert(st, geo);
    },

    boxRow(items, y, size, filled) {
      if (!items.length) return;
      const g = this.g;
      g.font = `bold ${size}px ${FONT}`;
      const widths = items.map((f) => g.measureText(f[0]).width + size * 1.4);
      let x = this.W / 2 - widths.reduce((a, b) => a + b, 0) / 2;
      items.forEach((f, i) => { this.box(f[0], x, y, f[1], size, filled); x += widths[i]; });
    },

    /** Clear failure messages, stacked above the status flags. Failures that disable a warning function are listed. */
    faultMessages(st, geo, bottom) {
      const f = st.flags, S = AC.settings, u = geo.u;
      const list = [];
      if (f.gpsFail) list.push(['NO GPS POSITION - ALERTS INHIBITED', COL.amber]);
      else if (f.gpsDegraded) list.push([f.gpsDegraded, COL.amber]);
      else if (f.dr !== false && f.dr !== undefined) list.push([`GPS LOST - DEAD RECKONING ${f.dr} s`, COL.amber]);
      if (f.offline) list.push(['NO INTERNET - NO TRAFFIC / WX DATA', COL.amber]);
      else if (f.tfcFail) list.push(['NO TRAFFIC DATA (ADS-B)', COL.red]);
      else if (f.tfcDelayed) list.push([`TRAFFIC DATA DELAYED ${f.tfcDelayed} s`, COL.amber]);
      if (f.terrNA) list.push(['NO TERRAIN DATA', COL.amber]);
      if (f.obsNA) list.push(['NO OBSTACLE DATA', COL.amber]);
      if (f.wxNA) list.push([f.wxNA === 'old' ? 'WEATHER DATA OUTDATED' : 'NO WEATHER DATA', COL.amber]);
      if (AC.Voice.diag.status === 'FEHLER' && !S.muted) list.push(['VOICE OUTPUT FAILED - TONES ONLY', COL.amber]);
      if (!list.length) return;
      const size = Math.round(12 * u * this.fk());
      const h = size * 1.35 + 3 * u;
      let y = bottom - h * list.length;
      for (const [txt, col] of list) {
        this.box(txt, this.W / 2, y, col, size, true, 'center');
        y += h;
      }
    },

    /**
     * Main alert annunciation. Normally centred in the upper part of the display; if it would cover a
     * traffic symbol or its direction vector, it moves to the top band above the compass rose and is shown
     * symmetrically as two identical boxes left and right of the heading box (which stays centred on top).
     * Once moved it stays up there until the alert has ended (no jumping back and forth).
     */
    mainAlert(st, geo) {
      const u = geo.u, W = this.W;
      const top = st.alerts[0];
      let label = null, color = COL.amber, lower = null;
      if (top) {
        const warning = top.level === 'warning' || top.level === 'warn';
        if (top.kind === 'terrain') { label = warning ? 'PULL UP' : 'CAUTION TERRAIN'; lower = warning ? 'TERRAIN' : null; }
        else if (top.kind === 'obstacle') { label = warning ? 'PULL UP' : 'CAUTION OBSTACLE'; lower = warning ? 'OBSTACLE' : null; }
        else if (top.kind === 'traffic' && (top.level === 'ta' || warning)) { label = 'TRAFFIC'; lower = this.closureTxt(top.item); }
        color = warning ? COL.red : COL.amber;
      }
      const key = label ? `${top.kind}-${label}` : null;
      if (!key) { this._annTop = false; this._annKey = null; return; }
      if (key !== this._annKey) { this._annKey = key; this._annTop = false; }

      const warning = top.level === 'warning' || top.level === 'warn';
      const blink = warning && this.flash;
      const g = this.g;

      // centred position and its rectangle
      const big = Math.round(20 * u);
      const yy = geo.arc ? geo.cy - geo.R * 0.52 : geo.cy - geo.R * 0.60;
      g.font = `bold ${big}px ${FONT}`;
      const bw = g.measureText(label).width + big * 0.7;
      const bh = big * 1.35 * (lower ? 2.6 : 1);
      const rect = { x: W / 2 - bw / 2 - 6 * u, y: yy - 6 * u, w: bw + 12 * u, h: bh + 12 * u };
      if (!this._annTop && this._symPts) {
        this._annTop = this._symPts.some((p) =>
          p.x + p.r > rect.x && p.x - p.r < rect.x + rect.w && p.y + p.r > rect.y && p.y - p.r < rect.y + rect.h);
      }

      if (!this._annTop) {
        this.box(label, W / 2, yy, color, big, blink, 'center');
        if (lower) {
          const lsz = top.kind === 'traffic' ? Math.round(big * 0.8) : big;
          this.box(lower, W / 2, yy + big * 1.6, color, lsz, false, 'center');
        }
        return;
      }

      // top band: two identical boxes, symmetric about the heading box
      const t = this._trkBox;
      if (!t) return;
      const short = { 'CAUTION TERRAIN': 'TERRAIN', 'CAUTION OBSTACLE': 'OBSTACLE' }[label] || label;
      const fsz = Math.round(15 * u);
      g.font = `bold ${fsz}px ${FONT}`;
      const h = fsz * 1.35;
      const y = t.y + t.h / 2 - h / 2;
      const gap = 8 * u;
      this.box(short, t.x - gap, y, color, fsz, blink, 'right');
      this.box(short, t.x + t.w + gap, y, color, fsz, blink, 'left');
    },

    // ---------------------------------------------------------------- frame
    frame(st, now) {
      const g = this.g;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.fillStyle = '#000';
      g.fillRect(0, 0, this.W, this.H);
      this.flash = Math.floor(now / 500) % 2 === 0;

      if (st.phase === 'off') return;
      if (st.phase === 'boot') { AC.SelfTest.draw(this, now); return; }

      const geo = this.geom();
      const S = AC.settings;
      const v = this.view(st);
      const own = v.own;
      this._symPts = [];
      // Terrain picture: selected by the pilot, or popped up automatically during a terrain/obstacle alert.
      const terrShow = S.terrOn || this.terrPopup;
      if (own) {
        g.save();
        g.beginPath(); g.rect(0, 0, this.W, this.H); g.clip();
        // Overlays: terrain, road map, weather (adjustable opacity). During auto range / an alert the
        // weather is hidden, so the traffic / terrain picture stays clear; it returns afterwards.
        const wxShow = S.wxOn && !(AC.App.wxSuppressed && AC.App.wxSuppressed());
        if (terrShow) this.drawTerr(own, geo, now);
        if (S.mapMode === 'on' || (S.mapMode === 'terr' && terrShow)) this.drawMap(own, geo);
        if (wxShow) this.drawWx(own, geo, now, S.wxAlpha || 0.5);
        if (wxShow && S.wxThunder) this.thunder(own, geo);
        this.obstacles(own, geo, st);
        g.restore();
      }
      this.outerRings(geo);
      this.rose(geo, own ? own.trk : 0);
      if (own) this.accuracyRing(own, geo);
      if (own && v.items && S.trafficEnabled) this.traffic(own, geo, v.items);
      this.ownship(geo, own ? COL.white : COL.dim);
      this.attitude(st, geo);
      if (!own) this.text('NO POSITION', geo.cx, geo.cy + 40 * geo.u, COL.amber, Math.round(16 * geo.u), 'center', 'middle', true);
      this.annunciations(st, geo);
      this.alertFrame(st, geo);
    },
  };

  AC.Display = D;
})(window.AC = window.AC || {});
