// Phase 8i — 專案儲存 / 讀取(含 PDF / 圖片底圖)
//   FileSystem Access API 優先(showSaveFilePicker → 取得 handle 後續可直接覆寫)。
//   退回機制:不支援 FSA 的瀏覽器走 <a download>(每次都是另存)。
//   完整專案 schema 含 state.files 的 pdfData / cachedBgImg / cachedBgSvg 等底圖快取
//   → base64 序列化,大專案可能跑十幾秒。
//
//   依賴:
//     • state / $ — legacy.ts
//     • withBusy / activatePage / setProjectDirty — legacy(8e 已 export)
//     • busyTick / setBusyMessage / showBusy / hideBusy — ui/busy
//     • _saveRecentProject — state/recentProjects(8h)
//
//   保留 fmtMB / base64ToArrayBuffer 一起搬:legacy 其他位置(addFile / loadProjectFull)
//   也會用,改用 re-export 維持 import 兼容。

import {
  state, $, withBusy, activatePage, setProjectDirty,
  nextJointId, nextMemberId, nextFileId, nextGlobalJointId, nextGlobalMemberId,
} from "../legacy";
import { busyTick, setBusyMessage, showBusy, hideBusy } from "../ui/busy";
import { _saveRecentProject } from "./recentProjects";

