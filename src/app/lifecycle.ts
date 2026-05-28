// 檔案 / 頁面生命週期 — 把檔案加進專案 + 切換到指定頁的核心流程
//
//   • addFile(f) — 拿 File 物件,判斷 PDF / Image / DXF / DWG 並建立 file entry,讀進 state.files
//   • syncStateScaleFromActiveFile() — 切檔時把 state.scale / unitName 對齊到 active file 的 scaleRuler
//   • activatePage(fileId, pageIdx) — 切到指定檔/頁:渲底圖、套 plane、重 infer globalJoint、refresh UI
//   • activatePageWithBusy(fileId, pageIdx) — 包 spinner 的版本(底圖渲染可能 block 數秒)
//   • _maybeShowCollisionPopup / _showAllCollisionsPopup / _showCollisionPopup — 桿件撞號通知 popup
// @ts-nocheck

import { state, allocFileId, setNextJointId, setNextMemberId, setNextFileId, setNextGlobalJointId } from "./state";
import { $ } from "./dom";
import { applyTransform, _restorePageView, _saveCurrentTabView } from "./transform";
import { inferAllGlobalJoints } from "../core/globalJoints";
import { invalidateRankCache } from "../core/rankCache";
import { showBusy, hideBusy, busyTick, setBusyMessage } from "../ui/busy";
import { showImportDialog } from "../io/bgLoaders";
import { openSearchWindow } from "../dialogs/search";
import {
  getActiveFile, getPage,
  applyBgRotation, cacheActivePageBgSegs,
  detectAlignmentAngle, render, refreshLists, refreshFileList, refreshPageSelector,
  fmtMB, dxfToSvg,
  renderPdfBg, renderImageBg, renderCachedBg, renderBlankBg,
  _updateGlobalOriginUI, _restoreSectionLinkShapeMarquee,
  refreshPageCoordSection, refreshSectionLinkList,
  updatePlaneOriginButton, updateScaleRulerButton, updateCalibrateButton,
  updateBgToggleBtn, updateLblToggleBtn, updateJointVisBtn, updateMemberVisBtn,
  updateAxisIndicator, paintEmptyCanvasMessage,
  parseDxf, dxfBbox,
  _navRecordIfNotInProgress,
  _t,
} from "../app/integration";

