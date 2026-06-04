// 自動對齊 / 底圖旋轉
//
//   • extractSvgSegments    — 從 bg svg 抽出直線段(供分析最長 H/V 線)
//   • detectAlignmentAngle  — 找最長線段的角度,推算「需要旋轉幾度才能水平」
//   • enterManualAlign / exitManualAlign — 手動對齊模式(滑鼠拖曳調整角度)
//   • rotateBg90Clockwise   — 旋轉底圖 + 節點 + 桿件 + 比例尺 + clipRect 90°(順時針)
//   • wireAutoAlignButtons — 綁定 #btnRotate90 onclick(由 legacy.ts module body call,避免 TDZ)
// @ts-nocheck

import {
  $, state, getActiveFile, withBusy,
  pushUndo, render, refreshLists, applyTransform,
  cacheActivePageBgSegs, syncUserBgLinesToDom,
  applyBgRotation,
  _afterCalibrationChanged, _resyncSectionLinksForFile,
} from "../app/integration";
import { invalidateRankCache } from "../core/rankCache";

export function extractSvgSegments(svgEl) {
  const segs = [];
  const paths = svgEl.querySelectorAll("path");
  for (const p of paths) {
    const stroke = p.getAttribute("stroke") || p.style.stroke || "";
    if (!stroke || stroke === "none") continue;
    const d = p.getAttribute("d") || "";
    // 用 M…L 分解 (跟原本 legacy 的解析一致 — 只看 M / L,忽略曲線)
    // 規則跟 parseStraightSegs 同;簡化版不寫 helper
    const cmds = (d.match(/[MLZmlz]\s*[^MLZmlz]*/g) || []);
    let cur = null, start = null;
    for (const c of cmds) {
      const head = c[0].toUpperCase();
      const nums = (c.slice(1).match(/-?\d*\.?\d+/g) || []).map(parseFloat);
      if (head === "M" && nums.length >= 2) {
        cur = { x: nums[0], y: nums[1] };
        start = { ...cur };
        // 若 M 後還跟著數字組 → 後續視為 L
        for (let i = 2; i + 1 < nums.length; i += 2) {
          const nx = { x: nums[i], y: nums[i+1] };
          segs.push({ a: cur, b: nx });
          cur = nx;
        }
      } else if (head === "L" && nums.length >= 2) {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const nx = { x: nums[i], y: nums[i+1] };
          if (cur) segs.push({ a: cur, b: nx });
          cur = nx;
        }
      } else if (head === "Z" && cur && start) {
        segs.push({ a: cur, b: { ...start } });
        cur = { ...start };
      }
    }
  }
  // 也吃 <line>
  const lines = svgEl.querySelectorAll("line");
  for (const ln of lines) {
    const x1 = parseFloat(ln.getAttribute("x1") || 0);
    const y1 = parseFloat(ln.getAttribute("y1") || 0);
    const x2 = parseFloat(ln.getAttribute("x2") || 0);
    const y2 = parseFloat(ln.getAttribute("y2") || 0);
    segs.push({ a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
  }
  return segs;
}

export function detectAlignmentAngle() {
  const bgSvg = document.getElementById("bgSvg");
  if (!bgSvg) return 0;
  const segs = extractSvgSegments(bgSvg);
  if (!segs.length) return 0;
  // 找最長線段
  let best = null, bestLen = 0;
  for (const s of segs) {
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (len > bestLen) { bestLen = len; best = s; }
  }
  if (!best) return 0;
  const ang = Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x) * 180 / Math.PI;
  // 把線段轉成「離最近的水平 / 垂直軸」差幾度
  // 結果 ∈ [-45, 45] — 目標是讓最長線水平
  let delta = ang;
  while (delta > 45)  delta -= 90;
  while (delta < -45) delta += 90;
  return -delta;   // 旋轉這個角度後最長線會水平
}

export function enterManualAlign() {
  state.manualAlign = state.manualAlign || {};
  state.manualAlign.active = true;
  $("hud").textContent = "手動對齊:拖曳調整角度,Enter 確認 / Esc 取消";
}

export function exitManualAlign() {
  if (state.manualAlign) state.manualAlign.active = false;
  $("hud").textContent = "";
}

