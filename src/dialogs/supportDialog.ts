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
import { ensureMechDialogCss } from "./mechDialogStyle";

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

// doc:要顯示視窗的 document(預設主視窗;從搜尋 popup 呼叫時傳入該 popup 的 document,
//   讓視窗疊在搜尋視窗之上而非主視窗)。樣式走共用的 .mech-dialog(見 mechDialogStyle.ts)。
export function pickSupportModal(jointCount: number, current?: Support | null, doc: Document = document): Promise<Support | null> {
  return new Promise((resolve) => {
    ensureMechDialogCss(doc);
    let modal = doc.getElementById("supportDialog") as HTMLDivElement | null;
    if (!modal) {
      modal = doc.createElement("div");
      modal.id = "supportDialog";
      modal.className = "mech-dialog";
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
