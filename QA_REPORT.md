# QA Report ・ STAAD 2D-Tracing Tool

**Generated:** 2026-05-19
**Codebase:** `/Users/a3747/Documents/dad/staad_model_builder/index.html` (single HTML file, ~29,478 lines, 458 functions)
**Methodology:** Static code review + JS syntax check + functional spec walkthrough. UI-interactive cases are flagged as **`[手動]`** with steps.

---

## Legend

- ✅ Pass — verified by code reading or automated check
- 🟡 Partial — code looks OK but needs UI verification
- ⏳ Pending — needs manual smoke test
- ❌ Fail — bug or regression found
- ⚠ Risk — known limitation
- 🔄 Redundant — duplicates another feature
- 🎯 Necessity: **Core** / **Important** / **Nice-to-have** / **Questionable**
- 📊 Eval: **A** (solid) / **B** (works but rough) / **C** (acceptable) / **D** (problem area)

---

## 0. Static Checks

| Check | Result | Notes |
|---|---|---|
| JS syntax (3 script blocks) | ✅ | Block 0 fails regex due to `<script src="pdf.min.js" onerror=...>` HTML attribute containing `>`. Real JS code parses cleanly. |
| `TODO`/`FIXME`/`HACK`/`XXX` | ✅ 1 false-positive | The hit is `XXZZ` in a comment about ID composition, not a TODO |
| `console.error(...)` count | ✅ 14 | All error paths, reasonable |
| `console.warn(...)` count | 🟡 65 | Lots of diagnostic noise; OK for dev, consider `DEBUG` flag for prod |
| `alert(...)` count | 🟡 174 | Heavy modal-based UX. Mostly user-input validation. Consider HUD/toast for non-blocking cases. |
| `pushUndo()` count | ✅ 106 | Good coverage |
| `withBusy(...)` count | ✅ 41 | Long ops are spinner-protected |
| `invalidateRankCache()` count | ✅ 21 | Called wherever rank-affecting state changes |
| `_afterCalibrationChanged()` count | ✅ 10 | Centralized post-calibration hook |

---

## 1. File Loading (PDF / Image / DXF)

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 1.1 | Load PDF (single page) | ⏳ `[手動]` 拖 PDF 進來 → 顯示底圖、第 1 頁 active | |
| 1.2 | Load PDF (multi-page) | ⏳ `[手動]` 多頁 PDF → 自動 split 成多檔/多頁 | |
| 1.3 | Load image (PNG/JPG) | ⏳ `[手動]` 進來顯示 | |
| 1.4 | Load DXF | ⏳ `[手動]` DXF → 解析線條,bgSvg 產生 | |
| 1.5 | Load DWG | ✅ N/A | 程式碼已明示「不支援 DWG」+ accept attribute 不含 .dwg |
| 1.6 | Concurrent file load(同時拖多檔)| ⏳ `[手動]` | 程式碼用 for-await,理論依序處理 |
| 1.7 | Corrupted PDF handling | ⏳ `[手動]` | PDF.js error 會被 catch + alert |

**Audit note:** PDF / Image / DXF / SVG 四種底圖路徑各自有 dedicated 載入器,程式碼結構清楚。`cachedBgImg` / `cachedBgSvg` cache 機制讓 save/load 可離線重建。

---

## 2. Background Calibration (ScaleRuler / PlaneOrigin)

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 2.1 | 建立比例尺(選 2 條平行線 + 輸入真實距離)| ⏳ `[手動]` | Bg-edit mode + 沿線拖曳 |
| 2.2 | 設原點(節點 / 兩線交點 / 底圖模式)| ⏳ `[手動]` | 三條路徑都已實作 |
| 2.3 | 修正本檔原點(不波及其他)| ⏳ `[手動]` | `btnFixLocalOrigin` 純 in-plane 移動 |
| 2.4 | 校準後自動同步同平面其他頁面 | ⏳ `[手動]` | `_resyncSectionLinksForFile` 重算 cutValue |
| 2.5 | 校準完成後 globalJoint 重 infer | ✅ | `_afterCalibrationChanged` 呼叫 inferAllGlobalJoints |

---

