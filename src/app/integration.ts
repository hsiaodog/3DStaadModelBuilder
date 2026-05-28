// @ts-nocheck
// integration.ts — 歷史整合層(原本叫 legacy.ts)
//
// 這檔目前 ~4600 行、~100 個 export,是 6 輪重構過程中逐步從單檔 index_legacy.html(已刪)
// 抽出 src/core/、src/tools/、src/dialogs/、src/ui/、src/persistence/ 之後,
// 剩下「還沒找到好家」的功能 + 對其他模組的中央 re-export hub。
//
// 別在這檔加新功能。新功能該歸哪就放哪(tools / dialogs / ui / persistence …)。
// 這檔的長期方向是繼續縮小、最後刪掉。要動之前先看「QA_REPORT.md」與「MIGRATION_PLAN.md」(docs/)。
//
// pdf.js setup → src/main.ts
// 各 pure util → src/utils/ + src/constants.ts
import { MAX_UNDO, ALLOWED_YY } from "../constants";
import { staadUnitKeyword, unitToMeter, meterToTarget } from "../utils/units";
import { xlsxCellRef as _xlsxCellRef, xmlEsc as _xmlEsc, xlsxCell as _xlsxCell } from "../utils/ooxml";
import { joint2DToWorld3D, world3DToJoint2D } from "../core/projection";
import { listGlobalBindings, inferGlobalJoint, inferAllGlobalJoints } from "../core/globalJoints";
import { proposeAutoPairings } from "../core/autopair";
import { _rankCache, invalidateRankCache, _worldForRank, _axisCap, _ensureRankCache } from "../core/rankCache";
import { _displayIdForJointWith } from "../core/displayId";
import { buildModel, showBuildModelCollisionsIfAny } from "../core/buildModel";
import { buildExportContext } from "../export/shared";

// ---------- main app code(原本是 1.13M chars 的大 <script> block) ----------
"use strict";

// ---------- state ----------
// state 物件 + counters + setters 搬到 src/app/state.ts
// DOM refs($ / wrap / stage / bg / bgctx / svg)搬到 src/app/dom.ts
// legacy.ts 仍 re-export 全部,讓既有 `from "./integration"` import 不需要改
import {
  state,
  nextJointId, nextMemberId, nextFileId, nextGlobalJointId, nextGlobalMemberId,
  allocJointId, allocMemberId, allocFileId, allocGlobalJointId, allocGlobalMemberId,
  setNextJointId, setNextMemberId, setNextFileId, setNextGlobalJointId, setNextGlobalMemberId,
} from "./state";
export {
  state,
  nextJointId, nextMemberId, nextFileId, nextGlobalJointId, nextGlobalMemberId,
  allocJointId, allocMemberId, allocFileId, allocGlobalJointId, allocGlobalMemberId,
  setNextJointId, setNextMemberId, setNextFileId, setNextGlobalJointId, setNextGlobalMemberId,
};

// ---------- 復原 / 重做 ----------
// undoStack / redoStack / pushUndo / undo / redo / postRestore 搬到 src/app/undoRedo.ts
import { undoStack, redoStack, pushUndo, undo, redo } from "./undoRedo";
export { undoStack, redoStack, pushUndo, undo, redo };

export function getActiveFile() {
  return state.files.find(f => f.id === state.activeFileId);
}
export function getPage() {
  const f = getActiveFile();
  if (!f) return { joints: [], members: [], z: 0, _orphan: true };  // no-op fallback
  if (!f.pages) f.pages = {};
  if (!f.pages[state.pageIdx]) f.pages[state.pageIdx] = { joints: [], members: [], z: 0 };
  return f.pages[state.pageIdx];
}
// 拆分頁面的可繪製範圍:有 clipRect 時只能在矩形內建立 / 編輯
//   tol 給少量浮點容差(預設 0.5 世界單位 = 0.5px)
export function isInsideClip(file, x, y, tol?: number) {
  if (!file || !file.clipRect) return true;
  const t = tol == null ? 0.5 : tol;
  const r = file.clipRect;
  return x >= r.x - t && x <= r.x + r.w + t
      && y >= r.y - t && y <= r.y + r.h + t;
}

// ---------- 全局節點 helpers (MVP-1) ----------
export function findGlobalJointById(gid) {
  if (gid == null) return null;
  return state.globalJoints.find(g => g.id === gid) || null;
}
function autoGlobalJointLabel() {
  // 找一個目前沒被使用的 N# (從 1 開始)
  const used = new Set(state.globalJoints.map(g => g.label));
  for (let i = 1; i < 100000; i++) {
    const lbl = "N" + i;
    if (!used.has(lbl)) return lbl;
  }
  return "N" + nextGlobalJointId;
}
// 把世界座標 round 到目前精準度(state.measureDecimals 位數),且 -0 → 0。
//   globalJoint 的 x/y/z 一律以這個結果儲存,避免漂浮小數造成 rank cache / 顯示不一致
export function _snapCoordToPrecision(v) {
  if (!Number.isFinite(v)) return v;
  const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  const r = parseFloat(v.toFixed(md));
  return r === 0 ? 0 : r;
}
// 把所有 globalJoint 的 x/y/z 重新對齊到目前精準度(精準度設定改動時呼叫)
export function snapAllGlobalJointsToPrecision() {
  if (!Array.isArray(state.globalJoints)) return 0;
  let touched = 0;
  for (const g of state.globalJoints) {
    if (!g) continue;
    const nx = _snapCoordToPrecision(g.x);
    const ny = _snapCoordToPrecision(g.y);
    const nz = _snapCoordToPrecision(g.z);
    if (nx !== g.x || ny !== g.y || nz !== g.z) {
      g.x = nx; g.y = ny; g.z = nz;
      touched++;
    }
  }
  if (touched && typeof invalidateRankCache === "function") invalidateRankCache();
  return touched;
}
export function createGlobalJoint() {
  const g = {
    id: allocGlobalJointId(),
    label: autoGlobalJointLabel(),
    x: null, y: null, z: null,
    derivedFrom: [],
    locked: false,
    warnings: [],
  };
  state.globalJoints.push(g);
  return g;
}
export function bindJointToGlobal(joint, gid) {
  const oldGid = joint.globalId;
  // 同一頁同一個 globalId 只能對應 1 個 view joint
  const p = getPage();
  for (const j of p.joints) {
    if (j !== joint && j.globalId === gid) j.globalId = null;
  }
  joint.globalId = gid;
  // 若是改綁,舊的 globalJoint 若沒人引用就清掉(否則重新推算)
  if (oldGid != null && oldGid !== gid) {
    if (countBindings(oldGid) === 0) gcGlobalJoint(oldGid);
    else { const og = findGlobalJointById(oldGid); if (og) inferGlobalJoint(og); }
  }
  const g = findGlobalJointById(gid);
  if (g) inferGlobalJoint(g);
}
export function unbindJointFromGlobal(joint) {
  const oldGid = joint.globalId;
  joint.globalId = null;
  // GC:若該 globalJoint 沒人引用,刪除;否則重新推算
  if (oldGid != null) {
    if (countBindings(oldGid) === 0) gcGlobalJoint(oldGid);
    else { const og = findGlobalJointById(oldGid); if (og) inferGlobalJoint(og); }
  }
}
function gcGlobalJoint(gid) {
  if (countBindings(gid) === 0) {
    state.globalJoints = state.globalJoints.filter(g => g.id !== gid);
  }
}
function countBindings(gid) {
  let n = 0;
  for (const f of state.files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      for (const j of (pg.joints || [])) if (j.globalId === gid) n++;
    }
  }
  return n;
}
// listGlobalBindings 移到 src/core/globalJoints.ts(Phase 3b)

// ---------- MVP-2:3D 投影與一致性推算 ----------
// 把 view joint 投影到 3D 世界座標。
//   座標系慣例:水平軸一律往「右」為正;縱軸方向依平面而異:
//     XY 平面(立面正視):+X = 螢幕右,+Y = 螢幕上;Z = page.z
//     YZ 平面(立面側視):+Z = 螢幕右,+Y = 螢幕上;X = page.z
//     XZ 平面(平面俯視):+X = 螢幕右,+Z = 螢幕下(plan view convention);Y = page.z
//   未設定:fallback 視為 XY
// 回傳 { x, y, z, strong: { X, Y, Z } }(strong[axis] = 該軸是否為 in-plane 強約束)
//   無比例尺(該檔沒校準且全局 state.scale 也無)→ 回傳 null
// joint2DToWorld3D 移到 src/core/projection.ts(Phase 3a)

// 把 joint 投影到本頁世界平面的 in-plane 兩軸,並回傳軸名 + 數值(已套 flipX/Y/原點/比例尺)。
//   軸名對應:XY → (X, Y) / YZ → (Z, Y) / XZ → (X, Z) — 螢幕水平軸放 axisA、垂直軸放 axisB。
//   數值由 joint2DToWorld3D 取出對應軸,因此 + 軸方向跟軸指示器箭頭一致(箭頭朝哪邊就 + 值)。
//   沒比例尺 / 沒 plane → 回 null,呼叫者要自己 fallback。
export function _inPlaneCoordsForJoint(file, page, joint) {
  const w = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(file, page, joint) : null;
  if (!w) return null;
  const plane = (page && page.plane) || "XY";
  switch (plane) {
    case "XZ": return { axisA: "X", axisB: "Z", valA: w.x, valB: w.z };
    case "YZ": return { axisA: "Z", axisB: "Y", valA: w.z, valB: w.y };
    case "XY":
    default:   return { axisA: "X", axisB: "Y", valA: w.x, valB: w.y };
  }
}

// 根據所有綁定推算 globalJoint 的 3D 座標 + 一致性檢查。
// 規則:
//   - 強約束(in-plane)優先採用;同軸有多個強約束 → 取平均並檢查差異
//   - 沒有任何強約束的軸 → 取所有弱約束(out-of-plane)的平均;若仍無 → null
//   - 若同軸強約束差異 > tol 或 弱/強衝突 > tol → 寫 warning
//   - locked === true 的不覆蓋座標,只跑檢查
// inferGlobalJoint + inferAllGlobalJoints 移到 src/core/globalJoints.ts(Phase 3f)

// Phase 8a:calibrateAllFilesToGlobalOrigin / CustomOrigin 搬到 src/tools/calibrate.ts
export { calibrateAllFilesToGlobalOrigin, calibrateAllFilesToCustomOrigin } from "../tools/calibrate";

// joint2DToWorld3D 的反函數:給 3D world (X, Y, Z) 與目標 (file, page),回 2D (joint.x, joint.y)
//   ratio / origin / plane 全部用目標 page 的設定
//   檢查 page 的「out-of-plane 軸」是否與 world 對應軸吻合(tol);不吻合回 { ok: false, reason }
//   無 ratio:回 null
// world3DToJoint2D 移到 src/core/projection.ts(Phase 3a)

// 找出能容納指定 3D world 的所有頁(任意 file 的任意 page),回傳 [{ file, page, pageIdx, x, y }]
function findCompatiblePages(world, opts) {
  const tol = (opts && opts.tol != null) ? opts.tol : 0.5;
  const out = [];
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      const r = world3DToJoint2D(f, pg, world, { tol });
      if (r && r.ok) out.push({ file: f, page: pg, pageIdx: +k, x: r.x, y: r.y });
    }
  }
  return out;
}

// ---------- P2:跨頁同步建點時吸到底圖實際交點 ----------
// 把當前 active 頁的 bg 線段以「世界座標」(= 該頁 joint 座標) 抽出快取到 page._bgSegsCache
// 結構:[{ x1, y1, x2, y2 }]
// 呼叫時機:activatePage 完成後;cache 跟著 page 走,即使切到其他頁也保留(供其他頁的 P2 snap 用)
//   不重要 / 太短的線會被過濾
export function cacheActivePageBgSegs() {
  const file = getActiveFile();
  const page = getPage();
  if (!file || !page || page._orphan) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) { page._bgSegsCache = null; return; }
  const segs = [];
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "circle" || tag === "ellipse") continue;  // 純曲線略過
    const sub = svgElementToSegments(el);
    if (!sub.length) continue;
    const ctm = el.getScreenCTM();
    if (!ctm) continue;
    const owner = el.ownerSVGElement || bgSvgEl;
    for (const s of sub) {
      const p1 = owner.createSVGPoint(); p1.x = s.x1; p1.y = s.y1;
      const p2 = owner.createSVGPoint(); p2.x = s.x2; p2.y = s.y2;
      const sp1 = p1.matrixTransform(ctm);
      const sp2 = p2.matrixTransform(ctm);
      const w1 = screenToWorld(sp1.x, sp1.y);
      const w2 = screenToWorld(sp2.x, sp2.y);
      const dx = w2.x - w1.x, dy = w2.y - w1.y;
      if ((dx * dx + dy * dy) < 0.01) continue;   // 零長 / 近零長略過
      segs.push({ x1: w1.x, y1: w1.y, x2: w2.x, y2: w2.y });
    }
  }
  page._bgSegsCache = segs;
}

// 全部頁面預先掃描 bg(供 P2 跨頁吸點使用)
//   會逐頁 activate(因為要 live DOM 算 CTM),完成後切回原頁
export async function prewarmAllPagesBgCache() {
  const origFid = state.activeFileId, origPidx = state.pageIdx;
  let scanned = 0;
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      if (Array.isArray(pg._bgSegsCache)) continue;  // 已快取就略過
      try {
        await activatePage(f.id, +k);
        cacheActivePageBgSegs();
        scanned++;
        await busyTick();
      } catch (e) { console.warn("[P2 prewarm] 失敗:", f.name, "#" + (+k + 1), e); }
    }
  }
  if (origFid != null) await activatePage(origFid, origPidx || 0);
  return scanned;
}

// 在指定 page 的 bg cache 裡找最接近 projected 的「實際交點」
//   projected = { x, y } 是該 page 的 joint 座標(來自 world3DToJoint2D)
//   radius:搜尋半徑(world 單位);預設 snapPx*2 / state.scale
//   strict:t/u ∈ [0, 1] 才接受(不允許延伸線交點)
//   回 { x, y, snapped: true }(吸到了)/ null(沒找到)
function snapProjectionToBgIntersection(file, page, projected, opts) {
  const segs = page && page._bgSegsCache;
  if (!Array.isArray(segs) || segs.length < 2) return null;
  const radius = (opts && opts.radius != null)
    ? opts.radius
    : Math.max(2.0, (state.snapPx * 2) / Math.max(state.scale || 1, 1e-9));
  // 預篩:取距離 projected 在 (radius + 線段長/2) 內的線
  const candidates = [];
  for (const s of segs) {
    const cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;
    const halfLen = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) / 2;
    const dCenter = Math.hypot(cx - projected.x, cy - projected.y);
    if (dCenter > radius + halfLen + 1) continue;
    candidates.push(s);
  }
  if (candidates.length < 2) return null;
  let best = null, bestD = radius;
  const eps = 1e-6;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      const r = lineLineIntersect(
        { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 },
        { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }
      );
      if (!r) continue;
      // strict 實際相交(容差 = eps 的線參數放寬,基本就是 [0,1])
      if (r.t < -eps || r.t > 1 + eps || r.u < -eps || r.u > 1 + eps) continue;
      const d = Math.hypot(r.x - projected.x, r.y - projected.y);
      if (d < bestD) { bestD = d; best = { x: r.x, y: r.y, snapped: true }; }
    }
  }
  return best;
}

// ---------- 三視圖自動配對 ----------
// 掃所有「已校準(可投影為 3D)」頁面,跨平面比對共軸座標,提出候選綁定。
//   triple:同時匹配 XY+XZ+YZ 三面(X、Y、Z 三軸都要在 tol 內),信心高
//   pair:  只匹配 2 面共軸(XY+XZ→X 軸 / XY+YZ→Y 軸 / XZ+YZ→Z 軸),信心中等
// 採貪心:先收信心最高(triple, score 最小)者,該頁節點不再被別組搶走;
// 再收 pair。回傳已篩選的 candidates。
//   opts.tol           : 匹配公差(state.unitName 同單位,如 mm),預設 50
//   opts.includeBound  : 是否含已綁定的節點,預設 false
// proposeAutoPairings 移到 src/core/autopair.ts(Phase 3c)

// 跨頁版 bind:不能用 bindJointToGlobal(它只看當前頁)
function bindJointAcrossPages(fileId, pageIdx, jointId, gid) {
  const f = state.files.find(x => x.id === fileId); if (!f) return;
  const pg = (f.pages || {})[pageIdx]; if (!pg) return;
  const j = (pg.joints || []).find(x => x.id === jointId); if (!j) return;
  // 同頁同 gid 互斥(一個全局節點在每一頁最多綁 1 個 view joint)
  for (const j2 of pg.joints) {
    if (j2 !== j && j2.globalId === gid) j2.globalId = null;
  }
  const oldGid = j.globalId;
  j.globalId = gid;
  if (oldGid != null && oldGid !== gid && countBindings(oldGid) === 0) {
    state.globalJoints = state.globalJoints.filter(g => g.id !== oldGid);
  }
}

function applyAutoPairings(accepted) {
  let triples = 0, pairs = 0;
  for (const c of accepted) {
    const g = createGlobalJoint();
    for (const m of c.members) bindJointAcrossPages(m.fileId, m.pageIdx, m.jointId, g.id);
    inferGlobalJoint(g);
    if (c.type === "triple") triples++; else pairs++;
  }
  return { triples, pairs };
}

// ---------- DOM ----------
import { $, wrap, stage, bg, bgctx, svg } from "./dom";
export { $, wrap, stage, bg, bgctx, svg };

// ---------- transform helpers ----------
// applyTransform / screenToWorld / fitToView / _saveCurrentTabView / _restorePageView
// 搬到 src/app/transform.ts
import {
  applyTransform, screenToWorld, fitToView,
  _saveCurrentTabView, _restorePageView,
} from "./transform";
export {
  applyTransform, screenToWorld, fitToView,
  _saveCurrentTabView, _restorePageView,
};

// ---------- background loaders ----------
// $("file") onchange handler + showImportDialog + setupImportDialogDrag
// 搬到 src/io/bgLoaders.ts(import 即執行 module-level 副作用)
import "../io/bgLoaders";
export { showImportDialog, setupImportDialogDrag } from "../io/bgLoaders";


// ---------- file / page lifecycle ----------
// addFile / activatePage / activatePageWithBusy / collision popup helpers / syncStateScaleFromActiveFile
// 搬到 src/app/lifecycle.ts
import {
  addFile, syncStateScaleFromActiveFile,
  activatePage, activatePageWithBusy,
  _maybeShowCollisionPopup, _showAllCollisionsPopup, _showCollisionPopup,
} from "./lifecycle";
export {
  addFile, syncStateScaleFromActiveFile,
  activatePage, activatePageWithBusy,
  _maybeShowCollisionPopup, _showAllCollisionsPopup, _showCollisionPopup,
};


// ---------- 導航歷史(類似 IntelliJ 的 cmd+[ / cmd+]) ----------
// navHistory state + _captureCurrentView / _navRecordIfNotInProgress / _navGoTo / navBack / navForward
// 搬到 src/state/navHistory.ts
export {
  navHistory,
  _captureCurrentView,
  _navRecordIfNotInProgress,
  _navGoTo,
  navBack,
  navForward,
} from "../persistence/navHistory";
import {
  _navRecordIfNotInProgress,
  navBack,
  navForward,
} from "../persistence/navHistory";
// ---------- 底圖渲染 / 路徑偵測 ----------
// 17 個函式搬到 src/io/bgRender.ts(底圖匡選用 shape detection + render PDF / image / cached SVG)
// legacy.ts 內 activatePage / 等處仍直接 call → 同時做 named import(進本模組 scope)+ re-export(對外)
import {
  parseStraightSegs,
  bgLineWorldEnds,
  bgLocalToWorld,
  bgBBoxInRange,
  findRectangleBgLines,
  bgPathWorldBBox,
  findCircleBgPaths,
  findStraightBgLines,
  _isStraightBgLineElement,
  _isDashedBgElement,
  findDiagonalBgSegments,
  applyBgSelectMode,
  updateBgStrokeWidth,
  applyBgRotation,
  renderPdfBg,
  renderBlankBg,
  renderImageBg,
  renderCachedBg,
} from "../io/bgRender";
export {
  parseStraightSegs,
  bgLineWorldEnds,
  bgLocalToWorld,
  bgBBoxInRange,
  findRectangleBgLines,
  bgPathWorldBBox,
  findCircleBgPaths,
  findStraightBgLines,
  _isStraightBgLineElement,
  _isDashedBgElement,
  findDiagonalBgSegments,
  applyBgSelectMode,
  updateBgStrokeWidth,
  applyBgRotation,
  renderPdfBg,
  renderBlankBg,
  renderImageBg,
  renderCachedBg,
};

// ---------- 左側欄檔案清單 ----------
// 檔案類型標籤(DXF / PDF / IMG / DXF-S / PDF-S / IMG-S / —)
//   拆分(split / 衍生)檔:沿用來源檔的類型 + "-S" 後綴
// ---------- 左側欄檔案清單 ----------
// fileTypeLabel / filePlaneLabel / refreshFileList / showFileCtxMenu /
// deleteSelectedFiles / refreshPageSelector 全搬到 src/ui/fileList.ts
// (fmtCoord / fmtWorld3D 留在 legacy.ts — 用途遠超檔案清單,屬通用 formatter)
import {
  fileTypeLabel, filePlaneLabel,
  refreshFileList,
  showFileCtxMenu, deleteSelectedFiles,
  refreshPageSelector,
} from "../ui/fileList";
export {
  fileTypeLabel, filePlaneLabel,
  refreshFileList,
  showFileCtxMenu, deleteSelectedFiles,
  refreshPageSelector,
};
export function fmtCoord(v) {
  if (v == null || !isFinite(v)) return "?";
  let n = state.coordDecimals;
  if (n == null || !isFinite(n) || n < 0) {
    const f = getActiveFile();
    n = (f && f.type === "application/dxf") ? 2 : 0;
  }
  let s = v.toFixed(Math.min(6, Math.max(0, n)));
  // 正規化 "-0" / "-0.0" / "-0.00..." → "0…",避免顯示負零
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s;
}

// 3D 世界座標專用的格式化器:用「精準度設定」(state.measureDecimals)而非
//   「座標小數位數」(state.coordDecimals)。這樣 rank bucket / xlsx / 側欄 / popup
//   都用同一個精準度,顯示值與 bucket key 永遠對齊(不會出現側欄顯示 4005、bucket
//   是 4005、xlsx 寫 4005.23 的錯位)。length / delta / px 維度仍走 fmtCoord。
export function fmtWorld3D(v: number): string {
  if (v == null || !isFinite(v)) return "?";
  let n = state.measureDecimals;
  if (n == null || !isFinite(n) || n < 0) n = 0;
  let s = v.toFixed(Math.min(6, Math.max(0, n)));
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s;
}

// ---------- pan/zoom + canvas events ----------
// 全部搬到 src/app/canvasEvents.ts(wheel / mousedown / mousemove / mouseup / keydown / keyup
// + markInteracting + 範圍放大 finalize)。由 wireCanvasEvents() 延後 call。
import { wireCanvasEvents, panning, rangeZoomDragStart, rangeZoomSuppressClick, mouseDownPos,
         setPanning, setRangeZoomDragStart, setRangeZoomSuppressClick, setMouseDownPos } from "./canvasEvents";
export { cKeyDown, panning, rangeZoomDragStart, rangeZoomSuppressClick, mouseDownPos,
         setPanning, setRangeZoomDragStart, setRangeZoomSuppressClick, setMouseDownPos } from "./canvasEvents";
import { _setBtnLabel, _t } from "../i18n";
import { _measureDec } from "../tools/measure";
import { _updateAnchorToggleBtn } from "../tools/anchor";
import { calibrateAllFilesToCustomOrigin, calibrateAllFilesToGlobalOrigin } from "../tools/calibrate";
import { handleMoveModeClick } from "../tools/moveCmd";
// integration.ts 內 cacheActivePageBgSegs / bg svg 處理還在用 svgElementToSegments
// + attachBgPathHandlers + _ensureBgOrigGroup,這些 helper 都在 toolbar.ts → 顯式 import
import { svgElementToSegments, attachBgPathHandlers,
         _projectPointOnLine, _selectedBgLinesAsWorld, exitSplitMode,
         updateCalibrateButton, updatePlaneOriginButton, updateScaleRulerButton,
         distinctSelectedLineCount, selectAllBgPaths } from "./toolbar";
wireCanvasEvents();

// ---------- tools ----------
export function setTool(t) {
  // 從修改底圖模式切到其他工具時,清空所有底圖選取
  const wasBgsel = (state.tool === "selectBg");
  if (wasBgsel && t !== "selectBg") {
    const f = getActiveFile();
    if (f) clearAllBgSelection(f);
    // 離開 selectBg → 若還卡在切線關聯 pending,一併結束(避免殘留 state)
    if (state.sectionLinkPending) {
      state.sectionLinkPending = false;
      state.sectionLinkPrevTool = null;
      $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
      _restoreSectionLinkShapeMarquee();
    }
    // 離開 selectBg → 連帶關掉所有底圖 sub-mode(畫直線 / 複製線 / 中分線 / 等分線)
    if (state.bgDrawLine && state.bgDrawLine.active) exitBgDrawLine();
    if (state.bgCopyLine && state.bgCopyLine.active) exitBgCopyLine();
    if (state.bgBisector && state.bgBisector.active) exitBgBisector();
    if (state.bgEqui && state.bgEqui.active) exitBgEqui();
  }
  state.tool = t;
  state.pendingLineStart = null;
  // bg 元素很多(DXF 常見)時,進 / 離 selectBg 都會 iterate 所有元素設 pointer-events,
  // 阻塞 UI 數百 ms。用 withBusy 顯示「處理中」並把工作 defer 到下一幀,讓 spinner 先 paint
  const bgSvgEl = document.getElementById("bgSvg");
  const bgCount = bgSvgEl ? bgSvgEl.querySelectorAll("[data-bg-idx]").length : 0;
  const heavy = bgCount > 500 && (t === "selectBg" || wasBgsel);
  const finish = () => {
    applyBgSelectMode && applyBgSelectMode();
    if (typeof applyBgVisibility === "function") applyBgVisibility();
    if ($("bgEditTools")) $("bgEditTools").style.display = (t === "selectBg") ? "flex" : "none";
    if ($("selectTools")) $("selectTools").style.display = (t === "select") ? "flex" : "none";
    // 旋轉 90° 只在底圖模式下有意義(會連同節點 / 桿件 / 量測 / userBg 線一起旋轉)
    if ($("btnRotate90")) $("btnRotate90").style.display = (t === "selectBg") ? "" : "none";
    if (typeof applyToolbarBounds === "function") applyToolbarBounds();
    if (t === "selectBg") updateBgEditOpsVisibility && updateBgEditOpsVisibility();
    _setToolFinishVisuals(t);
  };
  if (heavy) {
    withBusy(`處理底圖中…(${bgCount} 個元素)`, finish);
  } else {
    finish();
  }
  // 視覺狀態(✓ + active)立即更新,不等 heavy work
  _setToolFinishVisuals(t);
  return;
}
export function _setToolFinishVisuals(t) {
  // 工具按鈕視覺狀態:active 加藍底(✓ 打勾已移除,僅保留底色變化)
  //   i18n:用 _setBtnLabel 同步 .btn-text 的 data-i18n,讓語言切換能跟著翻譯,且 icon 保留
  const toolMap = [
    { id: "tool-line",   t: "line",     key: "tb.toolLine",   fb: "桿件" },
    { id: "tool-point",  t: "point",    key: "tb.toolPoint",  fb: "節點" },
    { id: "tool-select", t: "select",
      key: state.multiSelectSticky ? "tb.toolMulti" : "tb.toolSelect",
      fb:  state.multiSelectSticky ? "多選"          : "選取" },
    { id: "tool-bgsel",  t: "selectBg", key: "tb.toolBgSel",  fb: "底圖" },
  ];
  for (const { id, t: kt, key, fb } of toolMap) {
    const btn = $(id); if (!btn) continue;
    const isActive = (t === kt);
    btn.classList.toggle("active", isActive);
    _setBtnLabel(btn, key, fb);
  }
  render();
}
// 阻止工具列/HUD 的點擊冒泡到畫布(否則會誤建節點或啟動框選)
["toolbar", "tabBar", "hud", "zoomTools"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  ["click", "mousedown", "mouseup", "dblclick", "wheel"].forEach((ev) =>
    el.addEventListener(ev, (e) => e.stopPropagation()));
});

