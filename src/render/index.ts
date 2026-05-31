// Phase 6 — Render 看門狗 + _renderImpl 主控(從 legacy.ts 整段搬過來,@ts-nocheck 過渡)
//   _renderImpl 維持 1180 行單一函式;進一步拆 joint/member/label/snap 子模組屬於 phase 6 後續

import {
  state, svg, getPage, getActiveFile, $,
  applyTransform, fitToView,
  el, jointById, drawSnapGrid, updateBgStrokeWidth, updateSelectToolsVisibility,
  refreshAxisIndicator,
  displayJointId, displayMemberId,
  _fileHasFullSetup, _getJointMemberDirs, _hasAnyPerpPair, _allDirsCollinear,
  _t,
  // 互動 / 工具 / 對話框相關 helper(_renderImpl 的 click / contextmenu / hover handler 用)
  isInsideClip, screenToWorld, setTool, handleMoveModeClick,
  splitMemberAt, addMemberInteractive, additiveSelect, subtractiveSelect,
  showCtxMenu, _setSplitContext, showSplitDim,
  tryConsumePendingGlobalPair,
  showHoverTip, moveHoverTip, hideHoverTip, fmtJointInfo, fmtMemberInfo,
  showJointInfoPopup,
  clearSelection, pushUndo, _markSelectionSourceIfEmpty, _memberPassesDirFilter,
  // Phase 6 fix 2:_renderImpl 內仍會呼叫的 helper(snap、merged section links、投影 …)
  activatePageWithBusy, refreshLists,
  snap, snapToBgVertex, snapToBgPaths, moveModeTarget,
  _computeOutsideMarkerLine, _getMergedSectionLinks, _projectPointOnLine,
  // Phase 6 fix 3:DOM 容器、C 鍵旗標、ID 配發器
  wrap, cKeyDown, allocJointId, allocMemberId,
} from "../app/integration";
import { _worldForRank } from "../core/rankCache";
import { supportTypeOf, hasSupport } from "../core/support";
import { setDebugVar, getDebugVar } from "../utils/debug";

// labelsLayer 事件委派(只設定一次):每次 render 會建 ~17k 個 lbl div,
//   舊版每個 div 各加 5–6 個 listener = 每次 render ~100k 個 closure 分配。
//   改成在 labelsLayer 上委派 → div 只設 data-mid / data-jid;事件由父層一次處理。
let _labelsDelegated = false;
function _setupLabelsDelegation() {
  if (_labelsDelegated) return;
  const layer = $("labelsLayer");
  if (!layer) return;
  _labelsDelegated = true;
  const findLbl = (ev: any) => (ev.target && (ev.target as any).closest)
    ? (ev.target as any).closest(".lbl-member, .lbl-joint") as HTMLElement | null
    : null;
  const memById = (mid: string) => getPage().members.find((x: any) => String(x.id) === mid);
  const joiById = (jid: string) => getPage().joints.find((x: any) => String(x.id) === jid);
  layer.addEventListener("click", (ev: any) => {
    const el2 = findLbl(ev); if (!el2) return;
    ev.stopPropagation();
    if (el2.classList.contains("lbl-member")) {
      const m = memById(el2.dataset.mid!); if (!m) return;
      if (cKeyDown) {
        const a = jointById(m.j1), b = jointById(m.j2);
        if (!a || !b) return;
        pushUndo();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const nj: any = { id: allocJointId(), x: mid.x, y: mid.y };
        const p = getPage();
        p.joints.push(nj);
        p.members = p.members.filter((x: any) => x !== m);
        p.members.push({ id: allocMemberId(), j1: m.j1, j2: nj.id });
        p.members.push({ id: allocMemberId(), j1: nj.id, j2: m.j2 });
        render(); refreshLists();
        return;
      }
      if ((state as any).splitMode) return;
      if ((state as any).moveMode.active) {
        const w = screenToWorld(ev.clientX, ev.clientY);
        const sn = snap(w);
        handleMoveModeClick(sn.x, sn.y);
        return;
      }
      if ((state as any).tool === "line") {
        const tgt = svg.querySelector(`line.member[data-mid="${m.id}"]`);
        if (tgt) tgt.dispatchEvent(new MouseEvent("click", {
          bubbles: false, cancelable: true,
          clientX: ev.clientX, clientY: ev.clientY,
          shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey,
        }));
        return;
      }
      if ((state as any).tool !== "select") setTool("select");
      if (subtractiveSelect(ev)) {
        (state as any).selection.members.delete(m.id);
      } else {
        if ((state as any).selectFilter === "joints") return;
        if (!_memberPassesDirFilter(m)) return;
        if (!additiveSelect(ev)) clearSelection();
        (state as any).selection.members.add(m.id);
      }
      render(); refreshLists();
    } else {
      const j = joiById(el2.dataset.jid!); if (!j) return;
      if (tryConsumePendingGlobalPair(j)) return;
      if ((state as any).splitMode) return;
      if ((state as any).moveMode.active) { handleMoveModeClick(j.x, j.y); return; }
      if ((state as any).tool === "line") {
        if (!(state as any).pendingLineStart) (state as any).pendingLineStart = j.id;
        else {
          if ((state as any).pendingLineStart !== j.id) {
            pushUndo();
            addMemberInteractive((state as any).pendingLineStart, j.id);
          }
          (state as any).pendingLineStart = j.id;
        }
        render(); refreshLists();
        return;
      }
      if ((state as any).tool !== "select") setTool("select");
      if (subtractiveSelect(ev)) {
        (state as any).selection.joints.delete(j.id);
        if ((state as any).selection.joints.size === 0 && (state as any).selection.members.size === 0) {
          (state as any).selection.sourceFileId = null;
          (state as any).selection.sourcePageIdx = null;
        }
      } else {
        if ((state as any).selectFilter === "members") return;
        if (!additiveSelect(ev)) clearSelection();
        (state as any).selection.joints.add(j.id);
        _markSelectionSourceIfEmpty();
      }
      render(); refreshLists();
    }
  });
  layer.addEventListener("dblclick", (ev: any) => {
    const el2 = findLbl(ev); if (!el2) return;
    ev.stopPropagation();
    if ((state as any).splitMode) return;
    if (el2.classList.contains("lbl-member")) {
      const m = memById(el2.dataset.mid!); if (!m) return;
      splitMemberAt(m.id, ev.clientX, ev.clientY);
    }
  });
  layer.addEventListener("contextmenu", (ev: any) => {
    const el2 = findLbl(ev); if (!el2) return;
    ev.preventDefault(); ev.stopPropagation();
    const hasSel = (state as any).selection.joints.size + (state as any).selection.members.size > 0;
    if (hasSel) { showCtxMenu(ev.clientX, ev.clientY, null); return; }
    if (el2.classList.contains("lbl-member")) {
      const m = memById(el2.dataset.mid!); if (!m) return;
      showCtxMenu(ev.clientX, ev.clientY, { type: "member", id: m.id });
    } else {
      const j = joiById(el2.dataset.jid!); if (!j) return;
      showCtxMenu(ev.clientX, ev.clientY, { type: "joint", id: j.id });
    }
  });
  layer.addEventListener("mouseover", (ev: any) => {
    const el2 = findLbl(ev); if (!el2) return;
    if (el2.classList.contains("lbl-member")) {
      const m = memById(el2.dataset.mid!); if (!m) return;
      showHoverTip(fmtMemberInfo(m), ev);
    } else {
      const j = joiById(el2.dataset.jid!); if (!j) return;
      showHoverTip(fmtJointInfo(j), ev);
    }
  });
  layer.addEventListener("mousemove", (ev: any) => {
    const el2 = findLbl(ev); if (!el2) return;
    moveHoverTip(ev);
  });
  layer.addEventListener("mouseout", (ev: any) => {
    const el2 = findLbl(ev); if (!el2) return;
    // 離開 lbl 才隱藏(避免在同 layer 內滑過時頻繁閃)
    const to = ev.relatedTarget && (ev.relatedTarget as any).closest
      ? (ev.relatedTarget as any).closest(".lbl-member, .lbl-joint")
      : null;
    if (to) return;
    hideHoverTip();
  });
}

