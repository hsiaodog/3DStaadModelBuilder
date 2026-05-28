// 主工具列 button 處理 + 視覺切換 toggle 同步(~2720 行,最大宗)
//
//   • Label / Joint / Member / Bg 顯示切換按鈕的 update* 同步函式
//   • selectFilter / multiSelect / multiSelectSticky / labelFontScale 等 toggle 行為
//   • 大量 $("btnXXX").onclick = ... wiring(top-level 副作用,模組載入時直接綁)
//
//   依賴 legacy.ts 大量 helper(forward refs)— 過渡期都用 named import live binding。
// @ts-nocheck

import { state } from "./state";
import { $, wrap } from "./dom";
import {
  // 大量 legacy.ts forward refs(過渡期);ESM named import = live binding,
  // 在 module body 跑到 onclick handler 時都已就緒(handler 是 lazy,點擊才執行)
  getPage, getActiveFile, render, refreshLists, refreshFileList, refreshPageSelector,
  pushUndo, _setBtnLabel, _t, withBusy,
  _afterCalibrationChanged, _assertSelectionOnActivePage,
  _consolidateInPlace, _fileHasFullSetup, _planeAxisInfo,
  _populateSectionLinkJointsForFile, _restoreSectionLinkShapeMarquee,
  _snapCoordToPrecision, _updateGlobalOriginUI,

  activatePage, applyTransform, applyBgSelectMode, applyBgRotation,
  bgLineWorldEnds, bgLocalToWorld, bgPathWorldBBox,
  bindJointToGlobal, findGlobalJointById, unbindJointFromGlobal,
  checkBgPendingAfterSelect,
  clearSelection, clearAllBgSelection,
  createGlobalJoint,
  deleteSelectedFiles, deleteSelection, processIntersections, processIntersectionsForSelection,
  displayJointId, displayMemberId,
  duplicateJointOnAxis, extendJointAxisToIntersect, extendSelectedMembersToIntersect,
  effectiveAttr,
  ensureJointAt,
  exitMoveMode, exitOriginPending, exitRangeZoom, exitScaleRulerPending,
  fmtCoord, fmtWorld3D,
  jointById,
  setTool,
  syncMemberAcrossViews, syncJointAcrossViews,
  showCtxMenu,
  _isStraightBgLineElement,
  allocJointId, allocMemberId, allocGlobalJointId, allocGlobalMemberId,
  bgComputeMeasureFromSelection,
  bgSquaresToJoints,
  bgRectsToMembers,
  bgConvertToIntersections,
  bgPathsSplitToLines, bgPathsToMembers,
  bgToggleDashedOnSelection,
  consolidateAllPagesWithConfirm,
  _runFitMergeByPrecision,
  _run3DOneClickPipeline,
  relayoutNumberingAll, relayoutMembersNumberingAll, relayoutNumbering, relayoutMembersNumbering,
  open3DPreviewDialog,
  openMaterialMgrWindow,
  openSearchWindow,
  openGlobalJointMgrDialog,
  startExtendableMemberCheck, startExtendableMemberCheckCurrentPage,
  newProjectPrompt, openProjectWithPicker, startMoveMode, startMeasureFromCurrentSelection, getOrCreateJointOnPage,
  updateBgEditOpsVisibility,
  _startSaveWithHook,
  closeCurrentProject,
  toggleShapeMarqueeMode,
  clearAllShapeMarqueeModes,
  toggleBgMultiSelect,
  startScaleRulerDrag,
  setProjectDirty,
  inferAllGlobalJoints,
} from "../app/integration";
import { invalidateRankCache, _worldForRank } from "../core/rankCache";
import { showBusy, hideBusy, busyTick, showBusyWithCancel, setBusyMessage } from "../ui/busy";
import { parseStraightSegs, updateBgStrokeWidth } from "../io/bgRender";
import { getPage, refreshPageCoordSection, syncStateScaleFromActiveFile, prewarmAllPagesBgCache } from "./integration";
import { screenToWorld } from "./transform";
import { setNextGlobalJointId, setNextGlobalMemberId } from "./state";
import { handleCmdInputCommit } from "../tools/moveCmd";
import { hideCtxMenu } from "../dialogs/ctxMenu";
import { inferGlobalJoint } from "../core/globalJoints";
import { joint2DToWorld3D, world3DToJoint2D } from "../core/projection";
import { lineLineIntersect, splitMembersAtCollinearJoints, subtractiveSelect, consolidateGeometry } from "../tools/jointMemberEdit";
import { renderFileThumb } from "../tools/sectionLink";

// ---------- 標示字體整體放大 / 縮小 / 顯示切換 ----------
//   舊版 btnLblToggle 已拆成兩顆獨立按鈕(節點 / 桿件)。
//   updateLblToggleBtn 保留 thin wrapper 給可能的舊呼叫端,實際是同步兩顆新按鈕
export function updateLblToggleBtn() {
  updateJointLblToggleBtn();
  updateMemberLblToggleBtn();
}
export function updateJointLblToggleBtn() {
  const btn = $("btnJointLblToggle");
  if (btn) {
    const key = state.jointLabelsVisible ? "tb.jointLblShown" : "tb.jointLblHidden";
    const fb  = state.jointLabelsVisible ? "節點標號 顯示"  : "節點標號 隱藏";
    _setBtnLabel(btn, key, fb);
    btn.classList.toggle("active", !!state.jointLabelsVisible);
  }
}
export function updateMemberLblToggleBtn() {
  const btn = $("btnMemberLblToggle");
  if (btn) {
    const key = state.memberLabelsVisible ? "tb.memberLblShown" : "tb.memberLblHidden";
    const fb  = state.memberLabelsVisible ? "桿件標號 顯示"  : "桿件標號 隱藏";
    _setBtnLabel(btn, key, fb);
    btn.classList.toggle("active", !!state.memberLabelsVisible);
  }
}
export function updateJointVisBtn() {
  const btn = $("btnJointVis");
  if (btn) {
    const key = state.jointsVisible ? "tb.jointShown" : "tb.jointHidden";
    const fb  = state.jointsVisible ? "節點 顯示"   : "節點 隱藏";
    _setBtnLabel(btn, key, fb);
    btn.classList.toggle("active", !!state.jointsVisible);
  }
}
export function updateMemberVisBtn() {
  const btn = $("btnMemberVis");
  if (btn) {
    const key = state.membersVisible ? "tb.memberShown" : "tb.memberHidden";
    const fb  = state.membersVisible ? "桿件 顯示"   : "桿件 隱藏";
    _setBtnLabel(btn, key, fb);
    btn.classList.toggle("active", !!state.membersVisible);
  }
}
function applyGeomVisibility() {
  document.body.classList.toggle("joints-hidden",  !state.jointsVisible);
  document.body.classList.toggle("members-hidden", !state.membersVisible);
}
function bumpLabelFontScale(mult) {
  const cur = state.labelFontScale || 1;
  state.labelFontScale = Math.max(0.3, Math.min(4, cur * mult));
  render();
}
$("btnLblBigger")  && ($("btnLblBigger").onclick  = () => bumpLabelFontScale(1.15));
$("btnLblSmaller") && ($("btnLblSmaller").onclick = () => bumpLabelFontScale(1/1.15));
$("btnLblReset")   && ($("btnLblReset").onclick   = () => { state.labelFontScale = 1; render(); });
function _toggleLabelsVisible() {
  // 同時 toggle 兩個(舊行為:合併鈕)— 保留給快捷鍵 / 舊呼叫端
  const nextVal = !(state.jointLabelsVisible && state.memberLabelsVisible);
  state.jointLabelsVisible = nextVal;
  state.memberLabelsVisible = nextVal;
  state.labelsVisible = nextVal;
  updateLblToggleBtn();
  render();
}
function _toggleJointLabelsVisible() {
  state.jointLabelsVisible = !state.jointLabelsVisible;
  state.labelsVisible = state.jointLabelsVisible || state.memberLabelsVisible;
  updateJointLblToggleBtn();
  render();
}
function _toggleMemberLabelsVisible() {
  state.memberLabelsVisible = !state.memberLabelsVisible;
  state.labelsVisible = state.jointLabelsVisible || state.memberLabelsVisible;
  updateMemberLblToggleBtn();
  render();
}
function _toggleJointsVisible() {
  state.jointsVisible = !state.jointsVisible;
  applyGeomVisibility();
  updateJointVisBtn();
}
function _toggleMembersVisible() {
  state.membersVisible = !state.membersVisible;
  applyGeomVisibility();
  updateMemberVisBtn();
}
$("btnJointLblToggle")  && ($("btnJointLblToggle").onclick  = _toggleJointLabelsVisible);
$("btnMemberLblToggle") && ($("btnMemberLblToggle").onclick = _toggleMemberLabelsVisible);
// 舊 id 若還掛著(向下相容,不會 noop)
$("btnLblToggle")  && ($("btnLblToggle").onclick  = _toggleLabelsVisible);
$("btnJointVis")   && ($("btnJointVis").onclick   = _toggleJointsVisible);
$("btnMemberVis")  && ($("btnMemberVis").onclick  = _toggleMembersVisible);
updateLblToggleBtn();
updateJointVisBtn();
updateMemberVisBtn();
applyGeomVisibility();

// 底圖顯示 / 隱藏切換 — 用 body.bg-hidden class 一併控制 #bg-canvas 與 #bgSvg
// 修改底圖模式下不論 state.bgVisible 為何,都強制顯示底圖(否則 paths 無法點選)
export function updateBgToggleBtn() {
  const btn = $("btnBgToggle");
  if (!btn) return;
  const key = state.bgVisible ? "tb.bgShown" : "tb.bgHidden";
  const fb  = state.bgVisible ? "底圖 顯示"  : "底圖 隱藏";
  _setBtnLabel(btn, key, fb);
  btn.classList.toggle("active", !!state.bgVisible);
}
function applyBgVisibility() {
  const shouldHide = !state.bgVisible && state.tool !== "selectBg";
  document.body.classList.toggle("bg-hidden", shouldHide);
}
$("btnBgToggle") && ($("btnBgToggle").onclick = () => {
  state.bgVisible = !state.bgVisible;
  applyBgVisibility();
  updateBgToggleBtn();
});
updateBgToggleBtn();

// 底圖修復:重新跑 activatePage 把當前頁的 bg 從快取 / pdf / image 重建。
//   觸發情境:操作中底圖突然消失 — 通常是 DOM 上的 bgSvg 被某個流程清掉但沒重畫。
//   不動到節點 / 桿件 / 標線 / scaleRuler / planeOrigin / clipRect 等,純粹 re-render bg。
//   隱性把 bgVisible 也設回 true,避免「修復」按下去看起來沒反應(其實是不可見)。
//   按鈕已移到主選單列「工具」→「底圖修復」;函式公開以便兩處都能呼叫
export async function _runBgRepair() {
  const af = getActiveFile();
  if (!af) { $("hud").textContent = "底圖修復:尚未選擇檔案"; return; }
  if (!state.bgVisible) { state.bgVisible = true; applyBgVisibility(); updateBgToggleBtn(); }
  const before = {
    hasBgImg: !!af.cachedBgImg, hasBgSvg: !!af.cachedBgSvg,
    hasPdf: !!af.pdf, hasImage: !!af.image, sourceFileId: af.sourceFileId || null,
  };
  console.log("[底圖修復] 開始", { fileId: af.id, name: af.name, pageIdx: state.pageIdx, ...before });
  await withBusy("重新渲染底圖中…", async () => {
    try {
      await activatePage(af.id, state.pageIdx || 0);
    } catch (e) {
      console.error("[底圖修復] activatePage 失敗:", e);
      throw e;
    }
  });
  const bgSvgEl = document.getElementById("bgSvg");
  const bgCanvasEl = document.getElementById("bg-canvas");
  const svgChildren = bgSvgEl ? bgSvgEl.childElementCount : -1;
  console.log("[底圖修復] 完成", { bgSvgChildren: svgChildren, hasBgCanvas: !!bgCanvasEl });
  $("hud").textContent = `底圖修復完成・${af.name}(${before.hasPdf ? "PDF" : before.hasImage ? "Image" : before.hasBgSvg ? "cached SVG" : before.hasBgImg ? "cached PNG" : before.sourceFileId ? "source 共享" : "空白"}・SVG 子元素 ${svgChildren})`;
}
$("btnBgRepair") && ($("btnBgRepair").onclick = _runBgRepair);

// 3D 一鍵處理(主視窗 9 步 pipeline)— 實作搬到 src/tools/oneClickPipeline.ts
export { _run3DOneClickPipeline } from "../tools/oneClickPipeline";

// 跨頁同步建點 toggle
export function updateCrossViewSyncBtn() {
  const btn = $("btnCrossViewSync");
  if (!btn) return;
  btn.classList.toggle("active", !!state.crossViewSync);
  // 只用底色 active 表達狀態,不加 ✓ 文字
  _setBtnLabel(btn, "tb.crossViewSync", "跨頁同步");
}
$("btnCrossViewSync") && ($("btnCrossViewSync").onclick = () => {
  state.crossViewSync = !state.crossViewSync;
  updateCrossViewSyncBtn();
  $("hud").textContent = state.crossViewSync
    ? "跨頁同步建點:啟動 — 在「節點」工具下建立節點時,所有相容平面的頁面都會建對應節點"
    : "跨頁同步建點:已關閉";
});
updateCrossViewSyncBtn();

$("btnPrewarmBgCache") && ($("btnPrewarmBgCache").onclick = () =>
  withBusy("掃描所有底圖中…", async () => {
    const n = await prewarmAllPagesBgCache();
    $("hud").textContent = `底圖掃描完成:建立 ${n} 個頁面的 bg 交點快取,可開始用跨頁同步建點吸到底圖實際交點`;
  })
);
$("btnDel").onclick = performDelete;
$("selToolsExtend")     && ($("selToolsExtend").onclick     = () => withBusy("桿件單端延伸中…", () => extendSelectedMembersToIntersect(false)));
$("selToolsExtendBoth") && ($("selToolsExtendBoth").onclick = () => withBusy("桿件兩端延伸中…", () => extendSelectedMembersToIntersect(true)));
$("selToolsJExtH")     && ($("selToolsJExtH").onclick     = () => withBusy("端點水平延桿中…",     () => extendJointAxisToIntersect("h", false)));
$("selToolsJExtV")     && ($("selToolsJExtV").onclick     = () => withBusy("端點垂直延桿中…",     () => extendJointAxisToIntersect("v", false)));
$("selToolsJExtHBoth") && ($("selToolsJExtHBoth").onclick = () => withBusy("端點兩側水平延桿中…", () => extendJointAxisToIntersect("h", true)));
$("selToolsJExtVBoth") && ($("selToolsJExtVBoth").onclick = () => withBusy("端點兩側垂直延桿中…", () => extendJointAxisToIntersect("v", true)));
$("selToolsDupJointH") && ($("selToolsDupJointH").onclick = () => withBusy("節點水平複製中…",     () => duplicateJointOnAxis("h")));
$("selToolsDupJointV") && ($("selToolsDupJointV").onclick = () => withBusy("節點垂直複製中…",     () => duplicateJointOnAxis("v")));
$("selToolsJConnectH") && ($("selToolsJConnectH").onclick = () => connectSelectedJoints("h"));
$("selToolsJConnectV") && ($("selToolsJConnectV").onclick = () => connectSelectedJoints("v"));
$("selToolsJConnectD") && ($("selToolsJConnectD").onclick = () => connectSelectedJointsDiagonal());
$("selToolsJMerge")    && ($("selToolsJMerge").onclick    = () => mergeTwoSelectedJoints());
$("selToolsMeasure")   && ($("selToolsMeasure").onclick   = () => startMeasureFromCurrentSelection());
$("selToolsAnchorToggle") && ($("selToolsAnchorToggle").onclick = () => toggleAnchorOnSelectedJoints());
// _updateAnchorToggleBtn / toggleAnchorOnSelectedJoints / toggleSupportTypeOnSelectedAnchors /
// updateSupportTypeBtn 已抽到 tools/anchor.ts(pickSupportTypeModal 也在那邊)
import {
  _updateAnchorToggleBtn,
  toggleAnchorOnSelectedJoints,
  toggleSupportTypeOnSelectedAnchors,
  updateSupportTypeBtn,
} from "../tools/anchor";
export {
  _updateAnchorToggleBtn,
  toggleAnchorOnSelectedJoints,
  toggleSupportTypeOnSelectedAnchors,
  updateSupportTypeBtn,
};

