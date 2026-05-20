// Phase 7a — undo/redo 用的 state snapshot (純資料序列化,沒有 UI side-effect)
//   pdf / image / DOM 不快照(無法 JSON serialize);其餘 file metadata、pages、global joints、
//   measure overlay、id 計數器 全部以深拷貝形式存進 snapshot 物件。
//   applySnap 把 snapshot 寫回 state(注意:保留現有 file 物件以保留 pdf/image 參照,只替換 pages
//   等資料欄位),並用 setter 重設模組級 id 計數器(ESM let 不能跨模組直接寫,故走 setNext*Id)。
// @ts-nocheck

import {
  state,
  nextJointId, nextMemberId, nextGlobalJointId, nextGlobalMemberId,
  setNextJointId, setNextMemberId, setNextGlobalJointId, setNextGlobalMemberId,
  _updateGlobalOriginUI,
} from "../legacy";

export function snapshot() {
  // 只快照可序列化部分:每個 file 的 pages、metadata。pdf/image 物件不存。
  const filesSnap = state.files.map(f => ({
    id: f.id, name: f.name, type: f.type,
    rotation: f.rotation || 0,
    offsetX: f.offsetX || 0,
    offsetY: f.offsetY || 0,
    clipRect: f.clipRect ? { ...f.clipRect } : null,
    pages: JSON.parse(JSON.stringify(f.pages || {})),
    sectionLinks: f.sectionLinks ? JSON.parse(JSON.stringify(f.sectionLinks)) : undefined,
    userBgLines: Array.isArray(f.userBgLines) ? JSON.parse(JSON.stringify(f.userBgLines)) : [],
    measurements: Array.isArray(f.measurements) ? JSON.parse(JSON.stringify(f.measurements)) : [],
    _nextMeasureId: f._nextMeasureId || 1,
    // 重設原點 / 校準 / 旋轉 都會動 planeOrigin & scaleRuler,缺這兩個 → undo 還原不完整
    planeOrigin: f.planeOrigin ? { ...f.planeOrigin } : null,
    scaleRuler: f.scaleRuler ? JSON.parse(JSON.stringify(f.scaleRuler)) : null,
  }));
  return {
    files: filesSnap,
    activeFileId: state.activeFileId,
    pageIdx: state.pageIdx,
    scale: state.scale,
    unitName: state.unitName,
    globalCapacity: state.globalCapacity,
    globalOriginId: state.globalOriginId,
    globalOriginFileId: state.globalOriginFileId,
    globalJoints: JSON.parse(JSON.stringify(state.globalJoints || [])),
    globalMembers: JSON.parse(JSON.stringify(state.globalMembers || [])),
    // 標示距離結果:使用者可以 undo/redo 標示距離動作
    measure: state.measure ? JSON.parse(JSON.stringify(state.measure)) : null,
    nextJointId, nextMemberId, nextGlobalJointId, nextGlobalMemberId,
  };
}

export function applySnap(s) {
  // 把現有 file 物件保留(pdf/image 不能透過 JSON 還原),只替換 pages
  for (const fs of s.files) {
    const existing = state.files.find(f => f.id === fs.id);
    if (existing) {
      existing.pages = fs.pages;
      existing.rotation = fs.rotation || 0;
      existing.offsetX = fs.offsetX || 0;
      existing.offsetY = fs.offsetY || 0;
      existing.clipRect = fs.clipRect || null;
      // 衍生模型:undo 還原時也只保留主關聯,autoProp 副本(舊資料 / 升級前快照)直接濾掉
      existing.sectionLinks = fs.sectionLinks
        ? JSON.parse(JSON.stringify(fs.sectionLinks)).filter(e => !e.autoProp)
        : [];
      existing.userBgLines = Array.isArray(fs.userBgLines) ? JSON.parse(JSON.stringify(fs.userBgLines)) : [];
      existing.measurements = Array.isArray(fs.measurements) ? JSON.parse(JSON.stringify(fs.measurements)) : [];
      existing._nextMeasureId = fs._nextMeasureId || 1;
      // planeOrigin / scaleRuler 同步還原(否則 undo 動原點 / 比例尺後仍停留在新值)
      existing.planeOrigin = fs.planeOrigin ? { ...fs.planeOrigin } : null;
      existing.scaleRuler  = fs.scaleRuler  ? JSON.parse(JSON.stringify(fs.scaleRuler))  : null;
    }
  }
  // 移除快照沒有的 file(代表是被加入後又被撤銷)
  state.files = state.files.filter(f => s.files.some(fs => fs.id === f.id));
  state.activeFileId = s.activeFileId;
  state.pageIdx = s.pageIdx;
  state.scale = s.scale;
  state.unitName = s.unitName;
  if (s.globalCapacity) state.globalCapacity = s.globalCapacity;
  state.globalJoints = Array.isArray(s.globalJoints) ? s.globalJoints : [];
  state.globalOriginId = (s.globalOriginId != null) ? s.globalOriginId : null;
  state.globalOriginFileId = (s.globalOriginFileId != null) ? s.globalOriginFileId : null;
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  setNextJointId(s.nextJointId);
  setNextMemberId(s.nextMemberId);
  if (s.nextGlobalJointId) setNextGlobalJointId(s.nextGlobalJointId);
  if (s.nextGlobalMemberId) setNextGlobalMemberId(s.nextGlobalMemberId);
  // globalMembers 也跟著 undo/redo
  state.globalMembers = s.globalMembers ? JSON.parse(JSON.stringify(s.globalMembers)) : [];
  // 還原標示距離 overlay(undo/redo 可回溯標示距離結果)
  state.measure = s.measure ? JSON.parse(JSON.stringify(s.measure)) : null;
  state.pendingGlobalPair = null;
}
