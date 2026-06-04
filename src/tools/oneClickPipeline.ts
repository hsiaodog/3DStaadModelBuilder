// 3D 一鍵處理(主視窗版本)— 對應 3D 預覽 popup 內的「⚡ 一鍵處理」按鈕,
//   但只跑主視窗能取用的步驟(共 9 步):
//     1) 整理所有頁面  2) 清除所有 globalJoint 綁定  3) 適配關聯(精準度)重建
//     4) 編排節點編號  5) 編排桿件編號  6) 失效 rank cache + 重 infer
//     7) 重整切面 / page 座標區  8) 重整側欄列表  9) 重畫畫面
//
//   各步驟個別 pushUndo,任一步失敗皆可 Ctrl+Z 回上一個 stable state。
//   取消(Esc / 取消鈕):cancelled flag 在每步開頭檢查 → step-level 取消(不會在 step 中段斷)
// @ts-nocheck

import {
  state, $, pushUndo, render, refreshLists,
  consolidateAllPagesWithConfirm, cleanupBadGlobalJoints, _runFitMergeByPrecision,
  relayoutNumberingAll, relayoutMembersNumberingAll,
  refreshPageCoordSection, refreshSectionLinkList,
  _showAllCollisionsPopup,
} from "../app/integration";
import { showBusyWithCancel, setBusyMessage, hideBusy } from "../ui/busy";
import { invalidateRankCache } from "../core/rankCache";
import { inferAllGlobalJoints } from "../core/globalJoints";

export async function _run3DOneClickPipeline() {
  const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  if (!confirm(
    `3D 一鍵處理 — 依序跑下列 9 步:\n\n` +
    `1. 整理所有頁面(合併同位節點 / 刪重複桿件 / 共線中段拆段)\n` +
    `2. 清除所有 globalJoint 綁定(從乾淨狀態開始,避免舊綁定留錯資料)\n` +
    `3. 適配關聯(精準度 ${md} 位數)— 重建所有 globalJoint 綁定\n` +
    `4. 編排節點編號(全部頁面)\n` +
    `5. 編排桿件編號(全部頁面)\n` +
    `6. 失效 rank cache + 重 infer globalJoint\n` +
    `7. 重整切面 / page 座標區\n` +
    `8. 重整側欄列表\n` +
    `9. 重畫畫面\n\n` +
    `每步都會 pushUndo;失敗 / 取消可用 Ctrl+Z 逐步還原。要繼續嗎?`
  )) return;
  // 直接管 spinner — withBusy 不回傳 Promise,連串 await withBusy 不能保證序列化,
  //   也會在每步之間 sp.classList.remove("active") 造成閃爍 + 中間空窗。
  // 改法:用 showBusyWithCancel 開到尾,每步只更新訊息 + 檢查 cancel flag。
  //   Esc / 取消鈕設 cancelled=true → 下一步開始前 throw CANCELLED → catch 後跳到 finally
  let cancelled = false;
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !cancelled) {
      cancelled = true;
      setBusyMessage("取消中…等當前步驟完畢");
    }
  };
  document.addEventListener("keydown", onEsc, true);
  showBusyWithCancel("3D 一鍵處理 — 開始…(Esc / 取消鈕可中斷)", () => {
    if (cancelled) return;
    cancelled = true;
    setBusyMessage("取消中…等當前步驟完畢");
  });
  const sp = document.getElementById("busySpinner");
  const msgEl = sp ? sp.querySelector(".msg") : null;
  const setMsg = (m) => { if (msgEl) msgEl.textContent = m; };
  const yieldFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // 每步開頭呼叫:讓 paint 一次,然後檢查 cancel
  const _step = async (msg: string) => {
    setMsg(msg);
    await yieldFrame();
    if (cancelled) throw new Error("__CANCELLED__");
  };
  let ok = true;
  try {
    await _step("3D 一鍵處理 1/9:整理所有頁面…");
    if (typeof consolidateAllPagesWithConfirm === "function") {
      await consolidateAllPagesWithConfirm({ skipConfirm: true });
    }
    await _step("3D 一鍵處理 2/9:清除所有 globalJoint 綁定…");
    if (typeof cleanupBadGlobalJoints === "function") {
      cleanupBadGlobalJoints({ clearAll: true, skipConfirm: true });
    }
    await _step(`3D 一鍵處理 3/9:適配關聯(精準度 ${md})— 重建綁定…`);
    if (typeof _runFitMergeByPrecision === "function") {
      await _runFitMergeByPrecision({ skipConfirm: true });
    }
    await _step("3D 一鍵處理 4/9:編排節點編號…");
    if (typeof relayoutNumberingAll === "function") {
      await relayoutNumberingAll({ skipConfirm: true });
    }
    await _step("3D 一鍵處理 5/9:編排桿件編號…");
    if (typeof relayoutMembersNumberingAll === "function") {
      await relayoutMembersNumberingAll({ skipConfirm: true });
    }
    await _step("3D 一鍵處理 6/9:失效 rank cache + 重 infer globalJoint…");
    pushUndo();
    if (typeof invalidateRankCache === "function") invalidateRankCache();
    if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
    await _step("3D 一鍵處理 7/9:重整切面 / page 座標區…");
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
    if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
    await _step("3D 一鍵處理 8/9:重整側欄列表…");
    try { refreshLists(); } catch (_) {}
    await _step("3D 一鍵處理 9/9:重畫畫面…");
    try { render(); } catch (_) {}
    // 等最後一次 render 結束 + 一個 paint frame,再關 spinner — 避免畫面才剛要重排就先沒了訊息
    await yieldFrame();
  } catch (e) {
    if (e && (e as any).message === "__CANCELLED__") {
      console.log("[3D 一鍵處理] 使用者取消(已完成的步驟保留,可用 Ctrl+Z 還原)");
      setTimeout(() => alert("3D 一鍵處理已取消。已完成的步驟保留;可用 Ctrl+Z 逐步還原。"), 30);
      ok = false;
    } else {
      ok = false;
      console.warn("[3D 一鍵處理] 失敗", e);
      alert("3D 一鍵處理途中發生錯誤:" + (e && (e as any).message ? (e as any).message : e) + "\n\n已完成的步驟保留;可用 Ctrl+Z 逐步還原。");
    }
  } finally {
    document.removeEventListener("keydown", onEsc, true);
    hideBusy();
  }
  if (ok) {
    let pages = 0, joints = 0;
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        pages++; joints += (pg.joints || []).length;
      }
    }
    if ($("hud")) $("hud").textContent = `3D 一鍵處理完成 ・ ${pages} 頁 / ${joints} joint`;
    console.log("[3D 一鍵處理] 完成");
    // 若有撞號桿件 → 跳 popup 提示(跟切頁時同款,有「搜尋」+ 確定按鈕)
    try {
      if (state.memberCollisions && state.memberCollisions.size > 0) {
        _showAllCollisionsPopup();
      }
    } catch (e) { console.warn("[3D 一鍵處理] 撞號 popup 失敗:", e); }
  }
}