// 兩點合一:把選取的 2 個節點合併
//   合併點選擇:讓兩端原連的桿件「方向不變、只伸縮」
//     - 兩邊都有外部桿:對 A 的每根連桿 ↔ B 的每根連桿 兩兩求(無界線交點),取平均
//     - 只有一邊有外部桿:用那邊的座標(讓那些桿件完全不動)
//     - 兩邊都沒有外部桿:fallback 中點
//   1) 保留 id 較小者作為 anchor,移到合併點
//   2) 所有指向 drop 端點的 member 重新指向 anchor
//   3) 零長 member(j1==j2,即原本 anchor↔drop 之間那條)移除
//   4) 重複 member(已存在的端點對)移除
//   5) globalId 繼承(若 anchor 沒綁,且 drop 有綁 → 繼承)
function mergeTwoSelectedJoints() {
  const p = getPage();
  if (!p || p._orphan) return;
  const ids = [...state.selection.joints];
  if (ids.length !== 2) { alert("請先選取剛好 2 個節點。"); return; }
  const ja = p.joints.find(j => j.id === ids[0]);
  const jb = p.joints.find(j => j.id === ids[1]);
  if (!ja || !jb) return;
  pushUndo();
  const keep = ja.id < jb.id ? ja : jb;
  const drop = ja.id < jb.id ? jb : ja;
  // === 計算合併點(方向不變)===
  const collectLines = (j, otherJ) => {
    // 回傳 j 的所有外部連桿(不含 j↔otherJ 那條),每條轉成 (from = 另一端點, to = j)
    const out = [];
    for (const m of p.members) {
      let otherId = null;
      if (m.j1 === j.id) otherId = m.j2;
      else if (m.j2 === j.id) otherId = m.j1;
      if (otherId == null || otherId === otherJ.id) continue;
      const o = jointById(otherId);
      if (!o) continue;
      out.push({ p1: { x: o.x, y: o.y }, p2: { x: j.x, y: j.y } });
    }
    return out;
  };
  const linesA = collectLines(ja, jb);
  const linesB = collectLines(jb, ja);
  let mp;
  if (linesA.length > 0 && linesB.length > 0) {
    const pts = [];
    for (const la of linesA) {
      for (const lb of linesB) {
        const r = lineLineIntersect(la.p1, la.p2, lb.p1, lb.p2);
        if (r) pts.push(r);
      }
    }
    if (pts.length > 0) {
      const ax = pts.reduce((s, q) => s + q.x, 0) / pts.length;
      const ay = pts.reduce((s, q) => s + q.y, 0) / pts.length;
      mp = { x: ax, y: ay };
    } else {
      mp = { x: (ja.x + jb.x) / 2, y: (ja.y + jb.y) / 2 };  // 全部平行
    }
  } else if (linesA.length > 0) {
    mp = { x: ja.x, y: ja.y };       // 只有 A 端有外部桿件 → 留在 A
  } else if (linesB.length > 0) {
    mp = { x: jb.x, y: jb.y };       // 只有 B 端有外部桿件 → 留在 B
  } else {
    mp = { x: (ja.x + jb.x) / 2, y: (ja.y + jb.y) / 2 };  // 兩邊都沒桿件
  }
  keep.x = mp.x;
  keep.y = mp.y;
  // globalId 繼承(只在 anchor 沒綁、drop 有綁時繼承)
  if (keep.globalId == null && drop.globalId != null) {
    bindJointToGlobal(keep, drop.globalId);
  } else if (drop.globalId != null && drop.globalId !== keep.globalId) {
    // 衝突:解掉 drop 的綁定避免 GC 後不一致
    unbindJointFromGlobal(drop);
  }
  // 重新指向 drop 的 member 端點到 keep
  for (const m of p.members) {
    if (m.j1 === drop.id) m.j1 = keep.id;
    if (m.j2 === drop.id) m.j2 = keep.id;
  }
  // 刪 drop joint
  p.joints = p.joints.filter(j => j.id !== drop.id);
  // 移除零長 member(原本 keep↔drop 之間那條)
  const before = p.members.length;
  p.members = p.members.filter(m => m.j1 !== m.j2);
  const removedZero = before - p.members.length;
  // 去重(同一對端點 → 只留一條)
  const seen = new Set();
  const dedup = [];
  for (const m of p.members) {
    const k = m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(m);
  }
  const removedDup = p.members.length - dedup.length;
  p.members = dedup;
  // 選取狀態:剩下 anchor
  state.selection.joints.clear();
  state.selection.members.clear();
  state.selection.joints.add(keep.id);
  // 全局節點重新推算
  if (keep.globalId != null) {
    const g = findGlobalJointById(keep.globalId);
    if (g) inferGlobalJoint(g);
  }
  render(); refreshLists();
  $("hud").textContent = `兩點合一:保留 J${displayJointId(keep)}`
    + (removedZero ? `・移除零長桿件 ${removedZero}` : "")
    + (removedDup ? `・去重桿件 ${removedDup}` : "");
}

// 將選取節點兩兩連桿件:axis="h" 同 Y 分群、依 X 排序;axis="v" 同 X 分群、依 Y 排序
// 群組容差:state.scale 校準後 ≈ 1mm;像素時 ≈ 1px。共線視為同一群。
function connectSelectedJoints(axis) {
  const p = getPage();
  if (!p || p._orphan) return;
  const ids = [...(state.selection.joints || [])];
  if (ids.length < 2) { alert("請先選取至少 2 個節點"); return; }
  const joints = ids.map(id => p.joints.find(j => j.id === id)).filter(Boolean);
  if (joints.length < 2) return;

  const tol = state.scale ? Math.max(0.5, state.scale) : 1.0;     // 1 mm 容差(校準後),否則 1 px
  const groupKey = axis === "h" ? "y" : "x";
  const sortKey  = axis === "h" ? "x" : "y";

  // 把 joints 依 groupKey 排序,再相鄰差異 < tol 的歸成一群
  const sorted = [...joints].sort((a, b) => a[groupKey] - b[groupKey]);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i][groupKey] - cur[cur.length - 1][groupKey]) < tol) {
      cur.push(sorted[i]);
    } else {
      groups.push(cur);
      cur = [sorted[i]];
    }
  }
  groups.push(cur);

  // 既有桿件去重表
  const existing = new Set(p.members.map(m => m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`));
  const memberKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;

  pushUndo();
  let addedM = 0, skippedM = 0, lonely = 0;
  for (const g of groups) {
    if (g.length < 2) { lonely++; continue; }
    const seq = [...g].sort((a, b) => a[sortKey] - b[sortKey]);
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i], b = seq[i + 1];
      if (a.id === b.id) continue;
      const k = memberKey(a.id, b.id);
      if (existing.has(k)) { skippedM++; continue; }
      p.members.push({ id: allocMemberId(), j1: a.id, j2: b.id });
      existing.add(k);
      addedM++;
    }
  }
  render(); refreshLists();
  $("hud").textContent = `${axis === "h" ? "水平" : "垂直"}連結:新增 ${addedM} 桿件`
    + (skippedM ? `・略過已存在 ${skippedM}` : "")
    + (lonely ? `・單點群組 ${lonely}` : "");
}
// 斜線連結:在選取節點中找出所有「共線(非水平/垂直)的子群」,沿斜線排序後相鄰兩兩連桿件
//   流程:
//   1. 枚舉所有節點對 (i, j),把方向正規化(方向 + offset 量化)當 lineKey 去重
//   2. 跳過水平 / 垂直(由 H/V 按鈕負責),只處理 |ux| 與 |uy| 都 > minDir 的斜線
//   3. 對每條未處理的線:收集所有選取節點裡垂直距離 ≤ tol 的,沿線方向 sort,相鄰連桿件
//   4. 既存桿件自動跳過(不重建)
function connectSelectedJointsDiagonal() {
  const p = getPage();
  if (!p || p._orphan) return;
  const ids = [...(state.selection.joints || [])];
  if (ids.length < 2) { alert("請先選取至少 2 個節點"); return; }
  const joints = ids.map(id => p.joints.find(j => j.id === id)).filter(Boolean);
  if (joints.length < 2) return;
  const tol = state.scale ? Math.max(0.5, state.scale) : 1.0;   // 1 mm 容差(校準後),否則 1 px
  const minDir = 0.05;   // 排除水平 / 垂直(這兩種由 H/V 按鈕處理),分量太小視為軸向
  const memberKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
  const existing = new Set(p.members.map(m => memberKey(m.j1, m.j2)));
  const processedLines = new Set();
  pushUndo();
  let addedM = 0, skippedM = 0, processedLineCount = 0;
  for (let i = 0; i < joints.length; i++) {
    for (let j = i + 1; j < joints.length; j++) {
      const A = joints[i], B = joints[j];
      const dx = B.x - A.x, dy = B.y - A.y;
      const len = Math.hypot(dx, dy);
      if (len < tol) continue;
      let nx = dx / len, ny = dy / len;
      // 正規化方向:讓 nx >= 0(同條線兩種方向視為同一條)
      if (nx < 0) { nx = -nx; ny = -ny; }
      else if (nx === 0 && ny < 0) { ny = -ny; }
      // 排除水平 / 垂直
      if (Math.abs(nx) < minDir || Math.abs(ny) < minDir) continue;
      // 線的 quantized key:方向角(0.001 rad bin)+ 法距(tol bin)
      //   法距 = A · perpDir,perpDir = (-ny, nx)
      const angle = Math.atan2(ny, nx);
      const angleBin = Math.round(angle * 1000);
      const offset = -A.x * ny + A.y * nx;
      const offsetBin = Math.round(offset / tol);
      const lineKey = `${angleBin}|${offsetBin}`;
      if (processedLines.has(lineKey)) continue;
      processedLines.add(lineKey);
      // 收集所有共線(垂直距離 ≤ tol)的選取節點
      const onLine = [];
      for (const J of joints) {
        const vx = J.x - A.x, vy = J.y - A.y;
        // 垂直距離 = | (J - A) · perpDir | = | -vx*ny + vy*nx |
        const perp = Math.abs(-vx * ny + vy * nx);
        if (perp <= tol) onLine.push(J);
      }
      if (onLine.length < 2) continue;
      // 沿斜線方向 sort(投影量 t = (J - A) · (nx, ny))
      onLine.sort((p1, p2) => {
        const t1 = (p1.x - A.x) * nx + (p1.y - A.y) * ny;
        const t2 = (p2.x - A.x) * nx + (p2.y - A.y) * ny;
        return t1 - t2;
      });
      // 相鄰兩兩連桿件
      for (let k = 0; k + 1 < onLine.length; k++) {
        const a = onLine[k], b = onLine[k + 1];
        if (a.id === b.id) continue;
        const mk = memberKey(a.id, b.id);
        if (existing.has(mk)) { skippedM++; continue; }
        p.members.push({ id: allocMemberId(), j1: a.id, j2: b.id });
        existing.add(mk);
        addedM++;
      }
      processedLineCount++;
    }
  }
  render(); refreshLists();
  $("hud").textContent = `斜線連結:處理 ${processedLineCount} 條斜線・新增 ${addedM} 桿件`
    + (skippedM ? `・略過已存在 ${skippedM}` : "");
}
$("selToolsMove")      && ($("selToolsMove").onclick      = () => startMoveMode("free"));
$("selToolsMoveH")     && ($("selToolsMoveH").onclick     = () => startMoveMode("h"));
$("selToolsMoveV")     && ($("selToolsMoveV").onclick     = () => startMoveMode("v"));
$("selToolsMoveDist")  && ($("selToolsMoveDist").onclick  = () => startMoveMode("dist"));
$("selToolsMoveAngle") && ($("selToolsMoveAngle").onclick = () => startMoveMode("angle"));
$("selToolsMoveRect")  && ($("selToolsMoveRect").onclick  = () => startMoveMode("rect"));
$("cmdInputField") && $("cmdInputField").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); handleCmdInputCommit(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exitMoveMode(); }
});
// 阻止 cmd 輸入區的點擊冒泡到畫布
$("cmdInputBar") && ["click","mousedown","mouseup","dblclick","wheel"].forEach(ev =>
  $("cmdInputBar").addEventListener(ev, (e) => e.stopPropagation()));
function enterSplitMode() {
  state.splitMode = true;
  state.splitFirstCorner = null;
  $("btnSplit").classList.add("active");
  wrap.style.cursor = "none";
  $("hud").textContent = "拆分頁面:請點擊矩形第一個對角(Esc 取消)";
}
export function exitSplitMode() {
  state.splitMode = false;
  state.splitFirstCorner = null;
  $("btnSplit").classList.remove("active");
  wrap.style.cursor = "none";
  applyTransform();
  render();
}
$("btnSplit").onclick = enterSplitMode;

export function performDelete() {
  if (state.tool === "selectBg") {
    deleteSelectedBgPaths();
    return;
  }
  if (state.selection.joints.size === 0 && state.selection.members.size === 0
      && state.selection.fileIds.size > 0) {
    deleteSelectedFiles();
  } else {
    if (!_assertSelectionOnActivePage("刪除選取")) return;
    deleteSelection();
  }
}

function deleteSelectedBgPaths(opts) {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  if (!(opts && opts.skipConfirm)) {
    if (!confirm(`要刪除選取的 ${file.selectedBgPaths.size} 條底圖線條嗎?`)) return;
  }
  pushUndo();
  if (!file.deletedBgPaths) file.deletedBgPaths = new Set();
  file.selectedBgPaths.forEach(idx => {
    file.deletedBgPaths.add(idx);
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
    if (el2) el2.style.display = "none";
  });
  file.selectedBgPaths.clear();
}

// 把選取的底圖 path 解析成節點+桿件,加入當前頁
// 取得單一 bg <line> / 兩端 path 的兩端世界座標
// 把使用者輸入當數字運算式評估;只允許 0-9 . + - * / ( ) e E 與空白,避免任意 JS。
//   合法 → 回傳 number(包含 NaN 過濾);不合法 → 回傳 NaN
export function evalNumExpr(input) {
  if (input == null) return NaN;
  const s = String(input).trim();
  if (!s) return NaN;
  if (!/^[0-9.+\-*/() eE]+$/.test(s)) return NaN;
  try {
    const v = (new Function(`"use strict"; return (${s});`))();
    return (typeof v === "number" && isFinite(v)) ? v : NaN;
  } catch (_) { return NaN; }
}

// 把世界座標點 p 投影到「通過 a, b 的無限延伸直線」上
export function _projectPointOnLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return { x: a.x, y: a.y };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
export function bgSingleLineWorldEnds(el) {
  const segs = svgElementToSegments(el);
  if (segs.length !== 1) return null;
  const seg = segs[0];
  const ctm = el.getScreenCTM && el.getScreenCTM();
  let p1 = { x: seg.x1, y: seg.y1 }, p2 = { x: seg.x2, y: seg.y2 };
  if (ctm) {
    const owner = el.ownerSVGElement || document.getElementById("bgSvg");
    const sp1 = owner.createSVGPoint(); sp1.x = seg.x1; sp1.y = seg.y1;
    const sp2 = owner.createSVGPoint(); sp2.x = seg.x2; sp2.y = seg.y2;
    const wp1 = sp1.matrixTransform(ctm), wp2 = sp2.matrixTransform(ctm);
    p1 = screenToWorld(wp1.x, wp1.y);
    p2 = screenToWorld(wp2.x, wp2.y);
  }
  return { p1, p2 };
}

// 平面座標原點:從 2 條選取 bg 線的交點,或 1 個選取的模型節點
// 兩條線段是否共線(視為同一條無限線)— 平行 + 一條的中點到另一條的距離 ≈ 0
function linesAreCollinear(a, b, eps) {
  const av = { x: a.p2.x - a.p1.x, y: a.p2.y - a.p1.y };
  const bv = { x: b.p2.x - b.p1.x, y: b.p2.y - b.p1.y };
  const aLen = Math.hypot(av.x, av.y), bLen = Math.hypot(bv.x, bv.y);
  if (aLen < 1e-9 || bLen < 1e-9) return false;
  const cross = (av.x * bv.y - av.y * bv.x) / (aLen * bLen);
  if (Math.abs(cross) > 0.01) return false;       // 不平行
  // b 中點到 a 線的垂直距離
  const bm = { x: (b.p1.x + b.p2.x) / 2, y: (b.p1.y + b.p2.y) / 2 };
  const dx = bm.x - a.p1.x, dy = bm.y - a.p1.y;
  const dist = Math.abs(dx * av.y - dy * av.x) / aLen;
  return dist < eps;
}
// 把線段陣列依「共線」分群,回傳 group 陣列(每個 group = 共線索引的陣列)
export function groupCollinearLines(lines, eps) {
  eps = eps || 0.5;
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    let placed = false;
    for (const g of groups) {
      if (linesAreCollinear(lines[i], lines[g[0]], eps)) {
        g.push(i); placed = true; break;
      }
    }
    if (!placed) groups.push([i]);
  }
  return groups;
}
// 把 file.selectedBgPaths 內所有 single line 收成 lines 陣列(world coords)
export function _selectedBgLinesAsWorld(file) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!file || !file.selectedBgPaths || !bgSvgEl) return [];
  const out = [];
  for (const idx of file.selectedBgPaths) {
    const el = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(idx))}"]`);
    if (!el) continue;
    const L = bgSingleLineWorldEnds(el);
    if (L) out.push(L);
  }
  return out;
}
// 計算「不同線」的數量(把共線視為一條)
export function distinctSelectedLineCount(file) {
  const lines = _selectedBgLinesAsWorld(file);
  if (!lines.length) return 0;
  return groupCollinearLines(lines).length;
}
// 從 ≥ 2 條 bg 線推算共同交點:若所有「不同線」兩兩交點收斂到同一點 → 回傳該點;否則 null
function bgComputeOriginFromSelection(file) {
  const lines = _selectedBgLinesAsWorld(file);
  if (lines.length < 2) return null;
  const groups = groupCollinearLines(lines);
  if (groups.length < 2) return null;     // 全部共線 → 無交點
  const reps = groups.map(g => lines[g[0]]);
  const ips = [];
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      const r = lineLineIntersect(reps[i].p1, reps[i].p2, reps[j].p1, reps[j].p2);
      if (r) ips.push(r);
    }
  }
  if (ips.length === 0) return null;
  const ax = ips.reduce((s, p) => s + p.x, 0) / ips.length;
  const ay = ips.reduce((s, p) => s + p.y, 0) / ips.length;
  // 收斂性檢查:所有交點離平均不超過 5 世界單位
  const tol = 5;
  for (const p of ips) {
    if (Math.hypot(p.x - ax, p.y - ay) > tol) return null;
  }
  return { x: ax, y: ay };
}

