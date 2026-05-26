// @ts-nocheck
// Phase 8l — 搜尋 popup(Cmd+F):桿件 / 節點 + 方向 / 範圍 + 編號 + 檔案頁面
//   獨立 browser popup;點搜尋結果可 zoom 主畫面 canvas + 3D 預覽視窗(如已開)。
//   包含 _searchModel(實際搜尋邏輯)與 _renderSearchResults(結果 UI)。
//
//   依賴(全部已 export):
//     legacy: $ / state / _searchWin / setSearchWin / setSearchWinAutofill /
//             getActiveFile / displayMemberId / pushUndo / refreshLists / render /
//             activatePageWithBusy / _zoomMainCanvasToRect / _searchMaterialDropdownRefresh(window 級)
//     core/displayId: _displayIdForJointWith
//     core/projection: joint2DToWorld3D
//     core/rankCache: _worldForRank
//     i18n: _t / _applyI18nOnDoc
//     dialogs/materialMgr: openMaterialMgrWindow

import {
  $, state, _searchWin, setSearchWin, setSearchWinAutofill,
  getActiveFile, displayMemberId, pushUndo, refreshLists, render,
  activatePageWithBusy, _zoomMainCanvasToRect,
  _3dPreviewWindow,
} from "../legacy";
import { _displayIdForJointWith } from "../core/displayId";
import { joint2DToWorld3D } from "../core/projection";
import { _worldForRank } from "../core/rankCache";
import { _t, _applyI18nOnDoc } from "../i18n";
import { openMaterialMgrWindow } from "./materialMgr";

