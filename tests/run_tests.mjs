// ZipString test harness: loads decompressor.js + compressor.js, fuzzes the JS
// implementation (minifier + LZ77 + optimal parse + rep0 + Huffman), then runs
// generated loaders under real Lua 5.1 + 5.4 (byte-exact dumps, run mode,
// error paths, luac -p). Also verifies minifier semantic equality.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(ROOT, "tests", "tmp");

const dsrc = readFileSync(path.join(ROOT, "src", "decompressor.js"), "utf8");
const csrc = readFileSync(path.join(ROOT, "src", "compressor.js"), "utf8");
const Z = new Function(
  dsrc + "\n" + csrc + "\nreturn Object.assign({}, globalThis.ZipStringD, globalThis.ZipStringC);"
)();

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) passed++;
  else { failed++; console.error("  ✗ FAIL: " + name); }
}

function rnd(n, alpha) {
  if (typeof alpha === "string") alpha = Array.from(alpha);
  let s = "";
  for (let i = 0; i < n; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}
const ABC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t(){}[]=/;:'\".,#-+*%<>~^|&!?";

function roundTrip(s, opts, name) {
  const r = Z.compressToLoader(s, opts);
  const back = Z.decompressLoader(r.loader);
  if (back.src !== r.workText) { ok(false, name + " (decompressLoader mismatch vs workText)"); return r; }
  const lines = r.loader.split("\n");
  if (lines.length !== 3 || lines[1].length === 0) { ok(false, name + " (not single-line)"); return r; }
  if (!lines[0].startsWith("--minified by ZipString")) { ok(false, name + " (header comment)"); return r; }
  if (!lines[1].startsWith("return(function()")) { ok(false, name + " (skeleton head)"); return r; }
  if (!lines[1].trimEnd().endsWith("end)()")) { ok(false, name + " (skeleton tail)"); return r; }
  if (!/^[\x20-\x7E\n\r\t]*$/.test(r.loader)) { ok(false, name + " (loader not pure ASCII)"); return r; }
  ok(true, name);
  return r;
}

/* ============ minifier battery ============ */
console.log("== Minifier ==");
const MIN_SOURCES = [
  ["plain lua", [
    "-- a comment",
    "local t = {1, 2, 3} -- trailing",
    "--[[ long",
    "comment ]]",
    "local s = \"string -- with [[ stuff\"",
    "local s2 = 'single \\' quote'",
    "local n = 0xFF + .5 + 1e-3 + 10 + 1.5e2",
    "local concat = 1 .. 2 .. \"x\"",
    "local function f(a, b) return a + b end",
    "print(f(n, 2))",
    "print(#t, s, s2, concat)",
    "if n > 100 and n < 300 then print(\"mid\") elseif not n then print(\"hi\") else print(\"lo\") end",
    "for i = 1, 3 do print(i) end",
    "while false do end",
    "repeat until true",
    "local long = [==[multi",
    "line ]=] string ]==]",
    "print(long)",
    "print((\"x\"):rep(3), (\"y\"):byte())",
    "print(2^31, -2, 10 % 3, ... and \"var\" or \"none\")",
    "local a, b, c = ..., 2, 3",
    "print(a == nil, b, c)",
  ].join("\n")],
  ["directive", "--!strict\nlocal x = 1 -- normal comment\nprint(x)"],
  ["shebang", "#!/usr/bin/lua\nprint(1) -- comment"],
  ["nested comments", "local x = 1 --[=[ level1 ]=] --[==[ level2 ]==]\nprint(x) -- end"],
  ["ops soup", "local a=1 a=a+1 a=a-1 a=a*2 a=a/2 a=a%3 a=a^2 print(a~=1, a<=2, a>=0, a==1, a<5, a>0)"],
  ["dots", "print(select('#', ...), ...)\nlocal t = {...} print(#t)\nprint(1 .. 2)"],
  ["minus minus", "local a, b = 5, 3\nprint(a - -b, a - b, - -a)\nprint(1 - -2, 2 - - -3)"],
  ["dot dot dot five", "local x = 7 .. .5\nprint(x, 2 .. .25, 'a' .. .5)"],
  ["bracket longstring", "local t = {}\nt[ [[key]] ] = 42\nt[ [[another key]] ] = t[ [[key]] ] + 1\nprint(t[ [[key]] ], t[ [[another key]] ], #[[x]])"],
  ["float dot", "local y = 1. .. 2\nprint(y, 3. .. '')"],
  ["number then dots", "print(1 .. 2, 3 .. '', 0x10 .. '')"],
  ["number shorten", "local a = 0.1 + 0.50 + 1.50 + 007 + 0.0 + 1.0 + 0x10 + 1e-3 + 0.05\nprint(a, 00.10, .5, 100.00)"],
  ["call parens", "local game = { GetService = function(self, n) return n end }\nlocal w = game:GetService('Workspace')\nlocal p = game:GetService(\"Players\")\nprint(type('string'), tostring(42), w, p)\nlocal f = function(s) return s .. '!' end\nreturn f('a') .. f(\"b\") .. f [[c]]"],
  ["call parens chains", "local g = function(s) return function(t) return s .. t end end\nprint(g('x')('y'), ('z'):upper())\nlocal t = { k = g('q') }\nprint(t.k('r'), t['k']('s'))"],
  ["keywords before str", "return ('a') .. 'b'\n"],
  ["rename closures", "local counter = 0 local function inc() counter = counter + 1 return counter end inc() inc() return counter"],
  ["rename recursion", "local function fact(numb) if numb < 2 then return 1 end return numb * fact(numb - 1) end return fact(5)"],
  ["rename shadowing", "local foo = 1 do local foo = 2 end return foo"],
  ["rename global mix", "foo = 5 local foo = 1 return foo, foo"],
  ["rename pending self", "xyz = 7 local xyz = xyz return xyz"],
  ["rename repeat", "local foo = 0 repeat local bar = foo + 1 foo = bar until bar >= 3 return foo"],
  ["rename for", "local total = 0 for index = 1, 5 do total = total + index end for key, value in pairs({x=1}) do total = total + value end return total"],
  ["rename methods", "local obj = {} function obj:getVal() return self end function obj.setVal(self2, val) self2.v = val end obj.setVal(obj, 42) return obj:getVal().v"],
  ["rename params", "local function add(firstNumber, secondNumber) return firstNumber + secondNumber end return add(3, 4)"],
  ["rename strings", "local keep = 1 local drop = 2 return keep + drop, #\"keep me\""],
  ["rename nested", "local base = 10 local function outer(outerVal) local inner = outerVal * 2 return function() inner = inner + base return inner end end local f = outer(5) return f() + f()"],
  ["rename elseif", "local val = 5 local out = nil if val == 1 then out = 'one' elseif val == 5 then out = 'five' else out = 'other' end return out"],
  ["rename upvalue write", "local stash = {} for i = 1, 3 do local captured = i * 10 stash[i] = function() return captured end end return stash[1]() + stash[2]() + stash[3]()"],
  ["rename goto", "local total = 0 for i = 1, 4 do if i == 2 then goto skip end total = total + i ::skip:: end return total", {noRun: 1, noLuau: 1}],
  ["rename types", "type Point = {x: number, y: number} local point: Point = {x = 1, y = 2} return point.x", {noRun: 1, noLuau: 1}],
  ["rename generics", "local Array = 5 local mapping: {[number]: string} = {} return Array, mapping", {noRun: 1, noLuau: 1}],
];
{
  // idempotence + parse validity + no-crash
  for (const [name, src] of MIN_SOURCES) {
    const min1 = Z.minifyLua(src);
    ok(min1 !== null, "minify " + name + " (no bail)");
    if (min1 === null) continue;
    ok(Z.minifyLua(min1) === min1, "minify " + name + " idempotent");
    ok(min1.length < src.length, "minify " + name + " actually smaller (" + src.length + " -> " + min1.length + ")");
  }
  // Luau interpolated strings: verbatim pass-through, names inside are never renamed
  {
    const m = Z.minifyLua("local name = 'x'\nlocal greeting = `hello {name}`\nprint(greeting)");
    ok(m !== null && m.indexOf("`hello {name}`") >= 0, "backtick string passes through verbatim");
    ok(m !== null && m.indexOf("local name=") >= 0 && m.indexOf("local a=`hello {name}`") >= 0,
      "names inside interpolations keep their spelling (others still rename)");
  }
  // exact-output spot checks for the new transforms
  const EXACT = [
    ["local x = 0.1 + 0.50 + 1.50 + 007 + 0.0 + 1.0 + 0x10", "local x=.1+.5+1.5+7+.0+1.+0x10"],
    ["local w = game:GetService(\"Workspace\")", "local w=game:GetService\"Workspace\""],
    ["print(type('s'), tostring(42))", "print(type's',tostring(42))"],
    ["f('a') .. f(\"b\")", "f'a'..f\"b\""],
    ["function(s) return s end", "function(s)return s end"],
    ["local a = 0.05 + 10.00", "local a=.05+10."],
    ["local alpha = 1 return alpha", "local a=1 return a"],
    ["local playerCount = 0 playerCount = playerCount + 2 return playerCount", "local a=0 a=a+2 return a"],
    ["local function add(firstNumber, secondNumber) return firstNumber + secondNumber end return add(3, 4)", "local function a(b,c)return b+c end return a(3,4)"],
    ["type Point = {x: number, y: number} local point: Point = {x = 1, y = 2} return point.x", "type Point={x:number,y:number}local a:Point={x=1,y=2}return a.x"],
    ["local keep = 1 local drop = 2 return keep + drop", "local a=1 local b=2 return a+b"],
    ["local total = 0 for i = 1, 4 do if i == 2 then goto skip end total = total + i ::skip:: end return total", "local a=0 for i=1,4 do if i==2 then goto skip end a=a+i::skip::end return a"],
  ];
  for (const [inp, want] of EXACT) {
    ok(Z.minifyLua(inp) === want, "exact minify: " + inp.slice(0, 40) + " -> " + JSON.stringify(Z.minifyLua(inp)));
  }
  // whitespace/comment invariance: inflate whitespace runs and inject long comments
  // ONLY in code regions (never inside strings / comments / long brackets, where
  // whitespace is content) — verified with an independent lexer.
  const lexAwareInflate = (src) => {
    let out = "", i = 0, needNL = false;
    const n = src.length;
    if (src[0] === "#") { let j = src.indexOf("\n"); if (j < 0) j = n; out += src.slice(0, j); i = j; needNL = true; }
    while (i < n) {
      const c = src[i];
      if (c === "[") {
        let k = i + 1, eq = 0;
        while (src[k] === "=") { eq++; k++; }
        if (src[k] === "[") {
          const close = "]" + "=".repeat(eq) + "]";
          const end = src.indexOf(close, k + 1);
          const stop = end < 0 ? n : end + close.length;
          out += src.slice(i, stop); i = stop; continue;
        }
        out += c; i++; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === c) { j++; break; }
          if (src[j] === "\n") break;
          j++;
        }
        out += src.slice(i, j); i = j; continue;
      }
      if (c === "-" && src[i + 1] === "-") {
        let j = i + 2, stop = -1;
        if (src[j] === "[") {
          let k = j + 1, eq = 0;
          while (src[k] === "=") { eq++; k++; }
          if (src[k] === "[") {
            const close = "]" + "=".repeat(eq) + "]";
            const end = src.indexOf(close, k + 1);
            stop = end < 0 ? n : end + close.length;
          }
        }
        if (stop < 0) { let e = src.indexOf("\n", i); stop = e < 0 ? n : e; }
        out += src.slice(i, stop); i = stop;
        needNL = src[stop] === "\n"; /* line comment: following inflation must keep a line break */
        continue;
      }
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        if (needNL) {
          out += rnd(2, " \t") + "\n" + rnd(3, " \t\n\r") + (Math.random() < 0.5 ? "--[[" + rnd(3, "abc ") + "]]" : "") + rnd(2, " \t\n\r");
        } else {
          out += rnd(Math.random() < 0.5 ? 2 : 5, " \t\n\r") + (Math.random() < 0.5 ? "--[[" + rnd(3, "abc ") + "]]" : "");
        }
        needNL = false;
        i++; continue;
      }
      out += c; i++;
    }
    return out;
  };
  for (const [name, src] of MIN_SOURCES) {
    const base = Z.minifyLua(src);
    for (let rep = 0; rep < 3; rep++) {
      ok(Z.minifyLua(lexAwareInflate(src)) === base, "minify " + name + " whitespace/comment invariant (rep " + rep + ")");
    }
  }
  // semantic equality under real Lua (both interpreters)
  const luas = [];
  for (const l of ["lua5.1", "lua5.4"]) {
    try { execFileSync(l, ["-v"], { stdio: "pipe" }); luas.push(l); } catch (e) { /* skip */ }
  }
  if (luas.length) {
    mkdirSync(TMP, { recursive: true });
    for (const [name, src, flags] of MIN_SOURCES) {
      if (flags && flags.noRun) continue; /* Luau-only syntax */
      const min = Z.minifyLua(src);
      for (const lua of luas) {
        const fA = path.join(TMP, "sem_a.lua"), fB = path.join(TMP, "sem_b.lua");
        writeFileSync(fA, src, "utf8");
        writeFileSync(fB, min, "utf8");
        let outA, outB;
        try { outA = execFileSync(lua, [fA], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
        catch (e) { outA = "ERR:" + (e.stderr || "").toString(); }
        try { outB = execFileSync(lua, [fB], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
        catch (e) { outB = "ERR:" + (e.stderr || "").toString(); }
        ok(outA === outB, lua + " semantic equality: " + name + (outA !== outB ? "\n    orig: " + JSON.stringify(outA) + "\n    min:  " + JSON.stringify(outB) : ""));
      }
    }
  }
  // luac -p on minified sources
  try {
    execFileSync("luac5.1", ["-v"], { stdio: "pipe" });
    for (const [name, src, flags] of MIN_SOURCES) {
      if (flags && flags.noLuau) continue; /* Luau-only syntax */
      const f = path.join(TMP, "mparse.lua");
      writeFileSync(f, Z.minifyLua(src), "utf8");
      execFileSync("luac5.1", ["-p", f], { stdio: "pipe" });
      ok(true, "luac5.1 -p accepts minified: " + name);
    }
  } catch (e) {
    if (e.code !== "ENOENT") ok(false, "luac -p minified: " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message));
  }
}

/* ============ syntax battery: escapes, \z, exponent numbers ============ */
{
  console.log("\n== Syntax battery ==");
  const EXACT = [
    ["exp+", "print(1e+5)", "print(1e+5)"],
    ["exp-", "print(2e-3)", "print(2e-3)"],
    ["expE", "print(1E+10, 3e-7)", "print(1E+10,3e-7)"],
    ["hexfloat", "print(0x1p+4, 0xA.8p2)", "print(0x1p+4,0xA.8p2)"],
    ["z-escape", "local s = 'abc\\z\n   def' print(s)", "local s='abc\\z\n   def'print(s)"],
    ["z-escape-tab", "local s = \"a\\z\\t\t b\" print(s)", "local s=\"a\\z\\t\t b\"print(s)"],
    ["bs-newline", "local s = 'a\\\n b' print(s)", "local s='a\\\n b'print(s)"],
    ["escapes", "local s = '\\x41\\66\\u{1F600}\\n\\t' return #s", "local s='\\x41\\66\\u{1F600}\\n\\t'return#s"],
    ["longstr-z", "local s = [==[a\\z b]==] return s", "local s=[==[a\\z b]==]return s"],
  ];
  for (const [name, src, want] of EXACT) {
    const got = Z.minifyLua(src);
    ok(got === want, "exact minify " + name + ": " + JSON.stringify(got));
  }
  /* the killer case that produced 'Malformed string' in Luau: a \z whose
     whitespace run contains a newline must NOT end the string token */
  const zk = "local s='abc\\z\n   def' print(s, #s)";
  const zm = Z.minifyLua(zk);
  ok(zm.indexOf("'abc\\z\n   def'") >= 0, "\\z + newline stays inside the string token");
  /* 1e+5 must stay one token (a space would make it a malformed number) */
  ok(Z.minifyLua("print(1e+5, 1e - 5)") === "print(1e+5,1e-5)", "exponent signs stay glued to their numeral");
  /* semantic equality under real Lua for the number/escape fixes (no \z: that is 5.2+) */
  const SEM = [
    "print(1e+5, 2e-3, 1E+10)",
    "print(0.5e+2 + 1e+1)",
    "print('a\\x41\\66' .. 'b')",
    "local s='x\\'y' print(#s)",
  ];
  const luas0 = [];
  for (const l of ["lua5.1", "lua5.4"]) { try { execFileSync(l, ["-v"], { stdio: "pipe" }); luas0.push(l); } catch (e) { /* skip */ } }
  for (const lua of luas0) {
    for (const src of SEM) {
      const m = Z.minifyLua(src);
      let a = "", b = "";
      try { a = execFileSync(lua, ["-e", src], { encoding: "utf8" }); } catch (e) { a = "ERR:" + e.message.split("\n")[0]; }
      try { b = execFileSync(lua, ["-e", m], { encoding: "utf8" }); } catch (e) { b = "ERR:" + e.message.split("\n")[0]; }
      ok(a === b, lua + " escape/number semantic equality: " + src.slice(0, 40));
    }
  }
}

/* ============ deterministic short names ============ */
console.log("== Names ==");
{
  /* big enough that the full Huffman engine actually ships (a tiny input
     would honestly fall back to the smaller stored engine) */
  const r1 = Z.compressToLoader(Z.SAMPLE.repeat(3), { seed: 4242, entropy: "huffman" });
  const r2 = Z.compressToLoader(Z.SAMPLE.repeat(3), { seed: 4242, entropy: "huffman" });
  ok(r1.loader === r2.loader, "same seed -> identical loader");
  const r3 = Z.compressToLoader("print(1) -- x", { seed: 999 });
  ok(r1.loader !== r3.loader, "different seed -> different loader (alphabet)");
  ok(/local e=\{\}/.test(r1.loader) && /local e=\{\}/.test(r3.loader), "engine locals start at 'e' in every seed");
  ok(/local g,h=\{\},0/.test(r1.loader), "sequential names g,h follow e");
  /* every declared local must come from the a..z / aa.. bank, never a keyword or global */
  const KWSET = new Set(["and","break","do","else","elseif","end","false","for","function","goto","if","in","local","nil","not","or","repeat","return","then","true","until","while","io","os","math","string","table","error","tostring","tonumber","unpack","loadstring","setfenv","print"]);
  const decls = r1.loader.match(/local (?:function )?[a-zA-Z][a-zA-Z0-9]*(?:,[a-zA-Z][a-zA-Z0-9]*)*/g) || [];
  const lnames = [];
  for (const d of decls) lnames.push(...d.slice(6).replace("function ", "").split(","));
  ok(lnames.length >= 30, "engine declares a healthy number of locals (" + lnames.length + ")");
  ok(lnames.every(nm => !KWSET.has(nm)), "no keyword/global used as an engine local name");
  ok(lnames.every(nm => /^[a-z]{1,2}$/.test(nm) || "abcd".includes(nm) || nm === "l"), "all engine locals are 1-2 chars from the short bank");
}

/* ============ JS fuzz ============ */
console.log("== JS fuzz ==");
roundTrip(Z.SAMPLE, { seed: 1 }, "sample (minify on)");
roundTrip(Z.SAMPLE, { seed: 2, minify: false }, "sample (minify off)");
for (let len = 1; len <= 120; len++) roundTrip(rnd(len, "ab"), { seed: len * 7, minify: false }, "tiny ab len=" + len);
const sizes = [200, 255, 256, 257, 511, 512, 513, 1000, 1023, 1024, 1025, 2048, 4096, 5000, 10007, 16384, 32768, 65536, 100000, 150000, 300000, 520000, 600000];
for (const size of sizes) {
  roundTrip(rnd(size, ABC), { seed: size, minify: false }, "random ascii " + size);
  roundTrip(rnd(size, "ab"), { seed: size + 1, minify: false }, "random ab " + size);
  roundTrip(rnd(size, "abcde"), { seed: size + 2, minify: false }, "random abcde " + size);
}
roundTrip("abcdefgh".repeat(40000), { seed: 3, minify: false }, "320k same-distance matches (rep0)");
roundTrip("x".repeat(300000), { seed: 7, minify: false }, "300k single char");
roundTrip("ab".repeat(150000), { seed: 8, minify: false }, "300k two chars");
roundTrip(rnd(250000, "abcdefgh"), { seed: 9, minify: false }, "250k 8-alphabet");
roundTrip(rnd(500000, ABC), { seed: 10, minify: false }, "500k random ascii");
roundTrip(rnd(3000, "🥫é日本語✓\n\t"), { seed: 11, minify: false }, "unicode mix");
roundTrip("]==] ]=] [=[ [==[ testing ]==] brackets \" ' \\", { seed: 12, minify: false }, "bracket soup");
roundTrip("\n\n\n", { seed: 13, minify: false }, "newlines only");
roundTrip("print('hi')", { seed: 14 }, "tiny script");
for (let s = 0; s < 30; s++) roundTrip(rnd(3000, ABC), { seed: s * 99991, minify: s % 2 === 0 }, "seed sweep " + s);
console.log("  fuzz so far: " + passed + " passed, " + failed + " failed");

/* ============ 99% claims ============ */
console.log("== 99% ratio checks ==");
{
  const stress = new Array(513).join(Z.SAMPLE + "\n");
  const orig = new TextEncoder().encode(stress).length;
  const r = roundTrip(stress, { seed: 424242 }, "stress sample ×512 (" + orig + " B)");
  const pct = (1 - r.loaderChars / orig) * 100;
  console.log("  sample×512: " + orig + " B -> " + r.loaderChars + " chars = " + pct.toFixed(2) + "% smaller | tokens " + r.tokens + " | blocks " + r.blocks + " | DP " + r.usedDP);
  ok(pct >= 98.5, "sample×512 is ≥98.5% smaller (got " + pct.toFixed(2) + "%)");
  const ab = "ab".repeat(524288);
  const r2 = roundTrip(ab, { seed: 777, minify: false }, "1MiB ab");
  const pct2 = (1 - r2.loaderChars / ab.length) * 100;
  console.log("  1MiB ab: -> " + r2.loaderChars + " chars = " + pct2.toFixed(2) + "% smaller");
  ok(pct2 >= 99, "1MiB ab is ≥99% smaller (got " + pct2.toFixed(2) + "%)");
}

/* ============ real Lua ============ */
console.log("== Real Lua ==");
const luas = [];
for (const l of ["lua5.1", "lua5.4"]) {
  try { execFileSync(l, ["-v"], { stdio: "pipe" }); luas.push(l); } catch (e) { /* skip */ }
}
console.log("  interpreters: " + (luas.join(", ") || "none"));

if (luas.length) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  /* dense, repetitive code -> short matches -> many tokens -> multiple blocks,
     with rep0 (repeat-distance) matches crossing block boundaries */
  const moduleGen = (target) => {
    const mod = (i) => {
      const L = [];
      L.push("-- mod " + i);
      L.push("local m" + i + "={}");
      for (let k = 0; k < 60; k++) {
        L.push("local v" + k + "=m" + i + "[" + (k * 7 + i) + "]");
        L.push("if v" + k + " then m" + i + ".x" + k + "=v" + k + "+" + (k + i) + " else m" + i + ".x" + k + "=nil end");
        L.push("function m" + i + ".f" + k + "(a,b) local c=(a or 0)+(b or 0)*" + (k + 1) + " if c>" + (i * 3 + k) + " then return c," + k + " end return nil end");
      }
      L.push("return m" + i);
      return L.join("\n");
    };
    const parts = []; let total = 0, i = 0;
    while (total < target) { const s = mod(i++); parts.push(s); total += s.length + 1; }
    return parts.join("\n");
  };

  const dumpCases = [
    ["sample minified", Z.SAMPLE, { seed: 1 }],
    ["sample raw", Z.SAMPLE, { seed: 2, minify: false }],
    ["unicode", "local s = 'héllo 🥫 日本語 ]=] ]] [=[ \\n\\t \\' \" end'\nprint(#s)\nreturn s", { seed: 3, minify: false }],
    ["300k single char", "x".repeat(300000), { seed: 4, minify: false }],
    ["1MiB ab repetitive", "ab".repeat(524288), { seed: 5, minify: false }],
    ["random ascii 100k (DP)", rnd(100000, ABC), { seed: 6, minify: false }],
    ["random ascii 300k (DP)", rnd(300000, ABC), { seed: 16, minify: false }],
    ["random ascii 600k (greedy)", rnd(600000, ABC), { seed: 17, minify: false }],
    ["rep0 chain 320k", "abcdefgh".repeat(40000), { seed: 18, minify: false }],
    ["1 byte", "z", { seed: 7, minify: false }],
    ["crlf", "print(1)\r\nprint(2)\r\nlocal x = 'a\\r\\nb'\r\nprint(x)\r\n", { seed: 8, minify: false }],
    ["nul-ish escapes", "local s = '\\0\\1\\2\\255\\254\\0 more'\nreturn #s", { seed: 9, minify: false }],
    ["stress ×512", new Array(513).join(Z.SAMPLE + "\n"), { seed: 10 }],
    ["500k random", rnd(500000, ABC), { seed: 11, minify: false }],
    ["minified tricky lua", MIN_SOURCES[0][1], { seed: 12 }],
    ["multiblock rep0 400K raw", moduleGen(400000), { seed: 21, minify: false }],
    ["multiblock rep0 400K minified", moduleGen(400000), { seed: 22 }],
    ["multiblock rep0 150K (DP path)", moduleGen(150000), { seed: 23, minify: false }],
  ];
  for (const lua of luas) {
    for (const [name, src, opts] of dumpCases) {
      const r = Z.compressToLoader(src, Object.assign({ mode: "dump" }, opts));
      const loaderFile = path.join(TMP, lua + "_" + name.replace(/\W+/g, "_") + "_dump.lua");
      writeFileSync(loaderFile, r.loader, "utf8");
      const expected = Buffer.from(r.workText, "utf8");
      const t0 = Date.now();
      let out;
      try {
        out = execFileSync(lua, [loaderFile], { encoding: "buffer", maxBuffer: 1 << 28, timeout: 180000 });
      } catch (e) {
        ok(false, lua + " dump " + name + " (lua error: " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message) + ")");
        continue;
      }
      ok(out.equals(expected), lua + " dump " + name + " byte-exact (" + expected.length + " B, " + (Date.now() - t0) + " ms)");
    }
  }

  // run-mode: loader compiles + executes the (minified) payload
  const runPayload = [
    "local t = {}",
    "for i = 1, 100 do t[i] = i * i end",
    "local sum = 0",
    "for _, v in ipairs(t) do sum = sum + v end",
    "print('sum=' .. sum) -- comment to be stripped",
    "return 'RET1', 42, true",
  ].join("\n");
  for (const lua of luas) {
    for (const opts of [{ seed: 1 }, { seed: 99, minify: false }, { seed: 123456 }]) {
      const r = Z.compressToLoader(runPayload, opts);
      const f = path.join(TMP, lua + "_run_" + opts.seed + (opts.minify === false ? "_raw" : "") + ".lua");
      writeFileSync(f, r.loader, "utf8");
      const out = execFileSync(lua, ["-e", "local a,b,c = dofile('" + f + "') print(a,b,c)"], { encoding: "utf8" });
      ok(/sum=338350/.test(out) && /RET1\s+42\s+true/.test(out), lua + " run-mode seed=" + opts.seed + " minify=" + (opts.minify !== false) + " executes and returns values");
    }
    const r2 = Z.compressToLoader("glb = 123\nreturn glb + 1", { seed: 55 });
    const f2 = path.join(TMP, lua + "_run2.lua");
    writeFileSync(f2, r2.loader, "utf8");
    const out2 = execFileSync(lua, ["-e", "print(dofile('" + f2 + "'))"], { encoding: "utf8" });
    ok(/124/.test(out2), lua + " payload globals visible (after minify)");
  }

  // error paths
  {
    const lua = luas[0];
    const r = Z.compressToLoader("this is ! not valid lua ]=", { seed: 3 });
    const f = path.join(TMP, "err_compile.lua");
    writeFileSync(f, r.loader, "utf8");
    let threw = false, msg = "";
    try { execFileSync(lua, [f], { stdio: "pipe" }); } catch (e) { threw = true; msg = (e.stderr || "").toString(); }
    ok(threw && /payload failed to compile/.test(msg), lua + " compile error surfaced: " + msg.split("\n")[0].slice(0, 80));

    const r2 = Z.compressToLoader("error('boom from payload')", { seed: 4 });
    const f2 = path.join(TMP, "err_runtime.lua");
    writeFileSync(f2, r2.loader, "utf8");
    let threw2 = false, msg2 = "";
    try { execFileSync(lua, [f2], { stdio: "pipe" }); } catch (e) { threw2 = true; msg2 = (e.stderr || "").toString(); }
    ok(threw2 && /boom from payload/.test(msg2), lua + " runtime error propagates");

    const r3 = Z.compressToLoader("return 1 -- " + rnd(3000, ABC), { seed: 5, minify: false });
    const pStart = r3.loader.indexOf("[");
    const payloadRegion = r3.loader.slice(pStart);
    const flipAt = payloadRegion.search(/[0-9a-zA-Z]/) + pStart;
    const flipped = r3.loader.slice(0, flipAt) + (r3.loader[flipAt] === "A" ? "B" : "A") + r3.loader.slice(flipAt + 1);
    if (flipped === r3.loader) throw new Error("corruption test bug: nothing flipped");
    const f3 = path.join(TMP, "corrupt.lua");
    writeFileSync(f3, flipped, "utf8");
    let threw3 = false, msg3 = "";
    try { execFileSync(lua, [f3], { stdio: "pipe" }); } catch (e) { threw3 = true; msg3 = (e.stderr || "").toString(); }
    ok(threw3 && /corrupt|checksum|length|invalid|dangling|truncated|huff|tree|distance|failed to compile/.test(msg3),
      lua + " corrupted loader detected: " + msg3.split("\n")[0].slice(0, 90));
  }

  // luac -p syntax check across many seeds (random name permutations)
  try {
    execFileSync("luac5.1", ["-v"], { stdio: "pipe" });
    let synOk = 0;
    for (let seed = 0; seed < 25; seed++) {
      const r = Z.compressToLoader(Z.SAMPLE + "\n-- seed probe " + seed, { seed });
      const f = path.join(TMP, "syn_" + seed + ".lua");
      writeFileSync(f, r.loader, "utf8");
      execFileSync("luac5.1", ["-p", f], { stdio: "pipe" });
      synOk++;
    }
    ok(synOk === 25, "luac5.1 -p accepts 25 varied-seed loaders");
    const big = Z.compressToLoader("x".repeat(300000), { seed: 31, minify: false });
    const fb = path.join(TMP, "syn_big.lua");
    writeFileSync(fb, big.loader, "utf8");
    execFileSync("luac5.1", ["-p", fb], { stdio: "pipe" });
    ok(true, "luac5.1 -p accepts 300k single-char loader");
  } catch (e) {
    if (e.code === "ENOENT") console.log("  (luac not found, skipping)");
    else ok(false, "luac -p: " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message));
  }
  rmSync(TMP, { recursive: true, force: true });
}

