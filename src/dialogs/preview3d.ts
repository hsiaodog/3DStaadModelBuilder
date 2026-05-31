// @ts-nocheck
// Phase 8k — 3D 立體預覽 popup(獨立浮動視窗)
//   跳出後可拖移 / 縮放,跟主畫面同時運作。
//   操作:中鍵拖曳 = 旋轉、滾輪 = 縮放、Shift+中鍵 或 右鍵 = 平移、Hover = 詳情。
//   切面拼減、視角預設(俯視 / 正面 / 側面 / 等軸)、顯示控制。
//
//   依賴(全部已 export):
//     • $, state — legacy
//     • _3dPreviewWindow / setP3dPreviewWindow — legacy(let + setter,ESM 跨模組寫)
//     • activatePage / activatePageWithBusy — legacy
//     • cleanupBadGlobalJoints / consolidateAllPagesWithConfirm — legacy
//     • findAllExtendableMembers / _runFitMergeByPrecision — legacy
//     • _zoomMainCanvasToRect — legacy
//     • relayoutNumberingAll / relayoutMembersNumberingAll — legacy
//     • displayMemberId / refreshLists / render — legacy
//     • openSearchWindow — legacy
//     • _startSaveWithHook — legacy(Cmd+S 鏡像)
//     • _displayIdForJointWith — core/displayId
//     • joint2DToWorld3D — core/projection
//     • _t / _applyI18nOnDoc — i18n
//     • setBusyMessage — ui/busy

import {
  $, state,
  _3dPreviewWindow, setP3dPreviewWindow,
  activatePage, activatePageWithBusy,
  cleanupBadGlobalJoints, consolidateAllPagesWithConfirm,
  findAllExtendableMembers, _runFitMergeByPrecision,
  _zoomMainCanvasToRect,
  relayoutNumberingAll, relayoutMembersNumberingAll,
  displayMemberId, refreshLists, render,
  openSearchWindow, _startSaveWithHook,
  fmtWorld3D,
} from "../app/integration";
import { _displayIdForJointWith } from "../core/displayId";
import { joint2DToWorld3D } from "../core/projection";
import { supportTypeOf, hasSupport } from "../core/support";
import { _t, _applyI18nOnDoc } from "../i18n";
import { setBusyMessage } from "../ui/busy";

