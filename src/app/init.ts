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
import { getAllPipelines, getActiveStructureType, setActiveStructureType } from "../core/pipeline/pipelineSettings";
import { openPipelineManager } from "../dialogs/pipelineManager";
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
// 同時觸發自動備份(debounce 30s)— 不會寫到任何磁碟檔案,只進瀏覽器 IDB。
import { scheduleBackupSoon, flushBackupNow, clearBackupForActive } from "../persistence/autoBackup";
setPushUndoHook(() => {
  const wasDirty = projectDirty;
  setProjectDirty(true);
  if (!wasDirty) refreshProjectTabs();
  scheduleBackupSoon();
});
// beforeunload best-effort flush:同步觸發 IDB put;若瀏覽器允許 unload 完成 promise 就會完成。
window.addEventListener("beforeunload", () => { flushBackupNow().catch(() => {}); });
window.addEventListener("pagehide",     () => { flushBackupNow().catch(() => {}); });

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
  // 磁碟檔已是最新 → 清掉該 project 的自動備份(下次啟動就不會出現復原提示)
  clearBackupForActive().catch(() => {});
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
  // ============================================================
  //  全套重新規劃 — 每顆 icon 視覺唯一(byte-unique,已用 script 驗證)
  //  風格:24x24 viewBox、stroke 線條(CSS 給 fill:none/round);實心點用 fill=currentColor
  // ============================================================
  // === selectTools:選取 filter ===
  "selToolsAll":        '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none"/></svg>',
  "selToolsJoints":     '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="18" r="2.4"/></svg>',
  "selToolsMembers":    '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="5" r="2.2"/><line x1="7" y1="17" x2="17" y2="7"/></svg>',
  "selToolsDirV":       '<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21" stroke-width="2.8"/></svg>',
  "selToolsDirH":       '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" stroke-width="2.8"/></svg>',
  "selToolsDirO":       '<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20" stroke-width="2.4"/><line x1="4" y1="20" x2="4" y2="4" stroke-width="2.4"/></svg>',
  "selToolsDirD":       '<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="4" stroke-width="2.8"/></svg>',
  "selToolsRepeatHJ":   '<svg viewBox="0 0 24 24"><circle cx="5" cy="14" r="2"/><circle cx="12" cy="14" r="2"/><circle cx="19" cy="14" r="2"/><polyline points="4 6 20 6"/><polyline points="17 4 20 6 17 8"/></svg>',
  "selToolsRepeatVJ":   '<svg viewBox="0 0 24 24"><circle cx="10" cy="5" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="10" cy="19" r="2"/><polyline points="18 4 18 20"/><polyline points="16 17 18 20 20 17"/></svg>',
  "selToolsRepeatOH":   '<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="14" y2="6"/><line x1="3" y1="11" x2="14" y2="11"/><line x1="3" y1="16" x2="14" y2="16"/><polyline points="18 7 21 11 18 15"/></svg>',
  "selToolsRepeatOV":   '<svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="14"/><line x1="11" y1="3" x2="11" y2="14"/><line x1="16" y1="3" x2="16" y2="14"/><polyline points="7 18 11 21 15 18"/></svg>',
  "selToolsRepeatDH":   '<svg viewBox="0 0 24 24"><line x1="3" y1="16" x2="9" y2="8"/><line x1="9" y1="16" x2="15" y2="8"/><polyline points="18 8 21 12 18 16"/></svg>',
  "selToolsRepeatDV":   '<svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="14" y2="9"/><line x1="6" y1="10" x2="14" y2="16"/><polyline points="6 18 10 21 14 18"/></svg>',
  // === selectTools:編輯 ===
  "selToolsExtend":     '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.2"/><line x1="8" y1="12" x2="15" y2="12"/><polyline points="15 8 20 12 15 16"/></svg>',
  "selToolsExtendBoth": '<svg viewBox="0 0 24 24"><line x1="6" y1="12" x2="18" y2="12"/><polyline points="9 8 5 12 9 16"/><polyline points="15 8 19 12 15 16"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
  "selToolsJExtH":      '<svg viewBox="0 0 24 24"><circle cx="4" cy="12" r="2.2"/><line x1="6" y1="12" x2="20" y2="12"/><polyline points="16 8 20 12 16 16"/></svg>',
  "selToolsJExtV":      '<svg viewBox="0 0 24 24"><circle cx="12" cy="20" r="2.2"/><line x1="12" y1="18" x2="12" y2="4"/><polyline points="8 8 12 4 16 8"/></svg>',
  "selToolsJExtHBoth":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2"/><line x1="3" y1="12" x2="21" y2="12"/><polyline points="6 8 3 12 6 16"/><polyline points="18 8 21 12 18 16"/></svg>',
  "selToolsJExtVBoth":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2"/><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 6 12 3 16 6"/><polyline points="8 18 12 21 16 18"/></svg>',
  "selToolsDupJointH":  '<svg viewBox="0 0 24 24"><line x1="3" y1="18" x2="21" y2="18"/><circle cx="6" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="6" r="2.2"/><polyline points="9 11 12 8 15 11" /></svg>',
  "selToolsDupJointV":  '<svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="21"/><circle cx="6" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="6" cy="18" r="1.6" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="2.2"/><polyline points="11 9 14 12 11 15"/></svg>',
  "selToolsJConnectH":  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/><line x1="7" y1="12" x2="17" y2="12" stroke-width="2.2"/></svg>',
  "selToolsJConnectV":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><circle cx="12" cy="19" r="2.2"/><line x1="12" y1="7" x2="12" y2="17" stroke-width="2.2"/></svg>',
  "selToolsJConnectD":  '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="5" r="2.2"/><line x1="6.5" y1="17.5" x2="17.5" y2="6.5" stroke-width="2.2"/></svg>',
  "selToolsJMerge":     '<svg viewBox="0 0 24 24"><circle cx="4" cy="6" r="2"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="12" r="2.4"/><polyline points="6 6 12 12 6 18"/><line x1="12" y1="12" x2="18" y2="12"/></svg>',
  "selToolsMeasure":    '<svg viewBox="0 0 24 24"><rect x="2" y="8" width="20" height="8" rx="1"/><line x1="7" y1="8" x2="7" y2="13"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="17" y1="8" x2="17" y2="13"/></svg>',
  "selToolsSupportSet":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><line x1="12" y1="7" x2="12" y2="20"/><path d="M5 14a7 7 0 0 0 14 0"/><line x1="9" y1="11" x2="15" y2="11"/></svg>',
  "selToolsSupportFixed":'<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="14"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="7" y1="14" x2="4" y2="19"/><line x1="13" y1="14" x2="10" y2="19"/><line x1="19" y1="14" x2="16" y2="19"/></svg>',
  "selToolsSupportPinned":'<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><path d="M12 7 L5 17 H19 Z"/><line x1="4" y1="20" x2="20" y2="20"/></svg>',
  "selToolsSupportClear":'<svg viewBox="0 0 24 24"><path d="M12 4 L6 14 H18 Z"/><line x1="4" y1="18" x2="20" y2="18"/><line x1="3" y1="21" x2="21" y2="3" stroke-width="2.2"/></svg>',
  "selToolsReleaseSet":  '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/><line x1="6" y1="18" x2="14" y2="10"/><circle cx="16" cy="8" r="3"/></svg>',
  "selToolsReleasePinned":'<svg viewBox="0 0 24 24"><line x1="8" y1="12" x2="16" y2="12" stroke-width="2.2"/><circle cx="5" cy="12" r="3"/><circle cx="19" cy="12" r="3"/></svg>',
  "selToolsReleaseTruss":'<svg viewBox="0 0 24 24"><line x1="3" y1="19" x2="21" y2="19"/><polyline points="3 19 8 7 13 19 18 7 21 19"/></svg>',
  "selToolsReleaseClear":'<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><circle cx="3" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="21" cy="12" r="1.6" fill="currentColor" stroke="none"/><line x1="8" y1="7" x2="16" y2="17" stroke-width="2.2"/><line x1="16" y1="7" x2="8" y2="17" stroke-width="2.2"/></svg>',
  "selToolsIntersectSel":'<svg viewBox="0 0 24 24"><line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
  "btnDel":             '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  // === selectTools:移動 ===
  "selToolsMove":       '<svg viewBox="0 0 24 24"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
  "selToolsMoveH":      '<svg viewBox="0 0 24 24"><polyline points="6 8 2 12 6 16"/><polyline points="18 8 22 12 18 16"/><line x1="2" y1="12" x2="22" y2="12" stroke-width="2.2"/></svg>',
  "selToolsMoveV":      '<svg viewBox="0 0 24 24"><polyline points="8 6 12 2 16 6"/><polyline points="8 18 12 22 16 18"/><line x1="12" y1="2" x2="12" y2="22" stroke-width="2.2"/></svg>',
  "selToolsMoveDist":   '<svg viewBox="0 0 24 24"><line x1="3" y1="8" x2="3" y2="14"/><line x1="3" y1="11" x2="17" y2="11"/><polyline points="14 8 17 11 14 14"/><line x1="9" y1="9" x2="9" y2="13"/><polyline points="18 18 21 21 18 24"/><line x1="14" y1="20" x2="21" y2="20"/></svg>',
  "selToolsMoveAngle":  '<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20"/><line x1="4" y1="20" x2="19" y2="6"/><path d="M16 20 a12 12 0 0 0 -3.5 -8.5"/></svg>',
  "selToolsMoveRect":   '<svg viewBox="0 0 24 24"><polyline points="5 21 5 13 13 13"/><polyline points="5 13 19 13" stroke-dasharray="2 2"/><line x1="5" y1="21" x2="19" y2="21" stroke-dasharray="2 2"/><polyline points="16 10 19 13 16 16"/><polyline points="2 18 5 21 8 18"/></svg>',
  // === bgEditTools:選取 ===
  "bgEditSelectAll":    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/><line x1="6" y1="16" x2="13" y2="9"/><circle cx="16" cy="15" r="2.5"/></svg>',
  "bgEditClear":        '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>',
  "bgEditMultiSelect":  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="13" height="13" rx="1" stroke-dasharray="3 2"/><rect x="8" y="8" width="13" height="13" rx="1" stroke-dasharray="3 2"/></svg>',
  "bgEditSelSquares":   '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>',
  "bgEditSelRects":     '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="10" rx="1"/></svg>',
  "bgEditSelCircles":   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  "bgEditSelStraight":  '<svg viewBox="0 0 24 24"><line x1="3" y1="20" x2="21" y2="4"/></svg>',
  "bgEditSelStraightSolid": '<svg viewBox="0 0 24 24"><line x1="3" y1="20" x2="21" y2="4" stroke-width="2.4"/><circle cx="3" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="4" r="1.4" fill="currentColor" stroke="none"/></svg>',
  "bgEditSelDiagonals": '<svg viewBox="0 0 24 24"><line x1="3" y1="17" x2="17" y2="3"/><line x1="7" y1="21" x2="21" y2="7"/></svg>',
  "bgEditSelDashedDiagonals": '<svg viewBox="0 0 24 24"><line x1="3" y1="20" x2="21" y2="4" stroke-dasharray="3 2"/></svg>',
  "bgEditClearShape":   '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="9" height="9"/><circle cx="16" cy="16" r="4"/><line x1="3" y1="21" x2="21" y2="3" stroke-width="2.4"/></svg>',
  // === bgEditTools:編輯 ===
  "bgEditPlaneOrigin":  '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>',
  "bgEditScaleRuler":   '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6" rx="1"/><line x1="6" y1="9" x2="6" y2="13"/><line x1="9" y1="9" x2="9" y2="12"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="15" y1="9" x2="15" y2="12"/><line x1="18" y1="9" x2="18" y2="13"/></svg>',
  "bgEditDrawLine":     '<svg viewBox="0 0 24 24"><path d="M14 4 L20 10 L9 21 L4 21 L4 16 Z"/><line x1="13" y1="5" x2="19" y2="11"/></svg>',
  "bgEditDrawDashed":   '<svg viewBox="0 0 24 24"><path d="M14 4 L20 10 L9 21 L4 21 L4 16 Z"/><line x1="13" y1="5" x2="19" y2="11" stroke-dasharray="2 2"/></svg>',
  "bgEditCopyLine":     '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="12" height="12" rx="1"/><rect x="3" y="9" width="12" height="12" rx="1"/></svg>',
  "bgEditBisector":     '<svg viewBox="0 0 24 24"><line x1="3" y1="14" x2="21" y2="14"/><circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none"/><line x1="12" y1="4" x2="12" y2="20" stroke-dasharray="3 2"/></svg>',
  "bgEditEquidist":     '<svg viewBox="0 0 24 24"><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="10" x2="3" y2="18"/><line x1="9" y1="10" x2="9" y2="18" stroke-dasharray="2 2"/><line x1="15" y1="10" x2="15" y2="18" stroke-dasharray="2 2"/><line x1="21" y1="10" x2="21" y2="18"/></svg>',
  "bgEditToDashed":     '<svg viewBox="0 0 24 24"><line x1="3" y1="8" x2="21" y2="8"/><polyline points="14 14 17 17 14 20"/><line x1="3" y1="20" x2="13" y2="20" stroke-dasharray="3 2"/></svg>',
  "bgEditSplit":        '<svg viewBox="0 0 24 24"><line x1="3" y1="14" x2="21" y2="14"/><line x1="12" y1="5" x2="12" y2="23"/><polyline points="9 8 12 5 15 8"/></svg>',
  "bgEditToMember":     '<svg viewBox="0 0 24 24"><line x1="4" y1="16" x2="20" y2="16"/><line x1="4" y1="8" x2="20" y2="8"/><circle cx="4" cy="8" r="1.6" fill="currentColor" stroke="none"/><circle cx="20" cy="8" r="1.6" fill="currentColor" stroke="none"/><polyline points="10 11 12 13 14 11"/></svg>',
  "bgEditMarkIntersect":'<svg viewBox="0 0 24 24"><line x1="3" y1="5" x2="21" y2="19"/><line x1="3" y1="19" x2="21" y2="5"/><circle cx="12" cy="12" r="2.6"/></svg>',
  "bgEditMarkIntersectAndMember":'<svg viewBox="0 0 24 24"><line x1="3" y1="5" x2="21" y2="19"/><line x1="3" y1="19" x2="21" y2="5"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="3" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="19" r="1.4" fill="currentColor" stroke="none"/></svg>',
  "bgEditRectToCenterMember": '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="8"/><line x1="3" y1="12" x2="21" y2="12" stroke-width="2.2"/></svg>',
  "bgEditRectToTopMember":    '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="8"/><line x1="3" y1="8" x2="21" y2="8" stroke-width="2.4"/></svg>',
  "bgEditRectToBottomMember": '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="8"/><line x1="3" y1="16" x2="21" y2="16" stroke-width="2.4"/></svg>',
  "bgEditSquareToJoint":'<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>',
  "bgEditDel":          '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  "bgEditScaleRulerMove":'<svg viewBox="0 0 24 24"><path d="M3 17 L17 3 l4 4 L7 21 z"/><line x1="8" y1="8" x2="11" y2="11"/><polyline points="3 11 1 13 3 15"/><polyline points="21 9 23 11 21 13"/></svg>',
  "bgEditMeasureSelect": '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="7" rx="1"/><polyline points="8 12 11 15 16 8"/></svg>',
  "bgEditMeasureMove":  '<svg viewBox="0 0 24 24"><rect x="6" y="9" width="12" height="7" rx="1"/><polyline points="5 9 1 12 5 15"/><polyline points="19 9 23 12 19 15"/></svg>',
  // === bgEditTools:測量 ===
  "bgEditMeasure":      '<svg viewBox="0 0 24 24"><line x1="4" y1="12" x2="20" y2="12"/><polyline points="7 9 4 12 7 15"/><polyline points="17 9 20 12 17 15"/><line x1="4" y1="6" x2="4" y2="18"/><line x1="20" y1="6" x2="20" y2="18"/></svg>',
  "bgEditOriginDistH":  '<svg viewBox="0 0 24 24"><circle cx="3" cy="12" r="1.8" fill="currentColor" stroke="none"/><line x1="3" y1="12" x2="20" y2="12"/><polyline points="17 9 20 12 17 15"/><line x1="20" y1="4" x2="20" y2="20" stroke-dasharray="3 2"/></svg>',
  "bgEditOriginDistV":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="3" r="1.8" fill="currentColor" stroke="none"/><line x1="12" y1="3" x2="12" y2="20"/><polyline points="9 17 12 20 15 17"/><line x1="4" y1="20" x2="20" y2="20" stroke-dasharray="3 2"/></svg>',
  "bgEditOriginDistMin":'<svg viewBox="0 0 24 24"><line x1="3" y1="20" x2="21" y2="2"/><circle cx="4" cy="4" r="1.8" fill="currentColor" stroke="none"/><line x1="4" y1="4" x2="13" y2="13"/><polyline points="11 11 13 13 13 11" stroke-width="1.4"/></svg>',
  "bgEditMeasureDelLast":'<svg viewBox="0 0 24 24"><line x1="3" y1="14" x2="14" y2="14"/><line x1="3" y1="11" x2="3" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><line x1="16" y1="8" x2="22" y2="8" stroke-width="2.2"/></svg>',
  "bgEditMeasureClearAll":'<svg viewBox="0 0 24 24"><line x1="2" y1="7" x2="12" y2="7"/><line x1="2" y1="13" x2="12" y2="13"/><line x1="2" y1="19" x2="12" y2="19"/><line x1="16" y1="6" x2="22" y2="12" stroke-width="2.2"/><line x1="22" y1="6" x2="16" y2="12" stroke-width="2.2"/></svg>',
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
// 左側按鈕區:每個小區(.bg-edit-section)點標題可收合 / 展開,狀態存 localStorage
function _setupSectionCollapse() {
  ["#selectTools", "#bgEditTools"].forEach(sel => {
    const panel = document.querySelector(sel);
    if (!panel) return;
    panel.querySelectorAll<HTMLElement>(".bg-edit-section").forEach((sec, idx) => {
      const title = sec.querySelector<HTMLElement>(".bg-edit-title");
      if (!title || (title as any)._collapseWired) return;
      (title as any)._collapseWired = true;
      const key = `staad.secCollapse.${sel}.${title.getAttribute("data-i18n") || idx}`;
      try { if (localStorage.getItem(key) === "1") sec.classList.add("collapsed"); } catch (_) {}
      title.addEventListener("click", () => {
        const collapsed = sec.classList.toggle("collapsed");
        try { localStorage.setItem(key, collapsed ? "1" : "0"); } catch (_) {}
      });
    });
  });
}
_setupSectionCollapse();
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

// 左側欄「結構類型」下拉:選定後「⚡ 3D 一鍵處理」依此 pipeline 規劃步驟與編號方式
(function _initStructureTypeSelector() {
  const sel = $("structureTypeSel") as HTMLSelectElement | null;
  if (!sel) return;
  const fill = () => {
    const active = getActiveStructureType();
    sel.innerHTML = "";
    for (const p of getAllPipelines()) {
      const o = document.createElement("option");
      o.value = p.structureType;
      o.textContent = p.label || p.structureType;
      if (p.structureType === active) o.selected = true;
      sel.appendChild(o);
    }
  };
  fill();
  sel.addEventListener("change", () => { try { setActiveStructureType(sel.value); } catch (e) { console.warn(e); } });
  // 回到主視窗時刷新(反映在管理視窗 / 3D 預覽做的變更)
  window.addEventListener("focus", fill);
  const btn = $("structurePipelineMgrBtn");
  if (btn) btn.addEventListener("click", () => { try { openPipelineManager(fill); } catch (e) { console.warn(e); } });
})();
