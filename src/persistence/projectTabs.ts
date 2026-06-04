// 多專案分頁(同視窗多開專案)
//
//   • projects: 每個元素是一份完整 project 資料(files / globalJoints / undoStack / counters / etc.)
//   • activeProjectId: 目前活躍中那份的 id(state / global counters / undoStack 都是這份的)
//   • projectDirty: 目前活躍 project 自上次儲存後是否有變更
//   • activateProject(id): snapshot 目前 → load 目標
//   • refreshProjectTabs / refreshProjectMenu: 同步 sidebar + 主選單 UI
//
//   ESM 限制:跨模組「reassign let」會 throw,所以對外提供 setActiveProjectId / setProjectDirty;
//   原 legacy 內的 5 個 `activeProjectId = X` 都改成 setActiveProjectId(X)
// @ts-nocheck

import {
  $, state,
  nextJointId, nextMemberId, nextFileId, nextGlobalJointId,
  setNextJointId, setNextMemberId, setNextFileId, setNextGlobalJointId,
  undoStack, redoStack,
  _saveCurrentTabView,
  activatePage, initBlank,
  promptName, escapeHtml,
  closeProjectById,
  _t,
} from "../app/integration";
import { showBusy, hideBusy, busyTick } from "../ui/busy";

export const projects: any[] = [];
export let activeProjectId: any = null;
let nextProjId = 1;
export let projectDirty = false;

export function setActiveProjectId(v: any) { activeProjectId = v; }
export function setProjectDirty(v: boolean) { projectDirty = !!v; }

export function makeEmptyProjectData(name) {
  return {
    id: nextProjId++,
    name: name || "未命名",
    files: [],
    globalJoints: [],
    undoStack: [],
    redoStack: [],
    scale: null,
    unitName: "mm",
    globalCapacity: 10000,
    activeFileId: null,
    pageIdx: 0,
    openTabs: [],
    zoom: 1, panX: 0, panY: 0,
    nextJointId: 1, nextMemberId: 1, nextFileId: 1, nextGlobalJointId: 1,
    projectFileHandle: null,
    jobName: name || "",
    dirty: false,
  };
}

export function snapshotActiveProjectInto(p) {
  if (!p) return;
  // 把當前 zoom/pan 存到所屬 page,讓專案分頁切回來時能還原
  _saveCurrentTabView();
  p.files = state.files;
  p.globalJoints = state.globalJoints;
  p.materials = Array.isArray(state.materials) ? state.materials : [];
  p.undoStack = undoStack.slice();
  p.redoStack = redoStack.slice();
  p.scale = state.scale;
  p.unitName = state.unitName;
  p.globalCapacity = state.globalCapacity;
  p.activeFileId = state.activeFileId;
  p.pageIdx = state.pageIdx;
  p.openTabs = Array.isArray(state.openTabs) ? state.openTabs.map(t => ({ ...t })) : [];
  p.zoom = state.zoom; p.panX = state.panX; p.panY = state.panY;
  p.nextJointId = nextJointId;
  p.nextMemberId = nextMemberId;
  p.nextFileId = nextFileId;
  p.nextGlobalJointId = nextGlobalJointId;
  p.projectFileHandle = state.projectFileHandle || null;
  p.jobName = ($("jobName") && $("jobName").value) || p.jobName || "";
  p.dirty = projectDirty;
}

export function loadProjectDataFromP(p) {
  state.files = p.files || [];
  // 衍生模型遷移:舊專案檔內的 autoProp 副本不再儲存,載入時直接清掉。
  let _strippedAutoProp = 0;
  for (const f of state.files) {
    if (!Array.isArray(f.sectionLinks)) continue;
    const before = f.sectionLinks.length;
    f.sectionLinks = f.sectionLinks.filter(e => !e.autoProp);
    _strippedAutoProp += (before - f.sectionLinks.length);
  }
  if (_strippedAutoProp) console.log(`[載入遷移] 清除 ${_strippedAutoProp} 個舊版 autoProp 副本(衍生模型不需儲存)`);
  state.globalJoints = p.globalJoints || [];
  state.materials    = Array.isArray(p.materials) ? p.materials : [];
  undoStack.length = 0; undoStack.push(...(p.undoStack || []));
  redoStack.length = 0; redoStack.push(...(p.redoStack || []));
  state.scale = p.scale ?? null;
  state.unitName = p.unitName || "mm";
  state.globalCapacity = p.globalCapacity || 10000;
  state.activeFileId = p.activeFileId ?? null;
  state.pageIdx = p.pageIdx || 0;
  state.openTabs = Array.isArray(p.openTabs) ? p.openTabs.map(t => ({ ...t })) : [];
  state.zoom = p.zoom || 1; state.panX = p.panX || 0; state.panY = p.panY || 0;
  // 舊專案 / 沒有 per-page view 的:把 project-level zoom 寫入「上次活躍頁」的 _view
  if (p.activeFileId != null && Number.isFinite(p.zoom)) {
    const af = (p.files || []).find(f => f.id === p.activeFileId);
    if (af) {
      if (!af.pages) af.pages = {};
      const pidx = p.pageIdx || 0;
      if (!af.pages[pidx]) af.pages[pidx] = { joints: [], members: [], z: 0 };
      if (!af.pages[pidx]._view) {
        af.pages[pidx]._view = { zoom: p.zoom, panX: p.panX || 0, panY: p.panY || 0 };
      }
    }
  }
  setNextJointId(p.nextJointId || 1);
  setNextMemberId(p.nextMemberId || 1);
  setNextFileId(p.nextFileId || 1);
  setNextGlobalJointId(p.nextGlobalJointId || 1);
  state.projectFileHandle = p.projectFileHandle || null;
  if ($("jobName")) $("jobName").value = p.jobName || "";
  projectDirty = !!p.dirty;
  // 清掉暫態 UI(避免跨分頁洩漏)
  if (state.selection) { state.selection.joints.clear(); state.selection.members.clear(); state.selection.fileIds.clear(); }
  state.marquee = null;
  state.measure = null;
  state.measurePending = false;
  state.splitMode = false;
  state.splitFirstCorner = null;
  state.pendingLineStart = null;
}

