// Export 共用 helper(.xlsx + .std 都用)
//   一次 build,兩條匯出路徑共用 — 拿掉原本在兩個 handler 各自定義一次的所有 setup
//   .xlsx / .std 拿到 ExportContext 後,只需專注在「怎麼把 model 寫成自己的格式」

import { state, displayMemberId } from "../legacy";
import { _rankCache, _ensureRankCache } from "../core/rankCache";
import { joint2DToWorld3D } from "../core/projection";

type Joint = { id: number; x: number; y: number; z: number };
type Member = { id: number; j1: number; j2: number };
type MemRow = { m: Member; cat: MemberCat; mat: string | null };
type MemberCat = "Y" | "X" | "Z" | "DXY" | "DYZ" | "DXZ";
type MemberPage = { pageName: string; elev: number };
type JointRank = { xr: number | null; zr: number | null; yr?: number | null };

export interface ExportContext {
  joints: Joint[];
  members: Member[];
  /** joint.id → joint object(快查座標) */
  jWorldById: Map<number, Joint>;
  /** joint.id → 該 joint 各軸 rank */
  rankByJointId: Map<number, JointRank>;
  /** 3D 方向分類(用 cos(3°) ≈ 0.9986 軸向門檻)*/
  classifyMember3D: (m: Member) => MemberCat;
  /** 桿件的 plane(只對「真斜桿」回 XY/YZ/XZ;主軸 / 太短的回 null) */
  planeForDiagMember: (m: Member) => "XY" | "YZ" | "XZ" | null;
  /** 從 page.members 找出該 displayId 對應的 material 字串(table 名) */
  memberMat: (m: Member) => string | null;
  /** material name → state.materials entry,取 table 欄用 */
  matObjByName: Map<string, any>;
  /** member.id → 來源 page 名(掃序 XZ → XY → YZ → 其他) */
  memberPageById: Map<number, MemberPage>;
  /** joint.id → 來源 XZ page 的 floorType key(無對應頁 → null)。anchor 節點才填,brace 不填。 */
  floorTypeByJointId: Map<number, string | null>;
  /** 全部 member rows(含 cat / mat),未分桶版;xlsx / std 統計材料筆數用 */
  memRows: MemRow[];
  /** 6 個分類 bucket(已依 ID 升序排好)*/
  memY: MemRow[];
  memXAxis: MemRow[];
  memZAxis: MemRow[];
  memBraceXZ: MemRow[];
  memBraceXY: MemRow[];
  memBraceYZ: MemRow[];
  /** Y 軸 anchor 段最大 rank(brace 判定用)*/
  yAnchorMax: number;
  /** brace-kind 桶的 rank Set(Phase 3 加的;_isBraceJoint 用)*/
  braceRanks: Set<number> | null;
  /** joint 是不是 brace joint(demote-only 段 + brace-kind anchor)*/
  isBraceJoint: (j: Joint) => boolean;
  /** brace joint 的最佳平面 vote(投票自連接它的斜桿件)*/
  braceJointPlane: (j: Joint) => "XY" | "YZ" | "XZ" | null;
  /** XX·ZZ 柱線小區內排序:Y → X → Z → ID */
  bySubBlockCoord: (a: Joint, b: Joint) => number;
  /** [1, 4, 5, 6, 9] → ["1", "4 TO 6", "9"] */
  idsToSegs: (ids: Iterable<number | string>) => string[];
  /** 給 _rndForRank 用的 measureDecimals(已 clamp 0-6)*/
  md: number;
  /** _rndForRank — bucket key 用,跟 rankCache 同邏輯 */
  rndForRank: (v: number) => number;
}

