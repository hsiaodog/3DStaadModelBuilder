// 釘住的節點資訊視窗(jointInfoPopup)
//   點擊節點 → 在點擊位置開出可拖移、可關閉的小視窗;hover tip 同時隱藏避免重疊
//   建一次就重用,內容用 fmtJointInfo 產生,titlebar 自己加(jip-titlebar / jip-close)
//   CSS 樣式在 src/style.css 的 #jointInfoPopup 區塊
// @ts-nocheck

import { displayJointId } from "../app/integration";
import { fmtJointInfo, hideHoverTip } from "../ui/hoverTip";

// 拖移期間的 closure 狀態:模組單例,只跟 popup 的一份 DOM 對應
let _jipDragState: { startX: number; startY: number; left: number; top: number } | null = null;

export function showJointInfoPopup(j: any, ev: MouseEvent) {
  hideHoverTip();
  let popup = document.getElementById("jointInfoPopup") as HTMLDivElement | null;
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "jointInfoPopup";
    document.body.appendChild(popup);
    // 拖移 / Esc 監聽:整個 window 監一次,popup 重建時不重綁
    window.addEventListener("mousemove", (e: MouseEvent) => {
      if (!_jipDragState) return;
      const pp = document.getElementById("jointInfoPopup") as HTMLDivElement | null;
      if (!pp) return;
      const nx = _jipDragState.left + (e.clientX - _jipDragState.startX);
      const ny = _jipDragState.top  + (e.clientY - _jipDragState.startY);
      // clamp 不要拖出視窗
      pp.style.left = Math.max(0, Math.min(window.innerWidth - 60, nx)) + "px";
      pp.style.top  = Math.max(0, Math.min(window.innerHeight - 24, ny)) + "px";
    });
    window.addEventListener("mouseup", () => { _jipDragState = null; });
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const pp = document.getElementById("jointInfoPopup") as HTMLDivElement | null;
        if (pp && pp.style.display !== "none") pp.style.display = "none";
      }
    });
  }
  const titleId = displayJointId(j);
  popup.innerHTML =
    `<div class="jip-titlebar"><span class="jip-title-text">節點 J${titleId}</span><span class="jip-close" title="關閉 (Esc)">×</span></div>` +
    `<div class="jip-body">${fmtJointInfo(j)}</div>`;
  // 定位在點擊處附近,clamp 進視窗
  const off = 14;
  popup.style.display = "block";
  const r = popup.getBoundingClientRect();
  let x = ev.clientX + off, y = ev.clientY + off;
  if (x + r.width  > window.innerWidth)  x = ev.clientX - r.width  - off;
  if (y + r.height > window.innerHeight) y = ev.clientY - r.height - off;
  popup.style.left = Math.max(0, x) + "px";
  popup.style.top  = Math.max(0, y) + "px";
  // titlebar drag handler(每次重綁,因為 innerHTML 換掉子元素)
  const tbar = popup.querySelector(".jip-titlebar") as HTMLElement | null;
  if (tbar) {
    tbar.addEventListener("mousedown", (e: MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains("jip-close")) return;
      const rect = popup!.getBoundingClientRect();
      _jipDragState = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
      e.preventDefault();
    });
  }
  // close button
  const closeBtn = popup.querySelector(".jip-close") as HTMLElement | null;
  if (closeBtn) {
    closeBtn.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      popup!.style.display = "none";
    });
  }
}

export function hideJointInfoPopup() {
  const popup = document.getElementById("jointInfoPopup");
  if (popup) popup.style.display = "none";
}