export async function activateProject(id) {
  if (activeProjectId === id) return;
  const cur = projects.find(p => p.id === activeProjectId);
  if (cur) snapshotActiveProjectInto(cur);
  const next = projects.find(p => p.id === id);
  if (!next) return;
  activeProjectId = id;
  loadProjectDataFromP(next);
  showBusy(`切換到「${next.name}」…`);
  await busyTick();
  try {
    if (next.activeFileId != null && state.files.some(f => f.id === next.activeFileId)) {
      await activatePage(next.activeFileId, next.pageIdx || 0);
    } else {
      initBlank();
    }
  } catch (e) { console.warn("[activateProject]", e); }
  finally { hideBusy(); }
  refreshProjectTabs();
  refreshProjectMenu();
}

// 顯示用的專案名稱:把規範值 "未命名" 依目前語言翻成 "Untitled" / "未命名"
function _dispProjName(name) {
  if (name === "未命名") return (typeof _t === "function" && _t("project.untitled")) || name;
  return name;
}

export function refreshProjectTabs() {
  const scroll = document.querySelector("#projectTabs .pt-scroll");
  if (!scroll) return;
  scroll.innerHTML = "";
  for (const p of projects) {
    const tab = document.createElement("div");
    tab.className = "pt-tab" + (p.id === activeProjectId ? " active" : "");
    tab.dataset.pid = String(p.id);
    const dispName = _dispProjName(p.name);
    const unsaved = (typeof _t === "function" && _t("project.unsaved")) || "(未儲存)";
    tab.title = dispName + (p.dirty || (p.id === activeProjectId && projectDirty) ? unsaved : "");
    const dirtyMark = (p.id === activeProjectId ? projectDirty : p.dirty) ? '<span class="pt-dirty">●</span>' : '';
    tab.innerHTML =
      `${dirtyMark}<span class="pt-name">${escapeHtml(dispName)}</span><span class="pt-close" title="關閉此分頁">✕</span>`;
    tab.addEventListener("click", (e: any) => {
      if (e.target && e.target.classList.contains("pt-close")) {
        e.stopPropagation();
        closeProjectById(p.id);
        return;
      }
      activateProject(p.id);
    });
    // 右鍵 → 重新命名
    tab.addEventListener("contextmenu", async (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      const newName = await promptName("重新命名分頁", `目前名稱:${p.name}`, p.name);
      if (newName == null || newName === "" || newName === p.name) return;
      if (projects.some(x => x !== p && x.name === newName)) {
        alert("此名稱已被其他分頁使用");
        return;
      }
      p.name = newName;
      p.jobName = newName;
      const isActive = (p.id === activeProjectId);
      if (isActive && $("jobName")) $("jobName").value = newName;
      // 若已經存過檔 → 嘗試把磁碟檔案也一起改名(FileSystemFileHandle.move,Chromium only)
      const h = isActive ? state.projectFileHandle : p.projectFileHandle;
      if (h) {
        const targetFileName = `${newName}.stproj.json`;
        if (typeof h.move === "function") {
          try {
            await h.move(targetFileName);
            console.log(`[rename] 磁碟檔案已改名 → ${targetFileName}`);
          } catch (err) {
            console.warn("[rename] handle.move 失敗,下次儲存會跳 save-as:", err);
            if (isActive) state.projectFileHandle = null;
            p.projectFileHandle = null;
          }
        } else {
          console.log("[rename] 瀏覽器無 handle.move API,下次儲存會跳 save-as");
          if (isActive) state.projectFileHandle = null;
          p.projectFileHandle = null;
        }
      }
      refreshProjectTabs();
      refreshProjectMenu();
    });
    scroll.appendChild(tab);
  }
  // 捲動到 active tab
  const active = scroll.querySelector(".pt-tab.active");
  if (active) (active as any).scrollIntoView({ inline: "nearest", block: "nearest" });
}

export function refreshProjectMenu() {
  const list = document.getElementById("projectMenuList");
  if (!list) return;
  list.innerHTML = "";
  for (const p of projects) {
    const entry = document.createElement("div");
    entry.className = "menu-entry";
    entry.textContent = (p.id === activeProjectId ? "● " : "   ") + _dispProjName(p.name) + (p.dirty || (p.id === activeProjectId && projectDirty) ? " *" : "");
    entry.addEventListener("click", () => { activateProject(p.id); });
    list.appendChild(entry);
  }
}
