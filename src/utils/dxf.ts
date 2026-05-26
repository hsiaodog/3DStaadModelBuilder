// Phase 8d — DXF parser + SVG renderer
//   把 .dxf 文字檔解析成 entity list,再渲染成 SVG 字串(viewBox 正規化、Y 軸翻轉)。
//   完全純函式,沒有 DOM / state 依賴,可直接給 worker 用。
//
//   支援:LINE / LWPOLYLINE / POLYLINE+VERTEX / CIRCLE / ARC / TEXT / MTEXT / INSERT (BLOCK)
//   不支援(會被忽略):SPLINE / ELLIPSE / HATCH / DIMENSION / IMAGE
//   產生的 SVG:用 viewBox 正規化到 [0..W, 0..H],Y 軸翻轉(DXF 為 Y-up,SVG 為 Y-down);
//   每個圖元都有 class="bg-stroke" data-bg-idx,讓現有點選/選取/比例尺等流程通用。

// 支援:LINE / LWPOLYLINE / POLYLINE+VERTEX / CIRCLE / ARC / TEXT / MTEXT / INSERT (BLOCK)
//   不支援(會被忽略):SPLINE / ELLIPSE / HATCH / DIMENSION / IMAGE
//   產生的 SVG:用 viewBox 正規化到 [0..W, 0..H],Y 軸翻轉(DXF 為 Y-up,SVG 為 Y-down);
//   每個圖元都有 class="bg-stroke" data-bg-idx,讓現有點選/選取/比例尺等流程通用
export function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; ) {
    const codeStr = (lines[i] || "").trim();
    if (codeStr === "") { i++; continue; }
    const code = parseInt(codeStr, 10);
    if (!Number.isFinite(code)) { i++; continue; }
    pairs.push([code, (lines[i + 1] !== undefined ? lines[i + 1] : "")]);
    i += 2;
  }
  const blocks = {};
  const entities = [];
  const header = {};            // HEADER vars (例:$INSUNITS = 4 表示 mm)
  const layers = {};            // TABLES → LAYER 項目:name → { name, linetype }
  const ltypes = {};            // TABLES → LTYPE 項目:name → { name, pattern: [], totalLen }
  let pendingHeaderVar = null;
  let inSection = null;
  let inTable = null;            // 進入 TABLES 後的子表名稱(LAYER / LTYPE / ...)
  let currentTableEntry = null;  // 當前 LAYER 或 LTYPE 項目
  let currentBlock = null;
  let currentEntity = null;
  let openPolyline = null;
  const flushTableEntry = () => {
    const e = currentTableEntry;
    currentTableEntry = null;
    if (!e || !e.name) return;
    if (e._kind === "LAYER") layers[e.name] = e;
    else if (e._kind === "LTYPE") ltypes[e.name] = e;
  };

  const flushEntity = () => {
    if (!currentEntity) return;
    const ent = currentEntity;
    currentEntity = null;
    if (ent._attachVertexTo) {
      ent._attachVertexTo.vertices.push({ x: ent._vx || 0, y: ent._vy || 0, bulge: ent._bulge || 0 });
      return;
    }
    if (currentBlock) currentBlock.entities.push(ent);
    else if (inSection === "ENTITIES") entities.push(ent);
  };

  for (let i = 0; i < pairs.length; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      flushEntity();
      const t = (value || "").trim();
      if (t === "SECTION") {
        if (i + 1 < pairs.length && pairs[i + 1][0] === 2) {
          inSection = (pairs[i + 1][1] || "").trim();
          i++;
        }
      } else if (t === "ENDSEC") {
        flushTableEntry();
        inSection = null;
        inTable = null;
      } else if (inSection === "TABLES" && t === "TABLE") {
        flushTableEntry();
        if (i + 1 < pairs.length && pairs[i + 1][0] === 2) {
          inTable = (pairs[i + 1][1] || "").trim();
          i++;
        }
      } else if (inSection === "TABLES" && t === "ENDTAB") {
        flushTableEntry();
        inTable = null;
      } else if (inSection === "TABLES" && t === "LAYER" && inTable === "LAYER") {
        flushTableEntry();
        currentTableEntry = { _kind: "LAYER", linetype: "CONTINUOUS" };
      } else if (inSection === "TABLES" && t === "LTYPE" && inTable === "LTYPE") {
        flushTableEntry();
        currentTableEntry = { _kind: "LTYPE", pattern: [] };
      } else if (inSection === "TABLES") {
        // TABLES 內非 LAYER / LTYPE 項目(VPORT / STYLE 等)→ 不收集,但要清掉既有 entry
        flushTableEntry();
      } else if (t === "BLOCK" && inSection === "BLOCKS") {
        currentBlock = { name: null, entities: [], originX: 0, originY: 0 };
      } else if (t === "ENDBLK") {
        if (currentBlock && currentBlock.name) blocks[currentBlock.name] = currentBlock;
        currentBlock = null;
      } else if (t === "VERTEX" && openPolyline) {
        currentEntity = { type: "VERTEX", _attachVertexTo: openPolyline };
      } else if (t === "SEQEND") {
        openPolyline = null;
      } else if (t === "POLYLINE") {
        currentEntity = { type: "POLYLINE", vertices: [], flags: 0 };
        openPolyline = currentEntity;
      } else if (t === "LWPOLYLINE") {
        currentEntity = { type: "LWPOLYLINE", vertices: [], flags: 0 };
      } else {
        currentEntity = { type: t };
      }
    } else if (currentEntity) {
      const valStr = value;
      const valNum = parseFloat(value);
      switch (code) {
        case 1: currentEntity.text = valStr; break;
        case 2:
          // INSERT: 引用的 block 名;DIMENSION: anonymous *D block 名
          if (currentEntity.type === "INSERT" || currentEntity.type === "DIMENSION") {
            currentEntity.blockName = (valStr || "").trim();
          }
          break;
        case 6: currentEntity.linetype = (valStr || "").trim(); break;
        case 8: currentEntity.layer = valStr; break;
        case 10:
          if (currentEntity.type === "LWPOLYLINE") {
            currentEntity.vertices.push({ x: valNum, y: 0, bulge: 0 });
          } else if (currentEntity.type === "VERTEX") {
            currentEntity._vx = valNum;
          } else if (currentEntity.type === "SPLINE") {
            if (!currentEntity.controlPts) currentEntity.controlPts = [];
            currentEntity.controlPts.push({ x: valNum, y: 0 });
          } else {
            currentEntity.x1 = valNum;
          }
          break;
        case 20:
          if (currentEntity.type === "LWPOLYLINE" && currentEntity.vertices.length) {
            currentEntity.vertices[currentEntity.vertices.length - 1].y = valNum;
          } else if (currentEntity.type === "VERTEX") {
            currentEntity._vy = valNum;
          } else if (currentEntity.type === "SPLINE" && currentEntity.controlPts && currentEntity.controlPts.length) {
            currentEntity.controlPts[currentEntity.controlPts.length - 1].y = valNum;
          } else {
            currentEntity.y1 = valNum;
          }
          break;
        case 11:
          if (currentEntity.type === "SPLINE") {
            if (!currentEntity.fitPts) currentEntity.fitPts = [];
            currentEntity.fitPts.push({ x: valNum, y: 0 });
          } else {
            currentEntity.x2 = valNum;   // LINE / ELLIPSE 的 major axis 端點(相對中心)
          }
          break;
        case 21:
          if (currentEntity.type === "SPLINE" && currentEntity.fitPts && currentEntity.fitPts.length) {
            currentEntity.fitPts[currentEntity.fitPts.length - 1].y = valNum;
          } else {
            currentEntity.y2 = valNum;
          }
          break;
        case 12: currentEntity.x3 = valNum; break;   // 3DFACE / SOLID 第 3 角
        case 22: currentEntity.y3 = valNum; break;
        case 13: currentEntity.x4 = valNum; break;   // 3DFACE / SOLID 第 4 角
        case 23: currentEntity.y4 = valNum; break;
        case 40:
          if (currentEntity.type === "ELLIPSE") currentEntity.ratio = valNum;
          else if (currentEntity.type === "TEXT" || currentEntity.type === "MTEXT") currentEntity.height = valNum;
          else currentEntity.r = valNum;
          break;
        case 41:
          if (currentEntity.type === "ELLIPSE") currentEntity.startParam = valNum;
          else if (currentEntity.type === "INSERT") currentEntity.scaleX = valNum;
          break;
        case 42:
          if (currentEntity.type === "ELLIPSE") currentEntity.endParam = valNum;
          else if (currentEntity.type === "INSERT") currentEntity.scaleY = valNum;
          else if (currentEntity.type === "LWPOLYLINE" && currentEntity.vertices.length) {
            currentEntity.vertices[currentEntity.vertices.length - 1].bulge = valNum;
          } else if (currentEntity.type === "VERTEX") {
            currentEntity._bulge = valNum;
          }
          break;
        case 50:
          if (currentEntity.type === "INSERT") currentEntity.rotation = valNum;
          else if (currentEntity.type === "ARC") currentEntity.startAngle = valNum;
          else if (currentEntity.type === "TEXT" || currentEntity.type === "MTEXT") currentEntity.rotation = valNum;
          break;
        case 51:
          if (currentEntity.type === "ARC") currentEntity.endAngle = valNum;
          break;
        case 70: currentEntity.flags = parseInt(value, 10) | 0; break;
      }
    } else if (currentBlock) {
      if (code === 2) currentBlock.name = (value || "").trim();
      else if (code === 10) currentBlock.originX = parseFloat(value);
      else if (code === 20) currentBlock.originY = parseFloat(value);
    } else if (inSection === "TABLES" && currentTableEntry) {
      // 表格項目(LAYER / LTYPE)的內容碼
      if (code === 2) currentTableEntry.name = (value || "").trim();
      else if (code === 6 && currentTableEntry._kind === "LAYER") {
        currentTableEntry.linetype = (value || "").trim();
      } else if (code === 49 && currentTableEntry._kind === "LTYPE") {
        currentTableEntry.pattern.push(parseFloat(value));
      } else if (code === 40 && currentTableEntry._kind === "LTYPE") {
        currentTableEntry.totalLen = parseFloat(value);
      }
    } else if (inSection === "HEADER") {
      // HEADER 變數對:code 9 → 變數名;緊接的數值 code 70/40 等是其值
      if (code === 9) {
        pendingHeaderVar = (value || "").trim();
      } else if (pendingHeaderVar != null) {
        const num = parseFloat(value);
        header[pendingHeaderVar] = Number.isFinite(num) ? num : value;
        pendingHeaderVar = null;
      }
    }
  }
  flushEntity();
  flushTableEntry();

  return { entities, blocks, header, tables: { layers, ltypes } };
}

