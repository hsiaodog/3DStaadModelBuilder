// Relayout(編排節點 / 桿件編號)— rank cache 之外的另一個編號核心
//   _relayoutPageCore        — 單一 page 的核心邏輯(joints + members 都重編)
//   _nextMemberZeroBoundary  — 跨頁累加 startBase 進位(線性,非 digit-based)
//   relayoutNumbering        — 當頁節點 + 桿件重編(interactive)
//   relayoutNumberingAll     — 全部頁面節點 + 桿件重編(可中斷)
//   relayoutMembersNumbering — 當頁只重桿件(節點 ID 不動)
//   relayoutMembersNumberingAll — 全部頁面 4-stage 桿件重編(可中斷;與 rank cache 一致)
//
//   注意:
//   • 不要在這層 call refreshLists / render 以外的 UI hooks — caller 控制
//   • 各 stage 都 pushUndo,失敗可 Ctrl+Z;rank cache 在 caller(3D 一鍵處理)端 invalidate
//   • 跨頁同物理桿件 ID 用 globalMemberId 融合(unifyCrossPageMemberIds 收尾)
// @ts-nocheck

import {
  state, $, getPage, getActiveFile, pushUndo, render, refreshLists,
  nextJointId, nextMemberId, setNextJointId, setNextMemberId,
  _fileHasFullSetup, _populateSectionLinkJointsForFile,
  autoBindGlobalMembers, dedupSamePageMembers, unifyCrossPageMemberIds,
} from "../app/integration";
import { joint2DToWorld3D } from "./projection";
import { showBusyWithCancel, setBusyMessage, busyTick, hideBusy } from "../ui/busy";
import { wrapPosSort as _wrapPosSort } from "../utils/sort";
import { getOrInitDebugObj as _getOrInitDebugObj } from "../utils/debug";

// 對單一 page 套重排核心邏輯(joints + members 都重編)。回傳 {jointGroups, finalMax} 或 null。
// 不包含 pushUndo / render / refreshLists / 計數器同步,呼叫端負責。
// 編號可調參數(structure pipeline 用):只含「原本寫死」的 5 個 knob;未提供則用倉儲預設 → 行為與舊版一致。
//   direction / capacity / memberCap* / measureDecimals 仍走 state(由 pipeline step 在呼叫前寫入)。
export function _resolveNumbering(nb: any) {
  nb = nb || {};
  const _n = (v: any, d: number) => (Number.isFinite(v) ? v : d);
  const ord = (nb.axisOrderByPlane && typeof nb.axisOrderByPlane === "object") ? nb.axisOrderByPlane : null;
  return {
    tolGroup:   _n(nb.tolGroup, 2),       // joint / 同向桿件分群容差(mm)
    tolBeamRow: _n(nb.tolBeamRow, 50),    // 樑排分群容差(mm)
    angleTol:   _n(nb.angleTol, 0.05),    // 水平/垂直判定角度比(≈3°)
    absAxisTol: _n(nb.absAxisTol, 10),    // 軸向對齊絕對門檻(mm,短桿件防誤判)
    axisOrderByPlane: ord || { XY: ["Y", "X", "D"], YZ: ["Y", "Z", "D"], XZ: ["X", "Z", "D"] },
  };
}

