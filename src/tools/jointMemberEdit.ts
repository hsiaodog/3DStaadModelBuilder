// 節點 / 桿件編輯操作集中區
//
//   Extend / Duplicate / Split / Add / Delete / Intersection / Dedup 系列
//   selection helpers(clearSelection / _assertSelectionOnActivePage /
//     _markSelectionSourceIfEmpty / additiveSelect / subtractiveSelect)也一起搬,
//     因為它們是 edit ops 的前置條件 + 跟這些函式緊密耦合
//
//   多數函式由 src/ui/selectToolsPanel.ts 的按鈕 onclick(下一輪會抽)觸發;
//   也被 context menu / canvas 直接點擊 commit 等流程呼叫。
// @ts-nocheck

import {
  $, state, getPage, getActiveFile,
  pushUndo, render, refreshLists, withBusy,
  jointById, screenToWorld,
  ensureJointAt, syncJointAcrossViews,
  unbindJointFromGlobal, snapToBgVertex,
  activatePageWithBusy,
  allocJointId, allocMemberId, allocFileId, allocGlobalJointId, allocGlobalMemberId,
} from "../legacy";
import { invalidateRankCache } from "../core/rankCache";

export function extendSelectedMembersToIntersect(bothEnds) {
  const p = getPage(); if (!p) return;
  if (state.selection.members.size === 0) {
    alert("請先選取至少一條桿件");
    return;
  }
  pushUndo();
  const eps = 1e-3;
  let moved = 0;
  const targets = [];   // { member, endKey: "j1"|"j2", x, y }
  for (const mid of state.selection.members) {
    const m = p.members.find(mm => mm.id === mid);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < eps) continue;
    let bestA = null, bestB = null;
    // 候選 1:其他桿件的延伸交點(原本邏輯)
    for (const o of p.members) {
      if (o.id === m.id) continue;
      if (o.j1 === m.j1 || o.j1 === m.j2 || o.j2 === m.j1 || o.j2 === m.j2) continue;
      const c = jointById(o.j1), d = jointById(o.j2);
      if (!c || !d) continue;
      const denom = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
      if (Math.abs(denom) < eps) continue;
      const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denom;
      const s = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denom;
      if (s < -eps || s > 1 + eps) continue;
      const px = a.x + t * (b.x - a.x);
      const py = a.y + t * (b.y - a.y);
      if (t < -eps) {
        if (bestA === null || (-t) < (-bestA.t)) bestA = { t, x: px, y: py };
      } else if (t > 1 + eps) {
        if (bestB === null || (t - 1) < (bestB.t - 1)) bestB = { t, x: px, y: py };
      }
    }
    // 候選 2:孤立節點(或任何 joint)落在沿線方向上 — 用該 joint 當延伸目標
    //   tol 0.5 world units;計算 J 到 a-b 線的垂直距離 + 沿線參數 t
    const jTol = 0.5;
    const dxAB = b.x - a.x, dyAB = b.y - a.y;
    for (const j of p.joints) {
      if (j.id === m.j1 || j.id === m.j2) continue;
      const t = ((j.x - a.x) * dxAB + (j.y - a.y) * dyAB) / lenSq;
      const px = a.x + t * dxAB, py = a.y + t * dyAB;
      const perp = Math.hypot(j.x - px, j.y - py);
      if (perp > jTol) continue;            // 不在線上
      if (t < -eps) {
        if (bestA === null || (-t) < (-bestA.t)) bestA = { t, x: j.x, y: j.y, jointId: j.id };
      } else if (t > 1 + eps) {
        if (bestB === null || (t - 1) < (bestB.t - 1)) bestB = { t, x: j.x, y: j.y, jointId: j.id };
      }
    }
    // 方向阻擋:若延伸該端的方向上已有共線同向桿件,跳過該端
    const aBlocked = bestA ? jointHasCollinearMemberInDirection(a, a.x - b.x, a.y - b.y) : true;
    const bBlocked = bestB ? jointHasCollinearMemberInDirection(b, b.x - a.x, b.y - a.y) : true;
    if (bothEnds) {
      if (bestA && !aBlocked) targets.push({ m, endKey: "j1", x: bestA.x, y: bestA.y, jointId: bestA.jointId });
      if (bestB && !bBlocked) targets.push({ m, endKey: "j2", x: bestB.x, y: bestB.y, jointId: bestB.jointId });
    } else {
      // 只挑距離較近的一端(|t| 最小或 t-1 最小);被阻擋的端視為不可延伸
      const dA = (bestA && !aBlocked) ? -bestA.t : Infinity;
      const dB = (bestB && !bBlocked) ? (bestB.t - 1) : Infinity;
      if (bestA && !aBlocked && dA <= dB)  targets.push({ m, endKey: "j1", x: bestA.x, y: bestA.y, jointId: bestA.jointId });
      else if (bestB && !bBlocked)         targets.push({ m, endKey: "j2", x: bestB.x, y: bestB.y, jointId: bestB.jointId });
    }
  }
  // 統一套用:目標若為既有 joint → 直接重指端點到該 joint;否則建新 joint(共用) / 移動原 joint
  const formerEndpoints = new Set();    // 因為延伸到既有 joint 而被「換掉」的原端點 id
  for (const t of targets) {
    if (t.jointId != null) {
      // 延伸到既有 joint:把 member 端點重指過去;紀錄被換掉的原端點 id 以便事後清理
      const oldId = t.m[t.endKey];
      t.m[t.endKey] = t.jointId;
      if (oldId !== t.jointId) formerEndpoints.add(oldId);
    } else {
      const jId = t.m[t.endKey];
      const shared = p.members.some(mm => mm !== t.m && (mm.j1 === jId || mm.j2 === jId));
      if (shared) {
        const nj = { id: allocJointId(), x: t.x, y: t.y };
        p.joints.push(nj);
        t.m[t.endKey] = nj.id;
      } else {
        const j = jointById(jId);
        if (j) { j.x = t.x; j.y = t.y; }
      }
    }
    moved++;
  }
  // 清掉「原端點變孤立」的 joint(只清因延伸而換掉、且現在沒被任何 member 引用的)
  let removedOrphans = 0;
  if (formerEndpoints.size) {
    const used = new Set();
    for (const m of p.members) { used.add(m.j1); used.add(m.j2); }
    const toRemove = p.joints.filter(j => formerEndpoints.has(j.id) && !used.has(j.id));
    for (const j of toRemove) {
      if (j.globalId != null && typeof unbindJointFromGlobal === "function") unbindJointFromGlobal(j);
    }
    const removedSet = new Set(toRemove.map(j => j.id));
    p.joints = p.joints.filter(j => !removedSet.has(j.id));
    removedOrphans = toRemove.length;
  }
  if (moved === 0) {
    alert("沒有可延伸的端點 — 找不到沿線方向的交叉桿件,或延伸方向已有桿件");
    return;
  }
  // 確保延伸建立的線不重複/重疊:合併同位節點、去重、共線拆段
  const cr = _consolidateInPlace();
  console.log(`[延伸至交點] 延伸 ${moved} 個端點;移除原端點 ${removedOrphans};整理 合併 ${cr.mergedJ} / 去重 ${cr.droppedM} / 拆段 ${cr.splitM}`);
  render(); refreshLists();
}

