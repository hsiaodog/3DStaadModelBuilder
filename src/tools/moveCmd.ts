// 移動指令(M)— modal workflow:依目前選取節點起算,自由 / 水平 / 垂直 / 距離 / 角度 / 直角座標移動
//
//   • startMoveMode(type) → 進入 modal,type: "free" | "h" | "v" | "dist" | "angle" | "rect"
//   • Esc / exitMoveMode 取消;Enter / 點擊確認
//   • moveModeTarget(cursorWorld) 即時算 tx/ty 預覽位移
//   • commitMove(tx, ty) 套到所有選取節點
//   • showCmdInput / hideCmdInput / handleCmdInputCommit — 距離 / 角度數值輸入小視窗
//
//   依賴 legacy.ts 的 state / setTool / pushUndo / render / etc.
//   `$("cmdInputField")` 的 Enter handler 仍由 legacy.ts 綁(用 import 引用 handleCmdInputCommit)
// @ts-nocheck

import {
  $, state, getPage,
  setTool, pushUndo, render, refreshLists, applyTransform,
  jointById, evalNumExpr,
  _assertSelectionOnActivePage,
} from "../app/integration";

export function startMoveMode(type) {
  if (state.selection.joints.size === 0) {
    alert("請先選取至少一個節點(切到選取工具,再點/框選節點)。");
    return;
  }
  if (!_assertSelectionOnActivePage("移動選取節點(M)")) return;
  if (state.tool !== "select") setTool("select");
  state.moveMode = {
    active: true,
    type: type || "free",
    base: null, lock: null,
    distance: null, angle: null, dx: null, dy: null,
  };
  updateMoveModeHUD();
  render();
}
export function exitMoveMode() {
  state.moveMode = { active: false, type: null, base: null, lock: null, distance: null, angle: null, dx: null, dy: null };
  hideCmdInput();
  applyTransform();
  render();
}
export function moveModeTarget(cursorWorld) {
  const m = state.moveMode;
  if (!m.active || !m.base) return null;
  switch (m.type) {
    case "h": return { x: cursorWorld.x, y: m.base.y };
    case "v": return { x: m.base.x, y: cursorWorld.y };
    case "free": {
      if (m.lock === "h") return { x: cursorWorld.x, y: m.base.y };
      if (m.lock === "v") return { x: m.base.x, y: cursorWorld.y };
      return { x: cursorWorld.x, y: cursorWorld.y };
    }
    case "dist": {
      if (m.distance == null) return null;
      let dx = cursorWorld.x - m.base.x, dy = cursorWorld.y - m.base.y;
      if (m.lock === "h") dy = 0;
      else if (m.lock === "v") dx = 0;
      const len = Math.hypot(dx, dy) || 1;
      return { x: m.base.x + dx / len * m.distance, y: m.base.y + dy / len * m.distance };
    }
    case "angle": {
      if (m.distance == null || m.angle == null) return null;
      const a = m.angle * Math.PI / 180;
      return { x: m.base.x + Math.cos(a) * m.distance, y: m.base.y + Math.sin(a) * m.distance };
    }
    case "rect": {
      if (m.dx == null || m.dy == null) return null;
      return { x: m.base.x + m.dx, y: m.base.y + m.dy };
    }
  }
  return null;
}
export function commitMove(tx, ty) {
  pushUndo();
  const dx = tx - state.moveMode.base.x;
  const dy = ty - state.moveMode.base.y;
  for (const id of state.selection.joints) {
    const jt = jointById(id);
    if (jt) { jt.x += dx; jt.y += dy; }
  }
  exitMoveMode();
  refreshLists();
}
export function handleMoveModeClick(x, y) {
  const m = state.moveMode;
  if (!m.active) return;
  if (!m.base) {
    m.base = { x, y };
    updateMoveModeHUD();
    render();
    return;
  }
  // 第二次點:若資料已備齊就確認;否則無動作(等待輸入)
  const t = moveModeTarget({ x, y });
  if (!t) return;
  commitMove(t.x, t.y);
}
export function updateMoveModeHUD() {
  const m = state.moveMode;
  if (!m.active) return;
  let msg = "";
  if (!m.base) {
    msg = "移動:請點擊基準點(Esc 取消)";
    hideCmdInput();
  } else if (m.type === "dist") {
    if (m.distance == null) {
      msg = "距離移動:在下方輸入距離";
      showCmdInput("輸入距離:", "mm");
    } else {
      msg = "距離移動:移動方向(Shift 鎖水平 / Alt 鎖垂直),點擊確認";
      hideCmdInput();
    }
  } else if (m.type === "angle") {
    if (m.distance == null) {
      msg = "夾角移動:輸入距離";
      showCmdInput("輸入距離:", "mm");
    } else if (m.angle == null) {
      msg = "夾角移動:輸入夾角(0° = 右,90° = 上)";
      showCmdInput("輸入夾角:", "°");
    } else {
      msg = "夾角移動:Enter 確認";
      hideCmdInput();
    }
  } else if (m.type === "rect") {
    if (m.dx == null) {
      msg = "直角坐標移動:輸入水平位移(向右為正)";
      showCmdInput("水平位移:", "mm");
    } else if (m.dy == null) {
      msg = "直角坐標移動:輸入垂直位移(向上為正)";
      showCmdInput("垂直位移:", "mm");
    }
  } else if (m.type === "h") {
    msg = "水平移動:點擊目標(只能左右)";
    hideCmdInput();
  } else if (m.type === "v") {
    msg = "垂直移動:點擊目標(只能上下)";
    hideCmdInput();
  } else {
    msg = "移動:點擊目標(Shift 鎖水平 / Alt 鎖垂直)";
    hideCmdInput();
  }
  $("hud").textContent = msg;
}
export function showCmdInput(prompt, unit) {
  const bar = $("cmdInputBar");
  if (!bar) return;
  bar.style.display = "flex";
  bar.querySelector(".cmd-prompt").textContent = prompt;
  bar.querySelector(".cmd-unit").textContent = unit || "";
  const f = $("cmdInputField");
  f.value = "";
  setTimeout(() => f.focus(), 0);
}
export function hideCmdInput() {
  const bar = $("cmdInputBar");
  if (bar) bar.style.display = "none";
  // 釋放 focus,讓 Shift / Ctrl 等全域快捷鍵在隨後的 mouse 階段生效
  const f = $("cmdInputField");
  if (f) f.blur();
}
export function handleCmdInputCommit() {
  const m = state.moveMode;
  if (!m.active) return;
  const f = $("cmdInputField");
  const v = evalNumExpr(f.value);
  if (Number.isNaN(v)) return;
  if (m.type === "dist") {
    m.distance = v;
    updateMoveModeHUD();
    render();
  } else if (m.type === "angle") {
    if (m.distance == null) m.distance = v;
    else if (m.angle == null) {
      m.angle = v;
      const t = moveModeTarget({ x: 0, y: 0 });
      if (t) { commitMove(t.x, t.y); return; }
    }
    updateMoveModeHUD();
    render();
  } else if (m.type === "rect") {
    if (m.dx == null) m.dx = v;
    else if (m.dy == null) {
      m.dy = v;
      const t = moveModeTarget({ x: 0, y: 0 });
      if (t) { commitMove(t.x, t.y); return; }
    }
    updateMoveModeHUD();
    render();
  }
}