/* ============ Real Luau (official Luau CLI: Roblox-flavored verification) ============ */
{
  console.log("\n== Real Luau ==");
  let luau = null;
  for (const cand of [path.join(ROOT, ".tools", "luau"), "luau"]) {
    try { execFileSync(cand, ["--help"], { stdio: "pipe" }); luau = cand; break; } catch (e) { /* keep looking */ }
  }
  if (!luau) {
    console.log("  luau CLI not found (put the official Luau binary at .tools/luau) - SKIPPING");
  } else {
    const LT = path.join(ROOT, "tests", ".luau-run");
    rmSync(LT, { recursive: true, force: true });
    mkdirSync(LT, { recursive: true });
    const runFile = function (code) {
      const f = path.join(LT, "x.lua");
      writeFileSync(f, code, "utf8");
      return execFileSync(luau, [f], { encoding: "utf8", maxBuffer: 1 << 26 });
    };

    /* modern Luau syntax through the minifier: minified output behaves identically */
    const LUAU_CASES = [
      ["continue", "local out = {}\nfor i = 1, 10 do\n  if i % 2 == 0 then continue end\n  table.insert(out, i)\nend\nprint(table.concat(out, ','))"],
      ["compound", "local a = 1\na += 2\na -= 1\na *= 5\na /= 2\na //= 3\na %= 4\na ^= 2\na ..= 'x'\nprint(a)"],
      ["ifexpr", "local cond = true\nlocal x = if cond then 1 else 2\nprint(x)"],
      ["cast", "local y = '42'\nlocal n = y :: number\nprint(n + 0)"],
      ["generics", "export type Point = { x: number, y: number }\nlocal function map<T, U>(arr: { T }, fn: (T) -> U): { U }\n  local out = {}\n  for i, v in arr do\n    out[i] = fn(v)\n  end\n  return out\nend\nprint(map({1, 2, 3}, function(v) return v * 2 end)[3])"],
      ["typedfor", "local total: number = 0\nfor i: number = 1, 3 do\n  total += i\nend\nprint(total)"],
      ["geniter", "local t = { a = 1, b = 2 }\nfor k, v in t do print(k, v) end"],
      ["interp_basic", "local name = 'world'\nlocal greeting = `hello {name}!`\nprint(greeting)"],
      ["interp_expr", "local a, b = 3, 4\nprint(`sum={a + b} diff={a - b}`)"],
      ["interp_nested_string", "print(`q={\"a}b\"} done`)"],
      ["interp_preserved", "local counter = 5\nlocal label = `count is {counter}`\nprint(label)"],
      ["interp_call", "local x = 1\nprint(`{x}`)"],
      ["interp_escaped", "print(`literal \\{brace\\} ok`)"],
      ["interp_nested_istr", "local y = 2\nprint(`outer {`inner {y}`} end`)"],
    ];
    for (const [name, src] of LUAU_CASES) {
      const m = Z.minifyLua(src);
      let a, b;
      try { a = runFile(src); } catch (e) { a = "ERR:" + (e.stderr || "").toString().split("\n")[0]; }
      try { b = runFile(m === null ? src : m); } catch (e) { b = "ERR:" + (e.stderr || "").toString().split("\n")[0]; }
      ok(m !== null && a === b, "luau min == orig: " + name);
    }

    /* loader runs under Luau with Roblox-style globals stubbed
       (regression: the head used to setfenv the payload to _G, which is NOT the
       script environment in sandboxed Luau -> payload lost its globals) */
    const stubs = [
      "game = { GetService = function(self, n) return n end }",
      "workspace = 'Workspace'",
      "Instance = { new = function(cls) return { Name = '', ClassName = cls, Destroy = function() end } end }",
      "task = { spawn = function(f) f() end, wait = function() end }",
      "Vector3 = { new = function(x, y, z) return {X = x, Y = y, Z = z} end, zero = {X=0,Y=0,Z=0} }",
      "Color3 = { fromRGB = function(r, g, b) return {R = r, G = g, B = b} end }",
      "Enum = { PartType = { Ball = 'Ball' }, Material = { Neon = 'Neon' } }",
      "Random = { new = function(seed) return { NextInteger = function(self, a, b) return (a + b) // 2 end, NextNumber = function(self, a, b) return a end } end }",
    ].join("\n");
    const rbx = [
      "local Players = game:GetService('Players')",
      "local parts = {}",
      "for i = 1, 3 do",
      "  local p = Instance.new('Part')",
      "  p.Name = 'P' .. i",
      "  p.Color = Color3.fromRGB(255, 0, 0)",
      "  p.Parent = workspace",
      "  parts[i] = p",
      "end",
      "task.spawn(function() print('spawned', #parts, parts[1].Name, Players) end)",
      "print('done')",
    ].join("\n");
    const wrapLoad = function (loaderText) {
      return stubs + "\nlocal src = [====[\n" + loaderText + "\n]====]\nlocal fn = (loadstring or load)(src)\nfn()\n";
    };
    const rMin = Z.compressToLoader(rbx, { seed: 77 });
    const rRaw = Z.compressToLoader(rbx, { seed: 78, minify: false });
    const o1 = runFile(wrapLoad(rRaw.loader));
    const o2 = runFile(wrapLoad(rMin.loader));
    ok(o1 === o2 && o2.indexOf("done") >= 0, "luau loader runs Roblox-style payload with globals intact (env fix)");

    /* 400K multi-block payload: byte-exact decode under Luau */
    const moduleGenL = function (target) {
      const mod = function (i) {
        const L = [];
        L.push("-- mod " + i);
        L.push("local m" + i + "={}");
        for (let k = 0; k < 60; k++) {
          L.push("local v" + k + "=m" + i + "[" + (k * 7 + i) + "]");
          L.push("if v" + k + " then m" + i + ".x" + k + "=v" + k + "+" + (k + i) + " else m" + i + ".x" + k + "=nil end");
          L.push("function m" + i + ".f" + k + "(a,b) local c=(a or 0)+(b or 0)*" + (k + 1) + " if c>" + (i * 3 + k) + " then return c," + k + " end return nil end");
        }
        L.push("return m" + i);
        return L.join("\n");
      };
      const parts = []; let total = 0, i = 0;
      while (total < target) { const s = mod(i++); parts.push(s); total += s.length + 1; }
      return parts.join("\n");
    };
    const bundle = moduleGenL(400000);
    let lvl = 0;
    while (bundle.indexOf("]" + "=".repeat(lvl) + "]") >= 0 || bundle.indexOf("[" + "=".repeat(lvl) + "[") >= 0) lvl++;
    const op = "[" + "=".repeat(lvl) + "[", cl = "]" + "=".repeat(lvl) + "]";
    const rBig = Z.compressToLoader("print(" + op + bundle + cl + ")", { seed: 424242 });
    const outBig = runFile(wrapLoad(rBig.loader));
    ok(outBig === bundle + "\n", "luau 400K multi-block payload byte-exact (" + rBig.blocks + " blocks)");

    rmSync(LT, { recursive: true, force: true });
  }
}

