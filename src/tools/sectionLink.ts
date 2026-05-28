// 切面關聯(section links)+ 衍生模型(derived sectionLinks)
//
//   • 在當前頁選一條切線(允許多條共線視為一條),跳檔案清單對話框 → 勾選關聯頁面;
//     對應資訊存在 file.sectionLinks,之後可配合 origin / scale / plane / page.z 推算跨頁節點。
//   • 衍生 (autoProp):primary 之外的跨平面 / 平行兄弟 / fallback 都是即時計算,不寫資料。
//   • _populateSectionLinkJointsForFile:relayout / 3D 一鍵處理 第一步呼叫,從其他檔投影
//     joints/members 到本檔的切線上。
//
//   依賴 legacy.ts 的大量 helper(state / DOM / pushUndo / render / joint2DToWorld3D / etc.)
// @ts-nocheck

// 用 named imports → ESM 提供 live binding,即使 legacy.ts 還沒走完 module init,
//   等到函式真正被呼叫時 `$` / `state` / 各 helper 都已就緒。
// 不用 `import * as L` + `const $ = L.$` 解構 — 後者會在 sectionLink.ts module init 當下捕值,
//   此時 legacy.ts 還在 evaluate(circular import),拿到 undefined → ReferenceError。
import {
  $, state, getPage, getActiveFile,
  withBusy, pushUndo, render, refreshLists,
  jointById, fmtCoord, fmtWorld3D, displayJointId,
  findGlobalJointById, setProjectDirty, _t,
  setTool, clearSelection, exitSplitMode, clearAllBgSelection,
  activatePageWithBusy, escapeHtml,
  allocJointId, allocMemberId,
} from "../app/integration";
import { joint2DToWorld3D, world3DToJoint2D } from "../core/projection";

// ---------- 切面關聯 ----------
// 在當前頁選一條切線(允許多條共線視為一條),跳出檔案清單對話框 → 勾選要關聯的其他頁面,
// 對應資訊存在 file.sectionLinks,之後可配合原點 / 比例尺 / 平面 推算跨頁節點。
//
// 注意:這顆 onclick 必須延後到 legacy.ts 跑完 module init(才有 `$`)再綁;
//   不能在 module top-level 直接綁(circular import → TDZ)。
//   legacy.ts 在尾段 call wireSectionLinkButton() 一次完成綁定。
export function wireSectionLinkButton() {
  const btn = $("btnSectionLink");
  if (!btn) return;
  btn.onclick = () => {
    const file = getActiveFile();
    if (!file) { alert("請先載入底圖"); return; }
    // 先退出其他衝突模式(只有 splitMode / clearAllBgSelection / setTool 是 import 進來的;
    //   exitMoveMode / exitManualAlign / exitRangeZoom / exitOriginPending / exitScaleRulerPending /
    //   refreshShapeMarqueeUI 都用 typeof 偵測 — 沒 export 就跳過,行為跟舊版一致)
    if (state.splitMode) exitSplitMode();
    if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
    if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
    if (state.rangeZoomMode && typeof exitRangeZoom === "function") exitRangeZoom();
    if (state.originPending && typeof exitOriginPending === "function") exitOriginPending();
    if (state.scaleRulerPending && typeof exitScaleRulerPending === "function") exitScaleRulerPending();
    clearSelection();
    clearAllBgSelection(file);
    // 記住進入前的工具 → 結束後若原本不在 selectBg 則回去
    state.sectionLinkPending = true;
    state.sectionLinkPrevTool = state.tool;
    // 記住進入前的匡選類型過濾 — 切面期間強制改成「只允許直線」,結束後還原
    state._sectionLinkPrevShapeMarquee = state.bgShapeMarquee ? new Set(state.bgShapeMarquee) : new Set();
    state.bgShapeMarquee = new Set(["straight"]);
    if (typeof refreshShapeMarqueeUI === "function") refreshShapeMarqueeUI();
    if (state.tool !== "selectBg") setTool("selectBg");
    btn.classList.add("active");
    $("hud").textContent = "切面:請選底圖切線(只能選直線・Enter 確認 / Esc 取消)";
    render();
  };
}
// 還原切面 pending 期間覆寫的「只允許直線」匡選過濾(其他直接把 sectionLinkPending=false 的地方也要呼叫)
export function _restoreSectionLinkShapeMarquee() {
  if (state._sectionLinkPrevShapeMarquee) {
    state.bgShapeMarquee = state._sectionLinkPrevShapeMarquee;
    state._sectionLinkPrevShapeMarquee = null;
    if (typeof refreshShapeMarqueeUI === "function") refreshShapeMarqueeUI();
  }
}
export function exitSectionLinkPending(restoreTool) {
  state.sectionLinkPending = false;
  const prev = state.sectionLinkPrevTool;
  state.sectionLinkPrevTool = null;
  $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
  _restoreSectionLinkShapeMarquee();
  if (restoreTool && prev && prev !== "selectBg") setTool(prev);
}
// 畫切線 overlay(pending 期間在 canvas 顯示一條亮色延伸線,方便視覺辨認選到的切線)
// — 省略:沿用既有 bg 選取高亮(#ffd23f hover / #00cc66 selected),使用者已能看到