export async function addFile(f) {
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isImg = f.type.startsWith("image/") || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name);
  const isDxf = /\.dxf$/i.test(f.name);
  const isDwg = /\.dwg$/i.test(f.name);
  if (isDwg) {
    alert(
      "不支援 DWG 直接匯入。\n\n" +
      "DWG 是 AutoCAD 的封閉二進位格式,瀏覽器內沒有可靠的 parser。\n" +
      "請先用以下任一方式轉成 DXF 後再匯入:\n" +
      "  • AutoCAD「另存新檔 → DXF」\n" +
      "  • 免費工具 ODA File Converter(opendesign.com)"
    );
    return;
  }
  if (!isPdf && !isImg && !isDxf) { alert(`不支援的檔案類型: ${f.name}`); return; }

  // 檔案名稱重複偵測(以原始檔名比對)— 不硬擋,讓使用者決定。
  // (使用情境:原檔已被重新命名 / 複製 / 拆分後,原 sourceName 仍在系統中,
  //  此時若拿到的新檔剛好同名但是不同內容,直接擋會很不便。)
  if (state.files.some(x => x.sourceName === f.name)) {
    if (!confirm(`偵測到「${f.name}」可能已載入過(來源檔名相同)。\n仍要繼續匯入這份檔案嗎?\n\n( 取消 → 不匯入;確定 → 當作新檔載入,屆時會自動加上「(2)」之類的後綴避免名稱衝突 )`)) return;
  }
  // 顯示名稱 (file.name) 必須唯一;若撞名 → 自動加 (2)/(3)/...
  // sourceName 仍保留原始 f.name(不變),供下次重複偵測使用
  const uniqueName = (base) => {
    if (!state.files.some(x => x.name === base)) return base;
    let n = 2;
    while (state.files.some(x => x.name === `${base} (${n})`)) n++;
    return `${base} (${n})`;
  };

  if (isDxf) {
    showBusy(`讀取 DXF…(${fmtMB(f.size || 0)})`);
    await busyTick();
    const text = await f.text();
    let parsed, svgPack;
    setBusyMessage("解析 DXF entities…");
    await busyTick();
    try { parsed = parseDxf(text); }
    catch (e) { hideBusy(); alert("DXF 解析失敗:" + e.message); return; }
    setBusyMessage(`轉成 SVG…(entities: ${parsed.entities ? parsed.entities.length : 0})`);
    await busyTick();
    try { svgPack = dxfToSvg(parsed); }
    catch (e) { hideBusy(); alert("DXF 渲染失敗:" + e.message); return; }
    hideBusy();
    if (!svgPack.entityCount) { alert("此 DXF 檔內沒有可繪製的圖元(目前支援 LINE / LWPOLYLINE / POLYLINE / CIRCLE / ARC / TEXT / INSERT)"); return; }

    // 為了預覽,先把 SVG 轉成 dataURL 給 Image 使用
    const dlgRes = await showImportDialog({
      name: f.name + `(${svgPack.entityCount} 個圖元)`,
      drawPreview: async (canvas) => {
        const target = 600;
        const sc = Math.min(target / svgPack.width, target / svgPack.height, 1);
        canvas.width  = Math.max(1, Math.floor(svgPack.width  * sc));
        canvas.height = Math.max(1, Math.floor(svgPack.height * sc));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        // 預覽專用:在 root <svg> 塞 stroke-width,讓所有「沒自帶 stroke-width 的 bg-stroke」
        // 透過 SVG 屬性繼承一個粗值。配合 vector-effect="non-scaling-stroke" 表示「最終輸出 N px」,
        // 所以在光柵化到小 canvas 後仍然清晰可見。不影響匯入(只改這個 blob URL 的版本)。
        const previewSvg = svgPack.svg.replace(
          /<svg\b([^>]*)>/,
          '<svg$1 stroke-width="6" stroke-linecap="round" stroke-linejoin="round">'
        );
        await new Promise((res, rej) => {
          const img = new Image();
          const url = URL.createObjectURL(new Blob([previewSvg], { type: "image/svg+xml" }));
          img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); res(); };
          img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
          img.src = url;
        });
      },
    });
    if (!dlgRes.ok) return;
    const userRotRad = (dlgRes.rotation || 0) * Math.PI / 180;

    const baseName = f.name.replace(/\.dxf$/i, "");
    // DXF 1:1 自動比例尺:依 $INSUNITS 換算「DXF 單位 → mm」的 ratio,並建立一個視覺比例尺
    //   DXF $INSUNITS:1=in / 2=ft / 4=mm / 5=cm / 6=m / 0=unitless(預設假設 mm)
    const insUnits = (parsed.header && parsed.header.$INSUNITS) || 0;
    const unitToMm = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
    const dxfRatio = unitToMm[insUnits] || 1;     // mm per DXF unit;0 / 未知 → 假設 mm
    const unitLabel = ({ 1: "inch", 2: "ft", 4: "mm", 5: "cm", 6: "m" })[insUnits] || "mm(假設)";
    // 比例尺視覺化:在 bbox 底部畫一條 1000 mm 長(world coord = 1000 / dxfRatio)的水平線
    const realLen = 1000;
    const measured = realLen / dxfRatio;
    const margin = Math.max(20, svgPack.height * 0.05);
    const p1 = { x: margin, y: svgPack.height - margin };
    const p2 = { x: margin + measured, y: svgPack.height - margin };
    const autoRuler = {
      type: "twoLines",
      p1, p2,
      measured, real: realLen,
      ratio: dxfRatio,
    };
    const entry = {
      id: allocFileId(),
      name: uniqueName(baseName),
      sourceName: f.name,
      type: "application/dxf",
      pageCount: 1,
      pages: {},
      // 直接寫入 cachedBgSvg,activatePage 會走 renderCachedBg 路徑
      cachedBgSvg: svgPack.svg,
      cachedBgWidth: svgPack.width,
      cachedBgHeight: svgPack.height,
      rotation: userRotRad,
      // DXF 1:1 自動建立比例尺 → 之後不需要手動校準(若 INSUNITS 是合理值)
      scaleRuler: autoRuler,
    };
    state.files.push(entry);
    console.log(`[DXF 載入] ${f.name}: $INSUNITS = ${insUnits} (${unitLabel}),自動建立比例尺 ratio = ${dxfRatio} mm/unit`);
    if (state.activeFileId == null) {
      // 大 DXF(上萬圖元)渲染 SVG DOM 會同步 block 數秒 → busyTick 讓瀏覽器先 paint 出 spinner,
      // 否則使用者按「確定」後以為程式沒反應
      showBusy(`渲染底圖…(${svgPack.entityCount} 個圖元)`);
      await busyTick();
      try { await activatePage(entry.id, 0); }
      finally { hideBusy(); }
    }
    return;
  }

  if (isPdf) {
    if (!window.pdfjsLib) { alert("PDF.js 尚未載入。"); return; }
    showBusy(`讀取 PDF…(${fmtMB(f.size || 0)})`);
    await busyTick();
    const buf = await f.arrayBuffer();
    setBusyMessage("解析 PDF…");
    await busyTick();
    let pdf;
    try { pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise; }
    catch (e1) { pdf = await pdfjsLib.getDocument({ data: buf.slice(0), disableWorker: true }).promise; }
    hideBusy();

    // 導入設定:預覽第 1 頁 + 旋轉選擇
    const dlgRes = await showImportDialog({
      name: f.name + (pdf.numPages > 1 ? `(共 ${pdf.numPages} 頁)` : ""),
      drawPreview: async (canvas) => {
        const page = await pdf.getPage(1);
        const v0 = page.getViewport({ scale: 1 });
        const target = 600;   // buffer 解析度,顯示時再縮放
        const sc = Math.min(target / v0.width, target / v0.height);
        const v = page.getViewport({ scale: sc });
        canvas.width  = Math.floor(v.width);
        canvas.height = Math.floor(v.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: v }).promise;
      },
    });
    if (!dlgRes.ok) return;
    const userRotRad = (dlgRes.rotation || 0) * Math.PI / 180;
    // 0° 視為「未指定」→ 保留 PDF 自動對齊;非 0° 則直接寫入 file.rotation,跳過自動對齊
    const baseName = f.name.replace(/\.pdf$/i, "");
    const multi = pdf.numPages > 1;
    let firstId = null;
    // 多頁共用同一份原始 PDF buffer:只在第一個 entry 存 pdfData,後續用 sourceFileId 指向
    let firstPdfFileId = null;
    for (let i = 1; i <= pdf.numPages; i++) {
      const entry = {
        id: allocFileId(),
        name: uniqueName(multi ? `${baseName}-${i}` : baseName),
        sourceName: f.name,
        type: f.type,
        pdf: pdf,
        pdfPage: i,        // 在原始 PDF 中的頁次
        pageCount: 1,
        pages: {},
      };
      if (firstPdfFileId == null) {
        entry.pdfData = buf;     // 第一個 entry 持有原始 ArrayBuffer
        firstPdfFileId = entry.id;
      } else {
        entry.sourceFileId = firstPdfFileId;
      }
      if (userRotRad !== 0) entry.rotation = userRotRad;
      state.files.push(entry);
      if (firstId == null) firstId = entry.id;
    }
    if (state.activeFileId == null && firstId != null) {
      showBusy(`渲染 PDF 第 1 頁…`);
      await busyTick();
      try { await activatePage(firstId, 0); }
      finally { hideBusy(); }
    }
  } else {
    showBusy(`讀取圖片…(${fmtMB(f.size || 0)})`);
    await busyTick();
    const imgBuf = await f.arrayBuffer();
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
    hideBusy();

    const dlgRes = await showImportDialog({
      name: f.name,
      drawPreview: (canvas) => {
        const target = 600;
        const sc = Math.min(target / img.naturalWidth, target / img.naturalHeight, 1);
        canvas.width  = Math.max(1, Math.floor(img.naturalWidth  * sc));
        canvas.height = Math.max(1, Math.floor(img.naturalHeight * sc));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      },
    });
    if (!dlgRes.ok) return;
    const userRotRad = (dlgRes.rotation || 0) * Math.PI / 180;

    const entry = {
      id: allocFileId(),
      name: uniqueName(f.name),
      sourceName: f.name,
      type: f.type,
      image: img,
      imageData: imgBuf,                                          // 原始位元組,供專案儲存使用
      imageMime: f.type || "image/png",
      imageWidth: img.naturalWidth,
      imageHeight: img.naturalHeight,
      rotation: userRotRad,    // 圖檔沒有自動對齊邏輯,直接寫入即可
      pageCount: 1,
      pages: {},
    };
    state.files.push(entry);
    if (state.activeFileId == null) {
      showBusy("渲染圖片…");
      await busyTick();
      try { await activatePage(entry.id, 0); }
      finally { hideBusy(); }
    }
  }
}

