# Migration Plan: 29K-line single HTML → Vite + TypeScript + Modules

**目標:** 把現有 `index.html` 拆成可維護的模組結構,但**輸出仍是單一 HTML 檔**,使用者體驗 0 變動。

**前提:**
- 不換 framework(不引入 React / Vue)
- 不換語言核心(JS → TypeScript 是漸進的,不是大改寫)
- 不引入 backend
- 不變更 save file 格式(`.staadtracer` JSON 保持相容)
- 不變更 UI 行為
- 不變更使用者部署方式(雙擊 HTML 即開)

**Total estimated time:** ~40–60 hours,可分成 6–10 週、每週 5–8 小時做。

---

## Decision Points (動工前先決定)

### 1. 你的 OS 跟工具狀態

- [ ] 安裝 Node.js ≥ 18(macOS:`brew install node`)
- [ ] 編輯器有 TypeScript 支援(VSCode 預設就有;Sublime / vim 也行)
- [ ] 有 `git`(此次遷移強烈建議用 git 追蹤)

### 2. Git 分支策略

開個 `migration` branch,主分支 `main` 仍能用原本 single-file 版本。每完成一個 phase 合回 `main` 或 cherry-pick。

```sh
git init          # 如果還沒
git checkout -b migration
```

### 3. 是否要邊遷移邊加新功能?

**強烈建議:不要。** 遷移期間 freeze 新功能。若有 bug 必須修,在 `main` 上修完合到 `migration`。

---

## Phase 0 — Foundation(1 天 / 約 4–6 小時)

**目標:** Vite + TypeScript 殼建起來,輸出是單檔 HTML,跑起來跟現在一模一樣。

**新增依賴:**
```
vite (build tool)
typescript
vite-plugin-singlefile (把 JS/CSS inline 進 index.html)
```

**Steps:**

- [ ] 0.1 `npm create vite@latest . -- --template vanilla-ts`(在現有目錄;會提示是否覆蓋,小心)
  - 或者新建 `tracer-vite/` 子目錄,把 build 結果 cp 回去
- [ ] 0.2 `npm install vite-plugin-singlefile`
- [ ] 0.3 `vite.config.ts`:
   ```ts
   import { defineConfig } from 'vite';
   import { viteSingleFile } from 'vite-plugin-singlefile';
   export default defineConfig({
     plugins: [viteSingleFile()],
     build: {
       outDir: 'dist',
       target: 'esnext',
       cssCodeSplit: false,
       assetsInlineLimit: 100_000_000,   // 100 MB:把所有 asset inline
     },
   });
   ```
- [ ] 0.4 `src/main.ts`:
   ```ts
   // Step 0: 暫時把原本 index.html 整段 <script> 內容貼進來,當一個大 string
   //   然後用 eval / inject 進 document — 只是過渡用,確認 build pipeline 跑得通
   ```
- [ ] 0.5 `index.html`(Vite 入口):
   ```html
   <!doctype html>
   <html>
     <head><meta charset="utf-8"><title>STAAD Tracer</title></head>
     <body>
       <script type="module" src="/src/main.ts"></script>
     </body>
   </html>
   ```
- [ ] 0.6 `npm run dev` → 確認瀏覽器能開 → 看到一片空白(預期,因為還沒搬內容)
- [ ] 0.7 `npm run build` → 看到 `dist/index.html` 是單一檔 → 雙擊能開
- [ ] 0.8 把原 `index.html` 改名 `index_legacy.html`(供對照)
- [ ] 0.9 **Baseline smoke test:** 跑 `QA_REPORT.md` Phase A-F 16 條測 `index_legacy.html` 的當前行為,**記下哪些通過、哪些失敗**(基準!)
- [ ] 0.10 `git commit -m "phase 0: vite shell"`

**驗證:** `dist/index.html` 是空白頁但能開,build pipeline OK。

---

## Phase 1 — 把整段 legacy 內容塞進 Vite(0.5 天 / ~2 小時)

**目標:** Vite 輸出的 `dist/index.html` 跟 `index_legacy.html` 功能一樣。**還沒拆模組**,只是搬到 Vite 殼。

**Steps:**

