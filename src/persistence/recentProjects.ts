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
const _CONTENT_STORE  = "recentContent";   // v3:存專案內容(text),讓沒有 handle 的瀏覽器也能一鍵重開
const _RECENT_MAX     = 10;
const _RECENT_DB_VERSION = 3;     // v1→v2:key 從 name 換成複合指紋;v2→v3:新增 recentContent 內容快取

// 用 name + size + lastModified 組合出唯一 key,讓同名不同內容的檔在 recent 清單共存
function _makeRecentKey(name: string, size: number, lastModified: number): string {
  return `${name}|${size || 0}|${lastModified || 0}`;
}

export function _openRecentDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IDB"));
    const req = indexedDB.open(_RECENT_DB_NAME, _RECENT_DB_VERSION);
    req.onupgradeneeded = (e: any) => {
      const db = req.result;
      const oldV = e && e.oldVersion || 0;
      // v1 → v2:recentProjects keyPath 從 name 換成 key → drop + recreate
      if (oldV < 2 && db.objectStoreNames.contains(_RECENT_STORE)) {
        db.deleteObjectStore(_RECENT_STORE);
      }
      if (!db.objectStoreNames.contains(_RECENT_STORE)) {
        db.createObjectStore(_RECENT_STORE, { keyPath: "key" });
      }
      // v3:新增內容快取 store
      if (!db.objectStoreNames.contains(_CONTENT_STORE)) {
        db.createObjectStore(_CONTENT_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// 內容快取:存專案原始 JSON 文字(best-effort;配額不足等失敗時靜默略過 → 之後退回檔案選擇器)
async function _saveRecentContent(key: string, text: string, validKeys: string[]): Promise<void> {
  const db = await _openRecentDB();
  try {
    const tx = db.transaction(_CONTENT_STORE, "readwrite");
    const store = tx.objectStore(_CONTENT_STORE);
    store.put({ key, text, savedAt: Date.now() });
    // 清掉已從最近清單淘汰的 key 的內容(避免無限累積)
    if (Array.isArray(validKeys) && validKeys.length) {
      const allKeys: any[] = await new Promise(r => {
        const rq = store.getAllKeys(); rq.onsuccess = () => r(rq.result || []); rq.onerror = () => r([]);
      });
      const valid = new Set(validKeys);
      for (const k of allKeys) if (!valid.has(k)) { try { store.delete(k); } catch (_) {} }
    }
    await new Promise((res, rej) => { tx.oncomplete = () => res(null); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  } finally { db.close(); }
}

async function _getRecentContent(key: string): Promise<string | null> {
  if (!key) return null;
  try {
    const db = await _openRecentDB();
    const tx = db.transaction(_CONTENT_STORE, "readonly");
    const store = tx.objectStore(_CONTENT_STORE);
    const rec: any = await new Promise(r => {
      const rq = store.get(key); rq.onsuccess = () => r(rq.result || null); rq.onerror = () => r(null);
    });
    db.close();
    return rec && typeof rec.text === "string" ? rec.text : null;
  } catch (_) { return null; }
}
// text:專案原始 JSON 文字(可選)。給了就快取進 IndexedDB,讓沒有 handle 的瀏覽器也能一鍵重開。
export async function _saveRecentProject(name, handle, size, lastModified, text?: string) {
  if (!name) return;
  let key = "";
  let survivingKeys: string[] = [];
  try {
    const _size = Number.isFinite(size) ? size : 0;
    const _mtime = Number.isFinite(lastModified) ? lastModified : 0;
    key = _makeRecentKey(name, _size, _mtime);
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
    survivingKeys = all.slice(0, _RECENT_MAX).map(x => x.key);
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    db.close();
    try { (((window as any)._refreshRecentProjectMenu && (window as any)._refreshRecentProjectMenu())); } catch (_) {}
  } catch (e) {
    console.warn("[recent projects] save failed:", e);
  }
  // 內容快取(獨立於上面的 meta 寫入,失敗不影響 meta;配額不足會在這裡被吞掉 → 之後退回檔案選擇器)
  if (text && key) {
    try { await _saveRecentContent(key, text, survivingKeys.length ? survivingKeys : [key]); }
    catch (e) { console.warn("[recent projects] 內容快取失敗(可能瀏覽器儲存配額不足),此檔之後重開將需重選檔:", e); }
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
    const tx = db.transaction([_RECENT_STORE, _CONTENT_STORE], "readwrite");
    tx.objectStore(_RECENT_STORE).delete(key);
    try { tx.objectStore(_CONTENT_STORE).delete(key); } catch (_) {}   // 連內容快取一起刪
    await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
    db.close();
  } catch (e) {}
}

// 退回「從檔案開啟…」檔案選擇器(所有瀏覽器都支援的後備手段)
function _fallbackToFilePicker(name: string): void {
  const inp = document.getElementById("loadProject") as HTMLInputElement | null;
  if (inp) { try { inp.click(); return; } catch (_) {} }
  alert(`請改用「從檔案開啟…」開啟「${name}」。`);
}

// 從內容快取載入(沒有 handle 的瀏覽器走這條;handle=null → 存檔仍走另存)
async function _openFromContentCache(key: string, name: string): Promise<boolean> {
  const text = await _getRecentContent(key);
  if (text == null) return false;
  try {
    const file = new File([text], name || "project.stproj.json",
      { type: "application/json", lastModified: Date.now() });
    await withBusy(`讀入「${name}」(瀏覽器快取)…`, () => loadProjectFull(file, null));
    return true;
  } catch (e) {
    console.warn("[recent projects] 從快取載入失敗:", e);
    return false;
  }
}

export async function _openRecentProject(entry) {
  const { key, name, handle } = entry || {};
  // 1) 有 handle(Chrome / 支援 File System Access API)→ 直接從磁碟檔重開
  if (handle) {
    try {
      if (typeof handle.requestPermission === "function") {
        const cur = await handle.queryPermission({ mode: "readwrite" });
        if (cur !== "granted") {
          const got = await handle.requestPermission({ mode: "readwrite" });
          if (got !== "granted") throw new Error("permission denied");
        }
      }
      const f = await handle.getFile();
      await withBusy(`讀入「${name}」…`, () => loadProjectFull(f, handle));
      return;
    } catch (e) {
      console.warn("[recent projects] handle 開啟失敗,改試內容快取:", e);
      // 落到下面:試 IndexedDB 內容快取 → 再退回檔案選擇器
    }
  }
  // 2) 無 handle(Safari / Brave 等)或 handle 失敗 → 試 IndexedDB 內容快取(一鍵重開)
  if (await _openFromContentCache(key, name)) return;
  // 3) 都沒有 → 退回檔案選擇器(舊項目、或快取被清 / 配額不足)
  _fallbackToFilePicker(name);
}
