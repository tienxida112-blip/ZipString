/* ZipString compressor.js — minifier + LZ77 + Huffman + ASCII85 encoder and
   self-extracting loader generator. Depends on decompressor.js (loaded first)
   for the shared tables and for round-trip verification. Exposes globalThis.ZipStringC. */
(function () {
  const D = globalThis.ZipStringD;
  if (!D) throw new Error("compressor.js requires decompressor.js to be loaded first");
  const B85 = D.B85, NSYM = D.NSYM, hash32 = D.hash32,
    LEN_B = D.LEN_B, LEN_E = D.LEN_E, DIST_B = D.DIST_B, DIST_E = D.DIST_E,
    MAXLEN = D.MAXLEN, WINDOW = D.WINDOW,
    b85decode = D.b85decode, decodeContainer = D.decodeContainer;

function le32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

let len2code = null, dist2code = null;
function buildLookups() {
  if (len2code) return;
  len2code = new Int32Array(MAXLEN + 2);
  for (let i = 0; i < LEN_B.length; i++)
    for (let L = LEN_B[i]; L < LEN_B[i] + (1 << LEN_E[i]); L++) len2code[L] = i;
  dist2code = new Int32Array(WINDOW + 2);
  for (let i = 0; i < DIST_B.length; i++)
    for (let D = DIST_B[i]; D < DIST_B[i] + (1 << DIST_E[i]); D++) dist2code[D] = i;
}

/* ================= stage 0: Lua source minifier ================= */
/* Token-preserving: comments dropped, whitespace collapsed. Lua has no
   ASI, so keeping the token stream intact keeps semantics intact.
   Returns null to bail out (unterminated constructs) -> no minification. */
function minNum(s) {
  /* 0.1 -> .1, 007 -> 7, 1.50 -> 1.5, 1.0 -> 1. — never touches hex or exponents */
  if (s.length < 2 || (s[0] === "0" && (s[1] === "x" || s[1] === "X"))) return s;
  const m = s.match(/^([0-9]*\.?[0-9]*)([eE][-+]?[0-9]+)?$/);
  if (!m) return s;
  let mant = m[1], exp = m[2] || "";
  const di = mant.indexOf(".");
  if (di < 0) {
    mant = mant.replace(/^0+(?=[0-9])/, "");
  } else {
    let ip = mant.slice(0, di), fp = mant.slice(di + 1);
    if (/^0+$/.test(ip) && /[0-9]/.test(fp)) ip = ""; /* 0.5 -> .5 */
    else ip = ip.replace(/^0+(?=[0-9])/, "");         /* 007.5 -> 7.5 */
    fp = fp.replace(/0+$/, "");                       /* 1.50 -> 1.5, 1.0 -> 1. */
    if (ip === "" && fp === "") fp = "0";             /* 0.0 -> .0, never "." */
    mant = ip + "." + fp;
  }
  return mant + exp;
}
function renameLocals(toks) {
  /* scope-aware local renamer: locals, params and for-vars become a,b,c...
     Conservative by design: fields, globals, labels, Luau type annotations,
     goto targets and names that also appear inside string literals are never
     touched; locals declared inside repeat..until are left alone (their scope
     legally extends into the until-condition). */
  const KW = { "and":1,"break":1,"do":1,"else":1,"elseif":1,"end":1,"false":1,"for":1,"function":1,"goto":1,"if":1,"in":1,"local":1,"nil":1,"not":1,"or":1,"repeat":1,"return":1,"then":1,"true":1,"until":1,"while":1 };
  const STMTK = { "local":1,"return":1,"if":1,"while":1,"for":1,"do":1,"repeat":1,"function":1,"end":1,"else":1,"elseif":1,"until":1,"break":1,"goto":1,"then":1 };
  const EXPR_PREV = { "=":1,",":1,"(":1,"{":1,"[":1,"and":1,"or":1,"not":1,"return":1,"..":1,"+":1,"-":1,"*":1,"/":1,"%":1,"^":1,"==":1,"~=":1,"<":1,">":1,"<=":1,">=":1,"#":1,":":1 };
  const n = toks.length;
  const isIdent = function (i) { return i >= 0 && i < n && toks[i].k === "w" && !KW[toks[i].t]; };
  const disq = {};                    /* names that must keep their spelling */
  const inString = new Set();         /* words inside string literals -> disqualified */
  for (const tk of toks) if (tk.k === "s" || tk.k === "is") {
    let body = tk.t;
    if (body[0] === "`") body = body.slice(1, -1);
    else if (body[0] === '"' || body[0] === "'") body = body.slice(1, -1);
    else { const q = body.match(/^\[=*\[/); if (q) body = body.slice(q[0].length, body.length - q[0].length); }
    const w = body.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    if (w) for (const x of w) inString.add(x);
  }
  const usedIdents = new Set();       /* every identifier token: bank must avoid these */
  for (const tk of toks) if (tk.k === "w" && !KW[tk.t]) usedIdents.add(tk.t);

  const decls = [];                   /* {name, ok, newName} */
  const occ = new Array(n).fill(-1);  /* token i resolves to decls[occ[i]] */
  const mark = new Array(n);          /* declId at decl sites, -2 = never rename */
  const frames = [{ vars: new Map(), kind: "root" }];
  const paren = [];                   /* "p" param / "o" other / "b" brace / "g" generic */
  let region = false;                 /* type annotation / label region: no renames inside */
  let pending = null;                 /* locals visible only after their initializer */
  let forNames = null;                /* for control vars, registered at the coming do */
  let paramCtx = null;                /* {depth, frame} while inside a param list */
  let ctrl = null;                    /* "if"/"elseif" so then-frames land correctly */

  function mkDecl(pos) {
    const name = toks[pos].t;
    /* repeat-frame locals legally reach into the until-condition, where our
       scope tracking has already popped the frame: leave them alone */
    const ok = name.length >= 3 && !inString.has(name) && name !== "continue" &&
      !disq[name] && frames[frames.length - 1].kind !== "rep";
    const id = decls.length;
    decls.push({ name: name, ok: ok, newName: null });
    mark[pos] = id;
    return id;
  }
  function completePrev(p) {
    return !!p && ((p.k === "w" && !KW[p.t]) || p.k === "n" || p.k === "s" || p.k === "is" ||
      p.t === ")" || p.t === "]" || p.t === "}" || p.t === "..." || p.t === "end");
  }
  function namePartBack(i) {          /* does the ident/./: run before i start at function? */
    let j = i - 1;
    while (j >= 0 && (isIdent(j) || toks[j].t === "." || toks[j].t === ":")) j--;
    return j >= 0 && toks[j].t === "function";
  }

  for (let i = 0; i < n; i++) {
    const tk = toks[i], t = tk.t;

    /* pending locals commit at a statement boundary (initializer fully scanned).
       "function" only counts as a boundary when it starts a statement, not an
       expression (local f = function() ... end keeps the pending open). */
    if (pending) {
      let b = false;
      if (t === ";") b = true;
      else if (tk.k === "w" && STMTK[t]) {
        b = !(t === "function" && EXPR_PREV[toks[i - 1] ? toks[i - 1].t : ""]);
      } else if (isIdent(i) && completePrev(toks[i - 1]) && paren.length === 0) b = true;
      if (b) {
        const fi = Math.min(pending.frame, frames.length - 1);
        for (const id of pending.ids) frames[fi].vars.set(decls[id].name, id);
        pending = null;
      }
    }
    /* type regions end */
    if (region) {
      if (t === "=" || t === ";" || t === "::" || t === ">=") region = false;
      else if (t === "," && (paren.length === 0 || paren[paren.length - 1] === "p")) region = false;
      else if (tk.k === "w" && STMTK[t]) region = false;
      else if (isIdent(i) && completePrev(toks[i - 1]) && paren.length === 0) region = false;
    }

    if (tk.k === "o") {
      if (t === "(") {
        if (namePartBack(i)) {
          paren.push("p");
          frames.push({ vars: new Map(), kind: "fn" });
          paramCtx = { depth: paren.length, frame: frames.length - 1 };
        } else paren.push("o");
      } else if (t === ")") {
        const k2 = paren.pop();
        if (k2 === "p") { if (paramCtx && paramCtx.depth === paren.length + 1) paramCtx = null; region = false; }
      } else if (t === "{") {
        paren.push("b");
      } else if (t === "}") {
        if (paren.length && paren[paren.length - 1] !== "p") paren.pop();
      } else if (t === "<") {
        if (region) paren.push("g");
        else if (namePartBack(i)) { paren.push("g"); region = true; }
      } else if (t === ">" || t === ">=") {
        if (paren.length && paren[paren.length - 1] === "g") paren.pop();
      } else if (t === ":") {
        const nx = toks[i + 1];
        if (nx && (nx.t === "(" || nx.t === "{" || (isIdent(i + 1) && (!toks[i + 2] || toks[i + 2].t !== "(")))) region = true;
      } else if (t === "::") {
        region = true;
      }
      continue;
    }
    if (tk.k === "w" && !KW[t]) {
      /* plain identifier occurrence */
      if (mark[i] !== undefined) continue;
      const pv = toks[i - 1];
      if (pv && (pv.t === "." || pv.t === ":" || pv.t === "goto" || pv.t === "::")) continue;
      if (region) continue;
      if (paramCtx && paren.length === paramCtx.depth && pv && (pv.t === "(" || pv.t === ",")) {
        const id = mkDecl(i);
        frames[paramCtx.frame].vars.set(t, id);
        continue;
      }
      if (t === "type" && isIdent(i + 1) && toks[i + 2] && toks[i + 2].t === "=") { disq.type = 1; region = true; continue; }
      if (t === "export" && isIdent(i + 1) && toks[i + 1].t === "type") { disq.export = 1; continue; }
      for (let f = frames.length - 1; f >= 0; f--) {
        const id = frames[f].vars.get(t);
        if (id !== undefined) { occ[i] = id; break; }
      }
      continue;
    }
    /* keywords */
    if (t === "then") { if (ctrl === "if") frames.push({ vars: new Map(), kind: "then" }); ctrl = null; }
    else if (t === "elseif") { if (frames[frames.length - 1].kind === "then" && frames.length > 1) frames.pop(); frames.push({ vars: new Map(), kind: "then" }); ctrl = "elseif"; }
    else if (t === "else") { if (frames[frames.length - 1].kind === "then" && frames.length > 1) frames.pop(); frames.push({ vars: new Map(), kind: "then" }); ctrl = null; }
    else if (t === "if") ctrl = "if";
    else if (t === "do") {
      frames.push({ vars: new Map(), kind: "do" });
      if (forNames) { for (const p of forNames) frames[frames.length - 1].vars.set(toks[p].t, mark[p]); forNames = null; }
    }
    else if (t === "repeat") frames.push({ vars: new Map(), kind: "rep" });
    else if (t === "until") { if (frames.length > 1 && frames[frames.length - 1].kind === "rep") frames.pop(); }
    else if (t === "end") { if (frames.length > 1) frames.pop(); }
    else if (t === "for") {
      let j = i + 1; forNames = [];
      while (j < n && isIdent(j)) {
        forNames.push(j);
        j++;
        if (toks[j] && toks[j].t === ",") { j++; continue; }
        break;
      }
      for (const p of forNames) mkDecl(p);
    }
    else if (t === "local") {
      let j = i + 1;
      if (toks[j] && toks[j].t === "function" && isIdent(j + 1)) {
        /* local function NAME: visible immediately (recursion) */
        const id = mkDecl(j + 1);
        frames[frames.length - 1].vars.set(toks[j + 1].t, id);
      } else {
        const ids = [];
        while (j < n && isIdent(j)) {
          ids.push(j);
          j++;
          if (toks[j] && toks[j].t === "<") { /* <const>/<close> attribute */
            while (j < n && toks[j].t !== ">") { if (isIdent(j)) mark[j] = -2; j++; }
            if (j < n) j++;
          }
          if (toks[j] && toks[j].t === ",") { j++; continue; }
          break;
        }
        const pend = !!(toks[j] && toks[j].t === "=");
        for (const p of ids) {
          const id = mkDecl(p);
          if (pend) { if (!pending) pending = { frame: frames.length - 1, ids: [] }; pending.ids.push(id); }
          else frames[frames.length - 1].vars.set(toks[p].t, id);
        }
      }
    }
    else if (t === "goto") { if (isIdent(i + 1)) mark[i + 1] = -2; }
  }
  if (pending) {
    const fi = Math.min(pending.frame, frames.length - 1);
    for (const id of pending.ids) frames[fi].vars.set(decls[id].name, id);
  }

  /* short-name bank: a..z A..Z aa..zz, skipping keywords, io/os and anything
     already used as an identifier in this file */
  const BAD2 = { "if":1, "in":1, "do":1, "or":1, "io":1, "os":1 };
  const bank = [];
  for (let c = 97; c < 123; c++) bank.push(String.fromCharCode(c));
  for (let c = 65; c < 91; c++) bank.push(String.fromCharCode(c));
  for (let a = 97; a < 123; a++) for (let b = 97; b < 123; b++) {
    const s = String.fromCharCode(a, b);
    if (!BAD2[s]) bank.push(s);
  }
  let bi = 0;
  const byName = new Map();
  for (const d of decls) {
    if (!d.ok || byName.has(d.name)) continue;
    while (bi < bank.length && usedIdents.has(bank[bi])) bi++;
    if (bi >= bank.length) break;
    byName.set(d.name, bank[bi++]);
  }
  for (const d of decls) if (d.ok && byName.has(d.name)) d.newName = byName.get(d.name);

  /* rewrite: occurrence-resolved refs and declaration sites */
  for (let i = 0; i < n; i++) {
    if (occ[i] >= 0) { const d = decls[occ[i]]; if (d.newName) toks[i].t = d.newName; }
    else if (typeof mark[i] === "number" && mark[i] >= 0) { const d = decls[mark[i]]; if (d.newName) toks[i].t = d.newName; }
  }
  return toks;
}

function minifyLua(src) {
  const n = src.length;
  let i = 0;
  const toks = []; /* {t: text, k: w(ord) | n(umber) | s(tring) | o(p)} */
  const directives = [];
  let anyToken = false;
  function isDigit(c) { return c >= "0" && c <= "9"; }
  function isAlphaU(c) { return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_"; }
  function isAlnumU(c) { return isAlphaU(c) || isDigit(c); }
  function pushTok(tok, k) {
    if (tok === "") return;
    if (k === "n") tok = minNum(tok);
    toks.push({ t: tok, k: k });
    anyToken = true;
  }
  if (src[0] === "#") { /* shebang line stays verbatim on line 1 */
    let j = src.indexOf("\n");
    if (j < 0) j = n;
    directives.push(src.slice(0, j).replace(/\s+$/, ""));
    i = j + 1;
  }
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\v" || c === "\f") { i++; continue; }
    if (c === "-" && src[i + 1] === "-") {
      let j = i + 2;
      if (src[j] === "[") {
        let k = j + 1, eq = 0;
        while (src[k] === "=") { eq++; k++; }
        if (src[k] === "[") {
          const close = "]" + "=".repeat(eq) + "]";
          const end = src.indexOf(close, k + 1);
          i = end < 0 ? n : end + close.length;
          continue;
        }
      }
      if ((src[j] === "!" || src[j] === "@") && !anyToken) { /* keep leading --! / --@ directives */
        let e = i;
        while (e < n && src[e] !== "\n" && src[e] !== "\r") e++;
        directives.push(src.slice(i, e).replace(/\s+$/, ""));
        i = e;
        continue;
      }
      let e = i;
      while (e < n && src[e] !== "\n" && src[e] !== "\r") e++; /* real lexers end line comments at \n OR \r */
      i = e;
      continue;
    }
    if (c === "[") {
      let k = i + 1, eq = 0;
      while (src[k] === "=") { eq++; k++; }
      if (src[k] === "[") {
        const close = "]" + "=".repeat(eq) + "]";
        const end = src.indexOf(close, k + 1);
        const stop = end < 0 ? n : end + close.length;
        pushTok(src.slice(i, stop), "s");
        i = stop;
        continue;
      }
      pushTok("[", "o"); i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          /* \z (Lua 5.2+/Luau) skips ALL following whitespace incl. newlines;
             \<CR><LF> is one escape; content is copied verbatim either way —
             only the string END detection matters here */
          const e2 = src[j + 1];
          if (e2 === "z") { j += 2; while (j < n && " \t\n\r\v\f".indexOf(src[j]) >= 0) j++; continue; }
          if (e2 === "\r" && src[j + 2] === "\n") { j += 3; continue; }
          j += 2; continue;
        }
        if (src[j] === c) { j++; break; }
        if (src[j] === "\n" || src[j] === "\r") break;
        j++;
      }
      pushTok(src.slice(i, j), "s");
      i = j;
      continue;
    }
    if (c === "`") {
      /* Luau interpolated string: kept 100% verbatim (chunks AND the expressions
         inside \{...}); every identifier inside is disqualified from renaming, so
         references in interpolations always stay intact */
      const endIstr = function (start, depth) {
        if (depth > 32) return -1; /* pathological nesting (garbage input) */
        let j = start + 1;
        while (j < n) {
          const d = src[j];
          if (d === "\\") {
            const e2 = src[j + 1];
            if (e2 === "z") { j += 2; while (j < n && " \t\n\r\v\f".indexOf(src[j]) >= 0) j++; continue; }
            if (e2 === "\r" && src[j + 2] === "\n") { j += 3; continue; }
            j += 2; continue;
          }
          if (d === "`") return j + 1;
          if (d === "{") {
            let bd = 1, k = j + 1;
            while (k < n && bd > 0) {
              const e = src[k];
              if (e === "\\") { k += 2; continue; }
              if (e === "'" || e === '"') {
                const q = e;
                k++;
                while (k < n && src[k] !== q && src[k] !== "\n" && src[k] !== "\r") {
                  if (src[k] === "\\") {
                    const e3 = src[k + 1];
                    if (e3 === "z") { k += 2; while (k < n && " \t\n\r\v\f".indexOf(src[k]) >= 0) k++; continue; }
                    if (e3 === "\r" && src[k + 2] === "\n") { k += 3; continue; }
                    k += 2; continue;
                  }
                  k++;
                }
                if (k < n && src[k] === q) k++;
                continue;
              }
              if (e === "`") {
                const r = endIstr(k, depth + 1);
                if (r < 0) return -1;
                k = r;
                continue;
              }
              if (e === "{") bd++;
              else if (e === "}") { bd--; if (bd === 0) { k++; break; } }
              k++;
            }
            if (bd > 0) return -1; /* unterminated interpolation */
            j = k;
            continue;
          }
          j++;
        }
        return -1; /* unterminated */
      };
      const stop = endIstr(i, 0);
      if (stop < 0) return null;
      pushTok(src.slice(i, stop), "is");
      i = stop;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
      /* a +/- directly after e/E/p/P (with an alphanumeric after it) belongs to
         the numeral (matches the real Lua lexer: 1e+5, 2e-3, 0x1p+4, 0xE-1) */
      let j = i;
      while (j < n && (isAlnumU(src[j]) || src[j] === "." ||
        ((src[j] === "+" || src[j] === "-") && "eEpP".indexOf(src[j - 1]) >= 0 && j + 1 < n && isAlnumU(src[j + 1])))) j++;
      pushTok(src.slice(i, j), "n");
      i = j;
      continue;
    }
    if (isAlphaU(c)) {
      let j = i;
      while (j < n && isAlnumU(src[j])) j++;
      pushTok(src.slice(i, j), "w");
      i = j;
      continue;
    }
    if (src.substr(i, 3) === "...") { pushTok("...", "o"); i += 3; continue; }
    const two = src.substr(i, 2);
    if (two === ".." || two === "==" || two === "~=" || two === "<=" || two === ">=" || two === "::") {
      pushTok(two, "o"); i += 2; continue;
    }
    pushTok(c, "o"); i++;
  }
  if (toks.length === 0) return null; /* nothing but comments */
  renameLocals(toks); /* stack pass 2: locals -> a,b,c,... */
  /* drop call parens around a single string argument:
     f("x") -> f'x', game:GetService("Workspace") -> game:GetService'Workspace'
     (backtick strings keep their parens: f(`x`) stays f(`x`)) */
  function callablePrev(tk) {
    if (!tk) return false;
    if (tk.k === "s" || tk.k === "is") return true;
    if (tk.k === "w") return tk.t !== "function"; /* function("x")... would be a param list */
    return tk.t === ")" || tk.t === "]" || tk.t === "}";
  }
  const drop = [];
  for (let i2 = 0; i2 < toks.length; i2++) {
    const tk = toks[i2];
    if (tk.t === "(" && toks[i2 + 1] && toks[i2 + 1].k === "s" &&
        toks[i2 + 2] && toks[i2 + 2].t === ")" && callablePrev(drop[drop.length - 1])) {
      drop.push(toks[i2 + 1]);
      i2 += 2;
    } else drop.push(tk);
  }
  /* join with a space wherever juxtaposition would re-lex differently:
     word/word, number/".", dot/dot (a .. .5 -> a...5 !), minus/minus
     (a - -b -> a--b comment !), open-bracket/bracket (t[ [[k]] ] -> t[[[k]] ) */
  let res = "", lastTok = "", lastWordy = false, lastNumber = false;
  for (const tk of drop) {
    const t = tk.t;
    const wordy = tk.k === "w" || tk.k === "n";
    if ((lastWordy && wordy) || (lastNumber && t[0] === ".") ||
        (lastTok.slice(-1) === "." && t[0] === ".") ||
        (lastTok === "-" && t === "-") ||
        (lastTok === "[" && t[0] === "[")) res += " ";
    res += t;
    lastWordy = wordy; lastNumber = tk.k === "n"; lastTok = t;
  }
  const pre = directives.length ? directives.join("\n") + "\n" : "";
  return pre + res;
}

/* ================= stages 1-3: LZ77 + rep0 + Huffman ================= */
function BitWriter() { this.bytes = []; this.buf = 0; this.cnt = 0; }
BitWriter.prototype.w = function (v, n) {
  if (n === 0) return;
  this.buf |= v << this.cnt;
  this.cnt += n;
  while (this.cnt >= 8) { this.bytes.push(this.buf & 255); this.buf >>>= 8; this.cnt -= 8; }
};
BitWriter.prototype.flush = function () {
  if (this.cnt > 0) { this.bytes.push(this.buf & 255); this.buf = 0; this.cnt = 0; }
};
function revBits(v, n) { let r = 0; for (let i = 0; i < n; i++) { r = (r << 1) | (v & 1); v >>>= 1; } return r; }

function huffLengthsOnce(freqs) {
  const n = freqs.length;
  const lengths = new Array(n).fill(0);
  const leaves = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) leaves.push({ f: freqs[i], sym: i, parent: null });
  if (leaves.length === 0) return lengths;
  if (leaves.length === 1) { lengths[leaves[0].sym] = 1; return lengths; }
  const forest = leaves.slice();
  while (forest.length > 1) {
    let i1 = 0;
    for (let i = 1; i < forest.length; i++) if (forest[i].f < forest[i1].f) i1 = i;
    const n1 = forest.splice(i1, 1)[0];
    let i2 = 0;
    for (let i = 1; i < forest.length; i++) if (forest[i].f < forest[i2].f) i2 = i;
    const n2 = forest.splice(i2, 1)[0];
    const p = { f: n1.f + n2.f, parent: null };
    n1.parent = p; n2.parent = p;
    forest.push(p);
  }
  for (const lf of leaves) {
    let d = 0, p = lf.parent;
    while (p) { d++; p = p.parent; }
    lengths[lf.sym] = d;
  }
  return lengths;
}
function huffLengthsLimited(freqs, maxBits) {
  let f = freqs.slice();
  for (;;) {
    const L = huffLengthsOnce(f);
    let mx = 0;
    for (let i = 0; i < L.length; i++) if (L[i] > mx) mx = L[i];
    if (mx <= maxBits) return L;
    f = f.map(v => v > 0 ? ((v + 1) >> 1) : 0);
  }
}
function canonicalCodes(L) {
  const cnt = new Array(16).fill(0);
  for (let i = 0; i < L.length; i++) if (L[i] > 0) cnt[L[i]]++;
  const next = new Array(16).fill(0);
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + cnt[b - 1]) << 1; next[b] = code; }
  const codes = new Array(L.length).fill(0);
  for (let s = 0; s < L.length; s++) if (L[s] > 0) codes[s] = next[L[s]]++;
  return codes;
}
function writeTreeRLE(bw, L) {
  let i = 0;
  const n = L.length;
  while (i < n) {
    if (L[i] === 0) {
      let run = 0;
      while (i + run < n && L[i + run] === 0) run++;
      while (run > 0) {
        const r = Math.min(64, run);
        bw.w(0, 4); bw.w(r - 1, 6);
        run -= r; i += r;
      }
    } else { bw.w(L[i], 4); i++; }
  }
}