function bgCreatePlaneOrigin() {
  const file = getActiveFile();
  if (!file) return;
  // 依 state.originPending 判斷模式:`"local"` → 僅動本檔 + 完成後跳全局校準;否則 → 全平面傳播
  const isLocal = (state.originPending === "local");
  const _apply = isLocal ? _applyNewPlaneOriginLocalOnly : _applyNewPlaneOriginToAllSamePlane;
  const _afterDone = (r) => {
    if (isLocal && r && r.changed && $("hud")) {
      // 純 local fix:不自動觸發任何全局校準,避免動到 pg.z 或其他檔
      //   跨檔對齊由使用者手動處理(右側欄「全局節點校準」按鈕)
      $("hud").textContent += "・第三軸 pg.z 與其他檔皆未動;若需跨檔對齊請手動跑「全局節點校準」";
    }
  };
  // 模式 1:1 個模型節點被選取
  if (state.selection.joints && state.selection.joints.size === 1) {
    const jid = [...state.selection.joints][0];
    const j = jointById(jid);
    if (j) {
      const r = _apply(file, { x: j.x, y: j.y });
      if ($("hud")) {
        const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
        const head = isLocal ? `本檔原點已修正(僅本檔)` : `座標原點已設為節點 J${displayJointId(j)}・同平面其他 ${r.changed} 頁已同步對齊`;
        $("hud").textContent = `${head}${slTail}`;
      }
      _afterDone(r);
      return;
    }
  }
  // 模式 2:≥ 2 條 bg 線
  if (file.selectedBgPaths && file.selectedBgPaths.size >= 2) {
    const distinct = distinctSelectedLineCount(file);
    if (distinct < 2) { alert("選取的線都共線,沒有交點。請改選相交的兩條線。"); return; }
    const pt = bgComputeOriginFromSelection(file);
    if (!pt) {
      alert("選取的多條線交點不收斂(不在同一點)。請只選通過同一個節點的線。");
      return;
    }
    const r = _apply(file, { x: pt.x, y: pt.y });
    if ($("hud")) {
      const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
      const head = isLocal ? `本檔原點已修正(${distinct} 條線收斂交點)・僅本檔` : `座標原點已設定(${distinct} 條線收斂交點)・同平面其他 ${r.changed} 頁已同步對齊`;
      $("hud").textContent = `${head}${slTail}`;
    }
    _afterDone(r);
    return;
  }
  alert("請先做下列其一:\n• 在「底圖」選 ≥ 2 條相交的 bg 線\n• 或在「選取」模式下選 1 個節點");
}

// 比例尺(兩線距離):從兩條(理想平行)bg 線的垂直距離,輸入實際長度
function bgCreateScaleRulerByTwoLines() {
  const file = getActiveFile();
  if (!file) return;
  if (!file.selectedBgPaths || file.selectedBgPaths.size !== 2) {
    alert("請選取「兩條」底圖線段");
    return;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  const ids = [...file.selectedBgPaths];
  const els = ids.map(idx => bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`)).filter(Boolean);
  if (els.length !== 2) return;
  const L1 = bgSingleLineWorldEnds(els[0]);
  const L2 = bgSingleLineWorldEnds(els[1]);
  if (!L1 || !L2) { alert("請選取單一線段(若是矩形/多段 path,先「切成直線」)"); return; }
  const v1 = { x: L1.p2.x - L1.p1.x, y: L1.p2.y - L1.p1.y };
  const v2 = { x: L2.p2.x - L2.p1.x, y: L2.p2.y - L2.p1.y };
  const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
  if (len1 < 1e-6 || len2 < 1e-6) { alert("線段長度太短"); return; }
  // 平行檢測:|sin θ| 應該很小
  const sinTheta = Math.abs((v1.x * v2.y - v1.y * v2.x) / (len1 * len2));
  if (sinTheta > 0.05) {
    if (!confirm(`兩線並非平行(夾角 ${(Math.asin(Math.min(1, sinTheta)) * 180 / Math.PI).toFixed(1)}°)。\n會以 L1 中點到 L2 的垂直投影距離為測量值。要繼續嗎?`)) return;
  }
  // L1 中點到 L2 直線的垂直投影。注意:bgSingleLineWorldEnds 回傳的是 SVG path 幾何座標
  // (即 stroke 中心線,SVG 預設 stroke-alignment 為 center),所以這個距離是「中心線到中心線」
  // 的垂直距離,不受兩條線視覺粗度的影響。
  const m1 = { x: (L1.p1.x + L1.p2.x) / 2, y: (L1.p1.y + L1.p2.y) / 2 };
  const t = ((m1.x - L2.p1.x) * v2.x + (m1.y - L2.p1.y) * v2.y) / (len2 * len2);
  const proj = { x: L2.p1.x + t * v2.x, y: L2.p1.y + t * v2.y };
  const measured = Math.hypot(proj.x - m1.x, proj.y - m1.y);
  if (measured < 1e-3) { alert("兩線距離為 0"); return; }
  const input = prompt(
    `兩線中心線垂直距離為 ${measured.toFixed(3)} 單位\n請輸入實際距離(mm,最小 1)\n(可用 + − × ÷ 與括號,例:23*1450 或 1450+1300):`,
    file.scaleRuler ? String(file.scaleRuler.real) : "");
  if (input == null) return;
  const real = evalNumExpr(input);
  if (Number.isNaN(real) || real < 1) { alert("請輸入有效的數字運算式(結果需 ≥ 1)"); return; }
  pushUndo();
  file.scaleRuler = { type: "twoLines", p1: m1, p2: proj, measured, real, ratio: real / measured };
  console.log(`[比例尺・兩線距離] ${measured.toFixed(2)} → ${real} mm`);
  // 比例尺更新後,若是 active file,state.scale 立即同步(不用再按校準)
  if (file.id === state.activeFileId) syncStateScaleFromActiveFile();
  updateScaleRulerButton();
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  else { refreshLists(); render(); }
}

// 建立比例尺:智慧分流
//   選 1 條 → 以該線段長度為測量值
//   選 2 條 → 以兩線垂直距離為測量值(必須平行,否則彈警告)
function bgCreateScaleRuler() {
  const file = getActiveFile();
  if (!file) return;
  const n = (file.selectedBgPaths && file.selectedBgPaths.size) || 0;
  if (n === 2) {
    // 委派給兩線距離版
    return bgCreateScaleRulerByTwoLines();
  }
  if (n !== 1) {
    alert("請選取 1 條(以線段長度)或 2 條(以兩線垂直距離)底圖線段建立比例尺");
    return;
  }
  const idx = [...file.selectedBgPaths][0];
  const bgSvgEl = document.getElementById("bgSvg");
  const el = bgSvgEl && bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
  if (!el) return;
  const segs = svgElementToSegments(el);
  if (segs.length !== 1) {
    alert("此元素不是單一線段(可能是矩形、polyline 或多段 path)。請先「切成直線」再建立比例尺");
    return;
  }
  const seg = segs[0];
  // local → world
  const ctm = el.getScreenCTM && el.getScreenCTM();
  let p1 = { x: seg.x1, y: seg.y1 }, p2 = { x: seg.x2, y: seg.y2 };
  if (ctm) {
    const owner = el.ownerSVGElement || bgSvgEl;
    const sp1 = owner.createSVGPoint(); sp1.x = seg.x1; sp1.y = seg.y1;
    const sp2 = owner.createSVGPoint(); sp2.x = seg.x2; sp2.y = seg.y2;
    const wp1 = sp1.matrixTransform(ctm);
    const wp2 = sp2.matrixTransform(ctm);
    p1 = screenToWorld(wp1.x, wp1.y);
    p2 = screenToWorld(wp2.x, wp2.y);
  }
  // p1, p2 是 SVG path 的幾何端點(即 stroke 中心線端點,不含 stroke 粗度)
  const measured = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (measured < 1e-3) { alert("線段長度為 0,無法當比例尺"); return; }
  const input = prompt(
    `此線段(中心線)於底圖中的長度為 ${measured.toFixed(3)} 單位\n請輸入實際長度(mm,最小 1)\n(可用 + − × ÷ 與括號,例:23*1450):`,
    file.scaleRuler ? String(file.scaleRuler.real) : "");
  if (input == null) return;
  const real = evalNumExpr(input);
  if (Number.isNaN(real) || real < 1) { alert("請輸入有效的數字運算式(結果需 ≥ 1)"); return; }
  pushUndo();
  file.scaleRuler = { bgIdx: idx, p1, p2, measured, real, ratio: real / measured };
  console.log(`[比例尺] 1 底圖單位 = ${file.scaleRuler.ratio.toFixed(4)} mm  (${measured.toFixed(2)} → ${real} mm)`);
  if (file.id === state.activeFileId) syncStateScaleFromActiveFile();
  updateScaleRulerButton();
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  else { refreshLists(); render(); }
}
export function updatePlaneOriginButton() {
  const btn = $("btnPlaneOrigin");
  if (!btn) return;
  const file = getActiveFile();
  if (state.originPending) {
    _setBtnLabel(btn, "tb.planeOriginPending", "座標原點…");
    btn.classList.add("active");
  } else if (file && file.planeOrigin) {
    // active 底色代表「已設定」
    _setBtnLabel(btn, "tb.planeOrigin", "座標原點");
    btn.classList.add("active");
  } else {
    _setBtnLabel(btn, "tb.planeOrigin", "座標原點");
    btn.classList.remove("active");
  }
}

export function updateScaleRulerButton() {
  const btn = $("btnScaleRuler");
  if (!btn) return;
  const file = getActiveFile();
  if (state.scaleRulerPending) {
    _setBtnLabel(btn, "tb.scaleRulerPending", "比例尺…");
    btn.classList.add("active");
  } else if (file && file.scaleRuler) {
    _setBtnLabel(btn, "tb.scaleRuler", "比例尺");
    btn.title = `比例尺已建立:${file.scaleRuler.measured.toFixed(2)} 單位 = ${file.scaleRuler.real} mm(每單位 ${file.scaleRuler.ratio.toFixed(4)} mm)。點擊重新進入底圖模式,可重設`;
    btn.classList.add("active");
  } else {
    _setBtnLabel(btn, "tb.scaleRuler", "比例尺");
    btn.title = "建立比例尺:自動進入底圖模式,選兩條平行線後輸入真實距離,可沿線拖曳放置";
    btn.classList.remove("active");
  }
  updateCalibrateButton();
  updatePlaneOriginButton && updatePlaneOriginButton();
  // 比例尺存在與否會影響「比例尺沿線移動」按鈕的顯示
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
}

export function updateCalibrateButton() {
  const btn = $("btnCalibrate");
  if (!btn) return;
  const file = getActiveFile();
  const hasRuler  = !!(file && file.scaleRuler);
  const hasOrigin = !!(file && file.planeOrigin);
  const ready = hasRuler && hasOrigin;
  if (state.scale && ready) {
    _setBtnLabel(btn, "tb.calibrate", "校準");
    btn.title = `已校準:1 px = ${(1/state.scale).toFixed(4)} ${state.unitName}(state.scale = ${state.scale.toFixed(4)} px/${state.unitName});節點與底圖座標保持原狀,以平面原點為 (0,0)。再次點擊可重新校準`;
    btn.classList.add("active");
  } else {
    _setBtnLabel(btn, "tb.calibrate", "校準");
    if (!hasRuler && !hasOrigin)      btn.title = "校準前需先建立「比例尺」與「平面座標原點」";
    else if (!hasRuler)               btn.title = "校準前需先建立「比例尺」";
    else if (!hasOrigin)              btn.title = "校準前需先建立「平面座標原點」";
    else                              btn.title = "套用比例尺與原點:設定 px↔mm 比例(state.scale),節點與底圖座標不動,僅紀錄比例供後續換算";
    btn.classList.remove("active");
  }
}

// 校準此平面所有點的真實位置:必須有比例尺與平面原點。
//   1) 用比例尺的 ratio (mm/px) 把每個節點換成「相對原點的真實 mm」並四捨五入到 1 mm 整數
//   2) 以固定 PX:MM = 0.1:1 (state.scale = 0.1 px/mm) 重新換回像素座標
//   3) 比例尺端點同步重縮放,維持畫面上的對位
//      → 結果:節點/桿件清單顯示一律是整數 mm,桿件長度精確到 1 mm
//      → 重複按校準不會累積浮點誤差
export function calibratePlane() {
  const file = getActiveFile();
  if (!file) { alert("尚未載入底圖"); return; }
  const hasRuler  = !!file.scaleRuler;
  const hasOrigin = !!file.planeOrigin;
  if (!hasRuler && !hasOrigin) {
    alert("校準前需先建立:\n• 比例尺\n• 平面座標原點");
    return;
  }
  if (!hasRuler)  { alert("校準前需先建立「比例尺」"); return; }
  if (!hasOrigin) { alert("校準前需先建立「平面座標原點」"); return; }
  pushUndo();

  // 校準策略:不對節點 / 比例尺端點 / 底圖座標做任何空間搬動,只「記下」這張底圖的 px↔mm 比例。
  //   - 過去版本會把節點 reframe 到 0.1 px/mm 的標準框架,但底圖沒同步 → 兩層 mismatch
  //   - 改成只設 state.scale,所有「真實長度」用 (px - origin) / state.scale 即時算出
  //   - state.scale 直接從 active file 的 scaleRuler.ratio 推得 → 切檔案時自動跟著切
  const ratio = file.scaleRuler.ratio;
  if (!isFinite(ratio) || ratio <= 0) { alert("比例尺 ratio 無效,請重建比例尺。"); return; }
  syncStateScaleFromActiveFile();
  const o = file.planeOrigin;
  console.log(`[校準] 1 px = ${ratio.toFixed(6)} mm (state.scale = ${state.scale.toFixed(6)} px/mm);節點/底圖座標不動;原點 = (${o.x.toFixed(2)}, ${o.y.toFixed(2)})`);
  updateCalibrateButton();
  refreshLists();
  render();
}

// 從目前選取的 bg paths 中找出所有正方形,在每個正方形的中心新增一個節點
function bgSquaresToJoints() {
  const file = getActiveFile();
  const bgSvgEl = document.getElementById("bgSvg");
  if (!file || !bgSvgEl) return;
  if (!file.selectedBgPaths || file.selectedBgPaths.size === 0) {
    alert("請先用「正方形」匡選模式選取正方形");
    return;
  }
  const p = getPage();
  if (!p || p._orphan) return;

  const eps = 1.0;
  const centers = [];
  const selectedEls = [...file.selectedBgPaths]
    .map(idx => bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`))
    .filter(el => el && el.style.display !== "none" && el.dataset.bgPageBg !== "1");

  // ---- A. 從選取的 4 條軸向 line 找方形 ----
  const horizontals = [], verticals = [];
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line") continue;
    const ends = bgLineWorldEnds(el);
    if (!ends) continue;
    const dx = ends.b.x - ends.a.x, dy = ends.b.y - ends.a.y;
    if (Math.abs(dy) < eps && Math.abs(dx) >= eps) {
      horizontals.push({ x1: Math.min(ends.a.x, ends.b.x), x2: Math.max(ends.a.x, ends.b.x), y: (ends.a.y + ends.b.y) / 2 });
    } else if (Math.abs(dx) < eps && Math.abs(dy) >= eps) {
      verticals.push({ y1: Math.min(ends.a.y, ends.b.y), y2: Math.max(ends.a.y, ends.b.y), x: (ends.a.x + ends.b.x) / 2 });
    }
  }
  for (let i = 0; i < horizontals.length; i++) {
    for (let j = i + 1; j < horizontals.length; j++) {
      const ha = horizontals[i], hb = horizontals[j];
      if (Math.abs(ha.x1 - hb.x1) > eps || Math.abs(ha.x2 - hb.x2) > eps) continue;
      const top = Math.min(ha.y, hb.y), bot = Math.max(ha.y, hb.y);
      const left  = verticals.find(v => Math.abs(v.x - ha.x1) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      const right = verticals.find(v => Math.abs(v.x - ha.x2) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      if (!left || !right) continue;
      const w = ha.x2 - ha.x1, h = bot - top;
      if (Math.abs(w - h) > eps) continue;
      centers.push({ x: (ha.x1 + ha.x2) / 2, y: (top + bot) / 2 });
    }
  }

  // ---- B. 從選取的單一元素找方形 ----
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "line") continue;
    if (tag !== "path" && tag !== "polygon" && tag !== "polyline" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (segs.length < 4) continue;
    const worldSegs = segs.map(s => {
      const a = bgLocalToWorld(el, s.x1, s.y1);
      const b = bgLocalToWorld(el, s.x2, s.y2);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    });
    let allAxis = true;
    const xs = [], ys = [];
    for (const s of worldSegs) {
      const isH = Math.abs(s.ay - s.by) < eps;
      const isV = Math.abs(s.ax - s.bx) < eps;
      if (!isH && !isV) { allAxis = false; break; }
      xs.push(s.ax, s.bx); ys.push(s.ay, s.by);
    }
    if (!allAxis) continue;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w < eps || h < eps) continue;
    if (Math.abs(w - h) > eps) continue;
    centers.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  }

  if (centers.length === 0) {
    alert("選取項目中未偵測到正方形");
    return;
  }
  pushUndo();
  const radius = 0.5;   // 只吸收浮點誤差,別用 snapPx 把鄰近細部點合併掉
  let added = 0;
  for (const c of centers) {
    let merged = false;
    for (const j of p.joints) {
      if (Math.hypot(j.x - c.x, j.y - c.y) < radius) { merged = true; break; }
    }
    if (!merged) {
      p.joints.push({ id: allocJointId(), x: c.x, y: c.y });
      added++;
    }
  }
  console.log(`[正方形 → 節點] 偵測 ${centers.length} 個正方形,新增 ${added} 個節點`);
  render(); refreshLists();
}

