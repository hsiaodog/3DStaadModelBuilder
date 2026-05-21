// Phase 8h — 最近開啟過的專案(IndexedDB)
//   File 選單 → 開啟專案 → 子選單裡的「最近開啟」清單。儲存 [{ name, handle, lastOpened }];
//   handle 是 FileSystemFileHandle,可在使用者手勢下 requestPermission 重新取得讀寫權限。
//   localStorage 不能序列化 handle 才必須走 IDB。
// @ts-nocheck

import { withBusy, loadProjectFull } from "../legacy";


// ── 最近開啟過的專案(File 選單 → 開啟專案 → 子選單列出)──
//   IDB 存:[{ name, handle, lastOpened }]。handle 是 FileSystemFileHandle,
//   可在使用者新手勢時 requestPermission 重新取得讀寫;localStorage 無法序列化 handle 才放 IDB。
const _RECENT_DB_NAME = "staadTracerRecent";
const _RECENT_STORE   = "recentProjects";
const _RECENT_MAX     = 10;
export function _openRecentDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IDB"));
    const req = indexedDB.open(_RECENT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(_RECENT_STORE)) {
        db.createObjectStore(_RECENT_STORE, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
export async function _saveRecentProject(name, handle) {
  if (!name) return;
  try {
    const db = await _openRecentDB();
    const tx = db.transaction(_RECENT_STORE, "readwrite");
    const store = tx.objectStore(_RECENT_STORE);
    store.put({ name, handle: handle || null, lastOpened: Date.now() });
    const all = await new Promise(r => {
      const req = store.getAll();
      req.onsuccess = () => r(req.result || []);
      req.onerror   = () => r([]);
    });
    all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
    for (let i = _RECENT_MAX; i < all.length; i++) {
      try { store.delete(all[i].name); } catch (_) {}
    }
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    db.close();
    try { (((window as any)._refreshRecentProjectMenu && (window as any)._refreshRecentProjectMenu())); } catch (_) {}
  } catch (e) {
    console.warn("[recent projects] save failed:", e);
  }
}
export async function _getRecentProjects() {
  try {
    const db = await _openRecentDB();
    const tx = db.transaction(_RECENT_STORE, "readonly");
    const store = tx.objectStore(_RECENT_STORE);
    const all = await new Promise(r => {
      const req = store.getAll();
      req.onsuccess = () => r(req.result || []);
      req.onerror   = () => r([]);
    });
    db.close();
    return all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  } catch (e) {
    return [];
  }
}
export async function _removeRecentProject(name) {
  try {
    const db = await _openRecentDB();
    const tx = db.transaction(_RECENT_STORE, "readwrite");
    tx.objectStore(_RECENT_STORE).delete(name);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    db.close();
  } catch (e) {}
}
export async function _openRecentProject(entry) {
  const { name, handle } = entry || {};
  if (!handle) {
    alert(`無法直接開啟「${name}」(沒有保存檔案 handle);請改用「從檔案開啟…」。`);
    return;
  }
  try {
    // 嘗試重新取得讀寫權限(必須在 user gesture 下進行)
    if (typeof handle.requestPermission === "function") {
      const cur = await handle.queryPermission({ mode: "readwrite" });
      if (cur !== "granted") {
        const got = await handle.requestPermission({ mode: "readwrite" });
        if (got !== "granted") { alert(`沒有讀寫權限,無法開啟「${name}」`); return; }
      }
    }
    const f = await handle.getFile();
    await withBusy(`讀入「${name}」…`, () => loadProjectFull(f, handle));
  } catch (e) {
    console.warn("[recent projects] open failed:", e);
    alert(`開啟「${name}」失敗:${(e && e.message) || e}\n\n可能原因:檔案已被移動 / 刪除 / 重命名,或瀏覽器拒絕授權。\n請改用「從檔案開啟…」。`);
    // 失敗的就從 recent 清掉
    try { await _removeRecentProject(name); (((window as any)._refreshRecentProjectMenu && (window as any)._refreshRecentProjectMenu())); } catch (_) {}
  }
}
