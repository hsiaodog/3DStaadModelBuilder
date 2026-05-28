// 應用初始化 — module load 時跑一次的啟動序列
//
//   • initBlank() — 空白底圖初始化
//   • initFirstProject IIFE — 把目前 state 包成第一個專案分頁
//   • setupProjectTabsWheel IIFE — 專案分頁列垂直滾輪 → 水平捲動
//   • _startSaveWithHook — 儲存後清 dirty + 同步 project handle
//   • _applyToolbarMode + _initToolbarMode — 工具列顯示模式(文字/圖示/兩者)
//   • _decorateSubToolButtons + _decorateTopToolbarI18n — 子工具列圖示裝飾
//   • _initLang IIFE — 套上次語言
//
//   注意:這個 module 末段有大量 IIFE 副作用,所以 import 順序要在 toolbar / canvasEvents / 等
//          就緒之後,但 legacy.ts 在最後 import 此檔,確保所有 forward refs 都已 live。
// @ts-nocheck

import { state, nextJointId, nextMemberId, nextFileId, nextGlobalJointId } from "./state";
import { $, bg, bgctx } from "./dom";
import { fitToView } from "./transform";
import { undoStack, redoStack, setPushUndoHook } from "./undoRedo";
import { _setLanguage, readSavedLang, _applyI18n } from "../i18n";
import {
  // legacy forward refs
  render, refreshLists, refreshFileList, refreshPageSelector,
  paintEmptyCanvasMessage,
  updateSnapGridBtn, refreshPageCoordSection, updateSelectToolLabel, updateScaleRulerButton,
  projects, activeProjectId, setActiveProjectId, projectDirty, setProjectDirty,
  makeEmptyProjectData, refreshProjectTabs, refreshProjectMenu,
  startSave,
} from "../app/integration";

// ---------- init ----------
export function initBlank() {
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();
  bg.style.display = "block";
  const dpr = window.devicePixelRatio || 1;
  bg.width = Math.floor(state.bgWidth * dpr);
  bg.height = Math.floor(state.bgHeight * dpr);
  bg.style.width = state.bgWidth + "px";
  bg.style.height = state.bgHeight + "px";
  bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintEmptyCanvasMessage();
  fitToView(); render(); refreshLists();
  refreshFileList(); refreshPageSelector();
  if (typeof refreshTabBar === "function") refreshTabBar();
  updateSnapGridBtn && updateSnapGridBtn();
  refreshPageCoordSection && refreshPageCoordSection();
  updateSelectToolLabel && updateSelectToolLabel();
  updateScaleRulerButton && updateScaleRulerButton();
}
// ---------- dirty flag hooks ----------
// 把「有變更」訊號吸進 projectDirty(僅在 dirty 狀態轉換時重新渲染 tabs,避免高頻刷新)
setPushUndoHook(() => {
  const wasDirty = projectDirty;
  setProjectDirty(true);
  if (!wasDirty) refreshProjectTabs();
});

// 初始化第一個預設專案 — 包進 export function,由 integration.ts 透過 queueMicrotask 觸發,
// 避免在 persistence/projectTabs.ts 的 `let nextProjId = 1` 之前被觸發 → TDZ
export function _initFirstProject() {
  const p = makeEmptyProjectData("未命名");
  // 目前 state 已經 initBlank,直接接管
  p.files = state.files;
  p.globalJoints = state.globalJoints || [];
  p.materials = Array.isArray(state.materials) ? state.materials : [];
  p.undoStack = undoStack.slice();
  p.redoStack = redoStack.slice();
  p.scale = state.scale;
  p.unitName = state.unitName;
  p.globalCapacity = state.globalCapacity;
  p.activeFileId = state.activeFileId;
  p.pageIdx = state.pageIdx;
  p.openTabs = Array.isArray(state.openTabs) ? state.openTabs.map(t => ({ ...t })) : [];
  p.zoom = state.zoom; p.panX = state.panX; p.panY = state.panY;
  p.nextJointId = nextJointId;
  p.nextMemberId = nextMemberId;
  p.nextFileId = nextFileId;
  p.nextGlobalJointId = nextGlobalJointId;
  projects.push(p);
  setActiveProjectId(p.id);
  refreshProjectTabs();
  refreshProjectMenu();
}

// 專案分頁列:垂直滾輪 → 水平捲動
(function setupProjectTabsWheel() {
  const scroll = document.querySelector("#projectTabs .pt-scroll");
  if (!scroll) return;
  scroll.addEventListener("wheel", (e) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    scroll.scrollLeft += e.deltaY;
  }, { passive: false });
})();

