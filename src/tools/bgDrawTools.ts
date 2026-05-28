// 底圖繪圖工具 — 用 bg svg 圖層做幾何輔助線
//   • 畫直線 / 畫虛線(startBgDrawLine)— 兩點點擊建一條 bg line
//   • 複製線(startBgCopyLine)— 點來源 bg line 後跳基準點選擇,再每點一處放一份
//   • 中分線(startBgBisector)— 對選取的 bg line 中點作垂直中分線
//   • 等分線(startBgEqui) — 兩條平行 bg line 中央等距畫一條平行線
//   • bgToggleDashedOnSelection — 切換選取 bg line 的實線 / 虛線樣式
//
//   每個工具走 pending state(state.bgDrawLine / bgCopyLine / bgBisector / bgEqui)→
//     第一次點擊存第一點,第二次 commit;Esc / exit* 取消。
//   按鈕 onclick 用 wireBgDrawTools() 延後綁,避免 module top-level circular import TDZ。
// @ts-nocheck

import {
  $, state, getActiveFile,
  pushUndo, render, screenToWorld, setTool,
  clearAllBgSelection,
  addBgLineWorld, _refreshBgDrawButtonStates,
  bgSingleLineWorldEnds, groupCollinearLines,
  _selectedBgLinesAsWorld,
} from "../app/integration";