export function _relayoutPageCore(p, opts) {
  if (!p || p._orphan || !p.joints || !p.joints.length) return null;
  opts = opts || {};
  const interactive = opts.interactive !== false;
  const origin = opts.origin || null;            // 若有,起始點以原點 projection 為準,wrap-around 另一頭
  const membersOnly = !!opts.membersOnly;        // 只重編桿件 ID(節點 ID 保持不動)
  // 跨頁累加用:外部傳入桿件起始基底(預設 1);回傳的 maxMemberId 給下一頁繼承
  const memberStartBase = (Number.isFinite(opts.memberStartBase) && opts.memberStartBase >= 1)
    ? Math.floor(opts.memberStartBase) : 1;
  const NB = _resolveNumbering(opts.numbering);   // structure pipeline 可調參數(預設=倉儲)
  const tolGroup = NB.tolGroup;
  // 樑分群容差 — 用 50mm:
  //   • 大於 tolGroup=2mm(避免 CAD 細件 cap plate / anchor bolt 微小漂移把同排切碎)
  //   • 小於 100mm(避免把實際距離 100-500mm 的兩排不同樑誤合成一個 group → 編號互相穿插
  //     如 20301、20302、20303、20304 變成 (X1,上排), (X1,下排), (X2,上排), (X2,下排) 交錯)
  const tolBeamRow = NB.tolBeamRow;
  const cap = Math.max(10, state.relayoutCapacity || 100);
  const isVertical = state.relayoutDirection !== "horizontal";
  const nextBaseAfter = (lastId) => (Math.floor(lastId / cap) + 1) * cap + 1;
  // ★ 全程用 mm + 精準度 round 後的座標做分類與分群
  //   page-local 是 PIXELS(CAD 單位),要先 ×ratio 換成 mm,再套精準度 round
  //   thresholds(eps / absAxisTol / tolGroup / tolBeamRow)都是 mm,所以分母分子單位要一致
  const _pgFile = (state.files || []).find((f: any) => f && f.pages && Object.values(f.pages).includes(p));
  const _ratio = (_pgFile && (_pgFile as any).scaleRuler && (_pgFile as any).scaleRuler.ratio > 0)
    ? (_pgFile as any).scaleRuler.ratio
    : ((state as any).scale ? 1 / (state as any).scale : 1);
  const _classifyMd = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  const _rndMm = (v) => { const r = parseFloat(v.toFixed(_classifyMd)); return r === 0 ? 0 : r; };
  const _pxToMm = (v) => _rndMm(v * _ratio);
  const groupItems = (items, getMain, getSub, tol, subDesc, mainDesc) => {
    const sorted = [...items].sort((a, b) => getMain(a) - getMain(b));
    const groups = [];
    let cur = null, lastM = null;
    for (const it of sorted) {
      const m = getMain(it);
      if (cur === null || m - lastM > tol) { cur = []; groups.push(cur); }
      cur.push(it);
      lastM = m;
    }
    for (const g of groups) g.sort((a, b) => subDesc ? (getSub(b) - getSub(a)) : (getSub(a) - getSub(b)));
    return mainDesc ? groups.reverse() : groups;
  };
  // 把 array 旋轉:讓索引 idx 變第 0 位,前面被擠到尾巴(idx > 0 才旋轉;<=0 不動)
  const rotateAt = (arr, idx) => (idx <= 0 ? arr.slice() : arr.slice(idx).concat(arr.slice(0, idx)));
  // 找 array 中座標最接近 ref 值的索引
  const closestIdx = (arr, getCoord, ref) => {
    let bi = 0, bd = Infinity;
    for (let k = 0; k < arr.length; k++) {
      const d = Math.abs(getCoord(arr[k]) - ref);
      if (d < bd) { bd = d; bi = k; }
    }
    return bi;
  };
  // 用 origin 旋轉群陣列(外圈)+ 每群內部(內圈)
  //   mainCoord:原點在主軸的座標(isVertical → origin.x;水平 → origin.y)
  //   subCoord :原點在次軸的座標
  //   getMain / getSub:從 item 取主 / 次軸座標的 fn
  const applyOriginOrder = (groups, mainCoord, subCoord, getMain, getSub) => {
    if (origin == null) return groups;
    if (!groups.length) return groups;
    // 外圈:找哪一群的主軸座標最接近 origin.mainCoord
    //   每群至少 1 個 item,直接用 g[0] 的主軸值代表(因為同群主軸值一致)
    const outerIdx = closestIdx(groups, g => getMain(g[0]), mainCoord);
    const rotatedOuter = rotateAt(groups, outerIdx);
    // 內圈:對每群依次軸 origin.subCoord 旋轉
    return rotatedOuter.map(g => {
      const innerIdx = closestIdx(g, getSub, subCoord);
      return rotateAt(g, innerIdx);
    });
  };
  // 節點分群(membersOnly 模式下跳過)
  let jointGroups = [];
  let finalMax = 0;
  const oldToNew = new Map();
  if (!membersOnly) {
    // joint 分群 — 用 mm + 精準度 round 後的座標(tolGroup 也是 mm)
    if (isVertical) jointGroups = groupItems(p.joints, j => _pxToMm(j.x), j => _pxToMm(j.y), tolGroup, true, false);
    else            jointGroups = groupItems(p.joints, j => _pxToMm(j.y), j => _pxToMm(j.x), tolGroup, false, true);
    if (origin) {
      // origin 是 pixel,要換算成 mm 跟 _pxToMm 的回傳值同單位才能比對
      const _oxMm = _pxToMm(origin.x), _oyMm = _pxToMm(origin.y);
      const mainCoord = isVertical ? _oxMm : _oyMm;
      const subCoord  = isVertical ? _oyMm : _oxMm;
      const getMain   = isVertical ? (j => _pxToMm(j.x)) : (j => _pxToMm(j.y));
      const getSub    = isVertical ? (j => _pxToMm(j.y)) : (j => _pxToMm(j.x));
      jointGroups = applyOriginOrder(jointGroups, mainCoord, subCoord, getMain, getSub);
    }
    const groupBases = [];
    let nextBase = 1;
    for (let c = 0; c < jointGroups.length; c++) {
      groupBases.push(nextBase);
      nextBase = nextBaseAfter(nextBase + jointGroups[c].length - 1);
    }
    finalMax = jointGroups.length
      ? groupBases[jointGroups.length - 1] + jointGroups[jointGroups.length - 1].length - 1 : 0;
    if (interactive && state.globalCapacity && finalMax > state.globalCapacity) {
      if (!confirm(`重排後最大內部編號 ${finalMax} 已超過全域容量 ${state.globalCapacity},仍要繼續?`)) return null;
    }
    for (let c = 0; c < jointGroups.length; c++) {
      const base = groupBases[c];
      for (let r = 0; r < jointGroups[c].length; r++) oldToNew.set(jointGroups[c][r].id, base + r);
    }
    for (const j of p.joints) j.id = oldToNew.get(j.id);
    for (const m of p.members) {
      m.j1 = oldToNew.get(m.j1) ?? m.j1;
      m.j2 = oldToNew.get(m.j2) ?? m.j2;
    }
  }
  // 桿件三相位 + 進位 — 用「世界座標」分類(避開 page-local pixel 受 flipX/flipY / 微旋轉影響)
  //   priority:joint.globalId → state.globalJoints(precision-snapped)
  //   fallback:joint2DToWorld3D(file, page, joint)
  //   依 page.plane 挑平面內兩條世界軸:
  //     XZ → main=X、sub=Z;XY → main=X、sub=Y;YZ → main=Z、sub=Y
  //   分類後 dx/dy 都是世界 mm + 精準度 round,thresholds 也是 mm → 單位一致
  const angleTol = NB.angleTol;   // ≈ 3° 容忍(可由 pipeline 調)
  const eps = 0.5;          // 同位節點(dx≈dy≈0)排除用 — mm
  const jointMap = new Map(p.joints.map(j => [j.id, j]));
  const _plane = p.plane || "XY";
  const _worldFor = (j: any) => {
    if (j && j.globalId != null && Array.isArray((state as any).globalJoints)) {
      const gj = (state as any).globalJoints.find((g: any) => g && g.id === j.globalId);
      if (gj && Number.isFinite(gj.x) && Number.isFinite(gj.y) && Number.isFinite(gj.z)) {
        return { x: gj.x, y: gj.y, z: gj.z };
      }
    }
    return (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(_pgFile as any, p, j) : null;
  };
  const _pickAxes = (w: any) => {
    if (!w) return null;
    switch (_plane) {
      case "XZ": return { main: w.x, sub: w.z };   // page-x=世界X、page-y=世界Z
      case "YZ": return { main: w.z, sub: w.y };   // page-x=世界Z、page-y=世界Y
      default:   return { main: w.x, sub: w.y };   // XY:page-x=X、page-y=Y
    }
  };
  const memMid = (m) => {
    const a = jointMap.get(m.j1), b = jointMap.get(m.j2);
    if (!a || !b) return null;
    const wa = _worldFor(a), wb = _worldFor(b);
    if (!wa || !wb) return null;
    const pa = _pickAxes(wa)!, pb = _pickAxes(wb)!;
    const ma = _rndMm(pa.main), mb = _rndMm(pb.main);
    const sa = _rndMm(pa.sub),  sb = _rndMm(pb.sub);
    return { m, midX: (ma + mb) / 2, midY: (sa + sb) / 2,
             dx: Math.abs(ma - mb), dy: Math.abs(sa - sb) };
  };
  // 短桿件絕對門檻 — 短的 B4 / brace strut 用 ratio (dxRatio < 0.05) 可能因為長度短而被誤判:
  //   B4 長度 100mm + 5mm 水平偏移 → dxRatio = 0.05 剛好踩到門檻變斜撐 → 拿到 D 範圍 ID
  //   絕對門檻 < 10mm 的 dx 就一定當垂直、< 10mm 的 dy 就一定當水平,不論長度
  const absAxisTol = NB.absAxisTol;
  const horizontalsM = [], verticalsM = [], diagonalsM = [];
  // ★ 診斷:收集 D 分類的桿件 dx/dy/len,讓使用者用 console 找出為何特定桿件被歸到 D
  //   (window._lastDiagDClassify[pageTag] = [{ memberId, j1, j2, dx, dy, len, dxRatio }, ...])
  const _diagDLog: any[] = [];
  for (const m of p.members) {
    const w = memMid(m); if (!w) continue;
    const len = Math.hypot(w.dx, w.dy);
    if (len < eps) continue;   // 同位節點 / 太短
    // 絕對門檻優先(避免短桿件被 ratio 誤判)
    if (w.dx < absAxisTol && w.dy >= absAxisTol) { verticalsM.push(w); continue; }
    if (w.dy < absAxisTol && w.dx >= absAxisTol) { horizontalsM.push(w); continue; }
    const dxRatio = w.dx / len;
    const dyRatio = w.dy / len;
    if (dyRatio < angleTol) horizontalsM.push(w);     // 幾乎平行 2D X 軸(水平)
    else if (dxRatio < angleTol) verticalsM.push(w);  // 幾乎平行 2D Y 軸(垂直 — 柱)
    else {
      diagonalsM.push(w);                          // 斜撐
      _diagDLog.push({
        memberId: m.id, j1: m.j1, j2: m.j2,
        dx_mm: +w.dx.toFixed(2), dy_mm: +w.dy.toFixed(2), len_mm: +len.toFixed(2),
        dxRatio: +dxRatio.toFixed(4), dyRatio: +dyRatio.toFixed(4),
        absAxisTol, angleTol,
      });
    }
  }
  // 寫入 window._lastDiagDClassify[pageTag] 供 console 查
  if (_diagDLog.length) {
    const _bag = _getOrInitDebugObj<Record<string, any[]>>("_lastDiagDClassify", () => ({}));
    const _pageTag = `${_pgFile ? (_pgFile as any).name : "?"}#${p.plane || "?"}@z=${p.z != null ? p.z : "?"}`;
    _bag[_pageTag] = _diagDLog;
    console.log(`[diag D] ${_pageTag} ratio=${_ratio} md=${_classifyMd} → ${_diagDLog.length} 個桿件被歸成 D`, _diagDLog.slice(0, 10));
  }
  const groupForDir = (items) => {
    const groups = isVertical
      ? groupItems(items, it => it.midX, it => it.midY, tolGroup, true, false)
      : groupItems(items, it => it.midY, it => it.midX, tolGroup, false, true);
    if (!origin) return groups;
    const mainCoord = isVertical ? origin.x : origin.y;
    const subCoord  = isVertical ? origin.y : origin.x;
    const getMain   = isVertical ? (it => it.midX) : (it => it.midY);
    const getSub    = isVertical ? (it => it.midY) : (it => it.midX);
    return applyOriginOrder(groups, mainCoord, subCoord, getMain, getSub);
  };
  // 拓樸分群:同方向 member 共享 joint → 同一根「連續桿件」(柱 / 樑)
  //   解決:midpoint X 分群會被 joint X 漂移破壞;改用 union-find 不受幾何誤差影響
  const groupConnectedByJoint = (items, isVerticalDir) => {
    if (!items.length) return [];
    const parent = new Map(), rank = new Map();
    const makeSet = (id) => { if (!parent.has(id)) { parent.set(id, id); rank.set(id, 0); } };
    const find = (id) => {
      while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
      return id;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      const sa = rank.get(ra), sb = rank.get(rb);
      if (sa < sb) parent.set(ra, rb);
      else if (sa > sb) parent.set(rb, ra);
      else { parent.set(rb, ra); rank.set(ra, sa + 1); }
    };
    const jointToMembers = new Map();
    for (const it of items) {
      makeSet(it.m.id);
      for (const jid of [it.m.j1, it.m.j2]) {
        if (!jointToMembers.has(jid)) jointToMembers.set(jid, []);
        jointToMembers.get(jid).push(it.m.id);
      }
    }
    for (const arr of jointToMembers.values()) {
      if (arr.length < 2) continue;
      for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    }
    const groupMap = new Map();
    for (const it of items) {
      const r = find(it.m.id);
      if (!groupMap.has(r)) groupMap.set(r, []);
      groupMap.get(r).push(it);
    }
    // 每群內依「沿軸方向」排序,用 wrap-from-world-origin
    //   垂直柱:沿 midY wrap(0 → +Y → -Y)
    //   水平樑:沿 midX wrap
    for (const g of groupMap.values()) {
      if (isVerticalDir) g.sort((a, b) => _wrapPosSort(a.midY, b.midY));
      else g.sort((a, b) => _wrapPosSort(a.midX, b.midX));
    }
    const groups = [...groupMap.values()];
    // 群之間排序:wrap-from-world-origin
    //   垂直柱:外圈用 midX wrap;水平樑:外圈用 midY wrap
    groups.sort((g1, g2) => {
      const c1 = isVerticalDir ? g1[0].midX : g1[0].midY;
      const c2 = isVerticalDir ? g2[0].midX : g2[0].midY;
      return _wrapPosSort(c1, c2);
    });
    return groups;
  };
  // 斜撐分群:依「桿件所在 2D 線」(slope + perpendicular offset)
  //   同一條連續斜撐的多個 segment 會共享同一條線 → 編號連續(整條完整 → 下一條)
  // ★ 斜撐分群:依「起點 Z」(sub)分群 — 每個 Z-band 一群,跨 Z-band 跳到下一個 100-block
  //   起點定義:平面內 (sub, main) lex 較小者 — sub 較小優先(Z 較小);sub 相等則 main 較小
  //   群序:起點 sub asc(Z 由近到遠)
  //   同群內排序:起點 main asc → 終點 main asc → 終點 sub asc
  //   例:Z=z1 band 連號 20801, 20802, ... → 換 Z=z2 band 從 20901 開始
  const groupForDiag = (items) => {
    if (!items.length) return [];
    type Keyed = { mi: any; sMain: number; sSub: number; eMain: number; eSub: number };
    const keyed: Keyed[] = [];
    for (const mi of items) {
      const a = jointMap.get(mi.m.j1), b = jointMap.get(mi.m.j2);
      if (!a || !b) continue;
      const wa = _worldFor(a), wb = _worldFor(b);
      if (!wa || !wb) continue;
      const pa = _pickAxes(wa)!, pb = _pickAxes(wb)!;
      const ma = _rndMm(pa.main), sa = _rndMm(pa.sub);
      const mb = _rndMm(pb.main), sb = _rndMm(pb.sub);
      const aIsStart = (sa < sb) || (sa === sb && ma < mb);
      const s = aIsStart ? { main: ma, sub: sa } : { main: mb, sub: sb };
      const e = aIsStart ? { main: mb, sub: sb } : { main: ma, sub: sa };
      keyed.push({ mi, sMain: s.main, sSub: s.sub, eMain: e.main, eSub: e.sub });
    }
    // 分群 + 內排序:依 plane 不同
    //   XZ:外層用 sSub(世界 Z)— 同 Z band 一群;內層用 sMain(世界 X)asc
    //     X-brace 兩條 D 的 sSub 都 = min(z_a, z_b),已落在同 bay。
    //   YZ:外層用「bay Z」= min(main_a, main_b);內層用 sSub(世界 Y)asc(Y=0 往上)
    //     ★ 不能直接用 sMain 當外層 — X-brace / 起點 main=z1、\ 起點 main=z2,兩條 D 會被切到不同 bay。
    //       改用 min(sMain, eMain) → 兩條都歸到 bay min Z。
    //     內層 sSub 相同(同 Y level)時用 sMain asc 當 tiebreaker(z1 那條先,z2 那條後)
    //   XY(預設):同 XZ 風格,外層 sSub,內層 sMain
    const _isYZ = _plane === "YZ";
    const _outerKey = (k: Keyed) => _isYZ ? Math.min(k.sMain, k.eMain) : k.sSub;
    const groupMap = new Map<number, Keyed[]>();
    for (const k of keyed) {
      const key = _outerKey(k);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(k);
    }
    // 群序用 wrap-from-world-origin(0 → 正向 → 負向)
    const sortedKeys = [...groupMap.keys()].sort(_wrapPosSort);
    return sortedKeys.map(key => {
      const arr = groupMap.get(key)!;
      // 群內排序也用 wrap-from-world-origin,複合排序逐層 fallback
      arr.sort((a, b) => {
        if (_isYZ) {
          // YZ:sSub(Y level)wrap → sMain wrap → eMain wrap → eSub wrap
          let c = _wrapPosSort(a.sSub, b.sSub); if (c !== 0) return c;
          c = _wrapPosSort(a.sMain, b.sMain); if (c !== 0) return c;
          c = _wrapPosSort(a.eMain, b.eMain); if (c !== 0) return c;
          return _wrapPosSort(a.eSub, b.eSub);
        } else {
          // XZ / XY:sMain wrap → eMain wrap → eSub wrap
          let c = _wrapPosSort(a.sMain, b.sMain); if (c !== 0) return c;
          c = _wrapPosSort(a.eMain, b.eMain); if (c !== 0) return c;
          return _wrapPosSort(a.eSub, b.eSub);
        }
      });
      return arr.map(k => k.mi);
    });
  };
  // 分群策略(視 plane 不同):
  //   • horizontals(2D 水平樑):一律按「midY 分群」 — 同排樑 midY 一致 → 同群
  //     ⚠ 不能用 groupForDir():它依外層 isVertical 反向取軸 → 每根樑自成一群 → gi 暴增、編號跳號
  //   • verticals(2D 垂直):
  //       - XY / YZ 頁面 → 真正的 Y 軸柱,用拓樸(共享 joint)整合多段微漂移的柱身
  //       - XZ 頁面     → 其實是 Z 軸樑(平面圖縱樑),要用「midX 分群」才不會被切碎
  //   • D(斜撐):用「同線(slope + perp)」分群,連續斜撐一條線會合成一群
  const _groupHorizByMidY = (items) => {
    // 同排樑用 midY 分群(tolerance),群序與群內均用 wrap-from-world-origin
    //   群序:midY 0 → 正向 ascending → 負向 ascending
    //   群內:midX 0 → 正向 ascending → 負向 ascending
    const gs = groupItems(items, it => it.midY, it => it.midX, tolBeamRow, false, false);
    gs.sort((g1, g2) => _wrapPosSort(g1[0].midY, g2[0].midY));
    for (const g of gs) g.sort((a, b) => _wrapPosSort(a.midX, b.midX));
    return gs;
  };
  const _groupVertByMidX = (items) => {
    // 同列樑用 midX 分群、群序與群內均用 wrap-from-world-origin
    const gs = groupItems(items, it => it.midX, it => it.midY, tolBeamRow, false, false);
    gs.sort((g1, g2) => _wrapPosSort(g1[0].midX, g2[0].midX));
    for (const g of gs) g.sort((a, b) => _wrapPosSort(a.midY, b.midY));
    return gs;
  };
  const _isXZPage = (p.plane === "XZ");
  const hGroups = _groupHorizByMidY(horizontalsM);            // X / Z 軸樑:midY 分群
  const vGroups = _isXZPage
    ? _groupVertByMidX(verticalsM)                            // XZ 頁的 verticals = Z 軸樑 → midX 分群
    : groupConnectedByJoint(verticalsM, true);                // XY / YZ 頁的 verticals = Y 軸柱 → topology
  const dGroups = groupForDiag(diagonalsM);
  const memOldToNew = new Map();
  // 桿件編號(全局 cap 版):各方向使用自己的 cap(state.memberCapY/X/Z/Diag,預設 99)
  //   每個方向用 group_idx * mult + pos(pos 從 0 起):
  //     gi=0,pi=0 → startBase
  //     gi=0,pi=1 → startBase+1
  //     gi=1,pi=0 → startBase + mult
  //     gi=1,pi=1 → startBase + mult + 1
  //   mult = cap + 1(cap=99 → 100,符合 XX·YY 格式)
  //   每換方向 → startBase 進位到下一個「0 整位」+ 1(199→201,8859→9001)
  //
  //   依 plane 決定 2D「水平 / 垂直」對應哪個真實軸,以及處理順序:
  //     XY:vGroups = Y 軸,hGroups = X 軸,dGroups = 斜 → 順序 Y → X → 斜
  //     YZ:vGroups = Y 軸,hGroups = Z 軸,dGroups = 斜 → 順序 Y → Z → 斜
  //     XZ:vGroups = Z 軸,hGroups = X 軸,dGroups = 斜 → 順序 X → Z → 斜
  const plane = p.plane || "XY";
  const catGroups = {};
  if (plane === "XY") { catGroups.Y = vGroups; catGroups.X = hGroups; catGroups.D = dGroups; }
  else if (plane === "YZ") { catGroups.Y = vGroups; catGroups.Z = hGroups; catGroups.D = dGroups; }
  else { catGroups.X = hGroups; catGroups.Z = vGroups; catGroups.D = dGroups; }
  const catCap = {
    Y: state.memberCapY || 99,
    X: state.memberCapX || 99,
    Z: state.memberCapZ || 99,
    D: state.memberCapDiag || 99,
  };
  const orderByPlane = NB.axisOrderByPlane;
  const phaseOrder = orderByPlane[plane] || ["Y", "X", "Z", "D"];
  // 進位:n 的最高位 +1,後面歸 0,再 +1(例 199→201、8859→9001)
  // 換 phase 進位:跟當前 phase 的 mult 對齊(線性,避免 digit-based 指數成長)
  //   nextZeroBoundary(n, mult) → 下一個 mult 倍數 +1
  const nextZeroBoundary = (n, m) => {
    if (!Number.isFinite(n) || n <= 0) return 1;
    const step = m && m >= 2 ? m : 100;
    return (Math.floor(n / step) + 1) * step + 1;
  };
  // 跨頁累加用:每個 cat(Y / X / Z / D)有自己獨立的 startBase。
  //   讓「X 軸跨頁連續走 100-block」、「Y 軸跨頁連續走」等需求成立,不會因為某頁 Y 群多
  //   把下一頁 X 推高。catStartBase 由 caller 傳入(opts.catStartBase),內部回傳 catMax。
  //
  //   opts.catStartBase: { Y, X, Z, D } — 每個 cat 的起始 ID
  //   opts.diagStartBase 仍接受(向下相容,等同 catStartBase.D)
  //   opts.memberStartBase 仍接受(向下相容;沒傳 catStartBase 時 Y/X/Z 共用此 base)
  const _catStartBaseIn = (opts.catStartBase && typeof opts.catStartBase === "object") ? opts.catStartBase : null;
  const diagStartBase = (Number.isFinite(opts.diagStartBase) && opts.diagStartBase >= 1)
    ? Math.floor(opts.diagStartBase) : null;
  const _catBase = (cat) => {
    if (_catStartBaseIn && Number.isFinite(_catStartBaseIn[cat]) && _catStartBaseIn[cat] >= 1) {
      return Math.floor(_catStartBaseIn[cat]);
    }
    if (cat === "D" && diagStartBase != null) return diagStartBase;
    return memberStartBase;   // fallback:跟原本同序列
  };
  // 每個 cat 跑完後在此頁內推進,跨 cat 之間用 nextZeroBoundary 對齊 mult
  const _catRunStart = { Y: _catBase("Y"), X: _catBase("X"), Z: _catBase("Z"), D: _catBase("D") };
  const catMax = { Y: 0, X: 0, Z: 0, D: 0 };
  let startBase = memberStartBase;    // 保留向下相容(若沒走 per-cat 模式)
  let lastMaxId = 0;
  let lastDiagMaxId = 0;
  // phaseOnly:caller 可指定本次只處理單一 cat("Y" / "X" / "Z" / "D"),其他 cat 跳過。
  //   讓上層做「Pass 1: Y → Pass 2: X → Pass 3: Z → Pass 4: D」的 4 階段獨立累加。
  //   各階段邏輯互不干擾 — 改 X 邏輯不影響 Y 已產出的結果。
  const phaseOnly = opts.phaseOnly || null;
  const _shouldProcess = (cat) => !phaseOnly || phaseOnly === cat;

  // 統一的 cat-by-cat 處理(所有 plane 都走這條;沒有特殊的 XZ band 邏輯)
  //   每個 cat 用自己的 runStart(catStartBase[cat]),處理完後在此頁內推進。
  //   phaseOnly 設定時只跑該 cat,其他全部跳過 → memOldToNew 只裝該 cat 的 mapping,
  //   不影響其他 cat 在這頁已有的 m.id。
  for (const cat of phaseOrder) {
    if (!_shouldProcess(cat)) continue;
    const groups = catGroups[cat] || [];
    if (!groups.length) continue;
    const cap = catCap[cat];
    const mult = cap + 1;
    const useStartBase = _catRunStart[cat];
    let phaseMax = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      for (let pi = 0; pi < g.length; pi++) {
        const id = useStartBase + gi * mult + pi;
        memOldToNew.set(g[pi].m.id, id);
        if (id > phaseMax) phaseMax = id;
      }
    }
    if (phaseMax > catMax[cat]) catMax[cat] = phaseMax;
    _catRunStart[cat] = nextZeroBoundary(phaseMax, mult);
  }
  lastMaxId = Math.max(catMax.Y, catMax.X, catMax.Z);
  lastDiagMaxId = catMax.D;
  const _pageMaxMainMemberId = lastMaxId;
  const _pageMaxDiagMemberId = lastDiagMaxId;
  const _pageMaxMemberId = Math.max(lastMaxId, lastDiagMaxId);
  for (const m of p.members) {
    const nid = memOldToNew.get(m.id);
    if (nid != null) m.id = nid;
  }
  p.members.sort((a, b) => a.id - b.id);
  // 同步全域計數器(只往大跳)
  let maxJ = 0; for (const j of p.joints) if (j.id > maxJ) maxJ = j.id;
  let maxM = 0; for (const m of p.members) if (m.id > maxM) maxM = m.id;
  if (maxJ + 1 > nextJointId)  setNextJointId(maxJ + 1);
  if (maxM + 1 > nextMemberId) setNextMemberId(maxM + 1);
  return { jointGroups: jointGroups.length, finalMax, joints: p.joints.length, members: p.members.length,
           hGroups: hGroups.length, vGroups: vGroups.length, dGroups: dGroups.length,
           oldToNew, memOldToNew,
           maxMemberId: _pageMaxMemberId,
           maxMainMemberId: _pageMaxMainMemberId,
           maxDiagMemberId: _pageMaxDiagMemberId,
           catMax };
}