/* match finder: hash chains over 3-byte prefixes */
function makeMF(bytes) {
  const n = bytes.length;
  const HEAD = new Int32Array(65536).fill(-1);
  const PREV = new Int32Array(Math.max(1, n)).fill(-1);
  function insert(p) {
    if (p + 2 < n) {
      const h = ((bytes[p] << 10) ^ (bytes[p + 1] << 5) ^ bytes[p + 2]) & 0xFFFF;
      PREV[p] = HEAD[h]; HEAD[h] = p;
    }
  }
  /* record-breakers: (len, dist) with strictly increasing len & dist */
  function findRecords(p, chainCap, niceCap, recCap, goodCap) {
    const recs = [];
    if (p + 3 > n) return recs;
    const h = ((bytes[p] << 10) ^ (bytes[p + 1] << 5) ^ bytes[p + 2]) & 0xFFFF;
    const maxl = Math.min(MAXLEN, n - p);
    let best = 0, cand = HEAD[h], steps = 0;
    while (cand >= 0 && steps < chainCap) {
      const dist = p - cand;
      if (dist > WINDOW) break;
      let l = 0;
      while (l < maxl && bytes[cand + l] === bytes[p + l]) l++;
      if (l > best) {
        recs.push([l, dist]);
        best = l;
        if (l >= maxl || l >= niceCap || l >= goodCap || recs.length >= recCap) break;
      }
      cand = PREV[cand]; steps++;
    }
    return recs;
  }
  return { insert: insert, findRecords: findRecords };
}