// 計算 DXF 整體 bounding box(包含 INSERT 展開後)
export function dxfBbox(parsed) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const include = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < xmin) xmin = x; if (y < ymin) ymin = y;
    if (x > xmax) xmax = x; if (y > ymax) ymax = y;
  };
  function scan(ents, tx, ty, sx, sy, rot, depth) {
    if (depth > 8) return;   // 防止 BLOCK 互相 INSERT 造成無限遞迴
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const T = (x, y) => {
      const xs = (x || 0) * sx, ys = (y || 0) * sy;
      return { x: tx + xs * cosR - ys * sinR, y: ty + xs * sinR + ys * cosR };
    };
    for (const e of ents) {
      if (e.type === "LINE") {
        const a = T(e.x1, e.y1), b = T(e.x2, e.y2);
        include(a.x, a.y); include(b.x, b.y);
      } else if (e.type === "LWPOLYLINE" || e.type === "POLYLINE") {
        for (const v of (e.vertices || [])) { const p = T(v.x, v.y); include(p.x, p.y); }
      } else if (e.type === "CIRCLE" || e.type === "ARC") {
        const c = T(e.x1, e.y1), r = (e.r || 0) * Math.abs(sx);
        include(c.x - r, c.y - r); include(c.x + r, c.y + r);
      } else if (e.type === "TEXT" || e.type === "MTEXT") {
        const c = T(e.x1, e.y1); include(c.x, c.y);
      } else if (e.type === "ELLIPSE") {
        const c = T(e.x1, e.y1);
        const r = Math.hypot(e.x2 || 0, e.y2 || 0) * Math.abs(sx);
        include(c.x - r, c.y - r); include(c.x + r, c.y + r);
      } else if (e.type === "SPLINE") {
        const pts = (e.fitPts && e.fitPts.length) ? e.fitPts : (e.controlPts || []);
        for (const v of pts) { const p = T(v.x, v.y); include(p.x, p.y); }
      } else if (e.type === "POINT") {
        const c = T(e.x1 || 0, e.y1 || 0); include(c.x, c.y);
      } else if (e.type === "3DFACE" || e.type === "SOLID") {
        for (const k of [1, 2, 3, 4]) {
          const x = e["x" + k], y = e["y" + k];
          if (x != null) { const p = T(x, y); include(p.x, p.y); }
        }
      } else if (e.type === "DIMENSION" && e.blockName) {
        const blk = parsed.blocks[e.blockName];
        if (blk) scan(blk.entities, tx, ty, sx, sy, rot, depth + 1);
      } else if (e.type === "INSERT") {
        const blk = parsed.blocks[e.blockName]; if (!blk) continue;
        const ip = T(e.x1 || 0, e.y1 || 0);
        const isx = (e.scaleX || 1), isy = (e.scaleY || 1);
        const irot = (e.rotation || 0) * Math.PI / 180;
        scan(blk.entities, ip.x - blk.originX * sx * isx, ip.y - blk.originY * sy * isy,
          sx * isx, sy * isy, rot + irot, depth + 1);
      }
    }
  }
  scan(parsed.entities, 0, 0, 1, 1, 0, 0);
  if (!Number.isFinite(xmin)) return { xmin: 0, ymin: 0, xmax: 100, ymax: 100 };
  return { xmin, ymin, xmax, ymax };
}

