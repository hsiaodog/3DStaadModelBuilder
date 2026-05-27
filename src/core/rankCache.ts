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
import { wrapPosSort as _wrapPosSort } from "../utils/sort";
import { setDebugVar, getDebugVar } from "../utils/debug";

interface RankCacheShape {
  dirty: boolean;
  x: Map<number, number> | null;
  y: Map<number, number> | null;   // fallback:Y-value-only(不分桶,給未綁定 globalJoint 的散點用)
  // ★ per-joint Y rank,key = `${rx}|${ry}|${rz}`(3D 座標 round 後的字串)
  //   讓「同 Y 不同 (X,Z) 的 joint」可以落在不同 bucket → 不同 rank
  //   修補:gid=2287 在 Z=0(只接 XY brace)跟 gid=3024 在 Z=1700(接 YZ brace)
  //         過去都因為 Y=7855 那層 yToBraceType 寫成 brace_yz 而同被歸 YZ;現在按 joint 自己的
  //         斜撐端點所屬平面分桶,各自落在 brace_xy / brace_yz bucket
  yBy3D: Map<string, number> | null;
  z: Map<number, number> | null;
  signature: string | null;
  anchorMax?: { x: number; y: number; z: number };
  braceRanks?: Set<number>;
  demotedGids?: Set<number>;
  unboundDemoted?: WeakSet<object>;
  gidPlanes?: Map<number, Set<string>>;
  _lastOverflowAlertAt?: number;
}

