// 錨點(支座)相關操作 — 切換 isAnchor / supportType,跨頁 sibling 同步,選支座類型 modal
//
//   public:
//     toggleAnchorOnSelectedJoints       — 「設為錨點 / 取消錨點」按鈕主流程
//     toggleSupportTypeOnSelectedAnchors — 切換 FIXED ↔ PINNED(舊版獨立按鈕,目前未綁定,保留 API)
//     updateSupportTypeBtn               — 更新「支座 FIXED / PINNED」按鈕 label(同上)
//     _updateAnchorToggleBtn             — 更新「設為錨點 / 取消錨點」按鈕 label,refreshLists 會呼叫
//     pickSupportTypeModal               — 跳出支座類型選擇 modal(回傳 Promise)
//
//   錨點是「物理屬性」— 同 globalJoint 的所有跨頁副本要同步切。
//   isAnchor=true 時 supportType 預設 FIXED(JSON 不存欄位,清掉 supportType 就視為 FIXED)
// @ts-nocheck

import {
  state, $, getPage, pushUndo, withBusy, render, refreshLists,
} from "../legacy";
import { invalidateRankCache } from "../core/rankCache";
import { _setBtnLabel } from "../i18n";

// ---------- pickSupportTypeModal: FIXED / PINNED / 取消 ----------
//   為了避免多次重建 DOM,modal 第一次呼叫時 createElement,之後重用,只換 resolve 跟內容
let _stmResolve: ((v: "FIXED" | "PINNED" | null) => void) | null = null;

export function pickSupportTypeModal(jointCount: number): Promise<"FIXED" | "PINNED" | null> {
  return new Promise((resolve) => {
    let modal = document.getElementById("supportTypeModal") as HTMLDivElement | null;
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "supportTypeModal";
      document.body.appendChild(modal);
      // 一次性綁鍵盤 Esc(走 document 因為 modal 是新建的)
      document.addEventListener("keydown", (e: KeyboardEvent) => {
        const m = document.getElementById("supportTypeModal");
        if (m && m.classList.contains("active") && e.key === "Escape") {
          e.preventDefault();
          if (_stmResolve) { _stmResolve(null); _stmResolve = null; }
          m.classList.remove("active");
        }
      });
    }
    const _close = (v: "FIXED" | "PINNED" | null) => {
      if (_stmResolve) { _stmResolve(v); _stmResolve = null; }
      modal!.classList.remove("active");
    };
    _stmResolve = resolve;
    modal.innerHTML =
      `<div class="stm-card">` +
      `  <div class="stm-titlebar">設定支座類型</div>` +
      `  <div class="stm-body">` +
      `    將選取的 <b>${jointCount}</b> 顆節點標為錨點,並指定支座類型:` +
      `    <ul style="margin:8px 0 0 18px;padding:0">` +
      `      <li><b style="color:#5ab9ff">FIXED</b> — 6 個自由度全鎖,鋼柱基座最常見</li>` +
      `      <li><b style="color:#5ab9ff">PINNED</b> — 只鎖位移不鎖旋轉,銷接</li>` +
      `    </ul>` +
      `  </div>` +
      `  <div class="stm-buttons">` +
      `    <button class="stm-btn" data-act="cancel">取消</button>` +
      `    <button class="stm-btn secondary" data-act="pinned">PINNED</button>` +
      `    <button class="stm-btn primary" data-act="fixed">FIXED</button>` +
      `  </div>` +
      `</div>`;
    // backdrop 點擊也算取消
    modal.onclick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).id === "supportTypeModal") _close(null);
    };
    // 三顆按鈕
    modal.querySelectorAll<HTMLButtonElement>(".stm-btn").forEach(btn => {
      btn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "fixed") _close("FIXED");
        else if (act === "pinned") _close("PINNED");
        else _close(null);
      };
    });
    modal.classList.add("active");
    // 焦點放在 FIXED(預設)讓 Enter 直接送出
    setTimeout(() => {
      const fb = modal!.querySelector<HTMLButtonElement>('.stm-btn[data-act="fixed"]');
      fb && fb.focus();
    }, 30);
  });
}

// ---------- 按鈕 label 同步 ----------
// 「設為錨點 / 取消錨點」按鈕 label:選取中的 joint 多數已是錨點 → 顯示「取消錨點」
//   refreshLists 每次選取變更會呼叫 → 自動更新
//
//   重要:這顆按鈕 label 會在「設為錨點」↔「取消錨點」之間切,所以容易被 textContent= 洗掉
//   .btn-icon → icon-only 模式就只剩空白。為了在任何情況下都保有 anchor 圖示,函式自己
//   在每次呼叫時補上 .btn-icon / .btn-text 兩個 span(若缺)→ self-healing。
const _ANCHOR_ICON_SVG =
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><line x1="12" y1="7" x2="12" y2="20"/>' +
  '<path d="M5 14a7 7 0 0 0 14 0"/><line x1="9" y1="11" x2="15" y2="11"/></svg>';