export async function openSectionLinkDialog(file, repLine) {
  console.log("[切面 dialog open]", file.name,
    "p1=", repLine && repLine.p1, "p2=", repLine && repLine.p2);
  // 前提檢查:源檔必須有平面 + 原點 + 比例尺
  if (!_fileHasFullSetup(file)) {
    alert("此檔需先設定:平面座標(XY/XZ/YZ)、平面原點、比例尺。");
    state.sectionLinkPending = false;
    state.sectionLinkPrevTool = null;
    $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
    _restoreSectionLinkShapeMarquee();
    if (typeof clearAllBgSelection === "function") clearAllBgSelection(file);
    return;
  }
  // 軸向檢查:切線需與 X/Y/Z 軸對齊(由源檔平面映射出的 2D 軸向 → 3D 軸向)
  const axisInfo = _analyzeSectionLineAxis(file, { p1: repLine.p1, p2: repLine.p2 });
  if (!axisInfo) {
    const map = _planeAxisOf2D(file.pages[0].plane);
    alert(`切面線必須與 ${map.x} 軸或 ${map.y} 軸對齊(${file.pages[0].plane} 平面只允許這兩種方向)。\n請重新選一條軸向直線。`);
    state.sectionLinkPending = false;
    state.sectionLinkPrevTool = null;
    $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
    _restoreSectionLinkShapeMarquee();
    if (typeof clearAllBgSelection === "function") clearAllBgSelection(file);
    return;
  }
  const dlg = document.getElementById("sectionLinkDialog");
  const info = document.getElementById("slInfo");
  const list = document.getElementById("slList");
  setupSectionLinkDialogDrag();
  // 每次打開都重置位置為置中(清掉上次拖曳的 inline style)
  const card = dlg.querySelector(".sl-card");
  if (card) {
    // 每次打開:清掉拖曳位置 + 上次 resize 過的尺寸,讓 CSS 預設(80vw × 80vh)生效
    card.style.left = ""; card.style.top = ""; card.style.transform = ""; card.style.position = "";
    card.style.width = ""; card.style.height = "";
  }
  // 已進入對話框階段 → 關掉 pending 旗標,避免全局 Enter listener 再次觸發進入 dialog
  state.sectionLinkPending = false;
  _restoreSectionLinkShapeMarquee();   // 對話框打開即代表「選取階段結束」,還原匡選類型
  // 既有切線關聯(編輯 vs 新增)— 每次簡化為「新增一條」,使用者要編輯可以刪除後重建
  const existingSet = new Set();   // 預先勾選:已關聯的 file ids(此處留白,以後做編輯 UI)
  // 顯示切線資訊
  const len = Math.hypot(repLine.p2.x - repLine.p1.x, repLine.p2.y - repLine.p1.y);
  const scale = file.scaleRuler && file.scaleRuler.ratio ? file.scaleRuler.ratio : null;
  const lenTxt = scale ? `${(len * scale).toFixed(1)} mm` : `${len.toFixed(1)} px`;
  // 切面對應到的目標平面類型:目標平面的「depth 軸」必須等於 cutAxis
  //   = 切面平面(cutAxis = const)正好和該目標平面平行 → 該平面是「切面視圖」
  //   例:cutAxis=X → 目標 = depth=X 的 YZ;cutAxis=Y → 目標 = XZ;cutAxis=Z → 目標 = XY
  //   再排除源檔自己的平面(平行兄弟由 propagation 自動處理,不顯示在 dialog)
  const depthOfPlane = { XY: "Z", XZ: "Y", YZ: "X" };
  const sourcePlane = file.pages[0].plane;
  const compatPlanes = ["XY", "XZ", "YZ"]
    .filter(P => depthOfPlane[P] === axisInfo.cutAxis && P !== sourcePlane);
  info.textContent =
    `當前頁:${file.name}・平面 ${sourcePlane}・cutAxis=${axisInfo.cutAxis}@${axisInfo.cutValue.toFixed(1)}\n` +
    `切線端點:(${repLine.p1.x.toFixed(1)}, ${repLine.p1.y.toFixed(1)}) → (${repLine.p2.x.toFixed(1)}, ${repLine.p2.y.toFixed(1)})・長度 ${lenTxt}\n` +
    `相容的目標平面:${compatPlanes.join(" / ") || "(無)"}・平行兄弟自動關聯不顯示;單選(預設第一筆,點其他列切換;不要關聯按取消 / Esc):`;
  // 候選清單:平面 + 原點 + 比例尺齊全 + 相容平面 + 與源不同平面
  //   排序:平面座標 (XY → XZ → YZ) → 第三軸位置(asc) → 檔名(desc)
  list.innerHTML = "";
  const planeOrder = { XY: 0, XZ: 1, YZ: 2 };
  const candidates = state.files
    .filter(f => f.id !== file.id)
    .filter(f => _fileHasFullSetup(f))
    .filter(f => compatPlanes.indexOf(f.pages[0].plane) >= 0)
    .sort((a, b) => {
      const pa = planeOrder[a.pages[0].plane] ?? 99;
      const pb = planeOrder[b.pages[0].plane] ?? 99;
      if (pa !== pb) return pa - pb;
      const za = (a.pages[0].z != null && Number.isFinite(a.pages[0].z)) ? a.pages[0].z : 0;
      const zb = (b.pages[0].z != null && Number.isFinite(b.pages[0].z)) ? b.pages[0].z : 0;
      if (za !== zb) return za - zb;
      // reverse 檔名(局部排序:由 Z..A)
      return (b.name || "").localeCompare(a.name || "");
    });
  if (candidates.length === 0) {
    list.innerHTML = `<div style="padding:20px;color:#9aa0a6;font-size:11px;text-align:center">沒有可關聯的他平面檔案<br>需要平面是 ${compatPlanes.join(" 或 ") || "(此切線方向無相容平面)"}、且有平面+原點+比例尺</div>`;
  }
  const selected = new Set(existingSet);
  let focusFid = null;   // 目前 preview 中顯示的 file id
  const previewHeader = document.getElementById("slPreviewHeader");
  const previewCanvas = document.getElementById("slPreviewCanvas");
  // Preview 縮放/平移狀態 — 切換檔案時重置
  const previewState = { zoom: 1, offsetX: 0, offsetY: 0 };
  // 已載入的 bg image 快取(同一檔案 wheel zoom 時不重新載)。
  //   srcX/Y/W/H = 影像中要顯示的 sub-rectangle(用於 PDF/Image 對 clipRect 裁切);
  //   SVG 路徑因為已用 viewBox 重渲染,srcRect 等於整個 image。
  let cachedPreviewImg = { fid: null, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };

  const drawPreviewWithZoom = () => {
    if (!previewCanvas) return;
    const ctx = previewCanvas.getContext("2d");
    ctx.fillStyle = "#0d0e10";
    ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    const cached = cachedPreviewImg;
    if (cached && cached.img && cached.srcW > 0 && cached.srcH > 0) {
      const fit = Math.min(previewCanvas.width / cached.srcW, previewCanvas.height / cached.srcH);
      const sc = fit * previewState.zoom;
      const w = cached.srcW * sc, h = cached.srcH * sc;
      const x = (previewCanvas.width  - w) / 2 + previewState.offsetX;
      const y = (previewCanvas.height - h) / 2 + previewState.offsetY;
      if (cached.invert) {
        ctx.save();
        try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
        ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
      }
      console.log(`[slPreview draw fid=${cached.fid}]`, "drawImage OK",
        { src: { sx: Math.round(cached.srcX), sy: Math.round(cached.srcY), sw: Math.round(cached.srcW), sh: Math.round(cached.srcH) },
          dst: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, invert: cached.invert });
    } else {
      console.warn(`[slPreview draw fid=${cached && cached.fid}]`, "fallback text — no image",
        { hasImg: !!(cached && cached.img), srcW: cached && cached.srcW, srcH: cached && cached.srcH });
      const f = state.files.find(x => x.id === focusFid);
      ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText((f && f.name) || "—", previewCanvas.width / 2, previewCanvas.height / 2);
    }
  };

  const loadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

  const updatePreview = async (f) => {
    if (!f || !previewCanvas) return;
    const isNewFile = f.id !== focusFid;
    focusFid = f.id;
    if (isNewFile) {
      previewState.zoom = 1;
      previewState.offsetX = 0;
      previewState.offsetY = 0;
    }
    // 把 canvas 內部 buffer 調到 stage 可用尺寸 × devicePixelRatio(HiDPI 銳利度);
    //   CSS 顯示尺寸用 style 鎖在 css 像素,buffer 維度才是 dpr 倍 → 細節不會糊。
    const stage = previewCanvas.parentElement;
    const cssW = Math.max(100, Math.floor(stage.clientWidth  - 24));
    const cssH = Math.max(80,  Math.floor(stage.clientHeight - 24));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    previewCanvas.style.width  = cssW + "px";
    previewCanvas.style.height = cssH + "px";
    previewCanvas.width  = Math.round(cssW * dpr);
    previewCanvas.height = Math.round(cssH * dpr);
    previewCanvas.style.cursor = cachedPreviewImg.img ? "grab" : "default";
    const pl = (f.pages && f.pages[0] && f.pages[0].plane) || "—";
    const hasScale  = !!(f.scaleRuler && f.scaleRuler.ratio);
    const hasOrigin = !!f.planeOrigin;
    previewHeader.textContent =
      `${f.name}・平面 ${pl}・比例 ${hasScale ? "✓" : "✗"}・原點 ${hasOrigin ? "✓" : "✗"}・滾輪縮放 / 拖曳平移`;
    // 載入(或沿用快取)bg image。
    //   裁切到 clipRect(若有設):preview 會把 user 定義的「圖面範圍」鋪滿 canvas,
    //   不再被原始圖檔留白(PDF/DXF 的 title block 等)主導視覺。
    if (isNewFile || !cachedPreviewImg.img || cachedPreviewImg.fid !== f.id) {
      cachedPreviewImg = { fid: f.id, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };
      const bgW = f.cachedBgWidth  || f.bgWidth  || state.bgWidth  || 1200;
      const bgH = f.cachedBgHeight || f.bgHeight || state.bgHeight || 800;
      const clip = f.clipRect ? { x: f.clipRect.x, y: f.clipRect.y, w: f.clipRect.w, h: f.clipRect.h }
                              : { x: 0, y: 0, w: bgW, h: bgH };
      const ptag = `[slPreview #${f.id} ${f.name}]`;
      console.log(ptag, "start", {
        canvasBuf: { w: previewCanvas.width, h: previewCanvas.height },
        hasBgImg: !!f.cachedBgImg, bgImgLen: (f.cachedBgImg && f.cachedBgImg.length) || 0,
        hasBgSvg: !!f.cachedBgSvg, bgSvgLen: (f.cachedBgSvg && f.cachedBgSvg.length) || 0,
        bgW, bgH, clip, bgImgDarkReady: f.bgImgDarkReady,
      });
      if (f.cachedBgImg) {
        const invert = !f.bgImgDarkReady;
        const img = await loadImg(f.cachedBgImg);
        if (img && cachedPreviewImg.fid === f.id) {
          // image 是 bgWidth × bgHeight 的世界座標的點陣;clipRect 也是世界座標 → 直接比例換到 bitmap
          const sx = Math.max(0, clip.x * img.width  / bgW);
          const sy = Math.max(0, clip.y * img.height / bgH);
          const sw = Math.min(img.width  - sx, clip.w * img.width  / bgW);
          const sh = Math.min(img.height - sy, clip.h * img.height / bgH);
          cachedPreviewImg.img = img;
          cachedPreviewImg.invert = invert;
          cachedPreviewImg.srcX = sx; cachedPreviewImg.srcY = sy;
          cachedPreviewImg.srcW = sw > 0 ? sw : img.width;
          cachedPreviewImg.srcH = sh > 0 ? sh : img.height;
          console.log(ptag, "bgImg loaded", {
            iw: img.width, ih: img.height, sx, sy, sw, sh,
            srcW: cachedPreviewImg.srcW, srcH: cachedPreviewImg.srcH, invert,
          });
        } else {
          console.warn(ptag, "bgImg load failed or stale fid", { hasImg: !!img, curFid: cachedPreviewImg.fid, askedFid: f.id });
        }
      } else if (f.cachedBgSvg) {
        // 用 viewBox 把 SVG 視窗鎖在 clipRect → 渲染出來的 bitmap 已是裁好的;再用高解析度
        //   讓 zoom-in 仍保持銳利。每邊上限 4096 防 OOM。
        const aspect = (clip.w > 0 && clip.h > 0) ? clip.w / clip.h : 1;
        let renderW = Math.min(4096, Math.round(previewCanvas.width  * 4));
        let renderH = Math.round(renderW / aspect);
        if (renderH > 4096) { renderH = 4096; renderW = Math.round(renderH * aspect); }
        let sized = f.cachedBgSvg;
        // 替換 viewBox(無則新增)
        const vb = `${clip.x} ${clip.y} ${clip.w} ${clip.h}`;
        const m_vb = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
        const m_w  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
        const m_h  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
        console.log(ptag, "bgSvg pre-rewrite", {
          origViewBox: m_vb ? m_vb[1] : null, origWidth: m_w ? m_w[1] : null, origHeight: m_h ? m_h[1] : null,
          newViewBox: vb, renderW, renderH, aspect,
        });
        if (/<svg\b[^>]*\sviewBox=/.test(sized)) {
          sized = sized.replace(/(<svg\b[^>]*?\s)viewBox="[^"]*"/, `$1viewBox="${vb}"`);
        } else {
          sized = sized.replace(/<svg\b/, `<svg viewBox="${vb}"`);
        }
        // 替換 width / height(無則新增)
        if (/<svg\b[^>]*\swidth=/.test(sized)) {
          sized = sized.replace(/(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${renderW}"`);
        } else {
          sized = sized.replace(/<svg\b/, `<svg width="${renderW}"`);
        }
        if (/<svg\b[^>]*\sheight=/.test(sized)) {
          sized = sized.replace(/(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${renderH}"`);
        } else {
          sized = sized.replace(/<svg\b/, `<svg height="${renderH}"`);
        }
        // 拿掉根 svg 上 inline style 裡會干擾離線渲染的 css(width/height/clip-path/position 等)— in-page 渲染用,SVG-to-Image 時會覆蓋我們改的屬性
        sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
          const cleaned = style
            .replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
            .replace(/;{2,}/g, ";")
            .replace(/^;|;$/g, "")
            .trim();
          return cleaned ? `${head} style="${cleaned}"` : head;
        });
        const m_vb2 = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
        const m_w2  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
        const m_h2  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
        const m_st2 = sized.match(/<svg\b[^>]*\sstyle="([^"]+)"/);
        console.log(ptag, "bgSvg post-rewrite", {
          viewBox: m_vb2 ? m_vb2[1] : null, width: m_w2 ? m_w2[1] : null, height: m_h2 ? m_h2[1] : null,
          style: m_st2 ? m_st2[1] : null,
          sizedLen: sized.length,
        });
        const blob = new Blob([sized], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        try {
          const img = await loadImg(url);
          console.log(ptag, "bgSvg image load result", { hasImg: !!img, iw: img && img.width, ih: img && img.height, curFid: cachedPreviewImg.fid, askedFid: f.id });
          if (img && cachedPreviewImg.fid === f.id) {
            cachedPreviewImg.img = img;
            cachedPreviewImg.invert = true;
            cachedPreviewImg.srcX = 0; cachedPreviewImg.srcY = 0;
            cachedPreviewImg.srcW = img.width; cachedPreviewImg.srcH = img.height;
          }
        } finally { URL.revokeObjectURL(url); }
      } else {
        console.warn(ptag, "no bg cache (cachedBgImg / cachedBgSvg both empty)");
      }
    }
    if (cachedPreviewImg.img) previewCanvas.style.cursor = "grab";
    drawPreviewWithZoom();
  };

  // 滾輪縮放 — 以游標位置為 anchor,範圍 [0.2x, 20x]
  const onPreviewWheel = (ev) => {
    ev.preventDefault();
    if (!cachedPreviewImg.img) return;
    const rect = previewCanvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * (previewCanvas.width  / rect.width);
    const sy = (ev.clientY - rect.top)  * (previewCanvas.height / rect.height);
    const cx = previewCanvas.width / 2, cy = previewCanvas.height / 2;
    const oldZoom = previewState.zoom;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const newZoom = Math.max(0.2, Math.min(20, oldZoom * factor));
    if (newZoom === oldZoom) return;
    // 把游標下的影像點固定:cursor → image-coord 不變
    previewState.offsetX = sx - cx - (newZoom / oldZoom) * (sx - cx - previewState.offsetX);
    previewState.offsetY = sy - cy - (newZoom / oldZoom) * (sy - cy - previewState.offsetY);
    previewState.zoom = newZoom;
    drawPreviewWithZoom();
  };
  previewCanvas.addEventListener("wheel", onPreviewWheel, { passive: false });

  // 拖曳平移 — 左鍵按下開始,window 監聽 mousemove/mouseup 讓拖出 canvas 也持續有效
  let panDrag = null;
  const onPreviewMouseDown = (ev) => {
    if (ev.button !== 0) return;
    if (!cachedPreviewImg.img) return;
    panDrag = {
      startX: ev.clientX, startY: ev.clientY,
      startOffsetX: previewState.offsetX,
      startOffsetY: previewState.offsetY,
    };
    previewCanvas.style.cursor = "grabbing";
    ev.preventDefault();
  };
  const onPreviewMouseMove = (ev) => {
    if (!panDrag) return;
    const rect = previewCanvas.getBoundingClientRect();
    const sx = previewCanvas.width  / rect.width;
    const sy = previewCanvas.height / rect.height;
    previewState.offsetX = panDrag.startOffsetX + (ev.clientX - panDrag.startX) * sx;
    previewState.offsetY = panDrag.startOffsetY + (ev.clientY - panDrag.startY) * sy;
    drawPreviewWithZoom();
  };
  const onPreviewMouseUp = () => {
    if (!panDrag) return;
    panDrag = null;
    if (cachedPreviewImg.img) previewCanvas.style.cursor = "grab";
  };
  previewCanvas.addEventListener("mousedown", onPreviewMouseDown);
  window.addEventListener("mousemove", onPreviewMouseMove);
  window.addEventListener("mouseup",   onPreviewMouseUp);

  // 對話框拉伸時也重繪 preview(監看 card 的 resize,debounce)
  let _previewResizeTimer = null;
  const previewResizeObs = new ResizeObserver(() => {
    if (_previewResizeTimer) clearTimeout(_previewResizeTimer);
    _previewResizeTimer = setTimeout(() => {
      const f = state.files.find(x => x.id === focusFid);
      if (f) updatePreview(f);
    }, 120);
  });
  previewResizeObs.observe(card);

  // 重新命名單一檔案 — 直接在列內把 .sl-name 轉成 input,不彈外部對話框。
  //   Enter / blur 提交,Esc 取消;名稱重複 → alert 並還原。
  const triggerRename = (g, nameEl) => {
    if (!nameEl) return;
    if (nameEl.querySelector("input")) return;     // 已在編輯中,避免重入
    const oldText = g.name;
    const input = document.createElement("input");
    input.type = "text";
    input.value = oldText;
    Object.assign(input.style, {
      width: "100%", boxSizing: "border-box",
      fontSize: "12px", color: "#ddd",
      background: "#1a1c20",
      border: "1px solid #4f9dff", borderRadius: "2px",
      padding: "1px 4px", outline: "none",
    });
    nameEl.textContent = "";
    nameEl.appendChild(input);
    // 防止 input 上的點擊冒泡到列(避免觸發 selection toggle)
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click",     (e) => e.stopPropagation());
    input.addEventListener("dblclick",  (e) => e.stopPropagation());
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const newName = (input.value || "").trim();
      try { nameEl.removeChild(input); } catch (_) {}
      if (!commit || !newName || newName === oldText) {
        nameEl.textContent = oldText;
        return;
      }
      if (state.files.some(x => x.id !== g.id && x.name === newName)) {
        alert("名稱已存在,不可重複");
        nameEl.textContent = oldText;
        return;
      }
      pushUndo();
      g.name = newName;
      nameEl.textContent = newName;
      if (typeof refreshFileList === "function") refreshFileList();
      if (typeof refreshPageSelector === "function") refreshPageSelector();
      if (focusFid === g.id && previewHeader) {
        const pl = (g.pages && g.pages[0] && g.pages[0].plane) || "—";
        const hasScale  = !!(g.scaleRuler && g.scaleRuler.ratio);
        const hasOrigin = !!g.planeOrigin;
        previewHeader.textContent =
          `${g.name}・平面 ${pl}・比例 ${hasScale ? "✓" : "✗"}・原點 ${hasOrigin ? "✓" : "✗"}・滾輪縮放 / 拖曳平移`;
      }
    };
    input.addEventListener("keydown", (e) => {
      // 阻擋 dialog onKey 的 Esc/Enter 關閉;dialog 那邊也已加上 INPUT/TEXTAREA 旁路,但這裡再保險
      e.stopPropagation();
      if (e.key === "Enter")  { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  };

  // 建立一列;dblclick 名稱 / 對列右鍵都可重新命名
  const buildRow = (g) => {
    const row = document.createElement("div");
    row.className = "sl-row" + (selected.has(g.id) ? " on" : "");
    row.dataset.fid = String(g.id);
    const pl = g.pages[0].plane;
    const depthAxis = (pl === "XY") ? "Z" : (pl === "XZ") ? "Y" : "X";
    const z = g.pages[0].z;
    const zTxt = (z != null && Number.isFinite(z)) ? z.toFixed(0) : "—";
    const meta = `${pl}・${depthAxis}=${zTxt}`;
    row.innerHTML = `
      <canvas class="sl-thumb" width="56" height="42"></canvas>
      <div class="sl-row-body">
        <div class="sl-name" title="雙擊或對列右鍵可重新命名">${escapeHtml(g.name)}</div>
        <div class="sl-meta">${meta}</div>
      </div>
      <button class="sl-dup" title="複製此檔案(直接複製,新副本以新列出現;改名請對列雙擊或右鍵)">複製</button>
    `;
    // 點列 = 切換選擇到本列(無法反選;預設已有第一筆。要不關聯任何目標 → 按取消 / Esc)
    //   detail≥2(double-click 第二次)忽略避免 rename 時 selection 抖動
    row.addEventListener("click", (e) => {
      if (e.detail >= 2) return;
      if (e.target && e.target.classList.contains("sl-dup")) return;
      selected.clear();
      list.querySelectorAll(".sl-row").forEach(r => r.classList.remove("on"));
      selected.add(g.id);
      row.classList.add("on");
      list.querySelectorAll(".sl-row.focus").forEach(r => r.classList.remove("focus"));
      row.classList.add("focus");
      updatePreview(g);
    });
    // 雙擊檔名 → 重新命名
    const nameEl = row.querySelector(".sl-name");
    nameEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      triggerRename(g, nameEl);
    });
    // 對列右鍵 → 跳出小選單(重新命名 / 刪除)
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 點到右鍵也視為選中該列(同 click 邏輯)
      selected.clear();
      list.querySelectorAll(".sl-row").forEach(r => r.classList.remove("on"));
      selected.add(g.id);
      row.classList.add("on");
      list.querySelectorAll(".sl-row.focus").forEach(r => r.classList.remove("focus"));
      row.classList.add("focus");
      updatePreview(g);
      _showSlRowCtxMenu(e.clientX, e.clientY, g, nameEl, row);
    });
    // 複製按鈕:直接 duplicate;新副本以新一列加到清單末端 + 焦點移過去顯示 preview。
    //   不彈第三軸對話框、不彈 rename 對話框 — 改名請對新列雙擊或右鍵。
    const dupBtn = row.querySelector(".sl-dup");
    dupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof duplicateFileById !== "function") return;
      const clone = duplicateFileById(g.id, { activate: false });
      if (!clone) return;
      const newRow = buildRow(clone);
      list.appendChild(newRow);
      newRow.scrollIntoView({ block: "nearest" });
      list.querySelectorAll(".sl-row.focus").forEach(r => r.classList.remove("focus"));
      newRow.classList.add("focus");
      updatePreview(clone);
    });
    // 延遲繪製列表縮圖
    const thumb = row.querySelector(".sl-thumb");
    setTimeout(() => { renderFileThumb(thumb, g).catch(err => console.warn("[thumb]", err)); }, 0);
    return row;
  };

  for (const f of candidates) list.appendChild(buildRow(f));
  // 預設選擇第一筆候選並把 preview 拉到該檔(單選不可反選;不要的話按取消 / Esc)
  if (candidates.length) {
    const first = candidates[0];
    selected.clear();
    selected.add(first.id);
    const firstRow = list.querySelector(`.sl-row[data-fid="${first.id}"]`);
    if (firstRow) {
      firstRow.classList.add("on");
      firstRow.classList.add("focus");
    }
    setTimeout(() => updatePreview(first), 0);
  }
  // Buttons
  const okBtn = document.getElementById("slOkBtn");
  const cancelBtn = document.getElementById("slCancelBtn");
  const closeBtn = document.querySelector("#sectionLinkDialog .sl-close");
  const cleanup = (ok) => {
    console.log("[切面 dialog close]", "ok=", ok,
      "selected targets:", ok ? Array.from(selected) : "(cancelled)");
    _hideSlCtxMenu();
    dlg.classList.remove("active");
    document.removeEventListener("keydown", onKey, true);
    if (previewResizeObs) previewResizeObs.disconnect();
    if (previewCanvas) {
      previewCanvas.removeEventListener("wheel", onPreviewWheel);
      previewCanvas.removeEventListener("mousedown", onPreviewMouseDown);
      previewCanvas.style.cursor = "";
    }
    window.removeEventListener("mousemove", onPreviewMouseMove);
    window.removeEventListener("mouseup",   onPreviewMouseUp);
    clearAllBgSelection(file);
    if (ok) {
      // 直接用選到的 bg 線端點做標示;不再進入手動定位流程
      // 箭頭尖端 = 兩端點中較靠近 bg 中心的那個(讓箭頭指向圖面內部)
      const prevTool = state.sectionLinkPrevTool;
      state.sectionLinkPending = false;
      state.sectionLinkPrevTool = null;
      $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
      const bounds = _getPageBoundsForFile(file);
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      const d1 = Math.hypot(repLine.p1.x - cx, repLine.p1.y - cy);
      const d2 = Math.hypot(repLine.p2.x - cx, repLine.p2.y - cy);
      let tip, tail;
      if (d1 <= d2) { tip = repLine.p1; tail = repLine.p2; }
      else          { tip = repLine.p2; tail = repLine.p1; }
      saveSectionLink(file, { p1: tip, p2: tail }, Array.from(selected));
      // 校復原本工具(若原本不是 selectBg)
      if (prevTool && prevTool !== "selectBg" && prevTool !== state.tool) setTool(prevTool);
    } else {
      exitSectionLinkPending(true);
    }
    render();
  };
  // 對 focus 的列做刪除(從清單 + state.files 一起拿掉),共用給 Delete key / 右鍵選單
  const _deleteSlRow = (g, row) => {
    if (!g) return;
    const fid = g.id;
    if (!confirm(`刪除檔案「${g.name}」?\n此動作會一併移除其所有標線、比例尺、原點等資料。`)) return;
    // 沿用既有的 deleteSelectedFiles(處理依賴檔轉移 / 主檔切換 / refresh 等)
    const prev = new Set(state.selection.fileIds);
    state.selection.fileIds.clear();
    state.selection.fileIds.add(fid);
    deleteSelectedFiles();
    state.selection.fileIds = prev;          // 還原原本的選取
    state.selection.fileIds.delete(fid);     // 但被刪的不在了
    // 從 dialog 清單拿掉這列
    const r = row || list.querySelector(`.sl-row[data-fid="${fid}"]`);
    if (r) r.remove();
    if (selected.has(fid)) selected.delete(fid);
    // 若還有列,把 focus / preview 移到下一筆;若清單空了,清掉 preview header
    const remain = list.querySelectorAll(".sl-row");
    if (remain.length) {
      list.querySelectorAll(".sl-row.focus, .sl-row.on").forEach(x => x.classList.remove("focus", "on"));
      const next = remain[0];
      next.classList.add("on", "focus");
      const nextFid = Number(next.dataset.fid);
      const nextFile = state.files.find(f => f.id === nextFid);
      if (nextFile) { selected.clear(); selected.add(nextFid); updatePreview(nextFile); }
    } else {
      previewHeader && (previewHeader.textContent = "預覽(沒有候選檔案)");
      // 清掉 preview canvas 內容
      if (previewCanvas) {
        const ctx = previewCanvas.getContext("2d");
        ctx.fillStyle = "#0d0e10";
        ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
      }
    }
  };
  // 右鍵小選單(重新命名 / 刪除)— 點外面才關;點進選單裡的選項由選項自己 click handler 收掉。
  let _slCtxMenu = null;
  let _slCtxOutsideHandler = null;
  const _hideSlCtxMenu = () => {
    if (_slCtxMenu) { try { _slCtxMenu.remove(); } catch (_) {} _slCtxMenu = null; }
    if (_slCtxOutsideHandler) {
      document.removeEventListener("mousedown", _slCtxOutsideHandler, true);
      _slCtxOutsideHandler = null;
    }
  };
  const _showSlRowCtxMenu = (x, y, g, nameEl, row) => {
    _hideSlCtxMenu();
    const m = document.createElement("div");
    m.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:4000;background:#1c1d20;border:1px solid #444;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.5);padding:4px;min-width:120px;font-size:12px;`;
    const mkBtn = (label, onClick, danger) => {
      const b = document.createElement("div");
      b.textContent = label;
      b.style.cssText = `padding:6px 10px;cursor:pointer;border-radius:3px;color:${danger ? "#ff7788" : "#ddd"};`;
      b.addEventListener("mouseenter", () => { b.style.background = danger ? "#3a1a1a" : "#2a2c30"; });
      b.addEventListener("mouseleave", () => { b.style.background = "transparent"; });
      // 用 mousedown 而非 click,因為外面 dismiss listener 也是 mousedown(capture)— 我們在裡面要先 stopPropagation
      b.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        _hideSlCtxMenu();
        // 用 setTimeout 把實際動作推遲到此 mousedown event loop 之外,避免跟正在收掉的 listener 互卡
        setTimeout(() => { try { onClick(); } catch (err) { console.error("[sl ctx]", err); } }, 0);
      });
      return b;
    };
    m.appendChild(mkBtn("重新命名", () => triggerRename(g, nameEl)));
    m.appendChild(mkBtn("刪除", () => _deleteSlRow(g, row), true));
    document.body.appendChild(m);
    _slCtxMenu = m;
    // outside-click dismiss:capture 階段判斷 target 是否在 menu 內,在內就放行交給選項自己處理
    _slCtxOutsideHandler = (ev) => {
      if (_slCtxMenu && _slCtxMenu.contains(ev.target)) return;
      _hideSlCtxMenu();
    };
    // 推遲一個 tick 才 attach,避免捕到觸發本選單的 contextmenu/click 餘波
    setTimeout(() => {
      if (_slCtxOutsideHandler) document.addEventListener("mousedown", _slCtxOutsideHandler, true);
    }, 0);
    // 確保不超出視窗
    const rect = m.getBoundingClientRect();
    if (rect.right > window.innerWidth)  m.style.left = (window.innerWidth - rect.width - 4) + "px";
    if (rect.bottom > window.innerHeight) m.style.top  = (window.innerHeight - rect.height - 4) + "px";
  };
  const onKey = (e) => {
    // 編輯名稱中(列內 input)→ 不要把 Esc/Enter 當成關閉/確認 dialog;讓 input 自己處理
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); _hideSlCtxMenu(); cleanup(false); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); cleanup(true); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      // 刪除目前 focus 的列;Delete + Backspace 都接(Mac 鍵盤 Backspace 較常用)
      e.preventDefault(); e.stopImmediatePropagation();
      const focusRow = list.querySelector(".sl-row.focus");
      const fid = focusRow ? Number(focusRow.dataset.fid) : null;
      const g = fid != null ? state.files.find(f => f.id === fid) : null;
      if (g) _deleteSlRow(g, focusRow);
    }
    else { e.stopImmediatePropagation(); }
  };
  okBtn.onclick = () => cleanup(true);
  cancelBtn.onclick = () => cleanup(false);
  if (closeBtn) closeBtn.onclick = () => cleanup(false);
  document.addEventListener("keydown", onKey, true);
  dlg.classList.add("active");
}
export function saveSectionLink(file, repLine, targetIds) {
  // 防呆:本頁若是「純跨平面衍生頁」(看得到任何 cross-plane derivation,而本身沒有任何 primary),
  //   就「不在本頁建 primary」,改成「更新源檔 primary 的 cut + p1/p2 + 合併新 targets」。
  //   結果:本頁仍維持衍生視圖,但因為源頭 cut 改了,本頁衍生線會自動移到使用者新畫的位置。
  //   只有當本頁已經有自己的 primary 時,這條規則放行,改走原本的同源同 cut 覆蓋邏輯。
  const probeEntry = { p1: repLine.p1, p2: repLine.p2 };
  const probeAxis = _analyzeSectionLineAxis(file, probeEntry);
  const fileHasOwnPrimary = Array.isArray(file.sectionLinks) && file.sectionLinks.some(e => !e.autoProp);
  const existingOnFile = (typeof _deriveSectionLinksFor === "function") ? _deriveSectionLinksFor(file) : [];
  const crossPlaneDerivs = existingOnFile.filter(e => e && e.autoProp && e.crossPlane);
  console.log("[切面 probe] file=", file.name, "probeAxis=", probeAxis,
    "fileHasOwnPrimary=", fileHasOwnPrimary,
    "crossPlaneDerivs(count)=", crossPlaneDerivs.length,
    "crossPlaneDerivs=", crossPlaneDerivs.map(e => ({ groupId: e.groupId, cutAxis: e.cutAxis, cutValue: e.cutValue })));
  if (crossPlaneDerivs.length && !fileHasOwnPrimary) {
    // 本頁是純跨平面衍生頁 → 不建 primary,只把使用者選的 target 檔案「第三軸位置(page.z)」更新到新切線的 cutValue。
    //   幾何意義:使用者在衍生視圖上拖到新位置,意思是「我要把這個 target 頁移到這個 cut」 → 改 target 的 z。
    //   只更新 target.plane 的 depth 軸 == probeAxis.cutAxis 的 target(其它 plane 不適用,跳過)。
    if (!probeAxis || !probeAxis.cutAxis || !Number.isFinite(probeAxis.cutValue)) {
      console.log("[切面] 衍生頁:切線非軸向,無法更新 target 第三軸");
      $("hud").textContent = "本頁是衍生頁・切線非軸向,無法更新 target 第三軸位置";
      return;
    }
    const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    const newZ = Math.round(probeAxis.cutValue * factor) / factor;
    const zUpdates = [];
    const skipped = [];
    for (const tid of (targetIds || [])) {
      if (tid == null) continue;
      const tf = state.files.find(f => f.id === tid);
      if (!tf) { skipped.push({ tid, reason: "target file 不存在" }); continue; }
      const tp = tf.pages && tf.pages[0];
      if (!tp || !tp.plane) { skipped.push({ name: tf.name, reason: "target 沒設 plane" }); continue; }
      if (depthOf[tp.plane] !== probeAxis.cutAxis) {
        skipped.push({ name: tf.name, plane: tp.plane, reason: `target 平面 ${tp.plane} 的 depth 軸不是 ${probeAxis.cutAxis}` });
        continue;
      }
      if (tp.z === newZ) { skipped.push({ name: tf.name, reason: `已在 ${probeAxis.cutAxis}=${newZ},無變更` }); continue; }
      zUpdates.push({ tf, name: tf.name, plane: tp.plane, oldZ: tp.z, newZ });
    }
    if (zUpdates.length) {
      pushUndo();
      for (const u of zUpdates) u.tf.pages[0].z = u.newZ;
    }
    console.log("[切面] 衍生頁・更新 target 第三軸位置:", {
      file: { id: file.id, name: file.name },
      probe: probeAxis, newZ,
      updated: zUpdates.map(u => ({ name: u.name, plane: u.plane, oldZ: u.oldZ, newZ: u.newZ })),
      skipped,
    });
    if (zUpdates.length === 0) {
      $("hud").textContent = `本頁是衍生頁・${probeAxis.cutAxis}=${newZ}・所選 target 沒有可更新的(平面/已在位置)`;
      return;
    }
    const names = zUpdates.map(u => `${u.name}(${u.plane}・${probeAxis.cutAxis}=${u.newZ})`).join(", ");
    $("hud").textContent = `本頁是衍生頁・更新 ${zUpdates.length} 個 target 第三軸位置:${names}`;
    if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
    if (typeof refreshFileList === "function") refreshFileList();
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
    render && render();
    return;
  }
  pushUndo();   // 先捕捉舊狀態,Ctrl+Z 可回溯
  if (!file.sectionLinks) file.sectionLinks = [];
  // ── 主關聯去重 ──
  //   設計信念:同一個源檔對「同一個目標平面(= 同 cutAxis)」只應該有一條主關聯。
  //   作法:
  //     • 已存在同 cutAxis 的主關聯 → *不要* 建新 primary、*不要* 動既有 primary,只更新使用者
  //       這次挑選的目標檔 page.z 到新 cutValue;UI 上等同「重複關聯切面線只更新第三軸」。
  //     • 不存在同 cutAxis 的主關聯 → 走原本流程建 primary,並按下方 (b) 規則去掉跨檔重複 target。
  //   衍生(autoProp)永遠不動;跨平面 cut 全域唯一性由前面的「跨平面衍生 → 拒絕成 primary」防呆隱性保證。
  const existingSameAxisPrimary = (probeAxis && probeAxis.cutAxis)
    ? file.sectionLinks.find(e => !e.autoProp && e.cutAxis === probeAxis.cutAxis)
    : null;
  if (existingSameAxisPrimary && probeAxis && Number.isFinite(probeAxis.cutValue)) {
    // 早返:只更新使用者挑的目標檔 page.z,主關聯保持原狀
    const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    const newZ = Math.round(probeAxis.cutValue * factor) / factor;
    const zUpdates = [];
    for (const tid of (targetIds || [])) {
      const tf = state.files.find(x => x.id === tid);
      if (!tf || !tf.pages) continue;
      const tp = tf.pages[0];
      if (!tp || !tp.plane) continue;
      if (depthOf[tp.plane] !== probeAxis.cutAxis) continue;
      if (tp.z === newZ) continue;
      const oldZ = tp.z;
      tp.z = newZ;
      zUpdates.push({ name: tf.name, plane: tp.plane, oldZ, newZ });
    }
    console.log(`[切面] 已存在 ${probeAxis.cutAxis} 軸主關聯 #${existingSameAxisPrimary.id} → 只更新 ${zUpdates.length} 個目標檔 page.z=${newZ}`, zUpdates);
    if ($("hud")) {
      $("hud").textContent = `已存在 ${probeAxis.cutAxis} 軸主關聯(${file.name} #${existingSameAxisPrimary.id})→ 只更新 ${zUpdates.length} 個目標頁面 ${probeAxis.cutAxis}=${newZ}(主關聯未動)`;
    }
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
    if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
    if (typeof refreshLists === "function") refreshLists();
    if (typeof render === "function") render();
    return;
  }
  const overrideSummary = [];
  // (b) target 級別:跨檔掃過一遍。任一其他檔的 primary targetFileIds 含到 newTargets 的 id,
  //     就把該 id 從那條移掉;移到空就連 entry 一起刪。
  //     (本檔自己若有同 cutAxis 主關聯,前面早返,不會走到這裡;有不同 cutAxis 則理應並存,不必去重。)
  const newTargets = new Set((targetIds || []).filter(x => x != null));
  if (newTargets.size) {
    for (const f of state.files) {
      if (f.id === file.id) continue;       // file 本身的同 cutAxis 主關聯前面早返處理過了
      if (!f.sectionLinks || !f.sectionLinks.length) continue;
      const keep = [];
      for (const e of f.sectionLinks) {
        if (e.autoProp || !Array.isArray(e.targetFileIds)) { keep.push(e); continue; }
        const before = e.targetFileIds.slice();
        const after = before.filter(t => !newTargets.has(t));
        const dropped = before.filter(t => newTargets.has(t));
        if (dropped.length) {
          e.targetFileIds = after;
          if (after.length === 0) {
            overrideSummary.push({ host: f.name, entryId: e.id, action: "remove-entry", droppedTargets: dropped });
          } else {
            overrideSummary.push({ host: f.name, entryId: e.id, action: "trim-targets", droppedTargets: dropped, remaining: after.slice() });
            keep.push(e);
          }
        } else {
          keep.push(e);
        }
      }
      if (keep.length !== f.sectionLinks.length) f.sectionLinks = keep;
    }
  }
  if (overrideSummary.length) console.log("[切面] 主關聯覆蓋舊紀錄:", overrideSummary);
  const groupId = `sl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id: (file._nextSectionLinkId || 1),
    groupId,                         // 跨檔共用識別,同一條切線在各頁的 entry 共享此 id
    p1: { x: repLine.p1.x, y: repLine.p1.y },
    p2: { x: repLine.p2.x, y: repLine.p2.y },
    targetFileIds: targetIds.slice(),
    createdAt: Date.now(),
  };
  // 紀錄 cutAxis / cutValue(若軸向)讓未來判定快一點
  const axisInfo = _analyzeSectionLineAxis(file, entry);
  if (axisInfo) {
    entry.cutAxis = axisInfo.cutAxis;
    entry.cutValue = axisInfo.cutValue;
  }
  file._nextSectionLinkId = entry.id + 1;
  file.sectionLinks.push(entry);
  // 衍生模型:不再寫入其他檔案,所有目標平面的切面線在 render 時即時推算

  // 同步目標檔的 page.z:被勾選的目標,其平面 depth = cutAxis(dialog 已過濾),
  //   理應在 cutValue 這個切面位置上 → page.z 為 null 或不同就直接覆寫。
  //   寫入值會依 state.coordDecimals 四捨五入(跟其他座標顯示一致)。
  //   使用者要能 Ctrl+Z 回滾(已在開頭 pushUndo)。
  const zUpdates = [];
  let newZ = null;
  if (entry.cutAxis && Number.isFinite(entry.cutValue)) {
    const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    newZ = Math.round(entry.cutValue * factor) / factor;
    for (const tid of (targetIds || [])) {
      const tf = state.files.find(f => f.id === tid);
      if (!tf) continue;
      const tp = tf.pages && tf.pages[0];
      if (!tp || !tp.plane) continue;
      if (depthOf[tp.plane] !== entry.cutAxis) continue;
      if (tp.z === newZ) continue;
      const oldZ = tp.z;
      tp.z = newZ;
      zUpdates.push({ name: tf.name, plane: tp.plane, oldZ, newZ });
    }
  }
  if (zUpdates.length) {
    console.log(`[切面] 同步目標檔 page.z (${entry.cutAxis}=${newZ}):`, zUpdates);
    // 若 active file 是其中之一,刷新右欄座標 UI
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  }

  console.log(`[切面關聯] ${file.name} #${entry.id} group=${groupId}` +
    (entry.cutAxis ? `・cutAxis=${entry.cutAxis} cutValue=${entry.cutValue}` : "") +
    (zUpdates.length ? `・同步 ${zUpdates.length} 個目標檔的 page.z=${newZ}` : "") +
    (overrideSummary.length ? `・覆蓋舊主關聯 ${overrideSummary.length} 條` : ""));
  const zMsg = zUpdates.length ? `・同步 ${zUpdates.length} 個目標檔 ${entry.cutAxis}=${newZ}` : "";
  const ovMsg = overrideSummary.length ? `・覆蓋舊主關聯 ${overrideSummary.length}` : "";
  $("hud").textContent = `已加入切面 #${entry.id}(${file.name})${zMsg}${ovMsg}`;
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  // 主關聯 badge 在檔案清單顯示 → 新增 / 覆蓋後同步刷新
  if (typeof refreshFileList === "function") refreshFileList();
}

