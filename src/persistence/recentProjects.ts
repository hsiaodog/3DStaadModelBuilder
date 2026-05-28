// Phase 8h — 最近開啟過的專案(IndexedDB)
//   File 選單 → 開啟專案 → 子選單裡的「最近開啟」清單。
//   schema v2:每筆 entry = { key, name, handle, size, lastModified, lastOpened }
//     key 由 name + size + lastModified 組成 → 同名但內容/修改時間不同的檔可並存
//     瀏覽器(File System Access API)不允許讀絕對路徑,只能靠 size + mtime 當指紋分辨
//   handle 是 FileSystemFileHandle,可在使用者手勢下 requestPermission 重新取得讀寫權限。

import { withBusy, loadProjectFull } from "../app/integration";


// ── 最近開啟過的專案(File 選單 → 開啟專案 → 子選單列出)──
const _RECENT_DB_NAME = "staadTracerRecent";
const _RECENT_STORE   = "recentProjects";
const _RECENT_MAX     = 10;
const _RECENT_DB_VERSION = 2;     // v1 → v2:keyPath 從 "name" 換成 "key"(複合指紋)

// 用 name + size + lastModified 組合出唯一 key,讓同名不同內容的檔在 recent 清單共存
function _makeRecentKey(name: string, size: number, lastModified: number): string {
  return `${name}|${size || 0}|${lastModified || 0}`;
}

export function _openRecentDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IDB"));
    const req = indexedDB.open(_RECENT_DB_NAME, _RECENT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 → v2 遷移:keyPath 不能改,只能 drop + recreate(recent 清單頂多重新累積一次)
      if (db.objectStoreNames.contains(_RECENT_STORE)) {
        db.deleteObjectStore(_RECENT_STORE);
      }
      db.createObjectStore(_RECENT_STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
export async function _saveRecentProject(name, handle, size, lastModified) {
  if (!name) return;
  try {
    const _size = Number.isFinite(size) ? size : 0;
    const _mtime = Number.isFinite(lastModified) ? lastModified : 0;
    const key = _makeRecentKey(name, _size, _mtime);
    const db = await _openRecentDB();
    const tx = db.transaction(_RECENT_STORE, "readwrite");
    const store = tx.objectStore(_RECENT_STORE);
    store.put({ key, name, handle: handle || null, size: _size, lastModified: _mtime, lastOpened: Date.now() });
    const all: any[] = await new Promise<any[]>(r => {
      const req = store.getAll();
      req.onsuccess = () => r(req.result || []);
      req.onerror   = () => r([]);
    });
    all.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
    for (let i = _RECENT_MAX; i < all.length; i++) {
      try { store.delete(all[i].key); } catch (_) {}
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
    const all: any[] = await new Promise<any[]>(r => {
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
export async function _removeRecentProject(key) {
  if (!key) return;
  try {
    const db = await _openRecentDB();
    const tx = db.transaction(_RECENT_STORE, "readwrite");
    tx.objectStore(_RECENT_STORE).delete(key);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    db.close();
  } catch (e) {}
}
export async function _openRecentProject(entry) {
  const { key, name, handle } = entry || {};
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
    try { await _removeRecentProject(key || _makeRecentKey(name, entry?.size, entry?.lastModified)); (((window as any)._refreshRecentProjectMenu && (window as any)._refreshRecentProjectMenu())); } catch (_) {}
  }
}
