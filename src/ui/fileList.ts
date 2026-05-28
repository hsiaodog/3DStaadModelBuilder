// 左側欄檔案清單(#fileList)
//
//   • fileTypeLabel / filePlaneLabel — 檔案類型 / 平面標籤(DXF / PDF / IMG / XY / YZ / XZ)
//   • refreshFileList — 重渲整個檔案清單(含 visibility / drag-reorder / ctx menu / delete)
//   • showFileCtxMenu / deleteSelectedFiles — 右鍵 ctx menu + 多檔刪除
//   • refreshPageSelector — 當前檔案的頁面下拉清單
// @ts-nocheck

import {
  $, state, getActiveFile, pushUndo, render, refreshLists,
  activatePage, activatePageWithBusy, initBlank,
  _t,
} from "../legacy";
import { ctxState } from "../dialogs/ctxMenu";

export function fileTypeLabel(f) {
  if (!f) return "";
  // 沿著 sourceFileId 鏈往上找到根來源檔
  let cur = f, isSplit = false, guard = 0;
  while (cur && cur.sourceFileId && guard < 16) {
    isSplit = true;
    const next = state.files.find(x => x.id === cur.sourceFileId);
    if (!next || next === cur) break;
    cur = next;
    guard++;
  }
  let base;
  if (cur.type === "application/dxf") base = "DXF";
  else if (cur.type === "application/pdf" || cur.pdf) base = "PDF";
  else if (cur.type && String(cur.type).startsWith("image/")) base = "IMG";
  else base = "—";
  return isSplit ? base + "-S" : base;
}
// 檔案平面標記:讀第 1 頁的 plane / page.z,給檔案清單上的 badge 用
//   單頁:回傳該頁的 plane(XY/XZ/YZ);若是 XZ 且有 page.z 就附上 @標高
//   多頁且 plane 不一致:回傳 "Multi"
//   未設 plane:回傳 "—"
// 回傳 { plane: { text, title, cls }, axis: { text, title } | null }
//   plane:平面標籤(XY / XZ / YZ / Multi / —)
//   axis:第三軸數值標籤(若有 firstPg.z),沒有就回 null
export function filePlaneLabel(f) {
  const empty = { plane: { text: "—", title: "未設定平面", cls: "plane-none" }, axis: null };
  if (!f || !f.pages) return empty;
  const keys = Object.keys(f.pages);
  if (!keys.length) return empty;
  const planes = new Set();
  let firstPg = null;
  for (const k of keys) {
    const pg = f.pages[k];
    if (!pg) continue;
    if (!firstPg) firstPg = pg;
    if (pg.plane) planes.add(pg.plane);
  }
  if (!planes.size) return empty;
  if (planes.size > 1) {
    return { plane: { text: "Multi", title: `多頁不同平面:${[...planes].join(", ")}`, cls: "plane-multi" }, axis: null };
  }
  const plane = [...planes][0];
  const cls = "plane-" + plane.toLowerCase();
  const axisName = plane === "XZ" ? "Y" : plane === "YZ" ? "X" : "Z";
  let title = `${plane} 平面`;
  let axis = null;
  if (firstPg && firstPg.z != null && isFinite(firstPg.z)) {
    if (plane === "XZ")      title += `(Y 軸標高 = ${firstPg.z})`;
    else if (plane === "XY") title += `(Z 深度 = ${firstPg.z})`;
    else if (plane === "YZ") title += `(X 位置 = ${firstPg.z})`;
    axis = { text: String(firstPg.z), title: `第三軸 ${axisName} = ${firstPg.z}` };
  }
  return { plane: { text: plane, title, cls }, axis };
}