// 進位到下一個 mult 邊界 + 1 — 跨頁累加 startBase 用
//   舊版用「位數最高位 +1」(digit-based)會造成指數成長:99→101→201→...→1001→2001→...
//   新版用「最大 cap 對齊的 mult」固定步進(cap=9999 → mult=10000)→ 199→201、8859→8901
export function _nextMemberZeroBoundary(n) {
  if (!Number.isFinite(n) || n <= 0) return 1;
  // 用 4 個 cap 中的最大值 +1 當 mult,確保所有方向 phase 的 id 範圍夠用
  const caps = [
    state.memberCapY || 99,
    state.memberCapX || 99,
    state.memberCapZ || 99,
    state.memberCapDiag || 99,
  ];
  const mult = Math.max(...caps) + 1;
  return (Math.floor(n / mult) + 1) * mult + 1;
}

export async function relayoutNumbering() {
  const p = getPage();
  if (!p || p._orphan) { alert("尚未載入底圖頁面"); return; }
  const file = getActiveFile();
  if (typeof setBusyMessage === "function") setBusyMessage(`編排節點編號 — pushUndo 中…`);
  pushUndo();
  // 切面節點/桿件推斷:在重編號之前,先針對 active file 的所有切面線(主關聯 + 衍生),
  //   依「XZ → XY → YZ」順序從其他檔案投影 joints/members 到本檔的切面線上;
  //   F 設定不全或單條切面缺資料 → 跳過該條/該檔。
  //   _populateSectionLinkJointsForFile 是 async,必須 await 才能拿到 stats(不然 slStats 是 Promise)
  let slStats = null;
  if (file && _fileHasFullSetup(file) && state.pageIdx === 0) {
    if (typeof setBusyMessage === "function") setBusyMessage(`切面節點/桿件推斷中…(${file.name})`);
    try { slStats = await _populateSectionLinkJointsForFile(file); }
    catch (e) { console.warn("[切面節點推斷] 失敗", e); slStats = null; }
  }
  if (typeof setBusyMessage === "function") setBusyMessage(`重排當頁編號中…(${p.joints.length} 節點 / ${p.members.length} 桿件)`);
  if (!p.joints.length) {
    if (slStats && (slStats.jointsAdded || slStats.membersAdded)) {
      // 推斷有結果但本來無節點 → 不能跑核心 relayout(空頁直接 render)
      console.log(`[切面節點推斷] 處理 ${slStats.processedLinks} 條切面・新增節點 ${slStats.jointsAdded}・桿件 ${slStats.membersAdded}`);
    } else {
      alert("此頁尚無節點"); return;
    }
  }
  const r = (p.joints.length > 0)
    ? _relayoutPageCore(p, { interactive: true, origin: (file && file.planeOrigin) || null })
    : null;
  if (r) {
    // 同步 active page 上的選取與 pendingLineStart
    state.selection.joints  = new Set([...state.selection.joints ].map(id => r.oldToNew.get(id) ?? id).filter(id => p.joints.some(j => j.id === id)));
    state.selection.members = new Set([...state.selection.members].map(id => r.memOldToNew.get(id) ?? id).filter(id => p.members.some(m => m.id === id)));
    if (typeof state.pendingLineStart === "number") {
      state.pendingLineStart = r.oldToNew.get(state.pendingLineStart) ?? null;
    }
    console.log(`[重排編號] 方向=${state.relayoutDirection}・節點群 ${r.jointGroups}・節點 ${r.joints}(最大內部 ${r.finalMax})・桿件 ${r.members}・桿件群 H${r.hGroups}+V${r.vGroups}+D${r.dGroups}`);
    // hud 確認(若下方 slStats 還有訊息,會被它覆寫)
    $("hud").textContent = `重排完成 ・ 節點 ${r.joints} 重編 ・ 桿件 ${r.members} 重編 ・ 最大內部編號 ${r.finalMax}`;
  } else {
    // _relayoutPageCore 回傳 null — 通常是空頁
    $("hud").textContent = `編排節點編號:此頁無節點可重編`;
  }
  if (slStats) {
    console.log(`[切面節點推斷] 處理 ${slStats.processedLinks} 條切面・新增節點 ${slStats.jointsAdded}・桿件 ${slStats.membersAdded}・略過 ${slStats.skipped}` +
      (slStats.conflicts.length ? `・衝突 ${slStats.conflicts.length} 件` : ""));
    if (slStats.conflicts.length) {
      slStats.conflicts.forEach(c => console.warn("[切面衝突]", c));
      const head = slStats.conflicts.slice(0, 5).join("\n");
      const more = slStats.conflicts.length > 5 ? `\n…(共 ${slStats.conflicts.length} 件,詳見 console)` : "";
      $("hud").textContent = `重排完成・推斷節點 ${slStats.jointsAdded}、桿件 ${slStats.membersAdded}・⚠ 多平行切面衝突 ${slStats.conflicts.length} 件`;
      alert(`偵測到多平行切面衝突:\n\n${head}${more}`);
    } else if (slStats.jointsAdded || slStats.membersAdded) {
      $("hud").textContent = `重排完成・切面新增節點 ${slStats.jointsAdded}、桿件 ${slStats.membersAdded}`;
    }
  }
  render(); refreshLists();
}