export function rotateBg90Clockwise() {
  if (state.tool !== "selectBg") {
    $("hud").textContent = "旋轉 90°:請先進入底圖模式";
    return;
  }
  const file = getActiveFile();
  if (!file) { alert("請先載入檔案。"); return; }
  pushUndo();
  // 旋轉錨點 = 底圖在世界座標下的視覺中心
  //   applyBgRotation 的 transform 序為 `translate(tx,ty) rotate(angle)`、
  //   transform-origin 在 bg-local (bgWidth/2, bgHeight/2);因此世界座標的旋轉中心
  //   = (bgWidth/2 + file.offsetX, bgHeight/2 + file.offsetY)。
  //   若用 (bgWidth/2, bgHeight/2) 當錨點,manualAlign 後 offsetX/Y ≠ 0 會造成
  //   節點 / userBgLines / 量測 跟底圖視覺中心不同步。
  const cx = state.bgWidth / 2 + (file.offsetX || 0);
  const cy = state.bgHeight / 2 + (file.offsetY || 0);
  // 對 (cx, cy) 順時針旋轉 90°
  const rot = (p) => ({
    x: cx + (cy - p.y),
    y: cy + (p.x - cx),
  });
  // 1. 節點 / 桿件:本頁 (file.pages 內所有 page 都套)
  let nJoints = 0;
  let pg = null;
  for (const k of Object.keys(file.pages || {})) {
    pg = file.pages[k];
    if (!pg || pg._orphan) continue;
    for (const j of (pg.joints || [])) {
      const r = rot({ x: j.x, y: j.y });
      j.x = r.x; j.y = r.y;
      nJoints++;
    }
  }
  // 2. planeOrigin / scaleRuler / clipRect / pageBoundsRect / 量測線 — 跟著旋轉
  if (file.planeOrigin) {
    const r = rot(file.planeOrigin);
    file.planeOrigin.x = r.x; file.planeOrigin.y = r.y;
  }
  if (file.scaleRuler) {
    if (file.scaleRuler.p1) { const r = rot(file.scaleRuler.p1); file.scaleRuler.p1 = r; }
    if (file.scaleRuler.p2) { const r = rot(file.scaleRuler.p2); file.scaleRuler.p2 = r; }
    if (file.scaleRuler.q1) { const r = rot(file.scaleRuler.q1); file.scaleRuler.q1 = r; }
    if (file.scaleRuler.q2) { const r = rot(file.scaleRuler.q2); file.scaleRuler.q2 = r; }
  }
  if (file.clipRect) {
    // clipRect: { x, y, w, h } → 轉 4 個角再求 bbox
    const corners = [
      { x: file.clipRect.x, y: file.clipRect.y },
      { x: file.clipRect.x + file.clipRect.w, y: file.clipRect.y },
      { x: file.clipRect.x, y: file.clipRect.y + file.clipRect.h },
      { x: file.clipRect.x + file.clipRect.w, y: file.clipRect.y + file.clipRect.h },
    ].map(rot);
    const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
    file.clipRect.x = Math.min(...xs);
    file.clipRect.y = Math.min(...ys);
    file.clipRect.w = Math.max(...xs) - file.clipRect.x;
    file.clipRect.h = Math.max(...ys) - file.clipRect.y;
  }
  // 量測線:存在 file.measurements(file-level,不是 per-page)
  if (Array.isArray(file.measurements)) {
    for (const m of file.measurements) {
      if (m.p1) m.p1 = rot(m.p1);
      if (m.p2) m.p2 = rot(m.p2);
    }
  }
  // 使用者畫的 bg 線(直線 / 虛線 / 複製 / 中分線 / 等分線)
  //   權威資料存在 file.userBgLines 的 world 座標,要跟著旋轉;
  //   DOM 會在下方 syncUserBgLinesToDom 從新座標重建
  if (Array.isArray(file.userBgLines)) {
    for (const ln of file.userBgLines) {
      const r1 = rot({ x: ln.x1, y: ln.y1 });
      const r2 = rot({ x: ln.x2, y: ln.y2 });
      ln.x1 = r1.x; ln.y1 = r1.y;
      ln.x2 = r2.x; ln.y2 = r2.y;
    }
  }
  // 切面線(sectionLinks.p1/p2 是 world 座標):同步旋轉,
  // 之後的 _resyncSectionLinksForFile 會用新座標重新分析 cutAxis / cutValue
  if (Array.isArray(file.sectionLinks)) {
    for (const e of file.sectionLinks) {
      if (e.autoProp) continue;
      if (e.p1) e.p1 = rot(e.p1);
      if (e.p2) e.p2 = rot(e.p2);
    }
  }
  // 3. flip:旋轉 90° 後 flipX ↔ flipY 互換,但 page-local 已經轉過,所以不動 flipX/Y
  // 4. file.rotation(applyBgRotation 用的視覺旋轉,單位為弧度)累加 π/2
  //    必須改的是 file.rotation,不是 file.bgRotation — 後者沒有任何地方讀,改了等於沒改,
  //    造成只有 joint / 量測 / userBgLines 等資料層旋轉,bg 視覺停在原地。
  const TWO_PI = Math.PI * 2;
  file.rotation = ((file.rotation || 0) + Math.PI / 2) % TWO_PI;
  applyBgRotation(file);
  // 5. plane:旋轉 90° → 各 page 的 plane 不變(平面圖還是平面圖)— 不動
  // 6. 平面切換對應 / planeAxes:也不動(plane 維持)
  cacheActivePageBgSegs();
  syncUserBgLinesToDom(file);
  invalidateRankCache();
  // resync sectionLinks 在 file 上的 cutValue + 目標 page.z
  //   旋轉後通常會換軸或變號 → 用新的像素 + 原點重新分析,並同步目標檔 page.z
  const sl = (typeof _resyncSectionLinksForFile === "function") ? _resyncSectionLinksForFile(file) : { slUpdated: 0, tgtZUpdated: 0 };
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  else { render(); refreshLists(); }
  $("hud").textContent = `旋轉 90°(順時針)・${file.name}:${nJoints} 節點${pg && pg.members ? "・" + pg.members.length + " 桿件" : ""} 同步旋轉` +
    (sl.slUpdated ? `・切面 ${sl.slUpdated} 條重算` : "");
}

// 由 legacy.ts module body 觸發 — 避免 sectionLink-style top-level $().onclick TDZ
export function wireAutoAlignButtons() {
  const btn = $("btnRotate90");
  if (btn) btn.onclick = () => withBusy("旋轉 90°(底圖 + 節點 + 桿件)…", rotateBg90Clockwise);
}