// 座標 / 長度顯示精度:預設 DXF=2 位、其他=0 位;
// 使用者可在左欄「顯示設定 → 座標小數位數」覆寫(state.coordDecimals,0~6)
export function refreshFileList() {
  const c = $("fileList");
  if (!c) return;
  c.innerHTML = "";
  if (!state.files.length) {
    c.innerHTML = `<div style="color:#9aa0a6;font-size:11px;padding:6px">${(typeof _t==="function"&&_t("list.noFiles"))||"尚未載入任何檔案"}</div>`;
    return;
  }
  // 排序規則:Y 軸標高由大到小(僅 XZ 平面有效,其他無 Y 標高的檔放後面),其次依名稱
  //   - 取每個 file 第 1 頁的 page.z 當代表(平面圖 XZ 的本頁 Y 標高)
  //   - 若 file 有任何 XZ 頁面 → 用該頁 z;否則 z = -Infinity 排到後面
  //   - z 相同(或皆無)→ 用 localeCompare(numeric)
  const fileElev = (f) => {
    if (!f.pages) return -Infinity;
    let best = -Infinity;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (pg && pg.plane === "XZ" && pg.z != null && isFinite(pg.z)) {
        if (pg.z > best) best = pg.z;
      }
    }
    return best;
  };
  const sorted = [...state.files].sort((a, b) => {
    const za = fileElev(a), zb = fileElev(b);
    if (za !== zb) return zb - za;     // Y 大的在前
    // 名稱倒序(Z..A、numeric 9..1)— 跟切面對話框 / 切面 section 清單一致
    return String(b.name).localeCompare(String(a.name), undefined, { numeric: true, sensitivity: "base" });
  });
  // 渲染完成後把「可見順序」記到每個 file 上,以便 Shift 範圍選取使用
  sorted.forEach((f, idx) => { f._listIdx = idx; });
  for (const f of sorted) {
    const div = document.createElement("div");
    div.className = "file-item";
    if (state.activeFileId === f.id) div.classList.add("active");
    if (state.selection.fileIds.has(f.id)) div.classList.add("sel");
    div.title = f.name;          // 完整檔名 native tooltip
    const pg = (f.pages && f.pages[0]) || null;
    const show = state.fileListShow || { type: true, plane: true, stats: true };
    const nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    const isOriginFile = (state.globalOriginFileId === f.id);
    nameSpan.textContent = (isOriginFile ? "★ " : "") + f.name;
    if (isOriginFile) {
      nameSpan.style.color = "#ffd23f";
      nameSpan.title = `全局原點檔案:本檔的 planeOrigin + pageZ 即為世界 (0,0,0)\n${f.name}`;
    }
    if (show.type !== false) {
      const typeLbl = fileTypeLabel(f);
      const typeSpan = document.createElement("span");
      typeSpan.className = "file-type " + typeLbl.toLowerCase();
      typeSpan.textContent = typeLbl;
      div.appendChild(typeSpan);
    }
    div.appendChild(nameSpan);
    if (show.plane !== false) {
      const lbl = filePlaneLabel(f);
      const planeSpan = document.createElement("span");
      planeSpan.className = "file-plane";
      planeSpan.textContent = lbl.plane.text;
      planeSpan.title = lbl.plane.title;
      if (lbl.plane.cls) planeSpan.classList.add(lbl.plane.cls);
      div.appendChild(planeSpan);
      if (lbl.axis) {
        const axisSpan = document.createElement("span");
        axisSpan.className = "file-plane file-axis";
        axisSpan.textContent = lbl.axis.text;
        axisSpan.title = lbl.axis.title;
        if (lbl.plane.cls) axisSpan.classList.add(lbl.plane.cls);
        div.appendChild(axisSpan);
      }
      // 主關聯 badge:檔案 sectionLinks 內有非 autoProp 的 entry 才顯示。
      //   設計信念:「主關聯」一律掛在 sectionLinks 上(autoProp 是衍生),
      //   所以跨平面衍生的目標頁不會誤標(它們本身的 sectionLinks 不含這些衍生)。
      const hasPrimary = Array.isArray(f.sectionLinks) && f.sectionLinks.some(e => !e.autoProp);
      if (hasPrimary) {
        const primCount = f.sectionLinks.filter(e => !e.autoProp).length;
        const primSpan = document.createElement("span");
        primSpan.className = "file-plane file-primary";
        primSpan.textContent = "主";
        primSpan.title = `本頁有 ${primCount} 條主關聯切面`;
        div.appendChild(primSpan);
      }
    }
    if (show.stats !== false) {
      const stats = pg ? `${pg.joints.length}節 ${pg.members.length}桿` : "—";
      const statsSpan = document.createElement("span");
      statsSpan.className = "file-stats";
      statsSpan.textContent = stats;
      div.appendChild(statsSpan);
    }
    div.onclick = (e) => {
      const ctrl  = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      if (shift && state.selection.fileAnchor != null) {
        // Shift:anchor → 本次點擊的可見索引區間全選
        const anchor = state.files.find(ff => ff.id === state.selection.fileAnchor);
        const a = anchor ? anchor._listIdx : f._listIdx;
        const b = f._listIdx;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        state.selection.fileIds.clear();
        for (const ff of sorted) {
          if (ff._listIdx >= lo && ff._listIdx <= hi) state.selection.fileIds.add(ff.id);
        }
        refreshFileList();
      } else if (ctrl) {
        // Ctrl / Cmd:切換單一項目
        if (state.selection.fileIds.has(f.id)) state.selection.fileIds.delete(f.id);
        else state.selection.fileIds.add(f.id);
        state.selection.fileAnchor = f.id;
        refreshFileList();
      } else {
        // 一般點擊:單選,並切到該檔頁面
        state.selection.fileIds.clear();
        state.selection.fileIds.add(f.id);
        state.selection.fileAnchor = f.id;
        activatePageWithBusy(f.id, 0);
      }
    };
    div.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!state.selection.fileIds.has(f.id)) {
        state.selection.fileIds.clear();
        state.selection.fileIds.add(f.id);
        state.selection.fileAnchor = f.id;
      }
      showFileCtxMenu(e.clientX, e.clientY);
      refreshFileList();
    };
    c.appendChild(div);
  }
}

