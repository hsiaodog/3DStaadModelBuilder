// Rank cache — 把所有檔案 / 頁面的 joint 世界座標分軸 unique 化、給 rank
//   YYZZXX / XXZZYY 顯示編號的核心:displayId 就是各軸 rank padding 後 concat
//   Y 軸特例:依 floorType + braceType 分桶(共用 ALLOWED_YY 池),每桶從 yyStart 起編
//
//   架構:
//     _rankCache:module-level mutable 物件,跨呼叫共用
//     invalidateRankCache():外面任何會影響 rank 的 mutation 都該呼叫(座標 / capacity / floorTypes 改變)
//     _ensureRankCache():lazy 重建,signature 不變就 skip

import { state, _fileHasFullSetup, _getJointMemberDirs, _hasAnyPerpPair, _allDirsCollinear } from "../legacy";
import { joint2DToWorld3D } from "./projection";

interface RankCacheShape {
  dirty: boolean;
  x: Map<number, number> | null;
  y: Map<number, number> | null;
  z: Map<number, number> | null;
  signature: string | null;
  anchorMax?: { x: number; y: number; z: number };
  braceRanks?: Set<number>;
  demotedGids?: Set<number>;
  unboundDemoted?: WeakSet<object>;
  gidPlanes?: Map<number, Set<string>>;
  _lastOverflowAlertAt?: number;
}

export const _rankCache: RankCacheShape = { dirty: true, x: null, y: null, z: null, signature: null };

export function invalidateRankCache(): void {
  _rankCache.dirty = true;
}

/** 取得「用來算 rank 的世界座標」— 綁過 globalJoint 用 gj 座標(跨檔同物理點),否則本頁投影 */
export function _worldForRank(file: any, page: any, joint: any) {
  if (joint && joint.globalId != null && Array.isArray((state as any).globalJoints)) {
    const gj = (state as any).globalJoints.find((g: any) => g.id === joint.globalId);
    if (gj && Number.isFinite(gj.x) && Number.isFinite(gj.y) && Number.isFinite(gj.z)) {
      return { x: gj.x, y: gj.y, z: gj.z };
    }
  }
  return joint2DToWorld3D(file, page, joint);
}

/** 軸 capacity:state.numberCapacityX/Y/Z;只接受 9 / 99 / 999,其他都退回 99 */
export function _axisCap(ax: "x" | "y" | "z"): number {
  const s = state as any;
  const v = ax === "x" ? s.numberCapacityX : ax === "y" ? s.numberCapacityY : s.numberCapacityZ;
  const n = Number(v);
  return n === 9 || n === 99 || n === 999 ? n : 99;
}