- [ ] 1.1 把 `index_legacy.html` 的 HTML body 內容(`<div id="toolbar">` 等等)複製到 `index.html` 的 `<body>` 裡
- [ ] 1.2 把 `<style>` 區塊複製到 `src/style.css`,`main.ts` 加 `import './style.css'`
- [ ] 1.3 把整個大 `<script>` 區塊的內容複製到 `src/legacy.ts`,在 `main.ts` 加 `import './legacy.ts'`
- [ ] 1.4 `legacy.ts` 開頭加:
   ```ts
   // @ts-nocheck — 整段 legacy code 暫時關掉型別檢查,後面 phase 再逐步補
   ```
- [ ] 1.5 把 `<script src="pdf.min.js" onerror="...">` 用 import 替代:
   ```ts
   import 'pdfjs-dist/build/pdf.min.js';
   // 或者保留 <script src=> 直接寫進 index.html
   ```
- [ ] 1.6 `npm run build` → `dist/index.html` 出來,在瀏覽器試開
- [ ] 1.7 **再跑一次 Phase A-F 16 條** → 確認跟 Baseline 結果一致
- [ ] 1.8 `git commit -m "phase 1: paste legacy into vite"`

**驗證:** `dist/index.html` 跟 `index_legacy.html` 對使用者來說一模一樣。

**這時你可以選擇:** 把 `dist/index.html` 給同事用,他們不會發現有改。**用戶體驗 0 變動**。

---

## Phase 2 — 拆「純函式 / 常數」模組(1 週 / 約 4–6 小時)

**目標:** 把無 side effect、無 DOM 依賴的小工具拆出去。

**這批最安全,從這裡開始建立信心。**

**新檔結構:**

```
src/
├─ utils/
│   ├─ math.ts          ← 距離計算、座標 round、wrapPosSort
│   ├─ format.ts        ← fmtCoord, fmtWorld3D, _gjmFmtCoord
│   ├─ units.ts         ← staadUnitKeyword, unitToMeter, meterToTarget
│   └─ id.ts            ← _xlsxCellRef、padStart helpers
├─ constants.ts          ← ALLOWED_YY, MAX_UNDO, defaults
├─ types.ts              ← FloorType, GlobalJoint, FileEntry, Page, ...(先 stub)
├─ style.css
├─ legacy.ts             ← (還沒搬完的部分)
└─ main.ts
```

**Steps(逐項做,每完成一項 commit + smoke test):**

- [ ] 2.1 從 legacy.ts 剪下:`function _rndForRank`, `_displayIdForJointWith` 內的 round 函式,`_axisCap` → 放 `utils/math.ts` + export
- [ ] 2.2 從 legacy 剪下:`fmtCoord`, `fmtWorld3D`, `staadUnitKeyword`, `unitToMeter`, `meterToTarget` → `utils/format.ts` / `utils/units.ts`
- [ ] 2.3 在 legacy.ts 開頭加 `import { _rndForRank, _axisCap } from './utils/math'` 等
- [ ] 2.4 暫時用 `(window as any).XXX = XXX` 把 import 進來的東西 expose 到 global,因為 legacy 還是依賴 global scope
- [ ] 2.5 build + smoke test
- [ ] 2.6 把 `MAX_UNDO = 100`、`ALLOWED_YY = [1,11,...,91]` 移到 `constants.ts`
- [ ] 2.7 在 `types.ts` 寫 stub:
   ```ts
   export interface FloorType {
     key: string; label: string; yyStart: number;
     kind: "floor" | "brace";
   }
   export interface GlobalJoint {
     id: number; label?: string;
     x?: number; y?: number; z?: number;
     locked?: boolean;
     warnings?: Array<{ message: string }>;
   }
   // ... 其他先暫時 stub
   ```
- [ ] 2.8 `git commit -m "phase 2: extract pure utils + constants + stub types"`

**驗證:** smoke test 全過。`legacy.ts` 從 29K 行變成 ~28K 行(只少幾百行),但每一行被搬出去的都更清楚了。

---

## Phase 3 — 拆「無 UI 副作用」的演算法模組(1–2 週 / ~10 小時)

**目標:** 把「給定輸入,回傳輸出」的演算法核心拆出去。仍依賴 `state` 但不動 DOM。

**重點模組:**