// 從選取節點沿軸向延伸,在最近的桿件交點建新 joint + 新桿件
// axis: "h" = 水平(沿 X);"v" = 垂直(沿 Y)
// bothSides: false → 只挑兩側最近的一邊;true → 兩邊各建一條
export function extendJointAxisToIntersect(axis, bothSides) {
  const p = getPage(); if (!p) return;
  if (state.selection.joints.size === 0) {
    alert("請先選取至少一個節點");
    return;
  }
  pushUndo();
  const eps = 1e-3;
  let added = 0;
  for (const jid of [...state.selection.joints]) {
    const j = jointById(jid);
    if (!j) continue;
    let bestNeg = null, bestPos = null;   // 沿 axis 軸:Neg = 較小座標方向、Pos = 較大座標方向
    for (const m of p.members) {
      if (m.j1 === jid || m.j2 === jid) continue;     // 跳過與此節點相連的桿件
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      let px, py;
      if (axis === "h") {
        // 水平射線 y = j.y → 與 ab 交點
        const dy = b.y - a.y;
        if (Math.abs(dy) < eps) continue;             // 平行(目標也是水平)→ 跳過
        const t = (j.y - a.y) / dy;
        if (t < -eps || t > 1 + eps) continue;        // 不在 ab 線段內
        px = a.x + t * (b.x - a.x);
        py = j.y;
        const delta = px - j.x;
        if (Math.abs(delta) < eps) continue;          // 重合
        if (delta < 0) { if (bestNeg === null || px > bestNeg.x) bestNeg = { x: px, y: py, m }; }
        else           { if (bestPos === null || px < bestPos.x) bestPos = { x: px, y: py, m }; }
      } else {
        // 垂直射線 x = j.x → 與 ab 交點
        const dx = b.x - a.x;
        if (Math.abs(dx) < eps) continue;             // 平行(目標也是垂直)→ 跳過
        const t = (j.x - a.x) / dx;
        if (t < -eps || t > 1 + eps) continue;
        px = j.x;
        py = a.y + t * (b.y - a.y);
        const delta = py - j.y;
        if (Math.abs(delta) < eps) continue;
        if (delta < 0) { if (bestNeg === null || py > bestNeg.y) bestNeg = { x: px, y: py, m }; }
        else           { if (bestPos === null || py < bestPos.y) bestPos = { x: px, y: py, m }; }
      }
    }
    // 方向阻擋:若該方向已有共線同向桿件,跳過該側(避免重疊)
    const negDir = axis === "h" ? [-1, 0] : [0, -1];
    const posDir = axis === "h" ? [ 1, 0] : [0,  1];
    const negBlocked = jointHasCollinearMemberInDirection(j, negDir[0], negDir[1]);
    const posBlocked = jointHasCollinearMemberInDirection(j, posDir[0], posDir[1]);
    if (negBlocked) bestNeg = null;
    if (posBlocked) bestPos = null;

    let chosen = [];
    if (bothSides) {
      if (bestNeg) chosen.push(bestNeg);
      if (bestPos) chosen.push(bestPos);
    } else {
      // 兩側都有 → 挑距離較近的;只一側 → 挑那一側
      if (bestNeg && bestPos) {
        const dN = axis === "h" ? Math.abs(bestNeg.x - j.x) : Math.abs(bestNeg.y - j.y);
        const dP = axis === "h" ? Math.abs(bestPos.x - j.x) : Math.abs(bestPos.y - j.y);
        chosen.push(dN < dP ? bestNeg : bestPos);
      } else chosen.push(bestNeg || bestPos);
      chosen = chosen.filter(Boolean);
    }
    for (const c of chosen) {
      const nj = { id: allocJointId(), x: c.x, y: c.y };
      p.joints.push(nj);
      p.members.push({ id: allocMemberId(), j1: j.id, j2: nj.id });
      added++;
    }
  }
  if (added === 0) {
    alert("沒有可延伸的目標 — 找不到該方向上的桿件,或該方向已有桿件");
    return;
  }
  // 整理:合併同位節點、去重桿件、把節點落在桿件中段者 T 形拆段
  const cr = _consolidateInPlace();
  console.log(`[節點延伸] axis=${axis} bothSides=${bothSides} 新增 ${added};整理 合併 ${cr.mergedJ} / 去重 ${cr.droppedM} / 拆段 ${cr.splitM}`);
  render(); refreshLists();
}