// 取得檔案的頁面範圍(clipRect 優先,否則整張底圖):用世界 / 2D 座標(跟 sectionLink p1/p2 同系)
export function _getPageBoundsForFile(file) {
  if (file && file.clipRect) {
    return { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h };
  }
  const bw = (file && file.bgWidth)  ? file.bgWidth  : (state.bgWidth  || 1200);
  const bh = (file && file.bgHeight) ? file.bgHeight : (state.bgHeight || 800);
  return { x: 0, y: 0, w: bw, h: bh };
}
// 計算「外圍共軸標示線」:給定 bg 線端點 lp1, lp2 與檔案 file,回傳一個位於 bg 範圍外、
//   與 lp1-lp2 共軸、箭頭指向 bg 內部的標示線 { p1: 箭頭尖端(靠近 bg 邊),p2: 箭頭尾端(往外延伸) }
//   做法:
//     1. 算無限延伸線通過 bg 兩個邊界交點(slab method)
//     2. 判斷哪一個交點是「往外」(從 bg center 出發、沿 lp 線方向走、離 bg 中心較遠那一邊)
//     3. tip = 該邊界交點 + 小 gap 出 bg
//     4. tail = tip + markerLen 沿 outward 方向
export function _computeOutsideMarkerLine(file, lp1, lp2) {
  if (!lp1 || !lp2) return null;
  const bounds = _getPageBoundsForFile(file);
  const dxL = lp2.x - lp1.x, dyL = lp2.y - lp1.y;
  const len = Math.hypot(dxL, dyL);
  if (len < 1e-9) return null;
  const ux = dxL / len, uy = dyL / len;
  // 參數線:P(t) = lp1 + t * (ux, uy)
  // 找 P(t) 落在 bg 邊界內的 t 範圍 [tLo, tHi]
  let tLo = -Infinity, tHi = Infinity;
  if (Math.abs(ux) > 1e-9) {
    const t1 = (bounds.x - lp1.x) / ux;
    const t2 = (bounds.x + bounds.w - lp1.x) / ux;
    tLo = Math.max(tLo, Math.min(t1, t2));
    tHi = Math.min(tHi, Math.max(t1, t2));
  } else if (lp1.x < bounds.x || lp1.x > bounds.x + bounds.w) return null;
  if (Math.abs(uy) > 1e-9) {
    const t1 = (bounds.y - lp1.y) / uy;
    const t2 = (bounds.y + bounds.h - lp1.y) / uy;
    tLo = Math.max(tLo, Math.min(t1, t2));
    tHi = Math.min(tHi, Math.max(t1, t2));
  } else if (lp1.y < bounds.y || lp1.y > bounds.y + bounds.h) return null;
  if (tLo > tHi) return null;
  // 兩個 bg 邊界交點 P(tLo), P(tHi);分別判斷它們落在哪條邊上
  //   邊優先級:left(4) > top(3) > bottom(2) > right(1)。優先放左方,其次上方。
  const ptLo = { x: lp1.x + tLo * ux, y: lp1.y + tLo * uy };
  const ptHi = { x: lp1.x + tHi * ux, y: lp1.y + tHi * uy };
  const _edgePri = (pt) => {
    const tol = Math.max(0.5, Math.min(bounds.w, bounds.h) * 1e-4);
    if (Math.abs(pt.x - bounds.x) < tol) return 4;             // left
    if (Math.abs(pt.y - bounds.y) < tol) return 3;             // top
    if (Math.abs(pt.y - (bounds.y + bounds.h)) < tol) return 2; // bottom
    if (Math.abs(pt.x - (bounds.x + bounds.w)) < tol) return 1; // right
    return 0;
  };
  const prLo = _edgePri(ptLo);
  const prHi = _edgePri(ptHi);
  const useLo = prLo > prHi;
  const tEdge = useLo ? tLo : tHi;
  const sign  = useLo ? -1 : 1;        // tLo 一側往 -t 出去;tHi 一側往 +t 出去
  const edgeX = lp1.x + tEdge * ux;
  const edgeY = lp1.y + tEdge * uy;
  // 標示線長度:bg 短邊 10%(原為 20%,縮短一半讓四周箭頭不那麼搶眼);與 bg 邊緣的 gap = 短邊 2%
  const shortSide = Math.min(bounds.w, bounds.h);
  const markerLen = shortSide * 0.10;
  const gap = shortSide * 0.02;
  const tip  = { x: edgeX + sign * ux * gap,                   y: edgeY + sign * uy * gap };
  const tail = { x: tip.x + sign * ux * markerLen,             y: tip.y + sign * uy * markerLen };
  return { p1: tip, p2: tail };
}

