/*
 * Software rasterizer for LIRUX 3D.
 * Draws into a tiny pixel buffer (about 320x200) using a five level
 * monochrome palette, ordered dithering, a z-buffer for hidden line removal
 * and a 3x5 bitmap font. The browser only scales the result up, pixelated.
 */
(function (global) {
  'use strict';

  const HZ = 0.72;     // half height of the bounding box
  const BIAS = 0.035;  // depth tolerance so lines win over the faces they sit on
  const EPS = 1e-7;

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);

  const LIGHT = (() => {
    const v = [-0.45, -0.55, 0.9];
    const m = Math.hypot(v[0], v[1], v[2]);
    return v.map(c => c / m);
  })();

  // 3x5 font, rows top to bottom, 3 bits per row.
  const GLYPHS = {
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
    '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
    '6': '111100111101111', '7': '111001010010010', '8': '111101111101111',
    '9': '111101111001111', '.': '000000000000010', '-': '000000111000000',
    '+': '000010111010000', '|': '010010010010010', '(': '001010010010001',
    ')': '100010010010100', '=': '000111000111000', ' ': '000000000000000',
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011',
    'D': '110101101101110', 'E': '111100110100111', 'F': '111100110100100',
    'G': '011100101101011', 'H': '101101111101101', 'I': '111010010010111',
    'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
    'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010',
    'P': '110101110100100', 'Q': '010101101110011', 'R': '110101110101101',
    'S': '011100010001110', 'T': '111010010010010', 'U': '101101101101111',
    'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101',
    'Y': '101101010010010', 'Z': '111001010100111',
  };

  class Plotter {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.pal = new Uint32Array(5);
      this.ax = 1; // horizontal pixels per vertical pixel (2 on 80 column screens)
      this.ts = 1; // text scale, so labels keep the same size on hi-res screens
      this.proj = new Float32Array(0);
      this.resize(320, 200);
    }

    resize(w, h) {
      this.w = w;
      this.h = h;
      this.canvas.width = w;
      this.canvas.height = h;
      this.img = this.ctx.createImageData(w, h);
      this.px = new Uint32Array(this.img.data.buffer);
      this.zb = new Float32Array(w * h);
    }

    // Five colours from background (0) to brightest (4), each as [r, g, b].
    setPalette(colours) {
      this.pal.set(colours.map(([r, g, b]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0));
    }

    // Monochrome ramp: level 4 is an overdriven, almost white glow.
    setMonochrome(r, g, b) {
      const mix = (k, white = 0) => [r, g, b].map(v => Math.round(v * k + (255 - v * k) * white));
      this.setPalette([mix(0.05), mix(0.3), mix(0.55), mix(0.82), mix(1, 0.3)]);
    }

    /*
     * mesh: { n, pos: Float32Array (x, y, z in [-1, 1], z already scaled),
     *         valid: Uint8Array, phase: Float32Array | null }
     * cam:  { yaw, pitch, zoom }
     * o:    { style: 'wire' | 'solid' | 'mesh' | 'dots', labels }
     */
    render(mesh, cam, o) {
      const { w, h, px, zb, pal } = this;
      px.fill(pal[0]);
      zb.fill(Infinity);

      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      const ax = this.ax;
      const S = Math.min(w / ax / 3.3, h / 2.9) * cam.zoom;
      const D = 4.5, ox = w / 2, oy = h / 2;

      const P = (x, y, z) => {
        const xr = x * cy - y * sy, yr = x * sy + y * cy;
        const up = yr * sp + z * cp, d = yr * cp - z * sp;
        const f = D / (D + d);
        return [ox + xr * f * S * ax, oy - up * f * S, d];
      };

      const style = o.style;
      if (mesh) {
        const n = mesh.n, N1 = n + 1, cnt = N1 * N1, pos = mesh.pos, valid = mesh.valid;
        if (this.proj.length < cnt * 3) this.proj = new Float32Array(cnt * 3);
        const pr = this.proj;
        for (let k = 0; k < cnt; k++) {
          const q = P(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
          pr[k * 3] = q[0]; pr[k * 3 + 1] = q[1]; pr[k * 3 + 2] = q[2];
        }

        // Faces: in wire and dots mode they are drawn in the background
        // colour, which is what hides the lines behind the surface.
        const lo = style === 'solid' ? 1 : 0;
        const hi = style === 'solid' ? 4 : style === 'mesh' ? 2 : 0;
        const phase = mesh.phase;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const a = j * N1 + i, b = a + 1, c = a + N1 + 1, d = a + N1;
            if (!(valid[a] && valid[b] && valid[c] && valid[d])) continue;
            this.face(pos, pr, a, b, c, lo, hi, phase);
            this.face(pos, pr, a, c, d, lo, hi, phase);
          }
        }

        this.floor(P);

        if (style === 'wire' || style === 'mesh') {
          const seg = (a, b) => {
            const d = (pr[a * 3 + 2] + pr[b * 3 + 2]) / 2;
            const lvl = style === 'mesh' ? (d < 0.2 ? 4 : 3) : d < -0.35 ? 4 : d < 0.45 ? 3 : 2;
            this.line(pr[a * 3], pr[a * 3 + 1], pr[a * 3 + 2], pr[b * 3], pr[b * 3 + 1], pr[b * 3 + 2], pal[lvl], false);
          };
          for (let j = 0; j <= n; j++) {
            for (let i = 0; i < n; i++) {
              const a = j * N1 + i;
              if (valid[a] && valid[a + 1]) seg(a, a + 1);
            }
          }
          for (let j = 0; j < n; j++) {
            for (let i = 0; i <= n; i++) {
              const a = j * N1 + i;
              if (valid[a] && valid[a + N1]) seg(a, a + N1);
            }
          }
        } else if (style === 'dots') {
          for (let k = 0; k < cnt; k++) {
            if (!valid[k]) continue;
            const x = Math.floor(pr[k * 3]), y = Math.floor(pr[k * 3 + 1]), d = pr[k * 3 + 2];
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const idx = y * w + x;
            if (d <= zb[idx] + BIAS) px[idx] = pal[d < -0.35 ? 4 : d < 0.45 ? 3 : 2];
          }
        }
      } else {
        this.floor(P);
      }

      this.box(P);
      if (o.labels) this.labels(P, o.labels);
      this.ctx.putImageData(this.img, 0, 0);
    }

    face(pos, pr, a, b, c, lo, hi, phase) {
      let v = lo;
      if (hi > lo) {
        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
        const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const m = Math.hypot(nx, ny, nz) || 1;
        let inten = 0.12 + 0.88 * Math.abs((nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / m);
        // Complex mode: the argument of w modulates brightness (monochrome domain colouring).
        if (phase) inten *= 0.3 + 0.7 * phase[a];
        v = lo + inten * (hi - lo);
      }
      this.tri(pr[a * 3], pr[a * 3 + 1], pr[a * 3 + 2],
        pr[b * 3], pr[b * 3 + 1], pr[b * 3 + 2],
        pr[c * 3], pr[c * 3 + 1], pr[c * 3 + 2], v);
    }

    tri(ax, ay, ad, bx, by, bd, cx, cy, cd, v) {
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (!area || !isFinite(area)) return;
      const { w, h, px, zb, pal } = this;
      const inv = 1 / area;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
      const base = Math.min(4, Math.floor(v)), frac = v - base;
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5, row = (y & 3) << 2;
        for (let x = x0; x <= x1; x++) {
          const qx = x + 0.5;
          const w0 = ((bx - qx) * (cy - py) - (cx - qx) * (by - py)) * inv;
          if (w0 < -EPS) continue;
          const w1 = ((cx - qx) * (ay - py) - (ax - qx) * (cy - py)) * inv;
          if (w1 < -EPS) continue;
          const w2 = 1 - w0 - w1;
          if (w2 < -EPS) continue;
          const d = w0 * ad + w1 * bd + w2 * cd;
          const idx = y * w + x;
          if (d < zb[idx]) {
            zb[idx] = d;
            px[idx] = pal[frac > BAYER[row | (x & 3)] ? base + 1 : base];
          }
        }
      }
    }

    // Depth tested line; lines never write the z-buffer so they cannot hide each other.
    line(x0, y0, d0, x1, y1, d1, col, dotted) {
      const { w, h, px, zb } = this;
      const dx = x1 - x0, dy = y1 - y0;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
      if (!(steps < 5000)) return;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = Math.floor(x0 + dx * t), y = Math.floor(y0 + dy * t);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (dotted && ((x + y) & 1)) continue;
        const idx = y * w + x;
        if (d0 + (d1 - d0) * t <= zb[idx] + BIAS) px[idx] = col;
      }
    }

    line3(P, a, b, col, dotted) {
      const p = P(a[0], a[1], a[2]), q = P(b[0], b[1], b[2]);
      this.line(p[0], p[1], p[2], q[0], q[1], q[2], col, dotted);
    }

    floor(P) {
      const col = this.pal[1];
      for (let m = 0; m <= 8; m++) {
        const u = -1 + m / 4;
        this.line3(P, [u, -1, -HZ], [u, 1, -HZ], col, true);
        this.line3(P, [-1, u, -HZ], [1, u, -HZ], col, true);
      }
    }

    box(P) {
      const col = this.pal[1];
      const c = [-1, 1];
      for (const a of c) {
        for (const b of c) {
          this.line3(P, [-1, a, b * HZ], [1, a, b * HZ], col, false);
          this.line3(P, [a, -1, b * HZ], [a, 1, b * HZ], col, false);
          this.line3(P, [a, b, -HZ], [a, b, HZ], col, false);
        }
      }
    }

    // Axis labels go on the box edges nearest to the viewer, so the surface never covers them.
    labels(P, L) {
      const s = this.ts;
      const lab = (x, y, z, str, lvl, align) => {
        if (!str) return;
        const p = P(x, y, z);
        this.text(str, p[0], p[1], lvl, s, align);
      };
      const ey = P(0, -1, -HZ)[2] < P(0, 1, -HZ)[2] ? -1 : 1;
      const ex = P(-1, 0, -HZ)[2] < P(1, 0, -HZ)[2] ? -1 : 1;
      lab(-0.75, ey * 1.3, -HZ, L.x0, 2);
      lab(0.75, ey * 1.3, -HZ, L.x1, 2);
      lab(0, ey * 1.4, -HZ, L.xn, 3);
      lab(ex * 1.3, -0.75, -HZ, L.y0, 2);
      lab(ex * 1.3, 0.75, -HZ, L.y1, 2);
      lab(ex * 1.4, 0, -HZ, L.yn, 3);

      // Z on the vertical edge that appears leftmost on screen.
      let best = null;
      for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = P(cx, cy, 0);
        if (!best || p[0] < best.x) best = { x: p[0], cx, cy };
      }
      const pad = 4 * s * this.ax;
      const zl = (z, str, lvl) => {
        const p = P(best.cx, best.cy, z);
        this.text(str, p[0] - pad, p[1], lvl, s, 'right');
      };
      zl(-HZ, L.z0, 2);
      zl(HZ, L.z1, 2);
      zl(0, L.zn, 3);
    }

    // Bitmap text centred on (x, y) (or right aligned), with a background cell behind it.
    text(str, x, y, lvl, s, align) {
      const { w, h, px, pal } = this;
      str = String(str).toUpperCase();
      const sx = s * this.ax, sy = s;
      const cw = 4 * sx, tw = str.length * cw - sx, th = 5 * sy;
      const X = Math.round(align === 'right' ? x - tw : x - tw / 2), Y = Math.round(y - th / 2);
      const put = (xx, yy, col) => {
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) px[yy * w + xx] = col;
      };
      for (let yy = Y - sy; yy < Y + th + sy; yy++) {
        for (let xx = X - sx; xx < X + tw + sx; xx++) put(xx, yy, pal[0]);
      }
      const col = pal[lvl];
      for (let k = 0; k < str.length; k++) {
        const g = GLYPHS[str[k]];
        if (!g) continue;
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 3; c++) {
            if (g[r * 3 + c] !== '1') continue;
            for (let a = 0; a < sy; a++) {
              for (let b = 0; b < sx; b++) put(X + k * cw + c * sx + b, Y + r * sy + a, col);
            }
          }
        }
      }
    }
  }

  Plotter.HZ = HZ;
  global.Plotter = Plotter;
})(window);
