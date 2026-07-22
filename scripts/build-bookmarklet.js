#!/usr/bin/env node
// Generate docs/bookmarklet.js + docs/bookmarklet.css from the extension
// sources, so the bookmarklet never drifts from content.js again.
//
//   node scripts/build-bookmarklet.js
//
// Differences applied to content.js:
//   1. Prepend a header that captures the script URL and injects
//      bookmarklet.css via <link> (the extension gets CSS from the manifest)
//   2. Swap the chrome.storage block (between BWS:STORAGE markers) for a
//      localStorage implementation — bookmarklets have no chrome.* APIs

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srcJs = fs.readFileSync(path.join(root, "content.js"), "utf8");
const srcCss = fs.readFileSync(path.join(root, "content.css"), "utf8");

const HEADER = `// GENERATED FILE — do not edit. Built from content.js by scripts/build-bookmarklet.js
// Capture script src before IIFE (document.currentScript is null inside IIFE)
var _bwsScriptSrc = document.currentScript ? document.currentScript.src : "";
`;

const CSS_INJECT = `
  // ===== Inject CSS (bookmarklet mode) =====
  if (!document.getElementById("bws-injected-style") && _bwsScriptSrc) {
    const baseUrl = _bwsScriptSrc.replace(/[^/]+(\\?.*)?$/, "");
    const link = document.createElement("link");
    link.id = "bws-injected-style";
    link.rel = "stylesheet";
    link.href = baseUrl + "bookmarklet.css";
    document.head.appendChild(link);
  }
`;

const STORAGE_LOCAL = `  // ==== BWS:STORAGE-BEGIN ====
  // Storage backend — localStorage (bookmarklet build)
  function storageWrite(obj) {
    try {
      localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(obj));
    } catch (_) { /* quota exceeded — ignore */ }
  }

  async function storageRead() {
    try {
      const raw = localStorage.getItem(CACHE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  // ==== BWS:STORAGE-END ====`;

// 1. Swap storage block
const storageRe = / {2}\/\/ ==== BWS:STORAGE-BEGIN ====[\s\S]*?\/\/ ==== BWS:STORAGE-END ====/;
if (!storageRe.test(srcJs)) {
  console.error("ERROR: BWS:STORAGE markers not found in content.js");
  process.exit(1);
}
let out = srcJs.replace(storageRe, STORAGE_LOCAL);

// 2. Insert CSS injection right after "use strict";
const strictRe = /\(\(\) => \{\n {2}"use strict";\n/;
if (!strictRe.test(out)) {
  console.error('ERROR: IIFE "use strict" prologue not found in content.js');
  process.exit(1);
}
out = out.replace(strictRe, (m) => m + CSS_INJECT);

// 3. Prepend header
out = HEADER + out;

// Sanity: no chrome.* API calls may survive in the bookmarklet build
const leftover = out.match(/chrome\.(storage|runtime|tabs)/);
if (leftover) {
  console.error("ERROR: chrome API reference left in bookmarklet: " + leftover[0]);
  process.exit(1);
}

fs.writeFileSync(path.join(root, "docs", "bookmarklet.js"), out);
fs.writeFileSync(
  path.join(root, "docs", "bookmarklet.css"),
  "/* GENERATED FILE — built from content.css by scripts/build-bookmarklet.js */\n" + srcCss
);
console.log("built docs/bookmarklet.js (" + out.split("\n").length + " lines) and docs/bookmarklet.css");
