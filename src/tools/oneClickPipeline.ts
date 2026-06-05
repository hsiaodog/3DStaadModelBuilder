// 3D 一鍵處理(主視窗版本)— 現由「目前選定的 structure pipeline」驅動步驟順序與參數。
//   各步驟個別 pushUndo;任一步失敗 / 取消(Esc / 取消鈕)皆可 Ctrl+Z 回上一個 stable state。
//   step-level 取消:cancelled flag 在每步開頭(yieldAndCheckCancel)檢查 → 不會在 step 中段斷。
// @ts-nocheck

import {
  state, $, render, refreshLists,
  refreshPageCoordSection, refreshSectionLinkList,
  _showAllCollisionsPopup,
} from "../app/integration";
import { showBusyWithCancel, setBusyMessage, hideBusy } from "../ui/busy";
import { getActivePipeline } from "../core/pipeline/pipelineSettings";
import { getStepDef } from "../core/pipeline/registry";
import { runPipeline } from "../core/pipeline/runPipeline";

export async function _run3DOneClickPipeline() {
  const pipeline = getActivePipeline();
  const enabled = (pipeline.steps || []).filter((s) => s && s.enabled !== false && getStepDef(s.id));
  if (!enabled.length) { alert("目前的結構 pipeline 沒有任何啟用的步驟。"); return; }
  const stepLines = enabled.map((s, i) => `${i + 1}. ${(getStepDef(s.id) || {}).label || s.id}`).join("\n");
  if (!confirm(
    `3D 一鍵處理 — 結構類型「${pipeline.label}」,依序跑 ${enabled.length} 步:\n\n` +
    `${stepLines}\n\n` +
    `每步都會 pushUndo;失敗 / 取消可用 Ctrl+Z 逐步還原。要繼續嗎?`
  )) return;

  let cancelled = false;
  const onEsc = (e) => {
    if (e.key === "Escape" && !cancelled) { cancelled = true; setBusyMessage("取消中…等當前步驟完畢"); }
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

  // 主視窗 host 轉接器(refreshRender / checkIssues 為宿主相關步驟;rebuildInfer 已是核心步驟)
  const host = {
    setMessage: setMsg,
    yieldAndCheckCancel: async () => { await yieldFrame(); if (cancelled) throw new Error("__CANCELLED__"); },
    refreshRender: () => {
      try { if (typeof refreshPageCoordSection === "function") refreshPageCoordSection(); } catch (_) {}
      try { if (typeof refreshSectionLinkList === "function") refreshSectionLinkList(); } catch (_) {}
      try { refreshLists(); } catch (_) {}
      try { render(); } catch (_) {}
    },
    checkIssues: () => { try { if (state.memberCollisions && state.memberCollisions.size > 0) _showAllCollisionsPopup(); } catch (_) {} },
  };

  let ok = true;
  try {
    await runPipeline(pipeline, host);
    await yieldFrame();
  } catch (e) {
    ok = false;
    if (e && e.message === "__CANCELLED__") {
      console.log("[3D 一鍵處理] 使用者取消(已完成的步驟保留,可用 Ctrl+Z 還原)");
      setTimeout(() => alert("3D 一鍵處理已取消。已完成的步驟保留;可用 Ctrl+Z 逐步還原。"), 30);
    } else {
      console.warn("[3D 一鍵處理] 失敗", e);
      alert("3D 一鍵處理途中發生錯誤:" + (e && e.message ? e.message : e) + "\n\n已完成的步驟保留;可用 Ctrl+Z 逐步還原。");
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
    if ($("hud")) $("hud").textContent = `3D 一鍵處理完成 ・ ${pipeline.label} ・ ${pages} 頁 / ${joints} joint`;
    console.log(`[3D 一鍵處理] 完成 ・ pipeline=${pipeline.structureType}`);
  }
}