export function showFileCtxMenu(x, y) {
  if (!state.selection.fileIds.size) return;
  ctxState.pending = {
    fileIds: new Set(state.selection.fileIds),
    joints: new Set(), members: new Set(), orphans: new Set(),
  };
  $("ctxRename").style.display = (ctxState.pending.fileIds.size === 1) ? "block" : "none";
  $("ctxDuplicate") && ($("ctxDuplicate").style.display = (ctxState.pending.fileIds.size === 1) ? "block" : "none");
  $("ctxOpenTab") && ($("ctxOpenTab").style.display = "block");
  $("ctxDelete").style.display = "block";
  $("ctxFilterGroup").style.display = "none";
  $("ctxBgSplit").style.display = "none";
  $("ctxBgScaleRuler") && ($("ctxBgScaleRuler").style.display = "none");
  $("ctxBgToMember").style.display = "none";
  $("ctxBgToDashed") && ($("ctxBgToDashed").style.display = "none");
  $("ctxHead").textContent = `已選取 ${ctxState.pending.fileIds.size} 個檔案`;
  const list = $("ctxList");
  list.innerHTML = "";
  for (const fid of ctxState.pending.fileIds) {
    const f = state.files.find(ff => ff.id === fid);
    if (!f) continue;
    const d = document.createElement("div");
    d.className = "ctx-list-item";
    d.title = f.name;
    d.textContent = f.name;
    list.appendChild(d);
  }
  const m = $("ctxMenu");
  m.style.display = "flex";
  m.style.left = "0px"; m.style.top = "0px";
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + "px";
  m.style.top  = Math.min(y, window.innerHeight - h - 4) + "px";
}