/* ============ rep1 unit + legacy-format fallback ============ */
{
  console.log("\n== rep1 & legacy ==");
  /* synthetic stream with alternating match distances forces rep1 tokens */
  const toks = [];
  for (let i = 0; i < 40; i++) toks.push(65 + (i % 26));
  for (let k = 0; k < 60; k++) { toks.push(-1, 10, 40); toks.push(-1, 5, 25); }
  const rep = Z.convertReps(toks);
  let rep1 = 0, i = 0;
  while (i < rep.length) { if (rep[i] === -3) rep1++; i += rep[i] >= 0 ? 1 : (rep[i] === -1 ? 3 : 2); }
  ok(rep1 >= 50, "convertReps emits rep1 for alternating distances (" + rep1 + ")");
  /* reference expansion of the raw stream */
  const expected = [];
  for (let q = 0; q < toks.length; ) {
    const t = toks[q];
    if (t >= 0) { expected.push(t); q++; }
    else { const len = toks[q + 1], dist = toks[q + 2]; for (let k = 0; k < len; k++) expected.push(expected[expected.length - dist]); q += 3; }
  }
  const enc = Z.encodeTokens(Uint8Array.of(0), rep, 16384);
  const container = [1].concat(Z.le32(expected.length), Z.le32(Z.hash32(Uint8Array.from(expected))), enc.bytes);
  const back = Z.lzhDecode(Uint8Array.from(container), 9, false);
  ok(back.length === expected.length && back.every((b, q) => b === expected[q]),
    "lzhDecode round-trips a rep1 bitstream byte-exact (" + back.length + " B)");
  /* a loader made by the pre-2026-11-17 format (329-symbol trees, 40 dist codes) must still decode */
  const legacyLoader = readFileSync(path.join(ROOT, "tests", "fixtures", "legacy_loader.lua"), "utf8");
  const res = Z.decompressLoader(legacyLoader);
  ok(res.legacy === true, "legacy loader flagged as legacy");
  ok(res.src === Z.minifyLua(Z.SAMPLE), "legacy loader decodes byte-exact via legacy tables");
  const fresh = Z.compressToLoader(Z.SAMPLE, { seed: 7 });
  ok(Z.decompressLoader(fresh.loader).legacy === false, "new loader not flagged legacy");
}