/* greedy parse with lazy matching (pass 1 + fallback) */
function greedyParse(bytes) {
  const mf = makeMF(bytes);
  const tokens = [];
  /* stronger search: longer nice-length, deeper chains, more record candidates.
     >4 MiB inputs keep the leaner v7 depth so huge files don't crawl. */
  const GOOD = 64, NICE = 8192,
    CHAIN = (bytes.length > 4194304 ? 1024 : 2048),
    RECCAP = (bytes.length > 4194304 ? 32 : 64);
  const n = bytes.length;
  let p = 0;
  while (p < n) {
    const recs = mf.findRecords(p, CHAIN, NICE, RECCAP, GOOD);
    const best = recs.length ? recs[recs.length - 1] : null;
    if (best && best[0] >= 3 && best[0] < GOOD && p + 4 <= n) {
      const recs2 = mf.findRecords(p + 1, CHAIN, NICE, RECCAP, GOOD);
      const best2 = recs2.length ? recs2[recs2.length - 1] : null;
      if (best2 && best2[0] > best[0]) { tokens.push(bytes[p]); mf.insert(p); p += 1; continue; }
    }
    if (best && best[0] >= 3) {
      tokens.push(-1, best[0], best[1]);
      for (let q = p; q < p + best[0]; q++) mf.insert(q);
      p += best[0];
    } else {
      tokens.push(bytes[p]);
      mf.insert(p);
      p += 1;
    }
  }
  return tokens;
}