```
src/
├─ core/
│   ├─ rankCache.ts        ← _ensureRankCache, _rankCache, invalidateRankCache, _worldForRank
│   ├─ buildModel.ts       ← buildModel + collision tracking
│   ├─ inferGlobal.ts      ← inferGlobalJoint, inferAllGlobalJoints
│   ├─ autopair.ts         ← proposeAutoPairings
│   └─ joint2DToWorld3D.ts ← 2D→3D 投影
```

**Steps:**

- [ ] 3.1 拆 `joint2DToWorld3D` + `world3DToJoint2D` 到 `core/joint2DToWorld3D.ts`,export 兩個函式
- [ ] 3.2 拆 `_worldForRank` + `_ensureRankCache` + `invalidateRankCache` + `_rankCache` module state 到 `core/rankCache.ts`;`_rankCache` 變成 module-level let
- [ ] 3.3 拆 `buildModel` + `showBuildModelCollisionsIfAny` 到 `core/buildModel.ts`
- [ ] 3.4 拆 `inferGlobalJoint` + `inferAllGlobalJoints` + `listGlobalBindings` 到 `core/inferGlobal.ts`
- [ ] 3.5 拆 `proposeAutoPairings` 到 `core/autopair.ts`
- [ ] 3.6 拆 `calibrateAllFilesToGlobalOrigin` + `calibrateAllFilesToCustomOrigin` 到 `core/calibrate.ts`
- [ ] 3.7 build + smoke test 每步驟一次
- [ ] 3.8 `git commit -m "phase 3: extract core algorithms"`

**驗證:** smoke test 全過。`buildModel` 跟 `_ensureRankCache` 各自可單獨被 import 用。

**Bonus:** 這時可以寫第一份 unit test:
```ts
// src/core/__tests__/rankCache.test.ts
import { _rndForRank } from '../rankCache';
test('_rndForRank handles -0', () => { expect(_rndForRank(-0)).toBe(0); });
```

---

## Phase 4 — 拆 Export 模組(1 週 / ~6–8 小時)

**目標:** `.xlsx` 跟 `.std` 匯出抽成獨立模組。**順便把重複的 `_isBraceJoint`, `_planeForDiagMember` 等 helper 整合**。

```
src/
├─ export/
│   ├─ shared.ts        ← _isBraceJoint, _planeForDiagMember, _classifyMember3D, _bySubBlockCoord, _bracePlaneVotes 等共用
│   ├─ xlsx.ts          ← exportXlsxFile (760 行 → 拆成幾個函式: _writeJointsRegion / _writeMembersRegion / _writeProperties)
│   ├─ std.ts           ← exportStaad
│   └─ ooxml.ts         ← OOXML cell 生成、styles, sharedStrings, cellRef
```

**Steps:**

- [ ] 4.1 從 `exportXlsxFile` 跟 `$("exportStaad").onclick` 拉出共用 helper 到 `export/shared.ts`,**只定義一份**
- [ ] 4.2 把 `exportXlsxFile` 拆成 4 個函式各 ~200 行:
   - `buildJointRegion(model, opts) → { xml, rowCount }`
   - `buildMemberRegion(...)`
   - `buildPropertiesRegion(...)`
   - `assembleXlsx(parts)` → Blob
- [ ] 4.3 拆 `.std` 同樣
- [ ] 4.4 build + smoke test 驗匯出結果跟 Phase 1 一致(diff `.xlsx` 內容 / `.std` 文字)
- [ ] 4.5 `git commit -m "phase 4: extract export modules + dedup shared"`

**驗證:** 匯出的 `.xlsx` 跟 `.std` 跟舊版**對 binary diff 應該幾乎完全一樣**(只差 timestamp 之類)。

---

## Phase 5 — 拆 Dialog framework(1 週 / ~6–8 小時)

**目標:** 把 dialog 共用 framework(drag / mask / close / resize / × 按鈕)抽出。

```
src/
├─ ui/
│   ├─ dialog.ts          ← createDialog({ title, body, footer }) → 統一 framework
│   ├─ popup.ts           ← jump popup framework
│   └─ alert.ts           ← (可選)alert → HUD 弱提示的 wrapper
├─ dialogs/
│   ├─ floorTypes/
│   │   ├─ index.ts       ← openFloorTypesDialog
│   │   ├─ list.ts        ← page list 渲染
│   │   ├─ filter.ts      ← 篩選邏輯
│   │   └─ preview.ts     ← 預覽 canvas
│   ├─ globalJoints/
│   │   ├─ index.ts
│   │   ├─ list.ts
│   │   ├─ detail.ts
│   │   └─ search.ts
│   ├─ sectionLink.ts
│   ├─ split.ts
│   ├─ autopair.ts
│   └─ material.ts
```

