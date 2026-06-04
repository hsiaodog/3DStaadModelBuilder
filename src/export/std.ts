// Phase 8g — .std (STAAD) 匯出
//   依目前模型聚合 → 組 STAAD .std 文字檔下載。共用 buildExportContext 與 xlsx 那條
//   (Phase 4 dedup),所以這條只負責 STAAD 自己的格式:JOINT / MEMBER / MATERIAL / SUPPORT 等
//   區塊組裝。
//
//   INPUT WIDTH 79 — STAAD 規範介於 50–79;原本被誤寫成 200,STAAD 會整行 IGNORE 後續解析錯。
//
//   依賴(全部已 export):
//     • state / $          — legacy.ts
//     • buildModel / showBuildModelCollisionsIfAny — core/buildModel
//     • buildExportContext — export/shared
//     • unitToMeter / meterToTarget / staadUnitKeyword — utils/units

import { state, $ } from "../app/integration";
import { buildModel, showBuildModelCollisionsIfAny } from "../core/buildModel";
import { supportTypeOf, supportStaadSpec } from "../core/support";
import { buildExportContext } from "./shared";
import { unitToMeter, meterToTarget, staadUnitKeyword } from "../utils/units";
import { saveFileWithPicker } from "../utils/saveFile";

export function exportStdFile() {
  // === 共用邏輯透過 buildExportContext()(Phase 4 dedup;原本同樣 ~120 行在這跟 exportXlsxFile 各一份)
  const { joints, members } = buildModel();
  const tgt = ($("exportUnit") as HTMLSelectElement).value;
  const kFromCalib = unitToMeter(state.unitName);
  const kToTarget  = meterToTarget(tgt);
  const k = kFromCalib * kToTarget;
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
    bySubBlockCoord: _bySubBlockCoord, idsToSegs: _idsToSegs,
    md: _md, rndForRank: _rndForRank,
  } = _ctx;
  // 樓層類型 label / 排序(跟 xlsx 一致):
  const _ftLabel = (k) => {
    if (!k || k === "default") return "預設";
    const t = (state.floorTypes || []).find(x => x.key === k);
    return t ? (t.label || t.key) : k;
  };
  const _ftOrder = (k) => {
    const t = (state.floorTypes || []).find(x => x.key === k);
    return t && Number.isFinite(t.yyStart) ? t.yyStart : 9999;
  };
  // === 輸出 STAAD .std ===
  //   規範:INPUT WIDTH 79(STAAD 規定 50–79 之間;原本誤寫 200 會被 STAAD 整行 IGNORE 後續解析錯);* 起頭 = comment;`;` 分隔同列多 statement;`-` 行尾 = 行接續
  const lines = [];
  lines.push("STAAD SPACE");
  lines.push("START JOB INFORMATION");
  lines.push(`JOB NAME ${($("jobName") as HTMLInputElement).value || "Frame"}`);
  lines.push(`ENGINEER DATE ${new Date().toISOString().slice(0,10)}`);
  lines.push("END JOB INFORMATION");
  lines.push("INPUT WIDTH 79");
  lines.push(`UNIT ${staadUnitKeyword(tgt)} KN`);
  // === JOINT COORDINATES:跟 .xlsx 一致 ===
  //   依 (XX, ZZ) 柱線分桶,每柱線群內:`* Y-axis` 標 anchor 節點;`* BRACE YZ/XY/XZ` 標對應平面斜撐節點
  //   座標小數位數跟「節點適配位數」(state.measureDecimals)一致
  lines.push("JOINT COORDINATES");
  const _fmtJ = (j) => `${j.id} ${(_rndForRank(j.x)*k).toFixed(_md)} ${(_rndForRank(j.y)*k).toFixed(_md)} ${(_rndForRank(j.z)*k).toFixed(_md)}`;
  // MEMBER INCIDENCES 仍維持「一列 3 個 ;」的 STAAD 慣例
  const _packLines = (items, fmt) => {
    const out = [];
    for (let i = 0; i < items.length; i += 3) {
      out.push(items.slice(i, i + 3).map(fmt).join("; "));
    }
    return out;
  };
  // 連續 ID 分段:把 items 拆成 ID 連號的 run((next.m.id - cur.m.id === 1)),每 run
  //   獨立 _packLines。同 X-axis 下若有跳號,跳點處自動換行,視覺上能看出分段。
  const _packLinesByRuns = (items, fmt) => {
    const out = [];
    let i = 0;
    while (i < items.length) {
      let j = i + 1;
      while (j < items.length && (items[j].m.id - items[j-1].m.id) === 1) j++;
      out.push(..._packLines(items.slice(i, j), fmt));
      i = j;
    }
    return out;
  };
  // anchor/brace 判定 + 平面投票:_isBraceJoint / _planeForDiagMember / _braceJointPlane / _bySubBlockCoord
  // 全部已從 buildExportContext() 拿出(上面 destructure);這裡只需開始用 ─── (Phase 4 dedup)
  // 依 (XX, ZZ) 柱線分桶,內部 anchor + brace by plane
  {
    const linesMap = new Map();
    const _getBucket = (rk) => {
      const xr = rk.xr || null, zr = rk.zr || null;
      const key = `${xr}|${zr}`;
      if (!linesMap.has(key)) {
        linesMap.set(key, { xr, zr, anchors: [], bracesByPlane: new Map() });
      }
      return linesMap.get(key);
    };
    for (const j of joints) {
      const rk = _rankByJointId.get(j.id) || {};
      const bucket = _getBucket(rk);
      if (_isBraceJoint(j)) {
        let pl = _braceJointPlane(j) || "XZ";   // plane 不明 → 併入 XZ
        if (!bucket.bracesByPlane.has(pl)) bucket.bracesByPlane.set(pl, []);
        bucket.bracesByPlane.get(pl).push(j);
      } else {
        bucket.anchors.push(j);
      }
    }
    const sortedLines = [...linesMap.values()].sort((a, b) => {
      const ax = a.xr || 9999, bx = b.xr || 9999;
      if (ax !== bx) return ax - bx;
      return (a.zr || 9999) - (b.zr || 9999);
    });
    for (const line of sortedLines) {
      lines.push(`* XX ${line.xr != null ? String(line.xr).padStart(2, "0") : "?"}`);
      lines.push(`* ZZ ${line.zr != null ? String(line.zr).padStart(2, "0") : "?"}`);
      if (line.anchors.length) {
        lines.push("* Y-axis");
        // 依「樓層類型」分子區:`* TYPE <label>` → 該樓層類型的節點 → 下一個樓層類型 …
        //   排序依 yyStart 升序(跟 xlsx 同邏輯)
        const _byFt = new Map();
        for (const j of line.anchors) {
          const ft = _floorTypeByJointId.get(j.id) || "default";
          if (!_byFt.has(ft)) _byFt.set(ft, []);
          _byFt.get(ft).push(j);
        }
        const _sortedFt = [..._byFt.keys()].sort((a, b) => _ftOrder(a) - _ftOrder(b));
        for (const ft of _sortedFt) {
          lines.push(`* TYPE ${_ftLabel(ft)}`);
          const sorted = _byFt.get(ft).slice().sort(_bySubBlockCoord);
          for (const j of sorted) lines.push(_fmtJ(j));
        }
      }
      for (const pl of ["YZ", "XY", "XZ"]) {
        const items = line.bracesByPlane.get(pl);
        if (!items || !items.length) continue;
        lines.push(`* BRACE ${pl}`);
        const sorted = items.slice().sort(_bySubBlockCoord);
        for (const j of sorted) lines.push(_fmtJ(j));
      }
    }
  }
  // === MEMBER INCIDENCES:依分類分區、每列最多 3 個 ===
  if (members.length) {
    lines.push("MEMBER INCIDENCES");
    const _fmtM = (mr) => `${mr.m.id} ${mr.m.j1} ${mr.m.j2}`;
    // Y-axis:依 j1 (XX, ZZ) rank 分小區
    if (_memY.length) {
      lines.push("* MEMBER Y-axis");
      const ranked = _memY.map(mr => {
        const j1 = _jWorldById.get(mr.m.j1);
        const rk: any = j1 ? (_rankByJointId.get(j1.id) || {}) : {};
        return { mr, xr: rk.xr || null, zr: rk.zr || null };
      });
      ranked.sort((a, b) => {
        const az = a.zr || 9999, bz = b.zr || 9999;
        if (az !== bz) return az - bz;
        const ax = a.xr || 9999, bx = b.xr || 9999;
        if (ax !== bx) return ax - bx;
        return (a.mr.m.id || 0) - (b.mr.m.id || 0);
      });
      let _prevXr = null, _prevZr = null, _bucket = [];
      const _flush = () => { if (_bucket.length) { lines.push(..._packLines(_bucket.map(e => e.mr), _fmtM)); _bucket = []; } };
      for (const e of ranked) {
        if (e.xr !== _prevXr || e.zr !== _prevZr) {
          _flush();
          lines.push(`* XX ${e.xr != null ? String(e.xr).padStart(2, "0") : "?"} / ZZ ${e.zr != null ? String(e.zr).padStart(2, "0") : "?"}`);
          _prevXr = e.xr; _prevZr = e.zr;
        }
        _bucket.push(e);
      }
      _flush();
    }
    // XZ:三層分群 — 外層樓層類型 → 中層頁面 → 內層 X-axis / Z-axis
    if (_memXAxis.length || _memZAxis.length) {
      lines.push("* MEMBER XZ");
      const xz = [..._memXAxis, ..._memZAxis];
      const byFt = new Map();
      for (const mr of xz) {
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
      for (const ft of _sortedFt) {
        lines.push(`* TYPE ${_ftLabel(ft)}`);
        const byPage = byFt.get(ft);
        const sortedPages = [...byPage.entries()].sort((a, b) => {
          if (a[1].elev !== b[1].elev) return a[1].elev - b[1].elev;
          return a[0].localeCompare(b[0]);
        });
        const _byId = (a: any, b: any) => (a.m.id || 0) - (b.m.id || 0);
        for (const [pageName, info] of sortedPages) {
          lines.push(`* ${pageName}`);
          const xRows = (info as any).items.filter((mr: any) => mr.cat === "X").sort(_byId);
          const zRows = (info as any).items.filter((mr: any) => mr.cat === "Z").sort(_byId);
          if (xRows.length) {
            lines.push("* X-axis");
            lines.push(..._packLinesByRuns(xRows, _fmtM));
          }
          if (zRows.length) {
            lines.push("* Z-axis");
            lines.push(..._packLinesByRuns(zRows, _fmtM));
          }
        }
      }
    }
    // BRACE XZ:依頁面分小區
    if (_memBraceXZ.length) {
      lines.push("* MEMBER BRACE XZ");
      const withPage = _memBraceXZ.map(mr => {
        const info = _memberPageById.get(mr.m.id);
        return { mr, pageName: info ? info.pageName : "?", elev: info ? info.elev : Infinity };
      });
      withPage.sort((a, b) => {
        if (a.elev !== b.elev) return a.elev - b.elev;
        if (a.pageName !== b.pageName) return a.pageName.localeCompare(b.pageName);
        return (a.mr.m.id || 0) - (b.mr.m.id || 0);
      });
      let _prev = null, _bucket = [];
      const _flush = () => { if (_bucket.length) { lines.push(..._packLines(_bucket.map(e => e.mr), _fmtM)); _bucket = []; } };
      for (const e of withPage) {
        if (e.pageName !== _prev) { _flush(); lines.push(`* ${e.pageName}`); _prev = e.pageName; }
        _bucket.push(e);
      }
      _flush();
    }
    // BRACE XY / YZ:扁平 ID 升序
    if (_memBraceXY.length) {
      lines.push("* MEMBER BRACE XY");
      lines.push(..._packLines(_memBraceXY, _fmtM));
    }
    if (_memBraceYZ.length) {
      lines.push("* MEMBER BRACE YZ");
      lines.push(..._packLines(_memBraceYZ, _fmtM));
    }
  }
  // === MEMBER PROPERTY:跨分類彙整,以 (table, name) 分組壓縮 TO ranges ===
  //   STAAD 行寬 ≤200,若超出用 `-` 連續行
  if (_memRows.some(mr => mr.mat && String(mr.mat).trim())) {
    lines.push("MEMBER PROPERTY");
    const _writeMatGroup = (label, rows) => {
      const grouped = new Map();
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
      // label 為空字串 → 不再 push 一行 sub-header(由 caller 自己寫,例如 XZ 三層分群時)
      if (label) lines.push(`* ${label}`);
      const groupList = [...grouped.values()].sort((a, b) => {
        if (a.table !== b.table) return a.table.localeCompare(b.table);
        return a.name.localeCompare(b.name);
      });
      for (const g of groupList) {
        const segs = _idsToSegs(g.ids);
        const tail = g.table ? `${g.table} ${g.name}` : g.name;
        // 跟 .xlsx PROPERTIES 區一致 — 每列最多 6 個 ID slot:單 ID = 1 slot,TO 範圍 = 3 slot
        //   超過 6 slot 就換行;每行各自重複 tail(table + name)讓每行都是完整 MEMBER PROPERTY statement
        const MAX_SLOTS = 6;
        let buf = "", used = 0;
        const _flush = () => { if (buf) { lines.push(`${buf} ${tail}`); buf = ""; used = 0; } };
        for (const seg of segs) {
          const segSlots = seg.includes(" TO ") ? 3 : 1;
          if (used > 0 && used + segSlots > MAX_SLOTS) _flush();
          buf = buf ? `${buf} ${seg}` : seg;
          used += segSlots;
        }
        _flush();
      }
    };
    _writeMatGroup("Y-axis",    _memY);
    // XZ 區跟 MEMBER XZ 對齊 — 三層分群:floorType → page → (X-axis / Z-axis)
    //   讓「X 軸與 Z 軸編排完成才換下一個同類型頁面」的順序在材料區也成立
    {
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
      if (byFt.size) {
        lines.push("* XZ");
        const _sortedFt = [...byFt.keys()].sort((a, b) => _ftOrder(a) - _ftOrder(b));
        for (const ft of _sortedFt) {
          lines.push(`* TYPE ${_ftLabel(ft)}`);
          const byPage = byFt.get(ft);
          const sortedPages = [...byPage.entries()].sort((a, b) => {
            if (a[1].elev !== b[1].elev) return a[1].elev - b[1].elev;
            return a[0].localeCompare(b[0]);
          });
          for (const [pageName, pgInfo] of sortedPages) {
            lines.push(`* ${pageName}`);
            const xList = pgInfo.members.filter(mr => mr.cat === "X");
            const zList = pgInfo.members.filter(mr => mr.cat === "Z");
            if (xList.length) { lines.push("* X-axis"); _writeMatGroup("", xList); }
            if (zList.length) { lines.push("* Z-axis"); _writeMatGroup("", zList); }
          }
        }
      }
    }
    _writeMatGroup("BRACE XZ",  _memBraceXZ);
    _writeMatGroup("BRACE XY",  _memBraceXY);
    _writeMatGroup("BRACE YZ",  _memBraceYZ);
  }
  // === MEMBER RELEASE / TRUSS / TENSION / COMPRESSION / CABLE ===
  //   RELEASE:同 (START 自由度, END 自由度) 設定的桿件分組,各組分別輸出 START / END 兩列。
  //   其餘四種行為類型:各自一個 MEMBER <TYPE> 區塊。
  {
    // 每列 ≤ 此數個 id slot(TO range 算 3 slot),沿用 SUPPORTS 的寫法
    const _writeIdLines = (ids: number[], suffix: string) => {
      if (!ids.length) return;
      const segs = _idsToSegs([...ids].sort((a, b) => a - b));
      const MAX_SLOTS = 6;
      let buf = "", used = 0;
      const _flush = () => { if (buf) { lines.push(suffix ? `${buf} ${suffix}` : buf); buf = ""; used = 0; } };
      for (const seg of segs) {
        const segSlots = seg.includes(" TO ") ? 3 : 1;
        if (used > 0 && used + segSlots > MAX_SLOTS) _flush();
        buf = buf ? `${buf} ${seg}` : seg;
        used += segSlots;
      }
      _flush();
    };
    const _dofStr = (arr: any) => (Array.isArray(arr) ? arr.filter((d: string) => ["FX","FY","FZ","MX","MY","MZ"].includes(d)) : []);
    // RELEASE 分組:key = `S:..|E:..`
    const relGroups = new Map<string, { start: string[]; end: string[]; ids: number[] }>();
    const truss: number[] = [], tension: number[] = [], compression: number[] = [], cable: number[] = [];
    for (const m of members as any[]) {
      const r = m.release;
      if (!r || !r.type) continue;
      if (r.type === "TRUSS") { truss.push(m.id); continue; }
      if (r.type === "TENSION") { tension.push(m.id); continue; }
      if (r.type === "COMPRESSION") { compression.push(m.id); continue; }
      if (r.type === "CABLE") { cable.push(m.id); continue; }
      // RELEASE
      const s = _dofStr(r.start), e = _dofStr(r.end);
      if (!s.length && !e.length) continue;   // 空釋放略過
      const key = `S:${s.join(" ")}|E:${e.join(" ")}`;
      if (!relGroups.has(key)) relGroups.set(key, { start: s, end: e, ids: [] });
      relGroups.get(key)!.ids.push(m.id);
    }
    if (relGroups.size) {
      lines.push("MEMBER RELEASE");
      for (const g of relGroups.values()) {
        if (g.start.length) _writeIdLines(g.ids, `START ${g.start.join(" ")}`);
        if (g.end.length)   _writeIdLines(g.ids, `END ${g.end.join(" ")}`);
      }
    }
    if (truss.length)       { lines.push("MEMBER TRUSS");       _writeIdLines(truss, ""); }
    if (tension.length)     { lines.push("MEMBER TENSION");     _writeIdLines(tension, ""); }
    if (compression.length) { lines.push("MEMBER COMPRESSION"); _writeIdLines(compression, ""); }
    if (cable.length)       { lines.push("MEMBER CABLE");       _writeIdLines(cable, ""); }
  }
  // === SUPPORTS:有支承的 joint → 依「STAAD 規格字串」分組輸出 ===
  //   STAAD 格式:
  //     SUPPORTS
  //     1 5 9 TO 12 FIXED
  //     20 21 PINNED
  //     30 FIXED BUT MX MY MZ
  //     40 FIXED BUT KFY 15000 KMX 200
  //     50 ENFORCED
  //   相同規格的節點壓進同一組(TO range);FIXED / PINNED 先輸出,其餘依字串排序。
  {
    const specToIds = new Map<string, number[]>();
    for (const j of joints as any[]) {
      if (!supportTypeOf(j)) continue;
      const spec = supportStaadSpec(j.support);
      if (!specToIds.has(spec)) specToIds.set(spec, []);
      specToIds.get(spec)!.push(j.id);
    }
    if (specToIds.size) {
      lines.push("SUPPORTS");
      // 跟 MEMBER PROPERTY 一樣壓 TO range,每列 ≤ 6 slot
      const _writeSupportLines = (ids: number[], kind: string) => {
        if (!ids.length) return;
        const segs = _idsToSegs(ids);
        const MAX_SLOTS = 6;
        let buf = "", used = 0;
        const _flush = () => { if (buf) { lines.push(`${buf} ${kind}`); buf = ""; used = 0; } };
        for (const seg of segs) {
          const segSlots = seg.includes(" TO ") ? 3 : 1;
          if (used > 0 && used + segSlots > MAX_SLOTS) _flush();
          buf = buf ? `${buf} ${seg}` : seg;
          used += segSlots;
        }
        _flush();
      };
      // 輸出順序:FIXED、PINNED 先,其餘規格依字串排序(穩定輸出)
      const _specOrder = (s: string) => s === "FIXED" ? 0 : s === "PINNED" ? 1 : 2;
      const specs = [...specToIds.keys()].sort((a, b) => _specOrder(a) - _specOrder(b) || a.localeCompare(b));
      for (const spec of specs) _writeSupportLines(specToIds.get(spec)!, spec);
    }
  }
  lines.push("FINISH");
  // 用 jobName 當預設檔名,讓使用者按「另存」對話框時可以直接看到專案名
  const _jobName = (($("jobName") as HTMLInputElement)?.value || "model")
    .replace(/[\\\/:*?"<>|]/g, "_").trim() || "model";
  const suggestedName = `${_jobName}.std`;
  saveFileWithPicker({
    suggestedName,
    types: [{ description: "STAAD input file", accept: { "text/plain": [".std"] } }],
    data: lines.join("\n"),
    mime: "text/plain",
  }).then(r => {
    if (r.ok && $("hud")) $("hud").textContent = `匯出 .std 完成・${joints.length} 節點 / ${members.length} 桿件`;
    else if (r.cancelled && $("hud")) $("hud").textContent = "已取消 .std 匯出";
  });
  // 撞號 fallback 集中通知(buildModel 已收集,console 也有 detail)
  setTimeout(() => { try { showBuildModelCollisionsIfAny(".std 匯出"); } catch (_) {} }, 50);
}
