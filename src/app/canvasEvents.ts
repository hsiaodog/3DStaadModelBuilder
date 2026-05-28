// 中央 canvas / window 事件 dispatch — pan / zoom / 工具滑鼠互動 / 鍵盤 shortcuts 全在這
//
//   • wheel  — 滾輪 zoom(以游標為錨點)+ markInteracting()
//   • mousedown — 空白鍵拖移 / 範圍放大 / 一般工具點擊 dispatch
//   • mousemove — 全 window:游標 cursor 追蹤、拖移、tool preview
//   • mouseup   — 全 window:結束 pan / commit 工具
//   • keydown / keyup — 全 window:undo / redo / hotkeys / Shift ortho / Esc 取消等
//
//   全部 listener 由 wireCanvasEvents() 包起,legacy.ts module body 末段 call(避免 TDZ)。
//   依賴大量 legacy.ts 內 helper(很多 forward ref);過渡期都從 "../legacy" 拉。
// @ts-nocheck

import { state } from "./state";
import { hideCtxMenu } from "../dialogs/ctxMenu";
import { wrap, $ } from "./dom";
import { applyTransform, screenToWorld, _saveCurrentTabView } from "./transform";
import { undo, redo, pushUndo } from "./undoRedo";
import { snap } from "./snap";
import {
  // forward refs from legacy.ts (lots)
  getActiveFile, getPage, render, refreshLists,
  applyBgRotation, jointById,
  setTool, clearSelection, additiveSelect, subtractiveSelect, _markSelectionSourceIfEmpty,
  clearAllBgSelection, exitSplitMode, exitMoveMode, exitManualAlign,
  exitRangeZoom, exitOriginPending, exitScaleRulerPending, exitSectionLinkPending,
  exitMeasurePending, exitBgDrawLine, exitBgCopyLine, exitBgBisector, exitBgEqui,
  cancelScaleRulerDrag, _restoreSectionLinkShapeMarquee, _persistCurrentMeasure,
  finalizeRangeZoomRect, performDelete, checkBgPendingAfterSelect,
  clearAllShapeMarqueeModes, commitPendingFilter, cycleSelectFilter, cycleSnapGrid,
  closeAutoPairDialog, hideBusy, showBusy, busyTick,
  navBack, navForward, openPlanePicker,
  selectAllBgPaths, selToolsSelectAll, _memberPassesDirFilter,
  splitSelectedAtMidpoint, processIntersections, startMoveMode,
  updateBgEditOpsVisibility, updateSelectToolLabel,
  findRectangleBgLines, findCircleBgPaths, findStraightBgLines, findDiagonalBgSegments,
  _startSaveWithHook,
  withBusy,
} from "../app/integration";

// ---------- pan/zoom ----------
// 互動中標記:滾輪 / 平移期間打開 body.interacting,閒置 250ms 後拿掉
//   目的:讓 stage 暫時 promote 成 GPU layer 加速 zoom/pan,但結束後重新 raster → 細線維持清晰
let _interactingTimer = null;
function markInteracting() {
  document.body.classList.add("interacting");
  if (_interactingTimer) clearTimeout(_interactingTimer);
  _interactingTimer = setTimeout(() => {
    document.body.classList.remove("interacting");
    _interactingTimer = null;
  }, 250);
}

// C 鍵按住中:render/index.ts 需要 read 來決定點擊桿件是否在中點插新節點
//   下方 keydown/keyup 透過 setCKeyDown 寫(ESM 不允許跨函式 reassign export let)
export let cKeyDown = false;
export function setCKeyDown(v: boolean) { cKeyDown = v; }

// 共享 input state — integration.ts(舊 legacy 在 bg svg event delegate)也會讀
//   原本是 wireCanvasEvents() 內部 closure;extract 之後其他模組讀不到 → 改 module-top export let
export let panning = false;
export function setPanning(v: boolean) { panning = v; }
export let rangeZoomDragStart: any = null;
export function setRangeZoomDragStart(v: any) { rangeZoomDragStart = v; }
export let rangeZoomSuppressClick = false;
export function setRangeZoomSuppressClick(v: boolean) { rangeZoomSuppressClick = v; }
export let mouseDownPos: any = null;
export function setMouseDownPos(v: any) { mouseDownPos = v; }

