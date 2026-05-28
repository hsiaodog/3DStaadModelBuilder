// 檢查可延伸桿件(extendable members)— 互動式 modal workflow
//
//   • 掃描所有頁面 / 當前頁,找出「端點延伸到 tolGap 內可碰到其他節點」的桿件
//     (anchor → joint 還沒既存桿件、共線同向不再延伸 等規則)
//   • 跳出對話框逐條檢視:延伸此桿 / 跳過 / 全部延伸,含縮圖預覽 + 主畫布 zoom-to-rect
//   • 完成後跑 _consolidateInPlace 收尾(合併同位節點 / 拆共線中段)
//
//   依賴 legacy.ts 的 state / DOM / pushUndo / undo / render / activatePage / etc.
//   使用 named imports → ESM live binding,避免 circular import TDZ。
// @ts-nocheck

import {
  $, state, getPage, getActiveFile,
  wrap,
  pushUndo, undo, render, refreshLists, refreshFileList,
  activatePage, applyTransform,
  jointById, displayJointId, displayMemberId,
  unbindJointFromGlobal,
  _consolidateInPlace,
  consolidateAllPagesWithConfirm,
} from "../app/integration";
import { showBusy, hideBusy, busyTick } from "../ui/busy";

// ---------- 檢查可延伸桿件:斷點偵測 ----------
// 對單一頁的每條桿件(端點 A、B),檢查是否有節點 J 落在延伸線上(段外),滿足:
//   - J 不是 A 或 B
//   - J 到 A-B 直線垂直距離 ≤ tolPerp
//   - J 在線段外(投影 t < 0 或 t > |AB|);線段內的別擔心,「整理」會拆段
//   - gap(從段端點到 J)≤ tolGap
//   - anchor → J 還沒有既存桿件
//   - **anchor 那端在延伸方向上沒有共線同向的桿件**(否則 anchor 已連到中段了,不該再跨過去延)
//   - **每側只報「離 anchor 最近」那個 target**(避免跨過中間 joint 一路延到遠處)
// 垂直桿件(|uy| > 0.95 → 偏離 Y 軸 ≤ ~18°)放寬 tolPerp / tolGap,因為:
//   - 柱子各樓層位置可能微微偏移,但仍是同一根柱
//   - 整根柱常被各樓層樓板節點切成短段,延伸距離本來就大
// 斜撐(diagonal)同樣放寬:平面圖斜撐端點常因角度微差 > 2mm 偏離柱中心,
//   gap 也常大於 50mm,沿用 horizontal 的緊容差幾乎都抓不到
export function findExtendableMembersOnPage(file, page, opts) {
  opts = opts || {};
  const tolPerp = opts.tolPerp != null ? opts.tolPerp : 2.0;
  const tolPerpVert = opts.tolPerpVert != null ? opts.tolPerpVert : 5.0;
  // 斜撐(diagonal)放寬 perp / gap:斜線端點常因校準微差距離柱子節點 > 2mm,
  // 端點到柱子的 gap 也常比正交桿件大;若還是用 horizontal 的 2/50,XZ 平面斜撐幾乎抓不到
  const tolPerpDiag = opts.tolPerpDiag != null ? opts.tolPerpDiag : 8.0;
  const tolGap = opts.tolGap != null ? opts.tolGap : 50.0;
  const tolGapVert = opts.tolGapVert != null ? opts.tolGapVert : 200.0;
  const tolGapDiag = opts.tolGapDiag != null ? opts.tolGapDiag : 200.0;
  const vertThreshold = opts.vertThreshold != null ? opts.vertThreshold : 0.95;
  if (!page || !Array.isArray(page.members) || !Array.isArray(page.joints)) return [];
  const memberKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const existingPairs = new Set();
  for (const m of page.members) existingPairs.add(memberKey(m.j1, m.j2));
  const jointById = new Map();
  for (const j of page.joints) jointById.set(j.id, j);
  // 共線阻擋:回傳 true 表示 jointId 在方向 (dux, duy) 上已經有另一條同向 / 共線的 member
  //   (jointHasCollinearMemberInDirection 的可重入版本,接收 page 參數)
  const _hasCollinearOut = (excludeMemberId, jointId, dux, duy) => {
    const aJ = jointById.get(jointId);
    if (!aJ) return false;
    for (const mm of page.members) {
      if (mm.id === excludeMemberId) continue;
      let other = null;
      if (mm.j1 === jointId) other = jointById.get(mm.j2);
      else if (mm.j2 === jointId) other = jointById.get(mm.j1);
      if (!other) continue;
      const vx = other.x - aJ.x, vy = other.y - aJ.y;
      const vlen = Math.hypot(vx, vy);
      if (vlen < 1e-3) continue;
      const cross = Math.abs(vx * duy - vy * dux);   // 共線判定:垂直距離
      if (cross > 0.5) continue;
      const dot = vx * dux + vy * duy;                // 同向判定:點積為正
      if (dot > 1e-3) return true;
    }
    return false;
  };
  // 避免重複報告同一個 (anchor, target) 對 — 來自不同方向的兩條桿件可能都能延伸到 J
  const reportedAnchorTarget = new Set();
  const results = [];
  for (const m of page.members) {
    const A = jointById.get(m.j1);
    const B = jointById.get(m.j2);
    if (!A || !B) continue;
    const dx = B.x - A.x, dy = B.y - A.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-6) continue;
    const ux = dx / segLen, uy = dy / segLen;
    const isVertical = Math.abs(uy) > vertThreshold;
    const isHorizontal = Math.abs(ux) > vertThreshold;
    const isDiagonal = !isVertical && !isHorizontal;
    const useTolPerp = isVertical ? tolPerpVert : (isDiagonal ? tolPerpDiag : tolPerp);
    const useTolGap  = isVertical ? tolGapVert  : (isDiagonal ? tolGapDiag  : tolGap);
    // 先收所有共線 + 段外 joint,依「在 A 側 / B 側」分群並依 gap 排序
    const candA = [];   // t < 0,延伸方向 = -u(離開 A)
    const candB = [];   // t > segLen,延伸方向 = +u(離開 B)
    for (const J of page.joints) {
      if (J.id === m.j1 || J.id === m.j2) continue;
      const vx = J.x - A.x, vy = J.y - A.y;
      const t = vx * ux + vy * uy;
      const px = vx - t * ux, py = vy - t * uy;
      const perp = Math.hypot(px, py);
      if (perp > useTolPerp) continue;
      if (t < 0) candA.push({ J, gap: -t, perp });
      else if (t > segLen) candB.push({ J, gap: t - segLen, perp });
    }
    candA.sort((p, q) => p.gap - q.gap);
    candB.sort((p, q) => p.gap - q.gap);
    // 兩側各「只取最近一個」+ 方向阻擋檢查
    const sides = [
      { list: candA, extendFrom: "A", anchorId: m.j1, anchorJ: A, dux: -ux, duy: -uy },
      { list: candB, extendFrom: "B", anchorId: m.j2, anchorJ: B, dux:  ux, duy:  uy },
    ];
    for (const side of sides) {
      if (!side.list.length) continue;
      const best = side.list[0];
      if (best.gap > useTolGap) continue;
      if (existingPairs.has(memberKey(side.anchorId, best.J.id))) continue;
      // 方向阻擋:anchor 已在延伸方向有共線同向桿件 → 表示 anchor 已連到中段(或更遠),不該再跨過去延
      if (_hasCollinearOut(m.id, side.anchorId, side.dux, side.duy)) continue;
      const atKey = memberKey(side.anchorId, best.J.id);
      if (reportedAnchorTarget.has(atKey)) continue;
      reportedAnchorTarget.add(atKey);
      results.push({
        fileId: file.id, fileName: file.name,
        memberId: m.id, memberJ1: m.j1, memberJ2: m.j2,
        anchorJointId: side.anchorId, targetJointId: best.J.id,
        gap: best.gap, perpDist: best.perp, extendFrom: side.extendFrom,
        isVertical, isHorizontal,
        direction: isVertical ? "vertical" : (isHorizontal ? "horizontal" : "diagonal"),
        anchorX: side.anchorJ.x, anchorY: side.anchorJ.y,
        targetX: best.J.x, targetY: best.J.y,
        memberAx: A.x, memberAy: A.y, memberBx: B.x, memberBy: B.y,
        plane: page.plane || "?", pageZ: page.z != null ? page.z : 0,
      });
    }
  }
  return results;
}

