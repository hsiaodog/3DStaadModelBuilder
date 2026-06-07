import { defineConfig, devices } from "@playwright/test";

// 冒煙測試:載入已 build 的單檔 STAAD-Tracer.html,確認每個按鈕點下去
// 不會因為「缺 import / 缺函式 / 缺節點」而丟 ReferenceError / is not a function。
// 先決條件:要先 `npm run build` 產生最新的 STAAD-Tracer.html。
const PORT = Number(process.env.SMOKE_PORT || 4173);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/static-server.mjs",
    url: `http://localhost:${PORT}/STAAD-Tracer.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
