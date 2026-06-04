// 桿件釋放(member release)操作 — 套用 / 清除釋放到選取桿件,跨頁 sibling 同步。
//   架構同 tools/anchor.ts(節點支承),但作用對象是桿件、跨頁靠 globalMemberId。
//
//   public:
//     applyReleaseToSelection(release|null) — 核心:套用釋放(null=清除)到選取桿件 + 跨頁對應
//     setReleaseOnSelectedMembers           — 「設定釋放…」開視窗後套用
//     quickReleasePinned                     — 快速:兩端鉸接(放 MX MY MZ)
//     quickReleaseTruss                      — 快速:設為桁架桿(TRUSS)
//     clearReleaseOnSelectedMembers          — 清除選取桿件的釋放
// @ts-nocheck

import {
  state, $, getPage, pushUndo, withBusy, render, refreshLists,
} from "../app/integration";
import type { MemberRelease } from "../core/memberRelease";
import { hasRelease } from "../core/memberRelease";
import { pickReleaseModal } from "../dialogs/releaseDialog";

// 收集選取桿件 + 跨頁 siblings(共享同 globalMemberId 的其他頁桿件)
function _collectMemberTargets(p: any, ids: number[]): Map<any, any> {
  const targets = new Map();
  for (const id of ids) {
    const m = p.members.find((x: any) => x.id === id);
    if (!m) continue;
    targets.set(m, m);
    if (m.globalMemberId == null) continue;
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {}) as any[]) {
        if (!pg || pg._orphan) continue;
        for (const other of (pg.members || [])) {
          if (other !== m && other.globalMemberId === m.globalMemberId) targets.set(other, other);
        }
      }
    }
  }
  return targets;
}

// release=null → 清除釋放。空的 RELEASE(兩端都沒放)也視為清除。
export async function applyReleaseToSelection(release: MemberRelease | null) {
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.members];
  if (!ids.length) { alert("請先選取桿件"); return; }
  // 正規化:空的 RELEASE → 當作清除
  const eff: MemberRelease | null = (release && hasRelease({ release })) ? release : null;
  const targets = _collectMemberTargets(p, ids);
  const selectedCount = ids.length;
  const siblingCount = targets.size - selectedCount;
  const setTo = eff != null;
  const verb = setTo ? "設定釋放" : "清除釋放";
  const busyMsg = siblingCount
    ? `${verb}中…(${selectedCount} 選取 + ${siblingCount} 跨頁對應)`
    : `${verb}中…(處理 ${selectedCount} 根桿件)`;
  await withBusy(busyMsg, async () => {
    pushUndo();
    let changed = 0, alreadyState = 0;
    const newJson = setTo ? JSON.stringify(eff) : "";
    for (const m of targets.values()) {
      if (setTo) {
        const relChanged = JSON.stringify(m.release || null) !== newJson;
        if (relChanged) { m.release = JSON.parse(newJson); changed++; }   // 各持一份,避免共用參考
        else alreadyState++;
      } else {
        if (m.release) { delete m.release; changed++; }
        else alreadyState++;
      }
    }
    const siblingNote = siblingCount ? `(${selectedCount} 選取 + ${siblingCount} 跨頁對應)` : "";
    const typeNote = setTo ? `〔${eff!.type}〕` : "";
    const summary = `${verb}${typeNote} — 變動 ${changed} / ${targets.size} 根${siblingNote}${alreadyState ? `,${alreadyState} 根原本就是` : ""}`;
    $("hud").textContent = summary;
    console.log(`[桿件釋放] ${summary}`);
    render && render();
    refreshLists && refreshLists();
  });
}

// 設定釋放…:永遠開視窗,預填選取中第一個已有釋放的設定
export async function setReleaseOnSelectedMembers() {
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.members];
  if (!ids.length) { alert("請先選取桿件"); return; }
  let preset: MemberRelease | null = null;
  for (const id of ids) {
    const m = p.members.find((x: any) => x.id === id);
    if (m && (m as any).release) { preset = (m as any).release; break; }
  }
  const chosen = await pickReleaseModal(ids.length, preset);
  if (chosen == null) { console.log("[桿件釋放] 使用者取消 → 不動"); return; }
  await applyReleaseToSelection(chosen);
}

// 快速套用(不開視窗)
export const quickReleasePinned = () => applyReleaseToSelection({ type: "RELEASE", start: ["MX", "MY", "MZ"], end: ["MX", "MY", "MZ"] });
export const quickReleaseTruss  = () => applyReleaseToSelection({ type: "TRUSS" });
export const clearReleaseOnSelectedMembers = () => applyReleaseToSelection(null);