export function dxfToSvg(parsed) {
  const bb = dxfBbox(parsed);
  const w = Math.max(1, bb.xmax - bb.xmin);
  const h = Math.max(1, bb.ymax - bb.ymin);
  // DXF 座標 → SVG 座標(平移到 0,0 為左上,Y 翻轉)
  const SX = (x) => (x - bb.xmin);
  const SY = (y) => (bb.ymax - y);

  const out = [];
  let bgIdx = 0;
  const esc = (s) => String(s == null ? "" : s).replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&apos;"}[c]));

  // DXF 線型 → SVG stroke-dasharray(配合 vector-effect="non-scaling-stroke",數值單位 = 螢幕 px)
  // 內建名稱 fallback;優先用 LTYPE 表的真實 pattern。
  const DASH_PATTERNS = {
    DASHED: "8 4", HIDDEN: "6 4", CENTER: "12 4 4 4", DASHDOT: "8 4 2 4",
    DOT: "2 4", BORDER: "8 4 4 4 4", DIVIDE: "8 4 4 4", PHANTOM: "12 4 4 4 4 4",
    DASHED2: "4 2", HIDDEN2: "3 2", CENTER2: "6 2 2 2", DASHDOTX2: "16 8 4 8",
  };
  // 把 DXF LTYPE pattern(正 = 線、負 = 空、0 = 點)轉成 SVG stroke-dasharray(全正,單位 = px)
  // 保留比例,scale 到目標總長 ≈ 24 px,確保螢幕上看得到
  function ltypePatternToDasharray(pattern) {
    if (!pattern || !pattern.length) return null;
    let total = 0;
    for (const v of pattern) total += Math.abs(v);
    if (total < 1e-9) return null;
    const targetTotal = 24;
    const scale = targetTotal / total;
    const out = [];
    for (const v of pattern) {
      // 0 = dot → 給很短的長度;abs 後乘 scale
      out.push(Math.max(0.2, Math.abs(v) * scale));
    }
    // 確保偶數元素(dash, gap, dash, gap...)
    if (out.length % 2 === 1) out.push(out[out.length - 1]);
    return out.map(n => n.toFixed(2)).join(" ");
  }
  function isContinuousName(u) {
    return !u || u === "CONTINUOUS" || u === "BYLAYER" || u === "BYBLOCK" || u === "0";
  }
  // 從 entity 解析最終線型名稱(處理 BYLAYER 繼承),回傳 SVG stroke-dasharray 字串或 null
  function dashFor(e) {
    if (!e) return null;
    let lt = (e.linetype || "").trim();
    let u = lt.toUpperCase();
    // BYLAYER / 空 → 從 layer 表查
    if (isContinuousName(u)) {
      const layer = parsed.tables && parsed.tables.layers && parsed.tables.layers[(e.layer || "").trim()];
      if (layer && layer.linetype) {
        lt = layer.linetype.trim();
        u = lt.toUpperCase();
      }
    }
    if (isContinuousName(u)) return null;
    // 優先查 LTYPE 表 — 有真實 pattern 最準
    const lty = parsed.tables && parsed.tables.ltypes && parsed.tables.ltypes[lt];
    if (lty && lty.pattern && lty.pattern.length) {
      const da = ltypePatternToDasharray(lty.pattern);
      if (da) return da;
    }
    // fallback:用內建名稱表
    if (DASH_PATTERNS[u]) return DASH_PATTERNS[u];
    for (const k of Object.keys(DASH_PATTERNS)) {
      if (u.startsWith(k)) return DASH_PATTERNS[k];
    }
    return "6 4";
  }
  function dashAttr(e) {
    const d = dashFor(e);
    return d ? ` stroke-dasharray="${d}"` : "";
  }

  function emitLine(p1, p2, e) {
    out.push(`<line class="bg-stroke" data-bg-idx="${bgIdx++}" x1="${SX(p1.x).toFixed(3)}" y1="${SY(p1.y).toFixed(3)}" x2="${SX(p2.x).toFixed(3)}" y2="${SY(p2.y).toFixed(3)}" stroke="#000" fill="none" vector-effect="non-scaling-stroke"${dashAttr(e)}/>`);
  }
  function emitPolyline(pts, closed, e) {
    const ptsStr = pts.map(p => `${SX(p.x).toFixed(3)},${SY(p.y).toFixed(3)}`).join(" ");
    const tag = closed ? "polygon" : "polyline";
    out.push(`<${tag} class="bg-stroke" data-bg-idx="${bgIdx++}" points="${ptsStr}" stroke="#000" fill="none" vector-effect="non-scaling-stroke"${dashAttr(e)}/>`);
  }
  function emitCircle(c, r, e) {
    out.push(`<circle class="bg-stroke" data-bg-idx="${bgIdx++}" cx="${SX(c.x).toFixed(3)}" cy="${SY(c.y).toFixed(3)}" r="${r.toFixed(3)}" stroke="#000" fill="none" vector-effect="non-scaling-stroke"${dashAttr(e)}/>`);
  }
  function emitEllipse(c, rmaj, rmin, rotDeg, e) {
    const cx = SX(c.x).toFixed(3), cy = SY(c.y).toFixed(3);
    // SY 翻轉 Y 軸 → 旋轉角度也要反號
    const transform = rotDeg ? ` transform="rotate(${(-rotDeg).toFixed(3)} ${cx} ${cy})"` : "";
    out.push(`<ellipse class="bg-stroke" data-bg-idx="${bgIdx++}" cx="${cx}" cy="${cy}" rx="${Math.abs(rmaj).toFixed(3)}" ry="${Math.abs(rmin).toFixed(3)}" stroke="#000" fill="none" vector-effect="non-scaling-stroke"${dashAttr(e)}${transform}/>`);
  }
  function emitArc(c, r, a1Deg, a2Deg, e) {
    const sa = a1Deg * Math.PI / 180, ea = a2Deg * Math.PI / 180;
    const sxv = c.x + r * Math.cos(sa), syv = c.y + r * Math.sin(sa);
    const exv = c.x + r * Math.cos(ea), eyv = c.y + r * Math.sin(ea);
    let span = a2Deg - a1Deg; while (span < 0) span += 360; while (span > 360) span -= 360;
    const large = span > 180 ? 1 : 0;
    // Y 翻轉後 CCW 變 CW → sweep = 0
    out.push(`<path class="bg-stroke" data-bg-idx="${bgIdx++}" d="M ${SX(sxv).toFixed(3)} ${SY(syv).toFixed(3)} A ${r.toFixed(3)} ${r.toFixed(3)} 0 ${large} 0 ${SX(exv).toFixed(3)} ${SY(eyv).toFixed(3)}" stroke="#000" fill="none" vector-effect="non-scaling-stroke"${dashAttr(e)}/>`);
  }
  // 把 DXF MTEXT 控制碼 / TEXT 古早碼剝乾淨,只留可讀文字
  //   \A0; \A1; \A2;   對齊
  //   \H2.5; \H1.0x;   字高
  //   \W0.7;           字寬
  //   \Q15;            斜體
  //   \fArial|b0|i0|c0|p34;   字型
  //   \C3;             顏色
  //   \T1.5;           字距
  //   \L \l \O \o \K \k 各種樣式 toggle
  //   \pxq...;         段落
  //   \P               換行
  //   \~               不換行空白
  //   { ... }          群組
  //   %%U %%O          底線/上劃線
  //   %%P              ±    %%D  °    %%C  ⌀    %%C   直徑符
  //   %%數字           特殊字符碼(如 %%176 = °)
  function cleanDxfText(s) {
    if (s == null) return "";
    let t = String(s);
    // 反斜線 + 字母 + 可選參數 + 分號(吃掉完整控制段)
    t = t.replace(/\\[A-Za-z][^\\;{}]*;?/g, (m) => {
      // 保留換行 \P,其他丟掉
      if (/^\\P$/i.test(m) || /^\\P;$/i.test(m)) return "\n";
      return "";
    });
    // 特殊字元:%%數字 → 只能略過(SVG fontfaces 對應不一定有)
    t = t.replace(/%%\d+/g, "");
    // %%U / %%O / %%K — toggle codes,丟
    t = t.replace(/%%[uok]/gi, "");
    // %%P → ±,%%D → °,%%C → Ø
    t = t.replace(/%%P/gi, "±").replace(/%%D/gi, "°").replace(/%%C/gi, "Ø");
    // 群組括號
    t = t.replace(/[{}]/g, "");
    // \~  → 空白
    t = t.replace(/\\~/g, " ");
    // 雙反斜線 → 單反斜線
    t = t.replace(/\\\\/g, "\\");
    return t.trim();
  }
  function emitText(c, str, height, rotDeg) {
    const text = cleanDxfText(str);
    if (!text) return;
    const fs = Math.max(1, (height || 0) || 12);
    const tx = SX(c.x).toFixed(3), ty = SY(c.y).toFixed(3);
    let transform = "";
    if (rotDeg) transform = ` transform="rotate(${(-rotDeg).toFixed(3)} ${tx} ${ty})"`;
    // 多行 → 每行一個 tspan(\n 來自 \P 控制碼)
    if (text.indexOf("\n") >= 0) {
      const lines = text.split("\n");
      const tspans = lines.map((ln, i) =>
        `<tspan x="${tx}" dy="${i === 0 ? 0 : fs * 1.15}">${esc(ln)}</tspan>`
      ).join("");
      out.push(`<text class="bg-stroke" data-bg-idx="${bgIdx++}" x="${tx}" y="${ty}" font-size="${fs.toFixed(2)}" font-family="Arial, Helvetica, sans-serif" fill="#000" stroke="none"${transform}>${tspans}</text>`);
    } else {
      out.push(`<text class="bg-stroke" data-bg-idx="${bgIdx++}" x="${tx}" y="${ty}" font-size="${fs.toFixed(2)}" font-family="Arial, Helvetica, sans-serif" fill="#000" stroke="none"${transform}>${esc(text)}</text>`);
    }
  }

  function process(ents, tx, ty, sx, sy, rot, depth) {
    if (depth > 8) return;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const T = (x, y) => {
      const xs = (x || 0) * sx, ys = (y || 0) * sy;
      return { x: tx + xs * cosR - ys * sinR, y: ty + xs * sinR + ys * cosR };
    };
    for (const e of ents) {
      if (e.type === "LINE") {
        emitLine(T(e.x1, e.y1), T(e.x2, e.y2), e);
      } else if ((e.type === "LWPOLYLINE" || e.type === "POLYLINE") && e.vertices && e.vertices.length >= 2) {
        const pts = e.vertices.map(v => T(v.x, v.y));
        emitPolyline(pts, (e.flags & 1) === 1, e);
      } else if (e.type === "CIRCLE") {
        emitCircle(T(e.x1, e.y1), Math.abs((e.r || 0) * sx), e);
      } else if (e.type === "ARC") {
        // 旋轉影響起始/結束角度;DXF 角度為度
        emitArc(T(e.x1, e.y1), Math.abs((e.r || 0) * sx),
                (e.startAngle || 0) + rot * 180 / Math.PI,
                (e.endAngle   || 0) + rot * 180 / Math.PI, e);
      } else if (e.type === "TEXT" || e.type === "MTEXT") {
        emitText(T(e.x1, e.y1), e.text, (e.height || 0) * Math.abs(sx),
                 (e.rotation || 0) + rot * 180 / Math.PI);
      } else if (e.type === "ELLIPSE") {
        // ELLIPSE:中心 + major axis 端點(相對中心)+ minor/major ratio
        const c = T(e.x1, e.y1);
        const mx = (e.x2 || 0), my = (e.y2 || 0);
        const ratio = (e.ratio != null) ? e.ratio : 1;
        // major axis 長度(經過比例縮放)
        const rmaj = Math.hypot(mx, my) * Math.abs(sx);
        const rmin = rmaj * ratio;
        // major axis 角度;rot 是父層轉動
        const angRad = Math.atan2(my, mx) + rot;
        emitEllipse(c, rmaj, rmin, angRad * 180 / Math.PI, e);
      } else if (e.type === "SPLINE") {
        // SPLINE:用 fit points 優先(實際曲線會通過這些點),否則 control points
        const pts = (e.fitPts && e.fitPts.length >= 2) ? e.fitPts
                  : ((e.controlPts && e.controlPts.length >= 2) ? e.controlPts : null);
        if (pts) emitPolyline(pts.map(p => T(p.x, p.y)), false, e);
      } else if (e.type === "POINT") {
        // POINT 輸出半徑 1 的小圓
        emitCircle(T(e.x1 || 0, e.y1 || 0), 1, e);
      } else if (e.type === "3DFACE" || e.type === "SOLID") {
        // 4 角(SOLID 經常 x3==x4 表三角)
        const corners = [];
        if (e.x1 != null) corners.push(T(e.x1, e.y1));
        if (e.x2 != null) corners.push(T(e.x2, e.y2));
        if (e.x3 != null) corners.push(T(e.x3, e.y3));
        if (e.x4 != null && (e.x4 !== e.x3 || e.y4 !== e.y3)) corners.push(T(e.x4, e.y4));
        if (corners.length >= 3) emitPolyline(corners, true, e);
      } else if (e.type === "DIMENSION" && e.blockName) {
        // DIMENSION 通常引用一個 *D{N} 匿名 block,內含完整尺寸幾何(箭頭、文字、線等)
        // block 內容是絕對世界座標,跟 INSERT 不同(INSERT 是相對 block 原點)
        const blk = parsed.blocks[e.blockName];
        if (blk) process(blk.entities, tx, ty, sx, sy, rot, depth + 1);
      } else if (e.type === "LEADER") {
        // LEADER:折線(我們的 parser 沒抓 vertex array,但若 fit/control 已有就用)
        if (e.vertices && e.vertices.length >= 2) {
          emitPolyline(e.vertices.map(v => T(v.x, v.y)), false, e);
        }
      } else if (e.type === "INSERT") {
        const blk = parsed.blocks[e.blockName]; if (!blk) continue;
        const ip = T(e.x1 || 0, e.y1 || 0);
        const isx = (e.scaleX || 1), isy = (e.scaleY || 1);
        const irot = (e.rotation || 0) * Math.PI / 180;
        process(blk.entities, ip.x - blk.originX * sx * isx, ip.y - blk.originY * sy * isy,
                sx * isx, sy * isy, rot + irot, depth + 1);
      }
    }
  }
  process(parsed.entities, 0, 0, 1, 1, 0, 0);

  // 用整數寬高 + viewBox 從 0 開始
  const widthPx = Math.ceil(w);
  const heightPx = Math.ceil(h);
  const svgText =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" ` +
    `viewBox="0 0 ${widthPx} ${heightPx}" style="background:#fff">${out.join("")}</svg>`;
  return { svg: svgText, width: widthPx, height: heightPx, entityCount: bgIdx };
}

