// 標示距離(只讀,不寫,持續顯示直到 Esc 或重新測量)
//
//   ≥ 1 條 → 立即計算 + 進入沿線滑動,點擊確認 / Esc 取消
//   無選取 + bgEdit → 進入 pending 流程逐條點選
//   結果存在 file.measurements,跨頁不顯示 — 純視覺輔助
//
//   注意:bgEdit 子工具列的 onclick 綁定(bgEditMeasure / bgEditOriginDistH / V / Min /
//     bgEditMeasureDelLast / bgEditMeasureClearAll)仍留在 legacy.ts(透過 import 引用本檔函式),
//     避免 module init 時 circular import TDZ。
// @ts-nocheck

import {
  $, state, getActiveFile, getPage,
  pushUndo, render,
  jointById, setTool, screenToWorld,
  clearSelection, clearAllBgSelection,
  exitBgDrawLine, exitBgCopyLine, exitBgBisector, exitBgEqui,
  exitScaleRulerPending, exitOriginPending, exitRangeZoom, exitManualAlign,
  exitSplitMode, exitMoveMode,
  cancelScaleRulerDrag, _selectedBgLinesAsWorld, updateBgEditOpsVisibility,
} from "../legacy";

// ---------- 標示距離(只讀,不寫,持續顯示直到 Esc 或重新測量) ----------
export function exitMeasurePending() {
  if (!state.measurePending) return;
  state.measurePending = false;
}
// 用世界座標 + state.scale 把距離格式化成「<數字> <單位>」(小數位數由 state.measureDecimals 控制)
export function formatMeasureDistance(distWorld) {
  const dec = _measureDec();
  if (state.scale && state.scale > 0) {
    const mm = distWorld / state.scale;
    return { text: `${mm.toFixed(dec)} ${state.unitName || "mm"}`, mm };
  }
  return { text: `${distWorld.toFixed(dec)} px`, mm: null };
}
// 取得目前測量小數位數(0~6;預設 2)
export function _measureDec() {
  const v = state.measureDecimals;
  if (Number.isFinite(v) && v >= 0 && v <= 6) return Math.floor(v);
  return 2;
}
// 改完 state.measureDecimals 後,把所有檔案 + 編輯中的測量 label 重新生成
export function _refreshAllMeasurementLabels() {
  const dec = _measureDec();
  const u = state.unitName || "mm";
  for (const f of state.files) {
    if (!Array.isArray(f.measurements)) continue;
    const ratio = (f.scaleRuler && f.scaleRuler.ratio > 0) ? f.scaleRuler.ratio : null;
    for (const m of f.measurements) {
      if (ratio && Number.isFinite(m.distance)) {
        m.label = `${(m.distance * ratio).toFixed(dec)} ${u}`;
      }
    }
  }
  if (state.measure && Number.isFinite(state.measure.distance) && state.scale && state.scale > 0) {
    state.measure.label = `${(state.measure.distance / state.scale).toFixed(dec)} ${u}`;
  }
}
// 通用 measure compute:從一組 world line endpoints 算出 single / parallel measurement
//   1 條 → 單線長度
//   2+ 條 → 找第一對「平行且非共線」的線當參考(支援 N 選 2)
//   回傳 measure 物件(含 dx/dy 沿線方向供 slide 使用)或 null
export function computeMeasureFromLines(lines) {
  if (!lines || !lines.length) return null;
  if (lines.length === 1) {
    const L = lines[0];
    const d = Math.hypot(L.p2.x - L.p1.x, L.p2.y - L.p1.y);
    if (d < 1e-3) return null;
    const ux = (L.p2.x - L.p1.x) / d, uy = (L.p2.y - L.p1.y) / d;
    // 單線標示距離 slide 方向 = 垂直於線(法向);把 dx/dy 設成法向,
    //   使用者拖游標就能把整條標示距離線從 bg 線位置移開,避免兩線重疊看不見
    const nx = -uy, ny = ux;
    const f = formatMeasureDistance(d);
    return { kind: "single", p1: L.p1, p2: L.p2, distance: d, label: f.text, dx: nx, dy: ny };
  }
  // 2+ 條:找第一對平行且非共線的
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const L1 = lines[i], L2 = lines[j];
      const v1 = { x: L1.p2.x - L1.p1.x, y: L1.p2.y - L1.p1.y };
      const v2 = { x: L2.p2.x - L2.p1.x, y: L2.p2.y - L2.p1.y };
      const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
      if (len1 < 1e-6 || len2 < 1e-6) continue;
      const sinTheta = Math.abs((v1.x * v2.y - v1.y * v2.x) / (len1 * len2));
      if (sinTheta > 0.05) continue;       // 不平行
      const m1 = { x: (L1.p1.x + L1.p2.x) / 2, y: (L1.p1.y + L1.p2.y) / 2 };
      const t = ((m1.x - L2.p1.x) * v2.x + (m1.y - L2.p1.y) * v2.y) / (len2 * len2);
      const proj = { x: L2.p1.x + t * v2.x, y: L2.p1.y + t * v2.y };
      const d = Math.hypot(proj.x - m1.x, proj.y - m1.y);
      if (d < 1e-3) continue;              // 共線(零距)→ 找下一對
      const angDeg = Math.asin(Math.min(1, sinTheta)) * 180 / Math.PI;
      const f = formatMeasureDistance(d);
      let label = f.text;
      if (angDeg > 5) label += `(夾角 ${angDeg.toFixed(1)}°)`;
      const ux = v1.x / len1, uy = v1.y / len1;
      return { kind: "parallel", p1: m1, p2: proj, distance: d, label, dx: ux, dy: uy };
    }
  }
  return null;
}

