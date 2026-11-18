# ZipString 🗜️

**Minify your code, without worrying about whether the storage is almost full.**

A zip/tar.gz/tar.xz-inspired compressor **and minifier** for Lua/Luau (Roblox scripts,
executors, plain Lua) that runs entirely in your browser. Paste a script, get back
one single-line, self-extracting `loadstring` — nothing is uploaded anywhere.

→ Open the site and you land straight in the **compressor** (the root page
auto-redirects there); the decompressor lives at **`/decompressor/`**.
Everything runs client-side.

```
index.html               auto-redirects to compressor/
compressor/index.html    the compressor      →  your.site/compressor/
decompressor/index.html  the decompressor    →  your.site/decompressor/
src/decompressor.js      standalone decoder (Decompress page + round-trip verification)
src/compressor.js        minifier + LZ77 + Huffman + ASCII85 encoder + loader generator
src/app.js               UI wiring (each page wires only its own elements)
src/style.css            shared styles
```

No build step, no CDN, no assets — keep the folder structure and it works from disk
or any static host. On GitHub Pages the pretty URLs `…/compressor` and `…/decompressor`
work automatically (directories with an `index.html`).

---

## What it does

```
your script ──► minify ──► LZ77 (lazy + optimal parse) ──► range coder ∨ Huffman ──► ASCII85 ──► one-line loader
                (Stage 0)   (Stage 1, rep0+rep1 reuse)     (Stage 2, smallest wins)  (Stage 3)
```