// 掃描所有檔案 × 所有 page,把候選彙整在一起
//   排序:垂直(柱)先、水平次、斜線最後;同類別內 gap 小的先(便宜的修)
export function findAllExtendableMembers(opts) {
  const all = [];
  for (const f of state.files) {
    const pages = f.pages || {};
    for (const k of Object.keys(pages)) {
      const pg = pages[k];
      if (!pg || pg._orphan) continue;
      const cands = findExtendableMembersOnPage(f, pg, opts);
      for (const c of cands) {
        c.pageIdx = +k;
        all.push(c);
      }
    }
  }
  const dirRank = { vertical: 0, horizontal: 1, diagonal: 2 };
  all.sort((a, b) => {
    const da = dirRank[a.direction] ?? 3;
    const db = dirRank[b.direction] ?? 3;
    if (da !== db) return da - db;
    return a.gap - b.gap;
  });
  return all;
}

// 縮放主畫布到某個世界座標矩形(加邊距,讓使用者能看清楚周邊)
export function _zoomMainCanvasToRect(x1, y1, x2, y2, paddingFactor) {
  const r = wrap.getBoundingClientRect();
  const pad = paddingFactor != null ? paddingFactor : 0.5;   // 邊距 = 矩形短邊的一半
  const w = Math.max(1, Math.abs(x2 - x1));
  const h = Math.max(1, Math.abs(y2 - y1));
  const padX = w * pad, padY = h * pad;
  const minSide = Math.max(20, Math.min(w + 2 * padX, h + 2 * padY));   // 太小的矩形(同點 / 短桿)放大基準
  const tw = Math.max(w + 2 * padX, minSide);
  const th = Math.max(h + 2 * padY, minSide);
  const z = Math.min(r.width / tw, r.height / th);
  state.zoom = Math.max(0.0001, Math.min(50, z));
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  state.panX = r.width / 2 - cx * state.zoom;
  state.panY = r.height / 2 - cy * state.zoom;
  applyTransform();
  render();
}

