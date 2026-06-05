// @ts-nocheck
// Structure pipeline 設定 — 比照 export/xlsxSettings.ts 的模式。
//   來源優先序:builtin(內建 warehouse) < localStorage(跨專案 fallback) < 專案 state(優先)。
//   啟用中的結構類型 = state.activeStructureType > localStorage.active > "warehouse"。
import { state } from "../../app/integration";
import { getStepDef, allStepIds } from "./registry";

export const PIPELINE_SCHEMA = "staad-structure-pipeline/1";
const LS_KEY = "staad.structurePipelines.v1";

const _clone = (o: any) => JSON.parse(JSON.stringify(o));

// 內建「自動倉儲」pipeline — 步驟順序 + 參數 = 改版前的一鍵處理行為(numbering 參數取自 registry 預設)
function _builtinWarehouse() {
  const nj = _clone(getStepDef("numberJoints")!.defaultParams);
  const nm = _clone(getStepDef("numberMembers")!.defaultParams);
  return {
    schema: PIPELINE_SCHEMA,
    structureType: "warehouse",
    label: "自動倉儲",
    description: "自動倉儲(料架 / 走道型):柱(Y)先、樑(X/Z)次、斜撐(D)最後。為內建預設流程。",
    steps: [
      { id: "consolidatePages", enabled: true, params: {} },
      { id: "clearBindings",    enabled: true, params: { clearAll: true } },
      { id: "fitByPrecision",   enabled: true, params: {} },
      { id: "numberJoints",     enabled: true, params: nj },
      { id: "numberMembers",    enabled: true, params: nm },
      { id: "rebuildInfer",     enabled: true, params: {} },
      { id: "refreshRender",    enabled: true, params: {} },
      { id: "checkIssues",      enabled: true, params: {} },
    ],
  };
}
export function builtinPipelines() { return [_builtinWarehouse()]; }

// 正規化 / 驗證:保證 structureType / steps 合法;未知 step id 跳過;step 缺漏欄位補齊。
export function normalizePipeline(p: any): any | null {
  if (!p || typeof p !== "object") return null;
  const key = String(p.structureType || p.key || "").trim();
  if (!key) return null;
  const known = new Set(allStepIds());
  const steps = Array.isArray(p.steps) ? p.steps : [];
  const outSteps: any[] = [];
  const dropped: string[] = [];
  for (const s of steps) {
    if (!s || !known.has(s.id)) { if (s && s.id) dropped.push(String(s.id)); continue; }
    outSteps.push({
      id: s.id,
      enabled: s.enabled !== false,
      params: (s.params && typeof s.params === "object") ? s.params : {},
    });
  }
  if (dropped.length) console.warn(`[pipeline] 略過未知步驟:${dropped.join(", ")}（可用:${allStepIds().join(", ")}）`);
  return {
    schema: PIPELINE_SCHEMA,
    structureType: key,
    label: String(p.label || key),
    description: String(p.description || ""),
    steps: outSteps,
  };
}

function _loadLocal(): { pipelines: any[]; active: string } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { pipelines: [], active: "" };
    const o = JSON.parse(raw);
    return { pipelines: Array.isArray(o.pipelines) ? o.pipelines : [], active: typeof o.active === "string" ? o.active : "" };
  } catch (_) { return { pipelines: [], active: "" }; }
}
function _saveLocal(o: { pipelines: any[]; active: string }) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (_) {}
}

// 合併出所有可用 pipeline(builtin < localStorage < 專案 state),依 structureType 去重(後者覆蓋)。
export function getAllPipelines(): any[] {
  const map = new Map<string, any>();
  for (const p of builtinPipelines()) map.set(p.structureType, p);
  for (const p of _loadLocal().pipelines) { const n = normalizePipeline(p); if (n) map.set(n.structureType, n); }
  for (const p of ((state as any).structurePipelines || [])) { const n = normalizePipeline(p); if (n) map.set(n.structureType, n); }
  return [...map.values()];
}

export function getActiveStructureType(): string {
  return (state as any).activeStructureType || _loadLocal().active || "warehouse";
}
export function getActivePipeline(): any {
  const key = getActiveStructureType();
  const all = getAllPipelines();
  return all.find(p => p.structureType === key)
      || all.find(p => p.structureType === "warehouse")
      || all[0];
}
export function setActiveStructureType(key: string) {
  (state as any).activeStructureType = key;
  const local = _loadLocal(); local.active = key; _saveLocal(local);
}

// 新增 / 取代一個自訂(或覆寫內建)pipeline;寫入專案 state + localStorage。
export function upsertPipeline(p: any) {
  const n = normalizePipeline(p);
  if (!n) return false;
  if (!Array.isArray((state as any).structurePipelines)) (state as any).structurePipelines = [];
  const arr = (state as any).structurePipelines;
  const i = arr.findIndex((x: any) => x && x.structureType === n.structureType);
  if (i >= 0) arr[i] = n; else arr.push(n);
  const local = _loadLocal();
  const li = local.pipelines.findIndex((x: any) => x && x.structureType === n.structureType);
  if (li >= 0) local.pipelines[li] = n; else local.pipelines.push(n);
  _saveLocal(local);
  return true;
}

// 刪除自訂 pipeline(內建 warehouse 不可刪 → 只會還原成內建)。
export function removePipeline(key: string) {
  if (Array.isArray((state as any).structurePipelines))
    (state as any).structurePipelines = (state as any).structurePipelines.filter((x: any) => x && x.structureType !== key);
  const local = _loadLocal();
  local.pipelines = local.pipelines.filter((x: any) => x && x.structureType !== key);
  if (local.active === key) local.active = "warehouse";
  _saveLocal(local);
  if ((state as any).activeStructureType === key) (state as any).activeStructureType = "warehouse";
}

// === 專案存檔整合(比照 loadXlsxSettingsFromProject / serializeXlsxSettingsForProject)===
export function loadPipelinesFromProject(raw: any) {
  if (!raw || typeof raw !== "object") {
    (state as any).structurePipelines = undefined;
    (state as any).activeStructureType = undefined;
    return;
  }
  const list = Array.isArray(raw.pipelines) ? raw.pipelines.map(normalizePipeline).filter(Boolean) : [];
  (state as any).structurePipelines = list.length ? list : undefined;
  (state as any).activeStructureType = (typeof raw.active === "string" && raw.active) ? raw.active : undefined;
}
export function serializePipelinesForProject(): any {
  const list = (state as any).structurePipelines;
  const active = (state as any).activeStructureType;
  if ((!Array.isArray(list) || !list.length) && !active) return undefined;
  return { pipelines: Array.isArray(list) ? list : [], active: active || "warehouse" };
}