export function deleteSelectedFiles() {
  if (!state.selection.fileIds.size) return;
  // 一律跳出確認訊息:列出即將刪除的檔案名稱
  const ids = new Set(state.selection.fileIds);
  const names = state.files.filter(f => ids.has(f.id)).map(f => f.name);
  const msg = names.length === 1
    ? `確定刪除檔案「${names[0]}」?\n此動作會一併移除其所有標線、比例尺、原點等資料。`
    : `確定刪除以下 ${names.length} 個檔案?\n此動作會一併移除其所有標線、比例尺、原點等資料。\n\n${names.map(n => "• " + n).join("\n")}`;
  if (!confirm(msg)) return;
  pushUndo();
  // 在移除之前:若有其他檔案以 sourceFileId 指向即將被刪的檔案,先把底圖資料搬移給仍存活的依賴檔,
  // 並修正其他依賴檔的 sourceFileId 指向新主,避免原圖被刪後衍生檔變空白。
  for (const deletingId of ids) {
    const src = state.files.find(f => f.id === deletingId);
    if (!src) continue;
    const dependents = state.files.filter(f =>
      !ids.has(f.id) && (f.sourceFileId === deletingId || f.sourceFileId === src.sourceFileId && f.id !== deletingId)
    );
    if (!dependents.length) continue;
    // 選一個存活的依賴檔接手(優先挑本來就缺 own 快取的;否則選第一個)
    const heir = dependents.find(f => !f.pdf && !f.image && !f.cachedBgSvg && !f.cachedBgImg) || dependents[0];
    if (src.pdf && !heir.pdf) { heir.pdf = src.pdf; heir.pdfPage = heir.pdfPage || src.pdfPage; }
    if (src.image && !heir.image) {
      heir.image = src.image;
      heir.imageWidth  = heir.imageWidth  || src.imageWidth;
      heir.imageHeight = heir.imageHeight || src.imageHeight;
    }
    if (src.cachedBgSvg && !heir.cachedBgSvg) heir.cachedBgSvg = src.cachedBgSvg;
    if (src.cachedBgImg && !heir.cachedBgImg) heir.cachedBgImg = src.cachedBgImg;
    if (src.cachedBgWidth  && !heir.cachedBgWidth)  heir.cachedBgWidth  = src.cachedBgWidth;
    if (src.cachedBgHeight && !heir.cachedBgHeight) heir.cachedBgHeight = src.cachedBgHeight;
    if (src.detectedStrokeWidth && !heir.detectedStrokeWidth) heir.detectedStrokeWidth = src.detectedStrokeWidth;
    heir.sourceFileId = null;   // 它現在是自己的主檔
    // 其他依賴檔全部改指向 heir
    for (const d of dependents) if (d !== heir && d.sourceFileId === deletingId) d.sourceFileId = heir.id;
    console.log(`[刪除] ${src.name} 的底圖資料轉移給 ${heir.name}(${dependents.length - 1} 個其他依賴檔改指向)`);
  }
  // 清掉其他檔的 primary section link 中,指向「即將被刪」這幾個檔的 targetFileIds —
  //   不清掉的話會留下指向已不存在 file id 的 dangling reference,
  //   切面 section list 會出現「→ ?」、衍生計算也會撞到 missing target 而靜默濾掉。
  const slCleanup = [];
  for (const f of state.files) {
    if (ids.has(f.id)) continue;          // 自己也要被刪 → 反正整檔會丟,不用清 sectionLinks
    if (!Array.isArray(f.sectionLinks) || !f.sectionLinks.length) continue;
    const keep = [];
    for (const e of f.sectionLinks) {
      if (e.autoProp || !Array.isArray(e.targetFileIds)) { keep.push(e); continue; }
      const before = e.targetFileIds.slice();
      const after = before.filter(t => !ids.has(t));
      if (after.length === before.length) { keep.push(e); continue; }
      const dropped = before.filter(t => ids.has(t));
      if (after.length === 0) {
        slCleanup.push({ host: f.name, entryId: e.id, action: "remove-entry", droppedTargets: dropped });
      } else {
        e.targetFileIds = after;
        slCleanup.push({ host: f.name, entryId: e.id, action: "trim-targets", droppedTargets: dropped, remaining: after.slice() });
        keep.push(e);
      }
    }
    if (keep.length !== f.sectionLinks.length) f.sectionLinks = keep;
  }
  if (slCleanup.length) console.log("[刪除] 清理其他檔的主關聯 targetFileIds:", slCleanup);
  state.files = state.files.filter(f => !ids.has(f.id));
  state.selection.fileIds.clear();
  if (!state.files.find(f => f.id === state.activeFileId)) {
    const next = state.files[0];
    if (next) { activatePage(next.id, 0); return; }
    state.activeFileId = null; state.pageIdx = 0;
    initBlank();
  }
  refreshFileList(); refreshPageSelector();
  if (typeof refreshTabBar === "function") refreshTabBar();
  render(); refreshLists();
}

export function refreshPageSelector() {
  const sel = $("pageSelector");
  if (!sel) return;
  sel.innerHTML = "";
  for (const f of state.files) {
    for (let i = 0; i < f.pageCount; i++) {
      const opt = document.createElement("option");
      opt.value = `${f.id}/${i}`;
      const pg = (f.pages && f.pages[i]) || null;
      const stats = pg ? ` (${pg.joints.length}節 ${pg.members.length}桿)` : "";
      opt.textContent = `${f.name}${f.pdf ? ` · 第${i + 1}頁` : ""}${stats}`;
      if (state.activeFileId === f.id && state.pageIdx === i) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  if (!sel.children.length) {
    const opt = document.createElement("option");
    opt.textContent = (typeof _t === "function" && _t("rb.pageNotLoaded")) || "尚未載入";
    opt.disabled = true;
    sel.appendChild(opt);
  }
}

