// Phase 8b — i18n 語言包(zh-TW / en)
//   原本在 legacy.ts 末段(~636 行),含字典 _I18N、_t、_tx、_addI18n、_applyI18n、
//   _setBtnLabel、_setLanguage 與初始化 IIFE。狀態存 localStorage。
//
//   設計重點:
//   • _setLanguage 呼叫多個 update* / refresh* 函式來重畫各個按鈕 / 列表的文字;
//     全部以 typeof === "function" + try/catch 保護,允許 TDZ / 循環 import / 模組未初始化階段安全 skip。
//   • _applyI18n 也會掃所有開啟中的 popup window(search / material mgr / 3D preview),
//     popup 的 document 仍由 i18n 統一接管翻譯。
//   • window._t / window._tx / window._addI18n / window._setLanguage 仍會掛在
//     window 上,讓 popup / devtools / 第三方腳本可直接呼叫。

import {
  state, getPage, render, refreshLists,
  refreshFileList, refreshPageSelector,
  updateBgToggleBtn, updateLblToggleBtn, updateCrossViewSyncBtn,
  updateScaleRulerButton, updatePlaneOriginButton, updateCalibrateButton,
  updateSnapGridBtn, updateJointVisBtn, updateMemberVisBtn,
  updateSelectToolLabel,
  _setToolFinishVisuals, paintEmptyCanvasMessage,
  _searchWin, _materialMgrWin, _3dPreviewWindow,
} from "../app/integration";