// 全局重排:逐頁套用同樣邏輯
export async function relayoutNumberingAll(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  let totalPages = 0;
  for (const f of state.files) {
    for (const k in (f.pages || {})) totalPages++;
  }
  if (!totalPages) { if (!skipConfirm) alert("沒有任何頁面可重排。"); return; }
  if (!skipConfirm && !confirm(`將對全部 ${state.files.length} 個檔案、共 ${totalPages} 個頁面逐頁重排編號。\n\n各頁的節點 / 桿件編號獨立(每頁從 1 開始)。\n建議搭配每頁的「本頁數字」設定避免全域重複。\n\n要繼續嗎?`)) return;
  pushUndo();
  // 起手:先綁定 globalMember + 清同頁重複桿件(避免編號被髒資料污染)
  const preBind = (typeof autoBindGlobalMembers === "function") ? autoBindGlobalMembers() : null;
  const preDedup = dedupSamePageMembers();
  if (preBind || preDedup.dupRemoved || preDedup.zeroLen) {
    console.log(`[全局重排編號] 前置清理 ・ globalMember 新建 ${preBind ? preBind.created : 0} / 綁定 ${preBind ? preBind.bound : 0} ・ 同頁去重 ${preDedup.dupRemoved}(零長 ${preDedup.zeroLen}, 影響 ${preDedup.pagesTouched} 頁)`);
  }
  let ok = 0, skipped = 0, processed = 0;
  // 取消旗標:Esc / 取消鈕 → 設 true → 下一個 task 迭代開頭檢查 → 跳出迴圈,已處理頁面保留
  let cancelled = false;
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !cancelled) { cancelled = true; setBusyMessage("取消中…等當前頁完畢"); }
  };
  document.addEventListener("keydown", onEsc, true);
  showBusyWithCancel && showBusyWithCancel(`編排節點編號(全部頁面) 準備中…(共 ${totalPages} 頁・Esc / 取消可中斷)`, () => {
    if (cancelled) return;
    cancelled = true;
    setBusyMessage("取消中…等當前頁完畢");
  });
  await (typeof busyTick === "function" ? busyTick() : Promise.resolve());
  // 平面處理順序:XY > YZ > XZ(每個 plane 集合內維持檔案 / 頁面原順序)
  const planeOrder = { "XY": 0, "YZ": 1, "XZ": 2 };
  const tasks = [];
  for (const f of state.files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      const order = planeOrder[pg && pg.plane] ?? 99;
      tasks.push({ f, pg, k, order });
    }
  }
  // stable sort:按 plane 順序,同 plane 內保持原順序
  tasks.sort((a, b) => a.order - b.order);
  // 跨頁累加桿件 startBase:每頁結束後用 _nextMemberZeroBoundary 進位 → 下一頁繼續編
  let memberStartBase = 1;
  let lastMemberMax = 0;
  for (const t of tasks) {
    if (cancelled) break;
    processed++;
    if (typeof setBusyMessage === "function") setBusyMessage(`編排節點編號 ${processed}/${totalPages}・${t.f.name}・頁 ${t.k}・${t.pg.plane || "?"}・桿件起始 ${memberStartBase}`);
    await (typeof busyTick === "function" ? busyTick() : Promise.resolve());
    if (cancelled) break;
    const r = _relayoutPageCore(t.pg, {
      interactive: false,
      origin: t.f.planeOrigin || null,
      memberStartBase,
      numbering: opts.numbering,
    });
    if (r) {
      ok++;
      if (Number.isFinite(r.maxMemberId) && r.maxMemberId > 0) {
        lastMemberMax = r.maxMemberId;
        memberStartBase = _nextMemberZeroBoundary(r.maxMemberId);
      }
    } else skipped++;
  }
  document.removeEventListener("keydown", onEsc, true);
  if (cancelled) {
    if (typeof hideBusy === "function") hideBusy();
    console.log(`[全局重排編號] 已取消・已處理 ${processed}/${totalPages} 頁(已完成的保留,可用 Ctrl+Z 還原)`);
    if (!skipConfirm) setTimeout(() => alert(`重排節點編號已取消・已處理 ${processed}/${totalPages} 頁(已完成的保留,可用 Ctrl+Z 還原)`), 30);
    return;
  }
  if (typeof hideBusy === "function") hideBusy();
  state.selection.joints.clear();
  state.selection.members.clear();
  state.pendingLineStart = null;
  // 收尾:跨頁同物理桿件 ID 融合
  const unifyStats = unifyCrossPageMemberIds();
  if (unifyStats.gmsUnified || unifyStats.rewritten || unifyStats.conflicts) {
    console.log(`[全局重排編號] 跨頁融合 ・ gm ${unifyStats.gmsUnified} / 改寫 member ${unifyStats.rewritten}` +
      (unifyStats.conflicts ? ` / 衝突跳過 ${unifyStats.conflicts}` : ""));
  }
  console.log(`[全局重排編號] 完成 ${ok} 頁(略過空頁 ${skipped})・方向=${state.relayoutDirection}・cap=${state.relayoutCapacity}・桿件最終 max=${lastMemberMax}`);
  render(); refreshLists();
  if (!skipConfirm) alert(`全局重排編號完成:${ok} 頁已重編,${skipped} 頁略過(無節點)。\n桿件最終 max=${lastMemberMax}・跨頁融合 gm ${unifyStats.gmsUnified} / member ${unifyStats.rewritten}` +
    (unifyStats.conflicts ? `・衝突跳過 ${unifyStats.conflicts}` : ""));
}

