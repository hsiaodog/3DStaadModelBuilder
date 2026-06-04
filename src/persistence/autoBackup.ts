// 自動備份 — 把使用者編輯中的專案以「次最新快照」形式存進 IndexedDB,不碰任何磁碟檔案。
//
// 設計重點:
//   • 永遠不寫 .stproj.json — 即使原本是從檔案開啟也不覆寫。備份只在 IDB,不會誤蓋使用者的存檔。
//   • 一個 project 最多一筆備份(keyed by projectId)— 取最新,不留歷史,簡單可預期。
//   • 觸發:任何 pushUndo(編輯動作)→ debounce 30s → 寫一筆。beforeunload 時 best-effort flush。
//   • 清除:_startSaveWithHook 成功後刪掉該 project 的備份(因為磁碟檔已是最新)。
//   • 復原:啟動時掃 IDB,任何殘留的 backup 都代表「上次沒乾淨關掉的編輯」→ 跳對話框讓使用者決定。
//
// 對外:
//   • scheduleBackupSoon()     — pushUndo 後呼叫,debounce 寫入
//   • flushBackupNow()         — beforeunload / 手動觸發
//   • clearBackupForActive()   — 儲存後呼叫,刪當前專案的 backup
//   • listBackups() / deleteBackup() / getBackup()
//   • checkRecoveryOnStartup() — app init 完才呼叫(會跳對話框)
//   • restoreBackupIntoNewProject(record) — 把備份匯入成新專案分頁
// @ts-nocheck

import { state } from "../app/state";
import {
  projects, activeProjectId,
  loadProjectDataFromP, refreshProjectTabs, refreshProjectMenu, activateProject,
  _startSaveWithHook,
} from "../app/integration";
import { nextJointId, nextMemberId, nextFileId, nextGlobalJointId, nextGlobalMemberId } from "../app/state";
import { projectDirty } from "./projectTabs";
import { migrateAllSupports } from "../core/support";

const DB_NAME = "staadTracerAutoBackup";
const STORE   = "backups";
const DB_VERSION = 1;

const PERIODIC_BACKUP_MS  = 60_000;          // 每分鐘檢查一次,有 dirty 就備份
const SAVE_REMINDER_MS    = 30 * 60_000;     // 每 30 分鐘提醒一次儲存
const MAX_AGE_MS          = 14 * 24 * 60 * 60 * 1000;   // 14 天前的備份視為過期,啟動時清掉

// ---------- IDB low-level ----------

function _openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IDB"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "projectId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function _put(record: any) {
  const db = await _openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
  db.close();
}
async function _get(projectId: number): Promise<any | null> {
  const db = await _openDB();
  const r = await new Promise<any>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(projectId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
  db.close();
  return r;
}
async function _delete(projectId: number) {
  const db = await _openDB();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(projectId);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => resolve();
  });
  db.close();
}
async function _getAll(): Promise<any[]> {
  const db = await _openDB();
  const all = await new Promise<any[]>((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => resolve([]);
  });
  db.close();
  return all;
}

// ---------- 快照序列化 ----------

// 把 file 物件中不能 JSON.stringify 的欄位剝掉(PDF proxy / Image / Set),保留可序列化的。
function _cloneFileForBackup(f: any): any {
  if (!f) return f;
  const out: any = {};
  for (const k of Object.keys(f)) {
    const v = (f as any)[k];
    if (k === "pdf" || k === "image" || k === "_view") continue;   // PDF / Image / 暫態
    if (v instanceof Set) { out[k] = [...v]; continue; }
    if (v instanceof Map) { out[k] = [...v.entries()]; continue; }
    out[k] = v;
  }
  return out;
}