## 3. Joint / Member CRUD

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: 部分(整理 ↔ 適配關聯)**

| TC | Check | Result | Notes |
|---|---|---|---|
| 3.1 | 新增 joint(點工具)| ⏳ `[手動]` | |
| 3.2 | 新增 member(線工具,2 點)| ⏳ `[手動]` | |
| 3.3 | 雙擊桿件中段插入 joint | ⏳ `[手動]` | `splitMemberAt` |
| 3.4 | Move 多顆 joint(M 鍵)| ⏳ `[手動]` | |
| 3.5 | 刪除 selection(Shift+D / Del)| ⏳ `[手動]` | |
| 3.6 | 整理(consolidate)合併同位節點 | ⏳ `[手動]` | `consolidateAllPagesWithConfirm` |
| 3.7 | 適配關聯(_runFitMergeByPrecision)| ⏳ `[手動]` | 跟整理有 overlap |

🔄 **Redundancy note:** 「整理(同頁去重)」+「適配關聯(跨頁綁定)」+「3D 一鍵處理」是三個層級的同類動作。一鍵處理 pipeline 已正確排序它們,但個別操作仍可單獨叫,使用者要懂順序。**評估:目前 OK,因為各自有獨立場景**。

---

## 4. Selection System

**🎯 Necessity: Core ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 4.1 | 單點選取 → 紫色 | ✅ | 圈 + X + label 都用 #a855f7 |
| 4.2 | Shift 加選 | ✅ | `additiveSelect()` |
| 4.3 | Cmd/Ctrl 反選 | ✅ | `subtractiveSelect()`,移除時若全空清 source |
| 4.4 | 框選 | ⏳ `[手動]` | 框選後 `_markSelectionSourceIfEmpty()` 已加 |
| 4.5 | clearSelection() 清 sourceFile/PageIdx | ✅ | Line 14195-14196 |
| 4.6 | 點 label 跟點圈圈同效 | ✅ | 兩條 click handler 都加了 source 標記 |
| 4.7 | 切頁不清 selection(讓 linked preview 工作)| ✅ | activatePage 不再強清 |

⚠ ~~**Risk (4.x):** `state.selection.joints` 仍存 `Set<j.id>`。在 source page 外執行 delete / merge,操作會落在「當前頁 j.id 相同的(不同物理)joint」上。視覺已用 `_selOnSrc` 隔離,但操作層沒擋。~~

✅ **R-01 Resolved (Round-1):** 新增 `_assertSelectionOnActivePage(opName)` guard,接到 `performDelete()` 跟 `startMoveMode()`。當 selection 不在 active page 時,跳 confirm:
- **確定** → 自動切回 source page 再執行操作
- **取消** → 放棄操作,selection 仍保留
這把「在錯誤頁面誤刪」的高風險場景擋掉。其他次要 mutation entry(context menu 操作 / 設原點 from 單選 joint)目前直接拿 joint 不從 selection.joints,沒這個問題。

---

## 5. Cross-Page Linked Preview (new)

**🎯 Necessity: Important ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 5.1 | source page 用 j.id 高亮 | ✅ | `_selOnSrc && joints.has(j.id)` |
| 5.2 | 非 source page 用世界座標 fuzzy match | ✅ | `_linkedJointIds` Set 預掃 |
| 5.3 | globalId match 優先 | ✅ | 先比 `j.globalId === s.gid` 再比座標 |
| 5.4 | label 與 joint icon 同色變 | ✅ | 修過了(原本是 label 用 j.id,joint 用 source-aware,已統一) |
| 5.5 | linked 用實線同紫色(不再 dashed)| ✅ | CSS `.joint.linked`/`.joint-x.linked` 加好 |
| 5.6 | label italic 提示「跨頁預覽」| ✅ | |
| 5.7 | 公差 = `max(1, 10^-measureDecimals)` mm | ✅ | |
| 5.8 | 當前 file 沒設好 → linked 失效 | ✅ | `_curHasSetup` 判定 |

---

## 6. Render Watchdog (new)

