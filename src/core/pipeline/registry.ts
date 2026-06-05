// @ts-nocheck
// Structure pipeline — 內建步驟登錄表(step registry)。
//   使用者匯入的 pipeline 只能「引用」這些 step id + 調 params,不能塞任意程式碼 → 安全。
//   每個 step:{ id, label, description, defaultParams, paramDocs(教學註解), run(ctx, params) }。
//   ctx.host = 宿主轉接器(主視窗 / 3D 預覽各自實作 rebuildInfer / refreshRender / checkIssues)。
//
//   核心步驟(整理 / 綁定 / 編號)直接呼叫既有 integration 函式(於 run() 內延遲使用 → cyclic import 安全)。
import {
  state, pushUndo,
  consolidateAllPagesWithConfirm, cleanupBadGlobalJoints, _runFitMergeByPrecision,
  relayoutNumberingAll, relayoutMembersNumberingAll,
} from "../../app/integration";
import { invalidateRankCache } from "../rankCache";
import { inferAllGlobalJoints } from "../globalJoints";

export interface PipelineStepDef {
  id: string;
  label: string;
  description: string;
  defaultParams: Record<string, any>;
  paramDocs: Record<string, string>;
  run: (ctx: any, params: any) => Promise<void> | void;
}

// 若 pipeline 有指定才覆寫 state 編號設定;否則沿用使用者目前 UI 設定(預設 warehouse pipeline 不帶這些 → 行為不變)
function _applyNumberingState(p: any) {
  if (!p) return;
  if (p.direction === "vertical" || p.direction === "horizontal") (state as any).relayoutDirection = p.direction;
  if (Number.isFinite(p.capacity)) (state as any).relayoutCapacity = p.capacity;
  if (Number.isFinite(p.measureDecimals)) (state as any).measureDecimals = p.measureDecimals;
  if (p.caps && typeof p.caps === "object") {
    if (Number.isFinite(p.caps.Y)) (state as any).memberCapY = p.caps.Y;
    if (Number.isFinite(p.caps.X)) (state as any).memberCapX = p.caps.X;
    if (Number.isFinite(p.caps.Z)) (state as any).memberCapZ = p.caps.Z;
    if (Number.isFinite(p.caps.D)) (state as any).memberCapDiag = p.caps.D;
  }
}
// 傳給 relayout 的 numbering opts(5 個原本寫死的 knob)
function _numberingOpts(p: any) {
  p = p || {};
  return {
    tolGroup: p.tolGroup, tolBeamRow: p.tolBeamRow,
    angleTol: p.angleTol, absAxisTol: p.absAxisTol,
    axisOrderByPlane: p.axisOrderByPlane,
  };
}

// 節點 / 桿件編號共用的參數預設 + 教學
const NUMBERING_DEFAULTS = {
  angleTol: 0.05, absAxisTol: 10, tolGroup: 2, tolBeamRow: 50,
  axisOrderByPlane: { XY: ["Y", "X", "D"], YZ: ["Y", "Z", "D"], XZ: ["X", "Z", "D"] },
};
const NUMBERING_DOCS = {
  angleTol: "水平/垂直判定角度比(越大越容易判為斜撐),預設 0.05≈3°",
  absAxisTol: "軸向對齊絕對門檻 mm(短桿件防誤判),預設 10",
  tolGroup: "節點/同向桿件分群容差 mm,預設 2",
  tolBeamRow: "樑排分群容差 mm,預設 50",
  axisOrderByPlane: "各平面編號軸序。Y=柱 X/Z=樑 D=斜撐。XY立面=柱先;XZ平面圖=樑先;YZ側視=柱先",
  direction: "(選填)分群方向 vertical|horizontal;省略=沿用目前設定",
  capacity: "(選填)節點每群 ID 上限;省略=沿用目前設定",
  caps: "(選填){Y,X,Z,D} 各方向桿件 ID 上限(9/99/999/9999);省略=沿用目前設定",
  measureDecimals: "(選填)分類精準度小數位 0-6;省略=沿用目前設定",
};