// 把檔案底圖的指定世界座標區域畫到 canvas(類似 renderFileThumb 但用傳入的 region 取代 clipRect)
//   回傳 { sc, dx, dy, dw, dh, regionX, regionY }:可用 (wx - regionX) * sc + dx 把世界座標映射到 canvas 座標
//   供延伸檢查視窗的「放大預覽」用 — 在底圖上疊桿件 / 端點 / gap dashed 線
export async function _renderFileRegion(canvas, file, region) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#0d0e10"; ctx.fillRect(0, 0, W, H);
  if (!file || !region || region.w <= 0 || region.h <= 0) return null;
  const loadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  // 路徑 1:cachedBgImg(光柵)— 用 source rect 裁切
  if (file.cachedBgImg) {
    const img = await loadImg(file.cachedBgImg);
    if (img && img.width && img.height) {
      const bgW = file.cachedBgWidth  || file.bgWidth  || img.width;
      const bgH = file.cachedBgHeight || file.bgHeight || img.height;
      let sx = region.x * img.width  / bgW;
      let sy = region.y * img.height / bgH;
      let sw = region.w * img.width  / bgW;
      let sh = region.h * img.height / bgH;
      // 邊界 clamp
      if (sx < 0) { sw += sx; sx = 0; }
      if (sy < 0) { sh += sy; sy = 0; }
      if (sx + sw > img.width)  sw = img.width  - sx;
      if (sy + sh > img.height) sh = img.height - sy;
      if (sw <= 0 || sh <= 0) return null;
      const sc = Math.min(W / region.w, H / region.h);
      const dw = region.w * sc, dh = region.h * sc;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      const invert = !file.bgImgDarkReady;
      ctx.save();
      if (invert) { try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {} }
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
      return { sc, dx, dy, dw, dh, regionX: region.x, regionY: region.y };
    }
  }
  // 路徑 2:cachedBgSvg(向量)— 改寫 viewBox 後 SVG → image
  if (file.cachedBgSvg) {
    let sized = file.cachedBgSvg;
    const vb = `${region.x} ${region.y} ${region.w} ${region.h}`;
    const aspect = region.w / region.h;
    let renderW = Math.min(1024, Math.max(W * 4, 256));
    let renderH = Math.round(renderW / aspect);
    if (renderH > 1024) { renderH = 1024; renderW = Math.round(renderH * aspect); }
    if (/<svg\b[^>]*\sviewBox=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)viewBox="[^"]*"/, `$1viewBox="${vb}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg viewBox="${vb}"`);
    }
    if (/<svg\b[^>]*\swidth=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${renderW}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg width="${renderW}"`);
    }
    if (/<svg\b[^>]*\sheight=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${renderH}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg height="${renderH}"`);
    }
    sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
      const cleaned = style
        .replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
        .replace(/;{2,}/g, ";").replace(/^;|;$/g, "").trim();
      return cleaned ? `${head} style="${cleaned}"` : head;
    });
    const blob = new Blob([sized], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      if (img && img.width && img.height) {
        const sc = Math.min(W / img.width, H / img.height);
        const dw = img.width * sc, dh = img.height * sc;
        const dx = (W - dw) / 2, dy = (H - dh) / 2;
        ctx.save();
        try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
        // SVG 透過 viewBox 把整個 region 對應到整張圖,所以 effective sc = dw / region.w
        return { sc: dw / region.w, dx, dy, dw, dh, regionX: region.x, regionY: region.y };
      }
    } finally { URL.revokeObjectURL(url); }
  }
  // 沒有可用底圖快取:畫個底色 + 檔名
  ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("(無底圖快取)", W / 2, H / 2);
  return null;
}

// 把延伸檢查的標記畫到放大預覽 canvas:桿件實線 / gap 黃虛線 / 兩端圓點 + 點 / 桿件 ID 標號
//   也把同區域內「其他 joints / members」用淺灰色畫出,方便看清楚周邊環境
export function _drawExtensionMarkers(canvas, transform, candidate, file, page) {
  if (!canvas || !transform || !candidate) return;
  const ctx = canvas.getContext("2d");
  const wxToCanvas = (wx) => transform.dx + (wx - transform.regionX) * transform.sc;
  const wyToCanvas = (wy) => transform.dy + (wy - transform.regionY) * transform.sc;
  // 區域(由 transform 推回 region;dw / sc = region.w)
  const regionX0 = transform.regionX, regionY0 = transform.regionY;
  const regionX1 = regionX0 + transform.dw / transform.sc;
  const regionY1 = regionY0 + transform.dh / transform.sc;
  const inRange = (x, y) => x >= regionX0 && x <= regionX1 && y >= regionY0 && y <= regionY1;
  ctx.save();
  // ---- 周邊環境:其他 members(亮一點的灰細線,黑底上要看得到)----
  let jointById = null;
  if (page && Array.isArray(page.members)) {
    jointById = new Map();
    for (const j of (page.joints || [])) jointById.set(j.id, j);
    ctx.strokeStyle = "rgba(200, 200, 200, 0.7)";
    ctx.lineWidth = 1.4;
    for (const m of page.members) {
      if (m.id === candidate.memberId) continue;   // 候選主桿件下面單獨亮畫
      const a = jointById.get(m.j1), b = jointById.get(m.j2);
      if (!a || !b) continue;
      if (!inRange(a.x, a.y) && !inRange(b.x, b.y)) continue;   // 兩端都在範圍外則略過
      ctx.beginPath();
      ctx.moveTo(wxToCanvas(a.x), wyToCanvas(a.y));
      ctx.lineTo(wxToCanvas(b.x), wyToCanvas(b.y));
      ctx.stroke();
    }
  }
  // ---- 候選主桿件:藍色實線(加粗對比) ----
  ctx.strokeStyle = "#4f9dff"; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(wxToCanvas(candidate.memberAx), wyToCanvas(candidate.memberAy));
  ctx.lineTo(wxToCanvas(candidate.memberBx), wyToCanvas(candidate.memberBy));
  ctx.stroke();
  // ---- gap(anchor → target):黃色虛線(加粗) ----
  ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 4]);
  ctx.beginPath();
  ctx.moveTo(wxToCanvas(candidate.anchorX), wyToCanvas(candidate.anchorY));
  ctx.lineTo(wxToCanvas(candidate.targetX), wyToCanvas(candidate.targetY));
  ctx.stroke();
  ctx.setLineDash([]);
  // ---- 其他 joints:亮一點的灰色點 + ID ----
  ctx.font = "10px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
  ctx.textBaseline = "middle";
  if (page && Array.isArray(page.joints)) {
    for (const j of page.joints) {
      if (!inRange(j.x, j.y)) continue;
      if (j.id === candidate.anchorJointId || j.id === candidate.targetJointId
          || j.id === candidate.memberJ1 || j.id === candidate.memberJ2) continue;   // 重點端點下面單獨畫
      const cx = wxToCanvas(j.x), cy = wyToCanvas(j.y);
      ctx.fillStyle = "#bbb";
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ccc";
      ctx.textAlign = "left";
      ctx.fillText(String((typeof displayJointId === "function") ? displayJointId(j) : j.id), cx + 5, cy - 8);
    }
  }
  // ---- 候選桿件的另一端(非 anchor 那端):藍色端點 + 標號(候選桿件本體的兩端之一)----
  if (page && Array.isArray(page.joints) && jointById) {
    const otherEndId = candidate.extendFrom === "A" ? candidate.memberJ2 : candidate.memberJ1;
    const oj = jointById.get(otherEndId);
    if (oj) {
      const cx = wxToCanvas(oj.x), cy = wyToCanvas(oj.y);
      ctx.fillStyle = "#4f9dff";
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
      const lbl = String((typeof displayJointId === "function") ? displayJointId(oj) : oj.id);
      const tw = ctx.measureText(lbl).width;
      const lx = cx + 7, ly = cy - 9;
      ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
      ctx.fillRect(lx - 2, ly - 7, tw + 4, 13);
      ctx.fillStyle = "#9bb6e8";
      ctx.textAlign = "left";
      ctx.fillText(lbl, lx, ly);
    }
  }
  // ---- anchor / target 標號:沿 gap 方向往「外」散開,避免兩端 ID 在小 gap 時黏在一起 ----
  //   - anchor 標號朝「遠離 target」的方向放
  //   - target 標號朝「遠離 anchor」的方向放
  //   - 兩端在 canvas 上太接近時退而用固定對角偏移
  const acx = wxToCanvas(candidate.anchorX), acy = wyToCanvas(candidate.anchorY);
  const tcx = wxToCanvas(candidate.targetX), tcy = wyToCanvas(candidate.targetY);
  const labelOffsetPx = 18;
  let aOffX, aOffY, tOffX, tOffY;
  {
    const dxc = acx - tcx, dyc = acy - tcy;
    const lenc = Math.hypot(dxc, dyc);
    if (lenc > 1) {
      // anchor 朝「遠離 target」(dxc, dyc 是 anchor - target)
      aOffX =  dxc / lenc * labelOffsetPx;
      aOffY =  dyc / lenc * labelOffsetPx;
      tOffX = -aOffX;
      tOffY = -aOffY;
    } else {
      // 兩端在像素上完全重疊 → 固定對角分散
      aOffX = -16; aOffY = -10;
      tOffX =  14; tOffY =  10;
    }
  }
  // ---- anchor 端點:綠色實心圓 + 綠色 ID(偏向遠離 target 那側)----
  {
    ctx.fillStyle = "#44dd66";
    ctx.beginPath(); ctx.arc(acx, acy, 5.5, 0, Math.PI * 2); ctx.fill();
    let lbl = String(candidate.anchorJointId);
    if (jointById) {
      const aj = jointById.get(candidate.anchorJointId);
      if (aj && typeof displayJointId === "function") lbl = String(displayJointId(aj));
    }
    // 文字加深色背景,避免跟桿件線 / 其他線疊在一起看不到
    const tw = ctx.measureText(lbl).width;
    const lx = acx + aOffX, ly = acy + aOffY;
    ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
    ctx.fillRect(lx - 2, ly - 7, tw + 4, 13);
    ctx.fillStyle = "#7ef0a0";
    ctx.textAlign = "left";
    ctx.fillText(lbl, lx, ly);
  }
  // ---- target 端點:紅色實心圓 + 白色外圈 + 紅色 ID(偏向遠離 anchor 那側)----
  {
    ctx.fillStyle = "#ff4444";
    ctx.beginPath(); ctx.arc(tcx, tcy, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(tcx, tcy, 8.5, 0, Math.PI * 2); ctx.stroke();
    let lbl = String(candidate.targetJointId);
    if (jointById) {
      const tj = jointById.get(candidate.targetJointId);
      if (tj && typeof displayJointId === "function") lbl = String(displayJointId(tj));
    }
    const tw = ctx.measureText(lbl).width;
    const lx = tcx + tOffX, ly = tcy + tOffY;
    ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
    ctx.fillRect(lx - 2, ly - 7, tw + 4, 13);
    ctx.fillStyle = "#ff8888";
    ctx.textAlign = "left";
    ctx.fillText(lbl, lx, ly);
  }
  // ---- 候選桿件 ID:畫在桿件中點(藍色)----
  {
    const mx = (candidate.memberAx + candidate.memberBx) / 2;
    const my = (candidate.memberAy + candidate.memberBy) / 2;
    const cx = wxToCanvas(mx), cy = wyToCanvas(my);
    const mLbl = (typeof displayMemberId === "function")
      ? String(displayMemberId({ id: candidate.memberId, j1: candidate.memberJ1, j2: candidate.memberJ2 }))
      : `M${candidate.memberId}`;
    // 在白底矩形上畫,避免跟桿件線重疊看不清
    ctx.font = "11px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
    const tw = ctx.measureText(mLbl).width;
    ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
    ctx.fillRect(cx + 4, cy - 6, tw + 6, 14);
    ctx.fillStyle = "#4f9dff";
    ctx.textAlign = "left";
    ctx.fillText(mLbl, cx + 7, cy);
  }
  ctx.restore();
}

// 在縮圖 canvas 上疊加目前主畫布視窗位置的黃框
//   - canvas:已被 renderFileThumb 畫過底圖的縮圖 canvas
//   - file:對應的檔案(用來算 bg 顯示範圍)
export async function _drawThumbViewportBox(canvas, file) {
  if (!canvas || !file) return;
  const ctx = canvas.getContext("2d");
  const wrapRect = wrap.getBoundingClientRect();
  // 主畫布目前的世界座標可見範圍
  const viewLeft = -state.panX / state.zoom;
  const viewTop  = -state.panY / state.zoom;
  const viewW = wrapRect.width / state.zoom;
  const viewH = wrapRect.height / state.zoom;
  // 縮圖內 bg 的 fit 範圍(對齊 renderFileThumb 的計算)
  const cr = file.clipRect;
  const bgX = cr ? cr.x : 0;
  const bgY = cr ? cr.y : 0;
  const bgW = cr ? cr.w : (file.bgWidth || state.bgWidth || 1200);
  const bgH = cr ? cr.h : (file.bgHeight || state.bgHeight || 800);
  if (bgW <= 0 || bgH <= 0) return;
  const sc = Math.min(canvas.width / bgW, canvas.height / bgH);
  const dw = bgW * sc, dh = bgH * sc;
  const dxOff = (canvas.width - dw) / 2, dyOff = (canvas.height - dh) / 2;
  const tx = dxOff + (viewLeft - bgX) * sc;
  const ty = dyOff + (viewTop  - bgY) * sc;
  const tw = viewW * sc, th = viewH * sc;
  ctx.save();
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(tx, ty, tw, th);
  ctx.restore();
}

// 對單一候選執行延伸動作 — 完全比照「選取模式・桿件兩端 / 單端延伸」(extendSelectedMembersToIntersect)
//   對「延伸到既有 joint」的處理方式:
//     1. 把原桿件 anchor 端的 joint reference 改指到 target
//     2. 若原 anchor joint 沒被其他 member 引用了(變孤立)→ 從 page.joints 移除 + 解綁 globalId
//   pushUndo 由呼叫端控制(允許單條 / 批次的 undo group 不同)
export function _applyMemberExtension(c) {
  const f = state.files.find(x => x.id === c.fileId);
  if (!f) return false;
  const pg = f.pages && f.pages[c.pageIdx];
  if (!pg || !Array.isArray(pg.members) || !Array.isArray(pg.joints)) return false;
  const m = pg.members.find(x => x.id === c.memberId);
  if (!m) return false;
  // 同位防呆:可能前一條候選已經把這支桿件動過,端點已經變了 → 偵測時的 anchor 不再對得上
  //   (e.g., 兩條共線的候選互相影響;碰到這情況直接跳過,讓使用者重跑檢查就好)
  let oldEndpointId;
  if (c.extendFrom === "A") {
    if (m.j1 !== c.anchorJointId) return false;
    if (m.j2 === c.targetJointId) return false;       // 改完會變零長,放棄
    oldEndpointId = m.j1;
    m.j1 = c.targetJointId;
  } else {
    if (m.j2 !== c.anchorJointId) return false;
    if (m.j1 === c.targetJointId) return false;
    oldEndpointId = m.j2;
    m.j2 = c.targetJointId;
  }
  // 清掉「原端點變孤立」的 joint — 對齊 extendSelectedMembersToIntersect 對既有 joint 的處理
  //   只清因延伸而換掉、且現在沒被任何 member 引用的
  const stillUsed = pg.members.some(mm => mm.j1 === oldEndpointId || mm.j2 === oldEndpointId);
  if (!stillUsed) {
    const orphan = pg.joints.find(j => j.id === oldEndpointId);
    if (orphan && orphan.globalId != null && typeof unbindJointFromGlobal === "function") {
      try { unbindJointFromGlobal(orphan); } catch (_) {}
    }
    pg.joints = pg.joints.filter(j => j.id !== oldEndpointId);
  }
  return true;
}

// 主入口:檢查所有頁面,跳出逐條檢視視窗
//   先跑「整理所有頁面」把同位節點 / 重複桿件 / 共線中段拆段先收乾淨,再做延伸檢查,
//   避免一堆假候選(因為斷點其實是中段節點切出來的)
export async function startExtendableMemberCheck() {
  if (!state.files.length) { alert("沒有可檢查的檔案"); return; }
  // 先 pushUndo 一次,涵蓋「整理 + 後續延伸動作」 — 整體可一鍵 Ctrl+Z 退回掃描前狀態
  pushUndo();
  const consolidateResult = await consolidateAllPagesWithConfirm({
    skipConfirm: true,
    skipPushUndo: true,
    titlePrefix: "整理所有頁面(延伸檢查前)",
  });
  if (consolidateResult && consolidateResult.cancelled) {
    $("hud").textContent = "延伸檢查取消(整理階段中斷)";
    return;
  }
  showBusy("掃描可延伸桿件…");
  await busyTick();
  let candidates = [];
  try { candidates = findAllExtendableMembers({}); }
  finally { hideBusy(); }
  if (!candidates.length) {
    alert(`沒有找到可延伸桿件 — 模型已經很乾淨 🎉\n(整理階段:合併 ${consolidateResult.totalMerged}・刪桿件 ${consolidateResult.totalDropped}・拆段 ${consolidateResult.totalSplit})`);
    return;
  }
  openMemberExtensionCheckDialog(candidates);
}

// 主入口(當頁):只掃描目前 active 頁,跳出逐條檢視視窗
//   先在當頁跑「整理」(_consolidateInPlace)清掉同位節點 / 重複桿件 / 中段拆段,
//   再做延伸檢查,避免假候選
export async function startExtendableMemberCheckCurrentPage() {
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  if (!af) { alert("尚未選擇檔案"); return; }
  const pg = af.pages && af.pages[state.pageIdx];
  if (!pg) { alert("當前頁不存在"); return; }
  // pushUndo + 整理(整體可一鍵 Ctrl+Z 退回掃描前狀態)
  pushUndo();
  // 整理階段 pending — _consolidateInPlace 同步阻塞,先 showBusy + busyTick 讓 spinner 先 paint
  showBusy(`整理當頁中(延伸檢查前)・${af.name}・第 ${state.pageIdx + 1} 頁…`);
  await busyTick();
  let cr = { mergedJ: 0, droppedM: 0, splitM: 0 };
  try {
    if (typeof _consolidateInPlace === "function") cr = _consolidateInPlace();
  } finally {
    hideBusy();
  }
  if ((cr.mergedJ + cr.droppedM + cr.splitM) > 0) {
    console.log(`[整理(延伸檢查前)] 當頁:合併 ${cr.mergedJ} ・ 移除桿件 ${cr.droppedM} ・ 新拆桿件 ${cr.splitM}`);
    refreshLists && refreshLists();
    render && render();
  }
  showBusy("掃描當頁可延伸桿件…");
  await busyTick();
  let cands = [];
  try { cands = findExtendableMembersOnPage(af, pg, {}); }
  finally { hideBusy(); }
  // 補齊 pageIdx + 依方向 / gap 排序,讓 dialog 行為跟全頁面版一致
  for (const c of cands) c.pageIdx = state.pageIdx;
  const dirRank = { vertical: 0, horizontal: 1, diagonal: 2 };
  cands.sort((a, b) => {
    const da = dirRank[a.direction] ?? 3;
    const db = dirRank[b.direction] ?? 3;
    if (da !== db) return da - db;
    return a.gap - b.gap;
  });
  if (!cands.length) {
    const crTag = (cr.mergedJ + cr.droppedM + cr.splitM) > 0
      ? `\n(整理階段:合併 ${cr.mergedJ}・刪桿件 ${cr.droppedM}・拆段 ${cr.splitM})`
      : "";
    alert(`當前頁(${af.name}・第 ${state.pageIdx + 1} 頁)沒有可延伸桿件 — 已經很乾淨 🎉${crTag}`);
    return;
  }
  openMemberExtensionCheckDialog(cands);
}

// 逐條檢視「視窗」:獨立 browser popup;左 = 縮圖 + 視窗黃框、右 = 候選資訊 + 動作鈕
export function openMemberExtensionCheckDialog(candidates) {
  // 過濾、處理過的記錄
  const remaining = candidates.slice();
  let currentIndex = 0;
  let extended = 0, skipped = 0;
  const initialTotal = remaining.length;
  // 動作歷史:供 Cmd+Z 回退使用 — [{ idx, action: "extend" | "skip" }]
  //   - "extend" 對應到一次 pushUndo,Cmd+Z 跑 main window 的 undo() + dialog index 回退
  //   - "skip" 沒 pushUndo → 只回退 dialog index 不跑 undo(否則會撤掉之前的 extend)
  const actionHistory = [];
  // 打開獨立的 browser popup window;被擋住 → alert 提示
  const popupFeatures = "popup=yes,width=960,height=820,scrollbars=no,resizable=yes";
  const win = window.open("", "STAAD_ExtendCheck_" + Date.now(), popupFeatures);
  if (!win) {
    alert("彈出視窗被瀏覽器擋住了。請允許這個網站開啟彈窗,再試一次。");
    return;
  }
  win.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head>
<title>檢查可延伸桿件 - STAAD</title>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: #0a0b0d; color: #ddd;
         font-family: -apple-system, system-ui, "Microsoft JhengHei", sans-serif;
         overflow: hidden; user-select: none; }
  button { padding: 5px 12px; font-size: 12px; background: #2a2c30;
           border: 1px solid #444; color: #ddd; border-radius: 3px;
           cursor: pointer; font-family: inherit; }
  button:hover { background: #33363a; }
  button.primary { background: #4f9dff; border-color: #4f9dff; color: #fff; }
  button.danger { background: #2a1a1a; border-color: #a04040; color: #ff8888; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
</style></head><body></body></html>`);
  win.document.close();
  const pdoc = win.document;
  // card = 整個 popup body 內容容器
  const card = pdoc.createElement("div");
  Object.assign(card.style, {
    background: "#1c1d20", color: "#ddd",
    width: "100%", height: "100vh",
    display: "flex", flexDirection: "column", overflow: "hidden",
  });
  pdoc.body.appendChild(card);
  // 標題列
  const titleBar = pdoc.createElement("div");
  Object.assign(titleBar.style, {
    padding: "8px 12px", borderBottom: "1px solid #333",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    background: "#222428", flexShrink: "0",
  });
  const titleText = pdoc.createElement("div");
  titleText.style.fontWeight = "700";
  titleText.style.fontSize = "13px";
  titleText.style.color = "#9bb6e8";
  titleBar.appendChild(titleText);
  const closeBtn = pdoc.createElement("button");
  closeBtn.textContent = "✕";
  Object.assign(closeBtn.style, {
    background: "transparent", border: "none", color: "#999",
    cursor: "pointer", fontSize: "16px", padding: "0 4px",
  });
  closeBtn.onmouseenter = () => closeBtn.style.color = "#fff";
  closeBtn.onmouseleave = () => closeBtn.style.color = "#999";
  closeBtn.onclick = () => closeDialog();
  titleBar.appendChild(closeBtn);
  card.appendChild(titleBar);
  // 主內容
  const body = pdoc.createElement("div");
  Object.assign(body.style, {
    display: "flex", gap: "12px", padding: "12px", flex: "1", minHeight: "0",
    overflowY: "auto",
  });
  card.appendChild(body);
  // 左:預覽區(垂直堆疊兩個 canvas:放大預覽 + 整頁縮圖小地圖)
  const previewCol = pdoc.createElement("div");
  Object.assign(previewCol.style, {
    flexShrink: "0", display: "flex", flexDirection: "column", gap: "8px",
  });
  body.appendChild(previewCol);
  // 放大預覽 — 桿件 + 斷結處放大,標示桿件實線 + gap 黃虛線 + 兩端圓點
  const zoomLabel = pdoc.createElement("div");
  zoomLabel.textContent = "放大預覽(桿件 / 斷結處)";
  Object.assign(zoomLabel.style, { fontSize: "10px", color: "#9aa0a6" });
  previewCol.appendChild(zoomLabel);
  const zoomCanvas = pdoc.createElement("canvas");
  zoomCanvas.width = 420; zoomCanvas.height = 280;
  Object.assign(zoomCanvas.style, {
    background: "#0d0e10", border: "1px solid #333", display: "block",
  });
  previewCol.appendChild(zoomCanvas);
  // 色彩 legend:用 HTML 直接寫,跟 _drawExtensionMarkers 的色碼對應
  const legend = pdoc.createElement("div");
  Object.assign(legend.style, {
    fontSize: "10px", color: "#aaa", display: "flex", flexWrap: "wrap",
    gap: "8px 12px", lineHeight: "1.4", padding: "4px 2px",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  });
  legend.innerHTML =
    `<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#44dd66;vertical-align:-1px;margin-right:3px"></span>anchor(改 j1/j2 的端)</span>` +
    `<span><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#ff4444;border:1.5px solid #fff;vertical-align:-2px;margin-right:3px"></span>target(該連到這)</span>` +
    `<span><span style="display:inline-block;width:14px;height:0;border-top:2px dashed #ffd23f;vertical-align:3px;margin-right:3px"></span>gap(要補的段)</span>` +
    `<span><span style="display:inline-block;width:14px;height:0;border-top:2px solid #4f9dff;vertical-align:3px;margin-right:3px"></span>候選桿件</span>` +
    `<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4f9dff;vertical-align:-1px;margin-right:3px"></span>桿件另一端</span>` +
    `<span><span style="display:inline-block;width:14px;height:0;border-top:1px solid rgba(160,160,160,0.6);vertical-align:3px;margin-right:3px"></span>周邊環境</span>`;
  previewCol.appendChild(legend);
  // 整頁縮圖 — 黃框標示放大區域位置
  const thumbLabel = pdoc.createElement("div");
  thumbLabel.textContent = "整頁縮圖(黃框=放大區域 · 滾輪縮放 / 拖曳平移 · 雙擊重置)";
  Object.assign(thumbLabel.style, { fontSize: "10px", color: "#9aa0a6", marginTop: "4px" });
  previewCol.appendChild(thumbLabel);
  const thumbCanvas = pdoc.createElement("canvas");
  thumbCanvas.width = 420; thumbCanvas.height = 360;
  Object.assign(thumbCanvas.style, {
    background: "#0d0e10", border: "1px solid #333", display: "block", cursor: "grab",
  });
  thumbCanvas.title = "滾輪縮放 / 拖曳平移 / 雙擊重置";
  previewCol.appendChild(thumbCanvas);
  // ---- 整頁縮圖:滾輪縮放 + 拖曳平移(對齊切面選擇視窗的 preview)----
  //   thumbState:本次顯示的 zoom / pan;切候選時若是新檔會 reset
  //   cachedThumbImg:已載入的 bg image + 來源裁切矩形(clipRect 或全頁),避免每次重畫都重新載
  const thumbState = { zoom: 1, offsetX: 0, offsetY: 0 };
  let cachedThumbImg = { fid: null, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };
  const _thumbLoadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  const drawThumbWithZoom = () => {
    const ctx = thumbCanvas.getContext("2d");
    ctx.fillStyle = "#0d0e10";
    ctx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
    const cached = cachedThumbImg;
    if (!cached || !cached.img || cached.srcW <= 0 || cached.srcH <= 0) {
      const f = state.files.find(x => x.id === (remaining[currentIndex] && remaining[currentIndex].fileId));
      ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText((f && f.name) || "—", thumbCanvas.width / 2, thumbCanvas.height / 2);
      return;
    }
    // bg image fit + zoom
    const fit = Math.min(thumbCanvas.width / cached.srcW, thumbCanvas.height / cached.srcH);
    const sc = fit * thumbState.zoom;
    const w = cached.srcW * sc, h = cached.srcH * sc;
    const x = (thumbCanvas.width  - w) / 2 + thumbState.offsetX;
    const y = (thumbCanvas.height - h) / 2 + thumbState.offsetY;
    if (cached.invert) {
      ctx.save();
      try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
      ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
    }
    // ---- 黃色虛線框:標示主畫布目前視窗在 bg 上的位置(跟著 zoom / pan 一起變換)----
    const f = state.files.find(x => x.id === (remaining[currentIndex] && remaining[currentIndex].fileId));
    if (f) {
      const wrapRect = wrap.getBoundingClientRect();
      const viewLeft = -state.panX / state.zoom;
      const viewTop  = -state.panY / state.zoom;
      const viewW = wrapRect.width / state.zoom;
      const viewH = wrapRect.height / state.zoom;
      // bg 在 cached image 內的對應範圍:用 clipRect(若有)或整頁,跟載入時計算一致
      const cr = f.clipRect;
      const bgX = cr ? cr.x : 0;
      const bgY = cr ? cr.y : 0;
      const bgW = cr ? cr.w : (f.bgWidth || state.bgWidth || 1200);
      const bgH = cr ? cr.h : (f.bgHeight || state.bgHeight || 800);
      if (bgW > 0 && bgH > 0) {
        // 把世界座標(viewLeft..+viewW, viewTop..+viewH)映射到 canvas 座標 = (x, y) 加上 (worldRel * sc)
        //   worldRel = (世界 - bgOrigin) / bgSize * srcSize(因為 cached.src* = bg 在 image 內的 sub-rect)
        const wxToCanvas = (wx) => x + ((wx - bgX) / bgW) * w;
        const wyToCanvas = (wy) => y + ((wy - bgY) / bgH) * h;
        const bx1 = wxToCanvas(viewLeft);
        const by1 = wyToCanvas(viewTop);
        const bx2 = wxToCanvas(viewLeft + viewW);
        const by2 = wyToCanvas(viewTop + viewH);
        ctx.save();
        ctx.strokeStyle = "#ffd23f";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
        ctx.restore();
      }
    }
  };
  // 載入該檔的 bg image 進 cachedThumbImg(裁切到 clipRect),只在新檔切到時跑
  const loadThumbBg = async (file) => {
    if (!file) return;
    if (cachedThumbImg.fid === file.id && cachedThumbImg.img) return;  // 已快取同檔
    cachedThumbImg = { fid: file.id, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };
    const bgW = file.cachedBgWidth  || file.bgWidth  || state.bgWidth  || 1200;
    const bgH = file.cachedBgHeight || file.bgHeight || state.bgHeight || 800;
    const clip = file.clipRect ? { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h }
                               : { x: 0, y: 0, w: bgW, h: bgH };
    if (file.cachedBgImg) {
      const img = await _thumbLoadImg(file.cachedBgImg);
      if (img && cachedThumbImg.fid === file.id) {
        // src 矩形 = clipRect 換算到 image 像素座標
        const sx = Math.max(0, clip.x * img.width  / bgW);
        const sy = Math.max(0, clip.y * img.height / bgH);
        const sw = Math.min(img.width  - sx, clip.w * img.width  / bgW);
        const sh = Math.min(img.height - sy, clip.h * img.height / bgH);
        cachedThumbImg.img = img;
        cachedThumbImg.invert = !file.bgImgDarkReady;
        cachedThumbImg.srcX = sx; cachedThumbImg.srcY = sy;
        cachedThumbImg.srcW = sw > 0 ? sw : img.width;
        cachedThumbImg.srcH = sh > 0 ? sh : img.height;
      }
    } else if (file.cachedBgSvg) {
      // 改寫 viewBox 重新渲染 SVG → image(裁切到 clip)
      let sized = file.cachedBgSvg;
      const vb = `${clip.x} ${clip.y} ${clip.w} ${clip.h}`;
      const aspect = (clip.w > 0 && clip.h > 0) ? clip.w / clip.h : 1;
      let renderW = Math.min(1024, Math.max(thumbCanvas.width * 3, 512));
      let renderH = Math.round(renderW / aspect);
      if (renderH > 1024) { renderH = 1024; renderW = Math.round(renderH * aspect); }
      const setOrAdd = (re, attr, val) => {
        if (re.test(sized)) sized = sized.replace(new RegExp(`(<svg\\b[^>]*?\\s)${attr}="[^"]*"`), `$1${attr}="${val}"`);
        else sized = sized.replace(/<svg\b/, `<svg ${attr}="${val}"`);
      };
      setOrAdd(/<svg\b[^>]*\sviewBox=/, "viewBox", vb);
      setOrAdd(/<svg\b[^>]*\swidth=/, "width", renderW);
      setOrAdd(/<svg\b[^>]*\sheight=/, "height", renderH);
      sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
        const cleaned = style.replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
          .replace(/;{2,}/g, ";").replace(/^;|;$/g, "").trim();
        return cleaned ? `${head} style="${cleaned}"` : head;
      });
      const blob = new Blob([sized], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      try {
        const img = await _thumbLoadImg(url);
        if (img && cachedThumbImg.fid === file.id) {
          cachedThumbImg.img = img;
          cachedThumbImg.invert = true;
          cachedThumbImg.srcX = 0; cachedThumbImg.srcY = 0;
          cachedThumbImg.srcW = img.width; cachedThumbImg.srcH = img.height;
        }
      } finally { URL.revokeObjectURL(url); }
    }
  };
  // ---- 滾輪縮放:以游標位置為 anchor,範圍 [0.2x, 20x](對齊切面 preview)----
  thumbCanvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (!cachedThumbImg.img) return;
    const rect = thumbCanvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * (thumbCanvas.width  / rect.width);
    const sy = (ev.clientY - rect.top)  * (thumbCanvas.height / rect.height);
    const cx = thumbCanvas.width / 2, cy = thumbCanvas.height / 2;
    const oldZoom = thumbState.zoom;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const newZoom = Math.max(0.2, Math.min(20, oldZoom * factor));
    if (newZoom === oldZoom) return;
    thumbState.offsetX = sx - cx - (newZoom / oldZoom) * (sx - cx - thumbState.offsetX);
    thumbState.offsetY = sy - cy - (newZoom / oldZoom) * (sy - cy - thumbState.offsetY);
    thumbState.zoom = newZoom;
    drawThumbWithZoom();
  }, { passive: false });
  // ---- 拖曳平移 ----
  let _thumbPanDrag = null;
  thumbCanvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (!cachedThumbImg.img) return;
    _thumbPanDrag = { startX: ev.clientX, startY: ev.clientY, startOffsetX: thumbState.offsetX, startOffsetY: thumbState.offsetY };
    thumbCanvas.style.cursor = "grabbing";
    ev.preventDefault();
  });
  const _onThumbPanMove = (ev) => {
    if (!_thumbPanDrag) return;
    const rect = thumbCanvas.getBoundingClientRect();
    const sx = thumbCanvas.width  / rect.width;
    const sy = thumbCanvas.height / rect.height;
    thumbState.offsetX = _thumbPanDrag.startOffsetX + (ev.clientX - _thumbPanDrag.startX) * sx;
    thumbState.offsetY = _thumbPanDrag.startOffsetY + (ev.clientY - _thumbPanDrag.startY) * sy;
    drawThumbWithZoom();
  };
  const _onThumbPanUp = () => {
    if (!_thumbPanDrag) return;
    _thumbPanDrag = null;
    thumbCanvas.style.cursor = cachedThumbImg.img ? "grab" : "default";
  };
  win.addEventListener("mousemove", _onThumbPanMove);
  win.addEventListener("mouseup", _onThumbPanUp);
  // ---- 雙擊:重置 zoom / pan ----
  thumbCanvas.addEventListener("dblclick", () => {
    thumbState.zoom = 1; thumbState.offsetX = 0; thumbState.offsetY = 0;
    drawThumbWithZoom();
  });
  // 右:資訊
  const info = pdoc.createElement("div");
  Object.assign(info.style, {
    flex: "1", minWidth: "0", fontSize: "12px", lineHeight: "1.7",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    overflowY: "auto",
  });
  body.appendChild(info);
  // 動作按鈕列
  const actions = pdoc.createElement("div");
  Object.assign(actions.style, {
    padding: "8px 12px", borderTop: "1px solid #333",
    display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center",
    background: "#1a1b1e", flexShrink: "0",
  });
  card.appendChild(actions);
  const mkBtn = (label, onClick, opts) => {
    const b = pdoc.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      padding: "5px 12px", fontSize: "12px",
      background: opts && opts.primary ? "#4f9dff" : "#2a2c30",
      border: "1px solid " + (opts && opts.primary ? "#4f9dff" : "#444"),
      color: opts && opts.primary ? "#fff" : "#ddd",
      borderRadius: "3px", cursor: "pointer",
    });
    if (opts && opts.danger) {
      b.style.background = "#2a1a1a";
      b.style.borderColor = "#a04040";
      b.style.color = "#ff8888";
    }
    b.onclick = onClick;
    return b;
  };
  const btnPrev = mkBtn("← 上一條", () => navigate(-1));
  const btnNext = mkBtn("下一條 →", () => navigate(1));
  const btnSkip = mkBtn("跳過", () => doSkipCurrent());
  const btnExtend = mkBtn("延伸此桿", () => doExtendCurrent(), { primary: true });
  const btnExtendAll = mkBtn("全部延伸", () => doExtendAllRemaining());
  const btnSkipAll = mkBtn("全部跳過(關閉)", () => { skipped += remaining.length - currentIndex; closeDialog(); }, { danger: true });
  actions.appendChild(btnPrev);
  actions.appendChild(btnNext);
  actions.appendChild(btnSkip);
  const sp = pdoc.createElement("div");
  sp.style.flex = "1";
  actions.appendChild(sp);
  actions.appendChild(btnExtend);
  actions.appendChild(btnExtendAll);
  actions.appendChild(btnSkipAll);
  // 主邏輯
  let onKey;
  let _closed = false;
  function closeDialog() {
    if (_closed) return;
    _closed = true;
    try { win.removeEventListener("keydown", onKey, true); } catch (_) {}
    try { win.removeEventListener("mousemove", _onThumbPanMove); } catch (_) {}
    try { win.removeEventListener("mouseup", _onThumbPanUp); } catch (_) {}
    try { if (!win.closed) win.close(); } catch (_) {}
    const handled = extended + skipped;
    $("hud").textContent = `桿件延伸檢查完成・延伸 ${extended} 條・跳過 ${skipped}・剩 ${initialTotal - handled} 條未處理`;
    refreshLists && refreshLists();
    refreshFileList && refreshFileList();
    render && render();
  }
  // 使用者直接關掉 popup window → 觸發跟 closeDialog 一樣的清理
  win.addEventListener("beforeunload", () => { closeDialog(); });
  function advance() {
    currentIndex++;
    if (currentIndex >= remaining.length) {
      closeDialog();
      return;
    }
    refresh();
  }
  function navigate(delta) {
    const next = currentIndex + delta;
    if (next < 0 || next >= remaining.length) return;
    currentIndex = next;
    refresh();
  }
  async function refresh() {
    if (currentIndex >= remaining.length) { closeDialog(); return; }
    const c = remaining[currentIndex];
    titleText.textContent = `桿件延伸檢查 ${currentIndex + 1} / ${remaining.length}・延伸 ${extended}・跳過 ${skipped}`;
    // 顯示資訊
    const dirText = c.direction === "vertical" ? "垂直(Y軸 — 柱類)"
      : c.direction === "horizontal" ? "水平(X軸 — 樑類)" : "斜線";
    info.innerHTML =
      `<div><b style="color:#9bb6e8">檔案</b>:${c.fileName} ・ ${c.plane} 平面 ・ z=${c.pageZ}</div>` +
      `<div><b style="color:#9bb6e8">桿件</b> M${c.memberId} (J${c.memberJ1} ↔ J${c.memberJ2})</div>` +
      `<div><b style="color:#9bb6e8">方向</b>:${dirText}</div>` +
      `<div><b style="color:#9bb6e8">目標節點</b> J${c.targetJointId} @ (${c.targetX.toFixed(1)}, ${c.targetY.toFixed(1)})</div>` +
      `<div><b style="color:#9bb6e8">延伸自</b>:${c.extendFrom === "A" ? "A 端" : "B 端"} (J${c.anchorJointId})</div>` +
      `<div><b style="color:#9bb6e8">Gap</b>:${c.gap.toFixed(2)} ${c.isVertical ? "(柱:容忍 ≤200)" : "(梁/斜:容忍 ≤50)"}</div>` +
      `<div><b style="color:#9bb6e8">垂直偏移</b>:${c.perpDist.toFixed(2)}</div>`;
    // 切到該檔/頁,縮放主畫布
    if (state.activeFileId !== c.fileId || state.pageIdx !== c.pageIdx) {
      try { await activatePage(c.fileId, c.pageIdx); }
      catch (e) { console.warn("[延伸檢查] activatePage 失敗", e); }
    }
    const minX = Math.min(c.memberAx, c.memberBx, c.targetX);
    const minY = Math.min(c.memberAy, c.memberBy, c.targetY);
    const maxX = Math.max(c.memberAx, c.memberBx, c.targetX);
    const maxY = Math.max(c.memberAy, c.memberBy, c.targetY);
    _zoomMainCanvasToRect(minX, minY, maxX, maxY, 0.6);
    const f = state.files.find(x => x.id === c.fileId);
    // 放大預覽 canvas:用同樣的 region(再多放邊距,讓桿件周邊環境看得到)+ 疊桿件 / gap / 端點
    if (f) {
      try {
        // 計算 region(跟主畫布同步,但保證最小尺寸避免桿件貼邊)
        const pad = 0.6;
        const w0 = Math.max(1, maxX - minX), h0 = Math.max(1, maxY - minY);
        const region = {
          x: minX - w0 * pad,
          y: minY - h0 * pad,
          w: w0 * (1 + 2 * pad),
          h: h0 * (1 + 2 * pad),
        };
        // 給垂直 / 水平 / 重疊的線一個最小視覺方框(避免 w 或 h ≈ 0 時看不到 padding)
        const minSide = Math.max(region.w, region.h) * 0.5;
        if (region.w < minSide) { region.x -= (minSide - region.w) / 2; region.w = minSide; }
        if (region.h < minSide) { region.y -= (minSide - region.h) / 2; region.h = minSide; }
        // 不畫 bg image(被放大會糊,而且區域稀疏時整片黑) — 直接從結構幾何重建
        //   黑底 + 高對比的桿件 / 節點 overlay,看起來會比帶 bg 清楚得多
        const ctx = zoomCanvas.getContext("2d");
        ctx.fillStyle = "#0d0e10";
        ctx.fillRect(0, 0, zoomCanvas.width, zoomCanvas.height);
        const W = zoomCanvas.width, H = zoomCanvas.height;
        const sc = Math.min(W / region.w, H / region.h);
        const dw = region.w * sc, dh = region.h * sc;
        const tdx = (W - dw) / 2, tdy = (H - dh) / 2;
        const transform = { sc, dx: tdx, dy: tdy, dw, dh, regionX: region.x, regionY: region.y };
        const pgForLabels = f.pages && f.pages[c.pageIdx];
        _drawExtensionMarkers(zoomCanvas, transform, c, f, pgForLabels);
      } catch (e) { console.warn("[延伸檢查] 放大預覽失敗", e); }
      // 整頁縮圖(支援滾輪縮放 + 拖曳平移)
      //   切到新檔 → 重設 zoom/pan + 重新載 bg image;同檔不同候選 → 沿用 zoom/pan + 只重畫黃框
      try {
        const isNewFile = cachedThumbImg.fid !== f.id;
        if (isNewFile) {
          thumbState.zoom = 1; thumbState.offsetX = 0; thumbState.offsetY = 0;
          await loadThumbBg(f);
        }
        drawThumbWithZoom();
      } catch (e) { console.warn("[延伸檢查] 縮圖失敗", e); }
    }
    // 按鈕狀態
    btnPrev.disabled = currentIndex === 0;
    btnNext.disabled = currentIndex >= remaining.length - 1;
    btnPrev.style.opacity = btnPrev.disabled ? "0.4" : "1";
    btnNext.style.opacity = btnNext.disabled ? "0.4" : "1";
  }
  function doExtendCurrent() {
    if (currentIndex >= remaining.length) return;
    const c = remaining[currentIndex];
    pushUndo();
    const ok = _applyMemberExtension(c);
    if (ok) {
      extended++;
      actionHistory.push({ idx: currentIndex, action: "extend" });
    }
    advance();
  }
  function doSkipCurrent() {
    if (currentIndex >= remaining.length) return;
    actionHistory.push({ idx: currentIndex, action: "skip" });
    skipped++;
    advance();
  }
  // Cmd+Z 回退:依 actionHistory 最後一筆決定行為
  //   extend → 直接呼叫主畫面的 undo() 撤回 state + dialog index 回退 + 計數修正
  //   skip   → 沒 pushUndo,只回退 dialog index 不跑 undo(否則會誤撤上一個 extend)
  //   (popup 的 keydown 不會冒泡到主畫面,因此 undo 要在這裡明確呼叫)
  function handleDialogUndo() {
    const last = actionHistory.pop();
    if (!last) {
      // 沒歷史 → 把焦點還給主畫面讓使用者用主畫面的 Cmd+Z
      try { window.focus(); if (typeof undo === "function") undo(); } catch (_) {}
      return;
    }
    if (last.action === "extend") {
      extended = Math.max(0, extended - 1);
      currentIndex = last.idx;
      try { if (typeof undo === "function") undo(); } catch (_) {}
      setTimeout(() => { try { refresh(); } catch (_) {} }, 10);
    } else {
      skipped = Math.max(0, skipped - 1);
      currentIndex = last.idx;
      refresh();
    }
  }
  function doExtendAllRemaining() {
    const todo = remaining.slice(currentIndex);
    if (!todo.length) { closeDialog(); return; }
    if (!confirm(`一次延伸剩餘 ${todo.length} 條?\nCtrl+Z 可整批還原。`)) return;
    pushUndo();
    let added = 0;
    for (const c of todo) {
      if (_applyMemberExtension(c)) added++;
    }
    extended += added;
    // 批次當作一個 undo group,清掉歷史(再按 Cmd+Z 走 global undo 一次撤掉整批)
    actionHistory.length = 0;
    closeDialog();
  }
  // 鍵盤(綁在 popup window 上)
  onKey = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+Z:由 popup 自己呼叫主畫面 undo(popup keydown 不會冒泡到 main)
    if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      handleDialogUndo();
      return;
    }
    if (mod) return;
    if (e.key === "Escape") { e.preventDefault(); closeDialog(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); navigate(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); navigate(1); }
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); doExtendCurrent(); }
    else if (e.key === "s" || e.key === "S") { e.preventDefault(); doSkipCurrent(); }
  };
  win.addEventListener("keydown", onKey, true);
  // 第一條候選
  refresh();
  try { win.focus(); } catch (_) {}
}