// 通用下載 helper(blob → <a download> click → revoke URL)
function download(name, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
export function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
export function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

// 入口:必須由直接 click / keydown handler 呼叫(user gesture 才在)
//   重點:把需要 user gesture 的步驟 (showSaveFilePicker / requestPermission) 都放在 await busyTick() 之前
//   等 handle + readwrite 權限到位後,才開始 buildProjectBlob 的重活
export async function startSave(forceAs) {
  let handle = forceAs ? null : state.projectFileHandle;
  const projectName = ($("jobName") && ($("jobName") as HTMLInputElement).value.trim()) || "project";

  // step 1:在 user gesture 還活著時取得可寫的 handle
  if (!handle && (window as any).showSaveFilePicker) {
    try {
      handle = await (window as any).showSaveFilePicker({
        suggestedName: `${projectName}.stproj.json`,
        types: [{
          description: "STAAD Tracer 專案",
          accept: { "application/json": [".stproj.json", ".json"] },
        }],
      });
      console.log("[Save] picker → handle:", handle && handle.name);
    } catch (e) {
      if (e && e.name === "AbortError") return;     // 使用者取消
      console.warn("[Save] showSaveFilePicker 失敗,將退回下載:", e);
      handle = null;
    }
  }
  // step 2:確認 readwrite 權限(prompt 也只能在這時請求,user gesture 仍在)
  if (handle) {
    const ok = await ensureRwPermission(handle);
    if (!ok) {
      console.warn("[Save] 未取得 readwrite 權限,退回下載");
      handle = null;
    } else {
      state.projectFileHandle = handle;             // 記住,下次儲存就不再跳 picker
    }
  }

  // step 3:現在才 withBusy + buildProjectBlob + 寫檔(已不需要 user gesture)
  withBusy(forceAs ? "另存新檔中…" : "儲存專案中…(底圖編碼可能需要幾秒)", async () => {
    const { text, totalCacheBytes } = await buildProjectBlob();
    if (handle) {
      try {
        setBusyMessage(`覆寫 ${handle.name || projectName + ".stproj.json"}…`);
        await busyTick();
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        console.log(`[Save] 已直接覆寫 ${handle.name}・JSON ${fmtMB(text.length)}`);
        return;
      } catch (e) {
        console.error("[Save] createWritable 寫入失敗,退回下載:", e);
      }
    }
    // 沒 handle(showSaveFilePicker 不可用 / 使用者取消權限 / 寫入失敗)→ 一般下載
    setBusyMessage(`產生下載檔(${fmtMB(text.length)})…`);
    await busyTick();
    download(`${projectName}.stproj.json`, text);
  });
}

// 舊 API 仍保留 thin wrapper(避免外部呼叫處遺漏)— 但不再做 picker / permission,只把工作丟到 startSave
export async function saveProjectFull() { return startSave(false); }
export async function saveProjectAs()   { return startSave(true);  }

// 產生可序列化的專案 JSON(共享給「儲存專案」與「另存新檔」)
async function buildProjectBlob() {
  showBusy("準備儲存…(尚未渲染的頁面會自動渲染一次)");
  await busyTick();

  // 確保每個 PDF/圖片檔都有快取底圖。沒快取的就快速 activate 一次以觸發渲染。
  // - 拆分頁(有 clipRect)可共用來源檔的快取
  // - 多頁 PDF 的不同頁則需要各自的快取(內容不同)
  const origActive = state.activeFileId;
  const origPageIdx = state.pageIdx;
  for (let i = 0; i < state.files.length; i++) {
    const f = state.files[i];
    const hasOwnCache = f.cachedBgSvg || f.cachedBgImg;
    const canShareSrc = f.sourceFileId && f.clipRect &&
      state.files.some(x => x.id === f.sourceFileId && (x.cachedBgSvg || x.cachedBgImg));
    if (hasOwnCache || canShareSrc) continue;
    if (f.pdf || f.image) {
      setBusyMessage(`預先渲染 ${i + 1}/${state.files.length}:${f.name}…`);
      await busyTick();
      try { await activatePage(f.id, 0); } catch (e) { console.warn("預渲染失敗:", f.name, e); }
    }
  }
  if (origActive != null) await activatePage(origActive, origPageIdx);

  const total = state.files.length;
  const filesData = [];
  let totalCacheBytes = 0;

  for (let i = 0; i < total; i++) {
    const f = state.files[i];
    setBusyMessage(`封裝 ${i + 1}/${total}:${f.name}…`);
    await busyTick();
    const meta: any = {
      id: f.id,
      name: f.name,
      sourceName: f.sourceName || null,
      type: f.type,
      pageCount: f.pageCount || 1,
      pdfPage: f.pdfPage,
      rotation: f.rotation || 0,
      offsetX: f.offsetX || 0,
      offsetY: f.offsetY || 0,
      clipRect: f.clipRect || null,
      scaleRuler: f.scaleRuler || null,
      planeOrigin: f.planeOrigin || null,
      sectionLinks: f.sectionLinks ? JSON.parse(JSON.stringify(f.sectionLinks)) : null,
      userBgLines: Array.isArray(f.userBgLines) ? JSON.parse(JSON.stringify(f.userBgLines)) : [],
      measurements: Array.isArray(f.measurements) ? JSON.parse(JSON.stringify(f.measurements)) : [],
      _nextMeasureId: f._nextMeasureId || 1,
      bgWidth: f.bgWidth,
      bgHeight: f.bgHeight,
      pages: f.pages || {},
      selectedBgPaths: f.selectedBgPaths ? [...f.selectedBgPaths] : null,
      deletedBgPaths:  f.deletedBgPaths  ? [...f.deletedBgPaths]  : null,
      detectedStrokeWidth: f.detectedStrokeWidth,
      sourceFileId: f.sourceFileId || null,
      imageWidth:  f.imageWidth,
      imageHeight: f.imageHeight,
      cachedBgWidth:  f.cachedBgWidth,
      cachedBgHeight: f.cachedBgHeight,
    };
    if (f.cachedBgSvg) {
      meta.cachedBgSvg = f.cachedBgSvg;
      totalCacheBytes += f.cachedBgSvg.length;
    } else if (f.cachedBgImg) {
      meta.cachedBgImg = f.cachedBgImg;
      totalCacheBytes += f.cachedBgImg.length;
    }
    filesData.push(meta);
  }

  setBusyMessage(`封裝專案 JSON…(底圖快取 ${fmtMB(totalCacheBytes)})`);
  await busyTick();

  const data = {
    schema: "staad-tracer-project/2",
    savedAt: new Date().toISOString(),
    state: {
      scale: state.scale,
      unitName: state.unitName,
      globalCapacity: state.globalCapacity,
      coordDecimals: state.coordDecimals,
      measureDecimals: state.measureDecimals,
      globalOriginId: state.globalOriginId,
      globalOriginFileId: state.globalOriginFileId,
      relayoutDirection: state.relayoutDirection,
      relayoutCapacity: state.relayoutCapacity,
      memberCapY: state.memberCapY, memberCapX: state.memberCapX,
      memberCapZ: state.memberCapZ, memberCapDiag: state.memberCapDiag,
      fileListShow: state.fileListShow ? { ...state.fileListShow } : undefined,
      zoom: state.zoom,
      panX: state.panX,
      panY: state.panY,
      activeFileId: state.activeFileId,
      pageIdx: state.pageIdx,
      openTabs: Array.isArray(state.openTabs) ? state.openTabs.map(t => ({ fileId: t.fileId, pageIdx: t.pageIdx || 0 })) : [],
      sectionLinkStyle: state.sectionLinkStyle ? { ...state.sectionLinkStyle } : { fontPt: 15, strokeWidth: 30 },
    },
    counters: { nextJointId, nextMemberId, nextFileId, nextGlobalJointId, nextGlobalMemberId },
    globalJoints: state.globalJoints || [],
    globalMembers: state.globalMembers || [],
    materials: Array.isArray(state.materials) ? state.materials : [],
    floorTypes: Array.isArray(state.floorTypes) ? state.floorTypes : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }],
    files: filesData,
  };
  const text = JSON.stringify(data);
  const projectName = ($("jobName") && ($("jobName") as HTMLInputElement).value.trim()) || "project";
  console.log(`[儲存專案] 檔案數 ${state.files.length}・JSON ${fmtMB(text.length)}・底圖快取 ${fmtMB(totalCacheBytes)}`);
  return { text, projectName, totalCacheBytes };
}