/* ============ range coder (tag 2): adaptive binary range coder ============ */
{
  console.log("\n== Range coder (tag 2) ==");
  mkdirSync(TMP, { recursive: true });
  const rcModuleGen = function (target, runStyle) {
    const mod = function (i) {
      const L = [];
      L.push(runStyle ? "do" : "-- mod " + i);
      L.push("local m" + i + "={}");
      for (let k = 0; k < 60; k++) {
        L.push("local v" + k + "=m" + i + "[" + (k * 7 + i) + "]");
        L.push("if v" + k + " then m" + i + ".x" + k + "=v" + k + "+" + (k + i) + " else m" + i + ".x" + k + "=nil end");
        L.push("function m" + i + ".f" + k + "(a,b) local c=(a or 0)+(b or 0)*" + (k + 1) + " if c>" + (i * 3 + k) + " then return c," + k + " end return nil end");
      }
      L.push(runStyle ? "end" : "return m" + i);
      return L.join("\n");
    };
    const parts = []; let total = 0, i = 0;
    while (total < target) { const s = mod(i++); parts.push(s); total += s.length + 1; }
    return parts.join("\n");
  };
  const RC_CASES = [
    ["tiny", "print('hi')", { seed: 31, minify: false }],
    ["sample", Z.SAMPLE, { seed: 32 }],
    ["sample ×50", Z.SAMPLE.repeat(50), { seed: 33 }],
    ["rep0 chain 320k", "abcdefgh".repeat(40000), { seed: 34, minify: false }],
    ["random ascii 20k", rnd(20000, ABC), { seed: 35, minify: false }],
    ["module 400K", rcModuleGen(400000, false), { seed: 36, minify: false }],
  ];
  for (const [name, src, opts] of RC_CASES) {
    const rc = Z.compressToLoader(src, Object.assign({ entropy: "rc" }, opts));
    ok(rc.entropy === 2 || rc.entropy === 0, name + ": entropy rc -> tag 2 (or honest stored fallback, tag " + rc.entropy + ")");
    ok(Z.decompressLoader(rc.loader).src === rc.workText, name + ": rc loader JS round-trip");
    const hu = Z.compressToLoader(src, Object.assign({ entropy: "huffman" }, opts));
    ok(hu.entropy === 1 || hu.entropy === 0, name + ": entropy huffman -> tag 1 (or stored, tag " + hu.entropy + ")");
    ok(Z.decompressLoader(hu.loader).src === hu.workText, name + ": huffman loader JS round-trip");
    const auto = Z.compressToLoader(src, Object.assign({}, opts));
    ok(Z.decompressLoader(auto.loader).src === auto.workText, name + ": auto loader JS round-trip (tag " + auto.entropy + ")");
    ok(auto.loaderChars <= Math.min(rc.loaderChars, hu.loaderChars), name + ": auto keeps the smallest LOADER (engine included)");
    if (rc.entropy === 2 && hu.entropy === 1)
      console.log("    " + name + ": range " + rc.payloadBytes + " B vs huffman " + hu.payloadBytes + " B (" +
        (100 - Math.round(rc.payloadBytes / hu.payloadBytes * 100)) + "% smaller)");
  }
  const rH = Z.compressToLoader(Z.SAMPLE.repeat(50), { seed: 37 });
  ok(rH.origChars === Z.SAMPLE.repeat(50).length, "origChars exposed for honest headline math");
  ok(rH.algo === "LZ77+range" || rH.algo === "LZ77+Huffman" || rH.algo === "stored", "algo string present: " + rH.algo);

  /* real Lua 5.1/5.4 on tag-2 loaders */
  const luas2 = [];
  for (const l of ["lua5.1", "lua5.4"]) { try { execFileSync(l, ["-v"], { stdio: "pipe" }); luas2.push(l); } catch (e) { /* skip */ } }
  if (luas2.length === 0) console.log("  (no lua interpreters installed - rc interpreter checks skipped)");
  for (const lua of luas2) {
    const r400 = Z.compressToLoader(rcModuleGen(400000, false), { seed: 424242, minify: false, entropy: "rc", mode: "dump" });
    ok(r400.entropy === 2, lua + ": 400K rc dump actually uses tag 2");
    const f400 = path.join(TMP, "rc400_" + lua + ".lua");
    writeFileSync(f400, r400.loader, "utf8");
    const exp400 = Buffer.from(r400.workText, "utf8");
    let out400 = null;
    try { out400 = execFileSync(lua, [f400], { encoding: "buffer", maxBuffer: 1 << 28, timeout: 300000 }); }
    catch (e) { ok(false, lua + " rc dump 400K (lua error: " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message) + ")"); }
    if (out400 !== null) ok(out400.equals(exp400), lua + " rc dump 400K byte-exact (" + exp400.length + " B)");

    const src30 = rcModuleGen(30000, true) + '\nprint("mods ok")';
    const r30 = Z.compressToLoader(src30, { seed: 38, minify: false, entropy: "rc", mode: "run" });
    ok(r30.entropy === 2, lua + ": 30K run source actually uses tag 2");
    const f30 = path.join(TMP, "rc30_" + lua + ".lua");
    writeFileSync(f30, r30.loader, "utf8");
    let out30 = null;
    try { out30 = execFileSync(lua, [f30], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 120000 }); }
    catch (e) { ok(false, lua + " rc run 30K (lua error: " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message) + ")"); }
    if (out30 !== null) ok(out30 === "mods ok\n", lua + " rc run-mode output-exact");
  }

  /* real Luau CLI on tag-2 loaders: print-wrapped bundle = byte-exact without dump mode */
  let luau2 = null;
  for (const cand of [path.join(ROOT, ".tools", "luau"), "luau"]) {
    try { execFileSync(cand, ["--help"], { stdio: "pipe" }); luau2 = cand; break; } catch (e) { /* keep looking */ }
  }
  if (!luau2) console.log("  (luau CLI not found - rc Luau checks skipped)");
  else {
    const LT2 = path.join(ROOT, "tests", ".luau-rc");
    rmSync(LT2, { recursive: true, force: true });
    mkdirSync(LT2, { recursive: true });
    const runF = function (code) {
      const f = path.join(LT2, "x.lua");
      writeFileSync(f, code, "utf8");
      return execFileSync(luau2, [f], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 300000 });
    };
    const bundle = rcModuleGen(400000, false);
    let lvl = 0;
    while (bundle.indexOf("]" + "=".repeat(lvl) + "]") >= 0 || bundle.indexOf("[" + "=".repeat(lvl) + "[") >= 0) lvl++;
    const op = "[" + "=".repeat(lvl) + "[", cl = "]" + "=".repeat(lvl) + "]";
    const rBig = Z.compressToLoader("print(" + op + bundle + cl + ")", { seed: 424242, minify: false, entropy: "rc" });
    ok(rBig.entropy === 2, "luau: 400K rc bundle actually uses tag 2");
    const outBig = runF("local src=[====[\n" + rBig.loader + "\n]====]\n(loadstring or load)(src)()");
    ok(outBig === bundle + "\n", "luau 400K rc payload byte-exact (" + rBig.payloadBytes + " B payload)");

    const r30 = Z.compressToLoader(rcModuleGen(30000, true) + '\nprint("mods ok")', { seed: 39, minify: false, entropy: "rc" });
    const out30 = runF("local src=[====[\n" + r30.loader + "\n]====]\n(loadstring or load)(src)()");
    ok(out30 === "mods ok\n", "luau 30K rc run-mode output-exact");
    rmSync(LT2, { recursive: true, force: true });
  }
  rmSync(TMP, { recursive: true, force: true });
}

