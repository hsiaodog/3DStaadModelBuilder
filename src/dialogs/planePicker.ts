// 平面選取盤(Shift+W)— pie 形狀的小 popup,讓使用者選 XY / YZ / XZ 任一平面
//
//   • openPlanePicker / closePlanePicker / planePickerSectorAt — pie 中扇形偵測
//   • wirePlanePicker — 模組初始化:綁 window mousemove / mousedown + planePickerBtn onclick
//                       由 legacy.ts 延後 call,避免 TDZ
// @ts-nocheck

import {
  $, state, wrap,
  getPage, pushUndo, render, refreshLists,
  pageHasGroupNum, refreshPageCoordSection,
} from "../app/integration";
import { inferAllGlobalJoints } from "../core/globalJoints";

export function openPlanePicker() {
  const p = getPage();
  if (!p || p._orphan) { alert("請先載入並啟用一個頁面。"); return; }
  state.planePicker.active = true;
  state.planePicker.sector = null;
  // 居中於畫布
  const r = wrap.getBoundingClientRect();
  state.planePicker.x = r.left + r.width / 2;
  state.planePicker.y = r.top + r.height / 2;
  const pp = $("planePicker");
  pp.style.left = state.planePicker.x + "px";
  pp.style.top  = state.planePicker.y + "px";
  pp.style.display = "block";
}

export function closePlanePicker() {
  state.planePicker.active = false;
  $("planePicker").style.display = "none";
  ["ppXY", "ppYZ", "ppXZ", "ppCancel"].forEach(id => $(id).classList.remove("hot"));
}

export function planePickerSectorAt(clientX, clientY) {
  const dx = clientX - state.planePicker.x;
  const dy = clientY - state.planePicker.y;
  if (Math.hypot(dx, dy) < 32) return null;     // 在中心圓裡不選
  const a = Math.atan2(dy, dx);                 // -π..π
  if (a >= -Math.PI/4 && a < Math.PI/4)        return "YZ";
  if (a >= Math.PI/4 && a < 3*Math.PI/4)       return "XZ";
  if (a >= -3*Math.PI/4 && a < -Math.PI/4)     return "XY";
  return "cancel";
}

// window 事件 + 按鈕 onclick:延後到 legacy.ts module body 才綁,避免 circular import TDZ
let _bound = false;
export function wirePlanePicker() {
  if (_bound) return;
  _bound = true;
  window.addEventListener("mousemove", (e) => {
    if (!state.planePicker.active) return;
    const sec = planePickerSectorAt(e.clientX, e.clientY);
    if (sec === state.planePicker.sector) return;
    state.planePicker.sector = sec;
    const map = { XY: "ppXY", YZ: "ppYZ", XZ: "ppXZ", cancel: "ppCancel" };
    ["ppXY", "ppYZ", "ppXZ", "ppCancel"].forEach(id => $(id).classList.remove("hot"));
    if (sec && map[sec]) $(map[sec]).classList.add("hot");
  });
  window.addEventListener("mousedown", (e) => {
    if (!state.planePicker.active) return;
    e.preventDefault(); e.stopPropagation();
    const sec = planePickerSectorAt(e.clientX, e.clientY);
    closePlanePicker();
    if (!sec || sec === "cancel") return;
    const p = getPage();
    if (!p || p._orphan) return;
    pushUndo();
    p.plane = sec;
    // 提示輸入共有數字
    const cur = p.groupNum || "";
    const ans = prompt(`設定 ${sec} 平面的共有數字(1~10000,不可重複):`, cur);
    if (ans !== null) {
      const v = parseInt(ans, 10);
      if (v >= 1 && v <= 10000 && !pageHasGroupNum(v, p)) p.groupNum = v;
      else if (v) alert("數字不合法或已被使用,共有數字未變更。");
    }
    refreshPageCoordSection();
    inferAllGlobalJoints();
    render(); refreshLists();
  }, true);
  // 設定平面按鈕已從工具列移除;仍可用 Shift+W 開啟 plane picker(見 keydown 處理)
  const btn = $("planePickerBtn");
  if (btn) btn.onclick = openPlanePicker;
}
