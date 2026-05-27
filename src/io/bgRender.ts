// 底圖渲染 / 路徑偵測(bg render & detect)
//
//   • parseStraightSegs / bgLineWorldEnds / bgLocalToWorld — 底圖座標處理
//   • findRectangleBgLines / findCircleBgPaths / findStraightBgLines / findDiagonalBgSegments
//     — 形狀匡選的偵測核心(配合 selectBg 工具)
//   • applyBgSelectMode / updateBgStrokeWidth / applyBgRotation — 底圖視覺 / 互動
//   • renderPdfBg / renderBlankBg / renderImageBg / renderCachedBg — 各種底圖來源渲染
//
//   依賴 legacy.ts 的 state / DOM / getPage / screenToWorld / fitToView / etc.
//   (attachBgPathHandlers / svgElementToSegments / _ensureBgOrigGroup 留在 legacy.ts → import)
// @ts-nocheck

import {
  $, state, getPage,
  svg, stage, bg, bgctx,
  screenToWorld, fitToView,
  attachBgPathHandlers, svgElementToSegments, _ensureBgOrigGroup,
} from "../legacy";

export function parseStraightSegs(d) {
  const tokens = (d || "").match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) || [];
  const segs = []; let cur = null, start = null, cmd = null, i = 0;
  const grab = (n) => { const a = []; for (let k = 0; k < n; k++) a.push(parseFloat(tokens[i++])); return a; };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) {
      cmd = t; i++;
      if (cmd === "Z" || cmd === "z") {
        if (cur && start && (cur.x !== start.x || cur.y !== start.y)) {
          segs.push({ x1: cur.x, y1: cur.y, x2: start.x, y2: start.y });
        }
        cur = start ? { ...start } : null;
        cmd = null;
      }
      continue;
    }
    if (cmd == null) { i++; continue; }
    switch (cmd) {
      case "M": case "m": {
        const [x, y] = grab(2);
        cur = (cmd === "M" || !cur) ? { x, y } : { x: cur.x + x, y: cur.y + y };
        start = { ...cur };
        cmd = (cmd === "M") ? "L" : "l";    // 後續隱式 = lineto
        break;
      }
      case "L": case "l": {
        const [x, y] = grab(2);
        const next = (cmd === "L") ? { x, y } : { x: cur.x + x, y: cur.y + y };
        if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: next.x, y2: next.y });
        cur = next; break;
      }
      case "H": case "h": {
        const [x] = grab(1);
        const nx = cmd === "H" ? x : cur.x + x;
        if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: nx, y2: cur.y });
        cur = { x: nx, y: cur.y }; break;
      }
      case "V": case "v": {
        const [y] = grab(1);
        const ny = cmd === "V" ? y : cur.y + y;
        if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: cur.x, y2: ny });
        cur = { x: cur.x, y: ny }; break;
      }
      case "C": case "c": {
        const a = grab(6);
        const ex = cmd === "C" ? a[4] : cur.x + a[4];
        const ey = cmd === "C" ? a[5] : cur.y + a[5];
        cur = { x: ex, y: ey }; break;
      }
      case "S": case "s": case "Q": case "q": {
        const a = grab(4);
        const abs = (cmd === "S" || cmd === "Q");
        cur = { x: abs ? a[2] : cur.x + a[2], y: abs ? a[3] : cur.y + a[3] }; break;
      }
      case "T": case "t": {
        const [x, y] = grab(2);
        cur = (cmd === "T") ? { x, y } : { x: cur.x + x, y: cur.y + y }; break;
      }
      case "A": case "a": {
        const a = grab(7);
        const ex = cmd === "A" ? a[5] : cur.x + a[5];
        const ey = cmd === "A" ? a[6] : cur.y + a[6];
        cur = { x: ex, y: ey }; break;
      }
      default: i++;
    }
  }
  return segs;
}

// 把一條 <line> 兩端點轉成「世界座標」(經過所有父層 transform → 螢幕 → 世界)
// 解決 pdf.js 把同一張圖的不同段切到不同 <g> 父層、本地座標對不上的問題
export function bgLineWorldEnds(el) {
  const ctm = el.getScreenCTM();
  if (!ctm) return null;
  const svg = el.ownerSVGElement || document.getElementById("bgSvg");
  const x1 = parseFloat(el.getAttribute("x1") || 0);
  const y1 = parseFloat(el.getAttribute("y1") || 0);
  const x2 = parseFloat(el.getAttribute("x2") || 0);
  const y2 = parseFloat(el.getAttribute("y2") || 0);
  const p1 = svg.createSVGPoint(); p1.x = x1; p1.y = y1;
  const p2 = svg.createSVGPoint(); p2.x = x2; p2.y = y2;
  const s1 = p1.matrixTransform(ctm);
  const s2 = p2.matrixTransform(ctm);
  const w1 = screenToWorld(s1.x, s1.y);
  const w2 = screenToWorld(s2.x, s2.y);
  return { a: w1, b: w2 };
}

