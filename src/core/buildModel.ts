// buildModel — 把所有檔案 / 頁面聚合成單一 3D 模型(共用 .xlsx + .std 匯出邏輯)
//   編號:用 displayJointId(rank-based)/ displayMemberId;同位置 (eps=1e-4) 節點合併
//   撞號:_displayIdForJointWith 算出的 id 衝突 → fallback 流水號,記錄到 window._lastBuildModelCollisions
//   匯出端(.xlsx / .std)在輸出後呼叫 showBuildModelCollisionsIfAny() 跳對話框告知使用者

import { state, displayMemberId } from "../app/integration";
import { joint2DToWorld3D } from "./projection";
import { _displayIdForJointWith } from "./displayId";
import { setDebugVar, getDebugVar } from "../utils/debug";

interface JointCollision {
  originalDisplayId: string;
  fallbackId: number;
  fileName: string;
  pageIdx: number;
  jointId: number;
  x: number;
  y: number;
  z: number;
}
interface MemberCollision {
  originalDisplayId: string;
  fallbackId: number;
  fileName: string;
  pageIdx: number;
  memberId: number;
}
interface BuildModelResult {
  joints: Array<{ id: number; x: number; y: number; z: number; isAnchor?: boolean; supportType?: "FIXED" | "PINNED" }>;
  members: Array<{ id: number; j1: number; j2: number }>;
}

export function buildModel(): BuildModelResult {
  const allJoints: BuildModelResult["joints"] = [];
  const allMembers: BuildModelResult["members"] = [];
  const seenJointIds = new Set<number>();
  const seenMemberIds = new Set<number>();
  const seenGlobalMemberIds = new Set<number>();
  let fallbackJ = 1, fallbackM = 1;
  const jointCollisions: JointCollision[] = [];
  const memberCollisions: MemberCollision[] = [];
  const s = state as any;

  for (const file of s.files) {
    const ratio = (file.scaleRuler && file.scaleRuler.ratio > 0)
      ? file.scaleRuler.ratio
      : (s.scale ? 1 / s.scale : 1);
    const origin = file.planeOrigin || { x: 0, y: 0 };
    for (const pg of Object.values(file.pages || {}) as any[]) {
      if (!pg || pg._orphan) continue;
      const idMap = new Map<number, number>();
      for (const j of pg.joints) {
        let X: number, Y: number, Z: number;
        let w: { x: number; y: number; z: number } | null = null;
        if (j.globalId != null) {
          const gj = (s.globalJoints || []).find((g: any) => g.id === j.globalId);
          if (gj && Number.isFinite(gj.x) && Number.isFinite(gj.y) && Number.isFinite(gj.z)) {
            w = { x: gj.x, y: gj.y, z: gj.z };
          }
        }
        if (!w) {
          const w2 = joint2DToWorld3D(file, pg, j);
          if (w2) w = { x: w2.x, y: w2.y, z: w2.z };
        }
        if (w) {
          X = w.x; Y = w.y; Z = w.z;
        } else {
          X = (j.x - origin.x) * ratio;
          Y = (origin.y - j.y) * ratio;
          Z = pg.z || 0;
        }
        const eps = 1e-4;
        let dup = allJoints.find(q => Math.abs(q.x - X) < eps && Math.abs(q.y - Y) < eps && Math.abs(q.z - Z) < eps);
        if (!dup) {
          let nid = _displayIdForJointWith(file, pg, j);
          if (typeof nid !== "number" || !Number.isFinite(nid) || seenJointIds.has(nid)) {
            const fb = nid;
            while (seenJointIds.has(fallbackJ)) fallbackJ++;
            nid = fallbackJ++;
            console.warn(`[STAAD export] joint display id "${fb}" 撞號或無效 → fallback ${nid}`);
            jointCollisions.push({
              originalDisplayId: String(fb), fallbackId: nid,
              fileName: file.name,
              pageIdx: +Object.keys(file.pages).find(k => file.pages[k] === pg)!,
              jointId: j.id, x: X, y: Y, z: Z,
            });
          }
          seenJointIds.add(nid as number);
          dup = { id: nid as number, x: X, y: Y, z: Z };
          allJoints.push(dup);
        }
        // 累積錨點 / 支座類型:任一頁面的此 joint 標 isAnchor → 該物理點視為錨點
        //   supportType 取「最後一次設值」(實務上多頁應同步;若不同步,以最後讀到為準)
        if (j.isAnchor) {
          (dup as any).isAnchor = true;
          if (j.supportType === "PINNED" || j.supportType === "FIXED") {
            (dup as any).supportType = j.supportType;
          } else if (!(dup as any).supportType) {
            (dup as any).supportType = "FIXED";   // 未指定 → FIXED 預設
          }
        }
        idMap.set(j.id, dup.id);
      }
      for (const m of pg.members) {
        if (m.globalMemberId != null && seenGlobalMemberIds.has(m.globalMemberId)) continue;
        let nid: number | string = (typeof displayMemberId === "function") ? displayMemberId(m) : m.id;
        if (typeof nid !== "number" || !Number.isFinite(nid) || seenMemberIds.has(nid)) {
          const fb = nid;
          while (seenMemberIds.has(fallbackM)) fallbackM++;
          nid = fallbackM++;
          memberCollisions.push({
            originalDisplayId: String(fb), fallbackId: nid,
            fileName: file.name,
            pageIdx: +Object.keys(file.pages).find(k => file.pages[k] === pg)!,
            memberId: m.id,
          });
        }
        seenMemberIds.add(nid as number);
        if (m.globalMemberId != null) seenGlobalMemberIds.add(m.globalMemberId);
        allMembers.push({ id: nid as number, j1: idMap.get(m.j1)!, j2: idMap.get(m.j2)! });
      }
    }
  }
  setDebugVar("_lastBuildModelCollisions", { joints: jointCollisions, members: memberCollisions });
  return { joints: allJoints, members: allMembers };
}

