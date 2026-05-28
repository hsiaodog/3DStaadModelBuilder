# STAAD 描圖工具(STAAD Tracer)

依底圖(PDF / DXF / 圖片)在多個平面分別描出節點與桿件,自動聚合成 3D STAAD 模型,可匯出 `.std` / `.xlsx`。

---

## 給使用者(只想用 app,不開發)

### 安裝方式 1:`git clone`(推薦,有自動更新)

需要先裝 [Git](https://git-scm.com/downloads)。一次性安裝:

```bash
git clone https://github.com/hsiaodog/3DStaadModelBuilder.git
cd 3DStaadModelBuilder
```

雙擊 **`STAAD-Tracer.html`** → 預設瀏覽器打開 → 立刻可用。

之後想更新到最新版:

```bash
cd 3DStaadModelBuilder
git pull
```

`STAAD-Tracer.html` 會被覆寫成新版,重新打開或重新整理瀏覽器即可。

> App 內建版本檢查 — 啟動時會自動比對 GitHub 上最新 release;有新版會在頂部顯示提醒。也可用「說明 → 檢查更新」手動觸發。

### 安裝方式 2:下載單檔(不裝 git)

1. 開 [Releases 頁面](https://github.com/hsiaodog/3DStaadModelBuilder/releases)
2. 從最新 release 的 Assets 下載 `STAAD-Tracer.html`
3. 雙擊即可

更新就是再下載一次最新版蓋掉舊的。

### 安裝方式 3:GitHub Pages(直接用網址,不用下載)

> ⚠️ 需先由維護者啟用 GitHub Pages。啟用後網址會是:
> `https://hsiaodog.github.io/3DStaadModelBuilder/`

加書籤 → 之後永遠是最新版,沒有「更新」這回事。

### 系統需求

- 任何現代瀏覽器(建議 Chrome / Edge,Safari / Firefox 也可)
- 無作業系統限制:Windows / macOS / Linux 都行
- 完全離線可用(下載 `STAAD-Tracer.html` 後)
- 所有專案資料只存在本機(沒有伺服器、沒有帳號)

### 自動備份提醒

- 每分鐘自動把編輯內容備份到瀏覽器的 IndexedDB(**不會寫到你的硬碟檔案**)
- 每 30 分鐘提醒儲存(可關掉)
- 意外關閉瀏覽器再開啟時,會問你要不要復原上次未存的內容
- 「說明 → 自動備份…」可管理備份

---

## 給開發者(改 code / build / 發版)

### 第一次設定

需要先裝 [Node.js](https://nodejs.org/)(LTS 版即可,通常自帶 npm)。

```bash
git clone https://github.com/hsiaodog/3DStaadModelBuilder.git
cd 3DStaadModelBuilder
npm install          # 抓開發工具(Vite + TypeScript),約 40 MB,放在 node_modules/
```

### 日常開發

```bash
npm run dev          # 啟 Vite dev server → http://localhost:5173
                     # 改 .ts / .css 自動 hot reload
```

### 發版(build + 推到 GitHub)

```bash
npm run release      # = vite build
                     # 產生 dist/index.html
                     # 同時複製到 STAAD-Tracer.html(root)
git add STAAD-Tracer.html package.json   # 別忘了改 version
git commit -m "release: v0.1.1"
git push
```

### 其他指令

```bash
npm run typecheck    # tsc --noEmit,純檢查不出檔
npm run preview      # 啟 vite preview server 預覽 dist/
```

---

## 專案架構

```
3DStaadModelBuilder/
├── STAAD-Tracer.html      ← 給使用者雙擊的單檔 app(進 git)
├── app.html               ← Vite source entry(只給 build 用,不要直接開)
├── src/                   ← 開發 source code
│   ├── main.ts            ← entry,inline pdf.js
│   ├── app/               ← 整合層 / state / DOM / 主流程
│   ├── core/              ← 核心邏輯(rank / 投影 / 全局節點)
│   ├── render/            ← SVG 渲染
│   ├── tools/             ← 工具按鈕的功能(畫線 / 切面 / 量測 …)
│   ├── dialogs/           ← 對話框(3D 預覽 / 搜尋 / 樓層 …)
│   ├── ui/                ← UI 元件(menubar / fileList / 版本檢查 …)
│   ├── persistence/       ← 存檔 / 讀檔 / 自動備份
│   ├── export/            ← .std / .xlsx 匯出
│   ├── io/                ← 底圖載入 / DXF 解析
│   ├── utils/             ← 純 utility
│   ├── i18n/              ← 多語系
│   ├── style.css
│   └── vendor/            ← pdf.js + pdf.worker(被 main.ts 以 ?raw inline)
├── dist/                  ← Vite build 輸出(gitignored,暫存)
├── docs/                  ← 設計文件 / 重構計畫 / QA 報告
├── package.json
├── vite.config.ts
└── tsconfig.json
```

### 為什麼 `STAAD-Tracer.html` 進 git?

通常 build 產物不會進 git。我們刻意把它進 git 是為了:
- 使用者 `git clone` 完不需要裝 Node.js / npm 也能直接用
- 想用 git 管理版本的人,`git pull` = 自動更新

代價是每次 release 會在 `.git` 多一份 ~2.3 MB,可接受。

### 「拆檔架構」說明

`src/app/integration.ts` 是歷史整合層,還沒拆完。新功能請放在對應的 `src/tools/`、`src/dialogs/`、`src/ui/` 等資料夾,不要往 `integration.ts` 加。

詳細重構脈絡:[`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md)、[`docs/QA_REPORT.md`](docs/QA_REPORT.md)

---

## 常見問題

**Q: 雙擊 `app.html`(不是 `STAAD-Tracer.html`)會怎樣?**
A: 會看到空白頁,因為 `app.html` 只是 Vite 的 source entry,需要 dev server 才會載 `/src/main.ts`。請改開 `STAAD-Tracer.html`。

**Q: 我的專案檔(`.stproj.json`)會被自動備份覆寫嗎?**
A: 不會。自動備份只存進瀏覽器的 IndexedDB,**永遠不寫硬碟檔**。即使從備份「復原」也是開成新分頁,絕不蓋你原本的檔案。

**Q: 更新後我的專案會不會不見?**
A: 不會。專案資料存在你選的 `.stproj.json` 檔(由你決定路徑)+ 瀏覽器 IndexedDB(自動備份),跟 app HTML 完全分離。

**Q: 可以離線用嗎?**
A: 可以。`STAAD-Tracer.html` 是完整單檔(包括 pdf.js worker),載入後完全離線運作。版本檢查需要網路,但不影響功能。

**Q: 為什麼有時候卡卡的?**
A: 渲染主要在 SVG。節點 / 桿件超過幾千個時,zoom / pan 可能稍卡。可試試「節點 顯示」/「桿件標號 顯示」關掉減負擔。

---

## 授權

(待定)

## 回報問題 / 提建議

開 [GitHub Issues](https://github.com/hsiaodog/3DStaadModelBuilder/issues)