// 把 state.scale 同步成「目前 active file」的比例尺。
// 因為每個檔案(可能對應不同 PDF / 不同 DWG 來源)的 px↔mm 比例不一樣,
// 切換 active file 必須跟著切 state.scale,否則新檔案上的尺寸會用舊檔案的比例算錯。
export function syncStateScaleFromActiveFile() {
  const f = getActiveFile();
  if (f && f.scaleRuler && f.scaleRuler.ratio > 0) {
    state.scale = 1 / f.scaleRuler.ratio;
    state.unitName = "mm";
  } else {
    state.scale = null;     // 此檔案尚未建立比例尺
  }
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
}

export async function activatePage(fileId, pageIdx) {
  const file = state.files.find(f => f.id === fileId);
  if (!file) return;
  // 切頁/切檔 → 取消任何卡住的切面 pending / placing(否則上次卡住的「只能選直線」過濾會跟到新頁)
  if (state.sectionLinkPending) {
    state.sectionLinkPending = false;
    state.sectionLinkPrevTool = null;
    $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
    if (typeof _restoreSectionLinkShapeMarquee === "function") _restoreSectionLinkShapeMarquee();
  }
  if (state.sectionLinkPlacing) {
    state.sectionLinkPlacing = null;
  }
  // 切頁/切檔不再清選取 — 改用「來源頁紀錄 + 跨頁世界座標比對」的方式做 linked preview:
  //   - 在 source page 用 j.id 高亮(正常選取)
  //   - 在其他頁用世界座標 fuzzy match 高亮(linked preview,不同視覺,避免 j.id 撞號誤標)
  state.activeFileId = fileId;
  state.pageIdx = pageIdx || 0;
  syncStateScaleFromActiveFile();
  $("pageZ").value = (getPage().z ?? 0);
  // 優先順序:
  //   1) 有 pdf.js 物件 → 用 renderPdfBg(會更新快取)
  //   2) 有 image 物件 → 用 renderImageBg(會更新快取)
  //   3) 有快取的向量 SVG / 圖片 dataURL → 直接從快取重建底圖(專案讀回常走這條)
  //   4) split / 衍生檔有 sourceFileId → 用來源的快取
  //   5) 都沒有 → 空白底圖
  if (file.pdf) await renderPdfBg(file.pdf, file.pdfPage || (pageIdx + 1));
  else if (file.image) renderImageBg(file);
  else if (file.cachedBgSvg || file.cachedBgImg) await renderCachedBg(file);
  else if (file.sourceFileId) {
    const src = state.files.find(f => f.id === file.sourceFileId);
    if (src && (src.cachedBgSvg || src.cachedBgImg)) await renderCachedBg(src, file);
    else renderBlankBg(file);
  }
  else renderBlankBg(file);
  // 標記目前 bg DOM 屬於哪個檔案的哪一頁,供 _autoRepairBgIfMissing 偵測錯位
  state._bgRenderedFor = { fileId: file.id, pageIdx: state.pageIdx };
  const bgSvgElForTag = document.getElementById("bgSvg");
  if (bgSvgElForTag) {
    bgSvgElForTag.setAttribute("data-bg-file-id", String(file.id));
    bgSvgElForTag.setAttribute("data-bg-page-idx", String(state.pageIdx));
  }
  // 第一次啟用 PDF 頁時自動對齊
  if (file.pdf && file.rotation === undefined) {
    const r = detectAlignmentAngle();
    file.rotation = r ? r.correction : 0;
    if (r) console.log(`[自動對齊] ${file.name}: ${(r.correction * 180 / Math.PI).toFixed(3)}°(${r.src})`);
  }
  applyBgRotation(file);
  // render* 已經呼叫過 fitToView;若這頁之前看過,恢復記住的 zoom/pan(不要重設視野)
  if (_restorePageView(file, state.pageIdx)) applyTransform();
  refreshFileList();
  refreshPageSelector();
  if (typeof refreshTabBar === "function") refreshTabBar();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  refreshPageCoordSection && refreshPageCoordSection();
  updateScaleRulerButton && updateScaleRulerButton();
  updatePlaneOriginButton && updatePlaneOriginButton();
  updateCalibrateButton && updateCalibrateButton();
  render(); refreshLists();
  // P2:當前頁的 bg 線段快取(供跨頁同步建點時吸到底圖實際交點)
  //   每次 activatePage 重建,DOM 此時應該已就緒
  try { cacheActivePageBgSegs && cacheActivePageBgSegs(); } catch (e) { console.warn("[P2 cache] 失敗:", e); }
  // 撞號桿件 popup 已移到 activatePageWithBusy(使用者主動切頁時才跳),避免儲存/讀取
  // 內部預渲染呼叫 activatePage 時也跳 popup 中斷流程。
}