$("tool-line").onclick = () => setTool("line");
$("tool-point") && ($("tool-point").onclick = () => setTool("point"));
$("tool-select").onclick = () => setTool("select");
$("tool-bgsel").onclick = () => setTool(state.tool === "selectBg" ? "select" : "selectBg");
export function withBusy(msg, fn) {
  const sp = document.getElementById("busySpinner");
  if (!sp) { fn(); return; }
  const m = sp.querySelector(".msg"); if (m) m.textContent = msg || "處理中…";
  sp.classList.add("active");
  // 連續兩個 rAF:確保 spinner 先 paint 再執行運算,避免被同步任務阻塞而看不見
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    try {
      const r = fn();
      if (r && typeof r.then === "function") await r;   // 支援 async fn
    } finally {
      sp.classList.remove("active");
    }
  }));
}
// 比例尺(工具列):進入修改底圖並等待選取 2 條平行線,選完自動建立比例尺,再進入沿線拖曳
$("btnScaleRuler") && ($("btnScaleRuler").onclick = () => {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  // 退出衝突模式
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
  if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) cancelScaleRulerDrag();
  if (state.originPending) exitOriginPending();
  clearSelection();
  clearAllBgSelection(file);
  state.scaleRulerPending = true;
  if (state.tool !== "selectBg") setTool("selectBg");
  $("hud").textContent = "比例尺:請選第一條平行線(Esc 取消)";
  updateScaleRulerButton();
  render();
});
export function exitScaleRulerPending() {
  if (!state.scaleRulerPending) return;
  state.scaleRulerPending = false;
  updateScaleRulerButton();
}

// ---------- 標示距離(只讀,不寫,持續顯示直到 Esc 或重新測量) ----------
// 16 個函式搬到 src/tools/measure.ts;legacy.ts 內 bgEditMeasure / bgEditOriginDist 按鈕 onclick
// 仍透過 import 引用本檔函式(避免 module top-level circular dep TDZ)
export {
  exitMeasurePending,
  formatMeasureDistance,
  _measureDec,
  _refreshAllMeasurementLabels,
  computeMeasureFromLines,
  collectMeasureLinesFromCurrentSelection,
  _ensureFileMeasurements,
  _persistCurrentMeasure,
  startMeasureFromCurrentSelection,
  updateMeasureSlide,
  commitMeasureSlide,
  reenterMeasureSlide,
  deleteMeasurement,
  clearAllMeasurements,
  bgComputeMeasureFromSelection,
  startMeasurePending,
} from "../tools/measure";
import {
  exitMeasurePending,
  _refreshAllMeasurementLabels,
  startMeasureFromCurrentSelection,
  updateMeasureSlide,
  commitMeasureSlide,
  reenterMeasureSlide,
  deleteMeasurement,
  clearAllMeasurements,
  bgComputeMeasureFromSelection,
  startMeasurePending,
} from "../tools/measure";
// 點 / 匡選 完成後,如果在 比例尺 / 座標原點 pending 狀態,依目前選取數量決定下一步 HUD 提示或自動建立
export function checkBgPendingAfterSelect() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths) return;
  const n = file.selectedBgPaths.size;
  // 共線的線視為同一條,例如 DXF 把一條軸線拆成多段、或使用者點到同一線兩處
  const dn = distinctSelectedLineCount(file);
  const bgSvgEl = document.getElementById("bgSvg");

  if (state.scaleRulerPending) {
    if (dn === 0) {
      $("hud").textContent = "比例尺:請選第一條平行線(Esc 取消)";
    } else if (dn === 1) {
      const extra = n > 1 ? ` (${n} 條共線視為 1 條)` : "";
      $("hud").textContent = `比例尺:已選第一條${extra} — 請選第二條平行線(Esc 取消)`;
    } else if (dn === 2) {
      const before = file.scaleRuler;
      try { bgCreateScaleRulerByTwoLines(); } catch (_) {}
      if (file.scaleRuler && file.scaleRuler !== before) {
        exitScaleRulerPending();
        clearAllBgSelection(file);
        $("hud").textContent = "比例尺已建立 — 移動滑鼠調整位置,點擊確定 / Esc 取消";
        startScaleRulerDrag();
      } else {
        clearAllBgSelection(file);
        $("hud").textContent = "比例尺:兩線無效或已取消,請重新選取第一條平行線(Esc 取消)";
      }
    } else {
      $("hud").textContent = `比例尺:已選 ${dn} 條獨立線(需剛好 2 條)— Cmd/Ctrl+點擊移除多餘,或 Esc 重來`;
    }
  } else if (state.originPending) {
    if (dn === 0) {
      $("hud").textContent = "座標原點:請選第一條相交線(Esc 取消);完成後同平面其他頁面會一起對齊";
    } else if (dn === 1) {
      const extra = n > 1 ? ` (${n} 條共線視為 1 條)` : "";
      $("hud").textContent = `座標原點:已選第一條${extra} — 請選第二條相交線(Esc 取消);完成後同平面其他頁面會一起對齊`;
    } else if (dn >= 2) {
      // dn ≥ 2:嘗試建立(若多條共同收斂到一點 → 用該點;否則失敗)
      const before = file.planeOrigin;
      try { bgCreatePlaneOrigin(); } catch (_) {}
      if (file.planeOrigin && file.planeOrigin !== before) {
        exitOriginPending();
        clearAllBgSelection(file);
        setTool("select");
      } else {
        // 不收斂或失敗 → 維持 pending,清掉重來
        clearAllBgSelection(file);
        $("hud").textContent = `座標原點:${dn} 條獨立線交點不收斂,請重新選取第一條相交線(Esc 取消);完成後同平面其他頁面會一起對齊`;
      }
    }
  } else if (state.measurePending) {
    if (n === 0) {
      $("hud").textContent = "標示距離:請選第一條線(Esc 取消)";
    } else if (n === 1) {
      // 暫顯示單線長度,但 pending 仍開放讓使用者選第二條(轉成平行標示距離)
      bgComputeMeasureFromSelection();
      $("hud").textContent = `標示距離:${state.measure.label} — 再選第二條 = 兩線垂直距離(Esc 結束)`;
      render();
    } else if (n === 2) {
      if (bgComputeMeasureFromSelection()) {
        exitMeasurePending();
        $("hud").textContent = `標示距離:${state.measure.label}(Esc 清除)`;
        render();
      } else {
        clearAllBgSelection(file);
        $("hud").textContent = "標示距離:兩線無效,請重新選取第一條線(Esc 取消)";
      }
    } else {
      $("hud").textContent = `標示距離:已選 ${n} 條(需 1 或 2 條)— Cmd/Ctrl+點擊移除多餘,或 Esc 重來`;
    }
  } else if (state.sectionLinkPending) {
    // 切面關聯:dn===1 → 立刻跳出對話框(不等 Enter);dn>1 → 提示需清除多餘
    if (dn === 0) {
      $("hud").textContent = "切面:請選底圖切線(Esc 取消)";
    } else if (dn === 1) {
      const dlg = document.getElementById("sectionLinkDialog");
      const already = dlg && dlg.classList.contains("active");
      if (!already) {
        const lines = _selectedBgLinesAsWorld(file);
        if (lines.length) openSectionLinkDialog(file, lines[0]);
      }
    } else {
      $("hud").textContent = `切面:選到 ${dn} 條獨立線,切線必須是單一條 — 請 Cmd/Ctrl+點擊移除多餘`;
    }
  }
}
$("btnCalibrate") && ($("btnCalibrate").onclick = calibratePlane);
// 重新計算 3D 座標(當頁):3D 永遠是 live 算的,本鈕只跑校準變動共同收尾
//   (rank 失效 + globalJoint 重 infer + UI 重整 + 重畫)當作緊急 manual safety net。
//   實際上會跨頁全模型刷新(因為 globalJoint / rank 是 model-wide);命名「當頁」是
//   使用情境語意 — 「我剛改了這頁的校準,幫我刷一遍」。
$("btnRecomputeWorld") && ($("btnRecomputeWorld").onclick = () => {
  const f = getActiveFile();
  const pg = getPage();
  if (!f || !pg || pg._orphan) { alert("請先選擇一個有效頁面"); return; }
  pushUndo();
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  if ($("hud")) $("hud").textContent = "已重算 3D 座標(本頁觸發 ・ 全模型同步刷新)";
});
// 座標原點(工具列):統一行為(原本「座標原點」+「新座標原點」合併為單一按鈕)
//   1) 選取模式下選了 1 個節點 → 直接以節點為原點
//   2) 沒選節點 + bg 模式還沒選線 → 進入底圖選 2 條相交線
//   3) bg 模式下已經選了 2 條相交線 → 立刻以交點為原點
//   每個分支都會用 _applyNewPlaneOriginToAllSamePlane 傳播:同平面其他頁面跟著同步原點,並重算切面 cutValue / 目標 page.z
$("btnPlaneOrigin") && ($("btnPlaneOrigin").onclick = () => {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  // 捷徑 (1):選取模式下 1 個節點被選中 → 立刻以節點為原點(propagate)
  if (state.selection && state.selection.joints && state.selection.joints.size === 1) {
    const jid = [...state.selection.joints][0];
    const j = jointById(jid);
    if (j) {
      const r = _applyNewPlaneOriginToAllSamePlane(file, { x: j.x, y: j.y });
      if ($("hud")) {
        const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
        $("hud").textContent = `座標原點已設為節點 J${displayJointId(j)}・同平面其他 ${r.changed} 頁已同步對齊${slTail}`;
      }
      return;
    }
  }
  // 捷徑 (3):bg 模式下已選 ≥ 2 條相交線 → 立刻以交點為原點(propagate)
  if (file.selectedBgPaths && file.selectedBgPaths.size >= 2) {
    const distinct = distinctSelectedLineCount(file);
    if (distinct >= 2) {
      const pt = bgComputeOriginFromSelection(file);
      if (pt) {
        const r = _applyNewPlaneOriginToAllSamePlane(file, { x: pt.x, y: pt.y });
        if ($("hud")) {
          const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
          $("hud").textContent = `座標原點已設定・同平面其他 ${r.changed} 頁已同步對齊${slTail}`;
        }
        return;
      }
    }
  }
  // 一般流程 (2):進入底圖模式等待選 2 條相交線
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
  if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  clearSelection();
  clearAllBgSelection(file);
  state.originPending = true;
  if (state.tool !== "selectBg") setTool("selectBg");
  $("btnPlaneOrigin").classList.add("active");
  $("hud").textContent = "座標原點:請選第一條相交線(Esc 取消);完成後同平面其他頁面會一起對齊";
  render();
});
// 修正本檔原點:只動本檔的 planeOrigin + pg.z + sectionLinks cutValue,其他檔案不動;完成後自動跳全局校準
$("btnFixLocalOrigin") && ($("btnFixLocalOrigin").onclick = () => {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  // 捷徑 (1):選 1 個節點 → 立刻以節點為原點(僅本檔)
  if (state.selection && state.selection.joints && state.selection.joints.size === 1) {
    const jid = [...state.selection.joints][0];
    const j = jointById(jid);
    if (j) {
      const prev = state.originPending;
      state.originPending = "local";
      bgCreatePlaneOrigin();
      state.originPending = prev;
      return;
    }
  }
  // 捷徑 (3):bg 模式已選 ≥ 2 條 → 立刻取交點(僅本檔)
  if (file.selectedBgPaths && file.selectedBgPaths.size >= 2) {
    const distinct = distinctSelectedLineCount(file);
    if (distinct >= 2) {
      const prev = state.originPending;
      state.originPending = "local";
      bgCreatePlaneOrigin();
      state.originPending = prev;
      return;
    }
  }
  // 一般流程 (2):進入底圖模式等待選 2 條相交線
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
  if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  clearSelection();
  clearAllBgSelection(file);
  state.originPending = "local";
  if (state.tool !== "selectBg") setTool("selectBg");
  $("btnFixLocalOrigin").classList.add("active");
  $("hud").textContent = "修正本檔原點:請選第一條相交線(Esc 取消);只動本檔 planeOrigin pixel,其他全不動";
  render();
});
export function exitOriginPending() {
  if (!state.originPending) return;
  state.originPending = false;
  if ($("btnFixLocalOrigin")) $("btnFixLocalOrigin").classList.remove("active");
  updatePlaneOriginButton && updatePlaneOriginButton();
}
// 把 file 上所有主切面關聯的 cutValue 用「目前 planeOrigin」重新算,並同步目標檔 page.z。
// 何時呼叫:任何讓 file.planeOrigin 變動的動作之後(設定 / 修改 / 重設 都算)。
// 設計信念:p1 / p2 是像素,不會跟著原點移動;cutValue 是世界座標,原點換了就會位移,
//   不重算的話切面就會跑到錯誤的世界 plane 上(目標檔的 page.z 也會跟錯誤的 cutValue 對不上)。
export function _resyncSectionLinksForFile(file) {
  if (!file || !Array.isArray(file.sectionLinks) || !file.sectionLinks.length) {
    return { slUpdated: 0, tgtZUpdated: 0 };
  }
  let slUpdated = 0, tgtZUpdated = 0;
  const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
  const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
  const factor = Math.pow(10, decimals);
  for (const e of file.sectionLinks) {
    if (e.autoProp) continue;
    const info = _analyzeSectionLineAxis(file, e);
    if (!info) continue;
    e.cutAxis = info.cutAxis;
    e.cutValue = info.cutValue;
    slUpdated++;
    const newZ = Math.round(e.cutValue * factor) / factor;
    for (const tid of (e.targetFileIds || [])) {
      const tf = state.files.find(x => x.id === tid);
      if (!tf || !tf.pages) continue;
      const tp = tf.pages[0];
      if (!tp || !tp.plane) continue;
      if (depthOf[tp.plane] !== e.cutAxis) continue;
      if (tp.z === newZ) continue;
      tp.z = newZ;
      tgtZUpdated++;
    }
  }
  return { slUpdated, tgtZUpdated };
}
// 設定 / 重設座標原點:跨平面對齊整個世界框架。
//   作法:
//     1) 在「設原點之前」先記錄目標物理點(將要當新原點的位置)在 *目前舊原點* 框架下的世界座標 Wnew
//     2) 本頁 planeOrigin 改成新像素位置;本頁 page.z 減掉 Wnew[depth](通常 → 0)
//     3) 其他每個檔案(任何平面):planeOrigin 改成「物理點 Wnew 在該檔的舊像素」,
//        每頁的 page.z 各自減掉 Wnew[該頁深度軸];整個世界框架同步平移 -Wnew。
//   這樣:節點 / 桿件 / 切面標線的「物理位置」都不動;只有世界座標的數字改了(平移到新原點)。
//   切面 cutValue、目標檔 page.z 在後段自動重算 → 切面線仍維持在原本的標示位置。
function _applyNewPlaneOriginToAllSamePlane(activeFile, newPxOnActive) {
  if (!activeFile) return { changed: 0 };
  const activePage = activeFile.pages && activeFile.pages[state.pageIdx];
  if (!activePage) return { changed: 0 };
  const plane = activePage.plane;
  if (!plane) { alert("此頁尚未設定『世界平面』,無法傳播。"); return { changed: 0 }; }
  // 「不是新的原點」→ 不做事(避免 pushUndo / 重算切面)
  const oldO = activeFile.planeOrigin;
  if (oldO && Math.abs(oldO.x - newPxOnActive.x) < 1e-6 && Math.abs(oldO.y - newPxOnActive.y) < 1e-6) {
    return { changed: 0, slUpdated: 0, tgtZUpdated: 0, noChange: true };
  }
  // 必須要有 ratio 才能換算
  const haveRatio = !!((activeFile.scaleRuler && activeFile.scaleRuler.ratio > 0) || state.scale);
  if (!haveRatio) {
    // 沒 ratio:只設本頁,不做傳播
    pushUndo();
    activeFile.planeOrigin = { x: newPxOnActive.x, y: newPxOnActive.y };
    updateCalibrateButton(); updatePlaneOriginButton && updatePlaneOriginButton();
    if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
    else { refreshLists && refreshLists(); render(); }
    return { changed: 0 };
  }
  // 用「舊」origin 計算 Wnew(物理點變新世界原點時,在舊世界座標下的 3D 座標)
  const Wnew = joint2DToWorld3D(activeFile, activePage, { x: newPxOnActive.x, y: newPxOnActive.y });
  if (!Wnew) return { changed: 0 };
  pushUndo();
  // 全世界框架要平移 -Wnew。先處理本頁:
  //   • planeOrigin → 直接設成新像素位置(in-plane 軸 0 點)
  //   • page.z(深度軸值) → 減掉 Wnew[depth];對本頁就是減掉自己的舊 page.z → 變 0
  //   為避免浮點累積誤差(ratio 有小數 → joint2DToWorld3D 結果可能多到 10⁻¹³ 級別的尾數),
  //   每個 page.z 減完後都四捨五入到顯示精度(state.coordDecimals);若離整數很近也吃進整數。
  const depthOfPlane = { XY: "z", XZ: "y", YZ: "x" };
  const _zDecimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
  const _zFactor = Math.pow(10, _zDecimals);
  const _roundZ = (v) => {
    if (!Number.isFinite(v)) return v;
    const r = Math.round(v * _zFactor) / _zFactor;
    return r === 0 ? 0 : r;     // 規範化 -0 → 0
  };
  activeFile.planeOrigin = { x: newPxOnActive.x, y: newPxOnActive.y };
  {
    const dA = depthOfPlane[activePage.plane];
    if (dA && Number.isFinite(Wnew[dA])) {
      activePage.z = _roundZ((Number.isFinite(activePage.z) ? activePage.z : 0) - Wnew[dA]);
    }
  }
  // 其他所有檔案(不分平面,只要有 planeOrigin + scaleRuler):把世界框架同步平移 -Wnew
  //   做法:在 *舊* 框架下,找出物理點 Wnew 在該檔的像素 → 設為新 planeOrigin;
  //         該檔每頁的 page.z 各自減去 Wnew[該頁深度軸](並四捨五入到顯示精度)。
  let changed = 0;
  for (const f of state.files) {
    if (f === activeFile) continue;
    if (!f.pages) continue;
    if (!f.scaleRuler || !(f.scaleRuler.ratio > 0)) continue;
    if (!f.planeOrigin) continue;
    const P0 = f.pages[0];
    if (!P0 || !P0.plane) continue;
    const inv = world3DToJoint2D(f, P0, Wnew, { tol: 1e9 });
    if (!inv || !inv.ok) continue;
    f.planeOrigin = { x: inv.x, y: inv.y };
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan || !pg.plane) continue;
      const d = depthOfPlane[pg.plane];
      if (d && Number.isFinite(Wnew[d])) {
        pg.z = _roundZ((Number.isFinite(pg.z) ? pg.z : 0) - Wnew[d]);
      }
    }
    changed++;
  }
  // ── 重設原點 → 切線像素不動,只更新 cutValue(用新原點重算)──
  //   設計:p1 / p2 是使用者在「畫面上」標的物理位置,不該因為原點換了就移動。
  //   原點 → 世界座標數值會變,所以 cutValue 跟著重算。因為「全世界框架」都跟著平移
  //   (不只本平面),所以 *所有* 檔案上的切面 cutValue 都要重算 — 不能只跑同平面那幾個。
  let slUpdated = 0, tgtZUpdated = 0;
  for (const f of state.files) {
    const fp = f.pages && f.pages[0];
    if (!fp || !fp.plane) continue;
    const r = _resyncSectionLinksForFile(f);
    slUpdated += r.slUpdated;
    tgtZUpdated += r.tgtZUpdated;
  }
  if (slUpdated) {
    console.log(`[座標原點] 切面 cutValue 重算 ${slUpdated} 條;目標 page.z 同步 ${tgtZUpdated} 個`);
  }
  // 重建 rank / global / 重畫
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  updateCalibrateButton(); updatePlaneOriginButton && updatePlaneOriginButton();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  refreshLists && refreshLists(); render();
  return { changed, slUpdated, tgtZUpdated };
}

// 修正當頁原點(極簡 — 只動本檔 planeOrigin pixel,別的全不動):
//   設計信念:使用者單純想「把這個檔的原點 pixel 移到正確位置」,不希望任何 3D 數字被動到。
//   ─ 本檔 planeOrigin pixel → 改;這意味著本檔 joint 的 in-plane 世界座標會跟著變動 −Δ·ratio
//   ─ 本檔每頁 pg.z(depth 軸值)→ **不動**(因為 in-plane 移動不該影響深度軸)
//   ─ 本檔 sectionLinks 的 p1 / p2 / cutValue / cutAxis → **不動**
//     (p1/p2 是 pixel 不會跟著改;cutValue 故意不重算 → 該切面在 3D 仍代表同一個軸向平面)
//   ─ 其他檔案的 planeOrigin / pg.z / sectionLinks → **完全不動**
//   ─ joint 像素位置(joint.x / joint.y)→ 不動(它們是 file 屬性,跟原點獨立)
//
//   ⚠ 副作用:這個動作會讓「本檔的 3D 世界座標」跟「其他檔 + sectionLinks 的 3D 世界座標」
//      暫時不一致。沒問題 — 設計上要求呼叫端在執行後跳「全局原點校準(globalJoint)」,
//      它會根據 globalJoint 自動重新對齊各檔(調整每檔的 planeOrigin / pg.z)。
function _applyNewPlaneOriginLocalOnly(activeFile, newPxOnActive) {
  if (!activeFile) return { changed: 0 };
  const oldO = activeFile.planeOrigin;
  if (oldO && Math.abs(oldO.x - newPxOnActive.x) < 1e-6 && Math.abs(oldO.y - newPxOnActive.y) < 1e-6) {
    return { changed: 0, noChange: true };
  }
  pushUndo();
  // 只改 pixel — 不算 Wnew、不動 pg.z、不重算 cutValue、不碰其他檔
  activeFile.planeOrigin = { x: newPxOnActive.x, y: newPxOnActive.y };
  // joint 世界座標跟著變,rank 需要重算
  invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  updateCalibrateButton && updateCalibrateButton();
  updatePlaneOriginButton && updatePlaneOriginButton();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  refreshLists && refreshLists();
  render();
  return { changed: 1 };
}

// 平面座標原點:剛好選了 2 條 bg 線 → 直接取交點建原點;其他情況一律走 pending 流程
// (避免「使用者之前選過 joint 進到底圖模式後不小心觸發 1-joint 模式」)
$("bgEditPlaneOrigin") && ($("bgEditPlaneOrigin").onclick = () => {
  const file = getActiveFile();
  const bgN = (file && file.selectedBgPaths) ? file.selectedBgPaths.size : 0;
  if (bgN === 2) bgCreatePlaneOrigin();
  else $("btnPlaneOrigin").click();
});

// ---------- 切面關聯 / 衍生模型 ----------
// 切面關聯 + 衍生模型 + populateSectionLinkJointsForFile + 對話框 (~1930 行)
// 實作搬到 src/tools/sectionLink.ts。需要的 helper 都已 export。
import {
  _restoreSectionLinkShapeMarquee,
  exitSectionLinkPending,
  openSectionLinkDialog,
  saveSectionLink,
  _getPageBoundsForFile,
  _computeOutsideMarkerLine,
  _getMergedSectionLinks,
  refreshSectionLinkList,
  _planeAxisInfo,
  _fileHasFullSetup,
  _planeAxisOf2D,
  _analyzeSectionLineAxis,
  _buildSectionLineForFile,
  _clipLineToBounds,
  _systemHasAnyPrimary,
  _planeConnectionGroups,
  _isFileParticipatingInSectionSystem,
  _computeSiblingTraceOnTarget,
  _computeDerivedEntriesForTarget,
  _deriveSectionLinksFor,
  _populateSectionLinkJointsForFile,
  renderFileThumb,
  setupSectionLinkDialogDrag,
  wireSectionLinkButton,
} from "../tools/sectionLink";
// 切面按鈕 onclick:延後到這支 module 跑到這裡才綁(`$` / `state` 等到此時都已 init)
//   避免 sectionLink.ts module top-level 直接綁 → TDZ ReferenceError
wireSectionLinkButton();
export {
  _restoreSectionLinkShapeMarquee,
  exitSectionLinkPending,
  openSectionLinkDialog,
  saveSectionLink,
  _getPageBoundsForFile,
  _computeOutsideMarkerLine,
  _getMergedSectionLinks,
  refreshSectionLinkList,
  _planeAxisInfo,
  _fileHasFullSetup,
  _planeAxisOf2D,
  _analyzeSectionLineAxis,
  _buildSectionLineForFile,
  _clipLineToBounds,
  _systemHasAnyPrimary,
  _planeConnectionGroups,
  _isFileParticipatingInSectionSystem,
  _computeSiblingTraceOnTarget,
  _computeDerivedEntriesForTarget,
  _deriveSectionLinksFor,
  _populateSectionLinkJointsForFile,
  renderFileThumb,
  setupSectionLinkDialogDrag,
  wireSectionLinkButton,
};

// 標示距離(智能,讀):依目前選取數量分支(支援 bgEdit 與 select 模式)
//   ≥ 1 條 → 立即計算 + 進入沿線滑動,點擊確認 / Esc 取消
//   無選取 + bgEdit → 進入 pending 流程逐條點選
$("bgEditMeasure") && ($("bgEditMeasure").onclick = () => startMeasureFromCurrentSelection());
$("bgEditMeasureSelect")   && ($("bgEditMeasureSelect").onclick   = () => reenterMeasureSlide());
$("bgEditMeasureMove")     && ($("bgEditMeasureMove").onclick     = () => reenterMeasureSlide());
$("bgEditMeasureDelLast")  && ($("bgEditMeasureDelLast").onclick  = () => deleteMeasurement());
$("bgEditMeasureClearAll") && ($("bgEditMeasureClearAll").onclick = () => clearAllMeasurements());

// 線到原點最短距離 / 軸距離 — 共用前置檢查:選取必須是「多線視為同一條」,且檔案需有原點
function _validateLineToOrigin(file) {
  console.log("[線到原點 validate] file=", file && file.name,
    "planeOrigin=", file && file.planeOrigin,
    "scaleRuler=", file && file.scaleRuler,
    "state.scale=", state.scale,
    "selectedBgPaths.size=", file && file.selectedBgPaths && file.selectedBgPaths.size);
  if (!file) { alert("請先載入底圖"); return null; }
  if (!file.planeOrigin) { alert(`請先設定平面座標原點(目前檔案「${file.name}」尚未設定原點)`); return null; }
  if (!state.scale || state.scale <= 0) {
    alert(`請先建立比例尺(目前檔案「${file.name}」尚無比例尺;有原點但無比例尺無法換算實際距離)`);
    return null;
  }
  if (!file.selectedBgPaths || file.selectedBgPaths.size === 0) {
    alert("請先選取一條(或多條共線)的底圖直線"); return null;
  }
  const distinct = distinctSelectedLineCount(file);
  const lines = _selectedBgLinesAsWorld(file);
  console.log("[線到原點 validate] selectedBgPaths=", [...file.selectedBgPaths],
    "distinctLineCount=", distinct, "linesAsWorld.length=", lines.length, "lines=", lines);
  if (distinct === 0) {
    alert(`選取的 ${file.selectedBgPaths.size} 條 bg 路徑都不是「單一線段」(可能是多段折線 / 曲線 / 矩形)。請先用「切成直線」拆分,再選一條直線`);
    return null;
  }
  if (distinct > 1) {
    alert(`選取共有 ${distinct} 條不同方向的線(共線視為一條)。線到原點功能需要所有選取共線 — 請只選同一條線(可多段共線)`);
    return null;
  }
  if (!lines.length) {
    alert("無法取出選取線段的世界座標(可能是 bg 線結構異常)");
    return null;
  }
  // 取最長的一段作為代表(最穩定的線方向)
  let rep = lines[0], maxLen = 0;
  for (const L of lines) {
    const d = Math.hypot(L.p2.x - L.p1.x, L.p2.y - L.p1.y);
    if (d > maxLen) { maxLen = d; rep = L; }
  }
  return rep;
}
// 共用收尾:把計算好的距離寫進 state.measure 並進入 slide 模式(沿原線方向滑動)
//   結束後 click 會觸發 commitMeasureSlide(已存在的 wrap.click handler);Esc 還原並結束
function _setOriginDistMeasure(rep, p1, p2, distWorld, axisName) {
  const distMm = distWorld / state.scale;
  const u = state.unitName || "mm";
  const labelTxt = `${distMm.toFixed(_measureDec())} ${u}`;
  // slide 方向 = 原線方向(讓使用者沿原線拖移,p1/p2 同步位移、距離不變)
  const lineDx = rep.p2.x - rep.p1.x, lineDy = rep.p2.y - rep.p1.y;
  const lineLen = Math.hypot(lineDx, lineDy) || 1;
  pushUndo();
  state.measure = {
    kind: "lineToOrigin",
    p1: { x: p1.x, y: p1.y },
    p2: { x: p2.x, y: p2.y },
    distance: distWorld,
    label: labelTxt,
    dx: lineDx / lineLen, dy: lineDy / lineLen,
    _backup: { p1: { ...p1 }, p2: { ...p2 } },
    sliding: true,
  };
  $("hud").textContent = `${axisName}原點距離 = ${labelTxt} — 拖游標沿線滑動位置,點擊確認 / Esc 還原`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}
