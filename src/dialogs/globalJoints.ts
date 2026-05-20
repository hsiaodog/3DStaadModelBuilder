// Phase 5 — 全局節點管理 dialog + 跳轉 popup(從 legacy.ts 整段搬過來,@ts-nocheck 過渡)
//   功能:列出所有 globalJoint、搜尋(label / 內部 id / 顯示編號 / 座標 fuzzy)、
//        篩選 + 排序、左清單 + 右詳細、編輯 label、跳轉 / 解除單一綁定、設原點、刪除
// @ts-nocheck

import {
  state, $, render, refreshLists, escapeHtml,
  pushUndo, clearSelection, _markSelectionSourceIfEmpty,
  activatePageWithBusy, calibrateAllFilesToGlobalOrigin,
} from "../legacy";
import { listGlobalBindings, inferAllGlobalJoints } from "../core/globalJoints";
import { _displayIdForJointWith } from "../core/displayId";

export 
function openGlobalJointMgrDialog() {
  const dlg = document.getElementById("globalJointMgrDialog");
  if (!dlg) return;
  const summaryEl = document.getElementById("gjmSummary");
  const searchEl  = document.getElementById("gjmSearch");
  const filterEl  = document.getElementById("gjmFilter");
  const sortEl    = document.getElementById("gjmSort");
  const countEl   = document.getElementById("gjmCount");
  const listEl    = document.getElementById("gjmList");
  const detailEl  = document.getElementById("gjmDetail");
  // 狀態:目前選中的 globalJoint id;搜尋字串;filter/sort 值
  let selectedGid = null;
  let searchStr = "";
  let filterMode = "all";
  let sortMode = "id";
  const _gjmFmtCoord = (v) => Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : "—";
  // 取得 globalJoint 對應的「顯示編號(XX·ZZ·YY 組合)」— 用第一個 binding 套既有 _displayIdForJointWith
  //   binding 內的 jointId 可能跟 g.id 不同(globalId vs 本地 j.id);跨頁同物理點都拿到一樣的顯示編號
  const _gjmDisplayIdFor = (g, st) => {
    const binds = (st && st.binds) || listGlobalBindings(g.id);
    if (!binds.length) return null;
    const b = binds[0];
    const f = state.files.find(ff => ff.id === b.fileId);
    const pg = f && f.pages ? f.pages[b.pageIdx] : null;
    const j = pg && (pg.joints || []).find(jj => jj.id === b.jointId);
    if (!f || !pg || !j) return null;
    try {
      const d = _displayIdForJointWith(f, pg, j);
      return (d != null) ? String(d) : null;
    } catch (_) { return null; }
  };
  const _gjmBindStats = () => {
    // 預先建一份 gid → { binds, fileSet, warnCount, onThisPage, displayId } 以加速 filter/sort
    const m = new Map();
    for (const g of (state.globalJoints || [])) {
      const binds = listGlobalBindings(g.id);
      const fileSet = new Set(binds.map(b => b.fileId));
      const st = {
        binds,
        fileSet,
        warnCount: (g.warnings && g.warnings.length) || 0,
        onThisPage: binds.some(b => b.fileId === state.activeFileId && b.pageIdx === (state.pageIdx || 0)),
      };
      st.displayId = _gjmDisplayIdFor(g, st);
      m.set(g.id, st);
    }
    return m;
  };
  // 解析搜尋字串 → 判定模式;
  //   3 個以上有效數字(逗號/空白分隔)→ 座標 fuzzy 模式(distance ascending)
  //   單一純數字 → 內部 id / 顯示編號雙比對
  //   其他 → 文字 substring(label / N+id)
  const _gjmParseSearch = (raw) => {
    const s = (raw || "").trim();
    if (!s) return { mode: "none" };
    const parts = s.split(/[,\s]+/).filter(x => x.length > 0);
    const nums = parts.map(Number);
    if (parts.length >= 3 && nums.slice(0, 3).every(Number.isFinite)) {
      return { mode: "coord", x: nums[0], y: nums[1], z: nums[2] };
    }
    if (parts.length === 1 && /^\d+$/.test(parts[0])) {
      return { mode: "id", n: parts[0] };
    }
    return { mode: "text", text: s.toLowerCase() };
  };
  const _gjmFiltered = (allGs, stats) => {
    const sp = _gjmParseSearch(searchStr);
    return allGs.filter(g => {
      const st = stats.get(g.id);
      if (filterMode === "this" && !st.onThisPage) return false;
      if (filterMode === "warn" && st.warnCount === 0) return false;
      if (filterMode === "multi" && st.fileSet.size < 2) return false;
      if (filterMode === "origin" && state.globalOriginId !== g.id) return false;
      // 座標 fuzzy 模式不在 filter 階段做篩(全部都顯示,按距離排;sort 階段處理)
      if (sp.mode === "coord") return true;
      if (sp.mode === "id") {
        if (String(g.id).includes(sp.n)) return true;
        if (st.displayId && String(st.displayId).includes(sp.n)) return true;
        // 也讓 label 含數字時可被找到(例如 "N5")
        if ((g.label || "").toLowerCase().includes(sp.n)) return true;
        return false;
      }
      if (sp.mode === "text") {
        const lab = (g.label || ("N" + g.id)).toLowerCase();
        if (lab.includes(sp.text)) return true;
        if (String(g.id).includes(sp.text)) return true;
        if (st.displayId && String(st.displayId).toLowerCase().includes(sp.text)) return true;
        return false;
      }
      return true;
    });
  };
  const _gjmSorted = (gs, stats) => {
    const sp = _gjmParseSearch(searchStr);
    const arr = gs.slice();
    // 座標 fuzzy 模式:距離升冪排,蓋掉使用者選的 sort(因為距離才是這個模式的意義)
    if (sp.mode === "coord") {
      const tx = sp.x, ty = sp.y, tz = sp.z;
      for (const g of arr) {
        const dx = (g.x != null ? g.x : 0) - tx;
        const dy = (g.y != null ? g.y : 0) - ty;
        const dz = (g.z != null ? g.z : 0) - tz;
        g._gjmDist = (g.x != null && g.y != null && g.z != null)
          ? Math.hypot(dx, dy, dz) : Infinity;
      }
      arr.sort((a, b) => a._gjmDist - b._gjmDist);
      return arr;
    }
    switch (sortMode) {
      case "label": arr.sort((a, b) => (a.label || "").localeCompare(b.label || "")); break;
      case "binds": arr.sort((a, b) => (stats.get(b.id).binds.length - stats.get(a.id).binds.length)); break;
      case "warns": arr.sort((a, b) => (stats.get(b.id).warnCount - stats.get(a.id).warnCount)); break;
      case "id":
      default:      arr.sort((a, b) => a.id - b.id); break;
    }
    return arr;
  };
  const _refresh = () => {
    const all = state.globalJoints || [];
    const stats = _gjmBindStats();
    if (summaryEl) {
      const totalWarn = all.reduce((s, g) => s + ((g.warnings && g.warnings.length) || 0), 0);
      const onThis = all.filter(g => stats.get(g.id).onThisPage).length;
      summaryEl.innerHTML = `共 <b>${all.length}</b> 個全局節點 ・ 本頁有綁 <b>${onThis}</b> 個 ・ 有警告 <b>${totalWarn}</b> 個 ・ 原點:<b>${state.globalOriginId != null ? ("N" + state.globalOriginId) : "未指定"}</b>`;
    }
    const fs = _gjmFiltered(all, stats);
    const ss = _gjmSorted(fs, stats);
    if (countEl) countEl.textContent = `顯示 ${ss.length} / ${all.length}`;
    // 若 selectedGid 不在過濾後清單,改成第一筆(或 null)
    if (selectedGid != null && !ss.some(g => g.id === selectedGid)) {
      selectedGid = ss.length ? ss[0].id : null;
    } else if (selectedGid == null && ss.length) {
      selectedGid = ss[0].id;
    }
    _renderList(ss, stats);
    _renderDetail(stats);
  };
  const _renderList = (gs, stats) => {
    listEl.innerHTML = "";
    if (!gs.length) {
      const e = document.createElement("div");
      e.style.cssText = "color:#7b818a;font-size:11px;font-style:italic;padding:14px";
      e.textContent = (state.globalJoints && state.globalJoints.length)
        ? "目前篩選 / 搜尋條件下無結果"
        : "尚無全局節點 — 主畫面右鍵節點 → 設為全局節點";
      listEl.appendChild(e);
      return;
    }
    const sp = _gjmParseSearch(searchStr);
    for (const g of gs) {
      const st = stats.get(g.id);
      const row = document.createElement("div");
      row.className = "gjm-row";
      if (g.id === selectedGid) row.classList.add("active");
      const head = document.createElement("div");
      head.className = "gjm-row-head";
      const lblSpan = document.createElement("span");
      lblSpan.className = "lbl" + (st.onThisPage ? " on-this-page" : "");
      lblSpan.textContent = g.label || ("N" + g.id);
      head.appendChild(lblSpan);
      // 顯示編號(XX·ZZ·YY 組合)— 跟 joint label 上看到的數字一致
      if (st.displayId) {
        const dsp = document.createElement("span");
        dsp.style.cssText = "color:#b8e986;font-size:11px;font-variant-numeric:tabular-nums";
        dsp.title = "節點顯示編號(XX·ZZ·YY)— 跟主畫面 joint 標籤的數字一致";
        dsp.textContent = `#${st.displayId}`;
        head.appendChild(dsp);
      }
      const coordSpan = document.createElement("span");
      coordSpan.className = "coord";
      coordSpan.textContent = (g.x != null || g.y != null || g.z != null)
        ? `(${_gjmFmtCoord(g.x)}, ${_gjmFmtCoord(g.y)}, ${_gjmFmtCoord(g.z)})`
        : "(3D 未推得)";
      head.appendChild(coordSpan);
      if (state.globalOriginId === g.id) {
        const b = document.createElement("span"); b.className = "badge-origin"; b.textContent = "原點"; head.appendChild(b);
      }
      if (st.warnCount > 0) {
        const w = document.createElement("span"); w.className = "badge-warn"; w.textContent = "⚠"; w.title = `${st.warnCount} 條警告`; head.appendChild(w);
      }
      // 座標 fuzzy 搜尋下,顯示距離 badge
      if (sp.mode === "coord" && Number.isFinite(g._gjmDist)) {
        const d = document.createElement("span");
        d.style.cssText = "color:#ffd23f;font-size:10px;font-variant-numeric:tabular-nums";
        d.textContent = `Δ ${(Math.round(g._gjmDist * 10) / 10).toFixed(1)} mm`;
        head.appendChild(d);
      }
      row.appendChild(head);
      const meta = document.createElement("div");
      meta.className = "gjm-row-meta";
      const namesArr = st.binds.slice(0, 4).map(b => `${b.fileName}#${b.pageIdx + 1}`);
      const extra = st.binds.length > 4 ? `, … +${st.binds.length - 4}` : "";
      meta.textContent = `${st.binds.length} 處 ・ ${st.fileSet.size} 檔 ・ ${namesArr.join(", ")}${extra}`;
      row.appendChild(meta);
      row.addEventListener("click", () => {
        selectedGid = g.id;
        _refresh();
      });
      listEl.appendChild(row);
    }
  };
  const _renderDetail = (stats) => {
    detailEl.innerHTML = "";
    if (selectedGid == null) {
      const e = document.createElement("div"); e.className = "empty";
      e.textContent = "點左側清單任一筆查看詳細資料";
      detailEl.appendChild(e); return;
    }
    const g = (state.globalJoints || []).find(x => x.id === selectedGid);
    if (!g) { detailEl.innerHTML = '<div class="empty">節點已不存在</div>'; return; }
    const st = stats.get(g.id);
    // 標題 — label + 顯示編號 + 綁定數
    const head = document.createElement("div"); head.className = "gjm-detail-head";
    const dispTag = st.displayId ? ` ・ <span style="color:#b8e986;font-size:12px;font-variant-numeric:tabular-nums">#${st.displayId}</span>` : "";
    head.innerHTML = `${escapeHtml(g.label || ("N" + g.id))}${dispTag}  ・  ${st.binds.length} 處綁定  ・  ${st.fileSet.size} 個檔`;
    detailEl.appendChild(head);
    // 顯示編號欄位(獨立一行,方便複製)
    if (st.displayId) {
      const f = document.createElement("div"); f.className = "gjm-field";
      const lbl = document.createElement("div"); lbl.className = "gjm-field-label"; lbl.textContent = "顯示編號(XX·ZZ·YY)";
      const val = document.createElement("div");
      val.style.cssText = "color:#b8e986;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;user-select:all";
      val.textContent = String(st.displayId);
      f.appendChild(lbl); f.appendChild(val); detailEl.appendChild(f);
    }
    // Label 編輯
    {
      const f = document.createElement("div"); f.className = "gjm-field";
      const lbl = document.createElement("div"); lbl.className = "gjm-field-label"; lbl.textContent = "label";
      const inp = document.createElement("input"); inp.type = "text"; inp.value = g.label || ""; inp.placeholder = "N" + g.id;
      inp.addEventListener("change", () => {
        const v = String(inp.value || "").trim();
        if (!v) { inp.value = g.label || ""; return; }
        if ((state.globalJoints || []).some(x => x.id !== g.id && (x.label || "") === v)) {
          alert(`label「${v}」已被其他全局節點使用`);
          inp.value = g.label || ""; return;
        }
        pushUndo();
        g.label = v;
        if (typeof refreshLists === "function") refreshLists();
        _refresh();
      });
      f.appendChild(lbl); f.appendChild(inp); detailEl.appendChild(f);
    }
    // 世界座標(唯讀)
    {
      const f = document.createElement("div"); f.className = "gjm-field";
      const lbl = document.createElement("div"); lbl.className = "gjm-field-label"; lbl.textContent = "世界座標 (mm,推算)";
      const grid = document.createElement("div"); grid.className = "coord-grid";
      for (const [ax, v] of [["X", g.x], ["Y", g.y], ["Z", g.z]]) {
        const a = document.createElement("span"); a.className = "ax"; a.textContent = ax; grid.appendChild(a);
        const c = document.createElement("span"); c.textContent = Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "—"; grid.appendChild(c);
      }
      f.appendChild(lbl); f.appendChild(grid); detailEl.appendChild(f);
    }
    // 綁定清單
    {
      const f = document.createElement("div"); f.className = "gjm-field";
      const lbl = document.createElement("div"); lbl.className = "gjm-field-label"; lbl.textContent = `綁定 (${st.binds.length})`;
      f.appendChild(lbl);
      const ul = document.createElement("ul"); ul.className = "gjm-binds";
      for (const b of st.binds) {
        const li = document.createElement("li");
        const cur = (b.fileId === state.activeFileId && b.pageIdx === (state.pageIdx || 0));
        const name = document.createElement("span"); name.className = "name" + (cur ? " cur" : "");
        name.textContent = `${b.fileName}#${b.pageIdx + 1}` + (cur ? "  (本頁)" : "");
        li.appendChild(name);
        const btnJump = document.createElement("button");
        btnJump.textContent = "跳轉";
        btnJump.title = `跳到 ${b.fileName} 第 ${b.pageIdx + 1} 頁`;
        btnJump.addEventListener("click", () => {
          if (typeof activatePageWithBusy === "function") {
            activatePageWithBusy(b.fileId, b.pageIdx).then(() => {
              clearSelection();
              state.selection.joints.add(b.jointId);
              _markSelectionSourceIfEmpty();
              render(); refreshLists();
            });
          }
          // 不關 dialog,讓使用者繼續操作
        });
        li.appendChild(btnJump);
        const btnUnbind = document.createElement("button");
        btnUnbind.textContent = "解除";
        btnUnbind.className = "danger";
        btnUnbind.title = `解除 ${b.fileName}#${b.pageIdx + 1} 的 joint ${b.jointId} 跟此全局節點的綁定`;
        btnUnbind.addEventListener("click", () => {
          if (!confirm(`解除 ${b.fileName}#${b.pageIdx + 1} 的 joint ${b.jointId} 跟「${g.label || ('N' + g.id)}」的綁定?`)) return;
          pushUndo();
          const f0 = state.files.find(ff => ff.id === b.fileId);
          const pg0 = f0 && f0.pages ? f0.pages[b.pageIdx] : null;
          if (pg0) {
            const j0 = (pg0.joints || []).find(jj => jj.id === b.jointId);
            if (j0) j0.globalId = null;
          }
          if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
          if (typeof refreshLists === "function") refreshLists();
          render();
          _refresh();
        });
        li.appendChild(btnUnbind);
        ul.appendChild(li);
      }
      if (!st.binds.length) {
        const empty = document.createElement("li"); empty.textContent = "(無)"; empty.style.color = "#7b818a"; empty.style.fontStyle = "italic";
        ul.appendChild(empty);
      }
      f.appendChild(ul); detailEl.appendChild(f);
    }
    // 警告區
    if (g.warnings && g.warnings.length) {
      const w = document.createElement("div");
      w.className = "gjm-warnings";
      w.innerHTML = "<b>警告:</b><br>" + g.warnings.map(x => `• ${x.message || x}`).join("<br>");
      detailEl.appendChild(w);
    }
    // 動作區
    {
      const ac = document.createElement("div"); ac.className = "gjm-actions";
      const isOrigin = (state.globalOriginId === g.id);
      const btnOrig = document.createElement("button");
      btnOrig.textContent = isOrigin ? "⭐ 已是世界原點" : "⭐ 設為世界原點";
      btnOrig.disabled = isOrigin;
      btnOrig.title = isOrigin ? "此節點目前是世界 (0, 0, 0)" : "把此節點鎖定為世界 (0, 0, 0) 並校準所有檔案的 planeOrigin / pageZ";
      btnOrig.addEventListener("click", () => {
        if (typeof calibrateAllFilesToGlobalOrigin === "function") {
          if (calibrateAllFilesToGlobalOrigin({ globalJointId: g.id })) _refresh();
        }
      });
      ac.appendChild(btnOrig);
      const btnClear = document.createElement("button");
      btnClear.textContent = "🗑 解除所有綁定";
      btnClear.className = "danger";
      btnClear.title = "把所有檔的本 globalJoint 綁定全部解除(節點本身仍保留)";
      btnClear.addEventListener("click", () => {
        if (!confirm(`解除「${g.label || ('N' + g.id)}」的全部 ${st.binds.length} 個綁定?`)) return;
        pushUndo();
        for (const b of st.binds) {
          const f0 = state.files.find(ff => ff.id === b.fileId);
          const pg0 = f0 && f0.pages ? f0.pages[b.pageIdx] : null;
          if (pg0) {
            const j0 = (pg0.joints || []).find(jj => jj.id === b.jointId);
            if (j0) j0.globalId = null;
          }
        }
        if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
        if (typeof refreshLists === "function") refreshLists();
        render();
        _refresh();
      });
      ac.appendChild(btnClear);
      const btnDel = document.createElement("button");
      btnDel.textContent = "✂ 刪除此全局節點";
      btnDel.className = "danger";
      btnDel.title = "刪除此 globalJoint(會先解除所有綁定);無法復原請先儲存";
      btnDel.addEventListener("click", () => {
        if (!confirm(`刪除全局節點「${g.label || ('N' + g.id)}」?\n\n會先解除其所有綁定,再從 state.globalJoints 移除。`)) return;
        pushUndo();
        for (const b of st.binds) {
          const f0 = state.files.find(ff => ff.id === b.fileId);
          const pg0 = f0 && f0.pages ? f0.pages[b.pageIdx] : null;
          if (pg0) {
            const j0 = (pg0.joints || []).find(jj => jj.id === b.jointId);
            if (j0) j0.globalId = null;
          }
        }
        state.globalJoints = (state.globalJoints || []).filter(x => x.id !== g.id);
        if (state.globalOriginId === g.id) state.globalOriginId = null;
        selectedGid = null;
        if (typeof refreshLists === "function") refreshLists();
        render();
        _refresh();
      });
      ac.appendChild(btnDel);
      detailEl.appendChild(ac);
    }
  };
  // 工具列事件
  if (searchEl) searchEl.oninput = () => { searchStr = searchEl.value; _refresh(); };
  if (filterEl) filterEl.onchange = () => { filterMode = filterEl.value; _refresh(); };
  if (sortEl)   sortEl.onchange   = () => { sortMode   = sortEl.value;   _refresh(); };
  // 關閉
  const _closeDlg = () => { dlg.classList.remove("active"); };
  const btnClose = document.getElementById("gjmClose");
  const btnCloseFooter = document.getElementById("gjmCloseBtn");
  if (btnClose) btnClose.onclick = _closeDlg;
  if (btnCloseFooter) btnCloseFooter.onclick = _closeDlg;
  const mask = dlg.querySelector(".gjm-mask");
  if (mask) mask.onclick = _closeDlg;
  // 拖曳標題列(複用 floorTypesDialog 同樣 pattern;只 init 一次)
  if (!openGlobalJointMgrDialog._dragInited) {
    openGlobalJointMgrDialog._dragInited = true;
    const card = dlg.querySelector(".dlg-card");
    const tbar = dlg.querySelector(".gjm-titlebar");
    if (card && tbar) {
      let drag = null;
      tbar.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.classList.contains("gjm-close")) return;
        const rect = card.getBoundingClientRect();
        card.style.position = "absolute";
        card.style.left = rect.left + "px";
        card.style.top  = rect.top  + "px";
        card.style.margin = "0";
        drag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 40;
        const nx = Math.max(-card.offsetWidth + 100, Math.min(maxX, drag.left + (e.clientX - drag.startX)));
        const ny = Math.max(0, Math.min(maxY, drag.top + (e.clientY - drag.startY)));
        card.style.left = nx + "px";
        card.style.top  = ny + "px";
      });
      window.addEventListener("mouseup", () => { drag = null; });
    }
  }
  // 啟動 — 確保 input/select 值同步
  if (searchEl) searchEl.value = "";
  if (filterEl) filterEl.value = "all";
  if (sortEl)   sortEl.value   = "id";
  searchStr = ""; filterMode = "all"; sortMode = "id";
  _refresh();
  dlg.classList.add("active");
}