// Render 看門狗 — 量測單次 render 耗時;超過閾值 → 自動觸發 fitToView() 回復整圖顯示
//   觸發場景:zoom 太深 / 頁面元素極多 / 巨大 SVG → SVG 主執行緒阻塞、畫面卡死
//   策略:render 是同步的,等它跑完才能量測。一旦量到「上一次太慢」就排個 setTimeout 0 做 fitToView。
//   防重入:_renderRecoveryPending flag 確保「正在跑 recovery」期間不再排第二次。
//   閾值用 localStorage 'renderTimeoutMs' 覆蓋,預設 3000 ms;設成 0 / 負值可停用看門狗。
let _renderRecoveryPending = false;
function _getRenderTimeoutMs() {
  try {
    const v = parseFloat(localStorage.getItem("renderTimeoutMs"));
    if (Number.isFinite(v)) return v;
  } catch (_) {}
  return 3000;
}
function _renderImpl() {
  // clear
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  _setupLabelsDelegation();    // 第一次 render 時 wire 起來;之後 idempotent
  updateSelectToolsVisibility && updateSelectToolsVisibility();
  // 平面座標指示器:確保任何 page / plane 變動都會同步(防止 refreshPageCoordSection 沒被叫到的路徑漏更新)
  if (typeof refreshAxisIndicator === "function") refreshAxisIndicator();
  // 鎖點視覺層(若啟用)— 最早繪製,SVG 文件順序在底層
  drawSnapGrid();
  const p = getPage();
  // ---------- 熱路徑加速:jointById O(N) → Map O(1);每個 joint 的相連 member 也預建 ----------
  //   舊版每次 render 在 member loop 內 jointById(...) ≈ 億次 .find 比對;改成 Map 後 O(1)。
  //   adjMap 給「節點上的 X 軸角度推算」用(原本是 for(p.members) × for(p.joints) = O(J×M))。
  const jmap: Map<any, any> = new Map();
  for (const _j of p.joints) jmap.set(_j.id, _j);
  const jid = (id: any) => jmap.get(id);
  const adjAngles: Map<any, number[]> = new Map();
  for (const _m of p.members) {
    const _a = jmap.get(_m.j1), _b = jmap.get(_m.j2);
    if (!_a || !_b) continue;
    if (_a.x === _b.x && _a.y === _b.y) continue;
    const angAB = Math.atan2(_b.y - _a.y, _b.x - _a.x);
    let arrA = adjAngles.get(_m.j1); if (!arrA) { arrA = []; adjAngles.set(_m.j1, arrA); }
    arrA.push(angAB);
    let arrB = adjAngles.get(_m.j2); if (!arrB) { arrB = []; adjAngles.set(_m.j2, arrB); }
    arrB.push(angAB + Math.PI);   // 反向就是另一端的入射方向
  }
  const fs = Math.max(8, 11 / state.zoom);
  // 節點標示大小隨縮放變化(sqrt 曲線),畫面 CSS px 在 2~8 之間;縮小畫面時節點不會相對過大
  const jointR = Math.max(2, Math.min(8, 5 * Math.sqrt(state.zoom || 1))) / state.zoom;
  // 線寬統一以 CSS px 計(non-scaling-stroke):底圖 = 網格,桿件 = 網格 + 0.4,節點 = 網格
  const baseGridPx = Math.max(0.2, 1 / state.zoom);
  const sw = baseGridPx + 0.4;       // 桿件 / 預覽 / 校準 / 吸附環
  const swJoint = baseGridPx;        // 節點圓與 X
  const fsStroke = sw;               // 標籤白色 halo 寬度跟著線寬走
  // 把底圖線條同步調到 baseGridPx
  updateBgStrokeWidth();
  const halfPi = Math.PI / 2;

  // ---------- 預先計算所有標籤位置(隨後做避免重疊) ----------
  const charW = 0.6;  // 估字寬比例
  const padPx = fs * 0.15;  // 重疊容差
  const memberLabel = {};   // memberId -> {cx, cy, w, h, fill, text}
  const jointLabel  = {};   // jointId  -> {cx, cy, w, h, fill, text}
  const labelList = [];

  for (const m of p.members) {
    const a = jid(m.j1), b = jid(m.j2);
    if (!a || !b) continue;
    const text = String(displayMemberId(m));
    const isSel = state.selection.members.has(m.id);
    const isCollide = state.memberCollisions && state.memberCollisions.has(m.id);
    const fill = isSel ? "#ffe066" : (isCollide ? "#39ff14" : "#1976ff");   // 撞號 → 亮綠 (neon green)
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const off = fs * 0.8;
    const cx = (a.x + b.x) / 2 + (-uy) * off;
    const cy = (a.y + b.y) / 2 + ( ux) * off;
    const w = text.length * fs * charW + padPx * 2;
    const h = fs + padPx;
    const lab = { type: "member", id: m.id, text, fill, cx, cy, w, h };
    memberLabel[m.id] = lab;
    labelList.push(lab);
  }
  for (const j of p.joints) {
    const text = String(displayJointId(j));
    const isSel = state.selection.joints.has(j.id);
    const fill = isSel ? "#ffe066" : "#ff2424";
    const w = text.length * fs * charW + padPx * 2;
    const h = fs + padPx;
    const cx = j.x + jointR + fs * 0.4 + w / 2;
    const cy = j.y - jointR - fs * 0.4 - h / 2;
    const lab = { type: "joint", id: j.id, text, fill, cx, cy, w, h };
    jointLabel[j.id] = lab;
    labelList.push(lab);
  }

  // ---------- 重疊解析:成對推開,最多 6 輪 ----------
  // 空間網格加速:cellSize ≥ 最大 label 邊長 → 任意兩個會重疊的 label 必在同 cell 或 8 鄰居 cell。
  //   舊版 O(N²) × 6 輪在 17k label 規模下 ~9 億次比較;改成網格後接近 O(N × k)。
  //   每輪重建網格(label 在 iter 內會移動,grid 會 stale 一些 pair → 下一輪會接住)。
  let _maxLW = 0, _maxLH = 0;
  for (const L of labelList) { if (L.w > _maxLW) _maxLW = L.w; if (L.h > _maxLH) _maxLH = L.h; }
  const cellSize = Math.max(_maxLW, _maxLH, 1);
  for (let iter = 0; iter < 6; iter++) {
    // 重建 grid:Map<"cx|cy", number[]>(value = labelList 索引)
    const grid: Map<string, number[]> = new Map();
    for (let i = 0; i < labelList.length; i++) {
      const L = labelList[i];
      const key = Math.floor(L.cx / cellSize) + "|" + Math.floor(L.cy / cellSize);
      let arr = grid.get(key); if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(i);
    }
    let moved = false;
    for (let i = 0; i < labelList.length; i++) {
      const A = labelList[i];
      const cx = Math.floor(A.cx / cellSize);
      const cy = Math.floor(A.cy / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get((cx + dx) + "|" + (cy + dy));
          if (!cell) continue;
          for (const k of cell) {
            if (k <= i) continue;   // 每對只檢查一次(沿用舊版 i < k 規約)
            const B = labelList[k];
            const ovX = (A.w + B.w) / 2 - Math.abs(B.cx - A.cx);
            const ovY = (A.h + B.h) / 2 - Math.abs(B.cy - A.cy);
            if (ovX > 0 && ovY > 0) {
              if (ovX < ovY) {
                const sgn = (B.cx - A.cx) >= 0 ? 1 : -1;
                A.cx -= sgn * ovX / 2; B.cx += sgn * ovX / 2;
              } else {
                const sgn = (B.cy - A.cy) >= 0 ? 1 : -1;
                A.cy -= sgn * ovY / 2; B.cy += sgn * ovY / 2;
              }
              moved = true;
            }
          }
        }
      }
    }
    if (!moved) break;
  }

  // ---------- 繪製桿件(含其編號) ----------
  for (const m of p.members) {
    const a = jid(m.j1), b = jid(m.j2);
    if (!a || !b) continue;
    const ln = el("line", {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "member",
      "data-mid": m.id,
      "stroke-width": sw,
    });
    if (state.selection.members.has(m.id)) ln.classList.add("selected");
    // 撞號桿件 → 加 .collision class(CSS 亮綠色 stroke + dasharray 提示)
    if (state.memberCollisions && state.memberCollisions.has(m.id)) {
      ln.classList.add("collision");
    }
    ln.style.pointerEvents = "stroke";
    ln.addEventListener("click", (e) => {
      e.stopPropagation();
      console.log("[ln click] m.id=", m.id, "cKeyDown=", cKeyDown, "tool=", state.tool);
      // 按住 C 點線段 → 在線段中點(50%)插入新節點
      if (cKeyDown) {
        const a = jointById(m.j1), b = jointById(m.j2);
        if (!a || !b) return;
        pushUndo();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const nj = { id: allocJointId(), x: mid.x, y: mid.y };
        const p = getPage();
        p.joints.push(nj);
        p.members = p.members.filter(x => x !== m);
        p.members.push({ id: allocMemberId(), j1: m.j1, j2: nj.id });
        p.members.push({ id: allocMemberId(), j1: nj.id, j2: m.j2 });
        render(); refreshLists();
        return;
      }
      if (state.splitMode) {
        // 拆分模式 — 把投影點當作 click 對應點
        const w = screenToWorld(e.clientX, e.clientY);
        const snapped = snap(w);
        if (!state.splitFirstCorner) {
          state.splitFirstCorner = { x: snapped.x, y: snapped.y };
          $("hud").textContent = "拆分頁面:請點擊矩形對角(Esc 取消)";
          render(); return;
        }
        const a = state.splitFirstCorner;
        const rect = {
          x: Math.min(a.x, snapped.x), y: Math.min(a.y, snapped.y),
          w: Math.abs(snapped.x - a.x), h: Math.abs(snapped.y - a.y),
        };
        state.splitFirstCorner = null;
        if (rect.w < 1 || rect.h < 1) { render(); return; }
        const p = getPage();
        const movedJ = new Set();
        const inside = (j) => j.x >= rect.x && j.x <= rect.x + rect.w
                           && j.y >= rect.y && j.y <= rect.y + rect.h;
        for (const j of p.joints) if (inside(j)) movedJ.add(j.id);
        const movedM = new Set();
        for (const mm of p.members) {
          const aJ = jointById(mm.j1), bJ = jointById(mm.j2);
          if (aJ && bJ && inside(aJ) && inside(bJ)) movedM.add(mm.id);
        }
        _setSplitContext({ movedJ, movedM, rect });
        showSplitDim(rect);
        ($("splitName") as HTMLInputElement).value = "拆分_" + (state.files.length + 1);
        $("splitDialog").style.display = "flex";
        setTimeout(() => $("splitName").focus(), 30);
        render();
        return;
      }
      if (state.moveMode.active) {
        const w = screenToWorld(e.clientX, e.clientY);
        const snapped = snap(w);
        handleMoveModeClick(snapped.x, snapped.y);
        return;
      }
      // 畫線模式:點線段上 → 在最近投影點切出新節點並從 pendingLineStart 連過來
      if (state.tool === "line") {
        const a = jointById(m.j1), b = jointById(m.j2);
        if (!a || !b) return;
        const w = screenToWorld(e.clientX, e.clientY);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return;
        const t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2));
        const minMargin = (state.snapPx / state.zoom) / Math.sqrt(len2);
        let targetId;
        pushUndo();
        if (t < minMargin)         targetId = m.j1;       // 太接近端點 a → 用 a
        else if (t > 1 - minMargin) targetId = m.j2;       // 太接近端點 b → 用 b
        else {
          // 在投影點切割線段,新增節點
          const px = a.x + t * dx, py = a.y + t * dy;
          const nj = { id: allocJointId(), x: px, y: py };
          const p = getPage();
          p.joints.push(nj);
          p.members = p.members.filter(x => x !== m);
          p.members.push({ id: allocMemberId(), j1: m.j1, j2: nj.id });
          p.members.push({ id: allocMemberId(), j1: nj.id, j2: m.j2 });
          targetId = nj.id;
        }
        if (state.pendingLineStart && state.pendingLineStart !== targetId) {
          addMemberInteractive(state.pendingLineStart, targetId);
        }
        state.pendingLineStart = targetId;
        render(); refreshLists();
        return;
      }
      // 選取模式
      if (state.tool !== "select") setTool("select");
      if (subtractiveSelect(e)) {
        state.selection.members.delete(m.id);
      } else {
        // selectFilter=joints → 「點」filter 啟用中,線不能點選
        if (state.selectFilter === "joints") return;
        // 方向 filter:擋掉不符方向的桿件(避免使用者沒注意 filter 是哪種就點到)
        if (!_memberPassesDirFilter(m)) return;
        if (!additiveSelect(e)) clearSelection();
        state.selection.members.add(m.id);
      }
      render(); refreshLists();
    });
    ln.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      const hasSel = state.selection.joints.size + state.selection.members.size > 0;
      showCtxMenu(e.clientX, e.clientY, hasSel ? null : { type: "member", id: m.id });
    });
    ln.addEventListener("dblclick", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (state.splitMode) return;
      const w = screenToWorld(e.clientX, e.clientY);
      if (!isInsideClip(getActiveFile(), w.x, w.y)) {
        $("hud").textContent = "桿件中段插入節點:點擊位置在拆分頁範圍外,已忽略";
        return;
      }
      splitMemberAt(m.id, e.clientX, e.clientY);
    });
    svg.appendChild(ln);

    // 桿件編號移到最後統一繪製,確保始終在最上層
  }

  // ---------- 繪製節點(含其編號) ----------
  const tolRad = 15 * Math.PI / 180;
  const candDeg = [45, 30, 60, 22.5, 67.5, 15, 75, 0];
  // 跨頁 linked preview 預備:
  //   如果目前頁就是 selection source page → 用 j.id 高亮(原行為)
  //   不是 source page → 把 source page 上 selected joint 的世界座標蒐集起來,
  //     當前頁的 joint 用世界座標 fuzzy match,符合的標 isLinked = true(linked preview)
  //   注意:這份邏輯必須跟「節點 label 繪製」共用(否則 label 顏色會用舊的 j.id 比對而標錯點)
  const _selOnSrc = (state.selection.sourceFileId === state.activeFileId
                    && state.selection.sourcePageIdx === state.pageIdx);
  const _selLinkedWorlds = [];     // [{ x, y, z, gid }]
  if (!_selOnSrc && state.selection.joints.size > 0 && state.selection.sourceFileId != null) {
    const srcFile = state.files.find(f => f.id === state.selection.sourceFileId);
    const srcPage = srcFile && srcFile.pages ? srcFile.pages[state.selection.sourcePageIdx] : null;
    if (srcFile && srcPage && _fileHasFullSetup(srcFile)) {
      for (const sj of (srcPage.joints || [])) {
        if (!state.selection.joints.has(sj.id)) continue;
        const w = _worldForRank(srcFile, srcPage, sj);
        if (w) _selLinkedWorlds.push({ x: w.x, y: w.y, z: w.z, gid: sj.globalId });
      }
    }
  }
  const _linkedTol = Math.max(1, Math.pow(10, -(state.measureDecimals || 0)));
  const _curHasSetup = _fileHasFullSetup(getActiveFile());
  // 預先掃一遍當前頁 joints,建出「該頁哪些 j.id 是 linked」的 Set,後面 joint 繪製 + label 繪製都查它
  const _linkedJointIds = new Set();
  if (_selLinkedWorlds.length > 0 && _curHasSetup) {
    const _af = getActiveFile();
    for (const j of p.joints) {
      const w = _worldForRank(_af, p, j);
      if (!w) continue;
      for (const s of _selLinkedWorlds) {
        if (s.gid != null && j.globalId === s.gid) { _linkedJointIds.add(j.id); break; }
        if (Math.abs(w.x - s.x) < _linkedTol
         && Math.abs(w.y - s.y) < _linkedTol
         && Math.abs(w.z - s.z) < _linkedTol) { _linkedJointIds.add(j.id); break; }
      }
    }
  }
  // 暴露給後面 label 繪製階段使用(在同一個 render() 函式內,scope 共享)
  for (const j of p.joints) {
    const isSel = _selOnSrc && state.selection.joints.has(j.id);
    const isLinked = !isSel && _linkedJointIds.has(j.id);
    // 紫(選取) / 紫 + dashed(linked 預覽,跨頁同物理點) / 橘(支承點) / 紅(預設)
    //   linked 用「同一個紫」+ dashed,確保編號與節點圖示同色,只靠 stroke-dasharray / italic 區分
    const color = (isSel || isLinked) ? "#a855f7" : (hasSupport(j) ? "#ff8c00" : "#ff2424");

    // 收集相連桿件方向(僅未選取時要計算 X 角度)
    //   舊版每個 joint 都掃全部 members(O(J×M));改用預建的 adjAngles → O(degree(j))
    let xAngle = Math.PI / 4;
    if (!isSel) {
      const memAngles = adjAngles.get(j.id) || [];
      let bestGap = -1;
      for (const d of candDeg) {
        const c0 = d * Math.PI / 180;
        let minGap = halfPi;
        for (const a of memAngles) {
          let diff = ((a - c0) % halfPi + halfPi) % halfPi;
          diff = Math.min(diff, halfPi - diff);
          if (diff < minGap) minGap = diff;
        }
        if (minGap > bestGap) { bestGap = minGap; xAngle = c0; }
        if (bestGap >= tolRad) break;
      }
    }

    // 主圓:始終空心;選取時只把顏色從紅變黃,X 仍可見
    // 支承點:依 support 類型換 symbol(單一 SVG 元素,維持 .joint hover/selected 樣式)
    //   FIXED=倒三角 / PINNED=正方形 / FIXED_BUT=菱形 / SPRING=線圈 / ENFORCED=六邊形
    //   ★ 選取/linked 時保持符號,只換顏色;不改回圓圈
    //   stroke=color(選取時走紫色 #a855f7、未選走橘色 #ff8c00);fill 跟 stroke 同調但帶透明度
    const isAnchorMark = hasSupport(j);
    const c = isAnchorMark ? (() => {
      const r = jointR * 2.6;            // 加大 1.6 → 2.6
      const x = j.x, y = j.y;
      const _anchorFill = (isSel || isLinked)
        ? "rgba(168, 85, 247, 0.35)"   // 選取/linked → 紫色 #a855f7 + 35% alpha
        : "rgba(255, 140, 0, 0.4)";    // 未選 → 橘色
      const _cls = "joint anchor-marker" + (isSel ? " selected" : "") + (isLinked ? " linked" : "");
      const _common: Record<string, any> = {
        class: _cls, "data-jid": j.id,
        stroke: color, "stroke-width": swJoint * 2.0, "stroke-linejoin": "round",
      };
      const st = supportTypeOf(j);
      const k = r * 0.866, h = r * 0.5;   // 三角 / 六邊形幾何
      if (st === "PINNED") {
        // 正方形(置中於 j),邊長 ≈ 三角形外接圓邊長
        const s = r * 1.732;             // ≈ √3 r
        return el("rect", { ..._common, x: x - s / 2, y: y - s / 2, width: s, height: s, fill: _anchorFill });
      }
      if (st === "FIXED_BUT") {
        // 菱形(旋轉正方形)= 部分釋放
        return el("polygon", { ..._common, points: `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`, fill: _anchorFill });
      }
      if (st === "SPRING") {
        // 彈簧線圈(zigzag path,不填色)
        const d = `M ${x - r} ${y} L ${x - 0.6 * r} ${y - 0.6 * r} L ${x - 0.2 * r} ${y + 0.6 * r}` +
                  ` L ${x + 0.2 * r} ${y - 0.6 * r} L ${x + 0.6 * r} ${y + 0.6 * r} L ${x + r} ${y}`;
        return el("path", { ..._common, d, fill: "none", "stroke-linecap": "round" });
      }
      if (st === "ENFORCED") {
        // 六邊形 = 強制位移
        const pts = `${x},${y - r} ${x + k},${y - h} ${x + k},${y + h} ${x},${y + r} ${x - k},${y + h} ${x - k},${y - h}`;
        return el("polygon", { ..._common, points: pts, fill: _anchorFill });
      }
      // FIXED(預設):倒三角(頂點朝上)
      return el("polygon", { ..._common, points: `${x},${y - r} ${x - k},${y + h} ${x + k},${y + h}`, fill: _anchorFill });
    })() : el("circle", {
      cx: j.x, cy: j.y, r: jointR,
      class: "joint" + (isSel ? " selected" : "") + (isLinked ? " linked" : ""),
      "data-jid": j.id,
      fill: "transparent",
      stroke: color, "stroke-width": swJoint,
    });
    c.style.pointerEvents = "all";
    c.addEventListener("click", (e) => {
      // 底圖繪線/複製線/中分線/等分線 pending 中:不攔截,讓事件冒泡到 wrap 走原本的 commit 流程
      // (wrap 的 click handler 會用 snap/snapToBgVertex 吸到節點位置,所以結果一致)
      if ((state.bgDrawLine && state.bgDrawLine.active)
          || (state.bgCopyLine && state.bgCopyLine.active)
          || (state.bgBisector && state.bgBisector.active)
          || (state.bgEqui && state.bgEqui.active)
          || state.sectionLinkPlacing
          || state.scaleRulerDrag && state.scaleRulerDrag.active) {
        return;
      }
      e.stopPropagation();
      if (tryConsumePendingGlobalPair(j)) return;
      if (state.splitMode) {
        // 在拆分模式下,把節點位置當作 click 對應點交給 wrap 處理流程
        const w = { x: j.x, y: j.y };
        // 模擬走 wrap.click 的 splitMode 流程:
        if (!state.splitFirstCorner) {
          state.splitFirstCorner = { x: j.x, y: j.y };
          $("hud").textContent = "拆分頁面:請點擊矩形對角(Esc 取消)";
          render(); return;
        }
        const a = state.splitFirstCorner;
        const rect = {
          x: Math.min(a.x, j.x), y: Math.min(a.y, j.y),
          w: Math.abs(j.x - a.x), h: Math.abs(j.y - a.y),
        };
        state.splitFirstCorner = null;
        if (rect.w < 1 || rect.h < 1) { render(); return; }
        const p = getPage();
        const movedJ = new Set();
        const inside = (jt) => jt.x >= rect.x && jt.x <= rect.x + rect.w
                            && jt.y >= rect.y && jt.y <= rect.y + rect.h;
        for (const jj of p.joints) if (inside(jj)) movedJ.add(jj.id);
        const movedM = new Set();
        for (const mm of p.members) {
          const aJ = jointById(mm.j1), bJ = jointById(mm.j2);
          if (aJ && bJ && inside(aJ) && inside(bJ)) movedM.add(mm.id);
        }
        _setSplitContext({ movedJ, movedM, rect });
        showSplitDim(rect);
        ($("splitName") as HTMLInputElement).value = "拆分_" + (state.files.length + 1);
        $("splitDialog").style.display = "flex";
        setTimeout(() => $("splitName").focus(), 30);
        render();
        return;
      }
      if (state.moveMode.active) { handleMoveModeClick(j.x, j.y); return; }
      if (state.tool === "line") {
        if (!state.pendingLineStart) {
          state.pendingLineStart = j.id;
        } else {
          if (state.pendingLineStart !== j.id) {
            pushUndo();
            addMemberInteractive(state.pendingLineStart, j.id);
          }
          state.pendingLineStart = j.id;
        }
        render(); refreshLists();
      } else {
        if (subtractiveSelect(e)) {
          state.selection.joints.delete(j.id);
          if (state.selection.joints.size === 0 && state.selection.members.size === 0) {
            state.selection.sourceFileId = null;
            state.selection.sourcePageIdx = null;
          }
        } else {
          // selectFilter=members → 「線」filter 啟用中,點不能被選
          if (state.selectFilter === "members") return;
          if (!additiveSelect(e)) clearSelection();
          state.selection.joints.add(j.id);
          _markSelectionSourceIfEmpty();
        }
        render(); refreshLists();
        // 點擊節點 → 開出可拖移、可關閉的資訊小視窗
        //   subtractive(Ctrl 反選)時不開 — 反選通常表示「我要拿掉這個」,不需資訊
        if (!subtractiveSelect(e)) {
          try { showJointInfoPopup(j, e); } catch (err) { console.warn("[joint popup] 失敗:", err); }
        }
      }
    });
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      const hasSel = state.selection.joints.size + state.selection.members.size > 0;
      showCtxMenu(e.clientX, e.clientY, hasSel ? null : { type: "joint", id: j.id });
    });
    svg.appendChild(c);

    // X 兩條對角線(始終繪製,選取 / linked 都用同一紫色實線)
    const drawX = (a) => {
      const dx = jointR * Math.cos(a), dy = jointR * Math.sin(a);
      svg.appendChild(el("line", {
        x1: j.x - dx, y1: j.y - dy, x2: j.x + dx, y2: j.y + dy,
        class: "joint-x" + (isSel ? " selected" : "") + (isLinked ? " linked" : ""),
        stroke: color, "stroke-width": swJoint,
      }));
    };
    drawX(xAngle);
    drawX(xAngle + halfPi);

    // 節點編號移到最後統一繪製,確保始終在最上層
  }
  // preview line / ortho indicator
  if (state.tool === "line" && state.pendingLineStart && !state.manualAlign.active) {
    const a = jid(state.pendingLineStart);
    if (!a) { state.pendingLineStart = null; }
    else {
    const target = snap({ x: state.cursor.sx, y: state.cursor.sy });
    svg.appendChild(el("line", {
      x1: a.x, y1: a.y, x2: target.x, y2: target.y,
      class: "member preview", "stroke-width": sw,
    }));
    if (target.joint) {
      svg.appendChild(el("circle", {
        cx: target.x, cy: target.y, r: jointR + 2, class: "joint snap",
        "stroke-width": sw,
      }));
    }
    // length label
    if (state.scale) {
      const dpx = Math.hypot(target.x - a.x, target.y - a.y);
      const dist = (dpx / state.scale).toFixed(3);
      svg.appendChild(el("text",
        { x: (a.x+target.x)/2, y: (a.y+target.y)/2 - 4, class: "label" },
        `${dist} ${state.unitName}`));
    }
    }
  }
  // calibrate preview
  // hover snap indicator
  if (state.tool === "line" && !state.pendingLineStart && !state.manualAlign.active) {
    const target = snap({ x: state.cursor.sx, y: state.cursor.sy });
    if (target.joint) {
      svg.appendChild(el("circle", {
        cx: target.x, cy: target.y, r: jointR + 2, class: "joint snap",
        "stroke-width": sw,
      }));
    }
  }
  // 平面座標原點:青色十字 + 圓圈,跟一般節點顏色不同,不可編輯
  {
    const af = getActiveFile();
    if (af && af.planeOrigin) {
      const o = af.planeOrigin;
      const r2 = jointR * 1.6;
      const swO = Math.max(1, 1.6 / state.zoom);
      svg.appendChild(el("circle", {
        cx: o.x, cy: o.y, r: r2,
        fill: "rgba(0, 200, 200, 0.18)",
        stroke: "#00c8c8", "stroke-width": swO,
      }));
      svg.appendChild(el("line", { x1: o.x - r2 * 1.4, y1: o.y, x2: o.x + r2 * 1.4, y2: o.y, stroke: "#00c8c8", "stroke-width": swO }));
      svg.appendChild(el("line", { x1: o.x, y1: o.y - r2 * 1.4, x2: o.x, y2: o.y + r2 * 1.4, stroke: "#00c8c8", "stroke-width": swO }));
    }
    // 比例尺:工程比例尺樣式(主線 + T 端帽 + 主/次刻度 + 數字)
    if (af && af.scaleRuler) {
      const sr = af.scaleRuler;
      const dx = sr.p2.x - sr.p1.x, dy = sr.p2.y - sr.p1.y;
      const lenPx = Math.hypot(dx, dy);
      if (lenPx > 1e-3) {
        const ux = dx / lenPx, uy = dy / lenPx;
        // 選擇「下方」的法向量(畫面 y 軸朝下,故取 ny ≥ 0 的方向擺刻度與標籤);完全垂直時改取正 x 側
        let nx = -uy, ny = ux;
        if (ny < 0 || (Math.abs(ny) < 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }
        const realLen   = sr.real;            // mm
        const pxPerReal = lenPx / realLen;    // px / mm

        // 自動挑選「整齊」主刻度間距(目標 4–8 個主刻度)
        const target = realLen / 6;
        const mag = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1e-9))));
        const norm = target / mag;
        let major = mag;
        if (norm >= 1.5)  major = 2 * mag;
        if (norm >= 3.5)  major = 5 * mag;
        if (norm >= 7.5)  major = 10 * mag;
        const subdiv = 5;                      // 每個主刻度切 5 等分(次刻度)
        const minor  = major / subdiv;

        const color   = "#ff9800";
        const sw      = Math.max(1.2, 1.8 / state.zoom);
        const swMin   = Math.max(0.6, 1.0 / state.zoom);
        const tickMaj = 14 / state.zoom;
        const tickMid = 9  / state.zoom;        // 主刻度之間的中點次刻度
        const tickMin = 5  / state.zoom;
        const fontPx  = 11 / state.zoom;
        const labelGap = 3 / state.zoom;

        // 文字旋轉:沿著比例尺方向;若超過 ±90° 則反向避免倒立
        let rotDeg = Math.atan2(uy, ux) * 180 / Math.PI;
        if (rotDeg > 90)  rotDeg -= 180;
        if (rotDeg < -90) rotDeg += 180;

        // 主線
        svg.appendChild(el("line", {
          x1: sr.p1.x, y1: sr.p1.y, x2: sr.p2.x, y2: sr.p2.y,
          stroke: color, "stroke-width": sw,
        }));
        // 兩端 T 形端帽(上下各延伸一半)
        const capHalf = tickMaj * 0.55;
        for (const pt of [sr.p1, sr.p2]) {
          svg.appendChild(el("line", {
            x1: pt.x - nx*capHalf, y1: pt.y - ny*capHalf,
            x2: pt.x + nx*capHalf, y2: pt.y + ny*capHalf,
            stroke: color, "stroke-width": sw,
          }));
        }

        // 數字格式
        const fmt = (mm) => {
          if (major >= 1000) {
            const v = mm / 1000;
            return (Math.abs(v - Math.round(v)) < 1e-6 ? v.toFixed(0) : v.toFixed(1)) + " m";
          }
          if (major >= 1) return mm.toFixed(0) + " mm";
          return mm.toFixed(2) + " mm";
        };

        // 全部刻度:i=0..N (N = realLen / minor),i 是 subdiv 的倍數即為主刻度
        const N = Math.floor(realLen / minor + 1e-6);
        for (let i = 0; i <= N; i++) {
          const d = i * minor;
          const px = d * pxPerReal;
          const cx = sr.p1.x + ux * px, cy = sr.p1.y + uy * px;
          const isMajor = (i % subdiv === 0);
          const isMid   = (!isMajor && (i % Math.max(1, Math.round(subdiv / 2)) === 0));
          const tlen = isMajor ? tickMaj : (isMid ? tickMid : tickMin);
          const swT  = isMajor ? sw      : swMin;
          svg.appendChild(el("line", {
            x1: cx,            y1: cy,
            x2: cx + nx*tlen,  y2: cy + ny*tlen,
            stroke: color, "stroke-width": swT,
          }));
          if (isMajor) {
            const off = tlen + labelGap + fontPx * 0.55;
            const tx = cx + nx * off, ty = cy + ny * off;
            svg.appendChild(el("text", {
              x: tx, y: ty,
              transform: `rotate(${rotDeg.toFixed(2)} ${tx.toFixed(3)} ${ty.toFixed(3)})`,
              "font-size": fontPx, fill: "#fff",
              stroke: "#000", "stroke-width": Math.max(1.5, fontPx * 0.28),
              "paint-order": "stroke", "stroke-linejoin": "round",
              "text-anchor": "middle", "dominant-baseline": "middle",
              "font-family": "Arial, Helvetica, sans-serif", "font-weight": "700",
            }, fmt(d)));
          }
        }
        // 終點:若不在主刻度上,額外標示總長
        const lastMajorD = Math.floor(realLen / major + 1e-6) * major;
        if (realLen - lastMajorD > 1e-6) {
          const cx = sr.p2.x, cy = sr.p2.y;
          const off = tickMaj + labelGap + fontPx * 0.55;
          const tx = cx + nx * off, ty = cy + ny * off;
          svg.appendChild(el("text", {
            x: tx, y: ty,
            transform: `rotate(${rotDeg.toFixed(2)} ${tx.toFixed(3)} ${ty.toFixed(3)})`,
            "font-size": fontPx, fill: "#fff",
            stroke: "#000", "stroke-width": Math.max(1.5, fontPx * 0.28),
            "paint-order": "stroke", "stroke-linejoin": "round",
            "text-anchor": "middle", "dominant-baseline": "middle",
            "font-family": "Arial, Helvetica, sans-serif", "font-weight": "700",
          }, fmt(realLen)));
        }
        // 兩端小圓點
        const dotR = jointR * 0.7;
        svg.appendChild(el("circle", { cx: sr.p1.x, cy: sr.p1.y, r: dotR, fill: color }));
        svg.appendChild(el("circle", { cx: sr.p2.x, cy: sr.p2.y, r: dotR, fill: color }));
      }
    }
  }
  // 標示距離 overlay:青色雙箭頭線段 + 中點數字,跨 render 持續(永久保留,只能由刪除按鈕清除)
  //   渲染兩個來源:已固化 file.measurements + 正在編輯的 state.measure
  {
    const _mFile = getActiveFile && getActiveFile();
    const _mPersisted = (_mFile && Array.isArray(_mFile.measurements)) ? _mFile.measurements : [];
    const _mAll = state.measure ? [..._mPersisted, state.measure] : _mPersisted;
    const mc = "#4fc3f7";   // cyan
    const mw = Math.max(1.2, 1.8 / state.zoom);
    const mfs = Math.max(11, 13 / state.zoom);
    const mdotR = jointR * 0.85;
    for (const m of _mAll) {
      if (!m || !m.p1 || !m.p2) continue;
      const isEditing = (m === state.measure);
      // 編輯中的稍微突顯(用較粗 stroke / 略不同色)
      const _mc = isEditing ? "#ffe066" : mc;
      const _mw = isEditing ? Math.max(1.5, 2.4 / state.zoom) : mw;
      // 主線
      svg.appendChild(el("line", {
        x1: m.p1.x, y1: m.p1.y, x2: m.p2.x, y2: m.p2.y,
        stroke: _mc, "stroke-width": _mw,
      }));
      // 兩端小圓
      svg.appendChild(el("circle", { cx: m.p1.x, cy: m.p1.y, r: mdotR, fill: _mc }));
      svg.appendChild(el("circle", { cx: m.p2.x, cy: m.p2.y, r: mdotR, fill: _mc }));
      // 端帽(垂直於主線方向)
      const mdx = m.p2.x - m.p1.x, mdy = m.p2.y - m.p1.y;
      const mlen = Math.hypot(mdx, mdy);
      if (mlen > 1e-3) {
        const mux = mdx / mlen, muy = mdy / mlen;
        const mnx = -muy, mny = mux;
        const cap = 6 / state.zoom;
        for (const pt of [m.p1, m.p2]) {
          svg.appendChild(el("line", {
            x1: pt.x - mnx * cap, y1: pt.y - mny * cap,
            x2: pt.x + mnx * cap, y2: pt.y + mny * cap,
            stroke: _mc, "stroke-width": _mw,
          }));
        }
        // 中點標籤
        const cx = (m.p1.x + m.p2.x) / 2 + mnx * (mfs * 1.2);
        const cy = (m.p1.y + m.p2.y) / 2 + mny * (mfs * 1.2);
        let rotDeg = Math.atan2(muy, mux) * 180 / Math.PI;
        if (rotDeg > 90)  rotDeg -= 180;
        if (rotDeg < -90) rotDeg += 180;
        svg.appendChild(el("text", {
          x: cx, y: cy,
          transform: `rotate(${rotDeg.toFixed(2)} ${cx.toFixed(3)} ${cy.toFixed(3)})`,
          "font-size": mfs, fill: "#fff",
          stroke: "#000", "stroke-width": Math.max(1.5, mfs * 0.28),
          "paint-order": "stroke", "stroke-linejoin": "round",
          "text-anchor": "middle", "dominant-baseline": "middle",
          "font-family": "Arial, Helvetica, sans-serif", "font-weight": "700",
        }, m.label));
      }
    }
  }
  // 畫直線預覽(bg 模式內):
  //   - p1 未設:游標處顯示鎖點圓圈 + 「鎖點」文字(hover 即顯示)
  //   - p1 已設:p1 → 游標的虛線預覽 + 鎖點視覺(可正交鎖,Alt 優先吸 bg 整條線)
  if (state.bgDrawLine && state.bgDrawLine.active) {
    const p1 = state.bgDrawLine.p1;
    const cursor = { x: state.cursor.sx, y: state.cursor.sy };
    let snapped, snapKind = null;
    if (state.altDown) {
      const bgSnap = snapToBgPaths(cursor);
      if (bgSnap) { snapped = bgSnap; snapKind = bgSnap.kind; }
      else        snapped = snap(cursor);
    } else {
      const v = snapToBgVertex(cursor);
      if (v) { snapped = v; snapKind = v.kind; }
      else   snapped = snap(cursor);
    }
    let p2 = { x: snapped.x, y: snapped.y };
    if (p1 && state.ortho) {
      if (Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y)) p2 = { x: p2.x, y: p1.y };
      else p2 = { x: p1.x, y: p2.y };
    }
    const lc = "#4fc3f7";
    const lw = Math.max(1.2, 1.6 / state.zoom);
    if (p1) {
      // p1 已設 → 畫預覽線 + p1 起點
      svg.appendChild(el("line", {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: lc, "stroke-width": lw, "stroke-dasharray": `${4/state.zoom} ${3/state.zoom}`,
      }));
      svg.appendChild(el("circle", { cx: p1.x, cy: p1.y, r: jointR * 0.9, fill: lc }));
    }
    // 吸附目標視覺標示:
    //   bg-vertex(轉折點 / 端點):黃色實心方框
    //   bg-cross(線交點):黃色 X
    //   bg-end(snapToBgPaths 端點,Alt):同 vertex
    //   bg-line(snapToBgPaths 線投影,Alt):橘色細邊小方塊
    if (snapKind) {
      const sc  = "#ffd23f";    // 端點 / 交點 / 轉折點
      const sc2 = "#ff9b3f";    // 線投影
      const colorBy = (snapKind === "bg-line") ? sc2 : sc;
      const r = (snapKind === "bg-line") ? jointR * 1.0 : jointR * 1.3;
      // 圓形外框
      svg.appendChild(el("circle", {
        cx: p2.x, cy: p2.y, r,
        fill: "transparent", stroke: colorBy, "stroke-width": lw * 1.2,
      }));
      // 「鎖點」文字標籤 — 浮在圓圈右上角
      const tx = p2.x + r * 1.2;
      const ty = p2.y - r * 0.6;
      const fontSize = Math.max(10, 12 / state.zoom);
      // 文字描邊讓黑底底圖背景下也清楚
      svg.appendChild(el("text", {
        x: tx, y: ty, fill: colorBy,
        "font-size": fontSize, "font-family": "sans-serif",
        "stroke": "#000", "stroke-width": fontSize * 0.18,
        "paint-order": "stroke fill",
        "dominant-baseline": "middle",
      }, "鎖點"));
    }
  }
  // 複製線預覽:hover 顯示鎖點圓圈;設好基準點後在游標處顯示 ghost(每條 source 套上 offset)
  if (state.bgCopyLine && state.bgCopyLine.active) {
    const cl = state.bgCopyLine;
    const cursor = { x: state.cursor.sx, y: state.cursor.sy };
    let snapped, snapKind = null;
    if (state.altDown) {
      const bgSnap = snapToBgPaths(cursor);
      if (bgSnap) { snapped = bgSnap; snapKind = bgSnap.kind; }
      else        snapped = snap(cursor);
    } else {
      const v = snapToBgVertex(cursor);
      if (v) { snapped = v; snapKind = v.kind; }
      else   snapped = snap(cursor);
    }
    let target = { x: snapped.x, y: snapped.y };
    if (cl.base && state.ortho) {
      if (Math.abs(target.x - cl.base.x) >= Math.abs(target.y - cl.base.y)) target.y = cl.base.y;
      else target.x = cl.base.x;
    }
    const lc = "#22c55e";       // 複製線預覽用綠色,跟畫直線(藍)/中分線(紫)/等分線(綠)區分
    const lw = Math.max(1.2, 1.6 / state.zoom);
    if (cl.base) {
      // 基準點 marker
      svg.appendChild(el("circle", { cx: cl.base.x, cy: cl.base.y, r: jointR * 0.9, fill: lc }));
      // ghost:對每條 source 套 offset = target - base
      const dx = target.x - cl.base.x, dy = target.y - cl.base.y;
      for (const src of cl.sources) {
        const a = { x: src.p1.x + dx, y: src.p1.y + dy };
        const b = { x: src.p2.x + dx, y: src.p2.y + dy };
        const attrs = {
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          stroke: lc, "stroke-width": lw, opacity: 0.85,
        };
        if (src.dasharray) attrs["stroke-dasharray"] = src.dasharray;
        svg.appendChild(el("line", attrs));
      }
    }
    // 鎖點視覺(同畫直線那段)
    if (snapKind) {
      const sc  = "#ffd23f";
      const sc2 = "#ff9b3f";
      const colorBy = (snapKind === "bg-line") ? sc2 : sc;
      const r = (snapKind === "bg-line") ? jointR * 1.0 : jointR * 1.3;
      svg.appendChild(el("circle", {
        cx: target.x, cy: target.y, r,
        fill: "transparent", stroke: colorBy, "stroke-width": lw * 1.2,
      }));
      const tx = target.x + r * 1.2;
      const ty = target.y - r * 0.6;
      const fontSize = Math.max(10, 12 / state.zoom);
      svg.appendChild(el("text", {
        x: tx, y: ty, fill: colorBy,
        "font-size": fontSize, "font-family": "sans-serif",
        "stroke": "#000", "stroke-width": fontSize * 0.18,
        "paint-order": "stroke fill",
        "dominant-baseline": "middle",
      }, "鎖點"));
    }
  }
  // 中分線預覽
  if (state.bgBisector && state.bgBisector.active) {
    const b = state.bgBisector;
    const a = { x: b.mid.x - b.nx * b.halfLen, y: b.mid.y - b.ny * b.halfLen };
    const c = { x: b.mid.x + b.nx * b.halfLen, y: b.mid.y + b.ny * b.halfLen };
    const lc = "#a855f7";
    const lw = Math.max(1.2, 1.6 / state.zoom);
    svg.appendChild(el("line", {
      x1: a.x, y1: a.y, x2: c.x, y2: c.y,
      stroke: lc, "stroke-width": lw, "stroke-dasharray": `${4/state.zoom} ${3/state.zoom}`,
    }));
    svg.appendChild(el("circle", { cx: b.mid.x, cy: b.mid.y, r: jointR * 0.85, fill: lc }));
    svg.appendChild(el("circle", { cx: a.x, cy: a.y, r: jointR * 0.7, fill: lc }));
    svg.appendChild(el("circle", { cx: c.x, cy: c.y, r: jointR * 0.7, fill: lc }));
  }
  // 等分線預覽(綠色,跟中分線區別)
  if (state.bgEqui && state.bgEqui.active) {
    const e2 = state.bgEqui;
    const a = { x: e2.center.x - e2.dx * e2.halfLen, y: e2.center.y - e2.dy * e2.halfLen };
    const c = { x: e2.center.x + e2.dx * e2.halfLen, y: e2.center.y + e2.dy * e2.halfLen };
    const lc = "#22c55e";       // 綠色
    const lw = Math.max(1.2, 1.6 / state.zoom);
    svg.appendChild(el("line", {
      x1: a.x, y1: a.y, x2: c.x, y2: c.y,
      stroke: lc, "stroke-width": lw, "stroke-dasharray": `${4/state.zoom} ${3/state.zoom}`,
    }));
    svg.appendChild(el("circle", { cx: e2.center.x, cy: e2.center.y, r: jointR * 0.85, fill: lc }));
    svg.appendChild(el("circle", { cx: a.x, cy: a.y, r: jointR * 0.7, fill: lc }));
    svg.appendChild(el("circle", { cx: c.x, cy: c.y, r: jointR * 0.7, fill: lc }));
  }
  // 移動指令預覽:基準點 → 目前目標(依模式計算),並把選取的節點以幽靈樣式顯示
  if (state.moveMode.active && state.moveMode.base) {
    const cursor = snap({ x: state.cursor.sx, y: state.cursor.sy });
    const target = moveModeTarget(cursor) || cursor;
    const b = state.moveMode.base;
    svg.appendChild(el("line", {
      x1: b.x, y1: b.y, x2: target.x, y2: target.y,
      stroke: "#ffd23f", "stroke-width": Math.max(1, 1.4 / state.zoom),
      "stroke-dasharray": "5 3", "stroke-opacity": "0.9",
    }));
    const dx = target.x - b.x, dy = target.y - b.y;
    for (const id of state.selection.joints) {
      const jt = jid(id);
      if (!jt) continue;
      svg.appendChild(el("circle", {
        cx: jt.x + dx, cy: jt.y + dy, r: jointR,
        fill: "rgba(255, 210, 63, 0.18)",
        stroke: "#ffd23f",
        "stroke-width": Math.max(0.6, 1 / state.zoom),
        "stroke-dasharray": "2 2",
      }));
    }
  }
  // 拆分頁面預覽矩形(從第一個對角點到游標位置,亮黃色虛線;stroke 用 non-scaling 讓低縮放時仍清楚)
  if (state.splitMode && state.splitFirstCorner) {
    const a = state.splitFirstCorner;
    const t = snap({ x: state.cursor.sx, y: state.cursor.sy });
    const rx = Math.min(a.x, t.x), ry = Math.min(a.y, t.y);
    const rw = Math.abs(t.x - a.x), rh = Math.abs(t.y - a.y);
    svg.appendChild(el("rect", {
      x: rx, y: ry, width: rw, height: rh,
      fill: "rgba(255, 230, 100, 0.22)", stroke: "#ffee58",
      "stroke-width": 2.5, "stroke-dasharray": "6 3",
      "vector-effect": "non-scaling-stroke",
    }));
  }
  // 切面 定位預覽:對話框 OK 後游標跟著動,點 1 = 箭頭尖端,點 2 = 箭頭尾端
  //   兩點都強制投影到原 bg 切線的無限延伸線上,確保最終標示位於同一條直線
  //   主線/箭頭線寬與最終樣式一致,由左側欄設定取得
  if (state.sectionLinkPlacing) {
    const placing = state.sectionLinkPlacing;
    const rawCursor = { x: state.cursor.sx, y: state.cursor.sy };
    const cursor = _projectPointOnLine(rawCursor, placing.repLine.p1, placing.repLine.p2);
    const stroke = "#d4a4ff";
    const previewSW = (state.sectionLinkStyle && state.sectionLinkStyle.strokeWidth) || 30;
    if (!placing.tip) {
      // 還沒點第一點 — 在投影後的游標位置畫小十字提示
      const sz = 12 / state.zoom;
      svg.appendChild(el("line", {
        x1: cursor.x - sz, y1: cursor.y, x2: cursor.x + sz, y2: cursor.y,
        stroke, "stroke-width": Math.max(2, previewSW * 0.5),
        "vector-effect": "non-scaling-stroke", opacity: 0.85,
      }));
      svg.appendChild(el("line", {
        x1: cursor.x, y1: cursor.y - sz, x2: cursor.x, y2: cursor.y + sz,
        stroke, "stroke-width": Math.max(2, previewSW * 0.5),
        "vector-effect": "non-scaling-stroke", opacity: 0.85,
      }));
    } else {
      // 已點第一點 — 從 tip 拉到 (投影後的)cursor 預覽切線,tip 端有箭頭、tail 端無
      const tip = placing.tip;
      svg.appendChild(el("line", {
        x1: tip.x, y1: tip.y, x2: cursor.x, y2: cursor.y,
        stroke, "stroke-width": previewSW, "stroke-dasharray": "12 6",
        "vector-effect": "non-scaling-stroke", opacity: 0.9,
      }));
      // tip 端 chevron(箭頭)— 從 tip 往遠離 cursor 的方向
      const ddx = tip.x - cursor.x, ddy = tip.y - cursor.y;
      const len = Math.hypot(ddx, ddy);
      if (len > 1e-3) {
        const ux = ddx / len, uy = ddy / len;
        const arrowLen = Math.max(20 / state.zoom, Math.min(len * 0.05, 200 / state.zoom));
        const cosA = Math.cos(0.45), sinA = Math.sin(0.45);
        const w1x = tip.x - (ux * cosA - uy * sinA) * arrowLen;
        const w1y = tip.y - (uy * cosA + ux * sinA) * arrowLen;
        const w2x = tip.x - (ux * cosA + uy * sinA) * arrowLen;
        const w2y = tip.y - (uy * cosA - ux * sinA) * arrowLen;
        svg.appendChild(el("polyline", {
          points: `${w1x.toFixed(2)},${w1y.toFixed(2)} ${tip.x.toFixed(2)},${tip.y.toFixed(2)} ${w2x.toFixed(2)},${w2y.toFixed(2)}`,
          stroke, fill: "none", "stroke-width": previewSW,
          "vector-effect": "non-scaling-stroke", opacity: 0.9,
        }));
      }
    }
  }
  // 切面 overlay:此頁所有 sectionLinks 畫成細實線 + 一端箭頭(autoProp 顯較淡色)
  //   重複關聯(p1/p2 接近)的 entry 合併成一筆,只畫一個箭頭(標籤合併在第二段繪製)
  {
    const af = getActiveFile && getActiveFile();
    const merged = _getMergedSectionLinks(af);
    if (af && merged.length) {
      // 只在 merged group 數變化時印一次 log,協助排查(衍生模型不再有 raw entries 概念)
      if (getDebugVar<number>("_lastSLCount") !== merged.length) {
        setDebugVar("_lastSLCount", merged.length);
        const sl0 = merged[0] && merged[0].rep;
        if (sl0 && sl0.p1 && sl0.p2) {
          const sx1 = state.panX + sl0.p1.x * state.zoom;
          const sy1 = state.panY + sl0.p1.y * state.zoom;
          const sx2 = state.panX + sl0.p2.x * state.zoom;
          const sy2 = state.panY + sl0.p2.y * state.zoom;
          const r = wrap.getBoundingClientRect();
          const inView = (sx, sy) => (sx >= 0 && sx <= r.width && sy >= 0 && sy <= r.height) ? "✓ 在畫面內" : "✗ 在畫面外";
          const primaryCount = (af.sectionLinks || []).filter(e => !e.autoProp).length;
          console.log("[切面 render] file:", af.name,
            "merged groups:", merged.length, "primaries on file:", primaryCount,
            `\n  world  p1=(${sl0.p1.x.toFixed(0)}, ${sl0.p1.y.toFixed(0)})  p2=(${sl0.p2.x.toFixed(0)}, ${sl0.p2.y.toFixed(0)})`,
            `\n  screen p1=(${sx1.toFixed(0)}, ${sy1.toFixed(0)}) ${inView(sx1, sy1)}`,
            `\n  screen p2=(${sx2.toFixed(0)}, ${sy2.toFixed(0)}) ${inView(sx2, sy2)}`,
            `\n  viewport ${r.width.toFixed(0)} × ${r.height.toFixed(0)} (zoom ${state.zoom.toFixed(4)} pan ${state.panX.toFixed(0)},${state.panY.toFixed(0)})`);
        }
      }
      const slSW = (state.sectionLinkStyle && state.sectionLinkStyle.strokeWidth) || 30;
      for (const grp of merged) {
        const sl = grp.rep;
        if (!sl.p1 || !sl.p2) continue;
        const marker = _computeOutsideMarkerLine(af, sl.p1, sl.p2);
        if (!marker) continue;
        const isReverse = !!sl.autoProp;
        const isFallback = !!sl.crossPlaneFallback;
        const stroke = isReverse ? "#b07cff" : "#d4a4ff";
        const op = isReverse ? 0.85 : 1;
        // 反向關聯 → 虛線;跨平面 fallback(位置不準)→ 更稀疏虛線
        const dasharray = isFallback ? "8 6" : (isReverse ? "12 5" : null);
        // 主標示線
        const lineAttrs = {
          x1: marker.p1.x, y1: marker.p1.y, x2: marker.p2.x, y2: marker.p2.y,
          stroke, "stroke-width": slSW,
          "vector-effect": "non-scaling-stroke",
          opacity: op,
        };
        if (dasharray) lineAttrs["stroke-dasharray"] = dasharray;
        svg.appendChild(el("line", lineAttrs));
        // 單邊箭頭(主關聯 + 反向關聯都畫,指向 bg 內部)
        const ddx = marker.p1.x - marker.p2.x, ddy = marker.p1.y - marker.p2.y;
        const lineLen = Math.hypot(ddx, ddy);
        if (lineLen > 1e-3) {
          const ux = ddx / lineLen, uy = ddy / lineLen;
          const arrowLen = Math.max(20 / state.zoom, Math.min(lineLen * 0.25, 200 / state.zoom));
          const cosA = Math.cos(0.45), sinA = Math.sin(0.45);
          const w1x = marker.p1.x - (ux * cosA - uy * sinA) * arrowLen;
          const w1y = marker.p1.y - (uy * cosA + ux * sinA) * arrowLen;
          const w2x = marker.p1.x - (ux * cosA + uy * sinA) * arrowLen;
          const w2y = marker.p1.y - (uy * cosA - ux * sinA) * arrowLen;
          svg.appendChild(el("polyline", {
            points: `${w1x.toFixed(2)},${w1y.toFixed(2)} ${marker.p1.x.toFixed(2)},${marker.p1.y.toFixed(2)} ${w2x.toFixed(2)},${w2y.toFixed(2)}`,
            stroke, fill: "none", "stroke-width": slSW,
            "vector-effect": "non-scaling-stroke",
            opacity: op,
          }));
        }
      }
    }
  }
  // marquee selection rectangle
  //   select 模式:window = 藍實線(#4f9dff)、crossing = 綠虛線(#66d9b0)— AutoCAD 慣例
  //   selectBg 模式:兩種都用綠色(深綠 window 實線 + 亮綠 crossing 虛線)— 跟 bg 編輯的視覺一致
  if (state.marquee && state.marquee.moved) {
    const m = state.marquee;
    const rx = Math.min(m.x1, m.x2), ry = Math.min(m.y1, m.y2);
    const rw = Math.abs(m.x2 - m.x1), rh = Math.abs(m.y2 - m.y1);
    const crossing = m.x2 < m.x1;
    let stroke, fill;
    if (m.bg) {
      stroke = crossing ? "#7fffaa" : "#3fc77f";   // 亮綠(crossing) / 中綠(window)
      fill   = crossing ? "rgba(127,255,170,0.16)" : "rgba(63,199,127,0.14)";
    } else {
      stroke = crossing ? "#66d9b0" : "#4f9dff";
      fill   = crossing ? "rgba(102,217,176,0.14)" : "rgba(79,157,255,0.14)";
    }
    const attrs = {
      x: rx, y: ry, width: rw, height: rh,
      fill, stroke, "stroke-width": 1,
    };
    if (crossing) attrs["stroke-dasharray"] = "4 3";
    svg.appendChild(el("rect", attrs));
  }
  // ---------- 統一在最後繪製所有標號(HTML div,層在 stage 之外避免 transform 影響 hit-test) ----------
  const labelsLayer = $("labelsLayer");
  while (labelsLayer.firstChild) labelsLayer.removeChild(labelsLayer.firstChild);
  hideHoverTip && hideHoverTip();
  // 螢幕座標 = panX + 世界x * zoom, panY + 世界y * zoom
  const toScreenX = (wx) => state.panX + wx * state.zoom;
  const toScreenY = (wy) => state.panY + wy * state.zoom;
  // 切面 標籤:即使「標示 隱藏」也要顯示(目標頁名稱是切面語義的一部分,跟節點/桿件編號分開管理)
  //   位置:在外圍標示線的「箭頭尾端 p2」之後,沿線方向延伸顯示目標檔名(可點擊跳轉)
  {
    const af2 = getActiveFile && getActiveFile();
    const merged2 = _getMergedSectionLinks(af2);
    if (af2 && merged2.length) {
      const slFontPt = (state.sectionLinkStyle && state.sectionLinkStyle.fontPt) || 15;
      for (const grp of merged2) {
        const sl = grp.rep;
        if (!sl.p1 || !sl.p2) continue;
        const marker = _computeOutsideMarkerLine(af2, sl.p1, sl.p2);
        if (!marker) continue;
        const targetIds = [...(grp.allTargets || [])];
        if (!targetIds.length) continue;
        const targets = targetIds
          .map(tid => state.files.find(f => f.id === tid))
          .filter(Boolean);
        if (!targets.length) continue;
        const ddx = marker.p2.x - marker.p1.x, ddy = marker.p2.y - marker.p1.y;
        const len = Math.hypot(ddx, ddy) || 1;
        const ux = ddx / len, uy = ddy / len;
        let ang = Math.atan2(ddy, ddx) * 180 / Math.PI;
        let flipped = false;
        if (ang > 90) { ang -= 180; flipped = true; }
        else if (ang < -90) { ang += 180; flipped = true; }
        const padPx = 14;
        const anchorWorldX = marker.p2.x + ux * (padPx / state.zoom);
        const anchorWorldY = marker.p2.y + uy * (padPx / state.zoom);
        const anchorX = toScreenX(anchorWorldX);
        const anchorY = toScreenY(anchorWorldY);
        const div = document.createElement("div");
        div.className = "lbl lbl-section-link";
        const isReverse = !!sl.autoProp;
        const isFallback = !!sl.crossPlaneFallback;
        const role = isReverse
          ? (sl.crossPlane ? "跨平面反向關聯" : "同平面反向關聯")
          : "主關聯";
        const baseColor = sl.autoProp ? "#b07cff" : "#d4a4ff";
        for (let i = 0; i < targets.length; i++) {
          const tf = targets[i];
          const span = document.createElement("span");
          span.textContent = tf.name;
          span.title = `${role}・點擊跳到 ${tf.name}`
            + (isFallback ? "\n(跨平面位置為估算 fallback,實際位置請參考主關聯源)" : "");
          Object.assign(span.style, {
            cursor: "pointer", padding: "0 2px", borderRadius: "3px",
            transition: "background 0.12s, text-decoration-color 0.12s",
          });
          span.onmouseenter = () => { span.style.background = "rgba(255,255,255,0.18)"; };
          span.onmouseleave = () => { span.style.background = "transparent"; };
          span.onclick = (e) => {
            e.stopPropagation();
            if (tf.id !== af2.id) activatePageWithBusy(tf.id, 0);
          };
          div.appendChild(span);
          if (i < targets.length - 1) {
            const sep = document.createElement("span");
            sep.textContent = ", ";
            sep.style.cursor = "default";
            sep.style.opacity = "0.6";
            div.appendChild(sep);
          }
        }
        if (isFallback) {
          const warn = document.createElement("span");
          warn.textContent = " ⚠";
          warn.style.cursor = "default";
          warn.title = "跨平面位置為估算 fallback,實際位置請參考主關聯源";
          div.appendChild(warn);
        }
        Object.assign(div.style, {
          left: anchorX + "px", top: anchorY + "px",
          fontSize: slFontPt + "pt", color: baseColor,
          opacity: sl.autoProp ? "0.95" : "1", textShadow: "none",
          cursor: "default",
        });
        if (flipped) {
          div.style.transformOrigin = "100% 50%";
          div.style.transform = `translate(-100%, -50%) rotate(${ang.toFixed(2)}deg)`;
        } else {
          div.style.transformOrigin = "0 50%";
          div.style.transform = `translate(0, -50%) rotate(${ang.toFixed(2)}deg)`;
        }
        labelsLayer.appendChild(div);
      }
    }
  }
  // 節點 / 桿件標號各自獨立 toggle(切面標籤已在上方獨立繪製過,不受影響)
  //   兩個都隱藏才完全跳過剩餘繪製;其中一個還開著就繼續走下面的 loop,個別 if 篩
  const _showJointLbl  = state.jointLabelsVisible  !== false;
  const _showMemberLbl = state.memberLabelsVisible !== false;
  if (!_showJointLbl && !_showMemberLbl) {
    $("stats").textContent = (typeof _t === "function" && _t("dyn.joints"))
      ? `${p.joints.length} ${_t("dyn.joints")} · ${p.members.length} ${_t("dyn.members")} · ${_t("dyn.pageOrdinalPrefix")||""} ${state.pageIdx+1} ${_t("dyn.pageOrdinalSuffix")||""}`.replace(/\s+/g," ").trim()
      : `${p.joints.length} 節點 · ${p.members.length} 桿件 · 第 ${state.pageIdx+1} 頁`;
    return;
  }
  // 字級:基準 15(zoom=1),隨縮放 sqrt 變化,上限 20、下限 6;再乘上使用者倍率
  const lblFontPx = Math.max(6, Math.min(20, 15 * Math.sqrt(state.zoom || 1))) * (state.labelFontScale || 1);
  if (_showMemberLbl) for (const m of p.members) {
    const lab = memberLabel[m.id];
    if (!lab) continue;
    const isSelLab = state.selection.members.has(m.id);
    const div = document.createElement("div");
    div.className = "lbl lbl-member";
    div.dataset.mid = String(m.id);
    div.textContent = String(displayMemberId(m));
    div.style.left = toScreenX(lab.cx) + "px";
    div.style.top = toScreenY(lab.cy) + "px";
    div.style.fontSize = lblFontPx + "px";
    div.style.color = isSelLab ? "#ffe066" : "#1976ff";
    // 事件已委派到 labelsLayer(見 _setupLabelsDelegation)
    labelsLayer.appendChild(div);
  }
  if (_showJointLbl) for (const j of p.joints) {
    const lab = jointLabel[j.id];
    if (!lab) continue;
    // 跨頁同步:跟 joint 繪製用同一份 _selOnSrc / _linkedJointIds 判定,避免 label 用舊的 j.id 比對而標錯點
    const isSelJ = _selOnSrc && state.selection.joints.has(j.id);
    const isLinkedJ = !isSelJ && _linkedJointIds.has(j.id);
    const div = document.createElement("div");
    div.className = "lbl lbl-joint" + (isLinkedJ ? " linked" : "");
    div.dataset.jid = String(j.id);
    div.textContent = String(displayJointId(j));
    div.style.left = toScreenX(lab.cx) + "px";
    div.style.top = toScreenY(lab.cy) + "px";
    div.style.fontSize = lblFontPx + "px";
    // 編號與節點圖示同色:選取 / linked 都用同一個 #a855f7,linked 額外加 italic 區分
    div.style.color = (isSelJ || isLinkedJ) ? "#a855f7" : (hasSupport(j) ? "#ff8c00" : "#ff2424");
    if (isLinkedJ) { div.style.fontStyle = "italic"; }
    // 事件已委派到 labelsLayer(見 _setupLabelsDelegation)
    labelsLayer.appendChild(div);
  }
  // (切面標籤已在 early-return 之前獨立繪製過 — 即使「標示 隱藏」也會顯示)
  // stats
  $("stats").textContent = (typeof _t === "function" && _t("dyn.joints"))
    ? `${p.joints.length} ${_t("dyn.joints")} · ${p.members.length} ${_t("dyn.members")} · ${_t("dyn.pageOrdinalPrefix")||""} ${state.pageIdx+1} ${_t("dyn.pageOrdinalSuffix")||""}`.replace(/\s+/g," ").trim()
    : `${p.joints.length} 節點 · ${p.members.length} 桿件 · 第 ${state.pageIdx+1} 頁`;
}

