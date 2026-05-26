// Phase 8j — 完整專案讀取(loadProjectFull)
//   讀 .stproj.json 檔案 → 重建 state.files / state.globalJoints / state.globalMembers /
//   各檔 PDF / 圖片 / SVG 底圖快取(base64 還原成 ArrayBuffer / Blob URL)。
//
//   依賴(全部已 export):
//     • state / $ / applyTransform / clearSelection / render — legacy
//     • _updateGlobalOriginUI / activatePage — legacy
//     • refreshFileList / refreshPageSelector / refreshPageCoordSection / refreshLists — legacy
//     • refreshProjectTabs / refreshProjectMenu / updateScaleRulerButton — legacy
//     • inferAllGlobalJoints — core/globalJoints
//     • snapAllGlobalJointsToPrecision — legacy
//     • setNextJointId / setNextMemberId / setNextGlobalJointId / setNextGlobalMemberId / setProjectDirty — legacy(setter,ESM 跨模組寫 let 用)
//     • showBusy / setBusyMessage / busyTick — ui/busy
//     • _saveRecentProject — state/recentProjects(8h)
//     • base64ToArrayBuffer / fmtMB — state/projectFile(8i)

import {
  state, $, applyTransform, clearSelection, render,
  _updateGlobalOriginUI, activatePage,
  refreshFileList, refreshPageSelector, refreshPageCoordSection, refreshLists,
  refreshProjectTabs, refreshProjectMenu, updateScaleRulerButton,
  snapAllGlobalJointsToPrecision,
  nextGlobalJointId, nextGlobalMemberId,
  setNextJointId, setNextMemberId, setNextFileId, setNextGlobalJointId, setNextGlobalMemberId,
  setProjectDirty,
  projects, activeProjectId,
} from "../legacy";
import { showBusy, setBusyMessage, busyTick } from "../ui/busy";
import { inferGlobalJoint } from "../core/globalJoints";
import { _saveRecentProject } from "./recentProjects";
import { base64ToArrayBuffer, fmtMB } from "./projectFile";

