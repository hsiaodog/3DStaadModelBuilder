// 2D pixel ↔ 3D world 投影 — joint pixel 跟世界座標的雙向轉換
//   公式跟既有 legacy 一致:
//     u: 螢幕右為正 / v: 螢幕上為正(pixel y 反向);off = page.z = 第三軸
//     plane XZ:Z 向下為正(plan view convention)→ Z = -v
//     plane YZ:X = page.z;XY:Z = page.z
//   翻轉:page.flipX / flipY 套到 in-plane 兩軸

import { state } from "../app/integration";
import type { FileEntry, Page, Joint } from "../types";

interface World3D {
  x: number;
  y: number;
  z: number;
  strong: { X: boolean; Y: boolean; Z: boolean };
  plane: string;
}

/** joint pixel → 3D 世界座標。沒比例尺(file + state 雙重 fallback)→ null */
export function joint2DToWorld3D(
  file: FileEntry | null | undefined,
  page: Page,
  joint: Pick<Joint, "x" | "y">
): World3D | null {
  const ratio = (file && file.scaleRuler && (file.scaleRuler as any).ratio > 0)
    ? (file.scaleRuler as any).ratio
    : ((state as any).scale ? 1 / (state as any).scale : null);
  if (!ratio) return null;
  const o = file && file.planeOrigin;
  // u: 螢幕右為正(原始定義);v: 螢幕上為正(因 pixel-y 反向)
  let u = o ? (joint.x - o.x) * ratio : joint.x * ratio;
  let v = o ? (o.y - joint.y) * ratio : -joint.y * ratio;
  // 左右 / 上下翻轉:把對應的 in-plane 軸方向反轉(用於背面立面 / 鏡像圖紙 / 底視)
  if (page && page.flipX) u = -u;
  if (page && page.flipY) v = -v;
  const off = page.z || 0;
  const plane = page.plane || "XY";
  let X: number, Y: number, Z: number, strong: { X: boolean; Y: boolean; Z: boolean };
  switch (plane) {
    case "XZ": X = u;   Y = off; Z = -v;  strong = { X: true,  Y: false, Z: true  }; break;
    case "YZ": X = off; Y = v;   Z = u;   strong = { X: false, Y: true,  Z: true  }; break;
    case "XY":
    default:   X = u;   Y = v;   Z = off; strong = { X: true,  Y: true,  Z: false }; break;
  }
  return { x: X, y: Y, z: Z, strong, plane };
}

interface World3DCompat { ok: true; x: number; y: number }
interface World3DIncompat { ok: false; reason: string }
type World3DResult = World3DCompat | World3DIncompat;

/**
 * joint2DToWorld3D 的反函數:給 3D world → 對應該頁 (file, page) 上的 2D (joint.x, joint.y)
 *   檢查 page 的 out-of-plane 軸是否與 world 對應軸吻合(tol);不吻合回 { ok:false, reason }
 *   無 ratio → null
 */
export function world3DToJoint2D(
  file: FileEntry | null | undefined,
  page: Page,
  world: { x: number; y: number; z: number },
  opts?: { tol?: number }
): World3DResult | null {
  const ratio = (file && file.scaleRuler && (file.scaleRuler as any).ratio > 0)
    ? (file.scaleRuler as any).ratio
    : ((state as any).scale ? 1 / (state as any).scale : null);
  if (!ratio) return null;
  const tol = (opts && opts.tol != null) ? opts.tol : 0.5;
  const off = page.z || 0;
  const plane = page.plane || "XY";
  let u: number, v: number, depthAxisVal: number, depthAxisName: string;
  switch (plane) {
    case "XZ":
      u = world.x; v = -world.z;
      depthAxisVal = world.y; depthAxisName = "Y";
      break;
    case "YZ":
      u = world.z; v = world.y;
      depthAxisVal = world.x; depthAxisName = "X";
      break;
    case "XY":
    default:
      u = world.x; v = world.y;
      depthAxisVal = world.z; depthAxisName = "Z";
      break;
  }
  const compatible = Math.abs((depthAxisVal == null ? 0 : depthAxisVal) - off) <= tol;
  if (!compatible) {
    return { ok: false, reason: `${depthAxisName}=${depthAxisVal} 與該頁 page.z=${off} 不符` };
  }
  // 翻轉:joint2DToWorld3D 用 u' = -u / v' = -v,反推時也要對應反向
  if (page && page.flipX) u = -u;
  if (page && page.flipY) v = -v;
  const o = file && file.planeOrigin;
  const jx = (o ? o.x : 0) + u / ratio;
  const jy = (o ? o.y : 0) - v / ratio;
  return { ok: true, x: jx, y: jy };
}
