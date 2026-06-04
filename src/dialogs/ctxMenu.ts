// 右鍵 context menu — 點 / 線 / 多選 的快捷選單(刪除 / 全局節點綁定 / 重命名 / etc.)
//   showCtxMenu          — 在 (x, y) 顯示 menu,target 可為 null(用目前選取)或 {type, id, el}
//   hideCtxMenu          — 隱藏並清空 pending 狀態
//   ctxState             — 模組共享狀態(target / pending),legacy.ts 內其他 handler 透過 ctxState.pending 讀寫
//   updateCtxFilterRadios— 舊的選取模式 radio(目前隱藏,保留以免 ReferenceError)
//
//   注意:state.pending 必須是 mutable 共享(legacy.ts 多處 handler 還在用),所以走 ctxState.pending
// @ts-nocheck

import {
  state, $, getPage, findGlobalJointById,
  updateSelectToolLabel, applyTransform,
} from "../app/integration";

// 共享狀態 — legacy.ts 的 handlers (ctxRename / ctxDuplicate / ctxOpenTab / 刪除 等) 直接讀寫
export const ctxState: { target: any; pending: any } = { target: null, pending: null };

export function showCtxMenu(x, y, target) {
  _ensureBound();
  ctxState.target = target;
  const p = getPage();

  // 決定刪除集合
  // - target 在多選中 → 套用整個多選
  // - target 不在多選中 → 只刪這一個
  // - target 為 null → 使用目前選取
  const joints = new Set();
  const members = new Set();
  if (target) {
    const inSel = target.type === "joint"
      ? state.selection.joints.has(target.id)
      : state.selection.members.has(target.id);
    const multi = state.selection.joints.size + state.selection.members.size > 1;
    if (inSel && multi) {
      state.selection.joints.forEach((id) => joints.add(id));
      state.selection.members.forEach((id) => members.add(id));
    } else {
      if (target.type === "joint") joints.add(target.id);
      else members.add(target.id);
    }
  } else {
    state.selection.joints.forEach((id) => joints.add(id));
    state.selection.members.forEach((id) => members.add(id));
  }
  if (joints.size === 0 && members.size === 0) return;  // 沒有可刪內容

  // 預估孤立節點:被刪桿件的端點若已不被任何剩餘桿件用到 → 一起刪
  const checkOrphan = new Set();
  for (const m of p.members) if (members.has(m.id)) {
    checkOrphan.add(m.j1); checkOrphan.add(m.j2);
  }
  const remaining = p.members.filter(m =>
    !members.has(m.id) && !joints.has(m.j1) && !joints.has(m.j2));
  const used = new Set();
  for (const m of remaining) { used.add(m.j1); used.add(m.j2); }
  const orphans = new Set();
  for (const id of checkOrphan) {
    if (!joints.has(id) && !used.has(id)) orphans.add(id);
  }
  ctxState.pending = { joints, members, orphans };
  $("ctxRename").style.display = "none";
  $("ctxDuplicate") && ($("ctxDuplicate").style.display = "none");
  $("ctxOpenTab") && ($("ctxOpenTab").style.display = "none");
  $("ctxDelete").style.display = "block";
  $("ctxBgSplit").style.display = "none";
  $("ctxBgToMember").style.display = "none";
  $("ctxBgToDashed") && ($("ctxBgToDashed").style.display = "none");

  // 全局節點:單一 joint 才顯示
  const onlyOneJoint = (joints.size === 1 && members.size === 0);
  const theJoint = onlyOneJoint ? p.joints.find(j => j.id === [...joints][0]) : null;
  const hasGlobals = state.globalJoints.length > 0;
  const isBound = theJoint && theJoint.globalId != null;
  $("ctxPromoteGlobal").style.display = (theJoint && !isBound) ? "block" : "none";
  $("ctxBindGlobal").style.display    = (theJoint && hasGlobals) ? "block" : "none";
  $("ctxUnbindGlobal").style.display  = isBound ? "block" : "none";
  if (isBound) {
    const g = findGlobalJointById(theJoint.globalId);
    $("ctxBindGlobal").textContent = `改綁到其他全局節點… (目前: ${g ? g.label : "?"})`;
    $("ctxUnbindGlobal").textContent = `取消全局綁定 (${g ? g.label : "?"})`;
  } else {
    $("ctxBindGlobal").textContent = "綁定到既有 N…";
  }
  // 選取模式(選取點/選取線)已移除,改用 Shift+S 切換單/多選,ctxFilterGroup 不再顯示
  $("ctxFilterGroup").style.display = "none";

  // 標題
  const total = joints.size + members.size + orphans.size;
  $("ctxHead").textContent = `將刪除 ${total} 項` +
    (orphans.size ? `(含 ${orphans.size} 孤立節點)` : "");

  // 列表內容
  const list = $("ctxList");
  list.innerHTML = "";
  const addItem = (text, cls) => {
    const d = document.createElement("div");
    d.className = "ctx-list-item" + (cls ? " " + cls : "");
    d.textContent = text;
    list.appendChild(d);
  };
  for (const id of [...members].sort((a, b) => a - b)) {
    const m = p.members.find(x => x.id === id);
    if (m) addItem(`桿件 M${m.id} (J${m.j1}–J${m.j2})`);
  }
  for (const id of [...joints].sort((a, b) => a - b)) {
    addItem(`節點 J${id}`);
  }
  if (orphans.size) {
    const lbl = document.createElement("div");
    lbl.className = "ctx-section-label";
    lbl.textContent = "連帶清除孤立節點";
    list.appendChild(lbl);
    for (const id of [...orphans].sort((a, b) => a - b)) {
      addItem(`節點 J${id}`, "orphan");
    }
  }

  // 顯示並夾在視窗內
  const m = $("ctxMenu");
  m.style.display = "flex";
  m.style.left = "0px"; m.style.top = "0px";
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + "px";
  m.style.top  = Math.min(y, window.innerHeight - h - 4) + "px";
  if (target && target.el) target.el.classList.add("ctx-active");
}

