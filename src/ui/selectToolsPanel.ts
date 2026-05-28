// 選取工具浮動面板(#selectTools)
//
//   • updateSelectToolsVisibility — 依目前選取狀態切換編輯按鈕的 show/hide
//   • selToolsExtendAlong — 「點 / 線 重複擴展」按鈕的核心邏輯
//   • wireSelectToolsPanel — 14 個按鈕 onclick + 面板 click 冒泡阻擋,延後到 legacy.ts 才綁
// @ts-nocheck

import {
  $, state, getPage,
  jointById, render, refreshLists,
} from "../app/integration";
import {
  selToolsSelectAll,
  selToolsSelectJoints,
  selToolsSelectMembers,
  _updateSelToolsFilterBtns,
  _toggleDirFilter,
} from "../tools/selectTools";

// 依目前選取狀態切換編輯按鈕的顯示
export function updateSelectToolsVisibility() {
  const hasMembers = state.selection.members && state.selection.members.size > 0;
  const hasJoints  = state.selection.joints  && state.selection.joints.size  > 0;
  const showLine  = hasMembers ? "" : "none";
  const showJoint = hasJoints  ? "" : "none";
  if ($("selToolsExtend"))     $("selToolsExtend").style.display     = showLine;
  if ($("selToolsExtendBoth")) $("selToolsExtendBoth").style.display = showLine;
  if ($("selToolsJExtH"))      $("selToolsJExtH").style.display      = showJoint;
  if ($("selToolsJExtV"))      $("selToolsJExtV").style.display      = showJoint;
  if ($("selToolsJExtHBoth"))  $("selToolsJExtHBoth").style.display  = showJoint;
  if ($("selToolsJExtVBoth"))  $("selToolsJExtVBoth").style.display  = showJoint;
  if ($("selToolsDupJointH"))  $("selToolsDupJointH").style.display  = showJoint;
  if ($("selToolsDupJointV"))  $("selToolsDupJointV").style.display  = showJoint;
  const jointCount = state.selection.joints ? state.selection.joints.size : 0;
  const showConnect = jointCount >= 2 ? "" : "none";
  if ($("selToolsJConnectH"))  $("selToolsJConnectH").style.display  = showConnect;
  if ($("selToolsJConnectV"))  $("selToolsJConnectV").style.display  = showConnect;
  if ($("selToolsJConnectD"))  $("selToolsJConnectD").style.display  = showConnect;
  const showMerge = jointCount === 2 ? "" : "none";
  if ($("selToolsJMerge"))     $("selToolsJMerge").style.display     = showMerge;
  const memberCount = state.selection.members ? state.selection.members.size : 0;
  if ($("selToolsMeasure"))    $("selToolsMeasure").style.display    = memberCount >= 1 ? "" : "none";
  if ($("selToolsIntersectSel")) $("selToolsIntersectSel").style.display = memberCount >= 2 ? "" : "none";
}

// axis: "horizontal"(同 y)/ "vertical"(同 x);kind: "all" / "joints" / "members";
//   orientation:"horizontal" / "vertical" / "orthogonal" / "diagonal" / undefined(任何方向)
export function selToolsExtendAlong(axis, kind, orientation?) {
  const p = getPage(); if (!p) return;
  const round = (n) => Math.round(n * 100) / 100;
  const eps = 0.5;
  const matchesOrient = (m) => {
    if (!orientation) return true;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) return false;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (orientation === "horizontal") return dy < eps && dx >= eps;
    if (orientation === "vertical")   return dx < eps && dy >= eps;
    if (orientation === "orthogonal") return dy < eps || dx < eps;
    if (orientation === "diagonal")   return dx >= eps && dy >= eps;
    return true;
  };
  const memberKey = (m) => {
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) return null;
    const mid = round(axis === "horizontal" ? (a.y + b.y) / 2 : (a.x + b.x) / 2);
    const span = round(axis === "horizontal" ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x));
    return `${mid}|${span}`;
  };
  const jointCoords = new Set();
  const memberKeys = new Set();
  if (kind === "all" || kind === "joints") {
    for (const id of state.selection.joints) {
      const j = jointById(id); if (!j) continue;
      jointCoords.add(round(axis === "horizontal" ? j.y : j.x));
    }
  }
  if (kind === "all" || kind === "members") {
    for (const id of state.selection.members) {
      const m = p.members.find(mm => mm.id === id);
      if (!m) continue;
      if (!matchesOrient(m)) continue;
      const k = memberKey(m);
      if (k) memberKeys.add(k);
    }
  }
  if (jointCoords.size === 0 && memberKeys.size === 0) return;
  if (kind === "all" || kind === "joints") {
    for (const j of p.joints) {
      const v = round(axis === "horizontal" ? j.y : j.x);
      if (jointCoords.has(v)) state.selection.joints.add(j.id);
    }
  }
  if (kind === "all" || kind === "members") {
    for (const m of p.members) {
      if (!matchesOrient(m)) continue;
      const k = memberKey(m);
      if (k && memberKeys.has(k)) state.selection.members.add(m.id);
    }
  }
  render(); refreshLists();
}

// 14 個按鈕 onclick + 面板 click 冒泡阻擋。legacy.ts module body 末段 call 一次。
export function wireSelectToolsPanel() {
  $("selToolsAll")      && ($("selToolsAll").onclick      = selToolsSelectAll);
  $("selToolsJoints")   && ($("selToolsJoints").onclick   = selToolsSelectJoints);
  $("selToolsDirV")     && ($("selToolsDirV").onclick     = () => _toggleDirFilter("vertical"));
  $("selToolsDirH")     && ($("selToolsDirH").onclick     = () => _toggleDirFilter("horizontal"));
  $("selToolsDirO")     && ($("selToolsDirO").onclick     = () => _toggleDirFilter("orthogonal"));
  $("selToolsDirD")     && ($("selToolsDirD").onclick     = () => _toggleDirFilter("diagonal"));
  _updateSelToolsFilterBtns();   // 初始化 active 狀態
  $("selToolsMembers")  && ($("selToolsMembers").onclick  = selToolsSelectMembers);
  $("selToolsRepeatHJ") && ($("selToolsRepeatHJ").onclick = () => selToolsExtendAlong("horizontal", "joints"));
  $("selToolsRepeatVJ") && ($("selToolsRepeatVJ").onclick = () => selToolsExtendAlong("vertical",   "joints"));
  $("selToolsRepeatOH") && ($("selToolsRepeatOH").onclick = () => selToolsExtendAlong("horizontal", "members", "orthogonal"));
  $("selToolsRepeatOV") && ($("selToolsRepeatOV").onclick = () => selToolsExtendAlong("vertical",   "members", "orthogonal"));
  $("selToolsRepeatDH") && ($("selToolsRepeatDH").onclick = () => selToolsExtendAlong("horizontal", "members", "diagonal"));
  $("selToolsRepeatDV") && ($("selToolsRepeatDV").onclick = () => selToolsExtendAlong("vertical",   "members", "diagonal"));
  // 阻止選取面板點擊冒泡到畫布
  ["selectTools"].forEach(id => {
    const el = $(id); if (!el) return;
    ["click","mousedown","mouseup","dblclick","wheel"].forEach(ev =>
      el.addEventListener(ev, (e) => e.stopPropagation()));
  });
}