/* optimal parse: DP over positions using real Huffman bit costs */
function dpParse(bytes, costs) {
  const n = bytes.length;
  const mf = makeMF(bytes);
  const cost = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) cost[i] = Infinity;
  const tlen = new Int32Array(n + 1);
  const tdist = new Int32Array(n + 1);
  cost[0] = 0;
  const LIT_EPS = 0.001;
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    if (base === Infinity) continue;
    if (i + 3 <= n) {
      const recs = mf.findRecords(i, 256, 4096, 32, Infinity);
      let prevLen = 2;
      for (let r = 0; r < recs.length; r++) {
        const len = recs[r][0], dist = recs[r][1];
        const dc = dist2code[dist];
        const dBits = costs.distB[dc] + DIST_E[dc];
        /* relax every length-code base covered by this record (cheapest way to reach those lengths) */
        const cLo = prevLen >= 3 ? len2code[prevLen] + 1 : 0;
        const cHi = len2code[len];
        for (let c2 = cLo; c2 <= cHi; c2++) {
          const B = LEN_B[c2];
          if (B > prevLen && B <= len) {
            const lc = c2;
            const cc = base + costs.lenB[lc] + LEN_E[lc] + dBits;
            if (cc < cost[i + B]) { cost[i + B] = cc; tlen[i + B] = B; tdist[i + B] = dist; }
          }
        }
        /* relax the record's full length */
        const lc = len2code[len];
        const cc = base + costs.lenB[lc] + LEN_E[lc] + dBits;
        if (cc < cost[i + len]) { cost[i + len] = cc; tlen[i + len] = len; tdist[i + len] = dist; }
        prevLen = len;
      }
    }
    const cl = base + costs.lit[bytes[i]] + LIT_EPS;
    if (cl < cost[i + 1]) { cost[i + 1] = cl; tlen[i + 1] = 1; tdist[i + 1] = 0; }
    mf.insert(i);
  }
  const groups = [];
  let p = n;
  while (p > 0) {
    const L = tlen[p];
    if (L <= 0) return greedyParse(bytes); /* safety net, unreachable */
    if (L === 1) groups.push([bytes[p - 1]]);
    else groups.push([-1, L, tdist[p]]);
    p -= L;
  }
  groups.reverse();
  const tokens = [];
  for (let g = 0; g < groups.length; g++) {
    const gr = groups[g];
    for (let k = 0; k < gr.length; k++) tokens.push(gr[k]);
  }
  return tokens;
}

/* LZMA-style rep-distances: matches at the last or second-to-last distance pay
   no distance bits. -1,len,dist = normal match; -2,len = rep0; -3,len = rep1 */
function convertReps(tokens) {
  const out = [];
  let lastDist = 0, prevDist = 0, i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t >= 0) { out.push(t); i++; }
    else if (t === -2) { out.push(-2, tokens[i + 1]); i += 2; }
    else {
      const len = tokens[i + 1], dist = tokens[i + 2];
      if (dist === lastDist) out.push(-2, len);
      else if (dist === prevDist) { out.push(-3, len); const td = prevDist; prevDist = lastDist; lastDist = td; }
      else { out.push(-1, len, dist); prevDist = lastDist; lastDist = dist; }
      i += 3;
    }
  }
  return out;
}

function tokenFreqs(tokens) {
  const freqL = new Array(NSYM).fill(0), freqD = new Array(DIST_B.length).fill(0);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t >= 0) { freqL[t]++; i++; }
    else if (t === -2) { freqL[293 + len2code[tokens[i + 1]]]++; i += 2; }
    else if (t === -3) { freqL[329 + len2code[tokens[i + 1]]]++; i += 2; }
    else {
      const lc = len2code[tokens[i + 1]];
      freqL[257 + lc]++;
      freqD[dist2code[tokens[i + 2]]]++;
      i += 3;
    }
  }
  freqL[256]++; /* EOB */
  return { freqL: freqL, freqD: freqD };
}
function treesFromTokens(tokens) {
  const fr = tokenFreqs(tokens);
  const Ll = huffLengthsLimited(fr.freqL, 15);
  let Ld = huffLengthsLimited(fr.freqD, 15);
  if (Ld.every(x => x === 0)) Ld[0] = 1;
  return { Ll: Ll, Ld: Ld };
}
function costsFromTrees(Ll, Ld) {
  const lit = new Float64Array(256), lenB = new Float64Array(36), distB = new Float64Array(DIST_B.length);
  for (let s = 0; s < 256; s++) lit[s] = Ll[s] > 0 ? Ll[s] : 12;
  for (let lc = 0; lc < 36; lc++) lenB[lc] = Ll[257 + lc] > 0 ? Ll[257 + lc] : 12;
  for (let dc = 0; dc < DIST_B.length; dc++) distB[dc] = Ld[dc] > 0 ? Ld[dc] : 12;
  return { lit: lit, lenB: lenB, distB: distB };
}
function estimateBits(tokens, Ll, Ld) {
  let bits = 0, i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t >= 0) { bits += Ll[t] || 12; i++; }
    else if (t === -2) { const lc = len2code[tokens[i + 1]]; bits += (Ll[293 + lc] || 12) + LEN_E[lc]; i += 2; }
    else if (t === -3) { const lc = len2code[tokens[i + 1]]; bits += (Ll[329 + lc] || 12) + LEN_E[lc]; i += 2; }
    else {
      const lc = len2code[tokens[i + 1]], dc = dist2code[tokens[i + 2]];
      bits += (Ll[257 + lc] || 12) + LEN_E[lc] + (Ld[dc] || 12) + DIST_E[dc];
      i += 3;
    }
  }
  return bits + (Ll[256] || 12);
}

