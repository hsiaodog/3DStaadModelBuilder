import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 從 package.json 讀版本(用 readFileSync 而非 import,避免 TS 抱怨 JSON import 設定)
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// 命名規約(刻意把 source 跟 dist 取不一樣的檔名,避免混淆):
//   • `app.html`        — root 的 Vite entry,僅 DOM 骨架 + <script src="/src/main.ts">,
//                          只有 dev server / build 在用,絕不能直接雙擊。
//   • `dist/index.html` — build 後的單檔成品,所有 CSS / JS / pdf.js 都 inline 進去,
//                          使用者拿到的就是這個。檔名維持 index.html 是給 GitHub Pages
//                          / 其他靜態 host 預設 index 用。
//
// __APP_VERSION__ / __APP_REPO__:版本檢查用的編譯期常數,從 package.json 注入。
// src/ui/versionCheck.ts 直接讀,不用 fetch package.json。
export default defineConfig({
  plugins: [
    viteSingleFile(),
    // build 完把 dist/app.html 改名成 dist/index.html(預設 web server entry name)
    {
      name: 'rename-app-to-index',
      closeBundle() {
        const from = resolve(__dirname, 'dist/app.html');
        const to   = resolve(__dirname, 'dist/index.html');
        if (existsSync(from)) renameSync(from, to);
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REPO__: JSON.stringify('hsiaodog/3DStaadModelBuilder'),
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,   // 100 MB:把所有 asset inline 進 index.html
    rollupOptions: {
      input: resolve(__dirname, 'app.html'),   // 單一入口,改名後仍是它
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
});