// 偵測當前頁有沒有撞號桿件 → 顯示 popup
export function _maybeShowCollisionPopup(file, pageIdx) {
  if (!state.memberCollisions || state.memberCollisions.size === 0) return;
  const pg = file && file.pages && file.pages[pageIdx];
  if (!pg || pg._orphan) return;
  const hitIds = [];
  for (const m of pg.members || []) {
    if (state.memberCollisions.has(m.id)) hitIds.push(m.id);
  }
  if (!hitIds.length) return;
  _showCollisionPopup(hitIds, `本頁有 ${hitIds.length} 條桿件編號撞號(跟其他頁的不同物理桿件共用同一個 m.id),已被高亮為亮綠色`);
}

// 顯示所有撞號桿件 popup(3D 一鍵處理結束時用 / 全局警示)
export function _showAllCollisionsPopup() {
  if (!state.memberCollisions || state.memberCollisions.size === 0) return;
  const allIds = [...state.memberCollisions];
  _showCollisionPopup(allIds, `全模型共 ${allIds.length} 個 m.id 撞號(不同物理桿件共用同 ID),畫面上以亮綠色高亮;切到含撞號桿件的頁時會再次提醒`);
}

// 共用 popup 顯示邏輯 — caller 傳要列的 m.id 陣列 + 說明訊息
export function _showCollisionPopup(ids, msg) {
  if (!ids || !ids.length) return;
  const popup = document.getElementById("collisionPopup");
  const msgEl = document.getElementById("collisionPopupMsg");
  const idsEl = document.getElementById("collisionPopupIds");
  const searchBtn = document.getElementById("collisionSearchBtn");
  const okBtn = document.getElementById("collisionOkBtn");
  if (!popup || !msgEl || !idsEl || !searchBtn || !okBtn) return;
  msgEl.textContent = msg;
  const sortedIds = [...ids].sort((a, b) => a - b);
  idsEl.textContent = sortedIds.join(", ");
  popup.style.display = "block";
  // 確定 → 關 popup
  okBtn.onclick = () => { popup.style.display = "none"; };
  // 搜尋 → 開搜尋 popup,並自動填入撞號 m.id 到「桿件編號」textarea
  searchBtn.onclick = () => {
    popup.style.display = "none";
    try {
      if (typeof openSearchWindow === "function") openSearchWindow();
      // openSearchWindow 走 win.document.write + DOMContentLoaded 後 body.innerHTML;
      //   需要等 #memberIdInput textarea 真的就緒,輪詢最多 30 次 / 每次 100ms
      const idsStr = sortedIds.join(",");
      const _tryFill = (attempt) => {
        const w = _searchWin;
        const ready = w && !w.closed && w.document && w.document.getElementById("memberIdInput");
        if (!ready) {
          if (attempt < 30) setTimeout(() => _tryFill(attempt + 1), 100);
          else console.warn("[collision search prefill] 搜尋視窗未就緒,放棄填入");
          return;
        }
        try {
          // 確認搜尋模式 = 桿件(預設就是,但保險起見再勾一次並觸發 change)
          const typeMember = w.document.querySelector('input[name="searchType"][value="member"]');
          if (typeMember && !typeMember.checked) {
            typeMember.checked = true;
            typeMember.dispatchEvent(new w.Event("change", { bubbles: true }));
          }
          // 填編號 textarea + 觸發 input event
          const idInput = w.document.getElementById("memberIdInput");
          idInput.value = idsStr;
          idInput.dispatchEvent(new w.Event("input", { bubbles: true }));
          idInput.focus();
          // 直接按搜尋按鈕(textarea 內 Enter 是換行,搜尋鈕點下才會跑)
          const btn = w.document.getElementById("btnSearch");
          if (btn) btn.click();
        } catch (e) { console.warn("[collision search prefill] 填入失敗:", e); }
      };
      setTimeout(() => _tryFill(0), 100);
    } catch (e) { console.warn("[collision search] 失敗:", e); }
  };
}