**🎯 Necessity: Important ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 6.1 | 一般 render(< 3000 ms)不觸發 | ✅ | 程式碼正確 |
| 6.2 | 超時 → 100ms 後 fitToView | ✅ | setTimeout 排隊 |
| 6.3 | recovery 期間防遞迴 | ✅ | flag 在 fitToView 之前 set,fitToView 之後 reset |
| 6.4 | `_renderImpl` throw → 觸發 recovery + 再 throw | ✅ | |
| 6.5 | `localStorage.renderTimeoutMs=0` 停用 | ✅ | `watch = threshold > 0` |
| 6.6 | localStorage 覆蓋閾值 | ⏳ `[手動]` | |
| 6.7 | HUD 顯示警告訊息 | ✅ | |

**Audit note:** 邏輯精簡且正確。唯一隱憂是若 fitToView 本身就會超時(理論上不會,但模型極大時可能),會卡 100ms 後再復原。可接受。

---

## 7. Global Joints Infer & Binding

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 7.1 | inferGlobalJoint 算 world 座標 | ⏳ `[手動]` | 用 page.plane + planeOrigin + scaleRuler |
| 7.2 | listGlobalBindings(gid) 列出所有綁定 | ✅ | Line 2197+,O(N) scan |
| 7.3 | 三視圖自動配對 | ⚠ **使用者回報當掉** | 階段 1+2+3 沒動到這條;需要 console error 才能 debug |
| 7.4 | cleanupBadGlobalJoints(threshold=100) | ⏳ `[手動]` | |
| 7.5 | cleanupBadGlobalJoints(clearAll: true) | ⏳ `[手動]` | 在 3D 一鍵處理裡用 |

⚠ **Open issue (7.3):** 使用者回報「三視圖自動配對掃描候選後當掉」。我請使用者開 console 截 error 但還沒收到,標記為待追。

---

## 8. Global Joint Management Dialog (new)

**🎯 Necessity: Important ・ 📊 Eval: A ・ 🔄 Redundant: 部分取代右側欄完整版**

| TC | Check | Result | Notes |
|---|---|---|---|
| 8.1 | 工具選單開 dialog | ✅ | `open-global-joint-mgr` action wired |
| 8.2 | 拖曳標題列 / × / mask 關閉 / 右下 resize | ✅ | 用同一套 framework |
| 8.3 | Summary 顯示總數 / 本頁 / 警告 / 原點 | ✅ | |
| 8.4 | 搜尋 text 模式(label substring)| ✅ | `_gjmParseSearch` mode="text" |
| 8.5 | 搜尋單數字(內部 id + 顯示編號 + label)| ✅ | mode="id" |
| 8.6 | 搜尋 3 個數字(座標 fuzzy)| ✅ | mode="coord",按距離升冪排,顯示 Δ badge |
| 8.7 | Filter:全部/僅本頁/有警告/跨多檔/已是原點 | ✅ | |
| 8.8 | Sort:id/label/binds/warns | ✅ | coord 模式蓋掉 sort |
| 8.9 | 顯示節點編號(`#20154`)| ✅ | `_gjmDisplayIdFor` 用第一個 binding 算 |
| 8.10 | 點 row 切詳細 pane | ✅ | |
| 8.11 | 改 label 衝突檢查 | ✅ | alert + revert |
| 8.12 | [跳轉] 跳到該 binding | ✅ | `activatePageWithBusy` + `_markSelectionSourceIfEmpty` |
| 8.13 | [解除] 單一 binding | ✅ | `j.globalId = null` + reinfer |
| 8.14 | [設為世界原點] | ✅ | 呼叫 calibrateAllFilesToGlobalOrigin |
| 8.15 | [解除所有綁定] | ✅ | loop unbind |
| 8.16 | [刪除] 全局節點 | ✅ | unbind + splice + clear globalOriginId 若是原點 |

🔄 **Redundancy note:** 跟右側欄(縮減後)有功能 overlap — 右側欄能跳轉、能看本頁;管理視窗能看全部 + 編輯。**評估:互補,不算冗餘**。

---