export async function loadProjectFull(file, handle) {
  // 若使用 File System Access API 取得 handle(具 createWritable)→ 記住以便「儲存專案」直接覆寫同一個檔案
  // 否則(一般 <input type=file>)就清空 handle,下次「儲存專案」會走另存對話框(首次)
  state.projectFileHandle = (handle && typeof handle.createWritable === "function") ? handle : null;
  showBusy(`讀檔中…(${fmtMB(file.size || 0)})`);
  await busyTick();
  const text = await file.text();
  setBusyMessage("解析 JSON…");
  await busyTick();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { alert("專案檔不是有效的 JSON。"); return; }
  if (!data.schema || !String(data.schema).startsWith("staad-tracer-project")) {
    alert("這不是專案檔(schema 不符)。");
    return;
  }
  if (!confirm(`即將載入專案,目前的所有檔案與圖元會被覆蓋。要繼續嗎?\n(savedAt: ${data.savedAt || "n/a"})`)) return;

  // Reset
  state.files = [];
  state.activeFileId = null;
  state.pageIdx = 0;
  state.globalJoints = [];
  state.globalMembers = [];
  state.pendingGlobalPair = null;
  state.openTabs = [];
  clearSelection && clearSelection();

  // Restore state
  if (data.state) {
    state.scale         = data.state.scale ?? null;
    state.unitName      = data.state.unitName || "mm";
    state.globalCapacity= data.state.globalCapacity || 10000;
    if (data.state.coordDecimals != null) {
      const _cd = parseInt(data.state.coordDecimals, 10);
      state.coordDecimals = Math.min(6, Math.max(0, Number.isFinite(_cd) ? _cd : 0));
      if ($("coordDecimals")) ($("coordDecimals") as HTMLInputElement).value = String(state.coordDecimals);
    }
    if (data.state.measureDecimals != null) {
      const _md = parseInt(data.state.measureDecimals, 10);
      state.measureDecimals = Math.min(6, Math.max(0, Number.isFinite(_md) ? _md : 0));
      if ($("measureDecimals")) ($("measureDecimals") as HTMLInputElement).value = String(state.measureDecimals);
    }
    if (data.state.globalOriginId != null) {
      state.globalOriginId = data.state.globalOriginId;
      if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
    }
    if (data.state.globalOriginFileId != null) {
      state.globalOriginFileId = data.state.globalOriginFileId;
      if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
    }
    if (data.state.relayoutDirection) {
      state.relayoutDirection = (data.state.relayoutDirection === "horizontal") ? "horizontal" : "vertical";
      if ($("relayoutDirection")) ($("relayoutDirection") as HTMLInputElement).value = state.relayoutDirection;
    }
    if (data.state.relayoutCapacity != null) {
      state.relayoutCapacity = Math.max(10, parseInt(data.state.relayoutCapacity, 10) || 100);
      if ($("relayoutCapacity")) ($("relayoutCapacity") as HTMLInputElement).value = String(state.relayoutCapacity);
    }
    // 桿件編號 cap(全局)— 4 個方向
    for (const key of ["memberCapY", "memberCapX", "memberCapZ", "memberCapDiag"]) {
      const v = parseInt(data.state[key], 10);
      if ([9, 99, 999, 9999].includes(v)) {
        state[key] = v;
        if ($(key)) ($(key) as HTMLInputElement).value = String(v);
      }
    }
    if (data.state.fileListShow && typeof data.state.fileListShow === "object") {
      state.fileListShow = {
        type:  data.state.fileListShow.type  !== false,
        plane: data.state.fileListShow.plane !== false,
        stats: data.state.fileListShow.stats !== false,
      };
      ["fileListShowType","fileListShowPlane","fileListShowStats"].forEach(id => {
        const el = $(id); if (!el) return;
        const k = id === "fileListShowType" ? "type" : id === "fileListShowPlane" ? "plane" : "stats";
        (el as HTMLInputElement).checked = !!state.fileListShow[k];
      });
    }
    state.zoom          = data.state.zoom || 1;
    state.panX          = data.state.panX || 0;
    state.panY          = data.state.panY || 0;
    state.openTabs      = Array.isArray(data.state.openTabs)
      ? data.state.openTabs.map(t => ({ fileId: t.fileId, pageIdx: t.pageIdx || 0 }))
      : [];
    if (data.state.sectionLinkStyle && typeof data.state.sectionLinkStyle === "object") {
      const fp = parseInt(data.state.sectionLinkStyle.fontPt, 10);
      const sw = parseInt(data.state.sectionLinkStyle.strokeWidth, 10);
      state.sectionLinkStyle = {
        fontPt:      (Number.isFinite(fp) && fp >= 6 && fp <= 200) ? fp : 15,
        strokeWidth: (Number.isFinite(sw) && sw >= 1 && sw <= 50) ? sw : 30,
      };
      if ($("slFontPt"))      ($("slFontPt") as HTMLInputElement).value      = String(state.sectionLinkStyle.fontPt);
      if ($("slStrokeWidth")) ($("slStrokeWidth") as HTMLInputElement).value = String(state.sectionLinkStyle.strokeWidth);
    }
  }
  if (data.counters) {
    setNextJointId(data.counters.nextJointId  || 1);
    setNextMemberId(data.counters.nextMemberId || 1);
    setNextFileId(data.counters.nextFileId   || 1);
    setNextGlobalJointId(data.counters.nextGlobalJointId || 1);
    setNextGlobalMemberId(data.counters.nextGlobalMemberId || 1);
  }
  // v2:全局節點;v1 沒有此欄位則保持空陣列(向下相容)
  if (Array.isArray(data.globalJoints)) {
    state.globalJoints = data.globalJoints.map(g => ({
      id: g.id, label: g.label || ("N" + g.id),
      x: g.x ?? null, y: g.y ?? null, z: g.z ?? null,
      derivedFrom: Array.isArray(g.derivedFrom) ? g.derivedFrom : [],
      locked: !!g.locked,
      warnings: Array.isArray(g.warnings) ? g.warnings : [],
    }));
    // 容錯:若計數器落後於資料 id,推進
    let maxG = 0;
    for (const g of state.globalJoints) if (g.id > maxG) maxG = g.id;
    if (maxG + 1 > nextGlobalJointId) setNextGlobalJointId(maxG + 1);
    // 載入後一律把 globalJoint 座標對齊到當前精準度 — 舊存的浮點漂移在此清掉
    if (typeof snapAllGlobalJointsToPrecision === "function") snapAllGlobalJointsToPrecision();
  }
  // v3:全局桿件
  if (Array.isArray(data.globalMembers)) {
    state.globalMembers = data.globalMembers.map(g => ({
      id: g.id, label: g.label || ("M" + g.id),
      gj1: g.gj1, gj2: g.gj2,
    }));
    let maxGM = 0;
    for (const g of state.globalMembers) if (g.id > maxGM) maxGM = g.id;
    if (maxGM + 1 > nextGlobalMemberId) setNextGlobalMemberId(maxGM + 1);
  } else {
    state.globalMembers = [];
  }
  // 材料清單(專案層級;由「材料管理」視窗 CRUD)— 保留 table 欄(STAAD 表單識別字串)
  state.materials = Array.isArray(data.materials)
    ? data.materials.filter(m => m && typeof m.name === "string" && m.name.trim())
      .map(m => ({
        name:  String(m.name).trim(),
        table: m.table ? String(m.table).trim() : "",
        note:  m.note  ? String(m.note)        : "",
      }))
    : [];
  // 節點編號管理(樓層 + 斜撐共用一池);舊存檔沒 kind → 補成 "floor"(維持舊行為)
  state.floorTypes = Array.isArray(data.floorTypes)
    ? data.floorTypes.filter(t => t && typeof t.key === "string" && t.key.trim())
      .map(t => ({
        key:     String(t.key).trim(),
        label:   t.label ? String(t.label) : t.key,
        yyStart: Number.isFinite(+t.yyStart) ? Math.max(1, Math.floor(+t.yyStart)) : 1,
        kind:    (t.kind === "brace") ? "brace" : "floor",
      }))
    : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
  if (!state.floorTypes.length) state.floorTypes = [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];

  // Pass 1:重建檔案 entry,持有 binary 的還原 pdf / image 物件
  const allFiles = data.files || [];
  let failedFiles = [];
  for (let i = 0; i < allFiles.length; i++) {
    const fs = allFiles[i];
    setBusyMessage(`還原底圖 ${i + 1}/${allFiles.length}:${fs.name}…`);
    await busyTick();
   try {
    const entry: any = {
      id: fs.id,
      name: fs.name,
      sourceName: fs.sourceName,
      type: fs.type,
      pageCount: fs.pageCount || 1,
      pdfPage:   fs.pdfPage,
      rotation:  fs.rotation || 0,
      offsetX:   fs.offsetX || 0,
      offsetY:   fs.offsetY || 0,
      clipRect:    fs.clipRect    || null,
      scaleRuler:  fs.scaleRuler  || null,
      planeOrigin: fs.planeOrigin || null,
      // 衍生模型:載入專案時也濾掉 autoProp 副本(舊資料兼容)
      sectionLinks: fs.sectionLinks
        ? JSON.parse(JSON.stringify(fs.sectionLinks)).filter(e => !e.autoProp)
        : [],
      userBgLines: Array.isArray(fs.userBgLines) ? JSON.parse(JSON.stringify(fs.userBgLines)) : [],
      measurements: Array.isArray(fs.measurements) ? JSON.parse(JSON.stringify(fs.measurements)) : [],
      _nextMeasureId: fs._nextMeasureId || 1,
      bgWidth:  fs.bgWidth,
      bgHeight: fs.bgHeight,
      pages: fs.pages || {},
      selectedBgPaths: new Set(fs.selectedBgPaths || []),
      deletedBgPaths:  new Set(fs.deletedBgPaths  || []),
      detectedStrokeWidth: fs.detectedStrokeWidth,
      sourceFileId: fs.sourceFileId || null,
      imageWidth:  fs.imageWidth,
      imageHeight: fs.imageHeight,
      // 新格式:從專案檔還原快取的向量底圖 / 圖片 dataURL,不需 pdf.js
      cachedBgSvg:    fs.cachedBgSvg    || null,
      cachedBgImg:    fs.cachedBgImg    || null,
      cachedBgWidth:  fs.cachedBgWidth  || null,
      cachedBgHeight: fs.cachedBgHeight || null,
    };
    // 舊格式相容:若專案檔含 binaryKind + binary,還原為 pdf.js / Image 物件
    if (fs.binaryKind === "pdf" && fs.binary && fs.binary.length > 100 && (window as any).pdfjsLib) {
      const buf = base64ToArrayBuffer(fs.binary);
      entry.pdfData = buf;
      try {
        entry.pdf = await (window as any).pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      } catch (e1) {
        entry.pdf = await (window as any).pdfjsLib.getDocument({ data: buf.slice(0), disableWorker: true }).promise;
      }
    } else if (fs.binaryKind === "image" && fs.binary && fs.binary.length > 100) {
      const buf  = base64ToArrayBuffer(fs.binary);
      entry.imageData = buf;
      entry.imageMime = fs.binaryMime || "image/png";
      const blob = new Blob([buf], { type: entry.imageMime });
      const img  = new Image();
      img.src = URL.createObjectURL(blob);
      await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
      entry.image = img;
      if (!entry.imageWidth)  entry.imageWidth  = img.naturalWidth;
      if (!entry.imageHeight) entry.imageHeight = img.naturalHeight;
    }
    state.files.push(entry);
   } catch (err) {
    console.error("[載入專案] 還原檔案失敗:", fs.name, err);
    failedFiles.push(fs.name);
    // 即使 binary 還原失敗,仍把 metadata 推入,讓使用者可以看到此檔列在清單裡
    try {
      state.files.push({
        id: fs.id, name: fs.name, sourceName: fs.sourceName, type: fs.type,
        pageCount: fs.pageCount || 1, pdfPage: fs.pdfPage,
        rotation: fs.rotation || 0, offsetX: fs.offsetX || 0, offsetY: fs.offsetY || 0,
        clipRect: fs.clipRect || null,
        scaleRuler: fs.scaleRuler || null, planeOrigin: fs.planeOrigin || null,
        pages: fs.pages || {},
        selectedBgPaths: new Set(fs.selectedBgPaths || []),
        deletedBgPaths:  new Set(fs.deletedBgPaths  || []),
        sourceFileId: fs.sourceFileId || null,
        cachedBgSvg: fs.cachedBgSvg || null, cachedBgImg: fs.cachedBgImg || null,
        cachedBgWidth:  fs.cachedBgWidth  || null,
        cachedBgHeight: fs.cachedBgHeight || null,
      });
    } catch (e2) { console.error("補建 metadata 也失敗:", e2); }
   }
  }

  // Pass 2:把 split / 多頁衍生檔的 cached BG 連結到來源檔(若需要)
  setBusyMessage("連結拆分頁與多頁來源…");
  await busyTick();
  for (const f of state.files) {
    if (f.sourceFileId && !f.pdf && !f.image) {
      const src = state.files.find(x => x.id === f.sourceFileId);
      if (src) {
        if (src.pdf)   f.pdf = src.pdf;
        if (src.image) {
          f.image = src.image;
          if (!f.imageWidth)  f.imageWidth  = src.imageWidth;
          if (!f.imageHeight) f.imageHeight = src.imageHeight;
        }
      }
    }
  }
  setBusyMessage("套用作用中頁面…");
  await busyTick();

  // Activate active page(若失敗仍要繼續走完 refresh,讓 fileList 正常顯示)
  const targetActive = (data.state && data.state.activeFileId) ?? (state.files[0] && state.files[0].id) ?? null;
  const targetPage   = (data.state && data.state.pageIdx) || 0;
  try {
    if (targetActive != null && state.files.find(f => f.id === targetActive)) {
      await activatePage(targetActive, targetPage);
    } else if (state.files.length) {
      await activatePage(state.files[0].id, 0);
    }
  } catch (err) {
    console.error("[載入專案] activatePage 失敗:", err);
  }

  // 還原 zoom / pan(activatePage 不會動到,直接套)
  applyTransform && applyTransform();
  // 儲存檔的 globalJoint 座標是 source of truth — 只對「沒座標」的 globalJoint 補 infer,
  // 不去覆蓋已存的值。否則 page joints 跟 planeOrigin 的 sub-precision 漂移會讓
  // rank cache 重算後落到不同 bucket → 節點 display ID 在儲存後重讀就跑掉。
  if (typeof inferGlobalJoint === "function" && Array.isArray(state.globalJoints)) {
    for (const g of state.globalJoints) {
      if (!g) continue;
      if (g.x == null || g.y == null || g.z == null) {
        try { inferGlobalJoint(g); } catch (_) {}
      }
    }
  }
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  refreshPageCoordSection && refreshPageCoordSection();
  updateScaleRulerButton && updateScaleRulerButton();
  render && render();
  refreshLists && refreshLists();
  console.log(`[載入專案] 檔案 ${state.files.length} 個・active = ${state.activeFileId}・失敗 ${failedFiles.length}`);
  if (failedFiles.length) {
    alert(`部分檔案還原失敗(已保留中繼資料):\n${failedFiles.map(n => "  • " + n).join("\n")}`);
  }
  // 多專案:把當前活躍 tab 的名稱改為載入的檔案名(拿掉 .stproj.json / .json 副檔名)
  //   ★ 原本用 `typeof projects !== "undefined"` 守護,但 projects/activeProjectId 是
  //     legacy.ts 的 module-private 變數,ES module 從未 export → 永遠 undefined →
  //     整塊跳過 → 重讀檔案後 tab 名一直停在「未命名」。
  //     改成正常 import + null check 即可。
  if (activeProjectId != null) {
    const cur = projects.find(p => p.id === activeProjectId);
    if (cur && file && file.name) {
      cur.name = file.name.replace(/\.stproj\.json$/i, "").replace(/\.json$/i, "");
      setProjectDirty(false);
      cur.dirty = false;
      refreshProjectTabs && refreshProjectTabs();
      refreshProjectMenu && refreshProjectMenu();
    }
  }
  // 加入「最近開啟」紀錄(handle 若為空也存,讓使用者至少看得到名字)
  //   多帶 size + lastModified → 同名但不同內容的檔可以在清單裡並存區分
  try {
    if (file && file.name) {
      _saveRecentProject(
        file.name,
        handle || null,
        Number.isFinite(file.size) ? file.size : 0,
        Number.isFinite(file.lastModified) ? file.lastModified : 0,
      );
    }
  } catch (_) {}
}
