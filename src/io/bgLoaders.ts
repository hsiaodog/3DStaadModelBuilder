// 底圖載入器 — <input type="file"> change handler + 匯入對話框
//
//   • $("file") onchange:多檔選取 → 逐檔走 addFile() 流程
//   • showImportDialog({ name, drawPreview }) — 跳對話框讓使用者預覽 / 調整旋轉
//   • setupImportDialogDrag — 對話框 title bar drag
//
//   不要跟 io/bgRender.ts 混淆:bgRender 是「render 已載入的底圖 + path shape detection」,
//   bgLoaders 是「把 File 物件吃進來、變成 state.files entry」。
// @ts-nocheck

import { state } from "../app/state";
import { $ } from "../app/dom";
import {
  // legacy forward refs
  addFile, render, refreshLists, refreshFileList, refreshPageSelector,
  _t,
} from "../app/integration";
import { showBusy, hideBusy, busyTick } from "../ui/busy";
import { fmtMB } from "../persistence/projectFile";

// ---------- background loaders ----------
$("file").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  // 更新自製檔案狀態文字(取代 native input 的「未選擇任何檔案」)
  const fst = $("fileState");
  if (fst) {
    if (!files.length) {
      fst.textContent = (typeof _t === "function" && _t("sb.noFileChosen")) || "未選擇任何檔案";
    } else if (files.length === 1) {
      fst.textContent = files[0].name;
    } else {
      const suffix = (typeof _t === "function" && _t("sb.fileChosenN")) || "個檔案已選";
      fst.textContent = `${files.length} ${suffix}`;
    }
  }
  for (const f of files) {
    try { await addFile(f); }
    catch (err) {
      console.error("載入失敗:", f.name, err);
      alert(`載入「${f.name}」失敗:` + (err && err.message ? err.message : err));
    }
  }
  e.target.value = "";  // 允許重複選同檔案
  refreshFileList();
  refreshPageSelector();
});