export const _rankCache: RankCacheShape = { dirty: true, x: null, y: null, yBy3D: null, z: null, signature: null };

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
  // ★ Per-3D-position bucket 分類(取代舊的 Y-value-only / per-gid 兩種版本)
  //   bucket key = `${rx}|${ry}|${rz}`(世界座標 round 過的字串)— 不依賴 globalJoint
  //   優點:同物理位置不管有沒有綁 gid 都是同一 bucket,跨 3D 一鍵處理的 transient state
  //         (step 2 清空 gjs → step 3 重建 gjs)也成立。
  //
  //   優先順序:XZ floor > brace_xy > brace_yz > default
  const coordToBucket = new Map<string, string>();
  const _coordKey = (w: { x: number; y: number; z: number } | null | undefined) => {
    if (!w) return null;
    return `${round(w.x)}|${round(w.y)}|${round(w.z)}`;
  };
  // Pass 1:XZ floor(最高優先)— 每個 XZ 頁的所有 joint 套該頁的 floorType
  for (const f of s.files) {
    for (const pg of Object.values(f.pages || {}) as any[]) {
      if (!pg || pg._orphan || pg.plane !== "XZ") continue;
      const ft = pg.floorType || "default";
      for (const j of pg.joints || []) {
        const w = _worldForRank(f, pg, j);
        const k = _coordKey(w);
        if (k && !coordToBucket.has(k)) coordToBucket.set(k, ft);
      }
    }
  }
  // Pass 2 / 3:brace_xy / brace_yz — 只收該頁上斜撐 member 的端點(柱/樑端點不算)
  //   判定:page-local 2D 兩端 dx 跟 dy 都明顯非零 → 該 member 是斜撐
  const _braceEndpointDxTol = 5;
  const _scanBracePlane = (wantPlane: "YZ" | "XY") => {
    for (const f of s.files) {
      if (!_fileHasFullSetup(f)) continue;
      for (const pg of Object.values(f.pages || {}) as any[]) {
        if (!pg || pg._orphan || pg.plane !== wantPlane) continue;
        const btk = pg.braceType;
        if (!btk || btk === "default") continue;
        const _jmap = new Map<number, any>();
        for (const j of pg.joints || []) _jmap.set(j.id, j);
        const _braceJointIds = new Set<number>();
        for (const m of pg.members || []) {
          const ja = _jmap.get(m.j1), jb = _jmap.get(m.j2);
          if (!ja || !jb) continue;
          const dx = Math.abs((ja.x ?? 0) - (jb.x ?? 0));
          const dy = Math.abs((ja.y ?? 0) - (jb.y ?? 0));
          if (dx > _braceEndpointDxTol && dy > _braceEndpointDxTol) {
            _braceJointIds.add(m.j1);
            _braceJointIds.add(m.j2);
          }
        }
        for (const j of pg.joints || []) {
          if (!_braceJointIds.has(j.id)) continue;
          const w = _worldForRank(f, pg, j);
          const k = _coordKey(w);
          if (k && !coordToBucket.has(k)) coordToBucket.set(k, btk);
        }
      }
    }
  };
  // brace_xy 先掃,brace_yz 後掃 — 同時是兩種 brace 端點時優先 XY
  _scanBracePlane("XY");
  _scanBracePlane("YZ");
  // 取得任一 scanInfo 對應 joint 的 bucketKey:用 (rx, ry, rz) 查
  const _bucketOf = (info: any): string => {
    const k = _coordKey(info.w);
    if (k && coordToBucket.has(k)) return coordToBucket.get(k)!;
    return "default";
  };

  // 向下相容:還是建一份 yToType / yToBraceType,讓只有 Y 值能查的舊呼叫端(目前只剩 fallback)能用
  //   priority:floor > brace(first non-default seen)。同 Y 不同 bucket 取「首見」。
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
  for (const info of _scanInfos) {
    const bk = _bucketOf(info);
    if (bk === "default") continue;
    const ry = round(info.w.y);
    if (yToType.has(ry)) continue;
    if (!yToBraceType.has(ry)) yToBraceType.set(ry, bk);
  }

  for (const ax of ["x", "y", "z"] as const) {
    const c = caps[ax];
    if (ax === "y") {
      // ★ Per-joint Y rank:每個 joint 套自己的 bucket(_bucketOf 算出),Y rank 在該 bucket 內計算
      //   舊版用 Y-value-only 分桶 → 同 Y 不同 (X,Z) 的 joint 同 rank,無法區分 brace 來源
      //   新版用 (rx, ry, rz) 3D key,因為同位置 joint 必定同 bucket(globalJoint 跨頁共用),
      //   不同位置可能不同 bucket
      const types = Array.isArray(s.floorTypes) && s.floorTypes.length
        ? s.floorTypes
        : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
      const typeMap = new Map<string, any>();
      for (const t of types) {
        typeMap.set(t.key, {
          key: t.key,
          yyStart: t.yyStart || 1,
          // anchor / demoted 改存 set,因為同一 Y 值可能被多個 joint 對應而重複加入
          anchorYSet: new Set<number>(),
          demotedYSet: new Set<number>(),
          kind: t.kind === "brace" ? "brace" : "floor",
        });
      }
      if (!typeMap.has("default")) {
        typeMap.set("default", {
          key: "default", yyStart: 1, anchorYSet: new Set<number>(), demotedYSet: new Set<number>(), kind: "floor",
        });
      }
      // 把每個 scanInfo 的 Y 值收進對應 bucket(以 joint 為單位,不是 Y 值)
      //   若同 Y 在不同 bucket 都出現,各 bucket 都會記錄 → 各自有 rank,(rx,ry,rz) 區分
      //   ★ 兩-pass 設計:先把所有 anchor Y 加進 anchorYSet,再把 non-anchor Y 加進 demotedYSet
      //     (排除已在 anchorYSet 的)。避免單-pass 時若 demoted scanInfo 先到、anchor 後到,
      //     會發生 ry 同時在兩個 set → rank 計數器多跳一次 → 撐爆 cap → 觸發 overflow 警示。
      // Pass 1: 全部 anchor Y 入 anchorYSet
      for (const info of _scanInfos) {
        const isAnchor = info.gid != null
          ? finalAnchorGids.has(info.gid)
          : info.localIsAnchor;
        if (!isAnchor) continue;
        const bk = _bucketOf(info);
        const bucket = typeMap.get(bk) || typeMap.get("default")!;
        bucket.anchorYSet.add(round(info.w.y));
      }
      // Pass 2: 全部 non-anchor Y 入 demotedYSet(排除已在 anchorYSet 的)
      for (const info of _scanInfos) {
        const isAnchor = info.gid != null
          ? finalAnchorGids.has(info.gid)
          : info.localIsAnchor;
        if (isAnchor) continue;
        const bk = _bucketOf(info);
        const bucket = typeMap.get(bk) || typeMap.get("default")!;
        const ry = round(info.w.y);
        if (!bucket.anchorYSet.has(ry)) bucket.demotedYSet.add(ry);
      }
      // 建 (rx, ry, rz) → Y rank 的對應(per-3D-position)
      //   先把每個 bucket 內的 Y values 排好 rank,再用 _scanInfos 把每個 joint 的 (rx,ry,rz) 對應到 rank
      const bucketYRank = new Map<string, Map<number, number>>();   // bucketKey → Map<Yvalue, rank>
      const yByValueFallback = new Map<number, number>();           // fallback:Y value → first-assigned rank
      const braceRanks = new Set<number>();
      let overallAnchorMax = 0;
      // ★ 算每個 bucket 的「實際 cap」= 下個 bucket 的 yyStart - 1(若是最後一個 bucket → c)
      //   修補:若 brace_xy yyStart=61、default yyStart=71,brace_xy 只能用 61..70(10 個 slot);
      //         超過 → 與 default 的 rank 71 撞,xlsx / std 匯出時 display ID 會撞號 fallback。
      //   檢出 overflow 時錯誤訊息要指出是哪個 bucket 撐爆 + 建議解法(調大下一個 bucket 的 yyStart)。
      const _sortedBuckets = [...typeMap.values()].sort((a, b) => (a.yyStart || 1) - (b.yyStart || 1));
      const _bucketEffCap = new Map<string, number>();
      for (let i = 0; i < _sortedBuckets.length; i++) {
        const t = _sortedBuckets[i];
        const next = _sortedBuckets[i + 1];
        const effCap = next ? Math.min(c, (next.yyStart || 1) - 1) : c;
        _bucketEffCap.set(t.key, effCap);
      }
      // 收集每個 bucket 的 overflow 詳情(供 alert 顯示)
      const _bucketOverflows: Array<{ key: string; yyStart: number; total: number; effCap: number; needed: number }> = [];
      for (const t of typeMap.values()) {
        const sortedAnchor = [...t.anchorYSet].sort(_wrapPosSort);
        const sortedDemoted = [...t.demotedYSet].sort(_wrapPosSort);
        let rank = t.yyStart;
        const isBraceBucket = t.kind === "brace";
        const bMap = new Map<number, number>();
        bucketYRank.set(t.key, bMap);
        const effCap = _bucketEffCap.get(t.key) ?? c;
        const totalY = sortedAnchor.length + sortedDemoted.length;
        const neededMax = t.yyStart + totalY - 1;
        if (neededMax > effCap) {
          _bucketOverflows.push({ key: t.key, yyStart: t.yyStart, total: totalY, effCap, needed: neededMax });
          overflow.y++;
        }
        const assign = (arr: number[]) => {
          for (const v of arr) {
            const r = Math.min(rank, effCap);   // ★ 用 bucket-specific cap,避免跨 bucket 撞 rank
            bMap.set(v, r);
            // fallback:Y-value-only 表只記首見 rank(同 Y 多 bucket 時取第一個);
            //   只供未綁定 globalJoint 的散點查詢,正式查詢都走 yBy3D
            if (!yByValueFallback.has(v)) yByValueFallback.set(v, r);
            if (isBraceBucket) braceRanks.add(r);
            rank++;
          }
        };
        assign(sortedAnchor);
        if (!isBraceBucket) {
          const lastAnchorRank = sortedAnchor.length ? (t.yyStart + sortedAnchor.length - 1) : 0;
          if (lastAnchorRank > overallAnchorMax) overallAnchorMax = Math.min(lastAnchorRank, c);
        }
        assign(sortedDemoted);
      }
      // 暴露給 alert 用
      setDebugVar("_lastRankCacheBucketOverflows", _bucketOverflows);
      // 把每個 joint 的 (rx, ry, rz) 對應到該 bucket 內的 Y rank
      const yBy3D = new Map<string, number>();
      for (const info of _scanInfos) {
        const bk = _bucketOf(info);
        const bMap = bucketYRank.get(bk) || bucketYRank.get("default");
        if (!bMap) continue;
        const rx = round(info.w.x), ry = round(info.w.y), rz = round(info.w.z);
        const r = bMap.get(ry);
        if (r == null) continue;
        const key = `${rx}|${ry}|${rz}`;
        // 同 3D 位置可能有多個 scanInfo(跨頁同 gid)— 取第一個寫入即可
        if (!yBy3D.has(key)) yBy3D.set(key, r);
      }
      _anchorMax.y = overallAnchorMax;
      _rankCache.y = yByValueFallback;
      _rankCache.yBy3D = yBy3D;
      _rankCache.braceRanks = braceRanks;
      // ★ Debug 用:把每個 bucket 內的 Y 值 + 預期最大 rank 暴露到 window,方便 console 抓出爆 cap 的 bucket
      const _dbg: any = {};
      for (const t of typeMap.values()) {
        const a = [...t.anchorYSet].sort(_wrapPosSort);
        const dy = [...t.demotedYSet].sort(_wrapPosSort);
        const total = a.length + dy.length;
        const maxRank = total > 0 ? t.yyStart + total - 1 : t.yyStart;
        _dbg[t.key] = {
          yyStart: t.yyStart,
          anchorYCount: a.length, demotedYCount: dy.length, totalY: total,
          maxRank, overflows: maxRank > c,
          anchorYs: a, demotedYs: dy,
        };
      }
      setDebugVar("_lastRankCacheYBuckets", _dbg);
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
    console.log("[rank cache v2-twopass] 每軸 unique 座標統計", stats, "(tol=" + tol + " mm)");
    setDebugVar("_lastRankCacheStats", stats);
    setDebugVar("_rankCacheBuildVersion", "v2-twopass");
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
        // ★ 若是 Y 軸 overflow,印出哪個 bucket 撐爆 + 建議怎麼調 yyStart
        const bucketOverflows = getDebugVar<Array<{ key: string; yyStart: number; total: number; effCap: number; needed: number }>>("_lastRankCacheBucketOverflows");
        if (axisDiag.y && bucketOverflows && bucketOverflows.length) {
          lines.push("【Y 軸 bucket 撐爆細節】");
          // 按 yyStart 排,讓使用者知道下一個 bucket 是誰
          const sortedTypes = [...((s.floorTypes as any[]) || [])].sort((a, b) => (a.yyStart || 1) - (b.yyStart || 1));
          for (const bo of bucketOverflows) {
            const idx = sortedTypes.findIndex(t => t.key === bo.key);
            const nextT = idx >= 0 ? sortedTypes[idx + 1] : null;
            const nextStr = nextT ? `${nextT.label || nextT.key}(yyStart=${nextT.yyStart})` : "(無 — 已到 cap 99)";
            lines.push(`  • bucket「${bo.key}」yyStart=${bo.yyStart}・有 ${bo.total} 個 unique Y → 需要 rank 到 ${bo.needed},但被下一個 bucket 卡在 ${bo.effCap}`);
            lines.push(`    建議:把下一個 bucket「${nextStr}」的 yyStart 調大到至少 ${bo.needed + 1}`);
          }
          lines.push("");
          lines.push("(調整位置:節點編號管理 dialog → 樓層類型 / 斜撐起始 tab → 改 yyStart)");
        } else {
          lines.push("可能原因:");
          lines.push("  1. 跨檔案 / 跨頁的 calibration(planeOrigin / scaleRuler)有誤差 → 同物理位置在不同檔案得到稍不同的世界座標");
          lines.push("  2. 「誤差範圍」(numberTolerance) 太小,鄰近 bucket 沒合併");
          lines.push("  3. 真的存在那麼多 unique 位置(超過軸 capacity)");
          lines.push("");
          lines.push("建議:");
          lines.push("  • 先把「誤差範圍」調大(右側欄,現在 " + tol + " mm → 試 10 mm)");
          lines.push("  • 或把該軸最大編號調成 999");
          lines.push("  • 跨檔的「同物理位置」joint 用「三視圖自動配對」綁同一個 globalJoint,讓世界座標統一");
        }
        alert(lines.join("\n"));
      }, 0);
    }
  } else {
    _rankCache._lastOverflowAlertAt = 0;
  }
  _rankCache.signature = sig;
  _rankCache.dirty = false;
}