// 儲存成功後清 dirty 旗標(原本是 monkey-patch startSave;Phase 8i 抽 startSave 到模組後
//   改成 named wrapper,所有 caller 走 _startSaveWithHook 取代直接呼叫 startSave)
export async function _startSaveWithHook(forceAs) {
  const prevHandle = state.projectFileHandle;
  const r = await startSave(forceAs);
  // 儲存成功標誌:handle 非 null 或下載完成(無 error 拋出即視為成功)
  setProjectDirty(false);
  // 同步當前 project 的 handle
  const cur = projects.find(p => p.id === activeProjectId);
  if (cur) {
    cur.projectFileHandle = state.projectFileHandle || null;
    cur.dirty = false;
  }
  refreshProjectTabs();
  refreshProjectMenu();
  return r;
}

// ---------- 工具列顯示模式(文字 / 圖示 / 文字+圖示) ----------
//   body class:tb-mode-text / tb-mode-icon / tb-mode-both;預設 both;狀態存在 localStorage
const _TB_MODE_KEY = "staad.toolbar.displayMode";
export function _applyToolbarMode(mode) {
  const m = (mode === "text" || mode === "icon" || mode === "both") ? mode : "both";
  document.body.classList.remove("tb-mode-text", "tb-mode-icon", "tb-mode-both");
  document.body.classList.add("tb-mode-" + m);
  try { localStorage.setItem(_TB_MODE_KEY, m); } catch (_) {}
  // 同步 submenu 的勾選符號
  const map = { "text": "tb-mode-text", "icon": "tb-mode-icon", "both": "tb-mode-both" };
  document.querySelectorAll("#tbModeMenu .submenu .menu-entry").forEach(e => {
    e.classList.toggle("checked", e.dataset.action === map[m]);
  });
}
(function _initToolbarMode() {
  let saved = "both";
  try { const v = localStorage.getItem(_TB_MODE_KEY); if (v === "text" || v === "icon" || v === "both") saved = v; } catch (_) {}
  _applyToolbarMode(saved);
})();