// FSA 權限工具:確保 handle 具 readwrite 權限。已授權 → true;否則嘗試請求一次。
export async function ensureRwPermission(handle) {
  if (!handle) { console.log("[FSA perm] no handle"); return false; }
  const opts = { mode: "readwrite" };
  try {
    if (typeof handle.queryPermission === "function") {
      const cur = await handle.queryPermission(opts);
      console.log("[FSA perm] query =", cur);
      if (cur === "granted") return true;
    } else {
      console.log("[FSA perm] queryPermission not supported on this handle");
    }
    if (typeof handle.requestPermission === "function") {
      const got = await handle.requestPermission(opts);
      console.log("[FSA perm] request =", got);
      return got === "granted";
    } else {
      console.log("[FSA perm] requestPermission not supported on this handle");
    }
  } catch (e) {
    console.warn("[FSA perm] check failed:", e);
  }
  return false;
}

// 寫檔:優先使用 File System Access API 直接覆寫;沒有 handle 或不支援則「另存為」
//   forceAs = true → 強制跳出存檔對話框(另存新檔)
async function writeProjectWithHandle(text, projectName, forceAs) {
  let handle = forceAs ? null : state.projectFileHandle;
  console.log("[儲存專案] enter forceAs=", forceAs,
    "handle=", handle && handle.name, "type=", handle && typeof handle.createWritable);
  // 優先路徑:已有 handle 且不強制另存 → 直接覆寫
  if (handle && typeof handle.createWritable === "function") {
    try {
      // 先確認 readwrite 權限(若手勢還在仍可請求;失敗則落到「另存」)
      const ok = await ensureRwPermission(handle);
      if (!ok) throw new Error("readwrite permission not granted");
      setBusyMessage(`覆寫 ${handle.name || projectName + ".stproj.json"}…`);
      await busyTick();
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      console.log(`[儲存專案] 直接覆寫 ${handle.name}`);
      hideBusy();
      return;
    } catch (e) {
      console.warn("[儲存專案] 覆寫失敗,改為另存:", e);
      handle = null;
    }
  }
  // showSaveFilePicker:首次儲存 / 另存新檔 / 覆寫失敗的回退
  if ((window as any).showSaveFilePicker) {
    try {
      setBusyMessage("選擇儲存位置…");
      await busyTick();
      handle = await (window as any).showSaveFilePicker({
        suggestedName: `${projectName}.stproj.json`,
        types: [{
          description: "STAAD Tracer 專案",
          accept: { "application/json": [".stproj.json", ".json"] },
        }],
      });
      setBusyMessage(`寫入 ${handle.name}…`);
      await busyTick();
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      state.projectFileHandle = handle;
      console.log(`[${forceAs ? "另存新檔" : "儲存專案"}] ${handle.name}`);
      hideBusy();
      return;
    } catch (e) {
      if (e && e.name === "AbortError") { hideBusy(); return; }  // 使用者取消
      console.warn("[Save] showSaveFilePicker 失敗,退回 download:", e);
    }
  }
  // 最後回退:瀏覽器不支援 FSA(例如 Safari 舊版)→ 走一般下載
  setBusyMessage(`產生下載檔(${fmtMB(text.length)})…`);
  await busyTick();
  download(`${projectName}.stproj.json`, text);
  hideBusy();
}
