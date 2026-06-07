import { test, expect, type Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────
// 冒煙測試 (Layer 2):確保「缺東西就壞掉」的 bug 不會溜進 release。
//
// 只盯「缺少某物」這一類錯誤訊息(其餘 app 狀態錯誤忽略,降低雜訊):
//   • ReferenceError: X is not defined      ← 缺 import / 缺 export(今天踩到的)
//   • X is not a function                    ← 接到 undefined 當 handler
//   • Cannot read properties of null …       ← 缺 DOM 節點
// ─────────────────────────────────────────────────────────────────────────
const MISSING = /is not defined|is not a function|ReferenceError|Cannot read propert(?:y|ies) of (?:null|undefined)/i;

// 載入前就裝好:錯誤收集器 + 把會卡住/跳走的 API 打樁。
const INIT = `
  window.__errs = [];
  addEventListener('error', e => window.__errs.push(String((e.error && e.error.stack) || e.message)));
  addEventListener('unhandledrejection', e => window.__errs.push('unhandledrejection: ' + String(e.reason && (e.reason.stack || e.reason))));
  window.alert = () => {};
  window.confirm = () => false;   // 取消 → 不執行破壞性動作,但 handler 仍跑過 guard
  window.prompt = () => null;
  window.open = () => null;
`;

async function load(page: Page) {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.stack || e.message)));
  await page.addInitScript(INIT);
  await page.goto("/STAAD-Tracer.html", { waitUntil: "load" });
  await page.waitForTimeout(800);   // 讓 top-level wiring / 非同步初始化跑完
  return pageErrors;
}

test("頁面載入時沒有缺 import / 缺節點造成的崩潰", async ({ page }) => {
  const pageErrors = await load(page);
  const inPage: string[] = await page.evaluate(() => (window as any).__errs || []);
  const all = [...pageErrors, ...inPage];
  const missingErrs = all.filter((e) => MISSING.test(e));
  expect(missingErrs, `載入期出現「缺東西」錯誤:\n${missingErrs.join("\n---\n")}`).toEqual([]);
});

test("逐顆按鈕點擊都不會丟 ReferenceError / is-not-a-function", async ({ page }) => {
  await load(page);

  // 在頁內逐顆 dispatch click(直接打在元素上,繞過遮擋/可見性 → 連對話框內按鈕也測到)。
  // 事件監聽器丟出的同步例外會被瀏覽器回報到 window 'error',所以 __errs 收得到。
  const findings: { id: string; errs: string[] }[] = await page.evaluate(async () => {
    const errs: string[] = (window as any).__errs;
    const buttons = Array.from(document.querySelectorAll("button"));
    const out: { id: string; errs: string[] }[] = [];
    for (const b of buttons) {
      const label = b.id || (b.textContent || "").trim().slice(0, 24) || "(無 id/文字)";
      const before = errs.length;
      try {
        b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } catch (e) {
        errs.push(String(e));
      }
      await new Promise((r) => setTimeout(r, 0));   // 收 microtask / unhandledrejection
      const fresh = errs.slice(before);
      if (fresh.length) out.push({ id: label, errs: fresh });
    }
    return out;
  });

  const offenders = findings
    .map((f) => ({ id: f.id, errs: f.errs.filter((e) => MISSING.test(e)) }))
    .filter((f) => f.errs.length);

  const report = offenders.map((o) => `▶ 按鈕「${o.id}」\n   ${o.errs.join("\n   ")}`).join("\n\n");
  expect(offenders, `以下按鈕點擊後出現「缺東西」錯誤:\n\n${report}`).toEqual([]);
});