/* ============ specialized engines + small files ============ */
{
  console.log("\n== Specialized engines / small files ==");
  /* every loader now carries ONLY its own format's decoder */
  const eng = {};
  for (const e of ["rc", "huffman", "stored"]) eng[e] = Z.compressToLoader("print(1)", { seed: 7, entropy: e });
  ok(eng.stored.entropy === 0, "entropy 'stored' forces tag 0");
  ok(eng.stored.loaderChars < 1700, "engine floor is small (stored loader " + eng.stored.loaderChars + " chars for an 8-char payload)");
  const rS = Z.compressToLoader(Z.SAMPLE, { seed: 7 });
  ok(rS.loaderChars < 3400, "2 KB sample loader stays under 3.4K chars (got " + rS.loaderChars + ")");
  ok(Z.decompressLoader(rS.loader).src === rS.workText, "small-sample loader round-trips");
  let breakEven = -1;
  for (let n = 1; n <= 6 && breakEven < 0; n++) {
    const r = Z.compressToLoader(Z.SAMPLE.repeat(n), { seed: 7 });
    if (r.loaderChars <= r.origChars) breakEven = r.origChars;
  }
  ok(breakEven > 0, "break-even is reached within 6x sample (~" + breakEven + " chars in)");
  const rBig = Z.compressToLoader(Z.SAMPLE.repeat(5), { seed: 7 });
  ok(rBig.loaderChars < rBig.origChars, "5x sample (~10K chars) compresses honestly: " +
    Math.round((1 - rBig.loaderChars / rBig.origChars) * 100) + "% smaller");

  /* all three engines decode byte-exact in real Lua + run under Luau */
  const mod = [];
  for (let m = 0; m < 40; m++) {
    mod.push("do local t" + m + "={}");
    for (let k = 0; k < 8; k++) mod.push("t" + m + "[" + (k * 3 + m) + "]=" + (k + m) * (k + 1));
    mod.push("end");
  }
  const modSrc = mod.join("\n") + '\nprint("engines ok")';
  const luas3 = [];
  for (const l of ["lua5.1", "lua5.4"]) { try { execFileSync(l, ["-v"], { stdio: "pipe" }); luas3.push(l); } catch (e) { /* skip */ } }
  mkdirSync(TMP, { recursive: true });
  for (const [label, eo] of [["tag0", "stored"], ["tag1", "huffman"], ["tag2", "rc"]]) {
    const r = Z.compressToLoader(modSrc, { seed: 41, minify: false, entropy: eo, mode: "run" });
    ok(r.entropy === (label === "tag0" ? 0 : label === "tag1" ? 1 : 2), label + " engine actually shipped");
    ok(Z.decompressLoader(r.loader).src === r.workText, label + " loader JS round-trip");
    for (const lua of luas3) {
      const f = path.join(TMP, "eng_" + label + "_" + lua + ".lua");
      writeFileSync(f, r.loader, "utf8");
      let out = null;
      try { out = execFileSync(lua, [f], { encoding: "utf8", maxBuffer: 1 << 26 }); }
      catch (e) { ok(false, label + " " + lua + " run (lua error: " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message) + ")"); }
      if (out !== null) ok(out === "engines ok\n", label + " engine output-exact under " + lua);
    }
  }
  let luau3 = null;
  for (const cand of [path.join(ROOT, ".tools", "luau"), "luau"]) {
    try { execFileSync(cand, ["--help"], { stdio: "pipe" }); luau3 = cand; break; } catch (e) { /* keep looking */ }
  }
  if (luau3) {
    for (const [label, eo] of [["tag0", "stored"], ["tag1", "huffman"], ["tag2", "rc"]]) {
      const r = Z.compressToLoader(modSrc, { seed: 41, minify: false, entropy: eo, mode: "run" });
      const f = path.join(TMP, "eng_" + label + "_luau.lua");
      writeFileSync(f, "local src=[====[\n" + r.loader + "\n]====]\n(loadstring or load)(src)()", "utf8");
      let out = null;
      try { out = execFileSync(luau3, [f], { encoding: "utf8", maxBuffer: 1 << 26 }); }
      catch (e) { ok(false, label + " luau run: " + (e.stderr ? e.stderr.toString().split("\n")[0] : e.message)); }
      if (out !== null) ok(out === "engines ok\n", label + " engine output-exact under luau");
    }
  }
  rmSync(TMP, { recursive: true, force: true });
}

