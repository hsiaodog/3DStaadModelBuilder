// 通用「另存新檔」helper — 若瀏覽器支援 File System Access API(Chrome / Edge)就用
// showSaveFilePicker 讓使用者選位置 / 檔名;不支援就 fallback 到 <a download>(下載資料夾)。
//
// 用法:
//   await saveFileWithPicker({
//     suggestedName: "model.std",
//     types: [{ description: "STAAD .std", accept: { "text/plain": [".std"] } }],
//     data: stringOrBlobOrUint8Array,
//   });
//
// 回傳:{ ok: true } 成功;{ ok: false, cancelled: true } 使用者取消;{ ok: false, error } 其他失敗。
// @ts-nocheck

export interface SaveFileOptions {
  suggestedName: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  data: string | Blob | Uint8Array | ArrayBuffer;
  mime?: string;          // 給 fallback Blob 用,FSA 路徑會用 types[0]
}

export interface SaveFileResult {
  ok: boolean;
  cancelled?: boolean;
  error?: any;
  // 若走 FSA 路徑,handle 會傳回(呼叫端可選擇存起來給下次「覆寫」用)
  handle?: any;
}

function _toBlob(data: any, mime: string): Blob {
  if (data instanceof Blob) return data;
  if (data instanceof Uint8Array) return new Blob([data], { type: mime });
  if (data instanceof ArrayBuffer) return new Blob([data], { type: mime });
  return new Blob([String(data)], { type: mime });
}

export async function saveFileWithPicker(opts: SaveFileOptions): Promise<SaveFileResult> {
  const mime = opts.mime || (opts.types && opts.types[0] && Object.keys(opts.types[0].accept)[0]) || "application/octet-stream";
  // FSA 路徑
  if ((window as any).showSaveFilePicker) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: opts.suggestedName,
        types: opts.types || [{ accept: { [mime]: [] } }],
      });
      const writable = await handle.createWritable();
      const blob = _toBlob(opts.data, mime);
      await writable.write(blob);
      await writable.close();
      return { ok: true, handle };
    } catch (e: any) {
      if (e && e.name === "AbortError") return { ok: false, cancelled: true };
      console.warn("[saveFile] FSA failed, fallback to <a download>:", e);
      // 走下方 fallback
    }
  }
  // Fallback:<a download>
  try {
    const blob = _toBlob(opts.data, mime);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = opts.suggestedName;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}
