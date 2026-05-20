import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Vite config — 把 build 結果 inline 成單一 HTML,使用者體驗 0 變動。
// `dist/index.html` 是部署用單檔,雙擊即開。
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist',
    target: 'esnext',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,   // 100 MB:把所有 asset inline 進 index.html
    rollupOptions: {
      // 沒有額外 entry;單一入口 index.html
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    open: false,
  },
});