// ---------- 子工具列(selectTools / bgEditTools)圖示裝飾 ----------
//   原本只有純文字按鈕;這裡定義 id → SVG 對照表,然後用裝飾器把每個按鈕內容包成
//   <span class="btn-icon">…</span><span class="btn-text">…</span>,讓「工具列顯示模式」一樣作用。
const _GENERIC_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.4"/></svg>';
const _ICON_SVG = {
  // === selectTools: 選取群組 ===
  "selToolsAll":        '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.6" fill="currentColor" stroke="none"/><line x1="8" y1="8" x2="16" y2="16"/></svg>',
  "selToolsJoints":     '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/></svg>',
  "selToolsMembers":    '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><line x1="7" y1="17" x2="17" y2="7"/></svg>',
  // 方向 filter:全部以「斜線標示」當區別軸,線本身指方向;O = H+V 十字
  "selToolsDirV":       '<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21" stroke-width="2.6"/></svg>',
  "selToolsDirH":       '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" stroke-width="2.6"/></svg>',
  "selToolsDirO":       '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" stroke-width="2.4"/><line x1="12" y1="3" x2="12" y2="21" stroke-width="2.4"/></svg>',
  "selToolsDirD":       '<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="4" stroke-width="2.6"/></svg>',
  "selToolsRepeatHJ":   '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><polyline points="2 6 22 6 18 4 22 6 18 8"/></svg>',
  "selToolsRepeatVJ":   '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><polyline points="18 2 18 22 16 18 18 22 20 18"/></svg>',
  "selToolsRepeatOH":   '<svg viewBox="0 0 24 24"><line x1="3" y1="7" x2="15" y2="7"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="17" x2="15" y2="17"/><polyline points="18 8 21 11 18 14"/></svg>',
  "selToolsRepeatOV":   '<svg viewBox="0 0 24 24"><line x1="7" y1="3" x2="7" y2="15"/><line x1="12" y1="3" x2="12" y2="15"/><line x1="17" y1="3" x2="17" y2="15"/><polyline points="8 18 11 21 14 18"/></svg>',
  "selToolsRepeatDH":   '<svg viewBox="0 0 24 24"><line x1="3" y1="18" x2="11" y2="10"/><line x1="9" y1="18" x2="17" y2="10"/><polyline points="18 8 21 11 18 14"/></svg>',
  "selToolsRepeatDV":   '<svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="14" y2="11"/><line x1="6" y1="9" x2="14" y2="17"/><polyline points="8 18 11 21 14 18"/></svg>',
  // === selectTools: 編輯群組 ===
  "selToolsExtend":     '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><line x1="8" y1="12" x2="14" y2="12"/><polyline points="14 9 17 12 14 15"/></svg>',
  "selToolsExtendBoth": '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><line x1="8" y1="12" x2="16" y2="12"/><polyline points="9 9 6 12 9 15"/><polyline points="15 9 18 12 15 15"/></svg>',
  "selToolsJExtH":      '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><line x1="7" y1="12" x2="19" y2="12"/><polyline points="16 9 19 12 16 15"/></svg>',
  "selToolsJExtV":      '<svg viewBox="0 0 24 24"><circle cx="12" cy="19" r="2"/><line x1="12" y1="17" x2="12" y2="5"/><polyline points="9 8 12 5 15 8"/></svg>',
  "selToolsJExtHBoth":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><line x1="3" y1="12" x2="21" y2="12"/><polyline points="6 9 3 12 6 15"/><polyline points="18 9 21 12 18 15"/></svg>',
  "selToolsJExtVBoth":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><line x1="12" y1="3" x2="12" y2="21"/><polyline points="9 6 12 3 15 6"/><polyline points="9 18 12 21 15 18"/></svg>',
  "selToolsDupJointH":  '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><line x1="6" y1="8" x2="6" y2="16"/><line x1="18" y1="8" x2="18" y2="16"/></svg>',
  "selToolsDupJointV":  '<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21"/><circle cx="12" cy="6" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18" r="1.6"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="18" x2="16" y2="18"/></svg>',
  "selToolsJConnectH":  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>',
  "selToolsJConnectV":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><line x1="12" y1="7" x2="12" y2="17"/></svg>',
  "selToolsJConnectD":  '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="12" r="1.6"/><line x1="6.5" y1="17.5" x2="17.5" y2="6.5"/></svg>',
  "selToolsJMerge":     '<svg viewBox="0 0 24 24"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6c4 0 4 6 10 6"/><path d="M7 18c4 0 4-6 10-6"/></svg>',
  "selToolsMeasure":    '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="7" rx="1"/><line x1="6" y1="9" x2="6" y2="13"/><line x1="10" y1="9" x2="10" y2="13"/><line x1="14" y1="9" x2="14" y2="13"/><line x1="18" y1="9" x2="18" y2="13"/></svg>',
  "selToolsAnchorToggle":'<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><line x1="12" y1="7" x2="12" y2="20"/><path d="M5 14a7 7 0 0 0 14 0"/><line x1="9" y1="11" x2="15" y2="11"/></svg>',
  "selToolsIntersectSel":'<svg viewBox="0 0 24 24"><line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  "btnDel":             '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  // === selectTools: 移動群組 ===
  "selToolsMove":       '<svg viewBox="0 0 24 24"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
  "selToolsMoveH":      '<svg viewBox="0 0 24 24"><polyline points="6 8 3 11 6 14"/><polyline points="18 8 21 11 18 14"/><line x1="3" y1="11" x2="21" y2="11"/></svg>',
  "selToolsMoveV":      '<svg viewBox="0 0 24 24"><polyline points="8 6 11 3 14 6"/><polyline points="8 18 11 21 14 18"/><line x1="11" y1="3" x2="11" y2="21"/></svg>',
  "selToolsMoveDist":   '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="6" rx="1"/><line x1="6" y1="9" x2="6" y2="12"/><line x1="12" y1="9" x2="12" y2="12"/><line x1="18" y1="9" x2="18" y2="12"/><polyline points="20 18 22 20 20 22"/></svg>',
  "selToolsMoveAngle":  '<svg viewBox="0 0 24 24"><path d="M4 20 L20 4"/><path d="M4 20 L20 20"/><path d="M14 20a4 4 0 0 0 0-4"/></svg>',
  "selToolsMoveRect":   '<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20"/><line x1="4" y1="20" x2="4" y2="6"/><polyline points="2 9 4 6 7 9"/><polyline points="17 22 20 20 17 18"/></svg>',
  // === bgEditTools: 選取群組 ===
  // 全選底圖:虛框內含多個 bg primitive(直線、斜線、圓)→ 區隔 selToolsAll
  "bgEditSelectAll":    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><line x1="6" y1="9" x2="12" y2="9"/><line x1="6" y1="15" x2="14" y2="7"/><circle cx="17" cy="16" r="2.5"/></svg>',
  // 取消選取(虛框 + X)— 跟 ClearShape(取消形狀類型)區別:這裡虛框是動作框
  "bgEditClear":        '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/></svg>',
  "bgEditMultiSelect":  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="14" height="14" rx="1" stroke-dasharray="3 2"/><rect x="8" y="8" width="14" height="14" rx="1" stroke-dasharray="3 2"/></svg>',
  "bgEditSelSquares":   '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>',
  "bgEditSelRects":     '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="10" rx="1"/></svg>',
  "bgEditSelCircles":   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  "bgEditSelStraight":  '<svg viewBox="0 0 24 24"><line x1="3" y1="21" x2="21" y2="3"/></svg>',
  "bgEditSelStraightSolid": '<svg viewBox="0 0 24 24"><line x1="3" y1="21" x2="21" y2="3"/><circle cx="3" cy="21" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="3" r="1.4" fill="currentColor" stroke="none"/></svg>',
  "bgEditSelDiagonals": '<svg viewBox="0 0 24 24"><line x1="3" y1="18" x2="18" y2="3"/><line x1="6" y1="21" x2="21" y2="6"/></svg>',
  "bgEditSelDashedDiagonals": '<svg viewBox="0 0 24 24"><line x1="3" y1="21" x2="21" y2="3" stroke-dasharray="3 2"/></svg>',
  // 取消形狀類型:重疊的多種形狀(rect / circle / 斜線)被 X 切除,跟 bgEditClear 區別
  "bgEditClearShape":   '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="10" height="10"/><circle cx="16" cy="16" r="4"/><line x1="14" y1="3" x2="21" y2="10"/><line x1="20" y1="4" x2="4" y2="20" stroke-width="2.4"/></svg>',
  // === bgEditTools: 編輯群組 ===
  // bg 模式版本:用「交叉軸 + 中心點」風格(無外圈),跟主工具列 btnPlaneOrigin(同心圓外圈)區別
  "bgEditPlaneOrigin":  '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>',
  // bg 模式版本:單條直尺刻度,跟主工具列 btnScaleRuler(斜尺+刻度)區別
  "bgEditScaleRuler":   '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6" rx="1"/><line x1="6" y1="9" x2="6" y2="13"/><line x1="9" y1="9" x2="9" y2="12"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="15" y1="9" x2="15" y2="12"/><line x1="18" y1="9" x2="18" y2="13"/></svg>',
  "bgEditDrawLine":     '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/><line x1="6.4" y1="17.6" x2="17.6" y2="6.4"/></svg>',
  "bgEditDrawDashed":   '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/><line x1="6.4" y1="17.6" x2="17.6" y2="6.4" stroke-dasharray="3 2"/></svg>',
  "bgEditCopyLine":     '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="12" height="12" rx="1"/><rect x="3" y="9" width="12" height="12" rx="1"/></svg>',
  "bgEditBisector":     '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="3 2"/></svg>',
  "bgEditEquidist":     '<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12" stroke-dasharray="3 2"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  "bgEditToDashed":     '<svg viewBox="0 0 24 24"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15" stroke-dasharray="3 2"/></svg>',
  "bgEditSplit":        '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
  "bgEditToMember":     '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><polyline points="18 9 21 12 18 15"/><circle cx="3" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
  "bgEditMarkIntersect":'<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="18"/><line x1="3" y1="18" x2="21" y2="6"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
  "bgEditMarkIntersectAndMember":'<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="18"/><line x1="3" y1="18" x2="21" y2="6"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="3" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>',
  "bgEditRectToCenterMember": '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6"/><line x1="3" y1="12" x2="21" y2="12" stroke-dasharray="3 2"/></svg>',
  "bgEditRectToTopMember":    '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6"/><line x1="3" y1="9" x2="21" y2="9" stroke-dasharray="3 2"/></svg>',
  "bgEditRectToBottomMember": '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6"/><line x1="3" y1="15" x2="21" y2="15" stroke-dasharray="3 2"/></svg>',
  "bgEditSquareToJoint":'<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  "bgEditDel":          '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  "bgEditScaleRulerMove":'<svg viewBox="0 0 24 24"><path d="M3 17L17 3l4 4L7 21z"/><polyline points="6 6 3 9 6 12"/><polyline points="18 6 21 9 18 12"/></svg>',
  "bgEditMeasureSelect": '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="7" rx="1"/><polyline points="9 12 11 14 16 9"/></svg>',
  "bgEditMeasureMove":  '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="7" rx="1"/><polyline points="6 6 3 9 6 12"/><polyline points="18 6 21 9 18 12"/></svg>',
  // === bgEditTools: 測量群組(原本沒登錄圖示 → fallback 成 generic dot,現在補) ===
  // 標示距離:雙箭頭量度線(╞════╡)
  "bgEditMeasure":      '<svg viewBox="0 0 24 24"><line x1="4" y1="12" x2="20" y2="12"/><polyline points="7 9 4 12 7 15"/><polyline points="17 9 20 12 17 15"/><line x1="4" y1="6" x2="4" y2="18"/><line x1="20" y1="6" x2="20" y2="18"/></svg>',
  // 水平原點距離:從原點(十字)往右量到一條垂直線
  "bgEditOriginDistH":  '<svg viewBox="0 0 24 24"><line x1="3" y1="9" x2="3" y2="15"/><line x1="3" y1="12" x2="3" y2="12"/><circle cx="3" cy="12" r="1.6" fill="currentColor" stroke="none"/><line x1="3" y1="12" x2="20" y2="12"/><polyline points="17 9 20 12 17 15"/><line x1="20" y1="4" x2="20" y2="20" stroke-dasharray="3 2"/></svg>',
  // 垂直原點距離:從原點往下量到一條水平線
  "bgEditOriginDistV":  '<svg viewBox="0 0 24 24"><line x1="9" y1="3" x2="15" y2="3"/><circle cx="12" cy="3" r="1.6" fill="currentColor" stroke="none"/><line x1="12" y1="3" x2="12" y2="20"/><polyline points="9 17 12 20 15 17"/><line x1="4" y1="20" x2="20" y2="20" stroke-dasharray="3 2"/></svg>',
  // 與原點最短距離:從原點向斜線方向作垂線(直角符號)
  "bgEditOriginDistMin":'<svg viewBox="0 0 24 24"><line x1="3" y1="20" x2="21" y2="2"/><circle cx="4" cy="4" r="1.8" fill="currentColor" stroke="none"/><line x1="4" y1="4" x2="13" y2="13"/><polyline points="11 11 13 13 13 11" stroke-width="1.4"/></svg>',
};

