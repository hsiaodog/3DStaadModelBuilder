// @ts-nocheck
// Phase 8f — .xlsx 匯出(無外部 lib;簡易 OOXML + STORE-method ZIP)
//   三個大區塊參考 model_NEW.xlsx:
//     區塊 1 (col A-D): JOINT COORDINATES  — 全部節點(id, X, Y, Z)
//     區塊 2 (col F-H): MEMBER INCIDENCES  — 全部桿件(id, j1, j2)
//     區塊 3 (col J-K): MEMBER PROPERTIES  — 有材料的桿件(id, material)
//
//   依賴(全部已 export):
//     • state / $          — legacy.ts
//     • buildModel / showBuildModelCollisionsIfAny — core/buildModel
//     • buildExportContext — export/shared(rank / brace / matObj 等共用脈絡)
//     • unitToMeter / meterToTarget — utils/units
//     • _xlsxCell          — utils/ooxml(OOXML cell helper)

import { state, $ } from "../legacy";
import { buildModel, showBuildModelCollisionsIfAny } from "../core/buildModel";
import { buildExportContext } from "./shared";
import { unitToMeter, meterToTarget } from "../utils/units";
import { xlsxCell as _xlsxCell } from "../utils/ooxml";
import { getXlsxSettings, cssHexToArgb } from "./xlsxSettings";

// ============================================================================
// .xlsx 匯出(無外部 lib;簡易 OOXML + STORE-method ZIP)
// 三個區塊參考 model_NEW.xlsx:
//   區塊 1 (col A-D):    JOINT COORDINATES — 全部節點(id, X, Y, Z)
//   區塊 2 (col F-H):    MEMBER INCIDENCES — 全部桿件(id, j1, j2)
//   區塊 3 (col J-K):    MEMBER PROPERTIES — 有材料的桿件(id, material)
// 三個區塊在同一個工作表上並排,讓使用者可一眼看到模型完整結構。
// ============================================================================

// CRC32 (table-based) — ZIP 中央目錄與本地檔案頭都需要
const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function _crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function _strBytes(s) { return new TextEncoder().encode(s); }
function _u16(v) { return new Uint8Array([v & 0xff, (v >> 8) & 0xff]); }
function _u32(v) { return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]); }
function _concat(arrs) {
  let total = 0; for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let pos = 0; for (const a of arrs) { out.set(a, pos); pos += a.length; }
  return out;
}
// 建立 STORE-method ZIP(無壓縮 = Excel 接受;檔案會比 DEFLATE 大,但實作極簡)
function _buildZip(files) {
  // files: [{ name, data: Uint8Array }]
  const parts = [];
  const dir = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  for (const f of files) {
    const nameBytes = _strBytes(f.name);
    const crc = _crc32(f.data);
    const localHdr = _concat([
      _u32(0x04034b50),   // signature
      _u16(20),           // version needed
      _u16(0),            // flags
      _u16(0),            // STORE
      _u16(dosTime), _u16(dosDate),
      _u32(crc),
      _u32(f.data.length),         // compressed size = uncompressed
      _u32(f.data.length),
      _u16(nameBytes.length),
      _u16(0),            // extra
      nameBytes,
    ]);
    parts.push(localHdr, f.data);
    const dirEntry = _concat([
      _u32(0x02014b50),   // central dir signature
      _u16(20),           // version made by
      _u16(20),           // version needed
      _u16(0),            // flags
      _u16(0),            // STORE
      _u16(dosTime), _u16(dosDate),
      _u32(crc),
      _u32(f.data.length),
      _u32(f.data.length),
      _u16(nameBytes.length),
      _u16(0), _u16(0),   // extra, comment len
      _u16(0), _u16(0),   // disk, internal attrs
      _u32(0),            // external attrs
      _u32(offset),
      nameBytes,
    ]);
    dir.push(dirEntry);
    offset += localHdr.length + f.data.length;
  }
  let dirSize = 0;
  for (const d of dir) dirSize += d.length;
  const eocd = _concat([
    _u32(0x06054b50),
    _u16(0), _u16(0),
    _u16(files.length), _u16(files.length),
    _u32(dirSize),
    _u32(offset),
    _u16(0),
  ]);
  return _concat([...parts, ...dir, eocd]);
}

// _xlsxCellRef / _xmlEsc / _xlsxCell 移到 src/utils/ooxml.ts(Phase 2)