// 節點水平 / 垂直複製:沿選取節點的水平(或垂直)線投射,在每條相交桿件上新增節點並 T 形拆段
//   與 extendJointAxisToIntersect 不同:這裡「不」從選取節點拉新桿件,
//   只是在「該射線碰到的每條現有桿件上」插入節點並把該桿件拆成兩段(類似沿線自動切交點)
export function duplicateJointOnAxis(axis) {
  const p = getPage(); if (!p) return;
  if (state.selection.joints.size === 0) {
    alert("請先選取至少一個節點");
    return;
  }
  pushUndo();
  const eps = 1e-3;
  let added = 0, splitCount = 0;
  const selJids = [...state.selection.joints];
  for (const jid of selJids) {
    const j = jointById(jid);
    if (!j) continue;
    const rayCoord = (axis === "h") ? j.y : j.x;
    // 快照:此輪 ray 把 m 拆成兩段後,新段不會在同 y / 同 x 線上再次被掃到(無意義),
    // 所以快照一份在 ray 開始時就好,避免無限遞迴或重複切割
    const snapshot = p.members.slice();
    for (const m of snapshot) {
      // 與選取節點相連的桿件 → 該節點已是端點,不用再加
      if (m.j1 === jid || m.j2 === jid) continue;
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      let t;
      if (axis === "h") {
        const dy = b.y - a.y;
        if (Math.abs(dy) < eps) continue;      // 水平桿件與水平射線平行,跳過
        t = (rayCoord - a.y) / dy;
      } else {
        const dx = b.x - a.x;
        if (Math.abs(dx) < eps) continue;      // 垂直桿件與垂直射線平行,跳過
        t = (rayCoord - a.x) / dx;
      }
      // 只處理「嚴格在線段內部」的交點;端點在射線上 → 已是節點,不處理
      if (t < eps || t > 1 - eps) continue;
      const px = a.x + t * (b.x - a.x);
      const py = a.y + t * (b.y - a.y);
      // 該交點位置已有節點 → 複用(T 形拆段連到既有點)
      let nj = p.joints.find(jj => Math.hypot(jj.x - px, jj.y - py) < eps);
      if (!nj) {
        nj = { id: allocJointId(), x: px, y: py };
        p.joints.push(nj);
        added++;
      }
      // 把 m 從 members 移除,改成兩段短桿件(保留 m 原有的 capacity / constraint 等屬性)
      const idx = p.members.indexOf(m);
      if (idx < 0) continue;
      const baseProps = { ...m };
      delete baseProps.id; delete baseProps.j1; delete baseProps.j2;
      p.members.splice(idx, 1);
      p.members.push({ ...baseProps, id: allocMemberId(), j1: m.j1, j2: nj.id });
      p.members.push({ ...baseProps, id: allocMemberId(), j1: nj.id, j2: m.j2 });
      splitCount++;
    }
  }
  if (added === 0 && splitCount === 0) {
    alert(axis === "h" ? "水平線上沒有可新增節點的桿件" : "垂直線上沒有可新增節點的桿件");
    return;
  }
  console.log(`[節點${axis === "h" ? "水平" : "垂直"}複製] 新增節點 ${added}・拆段 ${splitCount}`);
  render(); refreshLists();
}

// 移動指令 (M) — re-export stub 留在 legacy.ts(已 import 進來的版本不在這檔)
// 將所有選取的桿件在中點插入節點(切成兩段)
export function splitSelectedAtMidpoint() {
  const p = getPage();
  if (!p || p._orphan) return;
  if (state.selection.members.size === 0) return;
  pushUndo();
  const ids = [...state.selection.members];
  for (const mid of ids) {
    const m = p.members.find(x => x.id === mid);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) continue;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const nj = { id: allocJointId(), x: cx, y: cy };
    p.joints.push(nj);
    p.members = p.members.filter(x => x !== m);
    p.members.push({ id: allocMemberId(), j1: m.j1, j2: nj.id });
    p.members.push({ id: allocMemberId(), j1: nj.id, j2: m.j2 });
  }
  clearSelection();
  render(); refreshLists();
}

// 在指定線段(memberId)上、最靠近 (clientX,clientY) 的位置插入新節點,並把該線段切成兩段
export function splitMemberAt(memberId, clientX, clientY) {
  const p = getPage();
  const m = p.members.find(x => x.id === memberId);
  if (!m) return;
  const a = jointById(m.j1), b = jointById(m.j2);
  if (!a || !b) return;
  const w = screenToWorld(clientX, clientY);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return;
  let t = ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2;
  const minMargin = (state.snapPx / state.zoom) / Math.sqrt(len2);
  if (t < minMargin || t > 1 - minMargin) return;
  pushUndo();
  const px = a.x + t * dx, py = a.y + t * dy;
  const j = { id: allocJointId(), x: px, y: py };
  p.joints.push(j);
  p.members = p.members.filter(x => x !== m);
  p.members.push({ id: allocMemberId(), j1: m.j1, j2: j.id });
  p.members.push({ id: allocMemberId(), j1: j.id, j2: m.j2 });
  render(); refreshLists();
}

export function addMember(j1, j2, targetPage) {
  const p = targetPage || getPage();
  if (!p) return;
  if (!Array.isArray(p.members)) p.members = [];
  const exists = p.members.some(m =>
    (m.j1 === j1 && m.j2 === j2) || (m.j1 === j2 && m.j2 === j1));
  if (exists) return;
  p.members.push({ id: allocMemberId(), j1, j2 });
}

// 跨頁同步桿件(P3):
//   給當前頁兩個 view-joint(剛新增桿件 A—B 的兩端),掃所有其他頁:
//     - 兩端的 globalJoint 都在該頁有 view-binding → 在該頁建對應桿件
//     - 缺一端 → 略過該頁
//   若兩端尚未綁定 globalJoint,呼叫端會先用 syncJointAcrossViews 把它們 promote 過去
//   回 { created, pages }
export function syncMemberAcrossViews(j1Local, j2Local) {
  const af = getActiveFile();
  if (!af) return { created: 0, pages: 0 };
  if (!j1Local || !j2Local) return { created: 0, pages: 0 };
  const g1 = j1Local.globalId, g2 = j2Local.globalId;
  if (g1 == null || g2 == null || g1 === g2) return { created: 0, pages: 0 };
  let created = 0, scannedPages = 0;
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      if (f.id === af.id && +k === state.pageIdx) continue;   // 略過當前頁
      const t1 = (pg.joints || []).find(jj => jj.globalId === g1);
      const t2 = (pg.joints || []).find(jj => jj.globalId === g2);
      if (!t1 || !t2) continue;
      scannedPages++;
      const exists = (pg.members || []).some(m =>
        (m.j1 === t1.id && m.j2 === t2.id) || (m.j1 === t2.id && m.j2 === t1.id));
      if (exists) continue;
      addMember(t1.id, t2.id, pg);
      created++;
    }
  }
  return { created, pages: scannedPages };
}