$("bgEditOriginDistH") && ($("bgEditOriginDistH").onclick = () => {
  console.log("[水平原點距離 click]");
  const file = getActiveFile();
  const rep = _validateLineToOrigin(file);
  if (!rep) return;
  const o = file.planeOrigin;
  const dx = rep.p2.x - rep.p1.x, dy = rep.p2.y - rep.p1.y;
  // 水平距離:線在 y=O.y 處的 x 座標 → 與 O.x 的差。若線是水平(dy ≈ 0),無法在 y=O.y 處取交點(除非線就在那高度)
  if (Math.abs(dy) < 1e-9) {
    alert("選取的線是水平線,無「水平原點距離」(請改用「垂直原點距離」或「最短距離」)");
    return;
  }
  const t = (o.y - rep.p1.y) / dy;
  const xAtOriginY = rep.p1.x + t * dx;
  const distWorld = Math.abs(xAtOriginY - o.x);
  const intersect = { x: xAtOriginY, y: o.y };
  console.log(`[水平原點距離] world=${distWorld.toFixed(4)}・原點 (${o.x.toFixed(2)}, ${o.y.toFixed(2)})・交點 (${intersect.x.toFixed(2)}, ${intersect.y.toFixed(2)})`);
  _setOriginDistMeasure(rep, { x: o.x, y: o.y }, intersect, distWorld, "水平");
});
$("bgEditOriginDistV") && ($("bgEditOriginDistV").onclick = () => {
  console.log("[垂直原點距離 click]");
  const file = getActiveFile();
  const rep = _validateLineToOrigin(file);
  if (!rep) return;
  const o = file.planeOrigin;
  const dx = rep.p2.x - rep.p1.x, dy = rep.p2.y - rep.p1.y;
  // 垂直距離:線在 x=O.x 處的 y 座標 → 與 O.y 的差。若線是垂直(dx ≈ 0),無交點(除非線就在那 X)
  if (Math.abs(dx) < 1e-9) {
    alert("選取的線是垂直線,無「垂直原點距離」(請改用「水平原點距離」或「最短距離」)");
    return;
  }
  const t = (o.x - rep.p1.x) / dx;
  const yAtOriginX = rep.p1.y + t * dy;
  const distWorld = Math.abs(yAtOriginX - o.y);
  const intersect = { x: o.x, y: yAtOriginX };
  console.log(`[垂直原點距離] world=${distWorld.toFixed(4)}・原點 (${o.x.toFixed(2)}, ${o.y.toFixed(2)})・交點 (${intersect.x.toFixed(2)}, ${intersect.y.toFixed(2)})`);
  _setOriginDistMeasure(rep, { x: o.x, y: o.y }, intersect, distWorld, "垂直");
});
$("bgEditOriginDistMin") && ($("bgEditOriginDistMin").onclick = () => {
  console.log("[與原點最短距離 click]");
  const file = getActiveFile();
  const rep = _validateLineToOrigin(file);
  if (!rep) return;
  const o = file.planeOrigin;
  const dx = rep.p2.x - rep.p1.x, dy = rep.p2.y - rep.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) { alert("線段長度太短,無法判定方向"); return; }
  // 原點投影到線上得到垂足
  const t = ((o.x - rep.p1.x) * dx + (o.y - rep.p1.y) * dy) / (len * len);
  const foot = { x: rep.p1.x + t * dx, y: rep.p1.y + t * dy };
  const distWorld = Math.hypot(foot.x - o.x, foot.y - o.y);
  console.log(`[與原點最短距離] world=${distWorld.toFixed(4)}・原點 (${o.x.toFixed(2)}, ${o.y.toFixed(2)})・垂足 (${foot.x.toFixed(2)}, ${foot.y.toFixed(2)})`);
  _setOriginDistMeasure(rep, { x: o.x, y: o.y }, foot, distWorld, "最短");
});

// 比例尺(智能):依目前選取數量分支
//   1 條 bg 線 → 用該線段長度法(bgCreateScaleRuler)
//   2 條 bg 線 → 用兩線距離法 + 進入沿線拖曳
//   其他(0 條 / 3+ 條) → 走 pending 流程,逐條提示點選
$("bgEditScaleRuler") && ($("bgEditScaleRuler").onclick = () => {
  const file = getActiveFile();
  const bgN = (file && file.selectedBgPaths) ? file.selectedBgPaths.size : 0;
  if (bgN === 1) {
    bgCreateScaleRuler();
    return;
  }
  if (bgN === 2) {
    const before = file.scaleRuler;
    bgCreateScaleRulerByTwoLines();
    if (file.scaleRuler && file.scaleRuler !== before) {
      clearAllBgSelection(file);
      startScaleRulerDrag();
    }
    return;
  }
  // 0 條或 3+ 條 → pending 流程
  $("btnScaleRuler").click();
});
$("bgEditScaleRulerMove") && ($("bgEditScaleRulerMove").onclick = () => startScaleRulerDrag());

// ---------- 在 bg svg 中加一條新 <line>(world / bgSvg-local 座標)----------
// 注意:bgSvg viewBox 不一定 = world coords。pdf.js / cached SVG 各自有不同 viewBox。
// 為了座標一致,新 line 寫到 bgSvg 內時要用 bgSvg 的「local」座標(getCTM inverse)。
// 簡化做法:先把 world 座標經 bgSvg 的 getScreenCTM 反推到 local。
function _worldToBgLocal(bgSvgEl, wx, wy) {
  const ctm = bgSvgEl.getScreenCTM();
  if (!ctm) return { x: wx, y: wy };
  // world → screen → 反 ctm → local
  const r = wrap.getBoundingClientRect();
  const screenX = wx * state.zoom + state.panX + r.left;
  const screenY = wy * state.zoom + state.panY + r.top;
  const inv = ctm.inverse();
  const sp = bgSvgEl.createSVGPoint(); sp.x = screenX; sp.y = screenY;
  const lp = sp.matrixTransform(inv);
  return { x: lp.x, y: lp.y };
}
// 把 bgSvg 內現有的「原始 PDF / DXF 內容」包進一個 <g class="bg-orig"> 群組(若尚未包過)。
//   目的:applyBgRotation 套 clipRect 時只 clip 原始底圖,使用者新增的 bg 線(標 data-bg-user="1")
//   留在 bgSvg root 不被 clip,可以延伸到拆分頁範圍外仍然顯示。
//   同時確保 <defs> 內有 <clipPath id="bgOrigClip">,讓 applyBgRotation 用 SVG 原生 clip-path 屬性
//   套用(比 CSS clip-path 在 <g> 上更可靠 — 不同瀏覽器對 reference box 的解讀不一致)。
export function _ensureBgOrigGroup(bgSvgEl) {
  if (!bgSvgEl) return null;
  const ns = "http://www.w3.org/2000/svg";
  // 確保 defs + clipPath 元素存在
  let defs = bgSvgEl.querySelector(":scope > defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    bgSvgEl.insertBefore(defs, bgSvgEl.firstChild);
  }
  if (!defs.querySelector("#bgOrigClip")) {
    const cp = document.createElementNS(ns, "clipPath");
    cp.id = "bgOrigClip";
    cp.setAttribute("clipPathUnits", "userSpaceOnUse");
    defs.appendChild(cp);
  }
  let orig = bgSvgEl.querySelector(":scope > g.bg-orig");
  if (orig) return orig;
  orig = document.createElementNS(ns, "g");
  orig.setAttribute("class", "bg-orig");
  // 把現有子節點搬進 orig,跳過 <defs>(保留在 root)與 data-bg-user="1"(使用者線,留在 root)
  const kids = Array.from(bgSvgEl.childNodes);
  for (const k of kids) {
    if (k.nodeType === 1) {
      const tag = k.tagName ? k.tagName.toLowerCase() : "";
      if (tag === "defs") continue;
      if (k.dataset && k.dataset.bgUser === "1") continue;
    }
    orig.appendChild(k);
  }
  bgSvgEl.appendChild(orig);
  return orig;
}

// 從世界座標 (p1, p2) 在 bgSvg root 上建立一條使用者線(<line> 元素)。
//   不更新 file.userBgLines / cachedBgSvg — 由呼叫端決定。提供給 addBgLineWorld 與
//   undo/redo 後 syncUserBgLinesToDom 共用,確保兩者建立的 DOM 結構完全一致。
function _appendUserBgLineDom(bgSvgEl, p1World, p2World, idx, dasharray) {
  const ns = "http://www.w3.org/2000/svg";
  const a = _worldToBgLocal(bgSvgEl, p1World.x, p1World.y);
  const b = _worldToBgLocal(bgSvgEl, p2World.x, p2World.y);
  const ln = document.createElementNS(ns, "line");
  ln.setAttribute("x1", a.x.toFixed(3));
  ln.setAttribute("y1", a.y.toFixed(3));
  ln.setAttribute("x2", b.x.toFixed(3));
  ln.setAttribute("y2", b.y.toFixed(3));
  ln.setAttribute("stroke", "#000");
  ln.setAttribute("fill", "none");
  ln.setAttribute("vector-effect", "non-scaling-stroke");
  if (dasharray) ln.setAttribute("stroke-dasharray", dasharray);
  ln.classList.add("bg-stroke");
  ln.dataset.bgIdx = String(idx);
  ln.dataset.bgUser = "1";
  bgSvgEl.appendChild(ln);          // bgSvg root(bg-orig 群組外,不被 clip)
  return ln;
}

export function addBgLineWorld(file, p1World, p2World, opts) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return null;
  let maxIdx = -1;
  bgSvgEl.querySelectorAll("[data-bg-idx]").forEach(el => {
    const n = parseInt(el.dataset.bgIdx, 10);
    if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
  });
  const newIdx = maxIdx + 1;
  const dasharray = (opts && opts.dasharray) || null;
  const ln = _appendUserBgLineDom(bgSvgEl, p1World, p2World, newIdx, dasharray);
  // 紀錄到 file.userBgLines,讓 undo/redo 與專案存檔可以重建
  if (!Array.isArray(file.userBgLines)) file.userBgLines = [];
  file.userBgLines.push({
    idx: newIdx,
    x1: p1World.x, y1: p1World.y,
    x2: p2World.x, y2: p2World.y,
    dasharray: dasharray || undefined,
  });
  try { file.cachedBgSvg = new XMLSerializer().serializeToString(bgSvgEl); } catch (_) {}
  updateBgStrokeWidth();
  return { idx: newIdx, el: ln };
}

// 把 file.userBgLines(權威資料)同步到 bgSvg DOM:先移除既有的 [data-bg-user="1"] 線,
//   再依資料逐條重建。專供 undo / redo 使用。
export function syncUserBgLinesToDom(file) {
  if (!file) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  bgSvgEl.querySelectorAll('[data-bg-user="1"]').forEach(el => el.remove());
  const lines = Array.isArray(file.userBgLines) ? file.userBgLines : [];
  for (const ln of lines) {
    _appendUserBgLineDom(
      bgSvgEl,
      { x: ln.x1, y: ln.y1 },
      { x: ln.x2, y: ln.y2 },
      ln.idx,
      ln.dasharray || null
    );
  }
  try { file.cachedBgSvg = new XMLSerializer().serializeToString(bgSvgEl); } catch (_) {}
  updateBgStrokeWidth();
}

// 畫直線 / 畫虛線 / 複製線 / 中分線 / 等分線 相關按鈕的 active 視覺狀態
export function _refreshBgDrawButtonStates() {
  const isDashed = !!(state.bgDrawLine && state.bgDrawLine.active && state.bgDrawLine.dasharray);
  const isSolid  = !!(state.bgDrawLine && state.bgDrawLine.active && !state.bgDrawLine.dasharray);
  const dl = $("bgEditDrawLine");
  if (dl) dl.classList.toggle("active", isSolid);
  const dd = $("bgEditDrawDashed");
  if (dd) dd.classList.toggle("active", isDashed);
  const cp = $("bgEditCopyLine");
  if (cp) cp.classList.toggle("active", !!(state.bgCopyLine && state.bgCopyLine.active));
  const bs = $("bgEditBisector");
  if (bs) bs.classList.toggle("active", !!(state.bgBisector && state.bgBisector.active));
  const eq = $("bgEditEquidist");
  if (eq) eq.classList.toggle("active", !!(state.bgEqui && state.bgEqui.active));
}

// ---------- 畫直線 / 畫虛線 / 複製線 / 中分線 / 等分線 / 切換虛線 ----------
// 12 個 bg 繪圖函式 + 6 個 button onclick wiring 全搬到 src/tools/bgDrawTools.ts
import {
  startBgDrawLine, commitBgDrawLineSecond,
  _captureSourceFromElement, startBgCopyLine, commitBgCopyLineDest,
  startBgBisector, updateBgBisectorPreview, commitBgBisector,
  startBgEqui, updateBgEquiPreview, commitBgEqui,
  bgToggleDashedOnSelection,
  exitBgDrawLine, exitBgCopyLine, exitBgBisector, exitBgEqui,
  wireBgDrawTools,
} from "../tools/bgDrawTools";
wireBgDrawTools();
export {
  startBgDrawLine, commitBgDrawLineSecond,
  _captureSourceFromElement, startBgCopyLine, commitBgCopyLineDest,
  startBgBisector, updateBgBisectorPreview, commitBgBisector,
  startBgEqui, updateBgEquiPreview, commitBgEqui,
  bgToggleDashedOnSelection,
  // 4 個 exit* — 之前已從 legacy export(measure.ts / sectionLink.ts 等 import 用),
  // 搬到 bgDrawTools.ts 後仍需從 legacy.ts re-export 維持下游 import 兼容
  exitBgDrawLine, exitBgCopyLine, exitBgBisector, exitBgEqui,
};
function startScaleRulerDrag() {
  const file = getActiveFile();
  if (!file || !file.scaleRuler) { alert("尚未建立比例尺。"); return; }
  pushUndo();
  state.scaleRulerDrag = {
    active: true,
    fileId: file.id,
    backup: {
      p1: { ...file.scaleRuler.p1 },
      p2: { ...file.scaleRuler.p2 },
    },
  };
  $("hud").textContent = "比例尺沿線移動:移動滑鼠預覽,點擊確定 / Esc 取消";
  render();
}
function _scaleRulerAxisUnit(sr) {
  const dx = sr.p2.x - sr.p1.x, dy = sr.p2.y - sr.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  // twoLines:p1→p2 垂直於參考線 → 旋轉 90°
  // 線段型:沿 p1→p2 方向
  if (sr.type === "twoLines") return { ux: -dy / len, uy: dx / len };
  return { ux: dx / len, uy: dy / len };
}
function updateScaleRulerDragPreview(clientX, clientY) {
  const drag = state.scaleRulerDrag;
  if (!drag || !drag.active) return;
  const file = state.files.find(f => f.id === drag.fileId);
  if (!file || !file.scaleRuler) return;
  const sr = file.scaleRuler;
  const u = _scaleRulerAxisUnit({ ...sr, p1: drag.backup.p1, p2: drag.backup.p2 });
  if (!u) return;
  const w = screenToWorld(clientX, clientY);
  // 投影:游標相對 backup 中點 → 沿軸 (ux, uy) 的純量
  const cx = (drag.backup.p1.x + drag.backup.p2.x) / 2;
  const cy = (drag.backup.p1.y + drag.backup.p2.y) / 2;
  const t = (w.x - cx) * u.ux + (w.y - cy) * u.uy;
  // 套到 p1/p2 = backup + t * 軸
  sr.p1.x = drag.backup.p1.x + u.ux * t;
  sr.p1.y = drag.backup.p1.y + u.uy * t;
  sr.p2.x = drag.backup.p2.x + u.ux * t;
  sr.p2.y = drag.backup.p2.y + u.uy * t;
  // HUD 顯示已位移多少 mm
  const ratio = state.scale ? state.scale : sr.ratio;
  const distMm = ratio ? t * ratio : t;
  $("hud").textContent = `比例尺沿線移動:位移 ${distMm.toFixed(1)} ${state.unitName || "mm"}(點擊確定 / Esc 取消)`;
  render();
}
function commitScaleRulerDrag() {
  // sr.p1/p2 已經是預覽位置 → 直接退出即「採用」
  state.scaleRulerDrag = null;
  $("hud").textContent = "比例尺沿線移動完成";
  render();
}
export function cancelScaleRulerDrag() {
  const drag = state.scaleRulerDrag;
  if (!drag) return;
  const file = state.files.find(f => f.id === drag.fileId);
  if (file && file.scaleRuler) {
    file.scaleRuler.p1 = drag.backup.p1;
    file.scaleRuler.p2 = drag.backup.p2;
  }
  state.scaleRulerDrag = null;
  $("hud").textContent = "比例尺沿線移動已取消";
  render();
}
$("ctxBgScaleRuler") && ($("ctxBgScaleRuler").onclick = (e) => { e.stopPropagation(); hideCtxMenu(); bgCreateScaleRuler(); });
$("bgEditSelectAll") && ($("bgEditSelectAll").onclick = () => withBusy("全選底圖線條中…", selectAllBgPaths));
$("bgEditClear")     && ($("bgEditClear").onclick    = () => withBusy("取消選取中…", () => clearAllBgSelection(getActiveFile())));
$("bgEditSplit")     && ($("bgEditSplit").onclick    = () => withBusy("拆分為直線中…", bgPathsSplitToLines));
$("bgEditToMember")  && ($("bgEditToMember").onclick = () => withBusy("轉為桿件中…", bgPathsToMembers));
$("bgEditDel")       && ($("bgEditDel").onclick      = () => withBusy("刪除中…", deleteSelectedBgPaths));
// ---------- 選取工具浮動面板 ----------
// updateSelectToolsVisibility / selToolsExtendAlong + 14 個按鈕 onclick + 面板 click 冒泡阻擋
// 搬到 src/ui/selectToolsPanel.ts;wireSelectToolsPanel() 由本檔延後 call。
// 同時保留 selToolsSelectAll / selToolsSelectJoints / selToolsSelectMembers / direction filter 等
// 從 tools/selectTools.ts 的 re-export(下游 ui/menubar / dialogs/... 仍可從 legacy.ts import)
import {
  selToolsSelectAll,
  selToolsSelectJoints,
  selToolsSelectMembers,
  _updateSelToolsFilterBtns,
  _classifyMemberDir,
  _memberPassesDirFilter,
  _toggleDirFilter,
} from "../tools/selectTools";
export {
  selToolsSelectAll,
  selToolsSelectJoints,
  selToolsSelectMembers,
  _updateSelToolsFilterBtns,
  _classifyMemberDir,
  _memberPassesDirFilter,
  _toggleDirFilter,
};
import {
  updateSelectToolsVisibility,
  selToolsExtendAlong,
  wireSelectToolsPanel,
} from "../ui/selectToolsPanel";
wireSelectToolsPanel();
export {
  updateSelectToolsVisibility,
  selToolsExtendAlong,
};

$("bgEditSelSquares")   && ($("bgEditSelSquares").onclick   = () => toggleShapeMarqueeMode("square"));
$("bgEditSelRects")     && ($("bgEditSelRects").onclick     = () => toggleShapeMarqueeMode("rect"));
$("bgEditSelCircles")   && ($("bgEditSelCircles").onclick   = () => toggleShapeMarqueeMode("circle"));
$("bgEditSelStraight") && ($("bgEditSelStraight").onclick = () => toggleShapeMarqueeMode("straight"));
$("bgEditSelStraightSolid") && ($("bgEditSelStraightSolid").onclick = () => toggleShapeMarqueeMode("straightSolid"));
$("bgEditSelDiagonals") && ($("bgEditSelDiagonals").onclick = () => toggleShapeMarqueeMode("diagonal"));
$("bgEditSelDashedDiagonals") && ($("bgEditSelDashedDiagonals").onclick = () => toggleShapeMarqueeMode("dashedDiagonal"));
$("bgEditClearShape")   && ($("bgEditClearShape").onclick   = () => clearAllShapeMarqueeModes());
$("bgEditMultiSelect") && ($("bgEditMultiSelect").onclick = () => toggleBgMultiSelect());
$("bgEditMarkIntersect") && ($("bgEditMarkIntersect").onclick = () => withBusy("計算交點中…", bgConvertToIntersections));
// 多線轉交點 + 桿件:組合操作
//   1. 加交點節點(只接受實際相交,不延伸)— bgConvertToIntersections strict
//   2. 視覺上把無實際相交的孤立線從選取剔除
//   3. 對「每條有 ≥ 2 個交點的線」依 t 排序,在連續兩個交點之間建桿件
//      (規則:桿件只能在交點與交點之間 — 端點到交點的尾段一律不建)
$("bgEditMarkIntersectAndMember") && ($("bgEditMarkIntersectAndMember").onclick = () =>
  withBusy("轉交點與桿件中…", async () => {
    const r = await bgConvertToIntersections({ strict: true });
    if (!r) return;
    const file = getActiveFile();
    // 視覺剔除:無實際相交的選取線
    if (file && file.selectedBgPaths && r.participatingSrcs) {
      const bgSvgEl = document.getElementById("bgSvg");
      const before = file.selectedBgPaths.size;
      const keep = new Set();
      for (const k of file.selectedBgPaths) {
        if (r.participatingSrcs.has(String(k))) keep.add(k);
        else if (bgSvgEl) {
          const el2 = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(k))}"]`);
          if (el2) el2.classList.remove("bg-selected");
        }
      }
      file.selectedBgPaths = keep;
      const dropped = before - keep.size;
      if (dropped > 0) $("hud").textContent = `已剔除 ${dropped} 條無實際相交的孤立線,剩 ${keep.size} 條`;
      if (keep.size === 0) {
        alert("選取的線之間沒有任何實際相交,無法產生桿件。");
        updateBgEditOpsVisibility();
        return;
      }
    }
    await busyTick();
    setBusyMessage("生成交點間桿件中…");
    const stat = bgBuildMembersBetweenIntersections(r.segIntersections);
    updateBgEditOpsVisibility();
    render(); refreshLists();
    $("hud").textContent =
      `交點 ${r.totalIntersections}・新增節點 ${r.addedJoints}・` +
      `桿件 ${stat.created}(已存在 ${stat.existed},僅交點之間)`;
  })
);

// 把每條 segment(以 segIdx 為 key)上的交點依 t 排序,於連續兩個交點之間建桿件
//   只接受交點之間的段;端點到交點的尾段不建。
//   回傳 { created, existed }(新增的桿件數 / 因已存在被跳過的數)
function bgBuildMembersBetweenIntersections(segIntersections) {
  const p = getPage();
  if (!p || !Array.isArray(p.members)) return { created: 0, existed: 0 };
  // 已存在桿件查表:無向 (j1, j2)
  const existKey = new Set();
  for (const m of p.members) {
    const k = m.j1 < m.j2 ? `${m.j1}|${m.j2}` : `${m.j2}|${m.j1}`;
    existKey.add(k);
  }
  let created = 0, existed = 0;
  for (const idxStr in segIntersections) {
    const ixs = (segIntersections[idxStr] || []).slice();
    if (ixs.length < 2) continue;
    ixs.sort((a, b) => a.t - b.t);
    // 同一 segment 上若多個交點對應同一個 jointId(極短距離合併),先去重
    const dedup = [];
    for (const ix of ixs) {
      if (ix.jointId == null) continue;
      if (dedup.length > 0 && dedup[dedup.length - 1].jointId === ix.jointId) continue;
      dedup.push(ix);
    }
    if (dedup.length < 2) continue;
    for (let i = 0; i < dedup.length - 1; i++) {
      const j1 = dedup[i].jointId, j2 = dedup[i + 1].jointId;
      if (j1 == null || j2 == null || j1 === j2) continue;
      const k = j1 < j2 ? `${j1}|${j2}` : `${j2}|${j1}`;
      if (existKey.has(k)) { existed++; continue; }
      addMember(j1, j2);
      existKey.add(k);
      created++;
    }
  }
  return { created, existed };
}