/* block encoder: ~16K tokens per block, per-block Huffman trees */
function encodeTokens(bytes, tokens, blockCap) {
  const bw = new BitWriter();
  let blocks = 0;
  function flushBlock(start, end, final) {
    const freqL = new Array(NSYM).fill(0), freqD = new Array(DIST_B.length).fill(0);
    for (let t = start; t < end; t++) {
      const tk = tokens[t];
      if (tk >= 0) { freqL[tk]++; }
      else if (tk === -2) { t++; freqL[293 + len2code[tokens[t]]]++; }
      else if (tk === -3) { t++; freqL[329 + len2code[tokens[t]]]++; }
      else {
        t++;
        const len = tokens[t]; t++;
        const dist = tokens[t];
        freqL[257 + len2code[len]]++;
        freqD[dist2code[dist]]++;
      }
    }
    freqL[256]++;
    const Ll = huffLengthsLimited(freqL, 15);
    let Ld = huffLengthsLimited(freqD, 15);
    if (Ld.every(x => x === 0)) Ld[0] = 1;
    const cl = canonicalCodes(Ll), cd = canonicalCodes(Ld);
    bw.w(final ? 1 : 0, 1);
    writeTreeRLE(bw, Ll);
    writeTreeRLE(bw, Ld);
    for (let t = start; t < end; t++) {
      const tk = tokens[t];
      if (tk >= 0) {
        bw.w(revBits(cl[tk], Ll[tk]), Ll[tk]);
      } else if (tk === -2) {
        t++;
        const lc = len2code[tokens[t]];
        bw.w(revBits(cl[293 + lc], Ll[293 + lc]), Ll[293 + lc]);
        bw.w(tokens[t] - LEN_B[lc], LEN_E[lc]);
      } else if (tk === -3) {
        t++;
        const lc = len2code[tokens[t]];
        bw.w(revBits(cl[329 + lc], Ll[329 + lc]), Ll[329 + lc]);
        bw.w(tokens[t] - LEN_B[lc], LEN_E[lc]);
      } else {
        t++;
        const len = tokens[t]; t++;
        const dist = tokens[t];
        const lc = len2code[len];
        bw.w(revBits(cl[257 + lc], Ll[257 + lc]), Ll[257 + lc]);
        bw.w(len - LEN_B[lc], LEN_E[lc]);
        const dc = dist2code[dist];
        bw.w(revBits(cd[dc], Ld[dc]), Ld[dc]);
        bw.w(dist - DIST_B[dc], DIST_E[dc]);
      }
    }
    bw.w(revBits(cl[256], Ll[256]), Ll[256]);
  }
  let i = 0;
  if (tokens.length === 0) { flushBlock(0, 0, true); blocks++; }
  while (i < tokens.length) {
    const start = i;
    let count = 0;
    while (i < tokens.length && count < blockCap) {
      const tk = tokens[i];
      if (tk >= 0) i++;
      else if (tk === -2 || tk === -3) i += 2;
      else i += 3;
      count++;
    }
    flushBlock(start, i, i >= tokens.length);
    blocks++;
  }
  bw.flush();
  return { bytes: bw.bytes, tokens: tokens, blocks: blocks };
}

function encodeLZH(bytes) {
  buildLookups();
  const greedy = convertReps(greedyParse(bytes));
  /* optimal parse when it can matter: small/medium-size, not already ultra-compressible */
  const tr0 = treesFromTokens(greedy);
  const bits0 = estimateBits(greedy, tr0.Ll, tr0.Ld);
  const useDP = bytes.length >= 64 && bytes.length <= 2097152 && bits0 > bytes.length * 8 * 0.06;
  const cands = [{ toks: greedy, dp: false }];
  if (useDP) {
    const iters = bytes.length <= 131072 ? 2 : 1;
    let cur = greedy;
    for (let k = 0; k < iters; k++) {
      const tr = treesFromTokens(cur);
      const costs = costsFromTrees(tr.Ll, tr.Ld);
      cur = convertReps(dpParse(bytes, costs));
      cands.push({ toks: cur, dp: true });
    }
  }
  let best = null, bestDP = false;
  /* stronger: for every parse, try two Huffman block sizes and keep the smallest */
  for (let c = 0; c < cands.length; c++) {
    for (const cap of [16384, 65536]) {
      const enc = encodeTokens(bytes, cands[c].toks, cap);
      if (!best || enc.bytes.length < best.bytes.length) { best = enc; bestDP = cands[c].dp; }
    }
  }
  return { bytes: best.bytes, tokens: best.tokens, blocks: best.blocks, usedDP: bestDP };
}

/* ================= stage 4b: adaptive range coder (LZMA-style) =================
   Same token stream as the Huffman path, but entropy-coded with an adaptive
   binary range coder: 11-bit probabilities, bit-trees for length/distance codes,
   order-1 literal contexts (top 3 bits of previous byte) and LZMA's
   match-byte literal mode. No blocks, no serialized trees - the adaptation IS
   the model. Typically 6-12% smaller than the per-block Huffman stage.
   The encoder always emits BOTH and keeps whichever is smaller. */
const RC_ISMATCH = 0, RC_ISREP = 1, RC_ISREP0 = 2,
  RC_LT = 8, RC_DT = 72, RC_LIT = 200, RC_XL = 6344, RC_XD = 6358, RC_NP = 6376;

function rcEncodeTokens(bytes, tokens) {
  const P = new Uint16Array(RC_NP);
  P.fill(1024);
  const out = [];
  let low = 0, range = 4294967295, cache = 0, cacheSize = 1;
  function shiftLow() {
    const lo32 = low % 4294967296;
    const carry = (low - lo32) / 4294967296;
    if (lo32 < 4278190080 /* 0xFF000000 */ || carry !== 0) {
      let temp = cache;
      do { out.push((temp + carry) & 255); temp = 255; } while (--cacheSize !== 0);
      cache = (lo32 - (lo32 % 16777216)) / 16777216;
    }
    cacheSize++;
    low = (lo32 * 256) % 4294967296;
  }
  function bit(idx, b) {
    const p = P[idx];
    const bound = Math.floor(range / 2048) * p;
    if (b === 0) { range = bound; P[idx] = p + ((2048 - p) >> 5); }
    else { low += bound; range -= bound; P[idx] = p - (p >> 5); }
    while (range < 16777216) { shiftLow(); range *= 256; }
  }
  function tree(off, sym, nbits) {
    let node = 1;
    for (let i = nbits - 1; i >= 0; i--) {
      const b = (sym >> i) & 1;
      bit(off + node, b);
      node = (node << 1) | b;
    }
  }
  function direct(val, n, base) { /* MSB first, adaptive per bit position */
    for (let i = n - 1; i >= 0; i--) bit(base + i, (val >> i) & 1);
  }
  let lastDist = 0, prevDist = 0, afterMatch = false, p = 0;
  function encLit(byte) {
    const prev = p > 0 ? bytes[p - 1] : 0;
    const base = RC_LIT + (prev >> 5) * 768;
    let sym = 1, b = byte;
    if (afterMatch) {
      let mb = bytes[p - lastDist];
      while (sym < 256) {
        const mbit = (mb >> 7) & 1;
        mb = (mb << 1) & 255;
        const ob = (b >> 7) & 1;
        b = (b << 1) & 255;
        bit(base + ((1 + mbit) << 8) + sym, ob);
        sym = (sym << 1) | ob;
        if (mbit !== ob) {
          while (sym < 256) { const o2 = (b >> 7) & 1; b = (b << 1) & 255; bit(base + sym, o2); sym = (sym << 1) | o2; }
          return;
        }
      }
      return;
    }
    while (sym < 256) {
      const ob = (b >> 7) & 1;
      b = (b << 1) & 255;
      bit(base + sym, ob);
      sym = (sym << 1) | ob;
    }
  }
  function encLen(len) {
    const lc = len2code[len];
    tree(RC_LT, lc, 6);
    direct(len - LEN_B[lc], LEN_E[lc], RC_XL);
  }
  function encDist(dist) {
    const dc = dist2code[dist];
    tree(RC_DT, dc, 7);
    direct(dist - DIST_B[dc], DIST_E[dc], RC_XD);
  }
  buildLookups();
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t >= 0) {
      bit(RC_ISMATCH, 0);
      encLit(t);
      p++; afterMatch = false; i++;
    } else if (t === -2) {
      bit(RC_ISMATCH, 1); bit(RC_ISREP, 1); bit(RC_ISREP0, 0);
      encLen(tokens[i + 1]);
      p += tokens[i + 1]; afterMatch = true; i += 2;
    } else if (t === -3) {
      bit(RC_ISMATCH, 1); bit(RC_ISREP, 1); bit(RC_ISREP0, 1);
      encLen(tokens[i + 1]);
      const td = prevDist; prevDist = lastDist; lastDist = td; /* mirror the decoder's rep1 swap */
      p += tokens[i + 1]; afterMatch = true; i += 2;
    } else {
      bit(RC_ISMATCH, 1); bit(RC_ISREP, 0);
      encLen(tokens[i + 1]);
      encDist(tokens[i + 2]);
      p += tokens[i + 1];
      prevDist = lastDist; lastDist = tokens[i + 2];
      afterMatch = true; i += 3;
    }
  }
  for (let k = 0; k < 5; k++) shiftLow();
  return out;
}