// 在「桿件」工具下完成第二端點時呼叫:本頁建桿件 + (若 crossViewSync 開啟)跨頁建對應桿件
//   兩端若尚未有 globalJoint,先 syncJointAcrossViews(promote + 跨頁建節點),再 syncMemberAcrossViews
export function addMemberInteractive(j1id, j2id) {
  addMember(j1id, j2id);
  if (!state.crossViewSync) return;
  const p = getPage();
  if (!p) return;
  const j1 = (p.joints || []).find(jj => jj.id === j1id);
  const j2 = (p.joints || []).find(jj => jj.id === j2id);
  if (!j1 || !j2) return;
  // Auto-promote 端點 → 各自 promote 為 globalJoint 並把對應節點建到其他頁
  if (j1.globalId == null) syncJointAcrossViews(j1);
  if (j2.globalId == null) syncJointAcrossViews(j2);
  const r = syncMemberAcrossViews(j1, j2);
  if (r.pages > 0 || r.created > 0) {
    $("hud").textContent = `跨頁同步桿件:在 ${r.pages} 個頁面比對,新建 ${r.created} 條桿件`;
  }
}

export function deleteSelection() {
  if (state.selection.joints.size + state.selection.members.size === 0) return;
  // 大模型 + 跨頁共點刪除可能要掃所有 file/page,給 pending message 避免使用者以為卡死
  //   先快速估算:若選取的 joint 有 globalId,且總頁面數 > 10 → 顯示 busy
  const totalPages = state.files.reduce((s, f) => s + Object.keys(f.pages || {}).length, 0);
  const hasGlobalSelected = state.selection.joints.size > 0 &&
    [...state.selection.joints].some(jid => {
      const p0 = getPage();
      const j = p0 && p0.joints.find(x => x.id === jid);
      return j && j.globalId != null;
    });
  if (hasGlobalSelected && totalPages > 10 && typeof withBusy === "function") {
    // 用 withBusy 包,讓 spinner / 取消鈕跑起來
    return withBusy(`刪除選取(跨 ${totalPages} 頁掃描共點)…`, () => _deleteSelectionCore());
  }
  return _deleteSelectionCore();
}
export function _deleteSelectionCore() {
  pushUndo();
  const p = getPage();
  // 記下被刪桿件的端點,稍後檢查是否變孤立
  const checkOrphan = new Set();
  if (state.selection.members.size) {
    for (const m of p.members) {
      if (state.selection.members.has(m.id)) {
        checkOrphan.add(m.j1); checkOrphan.add(m.j2);
      }
    }
    p.members = p.members.filter(m => !state.selection.members.has(m.id));
  }
  // 處理選取的節點:若節點剛好是「桿件中間的點」(degree == 2 且大致共線)→ 合併成一條
  //   degree == 2 但不共線(如 L 形轉角)→ 保留舊行為(連同兩條桿件一併刪除)
  //   tolerance:相對於桿件長度的 1% 或絕對 1.0 世界單位,取較大者
  //              這個值能容忍 processIntersections / 校準 累積的數值漂移,但仍能擋掉真正轉角
  if (state.selection.joints.size) {
    for (const jid of state.selection.joints) {
      const conn = p.members.filter(m => m.j1 === jid || m.j2 === jid);
      let merged = false;
      if (conn.length === 2) {
        const [m1, m2] = conn;
        const otherOf = (mem) => mem.j1 === jid ? mem.j2 : mem.j1;
        const aId = otherOf(m1), bId = otherOf(m2);
        const a = jointById(aId), b = jointById(bId), c = jointById(jid);
        if (a && b && c && aId !== bId) {
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          const cross = Math.abs(dx * (c.y - a.y) - dy * (c.x - a.x));
          const distToLine = len > 0 ? cross / len : Infinity;
          const tol = Math.max(1.0, len * 0.01);
          const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / (len * len || 1);
          if (distToLine <= tol && t > 0 && t < 1) {
            p.members = p.members.filter(m => m !== m1 && m !== m2);
            const exists = p.members.some(m =>
              (m.j1 === aId && m.j2 === bId) || (m.j1 === bId && m.j2 === aId));
            if (!exists) p.members.push({ id: allocMemberId(), j1: aId, j2: bId });
            merged = true;
          }
        }
      }
      if (!merged) {
        // 不共線 / 連 0、1 或 3+ 條 → 連同所有相連桿件一併移除
        p.members = p.members.filter(m => m.j1 !== jid && m.j2 !== jid);
      }
    }
    // 收集被刪 joint 的 globalId(有綁定的才需要跨頁刪)
    const deletedGids = new Set();
    for (const j of p.joints) {
      if (state.selection.joints.has(j.id) && j.globalId != null) deletedGids.add(j.globalId);
    }
    p.joints = p.joints.filter(j => !state.selection.joints.has(j.id));
    // 跨頁刪除「共點」joint:不再對每頁掃 joints,改成先一次性建 globalId → 受影響頁面索引
    //   優點:
    //     1. 沒受影響的頁面完全不會被 touch(filter members / joints 都不跑)
    //     2. globalJoint 清理可直接用索引推算「剩餘 binding」,不需再掃一遍 state
    if (deletedGids.size) {
      // ── 步驟 A:建 gid → [{pg, jid}] 索引(排除當前頁 p,因為它已處理)──
      const gidIndex = new Map();    // gid → [{pg, jid}]
      const stillBoundOther = new Set();   // 其他頁仍綁著的 gid(不在 deletedGids 內)
      for (const f of state.files) {
        for (const pg of Object.values(f.pages || {})) {
          if (!pg || pg._orphan || pg === p) continue;
          for (const j of (pg.joints || [])) {
            if (j.globalId == null) continue;
            if (deletedGids.has(j.globalId)) {
              let arr = gidIndex.get(j.globalId);
              if (!arr) { arr = []; gidIndex.set(j.globalId, arr); }
              arr.push({ pg, jid: j.id });
            } else {
              stillBoundOther.add(j.globalId);
            }
          }
        }
      }
      // ── 步驟 B:依索引收集每頁要刪的 joint id ──
      const pageRemove = new Map();   // pg → Set(jids)
      for (const arr of gidIndex.values()) {
        for (const b of arr) {
          let s = pageRemove.get(b.pg);
          if (!s) { s = new Set(); pageRemove.set(b.pg, s); }
          s.add(b.jid);
        }
      }
      // ── 步驟 C:只 filter 受影響的頁面 ──
      let crossPages = 0, crossJoints = 0, crossMembers = 0;
      for (const [pg, removeJids] of pageRemove) {
        const beforeJ = pg.joints.length, beforeM = (pg.members || []).length;
        pg.members = (pg.members || []).filter(m => !removeJids.has(m.j1) && !removeJids.has(m.j2));
        pg.joints = pg.joints.filter(j => !removeJids.has(j.id));
        crossPages++;
        crossJoints += beforeJ - pg.joints.length;
        crossMembers += beforeM - pg.members.length;
      }
      if (crossPages) {
        console.log(`[共點刪除] 跨頁刪除 ${crossPages} 頁・節點 ${crossJoints}・桿件 ${crossMembers}・globalId ${deletedGids.size} 個(O(受影響頁面),不再掃整個 state)`);
        $("hud").textContent = `已刪除節點(連同其他平面 ${crossPages} 頁的 ${crossJoints} 個共點)`;
      }
      // ── 步驟 D:清掉孤兒 globalJoint。
      //   不變式:每頁 1 gid 最多 1 個 joint binding(bindJointToGlobal 強制)→
      //     deletedGids 對應的 globalJoint,在其他頁的 binding 都被步驟 C 刪光、
      //     當前頁的 binding 也被前面 p.joints.filter 刪光 → 一律可刪。
      //   防禦性:還是檢查當前頁殘留 binding(以防不變式被外部破壞)
      const stillBoundInP = new Set();
      for (const j of p.joints) if (j.globalId != null) stillBoundInP.add(j.globalId);
      if (Array.isArray(state.globalJoints)) {
        const before = state.globalJoints.length;
        state.globalJoints = state.globalJoints.filter(g => {
          if (!deletedGids.has(g.id)) return true;
          // gid 在 deletedGids:當前頁 / 其他頁都不該有 binding 了 — 雙重檢查
          return stillBoundInP.has(g.id) || stillBoundOther.has(g.id);
        });
        const removedGj = before - state.globalJoints.length;
        if (removedGj) console.log(`[共點刪除] 清掉沒有 binding 的 globalJoint ${removedGj} 個`);
      }
    }
  }
  // 移除孤立節點(來自被刪桿件的端點)
  if (checkOrphan.size) {
    const used = new Set();
    for (const m of p.members) { used.add(m.j1); used.add(m.j2); }
    p.joints = p.joints.filter(j => !checkOrphan.has(j.id) || used.has(j.id));
  }
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  clearSelection();
  render(); refreshLists();
}