// 從目前選取(底圖層)抽出所有長方形 bbox,回傳 [{ minX, minY, maxX, maxY }]
function _bgFindSelectedRects() {
  const file = getActiveFile();
  const bgSvgEl = document.getElementById("bgSvg");
  if (!file || !bgSvgEl) return null;
  const eps = 1.0;
  const rects = [];
  const selectedEls = [...file.selectedBgPaths]
    .map(idx => bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`))
    .filter(el => el && el.style.display !== "none" && el.dataset.bgPageBg !== "1");

  // A. 從選取的 4 條軸向 line 找方框
  const horizontals = [], verticals = [];
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line") continue;
    const ends = bgLineWorldEnds(el);
    if (!ends) continue;
    const dx = ends.b.x - ends.a.x, dy = ends.b.y - ends.a.y;
    if (Math.abs(dy) < eps && Math.abs(dx) >= eps) {
      horizontals.push({ x1: Math.min(ends.a.x, ends.b.x), x2: Math.max(ends.a.x, ends.b.x), y: (ends.a.y + ends.b.y) / 2 });
    } else if (Math.abs(dx) < eps && Math.abs(dy) >= eps) {
      verticals.push({ y1: Math.min(ends.a.y, ends.b.y), y2: Math.max(ends.a.y, ends.b.y), x: (ends.a.x + ends.b.x) / 2 });
    }
  }
  for (let i = 0; i < horizontals.length; i++) {
    for (let j = i + 1; j < horizontals.length; j++) {
      const ha = horizontals[i], hb = horizontals[j];
      if (Math.abs(ha.x1 - hb.x1) > eps || Math.abs(ha.x2 - hb.x2) > eps) continue;
      const top = Math.min(ha.y, hb.y), bot = Math.max(ha.y, hb.y);
      const left  = verticals.find(v => Math.abs(v.x - ha.x1) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      const right = verticals.find(v => Math.abs(v.x - ha.x2) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      if (!left || !right) continue;
      const w = ha.x2 - ha.x1, h = bot - top;
      if (Math.abs(w - h) < eps) continue;   // 正方形 → 跳過
      rects.push({ minX: ha.x1, minY: top, maxX: ha.x2, maxY: bot });
    }
  }

  // B. 從選取的單一 path / polygon / polyline / rect 元素找方框
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "line") continue;
    if (tag !== "path" && tag !== "polygon" && tag !== "polyline" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (segs.length < 4) continue;
    const worldSegs = segs.map(s => {
      const a = bgLocalToWorld(el, s.x1, s.y1);
      const b = bgLocalToWorld(el, s.x2, s.y2);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    });
    let allAxis = true;
    const xs = [], ys = [];
    for (const s of worldSegs) {
      const isH = Math.abs(s.ay - s.by) < eps;
      const isV = Math.abs(s.ax - s.bx) < eps;
      if (!isH && !isV) { allAxis = false; break; }
      xs.push(s.ax, s.bx); ys.push(s.ay, s.by);
    }
    if (!allAxis) continue;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w < eps || h < eps) continue;
    if (Math.abs(w - h) < eps) continue;       // 正方形 → 跳過
    rects.push({ minX, minY, maxX, maxY });
  }

  return rects;
}

// 對選取的長方形建桿件,mode 決定建在哪一邊:
//   "center":中軸(沿長邊)
//   "top":   上邊(y 較小,在螢幕上方;水平/垂直長方形都用「上方水平邊」)
//   "bottom":下邊(y 較大,在螢幕下方;水平/垂直長方形都用「下方水平邊」)
export function bgRectsToMembers(mode) {
  mode = mode || "center";
  const file = getActiveFile();
  const p = getPage();
  if (!file || !p || p._orphan) return;
  const rects = _bgFindSelectedRects();
  if (rects == null) return;
  if (rects.length === 0) {
    alert("選取項目中未偵測到長方形");
    return;
  }
  pushUndo();
  const radius = 0.5;
  const getOrCreateJoint = (x, y) => getOrCreateJointOnPage(p, x, y, radius);
  let memAdded = 0;
  for (const r of rects) {
    const w = r.maxX - r.minX, h = r.maxY - r.minY;
    let p1, p2;
    if (mode === "top") {
      // 上水平邊
      p1 = { x: r.minX, y: r.minY };
      p2 = { x: r.maxX, y: r.minY };
    } else if (mode === "bottom") {
      // 下水平邊
      p1 = { x: r.minX, y: r.maxY };
      p2 = { x: r.maxX, y: r.maxY };
    } else if (w >= h) {
      const midY = (r.minY + r.maxY) / 2;
      p1 = { x: r.minX, y: midY };
      p2 = { x: r.maxX, y: midY };
    } else {
      const midX = (r.minX + r.maxX) / 2;
      p1 = { x: midX, y: r.minY };
      p2 = { x: midX, y: r.maxY };
    }
    const a = getOrCreateJoint(p1.x, p1.y);
    const b = getOrCreateJoint(p2.x, p2.y);
    if (a.id === b.id) continue;
    const exists = p.members.some(m =>
      (m.j1 === a.id && m.j2 === b.id) || (m.j1 === b.id && m.j2 === a.id));
    if (!exists) {
      p.members.push({ id: allocMemberId(), j1: a.id, j2: b.id });
      memAdded++;
    }
  }
  clearAllBgSelection(file);
  console.log(`[長方形 → ${mode} 桿件] 偵測 ${rects.length} 個長方形,新增 ${memAdded} 條桿件`);
  render(); refreshLists();
}

// 向後相容:舊 callers 仍能呼叫到中軸版本
function bgRectsToCenterlineMembers() { bgRectsToMembers("center"); }

function bgPathsToMembers() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) {
    alert("請先在「底圖」模式下框選或點選底圖線條");
    return;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  // 接近的節點視為同一個(snap radius)
  // 容差只用來吸收浮點誤差,不能用 snapPx — 那會把細部矩形的角(例如 3 mm 寬)合併掉
  const snapR = 0.5;   // 0.5 世界單位(通常 mm)
  const getOrCreateJoint = (x, y) => getOrCreateJointOnPage(p, x, y, snapR);
  const log = { input: file.selectedBgPaths.size, segs: 0, jointsAdded: 0, membersAdded: 0, pageBgSkip: 0 };
  const beforeJoints = p.joints.length, beforeMembers = p.members.length;
  for (const idx of file.selectedBgPaths) {
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
    if (!el2) continue;
    if (el2.dataset.bgPageBg === "1") { log.pageBgSkip++; continue; }
    const segs = svgElementToSegments(el2);
    log.segs += segs.length;
    for (const s of segs) {
      const w1 = bgLocalToWorld(el2, s.x1, s.y1);
      const w2 = bgLocalToWorld(el2, s.x2, s.y2);
      const a = getOrCreateJoint(w1.x, w1.y);
      const b = getOrCreateJoint(w2.x, w2.y);
      if (a.id === b.id) continue;
      const exists = p.members.some(m =>
        (m.j1 === a.id && m.j2 === b.id) || (m.j1 === b.id && m.j2 === a.id));
      if (!exists) p.members.push({ id: allocMemberId(), j1: a.id, j2: b.id });
    }
  }
  // 線重疊但端點不重疊時,把節點落在桿件中段的情況自動拆桿
  splitMembersAtCollinearJoints();
  log.jointsAdded = p.joints.length - beforeJoints;
  log.membersAdded = p.members.length - beforeMembers;
  console.log("[轉為桿件]", log);
  // 清掉底圖綠色選取標記(視覺) + selectedBgPaths(資料);保留在修改底圖模式
  clearAllBgSelection(file);
  render(); refreshLists();
}

// 把選取的 bg path 拆成多條 <line>(對 rect、多段 path、polyline 都有效)
function bgPathsSplitToLines() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  pushUndo();
  let maxIdx = 0;
  bgSvgEl.querySelectorAll("[data-bg-idx]").forEach(el => {
    const i = parseInt(el.dataset.bgIdx, 10) || 0;
    if (i > maxIdx) maxIdx = i;
  });
  const newSel = new Set();
  // 沿著父鏈往上找有效 stroke / stroke-width(pdf.js 常把屬性設在 <g> 上)
  function effectiveAttr(el, name) {
    let cur = el;
    while (cur && cur.getAttribute) {
      const v = cur.getAttribute(name) || (cur.style && cur.style[name === "stroke-width" ? "strokeWidth" : name]);
      if (v && v !== "none" && v !== "") return v;
      cur = cur.parentNode;
    }
    return null;
  }
  let _splitLog = { total: 0, noEl: 0, pageBg: 0, alreadyLine: 0, split: 0 };
  for (const idx of [...file.selectedBgPaths]) {
    _splitLog.total++;
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
    if (!el2) { _splitLog.noEl++; continue; }
    if (el2.dataset.bgPageBg === "1") { _splitLog.pageBg++; continue; }
    const segs = svgElementToSegments(el2);
    if (segs.length <= 1) {
      _splitLog.alreadyLine++;
      console.log(`[切成直線] idx=${idx} tag=${el2.tagName} segs=${segs.length} d=${(el2.getAttribute("d")||"").slice(0,80)} → 跳過(已是單一線段或不可解析)`);
      continue;
    }
    _splitLog.split++;
    console.log(`[切成直線] idx=${idx} tag=${el2.tagName} segs=${segs.length} → 拆`);
    const stroke = effectiveAttr(el2, "stroke") || "currentColor";
    const sw = effectiveAttr(el2, "stroke-width") || "1";
    const parent = el2.parentNode;
    const newEls = [];
    for (const s of segs) {
      const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
      ln.setAttribute("x1", s.x1); ln.setAttribute("y1", s.y1);
      ln.setAttribute("x2", s.x2); ln.setAttribute("y2", s.y2);
      ln.setAttribute("stroke", stroke);
      ln.setAttribute("stroke-width", sw);
      ln.style.vectorEffect = "non-scaling-stroke";
      ln.classList.add("bg-stroke", "bg-selected");
      maxIdx += 1;
      ln.dataset.bgIdx = String(maxIdx);
      attachBgPathHandlers(ln, file);
      newEls.push(ln);
      newSel.add(String(maxIdx));
    }
    for (const ne of newEls) parent.insertBefore(ne, el2);
    parent.removeChild(el2);
    file.selectedBgPaths.delete(idx);
  }
  newSel.forEach(k => file.selectedBgPaths.add(k));
  applyBgSelectMode();
  updateBgStrokeWidth();
  render();
  updateBgEditOpsVisibility();
  console.log("[切成直線] 結果:", _splitLog);
}

export function attachBgPathHandlers(/* el2, file */) {
  // 已改為 document 層事件委派(見下方 bgSvgDelegate*),此函式保留為 no-op,
  // 維持外部 call sites 無需更動。減少 N 個元素的 listener 為 1 個,降低記憶體與 dispatch 成本。
}
// 事件委派:對 bgSvg 內所有 [data-bg-idx] 元素統一處理 click / contextmenu。
//   capture 模式 → 比 bubble 階段的 wrap.click / document.click 早觸發
//   stopPropagation → 阻止後續 wrap.click 把點擊當作畫布空白點處理
function _bgSvgDelegateClick(ev) {
  if (state.tool !== "selectBg") return;
  // 畫直線 / 複製線 / 中分線 / 等分線 / 切面定位 進行中 → 點擊由 wrap.click 處理,不走選取邏輯
  if ((state.bgDrawLine && state.bgDrawLine.active) ||
      (state.bgCopyLine && state.bgCopyLine.active) ||
      (state.bgBisector && state.bgBisector.active) ||
      (state.bgEqui && state.bgEqui.active) ||
      state.sectionLinkPlacing) return;
  const el2 = ev.target && ev.target.closest && ev.target.closest("[data-bg-idx]");
  if (!el2 || !el2.closest("#bgSvg")) return;
  const file = getActiveFile();
  if (!file) return;
  // 切面 pending:只接受單段直線(line / 單段 path / 單段 polyline)
  //   非直線(rect / circle / 多段 path / 太短)→ 直接擋掉,不要污染選取狀態
  //   防呆:state.sectionLinkPending 為 true 但 btnSectionLink 不在 active(狀態不一致)→ 視為已退出,清旗標
  if (state.sectionLinkPending) {
    const _btn = document.getElementById("btnSectionLink");
    const _reallyPending = _btn && _btn.classList.contains("active");
    if (!_reallyPending) {
      state.sectionLinkPending = false;
      state.sectionLinkPrevTool = null;
      if (typeof _restoreSectionLinkShapeMarquee === "function") _restoreSectionLinkShapeMarquee();
    } else if (!_isStraightBgLineElement(el2)) {
      ev.stopPropagation();
      $("hud").textContent = "切面:只能選直線(實線 / 虛線都可;不接受矩形 / 圓 / 多段折線)";
      return;
    }
  }
  ev.stopPropagation();
  hideCtxMenu();
  if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
  const key = String(el2.dataset.bgIdx);
  if (subtractiveSelect(ev)) {
    if (file.selectedBgPaths.has(key)) {
      file.selectedBgPaths.delete(key);
      el2.classList.remove("bg-selected");
    }
  } else if (ev.shiftKey || state.bgMultiSelect) {
    if (file.selectedBgPaths.has(key)) {
      file.selectedBgPaths.delete(key);
      el2.classList.remove("bg-selected");
    } else {
      file.selectedBgPaths.add(key);
      el2.classList.add("bg-selected");
    }
  } else {
    if (!state.originPending && !state.scaleRulerPending) clearAllBgSelection(file);
    file.selectedBgPaths.add(key);
    el2.classList.add("bg-selected");
  }
  updateBgEditOpsVisibility();
  checkBgPendingAfterSelect();
}
function _bgSvgDelegateContext(ev) {
  if (state.tool !== "selectBg") return;
  const el2 = ev.target && ev.target.closest && ev.target.closest("[data-bg-idx]");
  if (!el2 || !el2.closest("#bgSvg")) return;
  const file = getActiveFile();
  if (!file) return;
  ev.preventDefault(); ev.stopPropagation();
  if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
  const key = String(el2.dataset.bgIdx);
  if (!file.selectedBgPaths.has(key)) {
    clearAllBgSelection(file);
    file.selectedBgPaths.add(key);
    el2.classList.add("bg-selected");
  }
  updateBgEditOpsVisibility();
  showBgCtxMenu(ev.clientX, ev.clientY);
}
document.addEventListener("click", _bgSvgDelegateClick, true);
document.addEventListener("contextmenu", _bgSvgDelegateContext, true);
export function clearAllBgSelection(file) {
  if (!file || !file.selectedBgPaths) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (bgSvgEl) {
    // 一次掃所有 .bg-selected,避免每個 idx 都呼叫 querySelector(N×N → N)
    bgSvgEl.querySelectorAll(".bg-selected").forEach(el => el.classList.remove("bg-selected"));
  }
  file.selectedBgPaths.clear();
  updateBgEditOpsVisibility();
}
export function selectAllBgPaths() {
  const file = getActiveFile();
  if (!file) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
  bgSvgEl.querySelectorAll("[data-bg-idx]").forEach(el2 => {
    if (el2.style.display === "none") return;     // 已刪除的不選
    if (el2.dataset.bgPageBg === "1") return;     // 跳過頁背景級大方框
    file.selectedBgPaths.add(String(el2.dataset.bgIdx));
    el2.classList.add("bg-selected");
  });
  updateBgEditOpsVisibility();
}

function showBgCtxMenu(x, y) {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  ctxState.pending = {
    bgPaths: new Set(file.selectedBgPaths),
    joints: new Set(), members: new Set(), orphans: new Set(), fileIds: new Set(),
  };
  $("ctxHead").textContent = `已選 ${file.selectedBgPaths.size} 條底圖線條`;
  $("ctxList").innerHTML = "";
  $("ctxRename").style.display = "none";
  $("ctxDuplicate") && ($("ctxDuplicate").style.display = "none");
  $("ctxOpenTab") && ($("ctxOpenTab").style.display = "none");
  $("ctxFilterGroup").style.display = "none";
  $("ctxBgSplit").style.display = "block";
  $("ctxBgToMember").style.display = "block";
  $("ctxBgToDashed") && ($("ctxBgToDashed").style.display = "block");
  // 建立比例尺:只在「正好一條」 bg 線段選取時顯示
  $("ctxBgScaleRuler") && ($("ctxBgScaleRuler").style.display = file.selectedBgPaths.size === 1 ? "block" : "none");
  $("ctxDelete").style.display = "block";
  const m = $("ctxMenu");
  m.style.display = "flex";
  m.style.left = "0px"; m.style.top = "0px";
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + "px";
  m.style.top  = Math.min(y, window.innerHeight - h - 4) + "px";
}

export function svgElementToSegments(el2) {
  const segs = [];
  // 用 localName,避免某些瀏覽器把 SVG tagName 回傳成 "svg:path" 等帶 namespace 前綴的字串
  const tag = (el2.localName || el2.tagName.replace(/^.*:/, "")).toLowerCase();
  if (tag === "line") {
    segs.push({
      x1: parseFloat(el2.getAttribute("x1") || 0),
      y1: parseFloat(el2.getAttribute("y1") || 0),
      x2: parseFloat(el2.getAttribute("x2") || 0),
      y2: parseFloat(el2.getAttribute("y2") || 0),
    });
  } else if (tag === "path") {
    const d = el2.getAttribute("d") || "";
    segs.push(...parseStraightSegs(d));
  } else if (tag === "rect") {
    const x = parseFloat(el2.getAttribute("x") || 0);
    const y = parseFloat(el2.getAttribute("y") || 0);
    const w = parseFloat(el2.getAttribute("width") || 0);
    const h = parseFloat(el2.getAttribute("height") || 0);
    segs.push({ x1: x, y1: y, x2: x + w, y2: y });
    segs.push({ x1: x + w, y1: y, x2: x + w, y2: y + h });
    segs.push({ x1: x + w, y1: y + h, x2: x, y2: y + h });
    segs.push({ x1: x, y1: y + h, x2: x, y2: y });
  } else if (tag === "polyline" || tag === "polygon") {
    const pts = (el2.getAttribute("points") || "").split(/[\s,]+/).filter(s => s !== "").map(parseFloat);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      segs.push({ x1: pts[i], y1: pts[i+1], x2: pts[i+2], y2: pts[i+3] });
    }
    if (tag === "polygon" && pts.length >= 4) {
      const lastIx = pts.length - 2;
      segs.push({ x1: pts[lastIx], y1: pts[lastIx+1], x2: pts[0], y2: pts[1] });
    }
  }
  return segs;
}

export function zoomToSelection() {
  const p = getPage();
  if (!p) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const id of state.selection.joints) {
    const j = p.joints.find(jj => jj.id === id);
    if (j) grow(j.x, j.y);
  }
  for (const id of state.selection.members) {
    const m = p.members.find(mm => mm.id === id);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (a) grow(a.x, a.y);
    if (b) grow(b.x, b.y);
  }
  if (!isFinite(minX)) {
    alert("請先選取節點或桿件。");
    return;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const r = wrap.getBoundingClientRect();
  // 0.7 為留白比例 → 邊界保留約 30% 空間
  const z = Math.min(r.width / w, r.height / h) * 0.7;
  state.zoom = Math.max(0.0001, Math.min(50, z));
  state.panX = r.width  / 2 - cx * state.zoom;
  state.panY = r.height / 2 - cy * state.zoom;
  applyTransform();
  render();
}
$("btnIntersect") && ($("btnIntersect").onclick = processIntersections);
$("selToolsIntersectSel") && ($("selToolsIntersectSel").onclick = processIntersectionsForSelection);
// 適配關聯:三種模式(只節點 / 只桿件 / 兩者),都對當前 active 檔
async function _runInferOnActiveFile(mode) {
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  if (!af) { alert("尚未選擇檔案"); return; }
  if (!_fileHasFullSetup(af)) { alert(`「${af.name}」設定不齊(平面 / 比例尺 / 原點)`); return; }
  pushUndo();
  const r = await _populateSectionLinkJointsForFile(af, { mode });
  if (!r) { $("hud").textContent = "本檔沒有切面線,無法推斷"; return; }
  const label = mode === "joints" ? "節點" : mode === "members" ? "桿件" : "節點+桿件";
  console.log(`[適配關聯:${label}] file=${af.name}・處理 ${r.processedLinks} 條・新增節點 ${r.jointsAdded}・桿件 ${r.membersAdded}・略過 ${r.skipped}` +
    (r.conflicts.length ? `・衝突 ${r.conflicts.length} 件` : ""));
  if (r.conflicts.length) {
    r.conflicts.forEach(c => console.warn("[切面衝突]", c));
    const head = r.conflicts.slice(0, 5).join("\n");
    const more = r.conflicts.length > 5 ? `\n…(共 ${r.conflicts.length} 件,詳見 console)` : "";
    alert(`偵測到多平行切面衝突:\n\n${head}${more}`);
  }
  const parts = [];
  if (r.jointsAdded)  parts.push(`節點 +${r.jointsAdded}`);
  if (r.membersAdded) parts.push(`桿件 +${r.membersAdded}`);
  if (!parts.length)  parts.push("無新增");
  $("hud").textContent = `適配關聯:${label}・${parts.join("、")}・處理 ${r.processedLinks} 條切面` +
    (r.conflicts.length ? `・⚠ 衝突 ${r.conflicts.length} 件` : "");
  render && render();
  refreshLists && refreshLists();
}
// 新版「適配關聯」(精準度配對全部檔案)
//   舊版 _runInferOnActiveFile / _runInferAllFiles (切面投影建節點) 仍保留,可被 console 或舊資料流呼叫
$("btnRelayoutCurrent") && ($("btnRelayoutCurrent").onclick = () => withBusy("編排節點編號(當頁)…", () => relayoutNumbering()));
$("btnRelayoutMembersCurrent") && ($("btnRelayoutMembersCurrent").onclick = () => withBusy("編排桿件編號(當頁)…", () => relayoutMembersNumbering()));
// 全部頁面:對 state.files 每個檔跑指定 mode("joints" / "members" / "both")
//   非同步 + 顯示可中斷的 pending 訊息(取消鈕);每個檔處理完後 busyTick + 檢查 cancel 旗標
async function _runInferAllFiles(mode, opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  const skipPushUndo = !!opts.skipPushUndo;
  const labelMap = { joints: "節點", members: "桿件", both: "節點 + 桿件" };
  const label = labelMap[mode] || "節點 + 桿件";
  const effMode = labelMap[mode] ? mode : "both";
  if (!state.files.length) { if (!skipConfirm) alert("沒有可處理的檔案"); return; }
  if (!skipConfirm && !confirm(`對全部 ${state.files.length} 個檔案跑「適配關聯${label}」?\n${
    effMode === "members" ? "只在兩端 joint 都已對應到目標既有節點時連桿(不建新節點)。" :
    effMode === "joints"  ? "會建節點並自動綁 globalJoint(不建桿件)。" :
                            "會建節點 + 桿件並自動綁 globalJoint。"
  }Ctrl+Z 可還原。\n處理時可從 spinner 上的「取消」按鈕中斷。`)) return;
  if (!skipPushUndo) pushUndo();
  const origFid = state.activeFileId, origPidx = state.pageIdx;
  let totalJ = 0, totalM = 0, totalLinks = 0, touched = 0;
  const allConflicts = [];
  let cancelled = false;
  const files = state.files.slice();
  const onEsc = (e) => {
    if (e.key === "Escape" && !cancelled) {
      e.preventDefault(); e.stopImmediatePropagation();
      cancelled = true;
      setBusyMessage("取消中…等當前檔處理完畢");
    }
  };
  document.addEventListener("keydown", onEsc, true);
  showBusyWithCancel(`適配關聯${label}(全部頁面)準備中…(共 ${files.length} 檔・Esc / 取消可中斷)`, () => {
    cancelled = true;
    setBusyMessage("取消中…等當前檔處理完畢");
  });
  await busyTick();
  let processedCount = 0;
  for (const f of files) {
    if (cancelled) break;
    processedCount++;
    setBusyMessage(`適配關聯${label} ${processedCount}/${files.length}・${f.name}`);
    await busyTick();
    if (cancelled) break;
    if (!_fileHasFullSetup(f)) continue;
    // 注意:不切換 state.activeFileId / pageIdx — _populateSectionLinkJointsForFile 用 F 參數運作,
    //   不讀全局 active state。切換 activeFileId 會讓 undo 後底圖 DOM 與 activeFile 對不上,
    //   造成 Cmd+Z 後 bg 消失。維持 origFid 不動才能讓 bg DOM / bgWidth / bgHeight 一致。
    const r = await _populateSectionLinkJointsForFile(f, {
      mode: effMode,
      onProgress: ({ fileName, processed }) => {
        if (cancelled) return false;
        setBusyMessage(`適配關聯${label} ${processedCount}/${files.length}・${fileName}(處理 ${processed} 節點)`);
      },
    });
    if (!r) continue;
    totalJ += r.jointsAdded; totalM += r.membersAdded; totalLinks += r.processedLinks;
    if (r.jointsAdded || r.membersAdded) touched++;
    for (const c of r.conflicts) allConflicts.push(`${f.name}: ${c}`);
  }
  // origFid/origPidx 從未被改過,但保留還原語義避免將來有人改了上面又忘了還原
  state.activeFileId = origFid; state.pageIdx = origPidx;
  document.removeEventListener("keydown", onEsc, true);
  hideBusy();
  const cancelTag = cancelled ? `(已中斷;處理到第 ${processedCount}/${files.length} 檔)` : "";
  console.log(`[適配關聯${label}(全部頁面)]${cancelTag} ${touched} 檔有變動・節點 +${totalJ}・桿件 +${totalM}・處理 ${totalLinks} 條切面・衝突 ${allConflicts.length} 件`);
  if (allConflicts.length) allConflicts.forEach(c => console.warn("[切面衝突]", c));
  render && render(); refreshLists && refreshLists();
  refreshFileList && refreshFileList();
  $("hud").textContent = `適配關聯${label}(全部頁面)${cancelTag}・${touched} 檔・節點 +${totalJ}・桿件 +${totalM}` +
    (allConflicts.length ? `・⚠ 衝突 ${allConflicts.length} 件` : "");
}
// 舊名稱保留(menu entry 用):
async function _runInferAllFilesBoth() { return _runInferAllFiles("both"); }

// 適配關聯(精準度):用 measureDecimals 把每顆 joint 的世界座標 round 後當 bucket key,
//   bucket 內 ≥ 2 顆來自不同檔 / 不同頁的 joint → 視為「同一物理點」,綁同一 globalJoint。
//   canonical 世界座標 = 該 bucket 的 round 後值(顯示什麼就存什麼)。
//   不依賴切面線、不需要建立節點(只「適配」既有節點)。
//   opts.skipConfirm:跳過確認對話框(批次 / 程式呼叫用)
//   回傳 { groupsCreated, jointsBound, mergedToExisting, totalScanned }
export function _runFitMergeByPrecision(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  const _round = (v) => {
    const r = parseFloat(v.toFixed(md));
    return r === 0 ? 0 : r;
  };
  const _setMsg = (m) => { if (typeof setBusyMessage === "function") setBusyMessage(m); };
  // _tick:直接用 busyTick(已內建 document.hidden 偵測 → 背景 tab 改用 microtask 快速路徑)
  const _tick = () => (typeof busyTick === "function") ? busyTick() : Promise.resolve();
  // 改 async 實作;外部 caller(menu dispatch 用 withBusy / 3D popup 用 await)能看到 spinner message 更新
  //   內部主動啟用 / 關閉主 spinner(showBusy / hideBusy)—— 確保:
  //     (1) 直接呼叫時(不走 withBusy)也看得到 spinner
  //     (2) 3D popup 的 startMirrorBusy polling 要 `.active` 才會鏡像 — 沒啟用就看不到 progress
  //   withBusy 包起來時:主 spinner 已是 active,showBusy 只是覆蓋 msg;hideBusy 會在 withBusy.finally 前先移除 .active → 沒副作用
  return (async () => {
  const _started = (typeof showBusy === "function");
  if (_started) showBusy(`適配關聯(精準度 ${md})準備中…`);
  try {
  // 掃描所有 joint,計算世界座標 + bucket key
  _setMsg(`適配關聯(精準度 ${md}):掃描節點中…`);
  await _tick();
  const buckets = new Map();   // "x|y|z" → [{file, page, key, joint, w}]
  let totalScanned = 0;
  for (const f of state.files) {
    if (!_fileHasFullSetup(f)) continue;
    for (const k of Object.keys(f.pages || {})) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) {
        totalScanned++;
        const w = (typeof _worldForRank === "function") ? _worldForRank(f, pg, j) : null;
        if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.z)) continue;
        const rx = _round(w.x), ry = _round(w.y), rz = _round(w.z);
        const key = `${rx}|${ry}|${rz}`;
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push({ file: f, page: pg, key: +k, j, w: { x: rx, y: ry, z: rz } });
      }
    }
  }
  _setMsg(`適配關聯(精準度 ${md}):掃描完成 ${totalScanned} 顆 ・ 計算候選 bucket…`);
  await _tick();
  // 預估會有多少 bucket 需要處理(只挑 ≥ 2 顆且來自不同檔 / 不同頁的)
  let candidateBuckets = 0;
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    const fids = new Set(arr.map(it => it.file.id + "|" + it.key));
    if (fids.size >= 2) candidateBuckets++;
  }
  if (!skipConfirm) {
    if (!candidateBuckets) {
      alert(`適配關聯:掃描 ${totalScanned} 顆節點,精準度 ${md} 位數下沒有可合併的 bucket(都不重疊)。`);
      return { groupsCreated: 0, jointsBound: 0, mergedToExisting: 0, totalScanned };
    }
  }
  // 統計既有綁定(用於 confirm 訊息 + 完成報告)
  _setMsg(`適配關聯(精準度 ${md}):統計既有綁定…`);
  await _tick();
  const existingGjs = Array.isArray(state.globalJoints) ? state.globalJoints.length : 0;
  const existingGms = Array.isArray(state.globalMembers) ? state.globalMembers.length : 0;
  let existingJointBindings = 0, existingMemberBindings = 0;
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) if (j.globalId != null) existingJointBindings++;
      for (const m of (pg.members || [])) if (m.globalMemberId != null) existingMemberBindings++;
    }
  }
  if (!skipConfirm) {
    const wipeMsg = (existingGjs || existingGms || existingJointBindings || existingMemberBindings)
      ? `\n\n⚠ 會先清除所有既有綁定(避免舊精準度 / 舊校準殘留污染新結果):\n  ・globalJoint 物件 ${existingGjs} 個 ・joint 綁定 ${existingJointBindings} 顆\n  ・globalMember 物件 ${existingGms} 個 ・member 綁定 ${existingMemberBindings} 條`
      : "";
    if (!confirm(`適配關聯:精準度 ${md} 位數 → 找到 ${candidateBuckets} 個可合併 bucket(共 ${totalScanned} 顆節點掃描中)。\n\n會把每組 bucket 內、來自不同檔 / 不同頁的 joint 綁定到同一個 globalJoint(canonical 座標 = round 後的值)。${wipeMsg}\n\nCtrl+Z 可還原。要繼續嗎?`)) {
      return { groupsCreated: 0, jointsBound: 0, mergedToExisting: 0, totalScanned };
    }
  }
  pushUndo();
  // 清除所有既有 global* 綁定 —— 從乾淨狀態重建,避免舊資料污染
  _setMsg(`適配關聯(精準度 ${md}):清除既有 ${existingGjs} gj / ${existingGms} gm…`);
  await _tick();
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) j.globalId = null;
      for (const m of (pg.members || [])) m.globalMemberId = null;
    }
  }
  state.globalJoints = [];
  state.globalMembers = [];
  if (typeof nextGlobalMemberId !== "undefined") setNextGlobalMemberId(1);
  if (typeof nextGlobalJointId !== "undefined") setNextGlobalJointId(1);
  _setMsg(`適配關聯(精準度 ${md}):建立 globalJoint(候選 ${candidateBuckets} bucket)…`);
  await _tick();
  let groupsCreated = 0, jointsBound = 0;
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    const pageKeys = new Set(arr.map(it => it.file.id + "|" + it.key));
    if (pageKeys.size < 2) continue;   // 同一頁多個 joint 應該由「整理」處理
    // 一律新建 globalJoint(既有綁定已在前面清光,不再有 reuse 分支)
    const nextId = state.globalJoints.length
      ? Math.max(...state.globalJoints.map(g => g.id || 0)) + 1 : 1;
    const gid = nextId;
    const wRef = arr[0].w;
    state.globalJoints.push({ id: gid, label: `N${gid}`, x: wRef.x, y: wRef.y, z: wRef.z });
    groupsCreated++;
    // 綁定該 bucket 內所有 joint
    for (const it of arr) {
      it.j.globalId = gid;
      jointsBound++;
    }
  }
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  // 適配桿件:joint global 化完後立即跑桿件 binding
  _setMsg(`適配關聯(精準度 ${md}):綁定 globalMember…`);
  await _tick();
  const memberStats = autoBindGlobalMembers();
  if (!skipConfirm) {
    alert(`適配關聯完成・精準度 ${md} 位數\n` +
      `清除既有:${existingGjs} globalJoint / ${existingGms} globalMember ・ 解綁 ${existingJointBindings} joint / ${existingMemberBindings} member\n` +
      `新建 globalJoint: ${groupsCreated}・綁定 joint: ${jointsBound}・掃描 ${totalScanned} 顆\n` +
      `新建 globalMember: ${memberStats.created}・綁定 member: ${memberStats.bound}・掃描 ${memberStats.scanned} 條`);
  }
  console.log(`[適配關聯(精準度)] md=${md}・清除 ${existingGjs} gj / ${existingGms} gm ・ bucket 候選 ${candidateBuckets}・新建 globalJoint ${groupsCreated}・綁定 ${jointsBound}・掃描 joint ${totalScanned}・新建 globalMember ${memberStats.created}・綁定 member ${memberStats.bound}・掃描 member ${memberStats.scanned}`);
  $("hud").textContent = `適配關聯(精準度 ${md})・節點 ${jointsBound} / 桿件 ${memberStats.bound}`;
  render && render();
  refreshLists && refreshLists();
  // 若 3D 預覽視窗開著,主動通知重建 —— menu 路徑也要讓 3D 即時反映新的 globalMember 合併結果
  //   (3D popup 自己的批次 handler 在 finally 也會呼叫 rebuildData,重複呼叫無害)
  try {
    if (typeof _3dPreviewWindow !== "undefined" && _3dPreviewWindow && _3dPreviewWindow.win
        && !_3dPreviewWindow.win.closed && typeof _3dPreviewWindow.rebuildData === "function") {
      _3dPreviewWindow.rebuildData();
    }
  } catch (_) {}
  return { groupsCreated, jointsBound, mergedToExisting: 0, totalScanned, memberCreated: memberStats.created, memberBound: memberStats.bound };
  } finally {
    if (_started && typeof hideBusy === "function") hideBusy();
  }
  })();
}

// 全局桿件:依「兩端 globalJoint id 對」自動建立 / 綁定 state.globalMembers
//   member.globalMemberId 指向 state.globalMembers[].id
//   只處理「兩端 joint 都有 globalId」的 member;沒綁的 member 維持本地 m.id
export function autoBindGlobalMembers() {
  if (!Array.isArray(state.globalMembers)) state.globalMembers = [];
  // 建索引:(gj_min, gj_max) → globalMember
  const idx = new Map();
  for (const gm of state.globalMembers) {
    const k = `${gm.gj1}|${gm.gj2}`;
    idx.set(k, gm);
  }
  let created = 0, bound = 0, scanned = 0;
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      const jmap = new Map((pg.joints || []).map(j => [j.id, j]));
      for (const m of (pg.members || [])) {
        scanned++;
        const j1 = jmap.get(m.j1), j2 = jmap.get(m.j2);
        if (!j1 || !j2) continue;
        if (j1.globalId == null || j2.globalId == null) continue;
        const a = Math.min(j1.globalId, j2.globalId);
        const b = Math.max(j1.globalId, j2.globalId);
        const k = `${a}|${b}`;
        let gm = idx.get(k);
        if (!gm) {
          const gid = allocGlobalMemberId();
          gm = { id: gid, label: "M" + gid, gj1: a, gj2: b };
          state.globalMembers.push(gm);
          idx.set(k, gm);
          created++;
        }
        if (m.globalMemberId !== gm.id) {
          m.globalMemberId = gm.id;
          bound++;
        }
      }
    }
  }
  return { created, bound, scanned };
}

// 清除「綁定點實際世界座標分歧過大」的 globalJoint(典型成因:適配關聯把多平行切面的不同物理位置 joint 誤綁同一 globalJoint)
//   opts.threshold:bbox 任一軸最大差距 > threshold 視為「壞綁定」(預設 100 mm)
//   opts.clearAll:true → 直接清掉所有 globalJoint 綁定(不論分歧大小)
//   opts.skipConfirm:跳過 confirm 對話框(批次操作用)
//   回傳 { gjsRemoved, bindingsUnbound, totalGjs, badGjs }
export function cleanupBadGlobalJoints(opts) {
  opts = opts || {};
  const threshold = opts.threshold != null ? opts.threshold : 100;
  const clearAll = !!opts.clearAll;
  const skipConfirm = !!opts.skipConfirm;
  // 收集每個 globalJoint 的所有 binding + 反推各 binding 的實際世界座標
  const gjBindings = new Map();
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) {
        if (j.globalId == null) continue;
        const w = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(f, pg, j) : null;
        if (!w) continue;
        let arr = gjBindings.get(j.globalId);
        if (!arr) { arr = []; gjBindings.set(j.globalId, arr); }
        arr.push({ file: f, page: pg, joint: j, world: w });
      }
    }
  }
  // 找出「壞」的:多個 binding 但世界座標分歧 > threshold,或 clearAll
  const bad = [];
  for (const [gid, bindings] of gjBindings) {
    if (clearAll) { bad.push({ gid, bindings, delta: null }); continue; }
    if (bindings.length < 2) continue;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const b of bindings) {
      if (b.world.x<minX)minX=b.world.x; if (b.world.x>maxX)maxX=b.world.x;
      if (b.world.y<minY)minY=b.world.y; if (b.world.y>maxY)maxY=b.world.y;
      if (b.world.z<minZ)minZ=b.world.z; if (b.world.z>maxZ)maxZ=b.world.z;
    }
    const maxDelta = Math.max(maxX-minX, maxY-minY, maxZ-minZ);
    if (maxDelta > threshold) bad.push({ gid, bindings, delta: maxDelta });
  }
  if (!bad.length) {
    if (!skipConfirm) {
      alert(clearAll ? "目前沒有任何 globalJoint 綁定可清除" : `沒有 globalJoint 的綁定點分歧超過 ${threshold} mm — 全部都是乾淨的`);
    }
    return { gjsRemoved: 0, bindingsUnbound: 0, totalGjs: gjBindings.size, badGjs: 0 };
  }
  let totalBindings = 0;
  for (const b of bad) totalBindings += b.bindings.length;
  if (!skipConfirm) {
    const extraGmMsg = clearAll
      ? `\n・globalMember 物件(全部)也會一併移除、所有 member.globalMemberId 會設為 null`
      : "";
    const msg = clearAll
      ? `將清除所有 globalJoint 綁定:\n・globalJoint 物件 ${gjBindings.size} 個會被移除\n・joint.globalId ${totalBindings} 個會被設為 null${extraGmMsg}\n\nCtrl+Z 可還原。\n要繼續嗎?`
      : `偵測到 ${bad.length} 個 globalJoint 的綁定點實際世界座標分歧超過 ${threshold} mm(總共 ${totalBindings} 個 joint binding 被誤綁):\n・這些 globalJoint 物件會被移除\n・對應 joint.globalId 會設為 null\n・其餘綁定正確的 globalJoint 不受影響\n\n清完後建議再跑「三視圖自動配對」重新建立正確綁定。\nCtrl+Z 可還原。\n要繼續嗎?`;
    if (!confirm(msg)) return { gjsRemoved: 0, bindingsUnbound: 0, totalGjs: gjBindings.size, badGjs: bad.length };
  }
  pushUndo();
  let unbound = 0;
  const removedGids = new Set();
  for (const b of bad) {
    for (const bd of b.bindings) {
      bd.joint.globalId = null;
      unbound++;
    }
    removedGids.add(b.gid);
  }
  if (Array.isArray(state.globalJoints)) {
    state.globalJoints = state.globalJoints.filter(g => !removedGids.has(g.id));
  }
  // clearAll 模式:一併清掉 globalMember(沒有它們 globalJoint 就是殭屍指標的上層),
  //   並解除所有 m.globalMemberId,重置 counter。非 clearAll 模式保留 globalMember(可能還有效)。
  let gmsRemoved = 0, memberBindingsCleared = 0;
  if (clearAll) {
    gmsRemoved = Array.isArray(state.globalMembers) ? state.globalMembers.length : 0;
    state.globalMembers = [];
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        for (const m of (pg.members || [])) {
          if (m.globalMemberId != null) { m.globalMemberId = null; memberBindingsCleared++; }
        }
      }
    }
    if (typeof nextGlobalMemberId !== "undefined") setNextGlobalMemberId(1);
  }
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  refreshFileList && refreshFileList();
  refreshLists && refreshLists();
  render && render();
  const msg = clearAll
    ? `已清除所有 global 綁定:移除 ${removedGids.size} globalJoint + ${gmsRemoved} globalMember,解除 ${unbound} joint + ${memberBindingsCleared} member binding`
    : `清除錯誤綁定:移除 ${removedGids.size} 個 globalJoint(分歧 > ${threshold} mm),解除 ${unbound} 個 joint binding;其餘正確綁定保留`;
  console.log(`[清理 globalJoint] ${msg}`);
  $("hud").textContent = msg + "。下一步建議:跑「三視圖自動配對」重建正確綁定";
  return { gjsRemoved: removedGids.size, bindingsUnbound: unbound, totalGjs: gjBindings.size, badGjs: bad.length, gmsRemoved, memberBindingsCleared };
}
$("btnConsolidate") && ($("btnConsolidate").onclick = () => withBusy("整理中…", consolidateGeometry));
$("btnExtendCheck") && ($("btnExtendCheck").onclick = () => startExtendableMemberCheckCurrentPage());

// 自動編「本頁數字」(填空式,保留既有設定):
//   1. 已有 groupNum 的頁面 → 一律保留,不動
//   2. 排序頁面:平面(XY → XZ → YZ → 未指派)→ |z| 升序(z 最接近 0 先排)→ 檔名倒序
//   3. 對每個「沒有 groupNum」的頁面,從 1 開始找「最小可用整數」(不在 takenNums 裡)分配
//   結果:每個平面內 z 最接近 0 的頁面會優先拿到較小數字(若它本來就沒 groupNum);
//   既有設定不會被覆蓋,全域不重複。
function autoAssignPageGroupNumbers(planeFilter) {
  const planeOrder = { XY: 0, XZ: 1, YZ: 2 };
  // 排序方式:select#autoPageGroupNumSort 為主("name" / "z");沒元件時預設 name
  const sortBy = ($("autoPageGroupNumSort") && $("autoPageGroupNumSort").value) || "name";
  // 全部頁:用來決定哪些 groupNum 已被佔用(避免跨平面重複)
  const allPages = [];
  const taken = new Set();
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      allPages.push({ file: f, pg, key: k });
      if (pg.groupNum != null && Number.isFinite(pg.groupNum)) taken.add(pg.groupNum);
    }
  }
  if (!allPages.length) { alert("沒有可編號的頁面"); return; }
  // 篩出符合 planeFilter 的「目標頁面」(planeFilter 為 null / 不傳 → 全部頁)
  const inScope = planeFilter
    ? allPages.filter(e => e.pg.plane === planeFilter)
    : allPages;
  if (!inScope.length) {
    alert(`目前沒有任何頁面是「${planeFilter}」平面`); return;
  }
  const missing = inScope.filter(e => e.pg.groupNum == null || !Number.isFinite(e.pg.groupNum));
  if (!missing.length) {
    $("hud").textContent = `${planeFilter || "所有"}平面的 ${inScope.length} 個頁面都已有本頁數字,沒東西要填`;
    return;
  }
  const sortLabel = sortBy === "name" ? "名稱升序" : "第三軸 |z| 升序";
  const planeLabel = planeFilter ? `${planeFilter} 平面` : "所有平面";
  if (!confirm(`將對 ${planeLabel}下 ${missing.length} 個沒有「本頁數字」的頁面自動填號(該平面已設定的 ${inScope.length - missing.length} 個保留不動)。\n排序方式:${sortLabel}。要繼續嗎?`)) return;
  pushUndo();
  const cmpName = (a, b) => String(a.file.name).localeCompare(String(b.file.name), undefined, { numeric: true, sensitivity: "base" });
  const sortPages = (arr) => {
    arr.sort((a, b) => {
      const pa = planeOrder[a.pg.plane] != null ? planeOrder[a.pg.plane] : 99;
      const pb = planeOrder[b.pg.plane] != null ? planeOrder[b.pg.plane] : 99;
      if (pa !== pb) return pa - pb;
      if (sortBy === "name") {
        const c = cmpName(a, b);
        if (c !== 0) return c;
        const aza = Math.abs(Number.isFinite(a.pg.z) ? a.pg.z : 0);
        const azb = Math.abs(Number.isFinite(b.pg.z) ? b.pg.z : 0);
        return aza - azb;
      }
      const za = Number.isFinite(a.pg.z) ? a.pg.z : 0;
      const zb = Number.isFinite(b.pg.z) ? b.pg.z : 0;
      const aza = Math.abs(za), azb = Math.abs(zb);
      if (aza !== azb) return aza - azb;
      if (za !== zb) return zb - za;
      return -cmpName(a, b);
    });
  };
  // 依平面分組(目前最多 1 個平面,因為 inScope 是 planeFilter 後的;但 planeFilter=null 時可能多平面)
  const byPlane = new Map();
  for (const ent of inScope) {
    const k = ent.pg.plane || "_none_";
    if (!byPlane.has(k)) byPlane.set(k, []);
    byPlane.get(k).push(ent);
  }
  // 該平面的「第一個數字」 = 該平面排序後第一頁的 groupNum;若它沒設定就分配最小可用整數,以它為起點
  const findSmallestUnused = () => {
    let c = 1;
    while (taken.has(c)) c++;
    return c;
  };
  const cap = state.globalCapacity || 10000;
  const overflowing = [];
  const summary = [];
  for (const [plane, pages] of byPlane) {
    sortPages(pages);
    // 確定該平面的起點
    let startNum = null;
    const first = pages[0];
    if (first.pg.groupNum != null && Number.isFinite(first.pg.groupNum)) {
      startNum = first.pg.groupNum;
    } else {
      const v = findSmallestUnused();
      first.pg.groupNum = v;
      taken.add(v);
      startNum = v;
      if (v > cap) overflowing.push({ name: first.file.name, plane: first.pg.plane, z: first.pg.z, n: v });
      summary.push({ name: first.file.name, plane: first.pg.plane || "—", z: first.pg.z != null ? first.pg.z : "—", newNum: v, anchor: true });
    }
    // 之後的頁面:cursor 從 startNum+1 開始往上跳;遇到既存 groupNum 就更新 cursor;
    //   missing 的頁面就找 cursor 起始的下一個未被佔用整數(嚴格往上,不會回頭撿小數字)
    let cursor = startNum + 1;
    for (let i = 1; i < pages.length; i++) {
      const ent = pages[i];
      if (ent.pg.groupNum != null && Number.isFinite(ent.pg.groupNum)) {
        if (ent.pg.groupNum >= cursor) cursor = ent.pg.groupNum + 1;
        continue;
      }
      while (taken.has(cursor)) cursor++;
      const v = cursor;
      ent.pg.groupNum = v;
      taken.add(v);
      cursor++;
      if (v > cap) overflowing.push({ name: ent.file.name, plane: ent.pg.plane, z: ent.pg.z, n: v });
      summary.push({ name: ent.file.name, plane: ent.pg.plane || "—", z: ent.pg.z != null ? ent.pg.z : "—", newNum: v });
    }
  }
  console.log(`[一鍵自動編 本頁數字] ${planeLabel}・排序=${sortLabel}・填 ${missing.length} 個(該平面保留 ${inScope.length - missing.length} 個既有,全域共 ${allPages.length} 頁):`, summary);
  if (overflowing.length) {
    console.warn(`[一鍵自動編 本頁數字] 有 ${overflowing.length} 筆超出可容納數字 ${cap}:`, overflowing);
  }
  refreshPageCoordSection();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render(); refreshLists();
  $("hud").textContent = `已填 ${missing.length} 個頁面的本頁數字(${planeLabel}・保留 ${inScope.length - missing.length} 個・${sortLabel})${overflowing.length ? `・⚠ ${overflowing.length} 筆超 cap` : ""}`;
}
// 兩顆「一鍵自動編 本頁數字」按鈕都只針對「當前 active 頁面所屬的平面」處理 —
//   想處理別的平面用編輯選單那三個 entry。沒設平面的當前頁就走「全部頁」。
function _autoAssignFromActivePage() {
  const p = (typeof getPage === "function") ? getPage() : null;
  const plane = p && p.plane;
  autoAssignPageGroupNumbers(plane || null);
}

// (舊版)合併重疊桿件邏輯 — 已被「整理」(_consolidateInPlace,btnConsolidate / 整理所有頁面)取代,
//   保留此函式以利之後若要做更寬容差版本時可重用;目前 UI 不暴露入口。
//   差異:_consolidateInPlace 用 0.5 容差(嚴),這版本 angTol=1e-2 / offsetTol=5(寬)。
function dedupOverlapOnPage(page, opts) {
  if (!page || !Array.isArray(page.members) || !page.members.length) {
    return { groups: 0, removed: 0, added: 0 };
  }
  const joints = page.joints || [];
  const jointById = new Map(joints.map(j => [j.id, j]));
  // 容差(opts 可覆寫 — 例如未來想做嚴 / 寬模式)
  const angTol     = (opts && opts.angTol     != null) ? opts.angTol     : 1e-2;   // ≈ 0.57°(寬一點容忍 DXF 微偏軸)
  const offsetTol  = (opts && opts.offsetTol  != null) ? opts.offsetTol  : 5.0;    // 5 單位(mm)
  const overlapTol = (opts && opts.overlapTol != null) ? opts.overlapTol : 5.0;    // 同上
  const debug = !!(opts && opts.debug);
  const lineMap = new Map();
  const memberRecords = [];
  for (const m of page.members) {
    const j1 = jointById.get(m.j1);
    const j2 = jointById.get(m.j2);
    if (!j1 || !j2) continue;
    const dx = j2.x - j1.x, dy = j2.y - j1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    let nx = dx / len, ny = dy / len;
    if (nx < -1e-12 || (Math.abs(nx) < 1e-12 && ny < 0)) { nx = -nx; ny = -ny; }
    const ang = Math.atan2(ny, nx);
    const offset = -ny * j1.x + nx * j1.y;
    const angRound = Math.round(ang / angTol);
    const offRound = Math.round(offset / offsetTol);
    const key = `${angRound}|${offRound}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    const rec = { m, j1, j2, ang, offset };
    lineMap.get(key).push(rec);
    memberRecords.push(rec);
  }
  if (debug) {
    console.log(`[dedupOverlap] page members=${page.members.length}・lineGroups=${lineMap.size}・容差: ang=${angTol} offset=${offsetTol} overlap=${overlapTol}`);
    let multi = 0;
    for (const [k, g] of lineMap) if (g.length >= 2) multi++;
    console.log(`[dedupOverlap]   有 ${multi} 個共線群組(≥2 條)`);
  }
  let groupsConsolidated = 0, removed = 0, added = 0;
  const removeIds = new Set();
  const newMembers = [];
  for (const [key, group] of lineMap) {
    if (group.length < 2) continue;     // 單一桿件,不會跟自己重疊
    // 用 group 第一條的 (j1, direction) 當參考軸
    const head = group[0];
    const dxH = head.j2.x - head.j1.x, dyH = head.j2.y - head.j1.y;
    const lenH = Math.hypot(dxH, dyH);
    const nxR = dxH / lenH, nyR = dyH / lenH;
    const ax = head.j1.x, ay = head.j1.y;
    const projT = (j) => (j.x - ax) * nxR + (j.y - ay) * nyR;
    const ranges = group.map(r => {
      const t1 = projT(r.j1);
      const t2 = projT(r.j2);
      return { ...r, t1, t2, lo: Math.min(t1, t2), hi: Math.max(t1, t2) };
    });
    ranges.sort((a, b) => a.lo - b.lo);
    // 合併 overlap unions
    const unions = [];
    let cur = null;
    for (const r of ranges) {
      if (!cur || r.lo > cur.hi + overlapTol) {
        if (cur) unions.push(cur);
        cur = { lo: r.lo, hi: r.hi, members: [r] };
      } else {
        cur.hi = Math.max(cur.hi, r.hi);
        cur.members.push(r);
      }
    }
    if (cur) unions.push(cur);
    for (const u of unions) {
      // 預先判斷:union 只有 1 條桿件,且線上沒有任何中段節點落在它的範圍 → 沒事可做,跳過
      //   (避免單純的 1 桿件 union 也走 remove + re-add 的 ID 重編)
      if (u.members.length < 2) {
        const r0 = u.members[0];
        const tLo = r0.lo, tHi = r0.hi;
        let hasExtra = false;
        for (const j of joints) {
          if (j.id === r0.j1.id || j.id === r0.j2.id) continue;
          const px = j.x - ax, py = j.y - ay;
          if (Math.abs(-nyR * px + nxR * py) > offsetTol) continue;
          const t = px * nxR + py * nyR;
          if (t < tLo + overlapTol || t > tHi - overlapTol) continue;     // 嚴格落在範圍內
          hasExtra = true; break;
        }
        if (!hasExtra) continue;
      }
      if (debug) {
        console.log(`[dedupOverlap]   union [${u.lo.toFixed(1)}, ${u.hi.toFixed(1)}] 含 ${u.members.length} 條桿件:`,
          u.members.map(r => `#${r.m.id}: j${r.m.j1}(${r.j1.x.toFixed(0)},${r.j1.y.toFixed(0)})-j${r.m.j2}(${r.j2.x.toFixed(0)},${r.j2.y.toFixed(0)}) t[${r.lo.toFixed(1)},${r.hi.toFixed(1)}]`));
      }
      // 1) 先收原桿件的端點;2) 再把「在這條線上、t 落在 union 範圍內」的所有 joints 也納入
      //    → 7 個共線節點即使中間節點不是任一桿件的端點,也會被當成斷點 → 結果一定切成 N-1 段
      //    去重:同 id 或同位置(t 在 overlapTol 內)視為同一個點
      const ptByT = [];
      const ptById = new Map();
      const _posMatch = (t1, t2) => Math.abs(t1 - t2) <= overlapTol;
      const tryAdd = (ent) => {
        if (ptById.has(ent.j.id)) return false;
        for (const p of ptByT) if (_posMatch(p.t, ent.t)) return false;
        ptById.set(ent.j.id, ent);
        ptByT.push(ent);
        return true;
      };
      for (const r of u.members) {
        tryAdd({ j: r.j1, t: r.t1 });
        tryAdd({ j: r.j2, t: r.t2 });
      }
      // 掃整頁的 joints,把「垂直距離 < offsetTol 且 t 落在 union 範圍內」的也加入
      //   normal vector = (-nyR, nxR);垂直距離 = |(-nyR)*(jx-ax) + nxR*(jy-ay)|
      let extraJoints = 0;
      for (const j of joints) {
        if (ptById.has(j.id)) continue;
        const px = j.x - ax, py = j.y - ay;
        const perp = Math.abs(-nyR * px + nxR * py);
        if (perp > offsetTol) continue;
        const t = px * nxR + py * nyR;
        if (t < u.lo - overlapTol || t > u.hi + overlapTol) continue;
        if (tryAdd({ j, t })) extraJoints++;
      }
      ptByT.sort((a, b) => a.t - b.t);
      if (debug) {
        console.log(`[dedupOverlap]     端點(${ptByT.length} 個・其中 ${extraJoints} 個是線上中段節點):`,
          ptByT.map(p => `j${p.j.id}@t=${p.t.toFixed(1)}(${p.j.x.toFixed(0)},${p.j.y.toFixed(0)})`));
      }
      // 移除原桿件
      for (const r of u.members) removeIds.add(r.m.id);
      // 新建相鄰 joint 連成的鏈狀桿件
      const expectedPairs = [];
      for (let i = 0; i < ptByT.length - 1; i++) {
        const a = ptByT[i].j, b = ptByT[i + 1].j;
        if (a.id === b.id) continue;
        // 同位置的 joint 偶爾會重複(不太可能,但保險)
        if (Math.abs(ptByT[i].t - ptByT[i + 1].t) < overlapTol) continue;
        expectedPairs.push([a.id, b.id]);
      }
      for (const [j1id, j2id] of expectedPairs) {
        newMembers.push({ id: allocMemberId(), j1: j1id, j2: j2id });
        added++;
      }
      removed += u.members.length;
      groupsConsolidated++;
    }
  }
  if (removeIds.size || newMembers.length) {
    page.members = page.members.filter(m => !removeIds.has(m.id));
    page.members.push(...newMembers);
  }
  if (debug) {
    console.log(`[dedupOverlap] 結束・groups=${groupsConsolidated} removed=${removed} added=${added}`);
    if (groupsConsolidated === 0) {
      console.log(`[dedupOverlap] (沒有發現任何重疊;若你預期應該有,請貼上方 log 看共線群組是否分到不同 key)`);
    }
  }
  return { groups: groupsConsolidated, removed, added };
}
function dedupOverlapAllPages() {
  const stats = [];
  let totalGroups = 0, totalRemoved = 0, totalAdded = 0, totalPagesTouched = 0;
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      const before = pg.members ? pg.members.length : 0;
      const r = dedupOverlapOnPage(pg);
      if (!r.groups) continue;
      totalGroups += r.groups;
      totalRemoved += r.removed;
      totalAdded += r.added;
      totalPagesTouched++;
      stats.push({
        file: f.name, page: k,
        beforeCount: before, afterCount: pg.members ? pg.members.length : 0,
        groups: r.groups, removed: r.removed, added: r.added,
        net: r.added - r.removed,
      });
    }
  }
  return { stats, totalGroups, totalRemoved, totalAdded, totalPagesTouched };
}
// 依關聯映射節點 — 對每個檔每條 primary section link:
//   - 若 targetFileIds 多於 1 個 → 通知並跳過(避免歧義)
//   - 否則找源頁上所有「落在這條切線(2D 線段內 + 3D cut 平面內)」的節點,投影到唯一 target 頁建節點
//   投影:joint2DToWorld3D → 把 depth 軸換成 target 頁的 z → world3DToJoint2D
//   去重:target 頁已有同位置(< dedupRadius)的節點就不重複建
//   不會動桿件 — 只建節點
function mapJointsViaSectionLinks() {
  if (!state.files.length) { alert("沒有可處理的檔案"); return; }
  const tol3D = 1.0;
  const tol2D = 5.0;
  const dedupRadius = 0.5;
  // 先 dry-scan 統計可處理 / 跳過的條數
  const allPrimaries = [];
  for (const F of state.files) {
    if (!_fileHasFullSetup(F)) continue;
    const sls = F.sectionLinks || [];
    for (const e of sls) {
      if (e.autoProp) continue;
      allPrimaries.push({ file: F, entry: e });
    }
  }
  if (!allPrimaries.length) {
    alert("目前沒有任何主關聯切面"); return;
  }
  const skipMulti = allPrimaries.filter(p => (p.entry.targetFileIds || []).length > 1);
  const skipNone  = allPrimaries.filter(p => (p.entry.targetFileIds || []).length === 0);
  const ok        = allPrimaries.filter(p => (p.entry.targetFileIds || []).length === 1);
  if (!confirm(
    `依關聯映射節點:\n` +
    `・主關聯總數:${allPrimaries.length}\n` +
    `・會處理(target=1):${ok.length}\n` +
    `・會跳過(target>1):${skipMulti.length}\n` +
    `・會跳過(target=0):${skipNone.length}\n` +
    `會把每條可處理主關聯的源頁節點投影到 target 頁建節點。\nCtrl+Z 可還原。要繼續嗎?`
  )) return;
  pushUndo();
  const stats = { processedLinks: 0, jointsAdded: 0, skipped: [] };
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };
  for (const p of skipMulti) stats.skipped.push({ host: p.file.name, entryId: p.entry.id, reason: `target 數 ${p.entry.targetFileIds.length} > 1` });
  for (const p of skipNone)  stats.skipped.push({ host: p.file.name, entryId: p.entry.id, reason: "無 target" });
  for (const { file: F, entry: e } of ok) {
    const Fpage = F.pages && F.pages[0];
    if (!Fpage || !e.p1 || !e.p2) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: "源頁設定不齊或切線端點缺" });
      continue;
    }
    if (!e.cutAxis || !Number.isFinite(e.cutValue)) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: "切線非軸向化" });
      continue;
    }
    const tid = e.targetFileIds[0];
    const T = state.files.find(x => x.id === tid);
    if (!T || !_fileHasFullSetup(T)) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: `target 不存在或設定不齊(id=${tid})` });
      continue;
    }
    const Tpage = T.pages && T.pages[0];
    if (!Tpage || !Tpage.plane) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: "target 頁未設平面" });
      continue;
    }
    const Tdepth = _planeAxisInfo(Tpage.plane).depth.toLowerCase();
    const tz = (Tpage.z != null && Number.isFinite(Tpage.z)) ? Tpage.z : 0;
    const cutAxLower = e.cutAxis.toLowerCase();
    let countAdded = 0, countConsidered = 0;
    // 段距函式(2D)
    const segDist2D = (px, py) => {
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) return Math.hypot(px - e.p1.x, py - e.p1.y);
      const t = Math.max(0, Math.min(1, ((px - e.p1.x) * dx + (py - e.p1.y) * dy) / len2));
      return Math.hypot(px - (e.p1.x + t * dx), py - (e.p1.y + t * dy));
    };
    for (const j of (Fpage.joints || [])) {
      const W = joint2DToWorld3D(F, Fpage, j);
      if (!W) continue;
      // 3D 切面平面檢查:joint 在 cutAxis = cutValue 平面上
      if (Math.abs(W[cutAxLower] - e.cutValue) > tol3D) continue;
      // 2D 線段檢查:確保 joint 確實落在切線段上(避免共面但離線段太遠)
      if (segDist2D(j.x, j.y) > tol2D) continue;
      countConsidered++;
      // 投影到 target:把 depth 軸換成 target.z
      const Wp = { x: W.x, y: W.y, z: W.z };
      Wp[Tdepth] = tz;
      const t2d = world3DToJoint2D(T, Tpage, Wp);
      if (!t2d || !t2d.ok) continue;
      // dedup
      let exists = null;
      for (const tj of (Tpage.joints || [])) {
        if (Math.hypot(tj.x - t2d.x, tj.y - t2d.y) < dedupRadius) { exists = tj; break; }
      }
      if (exists) {
        // 既有節點剛好在投影點 → 不新建,但仍嘗試把 src + 既有節點綁同一 globalId
        _autoBindGlobalForMappedJoint(j, exists, W, _bindOpts);
        continue;
      }
      if (!Array.isArray(Tpage.joints)) Tpage.joints = [];
      const newJoint = { id: allocJointId(), x: t2d.x, y: t2d.y };
      Tpage.joints.push(newJoint);
      _autoBindGlobalForMappedJoint(j, newJoint, W, _bindOpts);
      countAdded++;
    }
    stats.processedLinks++;
    stats.jointsAdded += countAdded;
    console.log(`[依關聯映射節點] ${F.name} #${e.id} → ${T.name}・候選 ${countConsidered} 個・新建 ${countAdded} 個`);
  }
  // 批次 infer 被動到的 globalJoints(避免每次綁定都 O(total joints))
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  console.log(`[依關聯映射節點] 完成・處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點・gids ${_touchedGids.size}・跳過 ${stats.skipped.length}`, stats.skipped);
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render && render();
  refreshLists && refreshLists();
  if (stats.skipped.length) {
    const top = stats.skipped.slice(0, 6).map(s => `「${s.host}」#${s.entryId}: ${s.reason}`).join("\n");
    alert(`映射完成。\n處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點。\n跳過 ${stats.skipped.length} 條(前 6 條):\n${top}`);
  } else {
    $("hud").textContent = `映射完成・處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點`;
  }
}