/* ================= stage 5: ASCII85 ================= */
function b85encode(bytes, alpha) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const k = Math.min(4, bytes.length - i);
    let v = 0;
    for (let j = 0; j < 4; j++) v = v * 256 + (j < k ? bytes[i + j] : 0);
    let d = "";
    for (let j = 0; j < 5; j++) { d = alpha[v % 85] + d; v = Math.floor(v / 85); }
    out += (k === 4) ? d : d.slice(0, k + 1);
  }
  return out;
}

/* ---- deterministic short names + loader template ---- */
const SINGLE_KEYS = ["e", "i", "f", "g", "j", "k", "x", "y", "h", "l", "m", "q", "r", "s", "t", "u", "v", "w", "z", "o", "p"];
const MULTI_KEYS = ["A", "vv", "m2", "tag", "src", "n2", "v2", "LB", "LE", "DB", "DE", "bb", "rl", "lens", "ci", "L2", "rr", "cnt", "fst", "off", "cur", "symtab", "code", "idx", "a1", "a2", "a3", "a4", "cn", "dd", "chr", "fin", "t1", "t2", "t3", "t4", "y1", "y2", "y3", "y4", "li", "len", "ds", "dst", "hh", "fn", "em", "ld", "ld2", "Pp", "sp", "rq", "pz", "rb", "db", "dt", "dx", "dl", "am", "cb", "bs", "s2", "mb", "mi", "ok2", "lc", "ln", "dc", "z3", "q2", "q3", "q4", "q5", "of2", "nb2", "i3", "pr", "bnd", "v3", "v4"];
/* the skeleton owns a,b,c,d; engine locals continue e..z, then 2-char
   (aa, ab, ...), then 3-char when the bank runs out. Keywords and globals
   the engine touches are skipped. */
