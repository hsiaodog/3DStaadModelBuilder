// 支承設定視窗(Phase 2)— 選類型 + 填參數,回傳完整 Support 物件
//
//   pickSupportModal(jointCount, current?) → Promise<Support | null>
//     null = 使用者取消(Esc / 點 backdrop / 取消鈕)→ 呼叫端不應更動任何資料
//
//   5 種類型:
//     FIXED      — 無參數
//     PINNED     — 無參數
//     FIXED_BUT  — released[]:勾選 = 放鬆(自由)的自由度
//     SPRING     — springs{}:各方向勁度(空白 = 該向維持固接)
//     ENFORCED   — enforced{}:各方向強制位移量(空白 = 不指定)
//
//   modal DOM 第一次呼叫時建立,之後重用(只重建內容 + 換 resolve)。
// @ts-nocheck

import type { Support, SupportType, DOF, SpringKey } from "../core/support";
import { DOF_KEYS, SPRING_KEYS } from "../core/support";

interface TypeMeta { type: SupportType; label: string; desc: string; }
const TYPE_META: TypeMeta[] = [
  { type: "FIXED",     label: "固接 FIXED",          desc: "6 個自由度全鎖 — 鋼柱基座最常見" },
  { type: "PINNED",    label: "銷接 PINNED",         desc: "鎖 3 平移、放 3 轉動 — 鉸支承" },
  { type: "FIXED_BUT", label: "部分釋放 FIXED BUT",  desc: "勾選的自由度放鬆(自由),其餘維持鎖死" },
  { type: "SPRING",    label: "彈簧 SPRING",         desc: "指定方向給彈簧勁度(空白 = 該向維持固接)" },
  { type: "ENFORCED",  label: "強制位移 ENFORCED",   desc: "指定方向給強制位移量(空白 = 不指定)" },
];

const DOF_LABEL: Record<DOF, string> = {
  FX: "FX 平移X", FY: "FY 平移Y", FZ: "FZ 平移Z",
  MX: "MX 轉動X", MY: "MY 轉動Y", MZ: "MZ 轉動Z",
};
const SPRING_LABEL: Record<SpringKey, string> = {
  KFX: "KFX", KFY: "KFY", KFZ: "KFZ", KMX: "KMX", KMY: "KMY", KMZ: "KMZ",
};

let _sdResolve: ((v: Support | null) => void) | null = null;

// #supportDialog 的樣式;主視窗已由 style.css 提供,獨立 popup(搜尋視窗)需自行注入一份。
const _SUPPORT_DIALOG_CSS = `
#supportDialog { position: fixed; inset: 0; z-index: 2000; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.5); }
#supportDialog.active { display: flex; }
#supportDialog .sd-card { background: #1e1e22; color: #eaeaea; border: 1px solid #555; border-radius: 8px; min-width: 440px; max-width: 580px; box-shadow: 0 10px 32px rgba(0,0,0,0.7); font: 12px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
#supportDialog .sd-titlebar { background: rgba(255,255,255,0.06); padding: 8px 14px; border-bottom: 1px solid #444; border-radius: 8px 8px 0 0; color: #ffd23f; font-weight: 700; font-size: 13px; }
#supportDialog .sd-body { padding: 14px 18px; color: #c8ccd0; max-height: 72vh; overflow: auto; }
#supportDialog .sd-intro { margin-bottom: 12px; }
#supportDialog .sd-intro b { color: #fff; }
#supportDialog .sd-types { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
#supportDialog .sd-type { padding: 6px 12px; border: 1px solid #555; border-radius: 6px; cursor: pointer; user-select: none; background: #26262b; color: #cfd3d8; font-weight: 700; }
#supportDialog .sd-type:hover { background: #33343a; color: #fff; }
#supportDialog .sd-type.active { background: #2f4a78; border-color: #4f9dff; color: #fff; box-shadow: 0 0 0 1px rgba(79,157,255,0.3) inset; }
#supportDialog .sd-desc { color: #9aa0a6; margin: 2px 0 12px; font-size: 11px; }
#supportDialog .sd-params { border-top: 1px dashed #3a3a3e; padding-top: 12px; min-height: 18px; }
#supportDialog .sd-params:empty { display: none; }
#supportDialog .sd-dofgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px 16px; }
#supportDialog .sd-dof { display: flex; align-items: center; gap: 6px; }
#supportDialog .sd-dof label { cursor: pointer; color: #cfd3d8; }
#supportDialog .sd-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
#supportDialog .sd-row .k { width: 52px; color: #9bb6e8; font-weight: 700; }
#supportDialog input[type=number] { width: 130px; background: #15161a; color: #eaeaea; border: 1px solid #555; border-radius: 4px; padding: 4px 6px; font: inherit; }
#supportDialog input[type=number]:focus { outline: none; border-color: #4f9dff; }
#supportDialog .sd-unit { color: #7b818a; font-size: 10.5px; }
#supportDialog .sd-hint { color: #7b818a; font-size: 10.5px; margin-bottom: 8px; }
#supportDialog .sd-warn { color: #ffb454; margin-top: 10px; font-size: 11px; min-height: 14px; }
#supportDialog .sd-buttons { padding: 10px 14px 14px; display: flex; gap: 8px; justify-content: flex-end; border-top: 1px solid #333; }
#supportDialog .sd-btn { padding: 6px 16px; border-radius: 4px; cursor: pointer; border: 1px solid #555; background: #2a2a2e; color: #eaeaea; font: inherit; }
#supportDialog .sd-btn:hover { background: #3a3a3e; }
#supportDialog .sd-btn.primary { background: #1976d2; border-color: #2196f3; color: #fff; }
#supportDialog .sd-btn.primary:hover { background: #2196f3; }
#supportDialog .sd-btn.primary:disabled { background: #37474f; border-color: #455a64; color: #90a4ae; cursor: not-allowed; }
`;