function _decorateSubToolButtons() {
  // 把 #selectTools / #bgEditTools 內每個 button 的內容包成 icon + text 兩個 span
  //   - text span 附 data-i18n="subtool.<id>",讓 _applyI18n 直接套字典(若字典裡有此 key)
  //   - 若 button 沒 id,就維持原文字、不加 i18n 屬性
  //   - title 屬性附 data-i18n-title="tip.<id>"(同樣 fallback 行為)
  ["#selectTools", "#bgEditTools"].forEach(sel => {
    const root = document.querySelector(sel);
    if (!root) return;
    root.querySelectorAll("button").forEach(btn => {
      if (btn.querySelector(".btn-icon")) return;            // 已裝飾
      const id = btn.id || "";
      const icon = _ICON_SVG[id] || _GENERIC_ICON;
      const text = btn.textContent.trim();
      const i18nAttr = id ? ` data-i18n="subtool.${id}"` : "";
      btn.innerHTML =
        `<span class="btn-icon">${icon}</span>` +
        `<span class="btn-text"${i18nAttr}>${text}</span>`;
      // tooltip i18n key:若該 id 存在 _I18N["tip." + id],套字典時會覆寫
      if (id && !btn.dataset.i18nTitle) btn.dataset.i18nTitle = "tip." + id;
    });
  });
}
_decorateSubToolButtons();
// 主工具列 button:批次加上 data-i18n-title="tip.<id>";切英文時自動套精簡 en tooltip
(function _decorateTopToolbarI18n() {
  document.querySelectorAll("#toolbar button").forEach(btn => {
    if (btn.id && !btn.dataset.i18nTitle) btn.dataset.i18nTitle = "tip." + btn.id;
  });
})();
// 再跑一次 _applyI18n,套用裝飾器剛加上的 data-i18n / data-i18n-title
try { _applyI18n(); } catch (_) {}

// 原本是 (function _initLang(){...})() 在 i18n 區塊的尾端跑;為了保持「i18n module 載入時
// 還不算完全 init 完畢、要等 legacy 走到對應位置」的舊時序,把 IIFE 拉回 legacy 這條位置上。
(function _initLang() {
  _setLanguage(readSavedLang());
})();