// 從目前 active 模式的選取收集「世界座標下的線段端點陣列」
export function collectMeasureLinesFromCurrentSelection() {
  if (state.tool === "selectBg") {
    const file = getActiveFile();
    if (!file) return [];
    return _selectedBgLinesAsWorld(file);
  }
  // 選取模式:用選取的 members
  const p = getPage();
  if (!p) return [];
  const out = [];
  for (const id of (state.selection.members || [])) {
    const m = p.members.find(mm => mm.id === id);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) continue;
    out.push({ p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y } });
  }
  return out;
}

// 確保 file.measurements / _nextMeasureId 已初始化
export function _ensureFileMeasurements(file) {
  if (!file) return null;
  if (!Array.isArray(file.measurements)) file.measurements = [];
  if (!file._nextMeasureId) file._nextMeasureId = 1;
  return file.measurements;
}
// 把目前 state.measure(剛建/重編)固化進 file.measurements,清掉 state.measure
export function _persistCurrentMeasure() {
  if (!state.measure) return;
  const file = getActiveFile();
  if (!file) { state.measure = null; return; }
  const list = _ensureFileMeasurements(file);
  const m = state.measure;
  const id = m.id || (file._nextMeasureId++);
  list.push({
    id,
    kind: m.kind,
    p1: { x: m.p1.x, y: m.p1.y },
    p2: { x: m.p2.x, y: m.p2.y },
    distance: m.distance,
    label: m.label,
    dx: m.dx, dy: m.dy,
  });
  state.measure = null;
}
// 啟動標示距離:依當前選取算出 measurement,進入「slide 沿線移動」模式直到使用者點擊確認
export function startMeasureFromCurrentSelection() {
  const lines = collectMeasureLinesFromCurrentSelection();
  if (!lines.length) {
    // 沒選 → 進 pending(僅在 bgEdit 模式有意義)
    if (state.tool === "selectBg") startMeasurePending();
    else alert("請先選取 1 條桿件(單線長度)或 2+ 條桿件(平行線距離)");
    return;
  }
  const m = computeMeasureFromLines(lines);
  if (!m) {
    if (lines.length === 1) alert("線段長度為 0");
    else alert(`找不到平行的兩條線(已嘗試 ${lines.length} 條),標示距離無法成立`);
    return;
  }
  pushUndo();
  // 若有正在編輯的 → 先固化(避免遺失)
  if (state.measure) _persistCurrentMeasure();
  state.measure = { ...m, _backup: { p1: { ...m.p1 }, p2: { ...m.p2 } }, sliding: true, _fromList: false };
  $("hud").textContent = `標示距離:${m.label} — 滑鼠沿線移動可滑動位置,點擊確認 / Esc 取消`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}

// 沿線移動:把 p1/p2 從 backup 加上 (dx,dy) * t 偏移
export function updateMeasureSlide(clientX, clientY) {
  const m = state.measure;
  if (!m || !m.sliding || !m._backup) return;
  const w = screenToWorld(clientX, clientY);
  const cx = (m._backup.p1.x + m._backup.p2.x) / 2;
  const cy = (m._backup.p1.y + m._backup.p2.y) / 2;
  const t = (w.x - cx) * m.dx + (w.y - cy) * m.dy;
  m.p1 = { x: m._backup.p1.x + m.dx * t, y: m._backup.p1.y + m.dy * t };
  m.p2 = { x: m._backup.p2.x + m.dx * t, y: m._backup.p2.y + m.dy * t };
  render();
}
// 點擊確認 → 把 state.measure 固化進 file.measurements
export function commitMeasureSlide() {
  if (!state.measure || !state.measure.sliding) return;
  const lbl = state.measure.label;
  _persistCurrentMeasure();
  $("hud").textContent = `標示距離已加入:${lbl}(永久保留;按右側欄清單刪除)`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}
