// 桿件釋放設定視窗 — 選類型(RELEASE / TRUSS / TENSION / COMPRESSION / CABLE)+ 填參數,
//   回傳完整 MemberRelease 物件;null = 取消。架構同 supportDialog,樣式共用 .mech-dialog。
//
//   RELEASE → 兩組自由度勾選(START=起點/j1 端、END=末點/j2 端)
//   其餘四種(桿件行為類型)無參數。
// @ts-nocheck

import type { MemberRelease, MemberReleaseType } from "../core/memberRelease";
import { RELEASE_TYPE_META } from "../core/memberRelease";
import type { DOF } from "../core/support";
import { DOF_KEYS } from "../core/support";
import { ensureMechDialogCss } from "./mechDialogStyle";

const DOF_LABEL: Record<DOF, string> = {
  FX: "FX 軸向力", FY: "FY 剪力Y", FZ: "FZ 剪力Z",
  MX: "MX 扭矩", MY: "MY 彎矩Y", MZ: "MZ 彎矩Z",
};

let _rdResolve: ((v: MemberRelease | null) => void) | null = null;

export function pickReleaseModal(memberCount: number, current?: MemberRelease | null, doc: Document = document): Promise<MemberRelease | null> {
  return new Promise((resolve) => {
    ensureMechDialogCss(doc);
    let modal = doc.getElementById("releaseDialog") as HTMLDivElement | null;
    if (!modal) {
      modal = doc.createElement("div");
      modal.id = "releaseDialog";
      modal.className = "mech-dialog";
      doc.body.appendChild(modal);
      doc.addEventListener("keydown", (e: KeyboardEvent) => {
        const m = doc.getElementById("releaseDialog");
        if (m && m.classList.contains("active") && e.key === "Escape") {
          e.preventDefault();
          if (_rdResolve) { _rdResolve(null); _rdResolve = null; }
          m.classList.remove("active");
        }
      });
    }
    const _close = (v: MemberRelease | null) => {
      if (_rdResolve) { _rdResolve(v); _rdResolve = null; }
      modal!.classList.remove("active");
    };
    _rdResolve = resolve;

    let curType: MemberReleaseType = (current && current.type) || "RELEASE";

    modal.innerHTML =
      `<div class="sd-card">` +
      `  <div class="sd-titlebar">設定桿件釋放</div>` +
      `  <div class="sd-body">` +
      `    <div class="sd-intro">將選取的 <b>${memberCount}</b> 根桿件設為以下釋放 / 類型:</div>` +
      `    <div class="sd-types">` +
      RELEASE_TYPE_META.map(t =>
        `<div class="sd-type${t.type === curType ? " active" : ""}" data-type="${t.type}">${t.label}</div>`
      ).join("") +
      `    </div>` +
      `    <div class="sd-desc" id="rdDesc"></div>` +
      `    <div class="sd-params" id="rdParams"></div>` +
      `    <div class="sd-warn" id="rdWarn"></div>` +
      `  </div>` +
      `  <div class="sd-buttons">` +
      `    <button class="sd-btn" data-act="cancel">取消</button>` +
      `    <button class="sd-btn primary" data-act="apply">套用</button>` +
      `  </div>` +
      `</div>`;

    const descEl   = modal.querySelector("#rdDesc") as HTMLElement;
    const paramsEl = modal.querySelector("#rdParams") as HTMLElement;
    const warnEl   = modal.querySelector("#rdWarn") as HTMLElement;
    const applyBtn = modal.querySelector('.sd-btn[data-act="apply"]') as HTMLButtonElement;

    // 一組自由度勾選 grid(end="start" | "end")
    const _dofGrid = (endKey: "start" | "end", preset: DOF[]) => {
      const set = new Set(preset || []);
      return `<div class="sd-dofgrid">` +
        DOF_KEYS.map(d =>
          `<div class="sd-dof"><input type="checkbox" id="${endKey}_${d}" value="${d}"${set.has(d) ? " checked" : ""}>` +
          `<label for="${endKey}_${d}">${DOF_LABEL[d]}</label></div>`
        ).join("") +
        `</div>`;
    };

    const _renderParams = () => {
      const meta = RELEASE_TYPE_META.find(t => t.type === curType)!;
      descEl.textContent = meta.desc;
      warnEl.textContent = "";
      applyBtn.disabled = false;
      if (curType !== "RELEASE") { paramsEl.innerHTML = ""; return; }
      const cs = (current && current.type === "RELEASE" && current.start) || [];
      const ce = (current && current.type === "RELEASE" && current.end) || [];
      paramsEl.innerHTML =
        `<div class="sd-hint">勾選 = 該端釋放此自由度(不傳遞)。FX 軸向 · FY/FZ 剪力 · MX 扭矩 · MY/MZ 彎矩。常見「鉸接」= 放 MX MY MZ。</div>` +
        `<div class="sd-grouptitle">START(起點 / j1 端)</div>` + _dofGrid("start", cs) +
        `<div class="sd-grouptitle" style="margin-top:10px">END(末點 / j2 端)</div>` + _dofGrid("end", ce);
      paramsEl.querySelectorAll("input[type=checkbox]").forEach(cb => cb.addEventListener("change", _validate));
    };

    const _readEnd = (endKey: "start" | "end"): DOF[] =>
      DOF_KEYS.filter(d => (modal!.querySelector(`#${endKey}_${d}`) as HTMLInputElement)?.checked);

    const _validate = () => {
      warnEl.textContent = "";
      applyBtn.disabled = false;
      if (curType !== "RELEASE") return;
      const s = _readEnd("start"), e = _readEnd("end");
      if (s.length === 6 && e.length === 6) {
        warnEl.textContent = "⚠ 兩端 6 個自由度全部釋放 = 桿件完全脫離(機構),請至少保留一些約束。";
        applyBtn.disabled = true;
      } else if (!s.length && !e.length) {
        warnEl.textContent = "提示:兩端都沒釋放任何自由度,套用等同「清除釋放」。";
      }
    };

    const _collect = (): MemberRelease | null => {
      if (curType !== "RELEASE") return { type: curType };
      const start = _readEnd("start"), end = _readEnd("end");
      return { type: "RELEASE", ...(start.length ? { start } : {}), ...(end.length ? { end } : {}) };
    };

    modal.querySelectorAll(".sd-type").forEach(btn => {
      btn.addEventListener("click", () => {
        curType = (btn as HTMLElement).dataset.type as MemberReleaseType;
        modal!.querySelectorAll(".sd-type").forEach(b => b.classList.toggle("active", b === btn));
        _renderParams();
      });
    });
    modal.onclick = (e: MouseEvent) => { if ((e.target as HTMLElement).id === "releaseDialog") _close(null); };
    modal.querySelector('.sd-btn[data-act="cancel"]')!.addEventListener("click", () => _close(null));
    applyBtn.addEventListener("click", () => { if (!applyBtn.disabled) _close(_collect()); });

    _renderParams();
    modal.classList.add("active");
    setTimeout(() => applyBtn.focus(), 30);
  });
}
