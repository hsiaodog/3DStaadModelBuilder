import { test, expect, type Page } from "@playwright/test";

// 命令列(AutoCAD 風)冒煙測試:確認指令登錄、自動完成、執行流程都活著,
// 且每個按鈕/選單都自動變成了指令(auto-scan 覆蓋)。
const MISSING = /is not defined|is not a function|ReferenceError|Cannot read propert(?:y|ies) of (?:null|undefined)/i;

async function load(page: Page) {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e.stack || e.message)));
  await page.addInitScript(`window.alert=()=>{};window.confirm=()=>false;window.prompt=()=>null;window.open=()=>null;`);
  await page.goto("/STAAD-Tracer.html", { waitUntil: "load" });
  await page.waitForTimeout(600);
  return errs;
}

test("命令列:開啟、自動完成、執行 help 都正常", async ({ page }) => {
  const errs = await load(page);

  // 命令列 DOM 應已注入
  await expect(page.locator("#cmdConsole .cc-input")).toHaveCount(1);

  // 按 / 叫出並聚焦
  await page.keyboard.press("/");
  const input = page.locator("#cmdConsole .cc-input");
  await expect(input).toBeFocused();

  // 打字 → 出現自動完成候選
  await input.fill("save");
  await expect(page.locator("#cmdConsole .cc-suggest .cc-sg").first()).toBeVisible();

  // 執行 help → 歷史出現「共 N 條指令」,且 N 夠大(證明 auto-scan 把按鈕+選單都收進來了)
  await input.fill("help");
  await input.press("Enter");
  const helpLine = page.locator("#cmdConsole .cc-hist .cc-info", { hasText: "共" });
  await expect(helpLine).toHaveCount(1);   // 已寫進歷史(可能被「只顯示最後 N 筆」裁切而不可見)
  const txt = await helpLine.first().textContent();
  const n = parseInt((txt || "").match(/共\s*(\d+)/)?.[1] || "0", 10);
  expect(n, `指令數應 > 100,實際 ${n}`).toBeGreaterThan(100);

  // Phase B:AutoCAD 短碼能解析(打 "L" 應出現候選,且第一條 matchedName 就是 "L")
  await input.fill("L");
  await expect(page.locator("#cmdConsole .cc-suggest .cc-sg").first()).toBeVisible();
  await expect(page.locator("#cmdConsole .cc-suggest .cc-sg .nm").first()).toHaveText("L");

  // Phase B:中文短查詢「搜尋」應命中搜尋指令(選單),不是對話框裡的「搜尋這些桿件」
  await input.fill("搜尋");
  await expect(page.locator("#cmdConsole .cc-suggest .cc-sg .nm").first()).toHaveText("搜尋");

  // 不存在的指令 → 紅字錯誤,但不可丟 JS 例外
  await input.fill("這不是指令xyz");
  await input.press("Enter");
  await expect(page.locator("#cmdConsole .cc-hist .cc-err").first()).toBeVisible();

  const missing = errs.filter((e) => MISSING.test(e));
  expect(missing, `命令列操作期出現缺東西錯誤:\n${missing.join("\n")}`).toEqual([]);
});

test("Phase C:參數型指令 — 行內參數、缺參數提問、格式驗證", async ({ page }) => {
  const errs = await load(page);
  await page.keyboard.press("/");
  const input = page.locator("#cmdConsole .cc-input");
  const lastLine = () => page.locator("#cmdConsole .cc-hist .cc-line").last();

  // 行內參數:grid 5 → 成功
  await input.fill("grid 5"); await input.press("Enter");
  await expect(lastLine()).toContainText("網格間距 = 5");

  // 缺參數:grid → 進入提問,prompt 標籤改變
  await input.fill("grid"); await input.press("Enter");
  await expect(lastLine()).toContainText("需要參數");
  await expect(page.locator("#cmdConsole .cc-prompt")).toContainText("網格間距");
  // 補值 → 成功,標籤還原
  await input.fill("8"); await input.press("Enter");
  await expect(lastLine()).toContainText("網格間距 = 8");
  await expect(page.locator("#cmdConsole .cc-prompt")).toHaveText("Command:");

  // 格式錯誤 → 紅字
  await input.fill("grid abc"); await input.press("Enter");
  await expect(lastLine()).toContainText("格式不正確");

  const missing = errs.filter((e) => MISSING.test(e));
  expect(missing, `參數指令操作期出現缺東西錯誤:\n${missing.join("\n")}`).toEqual([]);
});

test("狀態回饋:切換型指令會顯示 開/關、作用/取消", async ({ page }) => {
  await load(page);
  await page.keyboard.press("/");
  const input = page.locator("#cmdConsole .cc-input");
  const last = () => page.locator("#cmdConsole .cc-hist .cc-line").last();

  // 顯示切換:文字本身會在「顯示 / 隱藏」間變,回饋直接顯示結果狀態
  await input.fill("底圖顯示"); await input.press("Enter");
  await expect(last()).toContainText("隱藏");
  await input.fill("底圖顯示"); await input.press("Enter");
  await expect(last()).toContainText("顯示");

  // 模式切換:.active 變 → 顯示「作用中」
  await input.fill("L"); await input.press("Enter");
  await expect(last()).toContainText("作用中");
});

test("手動點按鈕也會記進歷史(🖱),且指令觸發不重複記", async ({ page }) => {
  await load(page);
  const last = () => page.locator("#cmdConsole .cc-hist .cc-line").last();

  // 手動點顯示切換 → 出現 🖱 + 結果狀態
  await page.locator("#btnBgToggle").click();
  await expect(last()).toContainText("🖱");
  await expect(last()).toContainText("隱藏");

  // 透過命令列執行 → 只有 echo + 結果兩行,不會多一筆 🖱
  await page.keyboard.press("/");
  const input = page.locator("#cmdConsole .cc-input");
  const before = await page.locator("#cmdConsole .cc-hist .cc-line").count();
  await input.fill("節點顯示"); await input.press("Enter");
  await page.waitForTimeout(120);
  const added = (await page.locator("#cmdConsole .cc-hist .cc-line").count()) - before;
  expect(added, "命令列執行應只新增 2 行(echo + 結果)").toBe(2);
});