// 把映射 / 推斷動作裡的 source / target joint 綁同一個 globalJoint。
//   優先使用既有 gid;沒人有就新建。
//   opts.skipInfer = true → 不馬上跑 inferGlobalJoint(bulk 用,結束後統一 infer);
//   opts.touched = Set<gid> → 把被動到的 gid 收集起來(配合 skipInfer 後續批次 infer)
function _autoBindGlobalForMappedJoint(srcJoint, tgtJoint, world, opts) {
  if (!srcJoint || !tgtJoint || !world) return null;
  const skipInfer = !!(opts && opts.skipInfer);
  const touched = opts && opts.touched;
  let gid = null;
  if (srcJoint.globalId != null) gid = srcJoint.globalId;
  else if (tgtJoint.globalId != null) gid = tgtJoint.globalId;
  if (gid == null) {
    const g = createGlobalJoint();
    g.x = _snapCoordToPrecision(world.x);
    g.y = _snapCoordToPrecision(world.y);
    g.z = _snapCoordToPrecision(world.z);
    gid = g.id;
  }
  if (srcJoint.globalId == null) srcJoint.globalId = gid;
  if (tgtJoint.globalId == null) tgtJoint.globalId = gid;
  if (touched) touched.add(gid);
  if (!skipInfer) {
    const g2 = (typeof findGlobalJointById === "function") ? findGlobalJointById(gid) : null;
    if (g2 && typeof inferGlobalJoint === "function") inferGlobalJoint(g2);
  }
  return gid;
}