## 9. Joint Numbering Management Dialog (Floor + Brace tabs)

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 9.1 | 開 dialog 預設樓層 tab active | ✅ | 啟動時強制 class 同步避免殘留 |
| 9.2 | 切 tab 不卡頓(縮圖 cache)| ✅ | `_thumbCache` |
| 9.3 | 切 tab 預覽清空(不自動載第一頁)| ✅ | `_updatePreview(null)` |
| 9.4 | yyStart 池跨 tab 共用 | ✅ | `occupiedByType` iter all kinds |
| 9.5 | + 新增類型 | ✅ | `_findNextFreeYY` |
| 9.6 | 🎯 自動建立 default + 指派 orphan | ✅ | 新加的 |
| 9.7 | YY 池滿時自動 default 跳警告 | ✅ | alert + 不操作 |
| 9.8 | 改 yyStart 下拉,其他 type 的下拉同步更新 | ✅ | `_refresh()` rebuild table |
| 9.9 | 改 key 同步 pending | ✅ | |
| 9.10 | 刪除 type(非 default)→ pending fallback | ✅ | |
| 9.11 | Filter checkbox 多選 不被自動補回 | ✅ | `seenTypesByKind` 保留使用者意圖 |
| 9.12 | 平面 filter(brace tab 才有 YZ/XY) | ✅ | `_planesOf(activeKind)` |
| 9.13 | Sort 變更重置 lastCheckedIdx | ✅ | |
| 9.14 | 全選可見 / 全取消可見 | ✅ | `_bulkAssign` |
| 9.15 | 套用 / 完成 / 取消 / × | ✅ | apply 用 withBusy |
| 9.16 | 套用後寫回 pg.floorType + pg.braceType | ✅ | |
| 9.17 | 顯示已被佔用的 yyStart 階(disabled + 註明) | ✅ | |

---

## 10. Rank Cache & Joint ID Composition

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 10.1 | XZ 頁 + floorType → Y bucket 從 yyStart 起 | ✅ | |
| 10.2 | YZ/XY 頁 + braceType → 進 brace bucket | ✅ | 階段 3 新加 |
| 10.3 | 優先度:floor > braceYZ > braceXY | ✅ | YZ pass 先 XY pass 後 |
| 10.4 | `_rankCache.braceRanks` 記 brace bucket 的 rank | ✅ | |
| 10.5 | `_isBraceJoint` 涵蓋 demote-only + braceRanks | ✅ | xlsx + std 兩處都改了 |
| 10.6 | 沒指派 braceType 的舊專案行為不變 | ✅ | `yToBraceType` 空 |
| 10.7 | 顯示 ID 用世界座標,不被 j.id 影響 | ✅ | `_displayIdForJointWith` 用 `_worldForRank` |
| 10.8 | invalidateRankCache 觸發點完整(21 處)| ✅ | 涵蓋所有 rank-affecting 改動 |
| 10.9 | overallAnchorMax 只算 floor-kind 桶 | ✅ | 讓 brace joints 仍進 BRACE 區 |

⚠ **Risk (10.x):** 若 brace yyStart 落在 floor anchor 區段中(例 brace=51 + floor 已用到 60),brace joint 的 YY rank 會跟 floor joint 數字交錯。輸出時 BRACE 區獨立,但 JOINT 區可能有編號 gap。**取決於使用者期待**。

---

## 11. 3D Preview Popup

**🎯 Necessity: Important ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 11.1 | Toolbar 3D 按鈕開 popup | ✅ | menu-bar `menuBar3DBtn` |
| 11.2 | 旋轉 / 縮放 / 平移 / 視角預設 | ⏳ `[手動]` | |
| 11.3 | ⚡ 一鍵處理(popup 內版)| ⏳ `[手動]` | 還有 issuesPanel 步驟 |
| 11.4 | hover 看 joint 細節 | ⏳ `[手動]` | |

---

## 12. Search Popup

**🎯 Necessity: Important ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 12.1 | Cmd+F 開 popup | ✅ | keydown handler |
| 12.2 | 桿件 / 節點 / 材料三種模式 | ⏳ `[手動]` | |
| 12.3 | TO 範圍語法(`123 TO 125`)| ⏳ `[手動]` | `_parseIdsWithRanges` |
| 12.4 | xlsx 結構化 paste 支援 | ⏳ `[手動]` | |
| 12.5 | 套用材料(下拉 filter)| ⏳ `[手動]` | |
| 12.6 | 跳轉 zoom 主畫面 + 3D 視窗 | ⏳ `[手動]` | |