// ============================================================================
// 語言包(i18n)
// ============================================================================
// 兩種語言:繁體中文(zh-TW)/ 英文(en);預設 zh-TW,狀態存在 localStorage。
//
// ─── 如何新增翻譯字串 ────────────────────────────────────────────────────────
// 1. 在 _I18N 字典裡加一行(按主題就近的區段加):
//      "myArea.someKey": { "zh-TW": "中文字", "en": "English text" },
//
// 2. 在 DOM / JS 用其中一種方式套用翻譯:
//
//    A. 靜態 HTML(textContent):
//       <span data-i18n="myArea.someKey">中文字</span>
//
//    B. 靜態 HTML(title 屬性):
//       <button data-i18n-title="myArea.tooltipKey" title="中文 tooltip">...</button>
//
//    C. 靜態 HTML(placeholder 屬性):
//       <input data-i18n-placeholder="myArea.placeholderKey" placeholder="中文 placeholder">
//
//    D. 靜態 HTML(含 HTML 標籤的內容,如 <span class="kbd">):
//       <div data-i18n-html="myArea.helpKey">中文 <span>...</span></div>
//
//    E. JS 動態組裝文字(format string):
//       el.textContent = `${_tx("myArea.label","中文")} ${value}`;
//       // _tx(key, fallback) 永遠安全:沒翻譯時退回 fallback,語言切換時自動更新
//
//    F. JS 動態設定按鈕(保留 .btn-icon):
//       _setBtnLabel(btn, "myArea.someKey", "中文");
//
// 3. 若需要在另一支檔案 / lazy-load 的程式裡加翻譯,呼叫:
//       _addI18n({ "myArea.someKey": { "zh-TW": "中文", "en": "English" } });
//
// ─── 注意事項 ────────────────────────────────────────────────────────────────
// • 字典中沒有 key 的元素不會被動到(維持目前內容),所以可以增量翻譯。
// • 空字串 "" 是合法翻譯;_t() 會正確回傳。
// • 若字典 entry 缺 en,但有 zh-TW,en 模式會 fallback 到 zh-TW(避免空文字)。
// • 設 (window.STAAD_I18N_DEBUG = true) 後,有用到但未在字典中的 key 會在 console 警告一次。
// • _applyI18n() 會自動掃所有開啟中的 popup(search / material / 3D)。
// ============================================================================
const _LANG_KEY = "staad.lang";
const _I18N = {
  // ── 主選單列 (menu titles) ──
  "menu.file":      { "zh-TW": "檔案",   "en": "File" },
  "menu.project":   { "zh-TW": "專案",   "en": "Project" },
  "menu.edit":      { "zh-TW": "編輯",   "en": "Edit" },
  "menu.tools":     { "zh-TW": "工具",   "en": "Tools" },
  "menu.help":      { "zh-TW": "說明",   "en": "Help" },
  "help.autoBackup":   { "zh-TW": "自動備份…", "en": "Auto Backups…" },
  "help.checkUpdates": { "zh-TW": "檢查更新", "en": "Check for Updates" },
  "help.about":     { "zh-TW": "關於 STAAD 描圖工具", "en": "About STAAD Tracer" },
  // ── 檔案 menu ──
  "file.openProject":       { "zh-TW": "開啟專案",       "en": "Open Project" },
  "file.openNewProject":    { "zh-TW": "開啟新專案",     "en": "Open New Project" },
  "file.openProjectFromFile":{ "zh-TW": "從檔案開啟…",   "en": "Open from file…" },
  "file.recentEmpty":       { "zh-TW": "(尚無最近開啟的專案)", "en": "(No recent projects)" },
  "file.recentClear":       { "zh-TW": "清除清單",       "en": "Clear list" },
  "file.saveProject":   { "zh-TW": "儲存專案",       "en": "Save Project" },
  "file.saveProjectAs": { "zh-TW": "另存新檔",       "en": "Save Project As…" },
  "file.importJson":    { "zh-TW": "讀入標線",       "en": "Import JSON" },
  "file.exportJson":    { "zh-TW": "儲存標線",       "en": "Export JSON" },
  "file.exportStd":     { "zh-TW": "匯出 .std",      "en": "Export .std" },
  "file.exportXlsx":    { "zh-TW": "匯出 .xlsx",     "en": "Export .xlsx" },
  "file.xlsxSettings":  { "zh-TW": "xlsx 輸出設定…", "en": "xlsx Export Settings…" },
  "file.clearAll":      { "zh-TW": "清除所有節點與桿件", "en": "Clear All Joints & Members" },
  "file.tbMode":        { "zh-TW": "工具列顯示",     "en": "Toolbar Display" },
  "file.tbModeText":    { "zh-TW": "文字",           "en": "Text" },
  "file.tbModeIcon":    { "zh-TW": "圖示",           "en": "Icon" },
  "file.tbModeBoth":    { "zh-TW": "文字 + 圖示",    "en": "Text + Icon" },
  "file.language":      { "zh-TW": "語言 / Language", "en": "Language / 語言" },
  "file.langZh":        { "zh-TW": "繁體中文",       "en": "繁體中文" },
  "file.langEn":        { "zh-TW": "English",        "en": "English" },
  // ── 專案 menu ──
  "project.new":        { "zh-TW": "新增專案…",     "en": "New Project…" },
  "project.untitled":   { "zh-TW": "未命名",         "en": "Untitled" },
  "project.unsaved":    { "zh-TW": "(未儲存)",     "en": "(unsaved)" },
  "project.close":      { "zh-TW": "關閉當前分頁",   "en": "Close Current Tab" },
  // ── 編輯 menu ──
  "edit.consolidateAll":      { "zh-TW": "整理所有頁面",      "en": "Consolidate All Pages" },
  "edit.extendCheckAll":      { "zh-TW": "檢查可延伸桿件(全部頁面)", "en": "Check Extendable (All Pages)" },
  "edit.inferAll":            { "zh-TW": "適配關聯(精準度)",  "en": "Fit-Merge by Precision" },
  "edit.relayoutAll":         { "zh-TW": "編排節點編號(全部頁面)", "en": "Re-number Joints (All Pages)" },
  "edit.relayoutMembersAll":  { "zh-TW": "編排桿件編號(全部頁面)", "en": "Re-number Members (All Pages)" },
  "edit.recomputeWorldAll":   { "zh-TW": "重新計算 3D 座標(全部頁面)", "en": "Recompute 3D Coords (All Pages)" },
  "edit.run3DPipeline":       { "zh-TW": "⚡ 3D 一鍵處理",      "en": "⚡ Run 3D Pipeline" },
  "edit.copyPageSamePlane":   { "zh-TW": "複製本頁節點+桿件到同平面頁", "en": "Copy Joints+Members to Same-Plane Page" },
  // ── 工具 menu ──
  "tools.open3D":             { "zh-TW": "3D 立體預覽",     "en": "3D Preview" },
  "tools.openMatMgr":         { "zh-TW": "材料管理",         "en": "Material Manager" },
  "tools.openFloorTypes":     { "zh-TW": "節點編號管理",     "en": "Joint Numbering" },
  "tools.openGlobalJointMgr": { "zh-TW": "全局節點管理",     "en": "Global Joints" },
  "tools.bgRepair":           { "zh-TW": "底圖修復",         "en": "Repair Background" },
  "tools.cleanupBad":         { "zh-TW": "清除錯誤的 globalJoint 綁定", "en": "Clean Bad globalJoint Bindings" },
  "tools.cleanupAll":         { "zh-TW": "清除所有 globalJoint 綁定",   "en": "Clean All globalJoint Bindings" },
  // ── 工具列(toolbar)section titles ──
  "tb.calib":   { "zh-TW": "校準",   "en": "Calibrate" },
  "tb.mode":    { "zh-TW": "模式",   "en": "Mode" },
  "tb.tools":   { "zh-TW": "工具",   "en": "Tools" },
  "tb.edit":    { "zh-TW": "編輯",   "en": "Edit" },
  "tb.page":    { "zh-TW": "頁面",   "en": "Page" },
  // ── 工具列按鈕文字 ──
  "tb.scaleRuler":      { "zh-TW": "比例尺",           "en": "Scale Ruler" },
  "tb.planeOrigin":     { "zh-TW": "座標原點",         "en": "Plane Origin" },
  "tb.fixLocalOrigin":  { "zh-TW": "修正本檔原點",     "en": "Fix Local Origin" },
  "tb.calibrate":       { "zh-TW": "校準",             "en": "Calibrate" },
  "tb.recomputeWorld":  { "zh-TW": "重算 3D 座標",     "en": "Recompute 3D" },
  "tb.rotate90":        { "zh-TW": "旋轉 90°",         "en": "Rotate 90°" },
  "tb.bgToggle":        { "zh-TW": "底圖 顯示",        "en": "Show Background" },
  "tb.jointVis":        { "zh-TW": "節點 顯示",        "en": "Show Joints" },
  "tb.memberVis":       { "zh-TW": "桿件 顯示",        "en": "Show Members" },
  "tb.toolSelect":      { "zh-TW": "選取",             "en": "Select" },
  "tb.toolBgSel":       { "zh-TW": "底圖",             "en": "Background" },
  "tb.toolPoint":       { "zh-TW": "節點",             "en": "Joint" },
  "tb.toolLine":        { "zh-TW": "桿件",             "en": "Member" },
  "tb.crossViewSync":   { "zh-TW": "跨頁同步",         "en": "Cross-View Sync" },
  "tb.prewarmBg":       { "zh-TW": "掃描所有底圖",     "en": "Scan All Backgrounds" },
  "tb.consolidate":     { "zh-TW": "整理",             "en": "Consolidate" },
  "tb.extendCheck":     { "zh-TW": "檢查可延伸桿件",   "en": "Check Extendable" },
  "tb.relayoutCur":     { "zh-TW": "編排節點編號",     "en": "Re-number Joints" },
  "tb.relayoutMembers": { "zh-TW": "編排桿件編號",     "en": "Re-number Members" },
  "tb.split":           { "zh-TW": "拆分頁面",         "en": "Split Page" },
  "tb.sectionLink":     { "zh-TW": "切面",             "en": "Section Link" },
  // ── 側邊欄 section 標題 ──
  "sb.title":           { "zh-TW": "STAAD 描圖工具", "en": "STAAD Tracer" },
  "sb.bg":              { "zh-TW": "底圖",           "en": "Background" },
  "sb.filesLoaded":     { "zh-TW": "已載入檔案",     "en": "Loaded Files" },
  "sb.snap":            { "zh-TW": "吸附",           "en": "Snap" },
  "sb.precision":       { "zh-TW": "精準度設定",     "en": "Precision" },
  "sb.jointNum":        { "zh-TW": "節點編號(全局)", "en": "Joint Numbering (Global)" },
  // ── 子工具列 selectTools 按鈕標籤 ──
  "subtool.selToolsAll":         { "zh-TW": "全選",             "en": "Select All" },
  "subtool.selToolsJoints":      { "zh-TW": "點",               "en": "Joints" },
  "subtool.selToolsMembers":     { "zh-TW": "線",               "en": "Members" },
  "subtool.selToolsRepeatHJ":    { "zh-TW": "點-水平重複",      "en": "J-Horiz Repeat" },
  "subtool.selToolsRepeatVJ":    { "zh-TW": "點-垂直重複",      "en": "J-Vert Repeat" },
  "subtool.selToolsRepeatOH":    { "zh-TW": "正交線-水平重複",  "en": "Ortho-Horiz Repeat" },
  "subtool.selToolsRepeatOV":    { "zh-TW": "正交線-垂直重複",  "en": "Ortho-Vert Repeat" },
  "subtool.selToolsRepeatDH":    { "zh-TW": "斜線-水平重複",    "en": "Diag-Horiz Repeat" },
  "subtool.selToolsRepeatDV":    { "zh-TW": "斜線-垂直重複",    "en": "Diag-Vert Repeat" },
  "subtool.selToolsExtend":      { "zh-TW": "桿件單端延伸",     "en": "Extend Member (Near)" },
  "subtool.selToolsExtendBoth":  { "zh-TW": "桿件兩端延伸",     "en": "Extend Member (Both)" },
  "subtool.selToolsJExtH":       { "zh-TW": "端點水平延桿",     "en": "Joint Horiz Extend" },
  "subtool.selToolsJExtV":       { "zh-TW": "端點垂直延桿",     "en": "Joint Vert Extend" },
  "subtool.selToolsJExtHBoth":   { "zh-TW": "端點兩側水平延桿", "en": "Joint Horiz Extend (Both)" },
  "subtool.selToolsJExtVBoth":   { "zh-TW": "端點兩側垂直延桿", "en": "Joint Vert Extend (Both)" },
  "subtool.selToolsDupJointH":   { "zh-TW": "節點水平複製",     "en": "Joint Horiz Duplicate" },
  "subtool.selToolsDupJointV":   { "zh-TW": "節點垂直複製",     "en": "Joint Vert Duplicate" },
  "subtool.selToolsJConnectH":   { "zh-TW": "點點水平連結",     "en": "Connect Joints Horiz" },
  "subtool.selToolsJConnectV":   { "zh-TW": "點點垂直連結",     "en": "Connect Joints Vert" },
  "subtool.selToolsJConnectD":   { "zh-TW": "點點斜線連結",     "en": "Connect Joints Diag" },
  "subtool.selToolsJMerge":      { "zh-TW": "兩點合一",         "en": "Merge Two Joints" },
  "subtool.selToolsMeasure":     { "zh-TW": "標示距離",         "en": "Mark Distance" },
  "subtool.section.support":     { "zh-TW": "節點支承",         "en": "Joint Supports" },
  "subtool.selToolsSupportSet":  { "zh-TW": "設定支承…",        "en": "Set Support…" },
  "subtool.selToolsSupportFixed":{ "zh-TW": "快速固接",         "en": "Quick FIXED" },
  "subtool.selToolsSupportPinned":{ "zh-TW": "快速銷接",        "en": "Quick PINNED" },
  "subtool.selToolsSupportClear":{ "zh-TW": "清除支承",         "en": "Clear Support" },
  "subtool.section.release":     { "zh-TW": "桿件釋放",         "en": "Member Release" },
  "subtool.selToolsReleaseSet":  { "zh-TW": "設定釋放…",        "en": "Set Release…" },
  "subtool.selToolsReleasePinned":{ "zh-TW": "快速兩端鉸接",    "en": "Quick Both-End Hinge" },
  "subtool.selToolsReleaseTruss":{ "zh-TW": "設為桁架",         "en": "Set TRUSS" },
  "subtool.selToolsReleaseClear":{ "zh-TW": "清除釋放",         "en": "Clear Release" },
  "subtool.selToolsIntersectSel":{ "zh-TW": "切交點(選取)",    "en": "Cut Intersections" },
  "subtool.btnDel":              { "zh-TW": "刪除",             "en": "Delete" },
  "subtool.selToolsMove":        { "zh-TW": "移動",             "en": "Move" },
  "subtool.selToolsMoveH":       { "zh-TW": "水平移動",         "en": "Move Horiz" },
  "subtool.selToolsMoveV":       { "zh-TW": "垂直移動",         "en": "Move Vert" },
  "subtool.selToolsMoveDist":    { "zh-TW": "距離移動",         "en": "Move by Distance" },
  "subtool.selToolsMoveAngle":   { "zh-TW": "夾角移動",         "en": "Move by Angle" },
  "subtool.selToolsMoveRect":    { "zh-TW": "直角坐標移動",     "en": "Move by Δx, Δy" },
  // ── 子工具列 bgEditTools 按鈕標籤 ──
  "subtool.bgEditSelectAll":     { "zh-TW": "全選",             "en": "Select All" },
  "subtool.bgEditClear":         { "zh-TW": "取消選取",         "en": "Clear Selection" },
  "subtool.bgEditMultiSelect":   { "zh-TW": "多線選取",         "en": "Multi-Select" },
  "subtool.bgEditSelSquares":    { "zh-TW": "正方形",           "en": "Squares" },
  "subtool.bgEditSelRects":      { "zh-TW": "長方形",           "en": "Rectangles" },
  "subtool.bgEditSelCircles":    { "zh-TW": "圓形",             "en": "Circles" },
  "subtool.bgEditSelStraight":   { "zh-TW": "直線",             "en": "Lines" },
  "subtool.bgEditSelStraightSolid": { "zh-TW": "直實線",        "en": "Solid Lines" },
  "subtool.bgEditSelDiagonals":  { "zh-TW": "斜線",             "en": "Diagonals" },
  "subtool.bgEditSelDashedDiagonals":{ "zh-TW": "虛斜線",       "en": "Dashed Diag" },
  "subtool.bgEditClearShape":    { "zh-TW": "取消選取類型",     "en": "Clear Shape Filter" },
  "subtool.bgEditScaleRulerMove":{ "zh-TW": "比例尺沿線移動",   "en": "Slide Scale Ruler" },
  "subtool.bgEditMeasureSelect": { "zh-TW": "標示距離線",       "en": "Pick Measure Line" },
  "subtool.bgEditPlaneOrigin":   { "zh-TW": "平面座標原點",     "en": "Plane Origin" },
  "subtool.bgEditScaleRuler":    { "zh-TW": "比例尺",           "en": "Scale Ruler" },
  "subtool.bgEditDrawLine":      { "zh-TW": "畫直線",           "en": "Draw Line" },
  "subtool.bgEditDrawDashed":    { "zh-TW": "畫虛線",           "en": "Draw Dashed" },
  "subtool.bgEditCopyLine":      { "zh-TW": "複製線",           "en": "Copy Line" },
  "subtool.bgEditBisector":      { "zh-TW": "中分線",           "en": "Bisector" },
  "subtool.bgEditEquidist":      { "zh-TW": "等分線",           "en": "Equidistant Line" },
  "subtool.bgEditToDashed":      { "zh-TW": "轉虛線",           "en": "Toggle Dashed" },
  "subtool.bgEditSplit":         { "zh-TW": "切成直線",         "en": "Split to Lines" },
  "subtool.bgEditToMember":      { "zh-TW": "轉為桿件",         "en": "To Members" },
  "subtool.bgEditMarkIntersect": { "zh-TW": "多線轉交點",       "en": "Mark Intersections" },
  "subtool.bgEditMarkIntersectAndMember": { "zh-TW": "多線轉交點+桿件", "en": "Mark Intersect + Members" },
  "subtool.bgEditRectToCenterMember":{ "zh-TW": "轉為置中桿件", "en": "Rect → Center Member" },
  "subtool.bgEditRectToTopMember":   { "zh-TW": "轉為上邊桿件", "en": "Rect → Top Member" },
  "subtool.bgEditRectToBottomMember":{ "zh-TW": "轉為下邊桿件", "en": "Rect → Bottom Member" },
  "subtool.bgEditSquareToJoint": { "zh-TW": "轉為節點",         "en": "Squares → Joints" },
  "subtool.bgEditMeasureMove":   { "zh-TW": "移動標示距離線",   "en": "Move Measure Line" },
  "subtool.bgEditDel":           { "zh-TW": "刪除",             "en": "Delete" },
  // ── 子工具列 section 標題 ──
  "subtool.section.select":      { "zh-TW": "選取",             "en": "Select" },
  "subtool.section.edit":        { "zh-TW": "編輯",             "en": "Edit" },
  "subtool.section.move":        { "zh-TW": "移動",             "en": "Move" },
  "subtool.section.measure":     { "zh-TW": "測量",             "en": "Measure" },
  // ── 左側 sidebar:檔案 / 吸附 / 精準度 / 節點編號 ──
  "sb.noFileLoaded":             { "zh-TW": "尚未載入任何檔案", "en": "No files loaded yet" },
  "sb.chooseFile":               { "zh-TW": "選擇檔案",          "en": "Choose File" },
  "sb.noFileChosen":             { "zh-TW": "未選擇任何檔案",    "en": "No file chosen" },
  "sb.fileChosenN":              { "zh-TW": "個檔案已選",        "en": "files selected" },
  "canvas.empty":                { "zh-TW": "請從左側載入 PDF 或圖片以開始描圖。", "en": "Load a PDF or image from the left to start tracing." },
  "hud.zoom":                    { "zh-TW": "縮放",              "en": "Zoom" },
  "hud.selectAll":               { "zh-TW": "選取",              "en": "Select" },
  "hud.selectJoints":            { "zh-TW": "選取點",            "en": "Select joints" },
  "hud.selectMembers":           { "zh-TW": "選取線",            "en": "Select members" },
  "tb.jointShown":               { "zh-TW": "節點 顯示",         "en": "Show Joints" },
  "tb.jointHidden":              { "zh-TW": "節點 隱藏",         "en": "Hide Joints" },
  "tb.memberShown":              { "zh-TW": "桿件 顯示",         "en": "Show Members" },
  "tb.memberHidden":             { "zh-TW": "桿件 隱藏",         "en": "Hide Members" },
  // ── 材料管理 popup ──
  "mm.title":                    { "zh-TW": "材料管理(專案層級;會隨專案存檔)", "en": "Material Manager (project-level; saved with project)" },
  "mm.namePlaceholder":          { "zh-TW": "材料名稱(例:T10010090 / H300x150x6.5x9)", "en": "Material name (e.g., T10010090 / H300x150x6.5x9)" },
  "mm.tablePlaceholder":         { "zh-TW": "STAAD 表單(例:UPT 5 / TABLE ST)", "en": "STAAD table (e.g., UPT 5 / TABLE ST)" },
  "mm.notePlaceholder":          { "zh-TW": "備註(可選)",       "en": "Note (optional)" },
  "mm.addBtn":                   { "zh-TW": "新增 (Enter)",      "en": "Add (Enter)" },
  "mm.filterPlaceholder":        { "zh-TW": "🔎 過濾...",        "en": "🔎 Filter..." },
  "mm.colTable":                 { "zh-TW": "表單",              "en": "Table" },
  "mm.colName":                  { "zh-TW": "材料名稱",          "en": "Name" },
  "mm.colNote":                  { "zh-TW": "備註",              "en": "Note" },
  "mm.colActions":               { "zh-TW": "操作",              "en": "Actions" },
  "mm.emptyHint":                { "zh-TW": "尚無材料 — 在上方輸入名稱後按「新增」開始建立", "en": "No materials yet — type a name above and press \"Add\"" },
  "mm.statsZero":                { "zh-TW": "共 0 筆",           "en": "0 total" },
  "mm.clearAll":                 { "zh-TW": "清空全部…",         "en": "Clear all…" },
  "mm.import":                   { "zh-TW": "📥 匯入…",           "en": "📥 Import…" },
  "mm.exportJson":               { "zh-TW": "📤 匯出 JSON",       "en": "📤 Export JSON" },
  "mm.exportCsv":                { "zh-TW": "📤 匯出 CSV",        "en": "📤 Export CSV" },
  "mm.footerHint":               { "zh-TW": "關閉視窗 / Esc 即儲存到專案", "en": "Close window / Esc to save into project" },
  "mm.delete":                   { "zh-TW": "刪除",              "en": "Delete" },
  "mm.totalPrefix":              { "zh-TW": "共",                "en": "" },
  "mm.unit":                     { "zh-TW": "筆",                "en": "total" },
  "mm.filtered":                 { "zh-TW": "(已過濾)",         "en": " (filtered)" },
  "rb.pageNotLoaded":            { "zh-TW": "尚未載入",          "en": "Not loaded yet" },
  "sb.memberNum":                { "zh-TW": "桿件編號(全局)",   "en": "Member Numbering (Global)" },
  "sb.memberNum.yMax":           { "zh-TW": "Y 軸最大",          "en": "Y max" },
  "sb.memberNum.xMax":           { "zh-TW": "X 軸最大",          "en": "X max" },
  "sb.memberNum.zMax":           { "zh-TW": "Z 軸最大",          "en": "Z max" },
  "sb.memberNum.dMax":           { "zh-TW": "斜桿最大",          "en": "Diag max" },
  "sb.memberNum.note":           { "zh-TW": "順序:Y 軸 → 斜撐 → X / Z 軸 → 平面斜撐<br>Plane:XY → YZ → XZ<br>每換方向 / 平面進位到下個 0 整位", "en": "Order: Y axis → Diag → X / Z axis → In-plane diag<br>Plane: XY → YZ → XZ<br>Each direction/plane bumps to the next 0-aligned base" },
  "sb.sectionLink":              { "zh-TW": "切面樣式",          "en": "Section Style" },
  "sb.sectionLink.fontPt":       { "zh-TW": "標籤字體 (pt)",     "en": "Label font (pt)" },
  "sb.sectionLink.strokeWidth":  { "zh-TW": "線條粗度 (px)",     "en": "Stroke width (px)" },
  "sb.help":                     { "zh-TW": "說明",              "en": "Help" },
  "sb.help.body":                { "zh-TW": '<span class="kbd">Shift+L</span> 畫線 · <span class="kbd">Shift+S</span> 切換單/多選 · <span class="kbd">Shift+C</span> 選取底線<br><span class="kbd">Shift+I</span> 自動切交點 · <span class="kbd">Shift+M</span> 合併鄰近節點<br><span class="kbd">空白</span>+拖曳 平移 · 滾輪 縮放<br><span class="kbd">Esc</span> 取消 · <span class="kbd">Shift+D</span> 或 <span class="kbd">Del</span> 刪除<br><span class="kbd">雙擊線段</span> 在點擊處新增節點<br><span class="kbd">M</span> 移動已選取節點(再點 2 次:基準點→目標點)<br><span class="kbd">⌘/Ctrl+Z</span> 復原 · <span class="kbd">⌘/Ctrl+⇧+Z</span> 重做<br><span class="kbd">⌘/Ctrl+S</span> 儲存專案 · <span class="kbd">⌘/Ctrl+⇧+S</span> 另存新檔<br><span style="color:#888">(工具切換需按住 Shift,避免在輸入時誤觸)</span>', "en": '<span class="kbd">Shift+L</span> Line · <span class="kbd">Shift+S</span> Toggle single/multi-select · <span class="kbd">Shift+C</span> Select background<br><span class="kbd">Shift+I</span> Auto cut intersections · <span class="kbd">Shift+M</span> Merge near joints<br><span class="kbd">Space</span>+drag Pan · Wheel Zoom<br><span class="kbd">Esc</span> Cancel · <span class="kbd">Shift+D</span> or <span class="kbd">Del</span> Delete<br><span class="kbd">Double-click segment</span> Add joint at clicked point<br><span class="kbd">M</span> Move selected joints (then 2 clicks: anchor → target)<br><span class="kbd">⌘/Ctrl+Z</span> Undo · <span class="kbd">⌘/Ctrl+⇧+Z</span> Redo<br><span class="kbd">⌘/Ctrl+S</span> Save project · <span class="kbd">⌘/Ctrl+⇧+S</span> Save as<br><span style="color:#888">(Tool shortcuts use Shift to avoid triggering while typing)</span>' },
  "sb.snap.radius":              { "zh-TW": "吸附半徑(畫面像素)", "en": "Snap radius (pixels)" },
  "sb.snap.ortho":               { "zh-TW": "正交模式",          "en": "Orthogonal" },
  "sb.snap.mid":                 { "zh-TW": "吸附線段中點",      "en": "Snap to midpoint" },
  "sb.snap.gridStep":            { "zh-TW": "鎖點間距",          "en": "Grid step" },
  "sb.snap.gridHelp":            { "zh-TW": "啟用鎖點後,游標會吸附到此間距的網格上。", "en": "When grid snap is on, cursor snaps to this spacing." },
  "sb.snap.bgTol":               { "zh-TW": "底圖誤差 (mm)",     "en": "Background tolerance (mm)" },
  "sb.prec.coordDec":            { "zh-TW": "坐標顯示位數",      "en": "Coord display decimals" },
  "sb.prec.measureDec":          { "zh-TW": "節點適配位數",      "en": "Joint-merge decimals" },
  "sb.num.xMax":                 { "zh-TW": "X 最大",            "en": "X max" },
  "sb.num.yMax":                 { "zh-TW": "Y 最大",            "en": "Y max" },
  "sb.num.zMax":                 { "zh-TW": "Z 最大",            "en": "Z max" },
  "sb.num.tol":                  { "zh-TW": "誤差範圍 (mm)",     "en": "Tolerance (mm)" },
  "sb.num.priority":             { "zh-TW": "編排優先",          "en": "Sort priority" },
  "sb.num.priorityH":            { "zh-TW": "水平優先",          "en": "Horizontal first" },
  "sb.num.priorityV":            { "zh-TW": "垂直優先",          "en": "Vertical first" },
  "sb.num.preview":              { "zh-TW": "編號預覽:—",       "en": "Preview: —" },
  "sb.num.rulesHelp":            { "zh-TW": "編號規則說明",      "en": "Numbering rule reference" },
  "sb.fileList.show":            { "zh-TW": "清單顯示欄位",      "en": "List columns" },
  "sb.fileList.colType":         { "zh-TW": "類型圖示(DXF / PDF / IMG)", "en": "Type icon (DXF / PDF / IMG)" },
  "sb.fileList.colPlane":        { "zh-TW": "平面 + 第三軸",     "en": "Plane + third-axis" },
  "sb.fileList.colStats":        { "zh-TW": "節點 / 桿件數",     "en": "Joint / member counts" },
  "sb.fileList.colNote":         { "zh-TW": "(檔名永遠顯示)",   "en": "(name is always shown)" },
  // ── 右側 sidebar:模型 / 頁面 / 節點 / 桿件 / 切面 / 匯出 ──
  "rb.title":                    { "zh-TW": "模型",              "en": "Model" },
  "rb.currentPage":              { "zh-TW": "當前頁面",          "en": "Current Page" },
  "rb.statsZero":                { "zh-TW": "0 節點 · 0 桿件",   "en": "0 joints · 0 members" },
  "rb.pageCoord":                { "zh-TW": "頁面座標",          "en": "Page Coordinates" },
  "rb.worldPlane":               { "zh-TW": "世界平面",          "en": "World Plane" },
  "rb.planeNotSet":              { "zh-TW": "未設定",            "en": "Not set" },
  "rb.planeXY":                  { "zh-TW": "XY 平面",           "en": "XY plane" },
  "rb.planeYZ":                  { "zh-TW": "YZ 平面",           "en": "YZ plane" },
  "rb.planeXZ":                  { "zh-TW": "XZ 平面",           "en": "XZ plane" },
  "rb.thirdAxis":                { "zh-TW": "第三軸位置",        "en": "Third-axis position" },
  "rb.flipX":                    { "zh-TW": "左右翻轉",          "en": "Flip horizontal" },
  "rb.flipY":                    { "zh-TW": "上下翻轉",          "en": "Flip vertical" },
  "rb.applyFlipSamePlane":       { "zh-TW": "套用翻轉到同平面",   "en": "Apply flip to same plane" },
  "rb.flipSync":                 { "zh-TW": "同步到全部同平面",   "en": "Sync to all same-plane pages" },
  "rb.floorType":                { "zh-TW": "樓層類型",           "en": "Floor type" },
  "rb.braceType":                { "zh-TW": "斜撐起始",           "en": "Brace start" },
  "rb.manageFloorTypes":         { "zh-TW": "管理…",              "en": "Manage…" },
  "sb.floorType":                { "zh-TW": "樓層類型",           "en": "Floor types" },
  "sb.openFloorTypeMgr":         { "zh-TW": "管理…",              "en": "Manage…" },
  "rb.setOrigin":                { "zh-TW": "本頁原點 = 世界原點", "en": "Page Origin = World Origin" },
  "rb.unsetOrigin":              { "zh-TW": "取消",              "en": "Cancel" },
  "rb.joints":                   { "zh-TW": "節點 Joints",       "en": "Joints" },
  "rb.globalJoints":             { "zh-TW": "全局節點 Global",   "en": "Global Joints" },
  "rb.autoPair":                 { "zh-TW": "三視圖自動配對",     "en": "3-View Auto Pair" },
  "rb.globalJointHint":          { "zh-TW": "想設世界原點?到右側欄上方「頁面座標」區用「本頁原點 = 世界原點」最快;要進階「自動推算各檔案位移」則需要先建立全局節點(右鍵節點 → 設為全局節點),再回到此區校準。", "en": "To set world origin: use \"Page Origin = World Origin\" in the Page Coordinates section above. For advanced auto-derive of file offsets, first create global joints (right-click a joint → Mark as Global), then calibrate here." },
  "rb.setGlobalOrigin":          { "zh-TW": "全局節點校準",      "en": "Calibrate from Global Joint" },
  "rb.setCustomOrigin":          { "zh-TW": "自訂原點座標",      "en": "Custom Origin Coords" },
  "rb.clearGlobalOrigin":        { "zh-TW": "解除節點原點",      "en": "Clear Joint Origin" },
  "rb.members":                  { "zh-TW": "桿件 Members",      "en": "Members" },
  "rb.sections":                 { "zh-TW": "切面 Sections",     "en": "Sections" },
  "rb.exportSettings":           { "zh-TW": "匯出設定",          "en": "Export Settings" },
  "rb.jobName":                  { "zh-TW": "專案名稱",          "en": "Project name" },
  "rb.exportUnit":               { "zh-TW": "匯出單位",          "en": "Export unit" },
  "rb.unit.meter":               { "zh-TW": "METER 公尺",        "en": "METER" },
  "rb.unit.mmb":                 { "zh-TW": "MMS 毫米",          "en": "MMS (mm)" },
  "rb.unit.cm":                  { "zh-TW": "CM 公分",           "en": "CM" },
  "rb.unit.ft":                  { "zh-TW": "FEET 呎",           "en": "FEET" },
  // ── 搜尋 popup(主要 UI 標籤) ──
  "search.title":                { "zh-TW": "搜尋 - STAAD",      "en": "Search - STAAD" },
  "search.target":               { "zh-TW": "搜尋對象:",        "en": "Search:" },
  "search.tab.member":           { "zh-TW": "桿件",              "en": "Member" },
  "search.tab.joint":            { "zh-TW": "節點",              "en": "Joint" },
  "search.tab.material":         { "zh-TW": "材料",              "en": "Material" },
  "search.tab.support":          { "zh-TW": "節點支承",          "en": "Joint Supports" },
  "search.tab.release":          { "zh-TW": "桿件釋放",          "en": "Member Release" },
  "search.supportType":          { "zh-TW": "支承類型:",        "en": "Support type:" },
  "search.releaseType":          { "zh-TW": "釋放類型:",        "en": "Release type:" },
  "search.release.unrestricted": { "zh-TW": "不限",              "en": "Any" },
  "search.release.has":          { "zh-TW": "有釋放",            "en": "Has release" },
  "search.release.none":         { "zh-TW": "無釋放",            "en": "No release" },
  "search.memberScope":          { "zh-TW": "桿件範圍:",        "en": "Member scope:" },
  "search.member.single":        { "zh-TW": "單條",              "en": "Single" },
  "search.member.line":          { "zh-TW": "整條",              "en": "Whole line" },
  "search.member.endpointAdj":   { "zh-TW": "端點關聯",          "en": "Endpoint-adj" },
  "search.member.onlyJoints":    { "zh-TW": "只要節點",          "en": "Joints only" },
  "search.jointScope":           { "zh-TW": "節點範圍:",        "en": "Joint scope:" },
  "search.joint.single":         { "zh-TW": "單點",              "en": "Single" },
  "search.joint.axisX":          { "zh-TW": "X 軸",              "en": "X axis" },
  "search.joint.axisY":          { "zh-TW": "Y 軸",              "en": "Y axis" },
  "search.joint.axisZ":          { "zh-TW": "Z 軸",              "en": "Z axis" },
  "search.joint.diag":           { "zh-TW": "相鄰斜撐",          "en": "Adjacent diag." },
  "search.resultInclude":        { "zh-TW": "結果包含:",        "en": "Result:" },
  "search.incMembers":           { "zh-TW": "含桿件",            "en": "Include members" },
  "search.onlyMembers":          { "zh-TW": "只有桿件",          "en": "Members only" },
  "search.limitPlane":           { "zh-TW": "限定平面:",        "en": "Plane filter:" },
  "search.clear":                { "zh-TW": "清",                "en": "Clear" },
  "search.pages.all":            { "zh-TW": "頁面: 全部 ▾",      "en": "Pages: All ▾" },
  "search.idMember":             { "zh-TW": "桿件編號:",        "en": "Member ID:" },
  "search.idJoint":              { "zh-TW": "節點編號:",        "en": "Joint ID:" },
  "search.idMaterial":           { "zh-TW": "材料名稱:",        "en": "Material:" },
  "search.placeholder.id":       { "zh-TW": "逗號 / 空白 / 換行分隔 ・支援 regex(.*52 = 結尾 52、52.* = 開頭 52、.*52.* = 含 52)・留空 = 全部", "en": "Comma / space / newline separated ・ regex supported (.*52 = ends with 52, 52.* = starts with 52, .*52.* = contains 52) ・ empty = all" },
  "search.placeholder.material": { "zh-TW": "點此選擇 / 輸入字串 filter(留空 = 所有「有材料設定」的桿件)", "en": "Click to select / type to filter (empty = members with any material)" },
  "search.btnSearch":            { "zh-TW": "搜尋 (Enter)",      "en": "Search (Enter)" },
  "search.btnClear":             { "zh-TW": "清除",              "en": "Clear" },
  "search.btnFilter":            { "zh-TW": "篩選 ⚙",            "en": "Filter ⚙" },
  "search.btnClearHist":         { "zh-TW": "清除歷史",          "en": "Clear History" },
  "search.histBtn":              { "zh-TW": "歷史 ▾",            "en": "History ▾" },
  "search.escClose":             { "zh-TW": "Esc 關閉",          "en": "Esc to close" },
  "search.collapse":             { "zh-TW": "▲ 收起設定",        "en": "▲ Collapse" },
  "search.expand":               { "zh-TW": "▼ 展開設定",        "en": "▼ Expand" },
  "search.noResult":             { "zh-TW": "尚未搜尋",          "en": "No search yet" },
  "search.matEmpty":             { "zh-TW": "尚無材料",          "en": "No materials yet" },
  "search.matGoMgr":             { "zh-TW": "前往「材料管理」新增", "en": "Add via Material Manager" },
  "search.matNoMatchPrefix":     { "zh-TW": "沒有符合「",        "en": "No materials match \"" },
  "search.matNoMatchSuffix":     { "zh-TW": "」的材料",          "en": "\"" },
  // ── 3D 預覽 popup(主要 UI 標籤) ──
  "p3d.title":                   { "zh-TW": "3D 立體預覽 - STAAD", "en": "3D Preview - STAAD" },
  "p3d.view":                    { "zh-TW": "視角:",             "en": "View:" },
  "p3d.viewTop":                 { "zh-TW": "俯視",               "en": "Top" },
  "p3d.viewFront":               { "zh-TW": "正面",               "en": "Front" },
  "p3d.viewSide":                { "zh-TW": "側面",               "en": "Side" },
  "p3d.viewIso":                 { "zh-TW": "等軸",               "en": "Iso" },
  "p3d.viewReset":               { "zh-TW": "重置",               "en": "Reset" },
  "p3d.show":                    { "zh-TW": "顯示:",             "en": "Show:" },
  "p3d.showJoints":              { "zh-TW": "節點",               "en": "Joints" },
  "p3d.showMembers":             { "zh-TW": "桿件",               "en": "Members" },
  "p3d.showJointIds":            { "zh-TW": "節點號",             "en": "Joint IDs" },
  "p3d.showMemberIds":           { "zh-TW": "桿件號",             "en": "Member IDs" },
  "p3d.showAxes":                { "zh-TW": "軸線",               "en": "Axes" },
  "p3d.showGrid":                { "zh-TW": "地網格",             "en": "Grid" },
  "p3d.showLegend":              { "zh-TW": "圖例",               "en": "Legend" },
  "p3d.font":                    { "zh-TW": "字:",                "en": "Font:" },
  "p3d.line":                    { "zh-TW": "線:",                "en": "Line:" },
  "p3d.point":                   { "zh-TW": "點:",                "en": "Point:" },
  "p3d.small":                   { "zh-TW": "小",                 "en": "Small" },
  "p3d.large":                   { "zh-TW": "大",                 "en": "Large" },
  "p3d.thin":                    { "zh-TW": "細",                 "en": "Thin" },
  "p3d.thick":                   { "zh-TW": "粗",                 "en": "Thick" },
  "p3d.autoScale":               { "zh-TW": "隨縮放",             "en": "Auto-scale" },
  "p3d.cut":                     { "zh-TW": "切面:",              "en": "Cut:" },
  "p3d.cutOff":                  { "zh-TW": "關閉",               "en": "Off" },
  "p3d.cutInvert":               { "zh-TW": "反向",               "en": "Invert" },
  "p3d.cutShow":                 { "zh-TW": "顯示切面",           "en": "Show cut" },
  "p3d.cutSlice":                { "zh-TW": "切片",               "en": "Slice" },
  "p3d.snapPage":                { "zh-TW": "吸附頁",             "en": "Snap page" },
  "p3d.snapJoint":               { "zh-TW": "吸附點",             "en": "Snap joint" },
  "p3d.tools":                   { "zh-TW": "工具:",              "en": "Tools:" },
  "p3d.perspective":             { "zh-TW": "透視",               "en": "Perspective" },
  "p3d.snapshot":                { "zh-TW": "截圖",               "en": "Snapshot" },
  "p3d.refresh":                 { "zh-TW": "更新",               "en": "Refresh" },
  "p3d.batch":                   { "zh-TW": "批次:",              "en": "Batch:" },
  "p3d.oneClick":                { "zh-TW": "一鍵處理",           "en": "Run All" },
  "p3d.consolidateAll":          { "zh-TW": "整理所有頁",         "en": "Consolidate All" },
  "p3d.inferAll":                { "zh-TW": "適配關聯",           "en": "Fit-Merge" },
  "p3d.cleanBad":                { "zh-TW": "清壞綁",             "en": "Clean Bad" },
  "p3d.cleanAll":                { "zh-TW": "清全部綁",           "en": "Clean All" },
  "p3d.checkProblems":           { "zh-TW": "檢查問題",           "en": "Check Issues" },
  "p3d.relayoutJ":               { "zh-TW": "編排編號",           "en": "Re-num Joints" },
  "p3d.relayoutM":               { "zh-TW": "編排桿件",           "en": "Re-num Members" },
  // ── 3D 預覽 popup:右上 legend + 右下 hint + 底部 footer ──
  "p3d.legend":                  { "zh-TW": "圖例",                              "en": "Legend" },
  "p3d.legend.singlePage":       { "zh-TW": "單頁節點",                          "en": "Single-page joint" },
  "p3d.legend.crossPage":        { "zh-TW": "跨頁綁定節點 (globalJoint 共享)",   "en": "Cross-page joint (globalJoint shared)" },
  "p3d.legend.anchorFixed":      { "zh-TW": "錨點 FIXED", "en": "Anchor FIXED" },
  "p3d.legend.anchorPinned":     { "zh-TW": "錨點 PINNED", "en": "Anchor PINNED" },
  "p3d.legend.anchorFixedBut":   { "zh-TW": "錨點 FIXED BUT", "en": "Anchor FIXED BUT" },
  "p3d.legend.anchorSpring":     { "zh-TW": "錨點 SPRING", "en": "Anchor SPRING" },
  "p3d.legend.anchorEnforced":   { "zh-TW": "錨點 ENFORCED", "en": "Anchor ENFORCED" },
  "p3d.legend.memY":             { "zh-TW": "垂直桿件 (Y 軸,柱)",                "en": "Vertical member (Y axis, column)" },
  "p3d.legend.memX":             { "zh-TW": "X 軸桿件 (橫樑)",                   "en": "X-axis member (beam)" },
  "p3d.legend.memZ":             { "zh-TW": "Z 軸桿件 (橫樑)",                   "en": "Z-axis member (beam)" },
  "p3d.legend.memDiag":          { "zh-TW": "斜橕 / 非軸向",                     "en": "Diagonal / off-axis" },
  "p3d.legend.relHinge":         { "zh-TW": "桿端釋放(鉸接 / 桁架)",            "en": "Member release (hinge / truss)" },
  "p3d.legend.relRoller":        { "zh-TW": "桿端釋放(滑支 / 平移)",            "en": "Member release (roller / translation)" },
  "p3d.legend.relTension":       { "zh-TW": "只受拉 TENSION",                    "en": "Tension-only" },
  "p3d.legend.relCompression":   { "zh-TW": "只受壓 COMPRESSION",                "en": "Compression-only" },
  "p3d.legend.relCable":         { "zh-TW": "索 CABLE",                          "en": "Cable" },
  "p3d.legend.worldAxes":        { "zh-TW": "世界軸:",                           "en": "World axes:" },
  "p3d.legend.yUp":              { "zh-TW": "Y(上)",                            "en": "Y (up)" },
  "p3d.legend.cutLabel":         { "zh-TW": "切面:",                            "en": "Cut:" },
  "p3d.hint":                    { "zh-TW": "操作說明",                          "en": "Controls" },
  "p3d.hint.midDrag":            { "zh-TW": "中鍵拖曳 = 平移",                   "en": "Middle drag = Pan" },
  "p3d.hint.spaceMid":           { "zh-TW": "Space + 中鍵 = 旋轉",               "en": "Space + Middle = Rotate" },
  "p3d.hint.shiftMid":           { "zh-TW": "Shift + 中鍵 = 旋轉",               "en": "Shift + Middle = Rotate" },
  "p3d.hint.rightDrag":          { "zh-TW": "右鍵拖曳 = 平移",                   "en": "Right drag = Pan" },
  "p3d.hint.wheel":              { "zh-TW": "滾輪 = 縮放",                       "en": "Wheel = Zoom" },
  "p3d.hint.leftClick":          { "zh-TW": "左鍵點節點/桿件 = 資訊",            "en": "Left-click joint/member = Info" },
  "p3d.footer.joints":           { "zh-TW": "節點",                              "en": "Joints" },
  "p3d.footer.members":          { "zh-TW": "桿件",                              "en": "Members" },
  "p3d.footer.view":             { "zh-TW": "視角",                              "en": "View" },
  "p3d.footer.font":             { "zh-TW": "字",                                "en": "Font" },
  "p3d.footer.line":             { "zh-TW": "線",                                "en": "Line" },
  "p3d.footer.point":            { "zh-TW": "點",                                "en": "Point" },
  "p3d.footer.autoScale":        { "zh-TW": "隨縮放",                            "en": "auto-scale" },
  "p3d.footer.controls":         { "zh-TW": "中鍵旋轉 / 滾輪縮放 / Shift+中鍵或右鍵平移 / Hover 詳情", "en": "Middle = Rotate / Wheel = Zoom / Shift+Middle or Right = Pan / Hover for info" },
  // ── 動態渲染字串(runtime;搭配 _t() 用) ──
  "dyn.joints":                  { "zh-TW": "節點",                  "en": "Joints" },
  "dyn.members":                 { "zh-TW": "桿件",                  "en": "Members" },
  "dyn.page":                    { "zh-TW": "頁",                    "en": "Page" },
  "dyn.pageOrdinalPrefix":       { "zh-TW": "第",                    "en": "Page" },
  "dyn.pageOrdinalSuffix":       { "zh-TW": "頁",                    "en": "" },
  // 桿件 hover info
  "hover.member.title":          { "zh-TW": "桿件",                  "en": "Member" },
  "hover.length":                { "zh-TW": "長度",                  "en": "Length" },
  "hover.delta":                 { "zh-TW": "Δx, Δy",                "en": "Δx, Δy" },
  "hover.angle":                 { "zh-TW": "夾角",                  "en": "Angle" },
  "hover.material":              { "zh-TW": "材料",                  "en": "Material" },
  "hover.release":               { "zh-TW": "桿件釋放",              "en": "Member Release" },
  "hover.state":                 { "zh-TW": "狀態",                  "en": "Status" },
  "hover.endpointMissing":       { "zh-TW": "端點不存在",            "en": "Endpoint missing" },
  "hover.notCalibrated":         { "zh-TW": "尚未校準(無比例尺/原點)", "en": "Not calibrated (no ruler / origin)" },
  "hover.tip":                   { "zh-TW": "提示",                  "en": "Tip" },
  "hover.noOrigin":              { "zh-TW": "尚未設定平面原點",      "en": "Plane origin not set" },
  // 節點 hover info
  "hover.joint.title":           { "zh-TW": "節點",                  "en": "Joint" },
  "hover.coord":                 { "zh-TW": "座標",                  "en": "Coord" },
  "hover.anchor":                { "zh-TW": "錨點",                  "en": "Anchor" },
  "hover.globalId":              { "zh-TW": "全局 ID",               "en": "Global ID" },
  "hover.connectedMembers":      { "zh-TW": "連接桿件",              "en": "Connected" },
  // 列表渲染
  "list.noFiles":                { "zh-TW": "尚未載入任何檔案",      "en": "No files loaded yet" },
  "list.noJoints":               { "zh-TW": "目前尚無節點",          "en": "No joints" },
  "list.noMembers":              { "zh-TW": "目前尚無桿件",          "en": "No members" },
  "list.noGlobalJoints":         { "zh-TW": "目前尚無全局節點",      "en": "No global joints" },
  "list.noSections":             { "zh-TW": "尚未選擇檔案",          "en": "No file selected" },
  // 主要 HUD 訊息(精選)
  "hud.fileLoaded":              { "zh-TW": "已載入",                "en": "Loaded" },
  "hud.fileFailed":              { "zh-TW": "載入失敗",              "en": "Load failed" },
  "hud.calibrated":              { "zh-TW": "校準完成",              "en": "Calibrated" },
  "hud.scaleRulerCreated":       { "zh-TW": "比例尺建立",            "en": "Scale ruler set" },
  "hud.planeOriginSet":          { "zh-TW": "平面原點已設定",        "en": "Plane origin set" },
  "hud.cancelled":               { "zh-TW": "已取消",                "en": "Cancelled" },
  // ── 按鈕狀態變體(textContent 動態切換的按鈕)──
  "tb.bgShown":                  { "zh-TW": "底圖 顯示",             "en": "BG: Shown" },
  "tb.bgHidden":                 { "zh-TW": "底圖 隱藏",             "en": "BG: Hidden" },
  "tb.lblShown":                 { "zh-TW": "標示 顯示",             "en": "Labels: On" },
  "tb.lblHidden":                { "zh-TW": "標示 隱藏",             "en": "Labels: Off" },
  "tb.jointLblShown":            { "zh-TW": "節點標號 顯示",         "en": "Joint Labels: On" },
  "tb.jointLblHidden":           { "zh-TW": "節點標號 隱藏",         "en": "Joint Labels: Off" },
  "tb.memberLblShown":           { "zh-TW": "桿件標號 顯示",         "en": "Member Labels: On" },
  "tb.memberLblHidden":          { "zh-TW": "桿件標號 隱藏",         "en": "Member Labels: Off" },
  "tb.crossViewActive":          { "zh-TW": "跨頁同步 ✓",            "en": "Cross-View Sync ✓" },
  "tb.crossView":                { "zh-TW": "跨頁同步",              "en": "Cross-View Sync" },
  "tb.scaleRulerPending":        { "zh-TW": "比例尺…",               "en": "Scale Ruler…" },
  "tb.scaleRulerSet":            { "zh-TW": "比例尺 ✓",              "en": "Scale Ruler ✓" },
  "tb.planeOriginPending":       { "zh-TW": "座標原點…",             "en": "Plane Origin…" },
  "tb.planeOriginSet":           { "zh-TW": "座標原點 ✓",            "en": "Plane Origin ✓" },
  "tb.calibrateSet":             { "zh-TW": "校準 ✓",                "en": "Calibrate ✓" },
  "tb.snapOff":                  { "zh-TW": "鎖點 關閉",             "en": "Snap: Off" },
  "tb.snapPoint":                { "zh-TW": "鎖點 點",               "en": "Snap: Point" },
  "tb.snapGrid":                 { "zh-TW": "鎖點 網格",             "en": "Snap: Grid" },
  "zt.snapGridLine":             { "zh-TW": "網格鎖點",              "en": "Snap to gridlines" },
  "zt.snapLinesPriority":        { "zh-TW": "線條優先",              "en": "Lines first" },
  "zt.snapGridPoint":            { "zh-TW": "網點鎖點",              "en": "Snap to grid points" },
  "tb.toolActive":               { "zh-TW": " ✓",                    "en": " ✓" },   // suffix
  "tb.toolMulti":                { "zh-TW": "多選",                  "en": "Multi-select" },
  "rb.setOriginCurrent":         { "zh-TW": "本頁 ✓ 全局原點",       "en": "This Page ✓ World Origin" },
  // 列表上方 hint
  "rb.globalJointHintShort":     { "zh-TW": "(尚無全局節點 — 右鍵節點點選「設為全局節點」)", "en": "(No global joints yet — right-click a joint → \"Mark as Global\")" },
  // ── tooltips:只填 "en"(原 HTML 上的長版 zh-TW title 會保留;只在切英文時換成精簡 en) ──
  "tip.btnScaleRuler":     { "en": "Scale ruler: pick two parallel lines, enter real distance" },
  "tip.btnPlaneOrigin":    { "en": "Plane origin: 3 ways — (1) 1 joint selected → use it as origin; (2) no selection → enter bg mode, pick 2 intersecting lines; (3) bg mode with 2 lines selected → use intersection. Same-plane pages auto-align; section cutValues / target page.z auto-resync." },
  "tip.btnCalibrate":      { "en": "Calibrate: apply ruler + origin → real coords" },
  "tip.btnRotate90":       { "en": "Rotate background 90° CW (with joints / members)" },
  "tip.btnBgToggle":       { "en": "Show / hide background" },
  "tip.btnJointVis":       { "en": "Show / hide joints (circles + joint IDs)" },
  "tip.btnMemberVis":      { "en": "Show / hide members (lines + member IDs)" },
  "tip.tool-select":       { "en": "Select mode (Shift+S)" },
  "tip.tool-bgsel":        { "en": "Background mode (Shift+C)" },
  "tip.tool-point":        { "en": "Joint tool (Shift+P)" },
  "tip.tool-line":         { "en": "Member tool (Shift+L)" },
  "tip.btnCrossViewSync":  { "en": "Cross-View Sync (joint creation)" },
  "tip.btnPrewarmBgCache": { "en": "Pre-scan all background intersections" },
  "tip.btnConsolidate":    { "en": "Consolidate: merge / dedup / split" },
  "tip.btnExtendCheck":    { "en": "Check extendable members (current page)" },
  "tip.btnRelayoutCurrent":{ "en": "Re-number joints (current page)" },
  "tip.btnRelayoutMembersCurrent":{ "en": "Re-number members (current page)" },
  "tip.btnSplit":          { "en": "Split page" },
  "tip.btnSectionLink":    { "en": "Section link" },
  "tip.selToolsAll":       { "en": "Select all (Cmd/Ctrl+A)" },
  "tip.selToolsJoints":    { "en": "Select all joints" },
  "tip.selToolsMembers":   { "en": "Select all members" },
  "tip.selToolsRepeatHJ":  { "en": "Repeat joints on same Y" },
  "tip.selToolsRepeatVJ":  { "en": "Repeat joints on same X" },
  "tip.selToolsRepeatOH":  { "en": "Ortho members at same Y" },
  "tip.selToolsRepeatOV":  { "en": "Ortho members at same X" },
  "tip.selToolsRepeatDH":  { "en": "Diag members at same Y" },
  "tip.selToolsRepeatDV":  { "en": "Diag members at same X" },
  "tip.selToolsExtend":    { "en": "Extend member (near end)" },
  "tip.selToolsExtendBoth":{ "en": "Extend member (both ends)" },
  "tip.selToolsJExtH":     { "en": "Extend joint horiz to nearest" },
  "tip.selToolsJExtV":     { "en": "Extend joint vert to nearest" },
  "tip.selToolsJExtHBoth": { "en": "Extend joint both horiz" },
  "tip.selToolsJExtVBoth": { "en": "Extend joint both vert" },
  "tip.selToolsDupJointH": { "en": "Duplicate joint along horiz" },
  "tip.selToolsDupJointV": { "en": "Duplicate joint along vert" },
  "tip.selToolsJConnectH": { "en": "Connect joints horizontally" },
  "tip.selToolsJConnectV": { "en": "Connect joints vertically" },
  "tip.selToolsJConnectD": { "en": "Connect joints diagonally" },
  "tip.selToolsJMerge":    { "en": "Merge two joints to midpoint" },
  "tip.selToolsMeasure":   { "en": "Mark distance (read-only)" },
  "tip.selToolsIntersectSel":{ "en": "Cut intersections in selection" },
  "tip.btnDel":            { "en": "Delete (Shift+D / Del)" },
  "tip.selToolsMove":      { "en": "Move freely (Shift+M)" },
  "tip.selToolsMoveH":     { "en": "Horizontal move" },
  "tip.selToolsMoveV":     { "en": "Vertical move" },
  "tip.selToolsMoveDist":  { "en": "Move by distance" },
  "tip.selToolsMoveAngle": { "en": "Move by angle" },
  "tip.selToolsMoveRect":  { "en": "Move by Δx, Δy" },
};
let _lang = "zh-TW";
export function _t(key) {
  // TDZ-safe:更新函式(updateBgToggleBtn 等)在頁面初始化階段就會呼叫 _t,
  //   此時 _I18N (const) 還在 TDZ。用 try/catch 保護,讓未初始化階段回傳 null
  //   也要保留「空字串」作為合法翻譯(避免 || 把 "" 視為缺失而 fallback 到 zh-TW)
  try {
    const e = _I18N[key];
    if (!e) {
      // 開發者模式:每個未翻譯 key 在 console 警告一次,方便補字典
      if (typeof window !== "undefined" && (window as any).STAAD_I18N_DEBUG) {
        if (!(_t as any)._warned) (_t as any)._warned = {};
        if (!(_t as any)._warned[key]) { (_t as any)._warned[key] = true; console.warn(`[i18n] missing key: ${key}`); }
      }
      return null;
    }
    if (typeof e[_lang] === "string") return e[_lang];        // 允許 ""
    if (typeof e["zh-TW"] === "string") return e["zh-TW"];
    return null;
  } catch (_) { return null; }
}
// _tx(key, fallback):全域便捷 helper —— 沒翻譯就回 fallback,常用於 JS template literal。
//   例: el.textContent = `${_tx("hud.zoom","縮放")}: ${z}%`;
export function _tx(key, fallback) {
  const v = _t(key);
  return (v != null) ? v : (fallback != null ? fallback : "");
}
// _addI18n(entries):動態擴充字典 —— 可在任何時候(包含 lazy-loaded 程式)補翻譯
//   例: _addI18n({ "myArea.x": { "zh-TW": "中文", "en": "English" } });
//   重複 key 直接覆蓋;呼叫後自動 _applyI18n 以套用新值
export function _addI18n(entries) {
  if (!entries || typeof entries !== "object") return;
  try {
    for (const k in entries) {
      if (Object.prototype.hasOwnProperty.call(entries, k)) _I18N[k] = entries[k];
    }
    if (typeof _applyI18n === "function") _applyI18n();
  } catch (e) { console.warn("[i18n] _addI18n failed:", e); }
}
// 全域曝露,讓 popup / devtools / 第三方腳本都能直接呼叫
try {
  if (typeof window !== "undefined") {
    (window as any)._t = _t; (window as any)._tx = _tx; (window as any)._addI18n = _addI18n;
    (window as any)._setLanguage = _setLanguage;
    // 除錯模式 toggle:在 devtools 執行 STAAD_I18N_DEBUG = true 即啟用 missing-key 警告
    if (!("STAAD_I18N_DEBUG" in window)) (window as any).STAAD_I18N_DEBUG = false;
  }
} catch (_) {}
// 動態設定按鈕文字 + i18n 綁定:取代 `btn.textContent = "..."`,保留 .btn-icon、
//   讓語言切換時 _applyI18n 能自動翻譯。fallback 用於 _t 找不到 key 時的 zh-TW 文字。
export function _setBtnLabel(btnOrId, i18nKey, fallback) {
  const btn = (typeof btnOrId === "string") ? document.getElementById(btnOrId) : btnOrId;
  if (!btn) return;
  let span = btn.querySelector(".btn-text");
  if (!span && btn.querySelector(".btn-icon")) {
    // 有 icon 但沒 text span(極少數情況) → 建立
    span = document.createElement("span");
    span.className = "btn-text";
    btn.appendChild(span);
  }
  // 同步 i18n 屬性(每次都覆寫,因為 state 變化會切換不同 key)
  const target = span || btn;
  target.dataset.i18n = i18nKey;
  target.dataset.i18nOrig = fallback;
  const v = (typeof _t === "function") ? _t(i18nKey) : null;
  target.textContent = (v != null) ? v : fallback;
}