const NAME_SKIP = {
  "and": 1, "break": 1, "do": 1, "else": 1, "elseif": 1, "end": 1, "false": 1,
  "for": 1, "function": 1, "goto": 1, "if": 1, "in": 1, "local": 1, "nil": 1,
  "not": 1, "or": 1, "repeat": 1, "return": 1, "then": 1, "true": 1, "until": 1,
  "while": 1,
  "io": 1, "os": 1, "math": 1, "string": 1, "table": 1, "error": 1,
  "tostring": 1, "tonumber": 1, "unpack": 1, "loadstring": 1, "setfenv": 1
};
function shortNameAt(i) {
  if (i < 22) return String.fromCharCode(101 + i); /* e..z */
  let n = i - 22, len = 2, per = 676;
  while (n >= per) { n -= per; len++; per *= 26; }
  let s = "";
  for (let k = 0; k < len; k++) { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function makeNames() {
  const names = {};
  let idx = 0;
  for (const key of SINGLE_KEYS.concat(MULTI_KEYS)) {
    let s;
    do { s = shortNameAt(idx++); } while (NAME_SKIP[s]);
    names[key] = s;
  }
  return names;
}

/* engine statements, @name tokens get substituted (@ never appears in Lua code) */
function engineStatements(dumpMode, tag) {
  const S = [];
  S.push('local @A="@ALPHA"');
  S.push("local @e={} for @i=1,#@A do @e[@A:byte(@i)]=@i-1 end");
  S.push("local @f,@g={},0 local @i=1");
  S.push("while @i<=#d do local @j=@i+4;local @k=5 if @j>#d then @j=#d;@k=#d-@i+1 end if @k<2 then error(\"corrupt: dangling char\",0) end local @vv=0 for @x=@i,@j do local @y=@e[d:byte(@x)] if not @y then error(\"corrupt: bad char\",0) end @vv=@vv*85+@y end if @k<5 then @vv=@vv*85^(5-@k);local @m2=256^(5-@k);@vv=math.ceil(@vv/@m2)*@m2 end @g=@g+1 @f[@g]=string.char(math.floor(@vv/16777216),math.floor(@vv/65536)%256,math.floor(@vv/256)%256,@vv%256):sub(1,@k-1) @i=@i+5 end");
  S.push("local @h=table.concat(@f)");
  S.push("if #@h<9 then error(\"corrupt: header\",0) end");
  S.push("local @l=@h:byte(2)+@h:byte(3)*256+@h:byte(4)*65536+@h:byte(5)*16777216");
  S.push("local @m=@h:byte(6)+@h:byte(7)*256+@h:byte(8)*65536+@h:byte(9)*16777216");
  S.push("local @src");
  /* one engine per format: a loader only ever carries the decoder for the
     format tag it actually ships — no dead branches riding along */
  const IF = [];
  if (tag === 1) {
  IF.push("local @q,@r,@s=10,0,0");
  IF.push("local function @t() if @s==0 then @r=@h:byte(@q) if not @r then error(\"corrupt: data\",0) end @q=@q+1;@s=8 end local @z=@r%2;@r=math.floor(@r/2);@s=@s-1 return @z end");
  IF.push("local function @u(@n2) local @v2=0 for @j=1,@n2 do @v2=@v2+@t()*2^(@j-1) end return @v2 end");
  IF.push("local @LB,@LE={},{} local @bb=3 for @j=1,8 do @LB[@j]=@bb;@LE[@j]=0;@bb=@bb+1 end for @j=1,14 do for @k=0,1 do @LB[#@LB+1]=@bb;@LE[#@LE+1]=@j;@bb=@bb+2^@j end end");
  IF.push("local @DB,@DE={},{} @bb=1 for @j=1,4 do @DB[@j]=@bb;@DE[@j]=0;@bb=@bb+1 end for @j=1,18 do for @k=0,3 do @DB[#@DB+1]=@bb;@DE[#@DE+1]=@j;@bb=@bb+2^@j end end");
  IF.push("local function @rl(@n2) local @lens,@ci={},0 while @ci<@n2 do local @L2=@u(4) if @L2>0 then @ci=@ci+1;@lens[@ci]=@L2 else local @rr=@u(6)+1 for @j=1,@rr do @ci=@ci+1;@lens[@ci]=0 end end if @ci>@n2 then error(\"corrupt: tree\",0) end end return @lens end");
  IF.push("local function @v(@lens) local @cnt,@fst,@off,@cur,@symtab={},{},{},{},{} for @j=0,15 do @cnt[@j]=0 end for @j=1,#@lens do local @L2=@lens[@j] if @L2>0 then @cnt[@L2]=@cnt[@L2]+1 end end local @code=0 for @j=1,15 do @code=(@code+@cnt[@j-1])*2;@fst[@j]=@code end local @idx=1 for @j=1,15 do @off[@j]=@idx;@cur[@j]=@idx;@idx=@idx+@cnt[@j] end for @j=1,#@lens do local @L2=@lens[@j] if @L2>0 then @symtab[@cur[@L2]]=@j-1;@cur[@L2]=@cur[@L2]+1 end end return @cnt,@fst,@off,@symtab end");
  IF.push("local function @w(@a1,@a2,@a3,@a4) local @code=0 for @j=1,15 do @code=@code*2+@t() local @cn=@a1[@j] if @cn>0 then local @dd=@code-@a2[@j] if @dd>=0 and @dd<@cn then return @a4[@a3[@j]+@dd] end end end error(\"corrupt: huff code\",0) end");
  IF.push("local @o,@p={},0 local @chr={} for @j=0,255 do @chr[@j]=string.char(@j) end local @ld,@ld2=0,0");
  IF.push("while true do local @fin=@t() local @t1,@t2,@t3,@t4=@v(@rl(365)) local @y1,@y2,@y3,@y4=@v(@rl(76)) while true do local @z=@w(@t1,@t2,@t3,@t4) if @z==256 then break end if @z<256 then @p=@p+1;@o[@p]=@chr[@z] else local @li,@len,@ds,@dst if @z>328 then @li=@z-328;@len=@LB[@li]+@u(@LE[@li]);@dst=@ld2;@ld2=@ld;@ld=@dst elseif @z>292 then @li=@z-292;@len=@LB[@li]+@u(@LE[@li]);@dst=@ld else @li=@z-256;@len=@LB[@li]+@u(@LE[@li]);@ds=@w(@y1,@y2,@y3,@y4);@dst=@DB[@ds+1]+@u(@DE[@ds+1]);@ld2=@ld;@ld=@dst end if @dst<1 or @dst>@p then error(\"corrupt: distance\",0) end for @j=1,@len do @p=@p+1;@o[@p]=@o[@p-@dst] end end end if @fin==1 then break end end");
  IF.push("@src=table.concat(@o)");
  } else if (tag === 2) {
  /* tag 2: LZ77 + adaptive range coder (LZMA-style) */
  IF.push("if #@h<14 then error(\"corrupt: header\",0) end");
  IF.push("local @o,@p={},0 local @chr={} for @j=0,255 do @chr[@j]=string.char(@j) end local @ld,@ld2=0,0");
  IF.push("local @LB,@LE={},{} local @bb=3 for @j=1,8 do @LB[@j]=@bb;@LE[@j]=0;@bb=@bb+1 end for @j=1,14 do for @k=0,1 do @LB[#@LB+1]=@bb;@LE[#@LE+1]=@j;@bb=@bb+2^@j end end");
  IF.push("local @DB,@DE={},{} @bb=1 for @j=1,4 do @DB[@j]=@bb;@DE[@j]=0;@bb=@bb+1 end for @j=1,18 do for @k=0,3 do @DB[#@DB+1]=@bb;@DE[#@DE+1]=@j;@bb=@bb+2^@j end end");
  IF.push("local @Pp={} for @j=0,6375 do @Pp[@j]=1024 end");
  IF.push("local @sp,@rq,@pz=15,4294967295,0");
  IF.push("local @q2,@q3,@q4,@q5=@h:byte(11,14) local @rr=@q2*16777216+@q3*65536+@q4*256+@q5");
  IF.push("local function @rb() local @z3=@h:byte(@sp) @sp=@sp+1 if not @z3 then @pz=@pz+1 if @pz>8 then error(\"corrupt: truncated\",0) end return 0 end return @z3 end");
  IF.push("local function @db(@i3) local @pr=@Pp[@i3] local @bnd=math.floor(@rq/2048)*@pr local @z3 if @rr<@bnd then @rq=@bnd @Pp[@i3]=@pr+math.floor((2048-@pr)/32) @z3=0 else @rr=@rr-@bnd @rq=@rq-@bnd @Pp[@i3]=@pr-math.floor(@pr/32) @z3=1 end while @rq<16777216 do @rq=@rq*256 @rr=(@rr*256+@rb())%4294967296 end return @z3 end");
  IF.push("local function @dt(@of2,@nb2) local @s2=1 for @j=1,@nb2 do @s2=@s2*2+@db(@of2+@s2) end return @s2-2^@nb2 end");
  IF.push("local function @dx(@nb2,@of2) local @v3=0 for @j=@nb2-1,0,-1 do @v3=@v3*2+@db(@of2+@j) end return @v3 end");
  IF.push("local @am=false");
  IF.push("local function @dl() local @cb=0 if @p>0 then @cb=@o[@p]:byte() end local @bs=200+math.floor(@cb/32)*768 local @s2=1 if @am then local @mb=@o[@p-@ld+1]:byte() local @ok2=false while @s2<256 do local @mi=math.floor(@mb/128) @mb=(@mb*2)%256 local @z3=@db(@bs+(1+@mi)*256+@s2) @s2=@s2*2+@z3 if @mi~=@z3 then @ok2=true break end end if @ok2 then while @s2<256 do @s2=@s2*2+@db(@bs+@s2) end end return @s2-256 end while @s2<256 do @s2=@s2*2+@db(@bs+@s2) end return @s2-256 end");
  IF.push("while @p<@l do if @db(0)==0 then local @v4=@dl() @p=@p+1 @o[@p]=@chr[@v4] @am=false else local @dst if @db(1)==1 then if @db(2)==0 then @dst=@ld else @dst=@ld2 @ld2=@ld @ld=@dst end local @lc=@dt(8,6) if @lc>35 then error(\"corrupt: len code\",0) end local @ln=@LB[@lc+1]+@dx(@LE[@lc+1],6344) if @dst<1 or @dst>@p then error(\"corrupt: distance\",0) end for @j=1,@ln do @p=@p+1 @o[@p]=@o[@p-@dst] end @am=true else local @lc=@dt(8,6) if @lc>35 then error(\"corrupt: len code\",0) end local @ln=@LB[@lc+1]+@dx(@LE[@lc+1],6344) local @dc=@dt(72,7) if @dc>75 then error(\"corrupt: dist code\",0) end @dst=@DB[@dc+1]+@dx(@DE[@dc+1],6358) if @dst<1 or @dst>@p then error(\"corrupt: distance\",0) end @ld2=@ld @ld=@dst for @j=1,@ln do @p=@p+1 @o[@p]=@o[@p-@dst] end @am=true end end end");
  IF.push("@src=table.concat(@o)");
  } else {
    IF.push("@src=@h:sub(10)");
  }
  for (const line of IF) S.push(line);
  S.push("if #@src~=@l then error(\"corrupt: length\",0) end");
  S.push("local @hh=0 for @i=1,#@src do @hh=(@hh*1000003+@src:byte(@i))%4294967296 end if @hh~=@m then error(\"corrupt: checksum\",0) end");
  if (dumpMode) {
    S.push("io.write(@src)");
  } else {
    S.push("local @fn,@em=c(@src,\"=payload\")");
    S.push("if not @fn then error(\"payload failed to compile: \"..tostring(@em),0) end");
    S.push("if setfenv and b then setfenv(@fn,b) end");
    S.push("return a({@fn()})");
  }
  return S;
}

function buildLoader(payloadText, seed, stats, opts) {
  opts = opts || {};
  const rng = mulberry32(seed >>> 0);
  const alpha = shuffle(B85.split(""), rng).join("");
  const names = makeNames();
  names.ALPHA = alpha;
  const level = 1 + Math.floor(rng() * 3);
  const open = "[" + "=".repeat(level) + "[";
  const close = "]" + "=".repeat(level) + "]";
  const stmts = engineStatements(opts.mode === "dump", stats.entropy);
  const joiners = [];
  for (let i = 0; i < stmts.length - 1; i++) joiners.push(rng() < 0.5 ? " " : ";");
  let engine = "";
  for (let i = 0; i < stmts.length; i++) {
    if (i > 0) engine += joiners[i - 1];
    engine += stmts[i].replace(/@(\w+)/g, function (m, k) {
      if (!(k in names)) throw new Error("template bug: unknown name " + k);
      return names[k];
    });
  }
  const head =
    "return(function()" +
    "local a,b,c,d=(unpack or table.unpack),(_ENV or getgenv and getgenv() or getfenv and getfenv() or _G)," +
    "(function(...)local l=(loadstring or load) if not l then error(\"loadstring unavailable\",0) end return l(...) end)," +
    "(" + open + payloadText + close + ") " + engine + " " +
    "end)()";
  const pct = (1 - head.length / Math.max(1, stats.origBytes)) * 100;
  const entropyName = stats.entropy === 2 ? "range" : (stats.entropy === 1 ? "Huffman" : "stored");
  const pctTxt = (pct >= 0 ? Math.round(pct * 10) / 10 + "% smaller" : Math.round(-pct * 10) / 10 + "% larger");
  const header =
    "--minified by ZipString \[https://tienxida112.github.oi/ZipString/\]"
  return header + "\n" + head + "\n";
}

function compressToLoader(inputStr, opts) {
  if (typeof inputStr !== "string") throw new Error("input must be a string (got " + typeof inputStr + ")");
  opts = opts || {};
  /* true-random seed: crypto u32s x performance.now x Date.now x Math.random,
     golden-ratio mixed (reworked by the boss) */
  let trueRandomUint32 = Math.floor(Math.random() * 4294967296) >>> 0;
  try {
    const cryptoObj = globalThis.crypto ||
      (typeof window !== "undefined" && (window.crypto || window.msCrypto)) || null;
    if (cryptoObj && cryptoObj.getRandomValues) {
      const array = new Uint32Array(8);
      cryptoObj.getRandomValues(array);
      let mixed = (Math.floor(performance.now() * 1000000) ^ Date.now() ^ trueRandomUint32) >>> 0;
      for (let i = 0; i < array.length; i++) {
        mixed = Math.imul(mixed ^ array[i], 2654435761) >>> 0;
      }
      trueRandomUint32 = (mixed ^ (mixed >>> 16)) >>> 0;
    }
  } catch (e) { /* stay with the Math.random mix */ }
  const seed = (opts.seed === undefined || opts.seed === null || opts.seed === "" || isNaN(+opts.seed))
    ? trueRandomUint32 : (+opts.seed >>> 0);
  const origBytes = new TextEncoder().encode(inputStr).length;
  let workStr = inputStr, minified = false;
  if (opts.minify !== false) {
    const m = minifyLua(inputStr);
    if (m !== null && new TextEncoder().encode(m).length > 0) { workStr = m; minified = true; }
  }
  const bytes = new TextEncoder().encode(workStr);
  if (bytes.length === 0) throw new Error("input is empty — nothing to compress");
  const H = hash32(bytes);
  const rng = mulberry32(seed);
  const alpha = shuffle(B85.split(""), rng).join("");
  const lzh = encodeLZH(bytes);
  const lzhContainer = [1].concat(le32(bytes.length), le32(H), lzh.bytes);
  const rcBytes = rcEncodeTokens(bytes, lzh.tokens);
  const rcContainer = [2].concat(le32(bytes.length), le32(H), rcBytes);
  const storedContainer = [0].concat(le32(bytes.length), le32(H), Array.from(bytes));
  const forced = opts.entropy === "rc" || opts.entropy === "huffman" || opts.entropy === "stored" ? opts.entropy : "auto";
  const allowed = forced === "rc" ? [2, 0] : (forced === "huffman" ? [1, 0] : (forced === "stored" ? [0] : [2, 1, 0]));
  const containers = { 2: rcContainer, 1: lzhContainer, 0: storedContainer };
  let tag = allowed[0], container = containers[tag], text = "", bestLoader = "", best = Infinity;
  for (const t of allowed) {
    const t2 = b85encode(Uint8Array.from(containers[t]), alpha);
    const st = { origBytes: origBytes, workBytes: bytes.length, payloadChars: t2.length, payloadBytes: containers[t].length, entropy: t };
    const ld = buildLoader(t2, seed, st, { mode: opts.mode === "dump" ? "dump" : "run" });
    if (ld.length < best) { best = ld.length; tag = t; container = containers[t]; text = t2; bestLoader = ld; }
  }
  /* raw mode (auto only): when even the smallest engine costs more than it saves
     (tiny or incompressible input), the smallest honest "loader" is the minified
     source itself behind a 4-char marker — no tables, no engine, no ASCII85.
     Sources with a shebang can't ship raw (the marker takes line 1). */
  let isRaw = false;
  if (opts.mode !== "dump" && forced === "auto" && workStr[0] !== "#") {
    const rawL = "--Z\n" + workStr;
    if (rawL.length < best) { best = rawL.length; bestLoader = rawL; isRaw = true; tag = 3; container = null; text = ""; }
  }
  if (isRaw) {
    if (bestLoader.slice(4) !== workStr) throw new Error("internal error: raw loader verification failed");
  } else {
    const back = decodeContainer(b85decode(text, alpha), alpha);
    if (back.tag !== tag || back.len !== bytes.length || back.hash !== H) {
      throw new Error("internal error: container verification failed");
    }
    for (let i = 0; i < bytes.length; i++) {
      if (back.src[i] !== bytes[i]) throw new Error("internal error: payload verification failed");
    }
  }
  const stats = {
    origBytes: origBytes,
    workBytes: bytes.length,
    payloadChars: isRaw ? workStr.length : text.length,
    payloadBytes: isRaw ? bytes.length : container.length,
    entropy: tag
  };
  const loader = bestLoader;
  return {
    loader: loader,
    workText: workStr,
    minified: minified,
    payloadText: text,
    origBytes: origBytes,
    origChars: inputStr.length,
    workBytes: bytes.length,
    payloadBytes: isRaw ? bytes.length : container.length,
    payloadChars: isRaw ? workStr.length : text.length,
    loaderChars: loader.length,
    tokens: countTokens(lzh.tokens),
    blocks: isRaw ? 1 : (tag === 2 ? 1 : lzh.blocks),
    usedDP: lzh.usedDP,
    seed: seed,
    entropy: tag,
    algo: isRaw ? "raw" : (tag === 2 ? "LZ77+range" : (tag === 1 ? "LZ77+Huffman" : "stored"))
  };
}
function countTokens(tokens) {
  let c = 0, i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t >= 0) i++;
    else if (t === -2 || t === -3) i += 2;
    else i += 3;
    c++;
  }
  return c;
}