// 從目前 in-memory state 建一份序列化過的 project payload。
// 不做任何 PDF / 底圖預渲染 — 只抓記憶體裡已有的 cachedBgSvg / cachedBgImg。
function _buildPayloadFromActiveState(): any {
  const filesData = (state as any).files.map((f: any) => _cloneFileForBackup(f));
  return {
    schema: "staad-tracer-autobackup/1",
    savedAt: new Date().toISOString(),
    state: {
      scale: (state as any).scale,
      unitName: (state as any).unitName,
      globalCapacity: (state as any).globalCapacity,
      coordDecimals: (state as any).coordDecimals,
      measureDecimals: (state as any).measureDecimals,
      globalOriginId: (state as any).globalOriginId,
      globalOriginFileId: (state as any).globalOriginFileId,
      relayoutDirection: (state as any).relayoutDirection,
      relayoutCapacity: (state as any).relayoutCapacity,
      memberCapY: (state as any).memberCapY, memberCapX: (state as any).memberCapX,
      memberCapZ: (state as any).memberCapZ, memberCapDiag: (state as any).memberCapDiag,
      fileListShow: (state as any).fileListShow ? { ...(state as any).fileListShow } : undefined,
      zoom: (state as any).zoom, panX: (state as any).panX, panY: (state as any).panY,
      activeFileId: (state as any).activeFileId,
      pageIdx: (state as any).pageIdx,
      openTabs: Array.isArray((state as any).openTabs)
        ? (state as any).openTabs.map((t: any) => ({ fileId: t.fileId, pageIdx: t.pageIdx || 0 }))
        : [],
    },
    counters: { nextJointId, nextMemberId, nextFileId, nextGlobalJointId, nextGlobalMemberId },
    globalJoints: (state as any).globalJoints || [],
    globalMembers: (state as any).globalMembers || [],
    materials: Array.isArray((state as any).materials) ? (state as any).materials : [],
    floorTypes: Array.isArray((state as any).floorTypes) ? (state as any).floorTypes : [],
    files: filesData,
  };
}

// ---------- 公開 API ----------

// 標記:離上次成功 / 提醒到現在「有沒有 dirty 過」— 用來決定 30 分鐘提醒要不要跳。
//   清 dirty 不只看當前瞬間 projectDirty(可能剛好按完 Save)— 也要尊重「30 分鐘內曾經有編輯」。
let _dirtySinceLastReminderAck = false;
let _periodicBackupTimer: any = null;
let _saveReminderTimer: any = null;

// 每分鐘:若當前 project dirty,就 flush 一次到 IDB(取代舊版「pushUndo 後 30s debounce」)。
//   未 dirty 不寫,避免無意義 IO 與 IDB 寫入磁碟壓力。
function _startPeriodicBackup() {
  if (_periodicBackupTimer) return;
  _periodicBackupTimer = setInterval(() => {
    if (!projectDirty) return;
    flushBackupNow().catch((e) => console.warn("[autoBackup] periodic flush failed:", e));
  }, PERIODIC_BACKUP_MS);
}

// 每 30 分鐘:dirty 就跳 banner 提醒儲存。timer 永遠跑,內部用 _dirtySinceLastReminderAck
// 判斷要不要顯示。clean save 後重置 — 給使用者「離上次儲存夠久」的感覺,不是「離 app 啟動 30 分」。
function _startSaveReminder() {
  if (_saveReminderTimer) return;
  _saveReminderTimer = setInterval(() => {
    if (!projectDirty || !_dirtySinceLastReminderAck) return;
    _showSaveReminderBanner();
  }, SAVE_REMINDER_MS);
}

// 把這個函式從 init.ts 的 pushUndo hook 呼叫;標記 dirty。
//   原本的 30s debounce 移除 — 改為 1 分鐘 polling。
//   不過為了「使用者剛改完馬上備份」這個語感,還是允許「第一次 dirty」立刻 schedule 一個 5s 後的 flush。
let _firstDirtyFlushed = true;
export function scheduleBackupSoon() {
  _dirtySinceLastReminderAck = true;
  // 啟動 timers(idempotent)
  _startPeriodicBackup();
  _startSaveReminder();
  // 第一次 dirty:5 秒內補一次 flush,讓使用者覺得「我才剛改,就已經有備份」
  if (_firstDirtyFlushed) {
    _firstDirtyFlushed = false;
    setTimeout(() => { flushBackupNow().catch(() => {}); }, 5000);
  }
}