// ---------- 畫直線 / 畫虛線 ----------
//   兩者共用 state.bgDrawLine 狀態與 commit 流程,差別只在 dasharray:
//   實線 → null;虛線 → 預設樣式 "8 4"(跟「轉虛線」共用)。
export function startBgDrawLine(opts) {
  if (state.tool !== "selectBg") setTool("selectBg");
  const dashed = !!(opts && opts.dashed);
  state.bgDrawLine = { active: true, p1: null, dasharray: dashed ? "8 4" : null };
  state.bgBisector = null;
  state.bgEqui = null;
  state.bgCopyLine = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = dashed
    ? "畫虛線:點選第一個點(自動吸 bg 端點 / 交點。Alt = 也吸線中段。Esc 取消)"
    : "畫直線:點選第一個點(自動吸 bg 端點 / 交點。Alt = 也吸線中段。Esc 取消)";
  render();
}
export function exitBgDrawLine(msg) {
  if (!state.bgDrawLine) return;
  state.bgDrawLine = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
export function commitBgDrawLineSecond(world) {
  const file = getActiveFile();
  if (!file || !state.bgDrawLine || !state.bgDrawLine.p1) return;
  const p1 = state.bgDrawLine.p1;
  const dasharray = state.bgDrawLine.dasharray || null;
  pushUndo();
  addBgLineWorld(file, p1, world, dasharray ? { dasharray } : undefined);
  state.bgDrawLine = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = dasharray ? "已加入 bg 虛線" : "已加入 bg 直線";
  render();
}

// ---------- 複製線(實線 / 虛線都支援) ----------
//   流程:
//     a) 進入時若已有選取的 bg 線 → 直接抓成 sources,進入「點基準點」
//     b) 進入時無選取 → 進入「選 source」,使用者點任一條 bg 線當來源後再進「點基準點」
//     c) 基準點設好後,每次點擊 = 放置一份新線(基準點不變,連續複製)
//   Esc 或切換到其他工具就退出。
export function _captureSourceFromElement(elx) {
  if (!elx) return null;
  const L = bgSingleLineWorldEnds(elx);
  if (!L) return null;
  let dash = elx.getAttribute && elx.getAttribute("stroke-dasharray");
  if (!dash) {
    const sty = elx.getAttribute && elx.getAttribute("style");
    const m = sty && sty.match(/stroke-dasharray\s*:\s*([^;]+)/i);
    if (m) dash = m[1].trim();
  }
  return { p1: { x: L.p1.x, y: L.p1.y }, p2: { x: L.p2.x, y: L.p2.y }, dasharray: dash || null };
}
export function startBgCopyLine() {
  if (state.tool !== "selectBg") setTool("selectBg");
  const file = getActiveFile();
  state.bgDrawLine = null;
  state.bgBisector = null;
  state.bgEqui = null;
  // 若已有選取 → 抓成 sources;否則 sources=[](用 pickingSource 旗標等使用者點線)
  const sources = [];
  if (file && file.selectedBgPaths && file.selectedBgPaths.size) {
    const bgSvgEl = document.getElementById("bgSvg");
    for (const idx of file.selectedBgPaths) {
      const elx = bgSvgEl && bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(idx))}"]`);
      const src = _captureSourceFromElement(elx);
      if (src) sources.push(src);
    }
    // 已轉成 sources,清掉視覺選取:複製線進行中不該有「選取狀態」殘留干擾
    clearAllBgSelection && clearAllBgSelection(file);
  }
  state.bgCopyLine = { active: true, sources, base: null };
  _refreshBgDrawButtonStates();
  if (sources.length) {
    $("hud").textContent = `複製線:選了 ${sources.length} 條 → 點基準點(自動吸 bg 端點 / 交點)`;
  } else {
    $("hud").textContent = `複製線:點一條要複製的 bg 線(實線 / 虛線都可)`;
  }
  render();
}
export function exitBgCopyLine(msg) {
  if (!state.bgCopyLine) return;
  state.bgCopyLine = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
export function commitBgCopyLineDest(world) {
  const file = getActiveFile();
  const cl = state.bgCopyLine;
  if (!file || !cl || !cl.active || !cl.base || !cl.sources.length) return;
  const dx = world.x - cl.base.x, dy = world.y - cl.base.y;
  pushUndo();
  let n = 0;
  for (const src of cl.sources) {
    const p1 = { x: src.p1.x + dx, y: src.p1.y + dy };
    const p2 = { x: src.p2.x + dx, y: src.p2.y + dy };
    addBgLineWorld(file, p1, p2, src.dasharray ? { dasharray: src.dasharray } : undefined);
    n++;
  }
  $("hud").textContent = `複製線:放置 ${n} 條(再點下一處,Esc 結束)`;
  render();
}

// ---------- 中分線 ----------
export function startBgBisector() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size < 1) {
    alert("請先選 1 條 bg 線"); return;
  }
  const lines = _selectedBgLinesAsWorld(file);
  if (lines.length < 1) { alert("選取的不是單一直線(可先「切成直線」)"); return; }
  const L = lines[0];
  const dx = L.p2.x - L.p1.x, dy = L.p2.y - L.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { alert("選取的線段太短"); return; }
  const mid = { x: (L.p1.x + L.p2.x) / 2, y: (L.p1.y + L.p2.y) / 2 };
  const nx = -dy / len, ny = dx / len;
  state.bgBisector = { active: true, mid, nx, ny, halfLen: len / 2 };
  state.bgDrawLine = null;
  state.bgEqui = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = "中分線:移動滑鼠決定半長,點擊確認 / Esc 取消";
  render();
}
export function exitBgBisector(msg) {
  if (!state.bgBisector) return;
  state.bgBisector = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
export function updateBgBisectorPreview(clientX, clientY) {
  const b = state.bgBisector; if (!b) return;
  const w = screenToWorld(clientX, clientY);
  // 投影 (w - mid) 到法向量 (nx, ny);取絕對值為半長
  const dx = w.x - b.mid.x, dy = w.y - b.mid.y;
  const t = dx * b.nx + dy * b.ny;
  b.halfLen = Math.max(1, Math.abs(t));
  render();
}
export function commitBgBisector() {
  const file = getActiveFile();
  const b = state.bgBisector; if (!file || !b) return;
  const p1 = { x: b.mid.x - b.nx * b.halfLen, y: b.mid.y - b.ny * b.halfLen };
  const p2 = { x: b.mid.x + b.nx * b.halfLen, y: b.mid.y + b.ny * b.halfLen };
  pushUndo();
  addBgLineWorld(file, p1, p2);
  state.bgBisector = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = `已加入中分線(半長 ${b.halfLen.toFixed(0)})`;
  render();
}

// ---------- 等分線(兩條近似平行 bg 線之間的等距平行線)----------
export function startBgEqui() {
  const file = getActiveFile();
  const lines = _selectedBgLinesAsWorld(file);
  if (lines.length < 2) { alert("請選 2 條以上 bg 線(系統自動找平行對)"); return; }
  // 共線視為同一條(允許重疊 / 同條線多次選到)→ 各 group 取代表
  const groups = groupCollinearLines(lines);
  if (groups.length < 2) { alert("選取的線都共線(同一條),需選 2 條不同位置的平行線"); return; }
  const reps = groups.map(g => lines[g[0]]);
  // 在所有獨立線兩兩中,找第一對平行(夾角 ≤ 3°,sin ≤ 0.05)的
  let L1 = null, L2 = null, sinTheta = 0;
  outer:
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      const v1 = { x: reps[i].p2.x - reps[i].p1.x, y: reps[i].p2.y - reps[i].p1.y };
      const v2 = { x: reps[j].p2.x - reps[j].p1.x, y: reps[j].p2.y - reps[j].p1.y };
      const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
      if (len1 < 1e-6 || len2 < 1e-6) continue;
      const s = Math.abs((v1.x * v2.y - v1.y * v2.x) / (len1 * len2));
      if (s <= 0.05) {
        L1 = reps[i]; L2 = reps[j]; sinTheta = s;
        break outer;
      }
    }
  }
  if (!L1) {
    // 找不到嚴格平行 → 提示使用者
    alert(`選取的 ${reps.length} 條獨立線中找不到平行對(夾角都 > 3°),無法畫等分線`);
    return;
  }
  // 同向化(若 v2 反向就翻)
  const v1 = { x: L1.p2.x - L1.p1.x, y: L1.p2.y - L1.p1.y };
  const v2 = { x: L2.p2.x - L2.p1.x, y: L2.p2.y - L2.p1.y };
  const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
  const dot = v1.x * v2.x + v1.y * v2.y;
  const v2s = dot >= 0 ? v2 : { x: -v2.x, y: -v2.y };
  const ux1 = v1.x / len1, uy1 = v1.y / len1;
  const ux2 = v2s.x / len2, uy2 = v2s.y / len2;
  let dx = (ux1 + ux2) / 2, dy = (uy1 + uy2) / 2;
  const dl = Math.hypot(dx, dy);
  if (dl < 1e-6) { alert("方向計算失敗"); return; }
  dx /= dl; dy /= dl;
  const m1 = { x: (L1.p1.x + L1.p2.x) / 2, y: (L1.p1.y + L1.p2.y) / 2 };
  const m2 = { x: (L2.p1.x + L2.p2.x) / 2, y: (L2.p1.y + L2.p2.y) / 2 };
  const center = { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 };
  const halfLen = (len1 + len2) / 4;
  state.bgEqui = { active: true, center, dx, dy, halfLen };
  state.bgDrawLine = null;
  state.bgBisector = null;
  _refreshBgDrawButtonStates();
  const msg = (reps.length > 2)
    ? `等分線:從 ${reps.length} 條獨立線中找到平行對 — 移動滑鼠決定總長,點擊確認 / Esc 取消`
    : "等分線:移動滑鼠決定總長(對稱拉長),點擊確認 / Esc 取消";
  $("hud").textContent = msg;
  render();
}
export function exitBgEqui(msg) {
  if (!state.bgEqui) return;
  state.bgEqui = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
export function updateBgEquiPreview(clientX, clientY) {
  const e = state.bgEqui; if (!e) return;
  const w = screenToWorld(clientX, clientY);
  // 投影 (w - center) 到方向 (dx, dy);取絕對值為半長
  const t = (w.x - e.center.x) * e.dx + (w.y - e.center.y) * e.dy;
  e.halfLen = Math.max(1, Math.abs(t));
  render();
}
export function commitBgEqui() {
  const file = getActiveFile();
  const e = state.bgEqui; if (!file || !e) return;
  const p1 = { x: e.center.x - e.dx * e.halfLen, y: e.center.y - e.dy * e.halfLen };
  const p2 = { x: e.center.x + e.dx * e.halfLen, y: e.center.y + e.dy * e.halfLen };
  pushUndo();
  // 等分線視為中心線:用 CENTER pattern 虛線(stroke-dasharray)
  addBgLineWorld(file, p1, p2, { dasharray: "12 4 4 4" });
  state.bgEqui = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = `已加入等分線(半長 ${e.halfLen.toFixed(0)},虛線樣式)`;
  render();
}

// 轉虛線:對所有選取的 bg 線切換 stroke-dasharray
//   元素已有 dasharray → 移除(轉成實線)
//   元素無 dasharray → 套用預設 "8 4"(轉成虛線)
//   不影響選取狀態,只改線型
export function bgToggleDashedOnSelection() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  pushUndo();
  let toDashed = 0, toSolid = 0;
  for (const idx of file.selectedBgPaths) {
    const el = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(idx))}"]`);
    if (!el) continue;
    if (el.hasAttribute("stroke-dasharray")) {
      el.removeAttribute("stroke-dasharray");
      toSolid++;
    } else {
      el.setAttribute("stroke-dasharray", "8 4");
      toDashed++;
    }
  }
  // 同步 cachedBgSvg
  try { file.cachedBgSvg = new XMLSerializer().serializeToString(bgSvgEl); } catch (_) {}
  $("hud").textContent = `轉虛線:${toDashed} 條變虛線、${toSolid} 條變實線`;
  render();
}

