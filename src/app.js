/* ZipString app.js — UI wiring, shared by both pages:
     /compressor/    (has #btnCompress)
     /decompressor/  (has #btnDecompress)
   Each page only wires the elements it contains.
   Requires src/decompressor.js + src/compressor.js (loaded first). */
(function () {
  const C = globalThis.ZipStringC, D = globalThis.ZipStringD;
  const $ = function (id) { return document.getElementById(id); };
  const fmt = function (n) { return n.toLocaleString("en-US"); };
  let timer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function showErr(box, e) {
    const b = $(box);
    b.style.display = "block";
    b.textContent = "⚠ " + (e && e.message ? e.message : String(e));
  }
  function hideErr(box) { $(box).style.display = "none"; }

  function copyText(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast(msg + " ✓"); },
        function () { legacyCopy(text, msg); }
      );
    } else legacyCopy(text, msg);
  }
  function legacyCopy(text, msg) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) { toast(msg + " ✓"); return; }
    } catch (e) { /* fall through */ }
    toast("copy blocked here — select the text and press Ctrl/Cmd+C");
  }
  /* ================= compressor page ================= */
  if ($("btnCompress")) {
  function countIn() {
    const v = inputShown ? fullInput : $("input").value;
    const bytes = new TextEncoder().encode(v).length;
    let txt = fmt(v.length) + " chars · " + fmt(bytes) + " bytes (UTF-8)";
    if (inputShown) txt += " · box shows first " + fmt(MAX_SHOW_IN) + " — original stored";
    $("inCount").textContent = txt;
  }
  $("input").addEventListener("input", function () {
    const v = $("input").value;
    if (!inputShown && v.length > MAX_SHOW_IN) {
      /* huge paste: keep the original, show only the prefix */
      fullInput = v;
      inputShown = true;
      $("input").value = v.slice(0, MAX_SHOW_IN);
      toast("⚠ " + fmt(v.length) + " chars — box shows first " + fmt(MAX_SHOW_IN) + ", original stored");
    } else if (inputShown) {
      /* any edit of the shown text takes over: what you see is what gets compressed */
      inputShown = false;
      fullInput = v;
      toast("editing the shown text — the stored original was replaced");
    } else fullInput = v;
    countIn();
  });

  const MAX_SHOW_IN = 500000; /* textbox shows at most this many chars */
  const MAX_SAFE = 20000000;  /* hard safety limit for compression */
  let fullInput = "";         /* authoritative input: the FULL original, never display-cut */
  let inputShown = false;     /* true while the textarea shows only a prefix of fullInput */

  $("btnClear").onclick = function () { $("input").value = ""; fullInput = ""; inputShown = false; countIn(); $("input").focus(); };

  /* import a .lua file */
  $("btnImport").onclick = function () { $("fileInput").click(); };
  $("fileInput").addEventListener("change", function () {
    const f = this.files && this.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = function () {
      fullInput = String(fr.result);
      if (fullInput.length > MAX_SHOW_IN) {
        inputShown = true;
        $("input").value = fullInput.slice(0, MAX_SHOW_IN);
        toast("imported " + f.name + " (" + fmt(fullInput.length) + " chars — box shows first " + fmt(MAX_SHOW_IN) + ", original stored)");
      } else {
        inputShown = false;
        $("input").value = fullInput;
        toast("imported " + f.name + " (" + fmt(fullInput.length) + " chars)");
      }
      countIn();
    };
    fr.onerror = function () { toast("could not read that file"); };
    fr.readAsText(f);
    this.value = "";
  });

  let fullLoader = ""; /* the complete loader — display may be cut, this never is */
  const MAX_SHOW = 500000; /* textarea display cap */
  $("btnCompress").onclick = function () {
    hideErr("errBox");
    try {
      const src2 = fullInput;
      if (!src2) throw new Error("paste or import a script first");
      if (src2.length > MAX_SAFE) throw new Error("input is " + fmt(src2.length) + " chars — over the " + fmt(MAX_SAFE) + "-char safety limit, nothing was compressed");
      const t0 = performance.now();
      const r = C.compressToLoader(src2, { minify: $("minify").checked });
      const ms = Math.round(performance.now() - t0);
      fullLoader = r.loader;
      if (r.loader.length > MAX_SHOW) {
        $("output").value = r.loader.slice(0, MAX_SHOW) + "\n-- Output cutted cuz it too big, dont worry, the whole code still stored";
        $("outCount").textContent = fmt(r.loaderChars) + " chars · 1 line · showing first " + fmt(MAX_SHOW) + " (copy/download = full)";
      } else {
        $("output").value = r.loader;
        $("outCount").textContent = fmt(r.loaderChars) + " chars · 1 line";
      }
      $("outCard").style.display = "block";
      /* output panel: % minified + the three sizes, nothing else */
      const origC = r.origChars || r.origBytes;
      const pct = Math.round((1 - r.loaderChars / Math.max(1, origC)) * 1000) / 10;
      const cls = pct >= 60 ? "good" : (pct >= 0 ? "mid" : "bad");
      const saved = origC - r.loaderChars;
      $("stats").innerHTML =
        '<div class="sv-big ' + cls + '">' + (pct >= 0 ? pct + "% minified" : (-pct) + "% bigger") + "</div>" +
        '<div class="sv-line">Input: <b>' + fmt(origC) + "</b> chars</div>" +
        '<div class="sv-line">Output: <b>' + fmt(r.loaderChars) + "</b> chars</div>" +
        '<div class="sv-line">Total: <b>' + fmt(origC) + " - " + fmt(r.loaderChars) + " = " + fmt(Math.abs(saved)) +
        "</b> chars " + (saved >= 0 ? "saved" : "bigger") + "</div>";
      /* silent self-check: the output must still decode back exactly */
      const back = D.decompressLoader(r.loader);
      if (back.src !== r.workText) throw new Error("internal error: round-trip mismatch");
    } catch (e) { showErr("errBox", e); }
  };

  $("btnCopy").onclick = function () { if (fullLoader) copyText(fullLoader, "full loader copied"); };
  $("btnDownload").onclick = function () {
    if (!fullLoader) return;
    try {
      const blob = new Blob([fullLoader], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "minified.lua";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast("downloaded minified.lua");
    } catch (e) { toast("download blocked in this preview — use Copy instead"); }
  };

    countIn();
  }

  /* ================= decompressor page ================= */
  if ($("btnDecompress")) {
  const MAX_SHOW_D = 500000; /* both boxes show at most this many chars */
  let fullDIn = "";           /* the FULL loader text, never display-cut */
  let dInShown = false;       /* true while the input box shows only a prefix */
  let fullDOut = "";          /* the FULL recovered source, never display-cut */
  function countDIn() {
    const v = dInShown ? fullDIn : $("dIn").value;
    const bytes = new TextEncoder().encode(v).length;
    let txt = fmt(v.length) + " chars · " + fmt(bytes) + " bytes (UTF-8)";
    if (dInShown) txt += " · box shows first " + fmt(MAX_SHOW_D) + " — full loader stored";
    $("dInCount").textContent = txt;
  }
  $("dIn").addEventListener("input", function () {
    const v = $("dIn").value;
    if (!dInShown && v.length > MAX_SHOW_D) {
      fullDIn = v;
      dInShown = true;
      $("dIn").value = v.slice(0, MAX_SHOW_D);
      toast("⚠ " + fmt(v.length) + " chars — box shows first " + fmt(MAX_SHOW_D) + ", full loader stored");
    } else if (dInShown) {
      dInShown = false;
      fullDIn = v;
      toast("editing the shown text — the stored loader was replaced");
    } else fullDIn = v;
    countDIn();
  });
  $("btnDClear").onclick = function () { $("dIn").value = ""; fullDIn = ""; dInShown = false; countDIn(); $("dIn").focus(); };
  $("btnDImport").onclick = function () { $("dFileInput").click(); };
  $("dFileInput").addEventListener("change", function () {
    const f = this.files && this.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = function () {
      fullDIn = String(fr.result);
      if (fullDIn.length > MAX_SHOW_D) {
        dInShown = true;
        $("dIn").value = fullDIn.slice(0, MAX_SHOW_D);
        toast("imported " + f.name + " (" + fmt(fullDIn.length) + " chars — box shows first " + fmt(MAX_SHOW_D) + ", full loader stored)");
      } else {
        dInShown = false;
        $("dIn").value = fullDIn;
        toast("imported " + f.name + " (" + fmt(fullDIn.length) + " chars)");
      }
      countDIn();
    };
    fr.onerror = function () { toast("could not read that file"); };
    fr.readAsText(f);
    this.value = "";
  });
  $("dCopy").onclick = function () { if (fullDOut) copyText(fullDOut, "full source copied"); };
  $("dDownload").onclick = function () {
    if (!fullDOut) return;
    try {
      const blob = new Blob([fullDOut], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "recovered.lua";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast("downloaded recovered.lua");
    } catch (e) { toast("download blocked in this preview — use Copy instead"); }
  };
  $("btnDecompress").onclick = function () {
    hideErr("dErrBox");
    $("dOutCard").style.display = "none";
    try {
      const loaderText = dInShown ? fullDIn : ($("dIn").value || fullDIn);
      if (!loaderText) throw new Error("paste or import a loader first");
      const t0 = performance.now();
      const r = D.decompressLoader(loaderText);
      fullDOut = r.src;
      if (r.src.length > MAX_SHOW_D) {
        $("dOut").value = r.src.slice(0, MAX_SHOW_D) + "\n-- Output cutted cuz it too big, dont worry, the whole code still stored";
        toast("⚠ " + fmt(r.src.length) + " chars — box shows first " + fmt(MAX_SHOW_D) + ", full source stored (copy/download = full)");
      } else {
        $("dOut").value = r.src;
      }
      $("dOutCard").style.display = "block";
      const fmtName = r.tag === 3 ? "raw (source as-is)" : (r.tag === 2 ? "LZ77+range" : (r.tag === 1 ? "LZ77+Huffman" : "stored"));
      const checkTxt = r.tag === 3 ? "no container — output is the minified source itself" : "checksum ✓ (source is the minified form if minify was on)";
      $("dMeta").textContent = fmt(r.len) + " bytes · " + fmtName +
        " · decoded in " + Math.max(1, Math.round(performance.now() - t0)) + " ms · " + checkTxt + (r.legacy ? " · legacy pre-v8 loader" : "");
    } catch (e) { showErr("dErrBox", e); }
  };
  countDIn();
  }
})();