// 依關聯映射節點(本頁版)— 限制掃描範圍只到當前 active 檔的 sectionLinks
function mapJointsViaSectionLinksOnCurrentFile() {
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  if (!af) { alert("尚未選擇檔案"); return; }
  const tol3D = 1.0, tol2D = 5.0, dedupRadius = 0.5;
  const primaries = (af.sectionLinks || []).filter(e => !e.autoProp);
  if (!primaries.length) { alert(`「${af.name}」本頁沒有主關聯切面`); return; }
  const skipMulti = primaries.filter(e => (e.targetFileIds || []).length > 1);
  const skipNone  = primaries.filter(e => (e.targetFileIds || []).length === 0);
  const ok        = primaries.filter(e => (e.targetFileIds || []).length === 1);
  if (!confirm(
    `依關聯映射節點(本頁・${af.name}):\n` +
    `・主關聯總數:${primaries.length}\n` +
    `・會處理(target=1):${ok.length}\n` +
    `・會跳過(target>1):${skipMulti.length}\n` +
    `・會跳過(target=0):${skipNone.length}\n` +
    `Ctrl+Z 可還原。要繼續嗎?`
  )) return;
  pushUndo();
  const stats = { processedLinks: 0, jointsAdded: 0, skipped: [] };
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };
  for (const e of skipMulti) stats.skipped.push({ host: af.name, entryId: e.id, reason: `target 數 ${e.targetFileIds.length} > 1` });
  for (const e of skipNone)  stats.skipped.push({ host: af.name, entryId: e.id, reason: "無 target" });
  const Fpage = af.pages && af.pages[0];
  if (!Fpage || !_fileHasFullSetup(af)) {
    alert("本檔設定不齊(平面 / 比例尺 / 原點)"); return;
  }
  for (const e of ok) {
    if (!e.p1 || !e.p2 || !e.cutAxis || !Number.isFinite(e.cutValue)) {
      stats.skipped.push({ host: af.name, entryId: e.id, reason: "切線非軸向化或端點缺" });
      continue;
    }
    const tid = e.targetFileIds[0];
    const T = state.files.find(x => x.id === tid);
    if (!T || !_fileHasFullSetup(T)) {
      stats.skipped.push({ host: af.name, entryId: e.id, reason: `target 不存在或設定不齊(id=${tid})` });
      continue;
    }
    const Tpage = T.pages && T.pages[0];
    if (!Tpage || !Tpage.plane) {
      stats.skipped.push({ host: af.name, entryId: e.id, reason: "target 頁未設平面" });
      continue;
    }
    const Tdepth = _planeAxisInfo(Tpage.plane).depth.toLowerCase();
    const tz = (Tpage.z != null && Number.isFinite(Tpage.z)) ? Tpage.z : 0;
    const cutAxLower = e.cutAxis.toLowerCase();
    let countAdded = 0, countConsidered = 0;
    const segDist2D = (px, py) => {
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) return Math.hypot(px - e.p1.x, py - e.p1.y);
      const t = Math.max(0, Math.min(1, ((px - e.p1.x) * dx + (py - e.p1.y) * dy) / len2));
      return Math.hypot(px - (e.p1.x + t * dx), py - (e.p1.y + t * dy));
    };
    for (const j of (Fpage.joints || [])) {
      const W = joint2DToWorld3D(af, Fpage, j);
      if (!W) continue;
      if (Math.abs(W[cutAxLower] - e.cutValue) > tol3D) continue;
      if (segDist2D(j.x, j.y) > tol2D) continue;
      countConsidered++;
      const Wp = { x: W.x, y: W.y, z: W.z };
      Wp[Tdepth] = tz;
      const t2d = world3DToJoint2D(T, Tpage, Wp);
      if (!t2d || !t2d.ok) continue;
      let exists = null;
      for (const tj of (Tpage.joints || [])) {
        if (Math.hypot(tj.x - t2d.x, tj.y - t2d.y) < dedupRadius) { exists = tj; break; }
      }
      if (exists) {
        // 既有節點剛好在投影點 → 不新建,但仍嘗試把 src + 既有節點綁同一 globalId
        _autoBindGlobalForMappedJoint(j, exists, W, _bindOpts);
        continue;
      }
      if (!Array.isArray(Tpage.joints)) Tpage.joints = [];
      const newJoint = { id: allocJointId(), x: t2d.x, y: t2d.y };
      Tpage.joints.push(newJoint);
      _autoBindGlobalForMappedJoint(j, newJoint, W, _bindOpts);
      countAdded++;
    }
    stats.processedLinks++;
    stats.jointsAdded += countAdded;
    console.log(`[依關聯映射節點(本頁)] ${af.name} #${e.id} → ${T.name}・候選 ${countConsidered} 個・新建 ${countAdded} 個`);
  }
  // 批次 infer 被動到的 globalJoints
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  console.log(`[依關聯映射節點(本頁)] 完成・處理 ${stats.processedLinks}・新增 ${stats.jointsAdded}・gids ${_touchedGids.size}・跳過 ${stats.skipped.length}`, stats.skipped);
  refreshFileList && refreshFileList();
  refreshLists && refreshLists();
  render && render();
  if (stats.skipped.length) {
    const top = stats.skipped.slice(0, 6).map(s => `「${s.host}」#${s.entryId}: ${s.reason}`).join("\n");
    alert(`映射完成(本頁)。\n處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點。\n跳過 ${stats.skipped.length} 條(前 6 條):\n${top}`);
  } else {
    $("hud").textContent = `映射完成(本頁)・處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點`;
  }
}

