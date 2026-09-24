/*
 * LIRUX 3D: the "computers". Three machines share one plotter:
 *   c128  an 8-bit home computer BASIC, 80 column hi-res (twice the pixels both ways)
 *   c64   its 64 mode, reached with GO64, 40 columns
 *   tty   an amber serial terminal dialled into a time-sharing box, reached with TERM
 * Plus boot sequences, tape loading border and F keys.
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const canvas = $('plot'), plotwrap = $('plotwrap'), term = $('term'), out = $('out');
  const cmd = $('cmd'), mirror = $('mirror'), statusEl = $('status'), tape = $('tape');
  const { compile, BasicError, functionNames } = window.MathParser;
  const plotter = new window.Plotter(canvas);
  const HZ = window.Plotter.HZ;

  const STYLES = ['wire', 'solid', 'mesh', 'dots'];

  // The 16 colours of the classic breadbox-era video chip.
  const PAL16 = {
    black: '#000000', white: '#ffffff', red: '#68372b', cyan: '#70a4b2',
    purple: '#6f3d86', green: '#588d43', blue: '#352879', yellow: '#b8c76f',
    orange: '#6f4f25', brown: '#433900', lightred: '#9a6759', darkgrey: '#444444',
    grey: '#6c6c6c', lightgreen: '#9ad284', lightblue: '#6c5eb5', lightgrey: '#959595',
  };

  const MACHINES = {
    c128: {
      theme: 'c128', dx: 2, dy: 2, basic: true,
      ramp: [PAL16.darkgrey, PAL16.grey, PAL16.green, PAL16.lightgreen, PAL16.white],
    },
    c64: {
      theme: 'c64', dx: 1, dy: 1, basic: true,
      ramp: [PAL16.blue, PAL16.purple, PAL16.lightblue, PAL16.cyan, PAL16.white],
    },
    tty: { theme: 'amber', dx: 2, dy: 1, basic: false, ramp: null },
  };

  let user = 'guest';
  let loginPrompt = false; // waiting for a name after login:
  let wopr = null; // step of the conversation with the war games computer, when connected to it
  const prompt = () => {
    if (!isTty() || wopr) return '';
    return loginPrompt ? 'login: ' : `${user}@lirux:~$ `;
  };

  const DEMOS = [
    { name: 'sombrero', e: 'sin(r)/r', range: [-12, 12, -12, 12], grid: 44, style: 'wire' },
    { name: 'eggbox', e: 'sin(x)*cos(y)', range: [-5, 5, -5, 5], grid: 40, style: 'wire' },
    { name: 'ripple', e: 'cos(r-2t)*exp(-r/6)', range: [-10, 10, -10, 10], grid: 44, style: 'mesh' },
    { name: 'monkey', e: 'x^3-3x*y^2', range: [-1.5, 1.5, -1.5, 1.5], grid: 32, style: 'solid' },
    { name: 'hills', e: '(x^2+3y^2)*exp(1-x^2-y^2)', range: [-2.5, 2.5, -2.5, 2.5], grid: 40, style: 'solid' },
    { name: 'pond', e: 'sin(x^2+y^2-t)/(1+x^2+y^2)', range: [-4, 4, -4, 4], grid: 48, style: 'wire' },
    { name: 'poles', e: '1/(z^2+1)', range: [-2, 2, -2, 2], grid: 48, style: 'mesh', view: 'abs' },
    { name: 'gamma', e: 'gamma(z)', range: [-4.5, 4.5, -2, 2], grid: 56, style: 'solid', view: 'log' },
    { name: 'sine', e: 'sin(z)', range: [-4, 4, -2, 2], grid: 40, style: 'mesh', view: 're' },
    { name: 'spiral', e: 'log(z)', range: [-2, 2, -2, 2], grid: 40, style: 'mesh', view: 'im' },
    { name: 'roots', e: 'z^3-1', range: [-1.6, 1.6, -1.6, 1.6], grid: 44, style: 'solid', view: 'abs' },
  ];

  const state = {
    machine: 'c128',
    home: 'c128', // the machine the terminal session was started from
    src: '',
    prog: null,
    range: [-5, 5, -5, 5],
    zrange: null,
    grid: 40,
    style: 'wire',
    view: 'abs',
    yaw: -0.65,
    pitch: 0.55,
    zoom: 1,
    spin: false,
    t: 0,
    demo: -1,
  };

  let mesh = null, meshDirty = false, dirty = true;
  let scaleLo = 0, scaleHi = 1, keepScale = false;

  const isTty = () => state.machine === 'tty';
  // Write a command the way the current machine expects it.
  const say = s => (isTty() ? s.toLowerCase() : s.toUpperCase());

  /* ---------- storage (per viewer convenience only) ---------- */

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  /* ---------- terminal ---------- */

  function print(text = '', cls) {
    for (const ln of String(text).split('\n')) {
      const d = document.createElement('div');
      d.textContent = ln || ' ';
      if (cls) d.className = cls;
      out.append(d);
    }
    while (out.childNodes.length > 300) out.firstChild.remove();
    term.scrollTop = term.scrollHeight;
  }

  function cls() {
    out.textContent = '';
  }

  function updateMirror() {
    const v = cmd.value;
    const p = cmd.selectionStart == null ? v.length : cmd.selectionStart;
    mirror.textContent = prompt();
    mirror.append(document.createTextNode(v.slice(0, p)));
    const cur = document.createElement('span');
    cur.className = 'cur';
    cur.textContent = v[p] || ' ';
    mirror.append(cur);
    mirror.append(document.createTextNode(v.slice(p + 1)));
  }

  const SHELL_ERRORS = {
    'SYNTAX': 'syntax error',
    "UNDEF'D FUNCTION": 'undefined function',
    'MISSING OPERAND': 'missing operand',
    'ILLEGAL QUANTITY': 'invalid argument',
    "UNDEF'D STATEMENT": 'nothing to plot',
  };

  function reportError(e, where) {
    const code = e instanceof BasicError ? e.code : 'SYNTAX';
    const detail = e instanceof BasicError && e.detail ? String(e.detail) : '';
    if (isTty()) {
      print(`${where}: ${detail ? detail.toLowerCase() + ': ' : ''}${SHELL_ERRORS[code] || 'error'}`);
    } else {
      print(`?${code} ERROR${detail ? ' IN ' + detail.toUpperCase() : ''}`);
    }
  }

  /* ---------- formatting ---------- */

  function fmt(v) {
    if (!Number.isFinite(v)) return '?';
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e4 || a < 1e-2)) return v.toExponential(1).toUpperCase().replace('E+', 'E');
    return String(+v.toFixed(a >= 100 ? 0 : 2));
  }

  const isComplex = () => state.prog && state.prog.mode === 'complex';
  const lhs = () => (isComplex() ? { re: 'RE W', im: 'IM W', abs: '|W|', log: 'LN|W|' }[state.view] : 'Z');

  function updateStatus() {
    const l = statusEl.querySelector('.l'), r = statusEl.querySelector('.r');
    l.textContent = state.prog ? say(`${lhs()}=${state.src}`) : say('no function');
    const bits = [state.style, `${state.grid}x${state.grid}`, `${plotter.w}x${plotter.h}`];
    if (state.spin) bits.push('spin');
    if (state.prog && state.prog.usesT) bits.push('t=' + state.t.toFixed(1));
    r.textContent = say(bits.join('  '));
  }

  /* ---------- sampling and mesh ---------- */

  const env = { x: 0, y: 0, t: 0, r: 0, th: 0 };
  const cenv = { z: [0, 0], x: [0, 0], y: [0, 0], t: [0, 0], r: [0, 0], th: [0, 0] };
  let sH = 0, sP = 0;

  function sample(x, y) {
    const p = state.prog;
    if (p.mode === 'real') {
      env.x = x; env.y = y; env.t = state.t;
      env.r = Math.hypot(x, y); env.th = Math.atan2(y, x);
      sH = p.fn(env);
      sP = 0;
    } else {
      cenv.z = [x, y]; cenv.x = [x, 0]; cenv.y = [y, 0]; cenv.t = [state.t, 0];
      cenv.r = [Math.hypot(x, y), 0]; cenv.th = [Math.atan2(y, x), 0];
      const w = p.fn(cenv);
      const m = Math.hypot(w[0], w[1]);
      sH = state.view === 're' ? w[0] : state.view === 'im' ? w[1] : state.view === 'log' ? Math.log(m) : m;
      sP = Number.isFinite(m) ? (Math.atan2(w[1], w[0]) / (2 * Math.PI) + 1) % 1 : 0;
    }
  }

  function buildMesh() {
    const n = state.grid, N1 = n + 1, cnt = N1 * N1;
    if (!mesh || mesh.n !== n) {
      mesh = {
        n,
        pos: new Float32Array(cnt * 3),
        valid: new Uint8Array(cnt),
        phase: new Float32Array(cnt),
        raw: new Float64Array(cnt),
        vals: new Float64Array(cnt),
      };
    }
    const [x0, x1, y0, y1] = state.range;
    const nx = (x1 - x0) * 1e-7, ny = (y1 - y0) * 1e-7;
    let nv = 0;
    for (let j = 0; j < N1; j++) {
      for (let i = 0; i < N1; i++) {
        const k = j * N1 + i;
        const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * j / n;
        sample(x, y);
        // 0/0 at a single point (sin(r)/r at the origin): look right next to it.
        if (Number.isNaN(sH)) sample(x + nx, y + ny);
        mesh.raw[k] = sH;
        mesh.phase[k] = sP;
        const ok = Number.isFinite(sH);
        mesh.valid[k] = ok ? 1 : 0;
        if (ok) mesh.vals[nv++] = sH;
      }
    }

    let lo, hi;
    if (state.zrange) {
      [lo, hi] = state.zrange;
    } else if (!nv) {
      lo = -1; hi = 1;
    } else {
      // Robust autoscale: follow the data, but clip poles and spikes.
      const v = mesh.vals.subarray(0, nv).sort();
      const q = f => v[Math.min(nv - 1, Math.floor(f * (nv - 1)))];
      const p1 = q(0.01), p99 = q(0.99), s = p99 - p1;
      lo = Math.max(v[0], p1 - 2 * s);
      hi = Math.min(v[nv - 1], p99 + 2 * s);
      if (hi - lo < 1e-9) {
        const c = (hi + lo) / 2, d = Math.max(1e-3, Math.abs(c) * 0.1);
        lo = c - d; hi = c + d;
      }
      if (keepScale) { lo = Math.min(lo, scaleLo); hi = Math.max(hi, scaleHi); }
    }
    scaleLo = lo; scaleHi = hi;
    keepScale = !!(state.prog && state.prog.usesT);

    const pos = mesh.pos, inv = 2 / (hi - lo);
    for (let j = 0; j < N1; j++) {
      for (let i = 0; i < N1; i++) {
        const k = j * N1 + i;
        let z = (mesh.raw[k] - lo) * inv - 1;
        z = z < -1 ? -1 : z > 1 ? 1 : z;
        pos[k * 3] = -1 + 2 * i / n;
        pos[k * 3 + 1] = -1 + 2 * j / n;
        pos[k * 3 + 2] = (mesh.valid[k] ? z : 0) * HZ;
      }
    }
  }

  function render() {
    const cplx = isComplex();
    const [x0, x1, y0, y1] = state.range;
    const labels = {
      x0: fmt(x0), x1: fmt(x1), y0: fmt(y0), y1: fmt(y1),
      z0: fmt(scaleLo), z1: fmt(scaleHi),
      xn: cplx ? 'RE' : 'X', yn: cplx ? 'IM' : 'Y', zn: state.prog ? lhs() : 'Z',
    };
    const m = state.prog && mesh
      ? { n: mesh.n, pos: mesh.pos, valid: mesh.valid, phase: cplx ? mesh.phase : null }
      : null;
    plotter.render(m, state, { style: state.style, labels });
    updateStatus();
  }

  /* ---------- layout ---------- */

  // The 64 has about 320x200 square pixels. The 128 splits each of them in
  // four (like the 640x400 interlaced mode of an 80 column video chip); the
  // terminal only splits them horizontally (80 columns, 640x200 style).
  function layout() {
    // Measure the screen, not the plot: the plot is hidden on text-only screens.
    const availW = $('display').clientWidth;
    if (!availW) return;
    const { dx, dy, basic } = MACHINES[state.machine];

    // Terminal text as large as the line allows: 40 columns of square
    // characters on the home computers, 80 columns (0.4em wide) on the terminal.
    const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, Math.floor(v)));
    const fs = basic ? clamp(8, 16, (availW - 18) / 40) : clamp(18, 28, (availW - 18) / 32);
    document.documentElement.style.setProperty('--term-size', fs + 'px');
    const termH = fs * (basic ? 1.6 : 1.05) * 7 + 8;

    const p = Math.max(1, Math.round(availW / 320));
    const small = window.innerWidth <= 720;
    const reserve = (small ? 240 : 330) + termH;
    const targetH = Math.min(availW * 0.62, Math.max(small ? 200 : 260, window.innerHeight - reserve));
    const cols = Math.floor(availW / p), rows = Math.max(60, Math.floor(targetH / p));
    const w = cols * dx, h = rows * dy;
    canvas.style.width = cols * p + 'px';
    canvas.style.height = rows * p + 'px';
    plotwrap.style.height = rows * p + 'px';
    plotter.ax = dx / dy;
    plotter.ts = dy;
    if (w !== plotter.w || h !== plotter.h) plotter.resize(w, h);
    applyTextMode();
    dirty = true;
  }

  // Full screen text, as before a program draws anything: the plot and the
  // status line are hidden and the terminal takes all of their room.
  let textMode = false;
  const display = $('display');
  function applyTextMode() {
    display.classList.remove('textmode');
    term.style.height = '';
    if (!textMode) return;
    const room = plotwrap.offsetHeight + statusEl.offsetHeight + term.offsetHeight;
    display.classList.add('textmode');
    term.style.height = room + 'px';
  }
  function setTextMode(on) {
    textMode = on;
    applyTextMode();
    term.scrollTop = term.scrollHeight;
  }

  /* ---------- machines ---------- */

  const hexRgb = hex => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim()) || [0, 'ff', 'b0', '00'];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  };

  function setMachine(name) {
    const m = MACHINES[name];
    state.machine = name;
    document.documentElement.dataset.theme = m.theme;
    if (m.ramp) {
      plotter.setPalette(m.ramp.map(hexRgb));
    } else {
      const fg = getComputedStyle(document.documentElement).getPropertyValue('--fg');
      plotter.setMonochrome(...hexRgb(fg));
    }
    store.set('lirux3d.machine', name);
    store.set('lirux3d.home', state.home);
    updateKeys();
    layout();
    updateMirror();
    meshDirty = true;
  }

  /* ---------- tape loading border ---------- */

  let tapeUntil = 0;
  const tctx = tape.getContext('2d');
  const PAL_LIST = Object.values(PAL16);

  function tapeLoad(ms = 900) {
    if (!MACHINES[state.machine].basic) return;
    tapeUntil = performance.now() + ms;
    tape.classList.add('on');
  }

  function drawTape(now) {
    if (now > tapeUntil) {
      if (tape.classList.contains('on')) tape.classList.remove('on');
      return;
    }
    let y = 0;
    while (y < tape.height) {
      const hh = 1 + ((Math.random() * 7) | 0);
      tctx.fillStyle = PAL_LIST[(Math.random() * PAL_LIST.length) | 0];
      tctx.fillRect(0, y, 1, hh);
      y += hh;
    }
  }

  /* ---------- plotting ---------- */

  function plot(src, quiet) {
    const s = src.trim().replace(/^['"]|['"]$/g, '')
      .replace(/^(def\s*)?(fn\s*)?[a-z]+\s*(\([^)]*\))?\s*=/i, '').trim();
    let prog;
    try {
      prog = compile(s);
      // Probe once so that runtime surprises surface as an error, not a blank screen.
      const saved = state.prog;
      state.prog = prog;
      try { sample(0.123, 0.456); } finally { state.prog = saved; }
    } catch (e) {
      reportError(e, 'plot');
      return false;
    }
    state.src = s.toLowerCase();
    state.prog = prog;
    setTextMode(false);
    state.t = 0;
    keepScale = false;
    meshDirty = true;
    tapeLoad();
    try { history.replaceState(null, '', '#' + encodeURIComponent(state.src)); } catch (e) { /* file:// */ }
    if (!quiet && prog.mode === 'complex') print(say(`complex mode: height=${lhs()}, brightness=arg w`));
    return true;
  }

  function findDemo(arg) {
    const n = parseInt(arg, 10);
    if (Number.isFinite(n)) return ((n - 1) % DEMOS.length + DEMOS.length) % DEMOS.length;
    if (arg) {
      const i = DEMOS.findIndex(d => d.name === arg.replace(/\.fn$/, ''));
      if (i < 0) throw new BasicError('ILLEGAL QUANTITY', arg);
      return i;
    }
    return (state.demo + 1) % DEMOS.length;
  }

  function applyDemo(i, quiet) {
    const d = DEMOS[i];
    state.demo = i;
    state.range = d.range.slice();
    state.grid = d.grid;
    state.style = d.style;
    state.view = d.view || 'abs';
    state.zrange = null;
    if (!quiet) print(isTty() ? `# ${d.name}.fn: ${d.e}` : `DEMO ${i + 1}/${DEMOS.length}: ${d.e}`);
    plot(d.e, true);
  }

  /* ---------- commands ---------- */

  const HELP_BASIC = [
    'TYPE A FORMULA AND PRESS RETURN:',
    '  SIN(X)*COS(Y)     Z=F(X,Y)',
    '  Z^3-1             W=F(Z), COMPLEX',
    'VARIABLES: X Y R TH T(TIME)  Z I',
    'COMMANDS:',
    '  RUN               DRAW THE PLOT AGAIN',
    '  RANGE A B [C D]   ZRANGE A B|AUTO',
    '  GRID N  STYLE WIRE|SOLID|MESH|DOTS',
    '  VIEW ABS|LOG|RE|IM   SPIN [ON|OFF]',
    '  DEMO [N]  LIST  FUNCS  HOME  SAVE  CLS',
  ];

  const HELP_SHELL = [
    'PLOT(1)                 LIRUX manual                 PLOT(1)',
    '',
    'usage: plot EXPR      z=f(x,y), or w=f(z) when using z or i',
    '       plot \'sin(x)*cos(y)\'   plot z^3-1',
    'vars:  x y r th t(time) z i',
    '',
    '  range A B [C D]    zrange A B|auto    grid N',
    '  style wire|solid|mesh|dots    view abs|log|re|im',
    '  run                draw the plot again',
    '  spin [on|off]  home  demo [N|NAME]  ls  cat',
    '  funcs  save [NAME]  clear  exit',
    '',
    'BUGS',
    '  Prof. Falken left a backdoor account on this box.',
    '  Nobody remembers its name. Try logging in as him.',
  ];

  function help() {
    if (isTty()) return print(HELP_SHELL.join('\n'));
    const extra = state.machine === 'c128'
      ? '  GO64  TERM (DIAL THE MAINFRAME)  RESET'
      : '  TERM (DIAL THE MAINFRAME)\n  RESET (BACK TO 128 MODE)';
    print(HELP_BASIC.concat(extra, '', 'SHALL WE PLAY A GAME? TERM, THEN LOGIN').join('\n'));
  }

  const num = s => {
    if (s == null || s === '') return NaN;
    try {
      const p = compile(s);
      return p.mode === 'real' ? p.fn({ x: 0, y: 0, t: 0, r: 0, th: 0 }) : NaN;
    } catch (e) {
      return NaN;
    }
  };

  function listing() {
    const cplx = isComplex();
    const [x0, x1, y0, y1] = state.range.map(fmt);
    const zr = state.zrange ? state.zrange.map(fmt) : null;
    if (isTty()) {
      print([
        '#!/usr/local/bin/plot',
        `range ${x0} ${x1} ${y0} ${y1}`,
        `zrange ${zr ? zr.join(' ') : 'auto'}`,
        `grid ${state.grid}; style ${state.style}${cplx ? '; view ' + state.view : ''}`,
        `plot '${state.src || '0'}'`,
      ].join('\n'));
    } else {
      print([
        '10 REM LIRUX 3D SURFACE',
        `20 DEF FN ${cplx ? 'W(Z)' : 'Z(X,Y)'}=${state.src || '0'}`,
        `30 RANGE ${x0},${x1},${y0},${y1}`,
        `40 ZRANGE ${zr ? zr.join(',') : 'AUTO'}`,
        `50 GRID ${state.grid}:STYLE ${state.style}${cplx ? ':VIEW ' + state.view : ''}`,
        '60 PLOT',
      ].join('\n'));
    }
  }

  // Commands shared by every machine.
  const COMMANDS = {
    help,
    funcs: () => print(say('functions:\n' + functionNames.join(' ') + '\nalso: n! |x| pi e tau phi ^ %')),
    list: listing,
    demo(a) { applyDemo(findDemo(a[0])); },
    range(a) {
      const v = a.map(num);
      if (v.length === 2) v.push(v[0], v[1]);
      if (v.length !== 4 || v.some(x => !Number.isFinite(x)) || v[0] >= v[1] || v[2] >= v[3]) {
        throw new BasicError('ILLEGAL QUANTITY');
      }
      state.range = v;
      meshDirty = true;
      keepScale = false;
    },
    zrange(a) {
      if (!a.length || a[0] === 'auto') {
        state.zrange = null;
      } else {
        const v = a.map(num);
        if (v.length !== 2 || v.some(x => !Number.isFinite(x)) || v[0] >= v[1]) throw new BasicError('ILLEGAL QUANTITY');
        state.zrange = v;
      }
      meshDirty = true;
      keepScale = false;
    },
    grid(a) {
      const n = parseInt(a[0], 10);
      if (!(n >= 8 && n <= 96)) throw new BasicError('ILLEGAL QUANTITY');
      state.grid = n;
      meshDirty = true;
    },
    style(a) {
      const s = a[0] || STYLES[(STYLES.indexOf(state.style) + 1) % STYLES.length];
      if (!STYLES.includes(s)) throw new BasicError('ILLEGAL QUANTITY', s);
      state.style = s;
      dirty = true;
    },
    view(a) {
      const s = a[0];
      if (!['abs', 'log', 're', 'im'].includes(s)) throw new BasicError('ILLEGAL QUANTITY', s);
      state.view = s;
      meshDirty = true;
      keepScale = false;
      if (!isComplex()) print(say('note: view only affects complex functions'));
    },
    spin(a) {
      state.spin = a[0] === 'on' ? true : a[0] === 'off' ? false : !state.spin;
      dirty = true;
    },
    home() {
      Object.assign(state, { yaw: -0.65, pitch: 0.55, zoom: 1, spin: false });
      dirty = true;
    },
    run() {
      if (!state.prog) throw new BasicError('UNDEF\'D STATEMENT');
      state.t = 0;
      keepScale = false;
      meshDirty = true;
      setTextMode(false);
      tapeLoad();
    },
    plot(a, rest) { if (rest) plot(rest); else COMMANDS.run(); },
    save(a) {
      const name = (a.join(' ').replace(/["']/g, '').trim() || 'plot').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const k = Math.max(2, Math.round(1280 / plotter.w));
      const c = document.createElement('canvas');
      c.width = plotter.w * k;
      c.height = Math.round(plotter.h * k * plotter.ax);
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(canvas, 0, 0, c.width, c.height);
      c.toBlob(b => {
        if (!b) return;
        const link = document.createElement('a');
        link.href = URL.createObjectURL(b);
        link.download = name + '.png';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      });
      if (!isTty()) print(`SAVING "${name.toUpperCase()}"`);
    },
  };

  // Commands that only exist in the home computer BASIC.
  const BASIC_COMMANDS = {
    cls,
    new: cls,
    go64() {
      if (state.machine !== 'c128') throw new BasicError('SYNTAX');
      print('ARE YOU SURE?');
      pending = answer => { if (/^y/i.test(answer)) sequence(go64); };
    },
    term: () => sequence(dialUp),
    reset: () => sequence(hardReset),
  };

  // Commands that only exist on the time-sharing box.
  const SHELL_COMMANDS = {
    clear: cls,
    man: help,
    exit: () => sequence(logout),
    logout: () => sequence(logout),
    ls: () => print(DEMOS.map(d => (d.name + '.fn').padEnd(13)).join('').replace(/(.{65})/g, '$1\n').trimEnd()),
    cat(a) {
      if (!a[0]) return listing();
      const d = DEMOS[findDemo(a[0])];
      print(`#!/usr/local/bin/plot\nrange ${d.range.join(' ')}\ngrid ${d.grid}; style ${d.style}\nplot '${d.e}'`);
    },
    whoami: () => print(user),
    uname: () => print('LIRUX lirux 4.3 m68k'),
  };

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const history_ = [];
  let hIdx = 0;
  let pending = null; // an answer the machine is waiting for (ARE YOU SURE?)

  function exec(line) {
    const raw = line.trim();
    print(prompt() + line);
    if (pending) {
      const p = pending;
      pending = null;
      loginPrompt = false;
      p(raw);
      if (!busy && !isTty()) print('READY.');
      updateMirror();
      return;
    }
    if (wopr) {
      woprInput(raw);
      return;
    }
    if (raw && history_[history_.length - 1] !== raw) history_.push(raw);
    hIdx = history_.length;

    const tty = isTty();
    const m = /^([a-z][a-z0-9]*)(?:\s+(.*))?$/i.exec(raw);
    const word = m && m[1].toLowerCase();
    const own = tty ? SHELL_COMMANDS : BASIC_COMMANDS;
    const other = tty ? BASIC_COMMANDS : SHELL_COMMANDS;
    try {
      if (!raw) {
        // nothing
      } else if (raw === '?') {
        help();
      } else if (word && (has(COMMANDS, word) || has(own, word))) {
        const rest = (m[2] || '').trim();
        const args = rest ? rest.toLowerCase().replace(/["']/g, '').split(/[\s,;]+/).filter(Boolean) : [];
        (has(own, word) ? own : COMMANDS)[word](args, rest);
      } else if (word && has(other, word) && !m[2]) {
        if (tty) print(`sh: ${word}: command not found`);
        else throw new BasicError('SYNTAX');
      } else {
        plot(raw);
      }
    } catch (e) {
      reportError(e, word && (has(COMMANDS, word) || has(own, word)) ? word : 'plot');
    }
    if (!tty && !busy && !pending) print('READY.');
  }

  /* ---------- function keys ---------- */

  const FKEYS = [
    { k: 'F1', label: () => (isTty() ? 'MAN' : 'HELP'), run: () => exec(isTty() ? 'man plot' : 'HELP') },
    { k: 'F2', label: () => 'STYLE', run: () => exec(say('style ' + STYLES[(STYLES.indexOf(state.style) + 1) % STYLES.length])) },
    { k: 'F3', label: () => (isTty() ? 'EXIT' : 'TERM'), run: () => exec(say(isTty() ? 'exit' : 'term')) },
    { k: 'F4', label: () => 'SPIN', run: () => exec(say('spin ' + (state.spin ? 'off' : 'on'))) },
    { k: 'F5', label: () => 'DEMO', run: () => exec(say('demo')) },
    { k: 'F6', label: () => 'HOME', run: () => exec(say('home')) },
    {
      k: 'F7',
      label: () => ({ c128: 'GO64', c64: 'RESET', tty: 'CLEAR' }[state.machine]),
      run: () => exec({ c128: 'GO64', c64: 'RESET', tty: 'clear' }[state.machine]),
    },
    { k: 'F8', label: () => 'SAVE', run: () => exec(say('save "plot"')) },
  ];

  const keysEl = $('keys');
  FKEYS.forEach(f => {
    const b = document.createElement('button');
    b.className = 'key';
    b.type = 'button';
    b.innerHTML = `<span class="fk">${f.k}</span><span class="lb"></span>`;
    b.addEventListener('click', () => pressKey(FKEYS.indexOf(f)));
    f.el = b;
    keysEl.append(b);
  });

  function updateKeys() {
    FKEYS.forEach(f => { f.el.querySelector('.lb').textContent = f.label(); });
  }

  function pressKey(i) {
    const f = FKEYS[i];
    f.el.classList.add('down');
    setTimeout(() => f.el.classList.remove('down'), 120);
    if (busy) { skipSeq(); return; }
    f.run();
    // Give the keyboard back to the command line, so ARE YOU SURE? can be answered right away.
    // On touch screens only when an answer is awaited, to avoid popping up the keyboard for nothing.
    if (pending || window.matchMedia('(pointer: fine)').matches) cmd.focus({ preventScroll: true });
  }

  /* ---------- input handling ---------- */

  cmd.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = cmd.value;
      cmd.value = '';
      if (busy) {
        skipSeq();
        seqDone.then(() => { if (v.trim()) exec(v); });
      } else {
        exec(v);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hIdx > 0) cmd.value = history_[--hIdx];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      hIdx = Math.min(history_.length, hIdx + 1);
      cmd.value = history_[hIdx] || '';
    } else if (e.key === 'Escape') {
      cmd.value = '';
    } else if (e.key === 'l' && e.ctrlKey && isTty()) {
      e.preventDefault();
      cls();
    }
    requestAnimationFrame(updateMirror);
  });
  ['input', 'keyup', 'click', 'focus', 'blur', 'select'].forEach(ev => cmd.addEventListener(ev, updateMirror));
  document.addEventListener('selectionchange', () => { if (document.activeElement === cmd) updateMirror(); });
  term.addEventListener('click', () => { if (!window.getSelection().toString()) cmd.focus(); });

  document.addEventListener('keydown', e => {
    const fk = /^F([1-8])$/.exec(e.key);
    if (fk) {
      e.preventDefault();
      pressKey(+fk[1] - 1);
      return;
    }
    if (busy && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (typing) cmd.value = '';
      skipSeq();
    }
    if (e.target === cmd || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest('button')) return;
    const step = 0.08;
    switch (e.key) {
      case 'ArrowLeft': state.yaw += step; break;
      case 'ArrowRight': state.yaw -= step; break;
      case 'ArrowUp': state.pitch = Math.min(1.5, state.pitch + step); break;
      case 'ArrowDown': state.pitch = Math.max(-1.5, state.pitch - step); break;
      case '+': case '=': state.zoom = Math.min(3, state.zoom * 1.1); break;
      case '-': case '_': state.zoom = Math.max(0.4, state.zoom / 1.1); break;
      default:
        if (e.key.length === 1) cmd.focus();
        return;
    }
    e.preventDefault();
    dirty = true;
  });

  /* ---------- mouse and touch ---------- */

  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    state.yaw -= dx * 0.008;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + dy * 0.008));
    dirty = true;
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    state.zoom = Math.max(0.4, Math.min(3, state.zoom * Math.exp(-e.deltaY * 0.0015)));
    dirty = true;
  }, { passive: false });

  window.addEventListener('resize', layout);

  /* ---------- main loop ---------- */

  let last = performance.now(), lastStatus = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.prog && state.prog.usesT) {
      state.t += dt;
      meshDirty = true;
    }
    if (state.spin) {
      state.yaw += dt * 0.35;
      dirty = true;
    }
    if (meshDirty && state.prog) {
      buildMesh();
      meshDirty = false;
      dirty = true;
    }
    if (dirty) {
      render();
      dirty = false;
      lastStatus = now;
    } else if (now - lastStatus > 500) {
      updateStatus();
      lastStatus = now;
    }
    drawTape(now);
    requestAnimationFrame(frame);
  }

  /* ---------- scripted sequences (boot, GO64, dial up, logout) ---------- */

  // A sequence plays out with small delays; any key press fast forwards it.
  let busy = false, skip = false, typing = false, seqDone = Promise.resolve();
  const skipWaiters = [];
  const sleep = ms => new Promise(res => {
    if (skip) return res();
    const id = setTimeout(res, ms);
    skipWaiters.push(() => { clearTimeout(id); res(); });
  });
  function skipSeq() {
    if (!busy) return;
    skip = true;
    skipWaiters.splice(0).forEach(f => f());
  }
  function sequence(fn) {
    busy = true;
    skip = false;
    seqDone = seqDone.then(fn).catch(() => {}).then(() => {
      busy = false;
      skip = false;
      typing = false;
      updateMirror();
    });
    return seqDone;
  }

  // Pretend someone types on the command line.
  async function typeIn(text) {
    typing = true;
    for (let i = 1; i <= text.length && !skip; i++) {
      cmd.value = text.slice(0, i);
      updateMirror();
      await sleep(45);
    }
    await sleep(180);
    if (typing && text.startsWith(cmd.value)) cmd.value = '';
    typing = false;
    updateMirror();
    print(prompt() + text);
  }

  // Banner lines are centred on the screen; READY. stays at the left margin.
  const BANNER_C128 = [
    'LIRUX BASIC V7.0 122365 BYTES FREE',
    '(C)1985 LIRUX ELECTRONICS, LTD.',
    '(C)1977 ALBERTOSOFT CORP.',
    'ALL RIGHTS RESERVED',
  ];

  const BANNER_C64 = [
    '**** LIRUX 64 BASIC V2 ****',
    '',
    '64K RAM SYSTEM  38911 BASIC BYTES FREE',
  ];

  function banner(lines) {
    print(lines.join('\n'), 'center');
    print('\nREADY.');
  }

  // Ask for a name at the login: prompt. One of them is not a user of this box.
  function askLogin(banner = true) {
    if (banner) print('\nLIRUX 4.3 BSoD (lirux) (tty01)\n');
    loginPrompt = true;
    updateMirror();
    pending = name => {
      const n = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (n === 'joshua') sequence(woprConnect);
      else if (n === 'falken') sequence(falkenHint);
      else sequence(() => loginAs(n || 'guest'));
    };
  }

  // The professor himself cannot log in, but he points at the backdoor.
  async function falkenHint() {
    await sleep(350);
    print('Password:');
    await sleep(700);
    print('Login incorrect');
    print('hint: the professor named his backdoor after his son\n');
    askLogin(false);
  }

  async function loginAs(name) {
    user = name;
    await sleep(350);
    print('Password:');
    await sleep(500);
    print('Last login: Wed Sep 23 22:41:07 1987 from lirux');
    print('LIRUX 4.3 BSoD: Thu Jan 29 1987\n');
    print('You have mail.');
    print("type 'man plot' for help, F5 for demos");
    await sleep(400);
    setTextMode(false);
  }

  // After a restart the screen is text only, until RUN (or a new formula) draws again.
  async function go64() {
    await sleep(250);
    cls();
    setTextMode(true);
    setMachine('c64');
    await sleep(350);
    banner(BANNER_C64);
  }

  async function hardReset() {
    cls();
    setTextMode(true);
    setMachine('c128');
    await sleep(400);
    banner(BANNER_C128);
  }

  async function dialUp() {
    print('ATDT 555 1987');
    await sleep(900);
    print('CONNECT 2400');
    await sleep(600);
    state.home = state.machine;
    cls();
    setTextMode(true);
    setMachine('tty');
    askLogin();
  }

  /* ---------- easter egg: the war games computer behind the backdoor ---------- */

  // Warheads land one after another: each city is a peak that grows once t passes its time.
  const TARGETS = [[-2, 1, 0.4], [1.5, 2, 1], [2.5, -1.5, 1.6], [-1, -2.2, 2.2], [0.3, 0.2, 2.8],
    [-3, -0.8, 3.4], [3, 1.2, 4], [-2.6, 2.7, 4.6], [1, -3, 5.2]];
  const WAR = TARGETS.map(([a, b, t0]) => `exp(-5((x-(${a}))^2+(y-(${b}))^2))*min(1,max(0,t-${t0}))`).join('+');
  const CHESS = 'mod(floor(x)+floor(y),2)';

  async function wsay(text) {
    await sleep(500);
    for (const ln of text.split('\n')) {
      print(ln);
      await sleep(250);
    }
  }

  function woprPlot(expr, range, style) {
    state.range = range;
    state.grid = 64;
    state.style = style;
    state.zrange = null;
    setTextMode(false);
    plot(expr, true);
  }

  async function woprConnect() {
    wopr = 'hello';
    user = 'joshua';
    updateMirror();
    await sleep(700);
    cls();
    await wsay('GREETINGS PROFESSOR FALKEN.');
    await sleep(900);
    print('(type something and press RETURN)');
  }

  async function woprWar() {
    await wsay('FINE.');
    woprPlot(WAR, [-4, 4, -4, 4], 'mesh');
    state.zrange = [0, 1]; // steady height scale while the peaks rise
    state.src = 'global thermonuclear war';
    await sleep(6500);
    await wsay('A STRANGE GAME.\nTHE ONLY WINNING MOVE IS\nNOT TO PLAY.\n\nHOW ABOUT A NICE GAME OF CHESS?');
    wopr = 'chess?';
  }

  async function woprChess() {
    woprPlot(CHESS, [-4, 4, -4, 4], 'solid');
    await wsay('YOUR MOVE.\n\nSHALL WE PLAY A GAME?');
    wopr = 'game';
  }

  function woprInput(raw) {
    const a = raw.toLowerCase();
    if (/^(exit|logout|quit|bye)\b/.test(a)) {
      wopr = null;
      user = 'guest';
      state.zrange = null;
      sequence(logout);
      return;
    }
    // The small talk of the film comes first; whatever is typed, the story moves on.
    if (wopr === 'hello') {
      wopr = 'feeling';
      sequence(() => wsay('HOW ARE YOU FEELING TODAY?'));
    } else if (wopr === 'feeling') {
      wopr = 'account';
      sequence(() => wsay("EXCELLENT. IT'S BEEN A LONG TIME.\nCAN YOU EXPLAIN THE REMOVAL OF YOUR\nUSER ACCOUNT ON 6/23/73?"));
    } else if (wopr === 'account') {
      wopr = 'game';
      // The film answer is "People sometimes make mistakes."
      sequence(() => wsay((/mistake/.test(a) ? 'YES THEY DO.\n' : '') + 'SHALL WE PLAY A GAME?'));
    } else if (wopr === 'war?') {
      // Anything but chess means the user insists on war.
      if (/chess|^y/.test(a)) {
        sequence(woprChess);
      } else {
        wopr = 'playing';
        sequence(woprWar);
      }
    } else if (/list/.test(a) || (wopr === 'game' && /^y(es)?\b/.test(a))) {
      // "LIST GAMES", or just yes to SHALL WE PLAY A GAME?: show what there is to play.
      sequence(() => wsay("FALKEN'S MAZE\nCHESS\nTHEATERWIDE TACTICAL WARFARE\nGLOBAL THERMONUCLEAR WAR"));
    } else if (/war/.test(a)) {
      wopr = 'war?';
      sequence(() => wsay("WOULDN'T YOU PREFER A GOOD GAME OF CHESS?"));
    } else if (/chess/.test(a) || (wopr === 'chess?' && /^y/.test(a))) {
      sequence(woprChess);
    } else {
      wopr = 'game';
      sequence(() => wsay('SHALL WE PLAY A GAME?'));
    }
  }

  async function logout() {
    print('logout');
    await sleep(300);
    print('Connection closed.');
    await sleep(500);
    cls();
    setTextMode(true);
    setMachine(state.home === 'c64' ? 'c64' : 'c128');
    print('NO CARRIER\nREADY.');
  }

  async function boot() {
    const hash = decodeURIComponent(location.hash.slice(1) || '').trim();
    const startPlot = () => {
      if (!hash || !plot(hash, true)) applyDemo(0, true);
    };
    setTextMode(true);
    if (state.machine === 'tty') {
      // The plot is ready behind the login screen and shows up once logged in.
      startPlot();
      setTextMode(true);
      askLogin();
      return;
    }
    banner(state.machine === 'c128' ? BANNER_C128 : BANNER_C64);
    await sleep(500);
    await typeIn(state.machine === 'c128' ? 'DLOAD"SURFACE"' : 'LOAD"SURFACE",8,1');
    print('\nSEARCHING FOR SURFACE');
    await sleep(600);
    print('LOADING');
    tapeLoad(skip ? 300 : 1300);
    await sleep(1300);
    print('READY.');
    await typeIn('RUN');
    setTextMode(false);
    startPlot();
    print('READY.\nTYPE HELP FOR COMMANDS, F5 FOR DEMOS');
  }

  /* ---------- start ---------- */

  const savedHome = store.get('lirux3d.home');
  state.home = savedHome === 'c64' ? 'c64' : 'c128';
  const savedMachine = store.get('lirux3d.machine');
  setMachine(has(MACHINES, savedMachine) ? savedMachine : 'c128');
  updateMirror();
  requestAnimationFrame(frame);
  if (window.matchMedia('(pointer: fine)').matches) cmd.focus({ preventScroll: true });
  sequence(boot);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
})();