**Steps:**

- [ ] 5.1 寫一個 `createDialog()` 通用工廠,把 #floorTypesDialog 跟 #globalJointMgrDialog 改用它(CSS class 沿用)
- [ ] 5.2 floorTypes dialog 拆成 5 個小檔(list / filter / preview / actions / index)
- [ ] 5.3 globalJoints dialog 同樣拆
- [ ] 5.4 jumpPopup 抽到 `ui/popup.ts`
- [ ] 5.5 build + smoke test
- [ ] 5.6 `git commit -m "phase 5: extract dialog framework + split dialog files"`

**驗證:** 兩個 dialog UI 行為 100% 不變,程式碼分散到 12 個小檔(每檔 < 300 行)。

---

## Phase 6 — 拆 Render(1–2 週 / ~10 小時)

**目標:** `_renderImpl` 1180 行拆成可組合的繪製函式。

```
src/
├─ render/
│   ├─ index.ts         ← render() wrapper + watchdog
│   ├─ impl.ts          ← _renderImpl 主控
│   ├─ labels.ts        ← jointLabel / memberLabel 預計算 + 繪製
│   ├─ joints.ts        ← joint circle + X + linked preview
│   ├─ members.ts       ← member line + arrow + selection 邊框
│   ├─ snap.ts          ← snap grid
│   ├─ overlap.ts       ← 標籤防重疊
│   └─ thumb.ts         ← renderFileThumb
```

**Steps:**

- [ ] 6.1 把 `renderFileThumb` 先拆(獨立性高)
- [ ] 6.2 拆 `drawSnapGrid` 跟相關 utils
- [ ] 6.3 拆 member 繪製
- [ ] 6.4 拆 joint 繪製(包含 linked preview 邏輯)
- [ ] 6.5 拆 label 預計算 + 繪製
- [ ] 6.6 把 `render` watchdog 跟 `_renderImpl` 主控留在 `render/index.ts`
- [ ] 6.7 build + smoke test
- [ ] 6.8 `git commit -m "phase 6: split render into sub-modules"`

**驗證:** render 結果跟舊版肉眼看不出差異。

---

## Phase 7 — 拆 State + Storage + Selection(1 週 / ~5–6 小時)

**目標:** 把 state shape 明確化(TypeScript interface),把 save/load 跟 selection 邏輯獨立。

```
src/
├─ state/
│   ├─ types.ts         ← 完整的 State interface(展開 phase 2 的 stub)
│   ├─ state.ts         ← 全域 state 物件(用 module pattern,不再裸 global)
│   ├─ selection.ts     ← state.selection 的 helper(_markSelectionSourceIfEmpty, _assertSelectionOnActivePage)
│   ├─ undo.ts          ← pushUndo, snapshot, undo/redo
│   └─ persist.ts       ← save / load (.staadtracer)
```

**Steps:**

- [ ] 7.1 把所有 state.* 的 type 完整寫到 `state/types.ts`
- [ ] 7.2 從 legacy 拆 `pushUndo`, `snapshot`, undo / redo handlers 到 `state/undo.ts`
- [ ] 7.3 拆 save / load 到 `state/persist.ts`
- [ ] 7.4 拆 selection helpers 到 `state/selection.ts`
- [ ] 7.5 build + smoke test
- [ ] 7.6 `git commit -m "phase 7: extract state / undo / selection / persist"`

**驗證:** state 的型別出來,IDE 開始能 autocomplete / catch typo。

---

## Phase 8 — 拆 Tools + Toolbar + Menubar + Sidebars(1 週 / ~5–6 小時)

**目標:** UI 互動層拆乾淨。

