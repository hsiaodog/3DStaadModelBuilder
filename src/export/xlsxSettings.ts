// xlsx 輸出設定:字型 / 字級 / 區塊填色 / 分隔欄寬 / 預設檔名 / sheet 名
//
//   來源優先序:project (state.xlsxExportSettings) > localStorage > 內建預設
//   寫入時:同時更新 project state + localStorage(下次開新專案有 fallback)
//
//   colors 用 "#RRGGBB"(瀏覽器 input[type=color] 原生格式),寫進 xlsx XML 時轉成 "FFRRGGBB"
// @ts-nocheck

import { state } from "../legacy";

export type XlsxColorKey =
  | "blockHeader" | "columnHeader" | "subHeader"
  | "jointId" | "memberId" | "separator" | "columnLine";

export type XlsxSettings = {
  fontName: string;
  fontSize: number;
  colors: Record<XlsxColorKey, string>;   // "#RRGGBB"
  separatorWidth: number;
  filenamePattern: string;                // "{projectName}" 會被代換
  sheetName: string;
};

const LS_KEY = "xlsx.exportSettings.v1";

export const XLSX_DEFAULTS: XlsxSettings = {
  fontName: "Calibri",
  fontSize: 12,
  colors: {
    blockHeader: "#1F4E78",   // 深藍(區塊大標)
    columnHeader: "#EDEDED",  // 淺灰(欄位標題)
    subHeader: "#FFE4B5",     // 暖橘(* Y-axis / * BRACE YZ / *<pageName> 等)
    jointId: "#D0E4F5",       // 淡藍(節點 ID)
    memberId: "#D4EFCC",      // 淡綠(桿件 / 材料 ID)
    separator: "#FFFF00",     // 黃(大區分隔欄)
    columnLine: "#CCE5FF",    // 淡藍(* XX nn / * ZZ nn 柱線 sub-header)
  },
  separatorWidth: 2,
  filenamePattern: "{projectName}",
  sheetName: "Model",
};

// 從 "#RRGGBB" 轉 OOXML 用的 "FFRRGGBB"(alpha 全不透明)
export function cssHexToArgb(css: string): string {
  if (!css) return "FF000000";
  const s = css.trim().replace(/^#/, "").toUpperCase();
  if (s.length === 6) return "FF" + s;
  if (s.length === 8) return s;   // 已是 ARGB
  return "FF000000";
}

// 反向:OOXML "FFRRGGBB" 轉 "#RRGGBB" 給 colorpicker
export function argbToCssHex(argb: string): string {
  if (!argb) return "#000000";
  const s = argb.trim().toUpperCase();
  if (s.length === 8) return "#" + s.slice(2);
  if (s.length === 6) return "#" + s;
  return "#000000";
}

// 深拷貝預設
function _cloneDefaults(): XlsxSettings {
  return {
    fontName: XLSX_DEFAULTS.fontName,
    fontSize: XLSX_DEFAULTS.fontSize,
    colors: { ...XLSX_DEFAULTS.colors },
    separatorWidth: XLSX_DEFAULTS.separatorWidth,
    filenamePattern: XLSX_DEFAULTS.filenamePattern,
    sheetName: XLSX_DEFAULTS.sheetName,
  };
}

// merge:dst 已有的欄位用 src 的覆蓋,沒 src 的留 dst(空值 / undefined 略過)
function _merge(dst: XlsxSettings, src: any): XlsxSettings {
  if (!src || typeof src !== "object") return dst;
  if (typeof src.fontName === "string" && src.fontName.trim()) dst.fontName = src.fontName.trim();
  const sz = Number(src.fontSize);
  if (Number.isFinite(sz) && sz >= 6 && sz <= 72) dst.fontSize = sz;
  if (src.colors && typeof src.colors === "object") {
    for (const k of Object.keys(XLSX_DEFAULTS.colors) as XlsxColorKey[]) {
      const v = src.colors[k];
      if (typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v.trim())) {
        dst.colors[k] = v.trim().toUpperCase();
      }
    }
  }
  const sw = Number(src.separatorWidth);
  if (Number.isFinite(sw) && sw >= 0.5 && sw <= 20) dst.separatorWidth = sw;
  if (typeof src.filenamePattern === "string" && src.filenamePattern.trim()) {
    dst.filenamePattern = src.filenamePattern.trim();
  }
  if (typeof src.sheetName === "string" && src.sheetName.trim()) {
    dst.sheetName = src.sheetName.trim().slice(0, 31);   // Excel sheet 名上限 31 字
  }
  return dst;
}

function _loadFromLocalStorage(): any {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function _saveToLocalStorage(s: XlsxSettings) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {}
}

// 取得目前有效的設定(merge 後;每次呼叫都重 merge → 設定 / 切專案後立即生效)
export function getXlsxSettings(): XlsxSettings {
  const out = _cloneDefaults();
  // localStorage(全域 fallback)
  _merge(out, _loadFromLocalStorage());
  // project(優先)
  _merge(out, (state as any).xlsxExportSettings);
  return out;
}

// 寫設定:同時更新 project state + localStorage
export function setXlsxSettings(s: XlsxSettings) {
  (state as any).xlsxExportSettings = s;
  _saveToLocalStorage(s);
}

// 從專案 JSON 載入(projectLoad.ts 用)
export function loadXlsxSettingsFromProject(raw: any) {
  if (!raw || typeof raw !== "object") {
    (state as any).xlsxExportSettings = undefined;
    return;
  }
  const merged = _cloneDefaults();
  _merge(merged, raw);
  (state as any).xlsxExportSettings = merged;
}

// 把目前 project 設定序列化成 JSON 給 projectFile.ts 存
export function serializeXlsxSettingsForProject(): any {
  return (state as any).xlsxExportSettings || undefined;
}