// 所有 canvas / window 互動 listener 都包進來,由 legacy.ts 延後 call(避免 TDZ)
export function wireCanvasEvents() {

wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  markInteracting();
  const r = wrap.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const factor = Math.exp(-e.deltaY * 0.0015);
  const wx = (mx - state.panX) / state.zoom;
  const wy = (my - state.panY) / state.zoom;
  state.zoom *= factor;
  state.zoom = Math.max(0.0001, Math.min(50, state.zoom));
  state.panX = mx - wx * state.zoom;
  state.panY = my - wy * state.zoom;
  applyTransform();
  render();
}, { passive: false });

let panStart: any = null;
// mouseDownPos lifted to module top (export let) — integration.ts reads cross-module
let alignDrag = null;     // 手動對齊拖曳:{ startX, startY, startRot, snapshotPushed }
let dragMove = null;      // 選取後拖曳節點:{ startX, startY, positions:Map, axis, moved }
// cKeyDown / setCKeyDown 從 module top-level export(下方);在 wire 內透過 setter 寫
wrap.addEventListener("mousedown", (e) => {
  if (state.rangeZoomMode && e.button === 0) {
    // 範圍放大:mousedown 記錄拖曳起點,mouseup 依位移判定拖曳 / 點擊
    const r = wrap.getBoundingClientRect();
    setRangeZoomDragStart({ x: e.clientX - r.left, y: e.clientY - r.top });
    e.preventDefault();
    return;
  }
  if (state.splitMode && e.button === 0) {
    // 拆分模式靠 click 處理(點兩下對角),mousedown 純粹擋掉
    e.preventDefault();
    return;
  }
  if (state.manualAlign.active && e.button === 0) {
    const file = getActiveFile();
    if (file) {
      pushUndo();
      alignDrag = {
        startX: e.clientX, startY: e.clientY,
        startOffsetX: file.offsetX || 0,
        startOffsetY: file.offsetY || 0,
        axis: null,
      };
    }
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if (e.button === 0) setMouseDownPos({ x: e.clientX, y: e.clientY });
  if (e.button === 1 || (e.button === 0 && state.spaceDown)) {
    setPanning(true); panStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
    wrap.style.cursor = "grabbing";
    e.preventDefault();
    return;
  }
  if (e.button === 0 && (state.tool === "select" || state.tool === "selectBg")) {
    const tag = e.target && e.target.tagName;
    if (state.tool === "select" && (tag === "circle" || tag === "line")) return;
    if (e.target && e.target.closest && e.target.closest("#labelsLayer")) return;
    // 底圖 sub-mode(畫直線 / 畫虛線 / 複製線 / 中分線 / 等分線 / 切面定位)進行中 → 不啟動匡選,
    //   避免拖曳時順手把 bg 線選起來造成「選取狀態」干擾這些連續流程。
    //   切面 pending 不在此列 — 切面要靠選取一條直線(下方 _bgSvgDelegateClick 會把選取限制成只允許直線)
    if ((state.bgDrawLine && state.bgDrawLine.active)
        || (state.bgCopyLine && state.bgCopyLine.active)
        || (state.bgBisector && state.bgBisector.active)
        || (state.bgEqui && state.bgEqui.active)
        || state.sectionLinkPlacing) {
      return;
    }
    const w = screenToWorld(e.clientX, e.clientY);
    const isBg = (state.tool === "selectBg");
    state.marquee = {
      x1: w.x, y1: w.y, x2: w.x, y2: w.y,
      additive: additiveSelect(e) || (isBg && state.bgMultiSelect),
      subtract: subtractiveSelect(e),
      moved: false, bg: isBg
    };
    e.preventDefault();
  }
});
window.addEventListener("mousemove", (e) => {
  if (alignDrag) {
    const file = getActiveFile();
    if (file) {
      let dx = (e.clientX - alignDrag.startX) / state.zoom;
      let dy = (e.clientY - alignDrag.startY) / state.zoom;
      // 按住 Shift → 鎖定軸向(依拖曳起始的優勢方向決定一次)
      if (e.shiftKey && !alignDrag.axis) {
        const adx = Math.abs(e.clientX - alignDrag.startX);
        const ady = Math.abs(e.clientY - alignDrag.startY);
        if (adx + ady > 4) alignDrag.axis = adx >= ady ? "x" : "y";
      }
      if (e.shiftKey && alignDrag.axis === "x") dy = 0;
      else if (e.shiftKey && alignDrag.axis === "y") dx = 0;
      file.offsetX = alignDrag.startOffsetX + dx;
      file.offsetY = alignDrag.startOffsetY + dy;
      applyBgRotation(file);
      const u = state.scale ? `${(file.offsetX / state.scale).toFixed(2)} , ${(file.offsetY / state.scale).toFixed(2)} ${state.unitName}`
                            : `${file.offsetX.toFixed(0)} , ${file.offsetY.toFixed(0)} px`;
      const lockTag = (e.shiftKey && alignDrag.axis) ? `  軸鎖:${alignDrag.axis === "x" ? "水平" : "垂直"}` : "";
      $("hud").textContent = `底圖偏移:${u}${lockTag}  (Esc 完成)`;
    }
    return;
  }
  if (panning) {
    markInteracting();
    state.panX = panStart.panX + (e.clientX - panStart.x);
    state.panY = panStart.panY + (e.clientY - panStart.y);
    applyTransform();
    render();    // 標號在 stage 外,需跟著平移重新計算螢幕位置
  } else if (state.marquee) {
    const w = screenToWorld(e.clientX, e.clientY);
    state.marquee.x2 = w.x; state.marquee.y2 = w.y;
    if (Math.hypot(w.x - state.marquee.x1, w.y - state.marquee.y1) * state.zoom > 3) {
      state.marquee.moved = true;
    }
    render();
  }
});
window.addEventListener("mouseup", (e) => {
  if (state.rangeZoomMode && rangeZoomDragStart) {
    const r = wrap.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const start = rangeZoomDragStart;
    setRangeZoomDragStart(null);
    const dx = mx - start.x, dy = my - start.y;
    if (Math.hypot(dx, dy) > 4) {
      // 真的有拖曳 → 直接以拖曳矩形完成範圍放大,並抑制緊接的 click 事件
      setRangeZoomSuppressClick(true);
      setTimeout(() => { setRangeZoomSuppressClick(false); }, 0);
      finalizeRangeZoomRect(start.x, start.y, mx, my);
      return;
    }
    // 位移很小 → 視為點擊,讓 click handler 接手(兩段式點擊)
  }
  if (alignDrag) { alignDrag = null; return; }
  if (state.marquee && state.marquee.moved) {
    // 記下最近一次的框選矩形,供「拆分為新頁」使用
    const m = state.marquee;
    state.lastMarquee = {
      x: Math.min(m.x1, m.x2), y: Math.min(m.y1, m.y2),
      w: Math.abs(m.x2 - m.x1), h: Math.abs(m.y2 - m.y1),
    };
  }
  setPanning(false);
  if (!state.manualAlign.active) wrap.style.cursor = state.spaceDown ? "grab" : "none";
  if (state.marquee) {
    const m = state.marquee;
    state.marquee = null;
    if (m.moved) {
      const crossing = m.x2 < m.x1;
      const x1 = Math.min(m.x1, m.x2), y1 = Math.min(m.y1, m.y2);
      const x2 = Math.max(m.x1, m.x2), y2 = Math.max(m.y1, m.y2);
      if (m.bg) {
        // 修改底圖模式:用 getBoundingClientRect → 螢幕座標 → 世界座標,正確處理底圖父層 transform
        const file = getActiveFile();
        const bgSvgEl = document.getElementById("bgSvg");
        // 形狀匡選子模式(正方形/長方形/圓形/斜線):範圍內只挑符合形狀的元素
        // - subtract 模式 → 把符合的從選取移除;否則(預設或 additive)→ 加入
        if (state.bgShapeMarquee && state.bgShapeMarquee.size > 0 && file && bgSvgEl) {
          // 形狀匡選(正方形 / 長方形 / 圓形 / 斜線)是 O(N × 形狀檢查),
          // DXF 上千元素時可能要幾百毫秒 → 用 withBusy 把工作延到 rAF 之後並顯示處理中
          const r = { x1, y1, x2, y2, crossing };
          const modes = [...state.bgShapeMarquee];
          withBusy("處理形狀匡選中…", async () => {
            if (!m.additive && !m.subtract) clearAllBgSelection(file);
            if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
            const hits = new Set();
            for (const mode of modes) {
              let s = null;
              if (mode === "square" || mode === "rect") s = findRectangleBgLines(mode, r);
              else if (mode === "circle")               s = findCircleBgPaths(r);
              else if (mode === "diagonal")             s = findDiagonalBgSegments(r, { requireSolid: true });
              else if (mode === "dashedDiagonal")       s = findDiagonalBgSegments(r, { requireDashed: true });
              else if (mode === "straight")             s = findStraightBgLines(r);
              else if (mode === "straightSolid")        s = findStraightBgLines(r, { requireSolid: true });
              if (s) s.forEach(id => hits.add(String(id)));
              await busyTick();
            }
            for (const id of hits) {
              const elx = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(id)}"]`);
              if (m.subtract) {
                file.selectedBgPaths.delete(id);
                if (elx) elx.classList.remove("bg-selected");
              } else {
                file.selectedBgPaths.add(id);
                if (elx) elx.classList.add("bg-selected");
              }
            }
            updateBgEditOpsVisibility();
            checkBgPendingAfterSelect();
            render();
          });
          return;
        }
        if (file && bgSvgEl) {
          if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
          // pending 模式下保留既有選取(累加),不清空
          const inPending = state.originPending || state.scaleRulerPending;
          if (!m.additive && !m.subtract && !inPending) clearAllBgSelection(file);
          const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
          // 元素很多時(DXF 常見上千個)迴圈中的 getBoundingClientRect 會強制 layout 重算 → 顯示處理中
          const heavy = els.length > 500;
          if (heavy) showBusy(`匡選中…(${els.length} 個元素)`);
          els.forEach(el2 => {
            if (el2.dataset.bgPageBg === "1") return;   // 跳過頁背景級大方框
            try {
              const cr = el2.getBoundingClientRect();
              if (cr.width === 0 && cr.height === 0) return;
              const tl = screenToWorld(cr.left, cr.top);
              const br = screenToWorld(cr.right, cr.bottom);
              const rx1 = Math.min(tl.x, br.x), ry1 = Math.min(tl.y, br.y);
              const rx2 = Math.max(tl.x, br.x), ry2 = Math.max(tl.y, br.y);
              const intersects = !(rx1 > x2 || rx2 < x1 || ry1 > y2 || ry2 < y1);
              const fully = (rx1 >= x1 && rx2 <= x2 && ry1 >= y1 && ry2 <= y2);
              const hit = crossing ? intersects : fully;
              if (!hit) return;
              const key = String(el2.dataset.bgIdx);
              if (m.subtract) {
                file.selectedBgPaths.delete(key);
                el2.classList.remove("bg-selected");
              } else {
                file.selectedBgPaths.add(key);
                el2.classList.add("bg-selected");
              }
            } catch (_) {}
          });
          updateBgEditOpsVisibility();
          // 匡選結束後同樣跑 pending 後處理(讓拖框 2 條也能觸發)
          checkBgPendingAfterSelect();
          if (heavy) hideBusy();
        }
        render();
        return;
      }
      if (!m.additive && !m.subtract) clearSelection();
      const p = getPage();
      const inside = (j) => j.x >= x1 && j.x <= x2 && j.y >= y1 && j.y <= y2;
      const f = state.selectFilter;
      if (f === "all" || f === "joints") {
        for (const j of p.joints) if (inside(j)) {
          if (m.subtract) state.selection.joints.delete(j.id);
          else            state.selection.joints.add(j.id);
        }
        _markSelectionSourceIfEmpty();   // 框選成功也記 source page
      }
      if (f === "all" || f === "members") {
        for (const mem of p.members) {
          const a = jointById(mem.j1), b = jointById(mem.j2);
          if (!a || !b) continue;
          const inA = inside(a), inB = inside(b);
          let hit = false;
          if (crossing) hit = inA || inB || segIntersectsRect(a, b, x1, y1, x2, y2);
          else          hit = inA && inB;
          if (!hit) continue;
          // 方向 filter:add 時擋住不符方向的(subtract 不擋,允許清除)
          if (!m.subtract && !_memberPassesDirFilter(mem)) continue;
          if (m.subtract) state.selection.members.delete(mem.id);
          else            state.selection.members.add(mem.id);
        }
      }
      render(); refreshLists();        // 只有真的拖曳才需要重畫
    }
  }
});