// 多線模式專用:對所有選取的底圖線段兩兩求交,在每個唯一交點新增節點。
//   opts.strict = true:只接受「線段實際相交 / 端點相觸」的交點(不允許延伸)
//                       線上參數 t / u 必須落在 [0, 1] 內(容差 = eps 世界單位 / 線段長)
//   opts.strict 未設(預設):允許延伸線交點,接受範圍 = 圖面尺寸 × 2
//   平行線(denom ≈ 0)直接略過。已有同位節點的交點不重複新增。
async function bgConvertToIntersections(opts) {
  const strict = !!(opts && opts.strict);
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size < 2) {
    alert("請至少選取 2 條底圖線。");
    return;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) { alert("找不到底圖。"); return; }

  // 收集所有選取 path 的線段(轉到世界座標)
  // pdf.js 出來的 bgSvg 內部 path 用自己的 viewBox 座標(非世界座標),
  // 必須經 getScreenCTM → screen → screenToWorld 才能跟 page joints 比對。
  const segs = [];
  for (const key of file.selectedBgPaths) {
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(key))}"]`);
    if (!el2 || el2.style.display === "none") continue;
    const sub = svgElementToSegments(el2);
    if (sub.length === 0) continue;
    const ctm = el2.getScreenCTM && el2.getScreenCTM();
    const owner = el2.ownerSVGElement || bgSvgEl;
    if (!ctm) {
      // 沒有 CTM(理論上不該發生)→ 退回把 path 座標當世界座標,起碼不 crash
      for (const s of sub) segs.push({ ...s, src: String(key), segIdx: segs.length });
      continue;
    }
    for (const s of sub) {
      const p1 = owner.createSVGPoint(); p1.x = s.x1; p1.y = s.y1;
      const p2 = owner.createSVGPoint(); p2.x = s.x2; p2.y = s.y2;
      const sp1 = p1.matrixTransform(ctm);    // path → screen
      const sp2 = p2.matrixTransform(ctm);
      const w1 = screenToWorld(sp1.x, sp1.y); // screen → world
      const w2 = screenToWorld(sp2.x, sp2.y);
      segs.push({ x1: w1.x, y1: w1.y, x2: w2.x, y2: w2.y, src: String(key), segIdx: segs.length });
    }
  }
  if (segs.length < 2) { alert("有效線段太少,無法求交。"); return; }

  // 延伸上限:圖面範圍 (clipRect 優先,否則整張底圖) 往外擴大一倍。
  //   原圖面 [bx, by, bx+bw, by+bh] → 接受範圍 [bx - bw/2, by - bh/2, bx + bw*1.5, by + bh*1.5]
  //   也就是每邊往外延伸半個圖面尺寸,總接受範圍 = 圖面尺寸 × 2
  const cr = file.clipRect;
  const bx = cr ? cr.x : 0;
  const by = cr ? cr.y : 0;
  const bw = cr ? cr.w : state.bgWidth;
  const bh = cr ? cr.h : state.bgHeight;
  const minX = bx - bw / 2, maxX = bx + bw * 1.5;
  const minY = by - bh / 2, maxY = by + bh * 1.5;
  const inBounds = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;

  const eps = 0.5;     // 同位容差(世界座標)
  const found = [];    // 候選交點 [{x, y}]
  const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
  const participatingSrcs = new Set();   // 真正參與「被接受相交」的線段 src(供 +桿件 流程過濾)
  // 每個 segment(以 segIdx 為 key)上接受到的交點:[{ t, x, y, jointId? }]
  // 用於 +桿件 流程把每條線只切出「交點與交點之間」的桿件
  const segIntersections = {};
  const ensureIxArr = (idx) => (segIntersections[idx] || (segIntersections[idx] = []));
  let inSeg = 0, extended = 0, rejected = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let k = i + 1; k < segs.length; k++) {
      const a = segs[i], b = segs[k];
      const r = lineLineIntersect(
        { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 },
        { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }
      );
      if (!r) continue;                          // 平行
      // strict:只接受實際相交(t、u 都在 [0,1] 內,容差 = eps 世界單位 / 線段長)
      if (strict) {
        const lenA = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1;
        const lenB = Math.hypot(b.x2 - b.x1, b.y2 - b.y1) || 1;
        const tEpsA = eps / lenA, tEpsB = eps / lenB;
        if (r.t < -tEpsA || r.t > 1 + tEpsA) { rejected++; continue; }
        if (r.u < -tEpsB || r.u > 1 + tEpsB) { rejected++; continue; }
      } else if (!inBounds(r.x, r.y)) { continue; } // 非 strict:超出「圖面 × 2」接受範圍 reject
      // 此 (a, b) 配對被接受 → 不論是否與既有 found 同位,兩條都算參與
      participatingSrcs.add(a.src);
      participatingSrcs.add(b.src);
      ensureIxArr(a.segIdx).push({ t: r.t, x: r.x, y: r.y });
      ensureIxArr(b.segIdx).push({ t: r.u, x: r.x, y: r.y });
      if (!found.some(p => same(p, r))) {
        found.push(r);
        if (r.t > 0 && r.t < 1 && r.u > 0 && r.u < 1) inSeg++;
        else extended++;
      }
    }
    if ((i & 31) === 0) await busyTick();
  }

  if (found.length === 0) {
    alert(strict
      ? "沒有找到任何實際相交點(線段需真正交會 / 端點相觸)。"
      : "沒有找到任何交點(交點都超出圖面 ×2 的範圍)。");
    return { participatingSrcs, segIntersections, segs, addedJoints: 0, totalIntersections: 0 };
  }

  // 過濾掉已存在於 page joints 的位置
  const p = getPage();
  const existing = p.joints || [];
  const isNew = (ip) => !existing.some(j => Math.hypot(j.x - ip.x, j.y - ip.y) < eps);
  const toAdd = found.filter(isNew);
  if (toAdd.length > 0) {
    pushUndo();
    for (const ip of toAdd) p.joints.push({ id: allocJointId(), x: ip.x, y: ip.y });
  }
  // 把每個交點對應到 page joint id(新建或既有)— 提供給 +桿件 流程用
  for (const arr of Object.values(segIntersections)) {
    for (const ix of arr) {
      const j = p.joints.find(jt => Math.hypot(jt.x - ix.x, jt.y - ix.y) < eps);
      if (j) ix.jointId = j.id;
    }
  }
  render(); refreshLists();
  if (toAdd.length === 0) {
    $("hud").textContent = `所有 ${found.length} 個交點皆已有節點(線內 ${inSeg}・延伸 ${extended})`;
  } else {
    $("hud").textContent = `已新增 ${toAdd.length} 個交點節點(線內 ${inSeg}・延伸 ${extended})`;
  }
  return { participatingSrcs, segIntersections, segs, addedJoints: toAdd.length, totalIntersections: found.length };
}

function toggleBgMultiSelect() {
  state.bgMultiSelect = !state.bgMultiSelect;
  const btn = $("bgEditMultiSelect");
  if (btn) btn.classList.toggle("active", state.bgMultiSelect);
  updateBgEditOpsVisibility();
  if (state.bgMultiSelect) {
    $("hud").textContent = "多線選取:點擊與匡選累加(Esc 關閉)";
  } else {
    $("hud").textContent = "x: 0 · y: 0 · zoom: 100%";
  }
}
$("bgEditSquareToJoint") && ($("bgEditSquareToJoint").onclick = () => withBusy("加節點中…", bgSquaresToJoints));
$("bgEditRectToCenterMember") && ($("bgEditRectToCenterMember").onclick = () => withBusy("建中軸桿件中…", () => bgRectsToMembers("center")));
$("bgEditRectToTopMember")    && ($("bgEditRectToTopMember").onclick    = () => withBusy("建上邊桿件中…", () => bgRectsToMembers("top")));
$("bgEditRectToBottomMember") && ($("bgEditRectToBottomMember").onclick = () => withBusy("建下邊桿件中…", () => bgRectsToMembers("bottom")));
// 沒有選取任何 bg path 時隱藏「編輯」整區,只留「選取」操作
export function updateBgEditOpsVisibility() {
  const sec = $("bgEditOpsSection");
  if (!sec) return;
  const file = getActiveFile();
  const selSize = (file && file.selectedBgPaths) ? file.selectedBgPaths.size : 0;
  const has = selSize > 0;
  // 編輯區永遠保持顯示(平面座標原點 / 比例尺 是常駐入口);其他按鈕逐個依需求顯示
  sec.style.display = "";
  const showSel = has ? "" : "none";
  // 永遠顯示(可在無選取時觸發 pending 流程)
  if ($("bgEditPlaneOrigin"))   $("bgEditPlaneOrigin").style.display   = "";
  if ($("bgEditScaleRulerTwo")) $("bgEditScaleRulerTwo").style.display = "";
  // 需要 1 條以上選取才有意義
  if ($("bgEditScaleRuler"))    $("bgEditScaleRuler").style.display    = showSel;
  if ($("bgEditSplit"))         $("bgEditSplit").style.display         = showSel;
  if ($("bgEditToMember"))      $("bgEditToMember").style.display      = showSel;
  if ($("bgEditDel"))           $("bgEditDel").style.display           = showSel;
  // 多線轉交點 / 多線轉交點+桿件:選 ≥ 2 條 bg 線即可(不再要求 多線選取 模式)
  const markBtn = $("bgEditMarkIntersect");
  const markMBtn = $("bgEditMarkIntersectAndMember");
  if (markBtn)  markBtn.style.display  = (selSize >= 2) ? "" : "none";
  if (markMBtn) markMBtn.style.display = (selSize >= 2) ? "" : "none";
  // 比例尺視覺位置移動:檔案有比例尺時才顯示(獨立於 bg path 選取)
  const hasRuler = !!(file && file.scaleRuler);
  if ($("bgEditScaleRulerMove")) $("bgEditScaleRulerMove").style.display = hasRuler ? "" : "none";
  // 畫直線:在 bgEdit 模式下永遠可見
  if ($("bgEditDrawLine")) $("bgEditDrawLine").style.display = "";
  // 中分線:剛好選 1 條獨立 bg 線時才能用
  const dn = (typeof distinctSelectedLineCount === "function") ? distinctSelectedLineCount(file) : selSize;
  if ($("bgEditBisector")) $("bgEditBisector").style.display = (dn === 1) ? "" : "none";
  // 線到原點 / 軸距離:選取必須是同一條(共線多段視為 1)、且檔案有原點與比例尺
  const hasOriginScale = !!(file && file.planeOrigin && file.scaleRuler && file.scaleRuler.ratio);
  const showL2O = (dn === 1 && hasOriginScale) ? "" : "none";
  if ($("bgEditOriginDistH"))   $("bgEditOriginDistH").style.display   = showL2O;
  if ($("bgEditOriginDistV"))   $("bgEditOriginDistV").style.display   = showL2O;
  if ($("bgEditOriginDistMin")) $("bgEditOriginDistMin").style.display = showL2O;
  // 標示距離線可移動 / 刪除按鈕:有任何標示距離(已固化或編輯中)就顯示
  const persistedCount = (file && Array.isArray(file.measurements)) ? file.measurements.length : 0;
  const hasMeasure = persistedCount > 0 || !!(state.measure && state.measure.p1 && state.measure.p2);
  if ($("bgEditMeasureSelect"))    $("bgEditMeasureSelect").style.display    = hasMeasure ? "" : "none";
  if ($("bgEditMeasureMove"))      $("bgEditMeasureMove").style.display      = hasMeasure ? "" : "none";
  if ($("bgEditMeasureDelLast"))   $("bgEditMeasureDelLast").style.display   = hasMeasure ? "" : "none";
  if ($("bgEditMeasureClearAll"))  $("bgEditMeasureClearAll").style.display  = (persistedCount > 1) ? "" : "none";
  // 等分線:選 2 條以上獨立 bg 線即可(實際是否平行由 startBgEqui 驗證)
  if ($("bgEditEquidist")) $("bgEditEquidist").style.display = (dn >= 2) ? "" : "none";
  // 轉虛線:選任 1 條以上 bg 線即可
  if ($("bgEditToDashed")) $("bgEditToDashed").style.display = (selSize >= 1) ? "" : "none";
  // 複製線:不依賴選取(無選取進入時,模式內第一個動作是點 bg 線當 source)→ 一律保持顯示
}
function toggleShapeMarqueeMode(mode) {
  if (!state.bgShapeMarquee) state.bgShapeMarquee = new Set();
  if (state.bgShapeMarquee.has(mode)) state.bgShapeMarquee.delete(mode);
  else state.bgShapeMarquee.add(mode);
  refreshShapeMarqueeUI();
}
export function clearAllShapeMarqueeModes() {
  if (!state.bgShapeMarquee) state.bgShapeMarquee = new Set();
  state.bgShapeMarquee.clear();
  refreshShapeMarqueeUI();
}
function refreshShapeMarqueeUI() {
  const has = (m) => state.bgShapeMarquee && state.bgShapeMarquee.has(m);
  const hasSq = has("square"), hasRc = has("rect"), hasCi = has("circle"),
        hasSt = has("straight"), hasSS = has("straightSolid"),
        hasDg = has("diagonal"), hasDD = has("dashedDiagonal");
  $("bgEditSelSquares")   && $("bgEditSelSquares").classList.toggle("active", hasSq);
  $("bgEditSelRects")     && $("bgEditSelRects").classList.toggle("active",   hasRc);
  $("bgEditSelCircles")   && $("bgEditSelCircles").classList.toggle("active", hasCi);
  $("bgEditSelStraight")  && $("bgEditSelStraight").classList.toggle("active", hasSt);
  $("bgEditSelStraightSolid") && $("bgEditSelStraightSolid").classList.toggle("active", hasSS);
  $("bgEditSelDiagonals") && $("bgEditSelDiagonals").classList.toggle("active", hasDg);
  $("bgEditSelDashedDiagonals") && $("bgEditSelDashedDiagonals").classList.toggle("active", hasDD);
  $("bgEditSquareToJoint") && ($("bgEditSquareToJoint").style.display = hasSq ? "" : "none");
  $("bgEditRectToCenterMember") && ($("bgEditRectToCenterMember").style.display = hasRc ? "" : "none");
  $("bgEditRectToTopMember")    && ($("bgEditRectToTopMember").style.display    = hasRc ? "" : "none");
  $("bgEditRectToBottomMember") && ($("bgEditRectToBottomMember").style.display = hasRc ? "" : "none");
  const labels = [];
  if (hasSq) labels.push("正方形");
  if (hasRc) labels.push("長方形");
  if (hasCi) labels.push("圓形");
  if (hasSt) labels.push("直線");
  if (hasDg) labels.push("斜線");
  if (hasDD) labels.push("虛斜線");
  $("hud").textContent = labels.length
    ? `${labels.join("+")}匡選模式:拉方框選取(Esc 取消)`
    : "x: 0 · y: 0 · zoom: 100%";
}

// Stop bg edit panel clicks from bubbling to canvas
["bgEditTools"].forEach(id => {
  const el = $(id); if (!el) return;
  ["click","mousedown","mouseup","dblclick","wheel"].forEach(ev =>
    el.addEventListener(ev, (e) => e.stopPropagation()));
});
// 選取按鈕右鍵:過去開啟選取模式子選單(全部/點/線),現已移除
$("tool-select").addEventListener("contextmenu", (e) => {
  e.preventDefault();
});
$("btnFit").onclick = fitToView;
$("btnZoomSel").onclick = zoomToSelection;
// ---------- 放大 / 縮小 / 範圍放大 ----------
// 範圍放大:拖曳模式追蹤(wrap 相對座標)— 宣告在前,下面的閉包才能安全參照
let rangeZoomDragStart = null;
let rangeZoomSuppressClick = false; // 拖曳完成後 mouseup → click 會緊接著觸發,避免被視為額外點擊
function applyZoomAt(factor, sx, sy) {
  const wx = (sx - state.panX) / state.zoom;
  const wy = (sy - state.panY) / state.zoom;
  state.zoom = Math.max(0.001, Math.min(50, state.zoom * factor));
  state.panX = sx - wx * state.zoom;
  state.panY = sy - wy * state.zoom;
  applyTransform();
  render();
}
function zoomByStep(factor) {
  const r = wrap.getBoundingClientRect();
  applyZoomAt(factor, r.width / 2, r.height / 2);
}
export function exitRangeZoom() {
  state.rangeZoomMode = false;
  state.rangeZoomFirst = null;
  rangeZoomDragStart = null;
  document.body.classList.remove("range-zoom-mode");
  const btn = $("btnZoomRange"); if (btn) btn.classList.remove("active");
  const prev = $("rangeZoomPreview"); if (prev) prev.style.display = "none";
  wrap.style.cursor = "none";
  // 還原其他進行中的模式的 HUD 提示(範圍放大不應中斷其他步驟)
  if (state.originPending) {
    $("hud").textContent = "座標原點:請點選兩條相交的底圖線(Esc 取消);完成後同平面其他頁面會一起對齊";
  } else if (state.splitMode) {
    $("hud").textContent = state.splitFirstCorner
      ? "拆分頁面:請點擊矩形對角(Esc 取消)"
      : "拆分頁面:請點擊矩形第一個對角(Esc 取消)";
  }
}
$("btnZoomIn")    && ($("btnZoomIn").onclick    = () => zoomByStep(1.25));
$("btnZoomOut")   && ($("btnZoomOut").onclick   = () => zoomByStep(1/1.25));
$("btnZoomRange") && ($("btnZoomRange").onclick = () => {
  if (state.rangeZoomMode) { exitRangeZoom(); return; }
  state.rangeZoomMode = true;
  state.rangeZoomFirst = null;
  rangeZoomDragStart = null;
  document.body.classList.add("range-zoom-mode");
  $("btnZoomRange").classList.add("active");
  $("hud").textContent = "範圍放大:請拖曳或點兩下對角(Esc 取消)";
  wrap.style.cursor = "crosshair";
});

export function finalizeRangeZoomRect(x1, y1, x2, y2) {
  const viewR = wrap.getBoundingClientRect();
  const ax = Math.min(x1, x2), ay = Math.min(y1, y2);
  const bx = Math.max(x1, x2), by = Math.max(y1, y2);
  const w = Math.max(bx - ax, 1), h = Math.max(by - ay, 1);
  exitRangeZoom();
  if (w < 4 || h < 4) { render(); return; }
  const scale = Math.min(viewR.width / w, viewR.height / h) * 0.95;
  const cx = ((ax + bx) / 2 - state.panX) / state.zoom;
  const cy = ((ay + by) / 2 - state.panY) / state.zoom;
  state.zoom = Math.max(0.001, Math.min(50, state.zoom * scale));
  state.panX = viewR.width  / 2 - cx * state.zoom;
  state.panY = viewR.height / 2 - cy * state.zoom;
  applyTransform();
  render();
}
// ---------- 標示字體 / button toggles / 工具列 wiring ----------
// ~2720 行 button onclicks + visibility toggles + label font / cross-view sync 等
// 搬到 src/app/toolbar.ts。檔案有大量 top-level $().onclick 副作用,但 ESM live binding
// 確保載入時各 handler 都拿得到目標 helper。
// 全部從 toolbar.ts re-export(下游很多 module 從 "../legacy" import,維持兼容)
export * from "./toolbar";
import {
  calibratePlane, clearAllBgSelection, bgRectsToMembers, zoomToSelection,
} from "./toolbar";
import { _startSaveWithHook } from "./init";
import "./toolbar";

// ---------- 檢查可延伸桿件:斷點偵測 ----------
// 完整 modal workflow + 縮圖預覽 + 主畫布 zoom-to-rect (~1080 行)
//   實作搬到 src/tools/extendCheck.ts。外部 import 點:
//     • ui/menubar.ts → startExtendableMemberCheck
//     • dialogs/search.ts → _zoomMainCanvasToRect
//     • dialogs/preview3d.ts → findAllExtendableMembers / _zoomMainCanvasToRect
export {
  findExtendableMembersOnPage,
  findAllExtendableMembers,
  _zoomMainCanvasToRect,
  _renderFileRegion,
  _drawExtensionMarkers,
  _drawThumbViewportBox,
  _applyMemberExtension,
  startExtendableMemberCheck,
  startExtendableMemberCheckCurrentPage,
  openMemberExtensionCheckDialog,
} from "../tools/extendCheck";
// legacy.ts 內 $("btnExtendCheck").onclick 直接 call startExtendableMemberCheckCurrentPage
//   → 同樣需要 named import 進本模組 scope(re-export 不會 bind 到 local scope)
import {
  startExtendableMemberCheckCurrentPage,
} from "../tools/extendCheck";

// 一鍵清空所有頁面的本頁數字 — 把每個 page.groupNum 設成 null,refresh + render;Ctrl+Z 可還原
function clearAllPageGroupNumbers() {
  const pages = [];
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      pages.push({ file: f, pg, key: k });
    }
  }
  const haveNum = pages.filter(e => e.pg.groupNum != null && Number.isFinite(e.pg.groupNum));
  if (!haveNum.length) {
    $("hud").textContent = "沒有任何頁面設定了本頁數字,沒東西要清";
    return;
  }
  if (!confirm(`將清空 ${haveNum.length} 個頁面的「本頁數字」(設為 null)。\n之後可用「一鍵自動編 本頁數字」整批重編。\nCtrl+Z 可還原。要繼續嗎?`)) return;
  pushUndo();
  const summary = [];
  for (const ent of haveNum) {
    summary.push({ name: ent.file.name, plane: ent.pg.plane || "—", oldNum: ent.pg.groupNum });
    ent.pg.groupNum = null;
  }
  console.log(`[一鍵清空 本頁數字] 清了 ${haveNum.length} 個頁面:`, summary);
  refreshPageCoordSection();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render(); refreshLists();
  $("hud").textContent = `已清空 ${haveNum.length} 個頁面的本頁數字`;
}

// ---------- canvas interaction ----------
wrap.addEventListener("mousemove", (e) => {
  updateCrosshair(e.clientX, e.clientY);
  if (panning) return;
  const w = screenToWorld(e.clientX, e.clientY);
  state.cursor.sx = w.x; state.cursor.sy = w.y;
  state.altDown = !!e.altKey;
  applyTransform();
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) {
    updateScaleRulerDragPreview(e.clientX, e.clientY);
    return;
  }
  if (state.bgDrawLine && state.bgDrawLine.active) {
    // 還沒點第一點時也要 render — 讓 hover 上 bg 端點 / 交點時就能看到鎖點圓圈與文字
    render();
    return;
  }
  if (state.bgCopyLine && state.bgCopyLine.active) {
    // 同樣 hover 顯示鎖點 + 預覽 ghost
    render();
    return;
  }
  if (state.sectionLinkPlacing) {
    render();   // 預覽切面定位:第一點前 = 游標十字;第一點後 = tip → 游標 + 箭頭
    return;
  }
  if (state.bgBisector && state.bgBisector.active) {
    updateBgBisectorPreview(e.clientX, e.clientY);
    return;
  }
  if (state.bgEqui && state.bgEqui.active) {
    updateBgEquiPreview(e.clientX, e.clientY);
    return;
  }
  if (state.measure && state.measure.sliding) {
    updateMeasureSlide(e.clientX, e.clientY);
    return;
  }
  if (state.tool === "line" && state.pendingLineStart) render();
  if (state.moveMode.active && state.moveMode.base) render();
  if (state.splitMode && state.splitFirstCorner) render();
  if (state.rangeZoomMode && (state.rangeZoomFirst || rangeZoomDragStart)) {
    const r = wrap.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const origin = rangeZoomDragStart || state.rangeZoomFirst;
    const ax = origin.x, ay = origin.y;
    const x1 = Math.min(ax, sx), y1 = Math.min(ay, sy);
    const x2 = Math.max(ax, sx), y2 = Math.max(ay, sy);
    const prev = $("rangeZoomPreview");
    if (prev) {
      prev.style.left = x1 + "px";
      prev.style.top  = y1 + "px";
      prev.style.width  = (x2 - x1) + "px";
      prev.style.height = (y2 - y1) + "px";
      prev.style.display = "block";
    }
  }
});
wrap.addEventListener("mouseleave", () => {
  $("crosshairH").style.display = "none";
  $("crosshairV").style.display = "none";
  $("crosshairBox").style.display = "none";
});
function updateCrosshair(clientX, clientY) {
  const cur = wrap.style.cursor;
  if (cur && cur !== "none") {
    $("crosshairH").style.display = "none";
    $("crosshairV").style.display = "none";
    $("crosshairBox").style.display = "none";
    return;
  }
  const r = wrap.getBoundingClientRect();
  const x = clientX - r.left, y = clientY - r.top;
  const h = $("crosshairH"), v = $("crosshairV"), b = $("crosshairBox");
  h.style.top  = y + "px"; h.style.display = "block";
  v.style.left = x + "px"; v.style.display = "block";
  b.style.left = x + "px"; b.style.top = y + "px"; b.style.display = "block";
}

wrap.addEventListener("click", (e) => {
  if (rangeZoomSuppressClick) { rangeZoomSuppressClick = false; return; }
  if (panning || state.spaceDown) return;
  // 若點擊命中工具列 / zoomTools / HUD 等浮層 UI,不視為畫布點擊
  if (e.target && e.target.closest && e.target.closest("#toolbar, #tabBar, #zoomTools, #bgEditTools, #selectTools, #hud, #cmdInputBar, #busySpinner, #menuBar")) return;
  // 比例尺沿線移動模式:點擊即確認當前位置
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) {
    commitScaleRulerDrag();
    return;
  }
  // 畫直線模式:第一點 → 第二點
  //   自動鎖點:不需按鍵就會吸到 bg 端點 / 線交點(snapToBgVertex)
  //   Alt / Option:再放寬到吸 bg 線投影(線中央)— 優先吸附整個 bg 路徑
  if (state.bgDrawLine && state.bgDrawLine.active) {
    const w = screenToWorld(e.clientX, e.clientY);
    let p;
    if (e.altKey) {
      const bgSnap = snapToBgPaths(w);
      p = bgSnap || snap(w);
    } else {
      const v = snapToBgVertex(w);
      p = v || snap(w);
    }
    p = { x: p.x, y: p.y };
    if (!state.bgDrawLine.p1) {
      state.bgDrawLine.p1 = p;
      $("hud").textContent = "畫直線:點選第二個點(自動吸 bg 端點 / 交點;Shift = 鎖正交,Alt = 也吸線中段;Esc 取消)";
      render();
      return;
    }
    if (e.shiftKey || state.ortho) {
      const p1 = state.bgDrawLine.p1;
      if (Math.abs(p.x - p1.x) >= Math.abs(p.y - p1.y)) p.y = p1.y;
      else p.x = p1.x;
    }
    commitBgDrawLineSecond(p);
    return;
  }
  // 複製線模式:
  //   sources 還沒選 → 點 bg 線設為 source
  //   sources 有了但 base 還沒設 → 設基準點
  //   都有 → 放一份新線(基準點不變,連續複製)
  if (state.bgCopyLine && state.bgCopyLine.active) {
    const cl = state.bgCopyLine;
    if (!cl.sources.length) {
      // 用 elementFromPoint 直接抓游標下的 bg 元素;只接受有 data-bg-idx 的單一線段元素
      const targetEl = document.elementFromPoint(e.clientX, e.clientY);
      const idx = targetEl && targetEl.dataset && targetEl.dataset.bgIdx;
      if (!idx) {
        $("hud").textContent = "複製線:沒點到 bg 線,請點任一條 bg 線(實線 / 虛線都可)";
        return;
      }
      const src = _captureSourceFromElement(targetEl);
      if (!src) {
        $("hud").textContent = "複製線:這個元素不是單一線段(請改點 line / 單段 path / polyline)";
        return;
      }
      cl.sources = [src];
      $("hud").textContent = `複製線:已選 1 條,點基準點(自動吸 bg 端點 / 交點)`;
      render();
      return;
    }
    const w = screenToWorld(e.clientX, e.clientY);
    let p;
    if (e.altKey) {
      const bgSnap = snapToBgPaths(w);
      p = bgSnap || snap(w);
    } else {
      const v = snapToBgVertex(w);
      p = v || snap(w);
    }
    p = { x: p.x, y: p.y };
    if (!cl.base) {
      cl.base = p;
      $("hud").textContent = `複製線:基準點已設,移動滑鼠看預覽,點擊放置(可連續;Esc 結束)`;
      render();
      return;
    }
    if (e.shiftKey || state.ortho) {
      const b = cl.base;
      if (Math.abs(p.x - b.x) >= Math.abs(p.y - b.y)) p.y = b.y;
      else p.x = b.x;
    }
    commitBgCopyLineDest(p);
    return;
  }
  // 中分線模式:點擊即確認
  if (state.bgBisector && state.bgBisector.active) {
    commitBgBisector();
    return;
  }
  // 等分線模式:點擊即確認
  if (state.bgEqui && state.bgEqui.active) {
    commitBgEqui();
    return;
  }
  // 標示距離 sliding 模式:點擊即固定當前位置
  if (state.measure && state.measure.sliding) {
    commitMeasureSlide();
    return;
  }
  // 切面定位:對話框 OK 後 → 兩點點擊定位箭頭(兩點皆強制吸附到原 bg 切線的無限延伸線)
  if (state.sectionLinkPlacing) {
    const w = screenToWorld(e.clientX, e.clientY);
    const placing = state.sectionLinkPlacing;
    const projected = _projectPointOnLine(w, placing.repLine.p1, placing.repLine.p2);
    if (!placing.tip) {
      placing.tip = projected;
      $("hud").textContent = "切面定位:點擊第二點(箭頭尾端) — Esc 取消";
      render();
    } else {
      const tail = projected;
      const tip = placing.tip;
      const prevTool = placing.prevTool;
      // 用使用者點的 2 點當 p1(尖端)/ p2(尾端)— 取代原本 bg 線端點,兩點都在原切線上
      saveSectionLink(placing.file, { p1: tip, p2: tail }, placing.targetIds);
      state.sectionLinkPlacing = null;
      if (prevTool && prevTool !== "selectBg" && prevTool !== state.tool) setTool(prevTool);
      render();
    }
    return;
  }
  if (state.rangeZoomMode) {
    // 範圍放大:點兩下對角(或拖曳;拖曳在 mouseup 完成,此處只處理兩段式點擊)
    const r = wrap.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (!state.rangeZoomFirst) {
      state.rangeZoomFirst = { x: sx, y: sy };
      $("hud").textContent = "範圍放大:請點擊對角的第二點(Esc 取消)";
      return;
    }
    finalizeRangeZoomRect(state.rangeZoomFirst.x, state.rangeZoomFirst.y, sx, sy);
    return;
  }
  if (state.splitMode) {
    // 拆分模式:點兩下對角形成矩形
    const w = screenToWorld(e.clientX, e.clientY);
    const snapped = snap(w);
    if (!isInsideClip(getActiveFile(), snapped.x, snapped.y)) {
      $("hud").textContent = "拆分頁面:點擊位置在拆分頁範圍外,已忽略";
      return;
    }
    if (!state.splitFirstCorner) {
      state.splitFirstCorner = { x: snapped.x, y: snapped.y };
      $("hud").textContent = "拆分頁面:請點擊矩形對角(Esc 取消)";
      render();
      return;
    }
    const a = state.splitFirstCorner;
    const b = { x: snapped.x, y: snapped.y };
    const rect = {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
    };
    state.splitFirstCorner = null;
    if (rect.w < 1 || rect.h < 1) { render(); return; }
    const p = getPage();
    const movedJ = new Set();
    const inside = (j) => j.x >= rect.x && j.x <= rect.x + rect.w
                       && j.y >= rect.y && j.y <= rect.y + rect.h;
    for (const j of p.joints) if (inside(j)) movedJ.add(j.id);
    const movedM = new Set();
    for (const mm of p.members) {
      const aJ = jointById(mm.j1), bJ = jointById(mm.j2);
      if (aJ && bJ && inside(aJ) && inside(bJ)) movedM.add(mm.id);
    }
    splitContext = { movedJ, movedM, rect };
    showSplitDim(rect);
    $("splitName").value = "拆分_" + (state.files.length + 1);
    $("splitDialog").style.display = "flex";
    setTimeout(() => $("splitName").focus(), 30);
    render();
    return;
  }
  if (state.manualAlign.active) return;     // 手動對齊模式下不處理任何點擊(畫線/校準/選取)
  if (state.moveMode.active) {
    const w = screenToWorld(e.clientX, e.clientY);
    const snapped = snap(w);
    handleMoveModeClick(snapped.x, snapped.y);
    return;
  }
  // 若 mousedown→mouseup 之間有實際移動,這是拖曳(平移或框選)結束的 click,不要當作普通點擊處理
  if (mouseDownPos) {
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    const moved = Math.hypot(dx, dy) > 4;
    setMouseDownPos(null);
    if (moved) return;
  }
  const w = screenToWorld(e.clientX, e.clientY);
  const snapped = snap(w);
  const _af = getActiveFile();
  // 校準功能已移除
  if (state.tool === "line") {
    if (!isInsideClip(_af, snapped.x, snapped.y)) {
      $("hud").textContent = "畫桿件:點擊位置在拆分頁範圍外,已忽略";
      return;
    }
    pushUndo();
    const j = ensureJointAt(snapped);
    if (!state.pendingLineStart) {
      state.pendingLineStart = j.id;
    } else {
      if (state.pendingLineStart !== j.id) {
        addMemberInteractive(state.pendingLineStart, j.id);
      }
      state.pendingLineStart = j.id;  // chain
    }
    render(); refreshLists();
    return;
  }
  if (state.tool === "point") {
    // 畫點:每按一下新增一個獨立節點(會 snap 到網格 / 既有節點)
    if (!isInsideClip(_af, snapped.x, snapped.y)) {
      $("hud").textContent = "畫節點:點擊位置在拆分頁範圍外,已忽略";
      return;
    }
    pushUndo();
    const j = ensureJointAt(snapped);
    if (state.crossViewSync) syncJointAcrossViews(j);
    render(); refreshLists();
    return;
  }
  if (state.tool === "select") {
    // selection happens via SVG element click handlers
    if (!additiveSelect(e)) clearSelection();
    render();
  }
  if (state.tool === "selectBg") {
    hideCtxMenu();
    // 多線選取開啟時:點擊空白不再清除既有選取(只能由 Esc 或關閉多線選取來清)
    if (!state.bgMultiSelect) clearAllBgSelection(getActiveFile());
  }
});