const SAMPLE_LUA = [
"-- Demo payload: confetti burst + stats (safe to run in Roblox)",
"-- This comment exists so the minifier has something to eat.",
"local Players = game:GetService(\"Players\")",
"local RunService = game:GetService(\"RunService\")",
"",
"local CONFIG = {",
"\tname = \"ConfettiBurst\",",
"\tcount = 32,",
"\tspread = 14,",
"\tcolors = {",
"\t\tColor3.fromRGB(255, 90, 71),",
"\t\tColor3.fromRGB(255, 200, 60),",
"\t\tColor3.fromRGB(90, 200, 255),",
"\t\tColor3.fromRGB(180, 120, 255),",
"\t},",
"}",
"",
"local Stats = { bursts = 0, particles = 0 }",
"",
"local function pick(list, rng)",
"\treturn list[rng:NextInteger(1, #list)]",
"end",
"",
"local function burst(parent, position)",
"\tlocal rng = Random.new()",
"\tlocal model = Instance.new(\"Model\")",
"\tmodel.Name = CONFIG.name",
"\tfor i = 1, CONFIG.count do",
"\t\tlocal part = Instance.new(\"Part\")",
"\t\tpart.Name = \"Particle\" .. i",
"\t\tpart.Shape = Enum.PartType.Ball",
"\t\tpart.Size = Vector3.new(0.4, 0.4, 0.4)",
"\t\tpart.Position = position",
"\t\tpart.Anchored = true",
"\t\tpart.CanCollide = false",
"\t\tpart.CanQuery = false",
"\t\tpart.Material = Enum.Material.Neon",
"\t\tpart.Color = pick(CONFIG.colors, rng)",
"\t\tpart.Parent = model",
"\t\tlocal dir = Vector3.new(rng:NextNumber(-1, 1), rng:NextNumber(0.4, 1), rng:NextNumber(-1, 1)).Unit",
"\t\ttask.spawn(function()",
"\t\t\tlocal steps = 30",
"\t\t\tfor step = 1, steps do",
"\t\t\t\tRunService.Heartbeat:Wait()",
"\t\t\t\tlocal a = step / steps",
"\t\t\t\tpart.Position = position + dir * a * CONFIG.spread",
"\t\t\t\tpart.Transparency = a",
"\t\t\t\tpart.Size = Vector3.one * (0.4 * (1 - a * 0.5))",
"\t\t\tend",
"\t\t\tpart:Destroy()",
"\t\tend)",
"\tend",
"\tmodel.Parent = parent",
"\tStats.bursts += 1",
"\tStats.particles += CONFIG.count",
"\treturn model",
"end",
"",
"local function report()",
"\tlocal parts = {}",
"\tfor key, value in pairs(Stats) do",
"\t\ttable.insert(parts, key .. \"=\" .. tostring(value))",
"\tend",
"\tprint(\"[\" .. CONFIG.name .. \"] \" .. table.concat(parts, \", \"))",
"end",
"",
"if RunService:IsClient() then",
"\tlocal player = Players.LocalPlayer",
"\tif player and player.Character then",
"\t\tburst(workspace, player.Character:GetPivot().Position)",
"\tend",
"else",
"\tburst(workspace, Vector3.zero)",
"end",
"report()"
].join("\n");

  globalThis.ZipStringC = {
    le32: le32, mulberry32: mulberry32, shuffle: shuffle,
    minifyLua: minifyLua, greedyParse: greedyParse, dpParse: dpParse,
    convertReps: convertReps, encodeLZH: encodeLZH, encodeTokens: encodeTokens,
    rcEncodeTokens: rcEncodeTokens,
    b85encode: b85encode, buildLoader: buildLoader, compressToLoader: compressToLoader,
    SAMPLE: SAMPLE_LUA
  };
})();
