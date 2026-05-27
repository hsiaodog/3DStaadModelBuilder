// xlsx 輸出設定 modal — 字型 / 字級 / 7 個區塊色 / 分隔欄寬 / 檔名樣板 / sheet 名
//   按確定 → 寫入 project state(隨 stproj.json 存)+ localStorage(全域 fallback)
//   按重設 → 拉預設值回 UI,但不關閉(讓使用者再決定要不要存)
//   按取消 / Esc → 不改動既有設定
// @ts-nocheck

import {
  XLSX_DEFAULTS, getXlsxSettings, setXlsxSettings,
  type XlsxSettings, type XlsxColorKey,
} from "../export/xlsxSettings";

let _modal: HTMLDivElement | null = null;
let _escHandler: ((e: KeyboardEvent) => void) | null = null;

const COLOR_FIELDS: { key: XlsxColorKey; label: string; hint: string }[] = [
  { key: "blockHeader",  label: "區塊大標",     hint: "JOINT COORDINATES / MEMBER INCIDENCES 等深色標題列" },
  { key: "columnHeader", label: "欄位標題",     hint: "ID / X / Y / Z 等粗體小標" },
  { key: "subHeader",    label: "Sub-header",   hint: "* Y-axis / * BRACE YZ / * 頁名 等暖色標籤" },
  { key: "jointId",      label: "節點 ID",      hint: "節點 J1, J2 … 編號儲存格" },
  { key: "memberId",     label: "桿件 / 材料 ID", hint: "桿件 M1, M2 … 編號儲存格" },
  { key: "separator",    label: "分隔欄",       hint: "JOINT / MEMBER / MATERIAL 之間的黃色細欄" },
  { key: "columnLine",   label: "柱線 sub-header", hint: "* XX nn / * ZZ nn — 樑柱線分組標籤" },
];

function _close() {
  if (_modal) _modal.classList.remove("active");
  if (_escHandler) {
    document.removeEventListener("keydown", _escHandler, true);
    _escHandler = null;
  }
}

function _applyToForm(s: XlsxSettings) {
  if (!_modal) return;
  (_modal.querySelector('[data-field="fontName"]') as HTMLInputElement).value = s.fontName;
  (_modal.querySelector('[data-field="fontSize"]') as HTMLInputElement).value = String(s.fontSize);
  (_modal.querySelector('[data-field="separatorWidth"]') as HTMLInputElement).value = String(s.separatorWidth);
  (_modal.querySelector('[data-field="filenamePattern"]') as HTMLInputElement).value = s.filenamePattern;
  (_modal.querySelector('[data-field="sheetName"]') as HTMLInputElement).value = s.sheetName;
  for (const cf of COLOR_FIELDS) {
    const el = _modal.querySelector(`[data-color="${cf.key}"]`) as HTMLInputElement;
    if (el) el.value = s.colors[cf.key];
  }
}

function _readForm(): XlsxSettings {
  const get = (k: string) => (_modal!.querySelector(`[data-field="${k}"]`) as HTMLInputElement).value;
  const colors: any = {};
  for (const cf of COLOR_FIELDS) {
    colors[cf.key] = (_modal!.querySelector(`[data-color="${cf.key}"]`) as HTMLInputElement).value.toUpperCase();
  }
  return {
    fontName: get("fontName").trim() || XLSX_DEFAULTS.fontName,
    fontSize: Number(get("fontSize")) || XLSX_DEFAULTS.fontSize,
    colors,
    separatorWidth: Number(get("separatorWidth")) || XLSX_DEFAULTS.separatorWidth,
    filenamePattern: get("filenamePattern").trim() || XLSX_DEFAULTS.filenamePattern,
    sheetName: get("sheetName").trim() || XLSX_DEFAULTS.sheetName,
  };
}

