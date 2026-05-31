// 節點支承(support)操作 — 套用 / 清除支承到選取節點,跨頁 sibling 同步。
//
//   public:
//     applySupportToSelection(support|null) — 核心:套用支承(null=清除)到選取節點 + 跨頁對應點
//     setSupportOnSelectedJoints            — 「設定支承…」按鈕:開支承設定視窗後套用
//     quickSupportFixed / quickSupportPinned — 快速套用 FIXED / PINNED(不開視窗)
//     clearSupportOnSelectedJoints          — 清除選取節點的支承
//     toggleAnchorOnSelectedJoints          — 向下相容別名 = setSupportOnSelectedJoints
//
//   ★ 「編號錨點(isAnchor)」概念已移除:有支承的點由 rankCache 自動視為座標軸錨點。
//     支承是「物理屬性」— 同 globalJoint 的所有跨頁副本要一起變動。
// @ts-nocheck

import {
  state, $, getPage, pushUndo, withBusy, render, refreshLists,
} from "../app/integration";
import { invalidateRankCache } from "../core/rankCache";
import type { Support } from "../core/support";
import { pickSupportModal } from "../dialogs/supportDialog";

// ---------- 共用:收集選取節點 + 跨頁 siblings ----------
// 回傳 Map(key=joint object),含選取節點本身與所有共享同 globalJoint 的跨頁對應 joint。
function _collectTargets(p: any, ids: number[]): Map<any, any> {
  const targets = new Map();
  for (const id of ids) {
    const j = p.joints.find((x: any) => x.id === id);
    if (!j) continue;
    targets.set(j, j);
    if (j.globalId == null) continue;
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {}) as any[]) {
        if (!pg || pg._orphan) continue;
        for (const other of (pg.joints || [])) {
          if (other !== j && other.globalId === j.globalId) targets.set(other, other);
        }
      }
    }
  }
  return targets;
}

// ---------- 主流程:套用支承到選取節點(+ 跨頁 siblings) ----------
// support=null → 清除支承。有支承的點在編號階段(rankCache)會自動視為座標軸錨點。
export async function applySupportToSelection(support: Support | null) {
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.joints];
  if (!ids.length) { alert("請先選取節點"); return; }
  const targets = _collectTargets(p, ids);
  const selectedCount = ids.length;
  const siblingCount = targets.size - selectedCount;
  const setTo = support != null;
  const verb = setTo ? "設定支承" : "清除支承";
  const busyMsg = siblingCount
    ? `${verb}中…(${selectedCount} 選取 + ${siblingCount} 跨頁對應點)`
    : `${verb}中…(處理 ${selectedCount} 顆節點)`;
  await withBusy(busyMsg, async () => {
    pushUndo();
    let changed = 0, alreadyState = 0;
    const newSupJson = setTo ? JSON.stringify(support) : "";
    for (const j of targets.values()) {
      if (j.isAnchor !== undefined) delete j.isAnchor;   // 清掉殘留的舊欄位
      if (setTo) {
        const supChanged = JSON.stringify(j.support || null) !== newSupJson;
        if (supChanged) {
          j.support = JSON.parse(newSupJson);   // 每個 joint 各持一份,避免共用參考
          changed++;
        } else {
          alreadyState++;
        }
      } else {
        if (j.support) { delete j.support; changed++; }
        else alreadyState++;
      }
    }
    if (typeof invalidateRankCache === "function") invalidateRankCache();
    const siblingNote = siblingCount ? `(${selectedCount} 選取 + ${siblingCount} 跨頁對應)` : "";
    const typeNote = setTo ? `〔${support!.type}〕` : "";
    const summary = `${verb}${typeNote} — 變動 ${changed} / ${targets.size} 顆${siblingNote}${alreadyState ? `,${alreadyState} 顆原本就是` : ""}`;
    $("hud").textContent = summary;
    console.log(`[支承] ${summary}`);
    render && render();
    refreshLists && refreshLists();
  });
}

// 設定支承…:永遠開支承設定視窗(類型 + 參數),預填選取中第一個已有支承的設定
export async function setSupportOnSelectedJoints() {
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.joints];
  if (!ids.length) { alert("請先選取節點"); return; }
  let preset: Support | null = null;
  for (const id of ids) {
    const j = p.joints.find((x: any) => x.id === id);
    if (j && (j as any).support) { preset = (j as any).support; break; }
  }
  const chosen = await pickSupportModal(ids.length, preset);
  if (chosen == null) { console.log("[支承設定] 使用者取消 → 不動"); return; }
  await applySupportToSelection(chosen);
}

// 快速套用(不開視窗)
export const quickSupportFixed  = () => applySupportToSelection({ type: "FIXED" });
export const quickSupportPinned = () => applySupportToSelection({ type: "PINNED" });
// 清除選取節點的支承
export const clearSupportOnSelectedJoints = () => applySupportToSelection(null);

// 向下相容別名:舊呼叫端(toggleAnchorOnSelectedJoints)→ 改為開支承設定視窗
export const toggleAnchorOnSelectedJoints = setSupportOnSelectedJoints;