// 使用者點擊切換頁面/檔案時的包裝:顯示 busy spinner,避免大 DXF/PDF 重繪期間畫面看似凍結。
//   activatePage 會走 renderCachedBg / renderPdfBg,對上萬元素的底圖可能同步 block 數秒,
//   必須先 showBusy + busyTick 讓瀏覽器 paint 出進度再進入重活。
export async function activatePageWithBusy(fileId, pageIdx) {
  // 使用者主動切分頁:先把當下視野存到正在離開的那頁,activatePage 內會還原目標頁的視野
  const targetPidx = pageIdx || 0;
  const isSwitching = state.activeFileId != null &&
    (state.activeFileId !== fileId || (state.pageIdx || 0) !== targetPidx);
  if (isSwitching) {
    _saveCurrentTabView();
    // 離開前先把當前位置寫進導航歷史(同位置只 update zoom/pan,不重複新增)→ Back 可以回到啟動頁
    _navRecordIfNotInProgress();
  }
  const f = state.files.find(ff => ff.id === fileId);
  const msg = f ? `切換到「${f.name}」…` : "切換頁面…";
  showBusy(msg);
  await busyTick();
  try { await activatePage(fileId, targetPidx); }
  finally { hideBusy(); }
  // 撞號桿件 popup:只在使用者主動切頁時跳,避免儲存/讀取期間的內部 activatePage 中斷流程。
  //   同一頁切回不會重覆跳 — 用 memberCollisionsLastShownPage 記錄上次顯示的 file.id#pageIdx。
  try {
    const pgKey = `${fileId}#${targetPidx}`;
    if (state.memberCollisionsLastShownPage !== pgKey) {
      const fileForPopup = state.files.find(ff => ff.id === fileId);
      _maybeShowCollisionPopup(fileForPopup, targetPidx);
      state.memberCollisionsLastShownPage = pgKey;
    }
  } catch (e) { console.warn("[collision popup] 失敗:", e); }
  // 抵達後記入導航歷史(若是 navBack/navForward 觸發的就跳過,避免迴圈)
  _navRecordIfNotInProgress();
}