export const PIPELINE_STEPS: PipelineStepDef[] = [
  {
    id: "consolidatePages",
    label: "整理所有頁面",
    description: "合併同位節點 / 刪重複桿件 / 共線中段拆段。",
    defaultParams: {},
    paramDocs: {},
    run: async () => { if (typeof consolidateAllPagesWithConfirm === "function") await consolidateAllPagesWithConfirm({ skipConfirm: true }); },
  },
  {
    id: "clearBindings",
    label: "清除 / 重建前清綁定",
    description: "清掉舊的 globalJoint / globalMember 綁定,從乾淨狀態開始(避免舊精準度殘留污染)。",
    defaultParams: { clearAll: true },
    paramDocs: { clearAll: "true=清掉全部綁定;false=只清分歧過大(>100mm)的壞綁" },
    run: (_ctx, p) => { if (typeof cleanupBadGlobalJoints === "function") cleanupBadGlobalJoints({ clearAll: p.clearAll !== false, skipConfirm: true }); },
  },
  {
    id: "fitByPrecision",
    label: "適配關聯(精準度)",
    description: "依目前精準度重建跨頁 / 跨檔 globalJoint 綁定。",
    defaultParams: {},
    paramDocs: {},
    run: async () => { if (typeof _runFitMergeByPrecision === "function") await _runFitMergeByPrecision({ skipConfirm: true }); },
  },
  {
    id: "numberJoints",
    label: "編排節點編號",
    description: "逐頁重編節點 ID(同時重編桿件)。柱/樑/斜撐分類 + 各平面軸序由下列參數決定。",
    defaultParams: { ...NUMBERING_DEFAULTS },
    paramDocs: { ...NUMBERING_DOCS },
    run: async (_ctx, p) => { _applyNumberingState(p); if (typeof relayoutNumberingAll === "function") await relayoutNumberingAll({ skipConfirm: true, numbering: _numberingOpts(p) }); },
  },
  {
    id: "numberMembers",
    label: "編排桿件編號",
    description: "跨頁 4-stage 重編桿件 ID(柱→樑→斜撐;節點 ID 不動)。",
    defaultParams: { ...NUMBERING_DEFAULTS },
    paramDocs: { ...NUMBERING_DOCS },
    run: async (_ctx, p) => { _applyNumberingState(p); if (typeof relayoutMembersNumberingAll === "function") await relayoutMembersNumberingAll({ skipConfirm: true, numbering: _numberingOpts(p) }); },
  },
  {
    id: "rebuildInfer",
    label: "重建 / 重算關聯",
    description: "失效 rank cache + 重新推斷 globalJoint(核心狀態,主視窗 / 3D 兩者皆套用)。",
    defaultParams: {},
    paramDocs: {},
    run: () => {
      try { if (typeof pushUndo === "function") pushUndo(); } catch (_) {}
      try { if (typeof invalidateRankCache === "function") invalidateRankCache(); } catch (_) {}
      try { if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints(); } catch (_) {}
    },
  },
  {
    id: "refreshRender",
    label: "重整並重畫",
    description: "重整側欄列表 + 重畫主畫面 / 3D(宿主相關)。",
    defaultParams: {},
    paramDocs: {},
    run: (ctx) => { ctx.host && ctx.host.refreshRender && ctx.host.refreshRender(); },
  },
  {
    id: "checkIssues",
    label: "檢查問題報告",
    description: "掃描撞號桿件 / 可延伸桿件 / 單頁節點並顯示報告(宿主相關)。",
    defaultParams: {},
    paramDocs: {},
    run: (ctx) => { ctx.host && ctx.host.checkIssues && ctx.host.checkIssues(); },
  },
];

export const PIPELINE_STEP_MAP = new Map(PIPELINE_STEPS.map(s => [s.id, s]));
export function getStepDef(id: string): PipelineStepDef | null { return PIPELINE_STEP_MAP.get(id) || null; }
export function allStepIds(): string[] { return PIPELINE_STEPS.map(s => s.id); }
