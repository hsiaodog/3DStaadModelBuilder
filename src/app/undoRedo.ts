// 復原 / 重做 — 全域 undo / redo stack + 還原後的 UI 重整 (postRestore)
//
//   • undoStack / redoStack: snapshot 陣列(每筆是整個 state 的深拷貝)
//   • pushUndo(): 把目前 state 推到 undoStack;清空 redoStack(任何寫入都把已 redo 的丟掉)
//   • undo() / redo(): 互換 stack + applySnap + postRestore
//   • postRestore(): 還原後重整 selection / UI / refresh* / globalJoint infer / bg auto-repair
//
//   專案切換時 undoStack / redoStack 由 projectTabs.snapshot/loadProjectDataFromP 維護。
//   pushUndo 會 invalidateRankCache,所以任何寫入都會讓下次 render 重新算 displayId。
// @ts-nocheck

import { MAX_UNDO } from "../constants";
import { state } from "./state";
import { $ } from "./dom";
import { snapshot, applySnap } from "../persistence/snapshot";
import { invalidateRankCache } from "../core/rankCache";
import { inferAllGlobalJoints } from "../core/globalJoints";
import { showBusy, hideBusy, busyTick } from "../ui/busy";
// 從 legacy.ts 來的 helper:有些定義在後段(forward ref),用 named import live binding
import {
  getActiveFile, getPage,
  clearSelection, render, refreshLists, refreshFileList, refreshPageSelector,
  refreshPageCoordSection, refreshSectionLinkList,
  applyBgRotation, syncUserBgLinesToDom,
  updatePlaneOriginButton, updateScaleRulerButton, updateCalibrateButton,
  activatePage,
} from "../app/integration";

export const undoStack: any[] = [];
export const redoStack: any[] = [];

// dirty-flag hook:projectTabs 想知道「有人剛 pushUndo」就把 projectDirty=true + 刷 tabs。
//   legacy.ts module body 末段會 setPushUndoHook(fn) 註冊;在沒註冊前 pushUndo 仍正常運作。
let _pushUndoHook: (() => void) | null = null;
export function setPushUndoHook(fn: (() => void) | null) { _pushUndoHook = fn; }

export function pushUndo() {
  if (_pushUndoHook) {
    try { _pushUndoHook(); } catch (e) { console.warn("[pushUndo hook]", e); }
  }
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  // 任何寫入操作都可能改變節點 / 桿件 / 平面設定 → rank cache 一律失效
  if (typeof invalidateRankCache === "function") invalidateRankCache();
}

function postRestore() {
  clearSelection();
  state.pendingLineStart = null;
  state.marquee = null;
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  const pz = $("pageZ");
  if (pz) (pz as any).value = (getPage().z ?? 0);
  applyBgRotation(getActiveFile());
  // 同步使用者畫的 bg 線:undo / redo 後 file.userBgLines 已被 applySnap 重置,
  //   需要把對應的 DOM <line> 也重建出來(否則撤銷的線會在畫面上殘留 / 重做的線會消失)
  if (typeof syncUserBgLinesToDom === "function") syncUserBgLinesToDom(getActiveFile());
  // planeOrigin / scaleRuler 還原後,按鈕 active 狀態 + globalJoint 推算結果都要跟著重來
  if (typeof updatePlaneOriginButton === "function") updatePlaneOriginButton();
  if (typeof updateScaleRulerButton === "function") updateScaleRulerButton();
  if (typeof updateCalibrateButton === "function") updateCalibrateButton();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  refreshPageCoordSection && refreshPageCoordSection();
  render(); refreshLists();
  // 防禦:若當前 active file 應該有底圖、但 bgSvg DOM 不見了或為空,自動重新觸發
  //   activatePage 重建底圖(原本「底圖修復」按鈕的邏輯,自動化)。
  _autoRepairBgIfMissing();
}

// 偵測底圖 DOM 是否被某流程清掉 → 自動重新跑 activatePage 重建(等同自動「底圖修復」)
//   只在 bg DOM 真的不見時才出手(bgSvg 整個沒了 且 bg-canvas 也沒了);僅靠 tag 不一致不觸發,
//   因為 activatePage 會跑 fitToView / _restorePageView 改視窗 zoom/pan,在 bg 還在的情況下啟動會
//   把使用者當前的視野打亂(造成「按 undo 後畫面變空」這類錯覺)。
//   設計成非同步 fire-and-forget;不阻塞 postRestore。沒可用來源時不動作。
function _autoRepairBgIfMissing() {
  const af = getActiveFile();
  if (!af) return;
  const hasSource = !!(af.pdf || af.image || af.cachedBgSvg || af.cachedBgImg || af.sourceFileId);
  if (!hasSource) return;
  const bgSvgEl = document.getElementById("bgSvg");
  const bgCanvasEl = document.getElementById("bg-canvas");
  const svgMissing = !bgSvgEl || bgSvgEl.childElementCount === 0;
  const canvasMissing = !bgCanvasEl;
  if (!(svgMissing && canvasMissing)) return;
  console.warn("[bg auto-repair] bgSvg + bg-canvas 都不見,自動重新 activatePage",
    { activeFileId: af.id, pageIdx: state.pageIdx });
  Promise.resolve().then(() => {
    try { activatePage(af.id, state.pageIdx || 0); }
    catch (e) { console.warn("[bg auto-repair] 失敗:", e); }
  });
}

export async function undo() {
  if (!undoStack.length) {
    if ($("hud")) $("hud").textContent = "已無可復原的動作";
    return;
  }
  // pending message:在 snapshot / applySnap / postRestore 之前先 paint 一個 spinner
  showBusy(`復原中…(可復原 ${undoStack.length} / 可重做 ${redoStack.length})`);
  if (typeof busyTick === "function") await busyTick();
  try {
    redoStack.push(snapshot());
    applySnap(undoStack.pop());
    postRestore();
  } finally {
    hideBusy();
  }
  if ($("hud")) {
    $("hud").textContent = `已復原(剩 ${undoStack.length} 步可復原 / ${redoStack.length} 步可重做)`;
  }
}

export async function redo() {
  if (!redoStack.length) {
    if ($("hud")) $("hud").textContent = "已無可重做的動作";
    return;
  }
  showBusy(`重做中…(可復原 ${undoStack.length} / 可重做 ${redoStack.length})`);
  if (typeof busyTick === "function") await busyTick();
  try {
    undoStack.push(snapshot());
    applySnap(redoStack.pop());
    postRestore();
  } finally {
    hideBusy();
  }
  if ($("hud")) {
    $("hud").textContent = `已重做(剩 ${undoStack.length} 步可復原 / ${redoStack.length} 步可重做)`;
  }
}
