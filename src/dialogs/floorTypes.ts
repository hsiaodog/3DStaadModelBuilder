// Phase 5 — 節點編號管理 dialog(從 legacy.ts 整段搬過來,@ts-nocheck 過渡)
//   功能:樓層類型 / 斜撐起始 兩 tab,各自 CRUD + 頁面指派 + filter + sort + 預覽
//   未來可進一步拆 list / filter / preview / actions 子檔
// @ts-nocheck

import {
  state, $, render, refreshLists, getPage, getActiveFile,
  pushUndo, withBusy, escapeHtml, renderFileThumb,
  _fileHasFullSetup, _t,
} from "../legacy";
import { invalidateRankCache, _rankCache, _worldForRank } from "../core/rankCache";
import { joint2DToWorld3D } from "../core/projection";
import { inferAllGlobalJoints } from "../core/globalJoints";
import { ALLOWED_YY } from "../constants";

export 
function openFloorTypesDialog() {
  const dlg = document.getElementById("floorTypesDialog");
  const tbody = document.getElementById("floorTypesTbody");
  const hint = document.getElementById("floorTypesHint");
  const summaryEl = document.getElementById("floorTypesSummary");
  const pagesHead = document.getElementById("floorTypesPagesHead");
  const pagesList = document.getElementById("floorTypesPagesList");
  const filterBtn = document.getElementById("floorTypesFilterBtn");
  const filterBtnLabel = document.getElementById("floorTypesFilterBtnLabel");
  const filterPanel = document.getElementById("floorTypesFilterPanel");
  const filterCountEl = document.getElementById("floorTypesFilterCount");
  const sortSel = document.getElementById("floorTypesSort");
  const previewName = document.getElementById("floorTypesPreviewName");
  const previewCanvas = document.getElementById("floorTypesPreviewCanvas");
  const previewZoom = document.getElementById("floorTypesPreviewZoom");
  const previewZoomVal = document.getElementById("floorTypesPreviewZoomVal");
  if (!dlg || !tbody) return;
  if (!Array.isArray(state.floorTypes) || !state.floorTypes.length) {
    state.floorTypes = [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
  }
  // 允許的 yyStart 值(每 10 一階,共 10 階)— floor + brace 共用同一池
  // ALLOWED_YY 已移到 src/constants.ts(Phase 2)
  const _normalizeKey = (k) => String(k || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_") || "type";
  // 確保現有 type 有 kind 欄位(舊資料補成 floor)
  for (const t of state.floorTypes) { if (t.kind !== "brace") t.kind = "floor"; }
  // pending assignments 拆 floor / brace 兩個 Map(各自寫回 pg.floorType / pg.braceType)
  const pendingByKind = {
    floor: new Map(),   // Map<"fid#k", floorTypeKey>;commit 時寫到 pg.floorType
    brace: new Map(),   // Map<"fid#k", braceTypeKey>;commit 時寫到 pg.braceType
  };
  // 蒐集兩種 page 集合(各自的 plane 集合)
  const pagesByKind = { floor: [], brace: [] };
  for (const f of state.files) {
    for (const k of Object.keys(f.pages || {})) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      const idStr = `${f.id}#${k}`;
      if (pg.plane === "XZ") {
        pagesByKind.floor.push({ file: f, page: pg, k: +k, id: idStr });
        pendingByKind.floor.set(idStr, pg.floorType || "default");
      } else if (pg.plane === "YZ" || pg.plane === "XY") {
        pagesByKind.brace.push({ file: f, page: pg, k: +k, id: idStr });
        pendingByKind.brace.set(idStr, pg.braceType || "default");
      }
    }
  }
  // 各 kind 預設排序;sortModeByKind 可改成 z-asc / z-desc / name(動態 resort 重排)
  // 平面排序權重(brace 預設先 plane 分組):XY < YZ(字母升序)
  const PLANE_ORDER = { XY: 0, YZ: 1, XZ: 2 };
  const _comparators = {
    auto_floor: (a, b) => {
      const za = Number.isFinite(a.page.z) ? a.page.z : Infinity;
      const zb = Number.isFinite(b.page.z) ? b.page.z : Infinity;
      if (za !== zb) return za - zb;
      return a.file.name.localeCompare(b.file.name);
    },
    auto_brace: (a, b) => {
      const pa = PLANE_ORDER[a.page.plane] ?? 9, pb = PLANE_ORDER[b.page.plane] ?? 9;
      if (pa !== pb) return pa - pb;
      const za = Number.isFinite(a.page.z) ? a.page.z : Infinity;
      const zb = Number.isFinite(b.page.z) ? b.page.z : Infinity;
      if (za !== zb) return za - zb;
      return a.file.name.localeCompare(b.file.name);
    },
    "z-asc": (a, b) => {
      const za = Number.isFinite(a.page.z) ? a.page.z : Infinity;
      const zb = Number.isFinite(b.page.z) ? b.page.z : Infinity;
      if (za !== zb) return za - zb;
      return a.file.name.localeCompare(b.file.name);
    },
    "z-desc": (a, b) => {
      const za = Number.isFinite(a.page.z) ? a.page.z : -Infinity;
      const zb = Number.isFinite(b.page.z) ? b.page.z : -Infinity;
      if (za !== zb) return zb - za;
      return a.file.name.localeCompare(b.file.name);
    },
    "name": (a, b) => {
      const r = a.file.name.localeCompare(b.file.name);
      if (r !== 0) return r;
      return a.k - b.k;
    },
  };
  const sortModeByKind = { floor: "auto", brace: "auto" };
  const _resortPages = (kind) => {
    const mode = sortModeByKind[kind] || "auto";
    const cmp = (mode === "auto")
      ? (kind === "brace" ? _comparators.auto_brace : _comparators.auto_floor)
      : _comparators[mode] || _comparators.auto_floor;
    pagesByKind[kind].sort(cmp);
  };
  _resortPages("floor");
  _resortPages("brace");
  // 互動狀態:active tab + 每個 tab 各自 selectedTypeKey / focusPageId / visibleTypes
  let activeKind = "floor";
  const _typesOf = (kind) => state.floorTypes.filter(t => (t.kind || "floor") === kind);
  const selectedTypeKeyByKind = {
    floor: (_typesOf("floor")[0] || {}).key || "default",
    brace: (_typesOf("brace")[0] || {}).key || null,
  };
  const focusPageIdByKind = { floor: null, brace: null };
  // 篩選 = 各 tab 自己的 visibleTypes Set
  const visibleTypesByKind = {
    floor: new Set(_typesOf("floor").map(t => t.key)),
    brace: new Set(_typesOf("brace").map(t => t.key)),
  };
  // 平面篩選 = 各 tab 自己的 visiblePlanes Set;預設全勾
  const visiblePlanesByKind = {
    floor: new Set(["XZ"]),
    brace: new Set(["XY", "YZ"]),
  };
  // 「曾出現過」的 type / plane key — 只在「第一次出現」時才自動加進 visibleSet,
  //   避免使用者刻意取消勾選後,下次 _refreshFilterOptions 又自動補回去把篩選重置掉。
  const seenTypesByKind  = {
    floor: new Set(_typesOf("floor").map(t => t.key)),
    brace: new Set(_typesOf("brace").map(t => t.key)),
  };
  const seenPlanesByKind = {
    floor: new Set(["XZ"]),
    brace: new Set(["XY", "YZ"]),
  };
  // active-tab-scoped getters(便利別名,後面程式碼讀起來跟原本一樣)
  const _xzPages       = () => pagesByKind[activeKind];
  const _pendingMap    = () => pendingByKind[activeKind];
  const _selectedTypeKey = () => selectedTypeKeyByKind[activeKind];
  const _setSelectedTypeKey = (k) => { selectedTypeKeyByKind[activeKind] = k; };
  const _focusPageId   = () => focusPageIdByKind[activeKind];
  const _setFocusPageId = (id) => { focusPageIdByKind[activeKind] = id; };
  const _visibleTypes  = () => visibleTypesByKind[activeKind];
  const _visiblePlanes = () => visiblePlanesByKind[activeKind];
  const _planesOf = (kind) => kind === "brace" ? ["XY", "YZ"] : ["XZ"];
  let lastCheckedIdx = -1;    // 多選 anchor(切 tab 後重置)
  let filterPanelOpen = false;
  // 預覽 cache + zoom/pan 狀態
  let cachedPreviewImg = { fid: null, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };
  const previewState = { zoom: 1, offsetX: 0, offsetY: 0 };
  // 縮圖快取(本次 dialog session) — 每個 file 只 renderFileThumb 一次,之後 drawImage 直接 blit。
  //   切 tab / refresh page list / 重 render 都不會再付 SVG-decode / DXF-trace 成本。
  const _thumbCache = new Map();   // file.id → HTMLCanvasElement(112×84,已渲染好)
  const _thumbPending = new Map(); // file.id → Promise<canvas>(避免同個 file 同時觸發多次 renderFileThumb)
  const _ensureThumb = (file) => {
    if (_thumbCache.has(file.id)) return Promise.resolve(_thumbCache.get(file.id));
    if (_thumbPending.has(file.id)) return _thumbPending.get(file.id);
    const off = document.createElement("canvas");
    off.width = 112; off.height = 84;
    const p = (typeof renderFileThumb === "function"
      ? Promise.resolve().then(() => renderFileThumb(off, file)).catch(() => {})
      : Promise.resolve()
    ).then(() => {
      _thumbCache.set(file.id, off);
      _thumbPending.delete(file.id);
      return off;
    });
    _thumbPending.set(file.id, p);
    return p;
  };
  const _blitThumb = (canvas, file) => {
    // 已快取 → 同步 drawImage(零成本);沒快取 → 觸發 _ensureThumb,完成後再 drawImage
    if (_thumbCache.has(file.id)) {
      try { canvas.getContext("2d").drawImage(_thumbCache.get(file.id), 0, 0); } catch (_) {}
      return;
    }
    _ensureThumb(file).then((src) => {
      if (!src) return;
      try { canvas.getContext("2d").drawImage(src, 0, 0); } catch (_) {}
    });
  };
  const loadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  const _drawPreview = () => {
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
    } else {
      ctx.fillStyle = "#7b818a"; ctx.font = "12px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("選擇頁面以預覽", previewCanvas.width / 2, previewCanvas.height / 2);
    }
  };
  // 直接 mirror 切面 dialog 的預覽流程(loadImg + clipRect 比例切片 + SVG viewBox 重寫),
  //   不走 renderFileThumb,因為這條已驗證能渲染各種底圖格式且帶 zoom/pan。
  const _updatePreview = async (entry) => {
    if (!previewCanvas) return;
    const stage = previewCanvas.parentElement;
    const cssW = Math.max(100, Math.floor(stage.clientWidth  - 24));
    const cssH = Math.max(80,  Math.floor(stage.clientHeight - 24));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    previewCanvas.style.width  = cssW + "px";
    previewCanvas.style.height = cssH + "px";
    previewCanvas.width  = Math.round(cssW * dpr);
    previewCanvas.height = Math.round(cssH * dpr);
    if (!entry) {
      cachedPreviewImg = { fid: null, img: null, srcX:0, srcY:0, srcW:0, srcH:0, invert:false };
      if (previewName) previewName.textContent = "點選頁面以預覽 ・ 滾輪縮放 / 拖曳平移";
      previewCanvas.style.cursor = "default";
      _drawPreview();
      return;
    }
    const f = entry.file;
    const isNewFile = f.id !== cachedPreviewImg.fid;
    if (isNewFile) {
      previewState.zoom = 1;
      previewState.offsetX = 0;
      previewState.offsetY = 0;
      if (previewZoom) previewZoom.value = "1";
      if (previewZoomVal) previewZoomVal.textContent = "100%";
      cachedPreviewImg.fid = f.id;
      cachedPreviewImg.img = null;
      cachedPreviewImg.srcX = 0; cachedPreviewImg.srcY = 0;
      cachedPreviewImg.srcW = 0; cachedPreviewImg.srcH = 0;
      cachedPreviewImg.invert = false;
      const bgW = f.cachedBgWidth  || f.bgWidth  || state.bgWidth  || 1200;
      const bgH = f.cachedBgHeight || f.bgHeight || state.bgHeight || 800;
      const clip = f.clipRect ? { x: f.clipRect.x, y: f.clipRect.y, w: f.clipRect.w, h: f.clipRect.h }
                              : { x: 0, y: 0, w: bgW, h: bgH };
      if (f.cachedBgImg) {
        const invert = !f.bgImgDarkReady;
        const img = await loadImg(f.cachedBgImg);
        if (img && cachedPreviewImg.fid === f.id) {
          const sx = Math.max(0, clip.x * img.width  / bgW);
          const sy = Math.max(0, clip.y * img.height / bgH);
          const sw = Math.min(img.width  - sx, clip.w * img.width  / bgW);
          const sh = Math.min(img.height - sy, clip.h * img.height / bgH);
          cachedPreviewImg.img = img;
          cachedPreviewImg.invert = invert;
          cachedPreviewImg.srcX = sx; cachedPreviewImg.srcY = sy;
          cachedPreviewImg.srcW = sw > 0 ? sw : img.width;
          cachedPreviewImg.srcH = sh > 0 ? sh : img.height;
        }
      } else if (f.cachedBgSvg) {
        const aspect = (clip.w > 0 && clip.h > 0) ? clip.w / clip.h : 1;
        let renderW = Math.min(4096, Math.round(previewCanvas.width * 4));
        let renderH = Math.round(renderW / aspect);
        if (renderH > 4096) { renderH = 4096; renderW = Math.round(renderH * aspect); }
        let sized = f.cachedBgSvg;
        const vb = `${clip.x} ${clip.y} ${clip.w} ${clip.h}`;
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
        sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
          const cleaned = style
            .replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
            .replace(/;{2,}/g, ";")
            .replace(/^;|;$/g, "")
            .trim();
          return cleaned ? `${head} style="${cleaned}"` : head;
        });
        const blob = new Blob([sized], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        try {
          const img = await loadImg(url);
          if (img && cachedPreviewImg.fid === f.id) {
            cachedPreviewImg.img = img;
            cachedPreviewImg.invert = true;
            cachedPreviewImg.srcX = 0; cachedPreviewImg.srcY = 0;
            cachedPreviewImg.srcW = img.width; cachedPreviewImg.srcH = img.height;
          }
        } finally { URL.revokeObjectURL(url); }
      }
    }
    const pl = (f.pages && f.pages[entry.k] && f.pages[entry.k].plane) || "—";
    const yStr = (entry.page.z != null && Number.isFinite(entry.page.z)) ? `Y=${entry.page.z}` : "Y=—";
    if (previewName) previewName.textContent = `${f.name} #${entry.k + 1} ・ 平面 ${pl} ・ ${yStr} ・ 滾輪縮放 / 拖曳平移`;
    previewCanvas.style.cursor = cachedPreviewImg.img ? "grab" : "default";
    _drawPreview();
  };
  // ── 上方摘要 ─── 顯示當前 tab 的各型計數
  const _refreshSummary = () => {
    if (!summaryEl) return;
    const counts = new Map();
    for (const tk of _pendingMap().values()) counts.set(tk, (counts.get(tk) || 0) + 1);
    const parts = [];
    for (const t of _typesOf(activeKind)) {
      const c = counts.get(t.key) || 0;
      parts.push(`<span class="ft-sum-item">${escapeHtml(t.label || t.key)} <b>${c}</b> 頁</span>`);
    }
    summaryEl.innerHTML = parts.join("") || `<span style="color:#7b818a">尚無${activeKind === "brace" ? "斜撐起始" : "樓層類型"};按 ＋ 新增</span>`;
  };
  // ── tab 數字標記同步 ──────────────────────────
  const _refreshTabCounts = () => {
    const cFloor = document.getElementById("floorTypesTabCountFloor");
    const cBrace = document.getElementById("floorTypesTabCountBrace");
    if (cFloor) cFloor.textContent = `(${_typesOf("floor").length})`;
    if (cBrace) cBrace.textContent = `(${_typesOf("brace").length})`;
  };
  // ── 類型 CRUD 表 ─── 只顯示當前 tab 的 kind;yyStart 池跨 tab 共用
  const _refresh = () => {
    tbody.innerHTML = "";
    state.floorTypes.sort((a, b) => (a.yyStart || 1) - (b.yyStart || 1));
    // 當前 tab 的 type 子集
    const myTypes = _typesOf(activeKind);
    // 若 selectedTypeKey 已不在當前 tab → 退回第一個(或 null 若該 tab 空)
    if (_selectedTypeKey() && !myTypes.some(t => t.key === _selectedTypeKey())) {
      _setSelectedTypeKey(myTypes[0] ? myTypes[0].key : null);
    } else if (!_selectedTypeKey() && myTypes[0]) {
      _setSelectedTypeKey(myTypes[0].key);
    }
    // 計算「目前 tab 的 pending」各型頁數
    const pendingCounts = new Map();
    for (const tk of _pendingMap().values()) pendingCounts.set(tk, (pendingCounts.get(tk) || 0) + 1);
    // 同時要算另一 tab 的 pending,用來佔位(共用池!兩 tab 的頁數都會吃 yyStart 階)
    const otherKind = activeKind === "floor" ? "brace" : "floor";
    const otherPendingCounts = new Map();
    for (const tk of pendingByKind[otherKind].values()) otherPendingCounts.set(tk, (otherPendingCounts.get(tk) || 0) + 1);
    // 每型佔據的階集合;頁數 N 佔據 ceil(N / 10) 個階,從 yyStart 起。跨 kind 全部納入(共用一池)
    const occupiedByType = new Map();
    for (const tt of state.floorTypes) {
      const cnt = ((tt.kind || "floor") === activeKind)
        ? (pendingCounts.get(tt.key) || 0)
        : (otherPendingCounts.get(tt.key) || 0);
      const start = tt.yyStart || 1;
      const slots = Math.max(1, Math.ceil(cnt / 10));   // 至少佔自己這格
      const occ = new Set();
      const baseIdx = ALLOWED_YY.indexOf(start);
      if (baseIdx >= 0) {
        for (let i = 0; i < slots && (baseIdx + i) < ALLOWED_YY.length; i++) {
          occ.add(ALLOWED_YY[baseIdx + i]);
        }
      }
      occupiedByType.set(tt.key, occ);
    }
    // 渲染只屬於當前 tab 的 type 列
    for (let idx = 0; idx < state.floorTypes.length; idx++) {
      const t = state.floorTypes[idx];
      if ((t.kind || "floor") !== activeKind) continue;
      const tr = document.createElement("tr");
      if (t.key === _selectedTypeKey()) tr.classList.add("on");
      tr.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" ||
            e.target.tagName === "BUTTON") return;
        _setSelectedTypeKey(t.key);
        _refresh();
      });
      // row-handle —— 在 key input 前方留一小段方便點選整列
      const tdH = document.createElement("td");
      tdH.className = "ft-row-handle";
      tdH.title = "點此格選此類型";
      const dot = document.createElement("span");
      dot.className = "ft-dot";
      tdH.appendChild(dot);
      tr.appendChild(tdH);
      // key —— 輸入時自動同步到 label(只要 label 還沒被手動改過)
      const tdK = document.createElement("td");
      const inK = document.createElement("input");
      inK.type = "text"; inK.value = t.key; inK.placeholder = "main";
      inK.title = "唯一識別字串(英數 / 底線);改 key 會把該型已綁定的 page 也一起改";
      let labelManual = (t.label && t.label !== t.key);   // 已手動編過 label?
      inK.addEventListener("input", () => {
        if (!labelManual) {
          inL.value = inK.value;
          t.label = inK.value || t.key;
          _refreshSummary();
          _refreshPagesPane();
        }
      });
      inK.addEventListener("change", () => {
        const newKey = _normalizeKey(inK.value);
        if (!newKey) { inK.value = t.key; return; }
        if (newKey === t.key) { inK.value = newKey; return; }
        if (state.floorTypes.some((tt, i) => i !== idx && tt.key === newKey)) {
          alert(`類型 key「${newKey}」已存在(跨樓層 / 斜撐皆需唯一)`);
          inK.value = t.key;
          return;
        }
        const oldKey = t.key;
        t.key = newKey;
        // 同步 pending(該型已勾的 page 都跟著改 key) — 只改本 kind 的 pending
        for (const [pid, tk] of _pendingMap().entries()) {
          if (tk === oldKey) _pendingMap().set(pid, newKey);
        }
        // visibleTypes 同步
        if (_visibleTypes().has(oldKey)) { _visibleTypes().delete(oldKey); _visibleTypes().add(newKey); }
        if (_selectedTypeKey() === oldKey) _setSelectedTypeKey(newKey);
        inK.value = newKey;
        _refresh();
      });
      tdK.appendChild(inK); tr.appendChild(tdK);
      // label —— 一旦手動編過,key 變動時不再覆蓋
      const tdL = document.createElement("td");
      const inL = document.createElement("input");
      inL.type = "text"; inL.value = t.label || ""; inL.placeholder = t.key;
      inL.addEventListener("input", () => { labelManual = true; });
      inL.addEventListener("change", () => {
        t.label = inL.value.trim() || t.key;
        _refreshSummary();
        _refreshPagesPane();
      });
      tdL.appendChild(inL); tr.appendChild(tdL);
      // yyStart —— 顯示全部 10 個階,被其他型佔走的 disable + 註明擁有者
      //   這樣某型切換後空出的階會立即在其他下拉「亮起來」(由 disabled 變成可選)。
      const tdY = document.createElement("td");
      const sel = document.createElement("select");
      // 反查每個 ALLOWED_YY 值的「擁有者 type key」(被誰佔了)
      const ownerByYY = new Map();
      for (const [tk, occ] of occupiedByType.entries()) {
        for (const v of occ) if (!ownerByYY.has(v)) ownerByYY.set(v, tk);
      }
      for (const v of ALLOWED_YY) {
        const opt = document.createElement("option");
        opt.value = String(v);
        const owner = ownerByYY.get(v);
        const isSelf = owner === t.key;
        const isOther = owner && !isSelf;
        if (isOther) {
          const ot = state.floorTypes.find(tt => tt.key === owner);
          opt.textContent = `${v} — 已被「${ot ? (ot.label || ot.key) : owner}」使用`;
          opt.disabled = true;
        } else {
          opt.textContent = String(v);
        }
        if (v === (t.yyStart || 1)) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => {
        const newVal = +sel.value || 1;
        // 雙保險:選到 disabled 值就 revert(瀏覽器本應禁用,但 select 程式控制時保底)
        if (ownerByYY.get(newVal) && ownerByYY.get(newVal) !== t.key) {
          sel.value = String(t.yyStart || 1);
          return;
        }
        t.yyStart = newVal;
        _refresh();
      });
      tdY.appendChild(sel); tr.appendChild(tdY);
      // action
      const tdA = document.createElement("td");
      // 樓層 tab 的 default 內建不可刪;斜撐 tab 沒有內建型,全部可刪
      const isBuiltIn = (activeKind === "floor" && t.key === "default");
      if (!isBuiltIn) {
        const btn = document.createElement("button");
        btn.className = "del-btn"; btn.textContent = "刪除";
        btn.title = `刪除此${activeKind === "brace" ? "斜撐起始" : "樓層類型"};已綁定此 key 的 page 會 fallback 到 default`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirm(`刪除${activeKind === "brace" ? "斜撐起始" : "樓層類型"}「${t.label || t.key}」?\n已綁定此型的頁面會 fallback 到 default。`)) return;
          // pending 也一起 fallback(只動本 kind 的 pending)
          for (const [pid, tk] of _pendingMap().entries()) {
            if (tk === t.key) _pendingMap().set(pid, "default");
          }
          if (_selectedTypeKey() === t.key) _setSelectedTypeKey(null);
          state.floorTypes.splice(idx, 1);
          _refresh();
        });
        tdA.appendChild(btn);
      } else {
        const span = document.createElement("span");
        span.style.cssText = "color:#666;font-size:11px";
        span.textContent = "(內建)";
        tdA.appendChild(span);
      }
      tr.appendChild(tdA);
      tbody.appendChild(tr);
    }
    // hint:剩餘可用 yyStart 階(跨 tab 全部統計 — 共用池)
    const allBlocked = new Set();
    for (const occ of occupiedByType.values()) for (const v of occ) allBlocked.add(v);
    const remaining = ALLOWED_YY.filter(v => !allBlocked.has(v));
    if (!remaining.length) {
      hint.textContent = "所有 YY 起始階已被佔用(樓層+斜撐共用,含頁數 > 10 自動延伸的階)";
      hint.style.color = "#ff7676";
    } else {
      hint.textContent = `剩餘可用起始(全域共用): ${remaining.join(", ")}`;
      hint.style.color = "#9aa0a6";
    }
    _refreshTabCounts();
    _refreshSummary();
    _refreshFilterOptions();
    if (!_refresh._skipPagesPane) _refreshPagesPane();
  };
  // ── checkbox 點擊後的 inline 更新 ─── 避免重畫整個 page list(縮圖 re-render 很慢)
  //   只更新每列的 checkbox + 類型 meta + pagesHead 計數 + filter 顯示計數 +
  //   類型 CRUD 表(yyStart 占位可能因頁數跨 10 而變);不動 thumbnail / file name
  const _updateRowStates = () => {
    if (!pagesList) return;
    const arr = _xzPages();
    const map = _pendingMap();
    const sel = _selectedTypeKey();
    const t = sel ? state.floorTypes.find(tt => tt.key === sel) : null;
    for (const row of pagesList.querySelectorAll(".ft-page-row")) {
      const pid = row.dataset.pageId;
      if (!pid) continue;
      const entry = arr.find(e => e.id === pid);
      if (!entry) continue;
      const cb = row.querySelector("input[type=checkbox]");
      if (cb && t) cb.checked = (map.get(pid) === t.key);
      const metaEl = row.querySelector(".ft-page-meta");
      if (metaEl) {
        const cur = map.get(pid) || "default";
        const curT = state.floorTypes.find(tt => tt.key === cur && (tt.kind || "floor") === activeKind);
        const yStr = (entry.page.z != null && Number.isFinite(entry.page.z)) ? `Y=${entry.page.z}` : "Y=—";
        const planeStr = entry.page.plane || "—";
        metaEl.textContent = `${planeStr} ・ ${yStr} ・ ${curT ? (curT.label || curT.key) : cur}`;
      }
    }
    if (pagesHead && t) {
      const cnt = Array.from(map.values()).filter(v => v === t.key).length;
      pagesHead.innerHTML = `指派至 <span class="ft-sel-label">${escapeHtml(t.label || t.key)}</span> ・ 已勾 ${cnt} / ${arr.length} 頁 ・ Shift/⌘ 多選`;
    }
    if (filterCountEl) {
      const visIdx = _filteredIndices();
      filterCountEl.textContent = `顯示 ${visIdx.length} / ${arr.length}`;
    }
  };
  // 用戶 toggle 完 checkbox / 全選 / 全取消後呼叫;只更新狀態 + 上方計數,不重建 page list
  const _refreshAfterAssign = () => {
    _updateRowStates();
    // 重建類型 CRUD 表(yyStart 占位可能因頁數變);但跳過 pages list rebuild
    _refresh._skipPagesPane = true;
    try { _refresh(); } finally { delete _refresh._skipPagesPane; }
  };
  // ── 多選下拉:每個 type 一個 checkbox;勾 = 顯示,沒勾 = 隱藏 ─────
  //   filter panel 的選項 = 當前 tab 的 types + 該 tab pending 中的孤兒 key(常見:default fallback)
  const _filterEntries = () => {
    const seen = new Set();
    const entries = [];
    for (const t of _typesOf(activeKind)) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      entries.push({ key: t.key, label: t.label || t.key, orphan: false });
    }
    // 把當前 tab 的 pending 中出現過、但不在 type 清單的 key 補進來(視為 fallback / 未指派)
    for (const k of _pendingMap().values()) {
      if (!seen.has(k)) {
        seen.add(k);
        const label = (k === "default") ? "未指派(default)" : `未知類型「${k}」`;
        entries.push({ key: k, label, orphan: true });
      }
    }
    return entries;
  };
  const _refreshFilterOptions = () => {
    if (!filterPanel) return;
    const entries = _filterEntries();
    const existing = new Set(entries.map(e => e.key));
    // 同步當前 tab 的 visibleTypes:
    //   - 已不存在的 type 從 visible + seen 一起清掉
    //   - 「第一次出現」的 type 自動加進 visible(只此一次,之後使用者取消勾就尊重)
    const vis = _visibleTypes();
    const seenT = seenTypesByKind[activeKind];
    for (const k of Array.from(vis))   if (!existing.has(k)) vis.delete(k);
    for (const k of Array.from(seenT)) if (!existing.has(k)) seenT.delete(k);
    for (const k of existing) {
      if (!seenT.has(k)) { seenT.add(k); vis.add(k); }
    }
    // 同步當前 tab 的 visiblePlanes:同樣只在第一次出現時自動加,避免取消勾被重置
    const visPl = _visiblePlanes();
    const seenP = seenPlanesByKind[activeKind];
    const validPlanes = new Set(_planesOf(activeKind));
    for (const p of Array.from(visPl)) if (!validPlanes.has(p)) visPl.delete(p);
    for (const p of Array.from(seenP)) if (!validPlanes.has(p)) seenP.delete(p);
    for (const p of validPlanes) {
      if (!seenP.has(p)) { seenP.add(p); visPl.add(p); }
    }
    // 各 key 計數 + 各 plane 計數
    const counts = new Map();
    for (const tk of _pendingMap().values()) counts.set(tk, (counts.get(tk) || 0) + 1);
    const planeCounts = new Map();
    for (const e of _xzPages()) planeCounts.set(e.page.plane, (planeCounts.get(e.page.plane) || 0) + 1);
    // 重建 panel
    filterPanel.innerHTML = "";
    const quick = document.createElement("div");
    quick.className = "ft-msel-quick";
    const mkQuick = (txt, fn) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = txt;
      b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); _refreshFilterOptions(); _refreshPagesPane(); });
      return b;
    };
    quick.appendChild(mkQuick("全選", () => {
      for (const e of entries) vis.add(e.key);
      for (const p of _planesOf(activeKind)) visPl.add(p);
    }));
    quick.appendChild(mkQuick("反選", () => {
      for (const e of entries) {
        if (vis.has(e.key)) vis.delete(e.key);
        else vis.add(e.key);
      }
      for (const p of _planesOf(activeKind)) {
        if (visPl.has(p)) visPl.delete(p);
        else visPl.add(p);
      }
    }));
    quick.appendChild(mkQuick("全不選", () => { vis.clear(); visPl.clear(); }));
    filterPanel.appendChild(quick);
    // 平面 section(只在 brace tab 有意義因為有 2 個 plane;floor tab 只有 XZ 仍顯示維持一致)
    const planeHead = document.createElement("div");
    planeHead.className = "ft-msel-section-head";
    planeHead.textContent = "平面";
    filterPanel.appendChild(planeHead);
    for (const p of _planesOf(activeKind)) {
      const lbl = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = visPl.has(p);
      cb.addEventListener("change", () => {
        if (cb.checked) visPl.add(p);
        else visPl.delete(p);
        _updateFilterBtnLabel();
        _refreshPagesPane();
      });
      const txt = document.createElement("span");
      txt.textContent = `${p} 平面`;
      const meta = document.createElement("span");
      meta.className = "ft-msel-meta";
      meta.textContent = `${planeCounts.get(p) || 0} 頁`;
      lbl.appendChild(cb);
      lbl.appendChild(txt);
      lbl.appendChild(meta);
      filterPanel.appendChild(lbl);
    }
    // 類型 section
    const typeHead = document.createElement("div");
    typeHead.className = "ft-msel-section-head";
    typeHead.textContent = "類型";
    filterPanel.appendChild(typeHead);
    for (const e of entries) {
      const lbl = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = vis.has(e.key);
      cb.addEventListener("change", () => {
        if (cb.checked) vis.add(e.key);
        else vis.delete(e.key);
        _updateFilterBtnLabel();
        _refreshPagesPane();
      });
      const txt = document.createElement("span");
      txt.textContent = e.label;
      if (e.orphan) txt.style.color = "#9aa0a6";
      const meta = document.createElement("span");
      meta.className = "ft-msel-meta";
      meta.textContent = `${counts.get(e.key) || 0} 頁`;
      lbl.appendChild(cb);
      lbl.appendChild(txt);
      lbl.appendChild(meta);
      filterPanel.appendChild(lbl);
    }
    _updateFilterBtnLabel();
  };
  const _updateFilterBtnLabel = () => {
    if (!filterBtnLabel) return;
    const entries = _filterEntries();
    const totalT = entries.length;
    const vis = _visibleTypes();
    const visPl = _visiblePlanes();
    const shownT = entries.filter(e => vis.has(e.key)).length;
    const planes = _planesOf(activeKind);
    const totalP = planes.length;
    const shownP = planes.filter(p => visPl.has(p)).length;
    const parts = [];
    if (shownT === totalT) parts.push("全類型");
    else if (shownT === 0) parts.push("無類型");
    else if (shownT === 1) {
      const e = entries.find(ee => vis.has(ee.key));
      parts.push(`類型: ${e.label}`);
    } else parts.push(`${shownT}/${totalT} 類型`);
    if (totalP > 1) {
      if (shownP === totalP) parts.push("全平面");
      else if (shownP === 0) parts.push("無平面");
      else if (shownP === 1) {
        const p = planes.find(pp => visPl.has(pp));
        parts.push(`平面: ${p}`);
      } else parts.push(`${shownP}/${totalP} 平面`);
    }
    filterBtnLabel.textContent = parts.join(" ・ ");
  };
  // 用 visibleTypes + visiblePlanes 過濾出實際要顯示的 page indices(保持原順序)
  const _filteredIndices = () => {
    const arr = _xzPages();
    const map = _pendingMap();
    const vis = _visibleTypes();
    const visPl = _visiblePlanes();
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const cur = map.get(arr[i].id) || "default";
      if (!vis.has(cur)) continue;
      if (!visPl.has(arr[i].page.plane)) continue;
      out.push(i);
    }
    return out;
  };
  // ── 左下:單列頁面 list ─── 顯示當前 tab 的 page 集合(floor=XZ;brace=YZ+XY)
  const _refreshPagesPane = () => {
    if (!pagesList) return;
    const arr = _xzPages();
    const map = _pendingMap();
    const sel = _selectedTypeKey();
    const t = sel ? state.floorTypes.find(tt => tt.key === sel) : null;
    const planeHint = activeKind === "brace" ? "YZ / XY" : "XZ";
    if (pagesHead) {
      if (t) {
        const cnt = Array.from(map.values()).filter(v => v === t.key).length;
        pagesHead.innerHTML = `指派至 <span class="ft-sel-label">${escapeHtml(t.label || t.key)}</span> ・ 已勾 ${cnt} / ${arr.length} 頁 ・ Shift/⌘ 多選`;
      } else {
        pagesHead.textContent = `尚未選擇${activeKind === "brace" ? "斜撐起始" : "樓層類型"};上方表格點選或新增`;
      }
    }
    const visIdx = _filteredIndices();
    if (filterCountEl) filterCountEl.textContent = `顯示 ${visIdx.length} / ${arr.length}`;
    pagesList.innerHTML = "";
    if (!t) return;
    if (!arr.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#7b818a;font-size:11px;font-style:italic;padding:14px";
      empty.textContent = `尚無 ${planeHint} 平面圖頁面`;
      pagesList.appendChild(empty);
      return;
    }
    if (!visIdx.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#7b818a;font-size:11px;font-style:italic;padding:14px";
      empty.textContent = "當前篩選條件下無頁面";
      pagesList.appendChild(empty);
      return;
    }
    const focusId = _focusPageId();
    for (const i of visIdx) {
      const entry = arr[i];
      const row = document.createElement("div");
      row.className = "ft-page-row";
      row.dataset.pageId = entry.id;
      row.dataset.idx = String(i);
      if (entry.id === focusId) row.classList.add("active");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = (map.get(entry.id) === t.key);
      cb.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const desired = cb.checked;
        if (ev.shiftKey && lastCheckedIdx >= 0 && lastCheckedIdx !== i) {
          const visSet = new Set(visIdx);
          const lo = Math.min(lastCheckedIdx, i);
          const hi = Math.max(lastCheckedIdx, i);
          for (let j = lo; j <= hi; j++) {
            if (!visSet.has(j)) continue;
            const e = arr[j];
            if (desired) map.set(e.id, t.key);
            else if (map.get(e.id) === t.key) map.set(e.id, "default");
          }
        } else if (ev.metaKey || ev.ctrlKey) {
          if (desired) map.set(entry.id, t.key);
          else map.set(entry.id, "default");
          lastCheckedIdx = i;
        } else {
          if (desired) map.set(entry.id, t.key);
          else map.set(entry.id, "default");
          lastCheckedIdx = i;
        }
        _refreshAfterAssign();   // inline 更新,不重 render 縮圖
      });
      row.appendChild(cb);
      const thumb = document.createElement("canvas");
      thumb.className = "ft-thumb"; thumb.width = 112; thumb.height = 84;
      _blitThumb(thumb, entry.file);   // 已快取就同步 blit;沒快取就背景跑完一次,後續零成本
      row.appendChild(thumb);
      const body = document.createElement("div");
      body.className = "ft-row-body";
      const name = document.createElement("div");
      name.className = "ft-page-name";
      name.textContent = `${entry.file.name} #${entry.k + 1}`;
      const meta = document.createElement("div");
      meta.className = "ft-page-meta";
      const cur = map.get(entry.id) || "default";
      const curT = state.floorTypes.find(tt => tt.key === cur && (tt.kind || "floor") === activeKind);
      const yStr = (entry.page.z != null && Number.isFinite(entry.page.z)) ? `Y=${entry.page.z}` : "Y=—";
      const planeStr = entry.page.plane || "—";
      meta.textContent = `${planeStr} ・ ${yStr} ・ ${curT ? (curT.label || curT.key) : cur}`;
      body.appendChild(name);
      body.appendChild(meta);
      row.appendChild(body);
      row.addEventListener("click", (ev) => {
        if (ev.target === cb) return;
        _setFocusPageId(entry.id);
        // 只切換 .active class,不重建整個 list(縮圖才不會被 re-render)
        for (const r of pagesList.querySelectorAll(".ft-page-row.active")) r.classList.remove("active");
        row.classList.add("active");
        _updatePreview(entry);
      });
      pagesList.appendChild(row);
    }
  };
  // ── 全選可見 / 全取消可見 ───────────────────────
  const _bulkAssign = (assign) => {
    const sel = _selectedTypeKey();
    const t = sel ? state.floorTypes.find(tt => tt.key === sel) : null;
    if (!t) { alert("請先在上方表格選擇一個類型"); return; }
    const arr = _xzPages();
    const map = _pendingMap();
    const visIdx = _filteredIndices();
    let changed = 0;
    for (const i of visIdx) {
      const id = arr[i].id;
      if (assign) {
        if (map.get(id) !== t.key) { map.set(id, t.key); changed++; }
      } else {
        if (map.get(id) === t.key) { map.set(id, "default"); changed++; }
      }
    }
    const bulkHint = document.getElementById("floorTypesBulkHint");
    if (bulkHint) {
      bulkHint.textContent = changed > 0
        ? `${assign ? "已指派" : "已取消"} ${changed} 頁`
        : `無變動(已是${assign ? "全部指派" : "全部未指派"}狀態)`;
      setTimeout(() => { if (bulkHint) bulkHint.textContent = ""; }, 2500);
    }
    if (changed > 0) _refreshAfterAssign();
  };
  const btnBulkSelect = document.getElementById("floorTypesBulkSelectAll");
  const btnBulkClear  = document.getElementById("floorTypesBulkClearAll");
  if (btnBulkSelect) btnBulkSelect.onclick = () => _bulkAssign(true);
  if (btnBulkClear)  btnBulkClear.onclick  = () => _bulkAssign(false);
  // ── 排序下拉(每 tab 各自記)───────────────────
  const _syncSortSel = () => {
    if (sortSel) sortSel.value = sortModeByKind[activeKind] || "auto";
  };
  if (sortSel) {
    sortSel.onchange = () => {
      sortModeByKind[activeKind] = sortSel.value || "auto";
      _resortPages(activeKind);
      lastCheckedIdx = -1;     // 順序變了,multi-select anchor 失效
      _refreshPagesPane();
    };
  }
  // ── 篩選下拉 panel 開合 ──────────────────────────
  const _setFilterPanelOpen = (open) => {
    filterPanelOpen = open;
    if (filterPanel) filterPanel.classList.toggle("open", open);
    if (filterBtn)   filterBtn.classList.toggle("open", open);
  };
  if (filterBtn) {
    filterBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      _setFilterPanelOpen(!filterPanelOpen);
    });
  }
  if (filterPanel) {
    // 點 panel 內部不關(checkbox / quick 按鈕都會冒泡;阻止關閉)
    filterPanel.addEventListener("click", (ev) => ev.stopPropagation());
  }
  // 點外面(視窗其他地方)關閉 panel — 只在 dialog 範圍內監聽,避免污染全域
  dlg.addEventListener("click", () => { if (filterPanelOpen) _setFilterPanelOpen(false); });
  // ── 預覽控制 ─────────────────────────────────────
  if (previewZoom) {
    previewZoom.oninput = () => {
      previewState.zoom = +previewZoom.value || 1;
      if (previewZoomVal) previewZoomVal.textContent = Math.round(previewState.zoom * 100) + "%";
      _drawPreview();
    };
  }
  // 滾輪縮放 + 拖曳平移
  if (previewCanvas) {
    previewCanvas.onwheel = (ev) => {
      ev.preventDefault();
      const delta = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      previewState.zoom = Math.max(0.5, Math.min(4, previewState.zoom * delta));
      if (previewZoom) previewZoom.value = String(previewState.zoom);
      if (previewZoomVal) previewZoomVal.textContent = Math.round(previewState.zoom * 100) + "%";
      _drawPreview();
    };
    let panStart = null;
    previewCanvas.onmousedown = (ev) => {
      panStart = { x: ev.clientX, y: ev.clientY, ox: previewState.offsetX, oy: previewState.offsetY };
      previewCanvas.style.cursor = "grabbing";
    };
    window.addEventListener("mousemove", (ev) => {
      if (!panStart) return;
      previewState.offsetX = panStart.ox + (ev.clientX - panStart.x);
      previewState.offsetY = panStart.oy + (ev.clientY - panStart.y);
      _drawPreview();
    });
    window.addEventListener("mouseup", () => {
      if (panStart) { panStart = null; previewCanvas.style.cursor = "grab"; }
    });
  }
  // 共用:找下一個未被「實際佔據」的 yyStart 階(扣掉所有 kind 的頁數延伸 — 共用池)
  const _findNextFreeYY = () => {
    const blocked = new Set();
    for (const tt of state.floorTypes) {
      const kindMap = pendingByKind[(tt.kind || "floor")];
      const cnt = Array.from(kindMap.values()).filter(v => v === tt.key).length;
      const slots = Math.max(1, Math.ceil(cnt / 10));
      const baseIdx = ALLOWED_YY.indexOf(tt.yyStart || 1);
      if (baseIdx >= 0) for (let i = 0; i < slots && (baseIdx + i) < ALLOWED_YY.length; i++) blocked.add(ALLOWED_YY[baseIdx + i]);
    }
    return ALLOWED_YY.find(v => !blocked.has(v)) || null;
  };
  // ── 新增類型(依當前 tab 決定 kind)──────────────
  const btnAdd = document.getElementById("btnAddFloorType");
  if (btnAdd) {
    btnAdd.onclick = () => {
      if (state.floorTypes.length >= ALLOWED_YY.length) {
        alert(`已達 ${ALLOWED_YY.length} 個類型上限(樓層+斜撐共用)`);
        return;
      }
      const prefix = activeKind === "brace" ? "brace" : "type";
      let n = 1, key;
      do { key = `${prefix}${n++}`; } while (state.floorTypes.some(t => t.key === key));
      const nextStart = _findNextFreeYY();
      if (!nextStart) { alert("沒有可用的 YY 起始階(被既有類型的頁數延伸占滿)"); return; }
      state.floorTypes.push({ key, label: key, yyStart: nextStart, kind: activeKind });
      _setSelectedTypeKey(key);
      _refresh();
    };
  }
  // ── 🎯 自動建立 default 並指派未分配頁 ──
  //   1) 若當前 tab 的 kind 還沒有 key="default" 的型 → 用「下一個可用 YY 階」建一個 default
  //      若 YY 階完全沒空位 → 跳警告,提示使用者:可以調整現有 yyStart / 刪掉不要的型來釋放階,然後再試
  //   2) 把當前 tab 所有「pending 值 = 'default' 但 default 型不存在」、或「pending 為空字串 / null」的頁,
  //      統一指派到剛建好(或既有)的 default 型
  const btnAutoDefault = document.getElementById("btnAutoDefaultFloorType");
  if (btnAutoDefault) {
    btnAutoDefault.onclick = () => {
      const arr = _xzPages();
      const map = _pendingMap();
      // 當前 kind 是否已有 default 型
      let existing = state.floorTypes.find(t => t.key === "default" && (t.kind || "floor") === activeKind);
      if (!existing) {
        // 檢查上限
        if (state.floorTypes.length >= ALLOWED_YY.length) {
          if (confirm(`已達 ${ALLOWED_YY.length} 個類型上限(樓層+斜撐共用)。\n\n要先刪掉不必要的型嗎?點「確定」會留在此視窗讓你手動調整,點「取消」則直接放棄。`)) return;
          return;
        }
        const nextStart = _findNextFreeYY();
        if (!nextStart) {
          alert(
            `沒有可用的 YY 起始階了 — 樓層 + 斜撐共用同一池 (1, 11, 21, …, 91),已被既有型 + 其頁數延伸佔滿。\n\n` +
            `請手動調整現有類型(改 yyStart、刪不需要的型、或減少某型的頁數),釋出至少一階後再按一次「🎯 自動建立 default」。`
          );
          return;
        }
        state.floorTypes.push({ key: "default", label: "預設", yyStart: nextStart, kind: activeKind });
        existing = state.floorTypes[state.floorTypes.length - 1];
      }
      // 指派:未在 state.floorTypes 中對應 key 的頁(包含 pending 為 "default" 但無 default 型的情況)
      const known = new Set(state.floorTypes.filter(t => (t.kind || "floor") === activeKind).map(t => t.key));
      let assigned = 0;
      for (const entry of arr) {
        const cur = map.get(entry.id);
        if (!cur || !known.has(cur)) {
          map.set(entry.id, "default");
          assigned++;
        }
      }
      _setSelectedTypeKey("default");
      _refresh();
      if ($("hud")) {
        $("hud").textContent = assigned > 0
          ? `已建立 / 套用 default 型(起始 ${existing.yyStart})・指派 ${assigned} 頁`
          : `default 型已存在(起始 ${existing.yyStart});沒有未指派頁需要套`;
      }
    };
  }
  // ── 套用 / 完成 / 關閉 ─── 同時寫回兩 kind 的 pending
  const _commitPending = () => {
    let changed = 0, total = 0;
    // floor:寫到 pg.floorType
    for (const entry of pagesByKind.floor) {
      const tk = pendingByKind.floor.get(entry.id) || "default";
      if ((entry.page.floorType || "default") !== tk) changed++;
      entry.page.floorType = tk;
      total++;
    }
    // brace:寫到 pg.braceType
    for (const entry of pagesByKind.brace) {
      const tk = pendingByKind.brace.get(entry.id) || "default";
      if ((entry.page.braceType || "default") !== tk) changed++;
      entry.page.braceType = tk;
      total++;
    }
    invalidateRankCache();
    if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
    try { refreshLists(); } catch (_) {}
    try { if (typeof refreshPageView === "function") refreshPageView(); } catch (_) {}
    // 同步右側 dropdown:floor(XZ 頁面)+ brace(YZ / XY 頁面)各一個
    try {
      const p = (typeof getPage === "function") ? getPage() : null;
      if (p && p.plane === "XZ") {
        const selFt = document.getElementById("pageFloorType");
        if (selFt) {
          selFt.innerHTML = "";
          for (const t of _typesOf("floor")) {
            const opt = document.createElement("option");
            opt.value = t.key;
            opt.textContent = `${t.label || t.key} (起始 ${t.yyStart || 1})`;
            selFt.appendChild(opt);
          }
          selFt.value = _typesOf("floor").some(t => t.key === (p.floorType || "default")) ? (p.floorType || "default") : "default";
        }
      } else if (p && (p.plane === "YZ" || p.plane === "XY")) {
        const selBt = document.getElementById("pageBraceType");
        if (selBt) {
          selBt.innerHTML = "";
          const list = [{ key: "default", label: "default(不指派)", yyStart: null }].concat(_typesOf("brace"));
          for (const t of list) {
            const opt = document.createElement("option");
            opt.value = t.key;
            opt.textContent = (t.yyStart != null) ? `${t.label || t.key} (起始 ${t.yyStart})` : (t.label || t.key);
            selBt.appendChild(opt);
          }
          selBt.value = list.some(t => t.key === (p.braceType || "default")) ? (p.braceType || "default") : "default";
        }
      }
    } catch (_) {}
    render();
    return { changed, total };
  };
  // 關閉 dialog 時清掉 _thumbCache(避免多檔案多 session 累積佔記憶體);
  //   下次開啟時第一輪重 render 雖然會付一次成本,但同一個 dialog session 內仍是零成本。
  const _closeDlg = () => {
    dlg.classList.remove("active");
    try { _thumbCache.clear(); _thumbPending.clear(); } catch (_) {}
  };
  // 把 commit 包進 withBusy:大模型上 invalidateRankCache + inferAllGlobalJoints + refresh* + render 可能要 100~1000ms。
  // withBusy 會顯示 spinner + msg、把工作 defer 到下一幀讓 spinner 先 paint,完成後 spinner 自動消失。
  const _commitWithBusy = (msg, afterFn) => withBusy(msg, async () => {
    const res = _commitPending();
    if ($("hud")) {
      $("hud").textContent = res.changed > 0
        ? `已套用節點編號管理 ・ 變動 ${res.changed} / ${res.total} 頁 ・ ${state.floorTypes.length} 型`
        : `節點編號管理已是最新狀態(${res.total} 頁無變動)`;
    }
    if (typeof afterFn === "function") afterFn();
  });
  const btnApply = document.getElementById("btnApplyFloorTypes");
  if (btnApply) btnApply.onclick = () => _commitWithBusy("套用節點編號管理中…");
  const btnDone = document.getElementById("btnDoneFloorTypes");
  if (btnDone) btnDone.onclick = () => _commitWithBusy("套用節點編號管理中…", _closeDlg);
  const btnCancel = document.getElementById("btnCancelFloorTypes");
  if (btnCancel) btnCancel.onclick = _closeDlg;   // 同 × — 丟棄未套用變更
  const btnClose = document.getElementById("floorTypesClose");
  if (btnClose) btnClose.onclick = _closeDlg;
  // 點 mask 關閉(視窗本體 = .dlg-card,點到 mask 才關)
  const mask = dlg.querySelector(".ft-mask");
  if (mask) mask.onclick = _closeDlg;
  // ── 拖曳標題列移動視窗 — 第一次開啟時 init,複用同個 handler
  if (!openFloorTypesDialog._dragInited) {
    openFloorTypesDialog._dragInited = true;
    const card = dlg.querySelector(".dlg-card");
    const tbar = dlg.querySelector(".ft-titlebar");
    if (card && tbar) {
      let drag = null;
      tbar.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.classList.contains("ft-close")) return;
        const rect = card.getBoundingClientRect();
        card.style.position = "absolute";
        card.style.left = rect.left + "px";
        card.style.top  = rect.top  + "px";
        card.style.margin = "0";
        drag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const maxX = window.innerWidth - 60;
        const maxY = window.innerHeight - 40;
        const nx = Math.max(-card.offsetWidth + 100, Math.min(maxX, drag.left + (e.clientX - drag.startX)));
        const ny = Math.max(0, Math.min(maxY, drag.top + (e.clientY - drag.startY)));
        card.style.left = nx + "px";
        card.style.top  = ny + "px";
      });
      window.addEventListener("mouseup", () => { drag = null; });
    }
  }
  // ── tab 切換 ───────────────────────────────────
  const _switchTab = (kind) => {
    if (activeKind === kind) return;
    // 先把所有「跟 tab 有關的資料狀態」一次切過去,_refresh / _updatePreview 才會用到一致的新狀態
    activeKind = kind;
    lastCheckedIdx = -1;
    _setFocusPageId(null);          // 切 tab = 視同沒選任何頁面,清掉舊 tab 的 focus
    cachedPreviewImg.fid = null;    // 預覽 cache 也清空,避免短暫顯示前一 tab 的圖
    for (const el of dlg.querySelectorAll(".ft-tab")) {
      el.classList.toggle("active", el.getAttribute("data-ft-kind") === kind);
    }
    _setFilterPanelOpen(false);
    _syncSortSel();
    // 資料全部切完才開始 render
    _refresh();
    _updatePreview(null);   // 顯示「選擇頁面以預覽」文字,不自動載入第一頁
  };
  for (const el of dlg.querySelectorAll(".ft-tab")) {
    el.addEventListener("click", () => _switchTab(el.getAttribute("data-ft-kind")));
  }
  // 啟動 — 注意 dialog DOM 是重複使用的,上次的 tab .active class 會殘留;
  //   必須先把視覺 tab 強制同步到本次的 activeKind(初始 "floor"),否則會出現
  //   「tab 顯示斜撐,實際資料是樓層」的不一致(因為 _refresh 是看 activeKind)。
  for (const el of dlg.querySelectorAll(".ft-tab")) {
    el.classList.toggle("active", el.getAttribute("data-ft-kind") === activeKind);
  }
  _syncSortSel();
  _refresh();
  dlg.classList.add("active");
  // 開啟時不自動載入第一頁預覽 — 顯示「選擇頁面以預覽」文字,等使用者點任一列才出圖
  requestAnimationFrame(() => _updatePreview(null));
}