// double-click stops a chain
wrap.addEventListener("dblclick", () => {
  state.pendingLineStart = null;
  render();
});

// 除錯:document 攔截每次 click,印出 target
document.addEventListener("click", (e) => {
  if (!e.isTrusted) return;
  const t = e.target;
  console.log("[doc click] tag=", t.tagName, "id=", t.id, "class=", t.className, "text=", (t.textContent || "").slice(0, 20));
}, true);

// 點擊 UI 控制元件(工具列、側欄、HUD、對話框、選單等)時取消連續畫線狀態
const _uiSel = "#toolbar, #tabBar, #zoomTools, #hud, #ctxMenu, #planePicker, #splitDialog, #gbindDialog, #autoPairDialog, .sidebar, .collapser, .sidebar-resizer, #menuBar";
document.addEventListener("click", (e) => {
  if (!state.pendingLineStart) return;
  if (e.target.closest(_uiSel)) {
    state.pendingLineStart = null;
    render();
  }
}, true);

// 連續畫線時:在畫布上短時間內近距離連點兩下視為雙擊 → 結束連續畫線,且不建立第二個節點
let _lineLastClick = null;
document.addEventListener("click", (e) => {
  if (!e.isTrusted) return;                  // 忽略 dispatchEvent 的合成事件(例如點 label 轉發)
  if (state.tool !== "line") return;
  if (!e.target.closest("#stage")) return;
  const now = Date.now();
  if (_lineLastClick && (now - _lineLastClick.time) < 350 &&
      Math.hypot(e.clientX - _lineLastClick.x, e.clientY - _lineLastClick.y) < 8) {
    state.pendingLineStart = null;
    _lineLastClick = null;
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    render();
    return;
  }
  _lineLastClick = { time: now, x: e.clientX, y: e.clientY };
}, true);

// 在畫布內按右鍵 → 若有選取就跳出刪除選單
wrap.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (state.tool === "selectBg") {
    const file = getActiveFile();
    if (file && file.selectedBgPaths && file.selectedBgPaths.size > 0) {
      showBgCtxMenu(e.clientX, e.clientY);
    } else {
      hideCtxMenu();
    }
    return;
  }
  const hasSel = state.selection.joints.size + state.selection.members.size > 0;
  if (hasSel) showCtxMenu(e.clientX, e.clientY, null);
  else hideCtxMenu();
});

// ---------- snap ----------
// snapToBgVertex / snapToBgPaths / snap 搬到 src/app/snap.ts
import { snapToBgVertex, snapToBgPaths, snap } from "./snap";
export { snapToBgVertex, snapToBgPaths, snap };


// ---------- model ops ----------
export function jointById(id) { return getPage().joints.find(j => j.id === id); }

// 在指定頁面上找鄰近節點,沒有就新建。radius 用世界座標單位(通常 mm)
export function getOrCreateJointOnPage(page, x, y, radius) {
  for (const j of page.joints) {
    if (Math.hypot(j.x - x, j.y - y) < radius) return j;
  }
  const j = { id: allocJointId(), x, y };
  page.joints.push(j);
  return j;
}

export function ensureJointAt(p) {
  if (p.joint) return p.joint;
  // also re-search to merge with any existing joint within snap radius
  const radius = state.snapPx / state.zoom;
  for (const j of getPage().joints) {
    if (Math.hypot(j.x - p.x, j.y - p.y) < radius) return j;
  }
  const j = { id: allocJointId(), x: p.x, y: p.y };
  getPage().joints.push(j);
  return j;
}

// 跨頁同步建點(P1):
//   給已建立在當前頁的 joint,投影到 3D world,然後在所有相容平面的頁面 (file, page) 建立對應節點。
//   全部綁到同一個新 globalJoint(若 joint 已綁過則沿用)。
//   相容性檢查:目標頁的 page.z 要 ≈ world 的「out-of-plane 軸」(否則該 page 是不同的 slice,跳過)。
//   缺少必要設定(plane / ratio / origin)的頁面也會被 world3DToJoint2D 自然 skip。
export function syncJointAcrossViews(joint) {
  const af = getActiveFile();
  const ap = getPage();
  if (!af || !ap) return;
  // 來源頁要能投影為 3D
  const world = joint2DToWorld3D(af, ap, joint);
  if (!world) {
    $("hud").textContent = "無法同步:當前頁缺少比例尺(原點可選)";
    return;
  }
  // 找相容頁(包含當前頁本身;當前頁要排除)
  const tol = Math.max(1.0, (state.snapPx || 12) / (state.scale || 1));
  const compat = findCompatiblePages(world, { tol })
    .filter(c => !(c.file.id === af.id && c.pageIdx === state.pageIdx));
  if (compat.length === 0) {
    $("hud").textContent = "跨頁同步:無其他相容頁面(檢查 plane / page.z / 比例尺 / 原點)";
    return;
  }
  // 取得或建立 globalJoint
  let g;
  if (joint.globalId != null) g = findGlobalJointById(joint.globalId);
  if (!g) {
    g = createGlobalJoint();
    joint.globalId = g.id;
  }
  // 建立對應節點 + 綁到同 globalJoint
  let created = 0, reused = 0, snappedToBg = 0, missingCache = 0;
  for (const c of compat) {
    // 檢查目標頁是否已有此 globalJoint 的綁定:有就略過(避免重複)
    const already = (c.page.joints || []).find(jj => jj.globalId === g.id);
    if (already) { reused++; continue; }
    // P2:嘗試吸到目標頁的底圖實際交點
    let pos = { x: c.x, y: c.y };
    if (Array.isArray(c.page._bgSegsCache)) {
      const snapHit = snapProjectionToBgIntersection(c.file, c.page, pos);
      if (snapHit) { pos = { x: snapHit.x, y: snapHit.y }; snappedToBg++; }
    } else {
      missingCache++;
    }
    // 目標頁是否已有同位節點:有就重用(綁過去)
    const radius = Math.max(1.0, (state.snapPx || 12) / (state.scale || 1));
    let target = (c.page.joints || []).find(jj =>
      Math.hypot(jj.x - pos.x, jj.y - pos.y) < radius);
    if (!target) {
      target = { id: allocJointId(), x: pos.x, y: pos.y };
      (c.page.joints || (c.page.joints = [])).push(target);
      created++;
    }
    target.globalId = g.id;
  }
  inferGlobalJoint(g);
  let msg = `跨頁同步:新建 ${created} 個節點(重用 ${reused},吸到底圖交點 ${snappedToBg})於 ${compat.length} 個相容頁,全綁到 ${g.label}`;
  if (missingCache > 0) msg += ` · ${missingCache} 個頁面尚未掃描底圖(可按「掃描所有底圖」)`;
  $("hud").textContent = msg;
}

// ---------- 移動指令(M) ----------
// startMoveMode / exitMoveMode / moveModeTarget / commitMove / showCmdInput / etc.
//   實作搬到 src/tools/moveCmd.ts。legacy.ts 內 cmdInputField 的 Enter handler 仍用 handleCmdInputCommit。
export {
  startMoveMode,
  exitMoveMode,
  moveModeTarget,
  commitMove,
  handleMoveModeClick,
  updateMoveModeHUD,
  showCmdInput,
  hideCmdInput,
  handleCmdInputCommit,
} from "../tools/moveCmd";
import {
  startMoveMode,
  exitMoveMode,
  handleCmdInputCommit,
} from "../tools/moveCmd";

// ---------- Relayout 編號 ----------
// _relayoutPageCore + 4-stage 桿件編號 ~1080 行搬到 src/core/relayout.ts
export {
  _relayoutPageCore,
  _nextMemberZeroBoundary,
  relayoutNumbering,
  relayoutNumberingAll,
  relayoutMembersNumbering,
  relayoutMembersNumberingAll,
} from "../core/relayout";
import {
  relayoutNumbering,
  relayoutMembersNumbering,
} from "../core/relayout";

// ---------- 節點 / 桿件編輯操作 + selection helpers ----------
// (原「移動指令(M)」section,內容其實是 extend/duplicate/split/add/delete/intersect/dedup
//  + selection helpers,~1015 行)搬到 src/tools/jointMemberEdit.ts
import {
  extendSelectedMembersToIntersect, extendJointAxisToIntersect,
  duplicateJointOnAxis,
  splitSelectedAtMidpoint, splitMemberAt,
  addMember, syncMemberAcrossViews, addMemberInteractive,
  deleteSelection, _deleteSelectionCore,
  clearSelection, _assertSelectionOnActivePage, _markSelectionSourceIfEmpty,
  additiveSelect, subtractiveSelect,
  splitMembersAtCollinearJoints,
  processIntersectionsForSelection, processIntersections,
  segIntersect, lineLineIntersect,
  _consolidateInPlace, jointHasCollinearMemberInDirection,
  consolidateGeometry,
  dedupSamePageMembers, unifyCrossPageMemberIds,
} from "../tools/jointMemberEdit";
export {
  extendSelectedMembersToIntersect, extendJointAxisToIntersect,
  duplicateJointOnAxis,
  splitSelectedAtMidpoint, splitMemberAt,
  addMember, syncMemberAcrossViews, addMemberInteractive,
  deleteSelection, _deleteSelectionCore,
  clearSelection, _assertSelectionOnActivePage, _markSelectionSourceIfEmpty,
  additiveSelect, subtractiveSelect,
  splitMembersAtCollinearJoints,
  processIntersectionsForSelection, processIntersections,
  segIntersect, lineLineIntersect,
  _consolidateInPlace, jointHasCollinearMemberInDirection,
  consolidateGeometry,
  dedupSamePageMembers, unifyCrossPageMemberIds,
};
// ---------- 自動對齊:偵測底圖最長水平/垂直線並旋轉 ----------
// extractSvgSegments / detectAlignmentAngle / enterManualAlign / exitManualAlign /
// rotateBg90Clockwise 搬到 src/dialogs/autoAlign.ts;btnRotate90 onclick 用 wire 函式延後綁
import {
  extractSvgSegments,
  detectAlignmentAngle,
  enterManualAlign,
  exitManualAlign,
  rotateBg90Clockwise,
  wireAutoAlignButtons,
} from "../dialogs/autoAlign";
wireAutoAlignButtons();
export {
  extractSvgSegments,
  detectAlignmentAngle,
  enterManualAlign,
  exitManualAlign,
  rotateBg90Clockwise,
};

// 在 vector 層底部繪製鎖點視覺(灰點 / 棋盤格)
export function drawSnapGrid() {
  if (!state.snapGrid || state.snapGrid.mode === 0) return;
  const stepWorld = (state.snapGrid.step || 1) * (state.scale || 1);
  if (stepWorld <= 0) return;

  // 視窗在世界座標的可見範圍
  const r = wrap.getBoundingClientRect();
  const tl = screenToWorld(r.left, r.top);
  const br = screenToWorld(r.right, r.bottom);
  const x1 = Math.min(tl.x, br.x), y1 = Math.min(tl.y, br.y);
  const x2 = Math.max(tl.x, br.x), y2 = Math.max(tl.y, br.y);

  // 動態調整實際顯示間距,避免太密;但仍保留鎖點計算用的真實 stepWorld
  let s = stepWorld;
  const maxCells = 120;            // 每方向最多 120 格(~14400 個視覺元素)
  while ((x2 - x1) / s > maxCells || (y2 - y1) / s > maxCells) s *= 5;

  const ix1 = Math.floor(x1 / s), ix2 = Math.ceil(x2 / s);
  const iy1 = Math.floor(y1 / s), iy2 = Math.ceil(y2 / s);

  // 主格(每 5 格)用較粗 / 較大來區分
  const majorEvery = 5;

  if (state.snapGrid.mode === 1) {
    // 點陣 — 鎖點位置畫成 1x1 ~ 3x3 px 的小方塊
    const minorSize = 1 / state.zoom;     // 1 CSS px
    const majorSize = 3 / state.zoom;     // 3 CSS px
    for (let ix = ix1; ix <= ix2; ix++) {
      for (let iy = iy1; iy <= iy2; iy++) {
        const isMajor = (ix % majorEvery === 0) && (iy % majorEvery === 0);
        const sz = isMajor ? majorSize : minorSize;
        const half = sz / 2;
        svg.appendChild(el("rect", {
          x: ix * s - half, y: iy * s - half,
          width: sz, height: sz,
          fill: "#9aa0a6",
          "fill-opacity": isMajor ? "0.65" : "0.4",
          stroke: "none",
        }));
      }
    }
  } else if (state.snapGrid.mode === 2) {
    // 線條方式 — 線寬隨縮放反向變化:放大越多 → 線越細
    const ymin = iy1 * s, ymax = iy2 * s;
    const xmin = ix1 * s, xmax = ix2 * s;
    const lineWidth = (basePx) => Math.max(0.2, basePx / state.zoom).toFixed(3);
    for (let ix = ix1; ix <= ix2; ix++) {
      const isMajor    = ix % majorEvery === 0;
      const isSuper    = ix % (majorEvery * majorEvery) === 0;
      const basePx     = isSuper ? 3 : isMajor ? 2 : 1;
      const opacity    = isSuper ? "0.55" : isMajor ? "0.4" : "0.22";
      svg.appendChild(el("line", {
        x1: ix * s, y1: ymin, x2: ix * s, y2: ymax,
        stroke: "#9aa0a6",
        "stroke-width": lineWidth(basePx),
        "stroke-opacity": opacity,
      }));
    }
    for (let iy = iy1; iy <= iy2; iy++) {
      const isMajor    = iy % majorEvery === 0;
      const isSuper    = iy % (majorEvery * majorEvery) === 0;
      const basePx     = isSuper ? 3 : isMajor ? 2 : 1;
      const opacity    = isSuper ? "0.55" : isMajor ? "0.4" : "0.22";
      svg.appendChild(el("line", {
        x1: xmin, y1: iy * s, x2: xmax, y2: iy * s,
        stroke: "#9aa0a6",
        "stroke-width": lineWidth(basePx),
        "stroke-opacity": opacity,
      }));
    }
  }
}

// Render 看門狗 + _renderImpl 移到 src/render/index.ts(Phase 6)
import { render } from "../render";
export { render };   // re-export 讓 dialog 等 module 仍能從 "./legacy" import render

export function el(tag: string, attrs: Record<string, any>, text?: any) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  if (text != null) e.textContent = text;
  return e;
}

// ---------- context menu (右鍵刪除) ----------
//   showCtxMenu / hideCtxMenu / updateCtxFilterRadios 已搬到 src/dialogs/ctxMenu.ts;
//   ctxState 是模組共享狀態(target / pending),legacy.ts 其他 handler 走 ctxState.pending 讀寫
import { showCtxMenu, hideCtxMenu, updateCtxFilterRadios, ctxState } from "../dialogs/ctxMenu";
export { showCtxMenu };

$("ctxBgSplit") && ($("ctxBgSplit").onclick = (e) => {
  e.stopPropagation();
  hideCtxMenu();
  bgPathsSplitToLines();
});
$("ctxBgToMember") && ($("ctxBgToMember").onclick = (e) => {
  e.stopPropagation();
  hideCtxMenu();
  bgPathsToMembers();
});
$("ctxBgToDashed") && ($("ctxBgToDashed").onclick = (e) => {
  e.stopPropagation();
  hideCtxMenu();
  bgToggleDashedOnSelection();
});

$("ctxOpenTab") && ($("ctxOpenTab").onclick = (e) => {
  e.stopPropagation();
  if (!ctxState.pending || !ctxState.pending.fileIds || !ctxState.pending.fileIds.size) return;
  const ids = [...ctxState.pending.fileIds];
  hideCtxMenu();
  let firstId = null;
  for (const fid of ids) {
    const f = state.files.find(ff => ff.id === fid);
    if (!f) continue;
    addTab(fid, 0);
    if (firstId == null) firstId = fid;
  }
  // 一鍵開多個分頁時,切到第一個被開的檔案
  if (firstId != null && state.activeFileId !== firstId) activatePageWithBusy(firstId, 0);
});

$("ctxRename").onclick = (e) => {
  e.stopPropagation();
  if (!ctxState.pending || !ctxState.pending.fileIds || ctxState.pending.fileIds.size !== 1) return;
  const fid = [...ctxState.pending.fileIds][0];
  const file = state.files.find(f => f.id === fid);
  hideCtxMenu();
  if (!file) return;
  const name = prompt("新名稱:", file.name);
  if (!name || name === file.name) return;
  if (state.files.some(f => f.id !== fid && f.name === name)) {
    alert("名稱已存在,不可重複"); return;
  }
  pushUndo();
  file.name = name;
  refreshFileList(); refreshPageSelector();
};

// 複製檔案:複製選取的單一檔案(含底圖參照、比例尺、原點、標線),節點/桿件重新編號避免衝突
$("ctxDuplicate") && ($("ctxDuplicate").onclick = (e) => {
  e.stopPropagation();
  if (!ctxState.pending || !ctxState.pending.fileIds || ctxState.pending.fileIds.size !== 1) return;
  const fid = [...ctxState.pending.fileIds][0];
  hideCtxMenu();
  duplicateFileById(fid);
});

function duplicateFileById(fid, opts) {
  const src = state.files.find(f => f.id === fid);
  if (!src) return null;
  pushUndo();
  // 產生不重複的新名稱:原名稱 (副本) / (副本 2) / ...
  const baseName = src.name;
  let newName = `${baseName} (副本)`;
  let n = 2;
  while (state.files.some(f => f.name === newName)) {
    newName = `${baseName} (副本 ${n++})`;
  }
  // deep clone pages,並重新編號 joint / member 以免和既有檔案衝突
  const clonedPages = {};
  for (const key of Object.keys(src.pages || {})) {
    const pg = src.pages[key];
    const idMap = new Map();  // 舊 jointId → 新 jointId
    const newJoints = [];
    for (const j of (pg.joints || [])) {
      const nid = allocJointId();
      idMap.set(j.id, nid);
      newJoints.push({ ...j, id: nid });
    }
    const newMembers = [];
    for (const m of (pg.members || [])) {
      const j1 = idMap.get(m.j1), j2 = idMap.get(m.j2);
      if (j1 == null || j2 == null) continue;   // 掉端點的直接跳過
      newMembers.push({ ...m, id: allocMemberId(), j1, j2 });
    }
    clonedPages[key] = {
      ...pg,
      joints: newJoints,
      members: newMembers,
    };
  }
  const clone = {
    id: allocFileId(),
    name: newName,
    type: src.type,
    pageCount: src.pageCount || 1,
    pdfPage: src.pdfPage,
    rotation: src.rotation || 0,
    offsetX: src.offsetX || 0,
    offsetY: src.offsetY || 0,
    clipRect: src.clipRect ? { ...src.clipRect } : null,
    scaleRuler: src.scaleRuler ? { ...src.scaleRuler } : null,
    planeOrigin: src.planeOrigin ? { ...src.planeOrigin } : null,
    bgWidth: src.bgWidth,
    bgHeight: src.bgHeight,
    detectedStrokeWidth: src.detectedStrokeWidth,
    imageWidth:  src.imageWidth,
    imageHeight: src.imageHeight,
    cachedBgWidth:  src.cachedBgWidth,
    cachedBgHeight: src.cachedBgHeight,
    pages: clonedPages,
    // 共享底圖資源(避免重新解析 PDF / 複製大型 buffer)
    sourceFileId: src.sourceFileId || src.id,
    pdf: src.pdf || null,
    image: src.image || null,
    cachedBgSvg: src.cachedBgSvg || null,
    cachedBgImg: src.cachedBgImg || null,
    // 不複製以下使用者正在處理的暫時選取狀態
    selectedBgPaths: null,
    deletedBgPaths: src.deletedBgPaths ? new Set(src.deletedBgPaths) : null,
  };
  state.files.push(clone);
  state.selection.fileIds.clear();
  state.selection.fileIds.add(clone.id);
  // 若指定了 pageZ → 寫入 clone 的 page[0].z;會影響後續 propagation 用到的 depth
  if (opts && Number.isFinite(opts.pageZ)) {
    if (!clone.pages) clone.pages = {};
    if (!clone.pages[0]) clone.pages[0] = { joints: [], members: [], z: 0 };
    clone.pages[0].z = opts.pageZ;
  }
  // 衍生模型:clone 出現在 state.files 後,所有切面線會在 render 時即時對 clone 推算,不必預先寫入
  console.log(`[複製檔案] ${src.name} → ${newName}(節點 ${Object.values(clonedPages).reduce((s, p) => s + p.joints.length, 0)} · 桿件 ${Object.values(clonedPages).reduce((s, p) => s + p.members.length, 0)})`);
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  refreshFileList(); refreshPageSelector();
  // opts.activate === false:複製後不切換 active page(切面 dialog 等情境用)
  if (!(opts && opts.activate === false)) {
    activatePage(clone.id, 0);
  }
  return clone;
}

export let splitContext = null;
export function _setSplitContext(ctx) { splitContext = ctx; }
export function showSplitDim(rect) {
  let dim = document.getElementById("splitDim");
  if (!dim) {
    dim = document.createElement("div");
    dim.id = "splitDim";
    stage.insertBefore(dim, svg);
  }
  dim.style.width = state.bgWidth + "px";
  dim.style.height = state.bgHeight + "px";
  dim.style.zIndex = "5";
  const w = state.bgWidth, h = state.bgHeight;
  const x1 = Math.max(0, rect.x), y1 = Math.max(0, rect.y);
  const x2 = Math.min(w, rect.x + rect.w), y2 = Math.min(h, rect.y + rect.h);
  dim.style.clipPath = `path(evenodd, "M0,0 H${w} V${h} H0 Z M${x1},${y1} H${x2} V${y2} H${x1} Z")`;
  dim.style.display = "block";
}
function hideSplitDim() {
  const dim = document.getElementById("splitDim");
  if (dim) dim.remove();
}
function openSplitDialog() {
  if (state.selection.joints.size + state.selection.members.size === 0) {
    alert("請先框選或選取要拆分的節點 / 桿件。");
    return;
  }
  const p = getPage();
  if (!p || p._orphan) { alert("請先載入並啟用一個頁面。"); return; }
  // 計算要搬移的圖元集合
  const movedJ = new Set(state.selection.joints);
  for (const id of state.selection.members) {
    const m = p.members.find(x => x.id === id);
    if (m) { movedJ.add(m.j1); movedJ.add(m.j2); }
  }
  const movedM = new Set(state.selection.members);
  for (const m of p.members) {
    if (movedJ.has(m.j1) && movedJ.has(m.j2)) movedM.add(m.id);
  }
  // 計算矩形(優先 marquee,否則 bbox)
  let rect = null;
  if (state.lastMarquee && state.lastMarquee.w > 0 && state.lastMarquee.h > 0) {
    rect = { ...state.lastMarquee };
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of movedJ) {
      const j = p.joints.find(x => x.id === id);
      if (!j) continue;
      if (j.x < minX) minX = j.x;
      if (j.x > maxX) maxX = j.x;
      if (j.y < minY) minY = j.y;
      if (j.y > maxY) maxY = j.y;
    }
    if (isFinite(minX)) {
      const pad = 20;
      rect = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    }
  }
  if (!rect) { alert("無法判斷拆分範圍。"); return; }
  splitContext = { movedJ, movedM, rect };
  showSplitDim(rect);
  $("splitName").value = "拆分_" + (state.files.length + 1);
  $("splitDialog").style.display = "flex";
  setTimeout(() => $("splitName").focus(), 30);
}
// 掃描目前 #bgSvg 中所有帶 data-bg-idx 的元素,回傳「螢幕 bbox 對應回世界座標後與 rect 重疊」的 index set。
//   用於拆分頁面時過濾底圖:讓新檔案只帶「框選範圍內」的 SVG 元素,不用共用整張大底圖。
//   實作注意:不能用 getBBox() — PDF 的 SVG 有巢狀 <g> transforms,getBBox 回傳的是父層本地座標,
//   跟 rect(stage 世界座標)不同空間會比對錯亂。改用 getBoundingClientRect() + screenToWorld()
//   走螢幕座標中繼,兩種結構(DXF 平鋪 / PDF 巢狀)都能正確處理。
function computeBgKeepForRect(rect) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return null;
  const keep = new Set();
  const shapes = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of shapes) {
    // 被使用者刪除的 bg 線(display:none)→ 不納入新檔
    if (el.style && el.style.display === "none") continue;
    const rc = el.getBoundingClientRect();
    if (rc.width === 0 && rc.height === 0) continue;   // 隱藏或沒渲染
    const p1 = screenToWorld(rc.left, rc.top);
    const p2 = screenToWorld(rc.right, rc.bottom);
    const bx1 = Math.min(p1.x, p2.x), by1 = Math.min(p1.y, p2.y);
    const bx2 = Math.max(p1.x, p2.x), by2 = Math.max(p1.y, p2.y);
    // AABB 重疊判定
    if (bx2 < rect.x) continue;
    if (bx1 > rect.x + rect.w) continue;
    if (by2 < rect.y) continue;
    if (by1 > rect.y + rect.h) continue;
    keep.add(String(el.dataset.bgIdx));
  }
  return keep;
}