// 確保目標 document 有 #supportDialog 樣式(主視窗已有 → 略過;popup → 注入一次)
function _ensureSupportDialogCss(doc: Document): void {
  if (doc === document) return;                       // 主視窗由 style.css 提供
  if (doc.getElementById("supportDialogStyle")) return;
  const style = doc.createElement("style");
  style.id = "supportDialogStyle";
  style.textContent = _SUPPORT_DIALOG_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}

// doc:要顯示視窗的 document(預設主視窗;從搜尋 popup 呼叫時傳入該 popup 的 document,
//   讓視窗疊在搜尋視窗之上而非主視窗)
export function pickSupportModal(jointCount: number, current?: Support | null, doc: Document = document): Promise<Support | null> {
  return new Promise((resolve) => {
    _ensureSupportDialogCss(doc);
    let modal = doc.getElementById("supportDialog") as HTMLDivElement | null;
    if (!modal) {
      modal = doc.createElement("div");
      modal.id = "supportDialog";
      doc.body.appendChild(modal);
      doc.addEventListener("keydown", (e: KeyboardEvent) => {
        const m = doc.getElementById("supportDialog");
        if (m && m.classList.contains("active") && e.key === "Escape") {
          e.preventDefault();
          if (_sdResolve) { _sdResolve(null); _sdResolve = null; }
          m.classList.remove("active");
        }
      });
    }
    const _close = (v: Support | null) => {
      if (_sdResolve) { _sdResolve(v); _sdResolve = null; }
      modal!.classList.remove("active");
    };
    _sdResolve = resolve;

    // 目前選定的類型(預設沿用 current,否則 FIXED)
    let curType: SupportType = (current && current.type) || "FIXED";

    modal.innerHTML =
      `<div class="sd-card">` +
      `  <div class="sd-titlebar">設定支承</div>` +
      `  <div class="sd-body">` +
      `    <div class="sd-intro">將選取的 <b>${jointCount}</b> 顆節點設為支承,並指定類型與參數:</div>` +
      `    <div class="sd-types">` +
      TYPE_META.map(t =>
        `<div class="sd-type${t.type === curType ? " active" : ""}" data-type="${t.type}">${t.label}</div>`
      ).join("") +
      `    </div>` +
      `    <div class="sd-desc" id="sdDesc"></div>` +
      `    <div class="sd-params" id="sdParams"></div>` +
      `    <div class="sd-warn" id="sdWarn"></div>` +
      `  </div>` +
      `  <div class="sd-buttons">` +
      `    <button class="sd-btn" data-act="cancel">取消</button>` +
      `    <button class="sd-btn primary" data-act="apply">套用</button>` +
      `  </div>` +
      `</div>`;

    const descEl   = modal.querySelector("#sdDesc") as HTMLElement;
    const paramsEl = modal.querySelector("#sdParams") as HTMLElement;
    const warnEl   = modal.querySelector("#sdWarn") as HTMLElement;
    const applyBtn = modal.querySelector('.sd-btn[data-act="apply"]') as HTMLButtonElement;

    // 依目前類型重建參數區
    const _renderParams = () => {
      const meta = TYPE_META.find(t => t.type === curType)!;
      descEl.textContent = meta.desc;
      warnEl.textContent = "";
      applyBtn.disabled = false;

      if (curType === "FIXED" || curType === "PINNED") {
        paramsEl.innerHTML = "";
        return;
      }
      if (curType === "FIXED_BUT") {
        const rel = new Set((current && current.type === "FIXED_BUT" && current.released) || []);
        paramsEl.innerHTML =
          `<div class="sd-hint">勾選 = 該自由度放鬆(自由);未勾 = 鎖死</div>` +
          `<div class="sd-dofgrid">` +
          DOF_KEYS.map(d =>
            `<div class="sd-dof"><input type="checkbox" id="dof_${d}" value="${d}"${rel.has(d) ? " checked" : ""}>` +
            `<label for="dof_${d}">${DOF_LABEL[d]}</label></div>`
          ).join("") +
          `</div>`;
        paramsEl.querySelectorAll("input[type=checkbox]").forEach(cb => cb.addEventListener("change", _validate));
        return;
      }
      if (curType === "SPRING") {
        const sp = (current && current.type === "SPRING" && current.springs) || {};
        paramsEl.innerHTML =
          `<div class="sd-hint">只填要當彈簧的方向;空白 = 該向維持固接。平移 kN/m、轉動 kN·m/rad</div>` +
          SPRING_KEYS.map(k => {
            const v = sp[k];
            const unit = k.startsWith("KM") ? "kN·m/rad" : "kN/m";
            return `<div class="sd-row"><span class="k">${SPRING_LABEL[k]}</span>` +
              `<input type="number" step="any" min="0" id="spr_${k}"${v != null ? ` value="${v}"` : ""}>` +
              `<span class="sd-unit">${unit}</span></div>`;
          }).join("");
        paramsEl.querySelectorAll("input[type=number]").forEach(inp => inp.addEventListener("input", _validate));
        return;
      }
      // ENFORCED
      const enf = (current && current.type === "ENFORCED" && current.enforced) || {};
      paramsEl.innerHTML =
        `<div class="sd-hint">指定方向的強制位移量;空白 = 不指定。平移 mm、轉動 rad</div>` +
        DOF_KEYS.map(d => {
          const v = enf[d];
          const unit = d.startsWith("M") ? "rad" : "mm";
          return `<div class="sd-row"><span class="k">${d}</span>` +
            `<input type="number" step="any" id="enf_${d}"${v != null ? ` value="${v}"` : ""}>` +
            `<span class="sd-unit">${unit}</span></div>`;
        }).join("");
      paramsEl.querySelectorAll("input[type=number]").forEach(inp => inp.addEventListener("input", _validate));
    };

    // 即時驗證:回傳 warn 訊息(空字串 = OK),並設定 applyBtn.disabled
    const _validate = () => {
      warnEl.textContent = "";
      applyBtn.disabled = false;
      if (curType === "FIXED_BUT") {
        const checked = DOF_KEYS.filter(d => (modal!.querySelector(`#dof_${d}`) as HTMLInputElement)?.checked);
        if (checked.length === 6) {
          warnEl.textContent = "⚠ 6 個自由度全放鬆 = 無束制(機構),請至少保留 1 個鎖死。";
          applyBtn.disabled = true;
        } else if (checked.length === 0) {
          warnEl.textContent = "提示:沒有放鬆任何自由度,等同 FIXED。";
        }
      } else if (curType === "SPRING") {
        const any = SPRING_KEYS.some(k => {
          const v = (modal!.querySelector(`#spr_${k}`) as HTMLInputElement)?.value;
          return v !== "" && v != null;
        });
        if (!any) warnEl.textContent = "提示:未填任何勁度,等同 FIXED。";
      }
    };

    // 收集成 Support 物件(回傳 null 代表驗證未過,不應發生因為 applyBtn 已 disable)
    const _collect = (): Support | null => {
      if (curType === "FIXED")  return { type: "FIXED" };
      if (curType === "PINNED") return { type: "PINNED" };
      if (curType === "FIXED_BUT") {
        const released = DOF_KEYS.filter(d => (modal!.querySelector(`#dof_${d}`) as HTMLInputElement)?.checked);
        return released.length ? { type: "FIXED_BUT", released } : { type: "FIXED" };  // 沒放鬆 → 退回 FIXED
      }
      if (curType === "SPRING") {
        const springs: Partial<Record<SpringKey, number>> = {};
        for (const k of SPRING_KEYS) {
          const raw = (modal!.querySelector(`#spr_${k}`) as HTMLInputElement)?.value;
          if (raw !== "" && raw != null) { const n = Number(raw); if (Number.isFinite(n)) springs[k] = n; }
        }
        return Object.keys(springs).length ? { type: "SPRING", springs } : { type: "FIXED" };
      }
      // ENFORCED
      const enforced: Partial<Record<DOF, number>> = {};
      for (const d of DOF_KEYS) {
        const raw = (modal!.querySelector(`#enf_${d}`) as HTMLInputElement)?.value;
        if (raw !== "" && raw != null) { const n = Number(raw); if (Number.isFinite(n)) enforced[d] = n; }
      }
      return { type: "ENFORCED", ...(Object.keys(enforced).length ? { enforced } : {}) };
    };

    // 類型按鈕
    modal.querySelectorAll(".sd-type").forEach(btn => {
      btn.addEventListener("click", () => {
        curType = (btn as HTMLElement).dataset.type as SupportType;
        modal!.querySelectorAll(".sd-type").forEach(b => b.classList.toggle("active", b === btn));
        _renderParams();
      });
    });
    // backdrop / 按鈕
    modal.onclick = (e: MouseEvent) => { if ((e.target as HTMLElement).id === "supportDialog") _close(null); };
    modal.querySelector('.sd-btn[data-act="cancel"]')!.addEventListener("click", () => _close(null));
    applyBtn.addEventListener("click", () => { if (!applyBtn.disabled) _close(_collect()); });

    _renderParams();
    modal.classList.add("active");
    setTimeout(() => applyBtn.focus(), 30);
  });
}
