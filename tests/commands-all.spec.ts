import { test, expect, type Page } from "@playwright/test";

// 全面命令測試:把「每一條」註冊指令都實際執行一次,確認沒有
//   ReferenceError / is-not-a-function(= 缺 import / 缺 export / 接到 undefined)。
//
// 這補上 button smoke 沒覆蓋到的「選單動作(menu actions)」與內建/參數指令,
// 是當初那批 bug(showBgCtxMenu / bgPathsToMembers …)的同類防線,但走命令路徑。
//
// 只盯「缺東西」訊息;DOM-null 類因為測試 stub 了 alert/confirm/open 會有雜訊,
// 那一類由 Layer 1(check-wiring)靜態涵蓋,這裡刻意不收。
const MISSING = /is not defined|is not a function|ReferenceError/i;

async function load(page: Page) {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e.stack || e.message)));
  await page.addInitScript(`window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;window.open=()=>null;`);
  await page.goto("/STAAD-Tracer.html", { waitUntil: "load" });
  await page.waitForTimeout(700);
  return errs;
}

test("全面:每一條指令都能執行,不丟 ReferenceError / is-not-a-function", async ({ page }) => {
  await load(page);

  // 測試 hook 應已掛上
  await expect.poll(() => page.evaluate(() => !!(window as any).__cmd)).toBeTruthy();

  const result = await page.evaluate(async () => {
    const MISS = /is not defined|is not a function|ReferenceError/i;
    const errs: string[] = [];
    addEventListener("error", (e: any) => errs.push(String((e.error && e.error.stack) || e.message)));
    addEventListener("unhandledrejection", (e: any) => errs.push("rej: " + String((e.reason && e.reason.stack) || e.reason)));
    const api = (window as any).__cmd;
    const cmds = api.list();
    const offenders: { id: string; name: string; errs: string[] }[] = [];
    for (const c of cmds) {
      const before = errs.length;
      try { api.run(c.id); } catch (e: any) { errs.push(String((e && e.stack) || e)); }
      await new Promise((r) => setTimeout(r, 0));
      const fresh = errs.slice(before).filter((x) => MISS.test(x));
      if (fresh.length) offenders.push({ id: c.id, name: c.name, errs: fresh });
      // 關掉執行指令時可能彈出的對話框/選單,降低後續指令互相干擾
      try { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch (_) {}
    }
    return { count: cmds.length, offenders };
  });

  console.log(`[全面命令測試] 共執行 ${result.count} 條指令`);
  expect(result.count, "指令數應 > 180").toBeGreaterThan(180);

  const report = result.offenders.map((o) => `▶ ${o.name} (${o.id})\n   ${o.errs.join("\n   ")}`).join("\n\n");
  expect(result.offenders, `以下指令執行時出現「缺東西」錯誤:\n\n${report}`).toEqual([]);
});
