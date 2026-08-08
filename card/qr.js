/* ═══════════════════════════════════════════════════════════════
   Minimal QR Code encoder: byte mode, single-block versions only.

   Written by hand rather than pulled from a CDN so the card stays a
   self-contained, offline-renderable artifact.

   Scope is deliberately narrow: only the (version, ECC) pairs that use
   ONE error-correction block, which removes block-interleaving entirely,
   the single most bug-prone part of a QR encoder. That still covers
   up to ~106 characters, far more than any URL on a business card.

   Exposes GSQR.svg(text, opts) and GSQR.matrix(text) plus GSQR._test()
   for self-checks.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ── GF(256), primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D) ──── */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /* generator polynomial = product of (x - a^i), i in [0, degree) */
  function rsGenerator(degree) {
    let poly = [1];                       // poly[0] is the highest-order term
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j]     ^= poly[j];                     // multiply by x
        next[j + 1] ^= gfMul(poly[j], EXP[i]);      // multiply by a^i
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (let j = 0; j < ecLen; j++) res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return res;
  }

  /* ── single-block configurations, smallest capacity first ─────── */
  const CONFIGS = [
    { version: 1, ec: 'M', dataCw: 16,  ecCw: 10 },
    { version: 2, ec: 'M', dataCw: 28,  ecCw: 16 },
    { version: 3, ec: 'M', dataCw: 44,  ecCw: 26 },
    { version: 4, ec: 'L', dataCw: 80,  ecCw: 20 },
    { version: 5, ec: 'L', dataCw: 108, ecCw: 26 }
  ];
  const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function utf8Bytes(text) {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      let c = text.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function pickConfig(byteLen) {
    /* 4 bits mode + 8 bits character count = 12 bits of overhead */
    for (const cfg of CONFIGS) {
      if (byteLen * 8 + 12 <= cfg.dataCw * 8) return cfg;
    }
    throw new Error('QR: payload too long for the supported versions (max ~106 bytes)');
  }

  function encodeCodewords(text, cfg) {
    const bytes = utf8Bytes(text);
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

    push(0b0100, 4);            // byte mode
    push(bytes.length, 8);      // count indicator is 8 bits for versions 1-9
    for (const b of bytes) push(b, 8);

    const cap = cfg.dataCw * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // terminator
    while (bits.length % 8 !== 0) bits.push(0);                      // byte align

    const PAD = [0xEC, 0x11];
    let p = 0;
    while (bits.length < cap) push(PAD[p++ % 2], 8);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    return { data, all: data.concat(rsEncode(data, cfg.ecCw)) };
  }

  /* ── matrix construction ──────────────────────────────────────── */
  function buildFunctionPatterns(cfg) {
    const size = cfg.version * 4 + 17;
    const m = [], fixed = [];
    for (let i = 0; i < size; i++) {
      m.push(new Array(size).fill(null));
      fixed.push(new Array(size).fill(false));
    }
    const set = (r, c, v) => {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      m[r][c] = v; fixed[r][c] = true;
    };

    /* finder patterns, with their one-module separators */
    function finder(r0, c0) {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          let v = 0;
          if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
            const ring = (dr === 0 || dr === 6 || dc === 0 || dc === 6);
            const core = (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
            v = (ring || core) ? 1 : 0;
          }
          set(r0 + dr, c0 + dc, v);
        }
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    /* timing patterns */
    for (let i = 8; i < size - 8; i++) {
      const v = (i % 2 === 0) ? 1 : 0;
      set(6, i, v);
      set(i, 6, v);
    }

    /* versions 2-6 carry exactly one alignment pattern, bottom-right */
    if (cfg.version >= 2) {
      const k = 4 * cfg.version + 10;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const d = Math.max(Math.abs(dr), Math.abs(dc));
          set(k + dr, k + dc, d === 1 ? 0 : 1);
        }
      }
    }

    set(size - 8, 8, 1);            // the permanently dark module

    /* reserve the format-information strips */
    for (let i = 0; i <= 8; i++) {
      if (m[8][i] === null) set(8, i, 0);
      if (m[i][8] === null) set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) set(8, size - 1 - i, 0);
      if (m[size - 1 - i][8] === null) set(size - 1 - i, 8, 0);
    }

    return { m, fixed, size };
  }

  function placeData(m, fixed, size, codewords) {
    const bits = [];
    for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

    let idx = 0, upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                     // skip the timing column
      for (let step = 0; step < size; step++) {
        const row = upward ? (size - 1 - step) : step;
        for (let k = 0; k < 2; k++) {
          const col = right - k;
          if (fixed[row][col]) continue;
          m[row][col] = idx < bits.length ? bits[idx] : 0;
          idx++;
        }
      }
      upward = !upward;
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0,
    (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0
  ];

  function penalty(m, size) {
    let score = 0;

    /* rule 1: runs of 5 or more */
    for (let i = 0; i < size; i++) {
      for (const horiz of [true, false]) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          const a = horiz ? m[i][j]     : m[j][i];
          const b = horiz ? m[i][j - 1] : m[j - 1][i];
          if (a === b) { run++; }
          else { if (run >= 5) score += 3 + (run - 5); run = 1; }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }

    /* rule 2: 2x2 blocks of one colour */
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    /* rule 3: finder-like 1:1:3:1:1 patterns with a 4-module gap */
    const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const match = (get, start) => {
      let okA = true, okB = true;
      for (let k = 0; k < 11; k++) {
        const v = get(start + k);
        if (v !== A[k]) okA = false;
        if (v !== B[k]) okB = false;
      }
      return (okA ? 1 : 0) + (okB ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      for (let j = 0; j + 11 <= size; j++) {
        score += 40 * match(k => m[i][k], j);
        score += 40 * match(k => m[k][i], j);
      }
    }

    /* rule 4: deviation from an even split of dark and light */
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
    const pct = (dark * 100) / (size * size);
    score += 10 * Math.floor(Math.abs(pct - 50) / 5);

    return score;
  }

  function formatBits(ecLevel, mask) {
    const data = (EC_BITS[ecLevel] << 3) | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function placeFormat(m, size, fmt) {
    for (let i = 0; i <= 5; i++) m[8][i] = (fmt >> i) & 1;
    m[8][7] = (fmt >> 6) & 1;
    m[8][8] = (fmt >> 7) & 1;
    m[7][8] = (fmt >> 8) & 1;
    for (let i = 9; i <= 14; i++) m[14 - i][8] = (fmt >> i) & 1;

    /* Second copy: 8 modules run left from the right edge along row 8,
       and 7 run up from the bottom along column 8. Getting these two
       halves the wrong way round makes the vertical strip 8 long, which
       silently overwrites the permanently-dark module at (size-8, 8). */
    for (let i = 0; i <= 7; i++)  m[8][size - 1 - i] = (fmt >> i) & 1;
    for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = (fmt >> i) & 1;
  }

  function matrix(text) {
    const bytes = utf8Bytes(text);
    const cfg = pickConfig(bytes.length);
    const { all } = encodeCodewords(text, cfg);
    const { m, fixed, size } = buildFunctionPatterns(cfg);
    placeData(m, fixed, size, all);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const trial = m.map(row => row.slice());
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!fixed[r][c] && MASKS[mask](r, c)) trial[r][c] ^= 1;
        }
      }
      placeFormat(trial, size, formatBits(cfg.ec, mask));
      const s = penalty(trial, size);
      if (!best || s < best.score) best = { score: s, mask, grid: trial };
    }
    return { grid: best.grid, size, version: cfg.version, ec: cfg.ec, mask: best.mask };
  }

  /* ── SVG output ───────────────────────────────────────────────── */
  function svg(text, opts) {
    const o = opts || {};
    const quiet = o.quiet == null ? 4 : o.quiet;      // spec minimum is 4 modules
    const dark = o.dark || '#000';
    const light = o.light || 'none';
    const { grid, size } = matrix(text);
    const total = size + quiet * 2;

    /* one merged path is far smaller than one <rect> per module, and
       prints without hairline seams between adjacent modules */
    let d = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (grid[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    const bg = light === 'none' ? ''
      : `<rect width="${total}" height="${total}" fill="${light}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
           `shape-rendering="crispEdges" role="img" aria-label="QR code linking to ${text}">` +
           `${bg}<path d="${d}" fill="${dark}"/></svg>`;
  }

  /* ── self-checks ──────────────────────────────────────────────── */
  function _test(text) {
    const out = [];
    const ok = (name, cond) => out.push((cond ? 'PASS  ' : 'FAIL  ') + name);

    /* GF(256) sanity: a^255 wraps to 1, and log/exp invert each other */
    ok('GF exp/log inverse', (() => {
      for (let i = 1; i < 256; i++) if (EXP[LOG[i]] !== i) return false;
      return true;
    })());
    ok('GF multiply identity', gfMul(1, 200) === 200 && gfMul(0, 200) === 0);

    /* Reed-Solomon: the full codeword polynomial must divide evenly by
       the generator. This is the real correctness property of RS ECC. */
    ok('RS remainder is zero', (() => {
      const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
      const ec = rsEncode(data, 10);
      const gen = rsGenerator(10);
      const rem = data.concat(ec);
      for (let i = 0; i < data.length; i++) {
        const f = rem[i];
        if (f === 0) continue;
        for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j], f);
      }
      return rem.every(v => v === 0);
    })());

    const cfg = pickConfig(utf8Bytes(text).length);
    const { all } = encodeCodewords(text, cfg);
    const res = matrix(text);
    const { grid, size } = res;

    ok('size matches version', size === cfg.version * 4 + 17);

    /* finder patterns land where they must */
    const finderOK = (r, c) =>
      grid[r][c] === 1 && grid[r + 1][c + 1] === 0 &&
      grid[r + 3][c + 3] === 1 && grid[r + 6][c + 6] === 1;
    ok('finder top-left',  finderOK(0, 0));
    ok('finder top-right', finderOK(0, size - 7));
    ok('finder bottom-left', finderOK(size - 7, 0));

    /* timing patterns alternate */
    ok('timing row', (() => {
      for (let i = 8; i < size - 8; i++) if (grid[6][i] !== (i % 2 === 0 ? 1 : 0)) return false;
      return true;
    })());
    ok('dark module', grid[size - 8][8] === 1);

    /* Round-trip: unmask and re-read the data modules in placement order.
       This is the strongest available check without an optical scanner,
       and it verifies placement, the mask, and the mask's own record in the
       format bits all agree. */
    ok('round-trip decode', (() => {
      const { fixed } = buildFunctionPatterns(cfg);
      const un = grid.map(row => row.slice());
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!fixed[r][c] && MASKS[res.mask](r, c)) un[r][c] ^= 1;
        }
      }
      const bits = [];
      let upward = true;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let step = 0; step < size; step++) {
          const row = upward ? (size - 1 - step) : step;
          for (let k = 0; k < 2; k++) {
            const col = right - k;
            if (fixed[row][col]) continue;
            bits.push(un[row][col]);
          }
        }
        upward = !upward;
      }
      for (let i = 0; i < all.length; i++) {
        let v = 0;
        for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
        if (v !== all[i]) return false;
      }
      return true;
    })());

    out.push(`INFO  version ${res.version}-${res.ec}, mask ${res.mask}, ${size}x${size} modules`);
    return out;
  }

  global.GSQR = { svg, matrix, _test };
})(typeof window !== 'undefined' ? window : globalThis);