// 解析 cachedBgSvg 文字,移除所有不在 keep 集合中的 data-bg-idx 元素,回傳縮減後的 SVG 文字
function filterCachedBgSvg(svgText, keep) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("SVG parse error");
  const root = doc.documentElement;
  const shapes = root.querySelectorAll("[data-bg-idx]");
  let removed = 0;
  for (const el of shapes) {
    if (!keep.has(String(el.dataset.bgIdx))) { el.remove(); removed++; }
  }
  console.log(`[拆分] 底圖過濾:保留 ${keep.size} 個元素,移除 ${removed} 個`);
  return new XMLSerializer().serializeToString(root);
}

async function applySplit() {
  if (!splitContext) return;
  const name = $("splitName").value.trim();
  if (!name) { alert("請輸入名稱"); $("splitName").focus(); return; }
  if (state.files.some(f => f.name === name)) { alert("名稱已存在,不可重複"); return; }
  const { movedJ, movedM, rect } = splitContext;
  const p = getPage();
  const src = getActiveFile();

  // 若來源有向量 SVG 快取(DXF / PDF 向量模式)→ 先過濾一份只含「框內元素」的獨立 SVG,
  // 讓新檔案自我封閉(不再共用整張大 cachedBgSvg);DXF 拆分後可大幅減少記憶體與專案檔體積。
  let filteredBgSvg = null;
  if (src && src.cachedBgSvg) {
    // 先隱藏對話框(z-index 2500 會擋住 busy spinner z-index 2000,使用者看不到進度)
    $("splitDialog").style.display = "none";
    showBusy("拆分底圖中…(過濾 SVG 元素)");
    await busyTick();
    try {
      const keep = computeBgKeepForRect(rect);
      if (keep) filteredBgSvg = filterCachedBgSvg(src.cachedBgSvg, keep);
    } catch (e) {
      console.warn("[拆分] 底圖過濾失敗,退回共用來源模式:", e);
      filteredBgSvg = null;
    }
    hideBusy();
  }

  pushUndo();
  // 拆分:把範圍內的圖元「複製」到新檔(非破壞性 — 原檔保留);為新檔的圖元重新分配 ID 避免跨檔衝突
  const idMap = new Map();
  const newJoints = [];
  for (const j of p.joints) {
    if (!movedJ.has(j.id)) continue;
    const clone = JSON.parse(JSON.stringify(j));
    const nid = allocJointId();
    idMap.set(j.id, nid);
    clone.id = nid;
    newJoints.push(clone);
  }
  const newMembers = [];
  for (const m of p.members) {
    if (!movedM.has(m.id)) continue;
    const nj1 = idMap.get(m.j1), nj2 = idMap.get(m.j2);
    if (nj1 == null || nj2 == null) continue;  // 端點不在範圍中(跨界桿件)→ 略過
    const clone = JSON.parse(JSON.stringify(m));
    clone.id = allocMemberId();
    clone.j1 = nj1;
    clone.j2 = nj2;
    newMembers.push(clone);
  }
  // 原檔不再移除任何圖元:保留完整內容,使用者若要清理可以手動刪除
  const file = {
    id: allocFileId(),
    name,
    sourceName: "(拆分)" + name,
    type: src && src.type ? src.type : "split",
    pageCount: 1,
    bgWidth: state.bgWidth,
    bgHeight: state.bgHeight,
    pages: { 0: { joints: newJoints, members: newMembers, z: p.z || 0 } },
  };
  if (src) {
    file.rotation = src.rotation || 0;
    file.offsetX = src.offsetX || 0;
    file.offsetY = src.offsetY || 0;
    file.detectedStrokeWidth = src.detectedStrokeWidth;
    // 拆分頁保留與來源一致的世界座標空間 → 比例尺 / 原點 的設定在新檔仍然成立,直接繼承
    //   即使 scaleRuler 的視覺線段位於 clipRect 之外,CSS clip-path 會把它隱藏,但 ratio 仍生效
    if (src.scaleRuler)  file.scaleRuler  = JSON.parse(JSON.stringify(src.scaleRuler));
    if (src.planeOrigin) file.planeOrigin = JSON.parse(JSON.stringify(src.planeOrigin));
    if (filteredBgSvg) {
      // 有獨立、縮減版的 SVG → 新檔自帶完整底圖,不再需要從來源讀取
      //   座標空間維持與來源一致(clipRect 仍有效),但 DOM 元素數量大幅減少
      //   sourceFileId 仍保留:fileTypeLabel 靠它判斷「拆分檔(-S 後綴)」;即使來源被刪,
      //   這個 ID 只會變成 dangling ref,fileTypeLabel 的走鏈會 graceful break,不影響渲染
      file.cachedBgSvg    = filteredBgSvg;
      file.cachedBgWidth  = src.cachedBgWidth  || state.bgWidth;
      file.cachedBgHeight = src.cachedBgHeight || state.bgHeight;
      file.sourceFileId   = src.sourceFileId || src.id;
      // 不帶 pdf / image / cachedBgImg:新檔渲染走 cachedBgSvg 路徑
    } else {
      // 無 SVG 快取(PDF raster / 原生圖片)→ 無法過濾,維持原本共用來源行為
      if (src.pdf) { file.pdf = src.pdf; file.pdfPage = src.pdfPage; }
      if (src.image) {
        file.image = src.image;
        file.imageWidth = src.imageWidth;
        file.imageHeight = src.imageHeight;
      }
      if (src.cachedBgSvg) file.cachedBgSvg = src.cachedBgSvg;
      if (src.cachedBgImg) file.cachedBgImg = src.cachedBgImg;
      if (src.cachedBgWidth)  file.cachedBgWidth  = src.cachedBgWidth;
      if (src.cachedBgHeight) file.cachedBgHeight = src.cachedBgHeight;
      // 追蹤來源檔案:專案儲存時可共用 PDF/圖片 buffer(以 sourceFileId 去重)
      file.sourceFileId = src.sourceFileId || src.id;
    }
  }
  file.clipRect = rect;
  state.lastMarquee = null;
  state.files.push(file);
  closeSplitDialog();
  clearSelection();
  refreshFileList(); refreshPageSelector();
  render(); refreshLists();
  activatePage(file.id, 0);
}
function closeSplitDialog() {
  $("splitDialog").style.display = "none";
  hideSplitDim();
  splitContext = null;
  state.splitMode = false;
  state.splitFirstCorner = null;
  $("btnSplit").classList.remove("active");
  applyTransform();
}
$("splitConfirm") && ($("splitConfirm").onclick = applySplit);
$("splitCancel")  && ($("splitCancel").onclick = closeSplitDialog);
$("splitName") && $("splitName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applySplit();
  else if (e.key === "Escape") closeSplitDialog();
});

// 配對中:把點到的 view joint 綁到 pendingGlobalPair。回傳 true 表示已處理(呼叫端應 return)
export function tryConsumePendingGlobalPair(j) {
  if (state.pendingGlobalPair == null) return false;
  const gid = state.pendingGlobalPair;
  if (j.globalId === gid) {
    // 已綁:再點一次就視為「結束配對」
    state.pendingGlobalPair = null;
    $("hud").textContent = "全局節點配對結束";
    render(); refreshLists();
    return true;
  }
  pushUndo();
  bindJointToGlobal(j, gid);
  // pendingGlobalPair 保持,讓使用者可以連續綁多個視圖
  const g = findGlobalJointById(gid);
  const n = g ? countBindings(g.id) : 0;
  $("hud").textContent = `已綁 ${g ? g.label : ""} (共 ${n} 個視圖)— 繼續點選或按 Esc 結束`;
  render(); refreshLists();
  return true;
}

// ---------- 全局節點:ctx menu 操作 ----------
function getCtxSingleJoint() {
  if (!ctxState.pending) return null;
  if (ctxState.pending.joints.size !== 1 || ctxState.pending.members.size !== 0) return null;
  const id = [...ctxState.pending.joints][0];
  return getPage().joints.find(j => j.id === id) || null;
}
$("ctxPromoteGlobal").onclick = (e) => {
  e.stopPropagation();
  const j = getCtxSingleJoint();
  if (!j) return;
  pushUndo();
  const g = createGlobalJoint();
  bindJointToGlobal(j, g.id);
  state.pendingGlobalPair = g.id;
  hideCtxMenu();
  $("hud").textContent = `已建立全局節點 ${g.label} — 切到其他頁,點選對應節點即可綁到 ${g.label}(Esc 取消)`;
  render(); refreshLists();
};
$("ctxBindGlobal").onclick = (e) => {
  e.stopPropagation();
  const j = getCtxSingleJoint();
  if (!j) return;
  hideCtxMenu();
  openGbindDialog(j);
};
$("ctxUnbindGlobal").onclick = (e) => {
  e.stopPropagation();
  const j = getCtxSingleJoint();
  if (!j || j.globalId == null) return;
  pushUndo();
  unbindJointFromGlobal(j);
  hideCtxMenu();
  render(); refreshLists();
};

// ---------- 綁定挑選對話框 ----------
let gbindTargetJoint = null;
function openGbindDialog(joint) {
  gbindTargetJoint = joint;
  const list = $("gbindList");
  list.innerHTML = "";
  const sorted = [...state.globalJoints].sort((a, b) => a.id - b.id);
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "#9aa0a6";
    empty.style.padding = "8px";
    empty.textContent = (typeof _t==="function"&&_t("list.noGlobalJoints"))||"(尚無全局節點)";
    list.appendChild(empty);
  }
  for (const g of sorted) {
    const n = countBindings(g.id);
    const row = document.createElement("div");
    row.className = "gbind-row";
    const isCur = (joint.globalId === g.id);
    row.innerHTML = `<span class="gbind-label">${g.label}${isCur ? " ✓" : ""}</span>`
      + `<span class="gbind-meta">${n} 個視圖綁定</span>`;
    row.onclick = () => {
      pushUndo();
      bindJointToGlobal(joint, g.id);
      // GC 原本綁的(若改綁過來,原 globalId 可能無人引用)— 由 unbind 路徑統一處理:
      // 但 bindJointToGlobal 沒走 unbind 流程,所以這裡顯式 GC
      // (其實不必:countBindings 會把新綁的也算進去,所以原 globalId 若還有他人綁就不會被刪)
      $("gbindDialog").style.display = "none";
      gbindTargetJoint = null;
      render(); refreshLists();
    };
    list.appendChild(row);
  }
  $("gbindDialog").style.display = "flex";
}
$("gbindCancel").onclick = () => {
  $("gbindDialog").style.display = "none";
  gbindTargetJoint = null;
};
$("gbindNew").onclick = () => {
  if (!gbindTargetJoint) return;
  pushUndo();
  const g = createGlobalJoint();
  bindJointToGlobal(gbindTargetJoint, g.id);
  state.pendingGlobalPair = g.id;
  $("gbindDialog").style.display = "none";
  $("hud").textContent = `已建立全局節點 ${g.label} — 切到其他頁,點選對應節點即可綁到 ${g.label}(Esc 取消)`;
  gbindTargetJoint = null;
  render(); refreshLists();
};

// ---------- 三視圖自動配對 對話框 ----------
// openAutoPairDialog / closeAutoPairDialog / rescanAutoPair + _apCandidates state
// 搬到 src/dialogs/triViewPair.ts;autoPairBtn onclick 用 wire 函式延後綁
import {
  openAutoPairDialog,
  closeAutoPairDialog,
  rescanAutoPair,
  getApCandidates,
  setApCandidates,
  wireTriViewPairButtons,
} from "../dialogs/triViewPair";
wireTriViewPairButtons();
export {
  openAutoPairDialog,
  closeAutoPairDialog,
  rescanAutoPair,
  getApCandidates,
  setApCandidates,
};

// Phase 8k:3D 立體預覽 popup 搬到 src/dialogs/preview3d.ts(~1700 行,大宗)
//   _3dPreviewWindow ref 還留在 legacy:i18n / busy / 主視窗 rebuild hook 都會讀,
//   preview3d 走 setP3dPreviewWindow setter 寫(ESM cross-module)。
export let _3dPreviewWindow: any = null;
export function setP3dPreviewWindow(v: any) { _3dPreviewWindow = v; }
import { open3DPreviewDialog } from "../dialogs/preview3d";
export { open3DPreviewDialog } from "../dialogs/preview3d";
$("btn3DPreview") && ($("btn3DPreview").onclick = open3DPreviewDialog);

// ===== 材料管理(工具 → 材料管理) =====
//   獨立 popup window;CRUD state.materials,使用者搜尋桿件時可從下拉選用
export let _materialMgrWin: any = null;
// Phase 8e:跨模組(materialMgr)要寫這個 ref → 必須走 setter
export function setMaterialMgrWin(v: any) { _materialMgrWin = v; }
// Phase 8e:openMaterialMgrWindow(材料管理 popup)搬到 src/dialogs/materialMgr.ts
import { openMaterialMgrWindow } from "../dialogs/materialMgr";

// Phase 8l:搜尋 popup(openSearchWindow / _searchModel / _renderSearchResults / _parseIdsWithRanges / history helpers)搬到 src/dialogs/search.ts(~2150 行)
//   _searchWin / _searchWinAutofill declaration + setter 留在 legacy(i18n.applyI18n 會 read _searchWin live binding)
export let _searchWin: any = null;
export function setSearchWin(v: any) { _searchWin = v; }
let _searchWinAutofill: any = null;
export function setSearchWinAutofill(v: any) { _searchWinAutofill = v; }
import { openSearchWindow } from "../dialogs/search";
export { openSearchWindow } from "../dialogs/search";

// 主頁面 Cmd/Ctrl+F → 開搜尋視窗(避免攔截 input 內的搜尋輸入)
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
  if (e.key !== "f" && e.key !== "F") return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
  e.preventDefault();
  openSearchWindow();
});

// 全局原點校準:用 prompt 讓使用者挑一個 globalJoint 當原點(預設第一個)→ 跑校準
$("btnSetGlobalOrigin") && ($("btnSetGlobalOrigin").onclick = () => {
  if (!Array.isArray(state.globalJoints) || state.globalJoints.length === 0) {
    alert("請先建立至少一個全局節點(在多個檔案上選同一個物理位置的節點 → 設為全局節點)");
    return;
  }
  // 列出 globalJoints 給使用者挑;每行附「世界座標 + 綁的 joint 數 + 跨幾個檔」,方便辨認
  const _fmtCoord = (v) => Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : "—";
  // 統計每個 globalJoint 被多少 joint / 多少 file 綁定
  const bindStats = new Map();   // gid → { jointCount, fileSet }
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) {
        if (j.globalId == null) continue;
        let s = bindStats.get(j.globalId);
        if (!s) { s = { jointCount: 0, fileSet: new Set() }; bindStats.set(j.globalId, s); }
        s.jointCount++;
        s.fileSet.add(f.id);
      }
    }
  }
  const lines = state.globalJoints.map((g, i) => {
    const tag = g.label || ('N' + g.id);
    const coord = `(${_fmtCoord(g.x)}, ${_fmtCoord(g.y)}, ${_fmtCoord(g.z)})`;
    const s = bindStats.get(g.id) || { jointCount: 0, fileSet: new Set() };
    const lockMark = g.locked ? " 🔒" : "";
    const curMark = (state.globalOriginId === g.id) ? " ← 目前原點" : "";
    return `${i + 1}. ${tag}${lockMark} ・ ${coord} ・ 綁 ${s.jointCount} 顆 joint / ${s.fileSet.size} 檔${curMark}`;
  }).join("\n");
  const cur = state.globalOriginId;
  const curIdx = cur != null ? state.globalJoints.findIndex(g => g.id === cur) : -1;
  const def = (curIdx >= 0 ? curIdx : 0) + 1;
  const choice = prompt(
    `請輸入要當作世界原點的全局節點編號(1~${state.globalJoints.length}):\n\n${lines}\n\n` +
    `說明:座標 = 該全局節點目前的世界座標(mm)。\n` +
    `「綁 N 顆 joint / M 檔」= 共有 M 個檔案的 N 個本地 joint 指到這個全局節點。\n` +
    `校準後此全局節點會被鎖定在世界 (0, 0, 0),所有有綁定它的檔案會自動調整 planeOrigin / pageZ。`,
    String(def)
  );
  if (choice == null) return;
  const idx = parseInt(choice, 10) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= state.globalJoints.length) {
    alert("無效的編號");
    return;
  }
  const G = state.globalJoints[idx];
  calibrateAllFilesToGlobalOrigin({ globalJointId: G.id });
});
// 自訂世界原點座標:用 prompt 收三個數字 → 跑 calibrateAllFilesToCustomOrigin
$("btnSetCustomOrigin") && ($("btnSetCustomOrigin").onclick = () => {
  const filesWithScale = state.files.filter(f => f.scaleRuler && f.scaleRuler.ratio > 0);
  if (!filesWithScale.length) {
    alert("沒有任何檔案有比例尺,無法校準。請先在至少一個檔案建立比例尺。");
    return;
  }
  const raw = prompt(
    `輸入要當作世界原點的目前世界座標 (X, Y, Z),用逗號或空白分隔(單位 mm):\n\n` +
    `說明:輸入的 (X, Y, Z) = 目前模型中你想當作 (0, 0, 0) 的物理位置的世界座標。\n` +
    `例:輸入「1000, 0, 2500」→ 校準後,原本位於世界 (1000, 0, 2500) 的物理點會變成 (0, 0, 0);其他 joint 的世界座標都對應減去 (1000, 0, 2500)。\n\n` +
    `不需要對應任何已存在的 joint。會校準 ${filesWithScale.length} 個有比例尺的檔案。`,
    "0, 0, 0"
  );
  if (raw == null) return;
  const parts = raw.split(/[,\s]+/).filter(s => s.length > 0).map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    alert("格式錯誤;請輸入三個數字(用逗號或空白分隔),例如:1000, 0, 2500");
    return;
  }
  calibrateAllFilesToCustomOrigin(parts[0], parts[1], parts[2]);
});
$("btnClearGlobalOrigin") && ($("btnClearGlobalOrigin").onclick = () => {
  if (state.globalOriginId == null) return;
  if (!confirm("解除全局原點指定?(只清狀態,各檔案的 planeOrigin / pageZ 不會還原)")) return;
  pushUndo();
  const G = state.globalJoints.find(g => g.id === state.globalOriginId);
  if (G) G.locked = false;
  state.globalOriginId = null;
  if (typeof refreshLists === "function") refreshLists();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  render();
});

// 顯示「解除原點」按鈕的條件 = 已指定全局原點時才顯示
export function _updateGlobalOriginUI() {
  // 沒有 globalJoints → 隱藏 globalJoint-based 校準按鈕,改顯示提示文字
  const hasGJ = Array.isArray(state.globalJoints) && state.globalJoints.length > 0;
  const calibWrap = $("globalOriginCalibBtns");
  const hint = $("globalJointHint");
  if (calibWrap) calibWrap.style.display = hasGJ ? "flex" : "none";
  if (hint)      hint.style.display      = hasGJ ? "none" : "";
  const btn = $("btnClearGlobalOrigin");
  if (btn) btn.style.display = (state.globalOriginId != null) ? "" : "none";
  // 更新「本頁設為全局原點」相關 UI
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  const isCurFileOrigin = !!(af && state.globalOriginFileId === af.id);
  const setBtn = $("btnSetFileAsOrigin");
  const unsetBtn = $("btnUnsetFileAsOrigin");
  if (setBtn) {
    if (isCurFileOrigin) {
      _setBtnLabel(setBtn, "rb.setOriginCurrent", "本頁 ✓ 全局原點");
      setBtn.style.background = "#2f7a3f";
    } else {
      _setBtnLabel(setBtn, "rb.setOrigin", "本頁原點 = 世界原點");
      setBtn.style.background = "";
    }
  }
  if (unsetBtn) unsetBtn.style.display = (state.globalOriginFileId != null) ? "" : "none";
  // info 文字:目前哪個檔案是全局原點
  const info = $("globalOriginInfo");
  if (info) {
    if (state.globalOriginFileId != null) {
      const ofile = state.files.find(f => f.id === state.globalOriginFileId);
      if (ofile) {
        const origin = ofile.planeOrigin;
        const op = ofile.pages && ofile.pages[0];
        const plane = op ? (op.plane || "?") : "?";
        const pz = op ? (op.z != null ? op.z : 0) : "?";
        info.style.display = "";
        info.textContent = `當前全局原點:${ofile.name}・${plane}・第三軸=${pz}` +
          (origin ? `・origin=(${origin.x.toFixed(0)}, ${origin.y.toFixed(0)})` : "・尚無 planeOrigin");
      } else {
        info.style.display = "none";
      }
    } else {
      info.style.display = "none";
    }
  }
}
_updateGlobalOriginUI();
$("btnSetFileAsOrigin") && ($("btnSetFileAsOrigin").onclick = () => {
  const af = getActiveFile();
  if (!af) { alert("請先選擇一個檔案"); return; }
  if (!af.planeOrigin) {
    alert(`目前檔案「${af.name}」尚未設定平面座標原點。請先設定原點再把它指定為全局原點。`);
    return;
  }
  if (!af.scaleRuler || !(af.scaleRuler.ratio > 0)) {
    alert(`目前檔案「${af.name}」尚未設定比例尺。請先建立比例尺。`);
    return;
  }
  pushUndo();
  state.globalOriginFileId = af.id;
  // 鎖定:這個檔案的 planeOrigin + pageZ 即是世界 (0,0,0)
  // 後續其他檔案的 planeOrigin 應由使用者手動設在同一物理位置
  if (typeof refreshLists === "function") refreshLists();
  if (typeof refreshFileList === "function") refreshFileList();
  _updateGlobalOriginUI();
  render();
  console.log(`[全局原點檔案] 設定 ${af.name} 為全局原點源`);
});
$("btnUnsetFileAsOrigin") && ($("btnUnsetFileAsOrigin").onclick = () => {
  if (state.globalOriginFileId == null) return;
  pushUndo();
  state.globalOriginFileId = null;
  if (typeof refreshLists === "function") refreshLists();
  if (typeof refreshFileList === "function") refreshFileList();
  _updateGlobalOriginUI();
  render();
});
$("apCancel") && ($("apCancel").onclick = closeAutoPairDialog);
$("apRescan") && ($("apRescan").onclick = rescanAutoPair);
$("apApply") && ($("apApply").onclick = () => {
  const list = $("apList");
  const checks = list.querySelectorAll("input[type=checkbox]:checked");
  if (!checks.length) { closeAutoPairDialog(); return; }
  const picked = [];
  checks.forEach(cb => {
    const idx = parseInt(cb.dataset.idx, 10);
    if (Number.isFinite(idx) && _apCandidates[idx]) picked.push(_apCandidates[idx]);
  });
  if (!picked.length) { closeAutoPairDialog(); return; }
  pushUndo();
  const r = applyAutoPairings(picked);
  closeAutoPairDialog();
  $("hud").textContent = `自動配對:建立 ${r.triples} 組三面 + ${r.pairs} 組雙面 → 共 ${r.triples + r.pairs} 個全局節點`;
  render(); refreshLists();
});

$("ctxDelete").onclick = (e) => {
  e.stopPropagation();
  if (!ctxState.pending) return;
  if (ctxState.pending.bgPaths && ctxState.pending.bgPaths.size) {
    hideCtxMenu();
    deleteSelectedBgPaths();
    return;
  }
  if (ctxState.pending.fileIds && ctxState.pending.fileIds.size) {
    state.selection.fileIds = new Set(ctxState.pending.fileIds);
    hideCtxMenu();
    deleteSelectedFiles();
    return;
  }
  clearSelection();
  ctxState.pending.joints.forEach((id) => state.selection.joints.add(id));
  ctxState.pending.members.forEach((id) => state.selection.members.add(id));
  hideCtxMenu();
  deleteSelection();
};

// ---------- side lists ----------
export function refreshLists() {
  // 同時更新檔案清單與頁次選單,確保節點/桿件數量同步
  if (typeof refreshFileList === "function") refreshFileList();
  if (typeof refreshPageSelector === "function") refreshPageSelector();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  if (typeof _refreshFloorTypeSidebar === "function") _refreshFloorTypeSidebar();
  if (typeof _updateAnchorToggleBtn === "function") _updateAnchorToggleBtn();
  const p = getPage();
  const af0 = getActiveFile();
  const orig = af0 && af0.planeOrigin;
  const jl = $("jointList"); jl.innerHTML = "";
  // 依內部 id 由小到大排序(顯示用的 displayJointId 與 id 同序;直接用 id 確保穩定)
  const jointsSorted = [...p.joints].sort((a, b) => a.id - b.id);
  // 軸名 header(對應 page.plane:XY → (x, y)、YZ → (z, y)、XZ → (x, z))。
  //   無 plane / 無校準 → 不顯示軸名(維持舊行為,row 顯示 px 或 raw)。
  const _axisLabelEl = $("jointListAxisLabel");
  if (_axisLabelEl) {
    let _axisLabelTxt = "";
    if (state.scale && p && p.plane) {
      const _probe = _inPlaneCoordsForJoint(af0, p, p.joints[0] || { x: 0, y: 0 });
      if (_probe) {
        _axisLabelTxt = ` (${_probe.axisA.toLowerCase()}, ${_probe.axisB.toLowerCase()})`;
      }
    }
    _axisLabelEl.textContent = _axisLabelTxt;
  }
  for (const j of jointsSorted) {
    const it = document.createElement("div");
    it.className = "item" + (state.selection.joints.has(j.id) ? " sel" : "");
    let real;
    if (state.scale) {
      const proj = _inPlaneCoordsForJoint(af0, p, j);
      if (proj) {
        // 用世界投影值 — flipX / flipY / planeOrigin / scaleRuler 已全套上,精準度走 measureDecimals
        real = `${fmtWorld3D(proj.valA)}, ${fmtWorld3D(proj.valB)} ${state.unitName}`;
      } else if (orig) {
        real = `${fmtWorld3D((j.x - orig.x)/state.scale)}, ${fmtWorld3D((orig.y - j.y)/state.scale)} ${state.unitName}`;
      } else {
        real = `${fmtWorld3D(j.x/state.scale)}, ${fmtWorld3D(-j.y/state.scale)} ${state.unitName}`;
      }
    } else {
      real = `${j.x.toFixed(0)}, ${j.y.toFixed(0)} px`;
    }
    it.innerHTML = `<span>J${displayJointId(j)}</span><span style="color:#9aa0a6">${real}</span>`;
    it.onclick = (e) => {
      if (!additiveSelect(e)) clearSelection();
      state.selection.joints.add(j.id);
      render(); refreshLists();
    };
    it.oncontextmenu = (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, { type: "joint", id: j.id, el: it });
    };
    jl.appendChild(it);
  }
  // 全局節點清單(縮減版 — 只列「目前這頁有綁的」全局節點;點任一筆 → 跳轉 popup;完整 CRUD 走「工具 → 全局節點管理」)
  const gl = $("globalJointList");
  if (gl) {
    gl.innerHTML = "";
    const af = getActiveFile();
    const allG = [...(state.globalJoints || [])].sort((a, b) => a.id - b.id);
    const curG = allG.filter(g => listGlobalBindings(g.id).some(b => b.fileId === (af && af.id) && b.pageIdx === state.pageIdx));
    if (allG.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#9aa0a6";
      empty.style.fontSize = "11px";
      empty.style.padding = "4px 2px";
      empty.textContent = (typeof _t==="function"&&_t("rb.globalJointHintShort"))||"(尚無全局節點 — 右鍵節點選「設為全局節點」)";
      gl.appendChild(empty);
    } else if (curG.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#9aa0a6";
      empty.style.fontSize = "11px";
      empty.style.padding = "4px 2px;line-height:1.5";
      empty.style.padding = "4px 2px";
      empty.innerHTML = `(本頁無綁定全局節點 — 共 ${allG.length} 個全局節點散佈在其他頁面)<br>完整清單與管理請到「工具 → 全局節點管理」`;
      gl.appendChild(empty);
    } else {
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:10px;color:#7b818a;padding:2px 2px 4px;line-height:1.4";
      hint.innerHTML = `本頁綁定 <b style="color:#4fc3f7">${curG.length}</b> / 共 <b>${allG.length}</b> ・ 點任一筆跳到綁定的其他頁面 ・ 完整管理:工具 → 全局節點管理`;
      gl.appendChild(hint);
    }
    for (const g of curG) {
      const binds = listGlobalBindings(g.id);
      const isPending = state.pendingGlobalPair === g.id;
      const hasW = (g.warnings && g.warnings.length > 0);
      const isOrigin = (state.globalOriginId === g.id);
      const it = document.createElement("div");
      it.className = "item";
      if (isPending) it.style.outline = "1px dashed #ffd23f";
      const coordTxt = (g.x != null || g.y != null || g.z != null)
        ? `(${fmtWorld3D(g.x)}, ${fmtWorld3D(g.y)}, ${fmtWorld3D(g.z)}) ${state.unitName || "?"}`
        : "(3D 未推得)";
      const warnDot = hasW ? `<span style="color:#ff7043">⚠</span>` : "";
      const originBadge = isOrigin ? `<span style="background:#ffe066;color:#000;padding:0 4px;border-radius:3px;font-size:9px;font-weight:700;margin-left:4px">原點</span>` : "";
      it.innerHTML = `<span style="color:#4fc3f7">${g.label}${isPending ? " ⋯" : ""} ${warnDot}${originBadge}</span>`
        + `<span style="color:#9aa0a6">${coordTxt}・${binds.length} 處</span>`;
      it.title = `全局節點 ${g.label}・${binds.length} 個視圖綁定`
        + (isOrigin ? "(目前為世界原點 0,0,0)" : "")
        + (isPending ? "(配對中)" : "")
        + (hasW ? "\n警告:\n" + g.warnings.map(w => "  • " + w.message).join("\n") : "")
        + "\n\n點擊 → 選要跳到的頁面";
      it.onclick = (ev) => {
        ev.stopPropagation();
        if (typeof showGlobalJointJumpPopup === "function") showGlobalJointJumpPopup(it, g.id);
      };
      gl.appendChild(it);
    }
  }

  const ml = $("memberList"); ml.innerHTML = "";
  // 桿件同樣依內部 id 由小到大排序
  const membersSorted = [...p.members].sort((a, b) => a.id - b.id);
  for (const m of membersSorted) {
    const it = document.createElement("div");
    it.className = "item" + (state.selection.members.has(m.id) ? " sel" : "");
    const a = jointById(m.j1), b = jointById(m.j2);
    let len = "";
    if (a && b && state.scale) {
      const d = Math.hypot(a.x-b.x, a.y-b.y) / state.scale;
      len = `${fmtCoord(d)} ${state.unitName}`;
    }
    it.innerHTML = `<span>M${displayMemberId(m)} (J${displayJointId({id:m.j1})}–J${displayJointId({id:m.j2})})</span><span style="color:#9aa0a6">${len}</span>`;
    it.onclick = (e) => {
      if (!additiveSelect(e)) clearSelection();
      state.selection.members.add(m.id);
      render(); refreshLists();
    };
    it.oncontextmenu = (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, { type: "member", id: m.id, el: it });
    };
    ml.appendChild(it);
  }
}

