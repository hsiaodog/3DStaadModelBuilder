// 鎖點(snap)— 游標 / 點擊位置自動吸附到節點 / 桿件 / 底圖 / 網格
//
//   • snapToBgVertex(world, opts) — 底圖端點 / 線交點(用 page._bgSegsCache 加速)
//   • snapToBgPaths(world) — 底圖線段端點 + 投影點(走 DOM 解析,slower)
//   • snap(p) — 主入口:節點吸附 + 桿件中點 + 桿件線投影 + ortho + 網格鎖點
//
//   選項:state.snapPx(px)/ state.snapMid / state.snapGrid / state.snapToGridLines /
//         state.snapToGridPoints / state.snapLinesPriority / state.ortho
// @ts-nocheck

import { state } from "./state";
import { getPage, jointById, svgElementToSegments } from "../app/integration";
import { screenToWorld } from "./transform";

export function snapToBgVertex(world, opts?: any) {
  const page = (typeof getPage === "function") ? getPage() : null;
  const segs = page && page._bgSegsCache;
  if (!Array.isArray(segs) || !segs.length) return null;
  const radius = (opts && opts.radius != null) ? opts.radius : ((state.snapPx || 12) / state.zoom);
  let best = null, bestD = radius;
  // 1. 端點(轉折點)
  for (const s of segs) {
    let d = Math.hypot(s.x1 - world.x, s.y1 - world.y);
    if (d < bestD) { bestD = d; best = { x: s.x1, y: s.y1, kind: "bg-vertex" }; }
    d = Math.hypot(s.x2 - world.x, s.y2 - world.y);
    if (d < bestD) { bestD = d; best = { x: s.x2, y: s.y2, kind: "bg-vertex" }; }
  }
  if (best) return best;
  // 2. 線段交點(只算靠近 world 的線段;避免 O(n²))
  const probe = radius * 4;
  const near = [];
  for (const s of segs) {
    const dxAB = s.x2 - s.x1, dyAB = s.y2 - s.y1;
    const lenSq = dxAB * dxAB + dyAB * dyAB;
    if (lenSq < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((world.x - s.x1) * dxAB + (world.y - s.y1) * dyAB) / lenSq));
    const px = s.x1 + t * dxAB, py = s.y1 + t * dyAB;
    const d = Math.hypot(world.x - px, world.y - py);
    if (d <= probe) near.push(s);
  }
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const a = near[i], b = near[j];
      const x1 = a.x1, y1 = a.y1, x2 = a.x2, y2 = a.y2;
      const x3 = b.x1, y3 = b.y1, x4 = b.x2, y4 = b.y2;
      const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(denom) < 1e-9) continue;
      const tA =  ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
      const tB = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
      if (tA < -0.01 || tA > 1.01 || tB < -0.01 || tB > 1.01) continue;
      const ix = x1 + tA * (x2 - x1);
      const iy = y1 + tA * (y2 - y1);
      const d = Math.hypot(ix - world.x, iy - world.y);
      if (d < bestD) { bestD = d; best = { x: ix, y: iy, kind: "bg-cross" }; }
    }
  }
  return best;
}

export function snapToBgPaths(world) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return null;
  const radius = state.snapPx / state.zoom;
  let best = null, bestD = radius;
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if ((el as any).style.display === "none") continue;
    if ((el as any).dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line" && tag !== "path" && tag !== "polyline" && tag !== "polygon" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (!segs.length) continue;
    const ctm = (el as any).getScreenCTM();
    if (!ctm) continue;
    const owner = (el as any).ownerSVGElement || bgSvgEl;
    for (const s of segs) {
      const sp1obj = owner.createSVGPoint(); sp1obj.x = s.x1; sp1obj.y = s.y1;
      const sp2obj = owner.createSVGPoint(); sp2obj.x = s.x2; sp2obj.y = s.y2;
      const ssp1 = sp1obj.matrixTransform(ctm), ssp2 = sp2obj.matrixTransform(ctm);
      const w1 = screenToWorld(ssp1.x, ssp1.y);
      const w2 = screenToWorld(ssp2.x, ssp2.y);
      // 端點
      let d = Math.hypot(w1.x - world.x, w1.y - world.y);
      if (d < bestD) { bestD = d; best = { x: w1.x, y: w1.y, kind: "bg-end" }; }
      d = Math.hypot(w2.x - world.x, w2.y - world.y);
      if (d < bestD) { bestD = d; best = { x: w2.x, y: w2.y, kind: "bg-end" }; }
      // 投影到線段
      const dxAB = w2.x - w1.x, dyAB = w2.y - w1.y;
      const lenSq = dxAB * dxAB + dyAB * dyAB;
      if (lenSq > 1e-9) {
        const t = Math.max(0, Math.min(1, ((world.x - w1.x) * dxAB + (world.y - w1.y) * dyAB) / lenSq));
        const px = w1.x + t * dxAB, py = w1.y + t * dyAB;
        d = Math.hypot(world.x - px, world.y - py);
        if (d < bestD) { bestD = d; best = { x: px, y: py, kind: "bg-line" }; }
      }
    }
  }
  return best;
}

export function snap(p) {
  const radius = state.snapPx / state.zoom;
  let best = null, bestD = radius;
  for (const j of getPage().joints) {
    const d = Math.hypot(j.x - p.x, j.y - p.y);
    if (d < bestD) { bestD = d; best = { x: j.x, y: j.y, joint: j }; }
  }
  if (state.snapMid) {
    for (const m of getPage().members) {
      const a = jointById(m.j1), b = jointById(m.j2);
      const mid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2 };
      const d = Math.hypot(mid.x - p.x, mid.y - p.y);
      if (d < bestD) { bestD = d; best = mid; }
    }
  }
  // 線條投影吸附:游標靠近任何已存在桿件時,吸附到該線上的投影點
  for (const mem of getPage().members) {
    const a = jointById(mem.j1), b = jointById(mem.j2);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const px = a.x + t * dx, py = a.y + t * dy;
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < bestD) { bestD = d; best = { x: px, y: py }; }
  }
  if (best) return best;
  // ortho snap relative to pendingLineStart
  let anchor = null;
  if (state.tool === "line" && state.pendingLineStart) {
    const j = jointById(state.pendingLineStart); anchor = { x: j.x, y: j.y };
  }
  let candidate = p;
  if (anchor && state.ortho) {
    const dx = Math.abs(p.x - anchor.x), dy = Math.abs(p.y - anchor.y);
    if (dx > dy) candidate = { x: p.x, y: anchor.y };
    else         candidate = { x: anchor.x, y: p.y };
  }
  // 網格鎖點 — 依 checkbox 組合決定
  const wantLine = !!state.snapToGridLines;
  const wantPoint = !!state.snapToGridPoints;
  if (wantLine || wantPoint) {
    const stepPx = (state.snapGrid.step || 1) * (state.scale || 1);
    if (stepPx > 0) {
      const nx = Math.round(candidate.x / stepPx) * stepPx;
      const ny = Math.round(candidate.y / stepPx) * stepPx;
      const dxToLine = Math.abs(candidate.x - nx);
      const dyToLine = Math.abs(candidate.y - ny);
      const snapToLine = () => (dxToLine <= dyToLine
        ? { x: nx, y: candidate.y }
        : { x: candidate.x, y: ny });
      const snapToPoint = () => ({ x: nx, y: ny });
      if (wantLine && wantPoint) {
        candidate = state.snapLinesPriority ? snapToLine() : snapToPoint();
      } else if (wantLine) candidate = snapToLine();
      else                  candidate = snapToPoint();
    }
  }
  return candidate;
}