// ===== 搜尋(Cmd+F):桿件 / 節點 + 方向 / 範圍 + 編號 + 檔案頁面 =====
//   獨立 browser popup;點搜尋結果可 zoom 主畫面 canvas + 3D 預覽視窗(如已開)
// 已開啟的 search popup 的「依目前主畫面選取重新填入編號」函式;每次 popup 建立時設定,close 時清空
// 搜尋歷史:桿件 / 節點 分開,各保留最近 50 筆(localStorage 跨 session 保存)
const _SEARCH_HIST_KEY = {
  member:   "staad.searchHistory.member",
  joint:    "staad.searchHistory.joint",
  material: "staad.searchHistory.material",
};
const _SEARCH_HIST_MAX = 50;
function _loadSearchHistory(type) {
  try {
    const raw = localStorage.getItem(_SEARCH_HIST_KEY[type]);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === "string" && s) : [];
  } catch (_) { return []; }
}
function _pushSearchHistory(type, value) {
  const v = String(value || "").trim();
  if (!v) return;                       // 空字串(= 全部)不記錄
  const cur = _loadSearchHistory(type).filter(s => s !== v);   // 去重(舊的位置移除)
  cur.unshift(v);                       // 最新放最前面
  if (cur.length > _SEARCH_HIST_MAX) cur.length = _SEARCH_HIST_MAX;
  try { localStorage.setItem(_SEARCH_HIST_KEY[type], JSON.stringify(cur)); } catch (_) {}
}
function _renderHistDatalist(doc, dl, list) {
  if (!dl) return;
  dl.innerHTML = "";
  for (const v of list) {
    const opt = doc.createElement("option");
    opt.value = v;
    dl.appendChild(opt);
  }
}
export function openSearchWindow() {
  // 已有 popup → focus 並依「目前主畫面選取」重新覆蓋編號(讓使用者在主畫面換選之後再按 Cmd+F 可直接帶入)
  //   主畫面 / 3D 預覽 Cmd+F 都會走到這裡,行為一致
  if (_searchWin && !_searchWin.closed) {
    try { _searchWin.focus(); } catch (_) {}
    try { _searchWinAutofill && _searchWinAutofill(); } catch (_) {}
    return;
  }
  // 視窗 features 與 3D 預覽視窗一致(只差大小):有 popup=yes + width/height + scrollbars + resizable,
  //   Chrome 會用獨立 popup window 開啟而不是新分頁;left/top 會觸發某些版本的 tab 啟發式 → 移除
  const _scrW = Math.max(640, Math.floor((window.screen && window.screen.availWidth)  || 1280) * 0.8);
  const _scrH = Math.max(540, Math.floor((window.screen && window.screen.availHeight) || 800)  * 0.8);
  const popupFeatures = `popup=yes,width=${_scrW},height=${_scrH},scrollbars=no,resizable=yes`;
  const win = window.open("", "STAAD_Search_" + Date.now(), popupFeatures);
  if (!win) { alert("彈出視窗被擋住,請允許彈窗"); return; }
  setSearchWin(win);
  win.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head>
<title>搜尋 - STAAD</title><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 12px; background: #0a0b0d; color: #ddd;
    font-family: -apple-system, system-ui, "Microsoft JhengHei", sans-serif; font-size: 12px;
    display: flex; flex-direction: column; box-sizing: border-box; }
  h3 { font-size: 11px; margin: 8px 0 3px; color: #9bb6e8; font-weight: 700; }
  h3.collapsible { cursor: pointer; user-select: none; }
  h3.collapsible:hover { color: #cfe2ff; }
  h3.collapsible .ca-tri { display: inline-block; width: 12px; text-align: center; color: #9aa0a6; font-size: 9px; margin-right: 2px; }
  input, select, button { background: #1a1c20; color: #ddd; border: 1px solid #444;
    padding: 4px 6px; font-size: 12px; border-radius: 3px; font-family: inherit; }
  input[type=text] { width: 100%; }
  select { width: 100%; }
  button { background: #2a2c30; cursor: pointer; padding: 5px 12px; }
  button:hover { background: #33363a; }
  button.primary { background: #4f9dff; border-color: #4f9dff; color: #fff; }
  .row { display: flex; gap: 8px; align-items: center; margin: 3px 0; }
  .opts { flex-wrap: wrap; gap: 3px 10px; }
  .opts label { font-size: 12px; cursor: pointer; }
  .opts input[type=radio] { margin-right: 3px; vertical-align: middle; }
  #results { margin-top: 8px; padding: 6px 8px; background: #16181c;
    border: 1px solid #333; border-radius: 3px;
    flex: 1 1 0; min-height: 120px; overflow: auto;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px; line-height: 1.55; }
  .group-title { color: #ffd23f; margin: 4px 0 2px; }
  .res-row { display: flex; gap: 6px; align-items: center; padding: 2px 0;
    border-bottom: 1px solid #1f2126; cursor: pointer; user-select: none; }
  .res-row:hover { background: rgba(255,255,255,0.05); }
  .res-row.all-sel { background: rgba(79,157,255,0.14); }
  .res-row.all-sel:hover { background: rgba(79,157,255,0.22); }
  .res-row .gr-toggle { display: inline-block; width: 14px; text-align: center;
    color: #9aa0a6; cursor: pointer; user-select: none; font-size: 10px; flex-shrink: 0; }
  .res-row .gr-toggle:hover { color: #fff; }
  .jump { color: #9bb6e8; text-decoration: underline; cursor: pointer; }
  .jump:hover { color: #fff; }
  /* === 材料工具列(搜尋結果上方) === */
  .mat-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    padding: 6px 8px; background: #1a1c20; border: 1px solid #333;
    border-radius: 3px; margin: 4px 0 6px; position: sticky; top: 0; z-index: 5; }
  .mat-toolbar .mt-label { color: #9bb6e8; font-weight: 700; font-size: 11px; }
  .mat-toolbar input[type=text] { flex: 1 1 160px; min-width: 120px; width: auto; }
  .mat-toolbar button { padding: 4px 8px; font-size: 11px; }
  .mat-toolbar .mt-sep { color: #555; }
  .mat-toolbar .mt-info { margin-left: auto; color: #ffd23f; font-weight: 700; font-size: 11px; }
  /* 材料 combobox(輸入 + 下拉 filter,讀自 state.materials) */
  .mat-combo-wrap { position: relative; flex: 1 1 200px; min-width: 160px; }
  .mat-combo-wrap input[type=text] { width: 100%; padding-right: 22px; }
  .mat-combo-caret { position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    color: #9aa0a6; font-size: 10px; pointer-events: none; user-select: none; }
  .mat-combo-menu { position: absolute; top: 100%; left: 0; right: 0; margin-top: 2px;
    max-height: 260px; overflow-y: auto;
    background: #1a1c20; border: 1px solid #4f9dff; border-radius: 4px;
    padding: 4px; z-index: 30; box-shadow: 0 6px 18px rgba(0,0,0,0.55); }
  .mat-combo-item { padding: 4px 10px; font-size: 11px; color: #cfd3d8; cursor: pointer;
    border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mat-combo-item:hover, .mat-combo-item.active { background: #2f4a78; color: #fff; }
  .mat-combo-item .note { color: #9aa0a6; font-size: 10px; margin-left: 6px; }
  .mat-combo-item.active .note,
  .mat-combo-item:hover .note { color: #cfe2ff; }
  .mat-combo-empty { padding: 6px 10px; color: #7b818a; font-size: 11px; font-style: italic; }
  .mat-combo-empty a { color: #9bb6e8; cursor: pointer; text-decoration: underline; }
  .mat-combo-empty a:hover { color: #fff; }
  /* === Excel-style 結果表 === */
  .res-table { border-collapse: collapse;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10.5px; margin: 2px 0 8px 12px;
    border: 1px solid #2a2d33; width: calc(100% - 12px); }
  .res-table caption { caption-side: top; text-align: left;
    color: #9aa0a6; font-size: 10px; padding: 2px 4px; font-family: inherit; }
  .res-table th { background: #1d2025; color: #aab; text-align: left;
    padding: 3px 6px; font-weight: 700; border-bottom: 1px solid #333;
    white-space: nowrap; }
  .res-table td { padding: 2px 6px; border-bottom: 1px solid #1f2126;
    color: #cfd3d8; white-space: nowrap; }
  .res-table tbody tr:nth-child(even) td { background: rgba(255,255,255,0.025); }
  .res-table.member-tbl tbody tr { cursor: pointer; user-select: none; }
  .res-table.member-tbl tbody tr:hover td { background: rgba(79,157,255,0.10); }
  .res-table.member-tbl tbody tr.sel td { background: rgba(79,157,255,0.28); color: #fff; }
  .res-table.member-tbl tbody tr.sel:hover td { background: rgba(79,157,255,0.36); }
  .res-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .res-table .col-mid { color: #6fb3ff; font-weight: 700; }
  .res-table .col-jid { color: #ff7676; font-weight: 700; }
  .res-table .col-jid.anchor { color: #ff8c00; }
  .res-table .col-mat { color: #b8e986; }
  .res-table .col-dir { color: #c8d2dc; text-align: center; }
  .res-table.member-tbl tbody tr.sel .col-mid,
  .res-table.member-tbl tbody tr.sel .col-jid,
  .res-table.member-tbl tbody tr.sel .col-mat { color: #fff; }
  .res-table .anchor-mark { color: #ff8c00; margin-left: 3px; }
  /* 合併表:節點 / 桿件 / 端點(縮排) */
  .res-table .endpoint-id { padding-left: 18px; font-weight: 500; opacity: 0.92; }
  .res-table .muted { color: #555; }
  .res-table tbody tr.member-row { cursor: pointer; user-select: none; }
  .res-table tbody tr.endpoint-row td,
  .res-table tbody tr.joint-row td { background: rgba(255,255,255,0.02); }
  .res-table tbody tr.member-row:hover td { background: rgba(79,157,255,0.10); }
  .res-table tbody tr.member-row.sel td { background: rgba(79,157,255,0.28); color: #fff; }
  .res-table tbody tr.member-row.sel:hover td { background: rgba(79,157,255,0.36); }
  /* === 多選清單(平面 / 頁面):checkbox + 反白 === */
  .ms-section { margin-top: 4px; border: 1px solid #2a2d33; border-radius: 3px; background: #16181c; }
  .ms-head { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-bottom: 1px solid #2a2d33; }
  .ms-title { font-size: 11px; color: #9bb6e8; font-weight: 700; }
  .ms-hint  { font-size: 10px; color: #7b818a; font-weight: 400; margin-left: 4px; }
  .ms-clear { font-size: 10px; padding: 2px 6px; }
  .ms-list  { max-height: 110px; overflow-y: auto; padding: 2px 0; }
  .ms-row   { display: flex; align-items: center; gap: 6px; padding: 2px 8px; cursor: pointer; font-size: 11px;
              user-select: none; color: #cfd3d8; }
  .ms-row:hover { background: rgba(255,255,255,0.05); }
  .ms-row input[type=checkbox] { margin: 0; flex-shrink: 0; }
  .ms-row.checked { background: rgba(79,157,255,0.20); color: #fff; }
  .ms-row.checked:hover { background: rgba(79,157,255,0.28); }
  .ms-list-empty { padding: 6px 10px; color: #7b818a; font-size: 10.5px; font-style: italic; }
  /* === 篩選 modal === */
  #filterDialog { position: fixed; inset: 0; z-index: 50; }
  #filterDialog .fd-mask { position: absolute; inset: 0; background: rgba(0,0,0,0.6); }
  #filterDialog .fd-box { position: relative; margin: 80px auto 0; max-width: 380px;
    background: #1a1c20; border: 1px solid #4f9dff; border-radius: 4px; padding: 14px 16px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.6); }
  #filterDialog .fd-row { margin: 8px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  #filterDialog .fd-label { color: #9bb6e8; font-weight: 700; width: 80px; }
  #filterDialog .fd-actions { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
  #btnFilter.has-active { background: #4f9dff; color: #fff; border-color: #4f9dff; }
  /* === 按鈕樣式 toggle + 區塊佈局 === */
  .top-panel { background: #0d0f12; border: 1px solid #2a2d33; border-radius: 4px;
    padding: 6px 8px; margin-bottom: 6px; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.35); }
  .top-panel.searched .collapsible-when-done { display: none; }   /* 搜尋後收合部分區塊 */
  .block { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 4px 0; border-bottom: 1px dashed #1f2126; }
  .block:last-child { border-bottom: none; }
  .block-label { color: #9bb6e8; font-weight: 700; font-size: 11px; flex-shrink: 0; min-width: 64px; }
  .bg-btn-group { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .bg-btn { display: inline-flex; align-items: center; padding: 3px 10px;
    background: #1a1c20; border: 1px solid #444; border-radius: 4px;
    cursor: pointer; user-select: none; font-size: 11px; color: #cfd3d8;
    transition: background 0.08s, border-color 0.08s, color 0.08s; white-space: nowrap; }
  .bg-btn:hover { background: #2a2d33; border-color: #555; color: #fff; }
  .bg-btn input { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }
  .bg-btn.checked { background: #2f4a78; border-color: #4f9dff; color: #fff; font-weight: 700;
    box-shadow: 0 0 0 1px rgba(79,157,255,0.3) inset; }
  .bg-btn.checked:hover { background: #3a5a90; }
  /* ID 編號區:在搜尋按鈕上方,獨立一區、寬度滿版 */
  .id-block { flex-direction: column; align-items: stretch; gap: 4px; }
  .id-block .id-row { display: flex; gap: 6px; align-items: stretch; }
  .id-block textarea { flex: 1; width: 100%; padding: 6px 8px; font-size: 13px;
    background: #1a1c20; color: #ddd; border: 1px solid #444; border-radius: 3px;
    font-family: inherit; resize: vertical; min-height: 36px; max-height: 200px;
    /* 只在 whitespace 處換行,不會把編號斷在中間;沒有空白時自動橫向滾動 */
    white-space: pre-wrap; word-break: normal; overflow-wrap: normal; line-height: 1.4; }
  .id-block textarea:focus { outline: none; border-color: #4f9dff; }
  .id-hist-btn { padding: 4px 10px; font-size: 11px; align-self: stretch; white-space: nowrap; }
  .id-hist-menu { position: absolute; right: 0; top: 100%; margin-top: 2px;
    min-width: 240px; max-width: 480px;
    background: #1a1c20; border: 1px solid #4f9dff; border-radius: 4px; padding: 4px;
    z-index: 30; box-shadow: 0 6px 18px rgba(0,0,0,0.55);
    max-height: 280px; overflow-y: auto; }
  .id-hist-row { padding: 3px 8px; font-size: 11px; color: #cfd3d8; cursor: pointer;
    border-radius: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .id-hist-row:hover { background: #2a2d33; color: #fff; }
  .id-hist-empty { padding: 6px 8px; color: #7b818a; font-size: 11px; font-style: italic; }
  /* 限定平面 / 頁面:用 bg-btn 排列 */
  #fileList .bg-btn { font-size: 10.5px; padding: 2px 8px; }
  .ms-list-empty { padding: 4px 8px; color: #7b818a; font-size: 11px; font-style: italic; }
  /* === 搜尋對象:大顆按鈕(用 .bg-btn-lg 變體;沿用 .bg-btn 的 .checked 反白邏輯) === */
  .bg-btn-lg { padding: 8px 24px !important; font-size: 14px !important;
    border-radius: 6px !important; font-weight: 700 !important; min-width: 80px; justify-content: center; }
  .bg-btn-group-lg { gap: 8px; }
  /* === 2-column 區塊佈局(展開時) === */
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
  .col { display: flex; flex-direction: column; gap: 0; min-width: 0; }
  /* === 頁面 dropdown === */
  .dropdown-wrap { position: relative; display: inline-block; }
  .dropdown-toggle { padding: 3px 10px; background: #1a1c20; border: 1px solid #444;
    border-radius: 4px; cursor: pointer; user-select: none; font-size: 11px; color: #cfd3d8;
    transition: background 0.08s, border-color 0.08s, color 0.08s; }
  .dropdown-toggle:hover { background: #2a2d33; border-color: #555; color: #fff; }
  .dropdown-toggle.has-sel { background: #2f4a78; border-color: #4f9dff; color: #fff; font-weight: 700; }
  .dropdown-menu { position: absolute; top: 100%; left: 0; margin-top: 4px;
    min-width: 240px; max-width: 380px;
    background: #1a1c20; border: 1px solid #4f9dff; border-radius: 4px;
    padding: 6px; z-index: 30; box-shadow: 0 6px 18px rgba(0,0,0,0.55); }
  .dropdown-menu .dm-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
    padding-bottom: 4px; border-bottom: 1px solid #2a2d33; font-size: 11px; color: #9bb6e8;
    font-weight: 700; }
  .dropdown-menu #fileList { display: flex; flex-direction: column; gap: 2px; align-items: stretch;
    max-height: 280px; overflow-y: auto; padding: 2px 0; }
  .dropdown-menu #fileList .bg-btn { justify-content: flex-start; padding: 4px 8px; font-size: 11px; white-space: normal; }
  /* === 凸出於設定區塊下方的「展開設定 / 收起設定」按鈕 === */
  .top-panel { position: relative; padding-bottom: 14px; margin-bottom: 14px; }
  .panel-toggle { position: absolute; bottom: -12px; left: 50%; transform: translateX(-50%);
    padding: 2px 22px; background: #2a2d33; border: 1px solid #444; border-top: none;
    border-radius: 0 0 8px 8px; cursor: pointer; user-select: none; font-size: 11px;
    color: #ddd; z-index: 5; white-space: nowrap;
    transition: background 0.08s, color 0.08s; }
  .panel-toggle:hover { background: #353940; color: #fff; border-color: #555; }
  .top-panel.searched .panel-toggle { background: #2f4a78; color: #fff; border-color: #4f9dff; }
</style></head><body></body></html>`);
  win.document.close();
  const doc = win.document;
  const body = doc.body;
  body.innerHTML = `
    <div class="top-panel" id="topPanel">
      <!-- 搜尋對象:大顆按鈕 -->
      <div class="block collapsible-when-done">
        <span class="block-label" data-i18n="search.target">搜尋對象:</span>
        <div class="bg-btn-group bg-btn-group-lg">
          <label class="bg-btn bg-btn-lg checked"><input type="radio" name="searchType" value="member" checked><span data-i18n="search.tab.member">桿件</span></label>
          <label class="bg-btn bg-btn-lg"><input type="radio" name="searchType" value="joint"><span data-i18n="search.tab.joint">節點</span></label>
          <label class="bg-btn bg-btn-lg" title="依「材料名稱」搜尋桿件"><input type="radio" name="searchType" value="material"><span data-i18n="search.tab.material">材料</span></label>
        </div>
      </div>
      <div class="cols collapsible-when-done">
        <div class="col col-l">
          <div class="block" data-role="memberSection" style="border-bottom:none">
            <span class="block-label" data-i18n="search.memberScope">桿件範圍:</span>
            <div class="bg-btn-group">
              <label class="bg-btn checked"><input type="radio" name="memberScope" value="single" checked><span data-i18n="search.member.single">單條</span></label>
              <label class="bg-btn" title="連續關聯 + 同方向"><input type="radio" name="memberScope" value="line"><span data-i18n="search.member.line">整條</span></label>
              <label class="bg-btn" title="端點關聯桿件(含本身)"><input type="radio" name="memberScope" value="endpoint-adj"><span data-i18n="search.member.endpointAdj">端點關聯</span></label>
              <label class="bg-btn" title="只回傳兩端節點,不顯示桿件本身"><input type="checkbox" id="onlyJoints"><span data-i18n="search.member.onlyJoints">只要節點</span></label>
            </div>
          </div>
          <div class="block" data-role="jointSection" style="border-bottom:none">
            <span class="block-label" data-i18n="search.jointScope">節點範圍:</span>
            <div class="bg-btn-group">
              <label class="bg-btn checked"><input type="checkbox" name="scope" value="single" checked><span data-i18n="search.joint.single">單點</span></label>
              <label class="bg-btn" title="X 軸方向(自動加入 XZ 平面)"><input type="checkbox" name="scope" value="axis-x"><span data-i18n="search.joint.axisX">X 軸</span></label>
              <label class="bg-btn" title="Y 軸方向(自動加入 XY 平面)"><input type="checkbox" name="scope" value="axis-y"><span data-i18n="search.joint.axisY">Y 軸</span></label>
              <label class="bg-btn" title="Z 軸方向(自動加入 XZ 平面)"><input type="checkbox" name="scope" value="axis-z"><span data-i18n="search.joint.axisZ">Z 軸</span></label>
              <label class="bg-btn" title="相鄰斜撐(自動加入 XY 平面)"><input type="checkbox" name="scope" value="diag-adj"><span data-i18n="search.joint.diag">相鄰斜撐</span></label>
            </div>
          </div>
        </div>
        <div class="col col-r">
          <div class="block" style="border-bottom:none">
            <span class="block-label" data-i18n="search.resultInclude">結果包含:</span>
            <div class="bg-btn-group">
              <label class="bg-btn" title="節點搜尋時,將「節點 + 連接的桿件」一併列出"><input type="checkbox" id="incMembers" data-mem-combo><span data-i18n="search.incMembers">含桿件</span></label>
              <label class="bg-btn checked" title="與「含桿件」相同的資料,但顯示時隱藏獨立的節點列"><input type="checkbox" id="onlyMembers" data-mem-combo checked><span data-i18n="search.onlyMembers">只有桿件</span></label>
            </div>
          </div>
          <div class="block" style="border-bottom:none">
            <span class="block-label" data-i18n="search.limitPlane">限定平面:</span>
            <div class="bg-btn-group" id="planeList">
              <label class="bg-btn" data-val="XY"><input type="checkbox" value="XY">XY</label>
              <label class="bg-btn" data-val="YZ"><input type="checkbox" value="YZ">YZ</label>
              <label class="bg-btn" data-val="XZ"><input type="checkbox" value="XZ">XZ</label>
            </div>
            <button id="planeClearBtn" class="ms-clear" data-i18n="search.clear" title="取消所有平面選擇">清</button>
            <div class="dropdown-wrap" style="margin-left:6px">
              <button id="fileDropdownToggle" class="dropdown-toggle" type="button" data-i18n="search.pages.all" title="頁面多選(依平面類型過濾)">頁面: 全部 ▾</button>
              <div id="fileDropdownMenu" class="dropdown-menu" style="display:none">
                <div class="dm-head">
                  <span>頁面(依平面過濾)</span>
                  <span style="flex:1"></span>
                  <button id="fileClearBtn" class="ms-clear" title="取消所有頁面選擇">取消選擇</button>
                </div>
                <div id="fileList" class="bg-btn-group"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="block id-block" data-role="memberSection">
        <span class="block-label" data-i18n="search.idMember">桿件編號:</span>
        <div class="id-row" style="position:relative">
          <textarea id="memberIdInput" rows="2" data-i18n-placeholder="search.placeholder.id" placeholder="逗號 / 空白 / 換行分隔(可直接從 Excel 貼一整欄),留空 = 全部"></textarea>
          <button class="id-hist-btn" data-hist-target="memberIdInput" data-hist-type="member" data-i18n="search.histBtn" type="button" title="最近 50 筆桿件搜尋紀錄">歷史 ▾</button>
        </div>
      </div>
      <div class="block id-block" data-role="jointSection">
        <span class="block-label" data-i18n="search.idJoint">節點編號:</span>
        <div class="id-row" style="position:relative">
          <textarea id="jointIdInput" rows="2" data-i18n-placeholder="search.placeholder.id" placeholder="逗號 / 空白 / 換行分隔(可直接從 Excel 貼一整欄),留空 = 全部"></textarea>
          <button class="id-hist-btn" data-hist-target="jointIdInput" data-hist-type="joint" data-i18n="search.histBtn" type="button" title="最近 50 筆節點搜尋紀錄">歷史 ▾</button>
        </div>
      </div>
      <div class="block id-block" data-role="materialSection">
        <span class="block-label" data-i18n="search.idMaterial">材料名稱:</span>
        <div class="id-row" style="position:relative">
          <div class="mat-combo-wrap" style="flex:1;min-width:0">
            <input type="text" id="materialIdInput" autocomplete="off" data-i18n-placeholder="search.placeholder.material" placeholder="點此選擇 / 輸入字串 filter(留空 = 所有「有材料設定」的桿件)">
            <span class="mat-combo-caret">▾</span>
            <div id="materialIdComboMenu" class="mat-combo-menu" style="display:none"></div>
          </div>
          <button class="id-hist-btn" data-hist-target="materialIdInput" data-hist-type="material" data-i18n="search.histBtn" type="button" title="最近 50 筆材料搜尋紀錄">歷史 ▾</button>
        </div>
      </div>
      <!-- 搜尋按鈕列 -->
      <div class="block" style="border-bottom:none;padding-top:6px">
        <button id="btnSearch" class="primary" data-i18n="search.btnSearch" title="編號區內可按 Cmd/Ctrl + Enter 直接搜尋(textarea 內單按 Enter 為換行)">搜尋 (Enter)</button>
        <button id="btnClear" data-i18n="search.btnClear">清除</button>
        <button id="btnFilter" data-i18n="search.btnFilter" title="結果篩選(目前支援:依材料設定)">篩選 ⚙</button>
        <button id="btnClearHist" data-i18n="search.btnClearHist" title="清除目前模式的搜尋歷史(節點 / 桿件 分開)">清除歷史</button>
        <span style="flex:1"></span>
        <span data-i18n="search.escClose" style="color:#888;font-size:10px">Esc 關閉</span>
      </div>
      <button id="panelToggleBtn" class="panel-toggle" type="button" title="切換搜尋條件區塊的展開 / 收起">▲ 收起設定</button>
    </div>
    <div id="results" data-i18n="search.noResult">尚未搜尋</div>
    <div id="filterDialog" style="display:none">
      <div class="fd-mask"></div>
      <div class="fd-box">
        <h3 style="margin-top:0;color:#9bb6e8">結果篩選</h3>
        <div class="fd-row">
          <span class="fd-label">材料設定:</span>
          <label><input type="radio" name="fltMat" value="any" checked> 不限</label>
          <label><input type="radio" name="fltMat" value="has"> 有材料</label>
          <label><input type="radio" name="fltMat" value="none"> 無材料</label>
        </div>
        <div class="fd-row">
          <span class="fd-label">指定材料:</span>
          <input type="text" id="fltMatName" list="fltMatNameList" autocomplete="off" style="flex:1;min-width:160px" placeholder="留空 = 不指定;選 / 輸入後,結果只保留此材料的桿件">
          <datalist id="fltMatNameList"></datalist>
        </div>
        <div class="ms-hint" style="margin-left:4px">(指定材料 ≠ 空字串時優先生效;只影響桿件列,節點不受影響)</div>
        <div class="fd-actions">
          <button id="filterReset">重置為不限</button>
          <span style="flex:1"></span>
          <button id="filterCancel">取消</button>
          <button id="filterApply" class="primary">套用</button>
        </div>
      </div>
    </div>
  `;
  // === 全域 toggle 同步:.bg-btn 與 .tab 兩種樣式都共用 .checked class ===
  //   radio 群組會自動互斥,需要在 change 事件遍歷整個群組 sync
  const _BG_SEL = ".bg-btn, .tab";
  const _syncBgBtn = (lab) => {
    const inp = lab.querySelector("input");
    if (!inp) return;
    lab.classList.toggle("checked", !!inp.checked);
  };
  body.addEventListener("change", (e) => {
    const inp = e.target;
    if (!inp || !inp.matches || !inp.matches("input")) return;
    const lab = inp.closest(_BG_SEL);
    if (lab) _syncBgBtn(lab);
    // radio:同名 group 內其他 button 也需 sync
    if (inp.type === "radio" && inp.name) {
      body.querySelectorAll(`input[type=radio][name="${inp.name}"]`).forEach(rr => {
        const l = rr.closest(_BG_SEL);
        if (l) _syncBgBtn(l);
      });
    }
  });
  // 初始化:依目前 input 狀態同步一次
  body.querySelectorAll(_BG_SEL).forEach(_syncBgBtn);

  // === 平面 / 頁面 多選清單 ===
  const planeList = body.querySelector("#planeList");
  const fileList  = body.querySelector("#fileList");
  const _getChecked = (listEl) => Array.from(listEl.querySelectorAll("input[type=checkbox]:checked")).map(i => i.value);
  // 依 planeList 的勾選過濾 fileList;保留已勾選且仍可見的 file。用 .bg-btn 樣式
  const _rebuildFileList = () => {
    const planes = new Set(_getChecked(planeList));
    const prevChecked = new Set(_getChecked(fileList));
    fileList.innerHTML = "";
    const showAll = planes.size === 0;
    const matched = state.files.filter(f => {
      if (showAll) return true;
      const pgs = Object.values(f.pages || {});
      return pgs.some(pg => pg && !pg._orphan && pg.plane && planes.has(pg.plane));
    });
    if (!matched.length) {
      const empty = doc.createElement("div");
      empty.className = "ms-list-empty";
      empty.textContent = planes.size ? "沒有符合所選平面的頁面" : "尚未載入任何頁面";
      fileList.appendChild(empty);
      return;
    }
    for (const f of matched) {
      const mainPg = (f.pages && f.pages[0]) || null;
      const tag = mainPg ? ` (${mainPg.plane || "?"}${Number.isFinite(mainPg.z) ? `, z=${mainPg.z}` : ""})` : "";
      const lab = doc.createElement("label");
      lab.className = "bg-btn";
      lab.dataset.val = String(f.id);
      const cb = doc.createElement("input");
      cb.type = "checkbox";
      cb.value = String(f.id);
      if (prevChecked.has(String(f.id))) { cb.checked = true; lab.classList.add("checked"); }
      lab.appendChild(cb);
      lab.appendChild(doc.createTextNode(`${f.name}${tag}`));
      fileList.appendChild(lab);
    }
    // 重建後也通知 dropdown toggle 更新數量(TDZ 安全:首次呼叫時 _updateFileToggleLabel 尚未宣告 → try/catch 略過)
    try { _updateFileToggleLabel(); } catch (_) {}
  };
  _rebuildFileList();
  // 平面改變 → 重建 file list(保留 file 勾選交集) + 平面 button 自身的反白由全域 sync 處理
  planeList.addEventListener("change", _rebuildFileList);
  // 取消選擇 按鈕
  body.querySelector("#planeClearBtn").addEventListener("click", () => {
    planeList.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = false; cb.closest(".bg-btn").classList.remove("checked"); });
    _rebuildFileList();
  });
  body.querySelector("#fileClearBtn").addEventListener("click", () => {
    fileList.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.checked = false; cb.closest(".bg-btn").classList.remove("checked"); });
    try { _updateFileToggleLabel(); } catch (_) {}
  });

  // 方向 ↔ 平面類型 自動同步
  //   axis-y / diag-adj → XY;axis-x / axis-z → XZ
  //   勾選方向 → 加入對應平面;取消方向 → 若沒有其它仍勾選的方向也對應同一個平面,就一併取消
  const _dirToPlane = { "axis-y": "XY", "diag-adj": "XY", "axis-x": "XZ", "axis-z": "XZ" };
  const _setPlaneChecked = (plane, checked) => {
    const pcb = planeList.querySelector(`input[value="${plane}"]`);
    if (!pcb || pcb.checked === checked) return false;
    pcb.checked = checked;
    pcb.closest(".bg-btn").classList.toggle("checked", checked);
    return true;
  };
  body.querySelectorAll('input[name="scope"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const plane = _dirToPlane[cb.value];
      if (!plane) return;
      if (cb.checked) {
        // 勾選 → 加入平面
        if (_setPlaneChecked(plane, true)) _rebuildFileList();
      } else {
        // 取消 → 若沒有其它仍勾選的方向 map 到同一個平面,就連同這個平面一起取消
        const stillNeeded = Object.entries(_dirToPlane).some(([dir, pl]) => {
          if (pl !== plane) return false;
          const other = body.querySelector(`input[name="scope"][value="${dir}"]`);
          return other && other.checked;
        });
        if (!stillNeeded && _setPlaneChecked(plane, false)) _rebuildFileList();
      }
    });
  });
  // === 頁面 dropdown(右下角 toggle 開合;label 顯示已選數量) ===
  const fileDropdownToggle = body.querySelector("#fileDropdownToggle");
  const fileDropdownMenu   = body.querySelector("#fileDropdownMenu");
  const _updateFileToggleLabel = () => {
    const n = _getChecked(fileList).length;
    fileDropdownToggle.textContent = n ? `頁面: 已選 ${n} 個 ▾` : "頁面: 全部 ▾";
    fileDropdownToggle.classList.toggle("has-sel", n > 0);
  };
  fileDropdownToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = fileDropdownMenu.style.display !== "none";
    fileDropdownMenu.style.display = open ? "none" : "";
  });
  // 點 dropdown 內(checkbox / 清除鈕)不關閉;點外部關閉
  fileDropdownMenu.addEventListener("click", (e) => { e.stopPropagation(); });
  doc.addEventListener("click", (e) => {
    if (e.target === fileDropdownToggle) return;
    if (fileDropdownMenu.contains(e.target)) return;
    fileDropdownMenu.style.display = "none";
  });
  // 任何 fileList 內 checkbox 變動 → 更新 toggle label
  fileList.addEventListener("change", _updateFileToggleLabel);
  // 含桿件 / 只有桿件:2 選 1 mutex(都不選 = 預設)
  const incMembersCb  = body.querySelector("#incMembers");
  const onlyMembersCb = body.querySelector("#onlyMembers");
  const _wireMemCombo = (a, b) => a.addEventListener("change", () => { if (a.checked) b.checked = false; });
  _wireMemCombo(incMembersCb,  onlyMembersCb);
  _wireMemCombo(onlyMembersCb, incMembersCb);
  // 桿件搜尋 + 只要節點 → 結果只有兩端節點,不該再「含桿件 / 只有桿件」,自動取消
  const onlyJointsCb = body.querySelector("#onlyJoints");
  if (onlyJointsCb) {
    onlyJointsCb.addEventListener("change", () => {
      if (!onlyJointsCb.checked) return;
      [incMembersCb, onlyMembersCb].forEach(cb => {
        if (cb.checked) {
          cb.checked = false;
          const lab = cb.closest(".bg-btn"); if (lab) lab.classList.remove("checked");
        }
      });
    });
  }
  // 顯示 / 隱藏 section(三種 mode 各自的 block:memberSection / jointSection / materialSection)
  function syncSections() {
    const type = body.querySelector("input[name=searchType]:checked").value;
    body.querySelectorAll("[data-role=memberSection]")  .forEach(el => el.style.display = type === "member"   ? "" : "none");
    body.querySelectorAll("[data-role=jointSection]")   .forEach(el => el.style.display = type === "joint"    ? "" : "none");
    body.querySelectorAll("[data-role=materialSection]").forEach(el => el.style.display = type === "material" ? "" : "none");
  }
  body.querySelectorAll("input[name=searchType]").forEach(r => r.addEventListener("change", syncSections));
  syncSections();
  // 節點範圍 mutex:單點 與「方向 / 相鄰斜撐」互斥(任何 X/Y/Z 軸或 相鄰斜撐 被選 → 單點自動取消;反之亦然)
  //   方向軸彼此之間以及 軸 vs 相鄰斜撐 可以同時存在(不互斥)
  const scopeBoxes = body.querySelectorAll("input[name=scope]");
  const _isRange = (v) => v.startsWith("axis-") || v === "diag-adj";
  scopeBoxes.forEach(cb => {
    cb.addEventListener("change", () => {
      if (!cb.checked) return;
      const otherKind = (cb.value === "single") ? _isRange : ((v) => v === "single");
      scopeBoxes.forEach(c => {
        if (c === cb) return;
        if (otherKind(c.value) && c.checked) {
          c.checked = false;
          // 程式化取消 → 同步 .bg-btn 反白(change 事件不會自動觸發)
          const lab = c.closest(".bg-btn"); if (lab) lab.classList.remove("checked");
        }
      });
    });
  });
  // 搜尋
  const btnSearch = body.querySelector("#btnSearch");
  const btnClear = body.querySelector("#btnClear");
  const btnClearHist = body.querySelector("#btnClearHist");
  const memberIdInput   = body.querySelector("#memberIdInput");
  const jointIdInput    = body.querySelector("#jointIdInput");
  const materialIdInput = body.querySelector("#materialIdInput");
  const materialIdComboMenu = body.querySelector("#materialIdComboMenu");
  const resultsDiv = body.querySelector("#results");
  const _activeIdInput = () => {
    const type = body.querySelector("input[name=searchType]:checked").value;
    if (type === "material") return materialIdInput;
    return type === "member" ? memberIdInput : jointIdInput;
  };
  // === 材料名稱 combobox(輸入下拉,可依輸入即時 filter)===
  //   來源:state.materials + 模型中已使用但未在清單的字串
  let _matFiltered = [];
  let _matActiveIdx = -1;
  const _collectAllMaterials = () => {
    const list = Array.isArray(state.materials) ? state.materials.slice() : [];
    const known = new Set(list.map(m => (m.name || "").trim()).filter(Boolean));
    const extras = new Set();
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        for (const mm of (pg.members || [])) {
          const v = mm && mm.material ? String(mm.material).trim() : "";
          if (v && !known.has(v)) extras.add(v);
        }
      }
    }
    for (const v of [...extras].sort()) list.push({ name: v, note: "(模型中已使用,未在材料清單)" });
    return list;
  };
  const _renderMatMenu = () => {
    const q = (materialIdInput.value || "").trim().toLowerCase();
    const all = _collectAllMaterials();
    _matFiltered = q
      ? all.filter(m => (m.name || "").toLowerCase().includes(q) || (m.note || "").toLowerCase().includes(q))
      : all;
    materialIdComboMenu.innerHTML = "";
    if (!_matFiltered.length) {
      const e = doc.createElement("div");
      e.className = "mat-combo-empty";
      const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
      if (all.length === 0) {
        e.innerHTML = `${T("search.matEmpty","尚無材料")} — <a id="goMgrLink2">${T("search.matGoMgr","前往「材料管理」新增")}</a>`;
        materialIdComboMenu.appendChild(e);
        const link = e.querySelector("#goMgrLink2");
        link.addEventListener("click", (ev) => { ev.stopPropagation(); try { openMaterialMgrWindow(); } catch (_) {} });
      } else {
        e.textContent = `${T("search.matNoMatchPrefix","沒有符合「")}${q}${T("search.matNoMatchSuffix","」的材料")}`;
        materialIdComboMenu.appendChild(e);
      }
      _matActiveIdx = -1;
      return;
    }
    _matFiltered.forEach((m, idx) => {
      const it = doc.createElement("div");
      it.className = "mat-combo-item" + (idx === _matActiveIdx ? " active" : "");
      const main = doc.createElement("span");
      main.textContent = m.name || "";
      it.appendChild(main);
      if (m.note) {
        const n = doc.createElement("span");
        n.className = "note";
        n.textContent = m.note;
        it.appendChild(n);
      }
      it.addEventListener("mouseenter", () => {
        _matActiveIdx = idx;
        materialIdComboMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === idx));
      });
      it.addEventListener("click", () => {
        materialIdInput.value = m.name || "";
        _closeMatMenu();
        materialIdInput.focus();
      });
      materialIdComboMenu.appendChild(it);
    });
    if (_matActiveIdx < 0 && _matFiltered.length) _matActiveIdx = 0;
    materialIdComboMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === _matActiveIdx));
  };
  const _openMatMenu  = () => { materialIdComboMenu.style.display = ""; _renderMatMenu(); };
  const _closeMatMenu = () => { materialIdComboMenu.style.display = "none"; };
  const _isMatMenuOpen = () => materialIdComboMenu.style.display !== "none";
  materialIdInput.addEventListener("focus", _openMatMenu);
  materialIdInput.addEventListener("click", _openMatMenu);
  materialIdInput.addEventListener("input", () => { _matActiveIdx = -1; _openMatMenu(); });
  materialIdInput.addEventListener("keydown", (e) => {
    if (!_isMatMenuOpen() && (e.key === "ArrowDown" || e.key === "ArrowUp")) { _openMatMenu(); e.preventDefault(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (_matFiltered.length) {
        _matActiveIdx = (_matActiveIdx + 1) % _matFiltered.length;
        materialIdComboMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === _matActiveIdx));
        const active = materialIdComboMenu.querySelector(".mat-combo-item.active");
        if (active) active.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (_matFiltered.length) {
        _matActiveIdx = (_matActiveIdx - 1 + _matFiltered.length) % _matFiltered.length;
        materialIdComboMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === _matActiveIdx));
        const active = materialIdComboMenu.querySelector(".mat-combo-item.active");
        if (active) active.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Escape") {
      if (_isMatMenuOpen()) { e.preventDefault(); e.stopPropagation(); _closeMatMenu(); }
    }
    // Enter:讓 win-level keydown 接手 → runSearch();若下拉有 highlight 先填入再給上層 search
    else if (e.key === "Enter") {
      if (_isMatMenuOpen() && _matActiveIdx >= 0 && _matFiltered[_matActiveIdx]) {
        materialIdInput.value = _matFiltered[_matActiveIdx].name || "";
        _closeMatMenu();
        // 不 preventDefault,讓 win 的 Enter handler 跑 runSearch
      }
    }
  });
  doc.addEventListener("click", (e) => {
    if (e.target === materialIdInput) return;
    if (materialIdComboMenu.contains(e.target)) return;
    _closeMatMenu();
  });
  // === 歷史 dropdown(button 點開,菜單顯示最近 50 筆;點一筆 → 填入 textarea) ===
  let _openHistMenu = null;
  const _closeHistMenu = () => { if (_openHistMenu) { _openHistMenu.remove(); _openHistMenu = null; } };
  const _openHistFor = (btn) => {
    _closeHistMenu();
    const type = btn.dataset.histType;
    const targetId = btn.dataset.histTarget;
    const targetEl = body.querySelector(`#${targetId}`);
    if (!targetEl) return;
    const items = _loadSearchHistory(type);
    const menu = doc.createElement("div");
    menu.className = "id-hist-menu";
    if (!items.length) {
      const e = doc.createElement("div");
      e.className = "id-hist-empty";
      e.textContent = "尚無紀錄";
      menu.appendChild(e);
    } else {
      for (const v of items) {
        const row = doc.createElement("div");
        row.className = "id-hist-row";
        row.textContent = v;
        row.title = v;
        row.addEventListener("click", () => {
          targetEl.value = v;
          _closeHistMenu();
          targetEl.focus();
        });
        menu.appendChild(row);
      }
    }
    btn.parentNode.appendChild(menu);
    _openHistMenu = menu;
  };
  body.querySelectorAll(".id-hist-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (_openHistMenu && _openHistMenu.parentNode === btn.parentNode) { _closeHistMenu(); return; }
      _openHistFor(btn);
    });
  });
  doc.addEventListener("click", (e) => {
    if (_openHistMenu && !_openHistMenu.contains(e.target) && !e.target.closest(".id-hist-btn")) _closeHistMenu();
  });
  // 保留外部接口名稱:既有 runSearch / clearHist 仍呼叫 _refreshHistUI(現在是 no-op,因為菜單每次開啟都會 reload)
  const _refreshHistUI = () => {};
  // === 結果篩選狀態(由 Filter dialog 設定) ===
  //   mat: any / has / none — 桿件的材料設定篩選(節點不受影響)
  //   matName: 指定材料字串(非空字串會優先於 mat 生效;case-insensitive 完全比對)
  const _filter = { mat: "any", matName: "" };
  const btnFilter = body.querySelector("#btnFilter");
  const _updateFilterBtn = () => {
    const active = _filter.mat !== "any" || !!_filter.matName;
    btnFilter.classList.toggle("has-active", active);
    let label = "篩選 ⚙";
    if (_filter.matName) label = `篩選 ⚙(材料=${_filter.matName})`;
    else if (_filter.mat === "has")  label = "篩選 ⚙(有材料)";
    else if (_filter.mat === "none") label = "篩選 ⚙(無材料)";
    btnFilter.textContent = label;
  };
  _updateFilterBtn();
  // Filter dialog 開關
  const filterDlg = body.querySelector("#filterDialog");
  const fltMatNameIn = filterDlg.querySelector("#fltMatName");
  const fltMatNameList = filterDlg.querySelector("#fltMatNameList");
  const _setDlgState = () => {
    body.querySelectorAll("input[name=fltMat]").forEach(r => r.checked = (r.value === _filter.mat));
    fltMatNameIn.value = _filter.matName || "";
    // 重建 datalist:state.materials + 「目前模型中已使用但未在清單」的字串
    fltMatNameList.innerHTML = "";
    const known = new Set();
    for (const m of (state.materials || [])) {
      const n = (m && m.name) ? String(m.name).trim() : "";
      if (!n || known.has(n)) continue;
      known.add(n);
      const opt = doc.createElement("option");
      opt.value = n;
      if (m.note) opt.label = m.note;
      fltMatNameList.appendChild(opt);
    }
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        for (const mm of (pg.members || [])) {
          const v = mm && mm.material ? String(mm.material).trim() : "";
          if (!v || known.has(v)) continue;
          known.add(v);
          const opt = doc.createElement("option");
          opt.value = v;
          opt.label = "(模型中已使用)";
          fltMatNameList.appendChild(opt);
        }
      }
    }
  };
  btnFilter.addEventListener("click", () => { _setDlgState(); filterDlg.style.display = "block"; setTimeout(() => fltMatNameIn.focus(), 0); });
  filterDlg.querySelector(".fd-mask").addEventListener("click", () => { filterDlg.style.display = "none"; });
  filterDlg.querySelector("#filterCancel").addEventListener("click", () => { filterDlg.style.display = "none"; });
  filterDlg.querySelector("#filterReset").addEventListener("click", () => {
    _filter.mat = "any"; _filter.matName = ""; _setDlgState();
  });
  filterDlg.querySelector("#filterApply").addEventListener("click", () => {
    const v = (body.querySelector("input[name=fltMat]:checked") || {}).value || "any";
    _filter.mat = v;
    _filter.matName = (fltMatNameIn.value || "").trim();
    _updateFilterBtn();
    filterDlg.style.display = "none";
    // 若已有結果,直接重跑一次(快速)
    if (resultsDiv.textContent !== "尚未搜尋") runSearch();
  });

  // 快取最近一次搜尋結果(顯示方式 checkbox 等切換時不需重跑 _searchModel)
  let _lastResult = null;
  // 顯示方式 checkbox 已移到結果區的 legend(說明)右側;當前 checked 狀態存在這個變數,
  //   _renderSearchResults 內會建立 checkbox 並寫入 result._showCoords / 此變數
  let _showCoordsState = true;
  let _searchInFlight = false;
  function runSearch() {
    if (_searchInFlight) return;            // 防止重複觸發(Enter 連按 / Search 點兩下)
    const type = body.querySelector("input[name=searchType]:checked").value;
    const scope = Array.from(body.querySelectorAll("input[name=scope]:checked")).map(el => el.value);
    if (!scope.length) scope.push("single");
    const memberScope = (body.querySelector("input[name=memberScope]:checked") || {}).value || "single";
    const onlyMembers    = !!onlyMembersCb.checked;
    // 「只有桿件」= 含桿件 的資料 + 隱藏節點列 → 此處強制把 includeMembers 也設為 true,
    //   讓 _searchModel 對節點搜尋同時拉出連接的桿件;後面再 result.joints = [] 把節點列拿掉
    const includeMembers = !!incMembersCb.checked || onlyMembers;
    const onlyJoints = !!(body.querySelector("#onlyJoints") && body.querySelector("#onlyJoints").checked);
    const idText = _activeIdInput().value.trim();
    // 多選來自 checkbox 清單;不選 = 全部
    const fileIds      = _getChecked(fileList).map(v => parseInt(v, 10)).filter(Number.isFinite);
    const planeFilters = _getChecked(planeList);
    // === 顯示 pending message + 鎖住 Search 鈕,讓使用者知道正在跑(且避免重複觸發) ===
    _searchInFlight = true;
    const origBtnLabel = btnSearch.textContent;
    btnSearch.disabled = true;
    btnSearch.textContent = "搜尋中…";
    const _typeLabel = type === "material" ? "材料" : (type === "member" ? "桿件" : "節點");
    resultsDiv.textContent = `⏳ 搜尋中…(${_typeLabel}${idText ? ` · ${idText}` : ""})`;
    // 收合 top panel,讓結果區塊看起來更大(展開設定 按鈕可一鍵還原)
    try { _collapseTopPanel(); } catch (_) {}
    const restore = () => {
      _searchInFlight = false;
      btnSearch.disabled = false;
      btnSearch.textContent = origBtnLabel;
    };
    setTimeout(() => {
      let result;
      const t0 = performance.now();
      try {
        result = _searchModel({ type, memberDir: "all", scope, memberScope, includeMembers, onlyJoints, idText, fileIds, planeFilters });
        // 方向篩選:節點搜尋 + 含桿件/只有桿件 + 軸/斜撐 scope 時,只保留方向相符的桿件
        //   (避免「Y 軸 + 只有桿件」把 Y 軸節點上連接的 X / Z / 斜 也一併納入)
        if (type === "joint" && includeMembers && Array.isArray(scope) && scope.length) {
          const allowedDirs = new Set();
          for (const s of scope) {
            if (s === "axis-x") allowedDirs.add("x");
            else if (s === "axis-y") allowedDirs.add("y");
            else if (s === "axis-z") allowedDirs.add("z");
            else if (s === "diag-adj") allowedDirs.add("diag");
          }
          const wantsDiag = allowedDirs.has("diag");
          // 若 scope 只有 "single",allowedDirs 為空 → 不套用方向篩選(維持「該節點所有連接桿件」)
          if (allowedDirs.size) {
            const seedMap = result.seedJointsByPage;
            result.members = result.members.filter(mr => {
              if (!mr.dir || !allowedDirs.has(mr.dir)) return false;
              // 「相鄰斜撐」需以「搜尋輸入的節點」為基準,而不是 scope 擴張後或 includeMembers 帶入的節點:
              //   斜桿(dir=diag)必須有一端是 seed joint 才算「相鄰」
              if (mr.dir === "diag" && wantsDiag && seedMap) {
                const seedSet = seedMap.get(`${mr.file.id}|${mr.key}`);
                if (!seedSet) return false;
                if (!seedSet.has(mr.m.j1) && !seedSet.has(mr.m.j2)) return false;
              }
              return true;
            });
          }
        }
        // 「只有桿件」→ 結果中不列獨立節點(端點仍會在桿件下方縮排顯示)
        if (onlyMembers) result.joints = [];
        // 篩選(材料):只影響桿件結果;節點不受影響
        //   優先順序:指定材料名稱(完全比對,case-insensitive) > 有材料 / 無材料 radio
        if (_filter.matName) {
          const tgt = _filter.matName.toLowerCase();
          result.members = result.members.filter(mr => {
            const v = mr.m && mr.m.material ? String(mr.m.material).trim().toLowerCase() : "";
            return v === tgt;
          });
        } else if (_filter.mat === "has") {
          result.members = result.members.filter(mr => mr.m && mr.m.material && String(mr.m.material).trim());
        } else if (_filter.mat === "none") {
          result.members = result.members.filter(mr => !mr.m || !mr.m.material || !String(mr.m.material).trim());
        }
      } catch (e) {
        console.error("[search] _searchModel failed:", e);
        resultsDiv.textContent = "搜尋失敗:" + (e && e.message ? e.message : String(e));
        restore();
        return;
      }
      const t1 = performance.now();
      resultsDiv.textContent = `⏳ 渲染 ${result.joints.length} 點 / ${result.members.length} 桿…`;
      _lastResult = result;
      setTimeout(() => {
        try {
          _renderSearchResults(resultsDiv, doc, result, win);
          if (idText) { _pushSearchHistory(type, idText); _refreshHistUI(); }
          const t2 = performance.now();
          console.log(`[search] model=${(t1 - t0).toFixed(1)}ms render=${(t2 - t1).toFixed(1)}ms`);
        } catch (e) {
          console.error("[search] render failed:", e);
          resultsDiv.textContent = "渲染失敗:" + (e && e.message ? e.message : String(e));
        } finally {
          restore();
        }
      }, 0);
    }, 0);
  }
  // 搜尋後:自動把 top panel 收合,讓結果區塊看起來更大;
  //   設定區塊底部會有凸出的「展開設定 / 收起設定」按鈕(panelToggleBtn)可一鍵切換
  const topPanel = body.querySelector("#topPanel");
  const panelToggleBtn = body.querySelector("#panelToggleBtn");
  const _collapseTopPanel = () => {
    topPanel.classList.add("searched");
    panelToggleBtn.textContent = _t("search.expand") || "▼ 展開設定";
  };
  const _expandTopPanel = () => {
    topPanel.classList.remove("searched");
    panelToggleBtn.textContent = _t("search.collapse") || "▲ 收起設定";
  };
  panelToggleBtn.addEventListener("click", () => {
    if (topPanel.classList.contains("searched")) _expandTopPanel();
    else _collapseTopPanel();
  });
  btnSearch.addEventListener("click", runSearch);
  btnClear.addEventListener("click", () => {
    // 清除三個輸入欄與結果(桿件 / 節點 / 材料 編號都會清空;不影響歷史)
    resultsDiv.textContent = "尚未搜尋";
    memberIdInput.value = "";
    jointIdInput.value  = "";
    materialIdInput.value = "";
    _expandTopPanel();
  });
  btnClearHist.addEventListener("click", () => {
    // 只清除目前模式(桿件 / 節點 / 材料)的歷史,讓三種紀錄可獨立管理
    const type = body.querySelector("input[name=searchType]:checked").value;
    if (!confirm(`清除「${type === "material" ? "材料" : (type === "member" ? "桿件" : "節點")}」的所有搜尋歷史(共 ${_loadSearchHistory(type).length} 筆)?`)) return;
    try { localStorage.removeItem(_SEARCH_HIST_KEY[type]); } catch (_) {}
    _refreshHistUI();
  });
  win.addEventListener("keydown", (e) => {
    const dlgOpen = filterDlg && filterDlg.style.display !== "none";
    if (e.key === "Enter") {
      const isTA = doc.activeElement && doc.activeElement.tagName === "TEXTAREA";
      const cmd = e.ctrlKey || e.metaKey;
      // 非 textarea + 純 Enter:跑搜尋 / 套用篩選
      if (!isTA && !e.shiftKey && !cmd) {
        e.preventDefault();
        if (dlgOpen) filterDlg.querySelector("#filterApply").click();
        else runSearch();
      }
      // textarea + Cmd / Ctrl + Enter:跑搜尋(讓使用者在 textarea 內可一鍵送出)
      else if (isTA && cmd) {
        e.preventDefault();
        runSearch();
      }
    }
    if (e.key === "Escape") {
      if (dlgOpen) { filterDlg.style.display = "none"; return; }
      try { win.close(); } catch (_) {}
    }
  });
  // 主視窗關閉時 → 一併關掉 search popup,避免孤立視窗
  //   ⚠ 只綁 beforeunload 在部分瀏覽器(Chrome 無使用者手勢 / Safari)會被略過;
  //     另外綁 pagehide 與 unload 當保險(三者擇一觸發即可,close() 重覆呼叫是 no-op)
  const _onMainUnload = () => { try { win.close(); } catch (_) {} };
  window.addEventListener("beforeunload", _onMainUnload);
  window.addEventListener("pagehide",     _onMainUnload);
  window.addEventListener("unload",       _onMainUnload);
  win.addEventListener("beforeunload", () => {
    // popup 自己被關掉(包含 main 關 popup) → 解除 main 的 listener,避免下次再開時殘留
    window.removeEventListener("beforeunload", _onMainUnload);
    window.removeEventListener("pagehide",     _onMainUnload);
    window.removeEventListener("unload",       _onMainUnload);
    setSearchWin(null);
    setSearchWinAutofill(null);
  });

  // === 依主畫面目前選取覆蓋編號(autofill)===
  //   呼叫時機:
  //     1. popup 第一次建立 → 直接呼叫一次
  //     2. popup 已存在但主畫面 Cmd+F 重按 → openSearchWindow 會再呼叫(換選 → 直接更新編號)
  //   規則:
  //     只選節點 → 切到節點模式,並把節點編號欄覆寫
  //     只選桿件 → 切到桿件模式,並把桿件編號欄覆寫
  //     兩者皆選 → 兩欄都覆寫(模式不變,使用者可自行切換)
  //     某邊沒有新選取  → 那邊的編號欄保留不動(讓使用者自行清空)
  const _autofillFromSelection = () => {
    try {
      const af = getActiveFile();
      const pg = (af && af.pages) ? af.pages[state.pageIdx] : null;
      const selJ = (state.selection && state.selection.joints)  || new Set();
      const selM = (state.selection && state.selection.members) || new Set();
      if (af && pg && selJ.size) {
        const jmap = new Map((pg.joints || []).map(jj => [jj.id, jj]));
        const ids = [...selJ].map(id => jmap.get(id)).filter(Boolean)
          .map(j => String(_displayIdForJointWith(af, pg, j)));
        jointIdInput.value = ids.join(", ");
      }
      if (af && pg && selM.size) {
        const mmap = new Map((pg.members || []).map(mm => [mm.id, mm]));
        const ids = [...selM].map(id => mmap.get(id)).filter(Boolean)
          .map(m => String(displayMemberId(m)));
        memberIdInput.value = ids.join(", ");
      }
      if (selM.size && !selJ.size) {
        body.querySelectorAll("input[name=searchType]").forEach(r => r.checked = (r.value === "member"));
      } else if (selJ.size && !selM.size) {
        body.querySelectorAll("input[name=searchType]").forEach(r => r.checked = (r.value === "joint"));
      }
      // 程式化變更 .checked 不會觸發 change 事件 → 手動同步 .bg-btn / .tab 的 .checked class,
      //   避免「節點被勾,但 桿件 還在反白」的視覺錯位
      body.querySelectorAll(_BG_SEL).forEach(_syncBgBtn);
      syncSections();
    } catch (e) { console.warn("[search] autofill from selection failed:", e); }
  };
  _autofillFromSelection();
  setSearchWinAutofill(_autofillFromSelection);

  // 套用目前語言:翻譯所有 popup 內帶 data-i18n / data-i18n-title / data-i18n-placeholder 的元素
  try { _applyI18nOnDoc(doc); } catch (_) {}
  // panel toggle 的文字依當前狀態決定(收合/展開),於此初始化
  try { _expandTopPanel(); } catch (_) {}

  try { _activeIdInput().focus(); } catch (_) {}
}

// 解析 idText:支援多種輸入格式
//   1) 簡單:逗號 / 空白 / 換行分隔 — 每個 token 都是 ID(沿用既有行為)
//   2) STAAD `N TO M` 範圍語法:`123 to 125` → 展開 123 124 125
//   3) xlsx MEMBER 區直接貼:
//      `*` 開頭的行 = comment 跳過;每行用 `;` 切成 triplet,每 triplet 取「首個整數 token」當 member ID
//      例如貼:`1 10106 10105 ; 2 10130 10106 ; 3 10107 10130` → 取出 ID = 1, 2, 3
//   偵測:text 含 `;` 或任何行起頭是 `*` → 走 (3);否則走 (1) 並對 token 跑 (2) 的 TO 展開
function _parseIdsWithRanges(text) {
  if (!text) return null;
  const str = String(text);
  const isStructured = str.includes(";") || /(^|\n)\s*\*/.test(str);
  if (isStructured) {
    // xlsx / STAAD style:每行 `;` 切 triplet,各 triplet 首 token 是 member ID;`*` 行略過
    const ids = [];
    for (const rawLine of str.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("*")) continue;
      for (const chunk of line.split(";")) {
        const tk = chunk.trim().split(/[\s,]+/).filter(Boolean);
        if (!tk.length) continue;
        const first = tk[0];
        if (/^\d+$/.test(first)) ids.push(first);
      }
    }
    return ids.length ? ids : null;
  }
  // 簡單路徑:逗號 / 空白 / 換行 split,然後跑 TO range 展開
  const tokens = str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const ids = [];
  const MAX_RANGE = 100000;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const isToNext = tokens[i + 1] && /^to$/i.test(tokens[i + 1]) && tokens[i + 2] != null;
    if (isToNext) {
      const a = Number(t), b = Number(tokens[i + 2]);
      if (Number.isInteger(a) && Number.isInteger(b)) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (hi - lo <= MAX_RANGE) {
          for (let n = lo; n <= hi; n++) ids.push(String(n));
          i += 2;
          continue;
        }
      }
    }
    ids.push(t);
  }
  return ids;
}
// 收集匹配:依 criteria 過濾 joints / members,計算 3D 包圍盒
export function _searchModel(c) {
  const ids = _parseIdsWithRanges(c.idText);
  const idSet = ids ? new Set(ids.map(String)) : null;
  // 過濾器:支援單值(back-compat)與多值(fileIds[] / planeFilters[])
  const fileIdSet = (Array.isArray(c.fileIds) && c.fileIds.length)
    ? new Set(c.fileIds)
    : (c.fileId != null ? new Set([c.fileId]) : null);
  const planeFilterSet = (Array.isArray(c.planeFilters) && c.planeFilters.length)
    ? new Set(c.planeFilters)
    : (c.planeFilter ? new Set([c.planeFilter]) : null);
  const pageList = [];
  for (const f of state.files) {
    if (fileIdSet && !fileIdSet.has(f.id)) continue;
    for (const k of Object.keys(f.pages || {})) {
      // 舊欄位 pageIdx 仍相容(若還有人傳)
      if (c.pageIdx != null && +k !== c.pageIdx) continue;
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      // 平面類型過濾(XY/YZ/XZ);未選 = 全部
      if (planeFilterSet && !planeFilterSet.has(pg.plane)) continue;
      pageList.push({ file: f, page: pg, key: +k });
    }
  }
  const joints = [];
  const members = [];
  const _world = (file, page, j) => {
    try { return (typeof _worldForRank === "function") ? _worldForRank(file, page, j) : joint2DToWorld3D(file, page, j); }
    catch (_) { return null; }
  };
  // member 方向分類 helper(共用)
  const _classifyDir = (wa, wb) => {
    if (!wa || !wb) return null;
    const dx = Math.abs(wb.x - wa.x), dy = Math.abs(wb.y - wa.y), dz = Math.abs(wb.z - wa.z);
    const len = Math.hypot(dx, dy, dz) || 1;
    const TH = 0.999;
    if (dy / len > TH) return "y";
    if (dx / len > TH) return "x";
    if (dz / len > TH) return "z";
    return "diag";
  };
  // 共用去重 helper —— 跨 scope 聯集 + 後置 includeMembers/includeJoints 用同一組 seen set
  const seenJ = new Set(), seenM = new Set();
  const jK = (s, jid) => `${s.file.id}|${s.key}|${jid}`;
  const mK = (s, mid) => `M${s.file.id}|${s.key}|${mid}`;
  const pushJoint = (s) => {
    const k = jK(s, s.j.id);
    if (seenJ.has(k)) return;
    seenJ.add(k);
    joints.push(s);
  };
  const pushMember = (s) => {
    const k = mK(s, s.m.id);
    if (seenM.has(k)) return;
    seenM.add(k);
    members.push(s);
  };
  if (c.type === "member") {
    // 階段 1:依 ID/file/plane/方向 篩 seed members
    const seedMembers = [];
    for (const t of pageList) {
      const jmap = new Map((t.page.joints || []).map(j => [j.id, j]));
      for (const m of (t.page.members || [])) {
        const dispM = String(typeof displayMemberId === "function" ? displayMemberId(m) : m.id);
        if (idSet && !idSet.has(dispM)) continue;
        const a = jmap.get(m.j1), b = jmap.get(m.j2);
        if (!a || !b) continue;
        const wa = _world(t.file, t.page, a), wb = _world(t.file, t.page, b);
        const dir = _classifyDir(wa, wb);
        // memberDir 欄位保留為 back-compat(外部呼叫仍可用);UI 已移除方向 filter
        if (c.memberDir && c.memberDir !== "all" && dir !== c.memberDir) continue;
        seedMembers.push({ file: t.file, page: t.page, key: t.key, m, dir, wa, wb });
      }
    }
    // 階段 2:依 memberScope 擴展
    //   single        → 只保留 seed 本身
    //   line          → 連續關聯 + 同方向,形成一條直線(BFS 從 seed 兩端擴張)
    //   endpoint-adj  → seed 兩端 joint 所連的所有 member,不含 seed 本身
    //   (舊值 endpoints / axis-* 保留 back-compat;UI 已移除)
    if (!c.memberScope || c.memberScope === "single") {
      for (const sm of seedMembers) pushMember(sm);
    } else if (c.memberScope === "line") {
      // 從 seed 沿兩端擴張,找 (共享 joint) 且 (方向單位向量與 seed 平行 / 反平行) 的 member
      //   dot(|ux*vx + uy*vy + uz*vz|) > 0.999(約 2.5° 容忍)視為共線
      for (const sm of seedMembers) {
        const dx0 = sm.wb.x - sm.wa.x, dy0 = sm.wb.y - sm.wa.y, dz0 = sm.wb.z - sm.wa.z;
        const L0 = Math.hypot(dx0, dy0, dz0);
        if (L0 < 1e-6) { pushMember(sm); continue; }
        const ux = dx0 / L0, uy = dy0 / L0, uz = dz0 / L0;
        pushMember(sm);
        const visited = new Set([`${sm.file.id}|${sm.key}|${sm.m.id}`]);
        const queue = [sm];
        while (queue.length) {
          const cur = queue.shift();
          const jmap = new Map((cur.page.joints || []).map(j => [j.id, j]));
          for (const jid of [cur.m.j1, cur.m.j2]) {
            for (const m of (cur.page.members || [])) {
              if (m === cur.m) continue;
              if (m.j1 !== jid && m.j2 !== jid) continue;
              const k = `${cur.file.id}|${cur.key}|${m.id}`;
              if (visited.has(k)) continue;
              const a = jmap.get(m.j1), b = jmap.get(m.j2);
              if (!a || !b) continue;
              const wa = _world(cur.file, cur.page, a);
              const wb = _world(cur.file, cur.page, b);
              if (!wa || !wb) continue;
              const ddx = wb.x - wa.x, ddy = wb.y - wa.y, ddz = wb.z - wa.z;
              const dl = Math.hypot(ddx, ddy, ddz);
              if (dl < 1e-6) continue;
              const dot = Math.abs((ddx / dl) * ux + (ddy / dl) * uy + (ddz / dl) * uz);
              if (dot < 0.999) continue;   // 不共線 → 跳過
              visited.add(k);
              const dir = _classifyDir(wa, wb);
              const ent = { file: cur.file, page: cur.page, key: cur.key, m, dir, wa, wb };
              pushMember(ent);
              queue.push(ent);
            }
          }
        }
      }
    } else if (c.memberScope === "endpoint-adj") {
      // seed 兩端 joint 所連的所有 member,**包含 seed 自己**
      for (const sm of seedMembers) {
        pushMember(sm);   // seed 本身先加入
        const endpoints = new Set([sm.m.j1, sm.m.j2]);
        const jmap = new Map((sm.page.joints || []).map(j => [j.id, j]));
        for (const m of (sm.page.members || [])) {
          if (m === sm.m) continue;   // seed 已加過,跳過
          if (!endpoints.has(m.j1) && !endpoints.has(m.j2)) continue;
          const a = jmap.get(m.j1), b = jmap.get(m.j2);
          if (!a || !b) continue;
          const wa = _world(sm.file, sm.page, a);
          const wb = _world(sm.file, sm.page, b);
          if (!wa || !wb) continue;
          const dir = _classifyDir(wa, wb);
          pushMember({ file: sm.file, page: sm.page, key: sm.key, m, dir, wa, wb });
        }
      }
    } else if (c.memberScope === "endpoints") {
      // back-compat(舊值):seed + 兩端 joint
      for (const sm of seedMembers) {
        pushMember(sm);
        const jmap = new Map((sm.page.joints || []).map(j => [j.id, j]));
        for (const jid of [sm.m.j1, sm.m.j2]) {
          const j = jmap.get(jid);
          if (!j) continue;
          const w = _world(sm.file, sm.page, j);
          if (w) pushJoint({ file: sm.file, page: sm.page, key: sm.key, j, w });
        }
      }
    } else if (c.memberScope.startsWith("axis-")) {
      // back-compat(舊值):同軸線(midpoint 的其他兩軸與 seed 一致)
      const axis = c.memberScope.slice(5);   // "x" / "y" / "z"
      const tol = 1;
      const seedKeys = seedMembers.map(sm => {
        const mx = (sm.wa.x + sm.wb.x) / 2;
        const my = (sm.wa.y + sm.wb.y) / 2;
        const mz = (sm.wa.z + sm.wb.z) / 2;
        return { sm, mid: { x: mx, y: my, z: mz } };
      });
      for (const t of pageList) {
        const jmap = new Map((t.page.joints || []).map(j => [j.id, j]));
        for (const m of (t.page.members || [])) {
          const a = jmap.get(m.j1), b = jmap.get(m.j2);
          if (!a || !b) continue;
          const wa = _world(t.file, t.page, a), wb = _world(t.file, t.page, b);
          if (!wa || !wb) continue;
          const mid = { x: (wa.x + wb.x) / 2, y: (wa.y + wb.y) / 2, z: (wa.z + wb.z) / 2 };
          let match = false;
          for (const sk of seedKeys) {
            const other1 = axis === "x" ? "y" : axis === "y" ? "x" : "x";
            const other2 = axis === "x" ? "z" : axis === "y" ? "z" : "y";
            if (Math.abs(mid[other1] - sk.mid[other1]) <= tol &&
                Math.abs(mid[other2] - sk.mid[other2]) <= tol) {
              match = true; break;
            }
          }
          if (!match) continue;
          const dir = _classifyDir(wa, wb);
          pushMember({ file: t.file, page: t.page, key: t.key, m, dir, wa, wb });
        }
      }
    }
  } else if (c.type === "material") {
    // 材料搜尋:依 m.material 比對 idText 解出的材料名稱列表(case-insensitive 完全比對)
    //   idText 空 → 列出所有「有材料設定」的桿件
    const matSet = (ids && ids.length)
      ? new Set(ids.map(s => String(s).trim().toLowerCase()).filter(Boolean))
      : null;
    for (const t of pageList) {
      const jmap = new Map((t.page.joints || []).map(j => [j.id, j]));
      for (const m of (t.page.members || [])) {
        const mat = (m && m.material) ? String(m.material).trim() : "";
        if (!mat) continue;
        if (matSet && !matSet.has(mat.toLowerCase())) continue;
        const a = jmap.get(m.j1), b = jmap.get(m.j2);
        if (!a || !b) continue;
        const wa = _world(t.file, t.page, a);
        const wb = _world(t.file, t.page, b);
        const dir = _classifyDir(wa, wb);
        pushMember({ file: t.file, page: t.page, key: t.key, m, dir, wa, wb });
      }
    }
  } else {
    // joint
    const seeds = [];
    // 紀錄 seed joint:per-page set,提供給 runSearch 篩選「相鄰斜撐」用
    //   (相鄰斜撐 的判定要以「搜尋輸入的節點」為基準,不能用 scope 擴張後的節點)
    const _seedJointsByPage = new Map();
    for (const t of pageList) {
      for (const j of (t.page.joints || [])) {
        const dispJ = String(typeof _displayIdForJointWith === "function" ? _displayIdForJointWith(t.file, t.page, j) : j.id);
        if (idSet && !idSet.has(dispJ)) continue;
        const w = _world(t.file, t.page, j);
        if (!w) continue;
        seeds.push({ file: t.file, page: t.page, key: t.key, j, w });
        const sk = `${t.file.id}|${t.key}`;
        if (!_seedJointsByPage.has(sk)) _seedJointsByPage.set(sk, new Set());
        _seedJointsByPage.get(sk).add(j.id);
      }
    }
    // 暴露給呼叫端(runSearch 內的方向 / 相鄰斜撐 篩選會用到)
    c._seedJointsByPage = _seedJointsByPage;
    // scope 是 array(複選);外部傳 string 自動轉 array 相容。
    //   支援:single / axis-x / axis-y / axis-z / diag-adj
    //   舊值 "connected" 保留相容(UI 已移除,由 includeMembers checkbox 取代)
    const scopeList = Array.isArray(c.scope) ? c.scope : (c.scope ? [c.scope] : ["single"]);
    for (const sc of scopeList) {
      if (sc === "single") {
        for (const s of seeds) pushJoint(s);
      } else if (sc === "connected") {
        // back-compat:seed + 接到的 members + 對側 joint(等同新 UI「單點 + 含桿件」)
        for (const sj of seeds) {
          pushJoint(sj);
          const jmap = new Map((sj.page.joints || []).map(jj => [jj.id, jj]));
          for (const m of (sj.page.members || [])) {
            if (m.j1 !== sj.j.id && m.j2 !== sj.j.id) continue;
            const a = jmap.get(m.j1), b = jmap.get(m.j2);
            const wa = a && _world(sj.file, sj.page, a);
            const wb = b && _world(sj.file, sj.page, b);
            pushMember({ file: sj.file, page: sj.page, key: sj.key, m, wa, wb });
            const other = m.j1 === sj.j.id ? b : a;
            if (other) {
              const w = _world(sj.file, sj.page, other);
              if (w) pushJoint({ file: sj.file, page: sj.page, key: sj.key, j: other, w });
            }
          }
        }
      } else if (sc.startsWith("axis-")) {
        // axis-x/y/z:沿該方向軸延伸的**線**上所有 joint
        //   axis-x = X 軸方向線 → 固定 y=y₁ & z=z₁,x 自由
        //   axis-y = Y 軸方向線 → 固定 x=x₁ & z=z₁,y 自由
        //   axis-z = Z 軸方向線 → 固定 x=x₁ & y=y₁,z 自由
        //   (舊版錯誤地只比對 w[axis] 本身 = 找出整個垂直該軸的「平面」,會把同頁幾乎所有點吸進來)
        const axis = sc.slice(5);    // "x" / "y" / "z"
        const tol = 1;
        const otherA = axis === "x" ? "y" : axis === "y" ? "x" : "x";
        const otherB = axis === "x" ? "z" : axis === "y" ? "z" : "y";
        for (const t of pageList) {
          for (const j of (t.page.joints || [])) {
            const w = _world(t.file, t.page, j);
            if (!w) continue;
            const match = seeds.some(s =>
              Math.abs(w[otherA] - s.w[otherA]) <= tol &&
              Math.abs(w[otherB] - s.w[otherB]) <= tol
            );
            if (match) pushJoint({ file: t.file, page: t.page, key: t.key, j, w });
          }
        }
      } else if (sc === "diag-adj") {
        // 相鄰斜撐:seed + 同頁中接到 seed 的「斜桿」對側 joint
        for (const sj of seeds) {
          pushJoint(sj);
          const jmap = new Map((sj.page.joints || []).map(jj => [jj.id, jj]));
          for (const m of (sj.page.members || [])) {
            if (m.j1 !== sj.j.id && m.j2 !== sj.j.id) continue;
            const a = jmap.get(m.j1), b = jmap.get(m.j2);
            if (!a || !b) continue;
            const wa = _world(sj.file, sj.page, a);
            const wb = _world(sj.file, sj.page, b);
            if (_classifyDir(wa, wb) !== "diag") continue;
            const other = m.j1 === sj.j.id ? b : a;
            const w = _world(sj.file, sj.page, other);
            if (w) pushJoint({ file: sj.file, page: sj.page, key: sj.key, j: other, w });
          }
        }
      }
    }
  }
  // 後置處理:includeMembers / includeJoints checkbox(正交於 scope 選項)
  if (c.type === "joint" && c.includeMembers) {
    // 把每個結果 joint 所接到的 member 納入 members(去重);member 另一端 joint 不自動加
    const jointsByPage = new Map();
    for (const jr of joints) {
      const k = `${jr.file.id}|${jr.key}`;
      if (!jointsByPage.has(k)) jointsByPage.set(k, new Set());
      jointsByPage.get(k).add(jr.j.id);
    }
    for (const t of pageList) {
      const set = jointsByPage.get(`${t.file.id}|${t.key}`);
      if (!set) continue;
      const jmap = new Map((t.page.joints || []).map(j => [j.id, j]));
      for (const m of (t.page.members || [])) {
        if (!set.has(m.j1) && !set.has(m.j2)) continue;
        const a = jmap.get(m.j1), b = jmap.get(m.j2);
        const wa = a && _world(t.file, t.page, a);
        const wb = b && _world(t.file, t.page, b);
        const dir = _classifyDir(wa, wb);
        pushMember({ file: t.file, page: t.page, key: t.key, m, dir, wa, wb });
      }
    }
  }
  if (c.type === "member" && c.onlyJoints) {
    // 「只要節點」:把結果 member 轉成兩端 joint,並清空 members(不顯示桿件本身)
    //   舊值 c.includeJoints 視為同義(back-compat)
    const memSnapshot = [...members];
    members.length = 0;
    seenM.clear();
    for (const mr of memSnapshot) {
      const jmap = new Map((mr.page.joints || []).map(j => [j.id, j]));
      for (const jid of [mr.m.j1, mr.m.j2]) {
        const j = jmap.get(jid);
        if (!j) continue;
        const w = _world(mr.file, mr.page, j);
        if (w) pushJoint({ file: mr.file, page: mr.page, key: mr.key, j, w });
      }
    }
  } else if (c.type === "member" && c.includeJoints) {
    // back-compat:舊的「含節點」語意 —— 保留 members + 加上兩端 joint
    const memSnapshot = [...members];
    for (const mr of memSnapshot) {
      const jmap = new Map((mr.page.joints || []).map(j => [j.id, j]));
      for (const jid of [mr.m.j1, mr.m.j2]) {
        const j = jmap.get(jid);
        if (!j) continue;
        const w = _world(mr.file, mr.page, j);
        if (w) pushJoint({ file: mr.file, page: mr.page, key: mr.key, j, w });
      }
    }
  }
  // 3D bounds
  const b = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
  const ext = (w) => { if (!w) return;
    if (w.x < b.x[0]) b.x[0] = w.x; if (w.x > b.x[1]) b.x[1] = w.x;
    if (w.y < b.y[0]) b.y[0] = w.y; if (w.y > b.y[1]) b.y[1] = w.y;
    if (w.z < b.z[0]) b.z[0] = w.z; if (w.z > b.z[1]) b.z[1] = w.z;
  };
  for (const j of joints) ext(j.w);
  for (const m of members) { ext(m.wa); ext(m.wb); }
  return { criteria: c, joints, members, bounds3D: b, seedJointsByPage: c._seedJointsByPage || null };
}

export function _renderSearchResults(div, doc, result, win) {
  div.innerHTML = "";
  if (!result.joints.length && !result.members.length) {
    div.textContent = "沒有找到符合條件的項目";
    return;
  }
  // 顯示方式:節點座標 (checkbox 已移到「結果區的說明」右側,持久狀態存於 result._showCoords / win.__searchShowCoords)
  //   勾選 → 7 欄(ID/方向/X/Y/Z/長度/材料)+ 端點縮排列;獨立節點仍以座標列顯示
  //   不勾 → 6 欄(ID/方向/J1/J2/長度/材料)、無端點縮排列;獨立節點隱藏(coord-off 模式下無座標可看)
  //   特例:結果只有節點、無桿件 → 自動勾選(否則 coord-off 會把僅有的獨立節點藏掉、整張表變空)
  const _persistKey = "__searchShowCoords";
  const _onlyJoints = result.joints.length > 0 && result.members.length === 0;
  const _showCoords = (result._showCoords !== undefined)
    ? !!result._showCoords
    : (_onlyJoints
        ? true
        : (win[_persistKey] !== undefined ? !!win[_persistKey] : false));
  // === summary ===
  const summary = doc.createElement("div");
  summary.className = "group-title";
  summary.textContent = `找到 ${result.joints.length} 個節點、${result.members.length} 條桿件`;
  div.appendChild(summary);
  const COL_MEMBER = "#6fb3ff";
  const COL_JOINT  = "#ff7676";
  const COL_ANCHOR = "#ff8c00";
  // 說明 + 顯示方式 toggle(放右邊)
  const legend = doc.createElement("div");
  legend.style.cssText = "display:flex;align-items:center;gap:8px;margin:3px 0 4px;font-size:10px;color:#9aa0a6;line-height:1.5;flex-wrap:wrap";
  const legendText = doc.createElement("span");
  legendText.style.flex = "1 1 auto";
  legendText.innerHTML =
    `<span style="color:${COL_MEMBER};font-weight:700">■ 桿件 ID</span> ・ ` +
    `<span style="color:${COL_JOINT};font-weight:700">■ 節點 ID</span> ・ ` +
    `<span style="color:${COL_ANCHOR};font-weight:700">■ 錨點</span> ・ ` +
    `<span style="color:#b8e986;font-weight:700">■ 材料</span> ・ ` +
    `<span style="color:#4fc3f7;font-weight:700">[XY]</span><span style="color:#ffd23f;font-weight:700">[YZ]</span><span style="color:#c39bff;font-weight:700">[XZ]</span> = 平面 ・ ` +
    `<span style="color:#9aa0a6">Click 選列、Shift+Click 選範圍、Cmd/Ctrl+Click 加減選</span>`;
  legend.appendChild(legendText);
  // 顯示方式 toggle 按鈕(在說明右側,沿用 .bg-btn 樣式)
  const coordLab = doc.createElement("label");
  coordLab.className = "bg-btn" + (_showCoords ? " checked" : "");
  coordLab.title = "勾選:在桿件下方縮排顯示兩端節點座標(X/Y/Z 欄)\n不勾:每條桿件只佔一列(只顯示 J1 / J2 + 長度 / 材料)";
  const coordCb = doc.createElement("input");
  coordCb.type = "checkbox";
  coordCb.id = "displayCoords";
  coordCb.checked = _showCoords;
  coordCb.addEventListener("change", () => {
    result._showCoords = coordCb.checked;
    win[_persistKey] = coordCb.checked;
    _renderSearchResults(div, doc, result, win);
  });
  coordLab.appendChild(coordCb);
  coordLab.appendChild(doc.createTextNode("節點座標"));
  legend.appendChild(coordLab);
  div.appendChild(legend);
  // zoom-all-3D + 全部收合 / 全部展開 工具列
  const _toolsBar = doc.createElement("div");
  _toolsBar.style.cssText = "display:flex;gap:4px;align-items:center;margin:3px 0 4px;flex-wrap:wrap";
  if (_3dPreviewWindow && _3dPreviewWindow.win && !_3dPreviewWindow.win.closed
      && typeof _3dPreviewWindow.zoomToBounds === "function") {
    const z3d = doc.createElement("button");
    z3d.textContent = "🔍 3D 視窗全部放大";
    z3d.style.cssText = "font-size:10px;padding:2px 6px";
    z3d.onclick = () => { _3dPreviewWindow.zoomToBounds(result.bounds3D); };
    _toolsBar.appendChild(z3d);
  }
  // 全部收合 / 全部展開:作用於所有 page header row
  const _btnCollapseAll = doc.createElement("button");
  _btnCollapseAll.textContent = "全部收合";
  _btnCollapseAll.title = "把所有頁面結果收起來,只看到 header 行";
  _btnCollapseAll.style.cssText = "font-size:10px;padding:2px 6px";
  const _btnExpandAll = doc.createElement("button");
  _btnExpandAll.textContent = "全部展開";
  _btnExpandAll.title = "展開所有頁面結果";
  _btnExpandAll.style.cssText = "font-size:10px;padding:2px 6px";
  _toolsBar.appendChild(_btnCollapseAll);
  _toolsBar.appendChild(_btnExpandAll);
  div.appendChild(_toolsBar);
  // 點擊事件(此時 groupRows 還是空,但 click 時 closure 會抓到當下已填好的 array)
  _btnCollapseAll.addEventListener("click", () => {
    for (const gr of groupRows) {
      const tgl = gr.row.querySelector(".gr-toggle");
      if (tgl && !gr.row.classList.contains("collapsed")) tgl.click();
    }
  });
  _btnExpandAll.addEventListener("click", () => {
    for (const gr of groupRows) {
      const tgl = gr.row.querySelector(".gr-toggle");
      if (tgl && gr.row.classList.contains("collapsed")) tgl.click();
    }
  });

  // === 材料工具列(只在有桿件時顯示) ===
  // 跨群組共用的 selection,key = `${fileId}|${pageKey}|${memberId}`
  const selectedKeys = new Set();
  const flatRows = [];   // 所有可選 member 列;支援 Shift 範圍
  const groupRows = [];  // 每個 page header row + 其在 flatRows 的範圍,支援「整頁選取」
  let lastClickIdx = -1;
  let matInput = null, selInfoSpan = null;
  const refreshSelectionUI = () => {
    for (const r of flatRows) r.tr.classList.toggle("sel", selectedKeys.has(r.key));
    // 整頁高亮:某 page 的所有 member 都被選 → 該頁 header 列加上 all-sel
    for (const gr of groupRows) {
      let allSel = gr.lastIdx >= gr.firstIdx;
      for (let i = gr.firstIdx; i <= gr.lastIdx && allSel; i++) {
        if (!selectedKeys.has(flatRows[i].key)) allSel = false;
      }
      gr.row.classList.toggle("all-sel", allSel);
    }
    if (selInfoSpan) selInfoSpan.textContent = `已選 ${selectedKeys.size} 條`;
  };
  if (result.members.length) {
    const tbar = doc.createElement("div");
    tbar.className = "mat-toolbar";
    tbar.innerHTML =
      `<span class="mt-label">表單:</span>` +
      `<select id="matTableSel" style="background:#1a1c20;color:#ddd;border:1px solid #444;border-radius:3px;padding:3px 6px;font:inherit;cursor:pointer;min-width:90px" title="先選表單(STAAD 資料庫類型) → 下方材料清單只列該表單下的選項;選「全部」不過濾"></select>` +
      `<span class="mt-label">材料:</span>` +
      `<div class="mat-combo-wrap">` +
        `<input id="matInput" type="text" autocomplete="off" placeholder="點此選擇 / 輸入字串過濾材料清單">` +
        `<span class="mat-combo-caret">▾</span>` +
        `<div id="matComboMenu" class="mat-combo-menu" style="display:none"></div>` +
      `</div>` +
      `<button id="btnMatApply" class="primary" title="把目前材料字串套用到所選桿件;Cmd+Z 可還原。新材料會自動加入清單(表單欄帶上目前選取的表單)">套用到所選</button>` +
      `<button id="btnMatClear" title="清除所選桿件的材料設定;Cmd+Z 可還原">清除材料</button>` +
      `<button id="btnMatMgr" title="開啟材料管理視窗,新增 / 編輯 / 刪除材料清單">管理…</button>` +
      `<span class="mt-sep">|</span>` +
      `<button id="btnSelAll" title="全選所有桿件結果">全選</button>` +
      `<button id="btnSelNone" title="全不選">全不選</button>` +
      `<span id="selInfo" class="mt-info">已選 0 條</span>`;
    div.appendChild(tbar);
    matInput = tbar.querySelector("#matInput");
    const matMenu = tbar.querySelector("#matComboMenu");
    const matTableSel = tbar.querySelector("#matTableSel");
    selInfoSpan = tbar.querySelector("#selInfo");
    // 表單下拉:從 state.materials 蒐集所有不重複的 table 值(含「(全部)」與「(無表單)」)
    const _fillTableSel = () => {
      const prev = matTableSel.value;
      matTableSel.innerHTML = "";
      const optAll = doc.createElement("option");
      optAll.value = "__ALL__"; optAll.textContent = "(全部)";
      matTableSel.appendChild(optAll);
      const tables = new Set();
      const hasUntabled = (Array.isArray(state.materials) ? state.materials : []).some(mm => {
        const t = (mm && mm.table ? String(mm.table) : "").trim();
        if (t) tables.add(t);
        return !t;
      });
      const sorted = [...tables].sort((a, b) => a.localeCompare(b));
      for (const t of sorted) {
        const o = doc.createElement("option");
        o.value = t; o.textContent = t;
        matTableSel.appendChild(o);
      }
      if (hasUntabled) {
        const o = doc.createElement("option");
        o.value = "__NONE__"; o.textContent = "(無表單)";
        matTableSel.appendChild(o);
      }
      // 還原之前的選擇(若還在);沒則保留 "(全部)"
      if (prev && Array.from(matTableSel.options).some(o => o.value === prev)) {
        matTableSel.value = prev;
      } else {
        matTableSel.value = "__ALL__";
      }
    };
    _fillTableSel();
    matTableSel.addEventListener("change", () => { _activeIdx = -1; if (_isOpen()) _renderMenu(); });
    let _activeIdx = -1;   // 鍵盤導航的高亮 index
    let _filteredItems = [];
    // 取材料清單:state.materials 為主;加上「目前桿件已套用但 state.materials 沒記錄」的字串(歷史補位)
    const _collectMaterials = () => {
      const list = Array.isArray(state.materials) ? state.materials.slice() : [];
      const known = new Set(list.map(m => (m.name || "").trim()).filter(Boolean));
      // 補:已存在於 m.material 但沒在材料清單中的字串(讓使用者也能選回去 / 刪除)
      const extras = new Set();
      for (const f of state.files) {
        for (const pg of Object.values(f.pages || {})) {
          for (const mm of (pg.members || [])) {
            const v = mm && mm.material ? String(mm.material).trim() : "";
            if (v && !known.has(v)) extras.add(v);
          }
        }
      }
      for (const v of [...extras].sort()) list.push({ name: v, note: "(模型中已使用,未在材料清單)" });
      return list;
    };
    const _renderMenu = () => {
      const q = (matInput.value || "").trim().toLowerCase();
      const all = _collectMaterials();
      // 表單篩選:`__ALL__` 全部 / `__NONE__` 無表單 / 其他 = 精確比對該 table 值
      const tableFilter = matTableSel ? matTableSel.value : "__ALL__";
      const byTable = tableFilter === "__ALL__"
        ? all
        : tableFilter === "__NONE__"
          ? all.filter(m => !(m.table && String(m.table).trim()))
          : all.filter(m => (m.table && String(m.table).trim()) === tableFilter);
      _filteredItems = q
        ? byTable.filter(m => (m.name || "").toLowerCase().includes(q) || (m.note || "").toLowerCase().includes(q))
        : byTable;
      matMenu.innerHTML = "";
      if (!_filteredItems.length) {
        const e = doc.createElement("div");
        e.className = "mat-combo-empty";
        const T2 = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
        if (all.length === 0) {
          e.innerHTML = `${T2("search.matEmpty","尚無材料")} — <a id="goMgrLink">${T2("search.matGoMgr","前往「材料管理」新增")}</a>`;
          matMenu.appendChild(e);
          const link = e.querySelector("#goMgrLink");
          link.addEventListener("click", (ev) => { ev.stopPropagation(); try { openMaterialMgrWindow(); } catch (_) {} });
        } else {
          e.textContent = `${T2("search.matNoMatchPrefix","沒有符合「")}${q}${T2("search.matNoMatchSuffix","」的材料")}`;
          matMenu.appendChild(e);
        }
        _activeIdx = -1;
        return;
      }
      _filteredItems.forEach((m, idx) => {
        const it = doc.createElement("div");
        it.className = "mat-combo-item" + (idx === _activeIdx ? " active" : "");
        it.dataset.idx = String(idx);
        // 顯示「[表單] 材料名稱」(表單留空就只顯示名稱)
        const tbl = (m.table || "").trim();
        const main = doc.createElement("span");
        main.textContent = (tbl ? `[${tbl}] ` : "") + (m.name || "");
        it.appendChild(main);
        if (m.note) {
          const n = doc.createElement("span");
          n.className = "note";
          n.textContent = m.note;
          it.appendChild(n);
        }
        it.addEventListener("mouseenter", () => {
          _activeIdx = idx;
          matMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === idx));
        });
        it.addEventListener("click", () => {
          matInput.value = m.name || "";
          _closeMenu();
        });
        matMenu.appendChild(it);
      });
      if (_activeIdx < 0 && _filteredItems.length) _activeIdx = 0;
      matMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === _activeIdx));
    };
    const _openMenu = () => { matMenu.style.display = ""; _renderMenu(); };
    const _closeMenu = () => { matMenu.style.display = "none"; };
    const _isOpen = () => matMenu.style.display !== "none";
    matInput.addEventListener("focus", _openMenu);
    matInput.addEventListener("click", _openMenu);
    matInput.addEventListener("input", () => { _activeIdx = -1; _openMenu(); });
    matInput.addEventListener("keydown", (e) => {
      if (!_isOpen() && (e.key === "ArrowDown" || e.key === "ArrowUp")) { _openMenu(); e.preventDefault(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (_filteredItems.length) {
          _activeIdx = (_activeIdx + 1) % _filteredItems.length;
          matMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === _activeIdx));
          const active = matMenu.querySelector(".mat-combo-item.active");
          if (active) active.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (_filteredItems.length) {
          _activeIdx = (_activeIdx - 1 + _filteredItems.length) % _filteredItems.length;
          matMenu.querySelectorAll(".mat-combo-item").forEach((el, i) => el.classList.toggle("active", i === _activeIdx));
          const active = matMenu.querySelector(".mat-combo-item.active");
          if (active) active.scrollIntoView({ block: "nearest" });
        }
      } else if (e.key === "Enter") {
        // 若 menu 開且有選 → 套用該項;否則套用目前輸入字串
        e.preventDefault(); e.stopPropagation();
        if (_isOpen() && _activeIdx >= 0 && _filteredItems[_activeIdx]) {
          matInput.value = _filteredItems[_activeIdx].name || "";
          _closeMenu();
        }
        const v = matInput.value.trim();
        if (v) applyMaterial(v);
      } else if (e.key === "Escape") {
        if (_isOpen()) { e.preventDefault(); e.stopPropagation(); _closeMenu(); }
      }
    });
    doc.addEventListener("click", (e) => {
      if (e.target === matInput) return;
      if (matMenu.contains(e.target)) return;
      _closeMenu();
    });
    // 暴露給 openMaterialMgrWindow:當材料清單被修改時即時刷新此下拉(含表單下拉)
    window._searchMaterialDropdownRefresh = () => {
      try { _fillTableSel(); } catch (_) {}
      if (_isOpen()) _renderMenu();
    };

    // keys = 若傳入則使用該 set,否則用 selectedKeys(工具列「套用到所選」走預設)
    const applyMaterial = (matStr, keys) => {
      const targetKeys = keys || selectedKeys;
      if (!targetKeys.size) {
        if (!keys && selInfoSpan) {   // 只有工具列模式才顯示提示
          selInfoSpan.textContent = "請先點選桿件列(Shift / Cmd 多選)";
          selInfoSpan.style.color = "#ff7676";
          setTimeout(() => { selInfoSpan.style.color = ""; refreshSelectionUI(); }, 1800);
        }
        return;
      }
      const _isToolbar = !keys;   // 工具列模式才顯示 pending(inline dropdown 是單筆,沒必要)
      if (_isToolbar && selInfoSpan) {
        selInfoSpan.textContent = `⏳ 套用「${matStr || "(清除)"}」到 ${targetKeys.size} 條…(跨頁同步中)`;
        selInfoSpan.style.color = "#ffd23f";
      }
      // 工具列模式 → setTimeout 0 讓 pending 訊息先渲染再執行(避免 sync 區段把 UI block 住)
      const _doWork = () => _applyMaterialWork(matStr, targetKeys);
      if (_isToolbar) setTimeout(_doWork, 0);
      else _doWork();
    };
    // 實際套用邏輯抽出來,以便 setTimeout 延遲呼叫
    const _applyMaterialWork = (matStr, targetKeys) => {
      try { pushUndo(); } catch (_) {}
      let changed = 0;
      const globalsTouched = new Set();   // 收集所選桿件的 globalMemberId,以便跨頁同步
      // 套用新材料時,同步刷新「表單 + 材料」兩欄(table 字串從 state.materials 反查)
      const _lookupTable = (name) => {
        if (!name || !Array.isArray(state.materials)) return "";
        const found = state.materials.find(mm => (mm && mm.name ? String(mm.name).trim() : "") === name);
        return found && found.table ? String(found.table) : "";
      };
      const _updateCell = (r, v) => {
        const name = v ? String(v).trim() : "";
        if (r.matTd) r.matTd.textContent = name;
        if (r.tblTd) r.tblTd.textContent = _lookupTable(name);
      };
      for (const r of flatRows) {
        if (!targetKeys.has(r.key)) continue;
        const realM = ((r.page && r.page.members) || []).find(x => x.id === r.m.id);
        if (!realM) continue;
        if (matStr) realM.material = matStr; else delete realM.material;
        r.m.material = matStr || undefined;
        _updateCell(r, matStr);
        changed++;
        if (realM.globalMemberId != null) globalsTouched.add(realM.globalMemberId);
      }
      // === 跨頁同步:同一物理桿件(共用 globalMemberId)在其他頁面也套用相同材料 ===
      //   桿件是 page-local 存放,但「材料是 global」屬性 → 任何頁面的同 globalMemberId 桿件都該保持一致
      let crossPageCount = 0;
      if (globalsTouched.size) {
        for (const f of state.files) {
          for (const pg of Object.values(f.pages || {})) {
            if (!pg || pg._orphan) continue;
            for (const mm of (pg.members || [])) {
              if (mm.globalMemberId == null) continue;
              if (!globalsTouched.has(mm.globalMemberId)) continue;
              if (matStr) {
                if (mm.material !== matStr) { mm.material = matStr; crossPageCount++; }
              } else {
                if (mm.material) { delete mm.material; crossPageCount++; }
              }
            }
          }
        }
      }
      // 同步更新「目前 popup 結果中」其他頁面的同 globalMember 列(避免顯示落差)
      for (const r of flatRows) {
        if (!r.m || r.m.globalMemberId == null) continue;
        if (!globalsTouched.has(r.m.globalMemberId)) continue;
        r.m.material = matStr || undefined;
        _updateCell(r, matStr);
      }
      // === 把新材料自動加入 state.materials(global 清單),讓它能持續累積 ===
      //   若目前表單下拉選了具體 table(非 __ALL__ / __NONE__),新材料 entry 也帶上該 table
      if (matStr) {
        if (!Array.isArray(state.materials)) state.materials = [];
        const lower = matStr.toLowerCase();
        const has = state.materials.some(mm => (mm.name || "").trim().toLowerCase() === lower);
        if (!has) {
          const _tableSelVal = (matTableSel && matTableSel.value) || "__ALL__";
          const _tableForNew = (_tableSelVal === "__ALL__" || _tableSelVal === "__NONE__") ? "" : _tableSelVal;
          state.materials.push({ name: matStr, table: _tableForNew, note: "" });
          // 通知材料管理視窗刷新(若已開啟)+ 表單下拉刷新
          if (_materialMgrWin && !_materialMgrWin.closed) {
            try { _materialMgrWin._refresh && _materialMgrWin._refresh(); } catch (_) {}
          }
          try { _fillTableSel(); } catch (_) {}
        }
      }
      try { render && render(); } catch (_) {}
      try { refreshLists && refreshLists(); } catch (_) {}
      if (selInfoSpan) {
        const extra = crossPageCount > 0 ? ` ・ 跨頁同步 +${crossPageCount}` : "";
        selInfoSpan.style.color = "#7fd3ff";
        selInfoSpan.textContent = `✓ 已套用「${matStr || "(清除)"}」到 ${changed} 條${extra}`;
        // 完成訊息 2.5 秒後淡回預設色 + 改回顯示「已選 N 條」
        setTimeout(() => {
          if (!selInfoSpan) return;
          selInfoSpan.style.color = "";
          refreshSelectionUI();
        }, 2500);
      }
    };
    tbar.querySelector("#btnMatApply").addEventListener("click", () => {
      const v = (matInput.value || "").trim();
      if (!v) { matInput.focus(); return; }
      applyMaterial(v);
    });
    tbar.querySelector("#btnMatClear").addEventListener("click", () => applyMaterial(null));
    tbar.querySelector("#btnMatMgr").addEventListener("click", () => { try { openMaterialMgrWindow(); } catch (_) {} });
    tbar.querySelector("#btnSelAll").addEventListener("click", () => {
      for (const r of flatRows) selectedKeys.add(r.key);
      lastClickIdx = flatRows.length ? flatRows.length - 1 : -1;
      refreshSelectionUI();
    });
    tbar.querySelector("#btnSelNone").addEventListener("click", () => {
      selectedKeys.clear(); lastClickIdx = -1; refreshSelectionUI();
    });
  }

  // === group by file+page ===
  const groups = new Map();
  const add = (item, kind) => {
    const key = `${item.file.id}|${item.key}`;
    if (!groups.has(key)) groups.set(key, { file: item.file, key: item.key, page: item.page, joints: [], members: [] });
    const g = groups.get(key);
    if (kind === "joint") g.joints.push(item.j);
    else g.members.push(item.m);
  };
  for (const j of result.joints) add(j, "joint");
  for (const m of result.members) add(m, "member");

  const _world = (file, page, j) => {
    try { return (typeof _worldForRank === "function") ? _worldForRank(file, page, j) : joint2DToWorld3D(file, page, j); }
    catch (_) { return null; }
  };
  const _coordDec = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  const _fmtN = (v) => (Number.isFinite(v) ? v : 0).toFixed(_coordDec);
  const _cmpCoord = (wa, wb) => {
    if (!wa && !wb) return 0;
    if (!wa) return 1;
    if (!wb) return -1;
    if (wa.x !== wb.x) return wa.x - wb.x;
    if (wa.y !== wb.y) return wa.y - wb.y;
    return wa.z - wb.z;
  };
  const _dirLabel = (wa, wb) => {
    if (!wa || !wb) return "?";
    const dx = Math.abs(wb.x - wa.x), dy = Math.abs(wb.y - wa.y), dz = Math.abs(wb.z - wa.z);
    const len = Math.hypot(dx, dy, dz) || 1, TH = 0.999;
    if (dy / len > TH) return "Y";
    if (dx / len > TH) return "X";
    if (dz / len > TH) return "Z";
    return "斜";
  };
  // 群組(= 一個頁面)按平面類型排序:XY > YZ > XZ > 其他
  const _planeOrder = { "XY": 0, "YZ": 1, "XZ": 2 };
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const pa = _planeOrder[a.page && a.page.plane] ?? 99;
    const pb = _planeOrder[b.page && b.page.plane] ?? 99;
    return pa - pb;
  });

  for (const g of sortedGroups) {
    // 群組標題列(收合三角形 + 檔名 + 頁次 + plane tag + 跳到此頁)
    const row = doc.createElement("div");
    row.className = "res-row";
    // 收合 / 展開 三角形(預設展開 ▼;點擊切換 ▶,點擊本身 stopPropagation,不會觸發整列選取)
    const toggle = doc.createElement("span");
    toggle.className = "gr-toggle";
    toggle.textContent = "▼";
    toggle.title = "收合 / 展開此頁面結果表";
    row.appendChild(toggle);
    let _tblForGroup = null;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const collapsed = row.classList.toggle("collapsed");
      toggle.textContent = collapsed ? "▶" : "▼";
      if (_tblForGroup) _tblForGroup.style.display = collapsed ? "none" : "";
    });
    const dispJN = g.joints.length, dispMN = g.members.length;
    const txt = doc.createElement("span");
    txt.style.flex = "1";
    txt.appendChild(doc.createTextNode(`${g.file.name} #${g.key + 1} `));
    const planeTag = doc.createElement("span");
    const _pl = g.page && g.page.plane;
    planeTag.textContent = _pl ? `[${_pl}]` : "[?]";
    // 平面色:跟主畫面左欄檔案清單同色票(XY=青、XZ=紫、YZ=黃、未知=灰)
    const _planeColor = { XY: "#4fc3f7", XZ: "#c39bff", YZ: "#ffd23f" }[_pl] || "#888";
    planeTag.style.cssText = `color:${_planeColor};font-weight:700;margin-right:4px`;
    txt.appendChild(planeTag);
    const parts = [];
    if (dispJN) parts.push(`${dispJN} 點`);
    if (dispMN) parts.push(`${dispMN} 桿`);
    txt.appendChild(doc.createTextNode(`: ${parts.join(" / ")}`));
    row.appendChild(txt);
    const jump = doc.createElement("span");
    jump.className = "jump";
    jump.textContent = "→ 跳到此頁";
    // 阻止點擊跳轉文字時冒泡到 row(避免同時觸發整列選取桿件)
    jump.addEventListener("click", (ev) => { ev.stopPropagation(); });
    jump.onclick = async () => {
      const origText = jump.textContent;
      const origPE = jump.style.pointerEvents, origOp = jump.style.opacity;
      jump.textContent = "⏳ 跳轉中…";
      jump.style.pointerEvents = "none";
      jump.style.opacity = "0.6";
      try {
        try { window.focus(); } catch (_) {}
        if (state.activeFileId !== g.file.id || state.pageIdx !== g.key) {
          jump.textContent = `⏳ 切換到「${g.file.name}」第 ${g.key + 1} 頁…`;
          try { await activatePageWithBusy(g.file.id, g.key); } catch (_) {}
        }
        jump.textContent = "⏳ 計算範圍與縮放…";
        let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
        const upd = (x, y) => { if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (y < mnY) mnY = y; if (y > mxY) mxY = y; };
        for (const j of g.joints) upd(j.x, j.y);
        const jmap = new Map((g.page.joints || []).map(jj => [jj.id, jj]));
        for (const m of g.members) {
          const a = jmap.get(m.j1), b = jmap.get(m.j2);
          if (a) upd(a.x, a.y);
          if (b) upd(b.x, b.y);
        }
        if (isFinite(mnX)) _zoomMainCanvasToRect(mnX, mnY, mxX, mxY, 3.0);
        try {
          if (_3dPreviewWindow && _3dPreviewWindow.win && !_3dPreviewWindow.win.closed) {
            if (typeof _3dPreviewWindow.alignToPage === "function") {
              _3dPreviewWindow.alignToPage(g.file, g.page);
            }
            const b = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
            const ext = (w) => { if (!w) return;
              if (w.x < b.x[0]) b.x[0] = w.x; if (w.x > b.x[1]) b.x[1] = w.x;
              if (w.y < b.y[0]) b.y[0] = w.y; if (w.y > b.y[1]) b.y[1] = w.y;
              if (w.z < b.z[0]) b.z[0] = w.z; if (w.z > b.z[1]) b.z[1] = w.z;
            };
            for (const it of result.joints) if (it.file.id === g.file.id && it.key === g.key) ext(it.w);
            for (const it of result.members) {
              if (it.file.id === g.file.id && it.key === g.key) { ext(it.wa); ext(it.wb); }
            }
            if (Number.isFinite(b.x[0]) && typeof _3dPreviewWindow.zoomToBounds === "function") {
              _3dPreviewWindow.zoomToBounds(b, { padFactor: 2.5 });
            }
          }
        } catch (_) {}
        jump.textContent = "⏳ 選取搜尋結果…";
        try {
          state.selection.joints  = new Set((g.joints  || []).map(j => j.id));
          state.selection.members = new Set((g.members || []).map(m => m.id));
          // ★ 標記 selection 來源頁為剛跳過去的這頁,讓 render 的 _selOnSrc 判斷成立 → 節點/桿件變紫色
          //   只設 selection 不設 source 的話 _selOnSrc=false → 即使有選取也不會上色
          state.selection.sourceFileId = g.file.id;
          state.selection.sourcePageIdx = g.key;
          render && render();
          refreshLists && refreshLists();
        } catch (_) {}
      } finally {
        jump.textContent = origText;
        jump.style.pointerEvents = origPE;
        jump.style.opacity = origOp;
      }
    };
    row.appendChild(jump);
    div.appendChild(row);

    // 紀錄此頁 group 在 flatRows 內的 range 起點(member 列加入前)
    const _grStart = flatRows.length;

    const jmapDetail = new Map((g.page.joints || []).map(jj => [jj.id, jj]));

    // === 合併表:節點 + 桿件(端點縮排顯示在桿件下方,保留座標) ===
    if (g.joints.length || g.members.length) {
      const tbl = doc.createElement("table");
      tbl.className = "res-table member-tbl";
      const cap = doc.createElement("caption");
      cap.textContent = "節點 + 桿件(Click 選桿件列 / Shift 範圍 / Cmd 加減選)";
      tbl.appendChild(cap);
      const thead = doc.createElement("thead");
      thead.innerHTML = _showCoords
        ? `<tr><th>ID</th><th>方向</th>` +
          `<th class="num">X</th><th class="num">Y</th><th class="num">Z</th>` +
          `<th class="num">長度</th><th>表單</th><th>材料</th></tr>`
        : `<tr><th>ID</th><th>方向</th><th>J1</th><th>J2</th>` +
          `<th class="num">長度</th><th>表單</th><th>材料</th></tr>`;
      tbl.appendChild(thead);
      const tbody = doc.createElement("tbody");

      // 1) 標準節點列(只列搜尋命中、但「未被結果中的桿件當端點」的 joint,避免和桿件下方端點列重複)
      //    coord-off 模式下節點失去座標欄,沒太多意義 → 直接隱藏
      const memberEndpointIds = new Set();
      for (const m of g.members) { memberEndpointIds.add(m.j1); memberEndpointIds.add(m.j2); }
      const standaloneJoints = _showCoords ? g.joints.filter(j => !memberEndpointIds.has(j.id)) : [];
      const sortedJoints = standaloneJoints
        .map(j => ({ j, w: _world(g.file, g.page, j) }))
        .filter(x => x.w)
        .sort((a, b) => _cmpCoord(a.w, b.w));
      const _mkJointRow = (j, w, isEndpoint) => {
        const did = "J" + (typeof _displayIdForJointWith === "function" ? _displayIdForJointWith(g.file, g.page, j) : j.id);
        const tr = doc.createElement("tr");
        tr.className = isEndpoint ? "endpoint-row" : "joint-row";
        const tdId = doc.createElement("td");
        tdId.className = "col-jid" + (j.isAnchor ? " anchor" : "") + (isEndpoint ? " endpoint-id" : "");
        tdId.textContent = did + (j.isAnchor ? " ▼" : "");
        tr.appendChild(tdId);
        const tdDir = doc.createElement("td"); tdDir.className = "col-dir muted"; tdDir.textContent = "—";
        tr.appendChild(tdDir);
        for (const v of [w.x, w.y, w.z]) {
          const td = doc.createElement("td"); td.className = "num"; td.textContent = _fmtN(v);
          tr.appendChild(td);
        }
        const tdLen = doc.createElement("td"); tdLen.className = "num muted"; tdLen.textContent = "—";
        tr.appendChild(tdLen);
        // 表單 / 材料 兩欄(joint 列無材料,placeholder)
        const tdTbl = doc.createElement("td"); tdTbl.className = "muted"; tdTbl.textContent = "—";
        tr.appendChild(tdTbl);
        const tdMat = doc.createElement("td"); tdMat.className = "muted"; tdMat.textContent = "—";
        tr.appendChild(tdMat);
        return tr;
      };
      for (const { j, w } of sortedJoints) tbody.appendChild(_mkJointRow(j, w, false));

      // 2) 桿件列 + 其兩端點列(縮排)
      const _midOf = (m) => {
        const v = (typeof displayMemberId === "function") ? displayMemberId(m) : m.id;
        const n = +v;
        return Number.isFinite(n) ? n : String(v);   // 數字優先;非數字退回字串(localeCompare 排序)
      };
      const sortedMembers = g.members
        .map(m => {
          const a = jmapDetail.get(m.j1), b = jmapDetail.get(m.j2);
          if (!a || !b) return null;
          const wa = _world(g.file, g.page, a);
          const wb = _world(g.file, g.page, b);
          if (!wa || !wb) return null;
          const flip = _cmpCoord(wa, wb) > 0;
          return { m, a: flip ? b : a, b: flip ? a : b, wa: flip ? wb : wa, wb: flip ? wa : wb };
        })
        .filter(Boolean)
        // 桿件用 displayMemberId 升序;節點(g.joints 的 sortedJoints)已是座標升序
        .sort((p, q) => {
          const ap = _midOf(p.m), aq = _midOf(q.m);
          if (typeof ap === "number" && typeof aq === "number") return ap - aq;
          return String(ap).localeCompare(String(aq));
        });
      for (const { m, a, b, wa, wb } of sortedMembers) {
        const didM = "M" + (typeof displayMemberId === "function" ? displayMemberId(m) : m.id);
        const len = Math.hypot(wb.x - wa.x, wb.y - wa.y, wb.z - wa.z);
        // 桿件 header 列(可選)
        const tr = doc.createElement("tr");
        tr.className = "member-row";
        const key = `${g.file.id}|${g.key}|${m.id}`;
        tr.dataset.mkey = key;
        const tdId = doc.createElement("td"); tdId.className = "col-mid"; tdId.textContent = didM;
        const tdDir = doc.createElement("td"); tdDir.className = "col-dir"; tdDir.textContent = _dirLabel(wa, wb);
        tr.appendChild(tdId); tr.appendChild(tdDir);
        if (_showCoords) {
          // coord-on:X/Y/Z 三欄留 — ,實際座標出現在下方兩個端點列
          const tdX = doc.createElement("td"); tdX.className = "num muted"; tdX.textContent = "—";
          const tdY = doc.createElement("td"); tdY.className = "num muted"; tdY.textContent = "—";
          const tdZ = doc.createElement("td"); tdZ.className = "num muted"; tdZ.textContent = "—";
          tr.appendChild(tdX); tr.appendChild(tdY); tr.appendChild(tdZ);
        } else {
          // coord-off:桿件那列直接顯示兩端 J1 / J2 ID(無下方端點列)
          const didJ1 = "J" + (typeof _displayIdForJointWith === "function" ? _displayIdForJointWith(g.file, g.page, a) : a.id);
          const didJ2 = "J" + (typeof _displayIdForJointWith === "function" ? _displayIdForJointWith(g.file, g.page, b) : b.id);
          const tdJ1 = doc.createElement("td");
          tdJ1.className = "col-jid" + (a.isAnchor ? " anchor" : "");
          tdJ1.textContent = didJ1 + (a.isAnchor ? " ▼" : "");
          const tdJ2 = doc.createElement("td");
          tdJ2.className = "col-jid" + (b.isAnchor ? " anchor" : "");
          tdJ2.textContent = didJ2 + (b.isAnchor ? " ▼" : "");
          tr.appendChild(tdJ1); tr.appendChild(tdJ2);
        }
        const tdLen = doc.createElement("td"); tdLen.className = "num"; tdLen.textContent = _fmtN(len);
        // 表單 / 材料 兩欄:依 m.material 名稱反查 state.materials 取得對應 table 字串
        //   未綁定材料 / 材料清單沒有此 name → table 欄留空
        const _matTbl = (() => {
          const name = m.material ? String(m.material).trim() : "";
          if (!name || !Array.isArray(state.materials)) return "";
          const found = state.materials.find(mm => (mm && mm.name ? String(mm.name).trim() : "") === name);
          return found && found.table ? String(found.table) : "";
        })();
        const tdTbl = doc.createElement("td"); tdTbl.className = "col-mat";
        tdTbl.textContent = _matTbl;
        const tdMat = doc.createElement("td"); tdMat.className = "col-mat";
        tdMat.textContent = m.material || "";
        tr.appendChild(tdLen); tr.appendChild(tdTbl); tr.appendChild(tdMat);
        const rowIdx = flatRows.length;
        tr.addEventListener("click", (e) => {
          e.preventDefault();
          if (e.shiftKey && lastClickIdx >= 0) {
            const lo = Math.min(rowIdx, lastClickIdx), hi = Math.max(rowIdx, lastClickIdx);
            if (!(e.metaKey || e.ctrlKey)) selectedKeys.clear();
            for (let i = lo; i <= hi; i++) selectedKeys.add(flatRows[i].key);
          } else if (e.metaKey || e.ctrlKey) {
            if (selectedKeys.has(key)) selectedKeys.delete(key);
            else selectedKeys.add(key);
            lastClickIdx = rowIdx;
          } else {
            selectedKeys.clear();
            selectedKeys.add(key);
            lastClickIdx = rowIdx;
          }
          refreshSelectionUI();
        });
        tr.addEventListener("dblclick", () => { try { jump.onclick && jump.onclick(); } catch (_) {} });
        tbody.appendChild(tr);
        flatRows.push({ key, file: g.file, page: g.page, m, tr, matTd: tdMat, tblTd: tdTbl });
        // 兩端點列(僅 coord-on 模式;coord-off 模式 J1/J2 已在桿件那列顯示)
        if (_showCoords) {
          tbody.appendChild(_mkJointRow(a, wa, true));
          tbody.appendChild(_mkJointRow(b, wb, true));
        }
      }

      tbl.appendChild(tbody);
      div.appendChild(tbl);
      _tblForGroup = tbl;   // 讓 toggle (▼/▶) 可以隱藏 / 顯示此 group 的表
    }

    // 此頁 group 在 flatRows 內的 range 終點(member 列加完後)
    const _grEnd = flatRows.length - 1;
    groupRows.push({ row, group: g, firstIdx: _grStart, lastIdx: _grEnd });
    // 整列點擊 → 選取此頁全部桿件(含 Shift / Cmd 行為)
    //   跳轉連結 (.jump) 與 收合三角 (.gr-toggle) 已 stopPropagation,不會落到這裡
    row.addEventListener("click", (e) => {
      if (_grEnd < _grStart) return;             // 此頁無 member 列(只有獨立節點?) → 不做事
      if (e.shiftKey && lastClickIdx >= 0) {
        // Shift:從上次的 anchor 列延伸到此頁最後一個 member 列
        const lo = Math.min(lastClickIdx, _grStart);
        const hi = Math.max(lastClickIdx, _grEnd);
        if (!(e.metaKey || e.ctrlKey)) selectedKeys.clear();
        for (let i = lo; i <= hi; i++) selectedKeys.add(flatRows[i].key);
        lastClickIdx = _grEnd;
      } else if (e.metaKey || e.ctrlKey) {
        // Cmd / Ctrl:整頁切換(若全選 → 全取消;否則 → 全加入)
        let allIn = true;
        for (let i = _grStart; i <= _grEnd && allIn; i++) if (!selectedKeys.has(flatRows[i].key)) allIn = false;
        if (allIn) for (let i = _grStart; i <= _grEnd; i++) selectedKeys.delete(flatRows[i].key);
        else      for (let i = _grStart; i <= _grEnd; i++) selectedKeys.add(flatRows[i].key);
        lastClickIdx = _grEnd;
      } else {
        // 一般點擊:只選此頁的桿件
        selectedKeys.clear();
        for (let i = _grStart; i <= _grEnd; i++) selectedKeys.add(flatRows[i].key);
        lastClickIdx = _grEnd;
      }
      refreshSelectionUI();
    });
  }
  refreshSelectionUI();
}
