// 通用對話框 helpers + 新增 / 關閉專案
//
//   • promptNumberWithSkip — 數字輸入 + skip 按鈕(回傳 number / "skip" / null)
//   • promptName — 字串輸入(回傳 string / null)
//   • confirm3 — 三選一對話框(儲存 / 丟棄 / 取消)
//   • newProjectPrompt — 新增專案 entry(會建立 makeEmptyProjectData + activateProject)
//   • closeProjectById / closeCurrentProject — 關閉專案(dirty 時跳 confirm3)
// @ts-nocheck

import { state } from "./state";
import { $ } from "./dom";
import { _startSaveWithHook } from "./init";
import {
  // legacy forward refs
  _t,
  projects, activeProjectId, setActiveProjectId, projectDirty,
  makeEmptyProjectData, snapshotActiveProjectInto, loadProjectDataFromP,
  activateProject, refreshProjectTabs, refreshProjectMenu,
  saveProjectFull,
  initBlank,
  setProjectDirty,
} from "../app/integration";

// ---------- 通用對話框 helpers ----------
// 輸入名稱對話框:回傳字串或 null(取消)
// 數值輸入對話框,並提供「跳過」按鈕 → 回傳 number / "skip" / null(Esc / 取消)
export function promptNumberWithSkip(title, label, defaultValue) {
  return new Promise(resolve => {
    const dlg = document.getElementById("genericDialog");
    const titleEl = document.getElementById("gdTitle");
    const msgEl = document.getElementById("gdMsg");
    const inpEl = document.getElementById("gdInput");
    const footerEl = document.getElementById("gdFooter");
    titleEl.textContent = title || "";
    msgEl.textContent = label || "";
    inpEl.style.display = "block";
    inpEl.type = "number";
    inpEl.value = (defaultValue == null || !Number.isFinite(defaultValue)) ? "" : String(defaultValue);
    footerEl.innerHTML = "";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    const skipBtn = document.createElement("button");
    skipBtn.textContent = "跳過";
    const okBtn = document.createElement("button");
    okBtn.className = "primary";
    okBtn.textContent = "確定";
    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(skipBtn);
    footerEl.appendChild(okBtn);
    const cleanup = () => {
      dlg.classList.remove("active");
      inpEl.type = "text";   // 還原給其他 promptName 用
      document.removeEventListener("keydown", onKey, true);
    };
    const close = (result) => { cleanup(); resolve(result); };
    const tryCommit = () => {
      const v = parseFloat(inpEl.value);
      if (!Number.isFinite(v)) { skipBtn.classList.add("primary"); inpEl.focus(); return; }
      close(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); tryCommit(); }
      else { e.stopImmediatePropagation(); }
    };
    cancelBtn.onclick = () => close(null);
    skipBtn.onclick = () => close("skip");
    okBtn.onclick = tryCommit;
    document.addEventListener("keydown", onKey, true);
    dlg.classList.add("active");
    setTimeout(() => { inpEl.focus(); inpEl.select(); }, 30);
  });
}

export function promptName(title, label, defaultValue) {
  return new Promise(resolve => {
    const dlg = document.getElementById("genericDialog");
    const titleEl = document.getElementById("gdTitle");
    const msgEl = document.getElementById("gdMsg");
    const inpEl = document.getElementById("gdInput");
    const footerEl = document.getElementById("gdFooter");
    titleEl.textContent = title || "";
    msgEl.textContent = label || "";
    inpEl.style.display = "block";
    inpEl.value = defaultValue || "";
    footerEl.innerHTML = "";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    const okBtn = document.createElement("button");
    okBtn.className = "primary";
    okBtn.textContent = "確定";
    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(okBtn);
    const close = (result) => {
      dlg.classList.remove("active");
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); close(inpEl.value.trim()); }
      else { e.stopImmediatePropagation(); }
    };
    cancelBtn.onclick = () => close(null);
    okBtn.onclick = () => close(inpEl.value.trim());
    document.addEventListener("keydown", onKey, true);
    dlg.classList.add("active");
    setTimeout(() => { inpEl.focus(); inpEl.select(); }, 30);
  });
}

// 三選一確認(儲存 / 丟棄 / 取消)→ 回傳 "save" | "discard" | "cancel"
export function confirm3(title, msg) {
  return new Promise(resolve => {
    const dlg = document.getElementById("genericDialog");
    document.getElementById("gdTitle").textContent = title || "";
    document.getElementById("gdMsg").textContent = msg || "";
    document.getElementById("gdInput").style.display = "none";
    const footerEl = document.getElementById("gdFooter");
    footerEl.innerHTML = "";
    const mkBtn = (label, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; return b; };
    const cancelBtn  = mkBtn("取消");
    const discardBtn = mkBtn("丟棄", "warn");
    const saveBtn    = mkBtn("儲存", "primary");
    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(discardBtn);
    footerEl.appendChild(saveBtn);
    const close = (r) => { dlg.classList.remove("active"); document.removeEventListener("keydown", onKey, true); resolve(r); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close("cancel"); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); close("save"); }
      else { e.stopImmediatePropagation(); }
    };
    cancelBtn.onclick  = () => close("cancel");
    discardBtn.onclick = () => close("discard");
    saveBtn.onclick    = () => close("save");
    document.addEventListener("keydown", onKey, true);
    dlg.classList.add("active");
  });
}

// ---------- 新增 / 關閉專案 ----------
export async function newProjectPrompt() {
  const defaultName = `未命名_${projects.length + 1}`;
  const name = await promptName("新增專案", "請輸入新專案名稱:", defaultName);
  if (name == null || name === "") return;
  if (projects.some(p => p.name === name)) {
    alert("專案名稱已存在,請換一個");
    return;
  }
  // snapshot 目前專案
  const cur = projects.find(p => p.id === activeProjectId);
  if (cur) snapshotActiveProjectInto(cur);
  // 建立新的空白專案
  const p = makeEmptyProjectData(name);
  projects.push(p);
  setActiveProjectId(p.id);
  loadProjectDataFromP(p);
  initBlank();
  refreshProjectTabs();
  refreshProjectMenu();
}

export async function closeProjectById(id) {
  const p = projects.find(x => x.id === id);
  if (!p) return;
  const isActive = (id === activeProjectId);
  const dirty = isActive ? projectDirty : p.dirty;
  if (dirty) {
    const choice = await confirm3("關閉專案", `專案「${p.name}」有未儲存的變更,是否儲存?`);
    if (choice === "cancel") return;
    if (choice === "save") {
      // 若不是當前 active,先切過去才能儲存(startSave 操作 active state)
      if (!isActive) await activateProject(id);
      try { await _startSaveWithHook(false); }
      catch (e) { console.warn("[close] 儲存失敗", e); alert("儲存失敗,已取消關閉"); return; }
    }
  }
  // 從陣列移除
  const idx = projects.findIndex(x => x.id === id);
  if (idx >= 0) projects.splice(idx, 1);
  if (isActive) {
    // 切到相鄰的分頁;若空了就自動新增一個空白
    setActiveProjectId(null);
    if (projects.length) {
      const target = projects[Math.min(idx, projects.length - 1)];
      await activateProject(target.id);
    } else {
      const np = makeEmptyProjectData("未命名");
      projects.push(np);
      setActiveProjectId(np.id);
      loadProjectDataFromP(np);
      initBlank();
      refreshProjectTabs();
      refreshProjectMenu();
    }
  } else {
    refreshProjectTabs();
    refreshProjectMenu();
  }
}
export async function closeCurrentProject() {
  if (activeProjectId != null) await closeProjectById(activeProjectId);
}