// 把 SVG 元素的 local 座標(透過 CTM 串完所有父層 transform)轉成世界座標
export function bgLocalToWorld(el, x, y) {
  const ctm = el.getScreenCTM();
  if (!ctm) return { x, y };
  const owner = el.ownerSVGElement || document.getElementById("bgSvg");
  const pt = owner.createSVGPoint(); pt.x = x; pt.y = y;
  const sp = pt.matrixTransform(ctm);
  return screenToWorld(sp.x, sp.y);
}

// bbox vs 匡選範圍判斷:crossing → 任何相交;非 crossing → 完整包含
export function bgBBoxInRange(bb, range) {
  if (range.crossing) {
    return !(bb.x2 < range.x1 || bb.x1 > range.x2 || bb.y2 < range.y1 || bb.y1 > range.y2);
  }
  return bb.x1 >= range.x1 && bb.x2 <= range.x2 && bb.y1 >= range.y1 && bb.y2 <= range.y2;
}

// 從目前 bg lines 中找出構成軸向矩形/正方形的元素
// mode: "square" = 寬 ≈ 高;"rect" = 寬 ≠ 高;"any" = 都選
// range:可選,世界座標 {x1,y1,x2,y2}, 只挑全部落在範圍內的形狀(crossing=false 嚴格包含)
export function findRectangleBgLines(mode, range) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();

  const eps = 1.0; // 世界單位(通常 1 mm)
  const matched = new Set();
  // 由右至左 (crossing) → 任何相交即可;由左至右 → 完整包含
  const inRange = (cx1, cy1, cx2, cy2) => {
    if (!range) return true;
    const minX = Math.min(cx1, cx2), maxX = Math.max(cx1, cx2);
    const minY = Math.min(cy1, cy2), maxY = Math.max(cy1, cy2);
    if (range.crossing) {
      return !(maxX < range.x1 || minX > range.x2 || maxY < range.y1 || minY > range.y2);
    }
    return minX >= range.x1 && maxX <= range.x2 && minY >= range.y1 && maxY <= range.y2;
  };

  // ---- A. 4 條獨立 <line> 構成的封閉矩形 ----
  const lines = Array.from(bgSvgEl.querySelectorAll('line[data-bg-idx]'))
    .filter(el => el.style.display !== "none" && el.dataset.bgPageBg !== "1");
  const horizontals = [], verticals = [];
  for (const el of lines) {
    const ends = bgLineWorldEnds(el);
    if (!ends) continue;
    const dx = ends.b.x - ends.a.x, dy = ends.b.y - ends.a.y;
    const idx = el.dataset.bgIdx;
    if (Math.abs(dy) < eps && Math.abs(dx) >= eps) {
      horizontals.push({ idx, x1: Math.min(ends.a.x, ends.b.x), x2: Math.max(ends.a.x, ends.b.x), y: (ends.a.y + ends.b.y) / 2 });
    } else if (Math.abs(dx) < eps && Math.abs(dy) >= eps) {
      verticals.push({ idx, y1: Math.min(ends.a.y, ends.b.y), y2: Math.max(ends.a.y, ends.b.y), x: (ends.a.x + ends.b.x) / 2 });
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
      const isSquare = Math.abs(w - h) < eps;
      if (mode === "square" && !isSquare) continue;
      if (mode === "rect"   && isSquare) continue;
      if (!inRange(ha.x1, top, ha.x2, bot)) continue;
      matched.add(ha.idx); matched.add(hb.idx);
      matched.add(left.idx); matched.add(right.idx);
    }
  }

  // ---- B. 單一元素(path / polygon / polyline / rect)本身就構成軸向矩形 ----
  // 「一線到底」型:單一 <path> 用 M-L-L-L-Z(或開放四段)畫完整個方框
  const candidates = bgSvgEl.querySelectorAll('[data-bg-idx]');
  for (const el of candidates) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "line") continue;       // line 在 A 階段處理
    if (tag !== "path" && tag !== "polygon" && tag !== "polyline" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (segs.length < 4) continue;       // 至少要 4 段才可能成方框
    // 把 segments 端點轉到 world 座標
    const worldSegs = segs.map(s => {
      const a = bgLocalToWorld(el, s.x1, s.y1);
      const b = bgLocalToWorld(el, s.x2, s.y2);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    });
    // 檢測:能否找到 4 段(允許 ≥4 取前 4 但要求閉合 + 軸向交替)
    // 簡化:取前 4 段,檢查每段都軸向 + 兩兩首尾相連 + 4 個角形成矩形
    if (worldSegs.length < 4) continue;
    // 從所有 segs 中找一組構成封閉軸向四邊形的端點 → 取所有端點的 bbox + 檢驗
    const xs = [], ys = [];
    let allAxisAligned = true;
    for (const s of worldSegs) {
      const isH = Math.abs(s.ay - s.by) < eps;
      const isV = Math.abs(s.ax - s.bx) < eps;
      if (!isH && !isV) { allAxisAligned = false; break; }
      xs.push(s.ax, s.bx); ys.push(s.ay, s.by);
    }
    if (!allAxisAligned) continue;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w < eps || h < eps) continue;
    // 確認 4 角點都被 segments 覆蓋(每個角點 = 兩條軸向邊的相交)
    const corners = [
      { x: minX, y: minY }, { x: maxX, y: minY },
      { x: maxX, y: maxY }, { x: minX, y: maxY },
    ];
    const reachedCorner = corners.map(c =>
      worldSegs.some(s =>
        (Math.abs(s.ax - c.x) < eps && Math.abs(s.ay - c.y) < eps) ||
        (Math.abs(s.bx - c.x) < eps && Math.abs(s.by - c.y) < eps)
      )
    );
    if (!reachedCorner.every(Boolean)) continue;
    // 邊長檢驗:必須有恰好覆蓋 4 邊(top/right/bottom/left)的軸向 segments
    const hasEdge = (x1, y1, x2, y2) => worldSegs.some(s => {
      const matchAB = Math.abs(s.ax - x1) < eps && Math.abs(s.ay - y1) < eps && Math.abs(s.bx - x2) < eps && Math.abs(s.by - y2) < eps;
      const matchBA = Math.abs(s.ax - x2) < eps && Math.abs(s.ay - y2) < eps && Math.abs(s.bx - x1) < eps && Math.abs(s.by - y1) < eps;
      return matchAB || matchBA;
    });
    if (!hasEdge(minX, minY, maxX, minY)) continue;
    if (!hasEdge(maxX, minY, maxX, maxY)) continue;
    if (!hasEdge(maxX, maxY, minX, maxY)) continue;
    if (!hasEdge(minX, maxY, minX, minY)) continue;

    const isSquare = Math.abs(w - h) < eps;
    if (mode === "square" && !isSquare) continue;
    if (mode === "rect"   && isSquare) continue;
    if (!inRange(minX, minY, maxX, maxY)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

// 取一個 bg path 的世界座標 bbox(透過 CTM 轉換)。回傳 null 若取不到。
export function bgPathWorldBBox(el) {
  const segs = svgElementToSegments(el);
  const ctm = el.getScreenCTM && el.getScreenCTM();
  const owner = el.ownerSVGElement || document.getElementById("bgSvg");
  if (!ctm || !owner) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  if (segs.length > 0) {
    for (const s of segs) {
      for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
        const pt = owner.createSVGPoint(); pt.x = px; pt.y = py;
        const sp = pt.matrixTransform(ctm);
        const wp = screenToWorld(sp.x, sp.y);
        grow(wp.x, wp.y);
      }
    }
  } else {
    // 沒有可解析的 segments(例如 <circle> / <ellipse>)→ 用 element 自己的 BBox
    try {
      const bb = el.getBBox();
      const corners = [
        [bb.x, bb.y], [bb.x + bb.width, bb.y],
        [bb.x + bb.width, bb.y + bb.height], [bb.x, bb.y + bb.height],
      ];
      for (const [px, py] of corners) {
        const pt = owner.createSVGPoint(); pt.x = px; pt.y = py;
        const sp = pt.matrixTransform(ctm);
        const wp = screenToWorld(sp.x, sp.y);
        grow(wp.x, wp.y);
      }
    } catch (_) { return null; }
  }
  if (!isFinite(minX)) return null;
  return { x1: minX, y1: minY, x2: maxX, y2: maxY };
}

