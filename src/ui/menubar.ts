// Phase 8m — 頂部主選單列(File / Project / Edit / Tools / View / Language)
//   • _refreshRecentProjectMenu: 從 state/recentProjects IDB 抓清單渲染到「File → 開啟專案 → 最近開啟」
//   • IIFE 主體:hook actions map + menubar entry click + 搜尋 / 3D 按鈕特殊 action
//
//   所有 menu action handler 全部走 export function 互動;dispatch layer。
//
//   依賴(全部已 export):
//     legacy: $ / state / pushUndo / withBusy / 一堆 action functions
//     export/xlsx, dialogs/*, state/recentProjects, i18n: 按需 import
//
//   模組載入時即執行 IIFE,跟原本在 legacy 內嵌的位置等價。
//   _refreshRecentProjectMenu 也順手暴露到 window,讓 state/recentProjects 的 callback 能找到。

import {
  $, state, pushUndo, withBusy,
  _afterCalibrationChanged, _applyToolbarMode,
  _runBgRepair, _run3DOneClickPipeline, _runFitMergeByPrecision,
  cleanupBadGlobalJoints, closeCurrentProject,
  consolidateAllPagesWithConfirm, copyPageJointsMembersToSamePlanePage,
  ensureRwPermission, loadProjectFull, newProjectPrompt,
  relayoutNumberingAll, relayoutMembersNumberingAll,
  startExtendableMemberCheck, _startSaveWithHook,
} from "../app/integration";
import { exportXlsxFile } from "../export/xlsx";
import { openXlsxSettingsDialog } from "../dialogs/xlsxSettings";
import { openFloorTypesDialog } from "../dialogs/floorTypes";
import { openGlobalJointMgrDialog } from "../dialogs/globalJoints";
import { openMaterialMgrWindow } from "../dialogs/materialMgr";
import { open3DPreviewDialog } from "../dialogs/preview3d";
import { openSearchWindow } from "../dialogs/search";
import { _getRecentProjects, _openRecentProject, _removeRecentProject } from "../persistence/recentProjects";
import { listBackups, restoreBackupIntoNewProject, deleteBackup } from "../persistence/autoBackup";
import { _t, _setLanguage } from "../i18n";
import { showAboutDialog, checkForUpdatesManual, checkForUpdatesAuto } from "./versionCheck";
import { openAutoBackupDialog } from "../persistence/autoBackup";