// 把同一個檔案內幾何重疊的 sectionLink(p1/p2 接近)合併:回傳 [{ rep, allTargets:Set, allEntries:[] }]
//   render 用這個結果畫:同一條切面只畫 1 個箭頭,標籤合併所有目標檔名(逗號連接)
export function _getMergedSectionLinks(af) {
  if (!af) return [];
  // 衍生模型:從所有 primaries(包含 af 自己 + 其他檔)即時計算 af 上應顯示的 entries
  const entries = _deriveSectionLinksFor(af);
  if (!entries.length) return [];
  const seen = new Map();
  for (const sl of entries) {
    if (!sl.p1 || !sl.p2) continue;
    // key = 兩端點(整數座標,正規化方向)+ groupId
    //   不同 group 的 entry 即使幾何重疊也不該合併標籤,以免 user 新建的關聯與舊 group 的目標串在一起
    const a = `${Math.round(sl.p1.x)},${Math.round(sl.p1.y)}`;
    const b = `${Math.round(sl.p2.x)},${Math.round(sl.p2.y)}`;
    const coords = a < b ? `${a}|${b}` : `${b}|${a}`;
    const key = `${sl.groupId || "_nogroup_"}::${coords}`;
    let g = seen.get(key);
    if (!g) {
      g = { rep: sl, allTargets: new Set(), allEntries: [] };
      seen.set(key, g);
    }
    g.allEntries.push(sl);
    for (const tid of (sl.targetFileIds || [])) g.allTargets.add(tid);
    // 群組內有非 autoProp(使用者直接建的)→ 用它當代表;否則維持第一個
    if (!sl.autoProp && g.rep.autoProp) g.rep = sl;
  }
  return [...seen.values()];
}