// 對外:render() 是看門狗版本,內部呼叫 _renderImpl(),並量測耗時 → 超時自動排 fitToView
//   防遞迴關鍵:recovery 跑 fitToView 時(本身也會 call render),flag 維持 true → 內層 render watch=false
// rAF 合併:同一 frame 內多次 render() 呼叫(zoom / pan / 標籤頻繁更新等)合併成一次,
//   避免一個 wheel burst 觸發 N 次全量 DOM 重建。renderNow() 走同步路徑,給必須立刻拿到
//   新畫面狀態的情境用(如 fit-to-view 接 zoom 量測)。
let _rafScheduled = false;
function _renderSync() {
  const threshold = _getRenderTimeoutMs();
  const watch = (threshold > 0) && !_renderRecoveryPending;
  const t0 = watch ? performance.now() : 0;
  const _scheduleRecovery = (reason) => {
    _renderRecoveryPending = true;
    setTimeout(() => {
      try { if (typeof fitToView === "function") fitToView(); }
      catch (e) { console.warn("[render recovery] fitToView 失敗:", e); }
      finally { _renderRecoveryPending = false; }
    }, 100);
    console.warn("[render] watchdog 觸發:" + reason);
  };
  try {
    _renderImpl();
  } catch (e) {
    console.error("[render] 拋出例外:", e);
    if (!_renderRecoveryPending) {
      if ($("hud")) $("hud").textContent = `⚠ render 失敗(${(e && e.message) || e})— 自動回復整圖顯示`;
      _scheduleRecovery(`exception: ${(e && e.message) || e}`);
    }
    throw e;
  }
  if (watch) {
    const dt = performance.now() - t0;
    if (dt > threshold) {
      if ($("hud")) $("hud").textContent = `⚠ 畫面 render 耗時 ${(dt / 1000).toFixed(1)} 秒(超過 ${(threshold / 1000).toFixed(1)} 秒閾值)— 自動回復整圖顯示`;
      _scheduleRecovery(`slow render ${dt.toFixed(0)} ms > ${threshold} ms`);
    }
  }
}
export function render() {
  if (_rafScheduled) return;
  _rafScheduled = true;
  requestAnimationFrame(() => {
    _rafScheduled = false;
    _renderSync();
  });
}
// 需要「立刻拿到新畫面狀態」的呼叫端(例如 fit-to-view 量測完才用)走這條同步路徑
export function renderNow() {
  if (_rafScheduled) _rafScheduled = false;   // 取消已排程的 rAF,避免重複
  _renderSync();
}
