// 視窗變換 / 座標轉換 — pan/zoom 數學
//
//   • applyTransform() — 把 state.panX/Y/zoom 套到 #stage 的 CSS transform,並更新 HUD
//   • screenToWorld(cx, cy) — 螢幕座標 → 世界座標(扣 wrap rect + pan + zoom)
//   • fitToView() — 縮放到能顯示整張底圖(拆分檔以 clipRect 為準)
//   • _saveCurrentTabView() — 把目前 zoom/pan 存進當前 page._view,讓分頁切換時能還原
//   • _restorePageView(file, pageIdx) — 若該 page 有存過 view 就還原
// @ts-nocheck

import { state } from "./state";
import { stage, wrap, $ } from "./dom";
import { getActiveFile, render, selectFilterLabel, _t } from "../app/integration";

export function applyTransform() {
  stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  // 進行中的互動模式 HUD 優先:不被座標/縮放資訊蓋掉
  if (state.rangeZoomMode || state.originPending || state.splitMode
      || (state.moveMode && state.moveMode.active) || (state.manualAlign && state.manualAlign.active)
      || state.pendingLineStart) return;
  const Z = (typeof _t === "function" && _t("hud.zoom")) || "縮放";
  $("hud").textContent =
    `X: ${state.cursor.sx.toFixed(1)} · Y: ${state.cursor.sy.toFixed(1)} · ${Z}: ${(state.zoom*100).toFixed(0)}%`
    + (state.tool === "select" ? `  ·  ${selectFilterLabel(state.selectFilter)}` : "");
}

export function screenToWorld(clientX, clientY) {
  const r = wrap.getBoundingClientRect();
  return {
    x: (clientX - r.left - state.panX) / state.zoom,
    y: (clientY - r.top  - state.panY) / state.zoom,
  };
}

export function fitToView() {
  const r = wrap.getBoundingClientRect();
  // 拆分檔:以 clipRect(截圖範圍)為準,否則回退到完整底圖尺寸
  const af = getActiveFile && getActiveFile();
  const cr = af && af.clipRect;
  const bx = cr ? cr.x : 0;
  const by = cr ? cr.y : 0;
  const bw = cr ? cr.w : state.bgWidth;
  const bh = cr ? cr.h : state.bgHeight;
  const z = Math.min(r.width / bw, r.height / bh) * 0.95;
  state.zoom = z;
  state.panX = (r.width  - bw * z) / 2 - bx * z;
  state.panY = (r.height - bh * z) / 2 - by * z;
  applyTransform();
  // 縮放變了,字級 / 節點半徑 / 標號座標都依賴 state.zoom,必須重繪
  render();
}

// 把當前 zoom / pan 存到「正在離開」的那個 page 上,讓切回來時能還原
export function _saveCurrentTabView() {
  if (state.activeFileId == null) return;
  const f = state.files.find(x => x.id === state.activeFileId);
  if (!f) return;
  if (!f.pages) f.pages = {};
  const pidx = state.pageIdx || 0;
  if (!f.pages[pidx]) f.pages[pidx] = { joints: [], members: [], z: 0 };
  f.pages[pidx]._view = { zoom: state.zoom, panX: state.panX, panY: state.panY };
}

// 若該 page 之前有存過 view,就還原並回 true;沒有則保留呼叫端原本的 zoom/pan
export function _restorePageView(file, pageIdx) {
  const p = file && file.pages && file.pages[pageIdx || 0];
  if (!p || !p._view) return false;
  const v = p._view;
  if (!Number.isFinite(v.zoom) || !Number.isFinite(v.panX) || !Number.isFinite(v.panY)) return false;
  state.zoom = v.zoom;
  state.panX = v.panX;
  state.panY = v.panY;
  return true;
}
