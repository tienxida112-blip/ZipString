/* ZipString decompressor.js — standalone decoder (no dependencies).
   Decodes ZipString loaders: ASCII85 -> container -> LZ77+Huffman (or stored) -> source.
   Used by the Decompress tab and by compressor.js for round-trip verification.
   Load this BEFORE compressor.js. Exposes globalThis.ZipStringD. */
(function () {
const B85 = "!#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ^_abcdefghijklmnopqrstuvwxyz~";
if (B85.length !== 85) throw new Error("b85 alphabet must be exactly 85 chars");
const NSYM = 365; /* 0..255 literals, 256 EOB, 257..292 length codes, 293..328 rep0, 329..364 rep1 */

function hash32(bytes) {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (h * 1000003 + bytes[i]) % 4294967296;
  return h;
}

/* ---- length / distance code tables (shared shape with the Lua engine) ---- */
const LEN_B = [], LEN_E = [], DIST_B = [], DIST_E = [];
(function () {
  let b = 3;
  for (let i = 0; i < 8; i++) { LEN_B.push(b); LEN_E.push(0); b++; }
  for (let e = 1; e <= 14; e++) for (let k = 0; k < 2; k++) { LEN_B.push(b); LEN_E.push(e); b += 1 << e; }
  b = 1;
  /* 4 distance codes per power of two (finer than deflate's 2) -> ~1 extra bit saved per match */
  for (let i = 0; i < 4; i++) { DIST_B.push(b); DIST_E.push(0); b++; }
  for (let e = 1; e <= 18; e++) for (let k = 0; k < 4; k++) { DIST_B.push(b); DIST_E.push(e); b += 1 << e; }
})();
/* legacy distance tables (loaders made before 2026-11-17 used 2 codes per power, 40 symbols) */
const DIST_B_OLD = [], DIST_E_OLD = [];
(function () {
  let b = 1;
  for (let i = 0; i < 4; i++) { DIST_B_OLD.push(b); DIST_E_OLD.push(0); b++; }
  for (let e = 1; e <= 18; e++) for (let k = 0; k < 2; k++) { DIST_B_OLD.push(b); DIST_E_OLD.push(e); b += 1 << e; }
})();
const MAXLEN = LEN_B[LEN_B.length - 1] + (1 << LEN_E[LEN_E.length - 1]) - 1;
const WINDOW = DIST_B[DIST_B.length - 1] + (1 << DIST_E[DIST_E.length - 1]) - 1;

function b85decode(s, alpha) {
  const R = new Map();
  for (let i = 0; i < alpha.length; i++) R.set(alpha.charCodeAt(i), i);
  const out = [];
  for (let i = 0; i < s.length; i += 5) {
    const q = Math.min(5, s.length - i);
    if (q === 1) throw new Error("corrupt stream: dangling character");
    let v = 0;
    for (let j = i; j < i + q; j++) {
      const d = R.get(s.charCodeAt(j));
      if (d === undefined) throw new Error("corrupt stream: invalid character");
      v = v * 85 + d;
    }
    if (q < 5) {
      v *= Math.pow(85, 5 - q);
      const m = Math.pow(256, 5 - q);
      v = Math.ceil(v / m) * m;
    }
    out.push(Math.floor(v / 16777216) & 255);
    if (q > 2) out.push(Math.floor(v / 65536) % 256);
    if (q > 3) out.push(Math.floor(v / 256) % 256);
    if (q > 4) out.push(v % 256);
  }
  return Uint8Array.from(out);
}

/* ---- JS mirror of the Lua engine (verification + Decompress tab) ---- */
function lzhDecode(u, start, legacy) {
  let q = start, r = 0, s = 0;
  function rb() {
    if (s === 0) {
      if (q >= u.length) throw new Error("corrupt stream: truncated data");
      r = u[q++]; s = 8;
    }
    const b = r & 1; r >>>= 1; s--; return b;
  }
  function bx(n) { let v = 0; for (let i = 0; i < n; i++) v += rb() << i; return v; }
  function rl(n) {
    const lens = []; let ci = 0;
    while (ci < n) {
      const L = bx(4);
      if (L > 0) { ci++; lens.push(L); }
      else { const rr = bx(6) + 1; for (let j = 0; j < rr; j++) { ci++; lens.push(0); } }
      if (ci > n) throw new Error("corrupt stream: bad tree");
    }
    return lens;
  }
  function mk(lens) {
    const cnt = new Array(16).fill(0), fst = new Array(16).fill(0), off = new Array(16).fill(0), cur = new Array(16).fill(0), sym = [];
    for (let i = 0; i < lens.length; i++) if (lens[i] > 0) cnt[lens[i]]++;
    let code = 0;
    for (let b = 1; b <= 15; b++) { code = (code + cnt[b - 1]) * 2; fst[b] = code; }
    let idx = 1;
    for (let b = 1; b <= 15; b++) { off[b] = idx; cur[b] = idx; idx += cnt[b]; }
    for (let i = 0; i < lens.length; i++) { const L = lens[i]; if (L > 0) { sym[cur[L]] = i; cur[L]++; } }
    return [cnt, fst, off, sym];
  }
  function dc(a1, a2, a3, a4) {
    let code = 0;
    for (let j = 1; j <= 15; j++) {
      code = code * 2 + rb();
      const cn = a1[j];
      if (cn > 0) {
        const dd = code - a2[j];
        if (dd >= 0 && dd < cn) return a4[a3[j] + dd];
      }
    }
    throw new Error("corrupt stream: bad huffman code");
  }
  const symN = legacy ? 329 : NSYM;
  const DB = legacy ? DIST_B_OLD : DIST_B, DE = legacy ? DIST_E_OLD : DIST_E;
  const out = [];
  let lastDist = 0, prevDist = 0;
  for (;;) {
    const fin = rb();
    const lt = mk(rl(symN)), dt = mk(rl(DB.length));
    for (;;) {
      const z = dc(lt[0], lt[1], lt[2], lt[3]);
      if (z === 256) break;
      if (z < 256) {
        out.push(z);
      } else {
        let len, dst;
        if (z >= 329) { /* rep1: second-to-last distance, no distance bits */
          len = LEN_B[z - 329] + bx(LEN_E[z - 329]);
          dst = prevDist; prevDist = lastDist; lastDist = dst;
        } else if (z >= 293) { /* rep0: reuse last distance, no distance bits */
          len = LEN_B[z - 293] + bx(LEN_E[z - 293]);
          dst = lastDist;
        } else {
          len = LEN_B[z - 257] + bx(LEN_E[z - 257]);
          const ds = dc(dt[0], dt[1], dt[2], dt[3]);
          dst = DB[ds] + bx(DE[ds]);
          prevDist = lastDist; lastDist = dst;
        }
        if (dst < 1 || dst > out.length) throw new Error("corrupt stream: distance too far");
        for (let j = 0; j < len; j++) out.push(out[out.length - dst]);
      }
    }
    if (fin === 1) break;
  }
  return Uint8Array.from(out);
}

/* ---- JS mirror of the tag-2 range-coder engine (verification + Decompress tab).
   LZMA-style adaptive binary range decoder over the same token stream:
   11-bit probs, len/dist bit-trees, order-1 literal contexts + match-byte mode. ---- */
function rcDecode(u, start, len) {
  const RC_LT = 8, RC_DT = 72, RC_LIT = 200, RC_XL = 6344, RC_XD = 6358;
  let sp = start + 1; /* first stream byte is the encoder's initial 0 cache */
  let code = 0;
  for (let i = 0; i < 4; i++) code = code * 256 + (sp < u.length ? u[sp++] : 0);
  let range = 4294967295, past = 0;
  const P = new Uint16Array(6376).fill(1024);
  function rb() {
    if (sp < u.length) return u[sp++];
    past++;
    if (past > 8) throw new Error("corrupt stream: truncated");
    return 0;
  }
  function db(idx) {
    const p = P[idx];
    const bound = Math.floor(range / 2048) * p;
    let z;
    if (code < bound) { range = bound; P[idx] = p + ((2048 - p) >> 5); z = 0; }
    else { code -= bound; range -= bound; P[idx] = p - (p >> 5); z = 1; }
    while (range < 16777216) { range *= 256; code = (code * 256 + rb()) % 4294967296; }
    return z;
  }
  function dt(off, nbits) {
    let s = 1;
    for (let i = 0; i < nbits; i++) s = s * 2 + db(off + s);
    return s - (1 << nbits);
  }
  function dx(n, off) {
    let v = 0;
    for (let j = n - 1; j >= 0; j--) v = v * 2 + db(off + j);
    return v;
  }
  const out = [];
  let lastDist = 0, prevDist = 0, afterMatch = false;
  function decLit() {
    const prev = out.length > 0 ? out[out.length - 1] : 0;
    const base = RC_LIT + (prev >> 5) * 768;
    let sym = 1;
    if (afterMatch) {
      let mb = out[out.length - lastDist];
      let done = false;
      while (sym < 256) {
        const mbit = (mb >> 7) & 1;
        mb = (mb << 1) & 255;
        const b = db(base + ((1 + mbit) << 8) + sym);
        sym = sym * 2 + b;
        if (mbit !== b) { done = true; break; }
      }
      if (!done) return sym - 256;
    }
    while (sym < 256) sym = sym * 2 + db(base + sym);
    return sym - 256;
  }
  while (out.length < len) {
    if (db(0) === 0) {
      out.push(decLit());
      afterMatch = false;
      continue;
    }
    let dst;
    if (db(1) === 1) {
      if (db(2) === 0) dst = lastDist;
      else { dst = prevDist; prevDist = lastDist; lastDist = dst; }
      const lc = dt(RC_LT, 6);
      if (lc > 35) throw new Error("corrupt stream: bad length code");
      const ln = LEN_B[lc] + dx(LEN_E[lc], RC_XL);
      if (dst < 1 || dst > out.length) throw new Error("corrupt stream: distance too far");
      for (let j = 0; j < ln; j++) out.push(out[out.length - dst]);
    } else {
      const lc = dt(RC_LT, 6);
      if (lc > 35) throw new Error("corrupt stream: bad length code");
      const ln = LEN_B[lc] + dx(LEN_E[lc], RC_XL);
      const dc = dt(RC_DT, 7);
      if (dc > DIST_B.length - 1) throw new Error("corrupt stream: bad distance code");
      dst = DIST_B[dc] + dx(DIST_E[dc], RC_XD);
      if (dst < 1 || dst > out.length) throw new Error("corrupt stream: distance too far");
      prevDist = lastDist; lastDist = dst;
      for (let j = 0; j < ln; j++) out.push(out[out.length - dst]);
    }
    afterMatch = true;
  }
  return Uint8Array.from(out);
}

function decodeContainer(u, alpha, legacy) {
  if (!(u instanceof Uint8Array)) u = Uint8Array.from(u);
  if (u.length < 9) throw new Error("corrupt stream: truncated header");
  const tag = u[0];
  const L = u[1] + u[2] * 256 + u[3] * 65536 + u[4] * 16777216;
  const H = u[5] + u[6] * 256 + u[7] * 65536 + u[8] * 16777216;
  let src;
  if (tag === 1) {
    if (u.length < 10) throw new Error("corrupt stream: truncated header");
    src = lzhDecode(u, 9, legacy);
  } else if (tag === 2) {
    if (u.length < 10) throw new Error("corrupt stream: truncated header");
    src = rcDecode(u, 9, L);
  } else if (tag === 0) {
    src = u.slice(9);
  } else {
    throw new Error("corrupt stream: unknown format tag");
  }
  if (src.length !== L) throw new Error("corrupt stream: length mismatch");
  if (hash32(src) !== H) throw new Error("corrupt stream: checksum mismatch");
  return { tag: tag, len: L, hash: H, src: src };
}

function decompressLoader(loaderText) {
  if (loaderText.indexOf("--Z\n") === 0) {
    /* raw loader: the payload ships as the plain (minified) source — no container */
    const src = loaderText.slice(4);
    const bytes = new TextEncoder().encode(src);
    return { src: src, bytes: bytes, len: bytes.length, tag: 3, legacy: false };
  }
  if (/\[0x[0-9a-fA-F]+\]=\(/.test(loaderText)) {
    throw new Error("this looks like an old multi-piece loader (piece table) — ZipString only decodes ZipString output");
  }
  const pm = loaderText.match(/\[=+\[([^\]]*)\]=+\]/);
  if (!pm) throw new Error("not a ZipString loader (no payload string found)");
  const am = loaderText.match(/"([!-~]{85})"/);
  if (!am) throw new Error("not a ZipString loader (alphabet not found)");
  /* new format first; loaders made before 2026-11-17 (329-symbol trees, 40 dist codes)
     get a second chance with the legacy tables */
  const ub = b85decode(pm[1], am[1]);
  let res, legacyUsed = false;
  try {
    res = decodeContainer(ub, am[1], false);
  } catch (e1) {
    try {
      res = decodeContainer(ub, am[1], true);
      legacyUsed = true;
    } catch (e2) {
      throw e1;
    }
  }
  return {
    src: new TextDecoder("utf-8", { fatal: false }).decode(res.src),
    bytes: res.src,
    len: res.len,
    tag: res.tag,
    legacy: legacyUsed
  };
}

  globalThis.ZipStringD = {
    B85: B85, NSYM: NSYM, hash32: hash32,
    LEN_B: LEN_B, LEN_E: LEN_E, DIST_B: DIST_B, DIST_E: DIST_E,
    MAXLEN: MAXLEN, WINDOW: WINDOW,
    b85decode: b85decode, lzhDecode: lzhDecode, rcDecode: rcDecode, decodeContainer: decodeContainer,
    decompressLoader: decompressLoader
  };
})();