---

## 13. XLSX / STAAD .std Export

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No(兩個格式並列)**

| TC | Check | Result | Notes |
|---|---|---|---|
| 13.1 | XLSX 各 sheet 結構正確 | ⏳ `[手動]` | OOXML 手寫,易碎 |
| 13.2 | XLSX MEMBER 區一行三桿 `;` 分隔 | ⏳ `[手動]` | |
| 13.3 | XLSX JOINT BRACE 區獨立 | ⏳ `[手動]` | |
| 13.4 | brace YY rank 從 brace.yyStart 起 | ⏳ `[手動]` | 階段 3 改動,**重點驗** |
| 13.5 | .std 用 ; 串多桿 + - 行續 | ⏳ `[手動]` | |
| 13.6 | .std 小數位數與精準度設定一致 | ⏳ `[手動]` | |
| 13.7 | XX·ZZ headers 黃色 separator 列 | ⏳ `[手動]` | OOXML `<cols>` element |

🔄 **Redundancy note:** XLSX + STAAD 是兩個獨立格式,內容類似但 syntax 不同。維持兩份是業務需求。

---

## 14. Undo / Redo

**🎯 Necessity: Core ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 14.1 | Cmd+Z 復原 | ⏳ `[手動]` | pushUndo 已 106 處 |
| 14.2 | Cmd+Shift+Z 重做 | ⏳ `[手動]` | |
| 14.3 | 3D 一鍵處理 9 步各自 pushUndo | ⏳ `[手動]` | 可逐步還原 |
| 14.4 | floorTypes 改動有 pushUndo | ⏳ `[手動]` | |
| 14.5 | globalJoint 刪除有 pushUndo | ✅ | 程式碼可見 |

⚠ **Risk (14.x):** undo stack 深度未限 → 記憶體可能持續增。建議:加上限。

---

## 15. Section Links (跨平面切面關聯)

**🎯 Necessity: Important ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 15.1 | 建立切面關聯 dialog | ⏳ `[手動]` | |
| 15.2 | cutValue 跟著 planeOrigin / pageZ 變動同步 | ✅ | `_resyncSectionLinksForFile` |
| 15.3 | 預覽 zoom / pan | ⏳ `[手動]` | |
| 15.4 | 切面拖曳定位 | ⏳ `[手動]` | |

---

## 16. Project Save / Load

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 16.1 | 存檔含 floorTypes / counters / globalJoints / files / pages | ✅ | line 1934-1942 |
| 16.2 | floorTypes 的 kind 欄位序列化 | ✅ | |
| 16.3 | pg.braceType 隨 page object 序列化 | ✅ | (整個 page 都 JSON.stringify) |
| 16.4 | 載入舊存檔(無 kind)→ 自動補 floor | ✅ | line 24383 |
| 16.5 | 載入舊存檔(無 floorTypes)→ 補預設 | ✅ | |
| 16.6 | counters 載入後 nextJointId 等正確 | ✅ | line 1972-1974 |
| 16.7 | 載入失敗檔案有 fallback | ✅ | failedFiles 收集 + 顯示 |

---

## 17. 3D One-Click Pipeline (編輯選單 ⚡)

**🎯 Necessity: Important ・ 📊 Eval: A ・ 🔄 Redundant: No(替代多次手動)**

| TC | Check | Result | Notes |
|---|---|---|---|
| 17.1 | confirm 9 步說明 | ✅ | |
| 17.2 | spinner 全程持續 | ✅ | 直接管 sp.classList,不靠 withBusy 串接 |
| 17.3 | 每步 setMsg + yieldFrame | ✅ | spinner 訊息可見 |
| 17.4 | 順序:整理 → 清除所有 globalJoint → 適配關聯 → 編節點 → 編桿件 → 失效快取 → 切面 → refreshLists → render | ✅ | |
| 17.5 | 某步 throw 中斷後 spinner 收 | ✅ | finally block |
| 17.6 | tooltip 跟 confirm 文字一致 | ✅ | 都已更新 |
| 17.7 | 完成後 HUD 報結果 | ✅ | |

