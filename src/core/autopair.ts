// 三視圖自動配對 — 跨平面共軸座標比對,提出 globalJoint 綁定候選
//   triples: XY+XZ+YZ 同時匹配(X, Y, Z 三軸都在 tol 內)→ 信心高
//   pairs:   只匹配 2 面 1 共軸 → 信心中等
//   貪心:先收 triples,該頁節點被綁就不再被別組搶
//
//   ⚠ 已知性能限制:O(N_XY × N_XZ × N_YZ);每平面 > 500 joint 會明顯卡頓。
//     建議用法:加 `withBusy` spinner 包起來,或事先估規模 + 提示。
//     真正解法是 spatial index(分桶,outer loop 只看同桶 / 鄰桶)。

import { state } from "../app/integration";
import { joint2DToWorld3D } from "./projection";
import { displayJointId } from "../app/integration";

export interface AutoPairCandidate {
  type: "triple" | "pair";
  members: Array<{
    fileId: number;
    fileName: string;
    pageIdx: number;
    jointId: number;
    plane: string;
    world: { x: number; y: number; z: number };
    dispJ: number | string;
  }>;
  /** 共軸最大差距(mm) — 越小越可靠 */
  score: number;
  /** triple 三軸個別差距 */
  axes?: { x: number; y: number; z: number };
  /** triple 三平面取平均後的世界座標 */
  world?: { x: number; y: number; z: number };
  /** pair 才有:共用的軸 */
  sharedAxis?: string;
}

export interface ProposeAutoPairingsOpts {
  /** 共軸座標可接受誤差(state.unitName 同單位,通常 mm)*/
  tol?: number;
  /** 是否含已綁定節點;預設 false */
  includeBound?: boolean;
}

export function proposeAutoPairings(opts: ProposeAutoPairingsOpts = {}): AutoPairCandidate[] {
  const tol = opts.tol != null ? opts.tol : 5;
  const includeBound = !!opts.includeBound;
  const buckets: Record<string, AutoPairCandidate["members"]> = { XY: [], XZ: [], YZ: [] };
  for (const f of (state as any).files) {
    for (const k in f.pages || {}) {
      const pg = f.pages[k];
      const plane = pg.plane || "XY";
      if (!buckets[plane]) continue;
      for (const j of pg.joints || []) {
        if (!includeBound && j.globalId != null) continue;
        const w = joint2DToWorld3D(f, pg, j);
        if (!w) continue;
        buckets[plane].push({
          fileId: f.id,
          fileName: f.name,
          pageIdx: +k,
          jointId: j.id,
          plane,
          world: w,
          dispJ: displayJointId(j),
        });
      }
    }
  }
  const cands: AutoPairCandidate[] = [];
  // triples
  for (const xy of buckets.XY) {
    for (const xz of buckets.XZ) {
      const dX = Math.abs(xy.world.x - xz.world.x);
      if (dX > tol) continue;
      for (const yz of buckets.YZ) {
        const dY = Math.abs(xy.world.y - yz.world.y);
        if (dY > tol) continue;
        const dZ = Math.abs(xz.world.z - yz.world.z);
        if (dZ > tol) continue;
        cands.push({
          type: "triple",
          members: [xy, xz, yz],
          score: Math.max(dX, dY, dZ),
          axes: { x: dX, y: dY, z: dZ },
          world: {
            x: (xy.world.x + xz.world.x) / 2,
            y: (xy.world.y + yz.world.y) / 2,
            z: (xz.world.z + yz.world.z) / 2,
          },
        });
      }
    }
  }
  // pairs
  const pairAxes = [
    { a: "XY", b: "XZ", axis: "x" },
    { a: "XY", b: "YZ", axis: "y" },
    { a: "XZ", b: "YZ", axis: "z" },
  ] as const;
  for (const pa of pairAxes) {
    for (const m1 of buckets[pa.a]) {
      for (const m2 of buckets[pa.b]) {
        const d = Math.abs((m1.world as any)[pa.axis] - (m2.world as any)[pa.axis]);
        if (d > tol) continue;
        cands.push({ type: "pair", members: [m1, m2], score: d, sharedAxis: pa.axis });
      }
    }
  }
  // 排序:triple 優先,然後 score 由小到大
  cands.sort((a, b) => {
    if (a.type !== b.type) return a.type === "triple" ? -1 : 1;
    return a.score - b.score;
  });
  // 貪心:同一 view-joint 不被多組重用
  const used = new Set<string>();
  const accepted: AutoPairCandidate[] = [];
  for (const c of cands) {
    const keys = c.members.map(m => `${m.fileId}:${m.pageIdx}:${m.jointId}`);
    if (keys.some(k => used.has(k))) continue;
    keys.forEach(k => used.add(k));
    accepted.push(c);
  }
  return accepted;
}