// 跳出一個多選列表對話框,右側帶 preview(reuse renderFileThumb)
//   - row click 切換選取;雙擊 = 只選該列並確定
//   - hover 或 click 任一列 → 右側 preview 切到該檔案
//   - candidate 需提供 .file(用於 renderFileThumb);.label / .right 顯示文字
//   回傳 Promise<Array<candidate>|null>(取消回 null)
function _pickTargetPageDialog(opts) {
  return new Promise((resolve) => {
    const { title, header, candidates } = opts;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
    const card = document.createElement("div");
    card.style.cssText = "background:#1c1d20;border:1px solid #555;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.6);padding:14px;width:min(900px, 90vw);max-height:85vh;display:flex;flex-direction:column;";
    const t = document.createElement("div");
    t.style.cssText = "font-weight:700;font-size:13px;color:#9bb6e8;margin-bottom:6px;";
    t.textContent = title || "選擇目標";
    card.appendChild(t);
    if (header) {
      const h = document.createElement("div");
      h.style.cssText = "font-size:11px;color:#9aa0a6;margin-bottom:8px;white-space:pre-line;";
      h.textContent = header;
      card.appendChild(h);
    }
    // 全選 / 全不選 + 計數
    const topBar = document.createElement("div");
    topBar.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;font-size:11px;color:#9aa0a6;";
    const selCount = document.createElement("span");
    const _btnStyle = "padding:2px 8px;font-size:11px;background:#2a2c30;color:#ddd;border:1px solid #444;border-radius:3px;cursor:pointer;";
    const selAllBtn = document.createElement("button");
    selAllBtn.textContent = "全選";
    selAllBtn.style.cssText = _btnStyle;
    const selNoneBtn = document.createElement("button");
    selNoneBtn.textContent = "全不選";
    selNoneBtn.style.cssText = _btnStyle;
    const btnGroup = document.createElement("div");
    btnGroup.style.cssText = "display:flex;gap:6px;";
    btnGroup.appendChild(selAllBtn);
    btnGroup.appendChild(selNoneBtn);
    topBar.appendChild(selCount);
    topBar.appendChild(btnGroup);
    card.appendChild(topBar);
    // body:左側列表 + 右側 preview
    const body = document.createElement("div");
    body.style.cssText = "display:flex;gap:10px;flex:1;min-height:360px;overflow:hidden;";
    // 左側列表
    const listEl = document.createElement("div");
    listEl.style.cssText = "flex:0 0 320px;overflow-y:auto;border:1px solid #333;border-radius:4px;background:#15161a;";
    // 右側 preview
    const previewWrap = document.createElement("div");
    previewWrap.style.cssText = "flex:1;display:flex;flex-direction:column;border:1px solid #333;border-radius:4px;background:#0d0e10;min-width:300px;";
    const previewHeader = document.createElement("div");
    previewHeader.style.cssText = "padding:6px 10px;font-size:11px;color:#9aa0a6;border-bottom:1px solid #333;flex:0 0 auto;";
    previewHeader.textContent = "預覽(hover 任一列即顯示)";
    previewWrap.appendChild(previewHeader);
    const previewStage = document.createElement("div");
    previewStage.style.cssText = "flex:1;display:flex;align-items:center;justify-content:center;padding:8px;position:relative;";
    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = 540; previewCanvas.height = 380;
    previewCanvas.style.cssText = "max-width:100%;max-height:100%;background:#0d0e10;display:block;";
    previewStage.appendChild(previewCanvas);
    previewWrap.appendChild(previewStage);
    body.appendChild(listEl);
    body.appendChild(previewWrap);
    card.appendChild(body);
    const rows = [];
    const selected = new Set();
    let previewFid = null;
    const updateCount = () => {
      selCount.textContent = `已選 ${selected.size} / ${candidates.length}`;
    };
    const setRowVisual = (row, on) => {
      if (on) {
        row.style.background = "rgba(79,157,255,0.18)";
        row.style.outline = "1px solid #4f9dff";
        row.style.outlineOffset = "-1px";
      } else {
        row.style.background = "transparent";
        row.style.outline = "none";
      }
      const cb = row.querySelector(".sl-cb");
      if (cb) cb.textContent = on ? "☑" : "☐";
    };
    const updatePreview = (c) => {
      if (!c || !c.file) return;
      previewFid = c.file.id;
      const pg = c.file.pages && c.file.pages[0];
      const planeTxt = pg && pg.plane ? pg.plane : "—";
      const zTxt = pg && pg.z != null ? `${_planeAxisInfo(planeTxt).depth}=${pg.z}` : "";
      previewHeader.textContent = `${c.file.name}・${planeTxt}${zTxt ? "・" + zTxt : ""}`;
      // 用既有的 renderFileThumb;它會自動處理 clipRect / svg viewBox
      if (typeof renderFileThumb === "function") {
        renderFileThumb(previewCanvas, c.file).catch(err => console.warn("[picker preview]", err));
      }
    };
    candidates.forEach((c, i) => {
      const row = document.createElement("div");
      row.style.cssText = "padding:8px 12px;border-bottom:1px solid #2a2c30;cursor:pointer;font-size:12px;color:#ddd;display:flex;align-items:center;gap:8px;";
      row.onmouseenter = () => {
        if (!selected.has(i)) row.style.background = "#24262b";
        updatePreview(c);
      };
      row.onmouseleave = () => { if (!selected.has(i)) row.style.background = "transparent"; };
      const cb = document.createElement("span");
      cb.className = "sl-cb";
      cb.style.cssText = "font-size:14px;color:#9bb6e8;flex-shrink:0;";
      cb.textContent = "☐";
      row.appendChild(cb);
      const left = document.createElement("span");
      left.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      left.textContent = c.label;
      row.appendChild(left);
      if (c.right) {
        const right = document.createElement("span");
        right.style.cssText = "color:#9aa0a6;font-size:10px;flex-shrink:0;";
        right.textContent = c.right;
        row.appendChild(right);
      }
      row.onclick = (e) => {
        e.stopPropagation();
        if (selected.has(i)) selected.delete(i);
        else selected.add(i);
        setRowVisual(row, selected.has(i));
        updateCount();
        updatePreview(c);
      };
      row.ondblclick = (e) => {
        e.stopPropagation();
        selected.clear(); selected.add(i);
        rows.forEach((r, ri) => setRowVisual(r, ri === i));
        updateCount();
        finish(true);
      };
      listEl.appendChild(row);
      rows.push(row);
    });
    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "margin-top:12px;display:flex;justify-content:flex-end;gap:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 14px;font-size:12px;background:#2a2c30;color:#ddd;border:1px solid #444;border-radius:3px;cursor:pointer;";
    const okBtn = document.createElement("button");
    okBtn.textContent = "確定";
    okBtn.className = "primary";
    okBtn.style.cssText = "padding:6px 14px;font-size:12px;background:#2f4a78;color:#fff;border:1px solid #4a78c8;border-radius:3px;cursor:pointer;";
    footer.appendChild(cancelBtn); footer.appendChild(okBtn);
    card.appendChild(footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    selAllBtn.onclick = () => {
      candidates.forEach((_, i) => selected.add(i));
      rows.forEach(r => setRowVisual(r, true));
      updateCount();
    };
    selNoneBtn.onclick = () => {
      selected.clear();
      rows.forEach(r => setRowVisual(r, false));
      updateCount();
    };
    function finish(ok) {
      const picks = ok ? Array.from(selected).sort((a, b) => a - b).map(i => candidates[i]) : [];
      cleanup();
      resolve(ok && picks.length ? picks : null);
    }
    function cleanup() {
      document.removeEventListener("keydown", onKey, true);
      try { overlay.remove(); } catch (_) {}
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
      else if (e.key === "Enter" && selected.size > 0) { e.preventDefault(); e.stopImmediatePropagation(); finish(true); }
    }
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(false); });
    document.addEventListener("keydown", onKey, true);
    updateCount();
  });
}

