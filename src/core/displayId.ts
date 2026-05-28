// 顯示編號(XX·ZZ·YY 組合)— 從 rank cache 算出 joint 的 display id
//   水平優先(state.numberPriority !== "v"):XX · ZZ · YY
//   垂直優先(state.numberPriority === "v"):YY · ZZ · XX
//   各軸 padding 位數 = log10(capacity) + 1(9→1, 99→2, 999→3)
//
//   demote 純粹靠 per-coord 分群:anchor 座標 rank 1..K 在前,demote-only 在後;
//   不在 displayId 加 +offset

import { state, _fileHasFullSetup, getActiveFile, getPage } from "../legacy";
import { _rankCache, _worldForRank, _axisCap, _ensureRankCache } from "./rankCache";

// ===== Joint connectivity classification(rank 算法用)=====
//   _isJointOrtho:joint 是否有 ≥1 水平 member + ≥1 垂直 member(2D 平面內)
//   _jointHasAnyDiagonal:是否有任何斜向 member → rank cache 用此把 brace 端點推到後段
//   _getJointMemberDirs:取出該 joint 所有 member 的「單位方向向量」陣列
//   _hasAnyPerpPair / _allDirsCollinear:從 dirs 陣列判 perp pair / 全共線
//   _jointHasPerpendicularPair:_hasAnyPerpPair 的舊 API
//   _jointConnectivityKind:回傳 "axis" / "diag" / "empty",rank 排序用

export function _isJointOrtho(j, page) {
  if (!page || !Array.isArray(page.members)) return false;
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  let hasH = false, hasV = false;
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    if (Math.abs(dx) < tol && Math.abs(dy) < tol) continue;
    if (Math.abs(dy) < tol && Math.abs(dx) > tol) hasH = true;
    if (Math.abs(dx) < tol && Math.abs(dy) > tol) hasV = true;
    if (hasH && hasV) return true;
  }
  return false;
}

export function _jointHasAnyDiagonal(j, page) {
  if (!page || !Array.isArray(page.members) || !page.members.length) return false;
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    if (Math.abs(dx) < tol && Math.abs(dy) < tol) continue;
    if (Math.abs(dy) >= tol && Math.abs(dx) >= tol) return true;
  }
  return false;
}

export function _getJointMemberDirs(j, page) {
  const out = [];
  if (!page || !Array.isArray(page.members) || !page.members.length) return out;
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    const len = Math.hypot(dx, dy);
    if (len < tol) continue;
    out.push({ dx: dx / len, dy: dy / len });
  }
  return out;
}

export function _hasAnyPerpPair(dirs) {
  for (let i = 0; i < dirs.length; i++) {
    for (let k = i + 1; k < dirs.length; k++) {
      const dot = dirs[i].dx * dirs[k].dx + dirs[i].dy * dirs[k].dy;
      if (Math.abs(dot) < 0.05) return true;
    }
  }
  return false;
}

export function _allDirsCollinear(dirs) {
  if (dirs.length < 2) return false;
  const d0 = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    const dot = Math.abs(d0.dx * dirs[i].dx + d0.dy * dirs[i].dy);
    if (Math.abs(dot - 1) > 0.05) return false;
  }
  return true;
}

export function _jointHasPerpendicularPair(j, page) {
  return _hasAnyPerpPair(_getJointMemberDirs(j, page));
}

export function _jointConnectivityKind(j, page) {
  if (!page || !Array.isArray(page.members) || !page.members.length) return "empty";
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  let hasH = false, hasV = false, hasD = false;
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    if (Math.abs(dx) < tol && Math.abs(dy) < tol) continue;
    if (Math.abs(dy) < tol && Math.abs(dx) > tol) hasH = true;
    else if (Math.abs(dx) < tol && Math.abs(dy) > tol) hasV = true;
    else hasD = true;
  }
  if (hasH || hasV) return "axis";
  if (hasD) return "diag";
  return "empty";
}

// ===== displayJointId / displayMemberId — 對外的 display ID API =====
//   • displayJointId: 走 _displayIdForJointWith,在 rank cache 已暖機時回傳 XX·ZZ·YY 編號
//   • displayMemberId: 直接回傳 m.id(rank 重編後的值,不再代換為 globalMember.id;
//     避免「同一根柱應該連續 1921/1922/1923 變成 1921/1945/1980」)

export function displayJointId(j) {
  return _displayIdForJointWith(getActiveFile(), getPage(), j);
}

export function displayMemberId(m) {
  if (!m) return "?";
  return m.id;
}

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
  const rx = round(w.x), ry = round(w.y), rz = round(w.z);
  const xr = _rankCache.x?.get(rx);
  // Y rank 先查 per-3D-position(per-joint bucket),沒有再退回 Y-value-only fallback
  //   同 Y 不同 (X,Z) 的 joint 可能落在不同 bucket → yBy3D 是正確答案,_rankCache.y 是 fallback
  const yr = _rankCache.yBy3D?.get(`${rx}|${ry}|${rz}`) ?? _rankCache.y?.get(ry);
  const zr = _rankCache.z?.get(rz);
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