export function hideCtxMenu() {
  // 走 document.getElementById 不走 legacy 的 `$` — hideCtxMenu 會被早期 click handler 呼叫到,
  // 若 legacy.ts 還沒初始化完(circular dep TDZ),$ 不能用
  const m = document.getElementById("ctxMenu");
  if (m) m.style.display = "none";
  if (ctxState.target && ctxState.target.el) ctxState.target.el.classList.remove("ctx-active");
  ctxState.target = null;
  ctxState.pending = null;
}

// 舊的選取模式 radio — 目前 ctxFilterGroup 已永久隱藏,但 click handler 還在(向下相容)
export function updateCtxFilterRadios() {
  document.querySelectorAll("#ctxFilterGroup .ctx-radio").forEach(el => {
    el.classList.toggle("on", el.dataset.filter === state.selectFilter);
  });
}

// ---------- 全域事件:點外面 / 右鍵 / 滾動都關掉 menu ----------
//   不能在 module top-level 跑 — legacy.ts ↔ ctxMenu.ts 是循環依賴:
//   ctxMenu.ts 載入時 legacy.ts 還在執行 top-level,`$` 還在 TDZ → ReferenceError
//   改成 lazy init:首次 showCtxMenu 時才綁;showCtxMenu / hideCtxMenu 都 call ensureBound 保險
let _bound = false;
function _ensureBound() {
  if (_bound) return;
  _bound = true;
  window.addEventListener("click", hideCtxMenu);
  window.addEventListener("contextmenu", (e: any) => {
    if (!e.target.closest(".item")) hideCtxMenu();
  });
  window.addEventListener("scroll", (e: any) => {
    if (e.target && e.target.closest && e.target.closest("#ctxMenu")) return;
    hideCtxMenu();
  }, true);
  const cm = $("ctxMenu");
  if (cm) {
    cm.addEventListener("click", (e: any) => e.stopPropagation());
    cm.addEventListener("wheel", (e: any) => e.stopPropagation());
  }
  document.querySelectorAll("#ctxFilterGroup .ctx-radio").forEach(el => {
    el.addEventListener("click", (e: any) => {
      e.stopPropagation();
      state.selectFilter = (el as HTMLElement).dataset.filter;
      updateCtxFilterRadios();
      updateSelectToolLabel();
      applyTransform();
      hideCtxMenu();
    });
  });
}