// 把當前頁(active 檔的第一頁)的節點 + 桿件複製到指定的同平面頁面
export async function copyPageJointsMembersToSamePlanePage() {
  const sf = (typeof getActiveFile === "function") ? getActiveFile() : null;
  const sp = (typeof getPage === "function") ? getPage() : null;
  if (!sf || !sp) { alert("尚未選擇檔案 / 頁面"); return; }
  if (!sp.plane) { alert("本頁未設平面"); return; }
  if (!_fileHasFullSetup(sf)) { alert(`「${sf.name}」設定不齊(平面 / 比例尺 / 原點)`); return; }
  if (!Array.isArray(sp.joints) || !sp.joints.length) { alert("本頁沒有節點可複製"); return; }
  const candidates = [];
  for (const f of state.files) {
    if (f.id === sf.id) continue;
    if (!_fileHasFullSetup(f)) continue;
    const pg = f.pages && f.pages[0];
    if (!pg || pg.plane !== sp.plane) continue;
    candidates.push({ file: f, page: pg });
  }
  if (!candidates.length) {
    alert(`沒有其他 ${sp.plane} 平面、設定齊全的檔案可作為目標`);
    return;
  }
  const depthAxisName = _planeAxisInfo(sp.plane).depth;
  // 用 list dialog 選 target
  const items = candidates.map(c => ({
    label: c.file.name,
    right: `${c.page.plane}・${depthAxisName}=${c.page.z != null ? c.page.z : "—"}`,
    file: c.file, page: c.page,
  }));
  const picks = await _pickTargetPageDialog({
    title: "複製本頁節點+桿件到同平面頁(可多選)",
    header: `從「${sf.name}」(${sp.plane}・${depthAxisName}=${sp.z != null ? sp.z : "—"})複製 ${sp.joints.length} 個節點、${(sp.members || []).length} 條桿件\n勾選一個或多個目標頁(雙擊單列 = 只選該列並確定;Enter 確定;Esc 取消):`,
    candidates: items,
  });
  if (!picks || !picks.length) return;
  showBusy(`複製到 ${picks.length} 個目標頁…`);
  await busyTick();
  pushUndo();
  const dedupRadius = 0.5;
  let totalJ = 0, totalJReused = 0, totalM = 0;
  const perTarget = [];
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };
  for (const picked of picks) {
    const T = picked.file;
    const Tp = picked.page;
    const tDepth = _planeAxisInfo(Tp.plane).depth.toLowerCase();
    const tz = (Tp.z != null && Number.isFinite(Tp.z)) ? Tp.z : 0;
    const idMap = new Map();
    let countJ = 0, countM = 0, countJReused = 0;
    for (const j of sp.joints) {
      const W = joint2DToWorld3D(sf, sp, j);
      if (!W) continue;
      const Wp = { x: W.x, y: W.y, z: W.z };
      Wp[tDepth] = tz;
      const t2d = world3DToJoint2D(T, Tp, Wp);
      if (!t2d || !t2d.ok) continue;
      let existing = null;
      for (const tj of (Tp.joints || [])) {
        if (Math.hypot(tj.x - t2d.x, tj.y - t2d.y) < dedupRadius) { existing = tj; break; }
      }
      let target;
      if (existing) {
        target = existing;
        countJReused++;
      } else {
        target = { id: allocJointId(), x: t2d.x, y: t2d.y };
        if (!Array.isArray(Tp.joints)) Tp.joints = [];
        Tp.joints.push(target);
        countJ++;
      }
      idMap.set(j.id, target.id);
      if (typeof _autoBindGlobalForMappedJoint === "function") {
        _autoBindGlobalForMappedJoint(j, target, W, _bindOpts);
      }
    }
    for (const m of (sp.members || [])) {
      const t1 = idMap.get(m.j1);
      const t2 = idMap.get(m.j2);
      if (t1 == null || t2 == null || t1 === t2) continue;
      const exists = (Tp.members || []).some(mm =>
        (mm.j1 === t1 && mm.j2 === t2) || (mm.j1 === t2 && mm.j2 === t1));
      if (exists) continue;
      if (!Array.isArray(Tp.members)) Tp.members = [];
      Tp.members.push({ id: allocMemberId(), j1: t1, j2: t2 });
      countM++;
    }
    perTarget.push({ name: T.name, countJ, countJReused, countM });
    totalJ += countJ; totalJReused += countJReused; totalM += countM;
  }
  // 批次 infer 被動到的 globalJoints
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  console.log(`[複製到同平面頁] ${sf.name} → ${picks.length} 個目標・節點 +${totalJ}(沿用 ${totalJReused})・桿件 +${totalM}・gids ${_touchedGids.size}`, perTarget);
  refreshFileList && refreshFileList();
  refreshLists && refreshLists();
  render && render();
  hideBusy();
  $("hud").textContent = `複製完成:${sf.name} → ${picks.length} 個目標・節點 +${totalJ}(沿用 ${totalJReused})、桿件 +${totalM}`;
}

// 整理所有頁面 — 沿用 _consolidateInPlace(同 btnConsolidate),逐頁切換 active state 後執行
//   _consolidateInPlace 內部用 getPage() / jointById() 都依賴 state.activeFileId + state.pageIdx
//   async + showBusyWithCancel:逐頁 yield 一次讓 UI 有機會 paint,Esc / 取消按鈕中斷
export async function consolidateAllPagesWithConfirm(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  const skipPushUndo = !!opts.skipPushUndo;
  const titlePrefix = opts.titlePrefix || "整理所有頁面";
  if (!state.files.length) {
    if (!skipConfirm) alert("沒有可整理的檔案");
    return { tasks: 0, pagesTouched: 0, totalMerged: 0, totalDropped: 0, totalSplit: 0, cancelled: false };
  }
  // 預先收集要處理的頁面(只看有節點或桿件、且非 _orphan 的頁)
  const tasks = [];
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      if (!(pg.joints || []).length && !(pg.members || []).length) continue;
      tasks.push({ f, pg, key: +k });
    }
  }
  if (!tasks.length) {
    if (!skipConfirm) alert("沒有可整理的頁面(都沒有節點/桿件)");
    return { tasks: 0, pagesTouched: 0, totalMerged: 0, totalDropped: 0, totalSplit: 0, cancelled: false };
  }
  if (!skipConfirm && !confirm(`對 ${tasks.length} 個頁面跑「整理」?\n會合併同位置節點、刪重複桿件、共線中段拆段。\nCtrl+Z 可還原。\n處理時可從 spinner 上的「取消」按鈕或 Esc 中斷。`)) {
    return { tasks: tasks.length, pagesTouched: 0, totalMerged: 0, totalDropped: 0, totalSplit: 0, cancelled: true };
  }
  if (!skipPushUndo) pushUndo();
  const origFid = state.activeFileId, origPidx = state.pageIdx;
  let pagesTouched = 0, totalMerged = 0, totalDropped = 0, totalSplit = 0;
  const stats = [];
  let cancelled = false;
  const onEsc = (e) => {
    if (e.key === "Escape" && !cancelled) {
      e.preventDefault(); e.stopImmediatePropagation();
      cancelled = true;
      setBusyMessage("取消中…等當前頁處理完畢");
    }
  };
  document.addEventListener("keydown", onEsc, true);
  showBusyWithCancel(`${titlePrefix} 準備中…(共 ${tasks.length} 頁・Esc / 取消可中斷)`, () => {
    cancelled = true;
    setBusyMessage("取消中…等當前頁處理完畢");
  });
  await busyTick();
  let processed = 0;
  for (const t of tasks) {
    if (cancelled) break;
    processed++;
    setBusyMessage(`${titlePrefix} ${processed}/${tasks.length}・${t.f.name}・頁 ${t.key}`);
    await busyTick();
    if (cancelled) break;
    state.activeFileId = t.f.id;
    state.pageIdx = t.key;
    const r = _consolidateInPlace();
    if ((r.mergedJ + r.droppedM + r.splitM) > 0) {
      pagesTouched++;
      totalMerged += r.mergedJ;
      totalDropped += r.droppedM;
      totalSplit += r.splitM;
      stats.push({ file: t.f.name, page: t.key, ...r });
    }
  }
  // loop 過程切換了 activeFileId,bgWidth/bgHeight 與 bgSvg DOM 可能停留在最後一個檔案上;
  //   即使最終 activeFileId 還原成 origFid,DOM 仍對不上。用 activatePage 重新渲染原本那頁
  //   底圖(等同自動「底圖修復」),確保視覺一致且後續 undo / redo 行為正確
  const fileChanged = (state.activeFileId !== origFid || state.pageIdx !== origPidx);
  state.activeFileId = origFid;
  state.pageIdx = origPidx;
  document.removeEventListener("keydown", onEsc, true);
  hideBusy();
  if (fileChanged) {
    try { await activatePage(origFid, origPidx); }
    catch (e) { console.warn("[整理所有頁面] 重新渲染底圖失敗:", e); }
  }
  const cancelTag = cancelled ? `(已中斷;處理到第 ${processed}/${tasks.length} 頁)` : "";
  console.log(`[${titlePrefix}]${cancelTag} ${pagesTouched} 頁有變動・合併節點 ${totalMerged}・刪桿件 ${totalDropped}・拆段 ${totalSplit}`, stats);
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render && render();
  refreshLists && refreshLists();
  $("hud").textContent = `${titlePrefix}${cancelTag}:${pagesTouched} 頁有變動・合併節點 ${totalMerged}・刪桿件 ${totalDropped}・拆段 ${totalSplit}`;
  return { tasks: tasks.length, pagesTouched, totalMerged, totalDropped, totalSplit, cancelled };
}