export function _applyI18nOnDoc(doc) {
  if (!doc) return;
  // textContent(也記原始文字,讓字典缺 key 時可還原)
  doc.querySelectorAll("[data-i18n]").forEach(el => {
    if (el.dataset.i18nOrig == null) el.dataset.i18nOrig = el.textContent;
    const v = _t(el.dataset.i18n);
    el.textContent = (v != null) ? v : el.dataset.i18nOrig;
  });
  // title 屬性:記下原始 zh-TW 詳細 title;若字典裡有對應 lang 的 tip 就替換,否則還原
  doc.querySelectorAll("[data-i18n-title]").forEach(el => {
    if (el.dataset.i18nTitleOrig == null) el.dataset.i18nTitleOrig = el.title || "";
    const v = _t(el.dataset.i18nTitle);
    el.title = (v != null) ? v : el.dataset.i18nTitleOrig;
  });
  // placeholder 屬性
  doc.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    if (el.dataset.i18nPlaceholderOrig == null) el.dataset.i18nPlaceholderOrig = el.placeholder || "";
    const v = _t(el.dataset.i18nPlaceholder);
    el.placeholder = (v != null) ? v : el.dataset.i18nPlaceholderOrig;
  });
  // innerHTML(用於含 HTML 標記的多段文字,如 .help)
  doc.querySelectorAll("[data-i18n-html]").forEach(el => {
    if (el.dataset.i18nHtmlOrig == null) el.dataset.i18nHtmlOrig = el.innerHTML;
    const v = _t(el.dataset.i18nHtml);
    el.innerHTML = (v != null) ? v : el.dataset.i18nHtmlOrig;
  });
}
export function _applyI18n() {
  _applyI18nOnDoc(document);
  // 同步翻譯所有開啟中的 popup 視窗(search / material mgr / 3D 預覽 / 等等)
  try { if (typeof _searchWin     !== "undefined" && _searchWin     && !_searchWin.closed)     _applyI18nOnDoc(_searchWin.document); } catch (_) {}
  try { if (typeof _materialMgrWin!== "undefined" && _materialMgrWin&& !_materialMgrWin.closed)_applyI18nOnDoc(_materialMgrWin.document); } catch (_) {}
  try { if (typeof _3dPreviewWindow!== "undefined" && _3dPreviewWindow && _3dPreviewWindow.win && !_3dPreviewWindow.win.closed) _applyI18nOnDoc(_3dPreviewWindow.win.document); } catch (_) {}
  // submenu 勾選符號
  const langMap = { "zh-TW": "lang-zh", "en": "lang-en" };
  document.querySelectorAll("#langMenu .submenu .menu-entry").forEach(e => {
    e.classList.toggle("checked", (e as HTMLElement).dataset.action === langMap[_lang]);
  });
}
export function _setLanguage(lang) {
  _lang = (lang === "en") ? "en" : "zh-TW";
  try { localStorage.setItem(_LANG_KEY, _lang); } catch (_) {}
  _applyI18n();
  // 觸發重新渲染:讓動態組裝的字串(stats、joint/member 列表、HUD 訊息 等)立即套新語言
  try { if (typeof refreshLists === "function") refreshLists(); } catch (_) {}
  try { if (typeof render === "function") render(); } catch (_) {}
  // 重跑會 textContent override 的按鈕更新函式,讓它們依新語言重畫文字
  try { if (typeof updateBgToggleBtn === "function") updateBgToggleBtn(); } catch (_) {}
  try { if (typeof updateLblToggleBtn === "function") updateLblToggleBtn(); } catch (_) {}
  try { if (typeof updateCrossViewSyncBtn === "function") updateCrossViewSyncBtn(); } catch (_) {}
  try { if (typeof updateScaleRulerButton === "function") updateScaleRulerButton(); } catch (_) {}
  try { if (typeof updatePlaneOriginButton === "function") updatePlaneOriginButton(); } catch (_) {}
  try { if (typeof updateCalibrateButton === "function") updateCalibrateButton(); } catch (_) {}
  try { if (typeof updateSnapGridBtn === "function") updateSnapGridBtn(); } catch (_) {}
  try { if (typeof updateJointVisBtn  === "function") updateJointVisBtn();  } catch (_) {}
  try { if (typeof updateMemberVisBtn === "function") updateMemberVisBtn(); } catch (_) {}
  try { if (typeof updateSelectToolLabel === "function") updateSelectToolLabel(); } catch (_) {}
  // updatePageSelector 從未在 legacy export,改用 refreshPageSelector 已足夠(下面那行)
  try { if (typeof (globalThis as any).updatePageSelector === "function") (globalThis as any).updatePageSelector(); } catch (_) {}
  try { if (typeof refreshPageSelector === "function") refreshPageSelector(); } catch (_) {}
  try { if (typeof refreshFileList === "function") refreshFileList(); } catch (_) {}
  try { if (typeof _setToolFinishVisuals === "function" && typeof state !== "undefined") _setToolFinishVisuals(state.tool); } catch (_) {}
  // 空白底圖提示:只有在尚未載入任何檔案時才重畫
  try {
    const hasFiles = typeof state !== "undefined" && Array.isArray(state.files) && state.files.some(f => f && (f.pdf || f.image || f.cachedBgSvg || f.cachedBgImg));
    if (!hasFiles && typeof paintEmptyCanvasMessage === "function") paintEmptyCanvasMessage();
  } catch (_) {}
  // 防御性:直接更新 stats badge,避免 render() 沒被觸發或被其他流程蓋掉
  try {
    const el = document.getElementById("stats");
    if (el && typeof getPage === "function" && typeof state !== "undefined") {
      const p = getPage();
      const J = _t("dyn.joints") || "節點";
      const M = _t("dyn.members") || "桿件";
      const PP = _t("dyn.pageOrdinalPrefix") || "";
      const PS = _t("dyn.pageOrdinalSuffix") || "";
      el.textContent = `${p.joints.length} ${J} · ${p.members.length} ${M} · ${PP} ${(state.pageIdx||0)+1} ${PS}`.replace(/\s+/g," ").trim();
    }
  } catch (_) {}
}
// Phase 8b 註記:原本的 _initLang IIFE 已搬回 legacy.ts 對應位置,理由是 ES module 載入順序:
//   i18n module 在 legacy.ts 解析 import 時就會跑完整個 body(包含 IIFE),這比 legacy
//   原本初始化 DOM / module-level state 還早,_setLanguage 中的 refreshLists/render/各種
//   update*Btn 會在 state 還沒完成初始化時被呼叫(雖然有 try/catch 保護不會 crash,但效果不對等)。
//   保留 _initLang 名稱以利搜尋,實作交回 legacy.ts。
// localStorage 取出語言喜好的初始化邏輯:
export function readSavedLang(): "zh-TW" | "en" {
  let saved: "zh-TW" | "en" = "zh-TW";
  try { const v = localStorage.getItem(_LANG_KEY); if (v === "zh-TW" || v === "en") saved = v; } catch (_) {}
  return saved;
}