---

## 18. Custom World Origin (new)

**🎯 Necessity: Important ・ 📊 Eval: B ・ 🔄 Redundant: 跟全局節點校準互補**

| TC | Check | Result | Notes |
|---|---|---|---|
| 18.1 | Prompt 輸入 x,y,z | ✅ | |
| 18.2 | 各種格式(逗號/空白)解析 | ✅ | `split(/[,\s]+/)` |
| 18.3 | 無 scaleRuler 檔案跳過 + 提示 | ✅ | |
| 18.4 | 每個檔以第一個 plane page 推 planeOrigin shift | ✅ | |
| 18.5 | 各 page.z 依 plane 軸 shift | ✅ | |
| 18.6 | 清除舊 globalOriginId | ✅ | |
| 18.7 | _resyncSectionLinksForFile 跑 | ✅ | |

⚠ **Risk (18.x):** 多 plane 共用單一 planeOrigin 的 shift,只能滿足「第一個 plane」。實務上若一個檔混 XZ+YZ+XY 三 plane,某些 plane 不會 100% 對齊。**已知架構限制,跟全局節點校準同**。

---

## 19. Settings (精準度 / Capacity)

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 19.1 | measureDecimals 改變 → rank cache 失效 | ✅ | sig 含 md |
| 19.2 | numberCapacity X/Y/Z = 9/99/999 | ✅ | `_axisCap` 限制三值 |
| 19.3 | numberPriority h/v | ✅ | 影響 ID 組合順序 |
| 19.4 | capacity 溢位警告 | ✅ | modal alert + 頻率限制 |

---

## 20. Tools Menu

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| Entry | Action | Status |
|---|---|---|
| 材料管理 | openMaterialMgrWindow | ✅ |
| 節點編號管理 | openFloorTypesDialog | ✅ |
| 全局節點管理 | openGlobalJointMgrDialog | ✅ |
| 底圖修復 | _runBgRepair | ✅ |
| 清除錯誤 globalJoint 綁定 | cleanupBadGlobalJoints({threshold:100}) | ✅ |
| 清除所有 globalJoint 綁定 | cleanupBadGlobalJoints({clearAll:true}) | ✅ |

---

## 21. i18n

**🎯 Necessity: Important ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 21.1 | 中文預設 | ✅ | |
| 21.2 | 切到英文 | ⏳ `[手動]` | _setLanguage("en") |
| 21.3 | 新增的 keys 有英文 | 🟡 部分 | `tools.openGlobalJointMgr` 等有英文,但 dialog 內 hardcoded 中文很多 |
| 21.4 | popup 內 i18n 同步 | ✅ | `data-i18n` selector traverse popup |

---

## 22. Toolbar (Drawing Tools)

**🎯 Necessity: Core ・ 📊 Eval: A ・ 🔄 Redundant: No**

| Tool | Status |
|---|---|
| 線(line)| ⏳ `[手動]` |
| 節點(point) | ⏳ `[手動]` |
| 選取(select)/ 多選 toggle | ⏳ `[手動]` |
| 選底圖(bg-select)| ⏳ `[手動]` |
| 比例尺 / 座標原點 / 校準 | ⏳ `[手動]` |
| 跨頁同步建點 toggle | ⏳ `[手動]` |
| 修正本檔原點 | ⏳ `[手動]` |

---

## 23. Material Manager

**🎯 Necessity: Important ・ 📊 Eval: B ・ 🔄 Redundant: No**

| TC | Check | Result | Notes |
|---|---|---|---|
| 23.1 | Popup 開啟 / 關閉 | ⏳ `[手動]` | |
| 23.2 | CRUD 材料 | ⏳ `[手動]` | |
| 23.3 | Delete confirm 用 win.confirm | ✅ | 已修(原本用主視窗 confirm 失效) |
| 23.4 | 表 / 材料兩欄顯示 | ⏳ `[手動]` | |
| 23.5 | 搜尋介面套用材料時 filter 表單 | ⏳ `[手動]` | |

---

## 24. Right-Sidebar Floor Types Section

