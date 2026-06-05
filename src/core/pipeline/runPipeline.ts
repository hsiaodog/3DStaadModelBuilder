// @ts-nocheck
// Structure pipeline — 泛用執行器。取代主視窗 / 3D 預覽兩處寫死的步驟序列。
//   依序跑 pipeline 內 enabled 的 step;busy 訊息 + 取消(Esc)由 host 轉接器提供。
//   各 step 內部自行 pushUndo(沿用既有函式行為)→ 失敗 / 取消可逐步 Ctrl+Z。
//
//   host 轉接器介面:
//     setMessage(msg)            — 更新 busy 訊息(兩窗)
//     yieldAndCheckCancel()      — 讓出一個 paint frame;若使用者取消則 throw Error("__CANCELLED__")
//     rebuildInfer()             — 重算關聯(主視窗:invalidate+infer+座標區/側欄;3D:collectData/rebuild)
//     refreshRender()            — 重整列表 + 重畫(3D:requestRender)
//     checkIssues()              — 問題報告(撞號 / 可延伸 / 單頁節點)
import { getStepDef } from "./registry";

export async function runPipeline(pipeline: any, host: any): Promise<{ total: number; done: number }> {
  const all = (pipeline && Array.isArray(pipeline.steps)) ? pipeline.steps : [];
  const steps = all.filter((s: any) => s && s.enabled !== false && getStepDef(s.id));
  const total = steps.length;
  let done = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const def = getStepDef(s.id)!;
    if (host && host.setMessage) host.setMessage(`${pipeline.label || "Pipeline"} ${i + 1}/${total}:${def.label}…`);
    if (host && host.yieldAndCheckCancel) await host.yieldAndCheckCancel();   // throw "__CANCELLED__" 由 caller 接
    const params = { ...(def.defaultParams || {}), ...(s.params || {}) };
    await def.run({ host, pipeline }, params);
    done++;
  }
  return { total, done };
}
