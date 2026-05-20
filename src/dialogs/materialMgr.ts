// Phase 8e — 材料管理 popup(工具 → 材料管理)
//   獨立 browser popup window;CRUD state.materials,使用者搜尋桿件時可從下拉選用。
//   主要依賴:
//     • state.materials             — CRUD 目標
//     • setProjectDirty / setMaterialMgrWin — 跨模組寫 let 用的 setter(ESM 限制)
//     • _t / _applyI18nOnDoc       — i18n
//     • window._searchMaterialDropdownRefresh — search popup 開啟時的下拉同步(optional)
// @ts-nocheck

import {
  state,
  setProjectDirty, setMaterialMgrWin, _materialMgrWin,
} from "../legacy";
import { _t, _applyI18nOnDoc } from "../i18n";

export function openMaterialMgrWindow() {
  if (_materialMgrWin && !_materialMgrWin.closed) {
    try { _materialMgrWin.focus(); } catch (_) {}
    try { _materialMgrWin._refresh && _materialMgrWin._refresh(); } catch (_) {}
    return;
  }
  const W = Math.max(640, Math.floor(((window.screen && window.screen.availWidth)  || 1280) * 0.55));
  const H = Math.max(540, Math.floor(((window.screen && window.screen.availHeight) || 800)  * 0.7));
  const win = window.open("", "STAAD_MaterialMgr_" + Date.now(),
    `popup=yes,width=${W},height=${H},scrollbars=no,resizable=yes`);
  if (!win) { alert("彈出視窗被擋住,請允許彈窗"); return; }
  setMaterialMgrWin(win);
  win.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head>
<title>材料管理 - STAAD</title><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 12px; background: #0a0b0d; color: #ddd;
    font-family: -apple-system, system-ui, "Microsoft JhengHei", sans-serif; font-size: 12px;
    display: flex; flex-direction: column; }
  h3 { font-size: 11px; margin: 4px 0; color: #9bb6e8; font-weight: 700; }
  input, button { background: #1a1c20; color: #ddd; border: 1px solid #444;
    padding: 5px 8px; font-size: 12px; border-radius: 3px; font-family: inherit; }
  button { cursor: pointer; }
  button:hover { background: #2a2d33; color: #fff; }
  button.primary { background: #4f9dff; border-color: #4f9dff; color: #fff; }
  button.primary:hover { background: #5fa8ff; }
  button.danger { background: #3a1f1f; border-color: #8a3a3a; color: #ffb0b0; }
  button.danger:hover { background: #5a2f2f; color: #fff; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 8px; background: #16181c; border: 1px solid #2a2d33; border-radius: 4px;
    margin-bottom: 8px; }
  .toolbar input[type=text] { flex: 1 1 180px; min-width: 140px; }
  .info { color: #9aa0a6; font-size: 11px; }
  .list-wrap { flex: 1 1 0; min-height: 200px; overflow: auto;
    border: 1px solid #2a2d33; border-radius: 4px; background: #0d0f12; }
  table.mat-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.mat-table th { position: sticky; top: 0; background: #1d2025; color: #aab;
    text-align: left; padding: 6px 10px; font-weight: 700; border-bottom: 1px solid #333; z-index: 2; }
  table.mat-table td { padding: 4px 10px; border-bottom: 1px solid #1f2126; color: #cfd3d8; }
  table.mat-table tbody tr:hover td { background: rgba(79,157,255,0.10); }
  table.mat-table input[type=text] { width: 100%; padding: 3px 6px; font-size: 12px;
    background: transparent; border: 1px solid transparent; border-radius: 2px; }
  table.mat-table input[type=text]:focus { outline: none; border-color: #4f9dff; background: #1a1c20; }
  table.mat-table td.actions { width: 90px; text-align: right; }
  table.mat-table .del-btn { padding: 2px 8px; font-size: 11px; color: #ff7676; border-color: #5a3434; background: transparent; }
  table.mat-table .del-btn:hover { background: #3a1f1f; color: #fff; }
  table.mat-table tbody tr.dup td { background: rgba(255,140,0,0.10); }
  table.mat-table tbody tr.dup td::after { /* no-op */ }
  .col-name { width: 32%; }
  .col-note { width: auto; }
  .empty { padding: 24px; text-align: center; color: #7b818a; font-style: italic; }
  .footer { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
  .stats { color: #9bb6e8; font-weight: 700; font-size: 11px; }
  .name-cell.invalid input { border-color: #ff7676 !important; background: rgba(255,118,118,0.08) !important; }
</style></head><body></body></html>`);
  win.document.close();
  const doc = win.document;
  const body = doc.body;
  body.innerHTML = `
    <h3 data-i18n="mm.title">材料管理(專案層級;會隨專案存檔)</h3>
    <div class="toolbar">
      <input type="text" id="newMatTable" data-i18n-placeholder="mm.tablePlaceholder" placeholder="STAAD 表單(例:UPT 5 / TABLE ST)" style="max-width:200px" title="STAAD 資料庫表單識別字串,例:UPT 5、TABLE ST、TABLE FU、TABLE LD…(匯出 .std MEMBER PROPERTY 時放在材料名稱前面)">
      <input type="text" id="newMatName" data-i18n-placeholder="mm.namePlaceholder" placeholder="材料名稱(例:T10010090 / H300x150x6.5x9)">
      <input type="text" id="newMatNote" data-i18n-placeholder="mm.notePlaceholder" placeholder="備註(可選)" style="max-width:160px">
      <button id="btnAdd" class="primary" data-i18n="mm.addBtn">新增 (Enter)</button>
      <span style="flex:1"></span>
      <input type="text" id="filterInput" data-i18n-placeholder="mm.filterPlaceholder" placeholder="🔎 過濾..." style="max-width:180px">
    </div>
    <div class="list-wrap">
      <table class="mat-table">
        <thead><tr>
          <th class="col-table" data-i18n="mm.colTable" style="width:120px">表單</th>
          <th class="col-name" data-i18n="mm.colName">材料名稱</th>
          <th class="col-note" data-i18n="mm.colNote">備註</th>
          <th class="actions" data-i18n="mm.colActions">操作</th>
        </tr></thead>
        <tbody id="matBody"></tbody>
      </table>
      <div id="emptyHint" class="empty" data-i18n="mm.emptyHint" style="display:none">尚無材料 — 在上方輸入名稱後按「新增」開始建立</div>
    </div>
    <div class="footer">
      <span class="stats" id="matStats" data-i18n="mm.statsZero">共 0 筆</span>
      <span style="flex:1"></span>
      <button id="btnClearAll" class="danger" data-i18n="mm.clearAll" title="清空所有材料(僅清除清單;桿件上已套用的 material 字串不會被改動)">清空全部…</button>
      <span class="info" data-i18n="mm.footerHint">關閉視窗 / Esc 即儲存到專案</span>
    </div>
  `;
  const inpTable = body.querySelector("#newMatTable");
  const inpName  = body.querySelector("#newMatName");
  const inpNote  = body.querySelector("#newMatNote");
  const btnAdd   = body.querySelector("#btnAdd");
  const filterIn = body.querySelector("#filterInput");
  const matBody  = body.querySelector("#matBody");
  const matStats = body.querySelector("#matStats");
  const emptyHint = body.querySelector("#emptyHint");
  const btnClearAll = body.querySelector("#btnClearAll");
  let _filterText = "";
  const _refresh = () => {
    const list = Array.isArray(state.materials) ? state.materials : [];
    // 過濾(case-insensitive,name 或 note 任一含關鍵字)
    const q = _filterText.trim().toLowerCase();
    const filtered = q
      ? list.filter(m =>
          (m.name  || "").toLowerCase().includes(q) ||
          (m.note  || "").toLowerCase().includes(q) ||
          (m.table || "").toLowerCase().includes(q))
      : list.slice();
    matBody.innerHTML = "";
    if (!filtered.length) {
      emptyHint.style.display = "";
      emptyHint.textContent = q ? "沒有符合過濾條件的材料" : "尚無材料 — 在上方輸入名稱後按「新增」開始建立";
    } else {
      emptyHint.style.display = "none";
      // 名稱重複偵測(以原 list 計算,顯示時若重複給警示色)
      const nameCount = new Map();
      for (const m of list) {
        const k = (m.name || "").trim().toLowerCase();
        if (k) nameCount.set(k, (nameCount.get(k) || 0) + 1);
      }
      // 依「表單(table)」分群:同一表單下可有多個材料 → 群首插 header row
      //   空 table 群放最後標 "(無表單)";群內依 name 字典序排
      const groups = new Map();
      for (const m of filtered) {
        const t = (m.table || "").trim();
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(m);
      }
      const sortedTables = [...groups.keys()].sort((a, b) => {
        if (!a && b) return 1;       // 空 table 排最後
        if (a && !b) return -1;
        return String(a).localeCompare(String(b));
      });
      const _addRow = (m) => {
        const origIdx = list.indexOf(m);
        const tr = doc.createElement("tr");
        const dup = nameCount.get((m.name || "").trim().toLowerCase()) > 1;
        if (dup) tr.classList.add("dup");
        // table (STAAD 資料庫表單,例:UPT 5 / TABLE ST)
        const tdTable = doc.createElement("td");
        const inTbl = doc.createElement("input");
        inTbl.type = "text"; inTbl.value = m.table || "";
        inTbl.placeholder = "UPT 5";
        inTbl.title = "STAAD 資料庫表單識別字串,匯出 .std MEMBER PROPERTY 時會放在材料名稱前面";
        inTbl.addEventListener("input", () => { m.table = inTbl.value; _markDirty(); });
        inTbl.addEventListener("blur", () => { m.table = inTbl.value.trim(); inTbl.value = m.table; _refresh(); });
        tdTable.appendChild(inTbl); tr.appendChild(tdTable);
        // name
        const tdName = doc.createElement("td");
        tdName.className = "name-cell" + (!m.name || !m.name.trim() ? " invalid" : "");
        const inN = doc.createElement("input");
        inN.type = "text"; inN.value = m.name || "";
        inN.addEventListener("input", () => {
          m.name = inN.value;
          tdName.classList.toggle("invalid", !m.name.trim());
          _markDirty();
        });
        inN.addEventListener("blur", () => { m.name = inN.value.trim(); inN.value = m.name; _refresh(); });
        tdName.appendChild(inN); tr.appendChild(tdName);
        // note
        const tdNote = doc.createElement("td");
        const inT = doc.createElement("input");
        inT.type = "text"; inT.value = m.note || "";
        inT.addEventListener("input", () => { m.note = inT.value; _markDirty(); });
        tdNote.appendChild(inT); tr.appendChild(tdNote);
        // action
        const tdAct = doc.createElement("td");
        tdAct.className = "actions";
        const btnDel = doc.createElement("button");
        btnDel.className = "del-btn";
        btnDel.dataset.i18n = "mm.delete";
        btnDel.textContent = (typeof _t === "function" && _t("mm.delete")) || "刪除";
        btnDel.addEventListener("click", () => {
          // 用 popup 自己的 confirm(否則對話框跳到主視窗,彈窗使用者看不到 → 以為刪除沒反應)
          if (!win.confirm(`刪除材料「${m.name || "(空白)"}」?\n(已套用此材料的桿件 material 字串不會被改動)`)) return;
          if (origIdx >= 0) state.materials.splice(origIdx, 1);
          _markDirty();
          _refresh();
          try {
            const fn = (window as any)._searchMaterialDropdownRefresh;
            fn && fn();
          } catch (_) {}
        });
        tdAct.appendChild(btnDel); tr.appendChild(tdAct);
        matBody.appendChild(tr);
      };
      // 逐表單(table)輸出:先插一行群首 header,再依 name 字典序列出該群下材料
      for (const tbl of sortedTables) {
        const items = groups.get(tbl).slice().sort((a, b) =>
          String(a.name || "").localeCompare(String(b.name || ""))
        );
        const trHead = doc.createElement("tr");
        trHead.className = "mat-group-head";
        const tdHead = doc.createElement("td");
        tdHead.colSpan = 4;
        tdHead.textContent = tbl
          ? `* 表單 ${tbl} (${items.length})`
          : `* (無表單) (${items.length})`;
        tdHead.style.cssText = "background:#2a2c30;color:#9bb6e8;font-weight:700;padding:5px 8px;border-top:1px solid #444";
        trHead.appendChild(tdHead);
        matBody.appendChild(trHead);
        for (const m of items) _addRow(m);
      }
    }
    const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
    matStats.textContent = q
      ? `${filtered.length} / ${list.length} ${T("mm.unit","筆")}${T("mm.filtered","(已過濾)")}`
      : `${T("mm.totalPrefix","共")} ${list.length} ${T("mm.unit","筆")}`;
  };
  const _markDirty = () => {
    // 任何 CRUD 都標 projectDirty,讓使用者下次可以儲存
    try { setProjectDirty(true); } catch (_) {}
    // 主畫面的搜尋 popup(若已開啟)需更新材料下拉
    try {
      const fn = (window as any)._searchMaterialDropdownRefresh;
      fn && fn();
    } catch (_) {}
  };
  const _addCurrent = () => {
    const name  = (inpName.value  || "").trim();
    const table = (inpTable.value || "").trim();
    if (!name) { inpName.focus(); return; }
    if (!Array.isArray(state.materials)) state.materials = [];
    // 避免重複(以「表單 + 材料名稱」為唯一索引,不同表單的相同名稱應該並存,例:UPT 5/T100 與 TABLE ST/T100)
    if (state.materials.some(m =>
      (m.name || "").trim().toLowerCase() === name.toLowerCase() &&
      (m.table || "").trim().toLowerCase() === table.toLowerCase()
    )) {
      win.alert(`材料「${table ? table + "  " : ""}${name}」已存在`);
      inpName.select();
      return;
    }
    state.materials.push({ name, table, note: (inpNote.value || "").trim() });
    inpTable.value = ""; inpName.value = ""; inpNote.value = "";
    inpTable.focus();
    _markDirty();
    _refresh();
  };
  btnAdd.addEventListener("click", _addCurrent);
  inpTable.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); _addCurrent(); } });
  inpName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); _addCurrent(); } });
  inpNote.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); _addCurrent(); } });
  filterIn.addEventListener("input", () => { _filterText = filterIn.value; _refresh(); });
  btnClearAll.addEventListener("click", () => {
    if (!Array.isArray(state.materials) || !state.materials.length) return;
    if (!win.confirm(`清空所有 ${state.materials.length} 筆材料?\n(桿件 m.material 字串不會被改動)`)) return;
    state.materials.length = 0;
    _markDirty();
    _refresh();
  });
  win.addEventListener("keydown", (e) => { if (e.key === "Escape") { try { win.close(); } catch (_) {} } });
  // 主視窗關閉時連帶關掉(同 search popup 模式)
  const _onMainUnload = () => { try { win.close(); } catch (_) {} };
  window.addEventListener("beforeunload", _onMainUnload);
  window.addEventListener("pagehide",     _onMainUnload);
  window.addEventListener("unload",       _onMainUnload);
  win.addEventListener("beforeunload", () => {
    window.removeEventListener("beforeunload", _onMainUnload);
    window.removeEventListener("pagehide",     _onMainUnload);
    window.removeEventListener("unload",       _onMainUnload);
    setMaterialMgrWin(null);
  });
  _refresh();
  win._refresh = _refresh;   // 供下次 focus 時刷新(以防外部修改了材料)
  try { _applyI18nOnDoc(doc); } catch (_) {}
  try { inpName.focus(); } catch (_) {}
}
