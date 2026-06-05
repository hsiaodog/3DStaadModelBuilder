// @ts-nocheck
// Structure pipeline — YAML 匯出(含教學註解)/ 匯入(js-yaml 原生支援 # 註解)。
import { dump, load } from "js-yaml";
import { getStepDef, PIPELINE_STEPS } from "./registry";
import { normalizePipeline, PIPELINE_SCHEMA } from "./pipelineSettings";

// 把值用 js-yaml flow 樣式輸出成單行;字串一律單引號(forceQuotes)→ 一致、避免 'Y' 與 X 混雜
function _inline(v: any): string {
  return dump(v, { flowLevel: 0, lineWidth: -1, quotingType: "'", forceQuotes: true }).trim();
}

export function pipelineToYaml(p: any): string {
  const L: string[] = [];
  L.push(`# ================================================================`);
  L.push(`# STAAD 結構編號 Pipeline — ${p.label || p.structureType}`);
  L.push(`# 編輯說明:`);
  L.push(`#   • steps 由上到下依序執行;設 enabled: false 可暫時跳過某步驟。`);
  L.push(`#   • id 只能用「可用步驟」清單裡的(見下),不能自創;params 省略則用預設值。`);
  L.push(`#   • 改完存成 .yaml,於「結構 Pipeline 管理」按匯入即可。`);
  L.push(`#`);
  L.push(`# 可用步驟 id:`);
  for (const s of PIPELINE_STEPS) L.push(`#   - ${s.id} … ${s.label}:${s.description}`);
  L.push(`# ================================================================`);
  L.push(`schema: ${PIPELINE_SCHEMA}`);
  L.push(`structureType: ${_inline(p.structureType)}   # 唯一代號(英數);切換結構類型的 key`);
  L.push(`label: ${_inline(p.label || p.structureType)}             # 顯示名稱`);
  if (p.description) L.push(`description: ${_inline(p.description)}`);
  L.push(`steps:`);
  for (const s of (p.steps || [])) {
    const def = getStepDef(s.id);
    if (def) L.push(`  # ▸ ${def.label}:${def.description}`);
    L.push(`  - id: ${s.id}`);
    L.push(`    enabled: ${s.enabled !== false}`);
    const params = s.params || {};
    const keys = Object.keys(params);
    if (!keys.length) { L.push(`    params: {}`); continue; }
    L.push(`    params:`);
    for (const k of keys) {
      const doc = def && def.paramDocs && def.paramDocs[k];
      if (doc) L.push(`      # ${doc}`);
      L.push(`      ${k}: ${_inline(params[k])}`);
    }
  }
  L.push(``);
  return L.join("\n");
}

export function pipelineFromYaml(text: string): any {
  let obj: any;
  try { obj = load(text); }
  catch (e: any) { throw new Error("YAML 解析失敗:" + (e && e.message ? e.message : String(e))); }
  const n = normalizePipeline(obj);
  if (!n) throw new Error("檔案缺少必要欄位(需 structureType 與 steps)。");
  if (!n.steps.length) throw new Error("steps 為空 — 至少要有一個有效步驟。");
  return n;
}