/* ============ stats ============ */
{
  console.log("\n== stats ==");
  const r = Z.compressToLoader(Z.SAMPLE, { seed: 1 });
  console.log("  sample (" + r.origBytes + " B): minified -> " + r.workBytes + " B | payload " + r.payloadChars +
    " chars | loader " + r.loaderChars + " chars (" + Math.round((1 - r.loaderChars / Math.max(1, r.origChars || r.origBytes)) * 100) +
    "% smaller) | " + r.algo + (r.usedDP ? "+DP" : "") + " | tokens " + r.tokens);
  const rRaw = Z.compressToLoader(Z.SAMPLE, { seed: 1, minify: false });
  console.log("  sample raw (no minify): payload " + rRaw.payloadChars + " chars | tokens " + rRaw.tokens + " | DP " + rRaw.usedDP);
  const big = Z.compressToLoader(rnd(20000, "local function end print return if then else for do game GetService Players workspace \n\t"), { seed: 2, minify: false });
  console.log("  20KB code-like (no minify): loader " + big.loaderChars + " chars (" + Math.round((1 - big.loaderChars / big.origBytes) * 100) + "% smaller) | tokens " + big.tokens + " | DP " + big.usedDP);
}

console.log("\n== RESULT: " + passed + " passed, " + failed + " failed ==");
process.exit(failed ? 1 : 0);
