// 共用「力學設定視窗」樣式(.mech-dialog)— 節點支承 / 桿件釋放兩個 modal 共用。
//   主視窗由 style.css 提供;獨立 popup(搜尋視窗)沒有 style.css → 需自行注入一份。

export const MECH_DIALOG_CSS = `
.mech-dialog { position: fixed; inset: 0; z-index: 2000; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.5); }
.mech-dialog.active { display: flex; }
.mech-dialog .sd-card { background: #1e1e22; color: #eaeaea; border: 1px solid #555; border-radius: 8px; min-width: 440px; max-width: 580px; box-shadow: 0 10px 32px rgba(0,0,0,0.7); font: 12px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.mech-dialog .sd-titlebar { background: rgba(255,255,255,0.06); padding: 8px 14px; border-bottom: 1px solid #444; border-radius: 8px 8px 0 0; color: #ffd23f; font-weight: 700; font-size: 13px; }
.mech-dialog .sd-body { padding: 14px 18px; color: #c8ccd0; max-height: 72vh; overflow: auto; }
.mech-dialog .sd-intro { margin-bottom: 12px; }
.mech-dialog .sd-intro b { color: #fff; }
.mech-dialog .sd-types { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.mech-dialog .sd-type { padding: 6px 12px; border: 1px solid #555; border-radius: 6px; cursor: pointer; user-select: none; background: #26262b; color: #cfd3d8; font-weight: 700; }
.mech-dialog .sd-type:hover { background: #33343a; color: #fff; }
.mech-dialog .sd-type.active { background: #2f4a78; border-color: #4f9dff; color: #fff; box-shadow: 0 0 0 1px rgba(79,157,255,0.3) inset; }
.mech-dialog .sd-desc { color: #9aa0a6; margin: 2px 0 12px; font-size: 11px; }
.mech-dialog .sd-params { border-top: 1px dashed #3a3a3e; padding-top: 12px; min-height: 18px; }
.mech-dialog .sd-params:empty { display: none; }
.mech-dialog .sd-grouptitle { color: #9bb6e8; font-weight: 700; font-size: 11px; margin: 8px 0 4px; }
.mech-dialog .sd-dofgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px 16px; }
.mech-dialog .sd-dof { display: flex; align-items: center; gap: 6px; }
.mech-dialog .sd-dof label { cursor: pointer; color: #cfd3d8; }
.mech-dialog .sd-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
.mech-dialog .sd-row .k { width: 52px; color: #9bb6e8; font-weight: 700; }
.mech-dialog input[type=number] { width: 130px; background: #15161a; color: #eaeaea; border: 1px solid #555; border-radius: 4px; padding: 4px 6px; font: inherit; }
.mech-dialog input[type=number]:focus { outline: none; border-color: #4f9dff; }
.mech-dialog .sd-unit { color: #7b818a; font-size: 10.5px; }
.mech-dialog .sd-hint { color: #7b818a; font-size: 10.5px; margin-bottom: 8px; }
.mech-dialog .sd-warn { color: #ffb454; margin-top: 10px; font-size: 11px; min-height: 14px; }
.mech-dialog .sd-buttons { padding: 10px 14px 14px; display: flex; gap: 8px; justify-content: flex-end; border-top: 1px solid #333; }
.mech-dialog .sd-btn { padding: 6px 16px; border-radius: 4px; cursor: pointer; border: 1px solid #555; background: #2a2a2e; color: #eaeaea; font: inherit; }
.mech-dialog .sd-btn:hover { background: #3a3a3e; }
.mech-dialog .sd-btn.primary { background: #1976d2; border-color: #2196f3; color: #fff; }
.mech-dialog .sd-btn.primary:hover { background: #2196f3; }
.mech-dialog .sd-btn.primary:disabled { background: #37474f; border-color: #455a64; color: #90a4ae; cursor: not-allowed; }
`;

// 確保目標 document 有 .mech-dialog 樣式(主視窗由 style.css 提供 → 略過;popup → 注入一次)
export function ensureMechDialogCss(doc: Document): void {
  if (doc === document) return;
  if (doc.getElementById("mechDialogStyle")) return;
  const style = doc.createElement("style");
  style.id = "mechDialogStyle";
  style.textContent = MECH_DIALOG_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}