// 導入設定對話框:顯示檔案預覽、提供 0/90/180/270 旋轉選擇,並即時更新預覽
//   參數:{ name, drawPreview(canvas) }
//   回傳:Promise<{ ok: boolean, rotation: 0|90|180|270 }>
//   預設旋轉:沿用上一次「確定」時所選的角度(取消不會更新);本 session 內生效
let lastImportRotation = 0;
// 讓 import dialog 的標題列可以拖曳整個 .imp-box 移動位置;每次重新打開會重置回置中。
// Lazy init:script 區塊在 HTML 裡早於 #importDialog 的 <div>,直接 querySelector 會拿不到 → 首次呼叫 show 時才掛 listener
let _importDlgDragInited = false;
export function setupImportDialogDrag() {
  if (_importDlgDragInited) return;
  const box = document.querySelector("#importDialog .imp-box");
  const title = document.querySelector("#importDialog .imp-title");
  if (!box || !title) return;
  _importDlgDragInited = true;
  let drag = null;
  title.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = box.getBoundingClientRect();
    // 從 translate(-50%, -50%) 置中切換到顯式 left/top 像素座標,後續拖曳直接寫 left/top
    box.style.left = rect.left + "px";
    box.style.top  = rect.top  + "px";
    box.style.transform = "none";
    drag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    // 限制不要拖出螢幕外(留 40px 標題區讓還能抓回來)
    const maxX = window.innerWidth - 40;
    const maxY = window.innerHeight - 40;
    const nx = Math.max(-box.offsetWidth + 80, Math.min(maxX, drag.left + (e.clientX - drag.startX)));
    const ny = Math.max(0, Math.min(maxY, drag.top + (e.clientY - drag.startY)));
    box.style.left = nx + "px";
    box.style.top  = ny + "px";
  });
  window.addEventListener("mouseup", () => { drag = null; });
}
export function showImportDialog({ name, drawPreview }) {
  return new Promise(async (resolve) => {
    const dlg     = document.getElementById("importDialog");
    const canvas  = document.getElementById("importPreviewCanvas");
    const fnEl    = document.getElementById("importFileName");
    const okBtn   = document.getElementById("importOkBtn");
    const caBtn   = document.getElementById("importCancelBtn");
    const rotBtns = dlg.querySelectorAll(".imp-rot-btn");
    const stage         = dlg.querySelector(".imp-preview-stage");
    const previewName   = document.getElementById("importPreviewName");
    const previewZoom   = document.getElementById("importPreviewZoom");
    const previewZoomVal = document.getElementById("importPreviewZoomVal");
    setupImportDialogDrag();   // 第一次打開時才掛拖曳 listener
    // 每次打開對話框都重置位置為置中(清掉上次拖曳留下的 inline style)
    const box = dlg.querySelector(".imp-box");
    if (box) { box.style.left = ""; box.style.top = ""; box.style.transform = ""; }
    fnEl.textContent = name;

    let curRot = lastImportRotation || 0;   // 沿用上一次的選擇
    // 參考 floorTypesDialog 的預覽流程:srcCanvas 是 drawPreview 畫進去的原始光柵圖,
    //   visible canvas 隨 stage 尺寸 + DPR 重設,_drawPreview 每次重繪都從 srcCanvas
    //   經 ctx 變換(translate / rotate / scale)blit 到 visible canvas → zoom 高倍仍然銳利。
    const previewState = { zoom: 1, offsetX: 0, offsetY: 0 };
    let srcCanvas = null;

    const _resizeVisibleCanvas = () => {
      const cssW = Math.max(80, Math.floor(stage.clientWidth));
      const cssH = Math.max(60, Math.floor(stage.clientHeight));
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.style.width  = cssW + "px";
      canvas.style.height = cssH + "px";
      canvas.width  = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    const _drawPreview = () => {
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!srcCanvas) return;
      const sw = srcCanvas.width, sh = srcCanvas.height;
      if (sw <= 0 || sh <= 0) return;
      // 90°/270° 時長寬互換 → fit 算出來的 scale 才能容下旋轉後的 bounding box
      const rotMod = ((curRot % 360) + 360) % 360;
      const effW = (rotMod === 90 || rotMod === 270) ? sh : sw;
      const effH = (rotMod === 90 || rotMod === 270) ? sw : sh;
      const fit = Math.min(canvas.width / effW, canvas.height / effH) * 0.95;   // 邊緣留一點空隙
      const sc = fit * previewState.zoom;
      ctx.save();
      ctx.translate(canvas.width / 2 + previewState.offsetX, canvas.height / 2 + previewState.offsetY);
      ctx.rotate(rotMod * Math.PI / 180);
      ctx.scale(sc, sc);
      // WYSIWYG 反相 + 對比加強(對應原本 CSS filter,讓使用者看到的接近匯入後實際模樣)。
      //   drop-shadow 在 canvas 上效能差且邊界鋸齒 → 不沿用,改用 contrast 與 imageSmoothing 補回。
      try { ctx.filter = "invert(1) hue-rotate(180deg) contrast(1.3)"; } catch (_) {}
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(srcCanvas, -sw / 2, -sh / 2);
      ctx.restore();
    };
    const _setZoom = (z) => {
      previewState.zoom = Math.max(0.25, Math.min(z, 8));
      if (previewZoom) previewZoom.value = String(previewState.zoom);
      if (previewZoomVal) previewZoomVal.textContent = Math.round(previewState.zoom * 100) + "%";
    };
    const resetView = () => { previewState.offsetX = 0; previewState.offsetY = 0; _setZoom(1); _drawPreview(); };

    const refreshButtons = () => {
      rotBtns.forEach(b => b.classList.toggle("active", parseInt(b.dataset.rot) === curRot));
    };
    rotBtns.forEach(b => {
      b.onclick = () => {
        curRot = parseInt(b.dataset.rot) || 0;
        refreshButtons();
        // 切換角度時順便重置 zoom/pan,避免在歪斜狀態下切角度造成視覺跳動
        resetView();
      };
    });
    refreshButtons();

    // 滾輪 zoom(以滑鼠位置為中心,讓游標下的點維持不動)
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / rect.width;
      // 換算到 canvas 內部像素座標,且以「畫面中心」為原點(對應 _drawPreview 的 translate)
      const cx = (e.clientX - rect.left) * dpr - canvas.width  / 2;
      const cy = (e.clientY - rect.top)  * dpr - canvas.height / 2;
      const factor = (e.deltaY < 0) ? 1.15 : (1 / 1.15);
      const newZoom = Math.max(0.25, Math.min(previewState.zoom * factor, 8));
      const ratio = newZoom / previewState.zoom;
      // 鎖定游標下的點:offset' = c - (c - offset) * ratio
      previewState.offsetX = cx - (cx - previewState.offsetX) * ratio;
      previewState.offsetY = cy - (cy - previewState.offsetY) * ratio;
      _setZoom(newZoom);
      _drawPreview();
    };
    // 左鍵拖曳 = pan
    let panStart = null;
    const onDown = (e) => {
      if (e.button !== 0) return;
      stage.classList.add("panning");
      panStart = { x: e.clientX, y: e.clientY, ox: previewState.offsetX, oy: previewState.offsetY };
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!panStart) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / rect.width;
      previewState.offsetX = panStart.ox + (e.clientX - panStart.x) * dpr;
      previewState.offsetY = panStart.oy + (e.clientY - panStart.y) * dpr;
      _drawPreview();
    };
    const onUp = () => {
      if (!panStart) return;
      panStart = null;
      stage.classList.remove("panning");
    };
    const onDbl = () => { resetView(); };
    const onZoomInput = () => { _setZoom(+previewZoom.value || 1); _drawPreview(); };

    stage.addEventListener("wheel",     onWheel, { passive: false });
    stage.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    stage.addEventListener("dblclick",  onDbl);
    if (previewZoom) previewZoom.addEventListener("input", onZoomInput);

    // 顯示對話框(必須先 active 才有 clientWidth/clientHeight 可量)
    dlg.classList.add("active");
    _resizeVisibleCanvas();
    // 把 drawPreview 畫到一個 offscreen srcCanvas;callers 會在裡面設 canvas.width/height + 繪圖,
    //   但 visible canvas 已被 _resizeVisibleCanvas 占走,所以給它一個全新的 srcCanvas。
    srcCanvas = document.createElement("canvas");
    srcCanvas.width = 1; srcCanvas.height = 1;
    try { await drawPreview(srcCanvas); }
    catch (e) { console.warn("導入預覽失敗:", e); }
    _setZoom(1);
    previewState.offsetX = 0; previewState.offsetY = 0;
    _drawPreview();

    // (顯示對話框已在 _resizeVisibleCanvas 之前完成,這裡不再重複 add)

    const close = (result) => {
      dlg.classList.remove("active");
      okBtn.onclick = null;
      caBtn.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      // 拆掉這次對話框掛在 stage / window / slider 上的 zoom / pan listener,避免下次再開時雙重觸發
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
      stage.removeEventListener("dblclick", onDbl);
      if (previewZoom) previewZoom.removeEventListener("input", onZoomInput);
      stage.classList.remove("panning");
      // 只有在使用者按「確定」時才更新預設;取消不更新
      if (result && result.ok) lastImportRotation = result.rotation || 0;
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close({ ok: false }); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); close({ ok: true, rotation: curRot }); }
      else { e.stopImmediatePropagation(); }   // 阻擋背景的工具熱鍵(Shift+L、Shift+S 等)
    };
    okBtn.onclick = () => close({ ok: true, rotation: curRot });
    caBtn.onclick = () => close({ ok: false });
    document.addEventListener("keydown", onKey, true);   // 用 capture 確保比其他 handler 先收到
  });
}
