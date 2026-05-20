// Phase 0 — Vite + TypeScript 殼建好的驗證 entry
// 之後 phase 會逐步把 index_legacy.html 的 JS 內容拆進 src/ 各 module。
console.log("[staad-tracer] Vite shell up. (Phase 0 baseline)");

// import 一個 CSS 進來,確認 Vite 的 CSS pipeline 也 OK
import "./style.css";

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("app");
  if (root) {
    root.innerHTML = `
      <div style="padding:40px;font:14px/1.6 -apple-system,sans-serif;color:#e6e6e6;background:#1e1f22;min-height:100vh">
        <h1 style="color:#66d9b0;margin:0 0 8px">STAAD 描圖工具 — Vite 殼 OK</h1>
        <p style="color:#9aa0a6">這是 Phase 0 的驗證頁面。實際功能在 <code style="background:#2b2d31;padding:2px 6px;border-radius:3px">index_legacy.html</code> 還能用,Phase 1 會把它的內容搬進這套 Vite + TypeScript 結構。</p>
        <ul style="color:#9aa0a6;line-height:2">
          <li>✓ Vite build pipeline up</li>
          <li>✓ TypeScript compiler available</li>
          <li>✓ <code style="background:#2b2d31;padding:2px 6px;border-radius:3px">vite-plugin-singlefile</code> inlines JS/CSS into one HTML</li>
          <li>✓ <code style="background:#2b2d31;padding:2px 6px;border-radius:3px">dist/index.html</code> 雙擊即開</li>
        </ul>
        <p style="color:#7b818a;font-size:11px;margin-top:24px">下一步:Phase 1 — 把 index_legacy.html 整段內容貼進 Vite 結構。</p>
      </div>
    `;
  }
});