export 
function showGlobalJointJumpPopup(anchor, gid) {
  const pop = document.getElementById("gjJumpPopup");
  if (!pop || !anchor) return;
  const g = (state.globalJoints || []).find(x => x.id === gid);
  if (!g) return;
  const binds = listGlobalBindings(gid);
  pop.innerHTML = "";
  const head = document.createElement("div");
  head.className = "gjp-head";
  head.textContent = `${g.label || ("N" + g.id)} ・ 跳到`;
  pop.appendChild(head);
  for (const b of binds) {
    const row = document.createElement("div");
    row.className = "gjp-row";
    const cur = (b.fileId === state.activeFileId && b.pageIdx === (state.pageIdx || 0));
    if (cur) row.classList.add("cur");
    const f = state.files.find(ff => ff.id === b.fileId);
    const pg = f && f.pages ? f.pages[b.pageIdx] : null;
    const plane = (pg && pg.plane) || "—";
    const name = document.createElement("span"); name.style.flex = "1";
    name.textContent = `${b.fileName}#${b.pageIdx + 1}` + (cur ? "  (本頁)" : "");
    const planeSpan = document.createElement("span"); planeSpan.className = "plane"; planeSpan.textContent = plane;
    row.appendChild(name); row.appendChild(planeSpan);
    if (!cur) {
      row.addEventListener("click", () => {
        hideGlobalJointJumpPopup();
        if (typeof activatePageWithBusy === "function") {
          activatePageWithBusy(b.fileId, b.pageIdx).then(() => {
            clearSelection();
            state.selection.joints.add(b.jointId);
            _markSelectionSourceIfEmpty();
            render(); refreshLists();
          });
        }
      });
    }
    pop.appendChild(row);
  }
  if (!binds.length) {
    const e = document.createElement("div");
    e.style.cssText = "padding:10px 12px;color:#7b818a;font-size:11px;font-style:italic";
    e.textContent = "(無綁定)";
    pop.appendChild(e);
  }
  // 定位在 anchor 右下方
  const r = anchor.getBoundingClientRect();
  const padding = 8;
  let left = r.right + padding;
  let top  = r.top;
  // 出右邊 → 改放左邊
  if (left + 280 > window.innerWidth) left = Math.max(8, r.left - 280 - padding);
  if (top + 360 > window.innerHeight) top = Math.max(8, window.innerHeight - 380);
  pop.style.left = left + "px";
  pop.style.top  = top + "px";
  pop.classList.add("active");
  // 點外面關閉 — 一次性 listener
  setTimeout(() => {
    const onAway = (ev) => {
      if (pop.contains(ev.target)) return;
      hideGlobalJointJumpPopup();
      window.removeEventListener("mousedown", onAway, true);
    };
    window.addEventListener("mousedown", onAway, true);
  }, 0);
}

export 
function hideGlobalJointJumpPopup() {
  const pop = document.getElementById("gjJumpPopup");
  if (pop) pop.classList.remove("active");
}