export function buildExportContext(model: { joints: Joint[]; members: Member[] }): ExportContext {
  const { joints, members } = model;
  const s = state as any;
  const jWorldById = new Map<number, Joint>(joints.map(j => [j.id, j]));

  // 桿件 3D 分類:cos(3°)≈0.9986 軸向門檻
  const classifyMember3D = (m: Member): MemberCat => {
    const a = jWorldById.get(m.j1), b = jWorldById.get(m.j2);
    if (!a || !b) return "DXZ";
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return "DXZ";
    const ax = Math.abs(dx) / len, ay = Math.abs(dy) / len, az = Math.abs(dz) / len;
    const T = 0.9986;
    if (ay > T) return "Y";
    if (ax > T) return "X";
    if (az > T) return "Z";
    if (az <= ax && az <= ay) return "DXY";
    if (ax <= ay && ax <= az) return "DYZ";
    return "DXZ";
  };

  // 桿件 plane(只回斜桿的 plane;主軸或太短回 null)
  const planeForDiagMember = (m: Member): "XY" | "YZ" | "XZ" | null => {
    const a = jWorldById.get(m.j1), b = jWorldById.get(m.j2);
    if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.5) return null;
    const ax = Math.abs(dx) / len, ay = Math.abs(dy) / len, az = Math.abs(dz) / len;
    const T = 0.9986;
    if (ax > T || ay > T || az > T) return null;
    if (az <= ax && az <= ay) return "XY";
    if (ax <= ay && ax <= az) return "YZ";
    return "XZ";
  };

  // 桿件來源頁面(掃序 XZ → XY → YZ → 其他;同 displayId 只記第一個 hit)
  const memberPageById = new Map<number, MemberPage>();
  for (const planeFilter of ["XZ", "XY", "YZ", null] as const) {
    for (const f of s.files) {
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k];
        if (!pg || pg._orphan) continue;
        const pgPlane = pg.plane || null;
        const match = planeFilter === null
          ? (pgPlane !== "XZ" && pgPlane !== "XY" && pgPlane !== "YZ")
          : (pgPlane === planeFilter);
        if (!match) continue;
        for (const mm of pg.members || []) {
          const dispId = typeof displayMemberId === "function" ? displayMemberId(mm) : mm.id;
          if (!memberPageById.has(dispId)) {
            memberPageById.set(dispId, {
              pageName: `${f.name}#${(+k) + 1}`,
              elev: Number.isFinite(pg.z) ? pg.z : Infinity,
            });
          }
        }
      }
    }
  }

  // 樓層類型 lookup:對每個 anchor 節點,找它源自的 XZ 頁面,記下該頁面的 floorType key。
  //   作法:掃所有 XZ 頁面(那才有 floorType),把頁面內每個 2D joint 投影到 3D,
  //   然後用 (rounded x, y, z) 為 key 比對 model.joints 找出對應的 STAAD id。
  //   若同一個 STAAD joint 在多個 XZ 頁出現,以第一個 hit 為準(掃描順序 = state.files 自然順序)。
  const floorTypeByJointId = new Map<number, string | null>();
  {
    const eps = 1e-4;
    const _coordKey = (x: number, y: number, z: number) =>
      `${Math.round(x / eps)}|${Math.round(y / eps)}|${Math.round(z / eps)}`;
    const idByCoord = new Map<string, number>();
    for (const j of joints) idByCoord.set(_coordKey(j.x, j.y, j.z), j.id);
    for (const f of s.files) {
      for (const k of Object.keys(f.pages || {})) {
        const pg = (f.pages as any)[k];
        if (!pg || pg._orphan) continue;
        if (pg.plane !== "XZ") continue;   // 只有 XZ 頁有 floorType
        const ftKey = pg.floorType || "default";
        for (const j2d of pg.joints || []) {
          let w: { x: number; y: number; z: number } | null = null;
          if (j2d.globalId != null) {
            const gj = (s.globalJoints || []).find((g: any) => g.id === j2d.globalId);
            if (gj && Number.isFinite(gj.x) && Number.isFinite(gj.y) && Number.isFinite(gj.z)) {
              w = { x: gj.x, y: gj.y, z: gj.z };
            }
          }
          if (!w) {
            const w2 = joint2DToWorld3D(f, pg, j2d);
            if (w2) w = { x: w2.x, y: w2.y, z: w2.z };
          }
          if (!w) continue;
          const sid = idByCoord.get(_coordKey(w.x, w.y, w.z));
          if (sid != null && !floorTypeByJointId.has(sid)) {
            floorTypeByJointId.set(sid, ftKey);
          }
        }
      }
    }
  }

  // 材料 lookup
  const memberMat = (m: Member): string | null => {
    for (const f of s.files) {
      for (const pg of Object.values(f.pages || {}) as any[]) {
        if (!pg || pg._orphan) continue;
        for (const mm of pg.members || []) {
          if (mm.material && (
            (typeof displayMemberId === "function" ? displayMemberId(mm) : mm.id) === m.id
          )) return mm.material;
        }
      }
    }
    return null;
  };
  const matObjByName = new Map<string, any>();
  if (Array.isArray(s.materials)) {
    for (const mm of s.materials) {
      const n = mm && mm.name ? String(mm.name).trim() : "";
      if (n && !matObjByName.has(n)) matObjByName.set(n, mm);
    }
  }

  // rank cache + joint rank lookup
  try { _ensureRankCache(); } catch (_) {}
  const md = Math.max(0, Math.min(6, Number.isFinite(s.measureDecimals) ? s.measureDecimals : 0));
  const rndForRank = (v: number) => {
    const r = parseFloat(v.toFixed(md));
    return r === 0 ? 0 : r;
  };
  const rankOf = (j: Joint): JointRank => {
    if (!_rankCache || !_rankCache.x || !_rankCache.y || !_rankCache.z) return { xr: null, zr: null, yr: null };
    return {
      xr: _rankCache.x.get(rndForRank(j.x)) || null,
      yr: _rankCache.y.get(rndForRank(j.y)) || null,
      zr: _rankCache.z.get(rndForRank(j.z)) || null,
    };
  };
  const rankByJointId = new Map<number, JointRank>();
  for (const j of joints) rankByJointId.set(j.id, rankOf(j));

  // 分桶:按 3D 方向
  const byId = (a: MemRow, b: MemRow) => (a.m.id || 0) - (b.m.id || 0);
  const memRows: MemRow[] = members.map(m => ({ m, cat: classifyMember3D(m), mat: memberMat(m) }));
  const memY: MemRow[] = [];
  const memXAxis: MemRow[] = [];
  const memZAxis: MemRow[] = [];
  const memBraceXZ: MemRow[] = [];
  const memBraceXY: MemRow[] = [];
  const memBraceYZ: MemRow[] = [];
  for (const mr of memRows) {
    switch (mr.cat) {
      case "Y":   memY.push(mr); break;
      case "X":   memXAxis.push(mr); break;
      case "Z":   memZAxis.push(mr); break;
      case "DXY": memBraceXY.push(mr); break;
      case "DYZ": memBraceYZ.push(mr); break;
      default:    memBraceXZ.push(mr);
    }
  }
  memY.sort(byId); memXAxis.sort(byId); memZAxis.sort(byId);
  memBraceXZ.sort(byId); memBraceXY.sort(byId); memBraceYZ.sort(byId);

  // brace 平面投票(從斜桿件兩端 vote)
  const bracePlaneVotes = new Map<number, Map<string, number>>();
  for (const m of members) {
    const pl = planeForDiagMember(m);
    if (!pl) continue;
    for (const jid of [m.j1, m.j2]) {
      let pm = bracePlaneVotes.get(jid);
      if (!pm) { pm = new Map(); bracePlaneVotes.set(jid, pm); }
      pm.set(pl, (pm.get(pl) || 0) + 1);
    }
  }
  const braceJointPlane = (j: Joint): "XY" | "YZ" | "XZ" | null => {
    const pm = bracePlaneVotes.get(j.id);
    if (!pm || pm.size === 0) return null;
    let best: "XY" | "YZ" | "XZ" | null = null;
    let bestCount = 0;
    for (const pl of ["XY", "YZ", "XZ"] as const) {
      const c = pm.get(pl) || 0;
      if (c > bestCount) { bestCount = c; best = pl; }
    }
    return best;
  };

  // brace joint 判定:demote-only 段 + brace-kind 桶 rank
  const yAnchorMax = (_rankCache && _rankCache.anchorMax && Number.isFinite(_rankCache.anchorMax.y))
    ? _rankCache.anchorMax.y : 0;
  const braceRanks = (_rankCache && _rankCache.braceRanks) || null;
  const isBraceJoint = (j: Joint): boolean => {
    const rk = rankByJointId.get(j.id);
    if (!rk || rk.yr == null) return false;
    if (yAnchorMax > 0 && rk.yr > yAnchorMax) return true;
    if (braceRanks && braceRanks.has(rk.yr)) return true;
    return false;
  };

  // 小區塊內排序:Y → X → Z → ID(rank cache 同 round)
  const bySubBlockCoord = (a: Joint, b: Joint): number => {
    const ay = rndForRank(a.y), by = rndForRank(b.y);
    if (ay !== by) return ay - by;
    const ax = rndForRank(a.x), bx = rndForRank(b.x);
    if (ax !== bx) return ax - bx;
    const az = rndForRank(a.z), bz = rndForRank(b.z);
    if (az !== bz) return az - bz;
    return (a.id || 0) - (b.id || 0);
  };

  // TO range 壓縮:[1,2,3,5,7,8] → ["1 TO 3", "5", "7 TO 8"]
  const idsToSegs = (ids: Iterable<number | string>): string[] => {
    const sorted = [...ids].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    });
    const segs: string[] = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length) {
        const cur = Number(sorted[j]), nxt = Number(sorted[j + 1]);
        if (Number.isFinite(cur) && Number.isFinite(nxt) && nxt === cur + 1) j++;
        else break;
      }
      if (j === i) segs.push(`${sorted[i]}`);
      else segs.push(`${sorted[i]} TO ${sorted[j]}`);
      i = j + 1;
    }
    return segs;
  };

  return {
    joints, members,
    jWorldById, rankByJointId,
    classifyMember3D, planeForDiagMember,
    memberMat, matObjByName, memberPageById, floorTypeByJointId,
    memRows,
    memY, memXAxis, memZAxis, memBraceXZ, memBraceXY, memBraceYZ,
    yAnchorMax, braceRanks, isBraceJoint, braceJointPlane,
    bySubBlockCoord, idsToSegs,
    md, rndForRank,
  };
}