export function _ensureRankCache(): void {
  const s = state as any;
  const md = Math.max(0, Math.min(6, Number.isFinite(s.measureDecimals) ? s.measureDecimals : 0));
  const capX = _axisCap("x"), capY = _axisCap("y"), capZ = _axisCap("z");
  const ftSig = (Array.isArray(s.floorTypes) ? s.floorTypes : [])
    .map((t: any) => `${t.key}:${t.yyStart || 1}`).join(",");
  const sig = `p=${s.numberPriority}|md=${md}|cx=${capX}|cy=${capY}|cz=${capZ}|files=${s.files.length}|gj=${(s.globalJoints || []).length}|ft=${ftSig}|sort=wrap`;
  if (!_rankCache.dirty && _rankCache.signature === sig) return;

  const cls: Record<"x" | "y" | "z", { ortho: Set<number>; anchorVal: Set<number> }> = {
    x: { ortho: new Set(), anchorVal: new Set() },
    y: { ortho: new Set(), anchorVal: new Set() },
    z: { ortho: new Set(), anchorVal: new Set() },
  };
  const demotedGids = new Set<number>();
  const manualAnchorGids = new Set<number>();
  const unboundDemoted = new WeakSet<object>();
  const gidPlanes = new Map<number, Set<string>>();
  const _scanInfos: any[] = [];
  const round = (v: number): number => {
    const r = parseFloat(v.toFixed(md));
    return r === 0 ? 0 : r;
  };
  const tol = Math.pow(10, -md);

  for (const f of s.files) {
    if (!_fileHasFullSetup(f)) continue;
    for (const pg of Object.values(f.pages || {}) as any[]) {
      if (!pg || pg._orphan) continue;
      for (const j of pg.joints || []) {
        const w = _worldForRank(f, pg, j);
        if (!w) continue;
        for (const ax of ["x", "y", "z"] as const) cls[ax].ortho.add(round(w[ax]));
        if (j.globalId != null && pg.plane) {
          let pl = gidPlanes.get(j.globalId);
          if (!pl) { pl = new Set(); gidPlanes.set(j.globalId, pl); }
          pl.add(pg.plane);
        }
        if (j.isAnchor && j.globalId != null) manualAnchorGids.add(j.globalId);
        const dirs = _getJointMemberDirs(j, pg);
        const hasPerpPair = _hasAnyPerpPair(dirs);
        const localIsAnchor =
          !!j.isAnchor ||
          dirs.length < 2 ||
          hasPerpPair ||
          _allDirsCollinear(dirs);
        _scanInfos.push({ j, pg, w, gid: j.globalId, hasPerpPair, localIsAnchor });
      }
    }
  }

  const caps = { x: capX, y: capY, z: capZ } as const;
  const overflow = { x: 0, y: 0, z: 0 };
  const _wrapPosSort = (a: number, b: number) => {
    if (a === 0) return b === 0 ? 0 : -1;
    if (b === 0) return 1;
    if (a > 0 && b < 0) return -1;
    if (a < 0 && b > 0) return 1;
    return a - b;
  };

  const coordAnchorGids = new Set<number>(manualAnchorGids);
  for (const [gid, pl] of gidPlanes) if (pl.size >= 3) coordAnchorGids.add(gid);
  for (const info of _scanInfos) {
    if (info.gid != null && info.hasPerpPair) coordAnchorGids.add(info.gid);
  }
  for (const info of _scanInfos) {
    const isCoordAnchor = info.gid != null
      ? coordAnchorGids.has(info.gid)
      : (info.hasPerpPair || (info.localIsAnchor && info.j.isAnchor));
    if (isCoordAnchor) {
      for (const ax of ["x", "y", "z"] as const) cls[ax].anchorVal.add(round(info.w[ax]));
    }
  }
  const finalAnchorGids = new Set<number>(manualAnchorGids);
  for (const [gid, pl] of gidPlanes) if (pl.size >= 3) finalAnchorGids.add(gid);
  for (const info of _scanInfos) {
    if (info.gid != null && info.localIsAnchor) finalAnchorGids.add(info.gid);
  }
  for (const info of _scanInfos) {
    const isAnchor = info.gid != null
      ? finalAnchorGids.has(info.gid)
      : info.localIsAnchor;
    if (!isAnchor) {
      if (info.gid != null) demotedGids.add(info.gid);
      else unboundDemoted.add(info.j);
    }
  }

  const _anchorMax = { x: 0, y: 0, z: 0 };
  // Y → typeKey 對應規則(floor 優先 → braceYZ → braceXY → default)
  const yToType = new Map<number, string>();
  for (const f of s.files) {
    for (const pg of Object.values(f.pages || {}) as any[]) {
      if (!pg || pg._orphan || pg.plane !== "XZ") continue;
      if (pg.z == null || !Number.isFinite(pg.z)) continue;
      const ry = round(pg.z);
      const tk = pg.floorType || "default";
      if (!yToType.has(ry)) yToType.set(ry, tk);
    }
  }
  const yToBraceType = new Map<number, string>();
  for (const wantPlane of ["YZ", "XY"] as const) {
    for (const f of s.files) {
      if (!_fileHasFullSetup(f)) continue;
      for (const pg of Object.values(f.pages || {}) as any[]) {
        if (!pg || pg._orphan) continue;
        if (pg.plane !== wantPlane) continue;
        const btk = pg.braceType;
        if (!btk || btk === "default") continue;
        for (const j of pg.joints || []) {
          const w = _worldForRank(f, pg, j);
          if (!w) continue;
          const ry = round(w.y);
          if (yToType.has(ry)) continue;
          if (!yToBraceType.has(ry)) yToBraceType.set(ry, btk);
        }
      }
    }
  }

  for (const ax of ["x", "y", "z"] as const) {
    const c = caps[ax];
    if (ax === "y") {
      const types = Array.isArray(s.floorTypes) && s.floorTypes.length
        ? s.floorTypes
        : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
      const typeMap = new Map<string, any>();
      for (const t of types) {
        typeMap.set(t.key, {
          key: t.key,
          yyStart: t.yyStart || 1,
          anchorVals: [] as number[],
          demotedOnly: [] as number[],
          kind: t.kind === "brace" ? "brace" : "floor",
        });
      }
      if (!typeMap.has("default")) {
        typeMap.set("default", {
          key: "default", yyStart: 1, anchorVals: [], demotedOnly: [], kind: "floor",
        });
      }
      for (const v of cls.y.ortho) {
        const tk = yToType.get(v) || yToBraceType.get(v) || "default";
        const bucket = typeMap.get(tk) || typeMap.get("default")!;
        if (cls.y.anchorVal.has(v)) bucket.anchorVals.push(v);
        else bucket.demotedOnly.push(v);
      }
      const map = new Map<number, number>();
      const braceRanks = new Set<number>();
      let overallAnchorMax = 0;
      for (const t of typeMap.values()) {
        t.anchorVals.sort(_wrapPosSort);
        t.demotedOnly.sort(_wrapPosSort);
        let rank = t.yyStart;
        const isBraceBucket = t.kind === "brace";
        const assign = (arr: number[]) => {
          for (const v of arr) {
            const r = Math.min(rank, c);
            map.set(v, r);
            if (isBraceBucket) braceRanks.add(r);
            if (rank > c) overflow.y++;
            rank++;
          }
        };
        assign(t.anchorVals);
        if (!isBraceBucket) {
          const lastAnchorRank = t.anchorVals.length ? (t.yyStart + t.anchorVals.length - 1) : 0;
          if (lastAnchorRank > overallAnchorMax) overallAnchorMax = Math.min(lastAnchorRank, c);
        }
        assign(t.demotedOnly);
      }
      _anchorMax.y = overallAnchorMax;
      _rankCache.y = map;
      _rankCache.braceRanks = braceRanks;
      continue;
    }
    const anchorVals = [...cls[ax].anchorVal].sort(_wrapPosSort);
    const demotedOnly = [...cls[ax].ortho].filter(v => !cls[ax].anchorVal.has(v)).sort(_wrapPosSort);
    const map = new Map<number, number>();
    let rank = 1;
    const assign = (arr: number[]) => {
      for (const v of arr) {
        map.set(v, Math.min(rank, c));
        if (rank > c) overflow[ax]++;
        rank++;
      }
    };
    assign(anchorVals);
    _anchorMax[ax] = Math.min(anchorVals.length, c);
    assign(demotedOnly);
    _rankCache[ax] = map;
  }
  _rankCache.anchorMax = _anchorMax;
  _rankCache.demotedGids = demotedGids;
  _rankCache.unboundDemoted = unboundDemoted;
  _rankCache.gidPlanes = gidPlanes;

  // diagnostic stats(維持與舊版相同的 console 行為)
  {
    const stats: any = {};
    for (const ax of ["x", "y", "z"] as const) {
      const all = [...cls[ax].ortho];
      const sorted = [...new Set(all)].sort((a, b) => a - b);
      const tightPairs: any[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i] - sorted[i - 1];
        if (d < tol * 5) tightPairs.push({ a: sorted[i - 1], b: sorted[i], d: +d.toFixed(2) });
      }
      tightPairs.sort((p, q) => p.d - q.d);
      stats[ax.toUpperCase()] = {
        uniqueCount: sorted.length,
        cap: caps[ax],
        firstFew: sorted.slice(0, 30).map(v => +v.toFixed(1)),
        nearAdjacentPairs: tightPairs.slice(0, 10),
      };
    }
    console.log("[rank cache] 每軸 unique 座標統計", stats, "(tol=" + tol + " mm)");
    (window as any)._lastRankCacheStats = stats;
  }

  if (overflow.x || overflow.y || overflow.z) {
    const overflowParts: string[] = [];
    const axisDiag: any = {};
    for (const ax of ["x", "y", "z"] as const) {
      if (!overflow[ax]) continue;
      const all = [...cls[ax].ortho];
      const sorted = [...new Set(all)].sort((a, b) => a - b);
      const cap = caps[ax];
      overflowParts.push(`${ax.toUpperCase()} 有 ${sorted.length} 個 unique 座標(cap ${cap})`);
      const tightPairs: any[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i] - sorted[i - 1];
        if (d < tol * 5) tightPairs.push({ a: sorted[i - 1], b: sorted[i], d });
      }
      tightPairs.sort((p, q) => p.d - q.d);
      axisDiag[ax] = { unique: sorted.length, cap, sample: sorted, tightPairs: tightPairs.slice(0, 5) };
    }
    console.warn(`[rank cache] 超出 capacity(X=${capX}/Y=${capY}/Z=${capZ}):${overflowParts.join("、")}`, axisDiag);
    if (Date.now() - (_rankCache._lastOverflowAlertAt || 0) > 5000) {
      _rankCache._lastOverflowAlertAt = Date.now();
      setTimeout(() => {
        const lines = ["⚠ 節點編號 capacity 超出 — 多個座標被 cap 成同 rank,導致 ID 重複\n"];
        for (const ax of ["x", "y", "z"] as const) {
          if (!axisDiag[ax]) continue;
          const d = axisDiag[ax];
          lines.push(`【${ax.toUpperCase()} 軸】 unique ${d.unique} 個(cap ${d.cap})`);
          if (d.tightPairs.length) {
            lines.push("  疑似校準誤差造成的鄰近 bucket(差距小於 tol×5):");
            for (const p of d.tightPairs) {
              lines.push(`    ${p.a.toFixed(2)} ↔ ${p.b.toFixed(2)} (差 ${p.d.toFixed(2)} mm)`);
            }
          }
          lines.push(`  前 20 個座標值:[${d.sample.slice(0, 20).map((v: number) => v.toFixed(1)).join(", ")}]${d.sample.length > 20 ? ` …(共 ${d.sample.length})` : ""}`);
          lines.push("");
        }
        lines.push("可能原因:");
        lines.push("  1. 跨檔案 / 跨頁的 calibration(planeOrigin / scaleRuler)有誤差 → 同物理位置在不同檔案得到稍不同的世界座標");
        lines.push("  2. 「誤差範圍」(numberTolerance) 太小,鄰近 bucket 沒合併");
        lines.push("  3. 真的存在那麼多 unique 位置(超過軸 capacity)");
        lines.push("");
        lines.push("建議:");
        lines.push("  • 先把「誤差範圍」調大(右側欄,現在 " + tol + " mm → 試 10 mm)");
        lines.push("  • 或把該軸最大編號調成 999");
        lines.push("  • 跨檔的「同物理位置」joint 用「三視圖自動配對」綁同一個 globalJoint,讓世界座標統一");
        alert(lines.join("\n"));
      }, 0);
    }
  } else {
    _rankCache._lastOverflowAlertAt = 0;
  }
  _rankCache.signature = sig;
  _rankCache.dirty = false;
}