function _ensureAnchorBtnStructure(btn: any) {
  let iconSpan = btn.querySelector(".btn-icon");
  let textSpan = btn.querySelector(".btn-text");
  if (iconSpan && textSpan) return textSpan;
  // 結構壞了 → 重建
  const txt = (textSpan && textSpan.textContent) || btn.textContent.trim() || "設為錨點";
  btn.innerHTML =
    `<span class="btn-icon">${_ANCHOR_ICON_SVG}</span>` +
    `<span class="btn-text" data-i18n="subtool.selToolsAnchorToggle">${txt}</span>`;
  return btn.querySelector(".btn-text");
}

export function _updateAnchorToggleBtn() {
  const btn = $("selToolsAnchorToggle");
  if (!btn) return;
  _ensureAnchorBtnStructure(btn);
  const p = getPage();
  const ids = p ? [...state.selection.joints] : [];
  let anchored = 0;
  for (const id of ids) {
    const j = p && p.joints.find(x => x.id === id);
    if (j && j.isAnchor) anchored++;
  }
  // 跟 toggleAnchorOnSelectedJoints 內的 setTo 判定一致:多數已是錨點 → 改顯示取消
  const isCancel = ids.length > 0 && anchored >= ids.length / 2;
  _setBtnLabel(btn, isCancel ? "subtool.selToolsAnchorToggle.cancel" : "subtool.selToolsAnchorToggle",
               isCancel ? "取消錨點" : "設為錨點");
}

// 依目前選取狀態更新「支座 FIXED / PINNED」按鈕的 label(若該按鈕還有掛)
export function updateSupportTypeBtn() {
  const btn = $("selToolsSupportType");
  if (!btn) return;
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.joints];
  // 預設標 FIXED;若選取錨點多數是 PINNED 才改顯示 PINNED
  let label = "支座 FIXED";
  if (ids.length) {
    const anchorSelected = ids
      .map(id => p.joints.find(x => x.id === id))
      .filter(j => j && j.isAnchor);
    if (anchorSelected.length) {
      const pinned = anchorSelected.filter(j => j.supportType === "PINNED").length;
      label = pinned >= anchorSelected.length / 2 ? "支座 PINNED" : "支座 FIXED";
    }
  }
  btn.textContent = label;
}