// 主匯出函式:依目前模型聚合 → 組 sheet1.xml → 包成 .xlsx ZIP 下載
export function exportXlsxFile() {
  const _xs = getXlsxSettings();   // 字型 / 字級 / 區塊填色 / 分隔欄寬 / 檔名樣板 / sheet 名
  // 用 buildModel() 把所有檔案 / 頁面聚合成單一 3D 模型(同 .std 匯出)
  let model;
  try { model = buildModel(); }
  catch (e) { alert("匯出 .xlsx 失敗:" + (e && e.message ? e.message : e)); return; }
  const joints  = model.joints  || [];
  const members = model.members || [];
  // 單位換算:跟 .std 匯出同邏輯
  const tgt = ($("exportUnit") && $("exportUnit").value) || "mmb";
  const kFromCalib = unitToMeter(state.unitName);
  const kToTarget  = meterToTarget(tgt);
  const k = kFromCalib * kToTarget;
  // joint id → material lookup(同 globalMemberId 共用材料)
  const jById = new Map(joints.map(j => [j.id, j]));
  // 區塊 1  — JOINT             (col A-D)   ─ 全部節點(anchor + brace),
  //                                          依 sub-header 分:`* XX nn / * ZZ nn` 為 anchor 柱線,
  //                                          `* BRACE YZ` / `* BRACE XY` / `* BRACE XZ` 為對應平面斜撐節點
  // MEMBER 區塊改成每塊 11 欄寬:一列最多 3 條桿件,以 `;` 分隔(3*3 + 2 = 11);
  // col 9 (J) 留空,col 10 (K) = JOINT 類 vs MEMBER 類 黃色分隔欄
  // 區塊 5  — MEMBER Y-axis     (col L-V,  11-21) ─ Y 軸向桿件(柱)
  // 區塊 6  — MEMBER XZ         (col X-AH, 23-33) ─ X + Z 軸樑(頁面 → X/Z-axis 兩層分群)
  // 區塊 7  — MEMBER BRACE XZ   (col AJ-AT, 35-45) ─ XZ 平面斜撐(樓板斜撐),依頁面分小區
  // 區塊 8  — MEMBER BRACE XY   (col AW-BG, 48-58) ─ XY 平面斜撐(BRACE 之間 2 條空白)
  // 區塊 9  — MEMBER BRACE YZ   (col BJ-BT, 61-71) ─ YZ 平面斜撐
  // 黃色分隔欄(col BV, 0-based 73)= MEMBER 類 vs MATERIAL 類
  // 區塊 10 — MEMBER PROPERTIES (col BW-CD, 74-81) ─ 只列有材料的(8 欄寬)
  //
  // 標題樣式:每個 section title 拆成多格 — 首格放 `*`,標題字串用空白拆,各字 / 詞獨立一格;
  //          (例:"MEMBER BRACE XZ" → `*` | `MEMBER` | `BRACE` | `XZ`,佔 4 格)
  //          row 2 首欄(原 "ID")改為 "*" 標記,其他欄維持 X/Y/Z 或 J1/J2 / Material
  //          Sub-header(`* XX nn` / `* <pageName>` / `* X-axis` 等)同樣拆格輸出
  // header 列:row 0 寫 section title;row 1 寫欄位名稱;row 2 起寫資料
  // styleId 對照(對應後段組出來的 cellXfs):
  //   1 = 區塊標題(粗體,深底)
  //   2 = 欄位標題(粗體)
  //   3 = comment 列(* XX / * ZZ)— 暖色底
  //   4 = 節點 ID 欄位 — 淡藍底
  //   5 = 桿件 ID 欄位 — 淡綠底
  const cells = [];
  const push = (rowIdx, colIdx, val, styleId) => {
    const c = _xlsxCell(rowIdx, colIdx, val, styleId);
    if (c) cells.push({ r: rowIdx, c: colIdx, s: c });
  };
  // Section titles — 每個 title 拆成多格:首格放 `*`,接著用空白拆字、每個字 / 詞獨立一格
  //   例:"BRACE XY"        → baseCol=*, +1=BRACE, +2=XY
  //       "MEMBER BRACE XZ" → baseCol=*, +1=MEMBER, +2=BRACE, +3=XZ
  const _pushTitle = (baseCol, title) => {
    push(0, baseCol, "*", 1);
    const words = String(title).split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      push(0, baseCol + 1 + i, words[i], 1);
    }
  };
  // Sub-header(`* XX nn` / `* ZZ nn` / `* <pageName>` / `* PLANE XY` / 純 `*` 等)拆格輸出:
  //   用空白分,每段獨立一格,全部套 styleId 3(comment 列暖色底)
  //   例:"* XX 01"      → `*` | `XX` | `01`
  //       "* PLANE XY"   → `*` | `PLANE` | `XY`
  //       "* 倉儲鋼構#1" → `*` | `倉儲鋼構#1`(無內部空白 → 1 + 1 = 2 格)
  //       "*"            → `*`(單格)
  const _pushSubHeader = (rowIdx, baseCol, label, styleId) => {
    const sId = (styleId != null) ? styleId : 3;
    const parts = String(label).split(/\s+/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      push(rowIdx, baseCol + i, parts[i], sId);
    }
  };
  _pushTitle(0,  "JOINT");
  _pushTitle(5,  "JOINT");   // JOINT 拆成兩大列區塊,左右各 half 的 (XX, ZZ) 柱線
  // MEMBER 區塊每塊寬 11 欄:3 個桿件 × (ID/J1/J2) + 2 個 `;` 分隔 → 一列最多裝 3 條桿件
  //   col 9 (J) 留空,col 10 (K) = 黃色分隔欄,MEMBER 從 col 11 (L) 起。
  _pushTitle(11, "MEMBER Y-axis");        // 11-21
  _pushTitle(23, "MEMBER XZ");            // 23-33(+1 gap)
  _pushTitle(35, "MEMBER BRACE XZ");      // 35-45(+1 gap)
  _pushTitle(48, "MEMBER BRACE XY");      // 48-58(+2 gap,BRACE 之間 2 條空白)
  _pushTitle(61, "MEMBER BRACE YZ");      // 61-71
  _pushTitle(74, "MEMBER PROPERTIES");    // 74-81(+1 extra + 黃色分隔 col 73)
  // Column headers — 首欄(ID 欄)用 `*` 取代「ID」;其他欄維持
  push(1, 0,  "*", 2);   push(1, 1,  "X", 2);  push(1, 2,  "Y", 2);  push(1, 3,  "Z", 2);
  push(1, 5,  "*", 2);   push(1, 6,  "X", 2);  push(1, 7,  "Y", 2);  push(1, 8,  "Z", 2);   // 第 2 大列區塊的 column header
  // MEMBER 區塊 row 2:首組 `* J1 J2` 標頭(剩餘的「; ID J1 J2; ID J1 J2」標頭留空,因為視覺已經由 ; 分明)
  push(1, 11, "*", 2);   push(1, 12, "J1", 2); push(1, 13, "J2", 2);
  push(1, 23, "*", 2);   push(1, 24, "J1", 2); push(1, 25, "J2", 2);
  push(1, 35, "*", 2);   push(1, 36, "J1", 2); push(1, 37, "J2", 2);
  push(1, 48, "*", 2);   push(1, 49, "J1", 2); push(1, 50, "J2", 2);
  push(1, 61, "*", 2);   push(1, 62, "J1", 2); push(1, 63, "J2", 2);
  push(1, 74, "*", 2);   push(1, 80, "Table", 2);  push(1, 81, "Material", 2);
  // SUPPORTS 區塊 header(col 92 起,跟 Material 同樣 6 個 ID slot + Type 欄)
  push(1, 92, "*", 2);   push(1, 99, "Type", 2);
  // ── Joint 區塊:按 (XX, ZZ) rank 分區。共用 helper 改由 buildExportContext() 一次建好(Phase 4 dedup)
  const _ctx = buildExportContext({ joints, members });
  const {
    jWorldById: _jWorldById, rankByJointId: _rankByJointId,
    classifyMember3D: _classifyMember3D, planeForDiagMember: _planeForDiagMember,
    memberMat: _memberMat, matObjByName: _matObjByName, memberPageById: _memberPageById,
    floorTypeByJointId: _floorTypeByJointId,
    memRows: _memRows,
    memY: _memY, memXAxis: _memXAxis, memZAxis: _memZAxis,
    memBraceXZ: _memBraceXZ, memBraceXY: _memBraceXY, memBraceYZ: _memBraceYZ,
    yAnchorMax: _yAnchorMax, braceRanks: _braceRanks,
    isBraceJoint: _isBraceJoint, braceJointPlane: _braceJointPlane,
    bySubBlockCoord: _bySubBlockCoord,
    md: _md, rndForRank: _rndForRank,
  } = _ctx;
  // 樓層類型 helper:給 joint 找該節點源 XZ 頁的 floorType key,並把 key 轉成顯示用 label / 排序順序
  //   _ftLabel:預設 key="default" 時直接顯示 "預設",其他 key 看 state.floorTypes label
  //   _ftOrder:用 floorType 的 yyStart 當排序 key(跟樓層 numbering 一致);找不到的塞最後
  const _ftLabel = (k) => {
    if (!k || k === "default") return "預設";
    const t = (state.floorTypes || []).find(x => x.key === k);
    return t ? (t.label || t.key) : k;
  };
  const _ftOrder = (k) => {
    const t = (state.floorTypes || []).find(x => x.key === k);
    return t && Number.isFinite(t.yyStart) ? t.yyStart : 9999;
  };
  // 註:_idsToSegs 不從 ctx 拿(xlsx 用 token-array 格式 [["123"],["123","TO","456"]],
  //   shared.ts 是 string 格式 ["123","123 TO 456"];兩者 API 不同,xlsx 保留自己 local 版本)
  // 排序:XX 升序 → ZZ 升序 → 小區內 ID 升序(後備 fallback 座標)
  const _jointsSorted = joints.slice().sort((a, b) => {
    const ra = _rankByJointId.get(a.id) || {}, rb = _rankByJointId.get(b.id) || {};
    const ax = ra.xr || 9999, bx = rb.xr || 9999;
    if (ax !== bx) return ax - bx;
    const az = ra.zr || 9999, bz = rb.zr || 9999;
    if (az !== bz) return az - bz;
    if ((a.id || 0) !== (b.id || 0)) return (a.id || 0) - (b.id || 0);
    const ay = _rndForRank(a.y), by = _rndForRank(b.y);
    if (ay !== by) return ay - by;
    const aX = _rndForRank(a.x), bX = _rndForRank(b.x);
    if (aX !== bX) return aX - bX;
    return _rndForRank(a.z) - _rndForRank(b.z);
  });
  const _regularSorted = _jointsSorted.filter(j => !_isBraceJoint(j));
  const _braceSorted   = _jointsSorted.filter(j =>  _isBraceJoint(j));
  // 渲染單一節點區塊:從 row=2 起,XX/ZZ rank 分小區,小區內 anchor→demote 插 * 標記
  //   baseCol = 該區塊 ID 欄位的 column index(JOINT COORDINATES=0, JOINT BRACE=5)
  //   opts.planeOf:若提供 → 先按 plane 分子群,每子群前插 `* PLANE XX/YZ/XZ` header,
  //                  XY > YZ > XZ priority,plane 不明的進 `* PLANE ?` 子群最後
  const _renderJointBlock = (sortedList, baseCol, opts) => {
    opts = opts || {};
    const planeOf = opts.planeOf;
    // 分子群(若無 planeOf 視為單一群,跳過 plane header)
    const subGroups = [];   // [{ header: string|null, items: [] }]
    if (planeOf) {
      const byPlane = new Map();
      for (const j of sortedList) {
        const pl = planeOf(j) || "?";
        if (!byPlane.has(pl)) byPlane.set(pl, []);
        byPlane.get(pl).push(j);
      }
      for (const pl of ["XY", "YZ", "XZ"]) {
        if (byPlane.has(pl)) subGroups.push({ header: `* PLANE ${pl}`, items: byPlane.get(pl) });
      }
      if (byPlane.has("?")) subGroups.push({ header: `* PLANE ?`, items: byPlane.get("?") });
    } else {
      subGroups.push({ header: null, items: sortedList });
    }
    let _r = 2;
    for (const grp of subGroups) {
      if (grp.header) _pushSubHeader(_r++, baseCol, grp.header);
      if (planeOf) {
        // 平面為唯一分群 → 拿掉 XX/ZZ 小區與 anchor→demote 標記,
        //   同平面節點直接依 ID 升序連續列出
        const _planeItems = grp.items.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
        for (const j of _planeItems) {
          push(_r, baseCol,     j.id, 4);
          push(_r, baseCol + 1, +(_rndForRank(j.x) * k).toFixed(4));
          push(_r, baseCol + 2, +(_rndForRank(j.y) * k).toFixed(4));
          push(_r, baseCol + 3, +(_rndForRank(j.z) * k).toFixed(4));
          _r++;
        }
        continue;
      }
      let _prevXr = null, _prevZr = null, _prevYr = null;
      for (const j of grp.items) {
        const rk = _rankByJointId.get(j.id) || {};
        if (rk.xr !== _prevXr || rk.zr !== _prevZr) {
          _pushSubHeader(_r++, baseCol, `* XX ${rk.xr != null ? String(rk.xr).padStart(2, "0") : "?"}`, 7);
          _pushSubHeader(_r++, baseCol, `* ZZ ${rk.zr != null ? String(rk.zr).padStart(2, "0") : "?"}`, 7);
          _prevXr = rk.xr; _prevZr = rk.zr;
          _prevYr = null;
        } else if (_yAnchorMax > 0 && _prevYr != null && rk.yr != null
                   && _prevYr <= _yAnchorMax && rk.yr > _yAnchorMax) {
          _pushSubHeader(_r++, baseCol, "*");
        }
        push(_r, baseCol,     j.id, 4);
        push(_r, baseCol + 1, +(_rndForRank(j.x) * k).toFixed(4));
        push(_r, baseCol + 2, +(_rndForRank(j.y) * k).toFixed(4));
        push(_r, baseCol + 3, +(_rndForRank(j.z) * k).toFixed(4));
        _r++;
        _prevYr = rk.yr;
      }
    }
  };
  // JOINT 區拆成兩個大列區塊(左右並排,各 col 0-3 / col 5-8):
  //   依 (XX, ZZ) 柱線分桶;sortedLines 一半放左、一半放右
  //   每個柱線群內:`* XX nn / * ZZ nn` → anchor → BRACE YZ → BRACE XY → BRACE XZ
  {
    const _writeJointRow = (_r, j, baseCol) => {
      push(_r, baseCol,     j.id, 4);
      push(_r, baseCol + 1, +(_rndForRank(j.x) * k).toFixed(4));
      push(_r, baseCol + 2, +(_rndForRank(j.y) * k).toFixed(4));
      push(_r, baseCol + 3, +(_rndForRank(j.z) * k).toFixed(4));
    };
    const linesMap = new Map();
    const _getBucket = (rk) => {
      const xr = rk.xr || null, zr = rk.zr || null;
      const key = `${xr}|${zr}`;
      if (!linesMap.has(key)) {
        linesMap.set(key, { xr, zr, anchors: [], bracesByPlane: new Map() });
      }
      return linesMap.get(key);
    };
    for (const j of _regularSorted) {
      const rk = _rankByJointId.get(j.id) || {};
      _getBucket(rk).anchors.push(j);
    }
    let _unknownBraceCount = 0;
    for (const j of _braceSorted) {
      const rk = _rankByJointId.get(j.id) || {};
      const bucket = _getBucket(rk);
      let pl = _braceJointPlane(j) || "?";
      if (pl === "?") { _unknownBraceCount++; pl = "XZ"; }
      if (!bucket.bracesByPlane.has(pl)) bucket.bracesByPlane.set(pl, []);
      bucket.bracesByPlane.get(pl).push(j);
    }
    if (_unknownBraceCount) {
      console.warn(`[xlsx] ${_unknownBraceCount} 顆 brace joint 沒接到任何斜撐桿件,plane 投票無結果 → 併入 BRACE XZ`);
    }
    const sortedLines = [...linesMap.values()].sort((a, b) => {
      const ax = a.xr || 9999, bx = b.xr || 9999;
      if (ax !== bx) return ax - bx;
      return (a.zr || 9999) - (b.zr || 9999);
    });
    // 一半放左 (col 0-3),一半放右 (col 5-8);ceil 讓左略長
    const _half = Math.ceil(sortedLines.length / 2);
    // _bySubBlockCoord 從 buildExportContext destructure 拿(Phase 4 dedup)
    const _renderLineGroup = (lines, baseCol) => {
      let _r = 2;
      for (const line of lines) {
        // 柱線 header(* XX nn / * ZZ nn)用 styleId 7(淡藍底,跟 BRACE 等差色)
        _pushSubHeader(_r++, baseCol, `* XX ${line.xr != null ? String(line.xr).padStart(2, "0") : "?"}`, 7);
        _pushSubHeader(_r++, baseCol, `* ZZ ${line.zr != null ? String(line.zr).padStart(2, "0") : "?"}`, 7);
        // anchor 節點前插一層 `* Y-axis`(跟 BRACE 平面 sub-header 同層級、同色 styleId 3)
        //   再依「樓層類型」分子區:`* TYPE <label>` → 該樓層類型的節點 → 下一個樓層類型 …
        //   樓層類型依 yyStart 升序(跟 .xlsx 頁面分群、.std 樓層編號一致)
        if (line.anchors.length) {
          _pushSubHeader(_r++, baseCol, "* Y-axis");
          // 把 anchors 按 floorType key 分桶
          const _byFt = new Map();
          for (const j of line.anchors) {
            const ft = _floorTypeByJointId.get(j.id) || "default";
            if (!_byFt.has(ft)) _byFt.set(ft, []);
            _byFt.get(ft).push(j);
          }
          const _sortedFt = [..._byFt.keys()].sort((a, b) => _ftOrder(a) - _ftOrder(b));
          for (const ft of _sortedFt) {
            _pushSubHeader(_r++, baseCol, `* TYPE ${_ftLabel(ft)}`);
            const items = _byFt.get(ft).slice().sort(_bySubBlockCoord);
            for (const j of items) { _writeJointRow(_r, j, baseCol); _r++; }
          }
        }
        for (const pl of ["YZ", "XY", "XZ"]) {
          const items = line.bracesByPlane.get(pl);
          if (!items || !items.length) continue;
          _pushSubHeader(_r++, baseCol, `* BRACE ${pl}`);
          const sorted = items.slice().sort(_bySubBlockCoord);
          for (const j of sorted) { _writeJointRow(_r, j, baseCol); _r++; }
        }
      }
    };
    _renderLineGroup(sortedLines.slice(0, _half), 0);
    _renderLineGroup(sortedLines.slice(_half),    5);
  }
  // ── MEMBER 四大區 + MEMBER PROPERTIES ──
  //   分類規則(3D 方向,cos(3°)≈0.9986 軸向門檻):
  //     Y 軸(柱)         → MEMBER Y-axis        (col U-W)
  //     X 軸 / Z 軸 / XZ 平面斜撐 → MEMBER XZ    (col Y-AA)
  //     XY 平面斜撐(垂直牆)→ MEMBER BRACE XY    (col AC-AE)
  //     YZ 平面斜撐(垂直牆)→ MEMBER BRACE YZ    (col AG-AI)
  //   排序:
  //     MEMBER Y-axis  — 用 j1 端 (XX rank, ZZ rank) 分小區,前插 `* XX nn / * ZZ nn`;
  //                       區間順序:ZZ 升序(primary)→ XX 升序(secondary)→ ID 升序
  //                       (Y 軸桿件兩端 X/Z 相同,故 j1 即可代表柱線)
  //     MEMBER XZ     — 用「來源頁面名稱」分小區(`* <fileName>#<pageIdx+1>`),
  //                       群間依 page elev(pg.z)升序 → 頁名稱 → ID 升序
  //     BRACE XY / BRACE YZ — 純 ID 升序、無小區分隔
  //   MEMBER PROPERTIES 跨四區彙整,以 ID 升序列出有材料的桿件。
  // _memberMat / _classifyMember3D / _memRows + 6 buckets / _memberPageById
  // 全部從 buildExportContext destructure 拿(Phase 4 dedup)。
  // 注意:此處原本的 _memberPageById 額外存 .file / .pg / .k / .plane,但下游 xlsx 邏輯只用 .pageName + .elev,
  //   shared.ts 版本已涵蓋所需欄位。
  const _byId = (a, b) => (a.m.id || 0) - (b.m.id || 0);
  // MEMBER 區塊:一列最多 3 條桿件,以 `;` 分隔。每組占 3 欄(ID, J1, J2)+ 1 欄 `;`(末組無 `;`)
  //   塊寬 = 3*3 + 2 = 11 欄。helper 把一個 rows 陣列從 startRow 開始 pack,回傳結束後下一個可用 row index
  const MEMBER_SETS_PER_ROW = 3, MEMBER_SET_W = 3;
  const _writeMembersPacked = (rows, baseCol, startRow) => {
    let _r = startRow;
    for (let i = 0; i < rows.length; i += MEMBER_SETS_PER_ROW) {
      const slice = rows.slice(i, i + MEMBER_SETS_PER_ROW);
      for (let j = 0; j < slice.length; j++) {
        const off = j * (MEMBER_SET_W + 1);
        const entry = slice[j];
        const m = entry.m || (entry.mr && entry.mr.m);
        if (!m) continue;
        push(_r, baseCol + off,     m.id, 5);
        push(_r, baseCol + off + 1, m.j1);
        push(_r, baseCol + off + 2, m.j2);
        if (j < slice.length - 1) push(_r, baseCol + off + 3, ";");
      }
      _r++;
    }
    return _r;
  };
  const _renderMemberFlat = (rows, baseCol) => { _writeMembersPacked(rows, baseCol, 2); };
  // 在 _writeMembersPacked 外面再套一層「連續 ID 分段」:把 rows 拆成 ID 連號的 run
  //   (rows[k+1].m.id - rows[k].m.id === 1 算同 run),每 run 從新 row 起 pack。
  //   結果就算同個 X-axis 下有 ID 跳號(例:140113 → 140121),也會在跳點視覺上換 row。
  const _writeMembersPackedByRuns = (rows, baseCol, startRow) => {
    let _r = startRow;
    let i = 0;
    while (i < rows.length) {
      let j = i + 1;
      while (j < rows.length &&
             ((rows[j].m?.id ?? rows[j].mr?.m?.id) -
              (rows[j-1].m?.id ?? rows[j-1].mr?.m?.id) === 1)) j++;
      _r = _writeMembersPacked(rows.slice(i, j), baseCol, _r);
      i = j;
    }
    return _r;
  };
  // MEMBER Y-axis(col 20-30):基於柱線 (XX, ZZ) 分小區 — Y 軸桿件兩端共用 X/Z,可用 j1 端 rank 當 key
  //   排序:ZZ 升序(primary)→ XX 升序(secondary)→ ID 升序
  //   每個 (XX, ZZ) 群前插 `* XX nn / * ZZ nn` header,群內走 packed 3-per-row
  const _rankForMemberJ1 = (mr) => {
    const j1 = _jWorldById.get(mr.m.j1);
    if (!j1) return { xr: null, zr: null };
    const rk = _rankByJointId.get(j1.id) || {};
    return { xr: rk.xr || null, zr: rk.zr || null };
  };
  const _memYRanked = _memY.map(mr => Object.assign({ mr }, _rankForMemberJ1(mr)));
  _memYRanked.sort((a, b) => {
    const az = a.zr || 9999, bz = b.zr || 9999;
    if (az !== bz) return az - bz;
    const ax = a.xr || 9999, bx = b.xr || 9999;
    if (ax !== bx) return ax - bx;
    return (a.mr.m.id || 0) - (b.mr.m.id || 0);
  });
  {
    let _r = 2, _prevXr = null, _prevZr = null, _bucket = [];
    const _flushBucket = () => {
      if (!_bucket.length) return;
      _r = _writeMembersPacked(_bucket, 11, _r);
      _bucket = [];
    };
    for (const entry of _memYRanked) {
      if (entry.xr !== _prevXr || entry.zr !== _prevZr) {
        _flushBucket();
        _pushSubHeader(_r++, 11, `* XX ${entry.xr != null ? String(entry.xr).padStart(2, "0") : "?"}`, 7);
        _pushSubHeader(_r++, 11, `* ZZ ${entry.zr != null ? String(entry.zr).padStart(2, "0") : "?"}`, 7);
        _prevXr = entry.xr; _prevZr = entry.zr;
      }
      _bucket.push(entry);
    }
    _flushBucket();
  }
  // MEMBER XZ(col 23-33):三層分群 — 外層『樓層類型』→ 中層『頁面』→ 內層『X-axis / Z-axis』
  //   排序:floorType yyStart 升序 → 頁面 elev (pg.z) 升序 → 頁面名稱 → 方向(X 在前 Z 在後) → ID 升序
  //   X-axis / Z-axis 各自走 packed 3-per-row + 連續 ID 分段
  {
    const _xzCombined = [..._memXAxis, ..._memZAxis];
    // 先按 floorType 分桶 → 每桶內再按 page 分桶
    const byFt = new Map();
    for (const mr of _xzCombined) {
      const info = _memberPageById.get(mr.m.id);
      const pageName = info ? info.pageName : "?";
      const elev = info ? info.elev : Infinity;
      const ft = (info && info.floorType) || "default";
      if (!byFt.has(ft)) byFt.set(ft, new Map());
      const byPage = byFt.get(ft);
      if (!byPage.has(pageName)) byPage.set(pageName, { elev, items: [] });
      byPage.get(pageName).items.push(mr);
    }
    const _sortedFt = [...byFt.keys()].sort((a, b) => _ftOrder(a) - _ftOrder(b));
    let _r = 2;
    for (const ft of _sortedFt) {
      _pushSubHeader(_r++, 23, `* TYPE ${_ftLabel(ft)}`, 7);
      const byPage = byFt.get(ft);
      const sortedPages = [...byPage.entries()].sort((a, b) => {
        if (a[1].elev !== b[1].elev) return a[1].elev - b[1].elev;
        return a[0].localeCompare(b[0]);
      });
      for (const [pageName, info] of sortedPages) {
        _pushSubHeader(_r++, 23, `* ${pageName}`);
        const xRows = info.items.filter(mr => mr.cat === "X").sort(_byId);
        const zRows = info.items.filter(mr => mr.cat === "Z").sort(_byId);
        if (xRows.length) {
          _pushSubHeader(_r++, 23, `* X-axis`);
          _r = _writeMembersPackedByRuns(xRows, 23, _r);
        }
        if (zRows.length) {
          _pushSubHeader(_r++, 23, `* Z-axis`);
          _r = _writeMembersPackedByRuns(zRows, 23, _r);
        }
      }
    }
  }
  // BRACE XZ(col 35-45):依頁面分小區(維持單層 page header),群內走 packed 3-per-row
  const _renderMemberByPage = (rows, baseCol) => {
    const withPage = rows.map(mr => {
      const info = _memberPageById.get(mr.m.id);
      return { mr, pageName: info ? info.pageName : "?", elev: info ? info.elev : Infinity };
    });
    withPage.sort((a, b) => {
      if (a.elev !== b.elev) return a.elev - b.elev;
      if (a.pageName !== b.pageName) return a.pageName.localeCompare(b.pageName);
      return (a.mr.m.id || 0) - (b.mr.m.id || 0);
    });
    let _r = 2, _prevPage = null, _bucket = [];
    const _flushBucket = () => {
      if (!_bucket.length) return;
      _r = _writeMembersPacked(_bucket, baseCol, _r);
      _bucket = [];
    };
    for (const entry of withPage) {
      if (entry.pageName !== _prevPage) {
        _flushBucket();
        _pushSubHeader(_r++, baseCol, `* ${entry.pageName}`);
        _prevPage = entry.pageName;
      }
      _bucket.push(entry);
    }
    _flushBucket();
  };
  _renderMemberByPage(_memBraceXZ, 35);
  _renderMemberFlat(_memBraceXY,   48);
  _renderMemberFlat(_memBraceYZ,   61);
  // MEMBER PROPERTIES — 跟 MEMBER 區同樣的分區結構,每子區用 (table, name) 分組壓縮:
  //   每列最多 6 個 ID-related 欄位(個別 ID 1 格,或 "start TO end" 3 格),不足補空白
  //   後接 Table(col 46) / Material(col 47)固定欄位
  const MAT_BASE_COL  = 74;
  const MAT_ID_SLOTS  = 6;
  const MAT_TABLE_COL = MAT_BASE_COL + MAT_ID_SLOTS;     // 89
  const MAT_NAME_COL  = MAT_TABLE_COL + 1;               // 90
  // sorted ids → segments:連續(差 1)壓成 [start,"TO",end];單個成 [id]
  //   排序:純數字 → 數值升序;含非數字 → 字典(numeric-aware)升序
  //   單桿件之間、單桿件 vs 範圍之間 都依此順序排列
  const _idsToSegs = (ids) => {
    const sorted = [...ids].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
    const segs = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      // 只有「兩者都是數字」且差 1 才連續;若任一非數字直接斷段
      while (j + 1 < sorted.length) {
        const cur = Number(sorted[j]), nxt = Number(sorted[j + 1]);
        if (Number.isFinite(cur) && Number.isFinite(nxt) && nxt === cur + 1) j++;
        else break;
      }
      if (j === i) segs.push([sorted[i]]);
      else segs.push([sorted[i], "TO", sorted[j]]);
      i = j + 1;
    }
    return segs;
  };
  // segments 攤平 → 切成 6-cell rows(不足補空白)
  const _segsToRows = (segs) => {
    const cells = [];
    for (const s of segs) cells.push(...s);
    const rows = [];
    for (let i = 0; i < cells.length; i += MAT_ID_SLOTS) {
      const row = cells.slice(i, i + MAT_ID_SLOTS);
      while (row.length < MAT_ID_SLOTS) row.push("");
      rows.push(row);
    }
    return rows;
  };
  // _matObjByName 從 buildExportContext destructure 拿(Phase 4 dedup)
  // 寫一個子區:label = sub header(如 "Y-axis"),rows = 該子區的 _memRows
  let _rMat = 2;
  const _writeSubProp = (label, rows) => {
    const grouped = new Map();   // "<table>||<name>" → { table, name, ids: [] }
    for (const mr of rows) {
      const name = mr.mat ? String(mr.mat).trim() : "";
      if (!name) continue;
      const matObj = _matObjByName.get(name);
      const tableStr = matObj && matObj.table ? String(matObj.table) : "";
      const key = `${tableStr}||${name}`;
      if (!grouped.has(key)) grouped.set(key, { table: tableStr, name, ids: [] });
      grouped.get(key).ids.push(mr.m.id);
    }
    if (!grouped.size) return;
    _pushSubHeader(_rMat++, MAT_BASE_COL, `* ${label}`);
    const groupList = [...grouped.values()].sort((a, b) => {
      if (a.table !== b.table) return a.table.localeCompare(b.table);
      return a.name.localeCompare(b.name);
    });
    for (const g of groupList) {
      const idRows = _segsToRows(_idsToSegs(g.ids));
      for (const r of idRows) {
        for (let i = 0; i < MAT_ID_SLOTS; i++) {
          const v = r[i];
          if (v === "" || v === undefined) continue;
          // 數字 ID 用 styleId 5(淡綠底,桿件 ID);"TO" 等字串不上色
          push(_rMat, MAT_BASE_COL + i, v, typeof v === "number" ? 5 : undefined);
        }
        if (g.table) push(_rMat, MAT_TABLE_COL, g.table);
        if (g.name)  push(_rMat, MAT_NAME_COL,  g.name);
        _rMat++;
      }
    }
  };
  // Y-axis 特例:在 (table, name) 分組之前先依「來源頁面」分子區(對應 XY elevation 視圖)
  //   結構:* Y-axis → * <pageName> → (table, name) 群 → 壓縮 TO ranges
  //   排序:page elev (pg.z) 升序 → page name → 群間 (table, name)
  //   柱類桿件在 XZ 平面圖通常以「joint 點」呈現,不在 pg.members 裡,所以
  //   `_memberPageById` 優先序 XZ → XY → YZ 會 fallback 到 XY elevation page,自然分到對應 XY 子區
  const _writeSubPropForYaxis = () => {
    const byPage = new Map();   // pageName → { elev, members: [] }
    for (const mr of _memY) {
      if (!mr.mat || !String(mr.mat).trim()) continue;
      const info = _memberPageById.get(mr.m.id);
      const pageName = info ? info.pageName : "?";
      const elev = info ? info.elev : Infinity;
      if (!byPage.has(pageName)) byPage.set(pageName, { elev, members: [] });
      byPage.get(pageName).members.push(mr);
    }
    if (!byPage.size) return;
    _pushSubHeader(_rMat++, MAT_BASE_COL, "* Y-axis");
    const sortedPages = [...byPage.entries()].sort((a, b) => {
      if (a[1].elev !== b[1].elev) return a[1].elev - b[1].elev;
      return a[0].localeCompare(b[0]);
    });
    for (const [pageName, pgInfo] of sortedPages) {
      _pushSubHeader(_rMat++, MAT_BASE_COL, `* ${pageName}`);
      const grouped = new Map();
      for (const mr of pgInfo.members) {
        const name = String(mr.mat).trim();
        const matObj = _matObjByName.get(name);
        const tableStr = matObj && matObj.table ? String(matObj.table) : "";
        const key = `${tableStr}||${name}`;
        if (!grouped.has(key)) grouped.set(key, { table: tableStr, name, ids: [] });
        grouped.get(key).ids.push(mr.m.id);
      }
      const groupList = [...grouped.values()].sort((a, b) => {
        if (a.table !== b.table) return a.table.localeCompare(b.table);
        return a.name.localeCompare(b.name);
      });
      for (const g of groupList) {
        const idRows = _segsToRows(_idsToSegs(g.ids));
        for (const r of idRows) {
          for (let i = 0; i < MAT_ID_SLOTS; i++) {
            const v = r[i];
            if (v === "" || v === undefined) continue;
            push(_rMat, MAT_BASE_COL + i, v, typeof v === "number" ? 5 : undefined);
          }
          if (g.table) push(_rMat, MAT_TABLE_COL, g.table);
          if (g.name)  push(_rMat, MAT_NAME_COL,  g.name);
          _rMat++;
        }
      }
    }
  };
  _writeSubPropForYaxis();
  // MEMBER PROPERTIES 的 XZ 區跟 MEMBER XZ 對齊 — 三層分群:floorType → page → (X-axis / Z-axis)
  //   讓「X 軸與 Z 軸編排完成才換下一個同類型頁面」的順序在材料區也成立
  //   結構:* XZ → * TYPE <label> → * <pageName> → * X-axis 群 → * Z-axis 群 → 下一頁 → 下一型
  const _writeSubPropForXZ = () => {
    // 把 XZ X / Z 兩桶合併,先 byFt → 再 byPage(只算有材料的桿件)
    const byFt = new Map();
    for (const mr of [..._memXAxis, ..._memZAxis]) {
      if (!mr.mat || !String(mr.mat).trim()) continue;
      const info = _memberPageById.get(mr.m.id);
      const pageName = info ? info.pageName : "?";
      const elev = info ? info.elev : Infinity;
      const ft = (info && info.floorType) || "default";
      if (!byFt.has(ft)) byFt.set(ft, new Map());
      const byPage = byFt.get(ft);
      if (!byPage.has(pageName)) byPage.set(pageName, { elev, members: [] });
      byPage.get(pageName).members.push(mr);
    }
    if (!byFt.size) return;
    _pushSubHeader(_rMat++, MAT_BASE_COL, "* XZ");
    const _writeOneCat = (members, catLabel) => {
      const grouped = new Map();
      for (const mr of members) {
        const name = String(mr.mat).trim();
        const matObj = _matObjByName.get(name);
        const tableStr = matObj && matObj.table ? String(matObj.table) : "";
        const key = `${tableStr}||${name}`;
        if (!grouped.has(key)) grouped.set(key, { table: tableStr, name, ids: [] });
        grouped.get(key).ids.push(mr.m.id);
      }
      if (!grouped.size) return;
      _pushSubHeader(_rMat++, MAT_BASE_COL, `* ${catLabel}`);
      const groupList = [...grouped.values()].sort((a, b) => {
        if (a.table !== b.table) return a.table.localeCompare(b.table);
        return a.name.localeCompare(b.name);
      });
      for (const g of groupList) {
        const idRows = _segsToRows(_idsToSegs(g.ids));
        for (const r of idRows) {
          for (let i = 0; i < MAT_ID_SLOTS; i++) {
            const v = r[i];
            if (v === "" || v === undefined) continue;
            push(_rMat, MAT_BASE_COL + i, v, typeof v === "number" ? 5 : undefined);
          }
          if (g.table) push(_rMat, MAT_TABLE_COL, g.table);
          if (g.name)  push(_rMat, MAT_NAME_COL,  g.name);
          _rMat++;
        }
      }
    };
    const _sortedFt = [...byFt.keys()].sort((a, b) => _ftOrder(a) - _ftOrder(b));
    for (const ft of _sortedFt) {
      _pushSubHeader(_rMat++, MAT_BASE_COL, `* TYPE ${_ftLabel(ft)}`);
      const byPage = byFt.get(ft);
      const sortedPages = [...byPage.entries()].sort((a, b) => {
        if (a[1].elev !== b[1].elev) return a[1].elev - b[1].elev;
        return a[0].localeCompare(b[0]);
      });
      for (const [pageName, pgInfo] of sortedPages) {
        _pushSubHeader(_rMat++, MAT_BASE_COL, `* ${pageName}`);
        const xList = pgInfo.members.filter(mr => mr.cat === "X");
        const zList = pgInfo.members.filter(mr => mr.cat === "Z");
        if (xList.length) _writeOneCat(xList, "X-axis");
        if (zList.length) _writeOneCat(zList, "Z-axis");
      }
    }
  };
  _writeSubPropForXZ();
  _writeSubProp("BRACE XZ",  _memBraceXZ);
  _rMat++;   // BRACE XZ 後加一列空白 — 水平群(Y / XZ / BRACE XZ)與垂直 brace 群之間的視覺分隔
  _writeSubProp("BRACE XY",  _memBraceXY);
  _writeSubProp("BRACE YZ",  _memBraceYZ);
  _rMat++;   // BRACE YZ 後也加一列空白 — PROPERTIES 區結尾收齊,跟 BRACE XZ 後對稱
  // === SUPPORTS 區塊(col 92 起,接在 Material 右邊)===
  //   layout 跟 Material 一致:6 個 ID slot + Type(col 99)
  //   anchor joint 按 supportType 分組(預設 FIXED)
  const SUP_BASE_COL = 92;
  const SUP_ID_SLOTS = 6;
  const SUP_TYPE_COL = SUP_BASE_COL + SUP_ID_SLOTS + 1;     // 99
  let _rSup = 2;
  const _writeSupBlock = (label: string, anchorIds: number[]) => {
    if (!anchorIds.length) return;
    _pushSubHeader(_rSup++, SUP_BASE_COL, `* ${label}`);
    const idRows = _segsToRows(_idsToSegs(anchorIds));
    for (const r of idRows) {
      for (let i = 0; i < SUP_ID_SLOTS; i++) {
        const v = r[i];
        if (v === "" || v === undefined) continue;
        push(_rSup, SUP_BASE_COL + i, v, typeof v === "number" ? 5 : undefined);
      }
      push(_rSup, SUP_TYPE_COL, label);
      _rSup++;
    }
  };
  {
    const fixedIds: number[] = [];
    const pinnedIds: number[] = [];
    for (const j of joints as any[]) {
      if (!j.isAnchor) continue;
      if (j.supportType === "PINNED") pinnedIds.push(j.id);
      else fixedIds.push(j.id);
    }
    fixedIds.sort((a, b) => a - b);
    pinnedIds.sort((a, b) => a - b);
    _writeSupBlock("FIXED",  fixedIds);
    if (fixedIds.length && pinnedIds.length) _rSup++;   // 兩組之間空一行
    _writeSupBlock("PINNED", pinnedIds);
  }
  // 大區分隔欄(黃色)改用 OOXML <cols> 元素整欄套色,不再 push per-row 空格(避免大量空格 cell 造成 Excel 開檔抱怨)
  //   col 19(T)= JOINT 類 vs MEMBER 類;col 39(AN)= MEMBER 類 vs MATERIAL 類
  //   col 91(CM)= MATERIAL 類 vs SUPPORTS 類
  //   實際的 <cols> 寫在 sheetXml 組裝那段
  const _matRowCount = _memRows.filter(mr => mr.mat && String(mr.mat).trim()).length;
  // 按 row 分組 → 組 sheet 的 <row> 標記;row 內 cells 必須依 column 升序(OOXML 規範)
  const rowMap = new Map();
  for (const c of cells) {
    if (!rowMap.has(c.r)) rowMap.set(c.r, []);
    rowMap.get(c.r).push(c);
  }
  const rowKeys = [...rowMap.keys()].sort((a, b) => a - b);
  const rowsXml = rowKeys.map(r => {
    const sorted = rowMap.get(r).slice().sort((a, b) => a.c - b.c);
    return `<row r="${r+1}">${sorted.map(x => x.s).join("")}</row>`;
  }).join("");
  // <cols> 套整欄黃色樣式(1-based col index)
  //   col 11 → 0-based col 10 (K) :JOINT 類 vs MEMBER 類(JOINT 右塊 col I 後留 col J 空欄 + col K 黃線)
  //   col 74 → 0-based col 73 (BV):MEMBER 類 vs MATERIAL 類
  //     (MEMBER 從 col 11 起,5 塊各 11 欄,PROPERTIES 從 col 74 起 8 欄)
  //   width 從 xlsx 輸出設定讀(預設 2);customWidth=1 才會被 Excel 認可
  const _sepW = _xs.separatorWidth;
  const colsXml = `<cols>` +
    `<col min="11" max="11" width="${_sepW}" customWidth="1" style="6"/>` +
    `<col min="74" max="74" width="${_sepW}" customWidth="1" style="6"/>` +
    `<col min="92" max="92" width="${_sepW}" customWidth="1" style="6"/>` +
    `</cols>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${rowsXml}</sheetData></worksheet>`;
  // 標準 OOXML container 檔案 + styles.xml(自訂底色 / 字型 / 對齊)
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  // sheet name 從 xlsx 設定讀;Excel 限制 31 字、不能含 :\/?*[]
  const _sheetName = (_xs.sheetName || "Model").replace(/[:\\\/?*\[\]]/g, "_").slice(0, 31);
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${_sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  // styles.xml — 8 個 cellXf:
  //   0 default / 1 區塊大標(深藍底+白字+粗體)/ 2 欄位標題(粗體+淺灰底)
  //   3 一般 sub-header(* Y-axis / * BRACE YZ / * <pageName> 等,暖橘底,斜體灰字)
  //   4 節點 ID 欄(淡藍底)
  //   5 桿件 / 材料 ID 欄(淡綠底)
  //   6 大區分隔欄(純黃色,JOINT / MEMBER / MATERIAL 三類之間)
  //   7 柱線 sub-header(* XX nn / * ZZ nn,淡藍底,斜體灰字)— 跟 BRACE 等差色
  // 字型 / 區塊填色都從 xlsx 設定讀(預設值維持原本配色);ARGB 寫法 "FFRRGGBB"
  const _fName = _xs.fontName || "Calibri";
  const _fSize = Number.isFinite(_xs.fontSize) ? _xs.fontSize : 12;
  const _fillBlockHeader  = cssHexToArgb(_xs.colors.blockHeader);
  const _fillColumnHeader = cssHexToArgb(_xs.colors.columnHeader);
  const _fillSubHeader    = cssHexToArgb(_xs.colors.subHeader);
  const _fillJointId      = cssHexToArgb(_xs.colors.jointId);
  const _fillMemberId     = cssHexToArgb(_xs.colors.memberId);
  const _fillSeparator    = cssHexToArgb(_xs.colors.separator);
  const _fillColumnLine   = cssHexToArgb(_xs.colors.columnLine);
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="${_fSize}"/><name val="${_fName}"/></font>
<font><sz val="${_fSize}"/><name val="${_fName}"/><b/><color rgb="FFFFFFFF"/></font>
<font><sz val="${_fSize}"/><name val="${_fName}"/><b/></font>
<font><sz val="${_fSize}"/><name val="${_fName}"/><i/><color rgb="FF666666"/></font>
</fonts>
<fills count="9">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${_fillBlockHeader}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${_fillColumnHeader}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${_fillSubHeader}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${_fillJointId}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${_fillMemberId}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${_fillSeparator}"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="${_fillColumnLine}"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="6" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="7" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="3" fillId="8" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const files = [
    { name: "[Content_Types].xml",       data: _strBytes(contentTypes) },
    { name: "_rels/.rels",               data: _strBytes(rels) },
    { name: "xl/workbook.xml",           data: _strBytes(wb) },
    { name: "xl/_rels/workbook.xml.rels",data: _strBytes(wbRels) },
    { name: "xl/styles.xml",             data: _strBytes(stylesXml) },
    { name: "xl/worksheets/sheet1.xml",  data: _strBytes(sheetXml) },
  ];
  const zip = _buildZip(files);
  const blob = new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const projectName = ($("jobName") && $("jobName").value.trim()) || "model";
  // 套檔名樣板:{projectName} 會被代換,其他文字原樣保留
  const _baseName = (_xs.filenamePattern || "{projectName}")
    .replace(/\{projectName\}/g, projectName)
    .replace(/[\\\/:*?"<>|]/g, "_")    // 移除作業系統不合法字元
    .trim() || projectName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${_baseName}.xlsx`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  if ($("hud")) $("hud").textContent = `匯出 .xlsx 完成・${joints.length} 節點 / ${members.length} 桿件 / ${_matRowCount} 材料`;
  // 撞號 fallback 集中通知(buildModel 已收集,console 也有 detail)
  setTimeout(() => { try { showBuildModelCollisionsIfAny(".xlsx 匯出"); } catch (_) {} }, 50);
}