// 比例尺沿線移動 — 點擊式互動:
//   1) 按按鈕 → 進入 drag 模式,記下原本 p1/p2(用於 Esc 還原)
//   2) 滑鼠 mouse-move → 即時把游標投影到比例尺的「參考線方向」軸上,sr.p1/p2 同步平移
//   3) 點擊畫布 → 確認當前位置(sr.p1/p2 已經就位),退出模式
//   4) Esc → 還原到 backup,退出模式

// 6 個 bgEdit 子工具按鈕的 onclick 集中綁定;由 legacy.ts module body 延後 call,避免 TDZ
export function wireBgDrawTools() {
  $("bgEditDrawLine")   && ($("bgEditDrawLine").onclick   = () => startBgDrawLine());
  $("bgEditDrawDashed") && ($("bgEditDrawDashed").onclick = () => startBgDrawLine({ dashed: true }));
  $("bgEditCopyLine")   && ($("bgEditCopyLine").onclick   = () => startBgCopyLine());
  $("bgEditBisector")   && ($("bgEditBisector").onclick   = () => startBgBisector());
  $("bgEditEquidist")   && ($("bgEditEquidist").onclick   = () => startBgEqui());
  $("bgEditToDashed")   && ($("bgEditToDashed").onclick   = () => bgToggleDashedOnSelection());
}