// ---------- inputs ----------
$("snapPx").onchange = (e) => state.snapPx = parseFloat(e.target.value);
$("snapAxis").onchange = (e) => { state.ortho = e.target.checked; };
$("snapMid").onchange = (e) => { state.snapMid = e.target.checked; };
$("snapGridStep").onchange = (e) => {
  state.snapGrid.step = parseFloat(e.target.value) || 1;
  updateSnapGridBtn();
  render();
};
$("bgSnapTolerance") && ($("bgSnapTolerance").onchange = (e) => {
  const v = Number(e.target.value);
  state.bgSnapTolerance = Number.isFinite(v) && v >= 0 ? v : 1;
  e.target.value = state.bgSnapTolerance;
});
$("coordDecimals") && ($("coordDecimals").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  state.coordDecimals = (Number.isFinite(v) && v >= 0 && v <= 6) ? v : 0;
  e.target.value = state.coordDecimals;
  refreshLists();
});
$("measureDecimals") && ($("measureDecimals").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  state.measureDecimals = (Number.isFinite(v) && v >= 0 && v <= 6) ? v : 0;
  e.target.value = state.measureDecimals;
  if (typeof _refreshAllMeasurementLabels === "function") _refreshAllMeasurementLabels();
  // 精準度改變 → globalJoint 座標也要重新對齊新精準度(0 → -0 / 224.7 → 225 之類)
  pushUndo();
  const touched = (typeof snapAllGlobalJointsToPrecision === "function") ? snapAllGlobalJointsToPrecision() : 0;
  if (touched) console.log(`[精準度] globalJoint 座標重新對齊 ${touched} 個`);
  // 顯示位數即 rank bucket 大小 → 改了之後 node 編號需要重算
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  render();
});

// 已載入檔案清單欄位顯示開關(在 popup 中)
function bindFileListShowCheckbox(id, key) {
  const el = $(id);
  if (!el) return;
  el.checked = !!(state.fileListShow && state.fileListShow[key] !== false);
  el.onchange = () => {
    if (!state.fileListShow) state.fileListShow = { type: true, plane: true, stats: true };
    state.fileListShow[key] = !!el.checked;
    refreshFileList();
  };
}
bindFileListShowCheckbox("fileListShowType",  "type");
bindFileListShowCheckbox("fileListShowPlane", "plane");
bindFileListShowCheckbox("fileListShowStats", "stats");

// Popup 顯示 / 隱藏:點 ⚙ 開關;點外面關閉
function positionFileListShowPopup() {
  const btn = $("fileListShowBtn"), pop = $("fileListShowPopup");
  if (!btn || !pop) return;
  const r = btn.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = (r.bottom + 4) + "px";
  // 偏左對齊到按鈕,但若超出右邊界就右對齊
  const popW = pop.offsetWidth || 220;
  let left = r.right - popW;
  if (left < 8) left = 8;
  pop.style.left = left + "px";
}
$("fileListShowBtn") && ($("fileListShowBtn").onclick = (e) => {
  e.stopPropagation();
  const pop = $("fileListShowPopup");
  if (!pop) return;
  const open = pop.style.display === "block";
  if (open) { pop.style.display = "none"; return; }
  pop.style.display = "block";
  positionFileListShowPopup();
});
document.addEventListener("click", (e) => {
  const pop = $("fileListShowPopup");
  if (!pop || pop.style.display !== "block") return;
  if (pop.contains(e.target)) return;
  if (e.target && e.target.id === "fileListShowBtn") return;
  pop.style.display = "none";
});
window.addEventListener("resize", () => {
  const pop = $("fileListShowPopup");
  if (pop && pop.style.display === "block") positionFileListShowPopup();
  if (typeof applyToolbarBounds === "function") applyToolbarBounds();
});
$("relayoutDirection") && ($("relayoutDirection").onchange = (e) => {
  state.relayoutDirection = (e.target.value === "horizontal") ? "horizontal" : "vertical";
});
$("relayoutCapacity") && ($("relayoutCapacity").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  state.relayoutCapacity = (Number.isFinite(v) && v >= 10) ? v : 100;
  e.target.value = state.relayoutCapacity;
});
// 桿件編號 cap(全局):每軸方向 / 斜桿
function _bindMemberCap(id, key) {
  const el = $(id);
  if (!el) return;
  el.value = String(state[key] || 99);
  el.onchange = (e) => {
    const v = parseInt(e.target.value, 10);
    state[key] = ([9, 99, 999, 9999].includes(v)) ? v : 99;
    e.target.value = String(state[key]);
  };
}
_bindMemberCap("memberCapY", "memberCapY");
_bindMemberCap("memberCapX", "memberCapX");
_bindMemberCap("memberCapZ", "memberCapZ");
_bindMemberCap("memberCapDiag", "memberCapDiag");
// 切面樣式:標籤字體 + 線條粗度,改完即重畫
function _ensureSectionLinkStyle() {
  if (!state.sectionLinkStyle) state.sectionLinkStyle = { fontPt: 15, strokeWidth: 30 };
}
$("slFontPt") && ($("slFontPt").onchange = (e) => {
  _ensureSectionLinkStyle();
  const v = parseInt(e.target.value, 10);
  state.sectionLinkStyle.fontPt = (Number.isFinite(v) && v >= 6 && v <= 200) ? v : 15;
  e.target.value = state.sectionLinkStyle.fontPt;
  render();
});
$("slStrokeWidth") && ($("slStrokeWidth").onchange = (e) => {
  _ensureSectionLinkStyle();
  const v = parseInt(e.target.value, 10);
  state.sectionLinkStyle.strokeWidth = (Number.isFinite(v) && v >= 1 && v <= 50) ? v : 30;
  e.target.value = state.sectionLinkStyle.strokeWidth;
  render();
});
export function updateSnapGridBtn() {
  const m = state.snapGrid.mode;
  const btn = $("snapGridBtn");
  if (!btn) return;
  btn.classList.toggle("active", m > 0);
  const u = state.unitName, st = state.snapGrid.step;
  // 用 _setBtnLabel 保留 .btn-icon — 直接 textContent= 會把磁鐵 svg 洗掉
  if (m === 0)      _setBtnLabel(btn, "tb.snapOff",   "鎖點 關閉");
  else if (m === 1) _setBtnLabel(btn, "tb.snapPoint", `鎖點 點 · ${st}${u}`);
  else              _setBtnLabel(btn, "tb.snapGrid",  `鎖點 網格 · ${st}${u}`);
}
export function cycleSnapGrid() {
  // 順序:網格 → 點 → 關閉 → 網格
  state.snapGrid.mode = (state.snapGrid.mode + 2) % 3;
  updateSnapGridBtn();
  render();
}

// 選取模式輪播:全部 → 只選點 → 只選線 → 全部
export function cycleSelectFilter() {
  const order = ["all", "joints", "members"];
  const i = order.indexOf(state.selectFilter);
  state.selectFilter = order[(i + 1) % 3];
  updateSelectToolLabel();
  applyTransform();
}
export function selectFilterLabel(f) {
  const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
  return f === "joints" ? T("hud.selectJoints","選取點")
       : f === "members" ? T("hud.selectMembers","選取線")
       : T("hud.selectAll","選取");
}
export function updateSelectToolLabel() {
  const btn = $("tool-select");
  if (!btn) return;
  const key = state.multiSelectSticky ? "tb.toolMulti" : "tb.toolSelect";
  const fb  = state.multiSelectSticky ? "多選"          : "選取";
  _setBtnLabel(btn, key, fb);
  btn.classList.toggle("multi", !!state.multiSelectSticky);
}

// Shift+S 連按浮動選單(放開 Shift 確認)
let pendingFilter = null;
function showSelectModePopup() {
  const btn = $("tool-select");
  const r = btn.getBoundingClientRect();
  const pop = $("selectModePopup");
  pop.style.left = r.left + "px";
  pop.style.top = (r.bottom + 4) + "px";
  pop.style.display = "block";
  if (pendingFilter === null) pendingFilter = state.selectFilter;
  updateSelectModePopup();
}
function hideSelectModePopup() {
  $("selectModePopup").style.display = "none";
}
function cyclePendingFilter() {
  const order = ["all", "joints", "members"];
  const cur = pendingFilter !== null ? pendingFilter : state.selectFilter;
  const i = order.indexOf(cur);
  pendingFilter = order[(i + 1) % 3];
  updateSelectModePopup();
}
function updateSelectModePopup() {
  const f = pendingFilter !== null ? pendingFilter : state.selectFilter;
  document.querySelectorAll("#selectModePopup .smp-item").forEach(el => {
    el.classList.toggle("active", el.dataset.filter === f);
  });
}
export function commitPendingFilter() {
  if (pendingFilter !== null) {
    state.selectFilter = pendingFilter;
    pendingFilter = null;
    hideSelectModePopup();
    updateCtxFilterRadios && updateCtxFilterRadios();
    updateSelectToolLabel();
    applyTransform();
  }
}
// 點選 popup 項目也可直接設定
document.querySelectorAll("#selectModePopup .smp-item").forEach(el => {
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    pendingFilter = el.dataset.filter;
    commitPendingFilter();
  });
});
$("snapGridLineChk")  && ($("snapGridLineChk").onchange  = (e) => { state.snapToGridLines  = e.target.checked; });
$("snapGridPointChk") && ($("snapGridPointChk").onchange = (e) => { state.snapToGridPoints = e.target.checked; });
$("snapGridBtn").onclick = cycleSnapGrid;
$("snapLinesPriority").onchange = (e) => {
  state.snapLinesPriority = e.target.checked;
  render();
};
$("pageZ").onchange = (e) => { pushUndo(); getPage().z = parseFloat(e.target.value) || 0; _afterCalibrationChanged(); };

// ---------- export ----------
// buildModel + showBuildModelCollisionsIfAny 移到 src/core/buildModel.ts(Phase 3e)

// staadUnitKeyword / unitToMeter / meterToTarget 移到 src/utils/units.ts(Phase 2)

// Phase 8g:exportStaad button handler 抽成 named function 進 src/export/std.ts
import { exportStdFile } from "../export/std";
$("exportStaad") && ($("exportStaad").onclick = exportStdFile);

// Phase 8f:exportXlsxFile + CRC32/ZIP/OOXML 組裝 helpers 搬到 src/export/xlsx.ts
import { exportXlsxFile } from "../export/xlsx";
export { exportXlsxFile } from "../export/xlsx";

$("exportJson").onclick = () => {
  const data = {
    schema: "staad-tracer/2",
    scale: state.scale, unitName: state.unitName,
    files: state.files.map(f => ({
      id: f.id, name: f.name, type: f.type,
      pageCount: f.pageCount,
      pages: f.pages || {},
    })),
    activeFileId: state.activeFileId,
    pageIdx: state.pageIdx,
  };
  const _jobName = (($("jobName") as HTMLInputElement)?.value || "model")
    .replace(/[\\\/:*?"<>|]/g, "_").trim() || "model";
  saveFileWithPicker({
    suggestedName: `${_jobName}.json`,
    types: [{ description: "STAAD Tracer JSON", accept: { "application/json": [".json"] } }],
    data: JSON.stringify(data, null, 2),
    mime: "application/json",
  }).then(r => {
    if (r.ok && $("hud")) $("hud").textContent = "已儲存標線 JSON";
    else if (r.cancelled && $("hud")) $("hud").textContent = "已取消儲存標線";
  });
};

$("importJson").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const txt = await f.text();
  const data = JSON.parse(txt);
  pushUndo();
  state.scale = data.scale || null;
  state.unitName = data.unitName || "mm";
  if (data.files) {
    state.files = data.files.map(fs => ({
      id: fs.id, name: fs.name, type: fs.type,
      pageCount: fs.pageCount || Object.keys(fs.pages || {}).length || 1,
      pages: fs.pages || {},
    }));
    if (state.files.length) setNextFileId(Math.max(nextFileId, ...state.files.map(f => f.id + 1)));
    state.activeFileId = data.activeFileId ?? (state.files[0] && state.files[0].id) ?? null;
    state.pageIdx = data.pageIdx || 0;
  } else if (data.pages) {
    // 舊格式 v1:轉成單一檔案
    const pageCount = Math.max(1, ...Object.keys(data.pages).map(k => +k + 1));
    const file = {
      id: allocFileId(),
      name: "已匯入專案", type: "legacy",
      pageCount, pages: data.pages,
    };
    state.files = [file];
    state.activeFileId = file.id;
    state.pageIdx = data.pageIdx || 0;
  }
  for (const file of state.files) {
    for (const pg of Object.values(file.pages || {})) {
      for (const j of pg.joints) setNextJointId(Math.max(nextJointId, j.id + 1));
      for (const m of pg.members) setNextMemberId(Math.max(nextMemberId, m.id + 1));
    }
  }
  alert("已讀入「標線」資料(輕量格式,不含底圖)。\n\n要連同底圖一起儲存/讀回,請改用下方「完整專案(含底圖)」的儲存/讀入按鈕。");
  refreshFileList(); refreshPageSelector();
  render(); refreshLists();
  e.target.value = "";
};

$("saveProject") && ($("saveProject").onclick = () => _startSaveWithHook(false));
$("loadProject") && ($("loadProject").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await withBusy("讀入專案中…", () => loadProjectFull(f));
  e.target.value = "";
});

// Phase 8d:parseDxf / dxfBbox / dxfToSvg 搬到 src/utils/dxf.ts(純函式,無 DOM / state 依賴)
import { parseDxf, dxfBbox, dxfToSvg } from "../utils/dxf";
import { saveFileWithPicker } from "../utils/saveFile";
export { parseDxf, dxfBbox, dxfToSvg } from "../utils/dxf";
function download(name, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ---------- 專案儲存 / 讀取(含 PDF / 圖片底圖)----------
// Phase 8c:setBusyMessage / busyTick / showBusy / showBusyWithCancel / hideBusy 搬到 src/ui/busy.ts
import { setBusyMessage, busyTick, showBusy, showBusyWithCancel, hideBusy } from "../ui/busy";
export { setBusyMessage, busyTick, showBusy, showBusyWithCancel, hideBusy } from "../ui/busy";

// Phase 8i:專案儲存 / 讀取(blobToBase64 / base64ToArrayBuffer / fmtMB / startSave / saveProjectFull/As / buildProjectBlob / ensureRwPermission / writeProjectWithHandle)搬到 src/state/projectFile.ts
import { base64ToArrayBuffer, fmtMB, startSave, saveProjectFull, saveProjectAs, ensureRwPermission } from "../persistence/projectFile";
export { base64ToArrayBuffer, fmtMB, startSave, saveProjectFull, saveProjectAs, ensureRwPermission } from "../persistence/projectFile";

// Phase 8h:recent projects IDB(_openRecentDB / _saveRecentProject / _getRecentProjects / _removeRecentProject / _openRecentProject)搬到 src/state/recentProjects.ts
import { _saveRecentProject, _getRecentProjects, _removeRecentProject, _openRecentProject } from "../persistence/recentProjects";
export { _saveRecentProject, _getRecentProjects, _removeRecentProject, _openRecentProject } from "../persistence/recentProjects";

// Phase 8j:loadProjectFull(完整專案讀取)搬到 src/state/projectLoad.ts
import { loadProjectFull } from "../persistence/projectLoad";
export { loadProjectFull } from "../persistence/projectLoad";

$("clearAll").onclick = () => {
  // 只清節點 + 桿件,保留所有檔案與底圖、平面、原點、比例尺、切面線、標示等
  if (!confirm("確定要清除所有節點與桿件嗎?\n(圖檔 / 底圖 / 平面 / 原點 / 比例尺 / 切面線 / 標線等都不會被刪除)")) return;
  pushUndo();
  let totalJ = 0, totalM = 0, totalGJ = 0;
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg) continue;
      if (Array.isArray(pg.joints))  { totalJ += pg.joints.length;  pg.joints  = []; }
      if (Array.isArray(pg.members)) { totalM += pg.members.length; pg.members = []; }
    }
  }
  // 全局節點(綁定的 metadata)也一併清掉,因為沒了 joints 也綁不到誰
  if (Array.isArray(state.globalJoints)) { totalGJ = state.globalJoints.length; state.globalJoints = []; }
  state.globalMembers = [];
  state.globalOriginId = null;
  state.globalOriginFileId = null;
  setNextJointId(1); setNextMemberId(1); setNextGlobalJointId(1); setNextGlobalMemberId(1);
  clearSelection();
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render && render();
  refreshLists && refreshLists();
  console.log(`[清除] 刪 ${totalJ} 個節點、${totalM} 條桿件、${totalGJ} 個全局節點;保留所有檔案與底圖`);
  $("hud").textContent = `已清除 ${totalJ} 個節點、${totalM} 條桿件、${totalGJ} 個全局節點`;
};

// ---------- sidebar 寬度與收合 ----------
const sidebarWidth = { left: 220, right: 220 };
function applySidebarWidth() {
  $("sbLeft").style.width = sidebarWidth.left + "px";
  $("sbRight").style.width = sidebarWidth.right + "px";
  $("leftResizer").style.left = (12 + sidebarWidth.left - 3) + "px";
  $("rightResizer").style.right = (12 + sidebarWidth.right - 3) + "px";
  // 收合按鈕位置:展開時貼著側欄外緣 4px;收合時固定在最邊
  if (!$("sbLeft").classList.contains("collapsed"))
    $("leftToggle").style.left = (12 + sidebarWidth.left + 4) + "px";
  if (!$("sbRight").classList.contains("collapsed"))
    $("rightToggle").style.right = (12 + sidebarWidth.right + 4) + "px";
  // HUD 由 CSS 固定在「中間下方偏右」(bottom 18px, left 75%, translateX -50%)
  // zoomTools:右側欄外緣 / 收合時靠視窗右邊
  const rightCollapsed = $("sbRight").classList.contains("collapsed");
  $("zoomTools").style.right = (rightCollapsed ? 12 : (12 + sidebarWidth.right + 28)) + "px";
  // bgEditTools / selectTools:左側欄外緣 / 收合時靠視窗左邊
  const leftCollapsed = $("sbLeft").classList.contains("collapsed");
  const leftPx = (leftCollapsed ? 12 : (12 + sidebarWidth.left + 28)) + "px";
  $("bgEditTools").style.left = leftPx;
  if ($("selectTools")) $("selectTools").style.left = leftPx;
  applyToolbarBounds();
}
function applyToolbarBounds() {
  const tb = $("toolbar");
  if (!tb) return;
  const sel = $("selectTools"), bgE = $("bgEditTools"), zoom = $("zoomTools");
  const visW = (el) => (el && el.offsetParent !== null) ? el.offsetWidth : 0;
  const leftToolW = Math.max(visW(sel), visW(bgE));
  const leftCollapsed = $("sbLeft").classList.contains("collapsed");
  const rightCollapsed = $("sbRight").classList.contains("collapsed");
  const leftBase = leftCollapsed ? 12 : (12 + sidebarWidth.left + 28);
  const rightBase = rightCollapsed ? 12 : (12 + sidebarWidth.right + 28);
  tb.style.left = (leftBase + leftToolW + 8) + "px";
  tb.style.right = (rightBase + visW(zoom) + 8) + "px";
  // 把左右 tool 區的 top 設在 toolbar 下方,避免遮住上方控制區
  const tbRect = tb.getBoundingClientRect();
  const topY = Math.max(100, Math.round(tbRect.bottom) + 8);
  const topPx = topY + "px";
  // 限制 tool 區最大高度為視窗高度 - top - 底部留白,讓內容超出時能 flex-wrap 換到下一欄
  const maxH = Math.max(120, window.innerHeight - topY - 16);
  const maxHPx = maxH + "px";
  if (sel)  { sel.style.top = topPx;  sel.style.maxHeight = maxHPx; }
  if (bgE)  { bgE.style.top = topPx;  bgE.style.maxHeight = maxHPx; }
  if (zoom) { zoom.style.top = topPx; }
}

// ---------- 檔案頁面分頁列 ----------
function addTab(fileId, pageIdx) {
  pageIdx = pageIdx || 0;
  if (!state.openTabs) state.openTabs = [];
  const exists = state.openTabs.some(t => t.fileId === fileId && (t.pageIdx || 0) === pageIdx);
  if (!exists) state.openTabs.push({ fileId, pageIdx });
  refreshTabBar();
}
function removeTab(fileId, pageIdx) {
  if (!state.openTabs) return;
  pageIdx = pageIdx || 0;
  const i = state.openTabs.findIndex(t => t.fileId === fileId && (t.pageIdx || 0) === pageIdx);
  if (i < 0) return;
  state.openTabs.splice(i, 1);
  refreshTabBar();
}
function refreshTabBar() {
  const el = $("tabBar");
  if (!el) return;
  if (!state.openTabs) state.openTabs = [];
  // 清掉指向已不存在檔案 / 越界頁的 tab
  state.openTabs = state.openTabs.filter(t => {
    const f = state.files.find(ff => ff.id === t.fileId);
    return f && (t.pageIdx || 0) < (f.pageCount || 1);
  });
  el.innerHTML = "";
  for (const t of state.openTabs) {
    const f = state.files.find(ff => ff.id === t.fileId);
    if (!f) continue;
    const pIdx = t.pageIdx || 0;
    const isActive = (state.activeFileId === t.fileId && state.pageIdx === pIdx);
    const tab = document.createElement("div");
    tab.className = "tab" + (isActive ? " active" : "");
    const multi = (f.pageCount || 1) > 1;
    tab.title = f.name + (multi ? ` · 第${pIdx + 1}頁` : "");
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = f.name + (multi ? ` ·${pIdx + 1}` : "");
    tab.appendChild(name);
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "關閉分頁";
    close.onclick = (e) => { e.stopPropagation(); removeTab(t.fileId, pIdx); };
    tab.appendChild(close);
    tab.onclick = () => activatePageWithBusy(t.fileId, pIdx);
    tab.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); removeTab(t.fileId, pIdx); } };
    el.appendChild(tab);
  }
  el.style.display = state.openTabs.length ? "flex" : "none";
}
function bindResizer(handleId, side) {
  const handle = $(handleId);
  let startX, startW;
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = sidebarWidth[side];
    handle.classList.add("dragging");
    document.body.style.cursor = "ew-resize";
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const w = side === "left" ? startW + dx : startW - dx;
      sidebarWidth[side] = Math.max(220, Math.min(560, w));
      applySidebarWidth();
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}
bindResizer("leftResizer", "left");
bindResizer("rightResizer", "right");

function bindCollapser(toggleId, sidebarId, expanded, collapsed) {
  const t = $(toggleId), s = $(sidebarId);
  t.onclick = () => {
    const isCollapsed = s.classList.toggle("collapsed");
    t.classList.toggle("collapsed", isCollapsed);
    t.textContent = isCollapsed ? expanded : collapsed;
    t.title = isCollapsed ? "展開側欄" : "收合側欄";
    applySidebarWidth();
  };
}
bindCollapser("leftToggle", "sbLeft", "›", "‹");
bindCollapser("rightToggle", "sbRight", "‹", "›");
applySidebarWidth();

// ---------- page selector ----------
$("pageSelector").addEventListener("change", (e) => {
  const v = e.target.value;
  if (!v) return;
  const [fid, pidx] = v.split("/").map(Number);
  activatePageWithBusy(fid, pidx);
});

// ---------- hover 資訊 tooltip ---------- (實作搬到 src/ui/hoverTip.ts;這邊只做 re-export)
export { showHoverTip, moveHoverTip, hideHoverTip, fmtJointInfo, fmtMemberInfo } from "../ui/hoverTip";
// 釘住的節點資訊視窗 — 實作搬到 src/dialogs/jointInfoPopup.ts
export { showJointInfoPopup, hideJointInfoPopup } from "../dialogs/jointInfoPopup";
// 設為錨點 → 跳支座類型選擇 modal(FIXED / PINNED / 取消)
//   實作已搬到 src/tools/anchor.ts,re-export 維持外部 importer 不用動
export { pickSupportTypeModal } from "../tools/anchor";
// positionHoverTip / escHtml / tipRow / fmtJointInfo / fmtMemberInfo 全搬到 src/ui/hoverTip.ts;
//   本檔不再保留實作。需要的話走檔頂的 re-export 拿。

