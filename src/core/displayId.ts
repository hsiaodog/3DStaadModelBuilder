// 顯示編號(XX·ZZ·YY 組合)— 從 rank cache 算出 joint 的 display id
//   水平優先(state.numberPriority !== "v"):XX · ZZ · YY
//   垂直優先(state.numberPriority === "v"):YY · ZZ · XX
//   各軸 padding 位數 = log10(capacity) + 1(9→1, 99→2, 999→3)
//
//   demote 純粹靠 per-coord 分群:anchor 座標 rank 1..K 在前,demote-only 在後;
//   不在 displayId 加 +offset

import { state, _fileHasFullSetup } from "../legacy";
import { _rankCache, _worldForRank, _axisCap, _ensureRankCache } from "./rankCache";

export function _displayIdForJointWith(file: any, page: any, j: any): number | string {
  if (!file || !page || !j) return j ? j.id : "?";
  if (!_fileHasFullSetup(file)) return j.id;
  _ensureRankCache();
  const w = _worldForRank(file, page, j);
  if (!w) return j.id;
  const s = state as any;
  const md = Math.max(0, Math.min(6, Number.isFinite(s.measureDecimals) ? s.measureDecimals : 0));
  const round = (v: number) => {
    const r = parseFloat(v.toFixed(md));
    return r === 0 ? 0 : r;
  };
  const xr = _rankCache.x?.get(round(w.x));
  const yr = _rankCache.y?.get(round(w.y));
  const zr = _rankCache.z?.get(round(w.z));
  if (xr == null || yr == null || zr == null) return j.id;
  const Nx = String(_axisCap("x")).length;
  const Ny = String(_axisCap("y")).length;
  const Nz = String(_axisCap("z")).length;
  const composed = s.numberPriority === "v"
    ? String(yr).padStart(Ny, "0") + String(zr).padStart(Nz, "0") + String(xr).padStart(Nx, "0")
    : String(xr).padStart(Nx, "0") + String(zr).padStart(Nz, "0") + String(yr).padStart(Ny, "0");
  const num = Number(composed);
  return Number.isFinite(num) ? num : composed;
}