export function clearSelection() {
  state.selection.joints.clear();
  state.selection.members.clear();
  state.selection.fileIds.clear();
  state.selection.fileAnchor = null;
  state.selection.sourceFileId = null;
  state.selection.sourcePageIdx = null;
}
// 防誤刪 guard:當 selection 不在當前 page 時,阻擋 mutation 操作。
//   R-01 修補:state.selection.joints 存 raw j.id,relayoutNumberingAll 後跨頁 j.id 可能撞號,
//   在 source page 之外按 delete 會誤刪同 id 但不同物理點的 joint。視覺已用 _selOnSrc 隔離,
//   操作層用這支 guard 擋住。
//   回傳 true = 可繼續;false = 已被使用者選擇取消或切換頁面,呼叫端應直接 return。
export function _assertSelectionOnActivePage(opName) {
  // 沒選任何東西 → 不擋(不影響無 selection 場景)
  if (state.selection.joints.size === 0 && state.selection.members.size === 0) return true;
  // 沒記 source(舊資料 / 沒被 mark 過)→ 不擋(legacy 行為)
  if (state.selection.sourceFileId == null || state.selection.sourcePageIdx == null) return true;
  const onSrc = (state.selection.sourceFileId === state.activeFileId
              && state.selection.sourcePageIdx === (state.pageIdx || 0));
  if (onSrc) return true;
  // 不在 source page → 詢問使用者怎麼做
  const srcFile = state.files.find(f => f.id === state.selection.sourceFileId);
  const srcName = srcFile ? `${srcFile.name}#${state.selection.sourcePageIdx + 1}` : `file ${state.selection.sourceFileId}, page ${state.selection.sourcePageIdx + 1}`;
  const opt = confirm(
    `⚠ 操作「${opName || "目前動作"}」會作用在選取的 joint / member,\n` +
    `但當前選取是在「${srcName}」建立的,目前頁不是 source。\n\n` +
    `直接執行可能誤刪 / 誤動 j.id 巧合相同的不同物理點(relayoutNumberingAll 後 j.id 跨頁會撞號)。\n\n` +
    `點【確定】切回 source page 並執行操作。\n` +
    `點【取消】放棄此次操作(selection 仍保留)。`
  );
  if (opt) {
    if (typeof activatePageWithBusy === "function") {
      activatePageWithBusy(state.selection.sourceFileId, state.selection.sourcePageIdx);
    }
  }
  return false;
}
// 標記 selection 的「來源頁」— 只在 selection 從空變非空、或來源還沒設時設定;
//   避免使用者連續勾選跨頁時 source 跳來跳去(理論上不會發生,因為跨頁勾選會經過切頁)
export function _markSelectionSourceIfEmpty() {
  if (state.selection.sourceFileId == null) {
    state.selection.sourceFileId = state.activeFileId;
    state.selection.sourcePageIdx = state.pageIdx || 0;
  }
}

// 多選判定:按住 Shift 或開啟多選持續模式(Shift+S 切換)時,點選為追加
export function additiveSelect(e) {
  return !!(e && e.shiftKey) || !!state.multiSelectSticky;
}
// 反選判定:按住 Ctrl(或 Mac 的 Cmd / Meta)時,點選為從選取中移除
export function subtractiveSelect(e) {
  return !!(e && (e.ctrlKey || e.metaKey));
}