// 圓形匡選:抓 <circle> / <ellipse>,以及 bbox 接近正方形 + d 含曲線指令(C/Q/A)的封閉 path
export function findCircleBgPaths(range) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();
  const matched = new Set();
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    let isCircle = false;
    if (tag === "circle" || tag === "ellipse") {
      isCircle = true;
    } else if (tag === "path") {
      const d = el.getAttribute("d") || "";
      if (/[CcQqAa]/.test(d)) {
        // 用 bbox 比例判斷是否近似圓 / 圓滑封閉曲線
        const bb = bgPathWorldBBox(el);
        if (bb) {
          const w = bb.x2 - bb.x1, h = bb.y2 - bb.y1;
          if (w > 0.5 && h > 0.5 && Math.abs(w - h) / Math.max(w, h) < 0.15) isCircle = true;
        }
      }
    }
    if (!isCircle) continue;
    const bb = bgPathWorldBBox(el);
    if (!bb || !bgBBoxInRange(bb, range)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

// 直線匡選:挑選「單段直線」元素(SVG <line> 或只含 1 個 M-L 段的 path / polyline)
//   排除:circle / ellipse / rect / polygon / 多段 polyline / 多段 path
export function findStraightBgLines(range, opts) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();
  const requireSolid = !!(opts && opts.requireSolid);
  const matched = new Set();
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    // 排除非線型元素
    if (tag === "circle" || tag === "ellipse" || tag === "rect" || tag === "polygon") continue;
    if (tag !== "line" && tag !== "path" && tag !== "polyline") continue;
    const segs = svgElementToSegments(el);
    // 必須剛好 1 段直線
    if (segs.length !== 1) continue;
    const s = segs[0];
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    if (Math.hypot(dx, dy) < 0.01) continue;   // 太短 / 零長
    if (requireSolid && _isDashedBgElement(el)) continue;   // 直實線:虛線排除
    const bb = bgPathWorldBBox(el);
    if (!bb || !bgBBoxInRange(bb, range)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

// 判定 bg 元素是否為「單段直線」(line / 單段 path / 單段 polyline,長度 > 0)
//   切面 pending 期間用來限制單擊只能選直線(同 marquee 的「直線」模式條件)
export function _isStraightBgLineElement(el) {
  if (!el || !el.dataset) return false;
  if (el.dataset.bgPageBg === "1") return false;
  const tag = (el.localName || (el.tagName || "").replace(/^.*:/, "")).toLowerCase();
  if (tag !== "line" && tag !== "path" && tag !== "polyline") return false;
  const segs = (typeof svgElementToSegments === "function") ? svgElementToSegments(el) : null;
  if (!segs || segs.length !== 1) return false;
  const s = segs[0];
  if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 0.01) return false;
  return true;
}

// 判定 bg 元素是否為「虛線」(顯式 stroke-dasharray 屬性,或 inline style 的 stroke-dasharray)
export function _isDashedBgElement(el) {
  const a = el.getAttribute && el.getAttribute("stroke-dasharray");
  if (a && a.trim() && a.trim() !== "none" && a.trim() !== "0") return true;
  const sty = el.style && el.style.strokeDasharray;
  if (sty && sty.trim() && sty.trim() !== "none" && sty.trim() !== "0") return true;
  return false;
}

export function findDiagonalBgSegments(range, opts) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();
  const requireDashed = !!(opts && opts.requireDashed);
  const requireSolid  = !!(opts && opts.requireSolid);
  const matched = new Set();
  const angleTolDeg = 5;

  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line" && tag !== "path" && tag !== "polyline" && tag !== "polygon") continue;
    const segs = svgElementToSegments(el);
    if (segs.length === 0) continue;
    const ctm = el.getScreenCTM && el.getScreenCTM();
    const owner = el.ownerSVGElement || bgSvgEl;
    if (!ctm) continue;
    // 轉到世界座標檢查是否有斜線段
    let hasDiag = false;
    for (const s of segs) {
      const p1 = owner.createSVGPoint(); p1.x = s.x1; p1.y = s.y1;
      const p2 = owner.createSVGPoint(); p2.x = s.x2; p2.y = s.y2;
      const sp1 = p1.matrixTransform(ctm), sp2 = p2.matrixTransform(ctm);
      const w1 = screenToWorld(sp1.x, sp1.y);
      const w2 = screenToWorld(sp2.x, sp2.y);
      const dx = w2.x - w1.x, dy = w2.y - w1.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;     // 太短的略過
      const ang = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;  // 0..90
      const offAxis = Math.min(ang, 90 - ang);
      if (offAxis > angleTolDeg) { hasDiag = true; break; }
    }
    if (!hasDiag) continue;
    if (requireDashed && !_isDashedBgElement(el)) continue;
    if (requireSolid  &&  _isDashedBgElement(el)) continue;
    const bb = bgPathWorldBBox(el);
    if (!bb || !bgBBoxInRange(bb, range)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

export function applyBgSelectMode() {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  const active = state.tool === "selectBg";
  // 取 bgSvg 在螢幕上的實際尺寸,用來判斷哪些元素是「頁背景級」大方框
  const svgRect = active ? bgSvgEl.getBoundingClientRect() : null;
  els.forEach(el => {
    if (!active) {
      el.style.pointerEvents = "none";
      el.style.cursor = "default";
      return;
    }
    // 已標記過:直接讀 dataset,跳過 getBoundingClientRect (避免反覆 layout 重算)
    if (el.dataset.bgPageBg === "1") {
      el.style.pointerEvents = "none";
      el.style.cursor = "default";
      return;
    }
    if (el.dataset.bgChecked !== "1") {
      // 第一次:偵測是否頁背景級大方框(bbox ≥ 視口 80% 寬+80% 高)
      try {
        const r = el.getBoundingClientRect();
        if (r.width >= svgRect.width * 0.8 && r.height >= svgRect.height * 0.8) {
          el.dataset.bgPageBg = "1";
          el.dataset.bgChecked = "1";
          el.style.pointerEvents = "none";
          el.style.cursor = "default";
          return;
        }
      } catch (_) {}
      el.dataset.bgChecked = "1";
    }
    // 統一用 stroke:不管 fill / stroke 屬性值是什麼,只要游標在 perimeter 就命中
    el.style.pointerEvents = "stroke";
    el.style.cursor = "none";
  });
}

export function updateBgStrokeWidth() {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  // 底圖線寬與網格細線寬一致 — 用 CSS 變數一次設,所有 .bg-stroke 透過 inherit 取值
  // (避免逐元素 setAttribute 對上千 DXF 元素造成卡頓)
  const target = Math.max(0.2, 1 / state.zoom).toFixed(3);
  bgSvgEl.style.setProperty("--bg-sw", target + "px");
}

export function applyBgRotation(file) {
  if (!file) return;
  const angle = file.rotation || 0;
  const tx = file.offsetX || 0;
  const ty = file.offsetY || 0;
  const cx = state.bgWidth / 2, cy = state.bgHeight / 2;
  const parts = [];
  if (tx || ty) parts.push(`translate(${tx}px, ${ty}px)`);
  if (angle)    parts.push(`rotate(${(angle * 180 / Math.PI).toFixed(4)}deg)`);
  const t = parts.join(" ");

  // 計算 clip 角點(若是拆分頁面有指定 clipRect)
  //   clipRect 是使用者拖出的「視覺世界座標」矩形;clip-path 卻是套在元素本地(旋轉前)
  //   座標上,所以要把世界矩形 4 個角扣回元素本地座標(反向位移 + 反向旋轉繞中心),
  //   並用 polygon 表達(任意角度的旋轉矩形不一定軸向對齊,inset 不夠用)。
  let cssClip = "";
  let clipCorners = null;
  if (file.clipRect) {
    const r = file.clipRect;
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    const corners = [
      [r.x,         r.y],
      [r.x + r.w,   r.y],
      [r.x + r.w,   r.y + r.h],
      [r.x,         r.y + r.h],
    ].map(([x, y]) => {
      const dx = (x - tx) - cx;
      const dy = (y - ty) - cy;
      return [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA];
    });
    clipCorners = corners;
    const ptsStr = corners.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(", ");
    cssClip = `polygon(${ptsStr})`;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  if (bgSvgEl) {
    bgSvgEl.style.transformOrigin = `${cx}px ${cy}px`;
    bgSvgEl.style.transform = t;
    bgSvgEl.style.clipPath = "";  // 不在 root 套 clip,改套在 bg-orig 子群組
    const orig = (typeof _ensureBgOrigGroup === "function")
      ? _ensureBgOrigGroup(bgSvgEl)
      : bgSvgEl.querySelector(":scope > g.bg-orig");
    if (orig) {
      // 用 SVG 原生 <clipPath> 套(透過 clip-path 屬性引用),比 CSS clip-path 在 <g> 上可靠
      const cp = bgSvgEl.querySelector("#bgOrigClip");
      if (clipCorners && cp) {
        while (cp.firstChild) cp.removeChild(cp.firstChild);
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", clipCorners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "));
        cp.appendChild(poly);
        orig.setAttribute("clip-path", "url(#bgOrigClip)");
      } else {
        orig.removeAttribute("clip-path");
      }
      orig.style.clipPath = "";
    } else {
      // 沒包成 bg-orig 群組(理論上不會發生):退回 CSS clip-path 套整個 bgSvg
      bgSvgEl.style.clipPath = cssClip;
    }
  }
  bg.style.transformOrigin = `${cx}px ${cy}px`;
  bg.style.transform = t;
  bg.style.clipPath = cssClip;
}

export async function renderPdfBg(pdf, n) {
  const page = await pdf.getPage(n);
  const dpr = window.devicePixelRatio || 1;
  const cssViewport = page.getViewport({ scale: state.pdfScale });
  state.bgWidth = Math.floor(cssViewport.width);
  state.bgHeight = Math.floor(cssViewport.height);

  // 移除上一頁的向量底圖(若有)
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();

  // Spinner:顯示「載入中」,讓瀏覽器有機會 paint 後再進入耗時的 sync 工作
  const sp = document.getElementById("busySpinner");
  const spMsg = sp && sp.querySelector(".msg");
  const showSpinner = (msg) => {
    if (!sp) return;
    if (spMsg) spMsg.textContent = msg || "處理中…";
    sp.classList.add("active");
  };
  const hideSpinner = () => sp && sp.classList.remove("active");
  // 在每段重活之前 yield 一拍,讓 spinner 能 paint、滑鼠保持可移動
  const yieldFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  showSpinner("載入 PDF 向量…");
  await yieldFrame();
  let usedVector = false;
  if (pdfjsLib.SVGGraphics) {
    try {
      const opList = await page.getOperatorList();
      const gfx = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
      const vSvg = await gfx.getSVG(opList, cssViewport);
      vSvg.id = "bgSvg";
      vSvg.style.position = "absolute";
      vSvg.style.left = "0";
      vSvg.style.top = "0";
      vSvg.style.width = state.bgWidth + "px";
      vSvg.style.height = state.bgHeight + "px";
      vSvg.style.pointerEvents = "none";
      vSvg.style.background = "#fff";
      // 插在 vector 描繪層之前 → 視覺位於底層
      stage.insertBefore(vSvg, svg);
      bg.style.display = "none";        // 隱藏 raster canvas
      usedVector = true;
      // 將底圖所有可能描邊的元素都套上非縮放 stroke,讓 updateBgStrokeWidth 能統一控制
      // pdf.js 常把 stroke 設在 <g> 父層而非 path 本身,所以路徑本身可能沒 stroke 屬性
      try {
        // 不自動拆分(autoSplit 在大 PDF 上太慢)
        // 使用者需要拆時可以選取後按「切成直線」按鈕手動拆
        if (spMsg) spMsg.textContent = "建立索引…";
        await yieldFrame();
        const shapes = vSvg.querySelectorAll("path, line, rect, polyline, polygon, circle, ellipse");
        const fileForBg = state.files.find(f => f.pdf === pdf);
        const sel = (fileForBg && fileForBg.selectedBgPaths) || new Set();
        const del = (fileForBg && fileForBg.deletedBgPaths) || new Set();
        // 沿父層尋找實際的 stroke 屬性
        const effStrokeOf = (el) => {
          let cur = el;
          while (cur && cur.getAttribute) {
            const v = cur.getAttribute("stroke") || (cur.style && cur.style.stroke);
            if (v && v !== "none" && v !== "") return v;
            cur = cur.parentNode;
          }
          return null;
        };
        const isWhitish = (c) => {
          if (!c) return false;
          const s = String(c).toLowerCase().trim();
          if (s === "white" || s === "#fff" || s === "#ffffff") return true;
          const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          if (m) return +m[1] >= 240 && +m[2] >= 240 && +m[3] >= 240;
          return false;
        };
        shapes.forEach((el2, idx) => {
          el2.classList.add("bg-stroke");
          el2.style.vectorEffect = "non-scaling-stroke";
          el2.dataset.bgIdx = idx;
          el2.style.cursor = "default";
          // 將白色線條改為較淺的深灰(比網格 #9aa0a6 深、但比 #444 淺),避免在白底上看不見
          const stk = effStrokeOf(el2);
          if (isWhitish(stk)) el2.style.stroke = "#777";
          if (sel.has(String(idx)) || sel.has(idx)) el2.classList.add("bg-selected");
          if (del.has(String(idx)) || del.has(idx)) el2.style.display = "none";
          attachBgPathHandlers(el2, fileForBg);
        });
        // 同步也對 group 加上 bg-stroke,以便覆蓋 group 上的 stroke-width 設定
        const groups = vSvg.querySelectorAll("g");
        for (const g of groups) g.classList.add("bg-stroke");
        updateBgStrokeWidth();
        applyBgSelectMode();
      } catch (_) { /* 無關緊要 */ }
      // 快取此頁的向量 SVG(在 try-catch 外,確保失敗會被看到):
      // pdfjs.SVGGraphics 會輸出 `svg:` 前綴(<svg:svg xmlns:svg="...">),所以 *不要* 自己注入
      // xmlns,避免破壞前綴。XMLSerializer 已能產生合法 XML。
      try {
        const fileForCache = state.files.find(f => f.pdf === pdf && f.pdfPage === n);
        if (fileForCache && vSvg) {
          let svgText = "";
          try { svgText = new XMLSerializer().serializeToString(vSvg); }
          catch (e) { svgText = vSvg.outerHTML || ""; }
          fileForCache.cachedBgSvg = svgText;
          fileForCache.cachedBgWidth = state.bgWidth;
          fileForCache.cachedBgHeight = state.bgHeight;
          console.log(`[cache:svg] ${fileForCache.name} pdfPage=${n} ${(svgText.length / 1024).toFixed(1)} KB`);
        }
      } catch (e) {
        console.error("[cache:svg] 寫快取失敗:", e);
      }
    } catch (err) {
      console.warn("PDF 向量渲染失敗,改用 raster:", err);
    }
  }

  if (!usedVector) {
    bg.style.display = "block";
    const hdViewport = page.getViewport({ scale: state.pdfScale * dpr });
    bg.width = Math.floor(hdViewport.width);
    bg.height = Math.floor(hdViewport.height);
    bg.style.width = state.bgWidth + "px";
    bg.style.height = state.bgHeight + "px";
    bgctx.setTransform(1, 0, 0, 1, 0, 0);
    await page.render({ canvasContext: bgctx, viewport: hdViewport }).promise;
    // raster 模式:把 canvas 內容快取為 dataURL
    try {
      const fileForCache = state.files.find(f => f.pdf === pdf && f.pdfPage === n);
      if (fileForCache) {
        fileForCache.cachedBgImg = bg.toDataURL("image/png");
        fileForCache.cachedBgWidth = state.bgWidth;
        fileForCache.cachedBgHeight = state.bgHeight;
        console.log(`[cache:img] ${fileForCache.name} pdfPage=${n} ${(fileForCache.cachedBgImg.length / 1024).toFixed(1)} KB`);
      }
    } catch (e) {
      console.error("[cache:img] 寫快取失敗:", e);
    }
  }

  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  fitToView();
  hideSpinner();
}

export function renderBlankBg(file) {
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();
  bg.style.display = "block";
  const dpr = window.devicePixelRatio || 1;
  state.bgWidth  = file.bgWidth  || state.bgWidth  || 1200;
  state.bgHeight = file.bgHeight || state.bgHeight || 800;
  bg.width = Math.floor(state.bgWidth * dpr);
  bg.height = Math.floor(state.bgHeight * dpr);
  bg.style.width = state.bgWidth + "px";
  bg.style.height = state.bgHeight + "px";
  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgctx.fillStyle = "#fafafa"; bgctx.fillRect(0, 0, state.bgWidth, state.bgHeight);
  fitToView();
}

export function renderImageBg(file) {
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();
  bg.style.display = "block";
  const img = file.image;
  const dpr = window.devicePixelRatio || 1;
  state.bgWidth = file.imageWidth; state.bgHeight = file.imageHeight;
  bg.width = Math.floor(state.bgWidth * dpr);
  bg.height = Math.floor(state.bgHeight * dpr);
  bg.style.width = state.bgWidth + "px";
  bg.style.height = state.bgHeight + "px";
  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgctx.clearRect(0, 0, state.bgWidth, state.bgHeight);
  bgctx.drawImage(img, 0, 0);
  // 快取為 PNG dataURL,供專案儲存使用(無需保留原始位元組)
  if (!file.cachedBgImg) {
    file.cachedBgImg = bg.toDataURL("image/png");
    file.cachedBgWidth = state.bgWidth;
    file.cachedBgHeight = state.bgHeight;
  }
  fitToView();
}

// 從快取的向量 SVG / 圖片 dataURL 重建底圖,不需 pdf.js / 原始位元組
//   bgSrc:擁有 cachedBgSvg / cachedBgImg 的檔案(可能是 sourceFile)
//   forFile:目前要顯示的檔案(若為 split / 衍生,點擊事件 handlers 仍綁到此檔)
export async function renderCachedBg(bgSrc, forFile) {
  const target = forFile || bgSrc;
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();

  state.bgWidth  = bgSrc.cachedBgWidth  || state.bgWidth  || 1200;
  state.bgHeight = bgSrc.cachedBgHeight || state.bgHeight || 800;

  if (bgSrc.cachedBgSvg) {
    let svgText = bgSrc.cachedBgSvg;
    // 修復舊版序列化 bug:`<svg xmlns="...":svg ...` → `<svg:svg ...`
    if (/^<svg\s+xmlns="[^"]*":svg\b/.test(svgText)) {
      svgText = svgText.replace(/^<svg\s+xmlns="[^"]*":svg\b/, "<svg:svg");
      console.warn("[renderCachedBg] 偵測到舊版 SVG 序列化 bug,自動修復。");
    }
    // pdf.js SVGGraphics 用 `svg:` 前綴格式輸出(<svg:svg xmlns:svg="...">),DOMParser 解析後
    // tagName 會是 "svg:svg" 而非 "svg",導致下面的 tagName 檢查失敗。
    // 把 svg: 前綴整體剝掉,正規化成預設命名空間形式,並把 xmlns:svg= 改回 xmlns=。
    if (/<svg:/.test(svgText) || /xmlns:svg=/.test(svgText)) {
      svgText = svgText
        .replace(/<svg:/g, "<")
        .replace(/<\/svg:/g, "</")
        .replace(/\bxmlns:svg=/g, "xmlns=");
      console.log("[renderCachedBg] 已剝除 svg: 前綴");
    }
    console.log(`[renderCachedBg] 來源 ${bgSrc.name}・SVG ${(svgText.length/1024).toFixed(1)} KB・前 80 字: ${svgText.slice(0, 80)}`);
    // 用 DOMParser 解析 SVG 文字 → 保證命名空間正確;再 importNode 到主文件
    let newSvgBg = null;
    try {
      const parser  = new DOMParser();
      const doc     = parser.parseFromString(svgText, "image/svg+xml");
      const perr    = doc.querySelector("parsererror");
      if (perr) throw new Error("SVG parse error: " + perr.textContent);
      newSvgBg = document.importNode(doc.documentElement, true);
    } catch (e) {
      console.warn("[renderCachedBg] DOMParser 失敗,改用 innerHTML 後備:", e);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = svgText;
      newSvgBg = wrapper.querySelector("svg");
    }
    if (newSvgBg && newSvgBg.tagName && newSvgBg.tagName.toLowerCase() === "svg") {
      newSvgBg.id = "bgSvg";
      newSvgBg.style.position = "absolute";
      newSvgBg.style.left = "0";
      newSvgBg.style.top  = "0";
      newSvgBg.style.width  = state.bgWidth  + "px";
      newSvgBg.style.height = state.bgHeight + "px";
      newSvgBg.style.pointerEvents = "none";
      newSvgBg.style.background = "#fff";
      stage.insertBefore(newSvgBg, svg);
      bg.style.display = "none";
      // 重新掛上點擊事件,並還原選取狀態
      const sel = (target.selectedBgPaths) || new Set();
      const del = (target.deletedBgPaths)  || new Set();
      const shapes = newSvgBg.querySelectorAll(".bg-stroke");
      shapes.forEach(el => {
        attachBgPathHandlers(el, target);
        const key = String(el.dataset.bgIdx);
        if (sel.has(key) || sel.has(+key)) el.classList.add("bg-selected");
        if (del.has(key) || del.has(+key)) el.style.display = "none";
      });
      updateBgStrokeWidth();
      applyBgSelectMode();
    } else {
      // SVG 解析完全失敗:退回灰底,讓使用者起碼能看到模型
      console.error("[renderCachedBg] cachedBgSvg 無法解析為 <svg>,退回空白底");
      bg.style.display = "block";
      const dpr = window.devicePixelRatio || 1;
      bg.width  = Math.floor(state.bgWidth  * dpr);
      bg.height = Math.floor(state.bgHeight * dpr);
      bg.style.width  = state.bgWidth  + "px";
      bg.style.height = state.bgHeight + "px";
      bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgctx.fillStyle = "#fafafa"; bgctx.fillRect(0, 0, state.bgWidth, state.bgHeight);
    }
  } else if (bgSrc.cachedBgImg) {
    bg.style.display = "block";
    const dpr = window.devicePixelRatio || 1;
    bg.width  = Math.floor(state.bgWidth  * dpr);
    bg.height = Math.floor(state.bgHeight * dpr);
    bg.style.width  = state.bgWidth  + "px";
    bg.style.height = state.bgHeight + "px";
    bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgctx.clearRect(0, 0, state.bgWidth, state.bgHeight);
    const img = new Image();
    img.src = bgSrc.cachedBgImg;
    await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
    bgctx.drawImage(img, 0, 0, state.bgWidth, state.bgHeight);
  }

  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  fitToView();
}
