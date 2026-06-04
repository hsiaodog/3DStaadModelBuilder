// Phase 1 — main entry。
//   1) inline pdf.js + worker(? raw 把 UMD source 當字串 import,global eval → window.pdfjsLib)
//   2) worker source 也 inline,跑 Blob URL 設給 GlobalWorkerOptions.workerSrc
//   3) import app/integration.ts(整段舊 code,@ts-nocheck)
//   4) import style.css(Vite CSS pipeline 處理)
// 目標:dist/index.html 是真正單檔(2.5MB 左右,含 pdf.js 1.4MB),雙擊即開。

import "./style.css";

// pdf.js 主程式(UMD,assigns window.pdfjsLib)— 用 indirect eval 跑在 global scope
// 否則 ESM module scope 內的 var 不會升到 window
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import pdfjsLibSrc from "./vendor/pdf.min.js?raw";
// pdf.js worker(在主執行緒不執行;Blob URL 給 worker 用)
import pdfWorkerSrc from "./vendor/pdf.worker.min.js?raw";

try {
  // (0, eval) 強制 indirect eval → 在 global scope 跑;`var pdfjsLib = ...` 才會綁到 window
  (0, eval)(pdfjsLibSrc);
} catch (e) {
  console.error("[pdf.js] 主程式 eval 失敗:", e);
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<div style="position:fixed;top:0;left:0;right:0;background:#ff6464;color:#000;padding:8px;z-index:9999;font:14px sans-serif">pdf.min.js 載入失敗 — 請看 console</div>'
  );
}

// pdf.js worker 啟用策略:
//   • file:// 模式 → 主動關 worker(讓 pdf.js 走 main-thread 同步路徑)。
//     原因:從 file:// 創出來的 blob URL origin 是 null,瀏覽器會擋 Worker
//     ("Not allowed to load local resource: blob:null/...")。原本 pdf.js 自己會
//     fallback,但會先丟一個紅色 console error → 直接跳過試 worker 這步,避免 noise。
//   • 其他模式(http/https/Tauri/PWA installed) → 用 Blob URL 起 worker,大 PDF parse
//     不阻塞主執行緒。
try {
  const w = window as any;
  if (!w.pdfjsLib) {
    console.error("[pdf.js] window.pdfjsLib 仍 undefined — eval 沒生效");
  } else if (location.protocol === "file:") {
    w.pdfjsLib.GlobalWorkerOptions.workerSrc = "";   // 明確告訴 pdf.js:不要試 worker
    console.log("pdf.js v" + (w.pdfjsLib.version || "?") + " 已載入(file://, main-thread fallback)");
  } else {
    const workerBlob = new Blob([pdfWorkerSrc], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(workerBlob);
    w.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    console.log("pdf.js v" + (w.pdfjsLib.version || "?") + " 已載入(worker via blob URL)");
  }
} catch (e) {
  console.error("[pdf.js] worker 設定失敗:", e);
}

// 把整合層拉進來執行(@ts-nocheck;之後 phase 會逐步拆模組)
import "./app/integration.ts";