function _ensureModal() {
  if (_modal) return;
  _modal = document.createElement("div");
  _modal.id = "xlsxSettingsModal";
  document.body.appendChild(_modal);

  const colorRows = COLOR_FIELDS.map(cf => `
    <div class="xs-row xs-color-row">
      <label class="xs-label" title="${cf.hint}">${cf.label}</label>
      <input type="color" class="xs-color" data-color="${cf.key}"/>
      <span class="xs-hint">${cf.hint}</span>
    </div>
  `).join("");

  _modal.innerHTML = `
    <div class="xs-card">
      <div class="xs-titlebar">xlsx 輸出設定</div>
      <div class="xs-body">
        <div class="xs-section">
          <div class="xs-section-title">字型</div>
          <div class="xs-row">
            <label class="xs-label">字型名稱</label>
            <input type="text" class="xs-input" data-field="fontName" placeholder="Calibri"/>
            <span class="xs-hint">如 Calibri、Microsoft JhengHei、Arial</span>
          </div>
          <div class="xs-row">
            <label class="xs-label">字級 (pt)</label>
            <input type="number" class="xs-input xs-small" data-field="fontSize" min="6" max="72" step="1"/>
            <span class="xs-hint">建議 10–14;範圍 6–72</span>
          </div>
        </div>
        <div class="xs-section">
          <div class="xs-section-title">區塊填色</div>
          ${colorRows}
        </div>
        <div class="xs-section">
          <div class="xs-section-title">版面 / 檔案</div>
          <div class="xs-row">
            <label class="xs-label">分隔欄寬</label>
            <input type="number" class="xs-input xs-small" data-field="separatorWidth" min="0.5" max="20" step="0.5"/>
            <span class="xs-hint">JOINT / MEMBER / MATERIAL 之間黃色細欄寬(Excel 字元寬,預設 2)</span>
          </div>
          <div class="xs-row">
            <label class="xs-label">檔名樣板</label>
            <input type="text" class="xs-input" data-field="filenamePattern" placeholder="{projectName}"/>
            <span class="xs-hint"><code>{projectName}</code> 會代換成專案名;副檔名 <code>.xlsx</code> 自動加</span>
          </div>
          <div class="xs-row">
            <label class="xs-label">Sheet 名稱</label>
            <input type="text" class="xs-input" data-field="sheetName" placeholder="Model" maxlength="31"/>
            <span class="xs-hint">Excel 工作表名;上限 31 字</span>
          </div>
        </div>
      </div>
      <div class="xs-buttons">
        <button class="xs-btn" data-act="reset">重設預設</button>
        <button class="xs-btn" data-act="cancel">取消</button>
        <button class="xs-btn primary" data-act="ok">確定</button>
      </div>
    </div>
  `;
  // backdrop click → 取消
  _modal.addEventListener("click", (e: MouseEvent) => {
    if ((e.target as HTMLElement).id === "xlsxSettingsModal") _close();
  });
  // 三顆按鈕
  _modal.querySelectorAll<HTMLButtonElement>(".xs-btn").forEach(btn => {
    btn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === "reset") {
        // 重設 → 拉內建預設值回 UI(不關閉,讓使用者再決定)
        _applyToForm(XLSX_DEFAULTS);
      } else if (act === "ok") {
        const s = _readForm();
        setXlsxSettings(s);
        _close();
        if ((window as any).$ && (window as any).$("hud")) {
          (window as any).$("hud").textContent = "xlsx 輸出設定已更新(下次匯出生效)";
        }
      } else {
        _close();
      }
    };
  });
}

export function openXlsxSettingsDialog() {
  _ensureModal();
  _applyToForm(getXlsxSettings());
  _modal!.classList.add("active");
  // Esc 取消
  _escHandler = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); _close(); } };
  document.addEventListener("keydown", _escHandler, true);
  // 焦點放第一個欄位
  setTimeout(() => {
    const first = _modal!.querySelector<HTMLInputElement>('[data-field="fontName"]');
    first && first.focus();
  }, 30);
}