```
src/
├─ ui/
│   ├─ toolbar.ts          ← 上方工具列(線 / 點 / 選取 / 比例尺 / 原點 / 校準 / 翻轉)
│   ├─ menubar.ts          ← 上方選單列 + dropdown(檔案 / 編輯 / 工具 / ...)
│   ├─ sidebarLeft.ts
│   ├─ sidebarRight.ts
│   ├─ statusBar.ts        ← HUD
│   └─ zoomTools.ts
├─ tools/
│   ├─ line.ts             ← 線工具
│   ├─ point.ts            ← 節點工具
│   ├─ select.ts           ← 選取工具(框選 / 點選)
│   ├─ bgSelect.ts         ← 底圖選取
│   └─ moveMode.ts
```

**Steps:** 略(類似前面 phase)

---

## Phase 9 — 收尾(1 週)

- [ ] 9.1 `legacy.ts` 應該已經很薄,把剩下的塞進對應 module
- [ ] 9.2 移除所有 `(window as any).XXX = XXX` 的 global expose hack
- [ ] 9.3 開 TypeScript strict mode:`tsconfig.json` `"strict": true`,逐一修錯
- [ ] 9.4 加 ESLint + Prettier
- [ ] 9.5 寫第一輪 unit test(rank cache 邏輯 / displayId composition / undo snapshot 等純函式)
- [ ] 9.6 更新 `QA_REPORT.md` 反映新結構
- [ ] 9.7 `git commit -m "phase 9: cleanup, strict types, lint"`
- [ ] 9.8 `git checkout main && git merge migration` → 正式 cutover

---

## Risk Management

每個 phase 都有 rollback 機制:
- `git revert <phase commit>` → 回到該 phase 前
- `index_legacy.html` 在整個遷移期間都還在,emergency fallback

每個 phase 後做的 smoke test(Phase A-F 16 條):
- 全過 → 進下一個 phase
- 任一失敗 → 不進下一個,在當前 phase 內修

如果你做到某一個 phase 不想繼續:
- **任何 phase 結束時都可以暫停**,不影響使用者體驗
- `dist/index.html` 一直是可用的單檔
- 想做的功能可在現有 phase 結構上加,不必等到全部 phase 完成

---

## 時程總覽

| Phase | 範圍 | 時間 | 累積 |
|---|---|---|---|
| 0 | Vite shell | 4–6 hr | 1 day |
| 1 | Legacy paste-in | 2 hr | 1.5 day |
| 2 | Pure utils | 4–6 hr | 1 wk |
| 3 | Core algorithms | 10 hr | 2 wk |
| 4 | Export | 6–8 hr | 3 wk |
| 5 | Dialogs | 6–8 hr | 4 wk |
| 6 | Render | 10 hr | 5 wk |
| 7 | State / undo / persist | 5–6 hr | 6 wk |
| 8 | UI / tools | 5–6 hr | 7 wk |
| 9 | Cleanup | 5 hr | 8 wk |

**Total:** ~55 hr,8 週,每週 ~7 hr。

---

## 我能幫什麼

每個 phase 可以這樣分工:

- **你做的事**:
  - Phase 0 的 npm 安裝 + Vite shell init(本機操作我做不了)
  - 每個 phase 後跑 smoke test(實際開 dist/index.html 操作)
  - 決定要不要繼續下一個 phase

- **我做的事**(我幫你寫 code):
  - 任何「把這段 code 從 legacy 搬到那個 module」的機械工作
  - 寫 TypeScript types
  - 找出重複 helper 並 dedup
  - 寫 unit test
  - 每個 phase 內遇到 build / 型別錯就幫你修

**你準備好 Phase 0 之後告訴我**,我就接手做 Phase 1 給你看,你跑一次 smoke test 確認 OK 再繼續。

---

## 開始前的 Checklist

- [ ] Node.js ≥ 18 安裝好
- [ ] git 初始化 + 第一次 commit 現有 index.html(safety net)
- [ ] 跑一次 QA_REPORT.md Phase A-F 16 條,記下「現在這版的行為」當基準
- [ ] 確認接下來 1–2 個月有 ~30 hr 可以投入(不一定連續)
- [ ] 接受「遷移期間 freeze 新功能」這個原則
- [ ] 決定是否動工 → 動工的話告訴我「開始 Phase 0」

如果現在沒空動,**這份計畫放在 `MIGRATION_PLAN.md`,半年後想做時直接從 Phase 0 開始,不會過期。**