// ---------- 頂部主選單列 ----------
// 開啟專案 → 子選單裡的「最近開啟」清單(IDB 持久化,點即重開)
async function _refreshRecentProjectMenu() {
  const cont = document.getElementById("recentProjectList");
  if (!cont) return;
  const list = await _getRecentProjects();
  cont.innerHTML = "";
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "menu-entry";
    e.style.cssText = "opacity:0.5;pointer-events:none;font-style:italic";
    e.textContent = (typeof _t === "function" && _t("file.recentEmpty")) || "(尚無最近開啟的專案)";
    cont.appendChild(e);
    // 不 return:即使沒有最近開啟,仍要往下列出「可復原的自動備份」
  }
  // 檔案大小格式化(MB / KB)
  const _fmtSize = (n) => {
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  };
  const _fmtDate = (ts) => {
    if (!Number.isFinite(ts) || ts <= 0) return "";
    try { const d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toLocaleString(); }
    catch (_) { return ""; }
  };
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "menu-entry";
    // 改成兩列:第 1 列檔名 + 上次開啟時間 + ✕;第 2 列檔案大小 + 修改時間(灰色小字,辨識同名不同位置用)
    row.style.cssText = "display:flex;flex-direction:column;gap:2px;padding:6px 14px";
    const topRow = document.createElement("div");
    topRow.style.cssText = "display:flex;align-items:center;gap:6px;justify-content:space-between";
    const main = document.createElement("span");
    main.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    main.textContent = item.name;
    const when = document.createElement("span");
    when.style.cssText = "font-size:10px;color:#9aa0a6;flex-shrink:0";
    when.textContent = _fmtDate(item.lastOpened);
    const del = document.createElement("span");
    del.textContent = "×";
    del.title = "從清單移除";
    del.style.cssText = "padding:0 4px;color:#9aa0a6;cursor:pointer;flex-shrink:0;border-radius:3px";
    del.onmouseenter = () => { del.style.background = "rgba(255,80,80,0.25)"; del.style.color = "#fff"; };
    del.onmouseleave = () => { del.style.background = "transparent"; del.style.color = "#9aa0a6"; };
    del.onclick = async (e) => {
      e.stopPropagation();
      await _removeRecentProject(item.key);
      _refreshRecentProjectMenu();
    };
    topRow.appendChild(main);
    topRow.appendChild(when);
    topRow.appendChild(del);
    // 第 2 列:辨識同名不同檔的指紋 — 大小 · 修改時間
    const meta = document.createElement("div");
    meta.style.cssText = "font-size:10px;color:#7a8088;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const sizeStr = _fmtSize(item.size);
    const mtimeStr = _fmtDate(item.lastModified);
    const metaParts = [];
    if (sizeStr) metaParts.push(sizeStr);
    if (mtimeStr) metaParts.push(`修改 ${mtimeStr}`);
    meta.textContent = metaParts.length ? metaParts.join(" · ") : "(無檔案指紋資訊)";
    // tooltip:把全部資訊塞進去,hover 可看完整
    row.title = `${item.name}${sizeStr ? " · " + sizeStr : ""}${mtimeStr ? " · 修改 " + mtimeStr : ""}${when.textContent ? " · 上次開啟 " + when.textContent : ""}`;
    row.appendChild(topRow);
    row.appendChild(meta);
    row.addEventListener("click", (e) => {
      // 不被父選單的 close-all 截斷:讓父選單先 close 後再開
      e.stopPropagation();
      const items = document.querySelectorAll("#menuBar .menu-item");
      items.forEach(m => m.classList.remove("open"));
      _openRecentProject(item);
    });
    cont.appendChild(row);
  }
  // === 可復原的自動備份(上次未存檔就關閉的編輯)→ 標示「復原」,點擊載成新分頁 ===
  let backups: any[] = [];
  try { backups = await listBackups(); } catch (_) {}
  if (backups.length) {
    const divider = document.createElement("div");
    divider.style.cssText = "border-top:1px solid #333;margin:4px 0";
    cont.appendChild(divider);
    const hdr = document.createElement("div");
    hdr.style.cssText = "padding:4px 14px;font-size:10px;color:#ffd23f;font-weight:700;pointer-events:none";
    hdr.textContent = `可復原的自動備份(${backups.length})`;
    cont.appendChild(hdr);
    for (const b of backups) {
      const row = document.createElement("div");
      row.className = "menu-entry";
      row.style.cssText = "display:flex;flex-direction:column;gap:2px;padding:6px 14px";
      const topRow = document.createElement("div");
      topRow.style.cssText = "display:flex;align-items:center;gap:6px;justify-content:space-between";
      const main = document.createElement("span");
      main.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center";
      const badge = document.createElement("span");
      badge.textContent = "復原";
      badge.style.cssText = "background:#7a5c00;color:#ffd23f;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;margin-right:6px;flex-shrink:0";
      main.appendChild(badge);
      main.appendChild(document.createTextNode(
        b.projectName + (b.jobName && b.jobName !== b.projectName ? ` (${b.jobName})` : "")));
      const when = document.createElement("span");
      when.style.cssText = "font-size:10px;color:#9aa0a6;flex-shrink:0";
      when.textContent = _fmtDate(b.savedAt);
      const del = document.createElement("span");
      del.textContent = "×";
      del.title = "刪除此備份";
      del.style.cssText = "padding:0 4px;color:#9aa0a6;cursor:pointer;flex-shrink:0;border-radius:3px";
      del.onmouseenter = () => { del.style.background = "rgba(255,80,80,0.25)"; del.style.color = "#fff"; };
      del.onmouseleave = () => { del.style.background = "transparent"; del.style.color = "#9aa0a6"; };
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!window.confirm(`刪除自動備份「${b.projectName}」?此操作無法復原。`)) return;
        try { await deleteBackup(b.projectId); } catch (_) {}
        _refreshRecentProjectMenu();
      };
      topRow.appendChild(main);
      topRow.appendChild(when);
      topRow.appendChild(del);
      const meta = document.createElement("div");
      meta.style.cssText = "font-size:10px;color:#7a8088;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const sz = _fmtSize(b.payloadSize);
      const metaParts: string[] = [`${b.nJoints || 0} 節點 / ${b.nMembers || 0} 桿`];
      if (sz) metaParts.push(sz);
      if (b.fileHandleName) metaParts.push(`原檔 ${b.fileHandleName}`);
      meta.textContent = metaParts.join(" · ");
      row.title = `自動備份(尚未存檔的編輯)· ${_fmtDate(b.savedAt)}\n點擊 → 以「[復原]」新分頁載入(原檔不會被覆寫)`;
      row.appendChild(topRow);
      row.appendChild(meta);
      row.addEventListener("click", async (e) => {
        e.stopPropagation();
        document.querySelectorAll("#menuBar .menu-item").forEach(m => m.classList.remove("open"));
        try { await restoreBackupIntoNewProject(b); } catch (err) { console.warn("[復原] 失敗:", err); }
      });
      cont.appendChild(row);
    }
  }
}
(function setupMenuBar() {
  const items = Array.from(document.querySelectorAll("#menuBar .menu-item"));
  const closeAll = () => items.forEach(m => m.classList.remove("open"));
  items.forEach(item => {
    const title = item.querySelector(".menu-title");
    if (!title) return;
    // 整個 .menu-item(含 14px padding 與背景區域)都可觸發;dropdown 內的 click 透過
    //   `e.target.closest(".menu-dropdown")` 過濾掉,避免點 dropdown 內部時誤關選單
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".menu-dropdown")) return;
      e.stopPropagation();
      const wasOpen = item.classList.contains("open");
      closeAll();
      if (!wasOpen) {
        item.classList.add("open");
        // 打開檔案選單時,順便更新「最近開啟」子選單
        if ((item as HTMLElement).dataset.menu === "file") _refreshRecentProjectMenu();
      }
    });
    // 滑過已開啟的選單列時,自動切換到目前的項目(類似傳統選單列)
    item.addEventListener("mouseenter", () => {
      if (items.some(m => m.classList.contains("open"))) {
        closeAll();
        item.classList.add("open");
        if ((item as HTMLElement).dataset.menu === "file") _refreshRecentProjectMenu();
      }
    });
  });
  document.addEventListener("click", closeAll);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAll();
  });
  // 選單項目觸發對應的現有按鈕 / input(保留原有流程)
  const actions = {
    "open-new-project":() => newProjectPrompt(),
    "open-project":    () => openProjectWithPicker(),
    "save-project":    () => _startSaveWithHook(false),
    "save-project-as": () => _startSaveWithHook(true),
    "import-json":     () => $("importJson") && $("importJson").click(),
    "export-json":     () => $("exportJson") && $("exportJson").click(),
    "export-std":      () => $("exportStaad") && $("exportStaad").click(),
    "export-xlsx":     () => exportXlsxFile(),
    "xlsx-settings":   () => openXlsxSettingsDialog(),
    "clear-all":       () => $("clearAll") && $("clearAll").click(),
    "new-project":     () => newProjectPrompt(),
    "close-project":   () => closeCurrentProject(),
    "consolidate-all-pages":   () => consolidateAllPagesWithConfirm({}),
    "extend-check-all":        () => startExtendableMemberCheck(),
    // 新版「適配關聯」走精準度配對;保留舊 entry id 以相容外部呼叫
    "infer-all-both":          () => withBusy("適配關聯(精準度)…", () => _runFitMergeByPrecision({})),
    "infer-all-joints":        () => withBusy("適配關聯(精準度)…", () => _runFitMergeByPrecision({})),
    "infer-all-members":       () => withBusy("適配關聯(精準度)…", () => _runFitMergeByPrecision({})),
    "relayout-all":            () => relayoutNumberingAll({}),
    "relayout-members-all":    () => relayoutMembersNumberingAll({}),
    "recompute-world-all":     () => withBusy("重新計算 3D 座標(全部頁面)…", () => {
      pushUndo();
      if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
      let pages = 0, joints = 0;
      for (const f of state.files) {
        for (const pg of Object.values(f.pages || {}) as any[]) {
          if (!pg || pg._orphan) continue;
          pages++; joints += (pg.joints || []).length;
        }
      }
      if ($("hud")) $("hud").textContent = `已重算 3D 座標 / ${pages} 頁 / ${joints} 個 joint`;
    }),
    "copy-page-to-same-plane": () => copyPageJointsMembersToSamePlanePage(),
    "run-3d-pipeline":         () => _run3DOneClickPipeline(),
    "open-3d-preview":         () => open3DPreviewDialog(),
    "open-material-mgr":       () => openMaterialMgrWindow(),
    "open-floor-types":        () => { if (typeof openFloorTypesDialog === "function") openFloorTypesDialog(); },
    "open-global-joint-mgr":   () => { if (typeof openGlobalJointMgrDialog === "function") openGlobalJointMgrDialog(); },
    "bg-repair":               () => _runBgRepair(),
    "open-search":             () => openSearchWindow(),
    "tb-mode-text":            () => _applyToolbarMode("text"),
    "tb-mode-icon":            () => _applyToolbarMode("icon"),
    "tb-mode-both":            () => _applyToolbarMode("both"),
    "lang-zh":                 () => _setLanguage("zh-TW"),
    "lang-en":                 () => _setLanguage("en"),
    "cleanup-bad-globaljoints":() => withBusy("清除錯誤 globalJoint 綁定…", () => cleanupBadGlobalJoints({ threshold: 100 })),
    "cleanup-all-globaljoints":() => withBusy("清除全部 globalJoint 綁定…", () => cleanupBadGlobalJoints({ clearAll: true })),
    "check-updates":           () => checkForUpdatesManual(),
    "about":                   () => showAboutDialog(),
    "auto-backup":             () => openAutoBackupDialog(),
  };
  // 啟動 idle 時自動檢查 GitHub 上是否有新版(快取 6 小時,不會每次刷新都打 API)
  if ("requestIdleCallback" in window) {
    (window as any).requestIdleCallback(() => { checkForUpdatesAuto(); }, { timeout: 5000 });
  } else {
    setTimeout(() => { checkForUpdatesAuto(); }, 2000);
  }

  // 開啟專案:優先使用 FSA showOpenFilePicker 取得 handle → 後續「儲存專案」可直接覆寫到同一個檔案
  async function openProjectWithPicker() {
    console.log("[開啟專案] showOpenFilePicker available?", !!(window as any).showOpenFilePicker);
    if ((window as any).showOpenFilePicker) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          types: [{
            description: "STAAD Tracer 專案 / JSON",
            accept: { "application/json": [".stproj.json", ".json"] },
          }],
          multiple: false,
        });
        console.log("[開啟專案] got handle:", handle.name, "createWritable=", typeof handle.createWritable);
        // 立刻在使用者手勢還活著時請求 readwrite,避免之後存檔時 createWritable 因為 gesture 失效而靜默失敗
        try {
          const ok = await ensureRwPermission(handle);
          console.log("[開啟專案] readwrite granted?", ok);
        }
        catch (e) { console.warn("[開啟專案] 請求 readwrite 權限時例外:", e); }
        const f = await handle.getFile();
        await withBusy("讀入專案中…", () => loadProjectFull(f, handle));
        console.log("[開啟專案] state.projectFileHandle =", state.projectFileHandle && state.projectFileHandle.name);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;   // 使用者取消
        console.warn("[開啟專案] showOpenFilePicker 失敗,退回 input:", e);
      }
    }
    // 回退:觸發隱藏的 <input type=file>
    console.warn("[開啟專案] 走 fallback <input type=file>(無 handle,儲存會跳另存)");
    if ($("loadProject")) $("loadProject").click();
  }
  document.querySelectorAll("#menuBar .menu-entry").forEach(entry => {
    entry.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAll();
      const fn = (actions as any)[(entry as HTMLElement).dataset.action!];
      if (fn) fn();
    });
  });
  const searchBtn = document.getElementById("menuBarSearchBtn");
  if (searchBtn) {
    searchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAll();
      openSearchWindow();
    });
  }
  const btn3D = document.getElementById("menuBar3DBtn");
  if (btn3D) {
    btn3D.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAll();
      open3DPreviewDialog();
    });
  }
})();

// 把 _refreshRecentProjectMenu 暴露到 window,讓 state/recentProjects 的更新流程能 callback
try { (window as any)._refreshRecentProjectMenu = _refreshRecentProjectMenu; } catch (_) {}