/** 顯示「匯出時撞號 fallback」清單;buildModel 之後呼叫,集中跳一次 alert */
export function showBuildModelCollisionsIfAny(exportLabel?: string): boolean {
  const c = getDebugVar<{ joints: JointCollision[]; members: MemberCollision[] }>("_lastBuildModelCollisions");
  if (!c) return false;
  const total = c.joints.length + c.members.length;
  if (total === 0) return false;
  const lines: string[] = [];
  lines.push(`⚠ ${exportLabel || "匯出"}時偵測到 ${total} 筆「顯示編號撞號」自動 fallback 成流水號:`);
  lines.push("");
  if (c.joints.length) {
    lines.push(`【節點(${c.joints.length} 筆)】`);
    for (const x of c.joints.slice(0, 15)) {
      lines.push(`  • 「${x.originalDisplayId}」→ ${x.fallbackId}  @ ${x.fileName}#${x.pageIdx + 1} (X=${Math.round(x.x)} Y=${Math.round(x.y)} Z=${Math.round(x.z)})`);
    }
    if (c.joints.length > 15) lines.push(`  …(其餘 ${c.joints.length - 15} 筆請看 console)`);
    lines.push("");
  }
  if (c.members.length) {
    lines.push(`【桿件(${c.members.length} 筆)】`);
    for (const x of c.members.slice(0, 15)) {
      lines.push(`  • 「${x.originalDisplayId}」→ ${x.fallbackId}  @ ${x.fileName}#${x.pageIdx + 1}`);
    }
    if (c.members.length > 15) lines.push(`  …(其餘 ${c.members.length - 15} 筆請看 console)`);
    lines.push("");
  }
  lines.push("常見原因:");
  lines.push("  1. 軸 capacity 太低 → 多個座標被 cap 成同 rank,擠到同一個 display ID");
  lines.push("  2. 同物理位置在不同檔/頁的世界座標有誤差(eps=0.1 mm),沒被 dedup,各算各的 ID 結果撞");
  lines.push("");
  lines.push("處理建議:");
  lines.push("  • 到「設定」加大 X / Y / Z capacity(99 → 999)");
  lines.push("  • 或先跑「⚡ 3D 一鍵處理」清光綁定 + 適配關聯,讓同物理點走同 globalJoint");
  lines.push("  • 匯出檔已生成,fallback 編號是流水號,跟主畫面顯示的編號會不同");
  alert(lines.join("\n"));
  return true;
}