// Process intersections: for every pair of members, if they cross (not at endpoints),
// split both at the intersection joint.
// 把「節點落在某桿件中段」的情況拆桿:
// 例如桿件 (0,0)-(10,0) 與節點 (3,0) 共線且夾在中間 → 拆成 (0,0)-(3,0) + (3,0)-(10,0)
// 處理線重疊但端點不重疊的情況(例如 bg 上有兩條重疊但不同長度的線轉桿件)
export function splitMembersAtCollinearJoints() {
  const p = getPage();
  if (!p) return;
  const eps = 1e-3;
  let changed = true, guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    outer:
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < eps) continue;
      const len = Math.sqrt(lenSq);
      for (const j of p.joints) {
        if (j.id === a.id || j.id === b.id) continue;
        const cross = Math.abs((j.x - a.x) * dy - (j.y - a.y) * dx);
        if (cross / len > eps) continue;          // 不共線
        const t = ((j.x - a.x) * dx + (j.y - a.y) * dy) / lenSq;
        if (t < eps || t > 1 - eps) continue;     // 不在內部
        // 在 j 點拆桿
        p.members.splice(i, 1);
        const existsA = p.members.some(mm => (mm.j1 === a.id && mm.j2 === j.id) || (mm.j1 === j.id && mm.j2 === a.id));
        const existsB = p.members.some(mm => (mm.j1 === j.id && mm.j2 === b.id) || (mm.j1 === b.id && mm.j2 === j.id));
        if (!existsA) p.members.push({ id: allocMemberId(), j1: a.id, j2: j.id });
        if (!existsB) p.members.push({ id: allocMemberId(), j1: j.id, j2: b.id });
        changed = true;
        break outer;
      }
    }
  }
}

// 切交點(選取版):只對 state.selection.members 內的桿件兩兩求交,在交點處建節點 + 拆段
//   - 拆段後新桿件自動加入選取(保持視覺一致,連續操作不需重選)
//   - 跟全頁版一樣會跑 splitMembersAtCollinearJoints 處理 T 形(但僅限拆完還在選取裡的桿件)
export function processIntersectionsForSelection() {
  const p = getPage();
  const sel = state.selection.members;
  if (!sel || sel.size < 2) {
    alert("請先選取至少 2 條桿件再執行切交點(選取)");
    return;
  }
  pushUndo();
  let selIds = new Set(sel);
  let intersections = 0;
  let changed = true, guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    const selMembers = p.members.filter(m => selIds.has(m.id));
    outer:
    for (let i = 0; i < selMembers.length; i++) {
      for (let k = i + 1; k < selMembers.length; k++) {
        const m1 = selMembers[i], m2 = selMembers[k];
        const a = jointById(m1.j1), b = jointById(m1.j2);
        const c = jointById(m2.j1), d = jointById(m2.j2);
        if (!a || !b || !c || !d) continue;
        const inter = segIntersect(a, b, c, d);
        if (!inter) continue;
        const eps = 1e-3;
        const isEnd = (j) => Math.hypot(j.x - inter.x, j.y - inter.y) < eps;
        if (isEnd(a) || isEnd(b) || isEnd(c) || isEnd(d)) continue;
        const nj = ensureJointAt(inter);
        // split m1
        const i1 = p.members.indexOf(m1);
        if (i1 !== -1) p.members.splice(i1, 1);
        const m1a = { id: allocMemberId(), j1: a.id, j2: nj.id };
        const m1b = { id: allocMemberId(), j1: nj.id, j2: b.id };
        p.members.push(m1a, m1b);
        // split m2
        const i2 = p.members.indexOf(m2);
        if (i2 !== -1) p.members.splice(i2, 1);
        const m2a = { id: allocMemberId(), j1: c.id, j2: nj.id };
        const m2b = { id: allocMemberId(), j1: nj.id, j2: d.id };
        p.members.push(m2a, m2b);
        selIds.delete(m1.id); selIds.delete(m2.id);
        selIds.add(m1a.id); selIds.add(m1b.id);
        selIds.add(m2a.id); selIds.add(m2b.id);
        intersections++;
        changed = true;
        break outer;
      }
    }
  }
  state.selection.members = selIds;
  // T 形:節點(新建的交點 + 既有節點)落在還在選取的桿件中段 → 拆段
  //   全頁版 splitMembersAtCollinearJoints 會處理整頁;這裡僅針對選取桿件,但用全頁掃也合理(節點少時)
  if (typeof splitMembersAtCollinearJoints === "function") splitMembersAtCollinearJoints();
  console.log(`[切交點(選取)] 加 ${intersections} 個交點・選取桿件數 ${state.selection.members.size}`);
  $("hud").textContent = `切交點(選取):新增 ${intersections} 個交點(選取保持為拆段後 ${state.selection.members.size} 條)`;
  render(); refreshLists();
}
export function processIntersections() {
  pushUndo();
  const p = getPage();
  let changed = true, guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    outer:
    for (let i = 0; i < p.members.length; i++) {
      for (let k = i + 1; k < p.members.length; k++) {
        const m1 = p.members[i], m2 = p.members[k];
        const a = jointById(m1.j1), b = jointById(m1.j2);
        const c = jointById(m2.j1), d = jointById(m2.j2);
        const inter = segIntersect(a, b, c, d);
        if (!inter) continue;
        // skip if intersection is an existing endpoint
        const eps = 1e-3;
        const isEnd = (j) => Math.hypot(j.x - inter.x, j.y - inter.y) < eps;
        if (isEnd(a) || isEnd(b) || isEnd(c) || isEnd(d)) continue;
        const nj = ensureJointAt(inter);
        // split m1
        p.members.splice(i, 1);
        p.members.push({ id: allocMemberId(), j1: a.id, j2: nj.id });
        p.members.push({ id: allocMemberId(), j1: nj.id, j2: b.id });
        // remove m2 (its index might have shifted because we removed i first)
        const k2 = p.members.indexOf(m2);
        if (k2 !== -1) p.members.splice(k2, 1);
        p.members.push({ id: allocMemberId(), j1: c.id, j2: nj.id });
        p.members.push({ id: allocMemberId(), j1: nj.id, j2: d.id });
        changed = true;
        break outer;
      }
    }
  }
  // T 形:某條桿件的端點落在另一條桿件中段(共線且夾在兩端之間)→ 拆桿
  splitMembersAtCollinearJoints();
  render(); refreshLists();
}