export function open3DPreviewDialog() {
  // 若已開:focus 並 rebuild 資料
  if (_3dPreviewWindow && _3dPreviewWindow.win && !_3dPreviewWindow.win.closed) {
    try { _3dPreviewWindow.win.focus(); } catch (_) {}
    if (typeof _3dPreviewWindow.rebuildData === "function") _3dPreviewWindow.rebuildData();
    return;
  }
  // 打開真正的瀏覽器彈出視窗(獨立於主 tab,可拖到 browser 外)
  const popupFeatures = "popup=yes,width=1000,height=760,scrollbars=no,resizable=yes";
  const win = window.open("", "STAAD_3D_Preview_" + Date.now(), popupFeatures);
  if (!win) {
    alert("彈出視窗被瀏覽器擋住了。請允許這個網站開啟彈窗(網址列右側有圖示可調整),再試一次。");
    return;
  }
  // 寫入基本 HTML / CSS
  win.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head>
<title>3D 立體預覽 - STAAD</title>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: #0a0b0d; color: #ddd;
         font-family: -apple-system, system-ui, "Microsoft JhengHei", sans-serif;
         overflow: hidden; user-select: none; }
  #controls { background: #1a1b1e; border-bottom: 1px solid #2a2b2e;
              padding: 6px 8px; display: flex; gap: 6px; flex-wrap: wrap;
              align-items: center; font-size: 11px;
              max-height: 130px; overflow-y: auto; }
  #canvasWrap { position: absolute; left: 0; right: 0; bottom: 24px; background: #0a0b0d; overflow: hidden; }
  #canvasWrap canvas { display: block; }
  #tooltip { position: absolute; display: none; pointer-events: none; z-index: 10;
             background: rgba(20,22,26,0.95); border: 1px solid #555; border-radius: 4px;
             padding: 6px 10px; font-size: 11px; color: #eee;
             font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
             white-space: pre; line-height: 1.5; box-shadow: 0 4px 12px rgba(0,0,0,0.6); }
  #footer { position: absolute; bottom: 0; left: 0; right: 0; height: 24px;
            padding: 4px 10px; background: #1a1b1e; border-top: 1px solid #2a2b2e;
            font-size: 10px; color: #9aa0a6;
            font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
            display: flex; align-items: center; overflow: hidden; white-space: nowrap; }
  button { padding: 3px 8px; font-size: 11px; background: #26282c; border: 1px solid #444;
           color: #ddd; border-radius: 3px; cursor: pointer; font-family: inherit; }
  button:hover { background: #33363a; }
  button.active { background: #4f9dff; border-color: #4f9dff; color: #fff; }
  button.mini { padding: 2px 6px; font-size: 10px; min-width: 22px; }
  select { font-size: 11px; padding: 2px; background: #26282c; border: 1px solid #444;
           color: #ddd; border-radius: 3px; font-family: inherit; }
  input[type=range] { vertical-align: middle; }
  input[type=checkbox] { vertical-align: middle; margin: 0 3px 0 0; }
  .gp { display: flex; gap: 3px; align-items: center; padding: 2px 6px;
        border-right: 1px solid #2a2b2e; }
  .gp:last-child { border-right: none; }
  .lbl { color: #9aa0a6; font-size: 10px; margin-right: 3px; }
  .ck { display: inline-flex; align-items: center; gap: 0; cursor: pointer;
        margin: 0 4px 0 0; font-size: 11px; }
</style></head><body></body></html>`);
  win.document.close();
  const doc = win.document;
  const body = doc.body;
  // 讓 body 可接收 keyboard focus → 不用點任何元素,popup 一開就能接 ←/→ 等鍵
  body.tabIndex = -1;
  body.style.outline = "none";

  // ===== UI 建立 =====
  const controls = doc.createElement("div");
  controls.id = "controls";
  body.appendChild(controls);
  const canvasWrap = doc.createElement("div");
  canvasWrap.id = "canvasWrap";
  body.appendChild(canvasWrap);
  const canvas = doc.createElement("canvas");
  canvasWrap.appendChild(canvas);
  const tooltip = doc.createElement("div");
  tooltip.id = "tooltip";
  canvasWrap.appendChild(tooltip);
  // 點擊資訊匡:點 node / edge 時固定顯示,內含可點擊的「→ 頁面」按鈕讓主視窗跳到該頁
  const infoPanel = doc.createElement("div");
  Object.assign(infoPanel.style, {
    position: "absolute", display: "none", zIndex: "11",
    background: "rgba(15, 17, 22, 0.88)", border: "1px solid #444",
    borderRadius: "4px", padding: "6px 9px",
    fontSize: "10px", color: "#ddd",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: "1.55", minWidth: "160px", maxWidth: "320px",
  });
  infoPanel.addEventListener("mousedown", (e) => e.stopPropagation());
  canvasWrap.appendChild(infoPanel);
  let _infoLastAnchor = null;   // 最後一次點擊的 client 座標(視窗 resize 時據此重新貼齊)
  function hideInfoPanel() { infoPanel.style.display = "none"; infoPanel.innerHTML = ""; _infoLastAnchor = null; }
  function repositionInfoPanel() {
    if (infoPanel.style.display === "none" || !_infoLastAnchor) return;
    _layoutInfoPanel(_infoLastAnchor.cx, _infoLastAnchor.cy);
  }
  async function _activatePageFromPopup(fileId, pageIdx, focusTarget) {
    // 在 3D popup 顯示 pending overlay,讓使用者知道跳轉流程在跑(不用去猜是否凍住)
    const srcFile = state.files.find(x => x.id === fileId);
    const pageLabel = srcFile ? `「${srcFile.name}」第 ${pageIdx + 1} 頁` : `頁面 ${pageIdx + 1}`;
    try { if (typeof showPopupBusy === "function") showPopupBusy(`切換到 ${pageLabel}…`); } catch (_) {}
    try { if (typeof startMirrorBusy === "function") startMirrorBusy(); } catch (_) {}
    try {
      try { window.focus(); } catch (_) {}
      try {
        if (typeof activatePageWithBusy === "function") {
          await activatePageWithBusy(fileId, pageIdx);
        } else if (typeof activatePage === "function") {
          await activatePage(fileId, pageIdx);
        }
      } catch (e) { console.warn("[3D 跳頁] 失敗", e); return; }
      // 跳完頁後,如果指定了 focus 目標(joint / member id),在主畫面把視野縮放到該位置
      if (!focusTarget || typeof _zoomMainCanvasToRect !== "function") return;
      try { if (typeof showPopupBusy === "function") showPopupBusy(`計算視野範圍 ${pageLabel}…`); } catch (_) {}
      try {
        const f = state.files.find(x => x.id === fileId);
        const pg = f && f.pages && f.pages[pageIdx];
        if (!pg) return;
        if (focusTarget.type === "joint") {
          const j = (pg.joints || []).find(jj => jj.id === focusTarget.id);
          if (!j) return;
          // 以節點為中心,先膨脹成 ~400mm 方框再套 0.5 padding → 視野約 800mm × 800mm,看得到周圍桿件
          const R = 400;
          _zoomMainCanvasToRect(j.x - R, j.y - R, j.x + R, j.y + R, 0.5);
          // 最後一步:選取該 joint 讓使用者一眼看到
          try { if (typeof showPopupBusy === "function") showPopupBusy(`選取目標節點 J${focusTarget.id}…`); } catch (_) {}
          try {
            state.selection.joints  = new Set([j.id]);
            state.selection.members = new Set();
            render && render();
            refreshLists && refreshLists();
          } catch (_) {}
        } else if (focusTarget.type === "member") {
          const m = (pg.members || []).find(mm => mm.id === focusTarget.id);
          if (!m) return;
          const a = (pg.joints || []).find(jj => jj.id === m.j1);
          const b = (pg.joints || []).find(jj => jj.id === m.j2);
          if (!a || !b) return;
          // 桿件 bbox + 1.0 padding → 視野約 3× 桿長 / 桿高,看得到接到的相鄰桿件
          _zoomMainCanvasToRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), 1.0);
          // 最後一步:選取該 member
          try { if (typeof showPopupBusy === "function") showPopupBusy(`選取目標桿件 M${focusTarget.id}…`); } catch (_) {}
          try {
            state.selection.joints  = new Set();
            state.selection.members = new Set([m.id]);
            render && render();
            refreshLists && refreshLists();
          } catch (_) {}
        }
      } catch (e) { console.warn("[3D 跳頁:zoom 失敗]", e); }
    } finally {
      try { if (typeof stopMirrorBusy === "function") stopMirrorBusy(); } catch (_) {}
      try { if (typeof hidePopupBusy === "function") hidePopupBusy(); } catch (_) {}
    }
  }
  function _layoutInfoPanel(cx, cy) {
    const r = canvasWrap.getBoundingClientRect();
    // 固定貼右側,排在圖例下方(避免擋住 3D 主體與圖例)
    //   若右側放不下(視窗太矮)→ 改貼左側,排在 pageSnapLabel 下方
    const ipW = infoPanel.offsetWidth, ipH = infoPanel.offsetHeight;
    const margin = 8;
    const legendBottom = (legend && legend.style.display !== "none")
      ? (legend.offsetTop + legend.offsetHeight) : 0;
    const snapBottom = (pageSnapLabel && pageSnapLabel.style.display !== "none")
      ? (pageSnapLabel.offsetTop + pageSnapLabel.offsetHeight) : 0;
    const rightTop = legendBottom + margin;
    const leftTop  = snapBottom  + margin;
    let left, top;
    if (rightTop + ipH + margin <= r.height) {
      left = Math.max(margin, r.width - ipW - margin);
      top  = rightTop;
    } else if (leftTop + ipH + margin <= r.height) {
      left = margin;
      top  = leftTop;
    } else {
      left = Math.max(margin, r.width - ipW - margin);
      top  = Math.max(margin, r.height - ipH - margin);
    }
    infoPanel.style.left = left + "px";
    infoPanel.style.top  = top  + "px";
  }
  function showInfoPanel(cx, cy, html) {
    infoPanel.innerHTML = html;
    infoPanel.style.display = "block";
    _infoLastAnchor = { cx, cy };
    _layoutInfoPanel(cx, cy);
    // 綁定 page-jump 按鈕
    infoPanel.querySelectorAll("[data-fileid][data-pageidx]").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rawFid = el.getAttribute("data-fileid");
        const fidNum = Number(rawFid);
        const fid = (rawFid !== "" && Number.isFinite(fidNum)) ? fidNum : rawFid;
        const pidx = parseInt(el.getAttribute("data-pageidx"), 10);
        let target = null;
        const jid = el.getAttribute("data-jointid");
        const mid = el.getAttribute("data-memberid");
        if (jid != null && jid !== "") target = { type: "joint",  id: parseInt(jid, 10) };
        else if (mid != null && mid !== "") target = { type: "member", id: parseInt(mid, 10) };
        _activatePageFromPopup(fid, pidx, target);
      });
    });
    const closeBtn = infoPanel.querySelector("[data-close='1']");
    if (closeBtn) closeBtn.addEventListener("click", (ev) => { ev.stopPropagation(); hideInfoPanel(); });
  }
  function _escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
  // 數值格式化:`-0.0` / `-0` 之類正規化成 `0.0` / `0`,避免畫面出現負零
  function _fmtNum(v, n) {
    if (!Number.isFinite(v)) return String(v);
    let s = v.toFixed(n);
    if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
    return s;
  }
  // 檢查問題 — 浮動結果面板(滾動,可顯示大量列表)
  const issuesPanel = doc.createElement("div");
  Object.assign(issuesPanel.style, {
    position: "absolute", display: "none", zIndex: "12",
    top: "8px", left: "50%", transform: "translateX(-50%)",
    width: "min(640px, calc(100% - 24px))",
    maxHeight: "calc(100% - 80px)",
    overflow: "auto",
    background: "rgba(15, 17, 22, 0.96)", border: "1px solid #4f6c95",
    borderRadius: "5px", padding: "8px 10px",
    fontSize: "11px", color: "#ddd",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: "1.55", boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
  });
  issuesPanel.addEventListener("mousedown", (e) => e.stopPropagation());
  canvasWrap.appendChild(issuesPanel);
  let _issuesEscHandler = null;
  function hideIssuesPanel() {
    issuesPanel.style.display = "none";
    issuesPanel.innerHTML = "";
    if (_issuesEscHandler) {
      try { win.removeEventListener("keydown", _issuesEscHandler, true); } catch (_) {}
      _issuesEscHandler = null;
    }
  }
  function showIssuesPanel(title, bodyHtml) {
    issuesPanel.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #3a3d44;padding-bottom:4px;margin-bottom:6px">
         <span style="color:#9bb6e8;font-weight:700;font-size:12px">${_escHtml(title)}</span>
         <span data-close="1" style="cursor:pointer;color:#888;padding:0 4px" title="關閉 (Esc)">✕</span>
       </div>
       <div id="issuesBody">${bodyHtml}</div>`;
    issuesPanel.style.display = "block";
    const closeBtn = issuesPanel.querySelector("[data-close='1']");
    if (closeBtn) closeBtn.addEventListener("click", hideIssuesPanel);
    // Esc 關閉(每次 show 只綁一個 handler;hide 時拆掉)
    if (_issuesEscHandler) {
      try { win.removeEventListener("keydown", _issuesEscHandler, true); } catch (_) {}
    }
    _issuesEscHandler = (e) => {
      if (e.key === "Escape" && issuesPanel.style.display !== "none") {
        e.preventDefault();
        e.stopPropagation();
        hideIssuesPanel();
      }
    };
    win.addEventListener("keydown", _issuesEscHandler, true);
  }
  function _bindPageJumpsIn(container) {
    container.querySelectorAll("[data-fileid][data-pageidx]").forEach(el => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const rawFid = el.getAttribute("data-fileid");
        const fidNum = Number(rawFid);
        const fid = (rawFid !== "" && Number.isFinite(fidNum)) ? fidNum : rawFid;
        const pidx = parseInt(el.getAttribute("data-pageidx"), 10);
        let target = null;
        const jid = el.getAttribute("data-jointid");
        const mid = el.getAttribute("data-memberid");
        if (jid != null && jid !== "") target = { type: "joint",  id: parseInt(jid, 10) };
        else if (mid != null && mid !== "") target = { type: "member", id: parseInt(mid, 10) };
        _activatePageFromPopup(fid, pidx, target);
      });
    });
  }
  function renderIssuesPanel(extendCands, singleNodes) {
    const dirLbl = { vertical: "柱(垂直)", horizontal: "樑(水平)", diagonal: "斜撐" };
    // 可延伸桿件
    const extRows = (extendCands || []).map(c => {
      const fname = _escHtml(c.fileName || "(unnamed)");
      const dir = dirLbl[c.direction] || c.direction || "—";
      const dispM = (() => {
        try {
          const f = state.files.find(x => x.id === c.fileId);
          const pg = f && f.pages && f.pages[c.pageIdx];
          if (!f || !pg) return c.memberId;
          const m = (pg.members || []).find(mm => mm.id === c.memberId);
          return m && typeof displayMemberId === "function" ? displayMemberId(m) : c.memberId;
        } catch (_) { return c.memberId; }
      })();
      return `<div style="display:grid;grid-template-columns:auto 1fr auto auto;column-gap:6px;align-items:center;padding:2px 0;border-bottom:1px solid #1f2126">
        <span style="color:#7fd3ff">M${_escHtml(dispM)}</span>
        <span style="color:#9aa0a6">${_escHtml(dir)}・gap ${c.gap.toFixed(1)}・perp ${c.perpDist.toFixed(1)}・${_escHtml(c.plane || "?")}</span>
        <span data-fileid="${_escHtml(c.fileId)}" data-pageidx="${c.pageIdx}" data-memberid="${_escHtml(c.memberId)}"
          title="切到主視窗對應頁面並放大到該桿件" style="color:#9bb6e8;text-decoration:underline;cursor:pointer">→ ${fname} #${c.pageIdx + 1}</span>
      </div>`;
    }).join("");
    // 單頁節點(srcCount=1)
    const singleRows = (singleNodes || []).map(n => {
      const s = (n.samples && n.samples[0]) || {};
      const fname = _escHtml(s.fileName || "(unnamed)");
      const plane = _escHtml(s.plane || "?");
      return `<div style="display:grid;grid-template-columns:auto 1fr auto;column-gap:6px;align-items:center;padding:2px 0;border-bottom:1px solid #1f2126">
        <span style="color:#ffd23f">J${_escHtml(s.displayId)}</span>
        <span style="color:#9aa0a6">(${fmtWorld3D(n.x)}, ${fmtWorld3D(n.y)}, ${fmtWorld3D(n.z)})・${plane}</span>
        <span data-fileid="${_escHtml(s.fileId || "")}" data-pageidx="${s.pageIdx}" data-jointid="${_escHtml(s.jointId)}"
          title="切到主視窗對應頁面並放大到該節點" style="color:#9bb6e8;text-decoration:underline;cursor:pointer">→ ${fname} #${(s.pageIdx || 0) + 1}</span>
      </div>`;
    }).join("");
    const html =
      `<div style="margin-bottom:6px">
         <div style="color:#ffd23f;font-weight:700;margin-bottom:3px">可延伸桿件 <span style="color:#9aa0a6">(${extendCands.length})</span></div>
         ${extRows || '<div style="color:#9aa0a6">— 沒有 —</div>'}
       </div>
       <div style="margin-top:8px">
         <div style="color:#ff9090;font-weight:700;margin-bottom:3px">單頁節點 <span style="color:#9aa0a6">(${singleNodes.length}) — 只在一張圖出現,跨頁可能漏綁</span></div>
         ${singleRows || '<div style="color:#9aa0a6">— 沒有 —</div>'}
       </div>`;
    showIssuesPanel(`檢查結果 ・ 延伸 ${extendCands.length}・單頁 ${singleNodes.length}`, html);
    _bindPageJumpsIn(issuesPanel);
  }
  // 依平面 (XY/YZ/XZ) 對齊的編號表格,每平面一欄,多個 ID 用換行;沒有的欄顯示 "—"
  function _planeGridHtml(samples, prefix, color) {
    const planes = ["XY", "YZ", "XZ"];
    const byPlane = { XY: [], YZ: [], XZ: [] };
    for (const s of (samples || [])) {
      if (s.plane && byPlane[s.plane]) byPlane[s.plane].push(prefix + s.displayId);
    }
    const headerCells = planes.map(p =>
      `<div style="color:#9aa0a6;font-weight:700;text-align:center">${p}</div>`).join("");
    const valueCells = planes.map(p => {
      const ids = byPlane[p];
      const inner = ids.length ? ids.map(_escHtml).join("<br>") : "—";
      return `<div style="color:${color};text-align:center;word-break:break-all">${inner}</div>`;
    }).join("");
    return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;column-gap:6px;row-gap:1px;
                   border:1px solid #3a3d44;border-radius:3px;padding:3px 4px;margin-top:3px">
              ${headerCells}${valueCells}
            </div>`;
  }
  // Pending overlay(整理 / 適配關聯時遮罩 + 訊息;鏡像主畫面 busy spinner 的文字)
  //   附帶 spinner animation,Esc 鍵會把點擊轉發到主畫面的 cancel 按鈕
  const popupBusy = doc.createElement("div");
  Object.assign(popupBusy.style, {
    position: "absolute", inset: "0", zIndex: "100",
    background: "rgba(0,0,0,0.75)", display: "none",
    alignItems: "center", justifyContent: "center",
    flexDirection: "column", gap: "14px",
    color: "#ddd", fontSize: "12px",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    textAlign: "center", padding: "20px",
  });
  const popupBusySpinner = doc.createElement("div");
  popupBusySpinner.style.cssText = "width:44px;height:44px;border:4px solid #333;border-top:4px solid #4f9dff;border-radius:50%;animation:popup-spin 1s linear infinite;";
  const popupBusyMsg = doc.createElement("div");
  popupBusyMsg.id = "popupBusyMsg";
  popupBusyMsg.textContent = "處理中…";
  const popupBusyHint = doc.createElement("div");
  popupBusyHint.style.cssText = "font-size:10px;color:#888;margin-top:4px";
  popupBusyHint.textContent = "(Esc 可中斷;或回主視窗按取消)";
  popupBusy.appendChild(popupBusySpinner);
  popupBusy.appendChild(popupBusyMsg);
  popupBusy.appendChild(popupBusyHint);
  const styleEl = doc.createElement("style");
  styleEl.textContent = "@keyframes popup-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
  doc.head.appendChild(styleEl);
  canvasWrap.appendChild(popupBusy);
  function showPopupBusy(msg) {
    popupBusyMsg.textContent = msg || "處理中…";
    popupBusy.style.display = "flex";
  }
  function hidePopupBusy() { popupBusy.style.display = "none"; }
  // 鏡像主視窗 busy spinner 訊息 → 顯示到 popup
  let _mirrorIv = 0;
  function startMirrorBusy() {
    stopMirrorBusy();
    _mirrorIv = win.setInterval(() => {
      const m = document.querySelector("#busySpinner.active .msg");
      if (m && m.textContent) popupBusyMsg.textContent = m.textContent;
    }, 200);
  }
  function stopMirrorBusy() {
    if (_mirrorIv) { try { win.clearInterval(_mirrorIv); } catch (_) {} _mirrorIv = 0; }
  }
  // popup Esc → 點主視窗的取消鈕(讓批次操作可從 popup 中斷)
  win.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popupBusy.style.display === "flex") {
      const cancelBtn = document.querySelector("#busyCancelBtn.active");
      if (cancelBtn) { try { cancelBtn.click(); } catch (_) {} }
    }
    // Cmd/Ctrl+F → 開搜尋視窗(由主畫面開,因為函式定義在 main scope)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      try { if (typeof openSearchWindow === "function") openSearchWindow(); } catch (_) {}
    }
    // Cmd/Ctrl+S → 主畫面儲存專案(Shift = 另存新檔)
    //   browser 預設會跳「儲存網頁」對話框 → preventDefault 攔掉,改跑 main 的 startSave
    //   popup 加 busy overlay + 鏡像主 busy 訊息,讓使用者知道有事在跑
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      (async () => {
        const isAs = !!e.shiftKey;
        showPopupBusy(isAs ? "另存新檔中…(主視窗會彈出檔案選擇)" : "儲存專案中…");
        startMirrorBusy();
        try {
          window.focus();   // FSA picker 必須在有 user gesture 的視窗上跑;主畫面拿到焦點
          if (typeof _startSaveWithHook === "function") await _startSaveWithHook(isAs);
        } catch (err) { console.warn("[3D Cmd+S] 儲存失敗", err); }
        finally {
          stopMirrorBusy();
          hidePopupBusy();
        }
      })();
    }
    // ←/→ 切面 slider step:吸附點 / 吸附頁 ON 時跳到 prev/next 值;否則用 slider.step
    //   不限聚焦元素 — 在任何地方都可以左右控制切面(text/number input 內例外,讓 input 自己處理)
    //   Shift+← / Shift+→ → 10× step
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.metaKey && !e.ctrlKey) {
      const ae = doc.activeElement;
      // 只在「文字輸入」類控件聚焦時讓給原生(text / number / search / textarea / select)
      //   range 滑桿 (type=range) 也是 INPUT 但我們要攔截做自定義 snap → 不算文字輸入
      if (ae && ae.tagName === "TEXTAREA") return;
      if (ae && ae.tagName === "SELECT") return;
      if (ae && ae.tagName === "INPUT") {
        const t = (ae.type || "").toLowerCase();
        if (t === "text" || t === "number" || t === "search" || t === "tel" || t === "url" || t === "email") return;
      }
      if (!cutState.axis) return;
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const cur = cutState.value;
      const eps = 1e-4;
      let next = null;
      const pickNext = (vals) => {
        let n = null;
        for (const v of vals) {
          if (dir > 0) { if (v > cur + eps) { n = v; break; } }
          else { if (v < cur - eps) n = v; else break; }
        }
        return n;
      };
      if (cutState.snapToNode) next = pickNext(collectNodeValuesForCutAxis(cutState.axis));
      else if (cutState.snapToPage) next = pickNext(collectPageDepthValuesForCutAxis(cutState.axis));
      else {
        const step = (parseFloat(cutSlider.step) || 1) * (e.shiftKey ? 10 : 1);
        next = cur + dir * step;
        const mn = parseFloat(cutSlider.min), mx = parseFloat(cutSlider.max);
        if (Number.isFinite(mn) && next < mn) next = mn;
        if (Number.isFinite(mx) && next > mx) next = mx;
      }
      if (next == null) return;   // 到頂 / 到底沒下一個
      cutState.value = next;
      cutSlider.value = next;
      requestRender();
    }
  });

  // 色彩圖例(浮在 canvas 右上角)
  const legend = doc.createElement("div");
  Object.assign(legend.style, {
    position: "absolute", top: "8px", right: "8px",
    background: "rgba(15, 17, 22, 0.88)", border: "1px solid #444",
    borderRadius: "4px", padding: "6px 9px",
    fontSize: "10px", color: "#ddd",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: "1.55", zIndex: "5", pointerEvents: "none",
    minWidth: "160px",
  });
  legend.innerHTML = `
    <div style="color:#9bb6e8;font-weight:700;margin-bottom:3px;font-size:11px" data-i18n="p3d.legend">圖例</div>
    <div><span style="color:#ff4444">●</span> <span data-i18n="p3d.legend.singlePage">單頁節點</span></div>
    <div><span style="color:#ffd23f">●</span> <span data-i18n="p3d.legend.crossPage">跨頁綁定節點 (globalJoint 共享)</span></div>
    <div><span style="color:#ff8c00">▼</span> <span data-i18n="p3d.legend.anchorFixed">錨點 FIXED</span></div>
    <div><span style="color:#ff8c00">■</span> <span data-i18n="p3d.legend.anchorPinned">錨點 PINNED</span></div>
    <div style="margin-top:3px"><span style="color:#7eb6ff">━</span> <span data-i18n="p3d.legend.memY">垂直桿件 (Y 軸,柱)</span></div>
    <div><span style="color:#ff9090">━</span> <span data-i18n="p3d.legend.memX">X 軸桿件 (橫樑)</span></div>
    <div><span style="color:#9aff9a">━</span> <span data-i18n="p3d.legend.memZ">Z 軸桿件 (橫樑)</span></div>
    <div><span style="color:#9aa0a6">━</span> <span data-i18n="p3d.legend.memDiag">斜橕 / 非軸向</span></div>
    <div style="margin-top:3px;padding-top:3px;border-top:1px solid #333">
      <span data-i18n="p3d.legend.worldAxes">世界軸:</span><span style="color:#ff5252;font-weight:700">X</span>
      ・<span style="color:#4ade80;font-weight:700" data-i18n="p3d.legend.yUp">Y(上)</span>
      ・<span style="color:#4f9dff;font-weight:700">Z</span>
    </div>
    <div style="margin-top:3px;color:#777;font-size:9px"><span data-i18n="p3d.legend.cutLabel">切面:</span><span style="color:#ffd23f">━━</span></div>
  `;
  canvasWrap.appendChild(legend);
  // 操作說明:浮在 canvas 右下角,跟圖例同風格
  const helpBox = doc.createElement("div");
  Object.assign(helpBox.style, {
    position: "absolute", bottom: "8px", right: "8px",
    background: "rgba(15, 17, 22, 0.88)", border: "1px solid #444",
    borderRadius: "4px", padding: "6px 9px",
    fontSize: "10px", color: "#ddd",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: "1.55", zIndex: "5", pointerEvents: "none",
    minWidth: "160px",
  });
  helpBox.innerHTML = `
    <div style="color:#9bb6e8;font-weight:700;margin-bottom:3px;font-size:11px" data-i18n="p3d.hint">操作說明</div>
    <div data-i18n="p3d.hint.midDrag">中鍵拖曳 = 平移</div>
    <div data-i18n="p3d.hint.spaceMid">Space + 中鍵 = 旋轉</div>
    <div data-i18n="p3d.hint.shiftMid">Shift + 中鍵 = 旋轉</div>
    <div data-i18n="p3d.hint.rightDrag">右鍵拖曳 = 平移</div>
    <div data-i18n="p3d.hint.wheel">滾輪 = 縮放</div>
    <div data-i18n="p3d.hint.leftClick">左鍵點節點/桿件 = 資訊</div>
  `;
  canvasWrap.appendChild(helpBox);
  // 吸附頁的頁面標籤 — 浮在 canvas 左上角,不擋 3D 結構視圖
  const pageSnapLabel = doc.createElement("div");
  Object.assign(pageSnapLabel.style, {
    position: "absolute", top: "8px", left: "8px",
    background: "rgba(15, 17, 22, 0.92)",
    border: "1.5px solid rgba(255, 210, 63, 0.85)",
    borderRadius: "4px", padding: "6px 10px",
    fontSize: "14px", fontWeight: "700", color: "#ffd23f",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    lineHeight: "1.35", zIndex: "5", pointerEvents: "none",
    boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
    display: "none", maxWidth: "300px",
  });
  canvasWrap.appendChild(pageSnapLabel);
  const footer = doc.createElement("div");
  footer.id = "footer";
  body.appendChild(footer);

  // 等 controls 渲染完才能拿到高度,所以延後一輪
  function layoutCanvasArea() {
    const ch = controls.getBoundingClientRect().height;
    canvasWrap.style.top = (ch + 1) + "px";
  }

  // i18n helper:若提供了 i18n key 且字典裡有翻譯,就用譯文;否則用原文(fallback)
  //   也把 data-i18n 屬性寫到元素上,讓之後切語言時 _applyI18nOnDoc(doc) 能自動翻譯
  const _tx = (key, fallback) => {
    if (key) { const v = (typeof _t === "function") ? _t(key) : null; if (v != null) return v; }
    return fallback;
  };
  const mkGp = (label, i18nKey) => {
    const g = doc.createElement("div"); g.className = "gp";
    if (label) {
      const l = doc.createElement("span"); l.className = "lbl";
      const txt = _tx(i18nKey, label);
      l.textContent = (txt.endsWith(":") || txt.endsWith(":")) ? txt : (txt + ":");
      if (i18nKey) l.dataset.i18n = i18nKey;
      g.appendChild(l);
    }
    controls.appendChild(g);
    return g;
  };
  const mkBtn = (label, title, onClick, opts) => {
    const b = doc.createElement("button");
    const key = opts && opts.i18n;
    const txt = _tx(key, label);
    b.textContent = txt;
    if (key) b.dataset.i18n = key;
    if (title) b.title = title;
    if (opts && opts.mini) b.classList.add("mini");
    b.onclick = onClick;
    return b;
  };
  const mkCheck = (label, init, onChange, opts) => {
    const w = doc.createElement("label"); w.className = "ck";
    const c = doc.createElement("input"); c.type = "checkbox"; c.checked = init;
    c.onchange = () => onChange(c.checked);
    const t = doc.createElement("span");
    const key = opts && opts.i18n;
    t.textContent = _tx(key, label);
    if (key) t.dataset.i18n = key;
    w.appendChild(c); w.appendChild(t); return w;
  };
  // ===== 1. 蒐集 3D 資料 =====
  //   nodes:所有節點(用 globalJoint 位置優先,沒綁的用 joint2DToWorld3D)
  //   去重:同世界座標(round 到 1mm)的視為同點,合併進 cluster
  //   edges:跨頁的 member;兩端轉成 3D node key 後加入
  function collectData() {
    const nodeMap = new Map();   // key "rx|ry|rz" → { x, y, z, srcCount, samples: [{fileName, jointId, pageIdx, displayId}] }
    const edgeMap = new Map();   // key "k1||k2" → { k1, k2, srcCount }
    // 精準度走 state.measureDecimals,跟「適配關聯(精準度)」一致 —
    //   否則:同物理點的 joint 因為 round 規則不同,3D 視為兩顆,popup 顯示「(0, *, 0)」
    //   但畫面上點漂在 x=0/z=0 軸旁邊
    const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
    const round = (v) => {
      const r = parseFloat(v.toFixed(md));
      return r === 0 ? 0 : r;
    };
    const _nodeKey = (w) => `${round(w.x)}|${round(w.y)}|${round(w.z)}`;
    for (const f of state.files) {
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k]; if (!pg || pg._orphan) continue;
        const local = new Map();
        for (const j of (pg.joints || [])) {
          let w = null;
          if (j.globalId != null) {
            const gj = (state.globalJoints || []).find(g => g.id === j.globalId);
            if (gj && Number.isFinite(gj.x) && Number.isFinite(gj.y) && Number.isFinite(gj.z)) {
              w = { x: gj.x, y: gj.y, z: gj.z };
            }
          }
          if (!w) {
            const w2 = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(f, pg, j) : null;
            if (w2) w = { x: w2.x, y: w2.y, z: w2.z };
          }
          if (!w) continue;
          const nk = _nodeKey(w);
          let node = nodeMap.get(nk);
          if (!node) {
            // 用 round 後的座標當節點位置,跟 dedup key 同精度(1mm)。
            // 否則第一個 joint 的次毫米誤差會殘留進 node.x/y/z,造成「資訊面板顯示 0,
            // 但畫面上點不在 x=0/z=0 軸」的視覺漂移
            node = { x: round(w.x), y: round(w.y), z: round(w.z), srcCount: 0, samples: [], key: nk, isAnchor: false };
            nodeMap.set(nk, node);
          }
          node.srcCount++;
          if (hasSupport(j)) node.isAnchor = true;   // 任一 binding joint 有支承 → 3D 節點視為支承/錨點
          // 任一 sibling 是 PINNED → 3D 視為 PINNED(否則為 FIXED 三角形預設)
          if (supportTypeOf(j) === "PINNED") node.supportType = "PINNED";
          if (node.samples.length < 8) {
            const dispId = (typeof _displayIdForJointWith === "function") ? _displayIdForJointWith(f, pg, j) : j.id;
            node.samples.push({ fileId: f.id, fileName: f.name, pageIdx: +k, jointId: j.id, displayId: dispId, plane: pg.plane, isAnchor: hasSupport(j) });
          }
          local.set(j.id, nk);
        }
        for (const m of (pg.members || [])) {
          const k1 = local.get(m.j1), k2 = local.get(m.j2);
          if (!k1 || !k2 || k1 === k2) continue;
          const ek = k1 < k2 ? `${k1}||${k2}` : `${k2}||${k1}`;
          let edge = edgeMap.get(ek);
          if (!edge) { edge = { k1, k2, srcCount: 0, samples: [] }; edgeMap.set(ek, edge); }
          edge.srcCount++;
          if (edge.samples.length < 4) {
            const dispM = (typeof displayMemberId === "function") ? displayMemberId(m) : m.id;
            edge.samples.push({ fileId: f.id, fileName: f.name, pageIdx: +k, memberId: m.id, displayId: dispM, plane: pg.plane });
          }
        }
      }
    }
    return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()], nodeMap };
  }

  // ===== 2. 攝影機投影(Y-up,正交投影,可切換透視)=====
  //   az = 繞 Y(垂直)軸偏航(0 = 從 +Z 方向看向 -Z;+pi/2 = 從 -X 方向看)
  //   el = 仰角(0 = 水平視線;+pi/2 = 從正上方往下看)
  //   cx/cy/cz = 旋轉中心(世界座標)
  //   zoom = 螢幕像素 / 世界單位
  const cam = { az: Math.PI / 5, el: Math.PI / 7, cx: 0, cy: 0, cz: 0, zoom: 1, mode: "ortho" };
  function project(p, w, h) {
    const dx = p.x - cam.cx, dy = p.y - cam.cy, dz = p.z - cam.cz;
    // 偏航繞 Y(垂直軸):x' = x cos - z sin, y' = y, z' = x sin + z cos
    const ca = Math.cos(cam.az), sa = Math.sin(cam.az);
    const x1 = dx * ca - dz * sa;
    const y1 = dy;
    const z1 = dx * sa + dz * ca;
    // 俯仰繞 view-X(水平軸):y'' = y cos + z sin, z'' = -y sin + z cos
    //   el=+pi/2 時 view-y 取 +Z 方向(也就是俯視時 +Z 朝上)
    const ce = Math.cos(cam.el), se = Math.sin(cam.el);
    const x2 = x1;
    const y2 = y1 * ce + z1 * se;
    const z2 = -y1 * se + z1 * ce;       // 深度:正值往螢幕內(離相機更遠)
    return { x: w / 2 + x2 * cam.zoom, y: h / 2 - y2 * cam.zoom, depth: z2 };
  }

  // ===== 3. 蒐集 + 初始視角 =====
  let data = collectData();
  function fitCameraToData() {
    if (!data.nodes.length) return;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const n of data.nodes) {
      if (n.x<minX)minX=n.x; if (n.x>maxX)maxX=n.x;
      if (n.y<minY)minY=n.y; if (n.y>maxY)maxY=n.y;
      if (n.z<minZ)minZ=n.z; if (n.z>maxZ)maxZ=n.z;
    }
    cam.cx=(minX+maxX)/2; cam.cy=(minY+maxY)/2; cam.cz=(minZ+maxZ)/2;
    // 算 bbox 8 個角落投影到目前視角後的 screen-space 範圍 → fit 利用率更高(不用 diag 保守估)
    const corners = [
      {x:minX,y:minY,z:minZ},{x:maxX,y:minY,z:minZ},{x:minX,y:maxY,z:minZ},{x:maxX,y:maxY,z:minZ},
      {x:minX,y:minY,z:maxZ},{x:maxX,y:minY,z:maxZ},{x:minX,y:maxY,z:maxZ},{x:maxX,y:maxY,z:maxZ},
    ];
    // 用單位 zoom 把 corners 投影到 screen space(複用 project 但 cam.zoom = 1 不影響我們算 span)
    const oldZoom = cam.zoom;
    cam.zoom = 1;
    let pxMin = Infinity, pxMax = -Infinity, pyMin = Infinity, pyMax = -Infinity;
    for (const c of corners) {
      const p = project(c, 0, 0);
      if (p.x < pxMin) pxMin = p.x; if (p.x > pxMax) pxMax = p.x;
      if (p.y < pyMin) pyMin = p.y; if (p.y > pyMax) pyMax = p.y;
    }
    cam.zoom = oldZoom;
    const spanX = Math.max(1, pxMax - pxMin);
    const spanY = Math.max(1, pyMax - pyMin);
    const cw = canvas.width, ch = canvas.height;
    // 1.0 = 讓 bbox 8 個投影角剛好頂到 canvas 邊;略微 over-fit 讓畫面利用率高一點,
    //   軸線 / 文字標籤就算貼邊也不會被裁切到結構
    cam.zoom = Math.min(cw / spanX, ch / spanY) * 1.0;
  }

  // ===== 4. 視覺尺寸狀態 + UI 控制群組 =====
  // fontScale / lineScale / dotScale 預設都用 0.3(= A- / 細 / 小 按鈕的最小值)
  const sizeOpts = { fontScale: 0.3, lineScale: 0.3, dotScale: 0.3, autoScaleWithZoom: true };
  let _refZoom = 1;   // fit 後記下的標準 zoom,用來算 zoomFactor
  // 顯示 / 切面狀態
  const opts = { showNodes: true, showEdges: true, showLabels: false, showMemberLabels: false, showAxes: true, showGrid: true, perspective: false };
  const cutState = { axis: null, value: 0, side: 1, slab: false, slabWidth: 0, snapToPage: false, snapToNode: true, showPlane: true };
  // 收集對應切軸的「檔案頁面深度值」(用來吸附 slider)
  //   切 X → YZ 頁的 page.z;切 Y → XZ 頁的 page.z;切 Z → XY 頁的 page.z
  function collectPageDepthValuesForCutAxis(axis) {
    if (!axis) return [];
    const planeWithDepth = axis === "x" ? "YZ" : axis === "y" ? "XZ" : "XY";
    const out = new Set();
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {}) as any[]) {
        if (!pg || pg._orphan) continue;
        if (pg.plane !== planeWithDepth) continue;
        const z = pg.z;
        if (Number.isFinite(z)) out.add(z);
      }
    }
    return [...out as Set<number>].sort((a, b) => a - b);
  }
  function snapCutValueToPage(value) {
    if (!cutState.axis) return value;
    const pages = collectPageDepthValuesForCutAxis(cutState.axis);
    if (!pages.length) return value;
    let best = pages[0], bestD = Math.abs(pages[0] - value);
    for (let i = 1; i < pages.length; i++) {
      const d = Math.abs(pages[i] - value);
      if (d < bestD) { bestD = d; best = pages[i]; }
    }
    return best;
  }
  // 收集 cut 軸上所有 unique node 座標(來自當前 data.nodes,已是 3D 合併後的世界座標)
  function collectNodeValuesForCutAxis(axis) {
    if (!axis || !data || !data.nodes) return [];
    const out = new Set<number>();
    for (const n of data.nodes) {
      const v = n[axis];
      if (Number.isFinite(v)) out.add(v);
    }
    return [...out].sort((a, b) => a - b);
  }
  function snapCutValueToNode(value) {
    if (!cutState.axis) return value;
    const vals = collectNodeValuesForCutAxis(cutState.axis);
    if (!vals.length) return value;
    let best = vals[0], bestD = Math.abs(vals[0] - value);
    for (let i = 1; i < vals.length; i++) {
      const d = Math.abs(vals[i] - value);
      if (d < bestD) { bestD = d; best = vals[i]; }
    }
    return best;
  }
  // 視角預設
  const vg = mkGp("視角", "p3d.view");
  vg.appendChild(mkBtn("俯視", "從正上方往下看 XZ 平面 (Y 朝下)", () => { cam.az = 0; cam.el = Math.PI / 2; requestRender(); }, { i18n: "p3d.viewTop" }));
  vg.appendChild(mkBtn("正面", "從 +Z 看 -Z (XY 立面, Y 朝上)", () => { cam.az = 0; cam.el = 0; requestRender(); }, { i18n: "p3d.viewFront" }));
  vg.appendChild(mkBtn("側面", "從 -X 看 +X (YZ 側立面, Y 朝上)", () => { cam.az = Math.PI / 2; cam.el = 0; requestRender(); }, { i18n: "p3d.viewSide" }));
  vg.appendChild(mkBtn("等軸", "iso 視角", () => { cam.az = Math.PI / 5; cam.el = Math.PI / 7; requestRender(); }, { i18n: "p3d.viewIso" }));
  vg.appendChild(mkBtn("重置", "回到 fit + 等軸視角", () => { cam.az = Math.PI / 5; cam.el = Math.PI / 7; fitCameraToData(); _refZoom = cam.zoom; requestRender(); }, { i18n: "p3d.viewReset" }));
  // 顯示控制
  const sg = mkGp("顯示", "p3d.show");
  sg.appendChild(mkCheck("節點", true, v => { opts.showNodes = v; requestRender(); }, { i18n: "p3d.showJoints" }));
  sg.appendChild(mkCheck("桿件", true, v => { opts.showEdges = v; requestRender(); }, { i18n: "p3d.showMembers" }));
  sg.appendChild(mkCheck("節點號", false, v => { opts.showLabels = v; requestRender(); }, { i18n: "p3d.showJointIds" }));
  sg.appendChild(mkCheck("桿件號", false, v => { opts.showMemberLabels = v; requestRender(); }, { i18n: "p3d.showMemberIds" }));
  sg.appendChild(mkCheck("軸線", true, v => { opts.showAxes = v; requestRender(); }, { i18n: "p3d.showAxes" }));
  sg.appendChild(mkCheck("地網格", true, v => { opts.showGrid = v; requestRender(); }, { i18n: "p3d.showGrid" }));
  sg.appendChild(mkCheck("圖例", true, v => { legend.style.display = v ? "block" : "none"; }, { i18n: "p3d.showLegend" }));
  // 字體 / 線寬 / 點大小 + 隨縮放
  const fg = mkGp("字", "p3d.font");
  fg.appendChild(mkBtn("A-", "字體縮小 (×0.8)", () => { sizeOpts.fontScale = Math.max(0.3, sizeOpts.fontScale * 0.8); requestRender(); }, { mini: true }));
  fg.appendChild(mkBtn("A", "字體還原", () => { sizeOpts.fontScale = 1; requestRender(); }, { mini: true }));
  fg.appendChild(mkBtn("A+", "字體放大 (×1.25)", () => { sizeOpts.fontScale = Math.min(8, sizeOpts.fontScale * 1.25); requestRender(); }, { mini: true }));
  const lg = mkGp("線", "p3d.line");
  lg.appendChild(mkBtn("細", "線寬變細 (×0.8)", () => { sizeOpts.lineScale = Math.max(0.3, sizeOpts.lineScale * 0.8); requestRender(); }, { mini: true, i18n: "p3d.thin" }));
  lg.appendChild(mkBtn("0", "線寬還原", () => { sizeOpts.lineScale = 1; requestRender(); }, { mini: true }));
  lg.appendChild(mkBtn("粗", "線寬加粗 (×1.25)", () => { sizeOpts.lineScale = Math.min(8, sizeOpts.lineScale * 1.25); requestRender(); }, { mini: true, i18n: "p3d.thick" }));
  const dg = mkGp("點", "p3d.point");
  dg.appendChild(mkBtn("小", "點變小 (×0.8)", () => { sizeOpts.dotScale = Math.max(0.3, sizeOpts.dotScale * 0.8); requestRender(); }, { mini: true, i18n: "p3d.small" }));
  dg.appendChild(mkBtn("0", "點還原", () => { sizeOpts.dotScale = 1; requestRender(); }, { mini: true }));
  dg.appendChild(mkBtn("大", "點變大 (×1.25)", () => { sizeOpts.dotScale = Math.min(8, sizeOpts.dotScale * 1.25); requestRender(); }, { mini: true, i18n: "p3d.large" }));
  dg.appendChild(mkCheck("隨縮放", true, v => { sizeOpts.autoScaleWithZoom = v; requestRender(); }, { i18n: "p3d.autoScale" }));
  // 切面
  const cg = mkGp("切面", "p3d.cut");
  const cutAxisSel = doc.createElement("select");
  for (const a of ["off", "x", "y", "z"]) {
    const o = doc.createElement("option"); o.value = a;
    if (a === "off") { o.dataset.i18n = "p3d.cutOff"; o.textContent = _tx("p3d.cutOff", "關閉"); }
    else             { o.textContent = a.toUpperCase(); }
    cutAxisSel.appendChild(o);
  }
  cutAxisSel.onchange = () => {
    cutState.axis = cutAxisSel.value === "off" ? null : cutAxisSel.value;
    if (cutState.axis) {
      let mn = Infinity, mx = -Infinity;
      for (const n of data.nodes) { const v = n[cutState.axis]; if (v < mn) mn = v; if (v > mx) mx = v; }
      cutSlider.min = mn; cutSlider.max = mx; cutSlider.step = Math.max(1, (mx - mn) / 200);
      cutState.value = (mn + mx) / 2; cutSlider.value = cutState.value;
    }
    requestRender();
  };
  cg.appendChild(cutAxisSel);
  const cutSlider = doc.createElement("input");
  cutSlider.type = "range"; cutSlider.style.width = "100px";
  cutSlider.oninput = () => {
    let v = parseFloat(cutSlider.value);
    // 吸附順序:節點 > 頁面;節點通常比頁面密,優先吸附節點避免覆蓋
    if (cutState.snapToNode) {
      v = snapCutValueToNode(v);
      cutSlider.value = v;
    } else if (cutState.snapToPage) {
      v = snapCutValueToPage(v);
      cutSlider.value = v;
    }
    cutState.value = v;
    requestRender();
  };
  cg.appendChild(cutSlider);
  const cutValueLabel = doc.createElement("span");
  cutValueLabel.style.cssText = "font-size:10px;color:#aaa;min-width:60px";
  cg.appendChild(cutValueLabel);
  cg.appendChild(mkBtn("反向", "切換顯示切面哪一側", () => { cutState.side = -cutState.side; requestRender(); }, { mini: true, i18n: "p3d.cutInvert" }));
  cg.appendChild(mkCheck("顯示切面", true, v => { cutState.showPlane = v; requestRender(); }, { i18n: "p3d.cutShow" }));
  cg.appendChild(mkCheck("切片", false, v => { cutState.slab = v; requestRender(); }, { i18n: "p3d.cutSlice" }));
  // 切片寬度(±mm):value ± slabWidth 範圍內的 joint 才會顯示;預設 50mm
  const slabWInput = doc.createElement("input");
  slabWInput.type = "number"; slabWInput.min = "0"; slabWInput.max = "5000"; slabWInput.step = "5";
  slabWInput.value = String(cutState.slabWidth);
  slabWInput.title = "切片厚度 (±mm):value ± slabWidth 範圍內的 joint 才會顯示。預設 0 → 只顯示剛好在切面值的節點(精確匹配)";
  slabWInput.style.cssText = "width:54px;font-size:10px;padding:2px 4px";
  slabWInput.onchange = () => {
    const v = parseFloat(slabWInput.value);
    cutState.slabWidth = (Number.isFinite(v) && v >= 0) ? v : 0;
    slabWInput.value = String(cutState.slabWidth);
    requestRender();
  };
  const slabWLbl = doc.createElement("span");
  slabWLbl.textContent = "±";
  slabWLbl.style.cssText = "font-size:10px;color:#9aa0a6";
  cg.appendChild(slabWLbl);
  cg.appendChild(slabWInput);
  const snapToPageCheck = mkCheck("吸附頁", false, v => {
    cutState.snapToPage = v;
    // 打開時立刻把目前 value 吸到最近的頁面點
    if (v && cutState.axis) {
      const snapped = snapCutValueToPage(cutState.value);
      cutState.value = snapped;
      cutSlider.value = snapped;
    }
    requestRender();
  }, { i18n: "p3d.snapPage" });
  cg.appendChild(snapToPageCheck);
  const snapToNodeCheck = mkCheck("吸附點", true, v => {
    cutState.snapToNode = v;
    // 打開時立刻把目前 value 吸到最近的節點座標
    if (v && cutState.axis) {
      const snapped = snapCutValueToNode(cutState.value);
      cutState.value = snapped;
      cutSlider.value = snapped;
    }
    requestRender();
  }, { i18n: "p3d.snapJoint" });
  cg.appendChild(snapToNodeCheck);
  // 其他工具
  const ug = mkGp("工具", "p3d.tools");
  const perspBtn = mkBtn("透視", "切換 正交 / 透視", () => {
    opts.perspective = !opts.perspective;
    perspBtn.classList.toggle("active", opts.perspective);
    requestRender();
  }, { i18n: "p3d.perspective" });
  ug.appendChild(perspBtn);
  ug.appendChild(mkBtn("截圖", "儲存目前 canvas 為 PNG", () => {
    const link = doc.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `3d-preview-${Date.now()}.png`;
    link.click();
  }, { i18n: "p3d.snapshot" }));
  ug.appendChild(mkBtn("更新", "重新從主畫面蒐集資料", () => {
    data = collectData();
    rebuildAfterDataChange();
    requestRender();
  }, { i18n: "p3d.refresh" }));
  // 在 3D 視窗直接觸發主畫面的批次操作 → 完成後自動 rebuild 3D 資料
  //   主畫面會顯示 confirm / busy spinner / Esc 中斷;這裡只是入口
  const og = mkGp("批次", "p3d.batch");
  // 一鍵處理:依序跑整個 pipeline。順序:
  //   1) 整理所有頁面 — page-level dedup / split
  //   2) 適配關聯(精準度)— 清全部 + 重建跨檔 globalJoint / globalMember 綁定
  //   3) 清壞綁 — 移除分歧 > 100mm 的綁定(誤綁 / 平行切面殘留)
  //   4) 編排節點編號 — 重編 joint / member ID
  //   5) 編排桿件編號 — 重編 member ID(Y → X → Z → 斜撐)
  //   6) 更新 3D — 重收資料 + 重畫
  //   7) 檢查問題 — 顯示報告面板(找延伸桿件 / 單頁節點)
  // 「清全部綁」沒列為獨立步驟 — 適配關聯內部已涵蓋。
  const _btnOneClick = mkBtn("⚡ 一鍵處理", "依序跑完整 pipeline:整理所有頁面 → 適配關聯(精準度)→ 清壞綁(>100mm)→ 編排節點編號 → 編排桿件編號 → 重算 3D → 檢查問題報告。一次操作全壓在同一個 Ctrl+Z(各步驟個別有 pushUndo,連續按可逐步還原)", async () => {
    const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
    if (!win.confirm(
      `一鍵處理 — 依序跑下列 7 步:\n\n` +
      `1. 整理所有頁面(合併同位節點 / 刪重複桿件 / 共線中段拆段)\n` +
      `2. 適配關聯(精準度 ${md} 位數)— 先清光所有綁定,再重建\n` +
      `3. 清壞綁(分歧 > 100mm 的 globalJoint 移除)\n` +
      `4. 編排節點編號(全部頁面)\n` +
      `5. 編排桿件編號(全部頁面)\n` +
      `6. 重算 3D\n` +
      `7. 檢查問題(顯示報告)\n\n` +
      `每步都會 pushUndo;失敗 / 取消可用 Ctrl+Z 逐步還原。要繼續嗎?`
    )) return;
    showPopupBusy("一鍵處理:準備中…");
    startMirrorBusy();
    let ok = true;
    try {
      // Step 1
      showPopupBusy("一鍵處理 1/7:整理所有頁面…");
      if (typeof setBusyMessage === "function") setBusyMessage("一鍵處理 1/7:整理所有頁面…");
      if (typeof consolidateAllPagesWithConfirm === "function") {
        await consolidateAllPagesWithConfirm({ skipConfirm: true });
      }
      // Step 2
      showPopupBusy("一鍵處理 2/7:適配關聯(精準度)…");
      if (typeof setBusyMessage === "function") setBusyMessage("一鍵處理 2/7:適配關聯(精準度)…");
      if (typeof _runFitMergeByPrecision === "function") {
        await _runFitMergeByPrecision({ skipConfirm: true });
      }
      // Step 3
      showPopupBusy("一鍵處理 3/7:清壞綁(>100mm)…");
      if (typeof setBusyMessage === "function") setBusyMessage("一鍵處理 3/7:清壞綁(>100mm)…");
      if (typeof cleanupBadGlobalJoints === "function") {
        cleanupBadGlobalJoints({ threshold: 100, skipConfirm: true });
      }
      // Step 4
      showPopupBusy("一鍵處理 4/7:編排節點編號…");
      if (typeof setBusyMessage === "function") setBusyMessage("一鍵處理 4/7:編排節點編號…");
      if (typeof relayoutNumberingAll === "function") {
        await relayoutNumberingAll({ skipConfirm: true });
      }
      // Step 5
      showPopupBusy("一鍵處理 5/7:編排桿件編號…");
      if (typeof setBusyMessage === "function") setBusyMessage("一鍵處理 5/7:編排桿件編號…");
      if (typeof relayoutMembersNumberingAll === "function") {
        await relayoutMembersNumberingAll({ skipConfirm: true });
      }
      // Step 6
      showPopupBusy("一鍵處理 6/7:重算 3D…");
      if (typeof setBusyMessage === "function") setBusyMessage("一鍵處理 6/7:重算 3D…");
      data = collectData();
      rebuildAfterDataChange();
      requestRender();
    } catch (e) {
      ok = false;
      console.warn("[3D 一鍵處理] 失敗", e);
      alert("一鍵處理途中發生錯誤:" + (e && e.message ? e.message : e) + "\n\n已完成的步驟保留;可用 Ctrl+Z 逐步還原。");
    } finally {
      stopMirrorBusy();
      hidePopupBusy();
    }
    // Step 7:檢查問題 — 顯示報告面板(即使前面失敗也跑,讓使用者看到當前狀態)
    try {
      showIssuesPanel("檢查中…", "<div style='color:#9aa0a6'>掃描中…</div>");
      await new Promise(r => setTimeout(r, 0));
      let cands = [];
      try {
        if (typeof findAllExtendableMembers === "function") cands = findAllExtendableMembers({}) || [];
      } catch (e) { console.warn("[3D 一鍵處理] findAllExtendableMembers 失敗", e); }
      const singlePageNodes = (data.nodes || []).filter(n => n.srcCount === 1);
      renderIssuesPanel(cands, singlePageNodes);
    } catch (e) { console.warn("[3D 一鍵處理] 檢查問題失敗", e); }
    if (ok) console.log("[3D 一鍵處理] 完成");
  }, { i18n: "p3d.oneClick" });
  _btnOneClick.style.cssText = "background:#4f9dff;border-color:#4f9dff;color:#fff;font-weight:700;padding:5px 12px";
  og.appendChild(_btnOneClick);
  og.appendChild(mkBtn("整理所有頁", "對主畫面所有頁面跑「整理」:合併同位節點、刪重複桿件、共線中段拆段。整理本身不會修改 globalJoint 位置,只動本頁節點 / 桿件清單。Ctrl+Z 可還原", async () => {
    if (typeof consolidateAllPagesWithConfirm !== "function") return;
    if (!win.confirm("對所有頁面跑「整理」?\n會合併同位節點、刪重複桿件、共線中段拆段。\nCtrl+Z 可還原。")) return;
    showPopupBusy("整理所有頁面準備中…");
    startMirrorBusy();
    try {
      await consolidateAllPagesWithConfirm({ skipConfirm: true });
    } catch (e) { console.warn("[3D 整理] 失敗", e); }
    finally {
      stopMirrorBusy();
      hidePopupBusy();
      data = collectData();
      rebuildAfterDataChange();
      requestRender();
    }
  }, { i18n: "p3d.consolidateAll" }));
  og.appendChild(mkBtn("適配關聯", "對主畫面所有檔案跑「適配關聯(精準度)」:會先清除所有既有綁定(globalJoint + globalMember),再以左欄『節點適配位數』(精準度)把每顆 joint 的世界座標 round 後當 bucket key,bucket 內來自不同檔 / 不同頁的 joint 視為同一物理點,綁同一 globalJoint。完成後 3D 自動更新。Ctrl+Z 可還原", async () => {
    if (typeof _runFitMergeByPrecision !== "function") return;
    const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
    // 統計既有綁定(用於 confirm 訊息)
    let gjCnt = Array.isArray(state.globalJoints) ? state.globalJoints.length : 0;
    let gmCnt = Array.isArray(state.globalMembers) ? state.globalMembers.length : 0;
    let jBind = 0, mBind = 0;
    for (const f of state.files || []) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        for (const j of (pg.joints || [])) if (j.globalId != null) jBind++;
        for (const m of (pg.members || [])) if (m.globalMemberId != null) mBind++;
      }
    }
    const wipeMsg = (gjCnt || gmCnt || jBind || mBind)
      ? `\n\n⚠ 會先清除所有既有綁定(避免舊精準度 / 舊校準殘留污染新結果):\n  ・globalJoint 物件 ${gjCnt} 個 ・joint 綁定 ${jBind} 顆\n  ・globalMember 物件 ${gmCnt} 個 ・member 綁定 ${mBind} 條`
      : "";
    if (!win.confirm(`對所有檔案跑「適配關聯(精準度)」?\n當前精準度 = 小數 ${md} 位數(可在主畫面左欄『節點適配位數』調整)。\n兩顆 joint 若 round 到 ${md} 位後座標相同 → 視為同一點,綁同一 globalJoint。${wipeMsg}\n\nCtrl+Z 可還原。`)) return;
    showPopupBusy("適配關聯(精準度)準備中…");
    startMirrorBusy();
    try {
      await _runFitMergeByPrecision({ skipConfirm: true });
    } catch (e) { console.warn("[3D 適配關聯] 失敗", e); }
    finally {
      stopMirrorBusy();
      hidePopupBusy();
      data = collectData();
      rebuildAfterDataChange();
      requestRender();
    }
  }, { i18n: "p3d.inferAll" }));
  og.appendChild(mkBtn("清壞綁", "清除「綁定錯誤」的 globalJoint(分歧 > 100 mm)。典型出現在適配關聯把多平行切面誤綁的情況。Ctrl+Z 可還原", () => {
    if (typeof cleanupBadGlobalJoints !== "function") return;
    if (!win.confirm("清除錯誤的 globalJoint 綁定?\n會掃描所有 globalJoint,移除實際座標分歧 > 100 mm 的(典型誤綁)。\n正確綁定的保留。Ctrl+Z 可還原。")) return;
    cleanupBadGlobalJoints({ threshold: 100, skipConfirm: true });
    data = collectData();
    rebuildAfterDataChange();
    requestRender();
  }, { i18n: "p3d.cleanBad" }));
  og.appendChild(mkBtn("清全部綁", "清除「所有」globalJoint 與 globalMember 綁定(不論對錯)。完全重置全局節點 + 全局桿件。通常清完立刻跑三視圖自動配對重建;若要同時重建桿件綁定,直接跑「適配關聯」(它會自動先清後建)。Ctrl+Z 可還原", () => {
    if (typeof cleanupBadGlobalJoints !== "function") return;
    if (!win.confirm("清除所有 global 綁定?\n・globalJoint 物件(全部)會被移除 + joint.globalId 設為 null\n・globalMember 物件(全部)會被移除 + member.globalMemberId 設為 null\n\n包括綁定正確的也會一併清掉。Ctrl+Z 可還原。")) return;
    cleanupBadGlobalJoints({ clearAll: true, skipConfirm: true });
    data = collectData();
    rebuildAfterDataChange();
    requestRender();
  }, { i18n: "p3d.cleanAll" }));
  og.appendChild(mkBtn("檢查問題", "掃描所有頁面找出:(1) 可延伸桿件 — 端點到既存節點有 gap 的桿件;(2) 單頁節點 — 只出現在一頁、沒跨頁綁定的節點(常是漏綁或微差校準)。結果列在浮動面板,每行可點頁名跳到該頁。", async () => {
    showIssuesPanel("檢查中…", "<div style='color:#9aa0a6'>掃描中…</div>");
    await new Promise(r => setTimeout(r, 0));
    let cands = [];
    try {
      if (typeof findAllExtendableMembers === "function") cands = findAllExtendableMembers({}) || [];
    } catch (e) { console.warn("[3D 檢查] findAllExtendableMembers 失敗", e); }
    const singlePageNodes = (data.nodes || []).filter(n => n.srcCount === 1);
    renderIssuesPanel(cands, singlePageNodes);
  }, { i18n: "p3d.checkProblems" }));
  og.appendChild(mkBtn("編排編號", "對主畫面所有頁面跑「編排節點編號」:依「節點編號(全局)」設定逐頁重新編排節點與桿件編號(XXZZYY 或 YYZZXX)。各頁編號獨立。Ctrl+Z 可還原", async () => {
    if (typeof relayoutNumberingAll !== "function") return;
    if (!win.confirm("對所有頁面跑「編排節點編號」?\n依「節點編號(全局)」設定逐頁重新編排節點 / 桿件編號。\n各頁編號獨立(每頁從 1 開始)。Ctrl+Z 可還原。")) return;
    showPopupBusy("編排節點編號(全部頁面)準備中…");
    startMirrorBusy();
    try {
      await relayoutNumberingAll({ skipConfirm: true });
    } catch (e) { console.warn("[3D 編排編號] 失敗", e); }
    finally {
      stopMirrorBusy();
      hidePopupBusy();
      data = collectData();
      rebuildAfterDataChange();
      requestRender();
    }
  }, { i18n: "p3d.relayoutJ" }));
  og.appendChild(mkBtn("編排桿件", "對主畫面所有頁面跑「編排桿件編號」:只重編桿件 ID(不動節點 ID)。Y 軸 → X 軸 → Z 軸 → 斜撐 順序,plane 順序 XY → YZ → XZ。Ctrl+Z 可還原", async () => {
    if (typeof relayoutMembersNumberingAll !== "function") return;
    if (!win.confirm("對所有頁面跑「編排桿件編號」?\n只重編桿件 ID(節點 ID 不動)。\nY → X → Z → 斜撐 順序;plane 順序 XY → YZ → XZ。\nCtrl+Z 可還原。")) return;
    showPopupBusy("編排桿件編號(全部頁面)準備中…");
    startMirrorBusy();
    try {
      await relayoutMembersNumberingAll({ skipConfirm: true });
    } catch (e) { console.warn("[3D 編排桿件編號] 失敗", e); }
    finally {
      stopMirrorBusy();
      hidePopupBusy();
      data = collectData();
      rebuildAfterDataChange();
      requestRender();
    }
  }, { i18n: "p3d.relayoutM" }));

  // 套用目前語言到 3D popup(將剛被裝飾的 data-i18n 元素翻譯)
  try { _applyI18nOnDoc(doc); } catch (_) {}

  layoutCanvasArea();

  // ===== 5. Canvas resize (DPR-aware) =====
  function syncCanvasSize() {
    const r = canvasWrap.getBoundingClientRect();
    const dpr = win.devicePixelRatio || 1;
    canvas.width  = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width  = r.width + "px";
    canvas.style.height = r.height + "px";
  }
  function onWinResize() {
    layoutCanvasArea();
    syncCanvasSize();
    requestRender();
    repositionInfoPanel();
  }
  win.addEventListener("resize", onWinResize);
  // 延遲一輪等 layout 完才量,再 fit camera + 記下 refZoom
  // 初次 fit:popup body 在 setTimeout(0) 時往往還沒結束 layout,canvasWrap.getBoundingClientRect()
  //   會回傳偏小的值 → fit 算出的 zoom 太小(模型看起來很小)。改用 requestAnimationFrame 等到下一幀
  //   layout 完成後再量,並多保險一次 RAF 確保 canvasWrap 真的拿到最終尺寸。
  const _initialFit = () => {
    onWinResize();
    fitCameraToData();
    _refZoom = cam.zoom;
    requestRender();
  };
  win.requestAnimationFrame(() => {
    win.requestAnimationFrame(() => {
      _initialFit();
      // 再保險一次 — 有些瀏覽器在 popup 第一幀 body rect 仍 0,再延一段時間 fit 一次
      setTimeout(_initialFit, 80);
      // 把 keyboard focus 放到 body,讓 ←/→ 等鍵在 popup 開的瞬間就可以用
      try { win.focus(); body.focus(); } catch (_) {}
    });
  });
  // 點 popup 任何非輸入元素 → 把 focus 還給 body,讓 ←/→ 一直可用
  body.addEventListener("mousedown", (e) => {
    const t = e.target;
    if (!t || (t.tagName !== "INPUT" && t.tagName !== "SELECT" && t.tagName !== "TEXTAREA" && t.tagName !== "BUTTON")) {
      try { body.focus(); } catch (_) {}
    }
  });

  // ===== 6. 互動:中鍵平移 / 滾輪縮放 / Space+中鍵 或 Shift+中鍵 旋轉 / 右鍵平移 =====
  let _interact = null;
  let _leftDown = null;   // 追蹤左鍵 mousedown 起點:若 mouseup 時位移很小視為「點擊」→ 顯示 info panel
  let _spaceHeld = false; // 空白鍵狀態:按住時搭配中鍵 = 旋轉
  win.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !_spaceHeld) {
      _spaceHeld = true;
      // 預設游標提示「目前 Space 按住 = rotate 模式」
      if (!_interact) canvas.style.cursor = "crosshair";
      e.preventDefault();
    }
  });
  win.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      _spaceHeld = false;
      if (!_interact) canvas.style.cursor = "default";
    }
  });
  // popup 失焦(切到別的視窗)時也要清掉,避免「黏住」
  win.addEventListener("blur", () => { _spaceHeld = false; if (!_interact) canvas.style.cursor = "default"; });
  canvas.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (e.button === 0) {
      _leftDown = { sx: e.clientX, sy: e.clientY };
    } else if (e.button === 1) {
      // 中鍵預設 = 平移;按住 Space 或 Shift = 旋轉
      const isRotate = e.shiftKey || _spaceHeld;
      _interact = { type: isRotate ? "rotate" : "pan", sx: e.clientX, sy: e.clientY,
                    sa: cam.az, se: cam.el, scx: cam.cx, scy: cam.cy, scz: cam.cz };
      canvas.style.cursor = isRotate ? "crosshair" : "grabbing";
    } else if (e.button === 2) {
      _interact = { type: "pan", sx: e.clientX, sy: e.clientY,
                    sa: cam.az, se: cam.el, scx: cam.cx, scy: cam.cy, scz: cam.cz };
      canvas.style.cursor = "grabbing";
    }
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // 左鍵點擊:命中 node / edge → 顯示固定資訊匡(含可點擊頁面跳轉)
  canvas.addEventListener("click", (e) => {
    if (!_leftDown) return;
    const dx = e.clientX - _leftDown.sx, dy = e.clientY - _leftDown.sy;
    _leftDown = null;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) return;   // 拖曳 → 不視為點擊
    const hN = hitTestNode(e.clientX, e.clientY);
    if (hN) {
      const rows = (hN.samples || []).map(s => {
        const fname = _escHtml(s.fileName || "(unnamed)");
        const planeTag = s.plane ? ` <span style="color:#9aa0a6">(${_escHtml(s.plane)})</span>` : "";
        return `<div style="display:flex;align-items:center;gap:4px">
          <span style="color:#ffd23f">J${_escHtml(s.displayId)}</span>
          <span data-fileid="${_escHtml(s.fileId || "")}" data-pageidx="${s.pageIdx}" data-jointid="${_escHtml(s.jointId)}"
            title="切到主視窗對應頁面並放大到該節點" style="color:#9bb6e8;text-decoration:underline;cursor:pointer;pointer-events:auto">→ ${fname} #${s.pageIdx + 1}</span>
          ${planeTag}
        </div>`;
      }).join("");
      const planeGridJ = _planeGridHtml(hN.samples, "J", "#ffd23f");
      const anchorBadge = hN.isAnchor ? ` <span style="color:#ff8c00;font-weight:700">▼ 支承</span>` : "";
      const html =
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
          <span style="color:#9bb6e8;font-weight:700;font-size:11px">節點資訊${anchorBadge}</span>
          <span data-close="1" style="cursor:pointer;color:#888;padding:0 4px;pointer-events:auto" title="關閉">✕</span>
        </div>
        ${planeGridJ}
        <div style="margin-top:3px">世界座標 (${fmtWorld3D(hN.x)}, ${fmtWorld3D(hN.y)}, ${fmtWorld3D(hN.z)})</div>
        <div>綁定 joint 數: ${hN.srcCount}</div>
        <div>來源(前 ${(hN.samples || []).length}):</div>
        ${rows}`;
      tooltip.style.display = "none";
      showInfoPanel(e.clientX, e.clientY, html);
      return;
    }
    const hE = hitTestEdge(e.clientX, e.clientY);
    if (hE) {
      const n1 = data.nodeMap.get(hE.k1), n2 = data.nodeMap.get(hE.k2);
      const lenStr = (n1 && n2) ? Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z).toFixed(1) : "—";
      const rows = (hE.samples || []).map(s => {
        const fname = _escHtml(s.fileName || "(unnamed)");
        const planeTag = s.plane ? ` <span style="color:#9aa0a6">(${_escHtml(s.plane)})</span>` : "";
        return `<div style="display:flex;align-items:center;gap:4px">
          <span style="color:#7fd3ff">M${_escHtml(s.displayId)}</span>
          <span data-fileid="${_escHtml(s.fileId || "")}" data-pageidx="${s.pageIdx}" data-memberid="${_escHtml(s.memberId)}"
            title="切到主視窗對應頁面並放大到該桿件" style="color:#9bb6e8;text-decoration:underline;cursor:pointer;pointer-events:auto">→ ${fname} #${s.pageIdx + 1}</span>
          ${planeTag}
        </div>`;
      }).join("");
      const planeGridM = _planeGridHtml(hE.samples, "M", "#7fd3ff");
      const html =
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
          <span style="color:#9bb6e8;font-weight:700;font-size:11px">桿件資訊</span>
          <span data-close="1" style="cursor:pointer;color:#888;padding:0 4px;pointer-events:auto" title="關閉">✕</span>
        </div>
        ${planeGridM}
        <div style="margin-top:3px">長度 ${lenStr}</div>
        <div>綁定 member 數: ${hE.srcCount}</div>
        <div>來源(前 ${(hE.samples || []).length}):</div>
        ${rows}`;
      tooltip.style.display = "none";
      showInfoPanel(e.clientX, e.clientY, html);
      return;
    }
    // 空白處 → 關閉
    hideInfoPanel();
  });
  function onPopupMove(e) {
    if (!_interact) {
      const hit = hitTestNode(e.clientX, e.clientY);
      if (hit) {
        const r = canvasWrap.getBoundingClientRect();
        tooltip.style.display = "block";
        tooltip.style.left = (e.clientX - r.left + 12) + "px";
        tooltip.style.top  = (e.clientY - r.top + 12) + "px";
        const samples = hit.samples.map(s => `  ${s.fileName} #${s.pageIdx + 1} J${s.displayId} (${s.plane})`).join("\n");
        tooltip.textContent =
          (hit.isAnchor ? "▼ 支承\n" : "") +
          `世界座標: (${fmtWorld3D(hit.x)}, ${fmtWorld3D(hit.y)}, ${fmtWorld3D(hit.z)})\n` +
          `綁定 joint 數: ${hit.srcCount}\n` +
          `來源(前 ${hit.samples.length}):\n${samples}`;
        canvas.style.cursor = "pointer";
        return;
      }
      const eHit = hitTestEdge(e.clientX, e.clientY);
      if (eHit) {
        const r = canvasWrap.getBoundingClientRect();
        tooltip.style.display = "block";
        tooltip.style.left = (e.clientX - r.left + 12) + "px";
        tooltip.style.top  = (e.clientY - r.top + 12) + "px";
        const n1 = data.nodeMap.get(eHit.k1), n2 = data.nodeMap.get(eHit.k2);
        const samples = (eHit.samples || []).map(s => `  ${s.fileName} #${s.pageIdx + 1} M${s.displayId}`).join("\n");
        const lenStr = (n1 && n2) ? ` (長度 ${Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z).toFixed(1)})` : "";
        tooltip.textContent =
          `桿件${lenStr}\n` +
          `綁定 member 數: ${eHit.srcCount}\n` +
          `來源(前 ${(eHit.samples || []).length}):\n${samples}`;
        canvas.style.cursor = "pointer";
        return;
      }
      tooltip.style.display = "none";
      canvas.style.cursor = _spaceHeld ? "crosshair" : "default";
      return;
    }
    const dx = e.clientX - _interact.sx, dy = e.clientY - _interact.sy;
    if (_interact.type === "rotate") {
      cam.az = _interact.sa - dx * 0.008;
      cam.el = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, _interact.se + dy * 0.008));
    } else {
      // pan(Y-up):view_right=(cos az,0,-sin az), view_up=(sin az·sin el, cos el, cos az·sin el)
      const ca = Math.cos(cam.az), sa = Math.sin(cam.az), ce = Math.cos(cam.el), se = Math.sin(cam.el);
      cam.cx = _interact.scx + (-dx * ca + dy * sa * se) / cam.zoom;
      cam.cy = _interact.scy + (dy * ce) / cam.zoom;
      cam.cz = _interact.scz + (dx * sa + dy * ca * se) / cam.zoom;
    }
    requestRender();
  }
  function onPopupUp() {
    _interact = null;
    canvas.style.cursor = _spaceHeld ? "crosshair" : "default";
    /* _leftDown cleared in click handler if click fires */
  }
  win.addEventListener("mousemove", onPopupMove);
  win.addEventListener("mouseup", onPopupUp);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    cam.zoom = Math.max(0.0001, Math.min(1e6, cam.zoom * factor));
    requestRender();
  }, { passive: false });

  // ===== 7. 視覺尺寸(DPR + 使用者倍率 + 隨縮放縮小)=====
  function zoomFactor() {
    if (!sizeOpts.autoScaleWithZoom || _refZoom <= 0) return 1;
    // 用 sqrt 緩和:zoom 小 1/4 倍時尺寸大概縮到一半;限制範圍 [0.3, 2.5]
    return Math.max(0.3, Math.min(2.5, Math.sqrt(cam.zoom / _refZoom)));
  }
  function dotRadius() { return 3.2 * (win.devicePixelRatio || 1) * sizeOpts.dotScale * zoomFactor(); }
  function lineWidth() { return 1.5 * (win.devicePixelRatio || 1) * sizeOpts.lineScale * zoomFactor(); }
  function fontPx()    { return 11  * (win.devicePixelRatio || 1) * sizeOpts.fontScale * zoomFactor(); }

  function hitTestNode(cx, cy) {
    if (!data.nodes.length) return null;
    const r = canvas.getBoundingClientRect();
    const dpr = win.devicePixelRatio || 1;
    const px = (cx - r.left) * dpr;
    const py = (cy - r.top) * dpr;
    const dotR = dotRadius() * 1.5 + 6 * dpr;
    const tol2 = dotR * dotR;
    let best = null, bestD2 = tol2;
    for (const n of data.nodes) {
      if (n._filtered) continue;
      const p = project(n, canvas.width, canvas.height);
      const d2 = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    return best;
  }
  function hitTestEdge(cx, cy) {
    if (!data.edges.length || !opts.showEdges) return null;
    const r = canvas.getBoundingClientRect();
    const dpr = win.devicePixelRatio || 1;
    const px = (cx - r.left) * dpr;
    const py = (cy - r.top) * dpr;
    const tol = Math.max(6 * dpr, lineWidth() * 2 + 4 * dpr);
    const tol2 = tol * tol;
    let best = null, bestD2 = tol2;
    const w = canvas.width, h = canvas.height;
    for (const e of data.edges) {
      const n1 = data.nodeMap.get(e.k1), n2 = data.nodeMap.get(e.k2);
      if (!n1 || !n2 || n1._filtered || n2._filtered) continue;
      const p1 = project(n1, w, h), p2 = project(n2, w, h);
      const vx = p2.x - p1.x, vy = p2.y - p1.y;
      const len2 = vx * vx + vy * vy;
      if (len2 < 1) continue;
      let t = ((px - p1.x) * vx + (py - p1.y) * vy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = p1.x + t * vx, qy = p1.y + t * vy;
      const d2 = (qx - px) * (qx - px) + (qy - py) * (qy - py);
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    return best;
  }

  // ===== 8. Render =====
  let _renderRaf = 0;
  function requestRender() {
    if (_renderRaf) return;
    _renderRaf = win.requestAnimationFrame(() => {
      _renderRaf = 0;
      doRender();
    });
  }
  function doRender() {
    if (!canvas.width || !canvas.height) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    // 背景:漸層
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#1a1c20");
    bg.addColorStop(1, "#08090b");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    // 切面 filter
    for (const n of data.nodes) {
      n._filtered = false;
      if (cutState.axis) {
        const v = n[cutState.axis];
        if (cutState.slab) n._filtered = Math.abs(v - cutState.value) > cutState.slabWidth;
        else n._filtered = cutState.side === 1 ? v < cutState.value : v > cutState.value;
      }
    }
    if (cutState.axis) {
      let lbl = `${cutState.axis.toUpperCase()}=${cutState.value.toFixed(0)}`;
      if (cutState.slab) lbl += `(±${cutState.slabWidth})`;
      else lbl += cutState.side === 1 ? " (>側)" : " (<側)";
      // 若吸附到頁面 → 在標籤上顯示對應的檔名(取前幾個)
      if (cutState.snapToPage) {
        const planeWithDepth = cutState.axis === "x" ? "YZ" : cutState.axis === "y" ? "XZ" : "XY";
        const matched = [];
        for (const f of state.files) {
          for (const pg of Object.values(f.pages || {})) {
            if (!pg || pg._orphan || pg.plane !== planeWithDepth) continue;
            if (!Number.isFinite(pg.z)) continue;
            if (Math.abs(pg.z - cutState.value) <= 0.5) matched.push(f.name);
          }
        }
        if (matched.length) {
          const show = matched.slice(0, 2).join("/");
          lbl += ` ＠${show}${matched.length > 2 ? `+${matched.length - 2}` : ""}`;
        }
      }
      cutValueLabel.textContent = lbl;
    } else {
      cutValueLabel.textContent = "";
    }
    if (opts.showGrid && data.nodes.length) drawGroundGrid(ctx, w, h);
    if (opts.showAxes) drawWorldAxes(ctx, w, h);
    // 桿件
    const lw = lineWidth();
    let projEdges = null;
    if (opts.showEdges || opts.showMemberLabels) {
      projEdges = [];
      for (const e of data.edges) {
        const n1 = data.nodeMap.get(e.k1), n2 = data.nodeMap.get(e.k2);
        if (!n1 || !n2 || n1._filtered || n2._filtered) continue;
        const p1 = project(n1, w, h), p2 = project(n2, w, h);
        projEdges.push({ p1, p2, n1, n2, e, depth: (p1.depth + p2.depth) / 2 });
      }
      projEdges.sort((a, b) => b.depth - a.depth);
    }
    if (opts.showEdges && projEdges) {
      ctx.lineWidth = lw;
      for (const pe of projEdges) {
        const dx = pe.n2.x - pe.n1.x, dy = pe.n2.y - pe.n1.y, dz = pe.n2.z - pe.n1.z;
        const adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
        const maxD = Math.max(adx, ady, adz);
        let color = "#9aa0a6";
        if (maxD === ady) color = "#7eb6ff";
        else if (maxD === adx) color = "#ff9090";
        else if (maxD === adz) color = "#9aff9a";
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(pe.p1.x, pe.p1.y); ctx.lineTo(pe.p2.x, pe.p2.y);
        ctx.stroke();
      }
    }
    // 節點
    if (opts.showNodes) {
      const baseR = dotRadius();
      const projNodes = data.nodes
        .filter(n => !n._filtered)
        .map(n => ({ n, p: project(n, w, h) }))
        .sort((a, b) => b.p.depth - a.p.depth);
      for (const pn of projNodes) {
        const r0 = pn.n.srcCount > 1 ? baseR * 1.3 : baseR;
        const isAnchor = !!pn.n.isAnchor;
        // 錨點:PINNED = 橘色正方形、其餘(FIXED) = 倒三角形(類似 STAAD support symbol)
        // 一般:圓形(srcCount > 1 黃色跨頁綁定 / 單頁紅色)
        if (isAnchor) {
          const r = r0 * 2.5;   // 加大 1.5 → 2.5
          ctx.fillStyle = "#ff8c00";
          ctx.strokeStyle = "#ffd9a0";
          ctx.lineWidth = Math.max(1, r0 * 0.18);
          if (pn.n.supportType === "PINNED") {
            const s = r * 1.732;   // ≈ √3 r,跟 2D 端視覺一致
            ctx.beginPath();
            ctx.rect(pn.p.x - s / 2, pn.p.y - s / 2, s, s);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.moveTo(pn.p.x, pn.p.y - r);
            ctx.lineTo(pn.p.x - r * 0.866, pn.p.y + r * 0.5);
            ctx.lineTo(pn.p.x + r * 0.866, pn.p.y + r * 0.5);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
        } else {
          ctx.fillStyle = pn.n.srcCount > 1 ? "#ffd23f" : "#ff4444";
          ctx.beginPath(); ctx.arc(pn.p.x, pn.p.y, r0, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (opts.showLabels) {
        const fpx = fontPx();
        ctx.fillStyle = "#ddd";
        ctx.font = `${fpx}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        for (const pn of projNodes) {
          if (pn.n.samples.length) {
            // 若所有 sample 的 displayId 都一樣 → 只顯示一個;否則 a/b/c
            const uniq = [...new Set(pn.n.samples.map(s => String(s.displayId)))];
            ctx.fillText(uniq.join("/"), pn.p.x + baseR * 1.6, pn.p.y - baseR * 1.2);
          }
        }
      }
    }
    // 桿件標號:在每條 edge 中點畫 member id(用第一個 sample 的 displayId,多個來源用 +N 標示)
    if (opts.showMemberLabels && projEdges) {
      const fpx = fontPx();
      ctx.font = `${fpx}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const pe of projEdges) {
        const samples = (pe.e && pe.e.samples) || [];
        if (!samples.length) continue;
        // 若所有 sample 的 displayId 都一樣 → 只顯示一個;否則 a/b/c
        const uniq = [...new Set(samples.map(s => String(s.displayId)))];
        const lbl = uniq.join("/");
        const mx = (pe.p1.x + pe.p2.x) / 2;
        const my = (pe.p1.y + pe.p2.y) / 2;
        // 小深色底框,避免跟桿件線蓋在一起難辨識
        const tw = ctx.measureText(lbl).width;
        ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
        ctx.fillRect(mx - tw / 2 - 2, my - fpx / 2 - 1, tw + 4, fpx + 2);
        ctx.fillStyle = "#9bb6e8";
        ctx.fillText(lbl, mx, my);
      }
    }
    if (cutState.axis && cutState.showPlane) drawCutPlane(ctx, w, h);
    updatePageSnapLabel();
    // Footer 資訊(逐欄用 _t() 取對應語言翻譯;後綴 (隨縮放…) 與控制提示也是)
    const _ft = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
    footer.textContent =
      `${_ft("p3d.footer.joints","節點")} ${data.nodes.length} ・ ` +
      `${_ft("p3d.footer.members","桿件")} ${data.edges.length} ・ ` +
      `${_ft("p3d.footer.view","視角")} az=${(cam.az*180/Math.PI).toFixed(1)}° el=${(cam.el*180/Math.PI).toFixed(1)}° zoom=${cam.zoom.toFixed(4)} ・ ` +
      `${_ft("p3d.footer.font","字")} ${sizeOpts.fontScale.toFixed(2)}x ` +
      `${_ft("p3d.footer.line","線")} ${sizeOpts.lineScale.toFixed(2)}x ` +
      `${_ft("p3d.footer.point","點")} ${sizeOpts.dotScale.toFixed(2)}x` +
      (sizeOpts.autoScaleWithZoom ? ` (${_ft("p3d.footer.autoScale","隨縮放")} ${zoomFactor().toFixed(2)}x)` : "") +
      ` ・ ${_ft("p3d.footer.controls","中鍵旋轉 / 滾輪縮放 / Shift+中鍵或右鍵平移 / Hover 詳情")}`;
  }

  // 地網格:在 z = minZ(地板)平面畫網格
  function drawGroundGrid(ctx, w, h) {
    if (!data.nodes.length) return;
    // Y-up:地網格畫在 minY 平面(最低 Y),沿 X 跟 Z 方向延伸
    let minX=Infinity,maxX=-Infinity,minY=Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const n of data.nodes) {
      if (n.x<minX)minX=n.x; if (n.x>maxX)maxX=n.x;
      if (n.y<minY)minY=n.y;
      if (n.z<minZ)minZ=n.z; if (n.z>maxZ)maxZ=n.z;
    }
    const pad = (Math.max(maxX-minX, maxZ-minZ)) * 0.2;
    minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
    const span = Math.max(maxX - minX, maxZ - minZ);
    let step = Math.pow(10, Math.floor(Math.log10(span / 10)));
    if (span / step > 25) step *= 2;
    if (span / step < 5) step /= 2;
    ctx.strokeStyle = "rgba(120,140,180,0.18)"; ctx.lineWidth = lineWidth() * 0.6;
    for (let x = Math.ceil(minX / step) * step; x <= maxX; x += step) {
      const p1 = project({ x, y: minY, z: minZ }, w, h);
      const p2 = project({ x, y: minY, z: maxZ }, w, h);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
    for (let z = Math.ceil(minZ / step) * step; z <= maxZ; z += step) {
      const p1 = project({ x: minX, y: minY, z }, w, h);
      const p2 = project({ x: maxX, y: minY, z }, w, h);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
  }
  // 世界軸線(原點 +X / +Y / +Z 各畫一段亮色線)
  function drawWorldAxes(ctx, w, h) {
    const origin = { x: 0, y: 0, z: 0 };
    let extent = 1000;
    if (data.nodes.length) {
      let max = 0;
      for (const n of data.nodes) max = Math.max(max, Math.abs(n.x), Math.abs(n.y), Math.abs(n.z));
      extent = max * 1.2;
    }
    const axesData = [
      { p: { x: extent, y: 0, z: 0 }, color: "#ff5252", label: "X" },
      { p: { x: 0, y: extent, z: 0 }, color: "#4ade80", label: "Y" },
      { p: { x: 0, y: 0, z: extent }, color: "#4f9dff", label: "Z" },
    ];
    const p0 = project(origin, w, h);
    ctx.lineWidth = lineWidth() * 1.5;
    ctx.font = `bold ${fontPx() * 1.2}px sans-serif`;
    for (const a of axesData) {
      const p = project(a.p, w, h);
      ctx.strokeStyle = a.color;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.fillStyle = a.color;
      ctx.fillText(a.label, p.x + 4, p.y - 4);
    }
  }
  // 切面平面視覺化:在 cut 軸 = value 處畫一個半透明的方框
  function drawCutPlane(ctx, w, h) {
    if (!data.nodes.length) return;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const n of data.nodes) {
      if (n.x<minX)minX=n.x; if (n.x>maxX)maxX=n.x;
      if (n.y<minY)minY=n.y; if (n.y>maxY)maxY=n.y;
      if (n.z<minZ)minZ=n.z; if (n.z>maxZ)maxZ=n.z;
    }
    const v = cutState.value;
    let corners;
    if (cutState.axis === "x") {
      corners = [{x:v,y:minY,z:minZ},{x:v,y:maxY,z:minZ},{x:v,y:maxY,z:maxZ},{x:v,y:minY,z:maxZ}];
    } else if (cutState.axis === "y") {
      corners = [{x:minX,y:v,z:minZ},{x:maxX,y:v,z:minZ},{x:maxX,y:v,z:maxZ},{x:minX,y:v,z:maxZ}];
    } else {
      corners = [{x:minX,y:minY,z:v},{x:maxX,y:minY,z:v},{x:maxX,y:maxY,z:v},{x:minX,y:maxY,z:v}];
    }
    const projs = corners.map(c => project(c, w, h));
    ctx.fillStyle = "rgba(255, 210, 63, 0.12)";
    ctx.strokeStyle = "rgba(255, 210, 63, 0.5)";
    ctx.lineWidth = lineWidth();
    ctx.beginPath();
    ctx.moveTo(projs[0].x, projs[0].y);
    for (let i = 1; i < projs.length; i++) ctx.lineTo(projs[i].x, projs[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // 吸附頁的頁面標籤:用 HTML div 浮在 canvas 角落,不會擋住 3D 結構視圖
  function updatePageSnapLabel() {
    if (!pageSnapLabel) return;
    // 只要有 cut axis 就嘗試顯示 — 不論吸附點 / 吸附頁 / 沒吸附;tol 用切片厚度(slabWidth)或預設 0.5mm
    if (!cutState.axis) {
      pageSnapLabel.style.display = "none";
      return;
    }
    const planeWithDepth = cutState.axis === "x" ? "YZ" : cutState.axis === "y" ? "XZ" : "XY";
    const tol = Math.max(0.5, cutState.slabWidth || 0);
    const matched = [];
    for (const f of state.files) {
      for (const [k, pg] of Object.entries(f.pages || {})) {
        if (!pg || pg._orphan || pg.plane !== planeWithDepth) continue;
        if (!Number.isFinite(pg.z)) continue;
        if (Math.abs(pg.z - cutState.value) <= tol) matched.push(`${f.name} #${(+k) + 1}`);
      }
    }
    if (!matched.length) {
      pageSnapLabel.style.display = "none";
      return;
    }
    const show = matched.length <= 4 ? matched.join(" / ") : `${matched.slice(0, 4).join(" / ")} +${matched.length - 4}`;
    pageSnapLabel.innerHTML =
      `<div style="font-size:10px;color:#aaa;font-weight:normal">當前切面對應頁</div>` +
      `<div style="margin-top:2px">${show}</div>` +
      `<div style="font-size:10px;color:#aaa;font-weight:normal;margin-top:2px">${cutState.axis.toUpperCase()}=${cutState.value.toFixed(0)}</div>`;
    pageSnapLabel.style.display = "block";
  }

  function rebuildAfterDataChange() {
    fitCameraToData();
    _refZoom = cam.zoom;
    if (cutState.axis) {
      let mn = Infinity, mx = -Infinity;
      for (const n of data.nodes) { const v = n[cutState.axis]; if (v < mn) mn = v; if (v > mx) mx = v; }
      cutSlider.min = mn; cutSlider.max = mx; cutSlider.step = Math.max(1, (mx - mn) / 200);
      if (cutState.value < mn || cutState.value > mx) { cutState.value = (mn + mx) / 2; cutSlider.value = cutState.value; }
    }
  }

  // ===== 9. Cleanup =====
  function cleanupOnClose() {
    stopMirrorBusy();
    win.removeEventListener("resize", onWinResize);
    win.removeEventListener("mousemove", onPopupMove);
    win.removeEventListener("mouseup", onPopupUp);
    window.removeEventListener("beforeunload", onMainUnload);
    setP3dPreviewWindow(null);
  }
  win.addEventListener("beforeunload", cleanupOnClose);
  // 主視窗關閉時也一併關掉 popup,避免孤立視窗
  const onMainUnload = () => { try { win.close(); } catch (_) {} };
  window.addEventListener("beforeunload", onMainUnload, { once: true });

  const _p3dRef = {
    win, canvas,
    rebuildData: () => { data = collectData(); rebuildAfterDataChange(); requestRender(); },
    // 把 3D 相機切到對應 page 的視角 + 開切面
    //   XZ 平面(俯視,depth=Y)→ 俯視 + Y cut at page.z
    //   XY 平面(立面,depth=Z)→ 正面 + Z cut at page.z
    //   YZ 平面(側立面,depth=X)→ 側面 + X cut at page.z
    alignToPage: (file, page) => {
      if (!page || !page.plane) return;
      const plane = page.plane;
      const depthAxis = plane === "XZ" ? "y" : plane === "XY" ? "z" : plane === "YZ" ? "x" : null;
      const depthVal = (page.z != null && Number.isFinite(page.z)) ? page.z : 0;
      // 視角
      if (plane === "XZ") { cam.az = 0; cam.el = Math.PI / 2; }
      else if (plane === "XY") { cam.az = 0; cam.el = 0; }
      else if (plane === "YZ") { cam.az = Math.PI / 2; cam.el = 0; }
      // 切面
      if (depthAxis) {
        cutState.axis = depthAxis;
        cutState.value = depthVal;
        cutState.slab = true;        // 切片模式比較直觀(只顯示該深度附近)
        cutState.snapToPage = true;  // 自動勾「吸附頁」 — 拖 slider 時會吸到最近頁面 Z
        try { cutAxisSel.value = depthAxis; } catch (_) {}
        try {
          // 同步「吸附頁」checkbox UI
          const cb = snapToPageCheck && snapToPageCheck.querySelector("input[type=checkbox]");
          if (cb) cb.checked = true;
        } catch (_) {}
        try {
          // 確保 slider range 涵蓋當前 cut value
          let mn = Infinity, mx = -Infinity;
          for (const n of data.nodes) { const v = n[depthAxis]; if (v < mn) mn = v; if (v > mx) mx = v; }
          if (!Number.isFinite(mn)) { mn = depthVal - 1000; mx = depthVal + 1000; }
          mn = Math.min(mn, depthVal); mx = Math.max(mx, depthVal);
          cutSlider.min = mn; cutSlider.max = mx;
          cutSlider.step = Math.max(1, (mx - mn) / 200);
          cutSlider.value = depthVal;
        } catch (_) {}
      }
      requestRender();
    },
    // 把相機置中到指定 3D 包圍盒,並計算可看下全部的 zoom
    //   opts.padFactor:相對 bbox 主邊的留白倍數(預設 1.4 = 40%;搜尋跳轉常用 2.5)
    zoomToBounds: (bounds3D, opts) => {
      if (!bounds3D) return;
      const padFactor = (opts && Number.isFinite(opts.padFactor)) ? opts.padFactor : 1.4;
      const [xMin, xMax] = bounds3D.x || [];
      const [yMin, yMax] = bounds3D.y || [];
      const [zMin, zMax] = bounds3D.z || [];
      if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return;
      cam.cx = (xMin + xMax) / 2;
      cam.cy = (yMin + yMax) / 2;
      cam.cz = (zMin + zMax) / 2;
      const w = xMax - xMin, h = yMax - yMin, d = zMax - zMin;
      const span = Math.max(w, h, d, 200) * padFactor;
      const r = canvasWrap.getBoundingClientRect();
      const dpr = win.devicePixelRatio || 1;
      const px = Math.min(r.width, r.height) * dpr;
      cam.zoom = Math.max(0.0001, px / span);
      _refZoom = cam.zoom;
      requestRender();
    },
  };  setP3dPreviewWindow(_p3dRef);
}