export async function flushBackupNow() {
  const cur = projects.find((p: any) => p.id === activeProjectId);
  if (!cur) return;
  // 空專案就別存 — 沒檔案 / 沒節點 / 沒桿件
  const totalJoints  = (state as any).files.reduce((s: number, f: any) => s + Object.values(f.pages || {}).reduce((ss: number, p: any) => ss + (p.joints?.length || 0), 0), 0);
  const totalMembers = (state as any).files.reduce((s: number, f: any) => s + Object.values(f.pages || {}).reduce((ss: number, p: any) => ss + (p.members?.length || 0), 0), 0);
  if (!(state as any).files.length && totalJoints === 0 && totalMembers === 0) return;
  let payload: string;
  try {
    payload = JSON.stringify(_buildPayloadFromActiveState());
  } catch (e) {
    console.warn("[autoBackup] serialize failed:", e);
    return;
  }
  const record = {
    projectId: cur.id,
    projectName: cur.name || "未命名",
    jobName: cur.jobName || "",
    fileHandleName: cur.projectFileHandle?.name || null,
    savedAt: Date.now(),
    nJoints: totalJoints,
    nMembers: totalMembers,
    nFiles: (state as any).files.length,
    payloadSize: payload.length,
    payload,
  };
  try {
    await _put(record);
    console.log(`[autoBackup] saved project ${cur.id}「${record.projectName}」(${(payload.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.warn("[autoBackup] put failed:", e);
  }
}

export async function clearBackupForActive() {
  if (activeProjectId == null) return;
  try { await _delete(activeProjectId); } catch (_) {}
  // 乾淨儲存後重置:dirty-since-reminder 旗標清掉、首次 dirty 也重新計時、隱藏 banner
  _dirtySinceLastReminderAck = false;
  _firstDirtyFlushed = true;
  _hideSaveReminderBanner();
}

// ---------- 30 分鐘儲存提醒 banner ----------

function _ensureSaveBanner(): HTMLDivElement {
  let bar = document.getElementById("saveReminderBanner") as HTMLDivElement;
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "saveReminderBanner";
  Object.assign(bar.style, {
    position: "fixed", top: "0", left: "0", right: "0",
    background: "linear-gradient(90deg, #b45309, #d97706)", color: "#fff",
    padding: "8px 16px", fontSize: "12px", fontFamily: "inherit",
    display: "none", alignItems: "center", gap: "12px", zIndex: "10001",
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
  });
  // 若版本 banner 也顯示,往下挪
  const vb = document.getElementById("versionBanner");
  if (vb && vb.style.display !== "none") bar.style.top = "36px";
  document.body.appendChild(bar);
  return bar;
}
function _hideSaveReminderBanner() {
  const bar = document.getElementById("saveReminderBanner");
  if (bar) bar.style.display = "none";
}
function _showSaveReminderBanner() {
  const bar = _ensureSaveBanner();
  bar.innerHTML = `
    <span style="font-weight:700">💾 該儲存了</span>
    <span>已經有 30 分鐘沒儲存,自動備份目前在瀏覽器 IndexedDB(不會寫到磁碟)— 建議按「儲存」確保資料安全。</span>
    <span style="flex:1"></span>
    <button id="srSaveBtn" style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.5);color:#fff;padding:4px 14px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700">儲存專案</button>
    <button id="srSnoozeBtn" style="background:transparent;border:1px solid rgba(255,255,255,0.4);color:#fff;padding:4px 10px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:11px" title="先關掉提醒,30 分鐘後再次提醒">稍後</button>
    <button id="srCloseBtn" title="關閉" style="background:transparent;border:none;color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">×</button>
  `;
  bar.style.display = "flex";
  document.getElementById("srSaveBtn")?.addEventListener("click", () => {
    _hideSaveReminderBanner();
    // 走 _startSaveWithHook(false)— 若已有 file handle 直接覆寫,沒有就跳另存
    (_startSaveWithHook as any)(false).catch((e: any) => console.warn("[autoBackup] save failed:", e));
  });
  document.getElementById("srSnoozeBtn")?.addEventListener("click", () => {
    _hideSaveReminderBanner();
    _dirtySinceLastReminderAck = false;   // 重置 → 30 分鐘後再提醒
  });
  document.getElementById("srCloseBtn")?.addEventListener("click", () => {
    _hideSaveReminderBanner();
    _dirtySinceLastReminderAck = false;
  });
}

export async function listBackups(): Promise<any[]> {
  const all = await _getAll();
  // 14 天前的清掉
  const now = Date.now();
  const fresh: any[] = [];
  for (const b of all) {
    if (now - (b.savedAt || 0) > MAX_AGE_MS) {
      _delete(b.projectId).catch(() => {});
      continue;
    }
    fresh.push(b);
  }
  fresh.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return fresh;
}

export async function deleteBackup(projectId: number) {
  await _delete(projectId);
}

export async function getBackup(projectId: number) {
  return _get(projectId);
}

// ---------- 復原(把備份載成新分頁,不蓋既有的 in-memory 專案)----------

export async function restoreBackupIntoNewProject(record: any) {
  if (!record || !record.payload) return;
  let payload: any;
  try { payload = JSON.parse(record.payload); }
  catch (e) { alert("備份內容已毀損,無法解析"); return; }
  // 支承資料 migration:舊備份的 isAnchor + supportType → 新的 support 物件
  migrateAllSupports(payload.files || []);
  // ★ 還原序列化時被攤平成陣列的 Set 欄位(_cloneFileForBackup 把 Set → array)。
  //   否則 render / renderCachedBg 對 selectedBgPaths.has(...) 會丟「c.has is not a function」。
  //   與 projectLoad 載入路徑保持一致。
  const _restoredFiles = (payload.files || []).map((f: any) => ({
    ...f,
    selectedBgPaths: new Set(Array.isArray(f.selectedBgPaths) ? f.selectedBgPaths : []),
    deletedBgPaths:  new Set(Array.isArray(f.deletedBgPaths)  ? f.deletedBgPaths  : []),
  }));
  // 建一個新 project entry,套用 payload
  // 重用 loadProjectDataFromP 的形狀:它讀的 p 物件需要 files/globalJoints/... 跟 next* 計數器
  // 但 loadProjectDataFromP 是套到當前 state,不是建分頁 → 我們得手動把 payload 包成 project entry
  const newId = Math.max(0, ...projects.map((p: any) => p.id)) + 1;
  const newProj: any = {
    id: newId,
    name: `[復原] ${record.projectName || "未命名"}`,
    files: _restoredFiles,
    globalJoints: payload.globalJoints || [],
    globalMembers: payload.globalMembers || [],
    undoStack: [], redoStack: [],
    scale: payload.state?.scale ?? null,
    unitName: payload.state?.unitName || "mm",
    globalCapacity: payload.state?.globalCapacity || 10000,
    activeFileId: payload.state?.activeFileId ?? null,
    pageIdx: payload.state?.pageIdx || 0,
    openTabs: payload.state?.openTabs || [],
    zoom: payload.state?.zoom || 1,
    panX: payload.state?.panX || 0,
    panY: payload.state?.panY || 0,
    nextJointId:        payload.counters?.nextJointId || 1,
    nextMemberId:       payload.counters?.nextMemberId || 1,
    nextFileId:         payload.counters?.nextFileId || 1,
    nextGlobalJointId:  payload.counters?.nextGlobalJointId || 1,
    nextGlobalMemberId: payload.counters?.nextGlobalMemberId || 1,
    materials: payload.materials || [],
    floorTypes: payload.floorTypes || [],
    projectFileHandle: null,                  // 復原後不接 handle,避免使用者誤蓋原檔
    jobName: record.jobName || "",
    dirty: true,                              // 復原進來的視為 dirty
  };
  projects.push(newProj);
  // 切過去
  await activateProject(newProj.id);
  refreshProjectTabs();
  refreshProjectMenu();
}

// ---------- 啟動復原檢查 ----------

export async function checkRecoveryOnStartup() {
  let backups: any[] = [];
  try { backups = await listBackups(); } catch (_) { return; }
  if (!backups.length) return;
  // 用最簡單的 confirm 流程:列清單 + 一鍵全部復原 / 全部刪除 / 略過
  const lines = backups.map((b, i) => {
    const ts = new Date(b.savedAt || 0).toLocaleString();
    const sz = ((b.payloadSize || 0) / 1024).toFixed(0);
    return `${i + 1}. ${b.projectName}${b.jobName && b.jobName !== b.projectName ? ` (${b.jobName})` : ""}\n   ` +
           `${ts}・${b.nJoints || 0} 節點・${b.nMembers || 0} 桿件・${sz} KB` +
           (b.fileHandleName ? `\n   原檔:${b.fileHandleName}(不會被覆寫)` : "");
  }).join("\n\n");
  const ok = window.confirm(
    `偵測到 ${backups.length} 份自動備份(上次未儲存就關閉的編輯內容):\n\n` +
    lines + `\n\n` +
    `備份只存在瀏覽器的 IndexedDB,沒有寫到任何磁碟檔案。\n\n` +
    `按「確定」→ 把所有備份載成新的專案分頁(以「[復原]」前綴標示),原檔不會被覆寫。\n` +
    `按「取消」→ 略過,備份保留(下次啟動還會問)。\n\n` +
    `若要丟掉備份,請從「說明 → 自動備份…」管理。`
  );
  if (!ok) return;
  for (const b of backups) {
    try { await restoreBackupIntoNewProject(b); } catch (e) { console.warn("[autoBackup] restore failed:", e); }
  }
}

// ---------- 對話框(說明 → 自動備份…)----------

export async function openAutoBackupDialog() {
  const backups = await listBackups();
  if (!backups.length) {
    window.alert("目前沒有任何自動備份。\n\n備份會在你編輯後 30 秒自動寫入瀏覽器,儲存專案時自動清掉。");
    return;
  }
  const lines = backups.map((b, i) => {
    const ts = new Date(b.savedAt || 0).toLocaleString();
    const sz = ((b.payloadSize || 0) / 1024).toFixed(0);
    return `${i + 1}. ${b.projectName} — ${ts} (${b.nJoints || 0}j/${b.nMembers || 0}m, ${sz} KB)`;
  }).join("\n");
  const ans = window.prompt(
    `自動備份清單(${backups.length} 份):\n\n${lines}\n\n` +
    `輸入要動作的編號(例:1):\n` +
    `• 復原該份 → 輸入「r1」(r + 編號)\n` +
    `• 刪除該份 → 輸入「d1」(d + 編號)\n` +
    `• 全部刪除 → 輸入「da」\n` +
    `• 取消 → 直接關閉`,
    ""
  );
  if (!ans) return;
  const cmd = ans.trim().toLowerCase();
  if (cmd === "da") {
    if (window.confirm(`確定刪除全部 ${backups.length} 份備份?`)) {
      for (const b of backups) await deleteBackup(b.projectId);
      window.alert("已刪除全部備份");
    }
    return;
  }
  const m = cmd.match(/^([rd])\s*(\d+)$/);
  if (!m) { window.alert("指令不正確"); return; }
  const idx = parseInt(m[2], 10) - 1;
  if (idx < 0 || idx >= backups.length) { window.alert("編號超出範圍"); return; }
  const target = backups[idx];
  if (m[1] === "r") {
    await restoreBackupIntoNewProject(target);
  } else {
    if (window.confirm(`刪除備份「${target.projectName}」?`)) {
      await deleteBackup(target.projectId);
      window.alert("已刪除");
    }
  }
}