// === 只重排桿件編號(不動節點 ID)===
//   套用 Y > X > Z > 斜撐 順序,從 planeOrigin 開始遞增循環。
//   節點 ID 保持不動,桿件的 j1 / j2 仍指向同一個節點。
export async function relayoutMembersNumbering() {
  const p = getPage();
  if (!p || p._orphan) { alert("尚未載入底圖頁面"); return; }
  const file = getActiveFile();
  if (typeof setBusyMessage === "function") setBusyMessage(`編排桿件編號 — pushUndo 中…`);
  pushUndo();
  if (typeof setBusyMessage === "function") setBusyMessage(`重排當頁桿件編號中…(${(p.members || []).length} 桿件)`);
  const r = _relayoutPageCore(p, {
    interactive: true,
    origin: (file && file.planeOrigin) || null,
    membersOnly: true,
  });
  if (r) {
    // 同步選取上的 member id 對應
    state.selection.members = new Set([...state.selection.members]
      .map(id => r.memOldToNew.get(id) ?? id)
      .filter(id => p.members.some(m => m.id === id)));
    console.log(`[重排桿件編號] 方向=${state.relayoutDirection}・桿件 ${r.members}・桿件群 H${r.hGroups}+V${r.vGroups}+D${r.dGroups}・plane=${p.plane}`);
    $("hud").textContent = `桿件編號完成 ・ ${r.members} 條重編(plane=${p.plane}・順序 ${p.plane === "XZ" ? "X→Z→斜" : "Y→" + (p.plane === "YZ" ? "Z" : "X") + "→斜"})`;
  } else {
    $("hud").textContent = `編排桿件編號:此頁無桿件可重編`;
  }
  render(); refreshLists();
}
export async function relayoutMembersNumberingAll(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  const NB = _resolveNumbering(opts.numbering);   // structure pipeline 可調(Stage 1 柱判定用)
  let totalPages = 0;
  for (const f of state.files) for (const k in (f.pages || {})) totalPages++;
  if (!totalPages) { if (!skipConfirm) alert("沒有任何頁面可重排。"); return; }
  if (!skipConfirm && !confirm(`對全部 ${state.files.length} 個檔案、共 ${totalPages} 個頁面逐頁重排桿件編號。\n節點 ID 不動。Ctrl+Z 可還原。要繼續嗎?`)) return;
  pushUndo();
  // 起手:先綁定 globalMember + 清同頁重複(保證後續單頁編號不受髒資料影響)
  const preBind = (typeof autoBindGlobalMembers === "function") ? autoBindGlobalMembers() : null;
  const preDedup = dedupSamePageMembers();
  if (preBind || preDedup.dupRemoved || preDedup.zeroLen) {
    console.log(`[全局重排桿件編號] 前置清理 ・ globalMember 新建 ${preBind ? preBind.created : 0} / 綁定 ${preBind ? preBind.bound : 0} ・ 同頁去重 ${preDedup.dupRemoved}(零長 ${preDedup.zeroLen}, 影響 ${preDedup.pagesTouched} 頁)`);
  }
  // ★ 清空所有 m.id 為唯一負數 sentinel(-1, -2, -3, ...)
  //   讓「沒被任何 stage 分類處理到的桿件」最後 m.id 還留著負號 → 可掃出來補 fallback
  //   負數 unique → 不會跟 stage 寫進來的正號 id 撞;每根有獨立 key,_relayoutPageCore 的
  //   memOldToNew indirection 仍正常運作
  {
    let _sentinel = -1;
    let _cleared = 0;
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || (pg as any)._orphan) continue;
        for (const m of ((pg as any).members || [])) {
          (m as any).id = _sentinel--;
          _cleared++;
        }
      }
    }
    console.log(`[全局重排桿件編號] 清空 m.id 為 sentinel ${_cleared} 條(stage 跑完後沒被覆寫的會留負號 → 視為 leftover)`);
  }
  let ok = 0, skipped = 0, processed = 0;
  // 取消旗標:Esc / 取消鈕 → 設 true → Stage 1/2/2b/2c/3/4 各 loop 開頭檢查 → 中斷
  //   step-level 取消:當前頁跑完才會 break,不會中斷一頁進行中的編號(避免 m.id 半成品狀態)
  let cancelled = false;
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !cancelled) { cancelled = true; setBusyMessage("取消中…等當前頁完畢"); }
  };
  document.addEventListener("keydown", onEsc, true);
  showBusyWithCancel && showBusyWithCancel(`編排桿件編號(全部頁面) 準備中…(共 ${totalPages} 頁・Esc / 取消可中斷)`, () => {
    if (cancelled) return;
    cancelled = true;
    setBusyMessage("取消中…等當前頁完畢");
  });
  await busyTick();
  // Y 軸(柱)優先 — XY / YZ 立面頁有 Y phase,先讓那些頁面跑完 → Y-axis 拿低位 ID;之後才 XZ
  const planeOrder = { "XY": 0, "YZ": 1, "XZ": 2 };
  // 樓層類型優先序:用 yyStart 升序排;XZ 頁才看 pg.floorType,其他平面不分樓層型
  const ftOrderOf = (pg) => {
    if (!pg || pg.plane !== "XZ") return 0;
    const key = pg.floorType || "default";
    const t = (state.floorTypes || []).find(x => x.key === key);
    return (t && Number.isFinite(t.yyStart)) ? t.yyStart : 9999;
  };
  const tasks = [];
  for (const f of state.files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      tasks.push({
        f, pg, k,
        order: planeOrder[pg && pg.plane] ?? 99,
        ftOrder: ftOrderOf(pg),
        elev: (pg && Number.isFinite(pg.z)) ? pg.z : Infinity,
      });
    }
  }
  // XZ 頁排序:plane 先(XY → YZ → XZ),XZ 內部再按 floorType yyStart → elev → 檔名 → 頁索引;
  //   讓「同一樓層類型的所有 XZ 頁先處理完,再換下一個 type」這個順序成立。
  tasks.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.ftOrder !== b.ftOrder) return a.ftOrder - b.ftOrder;
    if (a.elev !== b.elev) return a.elev - b.elev;
    if (a.f.name !== b.f.name) return a.f.name.localeCompare(b.f.name);
    return (+a.k) - (+b.k);
  });
  // ★ 4 個獨立的 code block,順序依照 user 規定:
  //   Stage 1: Y 軸柱 (XY / YZ 頁面) — 用原始未修改的 Y 軸邏輯,從 1 起跑跨頁累加
  //   Stage 2: XZ 平面 page-by-page,每頁順序為 row(X)→ column(Z)→ brace(D);
  //            頁面排序:floorType yyStart 升序(default 最後)→ 同型內 elev 升序;
  //            X/Z 共用單一累加器(從 max(2501, Pass1_max+1) 起);D 用獨立累加器(100001+)
  //   Stage 3: YZ 平面 brace(D 桿件)— 跨頁 D 累加器接續 Stage 2 的 D
  //   Stage 4: XY 平面 brace(D 桿件)— 同上
  //   各階段完全獨立 — 改某階段邏輯不會影響其他階段。
  let lastMemberMax = 0;
  const phaseMax = { Y: 0, X: 0, Z: 0, D: 0 };

  // 單頁單 phase 的呼叫 helper
  const _renumOnePage = (pg, fileOrigin, phaseKey, startBase) => {
    return _relayoutPageCore(pg, {
      interactive: false,
      origin: fileOrigin || null,
      membersOnly: true,
      phaseOnly: phaseKey,
      catStartBase: { Y: startBase, X: startBase, Z: startBase, D: startBase },
      numbering: opts.numbering,
    });
  };

  // ============================================================
  // Stage 1: Y 軸(柱)— ★ 全域處理,不依頁面 / floorType / 節點分桿件順序 ★
  //
  //   作法:
  //     1. 跨頁掃所有 XY / YZ 頁面的 Y 軸 member(2D vertical),投影到 3D world coords
  //     2. 用 globalMemberId 去重(沒 globalMemberId 的用 (x, y, z) 端點 key 去重)
  //     3. 把同一根物理柱的多段(同 worldX、同 worldZ,不同 worldY)合成 1 個 group
  //     4. 群按 (worldX 升序 → worldZ 升序)排序;群內按 worldY 升序(由下而上)排
  //     5. 序貫編號:gi=0 第 1 根柱,gi=1 第 2 根柱…,IDs 1..N、101..、201..
  //     6. 把編號寫回所有 page-local 副本(看 globalMemberId 或座標匹配)
  //
  //   優點:Y 軸編號完全跟頁面切割無關,同根柱 ID 連續,跨頁副本同步。
  // ============================================================
  {
    if (typeof setBusyMessage === "function") setBusyMessage(`[1/4] Y 軸(柱)— 全域收集 …`);
    await busyTick();
    // 步驟 1+2:掃 XY/YZ 頁的 Y 軸 member,投影 → 3D。用 globalMemberId 去重。
    // ★ 全程用「精準度(state.measureDecimals)」round 後的 mm 座標做分類與群組
    //   避免 CAD 匯入的 sub-precision 漂移(< 顯示精準度的值)造成短桿件分類錯誤
    type ColMember = { pageMembers: any[]; world: { x: number; y1: number; y2: number; z: number; midY: number } };
    const colMemberByGm = new Map<number, ColMember>();   // globalMemberId → 物理 member
    const colMemberAnon: ColMember[] = [];                 // 沒 globalMemberId 的 member(以座標 fallback)
    const angleTol = NB.angleTol;
    const epsMm = 0.5;   // mm
    const _stage1Md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
    const _stage1Rnd = (v: number) => { const r = parseFloat(v.toFixed(_stage1Md)); return r === 0 ? 0 : r; };
    for (const f of state.files) {
      const ratio = (f.scaleRuler && f.scaleRuler.ratio > 0) ? f.scaleRuler.ratio : (state.scale ? 1 / state.scale : 1);
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k]; if (!pg || pg._orphan) continue;
        if (pg.plane !== "XY" && pg.plane !== "YZ") continue;
        const jById = new Map(pg.joints.map(j => [j.id, j]));
        for (const m of pg.members) {
          const a = jById.get(m.j1), b = jById.get(m.j2);
          if (!a || !b) continue;
          // page-local pixel → mm,再套精準度 round → 才算 dx / dy(分類)
          const axMm = _stage1Rnd(a.x * ratio), bxMm = _stage1Rnd(b.x * ratio);
          const ayMm = _stage1Rnd(a.y * ratio), byMm = _stage1Rnd(b.y * ratio);
          const dx = Math.abs(bxMm - axMm), dy = Math.abs(byMm - ayMm);
          const len = Math.hypot(dx, dy);
          if (len < epsMm) continue;
          if (dx / len >= angleTol) continue;   // 不是 2D vertical → 不是 Y 軸
          // 投影:joint2DToWorld3D 用該 page 的 plane/origin/ratio,然後套精準度
          const wa = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(f, pg, a) : null;
          const wb = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(f, pg, b) : null;
          if (!wa || !wb) continue;
          const wax = _stage1Rnd(wa.x), way = _stage1Rnd(wa.y), waz = _stage1Rnd(wa.z);
          const wbx = _stage1Rnd(wb.x), wby = _stage1Rnd(wb.y), wbz = _stage1Rnd(wb.z);
          const wX = (wax + wbx) / 2, wZ = (waz + wbz) / 2;
          const y1 = Math.min(way, wby), y2 = Math.max(way, wby);
          const entry: ColMember = {
            pageMembers: [{ pg, m, file: f }],
            world: { x: wX, y1, y2, z: wZ, midY: (y1 + y2) / 2 },
          };
          if (m.globalMemberId != null) {
            const existing = colMemberByGm.get(m.globalMemberId);
            if (existing) existing.pageMembers.push({ pg, m, file: f });
            else colMemberByGm.set(m.globalMemberId, entry);
          } else {
            colMemberAnon.push(entry);
          }
        }
      }
    }
    const allColMembers: ColMember[] = [...colMemberByGm.values(), ...colMemberAnon];
    // 步驟 3:群組同根柱(同 worldX、同 worldZ);bucket 大小跟「精準度」連動
    //   md=0 → bucket=1mm;md=1 → 0.1mm;… 等於把同一精準度顯示值的座標合成一群
    const _bucketTolMm = Math.max(1, Math.pow(10, -_stage1Md));
    const _rk = (v: number) => Math.round(v / _bucketTolMm) * _bucketTolMm;
    const columnGroups = new Map<string, ColMember[]>();
    for (const cm of allColMembers) {
      const key = `${_rk(cm.world.x)}|${_rk(cm.world.z)}`;
      if (!columnGroups.has(key)) columnGroups.set(key, []);
      columnGroups.get(key)!.push(cm);
    }
    // 步驟 4:外圈群序按 worldZ wrap-from-origin → worldX wrap-from-origin
    //   (0 → 正向 ascending → 負向 ascending,從世界原點 (0,0,0) 出發 wrap)
    //   內圈按 worldY wrap-from-origin(0 那層先,再往上,再從最低層往上回到 0)
    //   sort tol 用 bucket tol 跟分群一致(差距 < tol 視同同層)
    const sortedCols = [...columnGroups.values()].sort((g1, g2) => {
      const z1 = g1[0].world.z, z2 = g2[0].world.z;
      if (Math.abs(z1 - z2) > _bucketTolMm) return _wrapPosSort(z1, z2);
      return _wrapPosSort(g1[0].world.x, g2[0].world.x);
    });
    for (const g of sortedCols) g.sort((a, b) => _wrapPosSort(a.world.midY, b.world.midY));
    // 步驟 5+6:序貫編號,寫回 page-local m.id
    const cap = state.memberCapY || 99, mult = cap + 1;
    let curStart = 1;
    let i = 0;
    for (const g of sortedCols) {
      if (cancelled) break;
      i++;
      if (typeof setBusyMessage === "function" && (i % 50 === 0 || i === sortedCols.length)) {
        setBusyMessage(`[1/4] Y 軸(柱)・編號中 ${i}/${sortedCols.length}・起始 ${curStart}`);
        await busyTick();
      }
      let phaseMaxLocal = 0;
      for (let pi = 0; pi < g.length; pi++) {
        const giOffset = Math.floor(pi / cap);
        const piIn = pi % cap;
        const newId = curStart + giOffset * mult + piIn;
        for (const pm of g[pi].pageMembers) {
          pm.m.id = newId;
        }
        if (newId > phaseMaxLocal) phaseMaxLocal = newId;
      }
      if (phaseMaxLocal > phaseMax.Y) phaseMax.Y = phaseMaxLocal;
      curStart = _nextMemberZeroBoundary(phaseMaxLocal);
    }
    // 排序更新各頁的 members 陣列(讓 m.id 升序)
    for (const f of state.files) {
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k]; if (!pg || pg._orphan) continue;
        if (pg.plane !== "XY" && pg.plane !== "YZ") continue;
        pg.members.sort((a, b) => a.id - b.id);
      }
    }
    if (sortedCols.length) {
      processed += sortedCols.length;
      console.log(`[Stage 1] Y 軸全域編號完成:${sortedCols.length} 根柱,${allColMembers.length} 個段,max ID = ${phaseMax.Y}`);
    }
  }

  // ============================================================
  // Stage 2: XZ 平面 page-by-page — 每頁順序 row(X) → column(Z) → brace(D)
  //   ★ 單一 curStart 累加器:X、Z、D 全部接續累加(brace 接在 column 結束的下一個 100 邊界)
  //   ★ Stage 2b/2c/3/4 也都用同一 curStart,所有號碼連續
  // ============================================================
  // _curStart:跨 Stage 2/2b/2c/3/4 共用的單一累加器
  let _curStart = Math.max(2501,
    phaseMax.Y > 0 ? _nextMemberZeroBoundary(phaseMax.Y) : 1);
  {
    console.log(`[Stage 2 XZ] 起始 curStart=${_curStart} (phaseMax.Y=${phaseMax.Y})`);
    const _advance = (mx: number, cat: "X" | "Z" | "D") => {
      if (!Number.isFinite(mx) || mx <= 0) return;
      if (mx > (phaseMax as any)[cat]) (phaseMax as any)[cat] = mx;
      _curStart = _nextMemberZeroBoundary(mx);
    };
    for (const t of tasks) {
      if (cancelled) break;
      if (t.pg.plane !== "XZ") continue;
      processed++;
      const pageTag = `${t.f.name}#${t.k}(z=${t.pg.z})`;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[2/4] XZ 平面・${pageTag}・起始 ${_curStart}`);
      }
      await busyTick();
      const before = _curStart;
      // 同一頁依序 X → Z → D,全部共用同一累加器
      let r = _renumOnePage(t.pg, t.f.planeOrigin, "X", _curStart);
      const xMax = (r && r.catMax) ? r.catMax.X : 0;
      _advance(xMax, "X");
      r = _renumOnePage(t.pg, t.f.planeOrigin, "Z", _curStart);
      const zMax = (r && r.catMax) ? r.catMax.Z : 0;
      _advance(zMax, "Z");
      r = _renumOnePage(t.pg, t.f.planeOrigin, "D", _curStart);
      const dMax = (r && r.catMax) ? r.catMax.D : 0;
      _advance(dMax, "D");
      console.log(`[Stage 2 XZ] ${pageTag} ${before} → X[max=${xMax}] Z[max=${zMax}] D[max=${dMax}] → next ${_curStart}`);
    }
    // Stage 2b:X 軸在 XY 頁(若有)— 接續 _curStart
    for (const t of tasks) {
      if (cancelled) break;
      if (t.pg.plane !== "XY") continue;
      const pageTag = `${t.f.name}#${t.k}(XY,z=${t.pg.z})`;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[2b/4] X 軸@XY・${pageTag}・起始 ${_curStart}`);
      }
      await busyTick();
      const before = _curStart;
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "X", _curStart);
      const xMax = (r && r.catMax) ? r.catMax.X : 0;
      _advance(xMax, "X");
      console.log(`[Stage 2b X@XY] ${pageTag} ${before} → X[max=${xMax}] → next ${_curStart}`);
    }
    // Stage 2c:Z 軸在 YZ 頁 — 接續 _curStart
    for (const t of tasks) {
      if (cancelled) break;
      if (t.pg.plane !== "YZ") continue;
      const pageTag = `${t.f.name}#${t.k}(YZ,z=${t.pg.z})`;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[2c/4] Z 軸@YZ・${pageTag}・起始 ${_curStart}`);
      }
      await busyTick();
      const before = _curStart;
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "Z", _curStart);
      const zMax = (r && r.catMax) ? r.catMax.Z : 0;
      _advance(zMax, "Z");
      console.log(`[Stage 2c Z@YZ] ${pageTag} ${before} → Z[max=${zMax}] → next ${_curStart}`);
    }
  }

  // ============================================================
  // Stage 3: YZ 平面 brace(D)— 接續同一 _curStart
  // ============================================================
  {
    for (const t of tasks) {
      if (cancelled) break;
      if (t.pg.plane !== "YZ") continue;
      processed++;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[3/4] YZ 平面 brace・${t.f.name}#${t.k}・起始 ${_curStart}`);
      }
      await busyTick();
      const before = _curStart;
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "D", _curStart);
      if (r && r.catMax && Number.isFinite(r.catMax.D) && r.catMax.D > 0) {
        if (r.catMax.D > phaseMax.D) phaseMax.D = r.catMax.D;
        _curStart = _nextMemberZeroBoundary(r.catMax.D);
      }
      console.log(`[Stage 3 D@YZ] ${t.f.name}#${t.k} ${before} → D[max=${r && r.catMax ? r.catMax.D : 0}] → next ${_curStart}`);
    }
  }

  // ============================================================
  // Stage 4: XY 平面 brace(D)— 跨頁連續編號(不對齊 100-block)
  //   每個 XY 頁可能只有 1-2 條 D,如果每頁跑完都對齊 100-block,會看到 61501,61502 → 61601 跳號
  //   改成頁間 +1 連續,所有 XY 頁跑完才對齊 100-block 給下一階段
  // ============================================================
  {
    let runStart = _curStart;
    for (const t of tasks) {
      if (cancelled) break;
      if (t.pg.plane !== "XY") continue;
      processed++;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[4/4] XY 平面 brace・${t.f.name}#${t.k}・起始 ${runStart}`);
      }
      await busyTick();
      const before = runStart;
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "D", runStart);
      if (r && r.catMax && Number.isFinite(r.catMax.D) && r.catMax.D > 0) {
        if (r.catMax.D > phaseMax.D) phaseMax.D = r.catMax.D;
        runStart = r.catMax.D + 1;   // ★ +1 不跳 100-block,頁間連續
      }
      console.log(`[Stage 4 D@XY] ${t.f.name}#${t.k} ${before} → D[max=${r && r.catMax ? r.catMax.D : 0}] → next ${runStart}`);
    }
    // 全部 XY D 跑完後對齊 100-block(雖然 Stage 4 是最後一階段,但留著保險)
    _curStart = _nextMemberZeroBoundary(runStart - 1);
  }

  ok = state.files.reduce((s, f) => s + Object.keys(f.pages || {}).length, 0);
  skipped = 0;
  lastMemberMax = Math.max(phaseMax.Y, phaseMax.X, phaseMax.Z, phaseMax.D);
  if (typeof hideBusy === "function") hideBusy();
  state.selection.members.clear();
  // ★ Leftover 掃描:m.id 仍是負數的桿件 = 沒被任何 stage 分類處理到
  //   (常見原因:短桿件被長度門檻過濾、座標漂移卡在分類邊界、page._orphan 但又跑進去等)
  //   策略:從 maxPhase 之後的下一個 100-block 起連續派 fallback id,並標進 memberCollisions
  //   讓畫面亮綠色高亮,使用者可進一步檢查
  let _leftoverCount = 0;
  {
    const _maxPhase = Math.max(phaseMax.Y, phaseMax.X, phaseMax.Z, phaseMax.D, 0);
    let _fb = _maxPhase > 0 ? _nextMemberZeroBoundary(_maxPhase) : 1;
    if (!state.memberCollisions) state.memberCollisions = new Set();
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || (pg as any)._orphan) continue;
        for (const m of ((pg as any).members || [])) {
          if (Number.isFinite((m as any).id) && (m as any).id < 0) {
            (m as any).id = _fb;
            (state.memberCollisions as Set<number>).add(_fb);
            _fb++;
            _leftoverCount++;
          }
        }
      }
    }
    if (_leftoverCount) {
      console.warn(`[全局重排桿件編號] Stage 1~4 後仍有 ${_leftoverCount} 條桿件未被分類處理 → 派 fallback id 從 ${_nextMemberZeroBoundary(_maxPhase)} 起,並亮綠色高亮提示`);
      lastMemberMax = Math.max(lastMemberMax, _fb - 1);
    }
  }
  // 收尾:跨頁同物理桿件 ID 融合(同 globalMemberId → 最小 id)
  const unifyStats = unifyCrossPageMemberIds();

  // ============================================================
  // 偵測撞號 — 不同 globalMemberId 但同 m.id 的桿件(只標記,不改 ID,讓使用者比對)
  //   原因常見:有些 plane(例如 X 軸在 XY 頁面)沒被 4 個 stage 處理到,留下舊 m.id 跟新 ID 撞號。
  //   策略:不重編號,維持原本 m.id;只把撞號 m.id 加進 state.memberCollisions
  //   (亮綠色高亮 + popup 警示;使用者可在搜尋視窗看到所有共用同 m.id 的桿件)
  // ============================================================
  state.memberCollisions = new Set();
  {
    const byId = new Map();
    for (const f of state.files) {
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k];
        if (!pg || pg._orphan) continue;
        for (const m of pg.members) {
          if (!byId.has(m.id)) byId.set(m.id, []);
          byId.get(m.id).push({ file: f, pg, m });
        }
      }
    }
    let collisionCount = 0, memberCount = 0;
    for (const [id, list] of byId) {
      if (list.length <= 1) continue;
      // 用 globalMemberId 分組(同 gm = 同物理桿件副本,不算撞號)
      const gmGroups = new Map();
      for (const entry of list) {
        const gm = entry.m.globalMemberId != null ? `g${entry.m.globalMemberId}`
          : `_a${entry.file.id}_${entry.pg && entry.pg.plane}_${entry.m.j1}_${entry.m.j2}`;
        if (!gmGroups.has(gm)) gmGroups.set(gm, []);
        gmGroups.get(gm).push(entry);
      }
      if (gmGroups.size <= 1) continue;   // 全部是同一根物理桿件的跨頁副本 → 沒撞號
      // 真撞號:標記 id,不改編號(讓使用者用搜尋對比哪些桿件共用同 m.id)
      collisionCount++;
      state.memberCollisions.add(id);
      memberCount += list.length;
    }
    if (collisionCount) {
      console.warn(`[桿件編號重排] 偵測到 ${collisionCount} 組撞號 m.id,涉及 ${memberCount} 條桿件;在畫面上以亮綠色高亮,切到該頁時跳出 popup 提示`);
    } else {
      console.log(`[桿件編號重排] 無撞號`);
    }
  }
  if (unifyStats.gmsUnified || unifyStats.rewritten || unifyStats.conflicts) {
    console.log(`[全局重排桿件編號] 跨頁融合 ・ gm ${unifyStats.gmsUnified} / 改寫 member ${unifyStats.rewritten}` +
      (unifyStats.conflicts ? ` / 衝突跳過 ${unifyStats.conflicts}` : ""));
  }
  document.removeEventListener("keydown", onEsc, true);
  console.log(`[全局重排桿件編號] ${cancelled ? "已取消" : "完成"} ${ok} 頁(略過空頁 ${skipped})・桿件最終 max=${lastMemberMax}`);
  render(); refreshLists();
  if (!skipConfirm) {
    if (cancelled) {
      alert(`全局重排桿件編號已取消・處理了 ${ok} 頁(已完成的保留,可用 Ctrl+Z 還原)`);
    } else {
      alert(`全局重排桿件編號完成:${ok} 頁已重編,${skipped} 頁略過。\n桿件最終 max=${lastMemberMax}・跨頁融合 gm ${unifyStats.gmsUnified} / member ${unifyStats.rewritten}` +
        (unifyStats.conflicts ? `・衝突跳過 ${unifyStats.conflicts}` : ""));
    }
  }
}