// 右側欄「切面 Sections」清單:以「當前 active 檔案」為視角列出該檔的所有 sectionLink entries。
//   每行顯示:「<當前檔名> → <該 entry 指向的目標檔>」+ 角色(主關聯 / 同平面反向 / 跨平面反向)
//   點擊整列 → 跳到指向的目標檔。× 刪除整個 groupId(連帶所有跨檔傳播)。
export function refreshSectionLinkList() {
  const c = $("sectionLinkList");
  if (!c) return;
  c.innerHTML = "";
  const af = getActiveFile();
  if (!af) {
    c.innerHTML = `<div style="color:#9aa0a6;font-size:11px;padding:6px 4px">${(typeof _t==="function"&&_t("list.noSections"))||"尚未選擇檔案"}</div>`;
    return;
  }
  // 衍生模型:列出 af 上的 primaries(可刪)+ 衍生 entries(只顯示,刪要回到源檔)
  const entries = _deriveSectionLinksFor(af);
  if (!entries.length) {
    c.innerHTML = `<div style="color:#9aa0a6;font-size:11px;padding:6px 4px">本頁尚無切面</div>`;
    return;
  }
  // 計算每個 group 全域總共有幾個衍生 entry(主關聯 + 各檔的衍生)— 給每個 group 算一次
  //   (對 af 跑 derive 已得 af 部分;對其他檔再各 derive 一次成本可能高,取近似:用所有 primaries 的 group)
  const groupTotals = {};
  for (const f of state.files) {
    const fEntries = _deriveSectionLinksFor(f);
    for (const e of fEntries) {
      if (!e.groupId) continue;
      groupTotals[e.groupId] = (groupTotals[e.groupId] || 0) + 1;
    }
  }
  const _planeOf = (f) => (f && f.pages && f.pages[0] && f.pages[0].plane) || "?";
  const _zOf = (f) => {
    const pg = f && f.pages && f.pages[0];
    return (pg && pg.z != null && isFinite(pg.z)) ? pg.z : null;
  };
  const planeOrder = { XY: 0, XZ: 1, YZ: 2 };
  // 拆成 (entry, targetId) 列再排序;同 target 的跨平面衍生若已有 primary 涵蓋就拿掉(同平面衍生 / sibling 不影響)
  const rows = [];
  const primaryTargets = new Set();
  for (const sl of entries) {
    if (sl.autoProp) continue;
    for (const tid of (sl.targetFileIds || [])) {
      if (tid != null) primaryTargets.add(tid);
    }
  }
  for (const sl of entries) {
    const targetIds = (sl.targetFileIds || []).slice();
    const rowTargets = targetIds.length ? targetIds : [null];
    for (const tid of rowTargets) {
      // 跨平面衍生 + target 已被 primary 涵蓋 → 丟掉(其它角色都保留)
      if (sl.autoProp && sl.crossPlane && tid != null && primaryTargets.has(tid)) continue;
      const tf = tid != null ? state.files.find(ff => ff.id === tid) : null;
      const tplane = tid == null ? "?" : _planeOf(tf);
      const tz = tid == null ? null : _zOf(tf);
      const tname = tid == null ? "—" : (tf ? tf.name : "?");
      rows.push({ sl, tid, tf, tplane, tz, tname, allTargetIds: targetIds });
    }
  }
  rows.sort((a, b) => {
    const pa = planeOrder[a.tplane] ?? 99;
    const pb = planeOrder[b.tplane] ?? 99;
    if (pa !== pb) return pa - pb;
    // 第三軸值:高的在前;null 排到後面
    const za = (a.tz == null) ? -Infinity : a.tz;
    const zb = (b.tz == null) ? -Infinity : b.tz;
    if (za !== zb) return zb - za;
    return (b.tname || "").localeCompare(a.tname || "", undefined, { numeric: true, sensitivity: "base" });
  });
  for (const r of rows) {
    const sl = r.sl;
    const tid = r.tid;
    const tf = r.tf;
    const tname = r.tname;
    const targetIds = r.allTargetIds;
    const isDerived = !!sl.autoProp;
    const role = isDerived
      ? (sl.crossPlane ? "跨平面衍生" : "同平面衍生")
      : "主關聯";
    const totalInGroup = sl.groupId ? (groupTotals[sl.groupId] || 1) : 1;
    {
      const tPlane = r.tplane;
      const planeBadge = `[${tPlane}]`;
      const div = document.createElement("div");
      div.className = "item";
      div.style.flexDirection = "column";
      div.style.alignItems = "stretch";
      div.style.gap = "2px";
      div.title = `${role}・目標平面 ${tPlane}\n目標頁:${tname}\n群組共 ${totalInGroup} 項\n${isDerived ? "衍生項目自動產生,要刪請從主關聯所在檔案刪" : "點擊跳到指向的目標檔"}`;
      const row1 = document.createElement("div");
      row1.style.display = "flex";
      row1.style.justifyContent = "space-between";
      row1.style.gap = "6px";
      row1.style.alignItems = "center";
      const planeTag = document.createElement("span");
      planeTag.textContent = planeBadge;
      Object.assign(planeTag.style, {
        fontSize: "10px", color: "#9bb6e8",
        background: "rgba(79,157,255,0.12)",
        border: "1px solid rgba(79,157,255,0.35)",
        borderRadius: "3px", padding: "0 4px", flexShrink: "0",
      });
      row1.appendChild(planeTag);
      const name = document.createElement("span");
      name.style.fontWeight = "600";
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      name.style.whiteSpace = "nowrap";
      name.style.flex = "1";
      name.textContent = tname;
      if (isDerived) name.style.color = "#b07cff";
      row1.appendChild(name);
      if (!isDerived) {
        // 主關聯:× 只移除「這一列對應的 target」;若 entry 移到沒 target 了,整條 entry 一起刪
        const del = document.createElement("button");
        del.textContent = "×";
        del.title = targetIds.length > 1
          ? `從這條主關聯移除 ${tname}(其他 target 仍保留;衍生會自動更新)`
          : "刪除這個切面(衍生項目會自動消失)";
        Object.assign(del.style, {
          fontSize: "11px", padding: "1px 8px", background: "transparent",
          border: "1px solid #555", color: "#ff7788",
          borderRadius: "3px", cursor: "pointer", flexShrink: "0",
        });
        del.onclick = (e) => {
          e.stopPropagation();
          const multi = targetIds.length > 1;
          const msg = multi
            ? `從主關聯移除 ${tname}?\n本條主關聯還有其他 target,只會去掉這一個`
            : `刪除切面「${tname}」?\n衍生到其他檔案的項目會自動消失`;
          if (!confirm(msg)) return;
          // sl 是 _deriveSectionLinksFor 回來的 clone(因為 dedupe 階段為了合併 targets 重新建物件),
          //   不能用引用比對找原物件;改用 id + groupId 找實際存在 af.sectionLinks 裡的 primary。
          const findReal = () => (af.sectionLinks || []).find(x =>
            !x.autoProp &&
            (sl.id != null ? x.id === sl.id : x.groupId === sl.groupId)
          );
          pushUndo();
          const realSl = findReal();
          if (!realSl) {
            console.warn("[切面 list ×] 找不到對應的真實 primary entry,refresh 後重試", { sl, afSectionLinks: af.sectionLinks });
            refreshSectionLinkList();
            if (typeof refreshFileList === "function") refreshFileList();
            render();
            return;
          }
          if (multi) {
            realSl.targetFileIds = (realSl.targetFileIds || []).filter(x => x !== tid);
            if (!realSl.targetFileIds.length) {
              af.sectionLinks = (af.sectionLinks || []).filter(x => x !== realSl);
            }
          } else {
            af.sectionLinks = (af.sectionLinks || []).filter(x => x !== realSl);
          }
          refreshSectionLinkList();
          if (typeof refreshFileList === "function") refreshFileList();
          render();
        };
        row1.appendChild(del);
      }
      const row2 = document.createElement("div");
      row2.style.color = "#9aa0a6";
      row2.style.fontSize = "10px";
      row2.textContent = `${role}・群組 ${totalInGroup} 項${sl.id != null ? `・#${sl.id}` : ""}`;
      div.appendChild(row1);
      div.appendChild(row2);
      div.onclick = () => {
        if (tid != null && tid !== af.id) activatePageWithBusy(tid, 0);
      };
      c.appendChild(div);
    }
  }
}

// 從 plane 字串拿到 in-plane 兩軸 + depth 軸名稱
export function _planeAxisInfo(plane) {
  if (plane === "XZ") return { in: ["X", "Z"], depth: "Y" };
  if (plane === "YZ") return { in: ["Y", "Z"], depth: "X" };
  return { in: ["X", "Y"], depth: "Z" };   // 預設 XY
}

// 檔案是否「設定齊全」(可作為 propagation source)
export function _fileHasFullSetup(f) {
  if (!f) return false;
  const pg = f.pages && f.pages[0];
  if (!pg || !pg.plane) return false;
  if (!f.scaleRuler || !f.scaleRuler.ratio) return false;
  if (!f.planeOrigin) return false;
  return true;
}

// 平面 → 2D x/y 各對應的 3D 軸名稱
//   joint2DToWorld3D 內的對應(同步 1525~1532 那段 switch):
//     XY: u → X, v → Y
//     XZ: u → X, v → Z
//     YZ: u → Z, v → Y
export function _planeAxisOf2D(plane) {
  if (plane === "XZ") return { x: "X", y: "Z" };
  if (plane === "YZ") return { x: "Z", y: "Y" };
  return { x: "X", y: "Y" };   // XY
}

// 判定切面線是否軸向對齊,並算出「被固定的 3D 軸」cutAxis 與 cutValue。
//   設計信念:切面線只允許平行 X/Y/Z 任一軸;對應的 3D 切面就是「軸向座標平面」(X=c / Y=c / Z=c)
//   回傳 null 表示不夠資訊或不軸向。
export function _analyzeSectionLineAxis(sourceFile, srcEntry) {
  const srcPage = sourceFile && sourceFile.pages && sourceFile.pages[0];
  if (!srcPage || !srcPage.plane) return null;
  if (!_fileHasFullSetup(sourceFile)) return null;
  if (!srcEntry || !srcEntry.p1 || !srcEntry.p2) return null;
  const dx = srcEntry.p2.x - srcEntry.p1.x;
  const dy = srcEntry.p2.y - srcEntry.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const angTol = 0.1;        // ~5.7°,容忍 PDF / DXF 偏軸的線(超過視為斜線)
  const xRatio = Math.abs(dx) / len;
  const yRatio = Math.abs(dy) / len;
  const map = _planeAxisOf2D(srcPage.plane);
  let cutAxis;
  if (yRatio < angTol) cutAxis = map.y;     // 2D x-aligned (固定 2D y → 固定 map.y 軸)
  else if (xRatio < angTol) cutAxis = map.x; // 2D y-aligned (固定 2D x → 固定 map.x 軸)
  else return null;                          // 斜線拒絕
  const W1 = joint2DToWorld3D(sourceFile, srcPage, srcEntry.p1);
  const W2 = joint2DToWorld3D(sourceFile, srcPage, srcEntry.p2);
  if (!W1 || !W2) return null;
  const cutValue = W1[cutAxis.toLowerCase()];
  return { cutAxis, cutValue, srcPlane: srcPage.plane, W1, W2 };
}

