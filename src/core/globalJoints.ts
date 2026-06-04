// 全局節點 binding 查詢 + 3D 座標推算
//   listGlobalBindings:列出某 globalJoint 的所有跨頁綁定
//   inferGlobalJoint:從綁定的世界座標反推 globalJoint 的 (X, Y, Z),含一致性檢查
//   inferAllGlobalJoints:對全部 globalJoint 跑一遍 infer
//   joint2DToWorld3D 已搬到 ./projection,這裡 import 使用

import { state, _snapCoordToPrecision } from "../app/integration";
import { joint2DToWorld3D } from "./projection";

export interface GlobalBinding {
  fileId: number;
  fileName: string;
  pageIdx: number;
  jointId: number;
}

/** 列出所有綁到此 globalId 的 view joint 位置(跨頁) */
export function listGlobalBindings(gid: number): GlobalBinding[] {
  const out: GlobalBinding[] = [];
  const files = (state as any).files;
  for (const f of files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      for (const j of (pg.joints || [])) {
        if ((j as any).globalId === gid) {
          out.push({ fileId: f.id, fileName: f.name, pageIdx: +k, jointId: j.id });
        }
      }
    }
  }
  return out;
}

/**
 * 根據所有綁定推算 globalJoint 的 3D 座標 + 一致性檢查。
 * 規則:
 *   - 強約束(in-plane)優先採用;同軸有多個強約束 → 取平均並檢查差異
 *   - 沒有任何強約束的軸 → 取所有弱約束(out-of-plane)的平均;若仍無 → null
 *   - 若同軸強約束差異 > tol 或 弱/強衝突 > tol → 寫 warning
 *   - locked === true 的不覆蓋座標,只跑檢查
 */
export function inferGlobalJoint(g: any): void {
  if (!g) return;
  const tol = 5;
  const planePriority = ["XY", "YZ", "XZ"] as const;
  const acc: Record<string, { strong: Array<{ v: number; src: string; plane: string }>; weak: Array<{ v: number; src: string; plane: string }> }> = {
    X: { strong: [], weak: [] }, Y: { strong: [], weak: [] }, Z: { strong: [], weak: [] },
  };
  const bindings = listGlobalBindings(g.id);
  const sources: any[] = [];
  const s = state as any;
  for (const b of bindings) {
    const f = s.files.find((x: any) => x.id === b.fileId); if (!f) continue;
    const pg = (f.pages || {})[b.pageIdx]; if (!pg) continue;
    const j = (pg.joints || []).find((x: any) => x.id === b.jointId); if (!j) continue;
    const w = joint2DToWorld3D(f, pg, j);
    if (!w) continue;
    sources.push({ b, w, fileName: f.name, pageIdx: b.pageIdx });
    for (const ax of ["X", "Y", "Z"] as const) {
      const v = ({ X: w.x, Y: w.y, Z: w.z } as any)[ax];
      ((w.strong as any)[ax] ? acc[ax].strong : acc[ax].weak).push({ v, src: `${f.name}#${b.pageIdx + 1}`, plane: pg.plane });
    }
  }
  const pickByPriority = (list: Array<{ plane: string; v: number; src: string }>) => {
    for (const plane of planePriority) {
      const sub = list.filter(e => e.plane === plane);
      if (sub.length) return sub;
    }
    return list;
  };
  const warnings: any[] = [];
  const out: any = { x: g.x, y: g.y, z: g.z };
  for (const ax of ["X", "Y", "Z"] as const) {
    const { strong, weak } = acc[ax];
    let chosen: number | null = null;
    if (strong.length > 0) {
      const top = pickByPriority(strong);
      const avg = top.reduce((s, e) => s + e.v, 0) / top.length;
      const maxDelta = Math.max(...top.map(e => Math.abs(e.v - avg)));
      if (maxDelta > tol) {
        const detail = top.map(e => `${e.src}=${e.v.toFixed(1)}`).join(", ");
        warnings.push({ axis: ax, delta: maxDelta, message: `${ax} 軸強約束(${top[0].plane})不一致 (Δ=${maxDelta.toFixed(1)}): ${detail}` });
      }
      chosen = avg;
      for (const e of strong) {
        if (e.plane === top[0].plane) continue;
        if (Math.abs(e.v - avg) > tol) {
          warnings.push({
            axis: ax, delta: Math.abs(e.v - avg),
            message: `${ax} 軸強約束 ${e.src}(${e.plane})=${e.v.toFixed(1)} 跟採用值(${top[0].plane})${avg.toFixed(1)} 差 ${Math.abs(e.v - avg).toFixed(1)}`,
          });
        }
      }
      for (const e of weak) {
        if (Math.abs(e.v - avg) > tol) {
          warnings.push({
            axis: ax, delta: Math.abs(e.v - avg),
            message: `${ax} 軸弱約束 ${e.src}=${e.v.toFixed(1)} 跟採用值 ${avg.toFixed(1)} 差 ${Math.abs(e.v - avg).toFixed(1)}`,
          });
        }
      }
    } else if (weak.length > 0) {
      const top = pickByPriority(weak);
      const avg = top.reduce((s, e) => s + e.v, 0) / top.length;
      const maxDelta = Math.max(...top.map(e => Math.abs(e.v - avg)));
      if (maxDelta > tol) {
        const detail = top.map(e => `${e.src}=${e.v.toFixed(1)}`).join(", ");
        warnings.push({ axis: ax, delta: maxDelta, message: `${ax} 軸只有弱約束(${top[0].plane})且不一致 (Δ=${maxDelta.toFixed(1)}): ${detail}` });
      }
      chosen = avg;
    }
    out[ax.toLowerCase()] = chosen;
  }
  if (!g.locked) {
    g.x = _snapCoordToPrecision(out.x);
    g.y = _snapCoordToPrecision(out.y);
    g.z = _snapCoordToPrecision(out.z);
  }
  g.warnings = warnings;
  g.derivedFrom = sources.map(s => ({
    fileId: s.b.fileId, pageIdx: s.b.pageIdx, jointId: s.b.jointId,
    plane: s.w.plane,
  }));
}

/** 對所有 globalJoint 跑一輪 infer(校準後或綁定改變後呼叫) */
export function inferAllGlobalJoints(): void {
  for (const g of (state as any).globalJoints) inferGlobalJoint(g);
}