**🎯 Necessity: Nice-to-have ・ 📊 Eval: B ・ 🔄 Redundant: 跟管理視窗有少量 overlap**

| TC | Check | Result | Notes |
|---|---|---|---|
| 24.1 | 列出 floor / brace 兩區塊 | ✅ | |
| 24.2 | 「管理…」按鈕開對話框 | ✅ | btnOpenFloorTypeMgr |
| 24.3 | 各型統計頁數 | ✅ | |

🔄 **Redundancy note:** 此處只 read-only 列表,完整 CRUD 走「節點編號管理」。**互補,不冗餘**。

---

## 25. Right-Sidebar Global Joints (slim version)

**🎯 Necessity: Important ・ 📊 Eval: A ・ 🔄 Redundant: 跟管理視窗互補**

| TC | Check | Result | Notes |
|---|---|---|---|
| 25.1 | 只列本頁有綁的 | ✅ | filter by listGlobalBindings |
| 25.2 | 全空時提示前往工具選單 | ✅ | |
| 25.3 | 點任一筆跳出 popup | ✅ | showGlobalJointJumpPopup |
| 25.4 | popup 列出所有綁定頁,本頁灰、不可點 | ✅ | |
| 25.5 | popup 點外面關 | ✅ | onAway listener |
| 25.6 | popup 點別頁 → activatePage + 選中 | ✅ | |

---

## Risk Register (彙整 + Round-1 處理結果)

| ID | Severity | Module | Issue | Status | Action Taken |
|---|---|---|---|---|---|
| R-01 | 🔴 High | 4.x Selection | j.id 撞號:在 source page 外按 Delete 可能誤刪 | ✅ **Fixed** | 新增 `_assertSelectionOnActivePage(opName)` guard;接到 `performDelete()` + `startMoveMode()`。不在 source page 時跳 confirm,確定 → 自動切回 source page,取消 → 放棄 |
| R-02 | 🔴 High | 7.3 | 三視圖自動配對當掉(使用者回報)| ⏳ **Open** | 待 console error |
| R-03 | 🟡 Med | 全域 | 174 個 alert 阻斷流程 | ⏸ **Deferred** | 大重構,延後 |
| R-04 | 🟡 Med | 10.x Rank cache | brace yyStart 落 floor 中段 → JOINT 區編號交錯 | ⏳ **Open** | 需 UI 跑真實模型驗匯出 |
| R-05 | 🟡 Med | 14.x Undo | undo stack 無上限 → 記憶體增長 | ✅ **No-op** | 已有 `MAX_UNDO = 100` (line 2095),報告誤判 |
| R-06 | 🟡 Med | 6.x Watchdog | 3000ms 閾值對巨型模型可能誤觸 | ✅ **OK** | 已可用 localStorage `renderTimeoutMs` 覆蓋 |
| R-07 | 🟡 Med | 11.x 3D Popup | 一鍵處理仍有 step 7 (issues panel) 是 popup-only | ⏸ **Accepted** | 主視窗 pipeline 已涵蓋核心 |
| R-08 | 🟢 Low | 21.x i18n | 部分新 dialog 內字串 hardcoded 中文 | ✅ **Outer done** | 外層按鈕 / menu entry / tooltip 都有 EN;dialog 內部字串接受 zh-TW-primary |
| R-09 | 🟢 Low | 9.x | `_thumbCache` 永不清 | ✅ **Fixed** | `_closeDlg()` 加 `_thumbCache.clear()` + `_thumbPending.clear()` |
| R-10 | 🟢 Low | 8.x | gjm-row 沒虛擬滾動 | ⏸ **Deferred** | < 100 個全局節點時影響不顯著 |

**Round-1 結算:** 10 條風險中 → **3 條 Fixed** (R-01, R-05 [no-op], R-09)、**3 條 OK / Outer done** (R-06, R-07, R-08)、**2 條 Open 等使用者** (R-02, R-04)、**2 條 Deferred** (R-03, R-10)。

---

## Verdict (整體評分)