function segIntersectsRect(a, b, x1, y1, x2, y2) {
  // assumes a or b not already inside (caller handles); test against 4 rect edges
  const corners = [
    { x: x1, y: y1 }, { x: x2, y: y1 },
    { x: x2, y: y2 }, { x: x1, y: y2 },
  ];
  for (let i = 0; i < 4; i++) {
    const c = corners[i], d = corners[(i + 1) % 4];
    if (segCrosses(a, b, c, d)) return true;
  }
  return false;
}
function segCrosses(p1, p2, p3, p4) {
  const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2);
  const d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // collinear edge touching counts too
  return false;
}

window.addEventListener("keydown", (e) => {
  // Alt / Option 鍵狀態追蹤(供 bgDrawLine 預覽切換 bg path 優先吸附)
  if (e.key === "Alt" && !state.altDown) {
    state.altDown = true;
    if (state.bgDrawLine && state.bgDrawLine.active) render();
  }
  // Cmd/Ctrl+S 儲存專案 — 即使在輸入框也允許,避免被瀏覽器的「儲存網頁」攔走
  // 必須放在 inEditable bail 前
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    _startSaveWithHook(!!e.shiftKey);
    return;
  }
  // Cmd/Ctrl+[  返回上一個畫面位置(類似 IntelliJ「Back」)
  // Cmd/Ctrl+]  前進到下一個畫面位置(類似 IntelliJ「Forward」)
  // 也擋下瀏覽器預設的「上下一頁」行為。Shift 不影響(避免跟其他組合衝突)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "[" || e.key === "]")) {
    e.preventDefault();
    if (e.key === "[") navBack(); else navForward();
    return;
  }
  // 在輸入框 / 下拉 / textarea 中時,其他全域快捷鍵不處理
  // (對話框內的 Esc / Enter 由各自 input 的 keydown listener 處理)
  const inEditable = e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA";
  if (inEditable) return;

  // 移動中的鎖定切換:free / dist 模式下,按 Shift = 鎖水平、Alt = 鎖垂直
  // (避免用 Ctrl — macOS 的 Ctrl+click 會被 OS 攔成 right-click,跟我們的 contextmenu 衝突)
  if (state.moveMode.active && state.moveMode.base) {
    const t = state.moveMode.type;
    if (t === "free" || t === "dist") {
      let chg = false;
      if (e.shiftKey && state.moveMode.lock !== "h") { state.moveMode.lock = "h"; chg = true; }
      else if (e.altKey && state.moveMode.lock !== "v") { state.moveMode.lock = "v"; chg = true; }
      if (chg) render();
    }
  }

  // C(無 Shift)
  // - 若已選取桿件 → 一次性把所有選取桿件中分(50% 中點)
  // - 否則 → 設為「插入中點」修飾鍵(按住 C + 點線段)
  if (!e.shiftKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    if (!e.repeat && state.selection.members.size > 0) {
      splitSelectedAtMidpoint();
      return;
    }
    if (!cKeyDown) console.log("[C down] cKeyDown -> true");
    setCKeyDown(true);
    return;
  }
  // Shift+工具切換快捷鍵
  if (e.shiftKey && !(e.metaKey || e.ctrlKey)) {
    const k = e.key.toLowerCase();
    if (k === "w") { e.preventDefault(); openPlanePicker(); return; }
    if (k === "l") { e.preventDefault(); setTool("line"); return; }
    if (k === "p") { e.preventDefault(); setTool("point"); return; }
    if (k === "c") {
      e.preventDefault();
      setTool(state.tool === "selectBg" ? "select" : "selectBg");
      return;
    }
    if (k === "i") { e.preventDefault(); processIntersections(); return; }
    if (k === "d") { e.preventDefault(); performDelete(); return; }
    if (k === "a") { e.preventDefault(); cycleSnapGrid(); return; }
    if (k === "m") { e.preventDefault(); startMoveMode(); return; }
    if (k === "s") {
      if (e.repeat) return;
      e.preventDefault();
      if (state.tool !== "select") setTool("select");
      state.multiSelectSticky = !state.multiSelectSticky;
      updateSelectToolLabel();
      $("hud").textContent = state.multiSelectSticky
        ? "多選模式:點選會累加(Shift+S 切回選取)"
        : "選取模式:點選取代既有(Shift+S 切換多選)";
      render();
      return;
    }
  }
  // Cmd/Ctrl+Z 復原 · Cmd/Ctrl+Shift+Z(或 Ctrl+Y)重做
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault(); redo(); return;
  }
  // Cmd/Ctrl+S 已在 inEditable 檢查之前處理,這裡不重複
  if (mod && e.key.toLowerCase() === "a" && state.tool === "selectBg") {
    e.preventDefault();
    selectAllBgPaths();
    return;
  }
  // Cmd/Ctrl+A 在選取模式下走「全選」按鈕同一條路徑 — 會套 state.selectFilter 跟 memberDirFilter
  // (filter=joints 只選點、filter=members 套方向 filter 只選符合方向的線、filter=all 兩個都選)
  if (mod && e.key.toLowerCase() === "a" && state.tool === "select") {
    e.preventDefault();
    selToolsSelectAll();
    return;
  }
  if (e.key === "Tab" && state.tool === "select") {
    e.preventDefault();
    cycleSelectFilter();
    return;
  }
  if (e.code === "Space") { state.spaceDown = true; wrap.style.cursor = "grab"; e.preventDefault(); }
  else if (e.key === "Shift") { state.ortho = !state.ortho; render(); }
  else if (e.shiftKey && e.key.toLowerCase() === "m") startMoveMode();
  else if (e.key === "Escape") {
    const apDlg = $("autoPairDialog");
    if (apDlg && apDlg.style.display === "flex") { closeAutoPairDialog(); return; }
    if (state.scaleRulerDrag && state.scaleRulerDrag.active) {
      cancelScaleRulerDrag();
      return;
    }
    if (state.bgDrawLine && state.bgDrawLine.active) {
      exitBgDrawLine("已取消畫直線");
      return;
    }
    if (state.bgCopyLine && state.bgCopyLine.active) {
      exitBgCopyLine("已取消複製線");
      return;
    }
    if (state.bgBisector && state.bgBisector.active) {
      exitBgBisector("已取消中分線");
      return;
    }
    if (state.bgEqui && state.bgEqui.active) {
      exitBgEqui("已取消等分線");
      return;
    }
    if (state.scaleRulerPending) {
      exitScaleRulerPending();
      $("hud").textContent = "已取消比例尺";
      return;
    }
    if (state.sectionLinkPending) {
      exitSectionLinkPending(true);
      const af = getActiveFile();
      if (af) clearAllBgSelection(af);
      $("hud").textContent = "已取消切面";
      render();
      return;
    }
    if (state.sectionLinkPlacing) {
      const prevTool = state.sectionLinkPlacing.prevTool;
      state.sectionLinkPlacing = null;
      if (prevTool && prevTool !== "selectBg" && prevTool !== state.tool) setTool(prevTool);
      $("hud").textContent = "已取消切面定位";
      render();
      return;
    }
    if (state.measurePending || state.measure) {
      // Esc 行為:
      //   - 若 state.measure 在 sliding 中且來自清單(re-edit) → 還原原位置,放回清單
      //   - 若 state.measure 是新建(_fromList=false) → 丟棄(等於取消這次新增)
      //   - 若 measurePending 中(尚未挑線) → 結束 pending
      //   - 已固化的 file.measurements 不會被 Esc 清掉,要刪請從右側欄清單或刪除按鈕
      if (state.measure && state.measure.sliding) {
        if (state.measure._fromList) {
          // 還原 backup → 放回清單
          state.measure.p1 = { ...state.measure._backup.p1 };
          state.measure.p2 = { ...state.measure._backup.p2 };
          state.measure.sliding = false;
          delete state.measure._backup;
          delete state.measure._fromList;
          _persistCurrentMeasure();
          $("hud").textContent = "已還原標示距離原本位置";
        } else {
          // 新建中按 Esc → 丟棄(不加入清單)
          state.measure = null;
          $("hud").textContent = "已取消新增標示距離";
        }
      } else if (state.measurePending) {
        $("hud").textContent = "已取消標示距離";
      }
      exitMeasurePending();
      const af = getActiveFile();
      if (af) clearAllBgSelection(af);
      if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
      render();
      return;
    }
    if (state.pendingGlobalPair != null) {
      state.pendingGlobalPair = null;
      $("hud").textContent = "已取消全局節點配對";
      render();
      return;
    }
    if (state.rangeZoomMode) { exitRangeZoom(); $("hud").textContent = ""; return; }
    if (state.originPending) {
      exitOriginPending();
      $("hud").textContent = "";
      return;
    }
    if (state.splitMode) { exitSplitMode(); return; }
    if (state.moveMode.active) { exitMoveMode(); return; }
    if (state.manualAlign.active) { exitManualAlign(); return; }
    if (state.tool === "selectBg") {
      hideCtxMenu();
      // 優先取消形狀匡選子模式(正方形/長方形/圓形/斜線)
      if (state.bgShapeMarquee && state.bgShapeMarquee.size > 0) {
        clearAllShapeMarqueeModes();
        return;
      }
      // 其次:多線選取模式
      if (state.bgMultiSelect) {
        state.bgMultiSelect = false;
        $("bgEditMultiSelect") && $("bgEditMultiSelect").classList.remove("active");
        updateBgEditOpsVisibility();
        $("hud").textContent = "x: 0 · y: 0 · zoom: 100%";
        return;
      }
      const file = getActiveFile();
      if (file && file.selectedBgPaths && file.selectedBgPaths.size > 0) {
        clearAllBgSelection(file);          // 先清掉選取
      } else {
        setTool("select");                  // 沒選取時 Esc 直接退出修改底圖模式
      }
      return;
    }
    hideCtxMenu();
    state.pendingLineStart = null;
    render();
  }
  else if (e.key === "Delete" || e.key === "Backspace") performDelete();
});
window.addEventListener("keyup", (e) => {
  if (e.key && e.key.toLowerCase() === "c") { setCKeyDown(false); console.log("[C up] cKeyDown -> false"); }
  if (e.key === "Alt") { state.altDown = false; if (state.bgDrawLine && state.bgDrawLine.active) render(); }
  if (e.code === "Space") { state.spaceDown = false; wrap.style.cursor = "none"; }
  else if (e.key === "Shift") {
    commitPendingFilter();              // 放開 Shift → 確認 popup 中的選取模式
    state.ortho = !state.ortho;
    render();
  }
  // 移動中釋放 Shift / Alt → 解除 lock
  if (state.moveMode.active && (e.key === "Shift" || e.key === "Alt")) {
    if (state.moveMode.lock) { state.moveMode.lock = null; render(); }
  }
});

}