export function segIntersect(p1, p2, p3, p4) {
  const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y,x3=p3.x,y3=p3.y,x4=p4.x,y4=p4.y;
  const denom = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / denom;
  const u = -((x1-x2)*(y1-y3) - (y1-y2)*(x1-x3)) / denom;
  const eps = 1e-6;
  if (t < eps || t > 1-eps || u < eps || u > 1-eps) return null;
  return { x: x1 + t*(x2-x1), y: y1 + t*(y2-y1) };
}
// 無線段邊界版:回傳「兩條無限延伸直線」的交點 + 各自的 t / u 參數。
// 平行(denom 太小)回傳 null。caller 自己決定接受多少延伸範圍。
export function lineLineIntersect(p1, p2, p3, p4) {
  const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y,x3=p3.x,y3=p3.y,x4=p4.x,y4=p4.y;
  const denom = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / denom;
  const u = -((x1-x2)*(y1-y3) - (y1-y2)*(x1-x3)) / denom;
  return { x: x1 + t*(x2-x1), y: y1 + t*(y2-y1), t, u };
}

// 整理(in-place):確保節點不重複位置、桿件不重複,並把共線重疊或內部含節點的桿件拆段
//   不會 pushUndo / render / refreshLists,可由其他操作呼叫以共用清理邏輯
//   1) 合併同位置節點(緊容差 epsJ);把所有桿件端點重新指向倖存節點
//   2) 移除零長 / 重複桿件
//   3) 對每條桿件:若有第三節點落在其內部且共線(緊容差 epsC),於該節點處拆段
//      → 共線重疊的桿件會自動分解到共同端點上
//   4) 拆段後再次去重(共線重疊段在拆完後會與另一條桿件對到同一對端點)
export function _consolidateInPlace() {
  const p = getPage();
  if (!p || p._orphan) return { mergedJ: 0, droppedM: 0, splitM: 0 };
  const epsJ = 0.5;        // 節點同位容差(世界座標 / 像素)
  const epsC = 0.5;        // 共線判定的垂直容差
  let mergedJ = 0, droppedM = 0, splitM = 0;

  // Pass 1:合併同位置節點
  const remap = new Map();
  const kept  = [];
  for (const j of p.joints) {
    let merged = null;
    for (const k of kept) {
      if (Math.hypot(k.x - j.x, k.y - j.y) < epsJ) { merged = k; break; }
    }
    if (merged) { remap.set(j.id, merged.id); mergedJ++; }
    else        { kept.push(j); remap.set(j.id, j.id); }
  }
  p.joints = kept;
  for (const m of p.members) {
    m.j1 = remap.get(m.j1) ?? m.j1;
    m.j2 = remap.get(m.j2) ?? m.j2;
  }

  // Pass 2:零長 / 重複桿件
  const dedupKey = (m) => m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`;
  {
    const seen = new Set();
    p.members = p.members.filter(m => {
      if (m.j1 === m.j2) { droppedM++; return false; }
      const k = dedupKey(m);
      if (seen.has(k)) { droppedM++; return false; }
      seen.add(k); return true;
    });
  }

  // Pass 3:在共線內部節點處拆段;迭代到穩定
  let changed = true, guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    outer:
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < epsJ * epsJ) continue;
      const len = Math.sqrt(lenSq);
      for (const j of p.joints) {
        if (j.id === a.id || j.id === b.id) continue;
        // 垂直距離(共線)
        const cross = Math.abs((j.x - a.x) * dy - (j.y - a.y) * dx);
        if (cross / len > epsC) continue;
        // 投影參數,需在 (0, 1) 內(避免端點)
        const t = ((j.x - a.x) * dx + (j.y - a.y) * dy) / lenSq;
        const tEdge = epsJ / len;
        if (t < tEdge || t > 1 - tEdge) continue;
        // 拆段
        p.members.splice(i, 1);
        const exA = p.members.some(mm => (mm.j1 === a.id && mm.j2 === j.id) || (mm.j1 === j.id && mm.j2 === a.id));
        const exB = p.members.some(mm => (mm.j1 === j.id && mm.j2 === b.id) || (mm.j1 === b.id && mm.j2 === j.id));
        if (!exA) { p.members.push({ id: allocMemberId(), j1: a.id, j2: j.id }); splitM++; }
        if (!exB) { p.members.push({ id: allocMemberId(), j1: j.id, j2: b.id }); splitM++; }
        changed = true;
        break outer;
      }
    }
  }

  // Pass 4:再次去重(共線重疊拆完後會出現相同端點對)
  {
    const seen = new Set();
    p.members = p.members.filter(m => {
      if (m.j1 === m.j2) { droppedM++; return false; }
      const k = dedupKey(m);
      if (seen.has(k)) { droppedM++; return false; }
      seen.add(k); return true;
    });
  }

  // Pass 5:把節點吸到底圖線端點 / 交點(若 bgSnapTolerance > 0)
  //   依賴 page._bgSegsCache(activatePage 後填入)+ snapToBgVertex helper(返回端點 / 兩段交點)
  //   只在偏差 < tol 時移動;移動後可能 Pass 1 同位置合併沒抓到的節點變同位,但因為這已是最後一步,不再二次合併
  let snappedJ = 0;
  const bgTol = Math.max(0, Number(state.bgSnapTolerance) || 0);
  if (bgTol > 0 && Array.isArray(p._bgSegsCache) && p._bgSegsCache.length && typeof snapToBgVertex === "function") {
    for (const j of p.joints) {
      const hit = snapToBgVertex({ x: j.x, y: j.y }, { radius: bgTol });
      if (!hit) continue;
      const d = Math.hypot(hit.x - j.x, hit.y - j.y);
      if (d > 0 && d <= bgTol) {
        j.x = hit.x; j.y = hit.y;
        snappedJ++;
      }
    }
  }

  // 清掉已不存在的選取
  state.selection.joints  = new Set([...state.selection.joints ].filter(id => p.joints .some(j => j.id === id)));
  state.selection.members = new Set([...state.selection.members].filter(id => p.members.some(m => m.id === id)));

  return { mergedJ, droppedM, splitM, snappedJ };
}

// 是否從節點 j 已經有「在 (dx,dy) 方向」的桿件:用來阻擋會造成重疊的延伸
//   - 共線(垂直距離 ≈ 0)
//   - 同向(向量點積 > 0)
export function jointHasCollinearMemberInDirection(j, dx, dy) {
  const p = getPage();
  if (!p || p._orphan) return false;
  const eps = 1e-3;
  const len = Math.hypot(dx, dy);
  if (len < eps) return false;
  const ux = dx / len, uy = dy / len;
  for (const m of p.members) {
    let other = null;
    if      (m.j1 === j.id) other = jointById(m.j2);
    else if (m.j2 === j.id) other = jointById(m.j1);
    if (!other) continue;
    const vx = other.x - j.x, vy = other.y - j.y;
    const vlen = Math.hypot(vx, vy);
    if (vlen < eps) continue;
    const cross = Math.abs(vx * uy - vy * ux);     // 共線判定:垂直距離
    if (cross > 0.5) continue;                      // 與 epsC 一致(0.5 px / world unit)
    const dot = vx * ux + vy * uy;                  // 同向判定
    if (dot > eps) return true;
  }
  return false;
}

export function consolidateGeometry() {
  const p = getPage();
  if (!p || p._orphan) { alert("尚未載入底圖頁面"); return; }
  pushUndo();
  const r = _consolidateInPlace();
  console.log(`[整理] 合併節點 ${r.mergedJ} ・ 移除桿件 ${r.droppedM} ・ 新拆桿件 ${r.splitM}`);
  render(); refreshLists();
}

// 重排編號:依「列」(同 x 群組)分組,同列內由下而上(畫面 y 由大到小)從 base 起每節點 +1。
//   下一列的起始 = 上一列最大編號「進位到下一個百位」 + 1
//   例:列 1 含 4 個節點 → 1..4;列 2 從 101 開始 → 101..N;若列 2 結束於 235,列 3 從 301 開始
//   桿件依端點順序連續從 1 起重編。
//
// Relayout re-export stub 留在 legacy.ts;這檔不重複。
// ========== 跨頁桿件去重 / 融合 ==========
// 同一條物理桿件在 3D 中只應有一個 ID。此區兩個 helper 負責維持這個 invariant:
//   1) dedupSamePageMembers   —— 同頁 {j1,j2} 完全相同(不論方向) / 零長度桿件 → 保留第一條,其餘刪除
//   2) unifyCrossPageMemberIds —— 同 globalMemberId 的所有 page-local 副本,把 m.id 全部統一到最小值
// 不動節點、不拆共線重疊 —— 那些由「整理所有頁面」(consolidateAllPagesWithConfirm)處理。

// 單頁內重複桿件(同一對 joint)→ 刪掉其餘,只留第一條
//   也順手清掉零長度桿件(j1 === j2)
//   不呼叫 pushUndo —— 由 caller 負責
export function dedupSamePageMembers() {
  let pagesTouched = 0, dupRemoved = 0, zeroLen = 0;
  for (const f of state.files || []) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan || !Array.isArray(pg.members)) continue;
      const seen = new Set();
      const kept = [];
      for (const m of pg.members) {
        if (m.j1 === m.j2) { zeroLen++; continue; }
        const k = m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`;
        if (seen.has(k)) { dupRemoved++; continue; }
        seen.add(k);
        kept.push(m);
      }
      if (kept.length !== pg.members.length) {
        pg.members = kept;
        pagesTouched++;
      }
    }
  }
  // 清掉已失效的 active-page 選取
  const ap = (typeof getPage === "function") ? getPage() : null;
  if (ap && !ap._orphan) {
    state.selection.members = new Set([...state.selection.members].filter(id => ap.members.some(m => m.id === id)));
  }
  return { pagesTouched, dupRemoved, zeroLen };
}

