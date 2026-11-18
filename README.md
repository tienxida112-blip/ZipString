# ZipString 🗜️
Lua Code compressor
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
| **Loader** | self-extractors | `return(function(unpack,env,compressedcode)…end)(unpack,env,compressedcode)` — a fixed skeleton (locals `a`/`b`/`c`/`d`), then the engine's locals simply continue down the alphabet: `e, f, g, … z, aa, ab, …` (2-char and 3-char names kick in when the single-letter bank runs out; keywords are skipped). Pure Lua 5.1: works on Lua 5.1–5.4, LuaJIT, Luau and executors (`getgenv`/`getfenv` handled). |

The only comment in the output is the header:

```lua
--This file is minified by ZipString (seed 3986750786) | 19630 B -> 4102 B (79.1% smaller) | minify+LZ77+range+ASCII85
return(function(unpack,env,compressedcode)local a,b,c,d=...end)(unpack,env,compressedcode)
```

The seed is picked at random on every compress (shown in the header so a loader can
always be reproduced later with the Decompress tab or `ZIPSTR.compressToLoader(src, {seed})`).

## Reduced ratios

What you get depends entirely on how repetitive the input is:

Every number below is the **real, headline number** — the loader you paste vs. the
input you pasted, char for char (the UI computes it exactly this way):

| Input | Size | Loader | Reduction |
|---|---|---|---|
| Dense module bundle (big project, minify −7%) | 12,706,117 B | 1,381,142 B | **89.1%** — minify, then LZ77+range −90% of the rest; range beat Huffman by ~11% |
| Same bundle at 400 KB | 404,425 B | 49,028 B | **87.9%** — byte-exact in lua5.1, lua5.4 **and** the official Luau CLI |
| Realistic script ×256 (**500 KB**) | 502,528 B | 7,429 chars | **98.5%** |
| Same script ×512 (repetitive) | 1,005,056 B | 7,454 chars | **99.3%** |
| `ab` repeated 1 MiB | 1,048,576 B | 6,306 chars | **99.4%** |
| Realistic 2 KB script (full loader) | 1,963 chars | 7,108 chars | −262% (bigger — see below) |
| Pure random ASCII, 10 MB | 10,000,000 chars | 10,341,109 chars | 3.4% bigger (entropy floor, see below) |

The big number on the compressor page is always **loader vs. your original input**
(chars vs. chars) — stage chips are labeled with what they're measured against
(minify vs. input, entropy stage vs. minified), so nothing inflates the result.

Two honest caveats:

- **The loader has a fixed ~3.6 KB engine.** Scripts below ~4–5 KB can come out *larger* than
  the input — the header and the UI will tel you so truthfully. Paste a bigger script
  (e.g. the same module pasted several times) and the ratio climbs fast.
- **Minification is lossy**: comments, indentation, blank lines and original local
  names are gone for good (that's the point). Turn it off if you need the exact bytes back.

**About "my 10 MB of random text got bigger":** if the file is mostly *encoded randomness* — an
obfuscated loadstring, base64/hex blobs, random passwords — there is no repetition left for
*any* compressor to exploit; ZipString's ASCII85 output stage even costs +25% on top, which
is why near-random input can come out slightly bigger. That's the entropy floor, not a bug:
zip/xz/tar.gz hit the exact same wall on random data. Real source code (even huge projects)
is a completely different story — see the table above.

 the original under real Luau; a Roblox-style payload
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

## License

[MIT](LICENSE) — Copyright (c) 2026 ZipString contributors.

## Credits

ZipString is a vibecoded tool that helps you minify your Lua code — everything runs
locally in your browser, nothing you paste is ever uploaded.