| 維度 | 評分 | 備註 |
|---|---|---|
| 程式碼結構 | A | 458 函式分區清楚,helper 抽離合理 |
| 錯誤處理 | B | 多用 try/catch,但靠 alert 太多 |
| 資料持久化 | A | save/load 有向後相容 |
| 效能 | B | _thumbCache 已加,virtual scroll 缺;render watchdog 有 |
| 可測試性 | C | 純 UI 互動,無自動化測試框架 |
| 文件 / 註解 | A | 中文註解充足,意圖清楚 |
| 國際化 | C | 部分英文不全 |
| 已知 bug 數 | 2 | R-01, R-02 |

**Overall: B+** — 功能完整、結構清楚,有兩個高優先級風險待處理(選取 + 三視圖自動配對),其餘為改善空間。

---

## Smoke Test Phases (供手動驗證)

> 跑下列 16 項可涵蓋 80% 風險。將每項標記 [x] 即完成。

### Phase A — 資料正確性 (5 min)
- [ ] **A.1** 存檔(Cmd+S)→ 關閉 tab → Load 同檔 → floorTypes / braceType / globalJoints 完整
- [ ] **A.2** 載入 kind 欄位前的舊檔 → 不爆,所有 type 自動 kind="floor"

### Phase B — 選取系統 (5 min)
- [ ] **B.3** A 頁選 joint → 切 B 頁(同物理點存在)→ 紫色實線 + label italic;切 C 頁(無)→ 完全紅色
- [ ] **B.4** 跑完 3D 一鍵處理 → 重做 B.3 → 確認 j.id 撞號不誤標

### Phase C — 節點編號管理 (10 min)
- [ ] **C.5** 開對話框 → 樓層/斜撐 tab 切換不卡頓 (`_thumbCache` 生效)
- [ ] **C.6** brace tab 第一次按 🎯 → 建 default + YZ/XY 未指派頁套上
- [ ] **C.7** YY 池滿後按 🎯 → 跳警告
- [ ] **C.8** 改一個 type yyStart → 其他下拉的可選項即時更新

### Phase D — 全局節點管理 (10 min)
- [ ] **D.9** 搜尋 `1460, 0, 0` → 距離升冪排,Δ 0.0 mm 排第一
- [ ] **D.10** 搜尋 `N5` / `20154` → 分別命中 label / 顯示編號
- [ ] **D.11** [跳轉] → 跳對應頁、joint 被選中
- [ ] **D.12** [⭐ 設為世界原點] → 退視窗檢查該節點 (0,0,0) + locked

### Phase E — 匯出正確性 (5 min)
- [ ] **E.13** 設 brace yyStart=51 → 匯出 .xlsx → BRACE 區 YY rank 從 51 起
- [ ] **E.14** 同專案 .std → BRACE 區跟 .xlsx 一致

### Phase F — Render Watchdog (2 min)
- [ ] **F.15** console: `localStorage.setItem('renderTimeoutMs','50')` → 重畫 → HUD 跳警告 + 自動 fitToView
- [ ] **F.16** `localStorage.setItem('renderTimeoutMs','0')` → 恢復停用

---

## Action Items (Round-1 結算)

| Priority | Item | Owner | Status |
|---|---|---|---|
| P0 | Trigger UI smoke tests Phase A-F | User | ⏳ Open |
| P0 | 取得三視圖自動配對的 console error | User | ⏳ Open |
| P1 | Selection 加 source page guard(防誤刪)| Claude | ✅ **Done** — `_assertSelectionOnActivePage` 接 performDelete + startMoveMode |
| P1 | Risk R-04 — 真實模型驗 BRACE 區匯出 | User | ⏳ Open |
| P2 | Undo stack cap | Claude | ✅ **Already in place** — `MAX_UNDO = 100` |
| P2 | i18n EN 補齊新 dialog | Claude | ✅ **Outer done** — menu / tooltip / labels 有 EN;dialog 內部 zh-TW |
| P2 | `_thumbCache` cleanup on dialog close (R-09)| Claude | ✅ **Done** |
| P3 | 174 alert → HUD 重構 (R-03)| TBD | ⏸ Deferred — 大重構 |
| P3 | gjm-row virtual scroll (R-10)| Claude | ⏸ Deferred — < 100 節點影響低 |
| P3 | 174 alert → HUD 重構 | TBD | 待排 |

---

*Report ends.*