// 跨頁同物理桿件 ID 統一:
//   對每個 state.globalMembers[gm],收集所有 m.globalMemberId === gm.id 的 page-local members
//   取最小的 m.id 當 canonical,把該 gm 下所有副本的 m.id 改成 canonical
//   碰撞保護:若目標頁上已有 *不同* member 佔用 canonical,該條保留原 id,記入 conflicts
//   前提:同頁已無重複桿件(dedupSamePageMembers 已跑過)—— 否則同頁會產生 duplicate id
//   呼叫時機:全局重編完成後,或獨立觸發
export function unifyCrossPageMemberIds() {
  if (!Array.isArray(state.globalMembers)) state.globalMembers = [];
  // 收集 gmId → [{ pg, m }]
  const gmToRefs = new Map();
  for (const f of state.files || []) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan || !Array.isArray(pg.members)) continue;
      for (const m of pg.members) {
        if (m.globalMemberId == null) continue;
        let arr = gmToRefs.get(m.globalMemberId);
        if (!arr) { arr = []; gmToRefs.set(m.globalMemberId, arr); }
        arr.push({ pg, m });
      }
    }
  }
  let gmsUnified = 0, rewritten = 0, conflicts = 0;
  for (const refs of gmToRefs.values()) {
    if (refs.length < 2) continue;
    // canonical = 同 gm 副本中最小的「正號」m.id;跳過 sentinel/leftover 的負數
    //   避免在 relayoutMembersNumberingAll 中途呼叫時,sentinel(-1, -2, ...)被當成 canonical
    //   把全部 ref 改成負號 → 後續 leftover 修補又再覆寫一次,白做工且短暫狀態錯亂
    let canonical = Infinity;
    for (const r of refs) {
      if (Number.isFinite(r.m.id) && r.m.id > 0 && r.m.id < canonical) canonical = r.m.id;
    }
    if (!Number.isFinite(canonical) || canonical <= 0) continue;
    let touched = 0;
    for (const r of refs) {
      if (r.m.id === canonical) continue;
      const clash = r.pg.members.find(mm => mm !== r.m && mm.id === canonical);
      if (clash) {
        // 同頁已有別的 member 佔用 canonical — 保守跳過(通常是 single-page relayout 導致的跨頁 id 重疊)
        conflicts++;
        continue;
      }
      r.m.id = canonical;
      rewritten++;
      touched++;
    }
    if (touched) gmsUnified++;
  }
  // 排序各頁 members + 同步 nextMemberId
  let maxId = 0;
  for (const f of state.files || []) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan || !Array.isArray(pg.members)) continue;
      pg.members.sort((a, b) => a.id - b.id);
      for (const m of pg.members) if (m.id > maxId) maxId = m.id;
    }
  }
  if (maxId + 1 > nextMemberId) nextMemberId = maxId + 1;
  return { gmsUnified, rewritten, conflicts };
}

