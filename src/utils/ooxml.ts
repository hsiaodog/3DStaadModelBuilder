// OOXML / .xlsx 共用 helpers — 純函式,沒 state 依賴

/**
 * 從 1-based 列 + 0-based 欄 index 算出 Excel 儲存格座標
 * @example xlsxCellRef(0, 0) === "A1";  xlsxCellRef(1, 26) === "AA2"
 */
export function xlsxCellRef(rowIdx0: number, colIdx0: number): string {
  let s = "", n = colIdx0;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s + (rowIdx0 + 1);
}

/** XML special-character escape(`<`, `>`, `&`, `"`, `'` → entities) */
export function xmlEsc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[<>&"']/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" } as Record<string, string>)[c]!
  );
}

/**
 * 組單一 cell XML。
 *   val=null/空字串 + 沒 styleId → 回空字串(略過)
 *   val=null/空字串 + 有 styleId → 純樣式空 cell(用於黃色分隔欄)
 *   val 是 Number → numeric cell
 *   其他 → inlineStr cell(自動 xmlEsc)
 */
export function xlsxCell(rowIdx0: number, colIdx0: number, val: unknown, styleId?: number): string {
  const ref = xlsxCellRef(rowIdx0, colIdx0);
  if (val == null || val === "") {
    if (styleId != null) return `<c r="${ref}" s="${styleId}"/>`;
    return "";
  }
  const sAttr = styleId != null ? ` s="${styleId}"` : "";
  if (typeof val === "number" && Number.isFinite(val)) {
    return `<c r="${ref}"${sAttr}><v>${val}</v></c>`;
  }
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
}