// 給定 cutAxis = cutValue 的「3D 切面平面」,在目標檔 F 上算對應的 2D 切面線
//   - F 平面要包含 cutAxis 為 in-plane(否則切面平面平行於 F → 退化)
//   - 對 F 取 in-plane 另一軸做為「線方向」,延伸到大範圍後 clip 回 F bounds 的擴張範圍
export function _buildSectionLineForFile(F, cutAxis, cutValue) {
  if (!_fileHasFullSetup(F)) return null;
  const Fpage = F.pages[0];
  const tInfo = _planeAxisInfo(Fpage.plane);
  if (tInfo.in.indexOf(cutAxis) < 0) return null;       // degenerate
  const otherAxis = tInfo.in[0] === cutAxis ? tInfo.in[1] : tInfo.in[0];
  const fz = (Fpage.z != null && Number.isFinite(Fpage.z)) ? Fpage.z : 0;
  const halfLen = 50000;
  const Pa3 = { x: 0, y: 0, z: 0 };
  const Pb3 = { x: 0, y: 0, z: 0 };
  Pa3[cutAxis.toLowerCase()] = cutValue;
  Pb3[cutAxis.toLowerCase()] = cutValue;
  Pa3[tInfo.depth.toLowerCase()] = fz;
  Pb3[tInfo.depth.toLowerCase()] = fz;
  Pa3[otherAxis.toLowerCase()] = -halfLen;
  Pb3[otherAxis.toLowerCase()] = halfLen;
  const a2d = world3DToJoint2D(F, Fpage, Pa3);
  const b2d = world3DToJoint2D(F, Fpage, Pb3);
  if (!a2d || !a2d.ok || !b2d || !b2d.ok) return null;
  // Clip 到「F bounds 擴張 50%」的長方形,讓線比 bg 範圍稍長,後續 _computeOutsideMarkerLine 會處理外移箭頭
  //   完全在擴張範圍外(回 null)→ 表示 F 的圖根本不涵蓋此切面位置 → 不要強加 entry
  const bounds = _getPageBoundsForFile(F);
  const padX = bounds.w * 0.5;
  const padY = bounds.h * 0.5;
  const expanded = { x: bounds.x - padX, y: bounds.y - padY, w: bounds.w + 2 * padX, h: bounds.h + 2 * padY };
  return _clipLineToBounds({ x: a2d.x, y: a2d.y }, { x: b2d.x, y: b2d.y }, expanded);
}