// ---------- 節點 ID 編碼:XXYYZZ(N=各軸最大位數)----------
// 7 個 connectivity helper + displayJointId / displayMemberId 整合到 src/core/displayId.ts
// (跟 _displayIdForJointWith 同檔)
import {
  _isJointOrtho,
  _jointHasAnyDiagonal,
  _getJointMemberDirs,
  _hasAnyPerpPair,
  _allDirsCollinear,
  _jointHasPerpendicularPair,
  _jointConnectivityKind,
  displayJointId,
  displayMemberId,
} from "../core/displayId";
export {
  _isJointOrtho,
  _jointHasAnyDiagonal,
  _getJointMemberDirs,
  _hasAnyPerpPair,
  _allDirsCollinear,
  _jointHasPerpendicularPair,
  _jointConnectivityKind,
  displayJointId,
  displayMemberId,
};
export function pageHasGroupNum(num, exclude) {
  for (const file of state.files) {
    for (const [k, pg] of Object.entries(file.pages || {})) {
      if (exclude && pg === exclude) continue;
      if (pg.groupNum === num) return true;
    }
  }
  return false;
}
export function refreshPageCoordSection() {
  const p = getPage();
  $("planeSelect").value = (p && p.plane) || "";
  $("numberTolerance") && ($("numberTolerance").value = state.numberTolerance != null ? state.numberTolerance : 2);
  $("numberCapacityX") && ($("numberCapacityX").value = String(state.numberCapacityX || 99));
  $("numberCapacityY") && ($("numberCapacityY").value = String(state.numberCapacityY || 99));
  $("numberCapacityZ") && ($("numberCapacityZ").value = String(state.numberCapacityZ || 99));
  $("numberPriority") && ($("numberPriority").value = state.numberPriority || "h");
  // 第三軸:依本頁 plane 動態切換 label / tooltip
  //   XY → Z(深度,例如各立面對應不同 Z 切面)
  //   XZ → Y(標高,樓層平面圖)
  //   YZ → X(側視位置,各側視對應不同 X 切面)
  //   未設定 → 隱藏
  const plane = p && p.plane;
  const wrap = $("pageYWrap");
  const showY = !!plane;
  if (wrap) wrap.style.display = showY ? "block" : "none";
  // 左右 / 上下翻轉 checkbox + 套用按鈕:plane 設定後才顯示;同步當前狀態
  const flipWrapX = $("pageFlipXWrap");
  if (flipWrapX) flipWrapX.style.display = showY ? "flex" : "none";
  if ($("pageFlipX")) $("pageFlipX").checked = !!(p && p.flipX);
  const flipWrapY = $("pageFlipYWrap");
  if (flipWrapY) flipWrapY.style.display = showY ? "flex" : "none";
  if ($("pageFlipY")) $("pageFlipY").checked = !!(p && p.flipY);
  const syncWrap = $("pageFlipSyncWrap");
  if (syncWrap) syncWrap.style.display = showY ? "flex" : "none";
  const applyBtn = $("btnApplyFlipToSamePlane");
  if (applyBtn) applyBtn.style.display = showY ? "block" : "none";
  // 樓層類型下拉:只在 XZ 平面 page 顯示;選項即時從 state.floorTypes(filter kind=floor)重建
  const floorWrap = $("pageFloorTypeWrap");
  if (floorWrap) floorWrap.style.display = (plane === "XZ") ? "block" : "none";
  if (plane === "XZ") {
    const sel = $("pageFloorType");
    if (sel) {
      sel.innerHTML = "";
      const all = Array.isArray(state.floorTypes) && state.floorTypes.length
        ? state.floorTypes : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
      const types = all.filter(t => (t.kind || "floor") === "floor");
      const list = types.length ? types : [{ key: "default", label: "預設", yyStart: 1 }];
      for (const t of list) {
        const opt = document.createElement("option");
        opt.value = t.key;
        opt.textContent = `${t.label || t.key} (起始 ${t.yyStart || 1})`;
        sel.appendChild(opt);
      }
      const cur = (p && p.floorType) || "default";
      sel.value = list.some(t => t.key === cur) ? cur : list[0].key;
    }
  }
  // 斜撐起始下拉:只在 YZ / XY 平面 page 顯示;選項即時從 state.floorTypes(filter kind=brace)重建
  //   斜撐型可能完全沒設,清單會空 — 此時下拉只顯示「default」做 fallback。
  const braceWrap = $("pageBraceTypeWrap");
  const isBracePlane = (plane === "YZ" || plane === "XY");
  if (braceWrap) braceWrap.style.display = isBracePlane ? "block" : "none";
  if (isBracePlane) {
    const sel = $("pageBraceType");
    if (sel) {
      sel.innerHTML = "";
      const all = Array.isArray(state.floorTypes) ? state.floorTypes : [];
      const types = all.filter(t => (t.kind || "floor") === "brace");
      // 永遠提供 default 選項在最前(代表「不指派 brace 型」,joint 走原 demote-only 邏輯)
      const list = [{ key: "default", label: "default(不指派)", yyStart: null }].concat(types);
      for (const t of list) {
        const opt = document.createElement("option");
        opt.value = t.key;
        opt.textContent = (t.yyStart != null)
          ? `${t.label || t.key} (起始 ${t.yyStart})`
          : (t.label || t.key);
        sel.appendChild(opt);
      }
      const cur = (p && p.braceType) || "default";
      sel.value = list.some(t => t.key === cur) ? cur : "default";
    }
  }
  if (showY) {
    const labelEl = $("pageZLabel");
    const inputEl = $("pageZ");
    let labelTxt, labelTip, inputTip;
    if (plane === "XZ") {
      labelTxt = "Y 軸標高";
      labelTip = "STAAD 以 Y 軸為鉛直方向(標高)。XZ 為水平剖面,本頁的 Y 值 = 該層標高";
      inputTip = "本頁對應的 Y 軸標高(mm),例如 3 樓樓板高度 4500";
    } else if (plane === "XY") {
      labelTxt = "Z 深度";
      labelTip = "XY 為立面正視。Z 為前後深度;多張 XY 立面對應不同 Z 切面(例如前/後排柱)";
      inputTip = "本頁對應的 Z 深度位置(mm),例如前排立面 0、後排立面 6000";
    } else if (plane === "YZ") {
      labelTxt = "X 軸位置";
      labelTip = "YZ 為立面側視。X 為左右位置;多張 YZ 側視對應不同 X 切面";
      inputTip = "本頁對應的 X 位置(mm),例如左側面 0、右側面 12000";
    } else {
      labelTxt = "第三軸位置";
      labelTip = "本頁對應的第三軸位置";
      inputTip = "本頁對應的第三軸位置(mm)";
    }
    if (labelEl) { labelEl.textContent = labelTxt; labelEl.title = labelTip; }
    if (inputEl) inputEl.title = inputTip;
    $("pageZ").value = (p && p.z != null) ? p.z : 0;
  }
  if (p && p.groupNum) {
    const base = p.groupNum * state.globalCapacity;
    $("idPreview").textContent = `編號預覽:J/M ${base + 1}~${base + state.globalCapacity}`;
  } else {
    $("idPreview").textContent = "編號預覽:未設定共有數字";
  }
  refreshAxisIndicator();
}
// 平面座標指示器:依當前頁面 plane 更新右上角的軸名 + 顏色
//   XY:右 X(紅) / 上 Y(綠) — 預設
//   XZ:右 X(紅) / 上 Z(藍) — 平面俯視
//   YZ:右 Z(藍) / 上 Y(綠) — 立面側視
//   未設定:同 XY,標籤帶 "(?)" 表示未指派
export function refreshAxisIndicator() {
  const p = getPage();
  const plane = (p && p.plane) || "";
  const flipX = !!(p && p.flipX);
  const flipY = !!(p && p.flipY);
  const xLbl = $("axisXLabel"), yLbl = $("axisYLabel");
  const xLine = $("axisXLine"), yLine = $("axisYLine");
  const origin = $("axisOrigin");
  if (!xLbl || !yLbl) return;
  const COLORS = { X: "#ff5252", Y: "#4ade80", Z: "#3b82f6" };
  // 平面預設方向 — 水平軸往右;縱軸 XZ 往「下」、XY/YZ 往「上」
  let horizAxis = "X", vertAxis = "Y", note = "", baseVertDown = false;
  if (plane === "XZ")      { horizAxis = "X"; vertAxis = "Z"; baseVertDown = true;  }
  else if (plane === "YZ") { horizAxis = "Z"; vertAxis = "Y"; baseVertDown = false; }
  else if (plane === "XY") { horizAxis = "X"; vertAxis = "Y"; baseVertDown = false; }
  else { note = "(?)"; }
  // flipY 把縱軸方向反轉(原本往上 → 往下;原本往下 → 往上)
  const vertDown = flipY ? !baseVertDown : baseVertDown;
  xLbl.textContent = horizAxis + note;
  yLbl.textContent = vertAxis + note;
  xLbl.setAttribute("fill", COLORS[horizAxis] || "#ccc");
  yLbl.setAttribute("fill", COLORS[vertAxis] || "#ccc");
  // 原點位置:flipX → 右側 (58);否則左側 (20)。oy 維持中段 44 — 縱軸往上 / 下從這延伸。
  const oy = 44;
  const ox = flipX ? 58 : 20;
  const xEnd = flipX ? 20 : 58;
  if (origin) { origin.setAttribute("cx", String(ox)); origin.setAttribute("cy", String(oy)); }
  if (xLine) {
    xLine.setAttribute("x1", String(ox)); xLine.setAttribute("y1", String(oy));
    xLine.setAttribute("x2", String(xEnd)); xLine.setAttribute("y2", String(oy));
    xLine.setAttribute("stroke", COLORS[horizAxis] || "#ccc");
    xLine.setAttribute("marker-end", `url(#arrAx${horizAxis})`);
  }
  xLbl.setAttribute("x", flipX ? "4" : "62");
  xLbl.setAttribute("y", String(oy + 4));
  // 縱軸 → 上 / 下(從同樣 ox 出發)
  if (yLine) {
    yLine.setAttribute("x1", String(ox)); yLine.setAttribute("y1", String(oy));
    yLine.setAttribute("x2", String(ox)); yLine.setAttribute("y2", vertDown ? "74" : "14");
    yLine.setAttribute("stroke", COLORS[vertAxis] || "#ccc");
    yLine.setAttribute("marker-end", `url(#arrAx${vertAxis})`);
  }
  yLbl.setAttribute("x", String(ox - 6));
  yLbl.setAttribute("y", vertDown ? "86" : "10");
}
$("planeSelect").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  p.plane = e.target.value || null;
  _afterCalibrationChanged();
};
// 校準變動後的共同收尾:rank 失效 + globalJoint 重 infer + UI 重整 + 重畫。
// 適用於所有「會改變 2D ↔ 3D 對應」的操作 — planeOrigin / scaleRuler / page.plane /
//   page.flipX/Y / page.z / 旋轉 90°。每個 mutation 點呼叫一次,確保下游
//   (顯示 ID、globalJoint world、xlsx 匯出、3D 預覽)即時對齊新基準。
// 注意:_resyncSectionLinksForFile 是 file-specific,呼叫者自己決定要不要先跑;
//   本 helper 結尾會 refreshSectionLinkList 把已更新的切面 cutValue 反映到 UI。
export function _afterCalibrationChanged() {
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  try { refreshLists(); } catch (_) {}
  try { render(); } catch (_) {}
}
// 翻轉變更後的共同收尾:active file 切面 resync(file-specific)→ 跑共同 calibration 收尾
function _afterFlipChanged(label) {
  const af = getActiveFile();
  if (af) {
    const r = (typeof _resyncSectionLinksForFile === "function")
      ? _resyncSectionLinksForFile(af) : { slUpdated: 0, tgtZUpdated: 0 };
    if (r.slUpdated) {
      console.log(`[${label}] ${af.name}・切面 cutValue 重算 ${r.slUpdated} 條;目標 page.z 同步 ${r.tgtZUpdated} 個`);
    }
  }
  _afterCalibrationChanged();
}
// 把本頁 flipX/flipY 設定推到所有同平面的其他頁面;回傳被改動的頁面數
function _propagateFlipToSamePlane(p) {
  if (!p || !p.plane) return 0;
  const fX = !!p.flipX, fY = !!p.flipY;
  let count = 0;
  const filesTouched = new Set();
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan || pg === p || pg.plane !== p.plane) continue;
      if (!!pg.flipX === fX && !!pg.flipY === fY) continue;
      pg.flipX = fX; pg.flipY = fY;
      count++;
      filesTouched.add(f);
    }
  }
  // 各被改動檔案重算切面 cutValue
  if (count && typeof _resyncSectionLinksForFile === "function") {
    for (const f of filesTouched) {
      try { _resyncSectionLinksForFile(f); } catch (_) {}
    }
  }
  return count;
}
// localStorage 持久化「同步到全部同平面」的勾選狀態(預設 ON)
try {
  const v = localStorage.getItem("flipSyncSamePlane");
  const el = $("pageFlipSync");
  if (el) el.checked = (v == null) ? true : (v !== "0");
} catch (_) {}
$("pageFlipSync") && ($("pageFlipSync").onchange = (e) => {
  try { localStorage.setItem("flipSyncSamePlane", e.target.checked ? "1" : "0"); } catch (_) {}
});
$("pageFloorType") && ($("pageFloorType").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan || p.plane !== "XZ") return;
  pushUndo();
  p.floorType = String(e.target.value || "default");
  // Y 軸 rank 連動 → 失效 rank cache、重建 globalJoints、重畫 + UI 同步
  invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  try { refreshLists(); } catch (_) {}
  render();
});
$("pageBraceType") && ($("pageBraceType").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan || (p.plane !== "YZ" && p.plane !== "XY")) return;
  pushUndo();
  p.braceType = String(e.target.value || "default");
  // Y 軸 rank 連動(brace bucket 重算)→ 失效 rank cache、重建 globalJoints、重畫 + UI 同步
  invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  try { refreshLists(); } catch (_) {}
  render();
});
$("btnOpenFloorTypeMgr") && ($("btnOpenFloorTypeMgr").onclick = () => {
  if (typeof openFloorTypesDialog === "function") openFloorTypesDialog();
});
// 左欄樓層類型清單(read-only 簡覽,管理走「管理…」按鈕)
function _refreshFloorTypeSidebar() {
  const list = $("floorTypeList");
  if (!list) return;
  const allTypes = Array.isArray(state.floorTypes) && state.floorTypes.length
    ? state.floorTypes : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
  // 統計:floor → XZ page 數;brace → YZ + XY page 數
  const floorCounts = new Map();
  const braceCounts = new Map();
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg) continue;
      if (pg.plane === "XZ") {
        const tk = pg.floorType || "default";
        floorCounts.set(tk, (floorCounts.get(tk) || 0) + 1);
      } else if (pg.plane === "YZ" || pg.plane === "XY") {
        const tk = pg.braceType || "default";
        braceCounts.set(tk, (braceCounts.get(tk) || 0) + 1);
      }
    }
  }
  list.innerHTML = "";
  const addHead = (txt) => {
    const h = document.createElement("div");
    h.style.cssText = "color:#9bb6e8;font-size:10px;font-weight:700;margin:4px 0 2px;letter-spacing:0.5px";
    h.textContent = txt;
    list.appendChild(h);
  };
  const addRow = (t, counts) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center;padding:2px 0";
    const lbl = document.createElement("span");
    lbl.style.cssText = "flex:1;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    lbl.textContent = `${t.label || t.key}`;
    const meta = document.createElement("span");
    meta.style.cssText = "color:#7b818a;font-size:10px;font-variant-numeric:tabular-nums";
    meta.textContent = `起始 ${t.yyStart || 1} ・ ${counts.get(t.key) || 0} 頁`;
    row.appendChild(lbl);
    row.appendChild(meta);
    list.appendChild(row);
  };
  const floorTypes = allTypes.filter(t => (t.kind || "floor") === "floor");
  const braceTypes = allTypes.filter(t => (t.kind || "floor") === "brace");
  addHead("樓層類型(XZ)");
  if (!floorTypes.length) {
    const e = document.createElement("div");
    e.style.cssText = "color:#666;font-size:10px;font-style:italic;padding:1px 0";
    e.textContent = "(無)";
    list.appendChild(e);
  } else {
    for (const t of floorTypes) addRow(t, floorCounts);
  }
  addHead("斜撐起始(YZ / XY)");
  if (!braceTypes.length) {
    const e = document.createElement("div");
    e.style.cssText = "color:#666;font-size:10px;font-style:italic;padding:1px 0";
    e.textContent = "(無)";
    list.appendChild(e);
  } else {
    for (const t of braceTypes) addRow(t, braceCounts);
  }
}
// 節點編號管理 dialog —— window-like 視窗 + tabs(樓層類型 / 斜撐起始)+ pending state
//   兩 tab 共用同一 yyStart 池(1/11/21.../91 不重複),但各自 type 清單、各自頁面集合:
//     樓層類型 tab → XZ 頁面,寫到 pg.floorType
//     斜撐起始 tab → YZ + XY 頁面,寫到 pg.braceType
//   類型 CRUD(yyStart 限 1/11/21.../91 共池不重複, key→displayName 自動同步)、
//   下方分割兩窗(左 page list、右大畫面預覽)、Shift / Cmd 多勾選、
//   上方顯示當前 tab 各型已勾頁數、套用 / 完成 / × 三種收尾按鈕
// openFloorTypesDialog 移到 src/dialogs/floorTypes.ts(Phase 5)
import { openFloorTypesDialog } from "../dialogs/floorTypes";

// ===== 全局節點管理 dialog =====
//   左半邊:所有 globalJoint 清單(可搜尋 / 篩選 / 排序)
//   右半邊:選中筆的詳細資料 — 改 label、看世界座標、列綁定可單獨解除、設原點、刪節點
//   底部:關閉鈕
// openGlobalJointMgrDialog + showGlobalJointJumpPopup + hideGlobalJointJumpPopup 移到 src/dialogs/globalJoints.ts(Phase 5)
import { openGlobalJointMgrDialog, showGlobalJointJumpPopup, hideGlobalJointJumpPopup } from "../dialogs/globalJoints";

$("pageFlipX") && ($("pageFlipX").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  p.flipX = !!e.target.checked;
  const syncEl = $("pageFlipSync");
  let n = 0;
  if (syncEl && syncEl.checked) n = _propagateFlipToSamePlane(p);
  _afterFlipChanged("左右翻轉");
  if (n) console.log(`[左右翻轉] 同步到 ${n} 個同 ${p.plane} 平面頁面`);
});
$("pageFlipY") && ($("pageFlipY").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  p.flipY = !!e.target.checked;
  const syncEl = $("pageFlipSync");
  let n = 0;
  if (syncEl && syncEl.checked) n = _propagateFlipToSamePlane(p);
  _afterFlipChanged("上下翻轉");
  if (n) console.log(`[上下翻轉] 同步到 ${n} 個同 ${p.plane} 平面頁面`);
});
$("btnApplyFlipToSamePlane") && ($("btnApplyFlipToSamePlane").onclick = () => {
  const p = getPage();
  if (!p || p._orphan) { alert("請先載入並選定本頁的世界平面"); return; }
  const plane = p.plane;
  if (!plane) { alert("此頁尚未設定『世界平面』,無法套用。"); return; }
  const fX = !!p.flipX, fY = !!p.flipY;
  // 找出所有同平面、且不是本頁的頁面
  const targets = [];
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      if (pg.plane !== plane) continue;
      if (pg === p) continue;
      // 已經跟本頁設定相同 → 不算需要動的
      if (!!pg.flipX === fX && !!pg.flipY === fY) continue;
      targets.push({ f, k, pg });
    }
  }
  if (!targets.length) { alert(`沒有需要更新的同平面頁面(${plane} 平面其他頁面的翻轉設定已經跟本頁一致)。`); return; }
  if (!confirm(
    `將「左右翻轉=${fX ? "開" : "關"}、上下翻轉=${fY ? "開" : "關"}」套用到 ${targets.length} 個同 ${plane} 平面頁面?\n` +
    `(各檔切面 cutValue 會跟著重算,可用 Ctrl+Z 還原)`
  )) return;
  pushUndo();
  const filesTouched = new Set();
  for (const { f, pg } of targets) {
    pg.flipX = fX;
    pg.flipY = fY;
    filesTouched.add(f);
  }
  // 為每個被改到的檔案重算切面 cutValue
  let slUpdated = 0, tgtZUpdated = 0;
  for (const f of filesTouched) {
    const r = (typeof _resyncSectionLinksForFile === "function")
      ? _resyncSectionLinksForFile(f) : { slUpdated: 0, tgtZUpdated: 0 };
    slUpdated += r.slUpdated; tgtZUpdated += r.tgtZUpdated;
  }
  invalidateRankCache();
  inferAllGlobalJoints();
  refreshPageCoordSection();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  refreshLists();
  render();
  if ($("hud")) {
    $("hud").textContent = `已套用翻轉(X=${fX ? "開" : "關"} / Y=${fY ? "開" : "關"})到 ${targets.length} 個 ${plane} 平面頁面` +
      (slUpdated ? `・切面 ${slUpdated} 條重算${tgtZUpdated ? `(目標 page.z ${tgtZUpdated})` : ""}` : "");
  }
  console.log(`[套用翻轉] plane=${plane} flipX=${fX} flipY=${fY} → ${targets.length} 頁`,
    targets.map(t => t.f.name));
});
$("numberTolerance") && ($("numberTolerance").onchange = (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v) || v <= 0) { alert("誤差範圍必須是大於 0 的數字"); refreshPageCoordSection(); return; }
  state.numberTolerance = v;
  invalidateRankCache();
  refreshPageCoordSection();
  render(); refreshLists();
});
const _onCapAxisChange = (axKey, stateKey) => (e) => {
  const v = parseInt(e.target.value, 10);
  if (v !== 9 && v !== 99 && v !== 999) { alert(`${axKey} 軸最大編號數必須是 9 / 99 / 999`); refreshPageCoordSection(); return; }
  state[stateKey] = v;
  invalidateRankCache();
  refreshPageCoordSection();
  render(); refreshLists();
};
$("numberCapacityX") && ($("numberCapacityX").onchange = _onCapAxisChange("X", "numberCapacityX"));
$("numberCapacityY") && ($("numberCapacityY").onchange = _onCapAxisChange("Y", "numberCapacityY"));
$("numberCapacityZ") && ($("numberCapacityZ").onchange = _onCapAxisChange("Z", "numberCapacityZ"));
// 編排優先 變更 → ID 排列順序變,refresh 即可(不需動 cache)
$("numberPriority") && ($("numberPriority").onchange = (e) => {
  state.numberPriority = (e.target.value === "v") ? "v" : "h";
  refreshPageCoordSection();
  render(); refreshLists();
});

// ---------- 平面選取盤(Shift+W) ----------
// openPlanePicker / closePlanePicker / planePickerSectorAt + window 事件 + planePickerBtn onclick
// 全部搬到 src/dialogs/planePicker.ts;wirePlanePicker 由本檔延後 call
import {
  openPlanePicker,
  closePlanePicker,
  planePickerSectorAt,
  wirePlanePicker,
} from "../dialogs/planePicker";
wirePlanePicker();
export {
  openPlanePicker,
  closePlanePicker,
  planePickerSectorAt,
};

// 空白底圖訊息:在尚未載入任何檔案時,在背景 canvas 上顯示「請從左側載入…」提示
//   抽成函式以便語言切換時重畫
export function paintEmptyCanvasMessage() {
  if (typeof bgctx === "undefined" || !bgctx) return;
  bgctx.fillStyle = "#fafafa"; bgctx.fillRect(0, 0, state.bgWidth, state.bgHeight);
  bgctx.fillStyle = "#888"; bgctx.font = "16px sans-serif";
  bgctx.textAlign = "center"; bgctx.textBaseline = "middle";
  bgctx.fillText((typeof _t === "function" && _t("canvas.empty")) || "請從左側載入 PDF 或圖片以開始描圖。", state.bgWidth / 2, state.bgHeight / 2);
  bgctx.textAlign = "start"; bgctx.textBaseline = "alphabetic";
}

// i18n re-exports — 下游(app/transform / app/toolbar / measure / etc.)從 "../legacy" 拉
export { _t, _tx, _addI18n, _applyI18n, _applyI18nOnDoc, _setBtnLabel, _setLanguage } from "../i18n";

// ---------- init / dirty flag / project tabs setup / toolbar mode / icon decorate / lang init ----------
// 全部搬到 src/app/init.ts(import 即執行 module-level IIFE 副作用,包括 dirty hook、
// initFirstProject、setupProjectTabsWheel、toolbar mode、icon decorate、lang init)。
// 注意:initBlank() 本身不能在 init.ts 模組頂 call,因為它會觸發 render → render/index.ts
// 的 let _renderRecoveryPending 可能還在 TDZ(模組評估順序問題)。改成在 integration.ts
// 模組最末段 call,確保所有 module 已 fully evaluated。
import { initBlank, _initFirstProject } from "./init";
import "./init";   // 觸發 init.ts module-level IIFE 副作用
export { initBlank, _applyToolbarMode, _startSaveWithHook } from "./init";
// 等所有 import 跑完後再 initBlank + _initFirstProject — 避免 TDZ
//   • render/index.ts 的 let _renderRecoveryPending
//   • persistence/projectTabs.ts 的 let nextProjId
queueMicrotask(() => {
  try { initBlank(); } catch (e) { console.error("[initBlank]", e); }
  try { _initFirstProject(); } catch (e) { console.error("[_initFirstProject]", e); }
  // 啟動完成後,在 idle 時檢查 IndexedDB 有沒有殘留的自動備份(代表上次沒乾淨儲存)
  //   等到 _initFirstProject 完成後再跑,確保 projects 陣列已就緒,使用者按「復原」時能 push 新分頁。
  setTimeout(() => {
    import("../persistence/autoBackup").then(m => m.checkRecoveryOnStartup()).catch(() => {});
  }, 1500);
});


// ---------- 多專案分頁 ----------
// projects / activeProjectId / projectDirty + makeEmptyProjectData / snapshotActiveProjectInto /
// loadProjectDataFromP / activateProject / refreshProjectTabs / refreshProjectMenu
// 全部搬到 src/state/projectTabs.ts;legacy.ts 內 reassign 改用 setActiveProjectId / setProjectDirty
import {
  projects, activeProjectId, projectDirty,
  setActiveProjectId, setProjectDirty,
  makeEmptyProjectData, snapshotActiveProjectInto, loadProjectDataFromP,
  activateProject, refreshProjectTabs, refreshProjectMenu,
} from "../persistence/projectTabs";
export {
  projects, activeProjectId, projectDirty,
  setActiveProjectId, setProjectDirty,
  makeEmptyProjectData, snapshotActiveProjectInto, loadProjectDataFromP,
  activateProject, refreshProjectTabs, refreshProjectMenu,
};

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&apos;"}[c]));
}

// ---------- 通用對話框 + 新增/關閉專案 ----------
// promptNumberWithSkip / promptName / confirm3 + newProjectPrompt / closeProjectById /
// closeCurrentProject 搬到 src/app/dialogs.ts
export * from "./dialogs";


// Phase 8m:頂部主選單列 + 最近開啟專案 子選單 搬到 src/ui/menubar.ts(~192 行)
import "../ui/menubar";

// ============================================================================
// Phase 1 — 把常用 global expose 給 window,維持 console debugging / 既有測試體驗
// 移到模組後,變數預設只在 module scope;Phase 9 cleanup 會移除這段。
// ============================================================================
(function _phase1ExposeGlobals() {
  const names = [
    "state", "$", "getPage", "getActiveFile",
    "render", "refreshLists", "fitToView",
    "invalidateRankCache", "inferAllGlobalJoints", "listGlobalBindings",
    "buildModel", "displayJointId", "displayMemberId",
    "openFloorTypesDialog", "openGlobalJointMgrDialog",
    "calibrateAllFilesToGlobalOrigin", "calibrateAllFilesToCustomOrigin",
    "_run3DOneClickPipeline", "_ensureRankCache",
    "showBuildModelCollisionsIfAny",
    "pushUndo", "clearSelection",
  ];
  for (const n of names) {
    try {
      const v = eval(n);
      if (typeof v !== "undefined") (window as any)[n] = v;
    } catch (_) {}
  }
  console.log("[phase 1] exposed " + names.length + " names to window for console debug");
})();
