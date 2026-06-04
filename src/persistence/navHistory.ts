// 導航歷史(類似 IntelliJ 的 cmd+[ / cmd+])
//
//   navHistory.stack    — 最多 10 個歷史 view(activeFileId, pageIdx, zoom, panX/Y)
//   navHistory.index    — 目前所在的位置(-1 = 還沒有歷史)
//   _navRecordIfNotInProgress() — 每次 activatePage 之後呼叫,push 新 view 進 stack
//                                  (除非正在 navBack/navForward 中,避免遞迴 record)
//   navBack / navForward         — cmd+[ / cmd+] 走 stack
// @ts-nocheck

import {
  $, state,
  activatePage, applyTransform,
  _saveCurrentTabView,
} from "../app/integration";
import { showBusy, hideBusy, busyTick } from "../ui/busy";

// ---------- 導航歷史(類似 IntelliJ 的 cmd+[ / cmd+]) ----------
//   stack: [{fileId, pageIdx, zoom, panX, panY}, ...]
//   index: 當前位置在 stack 的 index;-1 表示尚未記任何頁
//   navBack:index--;navForward:index++;到達後 restore zoom/pan + activatePage
//   recordIfNotInProgress:在 activatePageWithBusy 結束時呼叫;若 index 不在尾端就先截斷未來分支
export const navHistory = { stack: [], index: -1, max: 10 };
let _navInProgress = false;
export function _captureCurrentView() {
  if (state.activeFileId == null) return null;
  return {
    fileId: state.activeFileId,
    pageIdx: state.pageIdx || 0,
    zoom: state.zoom,
    panX: state.panX,
    panY: state.panY,
    t: Date.now(),
  };
}
export function _navRecordIfNotInProgress() {
  if (_navInProgress) return;
  const v = _captureCurrentView();
  if (!v) return;
  const last = navHistory.stack[navHistory.index];
  if (last && last.fileId === v.fileId && last.pageIdx === v.pageIdx) {
    // 同頁 → 只更新 zoom/pan,不新增 entry
    last.zoom = v.zoom; last.panX = v.panX; last.panY = v.panY; last.t = v.t;
    return;
  }
  // 截斷未來分支(若使用者 back 後又跳新頁,捨棄 forward)
  if (navHistory.index < navHistory.stack.length - 1) {
    navHistory.stack = navHistory.stack.slice(0, navHistory.index + 1);
  }
  navHistory.stack.push(v);
  navHistory.index = navHistory.stack.length - 1;
  if (navHistory.stack.length > navHistory.max) {
    navHistory.stack.shift();
    navHistory.index--;
  }
}
export async function _navGoTo(v) {
  if (!v) return;
  _navInProgress = true;
  try {
    if (state.activeFileId !== v.fileId || (state.pageIdx || 0) !== v.pageIdx) {
      _saveCurrentTabView();
      const f = state.files.find(ff => ff.id === v.fileId);
      if (!f) { console.warn("[nav] 目標檔已不存在,跳過", v); return; }
      showBusy(`返回「${f.name}」…`);
      await busyTick();
      try { await activatePage(v.fileId, v.pageIdx); } finally { hideBusy(); }
    }
    state.zoom = v.zoom; state.panX = v.panX; state.panY = v.panY;
    applyTransform();
  } finally {
    _navInProgress = false;
  }
}
export async function navBack() {
  if (navHistory.index <= 0) {
    $("hud").textContent = "返回:已在歷史最前端";
    return;
  }
  // 跳前先把當前 zoom/pan 寫回此格,讓 forward 還原一致
  const cur = _captureCurrentView();
  if (cur) {
    const top = navHistory.stack[navHistory.index];
    if (top && top.fileId === cur.fileId && top.pageIdx === cur.pageIdx) {
      top.zoom = cur.zoom; top.panX = cur.panX; top.panY = cur.panY;
    }
  }
  navHistory.index--;
  await _navGoTo(navHistory.stack[navHistory.index]);
  $("hud").textContent = `返回(${navHistory.index + 1}/${navHistory.stack.length})`;
}
export async function navForward() {
  if (navHistory.index >= navHistory.stack.length - 1) {
    $("hud").textContent = "前進:已在歷史最末端";
    return;
  }
  const cur = _captureCurrentView();
  if (cur) {
    const top = navHistory.stack[navHistory.index];
    if (top && top.fileId === cur.fileId && top.pageIdx === cur.pageIdx) {
      top.zoom = cur.zoom; top.panX = cur.panX; top.panY = cur.panY;
    }
  }
  navHistory.index++;
  await _navGoTo(navHistory.stack[navHistory.index]);
  $("hud").textContent = `前進(${navHistory.index + 1}/${navHistory.stack.length})`;
}

// SVG path "d" → 直線段陣列。完整支援:
// - M/m 後的「隱式 lineto」(SVG 規範:M 後續座標 = 隱式 L)
// - 絕對 / 相對 (大寫 = 絕對, 小寫 = 相對)
// - L/H/V/Z 直線
// - C/S/Q/T/A 曲線:不產生 segment,但會更新 cur 到曲線終點,讓後續直線位置正確