// 線 (p1, p2) 對矩形 b={x,y,w,h} 的 Liang-Barsky 參數裁切;失敗(整段在外)回 null
export function _clipLineToBounds(p1, p2, b) {
  const x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
  let t0 = 0, t1 = 1;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const checks = [
    [-dx, p1.x - x1],
    [ dx, x2 - p1.x],
    [-dy, p1.y - y1],
    [ dy, y2 - p1.y],
  ];
  for (const [pp, qq] of checks) {
    if (Math.abs(pp) < 1e-9) { if (qq < 0) return null; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else        { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return {
    p1: { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
    p2: { x: p1.x + t1 * dx, y: p1.y + t1 * dy },
  };
}

// ---------- 衍生模型(derived sectionLinks) ----------
// 設計信念:file.sectionLinks 只儲存使用者實際畫的「主關聯(primary)」項目;
//   所有 autoProp(同平面平行兄弟、跨平面、parallel-multi、fallback)由 derive 函式
//   依當前所有檔案的 plane / origin / scale / page.z 即時計算,不寫入資料。
//   - 改 origin / scale / page.z → 衍生立刻反映
//   - 刪 primary → 衍生自動消失
//   - 載入時 strip autoProp 舊資料(loadProjectDataFromP / applySnap)

// 系統內是否有任一條 primary
export function _systemHasAnyPrimary() {
  for (const f of state.files) {
    if (!Array.isArray(f.sectionLinks)) continue;
    if (f.sectionLinks.some(e => !e.autoProp)) return true;
  }
  return false;
}

// 用 union-find 計算「平面之間是否(直接或傳遞)互相連結」:
//   - 每條 primary 把 sourcePlane 與 targetPlane(= depth^-1(cutAxis))union 起來
//   - 兩個平面同 root → 互相連結(rule 4-6 的傳遞性自動成立)
//   - 只連 XZ-YZ 時,XY 仍是獨立 root → 不會被視為已連入
export function _planeConnectionGroups() {
  const parent = { XY: "XY", XZ: "XZ", YZ: "YZ" };
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const f of state.files) {
    if (!Array.isArray(f.sectionLinks)) continue;
    const sp = f.pages && f.pages[0] && f.pages[0].plane;
    if (!sp) continue;
    for (const e of f.sectionLinks) {
      if (e.autoProp) continue;
      let ax = e.cutAxis;
      if (!ax) {
        const ai = _analyzeSectionLineAxis(f, e);
        if (ai) ax = ai.cutAxis;
      }
      if (!ax) continue;
      const tp = ["XY", "XZ", "YZ"].find(P => _planeAxisInfo(P).depth === ax);
      if (!tp || tp === sp) continue;
      union(sp, tp);
    }
  }
  return { find };
}

// F 是否「已參與切面系統」:F 的平面必須與其他至少一個平面直接或傳遞連結
//   (rule 8 嚴謹版:只連 XZ-YZ 時 XY 仍是孤立 component,不參與)
export function _isFileParticipatingInSectionSystem(F) {
  if (!F || !_fileHasFullSetup(F)) return false;
  const fp = F.pages && F.pages[0] && F.pages[0].plane;
  if (!fp) return false;
  const { find } = _planeConnectionGroups();
  const root = find(fp);
  for (const p of ["XY", "XZ", "YZ"]) {
    if (p === fp) continue;
    if (find(p) === root) return true;
  }
  return false;
}

// 在 targetFile 上算 file G 的軌跡(sibling-on-target trace):
//   targetFile 的 in-plane 必含 G.depthAxis(任兩個不同平面必互含對方的 depth)
//   軌跡 = 沿 otherAxis 延伸的線,在 G.depthAxis = G.page.z 處
//   位置與 primary 的 cutValue 完全無關 — 純粹是 G 與 targetFile 的幾何關係
export function _computeSiblingTraceOnTarget(G, targetFile) {
  if (!_fileHasFullSetup(G) || !_fileHasFullSetup(targetFile)) return null;
  if (G.id === targetFile.id) return null;
  const tgtPlane = targetFile.pages[0].plane;
  const gPlane = G.pages[0].plane;
  if (gPlane === tgtPlane) return null;
  const tgtInfo = _planeAxisInfo(tgtPlane);
  const gInfo = _planeAxisInfo(gPlane);
  const gDepthAxis = gInfo.depth;
  if (tgtInfo.in.indexOf(gDepthAxis) < 0) return null;     // 理論上不會發生
  const otherAxis = tgtInfo.in.find(a => a !== gDepthAxis);
  if (!otherAxis) return null;
  const lc = (s) => s.toLowerCase();
  const halfLen = 50000;
  const Fpage = targetFile.pages[0];
  const fDepthVal = (Fpage.z != null && Number.isFinite(Fpage.z)) ? Fpage.z : 0;
  const Gpage = G.pages[0];
  const gDepthVal = (Gpage.z != null && Number.isFinite(Gpage.z)) ? Gpage.z : 0;
  const Pa = { x: 0, y: 0, z: 0 }, Pb = { x: 0, y: 0, z: 0 };
  Pa[lc(gDepthAxis)]      = gDepthVal;
  Pb[lc(gDepthAxis)]      = gDepthVal;
  Pa[lc(tgtInfo.depth)]   = fDepthVal;
  Pb[lc(tgtInfo.depth)]   = fDepthVal;
  Pa[lc(otherAxis)]       = -halfLen;
  Pb[lc(otherAxis)]       =  halfLen;
  const a2d = world3DToJoint2D(targetFile, Fpage, Pa);
  const b2d = world3DToJoint2D(targetFile, Fpage, Pb);
  if (!a2d || !a2d.ok || !b2d || !b2d.ok) return null;
  const bounds = _getPageBoundsForFile(targetFile);
  const padX = bounds.w * 0.5, padY = bounds.h * 0.5;
  const expanded = { x: bounds.x - padX, y: bounds.y - padY, w: bounds.w + 2 * padX, h: bounds.h + 2 * padY };
  const clipped = _clipLineToBounds({ x: a2d.x, y: a2d.y }, { x: b2d.x, y: b2d.y }, expanded);
  if (!clipped) return null;
  return {
    _derived: true,
    // synthetic groupId — 跨呼叫穩定,讓 dedupe + merge 自然發生
    groupId: `_sib_${G.id}_on_${targetFile.id}`,
    p1: clipped.p1, p2: clipped.p2,
    targetFileIds: [G.id],
    autoProp: true,
    crossPlane: true,
    crossPlaneParallelMulti: true,
    cutAxis: gDepthAxis,
    cutValue: gDepthVal,
  };
}

// 給定 sourceFile 上的 primary,計算它對 targetFile 應產出的 case (a) 衍生 entry。
//   case (a) = 「primary 的 cutAxis 在 targetFile 的 in-plane 軸」→ 在 cutValue 處畫切線。
//   case (b)(sibling 軌跡)已搬到 _computeSiblingTraceOnTarget,跟 primary 解耦。
export function _computeDerivedEntriesForTarget(sourceFile, primary, targetFile) {
  if (!sourceFile || !targetFile || sourceFile.id === targetFile.id) return [];
  if (!_fileHasFullSetup(sourceFile) || !_fileHasFullSetup(targetFile)) return [];
  const srcPlane = sourceFile.pages[0].plane;
  const tgtPlane = targetFile.pages[0].plane;
  const info = _analyzeSectionLineAxis(sourceFile, primary);
  if (!info) return [];     // 軸向化失敗 → primary 仍存在於源,但無衍生投影
  const { cutAxis, cutValue } = info;
  const tgtInfo = _planeAxisInfo(tgtPlane);
  const isSamePlane = (tgtPlane === srcPlane);
  const filterTargets = (ids) => (Array.isArray(ids) ? ids : [])
    .filter(t => t !== targetFile.id)
    .filter(t => {
      const tf = state.files.find(x => x.id === t);
      const tp = tf && tf.pages && tf.pages[0];
      return tp && tp.plane !== tgtPlane;
    });

  if (tgtInfo.in.indexOf(cutAxis) >= 0) {
    if (!isSamePlane) {
      // 第三平面 gating(寬鬆版,gates by _systemHasAnyPrimary;見 _isFileParticipatingInSectionSystem)
      if (!_isFileParticipatingInSectionSystem(targetFile)) return [];
    }
    const line = _buildSectionLineForFile(targetFile, cutAxis, cutValue);
    if (!line) return [];
    const propTargets = filterTargets(primary.targetFileIds);
    return [{
      _derived: true,
      groupId: primary.groupId,
      p1: line.p1, p2: line.p2,
      targetFileIds: propTargets.length ? propTargets : [sourceFile.id],
      autoProp: true,
      crossPlane: !isSamePlane,
      cutAxis, cutValue,
    }];
  }
  return [];
}

// 對 targetFile,回傳所有應顯示的 sectionLink entries(主關聯 + 衍生)。
//   1. targetFile 上的 primaries(使用者直接畫的)
//   2. case (a) 衍生:其他檔案的 primary 指定的具體切線(cutAxis=cutValue)
//   3. sibling traces(rule 8):系統有任一 primary 時,所有不同平面的設定齊全檔對 targetFile
//      自動產生「我在這個位置」的軌跡;跟 primary 的 cutValue 無關
//   最後依幾何座標 dedupe,優先序:primary > case (a) > sibling trace
export function _deriveSectionLinksFor(targetFile) {
  const out = [];
  if (!targetFile) return out;
  // 1. primaries on targetFile
  const primaries = (targetFile.sectionLinks || []).filter(e => !e.autoProp);
  for (const p of primaries) out.push(p);
  const ownedGroups = new Set(primaries.map(p => p.groupId).filter(Boolean));
  // 2. case (a) 衍生
  for (const sourceFile of state.files) {
    if (sourceFile.id === targetFile.id) continue;
    if (!Array.isArray(sourceFile.sectionLinks)) continue;
    for (const primary of sourceFile.sectionLinks) {
      if (primary.autoProp) continue;
      if (primary.groupId && ownedGroups.has(primary.groupId)) continue;
      const entries = _computeDerivedEntriesForTarget(sourceFile, primary, targetFile);
      for (const e of entries) out.push(e);
    }
  }
  // 3. sibling traces — 對每個「平面已與 targetFile.plane 直接或傳遞連結」的設定齊全檔產生軌跡。
  //    同平面 + 同 page.z 的檔合併成一筆(共用切線、targetFileIds 列出全員,
  //    render 階段每個檔名各自繪成可點擊 span)。
  //    例:只有 XZ-YZ primary 時,XY 平面孤立 → XY 上不會出現 XZ/YZ 的 trace,反之亦然
  if (_fileHasFullSetup(targetFile) && _systemHasAnyPrimary()) {
    const tgtPlane = targetFile.pages[0].plane;
    const { find } = _planeConnectionGroups();
    const tgtRoot = find(tgtPlane);
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    const groups = new Map();   // key = "plane@roundedZ" → [G files]
    for (const G of state.files) {
      if (G.id === targetFile.id) continue;
      if (!_fileHasFullSetup(G)) continue;
      const gp = G.pages[0];
      if (gp.plane === tgtPlane) continue;
      if (find(gp.plane) !== tgtRoot) continue;
      const z = (gp.z != null && Number.isFinite(gp.z))
        ? Math.round(gp.z * factor) / factor : 0;
      const key = `${gp.plane}@${z}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(G);
    }
    for (const members of groups.values()) {
      if (!members.length) continue;
      // 第一個檔當代表算軌跡(同 plane + 同 z 的線位置相同)
      const trace = _computeSiblingTraceOnTarget(members[0], targetFile);
      if (!trace) continue;
      const sortedIds = members.map(m => m.id).sort((a, b) => a - b);
      trace.targetFileIds = sortedIds;
      // synthetic groupId 反映合併群組;以 _sib_ 開頭,優先級判定仍生效
      trace.groupId = `_sib_${sortedIds.join("_")}_on_${targetFile.id}`;
      out.push(trace);
    }
  }
  // 4. 依幾何座標 dedupe(rounded p1/p2),保留優先序高者:
  //    primary(無 autoProp)> case (a) 衍生(autoProp 無 _sib_ groupId)> sibling trace(_sib_ groupId)
  //    為避免衍生頁的 case-a 把 sibling trace「整條掩蓋」(只剩主關聯目標,缺 sibling 群組成員),
  //    這裡 dedupe 時優先級判定維持不變(留高優先級當代表,p1/p2/cutAxis/cutValue 來自高優先級),
  //    但「targetFileIds 取聯集」— 把被丟掉那條的 targets 併進來。標籤渲染就會列出全部成員。
  const dedupedByCoords = new Map();
  const _mergeTargets = (a, b) => {
    const set = new Set();
    for (const t of (a || [])) if (t != null) set.add(t);
    for (const t of (b || [])) if (t != null) set.add(t);
    return Array.from(set);
  };
  for (const e of out) {
    if (!e.p1 || !e.p2) continue;
    const a = `${Math.round(e.p1.x)},${Math.round(e.p1.y)}`;
    const b = `${Math.round(e.p2.x)},${Math.round(e.p2.y)}`;
    const coords = a < b ? `${a}|${b}` : `${b}|${a}`;
    const isPrimary = !e.autoProp;
    const isSibTrace = typeof e.groupId === "string" && e.groupId.startsWith("_sib_");
    const priority = isPrimary ? 2 : (isSibTrace ? 0 : 1);
    const existing = dedupedByCoords.get(coords);
    if (!existing) {
      // 第一次遇到此座標 — clone 一份(後續可能會被改寫 targetFileIds 聯集,不影響原 e)
      dedupedByCoords.set(coords, {
        entry: { ...e, targetFileIds: (e.targetFileIds || []).slice() },
        priority,
      });
    } else if (priority > existing.priority) {
      // 新進的優先級更高 → 用它當代表,但把舊的 targets 併入,讓 sibling 群組成員不會掉
      const merged = _mergeTargets(e.targetFileIds, existing.entry.targetFileIds);
      dedupedByCoords.set(coords, { entry: { ...e, targetFileIds: merged }, priority });
    } else if (priority < existing.priority) {
      // 舊的優先級高 → 保留舊代表,但把新的 targets 併進去
      existing.entry.targetFileIds = _mergeTargets(existing.entry.targetFileIds, e.targetFileIds);
    } else {
      // 同優先級
      if (existing.entry.groupId === e.groupId) continue;   // 同 groupId 同 coords → 純重複,跳過
      // 同優先級不同 groupId(較少見)→ 也把 targets 併進舊代表(p1/p2/cut* 還是用先到的)
      existing.entry.targetFileIds = _mergeTargets(existing.entry.targetFileIds, e.targetFileIds);
    }
  }
  return [...dedupedByCoords.values()].map(v => v.entry);
}

// 為檔案 F 的每條切面線,從其他檔案的 joints / members 推斷 F 上應該存在的節點與桿件。
//   - F 的切面線 + F 的 depth 軸 → 3D 中的「切面平面」
//   - 對其他檔(優先序 XZ → XY → YZ)取每個 joint,計算它在 F 切面平面上的距離;
//     落在 tol 內就投影到 F 的 2D(改 depth 為 F.page.z)、檢查 2D 是否在切面線段上,通過就建節點
//   - 桿件:若一條桿件的兩端 joint 都被處理過(idMap 有),且彼此不重複,在 F 上連桿件
//   - 平面衝突檢測:同一個切面有 ≥2 個同平面檔案都貢獻節點 → 紀錄為「多平行切面衝突」
//   - F 自己缺平面/原點/比例尺,或切面 entry 缺 p1/p2 → 跳過該 entry(只處理能處理的)
export async function _populateSectionLinkJointsForFile(F, opts) {
  if (!F || !_fileHasFullSetup(F)) return null;
  const Fpage = F.pages && F.pages[0];
  if (!Fpage) return null;
  const fEntries = _deriveSectionLinksFor(F);
  if (!fEntries.length) return null;
  opts = opts || {};
  const tol3D = opts.tol3D != null ? opts.tol3D : 1.0;
  const tol2D = opts.tol2D != null ? opts.tol2D : 5.0;
  const dedupRadius = opts.dedupRadius != null ? opts.dedupRadius : 0.5;
  const planePriority = opts.planePriority || ["XY", "YZ", "XZ"];
  // mode: "joints"(只建節點)/ "members"(只建桿件)/ "both"(都建,預設)
  const mode = opts.mode === "joints" || opts.mode === "members" ? opts.mode : "both";
  const doJoints  = mode !== "members";
  const doMembers = mode !== "joints";
  // 時間基底 yield:每 yieldMs 毫秒(預設 50)yield 一次給瀏覽器處理事件,
  //   保證 cancel 按鈕 / Esc 可以在迴圈進行中被點到,且大檔不會被加上太多 overhead。
  const yieldMs = opts.yieldMs != null ? opts.yieldMs : 50;
  // 進度 callback:每 yield 點傳回 { fileName, processed };回傳 false 中斷處理
  const onProgress = opts.onProgress;
  const _yield = () => new Promise(r => setTimeout(r, 0));
  let _lastYield = Date.now();

  const stats = { processedLinks: 0, jointsAdded: 0, membersAdded: 0, conflicts: [], skipped: 0, mode };

  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  // ---- 優化 1:spatial hash for findExistingJoint(避免 O(n) linear scan)----
  //   cell 邊長 = dedupRadius * 2,只需檢查目標 cell 跟 8 鄰居就能涵蓋 < dedupRadius 範圍
  const cellSize = Math.max(dedupRadius * 2, 0.5);
  const _cellKey = (x, y) => `${Math.floor(x / cellSize)}|${Math.floor(y / cellSize)}`;
  const _jointGrid = new Map();
  for (const j of (Fpage.joints || [])) {
    const k = _cellKey(j.x, j.y);
    let arr = _jointGrid.get(k);
    if (!arr) { arr = []; _jointGrid.set(k, arr); }
    arr.push(j);
  }
  const findExistingJoint = (page, x, y) => {
    // page 參數保留簽名相容,實際只查 F 自己的網格
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = _jointGrid.get(`${cx + dx}|${cy + dy}`);
        if (!arr) continue;
        for (const j of arr) {
          if (Math.hypot(j.x - x, j.y - y) < dedupRadius) return j;
        }
      }
    }
    return null;
  };
  const _registerJoint = (j) => {
    const k = _cellKey(j.x, j.y);
    let arr = _jointGrid.get(k);
    if (!arr) { arr = []; _jointGrid.set(k, arr); }
    arr.push(j);
  };
  // ---- 優化 2:member key index(避免 O(n) some(...))----
  const _memberKeyOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const _memberKeys = new Set();
  for (const m of (Fpage.members || [])) _memberKeys.add(_memberKeyOf(m.j1, m.j2));
  // ---- 優化 3:joint2DToWorld3D memo(同 source joint 不重算)----
  const _worldCache = new Map();  // G.id → Map<sj.id, world3D|null>
  const _getWorld = (G, Gp, sj) => {
    let m = _worldCache.get(G.id);
    if (!m) { m = new Map(); _worldCache.set(G.id, m); }
    if (m.has(sj.id)) return m.get(sj.id);
    const w = joint2DToWorld3D(G, Gp, sj) || null;
    m.set(sj.id, w);
    return w;
  };
  // ---- 優化 4:bulk binding 模式 — 不每次 inferGlobalJoint,結束統一 infer 被動到的 ----
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };

  const fDepthAxis = _planeAxisInfo(Fpage.plane).depth.toLowerCase();

  // 候選來源檔(依平面優先序)— 只挑「圖頁有節點或桿件」的檔案,避免掃過空頁
  //   依 mode 決定條件:joints/both 需要 joints;members 需要 members;both 兩者任一即可
  const needJ = (mode !== "members");
  const needM = (mode !== "joints");
  const sourcesByPlane = { XY: [], XZ: [], YZ: [] };
  for (const G of state.files) {
    if (G.id === F.id) continue;
    if (!_fileHasFullSetup(G)) continue;
    const pg = G.pages[0];
    if (!sourcesByPlane[pg.plane]) continue;
    const hasJ = Array.isArray(pg.joints)  && pg.joints.length > 0;
    const hasM = Array.isArray(pg.members) && pg.members.length > 0;
    // 必須有需要的內容才納入:both 模式只要其一即可;joints 需要節點;members 需要桿件
    if (mode === "joints"  && !hasJ) continue;
    if (mode === "members" && !hasM) continue;
    if (mode === "both"    && !(hasJ || hasM)) continue;
    sourcesByPlane[pg.plane].push(G);
  }
  const orderedSources = [];
  for (const plane of planePriority) {
    for (const G of (sourcesByPlane[plane] || [])) orderedSources.push({ file: G, plane });
  }

  // ---- 預先過濾:對每個來源檔,把「結構性節點(接桿件)+ depth 對齊 F 平面」的 joint 先抓出來 ----
  //   每個 entry 包含 G / Gp / plane / sj / W / f2d,後續每條切線只要做 signedDist + segDist 兩個便宜檢查
  //   省掉每條切線都重跑 world3DToJoint2D / connectedJointIds 計算的成本(O(N_lines × N_joints) → O(N_joints + N_lines × N_passing))
  const eligibleByPlane = { XY: [], YZ: [], XZ: [] };
  {
    let _prefilterCount = 0;
    for (const { file: G, plane: Gplane } of orderedSources) {
      const Gp = G.pages[0];
      // 過濾孤立節點(無接桿件 → 多半是尺寸 / 標註 / 殘留),只在「該頁本身有 members」時生效。
      //   若頁面只有節點沒桿件(例如僅標柱位 / 軸線交點的純節點頁),所有節點都視為結構性,不過濾。
      const _connectedJointIds = new Set();
      let _hasAnyMember = false;
      for (const sm of (Gp.members || [])) {
        _hasAnyMember = true;
        if (sm.j1 != null) _connectedJointIds.add(sm.j1);
        if (sm.j2 != null) _connectedJointIds.add(sm.j2);
      }
      for (const sj of (Gp.joints || [])) {
        if (_hasAnyMember && !_connectedJointIds.has(sj.id)) continue;
        _prefilterCount++;
        // yield 給 UI / cancel(預過濾本身可能也要跑幾千次)
        if (Date.now() - _lastYield > yieldMs) {
          _lastYield = Date.now();
          if (onProgress) {
            const r = onProgress({ fileName: F.name, phase: "filter", processed: _prefilterCount });
            if (r === false) return stats;
          }
          await _yield();
        }
        const W = _getWorld(G, Gp, sj);
        if (!W) continue;
        // 嚴格 3D 對位 + 一次 world3DToJoint2D — 結果整個 F 處理過程都共用
        const f2d = world3DToJoint2D(F, Fpage, W, { tol: tol3D });
        if (!f2d || !f2d.ok) continue;
        eligibleByPlane[Gplane].push({ G, Gp, plane: Gplane, sj, W, f2d });
      }
    }
  }

  for (const e of fEntries) {
    if (!e.p1 || !e.p2) { stats.skipped++; continue; }
    if (e.crossPlaneFallback) { stats.skipped++; continue; }   // bg 中央 placeholder,沒幾何意義
    // F 的切面平面:過 FW1, FW2,法向 = cross(線方向, F depth 軸)
    const FW1 = joint2DToWorld3D(F, Fpage, e.p1);
    const FW2 = joint2DToWorld3D(F, Fpage, e.p2);
    if (!FW1 || !FW2) { stats.skipped++; continue; }
    const lineDir = { x: FW2.x - FW1.x, y: FW2.y - FW1.y, z: FW2.z - FW1.z };
    const dV = { x: 0, y: 0, z: 0 }; dV[fDepthAxis] = 1;
    const cutN = {
      x: lineDir.y * dV.z - lineDir.z * dV.y,
      y: lineDir.z * dV.x - lineDir.x * dV.z,
      z: lineDir.x * dV.y - lineDir.y * dV.x,
    };
    const nLen = Math.hypot(cutN.x, cutN.y, cutN.z);
    if (nLen < 1e-9) { stats.skipped++; continue; }
    cutN.x /= nLen; cutN.y /= nLen; cutN.z /= nLen;

    // (G.id, srcJointId) → F 上的目標 joint id (新建或既有)
    const idMap = new Map();
    // 真正的多平行切面衝突:同一個 plane 有 ≥ 2 個檔案投影到 F 上「同一個 target joint」。
    //   多排架平行結構(例如倉儲多個 XZ 排架在不同 Y 深度,各自有相同 X / Z 的柱位)
    //   每個排架投影到 F 切線上會落在不同 2D 點,雖然來自同 plane 多個檔案、卻不該算衝突。
    //   key: target joint id  value: { XY: Map<fileName, sj.id[]>, XZ: …, YZ: … }
    const _contribByTarget = new Map();

    // 處理順序:plane priority(XY → YZ → XZ),只走預過濾後的 eligible joints
    //   每個 eligible joint 已通過 depth 對位(world3DToJoint2D 的 tol);現在只要做切線兩個便宜檢查:
    //   (a) signedDist:joint 投影到 F 的 2D 後落在切面延伸線(線方向 × depth 軸)內
    //   (b) segDist:joint 落在切線段內(非無限延伸線)
    //   per-source 的 members 仍需要兩端 joint 都被「同一條切線」處理過(用 idMap 收集),mode === "joints" 時略過
    const contributedSrcByG = new Map();   // G.id → G(用於收集要處理 members 的來源檔)
    let _slProcCount = 0;
    for (const plane of planePriority) {
      for (const ent of (eligibleByPlane[plane] || [])) {
        const { G, sj, W, f2d } = ent;
        _slProcCount++;
        // yield 給 UI / cancel(每個 eligible joint 的迴圈內也要有機會中斷)
        if (Date.now() - _lastYield > yieldMs) {
          _lastYield = Date.now();
          if (onProgress) {
            const r = onProgress({ fileName: F.name, phase: "section", processed: _slProcCount });
            if (r === false) return stats;
          }
          await _yield();
        }
        const signedDist = (W.x - FW1.x) * cutN.x + (W.y - FW1.y) * cutN.y + (W.z - FW1.z) * cutN.z;
        if (Math.abs(signedDist) > tol3D) continue;
        if (segDist({ x: f2d.x, y: f2d.y }, e.p1, e.p2) > tol2D) continue;
        let target = findExistingJoint(Fpage, f2d.x, f2d.y);
        if (!target) {
          if (!doJoints) continue;   // members 模式 → 不建節點;沒既有 joint 就略過此 source joint
          target = { id: allocJointId(), x: f2d.x, y: f2d.y };
          Fpage.joints.push(target);
          _registerJoint(target);
          stats.jointsAdded++;
        }
        if (typeof _autoBindGlobalForMappedJoint === "function") {
          _autoBindGlobalForMappedJoint(sj, target, W, _bindOpts);
        }
        idMap.set(`${G.id}_${sj.id}`, target.id);
        contributedSrcByG.set(G.id, G);
        // 紀錄此 target joint 收到了哪個 plane 的哪個檔案的貢獻
        let perPlane = _contribByTarget.get(target.id);
        if (!perPlane) { perPlane = { XY: new Set(), XZ: new Set(), YZ: new Set() }; _contribByTarget.set(target.id, perPlane); }
        perPlane[plane] && perPlane[plane].add(G.name);
      }
    }
    // members:逐個有貢獻 joint 的來源檔處理,兩端 joint 都在 idMap(同切線)才連
    if (doMembers) {
      for (const G of contributedSrcByG.values()) {
        const Gp = G.pages[0];
        for (const sm of (Gp.members || [])) {
          const t1 = idMap.get(`${G.id}_${sm.j1}`);
          const t2 = idMap.get(`${G.id}_${sm.j2}`);
          if (t1 == null || t2 == null) continue;
          if (t1 === t2) continue;
          const mk = _memberKeyOf(t1, t2);
          if (_memberKeys.has(mk)) continue;
          if (!Array.isArray(Fpage.members)) Fpage.members = [];
          Fpage.members.push({ id: allocMemberId(), j1: t1, j2: t2 });
          _memberKeys.add(mk);
          stats.membersAdded++;
        }
      }
    }
    // 多平行切面衝突:同一個 target joint 收到同 plane ≥ 2 個檔案的投影
    //   把這類衝突 target 依 plane 聚合,匯總成「某 plane 上 N 個 target 有衝突,涉及檔案 [...]」
    const tag = e.id != null ? `#${e.id}` : (e.cutAxis ? `${e.cutAxis}=${e.cutValue}` : "(衍生)");
    const conflictByPlane = { XY: { tids: new Set(), files: new Set() }, XZ: { tids: new Set(), files: new Set() }, YZ: { tids: new Set(), files: new Set() } };
    for (const [tid, perPlane] of _contribByTarget) {
      for (const plane of ["XY", "XZ", "YZ"]) {
        const set = perPlane[plane];
        if (set && set.size >= 2) {
          conflictByPlane[plane].tids.add(tid);
          for (const n of set) conflictByPlane[plane].files.add(n);
        }
      }
    }
    for (const plane of Object.keys(conflictByPlane)) {
      const c = conflictByPlane[plane];
      if (c.tids.size >= 1) {
        const fileList = Array.from(c.files).join("、");
        stats.conflicts.push(`切面 ${tag}(${F.name})・${plane} 平面有 ${c.files.size} 個檔案投影到同一個節點(${c.tids.size} 個重疊位置)[${fileList}] → 多平行切面衝突`);
      }
    }
    stats.processedLinks++;
  }
  // 結束時統一 infer 被動到的 globalJoints(避免迴圈內每次都 O(total joints))
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  stats.touchedGlobals = _touchedGids.size;
  return stats;
}

// 檔案預覽縮圖:依 cachedBgImg / cachedBgSvg 把底圖畫進小 canvas(類似主畫布的反相效果)
//   套 clipRect 的處理方式跟主對話框 preview 一致:cachedBgImg 走 source-rect 裁切;
//   cachedBgSvg 改寫 viewBox 重新渲染。否則 DXF bbox 遠大於實際內容時,縮圖會被縮成一個小點。
export async function renderFileThumb(canvas, file) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0d0e10";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const W = canvas.width, H = canvas.height;
  const tag = `[thumb #${file && file.id} ${file && file.name}]`;
  const loadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => { console.warn(tag, "Image onerror", e); resolve(null); };
    img.src = src;
  });
  const drawFit = (img, sx, sy, sw, sh, invert) => {
    if (!img || !img.width || !img.height || sw <= 0 || sh <= 0) {
      console.warn(tag, "drawFit refuse", { hasImg: !!img, iw: img && img.width, ih: img && img.height, sx, sy, sw, sh });
      return false;
    }
    const sc = Math.min(W / sw, H / sh);
    const w = sw * sc, h = sh * sc;
    const x = (W - w) / 2, y = (H - h) / 2;
    if (invert) {
      ctx.save();
      try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }
    console.log(tag, "drawFit OK", { src: { sx: Math.round(sx), sy: Math.round(sy), sw: Math.round(sw), sh: Math.round(sh) },
      dst: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, invert });
    return true;
  };
  console.log(tag, "start", {
    canvas: { W, H },
    hasBgImg: !!file.cachedBgImg, bgImgLen: (file.cachedBgImg && file.cachedBgImg.length) || 0,
    hasBgSvg: !!file.cachedBgSvg, bgSvgLen: (file.cachedBgSvg && file.cachedBgSvg.length) || 0,
    bgW: file.bgWidth, bgH: file.bgHeight, cachedBgW: file.cachedBgWidth, cachedBgH: file.cachedBgHeight,
    clipRect: file.clipRect, bgImgDarkReady: file.bgImgDarkReady,
  });
  if (file.cachedBgImg) {
    const invert = !file.bgImgDarkReady;   // DXF 預烤 bitmap 已是深色,不需再 invert
    const img = await loadImg(file.cachedBgImg);
    if (img && img.width && img.height) {
      const bgW = file.cachedBgWidth  || file.bgWidth  || img.width;
      const bgH = file.cachedBgHeight || file.bgHeight || img.height;
      const clip = file.clipRect ? { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h }
                                 : { x: 0, y: 0, w: bgW, h: bgH };
      let sx = Math.max(0, clip.x * img.width  / bgW);
      let sy = Math.max(0, clip.y * img.height / bgH);
      let sw = Math.min(img.width  - sx, clip.w * img.width  / bgW);
      let sh = Math.min(img.height - sy, clip.h * img.height / bgH);
      console.log(tag, "bgImg loaded", { iw: img.width, ih: img.height, bgW, bgH, sx, sy, sw, sh });
      if (!(sw > 0 && sh > 0)) {
        console.warn(tag, "bgImg sw/sh degenerate, fall back to full image");
        sx = 0; sy = 0; sw = img.width; sh = img.height;
      }
      if (drawFit(img, sx, sy, sw, sh, invert)) return;
    } else {
      console.warn(tag, "bgImg load failed, hasImg=", !!img);
    }
  }
  if (file.cachedBgSvg) {
    const bgW = file.cachedBgWidth  || file.bgWidth  || 1200;
    const bgH = file.cachedBgHeight || file.bgHeight || 800;
    const clip = file.clipRect ? { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h }
                               : { x: 0, y: 0, w: bgW, h: bgH };
    const aspect = (clip.w > 0 && clip.h > 0) ? clip.w / clip.h : 1;
    let renderW = Math.min(1024, Math.max(W * 4, 256));
    let renderH = Math.round(renderW / aspect);
    if (renderH > 1024) { renderH = 1024; renderW = Math.round(renderH * aspect); }
    let sized = file.cachedBgSvg;
    const vb = `${clip.x} ${clip.y} ${clip.w} ${clip.h}`;
    const m_vb = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
    const m_w  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
    const m_h  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
    console.log(tag, "bgSvg pre-rewrite", {
      origViewBox: m_vb ? m_vb[1] : null, origWidth: m_w ? m_w[1] : null, origHeight: m_h ? m_h[1] : null,
      newViewBox: vb, renderW, renderH, aspect,
    });
    if (/<svg\b[^>]*\sviewBox=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)viewBox="[^"]*"/, `$1viewBox="${vb}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg viewBox="${vb}"`);
    }
    if (/<svg\b[^>]*\swidth=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${renderW}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg width="${renderW}"`);
    }
    if (/<svg\b[^>]*\sheight=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${renderH}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg height="${renderH}"`);
    }
    // 拿掉根 svg 上 inline style 裡會干擾離線渲染的 css 屬性 — DXF / PDF 解析時這些用於 in-page 渲染,
    //   但在 SVG-to-Image 時 width/height/clip-path 會強制覆蓋我們改的屬性,造成空白
    sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
      const cleaned = style
        .replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
        .replace(/;{2,}/g, ";")
        .replace(/^;|;$/g, "")
        .trim();
      return cleaned ? `${head} style="${cleaned}"` : head;
    });
    const m_vb2 = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
    const m_w2  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
    const m_h2  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
    const m_st2 = sized.match(/<svg\b[^>]*\sstyle="([^"]+)"/);
    console.log(tag, "bgSvg post-rewrite", {
      viewBox: m_vb2 ? m_vb2[1] : null, width: m_w2 ? m_w2[1] : null, height: m_h2 ? m_h2[1] : null,
      style: m_st2 ? m_st2[1] : null,
      sizedLen: sized.length,
    });
    const blob = new Blob([sized], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      if (img) console.log(tag, "bgSvg image loaded", { iw: img.width, ih: img.height });
      if (img && drawFit(img, 0, 0, img.width, img.height, true)) return;
    } finally { URL.revokeObjectURL(url); }
    return;
  }
  console.warn(tag, "no bg cache, falling back to filename label");
  ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(file.name || "—", W / 2, H / 2);
}

// 切面關聯對話框 — 標題列拖曳(同 import dialog pattern;lazy init 因為 script 早於 DOM)
let _slDlgDragInited = false;
export function setupSectionLinkDialogDrag() {
  if (_slDlgDragInited) return;
  const card = document.querySelector("#sectionLinkDialog .sl-card");
  const titlebar = document.querySelector("#sectionLinkDialog .sl-titlebar");
  if (!card || !titlebar) return;
  _slDlgDragInited = true;
  let drag = null;
  titlebar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // 點到關閉按鈕本身不要觸發拖曳
    if (e.target && e.target.classList.contains("sl-close")) return;
    const rect = card.getBoundingClientRect();
    card.style.position = "absolute";
    card.style.left = rect.left + "px";
    card.style.top  = rect.top  + "px";
    card.style.transform = "none";
    drag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const maxX = window.innerWidth - 40;
    const maxY = window.innerHeight - 40;
    const nx = Math.max(-card.offsetWidth + 80, Math.min(maxX, drag.left + (e.clientX - drag.startX)));
    const ny = Math.max(0, Math.min(maxY, drag.top + (e.clientY - drag.startY)));
    card.style.left = nx + "px";
    card.style.top  = ny + "px";
  });
  window.addEventListener("mouseup", () => { drag = null; });
}