| Stage | Borrowed from | What it actually does |
|---|---|---|
| **0 — Minifier** (stacked passes) | lua-minifiers | ① Token-preserving lexer strips comments and all non-essential whitespace. ② Numbers shorten (`0.1` → `.1`, `1.50` → `1.5`, `007` → `7`). ③ Call parens drop around single string arguments (`game:GetService("Workspace")` → `game:GetService'Workspace'`). ④ **Scope-aware local renaming**: every local, parameter and loop var becomes `a, b, c, … z, aa, ab…` — fields, globals, labels, Luau type annotations and names that appear inside strings are never touched. Keeps shebang lines and leading `--!` / `--@` directives. **Luau backtick / interpolated strings pass through verbatim** — the string and every expression inside `\{…}` are kept byte-for-byte, and any name mentioned inside is never renamed, so references stay intact. |
| **1 — LZ77** | zip / LZMA | **2 MiB window**, match lengths 3–65,542. Two parsers: a greedy+lazy pass with deep hash-chain search, then — for inputs up to 2 MiB, when it pays — an LZMA-style **optimal parse** (dynamic programming over real Huffman bit costs). Matches at either of the **two previous distances** cost almost nothing (**rep0 + rep1**, like LZMA's distance reuse). |
| **2 — Huffman** | zip / tar.gz | Canonical Huffman over **365 symbols** (literals, lengths, rep0, rep1) + **76 distance slots** (4 per power of two — finer than deflate's 2, saves ~1 bit per match). The encoder emits **both 16 K and 64 K-token blockings** and keeps whichever is smaller. RLE-compressed code lengths. Stored (uncompressed) fallback when that wins. |
| **2b — Range coder** | LZMA / zstd | **Adaptive binary range coder** over the same LZ77 token stream: context-modeled bits (match/rep flags, 6-bit length tree, 7-bit distance tree, literal tree with last-byte + match-byte contexts, per-position extra bits), 11-bit adaptive probabilities. The encoder emits **both** the range-coded and the Huffman container and keeps whichever is smaller (with a stored fallback), so the format tag in the header (`0`/`1`/`2`) says which one shipped. Typically 10–16% smaller than Huffman on repetitive code. |
| **3 — ASCII85** | tar.xz's a85 filter | 4 bytes → 5 printable chars, then a seed-shuffled alphabet so every load looks different and contains no `]` (safe inside the long-bracket payload). |
| **Loader env** | Roblox + executors | detects the real environment at runtime: executors via `getgenv`, sandboxed Luau via `getfenv()`, Lua 5.1 via `_G` — the payload always sees the globals it's supposed to see. |
| **Loader** | self-extractors | `return(function()…end)()` — a fixed skeleton (locals `a`/`b`/`c`/`d`), then the engine's locals simply continue down the alphabet: `e, f, g, … z, aa, ab, …` (2-char and 3-char names kick in when the single-letter bank runs out; keywords are skipped). **Each loader carries only the decoder for the format it ships** (stored ≈ 1.1 KB, Huffman ≈ 1.5 KB, range ≈ 1.6 KB) — no dead branches — and the compressor picks whichever full loader is smallest. Pure Lua 5.1: works on Lua 5.1–5.4, LuaJIT, Luau and executors (`getgenv`/`getfenv` handled). |

The only comment in the output is the header:

```lua
--minified by ZipString (seed 3986750786) | 19630 B -> 3411 B (82.6% smaller) | minify+LZ77+range+ASCII85
return(function(unpack,env,compressedcode)local a,b,c,d=...end)(unpack,env,compressedcode)
```

The seed is picked at random on every compress (shown in the header so a loader can
always be reproduced later with the Decompress tab or `ZIPSTR.compressToLoader(src, {seed})`).

### Luau & Roblox support

- **Verified against the official Luau CLI**: `continue`, compound assignments (`+=`, `..=`, …),
  if-then-else expressions, `::` type casts, type annotations + generics, generalized iteration
  and backtick string interpolation all minify to output that runs **identically** to the original.
- **A real Luau bug, found and fixed (2026-11-18)**: the loader head used to `setfenv` the payload
  to `_G` — but in sandboxed Luau (official CLI, some hosts) `_G` is *not* the script's environment
  table, so the payload lost all its globals ("attempt to index nil"). The head now resolves the
  real environment via `getgenv`/`getfenv()` and only falls back to `_G`. Old loaders made before
  this fix should be regenerated if you run them in such environments.
- **On plain Roblox** (no executor), `loadstring` only exists when
  *ServerScriptService ▸ LoadStringEnabled* is on — the loader now says exactly that when it's missing.

### UI

- **Compress page (`/compressor/`)** — paste (or 📂 **Import .lua**) a script, hit *Minify + compress*, copy the one-line loader.
  The minifier can be toggled off if you need byte-exact output.
- **Huge files** — the input box *displays* at most the **first 500,000 chars** (so the tab never lags), but the
  **full original is stored** and compressed — import a 10 MB file and all 10 MB end up in the loader
  (10 MB of real code → 99.95% smaller, decodes in ~0.5 s). The char counter always shows the true full size.
  If you edit the shown text, the tool switches to what-you-see-is-what-you-get. Hard safety limit: 20,000,000 chars.
- **Huge outputs** — if the loader itself is huge, the output box shows only the first 200,000 chars plus
  `-- Output cutted cuz it too big, dont worry, the whole code still stored` —
  **Copy and Download always give you the full loader.**
- **Honest stats** — the result row shows every stage separately (`original → minified → compressed
  payload → loader`, each with its own percentage) and the big number includes the explicit math
  (`12,765,139 B → 829,734 B`). The total is nothing magical: it's minify % + LZ77/Huffman %
  stacked. The ✓ line confirms the full loader decodes back to every byte — double-check any
  loader yourself in the Decompress tab.
- **Decompress page (`/decompressor/`)** — paste a ZipString loader to verify/inspect it (it returns the
  *minified* text when the minifier was used — minification is lossy by design).
  Loaders made before 2026-11-17 (old 329-symbol format) still decode — the old
  format is auto-detected and flagged.

## Realistic ratios (honest numbers)

What you get depends entirely on how repetitive the input is:

Every number below is the **real, headline number** — the loader you paste vs. the
input you pasted, char for char (the UI computes it exactly this way):

| Input | Size | Loader | Reduction |
|---|---|---|---|
| Dense module bundle (big project, minify −7%) | 12,706,117 B | 1,378,733 B | **89.1%** — minify, then LZ77+range −90% of the rest |
| Same bundle at 400 KB | 404,425 B | 46,619 B | **88.5%** — byte-exact in lua5.1, lua5.4 **and** the official Luau CLI |
| Realistic script ×256 (**500 KB**) | 502,528 B | 4,410 chars | **99.1%** |
| Same script ×512 (repetitive) | 1,005,056 B | 4,427 chars | **99.6%** |
| `ab` repeated 1 MiB | 1,048,576 B | 3,570 chars | **99.7%** |
| Realistic script ×3 (**5.9 KB**) | 5,889 chars | 4,381 chars | **25.6% smaller** — small files genuinely compress now |
| Realistic 2 KB script (full loader) | 1,963 chars | 3,173 chars | −62% (bigger — see below) |
| Pure random ASCII, 10 MB | 10,000,000 chars | ~10,341,109 chars | ~3% bigger (entropy floor, see below) |

The big number on the compressor page is always **loader vs. your original input**
(chars vs. chars) — stage chips are labeled with what they're measured against
(minify vs. input, entropy stage vs. minified), so nothing inflates the result.

Two honest caveats:

- **The loader carries a small fixed engine** (stored ≈ 1.1 KB, Huffman ≈ 1.5 KB,
  range ≈ 1.6 KB — each loader only embeds its own format's decoder). Scripts below
  **~4.3 KB** can still come out *larger* than the input — the header and the UI will
  tell you so truthfully. Past that break-even the ratio climbs fast (5.9 KB → −26%,
  500 KB → −99%).
- **Minification is lossy**: comments, indentation, blank lines and original local
  names are gone for good (that's the point). Turn it off if you need the exact bytes back.

**About "my 10 MB of random text got bigger":** if the file is mostly *encoded randomness* — an
obfuscated loadstring, base64/hex blobs, random passwords — there is no repetition left for
*any* compressor to exploit; ZipString's ASCII85 output stage even costs +25% on top, which
is why near-random input can come out slightly bigger. That's the entropy floor, not a bug:
zip/xz/tar.gz hit the exact same wall on random data. Real source code (even huge projects)
is a completely different story — see the table above.

## Verified by tests

> **Regenerate any loader made before 2026-11-17** — a rep0-across-blocks bug (fixed
> that day) could make large multi-block loaders fail in real Lua with
> `corrupt stream: distance too far`. The Decompress tab still reads them; just
> re-compress to get a loader that runs everywhere. (2026-11-17 also switched the
> payload format to rep0+rep1 with 76 distance slots — but since every loader embeds
> its own engine, old loaders keep running everywhere, and the Decompress tab
> auto-detects the old format. Nothing *must* be regenerated for correctness.)

`tests/run_tests.mjs` (Node ≥ 18) runs **684 checks**, all passing:

- **Minifier battery** — semantic equality of minified vs. original output under **real
  Lua 5.1 and 5.4** for the whole stacked pipeline: local renaming (closures, upvalues,
  recursion, shadowing, `local x = x` initializer scoping, globals mixed with locals,
  repeat-until, both for-loop forms, methods/self, params), numbers incl. `0.1` → `.1`,
  call-paren dropping `f("x")` → `f'x'` incl. chains, long strings, `...`, operators,
  `- -` hazards, `[ [[k]] ]` bracket hazards, goto/labels, Luau type annotations and
  generics (exact-output), exact-output spot checks, idempotence, whitespace/comment
  invariance (a lexer-aware fuzzer re-inflates every source with random whitespace +
  injected comments), `luac5.1 -p` parse checks, Luau backtick bail.
- **Name battery** — same seed → identical loader; engine locals are always the
  deterministic `a, b, c, d, e, f, …` bank (never keywords or globals like `io`/`os`).
- **Syntax battery** — the exact string/number escapes real code uses:
  `\z` (incl. a newline inside the whitespace run — the case that used to end the
  string token early and produce Luau's "Malformed string"), `\xNN`, `\ddd`,
  `\u{…}`, `\`+newline, exponent signs glued to their numeral (`1e+5`, `2e-3`,
  `0x1p+4`, `0xA.8p2` — a space there would be a *malformed number*), long strings
  containing `\z`; semantic equality of minified output under real Lua 5.1 + 5.4.
- **Specialized engines / small files** — every format ships its own decoder (no dead
  branches), the compressor picks the smallest **full loader** (engine included, not
  just the container), the engine floor stays under 1.7 K chars, and all three
  engines decode output-exact under lua5.1, lua5.4 **and** the Luau CLI; break-even
  (loader ≤ input) is reached within ~6× the 2 KB sample.
- **JS fuzz** — byte-exact round-trips from 1 byte to 600 KB across many alphabets,
  unicode/CRLF/NUL payloads, 30 seeds, determinism.
- **Real Lua** — byte-exact `dump`-mode decompression under lua5.1 **and** lua5.4
  (incl. 1 MiB, 300 K, DP-parsed and rep0-chain inputs, **multi-block streams where
  rep0 matches cross 16 K-token block boundaries** — this exact case once shipped with
  a bug where the Lua engine reset the rep0 distance per block while the encoder
  carried it, making real Lua fail with `corrupt stream: distance too far` on large
  files even though the in-browser check passed; found via a user report, fixed and
  regression-tested since), run-mode execution with return values and globals,
  compile-error and runtime-error propagation, corrupted-loader detection,
  `luac5.1 -p` on 25 varied-seed loaders.
- **v8 format battery** — synthetic rep1 (alternating-distance) streams encode →
  decode byte-exact; loaders made by the pre-v8 encoder still decode via the
  auto-detected legacy tables (and are flagged as legacy); fresh loaders are never
  mis-detected as legacy.
- **Range coder (tag 2)** — for six input classes (tiny → 400 K): `entropy` option
  tags, JS round-trips, and auto always keeping the smallest container; **real
  lua5.1 + lua5.4** byte-exact `dump` decoding of a 400 K range-coded loader and
  output-exact run-mode decoding; **official Luau CLI** byte-exact on a 400 K
  range-coded payload (print-wrapped, no dump mode needed). The Lua-side range
  decoder is pure 5.1-compatible arithmetic (`math.floor`, no bitwise ops), so the
  same engine runs on Lua 5.1–5.4, LuaJIT, Luau and executors.
- **Real Luau (official Luau CLI)** — every modern-Luau construct listed above minifies to
  output that runs identically to the original under real Luau; a Roblox-style payload
  (game/Instance/task/Color3/Enum stubs) executes from a generated loader with its globals
  intact (the env-fix regression); a 400 K multi-block payload decodes **byte-exact** under Luau.
  Put the official `luau` binary at `.tools/luau` (or in PATH) — the section skips with a warning
  if it's absent.

```bash
# Debian/Ubuntu interpreters for the real-Lua section
sudo apt-get install -y --no-install-recommends lua5.1 lua5.4
# official Luau CLI for the real-Luau section (github.com/luau-lang/luau/releases)
mkdir -p .tools && curl -sL https://github.com/luau-lang/luau/releases/latest/download/luau-ubuntu.zip -o /tmp/luau.zip && unzip -o -q /tmp/luau.zip luau -d .tools
node tests/run_tests.mjs
```

Performance: 500 KB of code compresses in ~255 ms; a 12.7 MB dense module bundle in
~40 s (deeper search + trying two blockings + full round-trip verification).
Decoding is strictly O(n) — ~65 ms for 330 KB, ~2.6 s for 11.9 MB in plain Lua 5.1 —
so there is no runtime lag regardless of input size. (10 MB of pure random text, the
worst case, takes ~29 s to compress and gains nothing — entropy is entropy.)

## Deploy to GitHub Pages

1. Create a repo (e.g. `zipstring`).
2. Commit the whole folder structure — `index.html`, `compressor/`, `decompressor/`,
   `src/` (plain static files: no build step, no CDN, no assets).
3. Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save.
4. Your tools are live at `https://<user>.github.io/zipstring/compressor/` and
   `https://<user>.github.io/zipstring/decompressor/`.

## License

[MIT](LICENSE) — Copyright (c) 2026 ZipString contributors.

## Credits

ZipString is a vibecoded tool that helps you minify your Lua code — everything runs
locally in your browser, nothing you paste is ever uploaded.