// 重新進入標示距離 slide:從 file.measurements 取最後一條(或指定 id)出來重編,直到再次 commit
export function reenterMeasureSlide(measureId) {
  const file = getActiveFile();
  const list = file && Array.isArray(file.measurements) ? file.measurements : [];
  if (!list.length && !state.measure) {
    alert("尚無標示距離可移動。請先用「標示距離」量一條線或兩條平行線。");
    return;
  }
  // 進入 slide 前把其他 pending 模式關掉,避免衝突
  if (state.measurePending) state.measurePending = false;
  if (state.bgDrawLine && state.bgDrawLine.active) exitBgDrawLine();
  if (state.bgCopyLine && state.bgCopyLine.active) exitBgCopyLine();
  if (state.bgBisector && state.bgBisector.active) exitBgBisector();
  if (state.bgEqui && state.bgEqui.active) exitBgEqui();
  // 若有正在編輯的 → 先固化
  if (state.measure) _persistCurrentMeasure();
  // 取目標 entry(指定 id 或最後一筆),從清單拿出來放回 state.measure
  let idx;
  if (measureId != null) idx = list.findIndex(m => m.id === measureId);
  else idx = list.length - 1;
  if (idx < 0) { alert("找不到要移動的標示距離"); return; }
  const target = list.splice(idx, 1)[0];
  state.measure = {
    ...target,
    _backup: { p1: { ...target.p1 }, p2: { ...target.p2 } },
    _fromList: true,
    sliding: true,
  };
  $("hud").textContent = `標示距離:${target.label} — 滑鼠移動可滑動位置,點擊確認 / Esc 還原`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}
// 刪除指定 / 最後一筆標示距離
//   measureId 給定 → 該筆(可能在 file.measurements 或正在編輯的 state.measure)
//   未指定 → 優先刪正在編輯中的(最新),否則刪 file.measurements 的最後一筆
export function deleteMeasurement(measureId) {
  const file = getActiveFile();
  if (measureId != null) {
    if (file && Array.isArray(file.measurements)) {
      const idx = file.measurements.findIndex(m => m.id === measureId);
      if (idx >= 0) {
        pushUndo();
        file.measurements.splice(idx, 1);
        if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
        render();
        return true;
      }
    }
    if (state.measure && state.measure.id === measureId) {
      pushUndo();
      state.measure = null;
      if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
      render();
      return true;
    }
    return false;
  }
  // 未指定 id → 刪最後 / 編輯中
  if (state.measure) {
    pushUndo();
    state.measure = null;
    if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
    render();
    return true;
  }
  if (file && Array.isArray(file.measurements) && file.measurements.length) {
    pushUndo();
    file.measurements.pop();
    if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
    render();
    return true;
  }
  return false;
}
// 清空所有標示距離(active file)
export function clearAllMeasurements() {
  const file = getActiveFile();
  if (!file) return;
  const n = (file.measurements || []).length + (state.measure ? 1 : 0);
  if (!n) return;
  if (!confirm(`確定刪除這個檔案上所有 ${n} 個標示距離?`)) return;
  pushUndo();
  file.measurements = [];
  state.measure = null;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}

// 舊 API 名稱,保留給 pending 流程在 checkBgPendingAfterSelect 內呼叫
export function bgComputeMeasureFromSelection() {
  const lines = collectMeasureLinesFromCurrentSelection();
  if (!lines.length) return false;
  const m = computeMeasureFromLines(lines);
  if (!m) return false;
  pushUndo();
  if (state.measure) _persistCurrentMeasure();
  state.measure = { ...m, _backup: { p1: { ...m.p1 }, p2: { ...m.p2 } }, sliding: true, _fromList: false };
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  return true;
}
export function startMeasurePending() {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active) exitMoveMode();
  if (state.manualAlign && state.manualAlign.active) exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) cancelScaleRulerDrag();
  if (state.originPending) exitOriginPending();
  if (state.scaleRulerPending) exitScaleRulerPending();
  clearSelection();
  clearAllBgSelection(file);
  state.measurePending = true;
  if (state.tool !== "selectBg") setTool("selectBg");
  $("hud").textContent = "標示距離:請選第一條線(再選一條 = 兩線垂直距離,Esc 取消)";
  render();
}

