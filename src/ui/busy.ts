// Phase 8c — Busy spinner UI(等待中蒙版 + 可選取消鈕)
//   主視窗 spinner DOM: #busySpinner > .msg (訊息) / #busyCancelBtn (可選取消鈕)
//   3D popup 開啟時 setBusyMessage 也會把訊息推到 popup 的 #popupBusyMsg。
//   busyTick:讓瀏覽器有機會 paint 的 yield 策略,綜合 rAF / scheduler / MessageChannel,
//   並處理「主 tab 在背景被節流」與「popup rAF 卡死」等 edge case。
//   依賴 legacy.ts 的 _3dPreviewWindow live binding(已 export)。
// @ts-nocheck

import { _3dPreviewWindow } from "../legacy";

// 進度顯示輔助:更新 spinner 訊息並讓瀏覽器有機會 paint
export function setBusyMessage(msg) {
  const sp = document.getElementById("busySpinner");
  if (sp) {
    const m = sp.querySelector(".msg");
    if (m) m.textContent = msg || "處理中…";
  }
  // 3D popup 開啟時,直接把訊息推到 popup 的 DOM(不依賴 popup 端的 setInterval mirror)
  //   原因:主 loop 用 scheduler.postTask(user-blocking) yield 時,user-blocking 會搶先 popup 的
  //   setInterval(默認 user-visible 優先),mirror callback 排不到 → 訊息卡在第一個。
  //   改為主動推送:每次 setBusyMessage 同時寫入主 spinner 與 popup 的 popupBusyMsg;
  //   popup 的 render 仍可在 vsync 時 paint 出更新。
  try {
    if (typeof _3dPreviewWindow !== "undefined" && _3dPreviewWindow && _3dPreviewWindow.win && !_3dPreviewWindow.win.closed) {
      const pm = _3dPreviewWindow.win.document.getElementById("popupBusyMsg");
      if (pm) pm.textContent = msg || "處理中…";
    }
  } catch (_) {}
}

export function busyTick() {
  // Yield 策略 —— 必須同時滿足兩件事:
  //   (a) 不被 tab visibility 節流(主 tab 在背景時 rAF / setTimeout 都被 clamp)
  //   (b) 讓瀏覽器有機會 paint(否則 popup 看不到訊息更新)
  //
  //   先決選項:
  //   1. 3D popup 開著 + popup 為 foreground → 用 popup 的 rAF。
  //      但 popup 進背景時 rAF 會被節流/停掉,純等 popup rAF 會永久卡死 main window 的 busy(實測:
  //      使用者在主視窗點切面連結觸發 activatePageWithBusy → spinner 永遠不消失)。
  //      → 一律 race 一個 100ms 的 setTimeout fallback,popup 沒回應就放主 window 的 rAF 走。
  //   2. 主 tab foreground → 用主 window 的 rAF(60Hz 正常)
  //   3. 主 tab 在背景 + 沒 popup → 用 scheduler.postTask user-blocking(不被節流,但此時沒 UI 觀察者;
  //      至少保證 op 能跑完)
  //   4. 最後 fallback:MessageChannel macrotask
  const _mainRaf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const _timeoutFallback = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    if (typeof _3dPreviewWindow !== "undefined" && _3dPreviewWindow && _3dPreviewWindow.win && !_3dPreviewWindow.win.closed) {
      const popupRaf = new Promise(r => _3dPreviewWindow.win.requestAnimationFrame(() => _3dPreviewWindow.win.requestAnimationFrame(r)));
      // popup 若在背景,rAF 不會 fire → race 100ms timeout 解死鎖
      return Promise.race([popupRaf, _timeoutFallback(100)]);
    }
  } catch (_) { /* popup 跨 origin / 權限問題 → 往下走 */ }
  if (typeof document === "undefined" || !document.hidden) {
    return _mainRaf();
  }
  if (typeof scheduler !== "undefined" && typeof scheduler.postTask === "function") {
    try {
      return scheduler.postTask(() => {}, { priority: "user-blocking" });
    } catch (_) { /* 不支援 options → 往下走 */ }
  }
  if (typeof MessageChannel === "function") {
    return new Promise(r => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(null);
    });
  }
  return _mainRaf();
}

export function showBusy(msg) {
  const sp = document.getElementById("busySpinner");
  if (sp) {
    setBusyMessage(msg);
    sp.classList.add("active");
  }
  // 顯示一般 busy 時把 cancel 按鈕藏起來(預設沒可取消的操作)
  const cb = document.getElementById("busyCancelBtn");
  if (cb) { cb.classList.remove("active"); (cb as any).onclick = null; }
}

// 顯示帶取消鈕的 busy。callback 點下會被呼叫(用來設 cancel 旗標)
//   呼叫端要自己負責 hideBusy 還有檢查旗標、await busyTick 讓 UI 有機會 paint cancel 點擊
//   會自動 focus 取消鈕,讓 Enter / Space 也能觸發
export function showBusyWithCancel(msg, onCancel) {
  showBusy(msg);
  const cb = document.getElementById("busyCancelBtn");
  if (!cb) return;
  cb.classList.add("active");
  (cb as any).onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    try { onCancel && onCancel(); } catch (err) { console.warn("[busy cancel]", err); }
  };
  // 把焦點放到按鈕,使用者按 Enter / Space 也能觸發,不必先 Tab
  setTimeout(() => { try { cb.focus(); } catch (_) {} }, 0);
}

export function hideBusy() {
  const sp = document.getElementById("busySpinner");
  if (sp) sp.classList.remove("active");
  const cb = document.getElementById("busyCancelBtn");
  if (cb) { cb.classList.remove("active"); (cb as any).onclick = null; }
}
