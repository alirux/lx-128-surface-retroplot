/*
 * Expression parser for LIRUX 3D.
 * Turns a formula typed by the user into an AST, then compiles the AST into
 * a tree of closures that evaluates either over real numbers (z = f(x, y))
 * or over complex numbers (w = f(z)). No eval, no Function constructor.
 */
(function (global) {
  'use strict';

  class BasicError extends Error {
    constructor(code, detail) {
      super(code);
      this.code = code;
      this.detail = detail || '';
    }
  }

  /* ---------- complex arithmetic on [re, im] pairs ---------- */

  const ONE = [1, 0];
  const I = [0, 1];
  const C = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    mul: (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
    div(a, b) {
      const d = b[0] * b[0] + b[1] * b[1];
      return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
    },
    abs: a => Math.hypot(a[0], a[1]),
    exp(a) {
      const m = Math.exp(a[0]);
      return [m * Math.cos(a[1]), m * Math.sin(a[1])];
    },
    log: a => [Math.log(Math.hypot(a[0], a[1])), Math.atan2(a[1], a[0])],
    pow(a, b) {
      // Small integer exponents: exact repeated squaring, no branch cut noise.
      if (b[1] === 0 && Number.isInteger(b[0]) && Math.abs(b[0]) <= 64) {
        let n = Math.abs(b[0]), r = ONE, p = a;
        while (n) {
          if (n & 1) r = C.mul(r, p);
          p = C.mul(p, p);
          n >>= 1;
        }
        return b[0] < 0 ? C.div(ONE, r) : r;
      }
      if (a[0] === 0 && a[1] === 0) return b[0] > 0 ? [0, 0] : [NaN, NaN];
      return C.exp(C.mul(b, C.log(a)));
    },
    sqrt(a) {
      const r = Math.sqrt(Math.hypot(a[0], a[1]));
      const t = Math.atan2(a[1], a[0]) / 2;
      return [r * Math.cos(t), r * Math.sin(t)];
    },
    sin: a => [Math.sin(a[0]) * Math.cosh(a[1]), Math.cos(a[0]) * Math.sinh(a[1])],
    cos: a => [Math.cos(a[0]) * Math.cosh(a[1]), -Math.sin(a[0]) * Math.sinh(a[1])],
    sinh: a => [Math.sinh(a[0]) * Math.cos(a[1]), Math.cosh(a[0]) * Math.sin(a[1])],
    cosh: a => [Math.cosh(a[0]) * Math.cos(a[1]), Math.sinh(a[0]) * Math.sin(a[1])],
  };
  C.tan = a => C.div(C.sin(a), C.cos(a));
  C.tanh = a => C.div(C.sinh(a), C.cosh(a));
  C.asin = a => C.mul([0, -1], C.log(C.add(C.mul(I, a), C.sqrt(C.sub(ONE, C.mul(a, a))))));
  C.acos = a => C.sub([Math.PI / 2, 0], C.asin(a));
  C.atan = a => C.mul([0, 0.5], C.sub(C.log(C.sub(ONE, C.mul(I, a))), C.log(C.add(ONE, C.mul(I, a)))));

  /* ---------- gamma function (Lanczos, g = 7) ---------- */

  const LG = 7;
  const LC = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7];

  function gammaR(x) {
    if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaR(1 - x));
    x -= 1;
    let a = LC[0];
    const t = x + LG + 0.5;
    for (let k = 1; k < 9; k++) a += LC[k] / (x + k);
    return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
  }

  function gammaC(z) {
    if (z[0] < 0.5) {
      const s = C.sin([Math.PI * z[0], Math.PI * z[1]]);
      return C.div([Math.PI, 0], C.mul(s, gammaC([1 - z[0], -z[1]])));
    }
    const x = [z[0] - 1, z[1]];
    let a = [LC[0], 0];
    for (let k = 1; k < 9; k++) a = C.add(a, C.div([LC[k], 0], [x[0] + k, x[1]]));
    const t = [x[0] + LG + 0.5, x[1]];
    const tp = C.exp(C.sub(C.mul([x[0] + 0.5, x[1]], C.log(t)), t));
    const k = Math.sqrt(2 * Math.PI);
    return C.mul([k * tp[0], k * tp[1]], a);
  }

  /* ---------- function table: real and complex versions ---------- */

  const f1 = (r, c) => ({ n: 1, r, c });
  const f2 = (r, c) => ({ n: 2, r, c });
  const reMod = (a, b) => a - b * Math.floor(a / b);

  const FUNCS = {
    sin: f1(Math.sin, C.sin),
    cos: f1(Math.cos, C.cos),
    tan: f1(Math.tan, C.tan),
    asin: f1(Math.asin, C.asin),
    acos: f1(Math.acos, C.acos),
    atan: f1(Math.atan, C.atan),
    sinh: f1(Math.sinh, C.sinh),
    cosh: f1(Math.cosh, C.cosh),
    tanh: f1(Math.tanh, C.tanh),
    sec: f1(x => 1 / Math.cos(x), a => C.div(ONE, C.cos(a))),
    csc: f1(x => 1 / Math.sin(x), a => C.div(ONE, C.sin(a))),
    cot: f1(x => 1 / Math.tan(x), a => C.div(ONE, C.tan(a))),
    exp: f1(Math.exp, C.exp),
    log: f1(Math.log, C.log),
    ln: f1(Math.log, C.log),
    log10: f1(Math.log10, a => C.div(C.log(a), [Math.LN10, 0])),
    log2: f1(Math.log2, a => C.div(C.log(a), [Math.LN2, 0])),
    sqrt: f1(Math.sqrt, C.sqrt),
    cbrt: f1(Math.cbrt, a => C.pow(a, [1 / 3, 0])),
    abs: f1(Math.abs, a => [C.abs(a), 0]),
    sign: f1(Math.sign, a => {
      const m = C.abs(a);
      return m ? [a[0] / m, a[1] / m] : [0, 0];
    }),
    floor: f1(Math.floor, a => [Math.floor(a[0]), Math.floor(a[1])]),
    ceil: f1(Math.ceil, a => [Math.ceil(a[0]), Math.ceil(a[1])]),
    round: f1(Math.round, a => [Math.round(a[0]), Math.round(a[1])]),
    gamma: f1(gammaR, gammaC),
    fact: f1(x => gammaR(x + 1), a => gammaC([a[0] + 1, a[1]])),
    re: f1(x => x, a => [a[0], 0]),
    im: f1(() => 0, a => [a[1], 0]),
    arg: f1(x => (x < 0 ? Math.PI : 0), a => [Math.atan2(a[1], a[0]), 0]),
    conj: f1(x => x, a => [a[0], -a[1]]),
    min: f2(Math.min, (a, b) => [Math.min(a[0], b[0]), 0]),
    max: f2(Math.max, (a, b) => [Math.max(a[0], b[0]), 0]),
    atan2: f2(Math.atan2, (a, b) => [Math.atan2(a[0], b[0]), 0]),
    mod: f2(reMod, (a, b) => [reMod(a[0], b[0]), 0]),
    pow: f2(Math.pow, C.pow),
    hypot: f2(Math.hypot, (a, b) => [Math.hypot(C.abs(a), C.abs(b)), 0]),
  };

  // Functions that only make sense on complex numbers: using them switches mode.
  const COMPLEX_ONLY = new Set(['re', 'im', 'arg', 'conj']);

  const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2 };
  const VARS = ['x', 'y', 't', 'r', 'th', 'theta', 'z', 'i'];

  const NAMES = Object.keys(FUNCS).concat(Object.keys(CONSTS), VARS)
    .sort((a, b) => b.length - a.length);

  /* ---------- tokenizer ---------- */

  // "xy" or "2xsin" style words are split into known names, so the user can
  // write implicit products the way they would on paper.
  function splitWord(word) {
    const out = [];
    let i = 0;
    outer: while (i < word.length) {
      if (/[0-9]/.test(word[i])) {
        let j = i;
        while (j < word.length && /[0-9]/.test(word[j])) j++;
        out.push({ t: 'num', v: +word.slice(i, j) });
        i = j;
        continue;
      }
      for (const n of NAMES) {
        if (word.startsWith(n, i)) {
          out.push({ t: 'id', v: n === 'theta' ? 'th' : n });
          i += n.length;
          continue outer;
        }
      }
      throw new BasicError("UNDEF'D FUNCTION", word);
    }
    return out;
  }

  function tokenize(src) {
    const s = src.toLowerCase().replace(/π/g, 'pi');
    const out = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      const rest = s.slice(i);
      let m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(rest);
      if (m) {
        out.push({ t: 'num', v: parseFloat(m[0]) });
        i += m[0].length;
        continue;
      }
      m = /^[a-z][a-z0-9]*/.exec(rest);
      if (m) {
        out.push(...splitWord(m[0]));
        i += m[0].length;
        continue;
      }
      if (rest.startsWith('**')) {
        out.push({ t: 'op', v: '^' });
        i += 2;
        continue;
      }
      if ('+-*/^(),|!%'.includes(ch)) {
        out.push({ t: 'op', v: ch });
        i++;
        continue;
      }
      throw new BasicError('SYNTAX', ch);
    }
    return out;
  }

  /* ---------- recursive descent parser ---------- */

  function parse(src) {
    const toks = tokenize(src);
    if (!toks.length) throw new BasicError('MISSING OPERAND');
    let p = 0;
    const peek = () => toks[p];
    const isOp = (tok, v) => tok && tok.t === 'op' && tok.v === v;
    const expect = v => {
      if (!isOp(peek(), v)) throw new BasicError('SYNTAX');
      p++;
    };
    const startsFactor = tok => tok && (tok.t === 'num' || tok.t === 'id' || isOp(tok, '('));

    function parseAdd() {
      let a = parseMul();
      while (isOp(peek(), '+') || isOp(peek(), '-')) {
        const op = toks[p++].v;
        a = { t: 'bin', op, a, b: parseMul() };
      }
      return a;
    }

    function parseMul() {
      let a = parseUnary();
      for (;;) {
        const k = peek();
        if (isOp(k, '*') || isOp(k, '/') || isOp(k, '%')) {
          p++;
          a = { t: 'bin', op: k.v, a, b: parseUnary() };
        } else if (startsFactor(k)) {
          a = { t: 'bin', op: '*', a, b: parsePow() }; // implicit product: 2x, x(y+1)
        } else {
          return a;
        }
      }
    }

    function parseUnary() {
      if (isOp(peek(), '-')) { p++; return { t: 'neg', a: parseUnary() }; }
      if (isOp(peek(), '+')) { p++; return parseUnary(); }
      return parsePow();
    }

    function parsePow() {
      const base = parsePostfix();
      if (isOp(peek(), '^')) {
        p++;
        return { t: 'bin', op: '^', a: base, b: parseUnary() };
      }
      return base;
    }

    function parsePostfix() {
      let a = parsePrimary();
      while (isOp(peek(), '!')) {
        p++;
        a = { t: 'call', fn: 'fact', args: [a] };
      }
      return a;
    }

    function parsePrimary() {
      const tok = toks[p++];
      if (!tok) throw new BasicError('MISSING OPERAND');
      if (tok.t === 'num') return { t: 'num', v: tok.v };
      if (isOp(tok, '(')) {
        const e = parseAdd();
        expect(')');
        return e;
      }
      if (isOp(tok, '|')) {
        const e = parseAdd();
        expect('|');
        return { t: 'call', fn: 'abs', args: [e] };
      }
      if (tok.t === 'id') {
        const fn = FUNCS[tok.v];
        if (!fn) return { t: 'var', name: tok.v };
        let args;
        if (isOp(peek(), '(')) {
          p++;
          args = [parseAdd()];
          while (isOp(peek(), ',')) { p++; args.push(parseAdd()); }
          expect(')');
        } else {
          args = [parsePow()]; // sin x, sin 2x style
        }
        if (args.length !== fn.n) throw new BasicError('ILLEGAL QUANTITY', tok.v);
        return { t: 'call', fn: tok.v, args };
      }
      throw new BasicError('SYNTAX', tok.v);
    }

    const ast = parseAdd();
    if (p < toks.length) throw new BasicError('SYNTAX');
    return ast;
  }

  /* ---------- compilers ---------- */

  const REAL_OPS = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '*': (a, b) => a * b,
    '/': (a, b) => a / b,
    '^': Math.pow,
    '%': reMod,
  };
  const CPLX_OPS = { '+': C.add, '-': C.sub, '*': C.mul, '/': C.div, '^': C.pow, '%': FUNCS.mod.c };

  function compileReal(node) {
    switch (node.t) {
      case 'num': { const v = node.v; return () => v; }
      case 'var': {
        const k = node.name;
        if (k in CONSTS) { const v = CONSTS[k]; return () => v; }
        return e => e[k];
      }
      case 'neg': { const a = compileReal(node.a); return e => -a(e); }
      case 'bin': {
        const a = compileReal(node.a), b = compileReal(node.b), f = REAL_OPS[node.op];
        return e => f(a(e), b(e));
      }
      case 'call': {
        const f = FUNCS[node.fn].r, args = node.args.map(compileReal);
        if (args.length === 1) { const a = args[0]; return e => f(a(e)); }
        const [a, b] = args;
        return e => f(a(e), b(e));
      }
    }
    throw new BasicError('SYNTAX');
  }

  function compileComplex(node) {
    switch (node.t) {
      case 'num': { const v = [node.v, 0]; return () => v; }
      case 'var': {
        const k = node.name;
        if (k === 'i') return () => I;
        if (k in CONSTS) { const v = [CONSTS[k], 0]; return () => v; }
        return e => e[k];
      }
      case 'neg': {
        const a = compileComplex(node.a);
        return e => { const v = a(e); return [-v[0], -v[1]]; };
      }
      case 'bin': {
        const a = compileComplex(node.a), b = compileComplex(node.b), f = CPLX_OPS[node.op];
        return e => f(a(e), b(e));
      }
      case 'call': {
        const f = FUNCS[node.fn].c, args = node.args.map(compileComplex);
        if (args.length === 1) { const a = args[0]; return e => f(a(e)); }
        const [a, b] = args;
        return e => f(a(e), b(e));
      }
    }
    throw new BasicError('SYNTAX');
  }

  function collect(node, vars, fns) {
    if (node.t === 'var') vars.add(node.name);
    if (node.t === 'call') fns.add(node.fn);
    if (node.a) collect(node.a, vars, fns);
    if (node.b) collect(node.b, vars, fns);
    if (node.args) node.args.forEach(n => collect(n, vars, fns));
  }

  // Compile a formula. Complex mode is chosen automatically when the formula
  // mentions z, i or a complex-only function.
  function compile(src) {
    const ast = parse(src);
    const vars = new Set(), fns = new Set();
    collect(ast, vars, fns);
    const complex = vars.has('z') || vars.has('i') || [...fns].some(f => COMPLEX_ONLY.has(f));
    return {
      src,
      mode: complex ? 'complex' : 'real',
      fn: complex ? compileComplex(ast) : compileReal(ast),
      usesT: vars.has('t'),
    };
  }

  global.MathParser = {
    compile,
    BasicError,
    functionNames: Object.keys(FUNCS).filter(n => n !== 'fact'),
    constantNames: Object.keys(CONSTS),
  };
})(window);