// ---------- 主流程 ----------
// 切換選取節點的 isAnchor 標記。
//   若多數選取節點目前是 anchor → 全部取消;否則 → 全部標為 anchor
//   標為錨點時跳支座類型 modal(FIXED / PINNED / 取消)
//   跨頁同步:若 joint 有 globalId → 所有共享同 globalJoint 的 siblings 一起 toggle
export async function toggleAnchorOnSelectedJoints() {
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.joints];
  if (!ids.length) { alert("請先選取節點"); return; }
  // 統計「選取節點本身」目前狀態,決定 setTo(兩邊各半 → 偏向「標為」)
  let anchoredCount = 0;
  for (const id of ids) {
    const j = p.joints.find(x => x.id === id);
    if (j && j.isAnchor) anchoredCount++;
  }
  const setTo = anchoredCount < ids.length / 2;
  const verb = setTo ? "標為錨點" : "取消錨點";
  // 若是「標為錨點」→ 跳自訂 modal 選擇支座類型(FIXED / PINNED / 取消)
  //   取消 / Esc / 點 backdrop → null → 整個操作 abort,不動 isAnchor
  let chosenSupportType: "FIXED" | "PINNED" | null = null;
  if (setTo) {
    chosenSupportType = await pickSupportTypeModal(ids.length);
    if (chosenSupportType == null) {
      console.log("[錨點切換] 使用者取消支座類型選擇 → 不動");
      return;
    }
  }
  // 收集要變動的 joint:選取節點 + 所有共享 globalJoint 的跨頁對應 joint(siblings)
  //   用 Map(key=joint object)去重,避免同一物件被加兩次
  const targets = new Map();
  for (const id of ids) {
    const j = p.joints.find(x => x.id === id);
    if (!j) continue;
    targets.set(j, j);
    if (j.globalId == null) continue;
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        for (const other of (pg.joints || [])) {
          if (other === j) continue;
          if (other.globalId === j.globalId) targets.set(other, other);
        }
      }
    }
  }
  const selectedCount = ids.length;
  const siblingCount = targets.size - selectedCount;
  const busyMsg = siblingCount
    ? `${verb}中…(${selectedCount} 選取 + ${siblingCount} 跨頁對應點)`
    : `${verb}中…(處理 ${selectedCount} 顆節點)`;
  await withBusy(busyMsg, async () => {
    pushUndo();
    let changed = 0, alreadyState = 0;
    for (const j of targets.values()) {
      const cur = !!j.isAnchor;
      if (cur !== setTo) {
        j.isAnchor = setTo || undefined;   // 不需要時直接 unset(讓 JSON 輸出乾淨)
        // 同時套支座類型:FIXED 預設不存欄位(JSON 乾淨);PINNED 才寫進去
        //   取消錨點時連 supportType 一起清掉
        if (setTo) {
          if (chosenSupportType === "PINNED") j.supportType = "PINNED";
          else delete j.supportType;
        } else {
          delete j.supportType;
        }
        changed++;
      } else {
        alreadyState++;
      }
    }
    if (typeof invalidateRankCache === "function") invalidateRankCache();
    console.log(`[錨點切換] ${verb} 完成・變動 ${changed}・已是該狀態 ${alreadyState}・選取 ${selectedCount}・跨頁 siblings ${siblingCount}`);
    const siblingNote = siblingCount ? `(${selectedCount} 選取 + ${siblingCount} 跨頁對應)` : "";
    const summary = `${verb}完成 — 變動 ${changed} / ${targets.size} 顆${siblingNote}${alreadyState ? `,${alreadyState} 顆原本就是` : ""}`;
    $("hud").textContent = summary;
    render && render();
    refreshLists && refreshLists();
    if (changed > 0) {
      setTimeout(() => {
        alert(`${summary}\n\n節點將以青色顯示。Rank 編號時這些 joint 會被視為錨點(等同有 H+V member 的真實交點),不會被推到後段。`);
      }, 30);
    } else {
      setTimeout(() => alert(`沒有變動 — 選取的 ${selectedCount} 顆節點${siblingCount ? `(及對應 ${siblingCount} 顆跨頁 siblings)` : ""}目前都已是「${setTo ? "錨點" : "非錨點"}」狀態。`), 30);
    }
  });
}

// 切換選取錨點的支座類型(FIXED ↔ PINNED)
//   STAAD 匯出時:FIXED = 6 自由度全鎖、PINNED = 鎖位移不鎖旋轉
//   只對 isAnchor=true 的 joint 生效;切換時跨頁同步(同 globalJoint 的所有副本)
//   未設過 supportType 的錨點預設視為 FIXED(向下相容,舊存檔可直接讀)
export async function toggleSupportTypeOnSelectedAnchors() {
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.joints];
  if (!ids.length) { alert("請先選取節點"); return; }
  const anchorSelected = ids
    .map(id => p.joints.find(x => x.id === id))
    .filter(j => j && j.isAnchor);
  if (!anchorSelected.length) {
    alert("選取的節點都不是錨點 — 請先按「設為錨點」把它們標為錨點,再切換支座類型。");
    return;
  }
  // 看選取錨點目前的 supportType 投票,決定 setTo(未設 → 視為 FIXED)
  let pinnedCount = 0;
  for (const j of anchorSelected) {
    if (j.supportType === "PINNED") pinnedCount++;
  }
  const setTo = pinnedCount < anchorSelected.length / 2 ? "PINNED" : "FIXED";
  const targets = new Map();
  for (const j of anchorSelected) {
    targets.set(j, j);
    if (j.globalId == null) continue;
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        for (const other of (pg.joints || [])) {
          if (other === j) continue;
          if (other.globalId === j.globalId) targets.set(other, other);
        }
      }
    }
  }
  const selectedCount = anchorSelected.length;
  const siblingCount = targets.size - selectedCount;
  await withBusy(`切換支座為 ${setTo}…(${selectedCount} 選取${siblingCount ? ` + ${siblingCount} 跨頁` : ""})`, async () => {
    pushUndo();
    let changed = 0;
    for (const j of targets.values()) {
      if (!j.isAnchor) continue;   // 只動已是錨點的 sibling,non-anchor 不誤動
      const cur = j.supportType || "FIXED";
      if (cur !== setTo) {
        if (setTo === "FIXED") delete j.supportType;
        else j.supportType = setTo;
        changed++;
      }
    }
    console.log(`[支座類型切換] → ${setTo}・變動 ${changed} / ${targets.size}`);
    updateSupportTypeBtn();
    render && render();
    refreshLists && refreshLists();
  });
}
