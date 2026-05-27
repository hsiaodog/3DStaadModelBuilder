// 選取工具列(右側 panel)邏輯
//   selToolsSelectAll        — 「全選」按鈕:依 selectFilter + memberDirFilter 框定範圍
//   selToolsSelectJoints     — 「點」按鈕 toggle:selectFilter joints ↔ all
//   selToolsSelectMembers    — 「線」按鈕 toggle:selectFilter members ↔ all
//   _toggleDirFilter         — 方向 filter 按鈕共用 toggle(垂直 / 水平 / 正交 / 斜)
//   _updateSelToolsFilterBtns— 同步「點 / 線 / 方向」按鈕 active 狀態
//   _classifyMemberDir       — 判定桿件方向(用 page-local pixel,跟 relayout 規則同步)
//   _memberPassesDirFilter   — 套 memberDirFilter 篩 member(true=通過)
//
//   注意:_classifyMemberDir / _memberPassesDirFilter 是 render 也會用的純函數,所以 export
// @ts-nocheck

import {
  state, $, getPage, render, refreshLists,
  clearSelection, _markSelectionSourceIfEmpty,
} from "../legacy";

export function selToolsSelectAll() {
  const p = getPage(); if (!p) return;
  clearSelection();
  // 全選會跟隨 selectFilter:filter=joints 只選點、filter=members 只選線、filter=all 兩個都選
  // 額外:member 還會套 memberDirFilter(只選方向符合的)
  const f = state.selectFilter || "all";
  if (f === "all" || f === "joints") {
    for (const j of p.joints) state.selection.joints.add(j.id);
  }
  if (f === "all" || f === "members") {
    for (const m of p.members) {
      if (!_memberPassesDirFilter(m)) continue;
      state.selection.members.add(m.id);
    }
  }
  _markSelectionSourceIfEmpty();   // 標記 source = 當前頁,讓 render 的 _selOnSrc 判斷成立 → 變色
  render(); refreshLists();
}

// 「點」按鈕:切換 selectFilter — joints (only) ↔ all。不是「全選頁面所有點」
//   作用範圍涵蓋點擊選取跟框選(state.selectFilter 兩邊共用)
export function selToolsSelectJoints() {
  state.selectFilter = state.selectFilter === "joints" ? "all" : "joints";
  _updateSelToolsFilterBtns();
  render();
}

// 「線」按鈕:切換 selectFilter — members (only) ↔ all
export function selToolsSelectMembers() {
  state.selectFilter = state.selectFilter === "members" ? "all" : "members";
  _updateSelToolsFilterBtns();
  render();
}

// 點 / 線 按鈕 active 狀態同步:filter 是 joints → 點按鈕亮、filter 是 members → 線按鈕亮、all → 都暗
export function _updateSelToolsFilterBtns() {
  const bJ = $("selToolsJoints");
  const bM = $("selToolsMembers");
  if (bJ) bJ.classList.toggle("active", state.selectFilter === "joints");
  if (bM) bM.classList.toggle("active", state.selectFilter === "members");
  // 方向 filter 按鈕(只有當 memberDirFilter 啟用時才亮;all 全暗)
  const bV = $("selToolsDirV"), bH = $("selToolsDirH"), bO = $("selToolsDirO"), bD = $("selToolsDirD");
  if (bV) bV.classList.toggle("active", state.memberDirFilter === "vertical");
  if (bH) bH.classList.toggle("active", state.memberDirFilter === "horizontal");
  if (bO) bO.classList.toggle("active", state.memberDirFilter === "orthogonal");
  if (bD) bD.classList.toggle("active", state.memberDirFilter === "diagonal");
}

// 桿件方向分類(page-local pixel 判定;跟 _relayoutPageCore 的 angleTol/absAxisTol 規則同步)
//   回傳 "horizontal" | "vertical" | "diagonal" | null(degenerate)
export function _classifyMemberDir(m: any): "horizontal" | "vertical" | "diagonal" | null {
  const p = getPage();
  if (!p) return null;
  const a = p.joints.find((x: any) => x.id === m.j1);
  const b = p.joints.find((x: any) => x.id === m.j2);
  if (!a || !b) return null;
  const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
  if (dx < 1 && dy < 1) return null;
  const absAxisTol = 5;     // page-local pixel:低於此視為 0
  if (dx < absAxisTol && dy >= absAxisTol) return "vertical";
  if (dy < absAxisTol && dx >= absAxisTol) return "horizontal";
  const len = Math.hypot(dx, dy);
  const angleTol = 0.05;    // ratio 容忍 — 約 3°
  if (dy / len < angleTol) return "horizontal";
  if (dx / len < angleTol) return "vertical";
  return "diagonal";
}

// 檢查 member 是否符合目前的 memberDirFilter(true = 通過,可被選取)
export function _memberPassesDirFilter(m: any): boolean {
  const f = state.memberDirFilter || "all";
  if (f === "all") return true;
  const d = _classifyMemberDir(m);
  if (!d) return false;
  if (f === "orthogonal") return d === "horizontal" || d === "vertical";
  return d === f;
}

// 通用 toggle:點該方向按鈕 → 切到該方向 / 取消;並把 selectFilter 自動拉到 "members"(避免衝突)
export function _toggleDirFilter(target: "vertical" | "horizontal" | "orthogonal" | "diagonal") {
  if (state.memberDirFilter === target) {
    state.memberDirFilter = "all";
  } else {
    state.memberDirFilter = target;
    // 方向 filter 只對 member 有意義 → 自動把 selectFilter 拉到 members(若還是 joints 會衝突)
    if (state.selectFilter === "joints") state.selectFilter = "all";
  }
  _updateSelToolsFilterBtns();
  render();
}
