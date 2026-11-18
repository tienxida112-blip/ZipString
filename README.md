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
| **Loader** | self-extractors | `return(function(unpack,env,compressedcode)…end)(unpack,env,compressedcode)`, then the engine's locals simply continue down the alphabet: `e, f, g, … z, aa, ab, …` (2-char and 3-char names kick in when the single-letter bank runs out; keywords are skipped). Pure Lua 5.1: works on Lua 5.1–5.4, LuaJIT, Luau and executors (`getgenv`/`getfenv` handled). |

The only comment in the output is the header:

```lua
--This file is minified by ZipString (https://tienxida112-blip.github.oi/ZipString)
return(function(unpack,env,compressedcode)local a,b,c,d=...end)(unpack,env,compressedcode)
```

The seed is picked at random on every compress (shown in the header so a loader can
always be reproduced later with the Decompress tab or `ZIPSTR.compressToLoader(src, {seed})`).

## License

[MIT](LICENSE) — Copyright (c) 2026 ZipString contributors.

## Credits

ZipString is a vibecoded tool that helps you minify your Lua code — everything runs
locally in your browser, nothing you paste is ever uploaded.