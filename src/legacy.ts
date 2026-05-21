// Phase 1 — legacy code 整段搬進 Vite,還沒拆模組
// pdf.js setup 已搬到 src/main.ts;這檔只保留主 app code
// 後續 phase 會把這檔的內容逐步移到 src/core/, src/render/, src/dialogs/ 等
// @ts-nocheck

// ============================================================================
// Phase 2 — 已拆出去的 pure utils / constants(從這檔的 inline 定義移到 src/utils/、
//   src/constants.ts;legacy.ts 透過 import 取得,呼叫位置不必改)
// ============================================================================
import { MAX_UNDO, ALLOWED_YY } from "./constants";
import { staadUnitKeyword, unitToMeter, meterToTarget } from "./utils/units";
import { xlsxCellRef as _xlsxCellRef, xmlEsc as _xmlEsc, xlsxCell as _xlsxCell } from "./utils/ooxml";
import { joint2DToWorld3D, world3DToJoint2D } from "./core/projection";
import { listGlobalBindings, inferGlobalJoint, inferAllGlobalJoints } from "./core/globalJoints";
import { proposeAutoPairings } from "./core/autopair";
import { _rankCache, invalidateRankCache, _worldForRank, _axisCap, _ensureRankCache } from "./core/rankCache";
import { _displayIdForJointWith } from "./core/displayId";
import { buildModel, showBuildModelCollisionsIfAny } from "./core/buildModel";
import { buildExportContext } from "./export/shared";

// ---------- main app code(原本是 1.13M chars 的大 <script> block) ----------
"use strict";

// ---------- state ----------
export const state = {
  // 多檔案結構:每個 file 有自己的 pages(以該檔案內的 pageIdx 為 key)
  files: [],          // [{ id, name, type, pdf?, image?, imageWidth?, imageHeight?, pages: {} }]
  activeFileId: null,
  pageIdx: 0,         // 當前 active file 內的頁次
  pdfScale: 3,
  bgWidth: 1200,
  bgHeight: 800,
  zoom: 1,
  panX: 0,
  panY: 0,
  tool: "select",
  pendingLineStart: null,    // joint id or {x,y}
  selection: {
    joints: new Set(), members: new Set(), fileIds: new Set(), fileAnchor: null,
    // 跨頁 preview 用:記錄選取「來源頁」(j.id / m.id 撞號後仍能正確比對);
    //   在 source page → j.id 比對(現行);非 source page → 用 source page 上 selected joint 的世界座標
    //   到當前頁找相符 joint 顯示 linked preview。
    sourceFileId: null, sourcePageIdx: null,
  },
  // 桿件編號撞號偵測(relayoutMembersNumberingAll 跑完會更新)
  //   - memberCollisions: Set<m.id> — 不同 globalMemberId 但同 m.id 的桿件 IDs(亮綠色高亮 + popup 警示)
  //   - memberCollisionsLastShownPage: 上次顯示撞號 popup 的「file.id#pageIdx」key,避免同一頁切回又跳 popup
  memberCollisions: new Set(),
  memberCollisionsLastShownPage: null,
  selectFilter: "all",                       // "all"|"joints"|"members" — 框選時的篩選
  scale: null,               // pixels per (unit) where unit is `unitName`
  unitName: "mm",
  snapPx: 12,
  ortho: false,
  snapMid: false,
  snapGrid: { mode: 0, step: 1 },           // 預設關閉網格鎖點視覺(Shift+A 切換)
  snapToGridLines: false,                    // 網格鎖點:吸附到網格線(單軸)— 預設關閉
  snapToGridPoints: false,                   // 網點鎖點:吸附到網格交點(雙軸)
  snapLinesPriority: true,                   // 線條優先:當兩者皆勾選時優先吸附網格線
  manualAlign: { active: false },
  moveMode: {                                // 移動指令(M):多模式狀態機
    active: false,
    type: null,           // "free" | "h" | "v" | "dist" | "angle" | "rect"
    base: null,           // {x, y}
    lock: null,           // "h" | "v" | null  (free / dist 模式下可由 Shift / Ctrl 切換)
    distance: null,       // mm
    angle: null,          // degrees
    dx: null, dy: null,   // rect 模式的水平/垂直位移
  },
  splitMode: false,                          // 拆分頁面模式
  scaleRulerDrag: null,                      // 比例尺沿線移動模式: { active, fileId, backup: {p1, p2} } 或 null
  bgDrawLine: null,                          // 畫直線模式: { active: true, p1: {x,y}|null, dasharray: string|null }
  altDown: false,                            // Alt / Option 鍵狀態(用於 bgDrawLine 切換 bg path 優先吸附)
  bgBisector: null,                          // 中分線模式: { active: true, mid: {x,y}, nx, ny, halfLen: number }
  bgEqui: null,                              // 等分線模式: { active: true, center: {x,y}, dx, dy, halfLen: number }
  bgCopyLine: null,                          // 複製線模式: { active, sources: [{p1,p2,dasharray}], base: {x,y}|null }
  bgMultiSelect: false,                      // 修改底圖模式:多線選取(點擊與匡選預設累加,不需 Shift)
  bgShapeMarquee: new Set(),                 // 修改底圖模式內形狀匡選子模式("square" / "rect" 可同時開)
  splitFirstCorner: null,                    // 兩點式對角:第一個對角點(世界座標)
  globalCapacity: 10000,                    // (舊資料相容用)全域:每頁 ID 容量上限;新編號方式不再使用
  numberPriority: "h",                      // 節點編排優先:"h" 水平(XXZZYY,預設)/ "v" 垂直(YYZZXX)
  numberTolerance: 2,                       // 軸坐標誤差範圍(預設 2mm):rank 合併容差,世界座標差 < tol 視為同 rank
  numberCapacityX: 99,                      // X 軸最大編號(9 / 99 / 999):X 部分 rank 上限 + 位數
  numberCapacityY: 99,                      // Y 軸最大編號
  numberCapacityZ: 99,                      // Z 軸最大編號
  bgSnapTolerance: 1,                       // 底圖誤差(mm):整理時用此值把節點吸到底圖線交點 / 端點
  planePicker: { active: false, sector: null, x: 0, y: 0 },
  spaceDown: false,
  cursor: { x: 0, y: 0, sx: 0, sy: 0 },   // sx,sy = world coords
  marquee: null,            // { x1,y1,x2,y2, additive }
  labelFontScale: 1,        // 使用者控制的標示字體整體倍率(+/- 按鈕)
  labelsVisible: true,      // 標示顯示 / 隱藏切換
  bgVisible: true,          // 底圖顯示 / 隱藏切換(影響 bg-canvas + bgSvg 的可見性)
  jointsVisible: true,      // 節點圓圈 + 錨點 + 節點編號 顯示 / 隱藏(body.joints-hidden CSS)
  membersVisible: true,     // 桿件線 + 桿件編號 顯示 / 隱藏(body.members-hidden CSS)
  rangeZoomMode: false,     // 範圍放大模式
  rangeZoomFirst: null,     // 第一個對角點(wrap 相對座標 {x,y})
  multiSelectSticky: false, // 多選持續模式(Shift+S 切換):開啟後點選為追加
  originPending: false,     // 座標原點 pending:進入 selectBg 等使用者選 2 條線
  scaleRulerPending: false, // 比例尺 pending:進入 selectBg 等使用者選 2 條平行線後自動建立
  sectionLinkPending: false, // 切面關聯 pending:進入 selectBg 等使用者選 1 條切線後確認
  sectionLinkPlacing: null,  // 切面定位:對話框 OK 後 → 兩點點擊定位箭頭(tip/tail)。{ file, repLine, targetIds, tip }
  sectionLinkPrevTool: null, // 進入切線關聯前的工具(結束後回到);若原本就在 selectBg 則維持
  measurePending: false,    // 標示距離 pending:進入 selectBg 等使用者選 1 或 2 條線後顯示距離(讀,不寫)
  measure: null,            // 標示距離結果 overlay: { kind: "single"|"parallel", a:{p1,p2}, b?:{p1,p2}, p1:{x,y}, p2:{x,y}, distance:number, unitLabel:string } 或 null
  coordDecimals: 0,         // 座標 / 長度顯示的小數位數(0~6,使用者可在「顯示設定」覆寫)
  relayoutDirection: "vertical",   // 重排編號方向:"vertical"(欄,左至右,欄內下至上)/ "horizontal"(排,上至下,排內左至右)
  relayoutCapacity: 100,    // 每排 / 欄之間的編號進位單位(預設 100)
  // 桿件編號 cap(全局):每軸方向 / 斜桿,選 9 / 99 / 999 / 9999。預設 99 → 每群最多 99 條
  //   Y 軸方向 = 柱(2D 垂直);X 軸方向 = 水平 X 樑;Z 軸方向 = 水平 Z 樑;斜桿 = 任何非軸向
  memberCapY: 99, memberCapX: 99, memberCapZ: 99, memberCapDiag: 99,
  projectFileHandle: null,  // 最近「儲存專案」的檔案 handle(File System Access API);「另存新檔」會更新
  crossViewSync: true,      // 跨頁同步建點(P1):節點模式下建立節點時自動在所有相容平面的頁面建對應節點 + 同 globalJoint
  fileListShow: { type: true, plane: true, stats: true },  // 已載入檔案清單顯示哪些欄位(name 永遠顯示)
  openTabs: [],                              // 已開啟的分頁:[{ fileId, pageIdx }]
  sectionLinkStyle: { fontPt: 15, strokeWidth: 30 },  // 切面樣式:標籤字體(pt)與線條粗度(px),預覽與最終皆套用
  measureDecimals: 0,                       // 標示距離 / 與原點距離 顯示的小數位數(0~6)
  globalOriginId: null,                     // 全局原點:某個 globalJoint id 被指定為世界 (0,0,0)
  globalOriginFileId: null,                 // 全局原點:某個檔案的 planeOrigin + pageZ 被指定為世界 (0,0,0)

  // 全局節點(跨頁/視圖共享):MVP-1
  // [{ id, label, x:null, y:null, z:null, derivedFrom: [], locked: false, warnings: [] }]
  // 每個 view joint 透過 joint.globalId 綁到此處的 id
  globalJoints: [],
  // 全局桿件:每個元素 { id, label, gj1, gj2 } — gj1/gj2 為一對 globalJoint id(已排序)
  //   member 透過 member.globalMemberId 綁到此處的 id
  //   自動 binding 規則:適配關聯後,若 member 兩端 joint 都已綁 globalJoint,
  //     將 (gj1, gj2) 排序後 lookup / create globalMember
  globalMembers: [],
  // 配對中:上一個 promote 出的 globalJoint id;下次點選 joint 會自動綁過去
  pendingGlobalPair: null,
  // 材料清單(由「材料管理」視窗 CRUD;搜尋桿件時可從下拉選用,寫入 m.material)
  //   元素:{ name: string, note?: string }
  materials: [],
  // 節點編號管理(樓層類型 + 斜撐起始 共用同一 YY 階池)
  //   元素:{ key, label, yyStart, kind: "floor"|"brace" }
  //     - kind="floor":XZ 頁面群組,各 XZ page 用 pg.floorType = <key> 指派
  //     - kind="brace":YZ / XY 頁面的斜撐起始群組,各 YZ/XY page 用 pg.braceType = <key> 指派
  //   兩 kind 共用同一 ALLOWED_YY 池(1, 11, …, 91),不得重疊。
  //   預設提供 "default"(floor 種,跟舊版相容);舊存檔沒 kind → 載入時補成 "floor"。
  floorTypes: [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }],
};

export let nextJointId = 1, nextMemberId = 1, nextFileId = 1, nextGlobalJointId = 1, nextGlobalMemberId = 1;
// Phase 6 fix 3:ESM 不允許跨模組對 `let` 做 post-increment,提供配發 id 的小函式給 render/index.ts
export function allocJointId() { return nextJointId++; }
export function allocMemberId() { return nextMemberId++; }
// Phase 7a:snapshot/applySnap 移到 src/state/snapshot.ts 後,跨模組重設計數器需要 setter
export function setNextJointId(v: number) { nextJointId = v; }
export function setNextMemberId(v: number) { nextMemberId = v; }
// Phase 8j follow-up:loadProjectFull 在 projectLoad.ts 還會寫 nextFileId
export function setNextFileId(v: number) { nextFileId = v; }
export function setNextGlobalJointId(v: number) { nextGlobalJointId = v; }
export function setNextGlobalMemberId(v: number) { nextGlobalMemberId = v; }

// ---------- 復原 / 重做 ----------
const undoStack = [];
const redoStack = [];
// MAX_UNDO 移到 src/constants.ts(Phase 2)
// Phase 7a:snapshot / applySnap 已搬到 src/state/snapshot.ts
import { snapshot, applySnap } from "./state/snapshot";
export function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  // 任何寫入操作都可能改變節點 / 桿件 / 平面設定 → rank cache 一律失效
  if (typeof invalidateRankCache === "function") invalidateRankCache();
}
function postRestore() {
  clearSelection();
  state.pendingLineStart = null;
  state.marquee = null;
  // 校準功能已移除,scaleInfo 元素也不存在
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  $("pageZ").value = (getPage().z ?? 0);
  applyBgRotation(getActiveFile());
  // 同步使用者畫的 bg 線:undo / redo 後 file.userBgLines 已被 applySnap 重置,
  //   需要把對應的 DOM <line> 也重建出來(否則撤銷的線會在畫面上殘留 / 重做的線會消失)
  if (typeof syncUserBgLinesToDom === "function") syncUserBgLinesToDom(getActiveFile());
  // planeOrigin / scaleRuler 還原後,按鈕 active 狀態 + globalJoint 推算結果都要跟著重來
  if (typeof updatePlaneOriginButton === "function") updatePlaneOriginButton();
  if (typeof updateScaleRulerButton === "function") updateScaleRulerButton();
  if (typeof updateCalibrateButton === "function") updateCalibrateButton();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  refreshPageCoordSection && refreshPageCoordSection();
  render(); refreshLists();
  // 防禦:若當前 active file 應該有底圖、但 bgSvg DOM 不見了或為空,自動重新觸發
  //   activatePage 重建底圖(原本「底圖修復」按鈕的邏輯,自動化)。
  //   解決:某些操作(例如全頁面適配關聯)曾改過 state.activeFileId 又還原,undo 後
  //   發現 bg DOM 與 activeFile 對不上的情形。
  _autoRepairBgIfMissing && _autoRepairBgIfMissing();
}
// 偵測底圖 DOM 是否被某流程清掉 → 自動重新跑 activatePage 重建(等同自動「底圖修復」)
//   只在 bg DOM 真的不見時才出手(bgSvg 整個沒了 且 bg-canvas 也沒了);僅靠 tag 不一致不觸發,
//   因為 activatePage 會跑 fitToView / _restorePageView 改視窗 zoom/pan,在 bg 還在的情況下啟動會
//   把使用者當前的視野打亂(造成「按 undo 後畫面變空」這類錯覺)。
//   設計成非同步 fire-and-forget;不阻塞 postRestore。沒可用來源時不動作。
function _autoRepairBgIfMissing() {
  const af = getActiveFile();
  if (!af) return;
  const hasSource = !!(af.pdf || af.image || af.cachedBgSvg || af.cachedBgImg || af.sourceFileId);
  if (!hasSource) return;
  const bgSvgEl = document.getElementById("bgSvg");
  const bgCanvasEl = document.getElementById("bg-canvas");
  const svgMissing = !bgSvgEl || bgSvgEl.childElementCount === 0;
  const canvasMissing = !bgCanvasEl;
  // 嚴格條件:兩條路徑都沒東西可看才修;只要其中之一有實際內容就放著(避免誤觸 fitToView)
  if (!(svgMissing && canvasMissing)) return;
  console.warn("[bg auto-repair] bgSvg + bg-canvas 都不見,自動重新 activatePage",
    { activeFileId: af.id, pageIdx: state.pageIdx });
  Promise.resolve().then(() => {
    try { activatePage(af.id, state.pageIdx || 0); }
    catch (e) { console.warn("[bg auto-repair] 失敗:", e); }
  });
}
async function undo() {
  if (!undoStack.length) {
    if ($("hud")) $("hud").textContent = "已無可復原的動作";
    return;
  }
  // pending message:在 snapshot / applySnap / postRestore 之前先 paint 一個 spinner +
  //   "復原中…(剩 N / M)" 的提示;大專案 undo 過程會卡幾秒,有可見的進度感比較不會誤以為 hang
  showBusy(`復原中…(可復原 ${undoStack.length} / 可重做 ${redoStack.length})`);
  if (typeof busyTick === "function") await busyTick();
  try {
    redoStack.push(snapshot());
    applySnap(undoStack.pop());
    postRestore();
  } finally {
    hideBusy();
  }
  if ($("hud")) {
    $("hud").textContent = `已復原(剩 ${undoStack.length} 步可復原 / ${redoStack.length} 步可重做)`;
  }
}
async function redo() {
  if (!redoStack.length) {
    if ($("hud")) $("hud").textContent = "已無可重做的動作";
    return;
  }
  showBusy(`重做中…(可復原 ${undoStack.length} / 可重做 ${redoStack.length})`);
  if (typeof busyTick === "function") await busyTick();
  try {
    undoStack.push(snapshot());
    applySnap(redoStack.pop());
    postRestore();
  } finally {
    hideBusy();
  }
  if ($("hud")) {
    $("hud").textContent = `已重做(剩 ${undoStack.length} 步可復原 / ${redoStack.length} 步可重做)`;
  }
}

export function getActiveFile() {
  return state.files.find(f => f.id === state.activeFileId);
}
export function getPage() {
  const f = getActiveFile();
  if (!f) return { joints: [], members: [], z: 0, _orphan: true };  // no-op fallback
  if (!f.pages) f.pages = {};
  if (!f.pages[state.pageIdx]) f.pages[state.pageIdx] = { joints: [], members: [], z: 0 };
  return f.pages[state.pageIdx];
}
// 拆分頁面的可繪製範圍:有 clipRect 時只能在矩形內建立 / 編輯
//   tol 給少量浮點容差(預設 0.5 世界單位 = 0.5px)
export function isInsideClip(file, x, y, tol) {
  if (!file || !file.clipRect) return true;
  const t = tol == null ? 0.5 : tol;
  const r = file.clipRect;
  return x >= r.x - t && x <= r.x + r.w + t
      && y >= r.y - t && y <= r.y + r.h + t;
}

// ---------- 全局節點 helpers (MVP-1) ----------
function findGlobalJointById(gid) {
  if (gid == null) return null;
  return state.globalJoints.find(g => g.id === gid) || null;
}
function autoGlobalJointLabel() {
  // 找一個目前沒被使用的 N# (從 1 開始)
  const used = new Set(state.globalJoints.map(g => g.label));
  for (let i = 1; i < 100000; i++) {
    const lbl = "N" + i;
    if (!used.has(lbl)) return lbl;
  }
  return "N" + nextGlobalJointId;
}
// 把世界座標 round 到目前精準度(state.measureDecimals 位數),且 -0 → 0。
//   globalJoint 的 x/y/z 一律以這個結果儲存,避免漂浮小數造成 rank cache / 顯示不一致
export function _snapCoordToPrecision(v) {
  if (!Number.isFinite(v)) return v;
  const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  const r = parseFloat(v.toFixed(md));
  return r === 0 ? 0 : r;
}
// 把所有 globalJoint 的 x/y/z 重新對齊到目前精準度(精準度設定改動時呼叫)
export function snapAllGlobalJointsToPrecision() {
  if (!Array.isArray(state.globalJoints)) return 0;
  let touched = 0;
  for (const g of state.globalJoints) {
    if (!g) continue;
    const nx = _snapCoordToPrecision(g.x);
    const ny = _snapCoordToPrecision(g.y);
    const nz = _snapCoordToPrecision(g.z);
    if (nx !== g.x || ny !== g.y || nz !== g.z) {
      g.x = nx; g.y = ny; g.z = nz;
      touched++;
    }
  }
  if (touched && typeof invalidateRankCache === "function") invalidateRankCache();
  return touched;
}
function createGlobalJoint() {
  const g = {
    id: nextGlobalJointId++,
    label: autoGlobalJointLabel(),
    x: null, y: null, z: null,
    derivedFrom: [],
    locked: false,
    warnings: [],
  };
  state.globalJoints.push(g);
  return g;
}
function bindJointToGlobal(joint, gid) {
  const oldGid = joint.globalId;
  // 同一頁同一個 globalId 只能對應 1 個 view joint
  const p = getPage();
  for (const j of p.joints) {
    if (j !== joint && j.globalId === gid) j.globalId = null;
  }
  joint.globalId = gid;
  // 若是改綁,舊的 globalJoint 若沒人引用就清掉(否則重新推算)
  if (oldGid != null && oldGid !== gid) {
    if (countBindings(oldGid) === 0) gcGlobalJoint(oldGid);
    else { const og = findGlobalJointById(oldGid); if (og) inferGlobalJoint(og); }
  }
  const g = findGlobalJointById(gid);
  if (g) inferGlobalJoint(g);
}
function unbindJointFromGlobal(joint) {
  const oldGid = joint.globalId;
  joint.globalId = null;
  // GC:若該 globalJoint 沒人引用,刪除;否則重新推算
  if (oldGid != null) {
    if (countBindings(oldGid) === 0) gcGlobalJoint(oldGid);
    else { const og = findGlobalJointById(oldGid); if (og) inferGlobalJoint(og); }
  }
}
function gcGlobalJoint(gid) {
  if (countBindings(gid) === 0) {
    state.globalJoints = state.globalJoints.filter(g => g.id !== gid);
  }
}
function countBindings(gid) {
  let n = 0;
  for (const f of state.files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      for (const j of (pg.joints || [])) if (j.globalId === gid) n++;
    }
  }
  return n;
}
// listGlobalBindings 移到 src/core/globalJoints.ts(Phase 3b)

// ---------- MVP-2:3D 投影與一致性推算 ----------
// 把 view joint 投影到 3D 世界座標。
//   座標系慣例:水平軸一律往「右」為正;縱軸方向依平面而異:
//     XY 平面(立面正視):+X = 螢幕右,+Y = 螢幕上;Z = page.z
//     YZ 平面(立面側視):+Z = 螢幕右,+Y = 螢幕上;X = page.z
//     XZ 平面(平面俯視):+X = 螢幕右,+Z = 螢幕下(plan view convention);Y = page.z
//   未設定:fallback 視為 XY
// 回傳 { x, y, z, strong: { X, Y, Z } }(strong[axis] = 該軸是否為 in-plane 強約束)
//   無比例尺(該檔沒校準且全局 state.scale 也無)→ 回傳 null
// joint2DToWorld3D 移到 src/core/projection.ts(Phase 3a)

// 把 joint 投影到本頁世界平面的 in-plane 兩軸,並回傳軸名 + 數值(已套 flipX/Y/原點/比例尺)。
//   軸名對應:XY → (X, Y) / YZ → (Z, Y) / XZ → (X, Z) — 螢幕水平軸放 axisA、垂直軸放 axisB。
//   數值由 joint2DToWorld3D 取出對應軸,因此 + 軸方向跟軸指示器箭頭一致(箭頭朝哪邊就 + 值)。
//   沒比例尺 / 沒 plane → 回 null,呼叫者要自己 fallback。
function _inPlaneCoordsForJoint(file, page, joint) {
  const w = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(file, page, joint) : null;
  if (!w) return null;
  const plane = (page && page.plane) || "XY";
  switch (plane) {
    case "XZ": return { axisA: "X", axisB: "Z", valA: w.x, valB: w.z };
    case "YZ": return { axisA: "Z", axisB: "Y", valA: w.z, valB: w.y };
    case "XY":
    default:   return { axisA: "X", axisB: "Y", valA: w.x, valB: w.y };
  }
}

// 根據所有綁定推算 globalJoint 的 3D 座標 + 一致性檢查。
// 規則:
//   - 強約束(in-plane)優先採用;同軸有多個強約束 → 取平均並檢查差異
//   - 沒有任何強約束的軸 → 取所有弱約束(out-of-plane)的平均;若仍無 → null
//   - 若同軸強約束差異 > tol 或 弱/強衝突 > tol → 寫 warning
//   - locked === true 的不覆蓋座標,只跑檢查
// inferGlobalJoint + inferAllGlobalJoints 移到 src/core/globalJoints.ts(Phase 3f)

// Phase 8a:calibrateAllFilesToGlobalOrigin / CustomOrigin 搬到 src/tools/calibrate.ts
export { calibrateAllFilesToGlobalOrigin, calibrateAllFilesToCustomOrigin } from "./tools/calibrate";

// joint2DToWorld3D 的反函數:給 3D world (X, Y, Z) 與目標 (file, page),回 2D (joint.x, joint.y)
//   ratio / origin / plane 全部用目標 page 的設定
//   檢查 page 的「out-of-plane 軸」是否與 world 對應軸吻合(tol);不吻合回 { ok: false, reason }
//   無 ratio:回 null
// world3DToJoint2D 移到 src/core/projection.ts(Phase 3a)

// 找出能容納指定 3D world 的所有頁(任意 file 的任意 page),回傳 [{ file, page, pageIdx, x, y }]
function findCompatiblePages(world, opts) {
  const tol = (opts && opts.tol != null) ? opts.tol : 0.5;
  const out = [];
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      const r = world3DToJoint2D(f, pg, world, { tol });
      if (r && r.ok) out.push({ file: f, page: pg, pageIdx: +k, x: r.x, y: r.y });
    }
  }
  return out;
}

// ---------- P2:跨頁同步建點時吸到底圖實際交點 ----------
// 把當前 active 頁的 bg 線段以「世界座標」(= 該頁 joint 座標) 抽出快取到 page._bgSegsCache
// 結構:[{ x1, y1, x2, y2 }]
// 呼叫時機:activatePage 完成後;cache 跟著 page 走,即使切到其他頁也保留(供其他頁的 P2 snap 用)
//   不重要 / 太短的線會被過濾
function cacheActivePageBgSegs() {
  const file = getActiveFile();
  const page = getPage();
  if (!file || !page || page._orphan) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) { page._bgSegsCache = null; return; }
  const segs = [];
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "circle" || tag === "ellipse") continue;  // 純曲線略過
    const sub = svgElementToSegments(el);
    if (!sub.length) continue;
    const ctm = el.getScreenCTM();
    if (!ctm) continue;
    const owner = el.ownerSVGElement || bgSvgEl;
    for (const s of sub) {
      const p1 = owner.createSVGPoint(); p1.x = s.x1; p1.y = s.y1;
      const p2 = owner.createSVGPoint(); p2.x = s.x2; p2.y = s.y2;
      const sp1 = p1.matrixTransform(ctm);
      const sp2 = p2.matrixTransform(ctm);
      const w1 = screenToWorld(sp1.x, sp1.y);
      const w2 = screenToWorld(sp2.x, sp2.y);
      const dx = w2.x - w1.x, dy = w2.y - w1.y;
      if ((dx * dx + dy * dy) < 0.01) continue;   // 零長 / 近零長略過
      segs.push({ x1: w1.x, y1: w1.y, x2: w2.x, y2: w2.y });
    }
  }
  page._bgSegsCache = segs;
}

// 全部頁面預先掃描 bg(供 P2 跨頁吸點使用)
//   會逐頁 activate(因為要 live DOM 算 CTM),完成後切回原頁
async function prewarmAllPagesBgCache() {
  const origFid = state.activeFileId, origPidx = state.pageIdx;
  let scanned = 0;
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      if (Array.isArray(pg._bgSegsCache)) continue;  // 已快取就略過
      try {
        await activatePage(f.id, +k);
        cacheActivePageBgSegs();
        scanned++;
        await busyTick();
      } catch (e) { console.warn("[P2 prewarm] 失敗:", f.name, "#" + (+k + 1), e); }
    }
  }
  if (origFid != null) await activatePage(origFid, origPidx || 0);
  return scanned;
}

// 在指定 page 的 bg cache 裡找最接近 projected 的「實際交點」
//   projected = { x, y } 是該 page 的 joint 座標(來自 world3DToJoint2D)
//   radius:搜尋半徑(world 單位);預設 snapPx*2 / state.scale
//   strict:t/u ∈ [0, 1] 才接受(不允許延伸線交點)
//   回 { x, y, snapped: true }(吸到了)/ null(沒找到)
function snapProjectionToBgIntersection(file, page, projected, opts) {
  const segs = page && page._bgSegsCache;
  if (!Array.isArray(segs) || segs.length < 2) return null;
  const radius = (opts && opts.radius != null)
    ? opts.radius
    : Math.max(2.0, (state.snapPx * 2) / Math.max(state.scale || 1, 1e-9));
  // 預篩:取距離 projected 在 (radius + 線段長/2) 內的線
  const candidates = [];
  for (const s of segs) {
    const cx = (s.x1 + s.x2) / 2, cy = (s.y1 + s.y2) / 2;
    const halfLen = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) / 2;
    const dCenter = Math.hypot(cx - projected.x, cy - projected.y);
    if (dCenter > radius + halfLen + 1) continue;
    candidates.push(s);
  }
  if (candidates.length < 2) return null;
  let best = null, bestD = radius;
  const eps = 1e-6;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      const r = lineLineIntersect(
        { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 },
        { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }
      );
      if (!r) continue;
      // strict 實際相交(容差 = eps 的線參數放寬,基本就是 [0,1])
      if (r.t < -eps || r.t > 1 + eps || r.u < -eps || r.u > 1 + eps) continue;
      const d = Math.hypot(r.x - projected.x, r.y - projected.y);
      if (d < bestD) { bestD = d; best = { x: r.x, y: r.y, snapped: true }; }
    }
  }
  return best;
}

// ---------- 三視圖自動配對 ----------
// 掃所有「已校準(可投影為 3D)」頁面,跨平面比對共軸座標,提出候選綁定。
//   triple:同時匹配 XY+XZ+YZ 三面(X、Y、Z 三軸都要在 tol 內),信心高
//   pair:  只匹配 2 面共軸(XY+XZ→X 軸 / XY+YZ→Y 軸 / XZ+YZ→Z 軸),信心中等
// 採貪心:先收信心最高(triple, score 最小)者,該頁節點不再被別組搶走;
// 再收 pair。回傳已篩選的 candidates。
//   opts.tol           : 匹配公差(state.unitName 同單位,如 mm),預設 50
//   opts.includeBound  : 是否含已綁定的節點,預設 false
// proposeAutoPairings 移到 src/core/autopair.ts(Phase 3c)

// 跨頁版 bind:不能用 bindJointToGlobal(它只看當前頁)
function bindJointAcrossPages(fileId, pageIdx, jointId, gid) {
  const f = state.files.find(x => x.id === fileId); if (!f) return;
  const pg = (f.pages || {})[pageIdx]; if (!pg) return;
  const j = (pg.joints || []).find(x => x.id === jointId); if (!j) return;
  // 同頁同 gid 互斥(一個全局節點在每一頁最多綁 1 個 view joint)
  for (const j2 of pg.joints) {
    if (j2 !== j && j2.globalId === gid) j2.globalId = null;
  }
  const oldGid = j.globalId;
  j.globalId = gid;
  if (oldGid != null && oldGid !== gid && countBindings(oldGid) === 0) {
    state.globalJoints = state.globalJoints.filter(g => g.id !== oldGid);
  }
}

function applyAutoPairings(accepted) {
  let triples = 0, pairs = 0;
  for (const c of accepted) {
    const g = createGlobalJoint();
    for (const m of c.members) bindJointAcrossPages(m.fileId, m.pageIdx, m.jointId, g.id);
    inferGlobalJoint(g);
    if (c.type === "triple") triples++; else pairs++;
  }
  return { triples, pairs };
}

// ---------- DOM ----------
export const $ = (id) => document.getElementById(id);
export const wrap = $("canvas-wrap");
const stage = $("stage");
const bg = $("bg-canvas");
const bgctx = bg.getContext("2d");
export const svg = $("vector");

// ---------- transform helpers ----------
export function applyTransform() {
  stage.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  // 進行中的互動模式 HUD 優先:不被座標/縮放資訊蓋掉(範圍放大 / 原點 / 拆分 / 手動對齊 / 移動 / 連續畫線)
  if (state.rangeZoomMode || state.originPending || state.splitMode
      || (state.moveMode && state.moveMode.active) || (state.manualAlign && state.manualAlign.active)
      || state.pendingLineStart) return;
  const Z = (typeof _t === "function" && _t("hud.zoom")) || "縮放";
  $("hud").textContent =
    `X: ${state.cursor.sx.toFixed(1)} · Y: ${state.cursor.sy.toFixed(1)} · ${Z}: ${(state.zoom*100).toFixed(0)}%`
    + (state.tool === "select" ? `  ·  ${selectFilterLabel(state.selectFilter)}` : "");
}
export function screenToWorld(clientX, clientY) {
  const r = wrap.getBoundingClientRect();
  return {
    x: (clientX - r.left - state.panX) / state.zoom,
    y: (clientY - r.top  - state.panY) / state.zoom,
  };
}
export function fitToView() {
  const r = wrap.getBoundingClientRect();
  // 拆分檔:以 clipRect(截圖範圍)為準,否則回退到完整底圖尺寸
  const af = getActiveFile && getActiveFile();
  const cr = af && af.clipRect;
  const bx = cr ? cr.x : 0;
  const by = cr ? cr.y : 0;
  const bw = cr ? cr.w : state.bgWidth;
  const bh = cr ? cr.h : state.bgHeight;
  const z = Math.min(r.width / bw, r.height / bh) * 0.95;
  state.zoom = z;
  state.panX = (r.width  - bw * z) / 2 - bx * z;
  state.panY = (r.height - bh * z) / 2 - by * z;
  applyTransform();
  // 縮放變了,字級 / 節點半徑 / 標號座標都依賴 state.zoom,必須重繪
  render();
}

// 把當前 zoom / pan 存到「正在離開」的那個 page 上,讓切回來時能還原
function _saveCurrentTabView() {
  if (state.activeFileId == null) return;
  const f = state.files.find(x => x.id === state.activeFileId);
  if (!f) return;
  if (!f.pages) f.pages = {};
  const pidx = state.pageIdx || 0;
  if (!f.pages[pidx]) f.pages[pidx] = { joints: [], members: [], z: 0 };
  f.pages[pidx]._view = { zoom: state.zoom, panX: state.panX, panY: state.panY };
}
// 若該 page 之前有存過 view,就還原並回 true;沒有則保留呼叫端原本的 zoom/pan
function _restorePageView(file, pageIdx) {
  const p = file && file.pages && file.pages[pageIdx || 0];
  if (!p || !p._view) return false;
  const v = p._view;
  if (!Number.isFinite(v.zoom) || !Number.isFinite(v.panX) || !Number.isFinite(v.panY)) return false;
  state.zoom = v.zoom;
  state.panX = v.panX;
  state.panY = v.panY;
  return true;
}

// ---------- background loaders ----------
$("file").addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  // 更新自製檔案狀態文字(取代 native input 的「未選擇任何檔案」)
  const fst = $("fileState");
  if (fst) {
    if (!files.length) {
      fst.textContent = (typeof _t === "function" && _t("sb.noFileChosen")) || "未選擇任何檔案";
    } else if (files.length === 1) {
      fst.textContent = files[0].name;
    } else {
      const suffix = (typeof _t === "function" && _t("sb.fileChosenN")) || "個檔案已選";
      fst.textContent = `${files.length} ${suffix}`;
    }
  }
  for (const f of files) {
    try { await addFile(f); }
    catch (err) {
      console.error("載入失敗:", f.name, err);
      alert(`載入「${f.name}」失敗:` + (err && err.message ? err.message : err));
    }
  }
  e.target.value = "";  // 允許重複選同檔案
  refreshFileList();
  refreshPageSelector();
});

// 導入設定對話框:顯示檔案預覽、提供 0/90/180/270 旋轉選擇,並即時更新預覽
//   參數:{ name, drawPreview(canvas) }
//   回傳:Promise<{ ok: boolean, rotation: 0|90|180|270 }>
//   預設旋轉:沿用上一次「確定」時所選的角度(取消不會更新);本 session 內生效
let lastImportRotation = 0;
// 讓 import dialog 的標題列可以拖曳整個 .imp-box 移動位置;每次重新打開會重置回置中。
// Lazy init:script 區塊在 HTML 裡早於 #importDialog 的 <div>,直接 querySelector 會拿不到 → 首次呼叫 show 時才掛 listener
let _importDlgDragInited = false;
function setupImportDialogDrag() {
  if (_importDlgDragInited) return;
  const box = document.querySelector("#importDialog .imp-box");
  const title = document.querySelector("#importDialog .imp-title");
  if (!box || !title) return;
  _importDlgDragInited = true;
  let drag = null;
  title.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const rect = box.getBoundingClientRect();
    // 從 translate(-50%, -50%) 置中切換到顯式 left/top 像素座標,後續拖曳直接寫 left/top
    box.style.left = rect.left + "px";
    box.style.top  = rect.top  + "px";
    box.style.transform = "none";
    drag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    // 限制不要拖出螢幕外(留 40px 標題區讓還能抓回來)
    const maxX = window.innerWidth - 40;
    const maxY = window.innerHeight - 40;
    const nx = Math.max(-box.offsetWidth + 80, Math.min(maxX, drag.left + (e.clientX - drag.startX)));
    const ny = Math.max(0, Math.min(maxY, drag.top + (e.clientY - drag.startY)));
    box.style.left = nx + "px";
    box.style.top  = ny + "px";
  });
  window.addEventListener("mouseup", () => { drag = null; });
}
function showImportDialog({ name, drawPreview }) {
  return new Promise(async (resolve) => {
    const dlg     = document.getElementById("importDialog");
    const canvas  = document.getElementById("importPreviewCanvas");
    const fnEl    = document.getElementById("importFileName");
    const okBtn   = document.getElementById("importOkBtn");
    const caBtn   = document.getElementById("importCancelBtn");
    const rotBtns = dlg.querySelectorAll(".imp-rot-btn");
    const stage         = dlg.querySelector(".imp-preview-stage");
    const previewName   = document.getElementById("importPreviewName");
    const previewZoom   = document.getElementById("importPreviewZoom");
    const previewZoomVal = document.getElementById("importPreviewZoomVal");
    setupImportDialogDrag();   // 第一次打開時才掛拖曳 listener
    // 每次打開對話框都重置位置為置中(清掉上次拖曳留下的 inline style)
    const box = dlg.querySelector(".imp-box");
    if (box) { box.style.left = ""; box.style.top = ""; box.style.transform = ""; }
    fnEl.textContent = name;

    let curRot = lastImportRotation || 0;   // 沿用上一次的選擇
    // 參考 floorTypesDialog 的預覽流程:srcCanvas 是 drawPreview 畫進去的原始光柵圖,
    //   visible canvas 隨 stage 尺寸 + DPR 重設,_drawPreview 每次重繪都從 srcCanvas
    //   經 ctx 變換(translate / rotate / scale)blit 到 visible canvas → zoom 高倍仍然銳利。
    const previewState = { zoom: 1, offsetX: 0, offsetY: 0 };
    let srcCanvas = null;

    const _resizeVisibleCanvas = () => {
      const cssW = Math.max(80, Math.floor(stage.clientWidth));
      const cssH = Math.max(60, Math.floor(stage.clientHeight));
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.style.width  = cssW + "px";
      canvas.style.height = cssH + "px";
      canvas.width  = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    const _drawPreview = () => {
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!srcCanvas) return;
      const sw = srcCanvas.width, sh = srcCanvas.height;
      if (sw <= 0 || sh <= 0) return;
      // 90°/270° 時長寬互換 → fit 算出來的 scale 才能容下旋轉後的 bounding box
      const rotMod = ((curRot % 360) + 360) % 360;
      const effW = (rotMod === 90 || rotMod === 270) ? sh : sw;
      const effH = (rotMod === 90 || rotMod === 270) ? sw : sh;
      const fit = Math.min(canvas.width / effW, canvas.height / effH) * 0.95;   // 邊緣留一點空隙
      const sc = fit * previewState.zoom;
      ctx.save();
      ctx.translate(canvas.width / 2 + previewState.offsetX, canvas.height / 2 + previewState.offsetY);
      ctx.rotate(rotMod * Math.PI / 180);
      ctx.scale(sc, sc);
      // WYSIWYG 反相 + 對比加強(對應原本 CSS filter,讓使用者看到的接近匯入後實際模樣)。
      //   drop-shadow 在 canvas 上效能差且邊界鋸齒 → 不沿用,改用 contrast 與 imageSmoothing 補回。
      try { ctx.filter = "invert(1) hue-rotate(180deg) contrast(1.3)"; } catch (_) {}
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(srcCanvas, -sw / 2, -sh / 2);
      ctx.restore();
    };
    const _setZoom = (z) => {
      previewState.zoom = Math.max(0.25, Math.min(z, 8));
      if (previewZoom) previewZoom.value = String(previewState.zoom);
      if (previewZoomVal) previewZoomVal.textContent = Math.round(previewState.zoom * 100) + "%";
    };
    const resetView = () => { previewState.offsetX = 0; previewState.offsetY = 0; _setZoom(1); _drawPreview(); };

    const refreshButtons = () => {
      rotBtns.forEach(b => b.classList.toggle("active", parseInt(b.dataset.rot) === curRot));
    };
    rotBtns.forEach(b => {
      b.onclick = () => {
        curRot = parseInt(b.dataset.rot) || 0;
        refreshButtons();
        // 切換角度時順便重置 zoom/pan,避免在歪斜狀態下切角度造成視覺跳動
        resetView();
      };
    });
    refreshButtons();

    // 滾輪 zoom(以滑鼠位置為中心,讓游標下的點維持不動)
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / rect.width;
      // 換算到 canvas 內部像素座標,且以「畫面中心」為原點(對應 _drawPreview 的 translate)
      const cx = (e.clientX - rect.left) * dpr - canvas.width  / 2;
      const cy = (e.clientY - rect.top)  * dpr - canvas.height / 2;
      const factor = (e.deltaY < 0) ? 1.15 : (1 / 1.15);
      const newZoom = Math.max(0.25, Math.min(previewState.zoom * factor, 8));
      const ratio = newZoom / previewState.zoom;
      // 鎖定游標下的點:offset' = c - (c - offset) * ratio
      previewState.offsetX = cx - (cx - previewState.offsetX) * ratio;
      previewState.offsetY = cy - (cy - previewState.offsetY) * ratio;
      _setZoom(newZoom);
      _drawPreview();
    };
    // 左鍵拖曳 = pan
    let panStart = null;
    const onDown = (e) => {
      if (e.button !== 0) return;
      stage.classList.add("panning");
      panStart = { x: e.clientX, y: e.clientY, ox: previewState.offsetX, oy: previewState.offsetY };
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!panStart) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / rect.width;
      previewState.offsetX = panStart.ox + (e.clientX - panStart.x) * dpr;
      previewState.offsetY = panStart.oy + (e.clientY - panStart.y) * dpr;
      _drawPreview();
    };
    const onUp = () => {
      if (!panStart) return;
      panStart = null;
      stage.classList.remove("panning");
    };
    const onDbl = () => { resetView(); };
    const onZoomInput = () => { _setZoom(+previewZoom.value || 1); _drawPreview(); };

    stage.addEventListener("wheel",     onWheel, { passive: false });
    stage.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
    stage.addEventListener("dblclick",  onDbl);
    if (previewZoom) previewZoom.addEventListener("input", onZoomInput);

    // 顯示對話框(必須先 active 才有 clientWidth/clientHeight 可量)
    dlg.classList.add("active");
    _resizeVisibleCanvas();
    // 把 drawPreview 畫到一個 offscreen srcCanvas;callers 會在裡面設 canvas.width/height + 繪圖,
    //   但 visible canvas 已被 _resizeVisibleCanvas 占走,所以給它一個全新的 srcCanvas。
    srcCanvas = document.createElement("canvas");
    srcCanvas.width = 1; srcCanvas.height = 1;
    try { await drawPreview(srcCanvas); }
    catch (e) { console.warn("導入預覽失敗:", e); }
    _setZoom(1);
    previewState.offsetX = 0; previewState.offsetY = 0;
    _drawPreview();

    // (顯示對話框已在 _resizeVisibleCanvas 之前完成,這裡不再重複 add)

    const close = (result) => {
      dlg.classList.remove("active");
      okBtn.onclick = null;
      caBtn.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      // 拆掉這次對話框掛在 stage / window / slider 上的 zoom / pan listener,避免下次再開時雙重觸發
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
      stage.removeEventListener("dblclick", onDbl);
      if (previewZoom) previewZoom.removeEventListener("input", onZoomInput);
      stage.classList.remove("panning");
      // 只有在使用者按「確定」時才更新預設;取消不更新
      if (result && result.ok) lastImportRotation = result.rotation || 0;
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close({ ok: false }); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); close({ ok: true, rotation: curRot }); }
      else { e.stopImmediatePropagation(); }   // 阻擋背景的工具熱鍵(Shift+L、Shift+S 等)
    };
    okBtn.onclick = () => close({ ok: true, rotation: curRot });
    caBtn.onclick = () => close({ ok: false });
    document.addEventListener("keydown", onKey, true);   // 用 capture 確保比其他 handler 先收到
  });
}

async function addFile(f) {
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isImg = f.type.startsWith("image/") || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name);
  const isDxf = /\.dxf$/i.test(f.name);
  const isDwg = /\.dwg$/i.test(f.name);
  if (isDwg) {
    alert(
      "不支援 DWG 直接匯入。\n\n" +
      "DWG 是 AutoCAD 的封閉二進位格式,瀏覽器內沒有可靠的 parser。\n" +
      "請先用以下任一方式轉成 DXF 後再匯入:\n" +
      "  • AutoCAD「另存新檔 → DXF」\n" +
      "  • 免費工具 ODA File Converter(opendesign.com)"
    );
    return;
  }
  if (!isPdf && !isImg && !isDxf) { alert(`不支援的檔案類型: ${f.name}`); return; }

  // 檔案名稱重複偵測(以原始檔名比對)— 不硬擋,讓使用者決定。
  // (使用情境:原檔已被重新命名 / 複製 / 拆分後,原 sourceName 仍在系統中,
  //  此時若拿到的新檔剛好同名但是不同內容,直接擋會很不便。)
  if (state.files.some(x => x.sourceName === f.name)) {
    if (!confirm(`偵測到「${f.name}」可能已載入過(來源檔名相同)。\n仍要繼續匯入這份檔案嗎?\n\n( 取消 → 不匯入;確定 → 當作新檔載入,屆時會自動加上「(2)」之類的後綴避免名稱衝突 )`)) return;
  }
  // 顯示名稱 (file.name) 必須唯一;若撞名 → 自動加 (2)/(3)/...
  // sourceName 仍保留原始 f.name(不變),供下次重複偵測使用
  const uniqueName = (base) => {
    if (!state.files.some(x => x.name === base)) return base;
    let n = 2;
    while (state.files.some(x => x.name === `${base} (${n})`)) n++;
    return `${base} (${n})`;
  };

  if (isDxf) {
    showBusy(`讀取 DXF…(${fmtMB(f.size || 0)})`);
    await busyTick();
    const text = await f.text();
    let parsed, svgPack;
    setBusyMessage("解析 DXF entities…");
    await busyTick();
    try { parsed = parseDxf(text); }
    catch (e) { hideBusy(); alert("DXF 解析失敗:" + e.message); return; }
    setBusyMessage(`轉成 SVG…(entities: ${parsed.entities ? parsed.entities.length : 0})`);
    await busyTick();
    try { svgPack = dxfToSvg(parsed); }
    catch (e) { hideBusy(); alert("DXF 渲染失敗:" + e.message); return; }
    hideBusy();
    if (!svgPack.entityCount) { alert("此 DXF 檔內沒有可繪製的圖元(目前支援 LINE / LWPOLYLINE / POLYLINE / CIRCLE / ARC / TEXT / INSERT)"); return; }

    // 為了預覽,先把 SVG 轉成 dataURL 給 Image 使用
    const dlgRes = await showImportDialog({
      name: f.name + `(${svgPack.entityCount} 個圖元)`,
      drawPreview: async (canvas) => {
        const target = 600;
        const sc = Math.min(target / svgPack.width, target / svgPack.height, 1);
        canvas.width  = Math.max(1, Math.floor(svgPack.width  * sc));
        canvas.height = Math.max(1, Math.floor(svgPack.height * sc));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        // 預覽專用:在 root <svg> 塞 stroke-width,讓所有「沒自帶 stroke-width 的 bg-stroke」
        // 透過 SVG 屬性繼承一個粗值。配合 vector-effect="non-scaling-stroke" 表示「最終輸出 N px」,
        // 所以在光柵化到小 canvas 後仍然清晰可見。不影響匯入(只改這個 blob URL 的版本)。
        const previewSvg = svgPack.svg.replace(
          /<svg\b([^>]*)>/,
          '<svg$1 stroke-width="6" stroke-linecap="round" stroke-linejoin="round">'
        );
        await new Promise((res, rej) => {
          const img = new Image();
          const url = URL.createObjectURL(new Blob([previewSvg], { type: "image/svg+xml" }));
          img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(url); res(); };
          img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
          img.src = url;
        });
      },
    });
    if (!dlgRes.ok) return;
    const userRotRad = (dlgRes.rotation || 0) * Math.PI / 180;

    const baseName = f.name.replace(/\.dxf$/i, "");
    // DXF 1:1 自動比例尺:依 $INSUNITS 換算「DXF 單位 → mm」的 ratio,並建立一個視覺比例尺
    //   DXF $INSUNITS:1=in / 2=ft / 4=mm / 5=cm / 6=m / 0=unitless(預設假設 mm)
    const insUnits = (parsed.header && parsed.header.$INSUNITS) || 0;
    const unitToMm = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
    const dxfRatio = unitToMm[insUnits] || 1;     // mm per DXF unit;0 / 未知 → 假設 mm
    const unitLabel = ({ 1: "inch", 2: "ft", 4: "mm", 5: "cm", 6: "m" })[insUnits] || "mm(假設)";
    // 比例尺視覺化:在 bbox 底部畫一條 1000 mm 長(world coord = 1000 / dxfRatio)的水平線
    const realLen = 1000;
    const measured = realLen / dxfRatio;
    const margin = Math.max(20, svgPack.height * 0.05);
    const p1 = { x: margin, y: svgPack.height - margin };
    const p2 = { x: margin + measured, y: svgPack.height - margin };
    const autoRuler = {
      type: "twoLines",
      p1, p2,
      measured, real: realLen,
      ratio: dxfRatio,
    };
    const entry = {
      id: nextFileId++,
      name: uniqueName(baseName),
      sourceName: f.name,
      type: "application/dxf",
      pageCount: 1,
      pages: {},
      // 直接寫入 cachedBgSvg,activatePage 會走 renderCachedBg 路徑
      cachedBgSvg: svgPack.svg,
      cachedBgWidth: svgPack.width,
      cachedBgHeight: svgPack.height,
      rotation: userRotRad,
      // DXF 1:1 自動建立比例尺 → 之後不需要手動校準(若 INSUNITS 是合理值)
      scaleRuler: autoRuler,
    };
    state.files.push(entry);
    console.log(`[DXF 載入] ${f.name}: $INSUNITS = ${insUnits} (${unitLabel}),自動建立比例尺 ratio = ${dxfRatio} mm/unit`);
    if (state.activeFileId == null) {
      // 大 DXF(上萬圖元)渲染 SVG DOM 會同步 block 數秒 → busyTick 讓瀏覽器先 paint 出 spinner,
      // 否則使用者按「確定」後以為程式沒反應
      showBusy(`渲染底圖…(${svgPack.entityCount} 個圖元)`);
      await busyTick();
      try { await activatePage(entry.id, 0); }
      finally { hideBusy(); }
    }
    return;
  }

  if (isPdf) {
    if (!window.pdfjsLib) { alert("PDF.js 尚未載入。"); return; }
    showBusy(`讀取 PDF…(${fmtMB(f.size || 0)})`);
    await busyTick();
    const buf = await f.arrayBuffer();
    setBusyMessage("解析 PDF…");
    await busyTick();
    let pdf;
    try { pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise; }
    catch (e1) { pdf = await pdfjsLib.getDocument({ data: buf.slice(0), disableWorker: true }).promise; }
    hideBusy();

    // 導入設定:預覽第 1 頁 + 旋轉選擇
    const dlgRes = await showImportDialog({
      name: f.name + (pdf.numPages > 1 ? `(共 ${pdf.numPages} 頁)` : ""),
      drawPreview: async (canvas) => {
        const page = await pdf.getPage(1);
        const v0 = page.getViewport({ scale: 1 });
        const target = 600;   // buffer 解析度,顯示時再縮放
        const sc = Math.min(target / v0.width, target / v0.height);
        const v = page.getViewport({ scale: sc });
        canvas.width  = Math.floor(v.width);
        canvas.height = Math.floor(v.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: v }).promise;
      },
    });
    if (!dlgRes.ok) return;
    const userRotRad = (dlgRes.rotation || 0) * Math.PI / 180;
    // 0° 視為「未指定」→ 保留 PDF 自動對齊;非 0° 則直接寫入 file.rotation,跳過自動對齊
    const baseName = f.name.replace(/\.pdf$/i, "");
    const multi = pdf.numPages > 1;
    let firstId = null;
    // 多頁共用同一份原始 PDF buffer:只在第一個 entry 存 pdfData,後續用 sourceFileId 指向
    let firstPdfFileId = null;
    for (let i = 1; i <= pdf.numPages; i++) {
      const entry = {
        id: nextFileId++,
        name: uniqueName(multi ? `${baseName}-${i}` : baseName),
        sourceName: f.name,
        type: f.type,
        pdf: pdf,
        pdfPage: i,        // 在原始 PDF 中的頁次
        pageCount: 1,
        pages: {},
      };
      if (firstPdfFileId == null) {
        entry.pdfData = buf;     // 第一個 entry 持有原始 ArrayBuffer
        firstPdfFileId = entry.id;
      } else {
        entry.sourceFileId = firstPdfFileId;
      }
      if (userRotRad !== 0) entry.rotation = userRotRad;
      state.files.push(entry);
      if (firstId == null) firstId = entry.id;
    }
    if (state.activeFileId == null && firstId != null) {
      showBusy(`渲染 PDF 第 1 頁…`);
      await busyTick();
      try { await activatePage(firstId, 0); }
      finally { hideBusy(); }
    }
  } else {
    showBusy(`讀取圖片…(${fmtMB(f.size || 0)})`);
    await busyTick();
    const imgBuf = await f.arrayBuffer();
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
    hideBusy();

    const dlgRes = await showImportDialog({
      name: f.name,
      drawPreview: (canvas) => {
        const target = 600;
        const sc = Math.min(target / img.naturalWidth, target / img.naturalHeight, 1);
        canvas.width  = Math.max(1, Math.floor(img.naturalWidth  * sc));
        canvas.height = Math.max(1, Math.floor(img.naturalHeight * sc));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      },
    });
    if (!dlgRes.ok) return;
    const userRotRad = (dlgRes.rotation || 0) * Math.PI / 180;

    const entry = {
      id: nextFileId++,
      name: uniqueName(f.name),
      sourceName: f.name,
      type: f.type,
      image: img,
      imageData: imgBuf,                                          // 原始位元組,供專案儲存使用
      imageMime: f.type || "image/png",
      imageWidth: img.naturalWidth,
      imageHeight: img.naturalHeight,
      rotation: userRotRad,    // 圖檔沒有自動對齊邏輯,直接寫入即可
      pageCount: 1,
      pages: {},
    };
    state.files.push(entry);
    if (state.activeFileId == null) {
      showBusy("渲染圖片…");
      await busyTick();
      try { await activatePage(entry.id, 0); }
      finally { hideBusy(); }
    }
  }
}

// 把 state.scale 同步成「目前 active file」的比例尺。
// 因為每個檔案(可能對應不同 PDF / 不同 DWG 來源)的 px↔mm 比例不一樣,
// 切換 active file 必須跟著切 state.scale,否則新檔案上的尺寸會用舊檔案的比例算錯。
function syncStateScaleFromActiveFile() {
  const f = getActiveFile();
  if (f && f.scaleRuler && f.scaleRuler.ratio > 0) {
    state.scale = 1 / f.scaleRuler.ratio;
    state.unitName = "mm";
  } else {
    state.scale = null;     // 此檔案尚未建立比例尺
  }
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
}

export async function activatePage(fileId, pageIdx) {
  const file = state.files.find(f => f.id === fileId);
  if (!file) return;
  // 切頁/切檔 → 取消任何卡住的切面 pending / placing(否則上次卡住的「只能選直線」過濾會跟到新頁)
  if (state.sectionLinkPending) {
    state.sectionLinkPending = false;
    state.sectionLinkPrevTool = null;
    $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
    if (typeof _restoreSectionLinkShapeMarquee === "function") _restoreSectionLinkShapeMarquee();
  }
  if (state.sectionLinkPlacing) {
    state.sectionLinkPlacing = null;
  }
  // 切頁/切檔不再清選取 — 改用「來源頁紀錄 + 跨頁世界座標比對」的方式做 linked preview:
  //   - 在 source page 用 j.id 高亮(正常選取)
  //   - 在其他頁用世界座標 fuzzy match 高亮(linked preview,不同視覺,避免 j.id 撞號誤標)
  state.activeFileId = fileId;
  state.pageIdx = pageIdx || 0;
  syncStateScaleFromActiveFile();
  $("pageZ").value = (getPage().z ?? 0);
  // 優先順序:
  //   1) 有 pdf.js 物件 → 用 renderPdfBg(會更新快取)
  //   2) 有 image 物件 → 用 renderImageBg(會更新快取)
  //   3) 有快取的向量 SVG / 圖片 dataURL → 直接從快取重建底圖(專案讀回常走這條)
  //   4) split / 衍生檔有 sourceFileId → 用來源的快取
  //   5) 都沒有 → 空白底圖
  if (file.pdf) await renderPdfBg(file.pdf, file.pdfPage || (pageIdx + 1));
  else if (file.image) renderImageBg(file);
  else if (file.cachedBgSvg || file.cachedBgImg) await renderCachedBg(file);
  else if (file.sourceFileId) {
    const src = state.files.find(f => f.id === file.sourceFileId);
    if (src && (src.cachedBgSvg || src.cachedBgImg)) await renderCachedBg(src, file);
    else renderBlankBg(file);
  }
  else renderBlankBg(file);
  // 標記目前 bg DOM 屬於哪個檔案的哪一頁,供 _autoRepairBgIfMissing 偵測錯位
  state._bgRenderedFor = { fileId: file.id, pageIdx: state.pageIdx };
  const bgSvgElForTag = document.getElementById("bgSvg");
  if (bgSvgElForTag) {
    bgSvgElForTag.setAttribute("data-bg-file-id", String(file.id));
    bgSvgElForTag.setAttribute("data-bg-page-idx", String(state.pageIdx));
  }
  // 第一次啟用 PDF 頁時自動對齊
  if (file.pdf && file.rotation === undefined) {
    const r = detectAlignmentAngle();
    file.rotation = r ? r.correction : 0;
    if (r) console.log(`[自動對齊] ${file.name}: ${(r.correction * 180 / Math.PI).toFixed(3)}°(${r.src})`);
  }
  applyBgRotation(file);
  // render* 已經呼叫過 fitToView;若這頁之前看過,恢復記住的 zoom/pan(不要重設視野)
  if (_restorePageView(file, state.pageIdx)) applyTransform();
  refreshFileList();
  refreshPageSelector();
  if (typeof refreshTabBar === "function") refreshTabBar();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  refreshPageCoordSection && refreshPageCoordSection();
  updateScaleRulerButton && updateScaleRulerButton();
  updatePlaneOriginButton && updatePlaneOriginButton();
  updateCalibrateButton && updateCalibrateButton();
  render(); refreshLists();
  // P2:當前頁的 bg 線段快取(供跨頁同步建點時吸到底圖實際交點)
  //   每次 activatePage 重建,DOM 此時應該已就緒
  try { cacheActivePageBgSegs && cacheActivePageBgSegs(); } catch (e) { console.warn("[P2 cache] 失敗:", e); }
  // 撞號桿件 popup:若當前頁有撞號 m.id → 跳警示 popup;同一頁切回不會重覆跳
  try { _maybeShowCollisionPopup(file, state.pageIdx); } catch (e) { console.warn("[collision popup] 失敗:", e); }
}

// 偵測當前頁有沒有撞號桿件 → 顯示 popup
function _maybeShowCollisionPopup(file, pageIdx) {
  if (!state.memberCollisions || state.memberCollisions.size === 0) return;
  const pg = file && file.pages && file.pages[pageIdx];
  if (!pg || pg._orphan) return;
  const hitIds = [];
  for (const m of pg.members || []) {
    if (state.memberCollisions.has(m.id)) hitIds.push(m.id);
  }
  if (!hitIds.length) return;
  _showCollisionPopup(hitIds, `本頁有 ${hitIds.length} 條桿件編號撞號(跟其他頁的不同物理桿件共用同一個 m.id),已被高亮為亮綠色`);
}

// 顯示所有撞號桿件 popup(3D 一鍵處理結束時用 / 全局警示)
function _showAllCollisionsPopup() {
  if (!state.memberCollisions || state.memberCollisions.size === 0) return;
  const allIds = [...state.memberCollisions];
  _showCollisionPopup(allIds, `全模型共 ${allIds.length} 個 m.id 撞號(不同物理桿件共用同 ID),畫面上以亮綠色高亮;切到含撞號桿件的頁時會再次提醒`);
}

// 共用 popup 顯示邏輯 — caller 傳要列的 m.id 陣列 + 說明訊息
function _showCollisionPopup(ids, msg) {
  if (!ids || !ids.length) return;
  const popup = document.getElementById("collisionPopup");
  const msgEl = document.getElementById("collisionPopupMsg");
  const idsEl = document.getElementById("collisionPopupIds");
  const searchBtn = document.getElementById("collisionSearchBtn");
  const okBtn = document.getElementById("collisionOkBtn");
  if (!popup || !msgEl || !idsEl || !searchBtn || !okBtn) return;
  msgEl.textContent = msg;
  const sortedIds = [...ids].sort((a, b) => a - b);
  idsEl.textContent = sortedIds.join(", ");
  popup.style.display = "block";
  // 確定 → 關 popup
  okBtn.onclick = () => { popup.style.display = "none"; };
  // 搜尋 → 開搜尋 popup,並自動填入撞號 m.id 到「桿件編號」textarea
  searchBtn.onclick = () => {
    popup.style.display = "none";
    try {
      if (typeof openSearchWindow === "function") openSearchWindow();
      // openSearchWindow 走 win.document.write + DOMContentLoaded 後 body.innerHTML;
      //   需要等 #memberIdInput textarea 真的就緒,輪詢最多 30 次 / 每次 100ms
      const idsStr = sortedIds.join(",");
      const _tryFill = (attempt) => {
        const w = _searchWin;
        const ready = w && !w.closed && w.document && w.document.getElementById("memberIdInput");
        if (!ready) {
          if (attempt < 30) setTimeout(() => _tryFill(attempt + 1), 100);
          else console.warn("[collision search prefill] 搜尋視窗未就緒,放棄填入");
          return;
        }
        try {
          // 確認搜尋模式 = 桿件(預設就是,但保險起見再勾一次並觸發 change)
          const typeMember = w.document.querySelector('input[name="searchType"][value="member"]');
          if (typeMember && !typeMember.checked) {
            typeMember.checked = true;
            typeMember.dispatchEvent(new w.Event("change", { bubbles: true }));
          }
          // 填編號 textarea + 觸發 input event
          const idInput = w.document.getElementById("memberIdInput");
          idInput.value = idsStr;
          idInput.dispatchEvent(new w.Event("input", { bubbles: true }));
          idInput.focus();
          // 直接按搜尋按鈕(textarea 內 Enter 是換行,搜尋鈕點下才會跑)
          const btn = w.document.getElementById("btnSearch");
          if (btn) btn.click();
        } catch (e) { console.warn("[collision search prefill] 填入失敗:", e); }
      };
      setTimeout(() => _tryFill(0), 100);
    } catch (e) { console.warn("[collision search] 失敗:", e); }
  };
}

// 使用者點擊切換頁面/檔案時的包裝:顯示 busy spinner,避免大 DXF/PDF 重繪期間畫面看似凍結。
//   activatePage 會走 renderCachedBg / renderPdfBg,對上萬元素的底圖可能同步 block 數秒,
//   必須先 showBusy + busyTick 讓瀏覽器 paint 出進度再進入重活。
export async function activatePageWithBusy(fileId, pageIdx) {
  // 使用者主動切分頁:先把當下視野存到正在離開的那頁,activatePage 內會還原目標頁的視野
  const targetPidx = pageIdx || 0;
  const isSwitching = state.activeFileId != null &&
    (state.activeFileId !== fileId || (state.pageIdx || 0) !== targetPidx);
  if (isSwitching) {
    _saveCurrentTabView();
    // 離開前先把當前位置寫進導航歷史(同位置只 update zoom/pan,不重複新增)→ Back 可以回到啟動頁
    _navRecordIfNotInProgress();
  }
  const f = state.files.find(ff => ff.id === fileId);
  const msg = f ? `切換到「${f.name}」…` : "切換頁面…";
  showBusy(msg);
  await busyTick();
  try { await activatePage(fileId, targetPidx); }
  finally { hideBusy(); }
  // 抵達後記入導航歷史(若是 navBack/navForward 觸發的就跳過,避免迴圈)
  _navRecordIfNotInProgress();
}

// ---------- 導航歷史(類似 IntelliJ 的 cmd+[ / cmd+]) ----------
//   stack: [{fileId, pageIdx, zoom, panX, panY}, ...]
//   index: 當前位置在 stack 的 index;-1 表示尚未記任何頁
//   navBack:index--;navForward:index++;到達後 restore zoom/pan + activatePage
//   recordIfNotInProgress:在 activatePageWithBusy 結束時呼叫;若 index 不在尾端就先截斷未來分支
const navHistory = { stack: [], index: -1, max: 10 };
let _navInProgress = false;
function _captureCurrentView() {
  if (state.activeFileId == null) return null;
  return {
    fileId: state.activeFileId,
    pageIdx: state.pageIdx || 0,
    zoom: state.zoom,
    panX: state.panX,
    panY: state.panY,
    t: Date.now(),
  };
}
function _navRecordIfNotInProgress() {
  if (_navInProgress) return;
  const v = _captureCurrentView();
  if (!v) return;
  const last = navHistory.stack[navHistory.index];
  if (last && last.fileId === v.fileId && last.pageIdx === v.pageIdx) {
    // 同頁 → 只更新 zoom/pan,不新增 entry
    last.zoom = v.zoom; last.panX = v.panX; last.panY = v.panY; last.t = v.t;
    return;
  }
  // 截斷未來分支(若使用者 back 後又跳新頁,捨棄 forward)
  if (navHistory.index < navHistory.stack.length - 1) {
    navHistory.stack = navHistory.stack.slice(0, navHistory.index + 1);
  }
  navHistory.stack.push(v);
  navHistory.index = navHistory.stack.length - 1;
  if (navHistory.stack.length > navHistory.max) {
    navHistory.stack.shift();
    navHistory.index--;
  }
}
async function _navGoTo(v) {
  if (!v) return;
  _navInProgress = true;
  try {
    if (state.activeFileId !== v.fileId || (state.pageIdx || 0) !== v.pageIdx) {
      _saveCurrentTabView();
      const f = state.files.find(ff => ff.id === v.fileId);
      if (!f) { console.warn("[nav] 目標檔已不存在,跳過", v); return; }
      showBusy(`返回「${f.name}」…`);
      await busyTick();
      try { await activatePage(v.fileId, v.pageIdx); } finally { hideBusy(); }
    }
    state.zoom = v.zoom; state.panX = v.panX; state.panY = v.panY;
    applyTransform();
  } finally {
    _navInProgress = false;
  }
}
async function navBack() {
  if (navHistory.index <= 0) {
    $("hud").textContent = "返回:已在歷史最前端";
    return;
  }
  // 跳前先把當前 zoom/pan 寫回此格,讓 forward 還原一致
  const cur = _captureCurrentView();
  if (cur) {
    const top = navHistory.stack[navHistory.index];
    if (top && top.fileId === cur.fileId && top.pageIdx === cur.pageIdx) {
      top.zoom = cur.zoom; top.panX = cur.panX; top.panY = cur.panY;
    }
  }
  navHistory.index--;
  await _navGoTo(navHistory.stack[navHistory.index]);
  $("hud").textContent = `返回(${navHistory.index + 1}/${navHistory.stack.length})`;
}
async function navForward() {
  if (navHistory.index >= navHistory.stack.length - 1) {
    $("hud").textContent = "前進:已在歷史最末端";
    return;
  }
  const cur = _captureCurrentView();
  if (cur) {
    const top = navHistory.stack[navHistory.index];
    if (top && top.fileId === cur.fileId && top.pageIdx === cur.pageIdx) {
      top.zoom = cur.zoom; top.panX = cur.panX; top.panY = cur.panY;
    }
  }
  navHistory.index++;
  await _navGoTo(navHistory.stack[navHistory.index]);
  $("hud").textContent = `前進(${navHistory.index + 1}/${navHistory.stack.length})`;
}

// SVG path "d" → 直線段陣列。完整支援:
// - M/m 後的「隱式 lineto」(SVG 規範:M 後續座標 = 隱式 L)
// - 絕對 / 相對 (大寫 = 絕對, 小寫 = 相對)
// - L/H/V/Z 直線
// - C/S/Q/T/A 曲線:不產生 segment,但會更新 cur 到曲線終點,讓後續直線位置正確
function parseStraightSegs(d) {
  const tokens = (d || "").match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) || [];
  const segs = []; let cur = null, start = null, cmd = null, i = 0;
  const grab = (n) => { const a = []; for (let k = 0; k < n; k++) a.push(parseFloat(tokens[i++])); return a; };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) {
      cmd = t; i++;
      if (cmd === "Z" || cmd === "z") {
        if (cur && start && (cur.x !== start.x || cur.y !== start.y)) {
          segs.push({ x1: cur.x, y1: cur.y, x2: start.x, y2: start.y });
        }
        cur = start ? { ...start } : null;
        cmd = null;
      }
      continue;
    }
    if (cmd == null) { i++; continue; }
    switch (cmd) {
      case "M": case "m": {
        const [x, y] = grab(2);
        cur = (cmd === "M" || !cur) ? { x, y } : { x: cur.x + x, y: cur.y + y };
        start = { ...cur };
        cmd = (cmd === "M") ? "L" : "l";    // 後續隱式 = lineto
        break;
      }
      case "L": case "l": {
        const [x, y] = grab(2);
        const next = (cmd === "L") ? { x, y } : { x: cur.x + x, y: cur.y + y };
        if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: next.x, y2: next.y });
        cur = next; break;
      }
      case "H": case "h": {
        const [x] = grab(1);
        const nx = cmd === "H" ? x : cur.x + x;
        if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: nx, y2: cur.y });
        cur = { x: nx, y: cur.y }; break;
      }
      case "V": case "v": {
        const [y] = grab(1);
        const ny = cmd === "V" ? y : cur.y + y;
        if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: cur.x, y2: ny });
        cur = { x: cur.x, y: ny }; break;
      }
      case "C": case "c": {
        const a = grab(6);
        const ex = cmd === "C" ? a[4] : cur.x + a[4];
        const ey = cmd === "C" ? a[5] : cur.y + a[5];
        cur = { x: ex, y: ey }; break;
      }
      case "S": case "s": case "Q": case "q": {
        const a = grab(4);
        const abs = (cmd === "S" || cmd === "Q");
        cur = { x: abs ? a[2] : cur.x + a[2], y: abs ? a[3] : cur.y + a[3] }; break;
      }
      case "T": case "t": {
        const [x, y] = grab(2);
        cur = (cmd === "T") ? { x, y } : { x: cur.x + x, y: cur.y + y }; break;
      }
      case "A": case "a": {
        const a = grab(7);
        const ex = cmd === "A" ? a[5] : cur.x + a[5];
        const ey = cmd === "A" ? a[6] : cur.y + a[6];
        cur = { x: ex, y: ey }; break;
      }
      default: i++;
    }
  }
  return segs;
}

// 把一條 <line> 兩端點轉成「世界座標」(經過所有父層 transform → 螢幕 → 世界)
// 解決 pdf.js 把同一張圖的不同段切到不同 <g> 父層、本地座標對不上的問題
function bgLineWorldEnds(el) {
  const ctm = el.getScreenCTM();
  if (!ctm) return null;
  const svg = el.ownerSVGElement || document.getElementById("bgSvg");
  const x1 = parseFloat(el.getAttribute("x1") || 0);
  const y1 = parseFloat(el.getAttribute("y1") || 0);
  const x2 = parseFloat(el.getAttribute("x2") || 0);
  const y2 = parseFloat(el.getAttribute("y2") || 0);
  const p1 = svg.createSVGPoint(); p1.x = x1; p1.y = y1;
  const p2 = svg.createSVGPoint(); p2.x = x2; p2.y = y2;
  const s1 = p1.matrixTransform(ctm);
  const s2 = p2.matrixTransform(ctm);
  const w1 = screenToWorld(s1.x, s1.y);
  const w2 = screenToWorld(s2.x, s2.y);
  return { a: w1, b: w2 };
}

// 把 SVG 元素的 local 座標(透過 CTM 串完所有父層 transform)轉成世界座標
function bgLocalToWorld(el, x, y) {
  const ctm = el.getScreenCTM();
  if (!ctm) return { x, y };
  const owner = el.ownerSVGElement || document.getElementById("bgSvg");
  const pt = owner.createSVGPoint(); pt.x = x; pt.y = y;
  const sp = pt.matrixTransform(ctm);
  return screenToWorld(sp.x, sp.y);
}

// bbox vs 匡選範圍判斷:crossing → 任何相交;非 crossing → 完整包含
function bgBBoxInRange(bb, range) {
  if (range.crossing) {
    return !(bb.x2 < range.x1 || bb.x1 > range.x2 || bb.y2 < range.y1 || bb.y1 > range.y2);
  }
  return bb.x1 >= range.x1 && bb.x2 <= range.x2 && bb.y1 >= range.y1 && bb.y2 <= range.y2;
}

// 從目前 bg lines 中找出構成軸向矩形/正方形的元素
// mode: "square" = 寬 ≈ 高;"rect" = 寬 ≠ 高;"any" = 都選
// range:可選,世界座標 {x1,y1,x2,y2}, 只挑全部落在範圍內的形狀(crossing=false 嚴格包含)
function findRectangleBgLines(mode, range) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();

  const eps = 1.0; // 世界單位(通常 1 mm)
  const matched = new Set();
  // 由右至左 (crossing) → 任何相交即可;由左至右 → 完整包含
  const inRange = (cx1, cy1, cx2, cy2) => {
    if (!range) return true;
    const minX = Math.min(cx1, cx2), maxX = Math.max(cx1, cx2);
    const minY = Math.min(cy1, cy2), maxY = Math.max(cy1, cy2);
    if (range.crossing) {
      return !(maxX < range.x1 || minX > range.x2 || maxY < range.y1 || minY > range.y2);
    }
    return minX >= range.x1 && maxX <= range.x2 && minY >= range.y1 && maxY <= range.y2;
  };

  // ---- A. 4 條獨立 <line> 構成的封閉矩形 ----
  const lines = Array.from(bgSvgEl.querySelectorAll('line[data-bg-idx]'))
    .filter(el => el.style.display !== "none" && el.dataset.bgPageBg !== "1");
  const horizontals = [], verticals = [];
  for (const el of lines) {
    const ends = bgLineWorldEnds(el);
    if (!ends) continue;
    const dx = ends.b.x - ends.a.x, dy = ends.b.y - ends.a.y;
    const idx = el.dataset.bgIdx;
    if (Math.abs(dy) < eps && Math.abs(dx) >= eps) {
      horizontals.push({ idx, x1: Math.min(ends.a.x, ends.b.x), x2: Math.max(ends.a.x, ends.b.x), y: (ends.a.y + ends.b.y) / 2 });
    } else if (Math.abs(dx) < eps && Math.abs(dy) >= eps) {
      verticals.push({ idx, y1: Math.min(ends.a.y, ends.b.y), y2: Math.max(ends.a.y, ends.b.y), x: (ends.a.x + ends.b.x) / 2 });
    }
  }
  for (let i = 0; i < horizontals.length; i++) {
    for (let j = i + 1; j < horizontals.length; j++) {
      const ha = horizontals[i], hb = horizontals[j];
      if (Math.abs(ha.x1 - hb.x1) > eps || Math.abs(ha.x2 - hb.x2) > eps) continue;
      const top = Math.min(ha.y, hb.y), bot = Math.max(ha.y, hb.y);
      const left  = verticals.find(v => Math.abs(v.x - ha.x1) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      const right = verticals.find(v => Math.abs(v.x - ha.x2) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      if (!left || !right) continue;
      const w = ha.x2 - ha.x1, h = bot - top;
      const isSquare = Math.abs(w - h) < eps;
      if (mode === "square" && !isSquare) continue;
      if (mode === "rect"   && isSquare) continue;
      if (!inRange(ha.x1, top, ha.x2, bot)) continue;
      matched.add(ha.idx); matched.add(hb.idx);
      matched.add(left.idx); matched.add(right.idx);
    }
  }

  // ---- B. 單一元素(path / polygon / polyline / rect)本身就構成軸向矩形 ----
  // 「一線到底」型:單一 <path> 用 M-L-L-L-Z(或開放四段)畫完整個方框
  const candidates = bgSvgEl.querySelectorAll('[data-bg-idx]');
  for (const el of candidates) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "line") continue;       // line 在 A 階段處理
    if (tag !== "path" && tag !== "polygon" && tag !== "polyline" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (segs.length < 4) continue;       // 至少要 4 段才可能成方框
    // 把 segments 端點轉到 world 座標
    const worldSegs = segs.map(s => {
      const a = bgLocalToWorld(el, s.x1, s.y1);
      const b = bgLocalToWorld(el, s.x2, s.y2);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    });
    // 檢測:能否找到 4 段(允許 ≥4 取前 4 但要求閉合 + 軸向交替)
    // 簡化:取前 4 段,檢查每段都軸向 + 兩兩首尾相連 + 4 個角形成矩形
    if (worldSegs.length < 4) continue;
    // 從所有 segs 中找一組構成封閉軸向四邊形的端點 → 取所有端點的 bbox + 檢驗
    const xs = [], ys = [];
    let allAxisAligned = true;
    for (const s of worldSegs) {
      const isH = Math.abs(s.ay - s.by) < eps;
      const isV = Math.abs(s.ax - s.bx) < eps;
      if (!isH && !isV) { allAxisAligned = false; break; }
      xs.push(s.ax, s.bx); ys.push(s.ay, s.by);
    }
    if (!allAxisAligned) continue;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w < eps || h < eps) continue;
    // 確認 4 角點都被 segments 覆蓋(每個角點 = 兩條軸向邊的相交)
    const corners = [
      { x: minX, y: minY }, { x: maxX, y: minY },
      { x: maxX, y: maxY }, { x: minX, y: maxY },
    ];
    const reachedCorner = corners.map(c =>
      worldSegs.some(s =>
        (Math.abs(s.ax - c.x) < eps && Math.abs(s.ay - c.y) < eps) ||
        (Math.abs(s.bx - c.x) < eps && Math.abs(s.by - c.y) < eps)
      )
    );
    if (!reachedCorner.every(Boolean)) continue;
    // 邊長檢驗:必須有恰好覆蓋 4 邊(top/right/bottom/left)的軸向 segments
    const hasEdge = (x1, y1, x2, y2) => worldSegs.some(s => {
      const matchAB = Math.abs(s.ax - x1) < eps && Math.abs(s.ay - y1) < eps && Math.abs(s.bx - x2) < eps && Math.abs(s.by - y2) < eps;
      const matchBA = Math.abs(s.ax - x2) < eps && Math.abs(s.ay - y2) < eps && Math.abs(s.bx - x1) < eps && Math.abs(s.by - y1) < eps;
      return matchAB || matchBA;
    });
    if (!hasEdge(minX, minY, maxX, minY)) continue;
    if (!hasEdge(maxX, minY, maxX, maxY)) continue;
    if (!hasEdge(maxX, maxY, minX, maxY)) continue;
    if (!hasEdge(minX, maxY, minX, minY)) continue;

    const isSquare = Math.abs(w - h) < eps;
    if (mode === "square" && !isSquare) continue;
    if (mode === "rect"   && isSquare) continue;
    if (!inRange(minX, minY, maxX, maxY)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

// 取一個 bg path 的世界座標 bbox(透過 CTM 轉換)。回傳 null 若取不到。
function bgPathWorldBBox(el) {
  const segs = svgElementToSegments(el);
  const ctm = el.getScreenCTM && el.getScreenCTM();
  const owner = el.ownerSVGElement || document.getElementById("bgSvg");
  if (!ctm || !owner) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  if (segs.length > 0) {
    for (const s of segs) {
      for (const [px, py] of [[s.x1, s.y1], [s.x2, s.y2]]) {
        const pt = owner.createSVGPoint(); pt.x = px; pt.y = py;
        const sp = pt.matrixTransform(ctm);
        const wp = screenToWorld(sp.x, sp.y);
        grow(wp.x, wp.y);
      }
    }
  } else {
    // 沒有可解析的 segments(例如 <circle> / <ellipse>)→ 用 element 自己的 BBox
    try {
      const bb = el.getBBox();
      const corners = [
        [bb.x, bb.y], [bb.x + bb.width, bb.y],
        [bb.x + bb.width, bb.y + bb.height], [bb.x, bb.y + bb.height],
      ];
      for (const [px, py] of corners) {
        const pt = owner.createSVGPoint(); pt.x = px; pt.y = py;
        const sp = pt.matrixTransform(ctm);
        const wp = screenToWorld(sp.x, sp.y);
        grow(wp.x, wp.y);
      }
    } catch (_) { return null; }
  }
  if (!isFinite(minX)) return null;
  return { x1: minX, y1: minY, x2: maxX, y2: maxY };
}

// 圓形匡選:抓 <circle> / <ellipse>,以及 bbox 接近正方形 + d 含曲線指令(C/Q/A)的封閉 path
function findCircleBgPaths(range) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();
  const matched = new Set();
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    let isCircle = false;
    if (tag === "circle" || tag === "ellipse") {
      isCircle = true;
    } else if (tag === "path") {
      const d = el.getAttribute("d") || "";
      if (/[CcQqAa]/.test(d)) {
        // 用 bbox 比例判斷是否近似圓 / 圓滑封閉曲線
        const bb = bgPathWorldBBox(el);
        if (bb) {
          const w = bb.x2 - bb.x1, h = bb.y2 - bb.y1;
          if (w > 0.5 && h > 0.5 && Math.abs(w - h) / Math.max(w, h) < 0.15) isCircle = true;
        }
      }
    }
    if (!isCircle) continue;
    const bb = bgPathWorldBBox(el);
    if (!bb || !bgBBoxInRange(bb, range)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

// 直線匡選:挑選「單段直線」元素(SVG <line> 或只含 1 個 M-L 段的 path / polyline)
//   排除:circle / ellipse / rect / polygon / 多段 polyline / 多段 path
function findStraightBgLines(range, opts) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();
  const requireSolid = !!(opts && opts.requireSolid);
  const matched = new Set();
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    // 排除非線型元素
    if (tag === "circle" || tag === "ellipse" || tag === "rect" || tag === "polygon") continue;
    if (tag !== "line" && tag !== "path" && tag !== "polyline") continue;
    const segs = svgElementToSegments(el);
    // 必須剛好 1 段直線
    if (segs.length !== 1) continue;
    const s = segs[0];
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    if (Math.hypot(dx, dy) < 0.01) continue;   // 太短 / 零長
    if (requireSolid && _isDashedBgElement(el)) continue;   // 直實線:虛線排除
    const bb = bgPathWorldBBox(el);
    if (!bb || !bgBBoxInRange(bb, range)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

// 判定 bg 元素是否為「單段直線」(line / 單段 path / 單段 polyline,長度 > 0)
//   切面 pending 期間用來限制單擊只能選直線(同 marquee 的「直線」模式條件)
function _isStraightBgLineElement(el) {
  if (!el || !el.dataset) return false;
  if (el.dataset.bgPageBg === "1") return false;
  const tag = (el.localName || (el.tagName || "").replace(/^.*:/, "")).toLowerCase();
  if (tag !== "line" && tag !== "path" && tag !== "polyline") return false;
  const segs = (typeof svgElementToSegments === "function") ? svgElementToSegments(el) : null;
  if (!segs || segs.length !== 1) return false;
  const s = segs[0];
  if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 0.01) return false;
  return true;
}

// 判定 bg 元素是否為「虛線」(顯式 stroke-dasharray 屬性,或 inline style 的 stroke-dasharray)
function _isDashedBgElement(el) {
  const a = el.getAttribute && el.getAttribute("stroke-dasharray");
  if (a && a.trim() && a.trim() !== "none" && a.trim() !== "0") return true;
  const sty = el.style && el.style.strokeDasharray;
  if (sty && sty.trim() && sty.trim() !== "none" && sty.trim() !== "0") return true;
  return false;
}

function findDiagonalBgSegments(range, opts) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return new Set();
  const requireDashed = !!(opts && opts.requireDashed);
  const requireSolid  = !!(opts && opts.requireSolid);
  const matched = new Set();
  const angleTolDeg = 5;

  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line" && tag !== "path" && tag !== "polyline" && tag !== "polygon") continue;
    const segs = svgElementToSegments(el);
    if (segs.length === 0) continue;
    const ctm = el.getScreenCTM && el.getScreenCTM();
    const owner = el.ownerSVGElement || bgSvgEl;
    if (!ctm) continue;
    // 轉到世界座標檢查是否有斜線段
    let hasDiag = false;
    for (const s of segs) {
      const p1 = owner.createSVGPoint(); p1.x = s.x1; p1.y = s.y1;
      const p2 = owner.createSVGPoint(); p2.x = s.x2; p2.y = s.y2;
      const sp1 = p1.matrixTransform(ctm), sp2 = p2.matrixTransform(ctm);
      const w1 = screenToWorld(sp1.x, sp1.y);
      const w2 = screenToWorld(sp2.x, sp2.y);
      const dx = w2.x - w1.x, dy = w2.y - w1.y;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;     // 太短的略過
      const ang = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;  // 0..90
      const offAxis = Math.min(ang, 90 - ang);
      if (offAxis > angleTolDeg) { hasDiag = true; break; }
    }
    if (!hasDiag) continue;
    if (requireDashed && !_isDashedBgElement(el)) continue;
    if (requireSolid  &&  _isDashedBgElement(el)) continue;
    const bb = bgPathWorldBBox(el);
    if (!bb || !bgBBoxInRange(bb, range)) continue;
    matched.add(el.dataset.bgIdx);
  }
  return matched;
}

function applyBgSelectMode() {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  const active = state.tool === "selectBg";
  // 取 bgSvg 在螢幕上的實際尺寸,用來判斷哪些元素是「頁背景級」大方框
  const svgRect = active ? bgSvgEl.getBoundingClientRect() : null;
  els.forEach(el => {
    if (!active) {
      el.style.pointerEvents = "none";
      el.style.cursor = "default";
      return;
    }
    // 已標記過:直接讀 dataset,跳過 getBoundingClientRect (避免反覆 layout 重算)
    if (el.dataset.bgPageBg === "1") {
      el.style.pointerEvents = "none";
      el.style.cursor = "default";
      return;
    }
    if (el.dataset.bgChecked !== "1") {
      // 第一次:偵測是否頁背景級大方框(bbox ≥ 視口 80% 寬+80% 高)
      try {
        const r = el.getBoundingClientRect();
        if (r.width >= svgRect.width * 0.8 && r.height >= svgRect.height * 0.8) {
          el.dataset.bgPageBg = "1";
          el.dataset.bgChecked = "1";
          el.style.pointerEvents = "none";
          el.style.cursor = "default";
          return;
        }
      } catch (_) {}
      el.dataset.bgChecked = "1";
    }
    // 統一用 stroke:不管 fill / stroke 屬性值是什麼,只要游標在 perimeter 就命中
    el.style.pointerEvents = "stroke";
    el.style.cursor = "none";
  });
}

export function updateBgStrokeWidth() {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  // 底圖線寬與網格細線寬一致 — 用 CSS 變數一次設,所有 .bg-stroke 透過 inherit 取值
  // (避免逐元素 setAttribute 對上千 DXF 元素造成卡頓)
  const target = Math.max(0.2, 1 / state.zoom).toFixed(3);
  bgSvgEl.style.setProperty("--bg-sw", target + "px");
}

function applyBgRotation(file) {
  if (!file) return;
  const angle = file.rotation || 0;
  const tx = file.offsetX || 0;
  const ty = file.offsetY || 0;
  const cx = state.bgWidth / 2, cy = state.bgHeight / 2;
  const parts = [];
  if (tx || ty) parts.push(`translate(${tx}px, ${ty}px)`);
  if (angle)    parts.push(`rotate(${(angle * 180 / Math.PI).toFixed(4)}deg)`);
  const t = parts.join(" ");

  // 計算 clip 角點(若是拆分頁面有指定 clipRect)
  //   clipRect 是使用者拖出的「視覺世界座標」矩形;clip-path 卻是套在元素本地(旋轉前)
  //   座標上,所以要把世界矩形 4 個角扣回元素本地座標(反向位移 + 反向旋轉繞中心),
  //   並用 polygon 表達(任意角度的旋轉矩形不一定軸向對齊,inset 不夠用)。
  let cssClip = "";
  let clipCorners = null;
  if (file.clipRect) {
    const r = file.clipRect;
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    const corners = [
      [r.x,         r.y],
      [r.x + r.w,   r.y],
      [r.x + r.w,   r.y + r.h],
      [r.x,         r.y + r.h],
    ].map(([x, y]) => {
      const dx = (x - tx) - cx;
      const dy = (y - ty) - cy;
      return [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA];
    });
    clipCorners = corners;
    const ptsStr = corners.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(", ");
    cssClip = `polygon(${ptsStr})`;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  if (bgSvgEl) {
    bgSvgEl.style.transformOrigin = `${cx}px ${cy}px`;
    bgSvgEl.style.transform = t;
    bgSvgEl.style.clipPath = "";  // 不在 root 套 clip,改套在 bg-orig 子群組
    const orig = (typeof _ensureBgOrigGroup === "function")
      ? _ensureBgOrigGroup(bgSvgEl)
      : bgSvgEl.querySelector(":scope > g.bg-orig");
    if (orig) {
      // 用 SVG 原生 <clipPath> 套(透過 clip-path 屬性引用),比 CSS clip-path 在 <g> 上可靠
      const cp = bgSvgEl.querySelector("#bgOrigClip");
      if (clipCorners && cp) {
        while (cp.firstChild) cp.removeChild(cp.firstChild);
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", clipCorners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" "));
        cp.appendChild(poly);
        orig.setAttribute("clip-path", "url(#bgOrigClip)");
      } else {
        orig.removeAttribute("clip-path");
      }
      orig.style.clipPath = "";
    } else {
      // 沒包成 bg-orig 群組(理論上不會發生):退回 CSS clip-path 套整個 bgSvg
      bgSvgEl.style.clipPath = cssClip;
    }
  }
  bg.style.transformOrigin = `${cx}px ${cy}px`;
  bg.style.transform = t;
  bg.style.clipPath = cssClip;
}

async function renderPdfBg(pdf, n) {
  const page = await pdf.getPage(n);
  const dpr = window.devicePixelRatio || 1;
  const cssViewport = page.getViewport({ scale: state.pdfScale });
  state.bgWidth = Math.floor(cssViewport.width);
  state.bgHeight = Math.floor(cssViewport.height);

  // 移除上一頁的向量底圖(若有)
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();

  // Spinner:顯示「載入中」,讓瀏覽器有機會 paint 後再進入耗時的 sync 工作
  const sp = document.getElementById("busySpinner");
  const spMsg = sp && sp.querySelector(".msg");
  const showSpinner = (msg) => {
    if (!sp) return;
    if (spMsg) spMsg.textContent = msg || "處理中…";
    sp.classList.add("active");
  };
  const hideSpinner = () => sp && sp.classList.remove("active");
  // 在每段重活之前 yield 一拍,讓 spinner 能 paint、滑鼠保持可移動
  const yieldFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  showSpinner("載入 PDF 向量…");
  await yieldFrame();
  let usedVector = false;
  if (pdfjsLib.SVGGraphics) {
    try {
      const opList = await page.getOperatorList();
      const gfx = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
      const vSvg = await gfx.getSVG(opList, cssViewport);
      vSvg.id = "bgSvg";
      vSvg.style.position = "absolute";
      vSvg.style.left = "0";
      vSvg.style.top = "0";
      vSvg.style.width = state.bgWidth + "px";
      vSvg.style.height = state.bgHeight + "px";
      vSvg.style.pointerEvents = "none";
      vSvg.style.background = "#fff";
      // 插在 vector 描繪層之前 → 視覺位於底層
      stage.insertBefore(vSvg, svg);
      bg.style.display = "none";        // 隱藏 raster canvas
      usedVector = true;
      // 將底圖所有可能描邊的元素都套上非縮放 stroke,讓 updateBgStrokeWidth 能統一控制
      // pdf.js 常把 stroke 設在 <g> 父層而非 path 本身,所以路徑本身可能沒 stroke 屬性
      try {
        // 不自動拆分(autoSplit 在大 PDF 上太慢)
        // 使用者需要拆時可以選取後按「切成直線」按鈕手動拆
        if (spMsg) spMsg.textContent = "建立索引…";
        await yieldFrame();
        const shapes = vSvg.querySelectorAll("path, line, rect, polyline, polygon, circle, ellipse");
        const fileForBg = state.files.find(f => f.pdf === pdf);
        const sel = (fileForBg && fileForBg.selectedBgPaths) || new Set();
        const del = (fileForBg && fileForBg.deletedBgPaths) || new Set();
        // 沿父層尋找實際的 stroke 屬性
        const effStrokeOf = (el) => {
          let cur = el;
          while (cur && cur.getAttribute) {
            const v = cur.getAttribute("stroke") || (cur.style && cur.style.stroke);
            if (v && v !== "none" && v !== "") return v;
            cur = cur.parentNode;
          }
          return null;
        };
        const isWhitish = (c) => {
          if (!c) return false;
          const s = String(c).toLowerCase().trim();
          if (s === "white" || s === "#fff" || s === "#ffffff") return true;
          const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          if (m) return +m[1] >= 240 && +m[2] >= 240 && +m[3] >= 240;
          return false;
        };
        shapes.forEach((el2, idx) => {
          el2.classList.add("bg-stroke");
          el2.style.vectorEffect = "non-scaling-stroke";
          el2.dataset.bgIdx = idx;
          el2.style.cursor = "default";
          // 將白色線條改為較淺的深灰(比網格 #9aa0a6 深、但比 #444 淺),避免在白底上看不見
          const stk = effStrokeOf(el2);
          if (isWhitish(stk)) el2.style.stroke = "#777";
          if (sel.has(String(idx)) || sel.has(idx)) el2.classList.add("bg-selected");
          if (del.has(String(idx)) || del.has(idx)) el2.style.display = "none";
          attachBgPathHandlers(el2, fileForBg);
        });
        // 同步也對 group 加上 bg-stroke,以便覆蓋 group 上的 stroke-width 設定
        const groups = vSvg.querySelectorAll("g");
        for (const g of groups) g.classList.add("bg-stroke");
        updateBgStrokeWidth();
        applyBgSelectMode();
      } catch (_) { /* 無關緊要 */ }
      // 快取此頁的向量 SVG(在 try-catch 外,確保失敗會被看到):
      // pdfjs.SVGGraphics 會輸出 `svg:` 前綴(<svg:svg xmlns:svg="...">),所以 *不要* 自己注入
      // xmlns,避免破壞前綴。XMLSerializer 已能產生合法 XML。
      try {
        const fileForCache = state.files.find(f => f.pdf === pdf && f.pdfPage === n);
        if (fileForCache && vSvg) {
          let svgText = "";
          try { svgText = new XMLSerializer().serializeToString(vSvg); }
          catch (e) { svgText = vSvg.outerHTML || ""; }
          fileForCache.cachedBgSvg = svgText;
          fileForCache.cachedBgWidth = state.bgWidth;
          fileForCache.cachedBgHeight = state.bgHeight;
          console.log(`[cache:svg] ${fileForCache.name} pdfPage=${n} ${(svgText.length / 1024).toFixed(1)} KB`);
        }
      } catch (e) {
        console.error("[cache:svg] 寫快取失敗:", e);
      }
    } catch (err) {
      console.warn("PDF 向量渲染失敗,改用 raster:", err);
    }
  }

  if (!usedVector) {
    bg.style.display = "block";
    const hdViewport = page.getViewport({ scale: state.pdfScale * dpr });
    bg.width = Math.floor(hdViewport.width);
    bg.height = Math.floor(hdViewport.height);
    bg.style.width = state.bgWidth + "px";
    bg.style.height = state.bgHeight + "px";
    bgctx.setTransform(1, 0, 0, 1, 0, 0);
    await page.render({ canvasContext: bgctx, viewport: hdViewport }).promise;
    // raster 模式:把 canvas 內容快取為 dataURL
    try {
      const fileForCache = state.files.find(f => f.pdf === pdf && f.pdfPage === n);
      if (fileForCache) {
        fileForCache.cachedBgImg = bg.toDataURL("image/png");
        fileForCache.cachedBgWidth = state.bgWidth;
        fileForCache.cachedBgHeight = state.bgHeight;
        console.log(`[cache:img] ${fileForCache.name} pdfPage=${n} ${(fileForCache.cachedBgImg.length / 1024).toFixed(1)} KB`);
      }
    } catch (e) {
      console.error("[cache:img] 寫快取失敗:", e);
    }
  }

  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  fitToView();
  hideSpinner();
}

function renderBlankBg(file) {
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();
  bg.style.display = "block";
  const dpr = window.devicePixelRatio || 1;
  state.bgWidth  = file.bgWidth  || state.bgWidth  || 1200;
  state.bgHeight = file.bgHeight || state.bgHeight || 800;
  bg.width = Math.floor(state.bgWidth * dpr);
  bg.height = Math.floor(state.bgHeight * dpr);
  bg.style.width = state.bgWidth + "px";
  bg.style.height = state.bgHeight + "px";
  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgctx.fillStyle = "#fafafa"; bgctx.fillRect(0, 0, state.bgWidth, state.bgHeight);
  fitToView();
}

function renderImageBg(file) {
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();
  bg.style.display = "block";
  const img = file.image;
  const dpr = window.devicePixelRatio || 1;
  state.bgWidth = file.imageWidth; state.bgHeight = file.imageHeight;
  bg.width = Math.floor(state.bgWidth * dpr);
  bg.height = Math.floor(state.bgHeight * dpr);
  bg.style.width = state.bgWidth + "px";
  bg.style.height = state.bgHeight + "px";
  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  bgctx.clearRect(0, 0, state.bgWidth, state.bgHeight);
  bgctx.drawImage(img, 0, 0);
  // 快取為 PNG dataURL,供專案儲存使用(無需保留原始位元組)
  if (!file.cachedBgImg) {
    file.cachedBgImg = bg.toDataURL("image/png");
    file.cachedBgWidth = state.bgWidth;
    file.cachedBgHeight = state.bgHeight;
  }
  fitToView();
}

// 從快取的向量 SVG / 圖片 dataURL 重建底圖,不需 pdf.js / 原始位元組
//   bgSrc:擁有 cachedBgSvg / cachedBgImg 的檔案(可能是 sourceFile)
//   forFile:目前要顯示的檔案(若為 split / 衍生,點擊事件 handlers 仍綁到此檔)
async function renderCachedBg(bgSrc, forFile) {
  const target = forFile || bgSrc;
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();

  state.bgWidth  = bgSrc.cachedBgWidth  || state.bgWidth  || 1200;
  state.bgHeight = bgSrc.cachedBgHeight || state.bgHeight || 800;

  if (bgSrc.cachedBgSvg) {
    let svgText = bgSrc.cachedBgSvg;
    // 修復舊版序列化 bug:`<svg xmlns="...":svg ...` → `<svg:svg ...`
    if (/^<svg\s+xmlns="[^"]*":svg\b/.test(svgText)) {
      svgText = svgText.replace(/^<svg\s+xmlns="[^"]*":svg\b/, "<svg:svg");
      console.warn("[renderCachedBg] 偵測到舊版 SVG 序列化 bug,自動修復。");
    }
    // pdf.js SVGGraphics 用 `svg:` 前綴格式輸出(<svg:svg xmlns:svg="...">),DOMParser 解析後
    // tagName 會是 "svg:svg" 而非 "svg",導致下面的 tagName 檢查失敗。
    // 把 svg: 前綴整體剝掉,正規化成預設命名空間形式,並把 xmlns:svg= 改回 xmlns=。
    if (/<svg:/.test(svgText) || /xmlns:svg=/.test(svgText)) {
      svgText = svgText
        .replace(/<svg:/g, "<")
        .replace(/<\/svg:/g, "</")
        .replace(/\bxmlns:svg=/g, "xmlns=");
      console.log("[renderCachedBg] 已剝除 svg: 前綴");
    }
    console.log(`[renderCachedBg] 來源 ${bgSrc.name}・SVG ${(svgText.length/1024).toFixed(1)} KB・前 80 字: ${svgText.slice(0, 80)}`);
    // 用 DOMParser 解析 SVG 文字 → 保證命名空間正確;再 importNode 到主文件
    let newSvgBg = null;
    try {
      const parser  = new DOMParser();
      const doc     = parser.parseFromString(svgText, "image/svg+xml");
      const perr    = doc.querySelector("parsererror");
      if (perr) throw new Error("SVG parse error: " + perr.textContent);
      newSvgBg = document.importNode(doc.documentElement, true);
    } catch (e) {
      console.warn("[renderCachedBg] DOMParser 失敗,改用 innerHTML 後備:", e);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = svgText;
      newSvgBg = wrapper.querySelector("svg");
    }
    if (newSvgBg && newSvgBg.tagName && newSvgBg.tagName.toLowerCase() === "svg") {
      newSvgBg.id = "bgSvg";
      newSvgBg.style.position = "absolute";
      newSvgBg.style.left = "0";
      newSvgBg.style.top  = "0";
      newSvgBg.style.width  = state.bgWidth  + "px";
      newSvgBg.style.height = state.bgHeight + "px";
      newSvgBg.style.pointerEvents = "none";
      newSvgBg.style.background = "#fff";
      stage.insertBefore(newSvgBg, svg);
      bg.style.display = "none";
      // 重新掛上點擊事件,並還原選取狀態
      const sel = (target.selectedBgPaths) || new Set();
      const del = (target.deletedBgPaths)  || new Set();
      const shapes = newSvgBg.querySelectorAll(".bg-stroke");
      shapes.forEach(el => {
        attachBgPathHandlers(el, target);
        const key = String(el.dataset.bgIdx);
        if (sel.has(key) || sel.has(+key)) el.classList.add("bg-selected");
        if (del.has(key) || del.has(+key)) el.style.display = "none";
      });
      updateBgStrokeWidth();
      applyBgSelectMode();
    } else {
      // SVG 解析完全失敗:退回灰底,讓使用者起碼能看到模型
      console.error("[renderCachedBg] cachedBgSvg 無法解析為 <svg>,退回空白底");
      bg.style.display = "block";
      const dpr = window.devicePixelRatio || 1;
      bg.width  = Math.floor(state.bgWidth  * dpr);
      bg.height = Math.floor(state.bgHeight * dpr);
      bg.style.width  = state.bgWidth  + "px";
      bg.style.height = state.bgHeight + "px";
      bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgctx.fillStyle = "#fafafa"; bgctx.fillRect(0, 0, state.bgWidth, state.bgHeight);
    }
  } else if (bgSrc.cachedBgImg) {
    bg.style.display = "block";
    const dpr = window.devicePixelRatio || 1;
    bg.width  = Math.floor(state.bgWidth  * dpr);
    bg.height = Math.floor(state.bgHeight * dpr);
    bg.style.width  = state.bgWidth  + "px";
    bg.style.height = state.bgHeight + "px";
    bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bgctx.clearRect(0, 0, state.bgWidth, state.bgHeight);
    const img = new Image();
    img.src = bgSrc.cachedBgImg;
    await new Promise((r, rej) => { img.onload = r; img.onerror = rej; });
    bgctx.drawImage(img, 0, 0, state.bgWidth, state.bgHeight);
  }

  svg.setAttribute("width", state.bgWidth);
  svg.setAttribute("height", state.bgHeight);
  svg.setAttribute("viewBox", `0 0 ${state.bgWidth} ${state.bgHeight}`);
  fitToView();
}

// ---------- 左側欄檔案清單 ----------
// 檔案類型標籤(DXF / PDF / IMG / DXF-S / PDF-S / IMG-S / —)
//   拆分(split / 衍生)檔:沿用來源檔的類型 + "-S" 後綴
function fileTypeLabel(f) {
  if (!f) return "";
  // 沿著 sourceFileId 鏈往上找到根來源檔
  let cur = f, isSplit = false, guard = 0;
  while (cur && cur.sourceFileId && guard < 16) {
    isSplit = true;
    const next = state.files.find(x => x.id === cur.sourceFileId);
    if (!next || next === cur) break;
    cur = next;
    guard++;
  }
  let base;
  if (cur.type === "application/dxf") base = "DXF";
  else if (cur.type === "application/pdf" || cur.pdf) base = "PDF";
  else if (cur.type && String(cur.type).startsWith("image/")) base = "IMG";
  else base = "—";
  return isSplit ? base + "-S" : base;
}
// 檔案平面標記:讀第 1 頁的 plane / page.z,給檔案清單上的 badge 用
//   單頁:回傳該頁的 plane(XY/XZ/YZ);若是 XZ 且有 page.z 就附上 @標高
//   多頁且 plane 不一致:回傳 "Multi"
//   未設 plane:回傳 "—"
// 回傳 { plane: { text, title, cls }, axis: { text, title } | null }
//   plane:平面標籤(XY / XZ / YZ / Multi / —)
//   axis:第三軸數值標籤(若有 firstPg.z),沒有就回 null
function filePlaneLabel(f) {
  const empty = { plane: { text: "—", title: "未設定平面", cls: "plane-none" }, axis: null };
  if (!f || !f.pages) return empty;
  const keys = Object.keys(f.pages);
  if (!keys.length) return empty;
  const planes = new Set();
  let firstPg = null;
  for (const k of keys) {
    const pg = f.pages[k];
    if (!pg) continue;
    if (!firstPg) firstPg = pg;
    if (pg.plane) planes.add(pg.plane);
  }
  if (!planes.size) return empty;
  if (planes.size > 1) {
    return { plane: { text: "Multi", title: `多頁不同平面:${[...planes].join(", ")}`, cls: "plane-multi" }, axis: null };
  }
  const plane = [...planes][0];
  const cls = "plane-" + plane.toLowerCase();
  const axisName = plane === "XZ" ? "Y" : plane === "YZ" ? "X" : "Z";
  let title = `${plane} 平面`;
  let axis = null;
  if (firstPg && firstPg.z != null && isFinite(firstPg.z)) {
    if (plane === "XZ")      title += `(Y 軸標高 = ${firstPg.z})`;
    else if (plane === "XY") title += `(Z 深度 = ${firstPg.z})`;
    else if (plane === "YZ") title += `(X 位置 = ${firstPg.z})`;
    axis = { text: String(firstPg.z), title: `第三軸 ${axisName} = ${firstPg.z}` };
  }
  return { plane: { text: plane, title, cls }, axis };
}

// 座標 / 長度顯示精度:預設 DXF=2 位、其他=0 位;
// 使用者可在左欄「顯示設定 → 座標小數位數」覆寫(state.coordDecimals,0~6)
function fmtCoord(v) {
  if (v == null || !isFinite(v)) return "?";
  let n = state.coordDecimals;
  if (n == null || !isFinite(n) || n < 0) {
    const f = getActiveFile();
    n = (f && f.type === "application/dxf") ? 2 : 0;
  }
  let s = v.toFixed(Math.min(6, Math.max(0, n)));
  // 正規化 "-0" / "-0.0" / "-0.00..." → "0…",避免顯示負零
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s;
}

// 3D 世界座標專用的格式化器:用「精準度設定」(state.measureDecimals)而非
//   「座標小數位數」(state.coordDecimals)。這樣 rank bucket / xlsx / 側欄 / popup
//   都用同一個精準度,顯示值與 bucket key 永遠對齊(不會出現側欄顯示 4005、bucket
//   是 4005、xlsx 寫 4005.23 的錯位)。length / delta / px 維度仍走 fmtCoord。
function fmtWorld3D(v) {
  if (v == null || !isFinite(v)) return "?";
  let n = state.measureDecimals;
  if (n == null || !isFinite(n) || n < 0) n = 0;
  let s = v.toFixed(Math.min(6, Math.max(0, n)));
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s;
}

export function refreshFileList() {
  const c = $("fileList");
  if (!c) return;
  c.innerHTML = "";
  if (!state.files.length) {
    c.innerHTML = `<div style="color:#9aa0a6;font-size:11px;padding:6px">${(typeof _t==="function"&&_t("list.noFiles"))||"尚未載入任何檔案"}</div>`;
    return;
  }
  // 排序規則:Y 軸標高由大到小(僅 XZ 平面有效,其他無 Y 標高的檔放後面),其次依名稱
  //   - 取每個 file 第 1 頁的 page.z 當代表(平面圖 XZ 的本頁 Y 標高)
  //   - 若 file 有任何 XZ 頁面 → 用該頁 z;否則 z = -Infinity 排到後面
  //   - z 相同(或皆無)→ 用 localeCompare(numeric)
  const fileElev = (f) => {
    if (!f.pages) return -Infinity;
    let best = -Infinity;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (pg && pg.plane === "XZ" && pg.z != null && isFinite(pg.z)) {
        if (pg.z > best) best = pg.z;
      }
    }
    return best;
  };
  const sorted = [...state.files].sort((a, b) => {
    const za = fileElev(a), zb = fileElev(b);
    if (za !== zb) return zb - za;     // Y 大的在前
    // 名稱倒序(Z..A、numeric 9..1)— 跟切面對話框 / 切面 section 清單一致
    return String(b.name).localeCompare(String(a.name), undefined, { numeric: true, sensitivity: "base" });
  });
  // 渲染完成後把「可見順序」記到每個 file 上,以便 Shift 範圍選取使用
  sorted.forEach((f, idx) => { f._listIdx = idx; });
  for (const f of sorted) {
    const div = document.createElement("div");
    div.className = "file-item";
    if (state.activeFileId === f.id) div.classList.add("active");
    if (state.selection.fileIds.has(f.id)) div.classList.add("sel");
    div.title = f.name;          // 完整檔名 native tooltip
    const pg = (f.pages && f.pages[0]) || null;
    const show = state.fileListShow || { type: true, plane: true, stats: true };
    const nameSpan = document.createElement("span");
    nameSpan.className = "file-name";
    const isOriginFile = (state.globalOriginFileId === f.id);
    nameSpan.textContent = (isOriginFile ? "★ " : "") + f.name;
    if (isOriginFile) {
      nameSpan.style.color = "#ffd23f";
      nameSpan.title = `全局原點檔案:本檔的 planeOrigin + pageZ 即為世界 (0,0,0)\n${f.name}`;
    }
    if (show.type !== false) {
      const typeLbl = fileTypeLabel(f);
      const typeSpan = document.createElement("span");
      typeSpan.className = "file-type " + typeLbl.toLowerCase();
      typeSpan.textContent = typeLbl;
      div.appendChild(typeSpan);
    }
    div.appendChild(nameSpan);
    if (show.plane !== false) {
      const lbl = filePlaneLabel(f);
      const planeSpan = document.createElement("span");
      planeSpan.className = "file-plane";
      planeSpan.textContent = lbl.plane.text;
      planeSpan.title = lbl.plane.title;
      if (lbl.plane.cls) planeSpan.classList.add(lbl.plane.cls);
      div.appendChild(planeSpan);
      if (lbl.axis) {
        const axisSpan = document.createElement("span");
        axisSpan.className = "file-plane file-axis";
        axisSpan.textContent = lbl.axis.text;
        axisSpan.title = lbl.axis.title;
        if (lbl.plane.cls) axisSpan.classList.add(lbl.plane.cls);
        div.appendChild(axisSpan);
      }
      // 主關聯 badge:檔案 sectionLinks 內有非 autoProp 的 entry 才顯示。
      //   設計信念:「主關聯」一律掛在 sectionLinks 上(autoProp 是衍生),
      //   所以跨平面衍生的目標頁不會誤標(它們本身的 sectionLinks 不含這些衍生)。
      const hasPrimary = Array.isArray(f.sectionLinks) && f.sectionLinks.some(e => !e.autoProp);
      if (hasPrimary) {
        const primCount = f.sectionLinks.filter(e => !e.autoProp).length;
        const primSpan = document.createElement("span");
        primSpan.className = "file-plane file-primary";
        primSpan.textContent = "主";
        primSpan.title = `本頁有 ${primCount} 條主關聯切面`;
        div.appendChild(primSpan);
      }
    }
    if (show.stats !== false) {
      const stats = pg ? `${pg.joints.length}節 ${pg.members.length}桿` : "—";
      const statsSpan = document.createElement("span");
      statsSpan.className = "file-stats";
      statsSpan.textContent = stats;
      div.appendChild(statsSpan);
    }
    div.onclick = (e) => {
      const ctrl  = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      if (shift && state.selection.fileAnchor != null) {
        // Shift:anchor → 本次點擊的可見索引區間全選
        const anchor = state.files.find(ff => ff.id === state.selection.fileAnchor);
        const a = anchor ? anchor._listIdx : f._listIdx;
        const b = f._listIdx;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        state.selection.fileIds.clear();
        for (const ff of sorted) {
          if (ff._listIdx >= lo && ff._listIdx <= hi) state.selection.fileIds.add(ff.id);
        }
        refreshFileList();
      } else if (ctrl) {
        // Ctrl / Cmd:切換單一項目
        if (state.selection.fileIds.has(f.id)) state.selection.fileIds.delete(f.id);
        else state.selection.fileIds.add(f.id);
        state.selection.fileAnchor = f.id;
        refreshFileList();
      } else {
        // 一般點擊:單選,並切到該檔頁面
        state.selection.fileIds.clear();
        state.selection.fileIds.add(f.id);
        state.selection.fileAnchor = f.id;
        activatePageWithBusy(f.id, 0);
      }
    };
    div.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!state.selection.fileIds.has(f.id)) {
        state.selection.fileIds.clear();
        state.selection.fileIds.add(f.id);
        state.selection.fileAnchor = f.id;
      }
      showFileCtxMenu(e.clientX, e.clientY);
      refreshFileList();
    };
    c.appendChild(div);
  }
}

function showFileCtxMenu(x, y) {
  if (!state.selection.fileIds.size) return;
  ctxPending = {
    fileIds: new Set(state.selection.fileIds),
    joints: new Set(), members: new Set(), orphans: new Set(),
  };
  $("ctxRename").style.display = (ctxPending.fileIds.size === 1) ? "block" : "none";
  $("ctxDuplicate") && ($("ctxDuplicate").style.display = (ctxPending.fileIds.size === 1) ? "block" : "none");
  $("ctxOpenTab") && ($("ctxOpenTab").style.display = "block");
  $("ctxDelete").style.display = "block";
  $("ctxFilterGroup").style.display = "none";
  $("ctxBgSplit").style.display = "none";
  $("ctxBgScaleRuler") && ($("ctxBgScaleRuler").style.display = "none");
  $("ctxBgToMember").style.display = "none";
  $("ctxBgToDashed") && ($("ctxBgToDashed").style.display = "none");
  $("ctxHead").textContent = `已選取 ${ctxPending.fileIds.size} 個檔案`;
  const list = $("ctxList");
  list.innerHTML = "";
  for (const fid of ctxPending.fileIds) {
    const f = state.files.find(ff => ff.id === fid);
    if (!f) continue;
    const d = document.createElement("div");
    d.className = "ctx-list-item";
    d.title = f.name;
    d.textContent = f.name;
    list.appendChild(d);
  }
  const m = $("ctxMenu");
  m.style.display = "flex";
  m.style.left = "0px"; m.style.top = "0px";
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + "px";
  m.style.top  = Math.min(y, window.innerHeight - h - 4) + "px";
}

function deleteSelectedFiles() {
  if (!state.selection.fileIds.size) return;
  // 一律跳出確認訊息:列出即將刪除的檔案名稱
  const ids = new Set(state.selection.fileIds);
  const names = state.files.filter(f => ids.has(f.id)).map(f => f.name);
  const msg = names.length === 1
    ? `確定刪除檔案「${names[0]}」?\n此動作會一併移除其所有標線、比例尺、原點等資料。`
    : `確定刪除以下 ${names.length} 個檔案?\n此動作會一併移除其所有標線、比例尺、原點等資料。\n\n${names.map(n => "• " + n).join("\n")}`;
  if (!confirm(msg)) return;
  pushUndo();
  // 在移除之前:若有其他檔案以 sourceFileId 指向即將被刪的檔案,先把底圖資料搬移給仍存活的依賴檔,
  // 並修正其他依賴檔的 sourceFileId 指向新主,避免原圖被刪後衍生檔變空白。
  for (const deletingId of ids) {
    const src = state.files.find(f => f.id === deletingId);
    if (!src) continue;
    const dependents = state.files.filter(f =>
      !ids.has(f.id) && (f.sourceFileId === deletingId || f.sourceFileId === src.sourceFileId && f.id !== deletingId)
    );
    if (!dependents.length) continue;
    // 選一個存活的依賴檔接手(優先挑本來就缺 own 快取的;否則選第一個)
    const heir = dependents.find(f => !f.pdf && !f.image && !f.cachedBgSvg && !f.cachedBgImg) || dependents[0];
    if (src.pdf && !heir.pdf) { heir.pdf = src.pdf; heir.pdfPage = heir.pdfPage || src.pdfPage; }
    if (src.image && !heir.image) {
      heir.image = src.image;
      heir.imageWidth  = heir.imageWidth  || src.imageWidth;
      heir.imageHeight = heir.imageHeight || src.imageHeight;
    }
    if (src.cachedBgSvg && !heir.cachedBgSvg) heir.cachedBgSvg = src.cachedBgSvg;
    if (src.cachedBgImg && !heir.cachedBgImg) heir.cachedBgImg = src.cachedBgImg;
    if (src.cachedBgWidth  && !heir.cachedBgWidth)  heir.cachedBgWidth  = src.cachedBgWidth;
    if (src.cachedBgHeight && !heir.cachedBgHeight) heir.cachedBgHeight = src.cachedBgHeight;
    if (src.detectedStrokeWidth && !heir.detectedStrokeWidth) heir.detectedStrokeWidth = src.detectedStrokeWidth;
    heir.sourceFileId = null;   // 它現在是自己的主檔
    // 其他依賴檔全部改指向 heir
    for (const d of dependents) if (d !== heir && d.sourceFileId === deletingId) d.sourceFileId = heir.id;
    console.log(`[刪除] ${src.name} 的底圖資料轉移給 ${heir.name}(${dependents.length - 1} 個其他依賴檔改指向)`);
  }
  // 清掉其他檔的 primary section link 中,指向「即將被刪」這幾個檔的 targetFileIds —
  //   不清掉的話會留下指向已不存在 file id 的 dangling reference,
  //   切面 section list 會出現「→ ?」、衍生計算也會撞到 missing target 而靜默濾掉。
  const slCleanup = [];
  for (const f of state.files) {
    if (ids.has(f.id)) continue;          // 自己也要被刪 → 反正整檔會丟,不用清 sectionLinks
    if (!Array.isArray(f.sectionLinks) || !f.sectionLinks.length) continue;
    const keep = [];
    for (const e of f.sectionLinks) {
      if (e.autoProp || !Array.isArray(e.targetFileIds)) { keep.push(e); continue; }
      const before = e.targetFileIds.slice();
      const after = before.filter(t => !ids.has(t));
      if (after.length === before.length) { keep.push(e); continue; }
      const dropped = before.filter(t => ids.has(t));
      if (after.length === 0) {
        slCleanup.push({ host: f.name, entryId: e.id, action: "remove-entry", droppedTargets: dropped });
      } else {
        e.targetFileIds = after;
        slCleanup.push({ host: f.name, entryId: e.id, action: "trim-targets", droppedTargets: dropped, remaining: after.slice() });
        keep.push(e);
      }
    }
    if (keep.length !== f.sectionLinks.length) f.sectionLinks = keep;
  }
  if (slCleanup.length) console.log("[刪除] 清理其他檔的主關聯 targetFileIds:", slCleanup);
  state.files = state.files.filter(f => !ids.has(f.id));
  state.selection.fileIds.clear();
  if (!state.files.find(f => f.id === state.activeFileId)) {
    const next = state.files[0];
    if (next) { activatePage(next.id, 0); return; }
    state.activeFileId = null; state.pageIdx = 0;
    initBlank();
  }
  refreshFileList(); refreshPageSelector();
  if (typeof refreshTabBar === "function") refreshTabBar();
  render(); refreshLists();
}

export function refreshPageSelector() {
  const sel = $("pageSelector");
  if (!sel) return;
  sel.innerHTML = "";
  for (const f of state.files) {
    for (let i = 0; i < f.pageCount; i++) {
      const opt = document.createElement("option");
      opt.value = `${f.id}/${i}`;
      const pg = (f.pages && f.pages[i]) || null;
      const stats = pg ? ` (${pg.joints.length}節 ${pg.members.length}桿)` : "";
      opt.textContent = `${f.name}${f.pdf ? ` · 第${i + 1}頁` : ""}${stats}`;
      if (state.activeFileId === f.id && state.pageIdx === i) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  if (!sel.children.length) {
    const opt = document.createElement("option");
    opt.textContent = (typeof _t === "function" && _t("rb.pageNotLoaded")) || "尚未載入";
    opt.disabled = true;
    sel.appendChild(opt);
  }
}

// ---------- pan/zoom ----------
// 互動中標記:滾輪 / 平移期間打開 body.interacting,閒置 250ms 後拿掉
//   目的:讓 stage 暫時 promote 成 GPU layer 加速 zoom/pan,但結束後重新 raster → 細線維持清晰
let _interactingTimer = null;
function markInteracting() {
  document.body.classList.add("interacting");
  if (_interactingTimer) clearTimeout(_interactingTimer);
  _interactingTimer = setTimeout(() => {
    document.body.classList.remove("interacting");
    _interactingTimer = null;
  }, 250);
}

wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  markInteracting();
  const r = wrap.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const factor = Math.exp(-e.deltaY * 0.0015);
  const wx = (mx - state.panX) / state.zoom;
  const wy = (my - state.panY) / state.zoom;
  state.zoom *= factor;
  state.zoom = Math.max(0.0001, Math.min(50, state.zoom));
  state.panX = mx - wx * state.zoom;
  state.panY = my - wy * state.zoom;
  applyTransform();
  render();
}, { passive: false });

let panning = false, panStart = null;
let mouseDownPos = null;
let alignDrag = null;     // 手動對齊拖曳:{ startX, startY, startRot, snapshotPushed }
let dragMove = null;      // 選取後拖曳節點:{ startX, startY, positions:Map, axis, moved }
export let cKeyDown = false;     // C 鍵按住中:對線段點擊會在中點插入新節點
wrap.addEventListener("mousedown", (e) => {
  if (state.rangeZoomMode && e.button === 0) {
    // 範圍放大:mousedown 記錄拖曳起點,mouseup 依位移判定拖曳 / 點擊
    const r = wrap.getBoundingClientRect();
    rangeZoomDragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    e.preventDefault();
    return;
  }
  if (state.splitMode && e.button === 0) {
    // 拆分模式靠 click 處理(點兩下對角),mousedown 純粹擋掉
    e.preventDefault();
    return;
  }
  if (state.manualAlign.active && e.button === 0) {
    const file = getActiveFile();
    if (file) {
      pushUndo();
      alignDrag = {
        startX: e.clientX, startY: e.clientY,
        startOffsetX: file.offsetX || 0,
        startOffsetY: file.offsetY || 0,
        axis: null,
      };
    }
    e.preventDefault(); e.stopPropagation();
    return;
  }
  if (e.button === 0) mouseDownPos = { x: e.clientX, y: e.clientY };
  if (e.button === 1 || (e.button === 0 && state.spaceDown)) {
    panning = true; panStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
    wrap.style.cursor = "grabbing";
    e.preventDefault();
    return;
  }
  if (e.button === 0 && (state.tool === "select" || state.tool === "selectBg")) {
    const tag = e.target && e.target.tagName;
    if (state.tool === "select" && (tag === "circle" || tag === "line")) return;
    if (e.target && e.target.closest && e.target.closest("#labelsLayer")) return;
    // 底圖 sub-mode(畫直線 / 畫虛線 / 複製線 / 中分線 / 等分線 / 切面定位)進行中 → 不啟動匡選,
    //   避免拖曳時順手把 bg 線選起來造成「選取狀態」干擾這些連續流程。
    //   切面 pending 不在此列 — 切面要靠選取一條直線(下方 _bgSvgDelegateClick 會把選取限制成只允許直線)
    if ((state.bgDrawLine && state.bgDrawLine.active)
        || (state.bgCopyLine && state.bgCopyLine.active)
        || (state.bgBisector && state.bgBisector.active)
        || (state.bgEqui && state.bgEqui.active)
        || state.sectionLinkPlacing) {
      return;
    }
    const w = screenToWorld(e.clientX, e.clientY);
    const isBg = (state.tool === "selectBg");
    state.marquee = {
      x1: w.x, y1: w.y, x2: w.x, y2: w.y,
      additive: additiveSelect(e) || (isBg && state.bgMultiSelect),
      subtract: subtractiveSelect(e),
      moved: false, bg: isBg
    };
    e.preventDefault();
  }
});
window.addEventListener("mousemove", (e) => {
  if (alignDrag) {
    const file = getActiveFile();
    if (file) {
      let dx = (e.clientX - alignDrag.startX) / state.zoom;
      let dy = (e.clientY - alignDrag.startY) / state.zoom;
      // 按住 Shift → 鎖定軸向(依拖曳起始的優勢方向決定一次)
      if (e.shiftKey && !alignDrag.axis) {
        const adx = Math.abs(e.clientX - alignDrag.startX);
        const ady = Math.abs(e.clientY - alignDrag.startY);
        if (adx + ady > 4) alignDrag.axis = adx >= ady ? "x" : "y";
      }
      if (e.shiftKey && alignDrag.axis === "x") dy = 0;
      else if (e.shiftKey && alignDrag.axis === "y") dx = 0;
      file.offsetX = alignDrag.startOffsetX + dx;
      file.offsetY = alignDrag.startOffsetY + dy;
      applyBgRotation(file);
      const u = state.scale ? `${(file.offsetX / state.scale).toFixed(2)} , ${(file.offsetY / state.scale).toFixed(2)} ${state.unitName}`
                            : `${file.offsetX.toFixed(0)} , ${file.offsetY.toFixed(0)} px`;
      const lockTag = (e.shiftKey && alignDrag.axis) ? `  軸鎖:${alignDrag.axis === "x" ? "水平" : "垂直"}` : "";
      $("hud").textContent = `底圖偏移:${u}${lockTag}  (Esc 完成)`;
    }
    return;
  }
  if (panning) {
    markInteracting();
    state.panX = panStart.panX + (e.clientX - panStart.x);
    state.panY = panStart.panY + (e.clientY - panStart.y);
    applyTransform();
    render();    // 標號在 stage 外,需跟著平移重新計算螢幕位置
  } else if (state.marquee) {
    const w = screenToWorld(e.clientX, e.clientY);
    state.marquee.x2 = w.x; state.marquee.y2 = w.y;
    if (Math.hypot(w.x - state.marquee.x1, w.y - state.marquee.y1) * state.zoom > 3) {
      state.marquee.moved = true;
    }
    render();
  }
});
window.addEventListener("mouseup", (e) => {
  if (state.rangeZoomMode && rangeZoomDragStart) {
    const r = wrap.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const start = rangeZoomDragStart;
    rangeZoomDragStart = null;
    const dx = mx - start.x, dy = my - start.y;
    if (Math.hypot(dx, dy) > 4) {
      // 真的有拖曳 → 直接以拖曳矩形完成範圍放大,並抑制緊接的 click 事件
      rangeZoomSuppressClick = true;
      setTimeout(() => { rangeZoomSuppressClick = false; }, 0);
      finalizeRangeZoomRect(start.x, start.y, mx, my);
      return;
    }
    // 位移很小 → 視為點擊,讓 click handler 接手(兩段式點擊)
  }
  if (alignDrag) { alignDrag = null; return; }
  if (state.marquee && state.marquee.moved) {
    // 記下最近一次的框選矩形,供「拆分為新頁」使用
    const m = state.marquee;
    state.lastMarquee = {
      x: Math.min(m.x1, m.x2), y: Math.min(m.y1, m.y2),
      w: Math.abs(m.x2 - m.x1), h: Math.abs(m.y2 - m.y1),
    };
  }
  panning = false;
  if (!state.manualAlign.active) wrap.style.cursor = state.spaceDown ? "grab" : "none";
  if (state.marquee) {
    const m = state.marquee;
    state.marquee = null;
    if (m.moved) {
      const crossing = m.x2 < m.x1;
      const x1 = Math.min(m.x1, m.x2), y1 = Math.min(m.y1, m.y2);
      const x2 = Math.max(m.x1, m.x2), y2 = Math.max(m.y1, m.y2);
      if (m.bg) {
        // 修改底圖模式:用 getBoundingClientRect → 螢幕座標 → 世界座標,正確處理底圖父層 transform
        const file = getActiveFile();
        const bgSvgEl = document.getElementById("bgSvg");
        // 形狀匡選子模式(正方形/長方形/圓形/斜線):範圍內只挑符合形狀的元素
        // - subtract 模式 → 把符合的從選取移除;否則(預設或 additive)→ 加入
        if (state.bgShapeMarquee && state.bgShapeMarquee.size > 0 && file && bgSvgEl) {
          // 形狀匡選(正方形 / 長方形 / 圓形 / 斜線)是 O(N × 形狀檢查),
          // DXF 上千元素時可能要幾百毫秒 → 用 withBusy 把工作延到 rAF 之後並顯示處理中
          const r = { x1, y1, x2, y2, crossing };
          const modes = [...state.bgShapeMarquee];
          withBusy("處理形狀匡選中…", async () => {
            if (!m.additive && !m.subtract) clearAllBgSelection(file);
            if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
            const hits = new Set();
            for (const mode of modes) {
              let s = null;
              if (mode === "square" || mode === "rect") s = findRectangleBgLines(mode, r);
              else if (mode === "circle")               s = findCircleBgPaths(r);
              else if (mode === "diagonal")             s = findDiagonalBgSegments(r, { requireSolid: true });
              else if (mode === "dashedDiagonal")       s = findDiagonalBgSegments(r, { requireDashed: true });
              else if (mode === "straight")             s = findStraightBgLines(r);
              else if (mode === "straightSolid")        s = findStraightBgLines(r, { requireSolid: true });
              if (s) s.forEach(id => hits.add(String(id)));
              await busyTick();
            }
            for (const id of hits) {
              const elx = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(id)}"]`);
              if (m.subtract) {
                file.selectedBgPaths.delete(id);
                if (elx) elx.classList.remove("bg-selected");
              } else {
                file.selectedBgPaths.add(id);
                if (elx) elx.classList.add("bg-selected");
              }
            }
            updateBgEditOpsVisibility();
            checkBgPendingAfterSelect();
            render();
          });
          return;
        }
        if (file && bgSvgEl) {
          if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
          // pending 模式下保留既有選取(累加),不清空
          const inPending = state.originPending || state.scaleRulerPending;
          if (!m.additive && !m.subtract && !inPending) clearAllBgSelection(file);
          const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
          // 元素很多時(DXF 常見上千個)迴圈中的 getBoundingClientRect 會強制 layout 重算 → 顯示處理中
          const heavy = els.length > 500;
          if (heavy) showBusy(`匡選中…(${els.length} 個元素)`);
          els.forEach(el2 => {
            if (el2.dataset.bgPageBg === "1") return;   // 跳過頁背景級大方框
            try {
              const cr = el2.getBoundingClientRect();
              if (cr.width === 0 && cr.height === 0) return;
              const tl = screenToWorld(cr.left, cr.top);
              const br = screenToWorld(cr.right, cr.bottom);
              const rx1 = Math.min(tl.x, br.x), ry1 = Math.min(tl.y, br.y);
              const rx2 = Math.max(tl.x, br.x), ry2 = Math.max(tl.y, br.y);
              const intersects = !(rx1 > x2 || rx2 < x1 || ry1 > y2 || ry2 < y1);
              const fully = (rx1 >= x1 && rx2 <= x2 && ry1 >= y1 && ry2 <= y2);
              const hit = crossing ? intersects : fully;
              if (!hit) return;
              const key = String(el2.dataset.bgIdx);
              if (m.subtract) {
                file.selectedBgPaths.delete(key);
                el2.classList.remove("bg-selected");
              } else {
                file.selectedBgPaths.add(key);
                el2.classList.add("bg-selected");
              }
            } catch (_) {}
          });
          updateBgEditOpsVisibility();
          // 匡選結束後同樣跑 pending 後處理(讓拖框 2 條也能觸發)
          checkBgPendingAfterSelect();
          if (heavy) hideBusy();
        }
        render();
        return;
      }
      if (!m.additive && !m.subtract) clearSelection();
      const p = getPage();
      const inside = (j) => j.x >= x1 && j.x <= x2 && j.y >= y1 && j.y <= y2;
      const f = state.selectFilter;
      if (f === "all" || f === "joints") {
        for (const j of p.joints) if (inside(j)) {
          if (m.subtract) state.selection.joints.delete(j.id);
          else            state.selection.joints.add(j.id);
        }
        _markSelectionSourceIfEmpty();   // 框選成功也記 source page
      }
      if (f === "all" || f === "members") {
        for (const mem of p.members) {
          const a = jointById(mem.j1), b = jointById(mem.j2);
          if (!a || !b) continue;
          const inA = inside(a), inB = inside(b);
          let hit = false;
          if (crossing) hit = inA || inB || segIntersectsRect(a, b, x1, y1, x2, y2);
          else          hit = inA && inB;
          if (!hit) continue;
          if (m.subtract) state.selection.members.delete(mem.id);
          else            state.selection.members.add(mem.id);
        }
      }
      render(); refreshLists();        // 只有真的拖曳才需要重畫
    }
  }
});

function segIntersectsRect(a, b, x1, y1, x2, y2) {
  // assumes a or b not already inside (caller handles); test against 4 rect edges
  const corners = [
    { x: x1, y: y1 }, { x: x2, y: y1 },
    { x: x2, y: y2 }, { x: x1, y: y2 },
  ];
  for (let i = 0; i < 4; i++) {
    const c = corners[i], d = corners[(i + 1) % 4];
    if (segCrosses(a, b, c, d)) return true;
  }
  return false;
}
function segCrosses(p1, p2, p3, p4) {
  const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2);
  const d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // collinear edge touching counts too
  return false;
}

window.addEventListener("keydown", (e) => {
  // Alt / Option 鍵狀態追蹤(供 bgDrawLine 預覽切換 bg path 優先吸附)
  if (e.key === "Alt" && !state.altDown) {
    state.altDown = true;
    if (state.bgDrawLine && state.bgDrawLine.active) render();
  }
  // Cmd/Ctrl+S 儲存專案 — 即使在輸入框也允許,避免被瀏覽器的「儲存網頁」攔走
  // 必須放在 inEditable bail 前
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    _startSaveWithHook(!!e.shiftKey);
    return;
  }
  // Cmd/Ctrl+[  返回上一個畫面位置(類似 IntelliJ「Back」)
  // Cmd/Ctrl+]  前進到下一個畫面位置(類似 IntelliJ「Forward」)
  // 也擋下瀏覽器預設的「上下一頁」行為。Shift 不影響(避免跟其他組合衝突)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "[" || e.key === "]")) {
    e.preventDefault();
    if (e.key === "[") navBack(); else navForward();
    return;
  }
  // 在輸入框 / 下拉 / textarea 中時,其他全域快捷鍵不處理
  // (對話框內的 Esc / Enter 由各自 input 的 keydown listener 處理)
  const inEditable = e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA";
  if (inEditable) return;

  // 移動中的鎖定切換:free / dist 模式下,按 Shift = 鎖水平、Alt = 鎖垂直
  // (避免用 Ctrl — macOS 的 Ctrl+click 會被 OS 攔成 right-click,跟我們的 contextmenu 衝突)
  if (state.moveMode.active && state.moveMode.base) {
    const t = state.moveMode.type;
    if (t === "free" || t === "dist") {
      let chg = false;
      if (e.shiftKey && state.moveMode.lock !== "h") { state.moveMode.lock = "h"; chg = true; }
      else if (e.altKey && state.moveMode.lock !== "v") { state.moveMode.lock = "v"; chg = true; }
      if (chg) render();
    }
  }

  // C(無 Shift)
  // - 若已選取桿件 → 一次性把所有選取桿件中分(50% 中點)
  // - 否則 → 設為「插入中點」修飾鍵(按住 C + 點線段)
  if (!e.shiftKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "c") {
    e.preventDefault();
    if (!e.repeat && state.selection.members.size > 0) {
      splitSelectedAtMidpoint();
      return;
    }
    if (!cKeyDown) console.log("[C down] cKeyDown -> true");
    cKeyDown = true;
    return;
  }
  // Shift+工具切換快捷鍵
  if (e.shiftKey && !(e.metaKey || e.ctrlKey)) {
    const k = e.key.toLowerCase();
    if (k === "w") { e.preventDefault(); openPlanePicker(); return; }
    if (k === "l") { e.preventDefault(); setTool("line"); return; }
    if (k === "p") { e.preventDefault(); setTool("point"); return; }
    if (k === "c") {
      e.preventDefault();
      setTool(state.tool === "selectBg" ? "select" : "selectBg");
      return;
    }
    if (k === "i") { e.preventDefault(); processIntersections(); return; }
    if (k === "d") { e.preventDefault(); performDelete(); return; }
    if (k === "a") { e.preventDefault(); cycleSnapGrid(); return; }
    if (k === "m") { e.preventDefault(); startMoveMode(); return; }
    if (k === "s") {
      if (e.repeat) return;
      e.preventDefault();
      if (state.tool !== "select") setTool("select");
      state.multiSelectSticky = !state.multiSelectSticky;
      updateSelectToolLabel();
      $("hud").textContent = state.multiSelectSticky
        ? "多選模式:點選會累加(Shift+S 切回選取)"
        : "選取模式:點選取代既有(Shift+S 切換多選)";
      render();
      return;
    }
  }
  // Cmd/Ctrl+Z 復原 · Cmd/Ctrl+Shift+Z(或 Ctrl+Y)重做
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault(); redo(); return;
  }
  // Cmd/Ctrl+S 已在 inEditable 檢查之前處理,這裡不重複
  if (mod && e.key.toLowerCase() === "a" && state.tool === "selectBg") {
    e.preventDefault();
    selectAllBgPaths();
    return;
  }
  if (e.key === "Tab" && state.tool === "select") {
    e.preventDefault();
    cycleSelectFilter();
    return;
  }
  if (e.code === "Space") { state.spaceDown = true; wrap.style.cursor = "grab"; e.preventDefault(); }
  else if (e.key === "Shift") { state.ortho = !state.ortho; render(); }
  else if (e.shiftKey && e.key.toLowerCase() === "m") startMoveMode();
  else if (e.key === "Escape") {
    const apDlg = $("autoPairDialog");
    if (apDlg && apDlg.style.display === "flex") { closeAutoPairDialog(); return; }
    if (state.scaleRulerDrag && state.scaleRulerDrag.active) {
      cancelScaleRulerDrag();
      return;
    }
    if (state.bgDrawLine && state.bgDrawLine.active) {
      exitBgDrawLine("已取消畫直線");
      return;
    }
    if (state.bgCopyLine && state.bgCopyLine.active) {
      exitBgCopyLine("已取消複製線");
      return;
    }
    if (state.bgBisector && state.bgBisector.active) {
      exitBgBisector("已取消中分線");
      return;
    }
    if (state.bgEqui && state.bgEqui.active) {
      exitBgEqui("已取消等分線");
      return;
    }
    if (state.scaleRulerPending) {
      exitScaleRulerPending();
      $("hud").textContent = "已取消比例尺";
      return;
    }
    if (state.sectionLinkPending) {
      exitSectionLinkPending(true);
      const af = getActiveFile();
      if (af) clearAllBgSelection(af);
      $("hud").textContent = "已取消切面";
      render();
      return;
    }
    if (state.sectionLinkPlacing) {
      const prevTool = state.sectionLinkPlacing.prevTool;
      state.sectionLinkPlacing = null;
      if (prevTool && prevTool !== "selectBg" && prevTool !== state.tool) setTool(prevTool);
      $("hud").textContent = "已取消切面定位";
      render();
      return;
    }
    if (state.measurePending || state.measure) {
      // Esc 行為:
      //   - 若 state.measure 在 sliding 中且來自清單(re-edit) → 還原原位置,放回清單
      //   - 若 state.measure 是新建(_fromList=false) → 丟棄(等於取消這次新增)
      //   - 若 measurePending 中(尚未挑線) → 結束 pending
      //   - 已固化的 file.measurements 不會被 Esc 清掉,要刪請從右側欄清單或刪除按鈕
      if (state.measure && state.measure.sliding) {
        if (state.measure._fromList) {
          // 還原 backup → 放回清單
          state.measure.p1 = { ...state.measure._backup.p1 };
          state.measure.p2 = { ...state.measure._backup.p2 };
          state.measure.sliding = false;
          delete state.measure._backup;
          delete state.measure._fromList;
          _persistCurrentMeasure();
          $("hud").textContent = "已還原標示距離原本位置";
        } else {
          // 新建中按 Esc → 丟棄(不加入清單)
          state.measure = null;
          $("hud").textContent = "已取消新增標示距離";
        }
      } else if (state.measurePending) {
        $("hud").textContent = "已取消標示距離";
      }
      exitMeasurePending();
      const af = getActiveFile();
      if (af) clearAllBgSelection(af);
      if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
      render();
      return;
    }
    if (state.pendingGlobalPair != null) {
      state.pendingGlobalPair = null;
      $("hud").textContent = "已取消全局節點配對";
      render();
      return;
    }
    if (state.rangeZoomMode) { exitRangeZoom(); $("hud").textContent = ""; return; }
    if (state.originPending) {
      exitOriginPending();
      $("hud").textContent = "";
      return;
    }
    if (state.splitMode) { exitSplitMode(); return; }
    if (state.moveMode.active) { exitMoveMode(); return; }
    if (state.manualAlign.active) { exitManualAlign(); return; }
    if (state.tool === "selectBg") {
      hideCtxMenu();
      // 優先取消形狀匡選子模式(正方形/長方形/圓形/斜線)
      if (state.bgShapeMarquee && state.bgShapeMarquee.size > 0) {
        clearAllShapeMarqueeModes();
        return;
      }
      // 其次:多線選取模式
      if (state.bgMultiSelect) {
        state.bgMultiSelect = false;
        $("bgEditMultiSelect") && $("bgEditMultiSelect").classList.remove("active");
        updateBgEditOpsVisibility();
        $("hud").textContent = "x: 0 · y: 0 · zoom: 100%";
        return;
      }
      const file = getActiveFile();
      if (file && file.selectedBgPaths && file.selectedBgPaths.size > 0) {
        clearAllBgSelection(file);          // 先清掉選取
      } else {
        setTool("select");                  // 沒選取時 Esc 直接退出修改底圖模式
      }
      return;
    }
    hideCtxMenu();
    state.pendingLineStart = null;
    render();
  }
  else if (e.key === "Delete" || e.key === "Backspace") performDelete();
});
window.addEventListener("keyup", (e) => {
  if (e.key && e.key.toLowerCase() === "c") { cKeyDown = false; console.log("[C up] cKeyDown -> false"); }
  if (e.key === "Alt") { state.altDown = false; if (state.bgDrawLine && state.bgDrawLine.active) render(); }
  if (e.code === "Space") { state.spaceDown = false; wrap.style.cursor = "none"; }
  else if (e.key === "Shift") {
    commitPendingFilter();              // 放開 Shift → 確認 popup 中的選取模式
    state.ortho = !state.ortho;
    render();
  }
  // 移動中釋放 Shift / Alt → 解除 lock
  if (state.moveMode.active && (e.key === "Shift" || e.key === "Alt")) {
    if (state.moveMode.lock) { state.moveMode.lock = null; render(); }
  }
});

// ---------- tools ----------
export function setTool(t) {
  // 從修改底圖模式切到其他工具時,清空所有底圖選取
  const wasBgsel = (state.tool === "selectBg");
  if (wasBgsel && t !== "selectBg") {
    const f = getActiveFile();
    if (f) clearAllBgSelection(f);
    // 離開 selectBg → 若還卡在切線關聯 pending,一併結束(避免殘留 state)
    if (state.sectionLinkPending) {
      state.sectionLinkPending = false;
      state.sectionLinkPrevTool = null;
      $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
      _restoreSectionLinkShapeMarquee();
    }
    // 離開 selectBg → 連帶關掉所有底圖 sub-mode(畫直線 / 複製線 / 中分線 / 等分線)
    if (state.bgDrawLine && state.bgDrawLine.active) exitBgDrawLine();
    if (state.bgCopyLine && state.bgCopyLine.active) exitBgCopyLine();
    if (state.bgBisector && state.bgBisector.active) exitBgBisector();
    if (state.bgEqui && state.bgEqui.active) exitBgEqui();
  }
  state.tool = t;
  state.pendingLineStart = null;
  // bg 元素很多(DXF 常見)時,進 / 離 selectBg 都會 iterate 所有元素設 pointer-events,
  // 阻塞 UI 數百 ms。用 withBusy 顯示「處理中」並把工作 defer 到下一幀,讓 spinner 先 paint
  const bgSvgEl = document.getElementById("bgSvg");
  const bgCount = bgSvgEl ? bgSvgEl.querySelectorAll("[data-bg-idx]").length : 0;
  const heavy = bgCount > 500 && (t === "selectBg" || wasBgsel);
  const finish = () => {
    applyBgSelectMode && applyBgSelectMode();
    if (typeof applyBgVisibility === "function") applyBgVisibility();
    if ($("bgEditTools")) $("bgEditTools").style.display = (t === "selectBg") ? "flex" : "none";
    if ($("selectTools")) $("selectTools").style.display = (t === "select") ? "flex" : "none";
    if (typeof applyToolbarBounds === "function") applyToolbarBounds();
    if (t === "selectBg") updateBgEditOpsVisibility && updateBgEditOpsVisibility();
    _setToolFinishVisuals(t);
  };
  if (heavy) {
    withBusy(`處理底圖中…(${bgCount} 個元素)`, finish);
  } else {
    finish();
  }
  // 視覺狀態(✓ + active)立即更新,不等 heavy work
  _setToolFinishVisuals(t);
  return;
}
export function _setToolFinishVisuals(t) {
  // 工具按鈕視覺狀態:active 加藍底(✓ 打勾已移除,僅保留底色變化)
  //   i18n:用 _setBtnLabel 同步 .btn-text 的 data-i18n,讓語言切換能跟著翻譯,且 icon 保留
  const toolMap = [
    { id: "tool-line",   t: "line",     key: "tb.toolLine",   fb: "桿件" },
    { id: "tool-point",  t: "point",    key: "tb.toolPoint",  fb: "節點" },
    { id: "tool-select", t: "select",
      key: state.multiSelectSticky ? "tb.toolMulti" : "tb.toolSelect",
      fb:  state.multiSelectSticky ? "多選"          : "選取" },
    { id: "tool-bgsel",  t: "selectBg", key: "tb.toolBgSel",  fb: "底圖" },
  ];
  for (const { id, t: kt, key, fb } of toolMap) {
    const btn = $(id); if (!btn) continue;
    const isActive = (t === kt);
    btn.classList.toggle("active", isActive);
    _setBtnLabel(btn, key, fb);
  }
  render();
}
// 阻止工具列/HUD 的點擊冒泡到畫布(否則會誤建節點或啟動框選)
["toolbar", "tabBar", "hud", "zoomTools"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  ["click", "mousedown", "mouseup", "dblclick", "wheel"].forEach((ev) =>
    el.addEventListener(ev, (e) => e.stopPropagation()));
});

$("tool-line").onclick = () => setTool("line");
$("tool-point") && ($("tool-point").onclick = () => setTool("point"));
$("tool-select").onclick = () => setTool("select");
$("tool-bgsel").onclick = () => setTool(state.tool === "selectBg" ? "select" : "selectBg");
export function withBusy(msg, fn) {
  const sp = document.getElementById("busySpinner");
  if (!sp) { fn(); return; }
  const m = sp.querySelector(".msg"); if (m) m.textContent = msg || "處理中…";
  sp.classList.add("active");
  // 連續兩個 rAF:確保 spinner 先 paint 再執行運算,避免被同步任務阻塞而看不見
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    try {
      const r = fn();
      if (r && typeof r.then === "function") await r;   // 支援 async fn
    } finally {
      sp.classList.remove("active");
    }
  }));
}
// 比例尺(工具列):進入修改底圖並等待選取 2 條平行線,選完自動建立比例尺,再進入沿線拖曳
$("btnScaleRuler") && ($("btnScaleRuler").onclick = () => {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  // 退出衝突模式
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
  if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) cancelScaleRulerDrag();
  if (state.originPending) exitOriginPending();
  clearSelection();
  clearAllBgSelection(file);
  state.scaleRulerPending = true;
  if (state.tool !== "selectBg") setTool("selectBg");
  $("hud").textContent = "比例尺:請選第一條平行線(Esc 取消)";
  updateScaleRulerButton();
  render();
});
function exitScaleRulerPending() {
  if (!state.scaleRulerPending) return;
  state.scaleRulerPending = false;
  updateScaleRulerButton();
}

// ---------- 標示距離(只讀,不寫,持續顯示直到 Esc 或重新測量) ----------
function exitMeasurePending() {
  if (!state.measurePending) return;
  state.measurePending = false;
}
// 用世界座標 + state.scale 把距離格式化成「<數字> <單位>」(小數位數由 state.measureDecimals 控制)
function formatMeasureDistance(distWorld) {
  const dec = _measureDec();
  if (state.scale && state.scale > 0) {
    const mm = distWorld / state.scale;
    return { text: `${mm.toFixed(dec)} ${state.unitName || "mm"}`, mm };
  }
  return { text: `${distWorld.toFixed(dec)} px`, mm: null };
}
// 取得目前測量小數位數(0~6;預設 2)
function _measureDec() {
  const v = state.measureDecimals;
  if (Number.isFinite(v) && v >= 0 && v <= 6) return Math.floor(v);
  return 2;
}
// 改完 state.measureDecimals 後,把所有檔案 + 編輯中的測量 label 重新生成
function _refreshAllMeasurementLabels() {
  const dec = _measureDec();
  const u = state.unitName || "mm";
  for (const f of state.files) {
    if (!Array.isArray(f.measurements)) continue;
    const ratio = (f.scaleRuler && f.scaleRuler.ratio > 0) ? f.scaleRuler.ratio : null;
    for (const m of f.measurements) {
      if (ratio && Number.isFinite(m.distance)) {
        m.label = `${(m.distance * ratio).toFixed(dec)} ${u}`;
      }
    }
  }
  if (state.measure && Number.isFinite(state.measure.distance) && state.scale && state.scale > 0) {
    state.measure.label = `${(state.measure.distance / state.scale).toFixed(dec)} ${u}`;
  }
}
// 通用 measure compute:從一組 world line endpoints 算出 single / parallel measurement
//   1 條 → 單線長度
//   2+ 條 → 找第一對「平行且非共線」的線當參考(支援 N 選 2)
//   回傳 measure 物件(含 dx/dy 沿線方向供 slide 使用)或 null
function computeMeasureFromLines(lines) {
  if (!lines || !lines.length) return null;
  if (lines.length === 1) {
    const L = lines[0];
    const d = Math.hypot(L.p2.x - L.p1.x, L.p2.y - L.p1.y);
    if (d < 1e-3) return null;
    const ux = (L.p2.x - L.p1.x) / d, uy = (L.p2.y - L.p1.y) / d;
    // 單線標示距離 slide 方向 = 垂直於線(法向);把 dx/dy 設成法向,
    //   使用者拖游標就能把整條標示距離線從 bg 線位置移開,避免兩線重疊看不見
    const nx = -uy, ny = ux;
    const f = formatMeasureDistance(d);
    return { kind: "single", p1: L.p1, p2: L.p2, distance: d, label: f.text, dx: nx, dy: ny };
  }
  // 2+ 條:找第一對平行且非共線的
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const L1 = lines[i], L2 = lines[j];
      const v1 = { x: L1.p2.x - L1.p1.x, y: L1.p2.y - L1.p1.y };
      const v2 = { x: L2.p2.x - L2.p1.x, y: L2.p2.y - L2.p1.y };
      const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
      if (len1 < 1e-6 || len2 < 1e-6) continue;
      const sinTheta = Math.abs((v1.x * v2.y - v1.y * v2.x) / (len1 * len2));
      if (sinTheta > 0.05) continue;       // 不平行
      const m1 = { x: (L1.p1.x + L1.p2.x) / 2, y: (L1.p1.y + L1.p2.y) / 2 };
      const t = ((m1.x - L2.p1.x) * v2.x + (m1.y - L2.p1.y) * v2.y) / (len2 * len2);
      const proj = { x: L2.p1.x + t * v2.x, y: L2.p1.y + t * v2.y };
      const d = Math.hypot(proj.x - m1.x, proj.y - m1.y);
      if (d < 1e-3) continue;              // 共線(零距)→ 找下一對
      const angDeg = Math.asin(Math.min(1, sinTheta)) * 180 / Math.PI;
      const f = formatMeasureDistance(d);
      let label = f.text;
      if (angDeg > 5) label += `(夾角 ${angDeg.toFixed(1)}°)`;
      const ux = v1.x / len1, uy = v1.y / len1;
      return { kind: "parallel", p1: m1, p2: proj, distance: d, label, dx: ux, dy: uy };
    }
  }
  return null;
}

// 從目前 active 模式的選取收集「世界座標下的線段端點陣列」
function collectMeasureLinesFromCurrentSelection() {
  if (state.tool === "selectBg") {
    const file = getActiveFile();
    if (!file) return [];
    return _selectedBgLinesAsWorld(file);
  }
  // 選取模式:用選取的 members
  const p = getPage();
  if (!p) return [];
  const out = [];
  for (const id of (state.selection.members || [])) {
    const m = p.members.find(mm => mm.id === id);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) continue;
    out.push({ p1: { x: a.x, y: a.y }, p2: { x: b.x, y: b.y } });
  }
  return out;
}

// 確保 file.measurements / _nextMeasureId 已初始化
function _ensureFileMeasurements(file) {
  if (!file) return null;
  if (!Array.isArray(file.measurements)) file.measurements = [];
  if (!file._nextMeasureId) file._nextMeasureId = 1;
  return file.measurements;
}
// 把目前 state.measure(剛建/重編)固化進 file.measurements,清掉 state.measure
function _persistCurrentMeasure() {
  if (!state.measure) return;
  const file = getActiveFile();
  if (!file) { state.measure = null; return; }
  const list = _ensureFileMeasurements(file);
  const m = state.measure;
  const id = m.id || (file._nextMeasureId++);
  list.push({
    id,
    kind: m.kind,
    p1: { x: m.p1.x, y: m.p1.y },
    p2: { x: m.p2.x, y: m.p2.y },
    distance: m.distance,
    label: m.label,
    dx: m.dx, dy: m.dy,
  });
  state.measure = null;
}
// 啟動標示距離:依當前選取算出 measurement,進入「slide 沿線移動」模式直到使用者點擊確認
function startMeasureFromCurrentSelection() {
  const lines = collectMeasureLinesFromCurrentSelection();
  if (!lines.length) {
    // 沒選 → 進 pending(僅在 bgEdit 模式有意義)
    if (state.tool === "selectBg") startMeasurePending();
    else alert("請先選取 1 條桿件(單線長度)或 2+ 條桿件(平行線距離)");
    return;
  }
  const m = computeMeasureFromLines(lines);
  if (!m) {
    if (lines.length === 1) alert("線段長度為 0");
    else alert(`找不到平行的兩條線(已嘗試 ${lines.length} 條),標示距離無法成立`);
    return;
  }
  pushUndo();
  // 若有正在編輯的 → 先固化(避免遺失)
  if (state.measure) _persistCurrentMeasure();
  state.measure = { ...m, _backup: { p1: { ...m.p1 }, p2: { ...m.p2 } }, sliding: true, _fromList: false };
  $("hud").textContent = `標示距離:${m.label} — 滑鼠沿線移動可滑動位置,點擊確認 / Esc 取消`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}

// 沿線移動:把 p1/p2 從 backup 加上 (dx,dy) * t 偏移
function updateMeasureSlide(clientX, clientY) {
  const m = state.measure;
  if (!m || !m.sliding || !m._backup) return;
  const w = screenToWorld(clientX, clientY);
  const cx = (m._backup.p1.x + m._backup.p2.x) / 2;
  const cy = (m._backup.p1.y + m._backup.p2.y) / 2;
  const t = (w.x - cx) * m.dx + (w.y - cy) * m.dy;
  m.p1 = { x: m._backup.p1.x + m.dx * t, y: m._backup.p1.y + m.dy * t };
  m.p2 = { x: m._backup.p2.x + m.dx * t, y: m._backup.p2.y + m.dy * t };
  render();
}
// 點擊確認 → 把 state.measure 固化進 file.measurements
function commitMeasureSlide() {
  if (!state.measure || !state.measure.sliding) return;
  const lbl = state.measure.label;
  _persistCurrentMeasure();
  $("hud").textContent = `標示距離已加入:${lbl}(永久保留;按右側欄清單刪除)`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}
// 重新進入標示距離 slide:從 file.measurements 取最後一條(或指定 id)出來重編,直到再次 commit
function reenterMeasureSlide(measureId) {
  const file = getActiveFile();
  const list = file && Array.isArray(file.measurements) ? file.measurements : [];
  if (!list.length && !state.measure) {
    alert("尚無標示距離可移動。請先用「標示距離」量一條線或兩條平行線。");
    return;
  }
  // 進入 slide 前把其他 pending 模式關掉,避免衝突
  if (state.measurePending) state.measurePending = false;
  if (state.bgDrawLine && state.bgDrawLine.active) exitBgDrawLine();
  if (state.bgCopyLine && state.bgCopyLine.active) exitBgCopyLine();
  if (state.bgBisector && state.bgBisector.active) exitBgBisector();
  if (state.bgEqui && state.bgEqui.active) exitBgEqui();
  // 若有正在編輯的 → 先固化
  if (state.measure) _persistCurrentMeasure();
  // 取目標 entry(指定 id 或最後一筆),從清單拿出來放回 state.measure
  let idx;
  if (measureId != null) idx = list.findIndex(m => m.id === measureId);
  else idx = list.length - 1;
  if (idx < 0) { alert("找不到要移動的標示距離"); return; }
  const target = list.splice(idx, 1)[0];
  state.measure = {
    ...target,
    _backup: { p1: { ...target.p1 }, p2: { ...target.p2 } },
    _fromList: true,
    sliding: true,
  };
  $("hud").textContent = `標示距離:${target.label} — 滑鼠移動可滑動位置,點擊確認 / Esc 還原`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}
// 刪除指定 / 最後一筆標示距離
//   measureId 給定 → 該筆(可能在 file.measurements 或正在編輯的 state.measure)
//   未指定 → 優先刪正在編輯中的(最新),否則刪 file.measurements 的最後一筆
function deleteMeasurement(measureId) {
  const file = getActiveFile();
  if (measureId != null) {
    if (file && Array.isArray(file.measurements)) {
      const idx = file.measurements.findIndex(m => m.id === measureId);
      if (idx >= 0) {
        pushUndo();
        file.measurements.splice(idx, 1);
        if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
        render();
        return true;
      }
    }
    if (state.measure && state.measure.id === measureId) {
      pushUndo();
      state.measure = null;
      if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
      render();
      return true;
    }
    return false;
  }
  // 未指定 id → 刪最後 / 編輯中
  if (state.measure) {
    pushUndo();
    state.measure = null;
    if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
    render();
    return true;
  }
  if (file && Array.isArray(file.measurements) && file.measurements.length) {
    pushUndo();
    file.measurements.pop();
    if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
    render();
    return true;
  }
  return false;
}
// 清空所有標示距離(active file)
function clearAllMeasurements() {
  const file = getActiveFile();
  if (!file) return;
  const n = (file.measurements || []).length + (state.measure ? 1 : 0);
  if (!n) return;
  if (!confirm(`確定刪除這個檔案上所有 ${n} 個標示距離?`)) return;
  pushUndo();
  file.measurements = [];
  state.measure = null;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}

// 舊 API 名稱,保留給 pending 流程在 checkBgPendingAfterSelect 內呼叫
function bgComputeMeasureFromSelection() {
  const lines = collectMeasureLinesFromCurrentSelection();
  if (!lines.length) return false;
  const m = computeMeasureFromLines(lines);
  if (!m) return false;
  pushUndo();
  if (state.measure) _persistCurrentMeasure();
  state.measure = { ...m, _backup: { p1: { ...m.p1 }, p2: { ...m.p2 } }, sliding: true, _fromList: false };
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  return true;
}
function startMeasurePending() {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active) exitMoveMode();
  if (state.manualAlign && state.manualAlign.active) exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) cancelScaleRulerDrag();
  if (state.originPending) exitOriginPending();
  if (state.scaleRulerPending) exitScaleRulerPending();
  clearSelection();
  clearAllBgSelection(file);
  state.measurePending = true;
  if (state.tool !== "selectBg") setTool("selectBg");
  $("hud").textContent = "標示距離:請選第一條線(再選一條 = 兩線垂直距離,Esc 取消)";
  render();
}

// 點 / 匡選 完成後,如果在 比例尺 / 座標原點 pending 狀態,依目前選取數量決定下一步 HUD 提示或自動建立
function checkBgPendingAfterSelect() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths) return;
  const n = file.selectedBgPaths.size;
  // 共線的線視為同一條,例如 DXF 把一條軸線拆成多段、或使用者點到同一線兩處
  const dn = distinctSelectedLineCount(file);
  const bgSvgEl = document.getElementById("bgSvg");

  if (state.scaleRulerPending) {
    if (dn === 0) {
      $("hud").textContent = "比例尺:請選第一條平行線(Esc 取消)";
    } else if (dn === 1) {
      const extra = n > 1 ? ` (${n} 條共線視為 1 條)` : "";
      $("hud").textContent = `比例尺:已選第一條${extra} — 請選第二條平行線(Esc 取消)`;
    } else if (dn === 2) {
      const before = file.scaleRuler;
      try { bgCreateScaleRulerByTwoLines(); } catch (_) {}
      if (file.scaleRuler && file.scaleRuler !== before) {
        exitScaleRulerPending();
        clearAllBgSelection(file);
        $("hud").textContent = "比例尺已建立 — 移動滑鼠調整位置,點擊確定 / Esc 取消";
        startScaleRulerDrag();
      } else {
        clearAllBgSelection(file);
        $("hud").textContent = "比例尺:兩線無效或已取消,請重新選取第一條平行線(Esc 取消)";
      }
    } else {
      $("hud").textContent = `比例尺:已選 ${dn} 條獨立線(需剛好 2 條)— Cmd/Ctrl+點擊移除多餘,或 Esc 重來`;
    }
  } else if (state.originPending) {
    if (dn === 0) {
      $("hud").textContent = "座標原點:請選第一條相交線(Esc 取消);完成後同平面其他頁面會一起對齊";
    } else if (dn === 1) {
      const extra = n > 1 ? ` (${n} 條共線視為 1 條)` : "";
      $("hud").textContent = `座標原點:已選第一條${extra} — 請選第二條相交線(Esc 取消);完成後同平面其他頁面會一起對齊`;
    } else if (dn >= 2) {
      // dn ≥ 2:嘗試建立(若多條共同收斂到一點 → 用該點;否則失敗)
      const before = file.planeOrigin;
      try { bgCreatePlaneOrigin(); } catch (_) {}
      if (file.planeOrigin && file.planeOrigin !== before) {
        exitOriginPending();
        clearAllBgSelection(file);
        setTool("select");
      } else {
        // 不收斂或失敗 → 維持 pending,清掉重來
        clearAllBgSelection(file);
        $("hud").textContent = `座標原點:${dn} 條獨立線交點不收斂,請重新選取第一條相交線(Esc 取消);完成後同平面其他頁面會一起對齊`;
      }
    }
  } else if (state.measurePending) {
    if (n === 0) {
      $("hud").textContent = "標示距離:請選第一條線(Esc 取消)";
    } else if (n === 1) {
      // 暫顯示單線長度,但 pending 仍開放讓使用者選第二條(轉成平行標示距離)
      bgComputeMeasureFromSelection();
      $("hud").textContent = `標示距離:${state.measure.label} — 再選第二條 = 兩線垂直距離(Esc 結束)`;
      render();
    } else if (n === 2) {
      if (bgComputeMeasureFromSelection()) {
        exitMeasurePending();
        $("hud").textContent = `標示距離:${state.measure.label}(Esc 清除)`;
        render();
      } else {
        clearAllBgSelection(file);
        $("hud").textContent = "標示距離:兩線無效,請重新選取第一條線(Esc 取消)";
      }
    } else {
      $("hud").textContent = `標示距離:已選 ${n} 條(需 1 或 2 條)— Cmd/Ctrl+點擊移除多餘,或 Esc 重來`;
    }
  } else if (state.sectionLinkPending) {
    // 切面關聯:dn===1 → 立刻跳出對話框(不等 Enter);dn>1 → 提示需清除多餘
    if (dn === 0) {
      $("hud").textContent = "切面:請選底圖切線(Esc 取消)";
    } else if (dn === 1) {
      const dlg = document.getElementById("sectionLinkDialog");
      const already = dlg && dlg.classList.contains("active");
      if (!already) {
        const lines = _selectedBgLinesAsWorld(file);
        if (lines.length) openSectionLinkDialog(file, lines[0]);
      }
    } else {
      $("hud").textContent = `切面:選到 ${dn} 條獨立線,切線必須是單一條 — 請 Cmd/Ctrl+點擊移除多餘`;
    }
  }
}
$("btnCalibrate") && ($("btnCalibrate").onclick = calibratePlane);
// 重新計算 3D 座標(當頁):3D 永遠是 live 算的,本鈕只跑校準變動共同收尾
//   (rank 失效 + globalJoint 重 infer + UI 重整 + 重畫)當作緊急 manual safety net。
//   實際上會跨頁全模型刷新(因為 globalJoint / rank 是 model-wide);命名「當頁」是
//   使用情境語意 — 「我剛改了這頁的校準,幫我刷一遍」。
$("btnRecomputeWorld") && ($("btnRecomputeWorld").onclick = () => {
  const f = getActiveFile();
  const pg = getPage();
  if (!f || !pg || pg._orphan) { alert("請先選擇一個有效頁面"); return; }
  pushUndo();
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  if ($("hud")) $("hud").textContent = "已重算 3D 座標(本頁觸發 ・ 全模型同步刷新)";
});
// 座標原點(工具列):統一行為(原本「座標原點」+「新座標原點」合併為單一按鈕)
//   1) 選取模式下選了 1 個節點 → 直接以節點為原點
//   2) 沒選節點 + bg 模式還沒選線 → 進入底圖選 2 條相交線
//   3) bg 模式下已經選了 2 條相交線 → 立刻以交點為原點
//   每個分支都會用 _applyNewPlaneOriginToAllSamePlane 傳播:同平面其他頁面跟著同步原點,並重算切面 cutValue / 目標 page.z
$("btnPlaneOrigin") && ($("btnPlaneOrigin").onclick = () => {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  // 捷徑 (1):選取模式下 1 個節點被選中 → 立刻以節點為原點(propagate)
  if (state.selection && state.selection.joints && state.selection.joints.size === 1) {
    const jid = [...state.selection.joints][0];
    const j = jointById(jid);
    if (j) {
      const r = _applyNewPlaneOriginToAllSamePlane(file, { x: j.x, y: j.y });
      if ($("hud")) {
        const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
        $("hud").textContent = `座標原點已設為節點 J${displayJointId(j)}・同平面其他 ${r.changed} 頁已同步對齊${slTail}`;
      }
      return;
    }
  }
  // 捷徑 (3):bg 模式下已選 ≥ 2 條相交線 → 立刻以交點為原點(propagate)
  if (file.selectedBgPaths && file.selectedBgPaths.size >= 2) {
    const distinct = distinctSelectedLineCount(file);
    if (distinct >= 2) {
      const pt = bgComputeOriginFromSelection(file);
      if (pt) {
        const r = _applyNewPlaneOriginToAllSamePlane(file, { x: pt.x, y: pt.y });
        if ($("hud")) {
          const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
          $("hud").textContent = `座標原點已設定・同平面其他 ${r.changed} 頁已同步對齊${slTail}`;
        }
        return;
      }
    }
  }
  // 一般流程 (2):進入底圖模式等待選 2 條相交線
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
  if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  clearSelection();
  clearAllBgSelection(file);
  state.originPending = true;
  if (state.tool !== "selectBg") setTool("selectBg");
  $("btnPlaneOrigin").classList.add("active");
  $("hud").textContent = "座標原點:請選第一條相交線(Esc 取消);完成後同平面其他頁面會一起對齊";
  render();
});
// 修正本檔原點:只動本檔的 planeOrigin + pg.z + sectionLinks cutValue,其他檔案不動;完成後自動跳全局校準
$("btnFixLocalOrigin") && ($("btnFixLocalOrigin").onclick = () => {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  // 捷徑 (1):選 1 個節點 → 立刻以節點為原點(僅本檔)
  if (state.selection && state.selection.joints && state.selection.joints.size === 1) {
    const jid = [...state.selection.joints][0];
    const j = jointById(jid);
    if (j) {
      const prev = state.originPending;
      state.originPending = "local";
      bgCreatePlaneOrigin();
      state.originPending = prev;
      return;
    }
  }
  // 捷徑 (3):bg 模式已選 ≥ 2 條 → 立刻取交點(僅本檔)
  if (file.selectedBgPaths && file.selectedBgPaths.size >= 2) {
    const distinct = distinctSelectedLineCount(file);
    if (distinct >= 2) {
      const prev = state.originPending;
      state.originPending = "local";
      bgCreatePlaneOrigin();
      state.originPending = prev;
      return;
    }
  }
  // 一般流程 (2):進入底圖模式等待選 2 條相交線
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
  if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  clearSelection();
  clearAllBgSelection(file);
  state.originPending = "local";
  if (state.tool !== "selectBg") setTool("selectBg");
  $("btnFixLocalOrigin").classList.add("active");
  $("hud").textContent = "修正本檔原點:請選第一條相交線(Esc 取消);只動本檔 planeOrigin pixel,其他全不動";
  render();
});
function exitOriginPending() {
  if (!state.originPending) return;
  state.originPending = false;
  if ($("btnFixLocalOrigin")) $("btnFixLocalOrigin").classList.remove("active");
  updatePlaneOriginButton && updatePlaneOriginButton();
}
// 把 file 上所有主切面關聯的 cutValue 用「目前 planeOrigin」重新算,並同步目標檔 page.z。
// 何時呼叫:任何讓 file.planeOrigin 變動的動作之後(設定 / 修改 / 重設 都算)。
// 設計信念:p1 / p2 是像素,不會跟著原點移動;cutValue 是世界座標,原點換了就會位移,
//   不重算的話切面就會跑到錯誤的世界 plane 上(目標檔的 page.z 也會跟錯誤的 cutValue 對不上)。
export function _resyncSectionLinksForFile(file) {
  if (!file || !Array.isArray(file.sectionLinks) || !file.sectionLinks.length) {
    return { slUpdated: 0, tgtZUpdated: 0 };
  }
  let slUpdated = 0, tgtZUpdated = 0;
  const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
  const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
  const factor = Math.pow(10, decimals);
  for (const e of file.sectionLinks) {
    if (e.autoProp) continue;
    const info = _analyzeSectionLineAxis(file, e);
    if (!info) continue;
    e.cutAxis = info.cutAxis;
    e.cutValue = info.cutValue;
    slUpdated++;
    const newZ = Math.round(e.cutValue * factor) / factor;
    for (const tid of (e.targetFileIds || [])) {
      const tf = state.files.find(x => x.id === tid);
      if (!tf || !tf.pages) continue;
      const tp = tf.pages[0];
      if (!tp || !tp.plane) continue;
      if (depthOf[tp.plane] !== e.cutAxis) continue;
      if (tp.z === newZ) continue;
      tp.z = newZ;
      tgtZUpdated++;
    }
  }
  return { slUpdated, tgtZUpdated };
}
// 設定 / 重設座標原點:跨平面對齊整個世界框架。
//   作法:
//     1) 在「設原點之前」先記錄目標物理點(將要當新原點的位置)在 *目前舊原點* 框架下的世界座標 Wnew
//     2) 本頁 planeOrigin 改成新像素位置;本頁 page.z 減掉 Wnew[depth](通常 → 0)
//     3) 其他每個檔案(任何平面):planeOrigin 改成「物理點 Wnew 在該檔的舊像素」,
//        每頁的 page.z 各自減掉 Wnew[該頁深度軸];整個世界框架同步平移 -Wnew。
//   這樣:節點 / 桿件 / 切面標線的「物理位置」都不動;只有世界座標的數字改了(平移到新原點)。
//   切面 cutValue、目標檔 page.z 在後段自動重算 → 切面線仍維持在原本的標示位置。
function _applyNewPlaneOriginToAllSamePlane(activeFile, newPxOnActive) {
  if (!activeFile) return { changed: 0 };
  const activePage = activeFile.pages && activeFile.pages[state.pageIdx];
  if (!activePage) return { changed: 0 };
  const plane = activePage.plane;
  if (!plane) { alert("此頁尚未設定『世界平面』,無法傳播。"); return { changed: 0 }; }
  // 「不是新的原點」→ 不做事(避免 pushUndo / 重算切面)
  const oldO = activeFile.planeOrigin;
  if (oldO && Math.abs(oldO.x - newPxOnActive.x) < 1e-6 && Math.abs(oldO.y - newPxOnActive.y) < 1e-6) {
    return { changed: 0, slUpdated: 0, tgtZUpdated: 0, noChange: true };
  }
  // 必須要有 ratio 才能換算
  const haveRatio = !!((activeFile.scaleRuler && activeFile.scaleRuler.ratio > 0) || state.scale);
  if (!haveRatio) {
    // 沒 ratio:只設本頁,不做傳播
    pushUndo();
    activeFile.planeOrigin = { x: newPxOnActive.x, y: newPxOnActive.y };
    updateCalibrateButton(); updatePlaneOriginButton && updatePlaneOriginButton();
    if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
    else { refreshLists && refreshLists(); render(); }
    return { changed: 0 };
  }
  // 用「舊」origin 計算 Wnew(物理點變新世界原點時,在舊世界座標下的 3D 座標)
  const Wnew = joint2DToWorld3D(activeFile, activePage, { x: newPxOnActive.x, y: newPxOnActive.y });
  if (!Wnew) return { changed: 0 };
  pushUndo();
  // 全世界框架要平移 -Wnew。先處理本頁:
  //   • planeOrigin → 直接設成新像素位置(in-plane 軸 0 點)
  //   • page.z(深度軸值) → 減掉 Wnew[depth];對本頁就是減掉自己的舊 page.z → 變 0
  //   為避免浮點累積誤差(ratio 有小數 → joint2DToWorld3D 結果可能多到 10⁻¹³ 級別的尾數),
  //   每個 page.z 減完後都四捨五入到顯示精度(state.coordDecimals);若離整數很近也吃進整數。
  const depthOfPlane = { XY: "z", XZ: "y", YZ: "x" };
  const _zDecimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
  const _zFactor = Math.pow(10, _zDecimals);
  const _roundZ = (v) => {
    if (!Number.isFinite(v)) return v;
    const r = Math.round(v * _zFactor) / _zFactor;
    return r === 0 ? 0 : r;     // 規範化 -0 → 0
  };
  activeFile.planeOrigin = { x: newPxOnActive.x, y: newPxOnActive.y };
  {
    const dA = depthOfPlane[activePage.plane];
    if (dA && Number.isFinite(Wnew[dA])) {
      activePage.z = _roundZ((Number.isFinite(activePage.z) ? activePage.z : 0) - Wnew[dA]);
    }
  }
  // 其他所有檔案(不分平面,只要有 planeOrigin + scaleRuler):把世界框架同步平移 -Wnew
  //   做法:在 *舊* 框架下,找出物理點 Wnew 在該檔的像素 → 設為新 planeOrigin;
  //         該檔每頁的 page.z 各自減去 Wnew[該頁深度軸](並四捨五入到顯示精度)。
  let changed = 0;
  for (const f of state.files) {
    if (f === activeFile) continue;
    if (!f.pages) continue;
    if (!f.scaleRuler || !(f.scaleRuler.ratio > 0)) continue;
    if (!f.planeOrigin) continue;
    const P0 = f.pages[0];
    if (!P0 || !P0.plane) continue;
    const inv = world3DToJoint2D(f, P0, Wnew, { tol: 1e9 });
    if (!inv || !inv.ok) continue;
    f.planeOrigin = { x: inv.x, y: inv.y };
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan || !pg.plane) continue;
      const d = depthOfPlane[pg.plane];
      if (d && Number.isFinite(Wnew[d])) {
        pg.z = _roundZ((Number.isFinite(pg.z) ? pg.z : 0) - Wnew[d]);
      }
    }
    changed++;
  }
  // ── 重設原點 → 切線像素不動,只更新 cutValue(用新原點重算)──
  //   設計:p1 / p2 是使用者在「畫面上」標的物理位置,不該因為原點換了就移動。
  //   原點 → 世界座標數值會變,所以 cutValue 跟著重算。因為「全世界框架」都跟著平移
  //   (不只本平面),所以 *所有* 檔案上的切面 cutValue 都要重算 — 不能只跑同平面那幾個。
  let slUpdated = 0, tgtZUpdated = 0;
  for (const f of state.files) {
    const fp = f.pages && f.pages[0];
    if (!fp || !fp.plane) continue;
    const r = _resyncSectionLinksForFile(f);
    slUpdated += r.slUpdated;
    tgtZUpdated += r.tgtZUpdated;
  }
  if (slUpdated) {
    console.log(`[座標原點] 切面 cutValue 重算 ${slUpdated} 條;目標 page.z 同步 ${tgtZUpdated} 個`);
  }
  // 重建 rank / global / 重畫
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  updateCalibrateButton(); updatePlaneOriginButton && updatePlaneOriginButton();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  refreshLists && refreshLists(); render();
  return { changed, slUpdated, tgtZUpdated };
}

// 修正當頁原點(極簡 — 只動本檔 planeOrigin pixel,別的全不動):
//   設計信念:使用者單純想「把這個檔的原點 pixel 移到正確位置」,不希望任何 3D 數字被動到。
//   ─ 本檔 planeOrigin pixel → 改;這意味著本檔 joint 的 in-plane 世界座標會跟著變動 −Δ·ratio
//   ─ 本檔每頁 pg.z(depth 軸值)→ **不動**(因為 in-plane 移動不該影響深度軸)
//   ─ 本檔 sectionLinks 的 p1 / p2 / cutValue / cutAxis → **不動**
//     (p1/p2 是 pixel 不會跟著改;cutValue 故意不重算 → 該切面在 3D 仍代表同一個軸向平面)
//   ─ 其他檔案的 planeOrigin / pg.z / sectionLinks → **完全不動**
//   ─ joint 像素位置(joint.x / joint.y)→ 不動(它們是 file 屬性,跟原點獨立)
//
//   ⚠ 副作用:這個動作會讓「本檔的 3D 世界座標」跟「其他檔 + sectionLinks 的 3D 世界座標」
//      暫時不一致。沒問題 — 設計上要求呼叫端在執行後跳「全局原點校準(globalJoint)」,
//      它會根據 globalJoint 自動重新對齊各檔(調整每檔的 planeOrigin / pg.z)。
function _applyNewPlaneOriginLocalOnly(activeFile, newPxOnActive) {
  if (!activeFile) return { changed: 0 };
  const oldO = activeFile.planeOrigin;
  if (oldO && Math.abs(oldO.x - newPxOnActive.x) < 1e-6 && Math.abs(oldO.y - newPxOnActive.y) < 1e-6) {
    return { changed: 0, noChange: true };
  }
  pushUndo();
  // 只改 pixel — 不算 Wnew、不動 pg.z、不重算 cutValue、不碰其他檔
  activeFile.planeOrigin = { x: newPxOnActive.x, y: newPxOnActive.y };
  // joint 世界座標跟著變,rank 需要重算
  invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  updateCalibrateButton && updateCalibrateButton();
  updatePlaneOriginButton && updatePlaneOriginButton();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  refreshLists && refreshLists();
  render();
  return { changed: 1 };
}

// 平面座標原點:剛好選了 2 條 bg 線 → 直接取交點建原點;其他情況一律走 pending 流程
// (避免「使用者之前選過 joint 進到底圖模式後不小心觸發 1-joint 模式」)
$("bgEditPlaneOrigin") && ($("bgEditPlaneOrigin").onclick = () => {
  const file = getActiveFile();
  const bgN = (file && file.selectedBgPaths) ? file.selectedBgPaths.size : 0;
  if (bgN === 2) bgCreatePlaneOrigin();
  else $("btnPlaneOrigin").click();
});

// ---------- 切面關聯 ----------
// 在當前頁選一條切線(允許多條共線視為一條),跳出檔案清單對話框 → 勾選要關聯的其他頁面,
// 對應資訊存在 file.sectionLinks,之後可配合原點 / 比例尺 / 平面 推算跨頁節點。
$("btnSectionLink") && ($("btnSectionLink").onclick = () => {
  const file = getActiveFile();
  if (!file) { alert("請先載入底圖"); return; }
  // 先退出其他衝突模式
  if (state.splitMode) exitSplitMode();
  if (state.moveMode && state.moveMode.active && typeof exitMoveMode === "function") exitMoveMode();
  if (state.manualAlign && state.manualAlign.active && typeof exitManualAlign === "function") exitManualAlign();
  if (state.rangeZoomMode) exitRangeZoom();
  if (state.originPending) exitOriginPending();
  if (state.scaleRulerPending) exitScaleRulerPending();
  clearSelection();
  clearAllBgSelection(file);
  // 記住進入前的工具 → 結束後若原本不在 selectBg 則回去
  state.sectionLinkPending = true;
  state.sectionLinkPrevTool = state.tool;
  // 記住進入前的匡選類型過濾 — 切面期間強制改成「只允許直線」,結束後還原
  state._sectionLinkPrevShapeMarquee = state.bgShapeMarquee ? new Set(state.bgShapeMarquee) : new Set();
  state.bgShapeMarquee = new Set(["straight"]);
  if (typeof refreshShapeMarqueeUI === "function") refreshShapeMarqueeUI();
  if (state.tool !== "selectBg") setTool("selectBg");
  $("btnSectionLink").classList.add("active");
  $("hud").textContent = "切面:請選底圖切線(只能選直線・Enter 確認 / Esc 取消)";
  render();
});
// 還原切面 pending 期間覆寫的「只允許直線」匡選過濾(其他直接把 sectionLinkPending=false 的地方也要呼叫)
function _restoreSectionLinkShapeMarquee() {
  if (state._sectionLinkPrevShapeMarquee) {
    state.bgShapeMarquee = state._sectionLinkPrevShapeMarquee;
    state._sectionLinkPrevShapeMarquee = null;
    if (typeof refreshShapeMarqueeUI === "function") refreshShapeMarqueeUI();
  }
}
function exitSectionLinkPending(restoreTool) {
  state.sectionLinkPending = false;
  const prev = state.sectionLinkPrevTool;
  state.sectionLinkPrevTool = null;
  $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
  _restoreSectionLinkShapeMarquee();
  if (restoreTool && prev && prev !== "selectBg") setTool(prev);
}
// 畫切線 overlay(pending 期間在 canvas 顯示一條亮色延伸線,方便視覺辨認選到的切線)
// — 省略:沿用既有 bg 選取高亮(#ffd23f hover / #00cc66 selected),使用者已能看到

async function openSectionLinkDialog(file, repLine) {
  console.log("[切面 dialog open]", file.name,
    "p1=", repLine && repLine.p1, "p2=", repLine && repLine.p2);
  // 前提檢查:源檔必須有平面 + 原點 + 比例尺
  if (!_fileHasFullSetup(file)) {
    alert("此檔需先設定:平面座標(XY/XZ/YZ)、平面原點、比例尺。");
    state.sectionLinkPending = false;
    state.sectionLinkPrevTool = null;
    $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
    _restoreSectionLinkShapeMarquee();
    if (typeof clearAllBgSelection === "function") clearAllBgSelection(file);
    return;
  }
  // 軸向檢查:切線需與 X/Y/Z 軸對齊(由源檔平面映射出的 2D 軸向 → 3D 軸向)
  const axisInfo = _analyzeSectionLineAxis(file, { p1: repLine.p1, p2: repLine.p2 });
  if (!axisInfo) {
    const map = _planeAxisOf2D(file.pages[0].plane);
    alert(`切面線必須與 ${map.x} 軸或 ${map.y} 軸對齊(${file.pages[0].plane} 平面只允許這兩種方向)。\n請重新選一條軸向直線。`);
    state.sectionLinkPending = false;
    state.sectionLinkPrevTool = null;
    $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
    _restoreSectionLinkShapeMarquee();
    if (typeof clearAllBgSelection === "function") clearAllBgSelection(file);
    return;
  }
  const dlg = document.getElementById("sectionLinkDialog");
  const info = document.getElementById("slInfo");
  const list = document.getElementById("slList");
  setupSectionLinkDialogDrag();
  // 每次打開都重置位置為置中(清掉上次拖曳的 inline style)
  const card = dlg.querySelector(".sl-card");
  if (card) {
    // 每次打開:清掉拖曳位置 + 上次 resize 過的尺寸,讓 CSS 預設(80vw × 80vh)生效
    card.style.left = ""; card.style.top = ""; card.style.transform = ""; card.style.position = "";
    card.style.width = ""; card.style.height = "";
  }
  // 已進入對話框階段 → 關掉 pending 旗標,避免全局 Enter listener 再次觸發進入 dialog
  state.sectionLinkPending = false;
  _restoreSectionLinkShapeMarquee();   // 對話框打開即代表「選取階段結束」,還原匡選類型
  // 既有切線關聯(編輯 vs 新增)— 每次簡化為「新增一條」,使用者要編輯可以刪除後重建
  const existingSet = new Set();   // 預先勾選:已關聯的 file ids(此處留白,以後做編輯 UI)
  // 顯示切線資訊
  const len = Math.hypot(repLine.p2.x - repLine.p1.x, repLine.p2.y - repLine.p1.y);
  const scale = file.scaleRuler && file.scaleRuler.ratio ? file.scaleRuler.ratio : null;
  const lenTxt = scale ? `${(len * scale).toFixed(1)} mm` : `${len.toFixed(1)} px`;
  // 切面對應到的目標平面類型:目標平面的「depth 軸」必須等於 cutAxis
  //   = 切面平面(cutAxis = const)正好和該目標平面平行 → 該平面是「切面視圖」
  //   例:cutAxis=X → 目標 = depth=X 的 YZ;cutAxis=Y → 目標 = XZ;cutAxis=Z → 目標 = XY
  //   再排除源檔自己的平面(平行兄弟由 propagation 自動處理,不顯示在 dialog)
  const depthOfPlane = { XY: "Z", XZ: "Y", YZ: "X" };
  const sourcePlane = file.pages[0].plane;
  const compatPlanes = ["XY", "XZ", "YZ"]
    .filter(P => depthOfPlane[P] === axisInfo.cutAxis && P !== sourcePlane);
  info.textContent =
    `當前頁:${file.name}・平面 ${sourcePlane}・cutAxis=${axisInfo.cutAxis}@${axisInfo.cutValue.toFixed(1)}\n` +
    `切線端點:(${repLine.p1.x.toFixed(1)}, ${repLine.p1.y.toFixed(1)}) → (${repLine.p2.x.toFixed(1)}, ${repLine.p2.y.toFixed(1)})・長度 ${lenTxt}\n` +
    `相容的目標平面:${compatPlanes.join(" / ") || "(無)"}・平行兄弟自動關聯不顯示;單選(預設第一筆,點其他列切換;不要關聯按取消 / Esc):`;
  // 候選清單:平面 + 原點 + 比例尺齊全 + 相容平面 + 與源不同平面
  //   排序:平面座標 (XY → XZ → YZ) → 第三軸位置(asc) → 檔名(desc)
  list.innerHTML = "";
  const planeOrder = { XY: 0, XZ: 1, YZ: 2 };
  const candidates = state.files
    .filter(f => f.id !== file.id)
    .filter(f => _fileHasFullSetup(f))
    .filter(f => compatPlanes.indexOf(f.pages[0].plane) >= 0)
    .sort((a, b) => {
      const pa = planeOrder[a.pages[0].plane] ?? 99;
      const pb = planeOrder[b.pages[0].plane] ?? 99;
      if (pa !== pb) return pa - pb;
      const za = (a.pages[0].z != null && Number.isFinite(a.pages[0].z)) ? a.pages[0].z : 0;
      const zb = (b.pages[0].z != null && Number.isFinite(b.pages[0].z)) ? b.pages[0].z : 0;
      if (za !== zb) return za - zb;
      // reverse 檔名(局部排序:由 Z..A)
      return (b.name || "").localeCompare(a.name || "");
    });
  if (candidates.length === 0) {
    list.innerHTML = `<div style="padding:20px;color:#9aa0a6;font-size:11px;text-align:center">沒有可關聯的他平面檔案<br>需要平面是 ${compatPlanes.join(" 或 ") || "(此切線方向無相容平面)"}、且有平面+原點+比例尺</div>`;
  }
  const selected = new Set(existingSet);
  let focusFid = null;   // 目前 preview 中顯示的 file id
  const previewHeader = document.getElementById("slPreviewHeader");
  const previewCanvas = document.getElementById("slPreviewCanvas");
  // Preview 縮放/平移狀態 — 切換檔案時重置
  const previewState = { zoom: 1, offsetX: 0, offsetY: 0 };
  // 已載入的 bg image 快取(同一檔案 wheel zoom 時不重新載)。
  //   srcX/Y/W/H = 影像中要顯示的 sub-rectangle(用於 PDF/Image 對 clipRect 裁切);
  //   SVG 路徑因為已用 viewBox 重渲染,srcRect 等於整個 image。
  let cachedPreviewImg = { fid: null, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };

  const drawPreviewWithZoom = () => {
    if (!previewCanvas) return;
    const ctx = previewCanvas.getContext("2d");
    ctx.fillStyle = "#0d0e10";
    ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    const cached = cachedPreviewImg;
    if (cached && cached.img && cached.srcW > 0 && cached.srcH > 0) {
      const fit = Math.min(previewCanvas.width / cached.srcW, previewCanvas.height / cached.srcH);
      const sc = fit * previewState.zoom;
      const w = cached.srcW * sc, h = cached.srcH * sc;
      const x = (previewCanvas.width  - w) / 2 + previewState.offsetX;
      const y = (previewCanvas.height - h) / 2 + previewState.offsetY;
      if (cached.invert) {
        ctx.save();
        try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
        ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
      }
      console.log(`[slPreview draw fid=${cached.fid}]`, "drawImage OK",
        { src: { sx: Math.round(cached.srcX), sy: Math.round(cached.srcY), sw: Math.round(cached.srcW), sh: Math.round(cached.srcH) },
          dst: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, invert: cached.invert });
    } else {
      console.warn(`[slPreview draw fid=${cached && cached.fid}]`, "fallback text — no image",
        { hasImg: !!(cached && cached.img), srcW: cached && cached.srcW, srcH: cached && cached.srcH });
      const f = state.files.find(x => x.id === focusFid);
      ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText((f && f.name) || "—", previewCanvas.width / 2, previewCanvas.height / 2);
    }
  };

  const loadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

  const updatePreview = async (f) => {
    if (!f || !previewCanvas) return;
    const isNewFile = f.id !== focusFid;
    focusFid = f.id;
    if (isNewFile) {
      previewState.zoom = 1;
      previewState.offsetX = 0;
      previewState.offsetY = 0;
    }
    // 把 canvas 內部 buffer 調到 stage 可用尺寸 × devicePixelRatio(HiDPI 銳利度);
    //   CSS 顯示尺寸用 style 鎖在 css 像素,buffer 維度才是 dpr 倍 → 細節不會糊。
    const stage = previewCanvas.parentElement;
    const cssW = Math.max(100, Math.floor(stage.clientWidth  - 24));
    const cssH = Math.max(80,  Math.floor(stage.clientHeight - 24));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    previewCanvas.style.width  = cssW + "px";
    previewCanvas.style.height = cssH + "px";
    previewCanvas.width  = Math.round(cssW * dpr);
    previewCanvas.height = Math.round(cssH * dpr);
    previewCanvas.style.cursor = cachedPreviewImg.img ? "grab" : "default";
    const pl = (f.pages && f.pages[0] && f.pages[0].plane) || "—";
    const hasScale  = !!(f.scaleRuler && f.scaleRuler.ratio);
    const hasOrigin = !!f.planeOrigin;
    previewHeader.textContent =
      `${f.name}・平面 ${pl}・比例 ${hasScale ? "✓" : "✗"}・原點 ${hasOrigin ? "✓" : "✗"}・滾輪縮放 / 拖曳平移`;
    // 載入(或沿用快取)bg image。
    //   裁切到 clipRect(若有設):preview 會把 user 定義的「圖面範圍」鋪滿 canvas,
    //   不再被原始圖檔留白(PDF/DXF 的 title block 等)主導視覺。
    if (isNewFile || !cachedPreviewImg.img || cachedPreviewImg.fid !== f.id) {
      cachedPreviewImg = { fid: f.id, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };
      const bgW = f.cachedBgWidth  || f.bgWidth  || state.bgWidth  || 1200;
      const bgH = f.cachedBgHeight || f.bgHeight || state.bgHeight || 800;
      const clip = f.clipRect ? { x: f.clipRect.x, y: f.clipRect.y, w: f.clipRect.w, h: f.clipRect.h }
                              : { x: 0, y: 0, w: bgW, h: bgH };
      const ptag = `[slPreview #${f.id} ${f.name}]`;
      console.log(ptag, "start", {
        canvasBuf: { w: previewCanvas.width, h: previewCanvas.height },
        hasBgImg: !!f.cachedBgImg, bgImgLen: (f.cachedBgImg && f.cachedBgImg.length) || 0,
        hasBgSvg: !!f.cachedBgSvg, bgSvgLen: (f.cachedBgSvg && f.cachedBgSvg.length) || 0,
        bgW, bgH, clip, bgImgDarkReady: f.bgImgDarkReady,
      });
      if (f.cachedBgImg) {
        const invert = !f.bgImgDarkReady;
        const img = await loadImg(f.cachedBgImg);
        if (img && cachedPreviewImg.fid === f.id) {
          // image 是 bgWidth × bgHeight 的世界座標的點陣;clipRect 也是世界座標 → 直接比例換到 bitmap
          const sx = Math.max(0, clip.x * img.width  / bgW);
          const sy = Math.max(0, clip.y * img.height / bgH);
          const sw = Math.min(img.width  - sx, clip.w * img.width  / bgW);
          const sh = Math.min(img.height - sy, clip.h * img.height / bgH);
          cachedPreviewImg.img = img;
          cachedPreviewImg.invert = invert;
          cachedPreviewImg.srcX = sx; cachedPreviewImg.srcY = sy;
          cachedPreviewImg.srcW = sw > 0 ? sw : img.width;
          cachedPreviewImg.srcH = sh > 0 ? sh : img.height;
          console.log(ptag, "bgImg loaded", {
            iw: img.width, ih: img.height, sx, sy, sw, sh,
            srcW: cachedPreviewImg.srcW, srcH: cachedPreviewImg.srcH, invert,
          });
        } else {
          console.warn(ptag, "bgImg load failed or stale fid", { hasImg: !!img, curFid: cachedPreviewImg.fid, askedFid: f.id });
        }
      } else if (f.cachedBgSvg) {
        // 用 viewBox 把 SVG 視窗鎖在 clipRect → 渲染出來的 bitmap 已是裁好的;再用高解析度
        //   讓 zoom-in 仍保持銳利。每邊上限 4096 防 OOM。
        const aspect = (clip.w > 0 && clip.h > 0) ? clip.w / clip.h : 1;
        let renderW = Math.min(4096, Math.round(previewCanvas.width  * 4));
        let renderH = Math.round(renderW / aspect);
        if (renderH > 4096) { renderH = 4096; renderW = Math.round(renderH * aspect); }
        let sized = f.cachedBgSvg;
        // 替換 viewBox(無則新增)
        const vb = `${clip.x} ${clip.y} ${clip.w} ${clip.h}`;
        const m_vb = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
        const m_w  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
        const m_h  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
        console.log(ptag, "bgSvg pre-rewrite", {
          origViewBox: m_vb ? m_vb[1] : null, origWidth: m_w ? m_w[1] : null, origHeight: m_h ? m_h[1] : null,
          newViewBox: vb, renderW, renderH, aspect,
        });
        if (/<svg\b[^>]*\sviewBox=/.test(sized)) {
          sized = sized.replace(/(<svg\b[^>]*?\s)viewBox="[^"]*"/, `$1viewBox="${vb}"`);
        } else {
          sized = sized.replace(/<svg\b/, `<svg viewBox="${vb}"`);
        }
        // 替換 width / height(無則新增)
        if (/<svg\b[^>]*\swidth=/.test(sized)) {
          sized = sized.replace(/(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${renderW}"`);
        } else {
          sized = sized.replace(/<svg\b/, `<svg width="${renderW}"`);
        }
        if (/<svg\b[^>]*\sheight=/.test(sized)) {
          sized = sized.replace(/(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${renderH}"`);
        } else {
          sized = sized.replace(/<svg\b/, `<svg height="${renderH}"`);
        }
        // 拿掉根 svg 上 inline style 裡會干擾離線渲染的 css(width/height/clip-path/position 等)— in-page 渲染用,SVG-to-Image 時會覆蓋我們改的屬性
        sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
          const cleaned = style
            .replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
            .replace(/;{2,}/g, ";")
            .replace(/^;|;$/g, "")
            .trim();
          return cleaned ? `${head} style="${cleaned}"` : head;
        });
        const m_vb2 = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
        const m_w2  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
        const m_h2  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
        const m_st2 = sized.match(/<svg\b[^>]*\sstyle="([^"]+)"/);
        console.log(ptag, "bgSvg post-rewrite", {
          viewBox: m_vb2 ? m_vb2[1] : null, width: m_w2 ? m_w2[1] : null, height: m_h2 ? m_h2[1] : null,
          style: m_st2 ? m_st2[1] : null,
          sizedLen: sized.length,
        });
        const blob = new Blob([sized], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        try {
          const img = await loadImg(url);
          console.log(ptag, "bgSvg image load result", { hasImg: !!img, iw: img && img.width, ih: img && img.height, curFid: cachedPreviewImg.fid, askedFid: f.id });
          if (img && cachedPreviewImg.fid === f.id) {
            cachedPreviewImg.img = img;
            cachedPreviewImg.invert = true;
            cachedPreviewImg.srcX = 0; cachedPreviewImg.srcY = 0;
            cachedPreviewImg.srcW = img.width; cachedPreviewImg.srcH = img.height;
          }
        } finally { URL.revokeObjectURL(url); }
      } else {
        console.warn(ptag, "no bg cache (cachedBgImg / cachedBgSvg both empty)");
      }
    }
    if (cachedPreviewImg.img) previewCanvas.style.cursor = "grab";
    drawPreviewWithZoom();
  };

  // 滾輪縮放 — 以游標位置為 anchor,範圍 [0.2x, 20x]
  const onPreviewWheel = (ev) => {
    ev.preventDefault();
    if (!cachedPreviewImg.img) return;
    const rect = previewCanvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * (previewCanvas.width  / rect.width);
    const sy = (ev.clientY - rect.top)  * (previewCanvas.height / rect.height);
    const cx = previewCanvas.width / 2, cy = previewCanvas.height / 2;
    const oldZoom = previewState.zoom;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const newZoom = Math.max(0.2, Math.min(20, oldZoom * factor));
    if (newZoom === oldZoom) return;
    // 把游標下的影像點固定:cursor → image-coord 不變
    previewState.offsetX = sx - cx - (newZoom / oldZoom) * (sx - cx - previewState.offsetX);
    previewState.offsetY = sy - cy - (newZoom / oldZoom) * (sy - cy - previewState.offsetY);
    previewState.zoom = newZoom;
    drawPreviewWithZoom();
  };
  previewCanvas.addEventListener("wheel", onPreviewWheel, { passive: false });

  // 拖曳平移 — 左鍵按下開始,window 監聽 mousemove/mouseup 讓拖出 canvas 也持續有效
  let panDrag = null;
  const onPreviewMouseDown = (ev) => {
    if (ev.button !== 0) return;
    if (!cachedPreviewImg.img) return;
    panDrag = {
      startX: ev.clientX, startY: ev.clientY,
      startOffsetX: previewState.offsetX,
      startOffsetY: previewState.offsetY,
    };
    previewCanvas.style.cursor = "grabbing";
    ev.preventDefault();
  };
  const onPreviewMouseMove = (ev) => {
    if (!panDrag) return;
    const rect = previewCanvas.getBoundingClientRect();
    const sx = previewCanvas.width  / rect.width;
    const sy = previewCanvas.height / rect.height;
    previewState.offsetX = panDrag.startOffsetX + (ev.clientX - panDrag.startX) * sx;
    previewState.offsetY = panDrag.startOffsetY + (ev.clientY - panDrag.startY) * sy;
    drawPreviewWithZoom();
  };
  const onPreviewMouseUp = () => {
    if (!panDrag) return;
    panDrag = null;
    if (cachedPreviewImg.img) previewCanvas.style.cursor = "grab";
  };
  previewCanvas.addEventListener("mousedown", onPreviewMouseDown);
  window.addEventListener("mousemove", onPreviewMouseMove);
  window.addEventListener("mouseup",   onPreviewMouseUp);

  // 對話框拉伸時也重繪 preview(監看 card 的 resize,debounce)
  let _previewResizeTimer = null;
  const previewResizeObs = new ResizeObserver(() => {
    if (_previewResizeTimer) clearTimeout(_previewResizeTimer);
    _previewResizeTimer = setTimeout(() => {
      const f = state.files.find(x => x.id === focusFid);
      if (f) updatePreview(f);
    }, 120);
  });
  previewResizeObs.observe(card);

  // 重新命名單一檔案 — 直接在列內把 .sl-name 轉成 input,不彈外部對話框。
  //   Enter / blur 提交,Esc 取消;名稱重複 → alert 並還原。
  const triggerRename = (g, nameEl) => {
    if (!nameEl) return;
    if (nameEl.querySelector("input")) return;     // 已在編輯中,避免重入
    const oldText = g.name;
    const input = document.createElement("input");
    input.type = "text";
    input.value = oldText;
    Object.assign(input.style, {
      width: "100%", boxSizing: "border-box",
      fontSize: "12px", color: "#ddd",
      background: "#1a1c20",
      border: "1px solid #4f9dff", borderRadius: "2px",
      padding: "1px 4px", outline: "none",
    });
    nameEl.textContent = "";
    nameEl.appendChild(input);
    // 防止 input 上的點擊冒泡到列(避免觸發 selection toggle)
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click",     (e) => e.stopPropagation());
    input.addEventListener("dblclick",  (e) => e.stopPropagation());
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const newName = (input.value || "").trim();
      try { nameEl.removeChild(input); } catch (_) {}
      if (!commit || !newName || newName === oldText) {
        nameEl.textContent = oldText;
        return;
      }
      if (state.files.some(x => x.id !== g.id && x.name === newName)) {
        alert("名稱已存在,不可重複");
        nameEl.textContent = oldText;
        return;
      }
      pushUndo();
      g.name = newName;
      nameEl.textContent = newName;
      if (typeof refreshFileList === "function") refreshFileList();
      if (typeof refreshPageSelector === "function") refreshPageSelector();
      if (focusFid === g.id && previewHeader) {
        const pl = (g.pages && g.pages[0] && g.pages[0].plane) || "—";
        const hasScale  = !!(g.scaleRuler && g.scaleRuler.ratio);
        const hasOrigin = !!g.planeOrigin;
        previewHeader.textContent =
          `${g.name}・平面 ${pl}・比例 ${hasScale ? "✓" : "✗"}・原點 ${hasOrigin ? "✓" : "✗"}・滾輪縮放 / 拖曳平移`;
      }
    };
    input.addEventListener("keydown", (e) => {
      // 阻擋 dialog onKey 的 Esc/Enter 關閉;dialog 那邊也已加上 INPUT/TEXTAREA 旁路,但這裡再保險
      e.stopPropagation();
      if (e.key === "Enter")  { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  };

  // 建立一列;dblclick 名稱 / 對列右鍵都可重新命名
  const buildRow = (g) => {
    const row = document.createElement("div");
    row.className = "sl-row" + (selected.has(g.id) ? " on" : "");
    row.dataset.fid = String(g.id);
    const pl = g.pages[0].plane;
    const depthAxis = (pl === "XY") ? "Z" : (pl === "XZ") ? "Y" : "X";
    const z = g.pages[0].z;
    const zTxt = (z != null && Number.isFinite(z)) ? z.toFixed(0) : "—";
    const meta = `${pl}・${depthAxis}=${zTxt}`;
    row.innerHTML = `
      <canvas class="sl-thumb" width="56" height="42"></canvas>
      <div class="sl-row-body">
        <div class="sl-name" title="雙擊或對列右鍵可重新命名">${escapeHtml(g.name)}</div>
        <div class="sl-meta">${meta}</div>
      </div>
      <button class="sl-dup" title="複製此檔案(直接複製,新副本以新列出現;改名請對列雙擊或右鍵)">複製</button>
    `;
    // 點列 = 切換選擇到本列(無法反選;預設已有第一筆。要不關聯任何目標 → 按取消 / Esc)
    //   detail≥2(double-click 第二次)忽略避免 rename 時 selection 抖動
    row.addEventListener("click", (e) => {
      if (e.detail >= 2) return;
      if (e.target && e.target.classList.contains("sl-dup")) return;
      selected.clear();
      list.querySelectorAll(".sl-row").forEach(r => r.classList.remove("on"));
      selected.add(g.id);
      row.classList.add("on");
      list.querySelectorAll(".sl-row.focus").forEach(r => r.classList.remove("focus"));
      row.classList.add("focus");
      updatePreview(g);
    });
    // 雙擊檔名 → 重新命名
    const nameEl = row.querySelector(".sl-name");
    nameEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      triggerRename(g, nameEl);
    });
    // 對列右鍵 → 跳出小選單(重新命名 / 刪除)
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 點到右鍵也視為選中該列(同 click 邏輯)
      selected.clear();
      list.querySelectorAll(".sl-row").forEach(r => r.classList.remove("on"));
      selected.add(g.id);
      row.classList.add("on");
      list.querySelectorAll(".sl-row.focus").forEach(r => r.classList.remove("focus"));
      row.classList.add("focus");
      updatePreview(g);
      _showSlRowCtxMenu(e.clientX, e.clientY, g, nameEl, row);
    });
    // 複製按鈕:直接 duplicate;新副本以新一列加到清單末端 + 焦點移過去顯示 preview。
    //   不彈第三軸對話框、不彈 rename 對話框 — 改名請對新列雙擊或右鍵。
    const dupBtn = row.querySelector(".sl-dup");
    dupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof duplicateFileById !== "function") return;
      const clone = duplicateFileById(g.id, { activate: false });
      if (!clone) return;
      const newRow = buildRow(clone);
      list.appendChild(newRow);
      newRow.scrollIntoView({ block: "nearest" });
      list.querySelectorAll(".sl-row.focus").forEach(r => r.classList.remove("focus"));
      newRow.classList.add("focus");
      updatePreview(clone);
    });
    // 延遲繪製列表縮圖
    const thumb = row.querySelector(".sl-thumb");
    setTimeout(() => { renderFileThumb(thumb, g).catch(err => console.warn("[thumb]", err)); }, 0);
    return row;
  };

  for (const f of candidates) list.appendChild(buildRow(f));
  // 預設選擇第一筆候選並把 preview 拉到該檔(單選不可反選;不要的話按取消 / Esc)
  if (candidates.length) {
    const first = candidates[0];
    selected.clear();
    selected.add(first.id);
    const firstRow = list.querySelector(`.sl-row[data-fid="${first.id}"]`);
    if (firstRow) {
      firstRow.classList.add("on");
      firstRow.classList.add("focus");
    }
    setTimeout(() => updatePreview(first), 0);
  }
  // Buttons
  const okBtn = document.getElementById("slOkBtn");
  const cancelBtn = document.getElementById("slCancelBtn");
  const closeBtn = document.querySelector("#sectionLinkDialog .sl-close");
  const cleanup = (ok) => {
    console.log("[切面 dialog close]", "ok=", ok,
      "selected targets:", ok ? Array.from(selected) : "(cancelled)");
    _hideSlCtxMenu();
    dlg.classList.remove("active");
    document.removeEventListener("keydown", onKey, true);
    if (previewResizeObs) previewResizeObs.disconnect();
    if (previewCanvas) {
      previewCanvas.removeEventListener("wheel", onPreviewWheel);
      previewCanvas.removeEventListener("mousedown", onPreviewMouseDown);
      previewCanvas.style.cursor = "";
    }
    window.removeEventListener("mousemove", onPreviewMouseMove);
    window.removeEventListener("mouseup",   onPreviewMouseUp);
    clearAllBgSelection(file);
    if (ok) {
      // 直接用選到的 bg 線端點做標示;不再進入手動定位流程
      // 箭頭尖端 = 兩端點中較靠近 bg 中心的那個(讓箭頭指向圖面內部)
      const prevTool = state.sectionLinkPrevTool;
      state.sectionLinkPending = false;
      state.sectionLinkPrevTool = null;
      $("btnSectionLink") && $("btnSectionLink").classList.remove("active");
      const bounds = _getPageBoundsForFile(file);
      const cx = bounds.x + bounds.w / 2;
      const cy = bounds.y + bounds.h / 2;
      const d1 = Math.hypot(repLine.p1.x - cx, repLine.p1.y - cy);
      const d2 = Math.hypot(repLine.p2.x - cx, repLine.p2.y - cy);
      let tip, tail;
      if (d1 <= d2) { tip = repLine.p1; tail = repLine.p2; }
      else          { tip = repLine.p2; tail = repLine.p1; }
      saveSectionLink(file, { p1: tip, p2: tail }, Array.from(selected));
      // 校復原本工具(若原本不是 selectBg)
      if (prevTool && prevTool !== "selectBg" && prevTool !== state.tool) setTool(prevTool);
    } else {
      exitSectionLinkPending(true);
    }
    render();
  };
  // 對 focus 的列做刪除(從清單 + state.files 一起拿掉),共用給 Delete key / 右鍵選單
  const _deleteSlRow = (g, row) => {
    if (!g) return;
    const fid = g.id;
    if (!confirm(`刪除檔案「${g.name}」?\n此動作會一併移除其所有標線、比例尺、原點等資料。`)) return;
    // 沿用既有的 deleteSelectedFiles(處理依賴檔轉移 / 主檔切換 / refresh 等)
    const prev = new Set(state.selection.fileIds);
    state.selection.fileIds.clear();
    state.selection.fileIds.add(fid);
    deleteSelectedFiles();
    state.selection.fileIds = prev;          // 還原原本的選取
    state.selection.fileIds.delete(fid);     // 但被刪的不在了
    // 從 dialog 清單拿掉這列
    const r = row || list.querySelector(`.sl-row[data-fid="${fid}"]`);
    if (r) r.remove();
    if (selected.has(fid)) selected.delete(fid);
    // 若還有列,把 focus / preview 移到下一筆;若清單空了,清掉 preview header
    const remain = list.querySelectorAll(".sl-row");
    if (remain.length) {
      list.querySelectorAll(".sl-row.focus, .sl-row.on").forEach(x => x.classList.remove("focus", "on"));
      const next = remain[0];
      next.classList.add("on", "focus");
      const nextFid = Number(next.dataset.fid);
      const nextFile = state.files.find(f => f.id === nextFid);
      if (nextFile) { selected.clear(); selected.add(nextFid); updatePreview(nextFile); }
    } else {
      previewHeader && (previewHeader.textContent = "預覽(沒有候選檔案)");
      // 清掉 preview canvas 內容
      if (previewCanvas) {
        const ctx = previewCanvas.getContext("2d");
        ctx.fillStyle = "#0d0e10";
        ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
      }
    }
  };
  // 右鍵小選單(重新命名 / 刪除)— 點外面才關;點進選單裡的選項由選項自己 click handler 收掉。
  let _slCtxMenu = null;
  let _slCtxOutsideHandler = null;
  const _hideSlCtxMenu = () => {
    if (_slCtxMenu) { try { _slCtxMenu.remove(); } catch (_) {} _slCtxMenu = null; }
    if (_slCtxOutsideHandler) {
      document.removeEventListener("mousedown", _slCtxOutsideHandler, true);
      _slCtxOutsideHandler = null;
    }
  };
  const _showSlRowCtxMenu = (x, y, g, nameEl, row) => {
    _hideSlCtxMenu();
    const m = document.createElement("div");
    m.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:4000;background:#1c1d20;border:1px solid #444;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,0.5);padding:4px;min-width:120px;font-size:12px;`;
    const mkBtn = (label, onClick, danger) => {
      const b = document.createElement("div");
      b.textContent = label;
      b.style.cssText = `padding:6px 10px;cursor:pointer;border-radius:3px;color:${danger ? "#ff7788" : "#ddd"};`;
      b.addEventListener("mouseenter", () => { b.style.background = danger ? "#3a1a1a" : "#2a2c30"; });
      b.addEventListener("mouseleave", () => { b.style.background = "transparent"; });
      // 用 mousedown 而非 click,因為外面 dismiss listener 也是 mousedown(capture)— 我們在裡面要先 stopPropagation
      b.addEventListener("mousedown", (e) => {
        e.preventDefault(); e.stopPropagation();
        _hideSlCtxMenu();
        // 用 setTimeout 把實際動作推遲到此 mousedown event loop 之外,避免跟正在收掉的 listener 互卡
        setTimeout(() => { try { onClick(); } catch (err) { console.error("[sl ctx]", err); } }, 0);
      });
      return b;
    };
    m.appendChild(mkBtn("重新命名", () => triggerRename(g, nameEl)));
    m.appendChild(mkBtn("刪除", () => _deleteSlRow(g, row), true));
    document.body.appendChild(m);
    _slCtxMenu = m;
    // outside-click dismiss:capture 階段判斷 target 是否在 menu 內,在內就放行交給選項自己處理
    _slCtxOutsideHandler = (ev) => {
      if (_slCtxMenu && _slCtxMenu.contains(ev.target)) return;
      _hideSlCtxMenu();
    };
    // 推遲一個 tick 才 attach,避免捕到觸發本選單的 contextmenu/click 餘波
    setTimeout(() => {
      if (_slCtxOutsideHandler) document.addEventListener("mousedown", _slCtxOutsideHandler, true);
    }, 0);
    // 確保不超出視窗
    const rect = m.getBoundingClientRect();
    if (rect.right > window.innerWidth)  m.style.left = (window.innerWidth - rect.width - 4) + "px";
    if (rect.bottom > window.innerHeight) m.style.top  = (window.innerHeight - rect.height - 4) + "px";
  };
  const onKey = (e) => {
    // 編輯名稱中(列內 input)→ 不要把 Esc/Enter 當成關閉/確認 dialog;讓 input 自己處理
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); _hideSlCtxMenu(); cleanup(false); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); cleanup(true); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      // 刪除目前 focus 的列;Delete + Backspace 都接(Mac 鍵盤 Backspace 較常用)
      e.preventDefault(); e.stopImmediatePropagation();
      const focusRow = list.querySelector(".sl-row.focus");
      const fid = focusRow ? Number(focusRow.dataset.fid) : null;
      const g = fid != null ? state.files.find(f => f.id === fid) : null;
      if (g) _deleteSlRow(g, focusRow);
    }
    else { e.stopImmediatePropagation(); }
  };
  okBtn.onclick = () => cleanup(true);
  cancelBtn.onclick = () => cleanup(false);
  if (closeBtn) closeBtn.onclick = () => cleanup(false);
  document.addEventListener("keydown", onKey, true);
  dlg.classList.add("active");
}
function saveSectionLink(file, repLine, targetIds) {
  // 防呆:本頁若是「純跨平面衍生頁」(看得到任何 cross-plane derivation,而本身沒有任何 primary),
  //   就「不在本頁建 primary」,改成「更新源檔 primary 的 cut + p1/p2 + 合併新 targets」。
  //   結果:本頁仍維持衍生視圖,但因為源頭 cut 改了,本頁衍生線會自動移到使用者新畫的位置。
  //   只有當本頁已經有自己的 primary 時,這條規則放行,改走原本的同源同 cut 覆蓋邏輯。
  const probeEntry = { p1: repLine.p1, p2: repLine.p2 };
  const probeAxis = _analyzeSectionLineAxis(file, probeEntry);
  const fileHasOwnPrimary = Array.isArray(file.sectionLinks) && file.sectionLinks.some(e => !e.autoProp);
  const existingOnFile = (typeof _deriveSectionLinksFor === "function") ? _deriveSectionLinksFor(file) : [];
  const crossPlaneDerivs = existingOnFile.filter(e => e && e.autoProp && e.crossPlane);
  console.log("[切面 probe] file=", file.name, "probeAxis=", probeAxis,
    "fileHasOwnPrimary=", fileHasOwnPrimary,
    "crossPlaneDerivs(count)=", crossPlaneDerivs.length,
    "crossPlaneDerivs=", crossPlaneDerivs.map(e => ({ groupId: e.groupId, cutAxis: e.cutAxis, cutValue: e.cutValue })));
  if (crossPlaneDerivs.length && !fileHasOwnPrimary) {
    // 本頁是純跨平面衍生頁 → 不建 primary,只把使用者選的 target 檔案「第三軸位置(page.z)」更新到新切線的 cutValue。
    //   幾何意義:使用者在衍生視圖上拖到新位置,意思是「我要把這個 target 頁移到這個 cut」 → 改 target 的 z。
    //   只更新 target.plane 的 depth 軸 == probeAxis.cutAxis 的 target(其它 plane 不適用,跳過)。
    if (!probeAxis || !probeAxis.cutAxis || !Number.isFinite(probeAxis.cutValue)) {
      console.log("[切面] 衍生頁:切線非軸向,無法更新 target 第三軸");
      $("hud").textContent = "本頁是衍生頁・切線非軸向,無法更新 target 第三軸位置";
      return;
    }
    const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    const newZ = Math.round(probeAxis.cutValue * factor) / factor;
    const zUpdates = [];
    const skipped = [];
    for (const tid of (targetIds || [])) {
      if (tid == null) continue;
      const tf = state.files.find(f => f.id === tid);
      if (!tf) { skipped.push({ tid, reason: "target file 不存在" }); continue; }
      const tp = tf.pages && tf.pages[0];
      if (!tp || !tp.plane) { skipped.push({ name: tf.name, reason: "target 沒設 plane" }); continue; }
      if (depthOf[tp.plane] !== probeAxis.cutAxis) {
        skipped.push({ name: tf.name, plane: tp.plane, reason: `target 平面 ${tp.plane} 的 depth 軸不是 ${probeAxis.cutAxis}` });
        continue;
      }
      if (tp.z === newZ) { skipped.push({ name: tf.name, reason: `已在 ${probeAxis.cutAxis}=${newZ},無變更` }); continue; }
      zUpdates.push({ tf, name: tf.name, plane: tp.plane, oldZ: tp.z, newZ });
    }
    if (zUpdates.length) {
      pushUndo();
      for (const u of zUpdates) u.tf.pages[0].z = u.newZ;
    }
    console.log("[切面] 衍生頁・更新 target 第三軸位置:", {
      file: { id: file.id, name: file.name },
      probe: probeAxis, newZ,
      updated: zUpdates.map(u => ({ name: u.name, plane: u.plane, oldZ: u.oldZ, newZ: u.newZ })),
      skipped,
    });
    if (zUpdates.length === 0) {
      $("hud").textContent = `本頁是衍生頁・${probeAxis.cutAxis}=${newZ}・所選 target 沒有可更新的(平面/已在位置)`;
      return;
    }
    const names = zUpdates.map(u => `${u.name}(${u.plane}・${probeAxis.cutAxis}=${u.newZ})`).join(", ");
    $("hud").textContent = `本頁是衍生頁・更新 ${zUpdates.length} 個 target 第三軸位置:${names}`;
    if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
    if (typeof refreshFileList === "function") refreshFileList();
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
    render && render();
    return;
  }
  pushUndo();   // 先捕捉舊狀態,Ctrl+Z 可回溯
  if (!file.sectionLinks) file.sectionLinks = [];
  // ── 主關聯去重 ──
  //   設計信念:同一個源檔對「同一個目標平面(= 同 cutAxis)」只應該有一條主關聯。
  //   作法:
  //     • 已存在同 cutAxis 的主關聯 → *不要* 建新 primary、*不要* 動既有 primary,只更新使用者
  //       這次挑選的目標檔 page.z 到新 cutValue;UI 上等同「重複關聯切面線只更新第三軸」。
  //     • 不存在同 cutAxis 的主關聯 → 走原本流程建 primary,並按下方 (b) 規則去掉跨檔重複 target。
  //   衍生(autoProp)永遠不動;跨平面 cut 全域唯一性由前面的「跨平面衍生 → 拒絕成 primary」防呆隱性保證。
  const existingSameAxisPrimary = (probeAxis && probeAxis.cutAxis)
    ? file.sectionLinks.find(e => !e.autoProp && e.cutAxis === probeAxis.cutAxis)
    : null;
  if (existingSameAxisPrimary && probeAxis && Number.isFinite(probeAxis.cutValue)) {
    // 早返:只更新使用者挑的目標檔 page.z,主關聯保持原狀
    const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    const newZ = Math.round(probeAxis.cutValue * factor) / factor;
    const zUpdates = [];
    for (const tid of (targetIds || [])) {
      const tf = state.files.find(x => x.id === tid);
      if (!tf || !tf.pages) continue;
      const tp = tf.pages[0];
      if (!tp || !tp.plane) continue;
      if (depthOf[tp.plane] !== probeAxis.cutAxis) continue;
      if (tp.z === newZ) continue;
      const oldZ = tp.z;
      tp.z = newZ;
      zUpdates.push({ name: tf.name, plane: tp.plane, oldZ, newZ });
    }
    console.log(`[切面] 已存在 ${probeAxis.cutAxis} 軸主關聯 #${existingSameAxisPrimary.id} → 只更新 ${zUpdates.length} 個目標檔 page.z=${newZ}`, zUpdates);
    if ($("hud")) {
      $("hud").textContent = `已存在 ${probeAxis.cutAxis} 軸主關聯(${file.name} #${existingSameAxisPrimary.id})→ 只更新 ${zUpdates.length} 個目標頁面 ${probeAxis.cutAxis}=${newZ}(主關聯未動)`;
    }
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
    if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
    if (typeof refreshLists === "function") refreshLists();
    if (typeof render === "function") render();
    return;
  }
  const overrideSummary = [];
  // (b) target 級別:跨檔掃過一遍。任一其他檔的 primary targetFileIds 含到 newTargets 的 id,
  //     就把該 id 從那條移掉;移到空就連 entry 一起刪。
  //     (本檔自己若有同 cutAxis 主關聯,前面早返,不會走到這裡;有不同 cutAxis 則理應並存,不必去重。)
  const newTargets = new Set((targetIds || []).filter(x => x != null));
  if (newTargets.size) {
    for (const f of state.files) {
      if (f.id === file.id) continue;       // file 本身的同 cutAxis 主關聯前面早返處理過了
      if (!f.sectionLinks || !f.sectionLinks.length) continue;
      const keep = [];
      for (const e of f.sectionLinks) {
        if (e.autoProp || !Array.isArray(e.targetFileIds)) { keep.push(e); continue; }
        const before = e.targetFileIds.slice();
        const after = before.filter(t => !newTargets.has(t));
        const dropped = before.filter(t => newTargets.has(t));
        if (dropped.length) {
          e.targetFileIds = after;
          if (after.length === 0) {
            overrideSummary.push({ host: f.name, entryId: e.id, action: "remove-entry", droppedTargets: dropped });
          } else {
            overrideSummary.push({ host: f.name, entryId: e.id, action: "trim-targets", droppedTargets: dropped, remaining: after.slice() });
            keep.push(e);
          }
        } else {
          keep.push(e);
        }
      }
      if (keep.length !== f.sectionLinks.length) f.sectionLinks = keep;
    }
  }
  if (overrideSummary.length) console.log("[切面] 主關聯覆蓋舊紀錄:", overrideSummary);
  const groupId = `sl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id: (file._nextSectionLinkId || 1),
    groupId,                         // 跨檔共用識別,同一條切線在各頁的 entry 共享此 id
    p1: { x: repLine.p1.x, y: repLine.p1.y },
    p2: { x: repLine.p2.x, y: repLine.p2.y },
    targetFileIds: targetIds.slice(),
    createdAt: Date.now(),
  };
  // 紀錄 cutAxis / cutValue(若軸向)讓未來判定快一點
  const axisInfo = _analyzeSectionLineAxis(file, entry);
  if (axisInfo) {
    entry.cutAxis = axisInfo.cutAxis;
    entry.cutValue = axisInfo.cutValue;
  }
  file._nextSectionLinkId = entry.id + 1;
  file.sectionLinks.push(entry);
  // 衍生模型:不再寫入其他檔案,所有目標平面的切面線在 render 時即時推算

  // 同步目標檔的 page.z:被勾選的目標,其平面 depth = cutAxis(dialog 已過濾),
  //   理應在 cutValue 這個切面位置上 → page.z 為 null 或不同就直接覆寫。
  //   寫入值會依 state.coordDecimals 四捨五入(跟其他座標顯示一致)。
  //   使用者要能 Ctrl+Z 回滾(已在開頭 pushUndo)。
  const zUpdates = [];
  let newZ = null;
  if (entry.cutAxis && Number.isFinite(entry.cutValue)) {
    const depthOf = { XY: "Z", XZ: "Y", YZ: "X" };
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    newZ = Math.round(entry.cutValue * factor) / factor;
    for (const tid of (targetIds || [])) {
      const tf = state.files.find(f => f.id === tid);
      if (!tf) continue;
      const tp = tf.pages && tf.pages[0];
      if (!tp || !tp.plane) continue;
      if (depthOf[tp.plane] !== entry.cutAxis) continue;
      if (tp.z === newZ) continue;
      const oldZ = tp.z;
      tp.z = newZ;
      zUpdates.push({ name: tf.name, plane: tp.plane, oldZ, newZ });
    }
  }
  if (zUpdates.length) {
    console.log(`[切面] 同步目標檔 page.z (${entry.cutAxis}=${newZ}):`, zUpdates);
    // 若 active file 是其中之一,刷新右欄座標 UI
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  }

  console.log(`[切面關聯] ${file.name} #${entry.id} group=${groupId}` +
    (entry.cutAxis ? `・cutAxis=${entry.cutAxis} cutValue=${entry.cutValue}` : "") +
    (zUpdates.length ? `・同步 ${zUpdates.length} 個目標檔的 page.z=${newZ}` : "") +
    (overrideSummary.length ? `・覆蓋舊主關聯 ${overrideSummary.length} 條` : ""));
  const zMsg = zUpdates.length ? `・同步 ${zUpdates.length} 個目標檔 ${entry.cutAxis}=${newZ}` : "";
  const ovMsg = overrideSummary.length ? `・覆蓋舊主關聯 ${overrideSummary.length}` : "";
  $("hud").textContent = `已加入切面 #${entry.id}(${file.name})${zMsg}${ovMsg}`;
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  // 主關聯 badge 在檔案清單顯示 → 新增 / 覆蓋後同步刷新
  if (typeof refreshFileList === "function") refreshFileList();
}

// 取得檔案的頁面範圍(clipRect 優先,否則整張底圖):用世界 / 2D 座標(跟 sectionLink p1/p2 同系)
function _getPageBoundsForFile(file) {
  if (file && file.clipRect) {
    return { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h };
  }
  const bw = (file && file.bgWidth)  ? file.bgWidth  : (state.bgWidth  || 1200);
  const bh = (file && file.bgHeight) ? file.bgHeight : (state.bgHeight || 800);
  return { x: 0, y: 0, w: bw, h: bh };
}
// 計算「外圍共軸標示線」:給定 bg 線端點 lp1, lp2 與檔案 file,回傳一個位於 bg 範圍外、
//   與 lp1-lp2 共軸、箭頭指向 bg 內部的標示線 { p1: 箭頭尖端(靠近 bg 邊),p2: 箭頭尾端(往外延伸) }
//   做法:
//     1. 算無限延伸線通過 bg 兩個邊界交點(slab method)
//     2. 判斷哪一個交點是「往外」(從 bg center 出發、沿 lp 線方向走、離 bg 中心較遠那一邊)
//     3. tip = 該邊界交點 + 小 gap 出 bg
//     4. tail = tip + markerLen 沿 outward 方向
export function _computeOutsideMarkerLine(file, lp1, lp2) {
  if (!lp1 || !lp2) return null;
  const bounds = _getPageBoundsForFile(file);
  const dxL = lp2.x - lp1.x, dyL = lp2.y - lp1.y;
  const len = Math.hypot(dxL, dyL);
  if (len < 1e-9) return null;
  const ux = dxL / len, uy = dyL / len;
  // 參數線:P(t) = lp1 + t * (ux, uy)
  // 找 P(t) 落在 bg 邊界內的 t 範圍 [tLo, tHi]
  let tLo = -Infinity, tHi = Infinity;
  if (Math.abs(ux) > 1e-9) {
    const t1 = (bounds.x - lp1.x) / ux;
    const t2 = (bounds.x + bounds.w - lp1.x) / ux;
    tLo = Math.max(tLo, Math.min(t1, t2));
    tHi = Math.min(tHi, Math.max(t1, t2));
  } else if (lp1.x < bounds.x || lp1.x > bounds.x + bounds.w) return null;
  if (Math.abs(uy) > 1e-9) {
    const t1 = (bounds.y - lp1.y) / uy;
    const t2 = (bounds.y + bounds.h - lp1.y) / uy;
    tLo = Math.max(tLo, Math.min(t1, t2));
    tHi = Math.min(tHi, Math.max(t1, t2));
  } else if (lp1.y < bounds.y || lp1.y > bounds.y + bounds.h) return null;
  if (tLo > tHi) return null;
  // 兩個 bg 邊界交點 P(tLo), P(tHi);分別判斷它們落在哪條邊上
  //   邊優先級:left(4) > top(3) > bottom(2) > right(1)。優先放左方,其次上方。
  const ptLo = { x: lp1.x + tLo * ux, y: lp1.y + tLo * uy };
  const ptHi = { x: lp1.x + tHi * ux, y: lp1.y + tHi * uy };
  const _edgePri = (pt) => {
    const tol = Math.max(0.5, Math.min(bounds.w, bounds.h) * 1e-4);
    if (Math.abs(pt.x - bounds.x) < tol) return 4;             // left
    if (Math.abs(pt.y - bounds.y) < tol) return 3;             // top
    if (Math.abs(pt.y - (bounds.y + bounds.h)) < tol) return 2; // bottom
    if (Math.abs(pt.x - (bounds.x + bounds.w)) < tol) return 1; // right
    return 0;
  };
  const prLo = _edgePri(ptLo);
  const prHi = _edgePri(ptHi);
  const useLo = prLo > prHi;
  const tEdge = useLo ? tLo : tHi;
  const sign  = useLo ? -1 : 1;        // tLo 一側往 -t 出去;tHi 一側往 +t 出去
  const edgeX = lp1.x + tEdge * ux;
  const edgeY = lp1.y + tEdge * uy;
  // 標示線長度:bg 短邊 10%(原為 20%,縮短一半讓四周箭頭不那麼搶眼);與 bg 邊緣的 gap = 短邊 2%
  const shortSide = Math.min(bounds.w, bounds.h);
  const markerLen = shortSide * 0.10;
  const gap = shortSide * 0.02;
  const tip  = { x: edgeX + sign * ux * gap,                   y: edgeY + sign * uy * gap };
  const tail = { x: tip.x + sign * ux * markerLen,             y: tip.y + sign * uy * markerLen };
  return { p1: tip, p2: tail };
}

// 把同一個檔案內幾何重疊的 sectionLink(p1/p2 接近)合併:回傳 [{ rep, allTargets:Set, allEntries:[] }]
//   render 用這個結果畫:同一條切面只畫 1 個箭頭,標籤合併所有目標檔名(逗號連接)
export function _getMergedSectionLinks(af) {
  if (!af) return [];
  // 衍生模型:從所有 primaries(包含 af 自己 + 其他檔)即時計算 af 上應顯示的 entries
  const entries = _deriveSectionLinksFor(af);
  if (!entries.length) return [];
  const seen = new Map();
  for (const sl of entries) {
    if (!sl.p1 || !sl.p2) continue;
    // key = 兩端點(整數座標,正規化方向)+ groupId
    //   不同 group 的 entry 即使幾何重疊也不該合併標籤,以免 user 新建的關聯與舊 group 的目標串在一起
    const a = `${Math.round(sl.p1.x)},${Math.round(sl.p1.y)}`;
    const b = `${Math.round(sl.p2.x)},${Math.round(sl.p2.y)}`;
    const coords = a < b ? `${a}|${b}` : `${b}|${a}`;
    const key = `${sl.groupId || "_nogroup_"}::${coords}`;
    let g = seen.get(key);
    if (!g) {
      g = { rep: sl, allTargets: new Set(), allEntries: [] };
      seen.set(key, g);
    }
    g.allEntries.push(sl);
    for (const tid of (sl.targetFileIds || [])) g.allTargets.add(tid);
    // 群組內有非 autoProp(使用者直接建的)→ 用它當代表;否則維持第一個
    if (!sl.autoProp && g.rep.autoProp) g.rep = sl;
  }
  return [...seen.values()];
}

// 右側欄「切面 Sections」清單:以「當前 active 檔案」為視角列出該檔的所有 sectionLink entries。
//   每行顯示:「<當前檔名> → <該 entry 指向的目標檔>」+ 角色(主關聯 / 同平面反向 / 跨平面反向)
//   點擊整列 → 跳到指向的目標檔。× 刪除整個 groupId(連帶所有跨檔傳播)。
export function refreshSectionLinkList() {
  const c = $("sectionLinkList");
  if (!c) return;
  c.innerHTML = "";
  const af = getActiveFile();
  if (!af) {
    c.innerHTML = `<div style="color:#9aa0a6;font-size:11px;padding:6px 4px">${(typeof _t==="function"&&_t("list.noSections"))||"尚未選擇檔案"}</div>`;
    return;
  }
  // 衍生模型:列出 af 上的 primaries(可刪)+ 衍生 entries(只顯示,刪要回到源檔)
  const entries = _deriveSectionLinksFor(af);
  if (!entries.length) {
    c.innerHTML = `<div style="color:#9aa0a6;font-size:11px;padding:6px 4px">本頁尚無切面</div>`;
    return;
  }
  // 計算每個 group 全域總共有幾個衍生 entry(主關聯 + 各檔的衍生)— 給每個 group 算一次
  //   (對 af 跑 derive 已得 af 部分;對其他檔再各 derive 一次成本可能高,取近似:用所有 primaries 的 group)
  const groupTotals = {};
  for (const f of state.files) {
    const fEntries = _deriveSectionLinksFor(f);
    for (const e of fEntries) {
      if (!e.groupId) continue;
      groupTotals[e.groupId] = (groupTotals[e.groupId] || 0) + 1;
    }
  }
  const _planeOf = (f) => (f && f.pages && f.pages[0] && f.pages[0].plane) || "?";
  const _zOf = (f) => {
    const pg = f && f.pages && f.pages[0];
    return (pg && pg.z != null && isFinite(pg.z)) ? pg.z : null;
  };
  const planeOrder = { XY: 0, XZ: 1, YZ: 2 };
  // 拆成 (entry, targetId) 列再排序;同 target 的跨平面衍生若已有 primary 涵蓋就拿掉(同平面衍生 / sibling 不影響)
  const rows = [];
  const primaryTargets = new Set();
  for (const sl of entries) {
    if (sl.autoProp) continue;
    for (const tid of (sl.targetFileIds || [])) {
      if (tid != null) primaryTargets.add(tid);
    }
  }
  for (const sl of entries) {
    const targetIds = (sl.targetFileIds || []).slice();
    const rowTargets = targetIds.length ? targetIds : [null];
    for (const tid of rowTargets) {
      // 跨平面衍生 + target 已被 primary 涵蓋 → 丟掉(其它角色都保留)
      if (sl.autoProp && sl.crossPlane && tid != null && primaryTargets.has(tid)) continue;
      const tf = tid != null ? state.files.find(ff => ff.id === tid) : null;
      const tplane = tid == null ? "?" : _planeOf(tf);
      const tz = tid == null ? null : _zOf(tf);
      const tname = tid == null ? "—" : (tf ? tf.name : "?");
      rows.push({ sl, tid, tf, tplane, tz, tname, allTargetIds: targetIds });
    }
  }
  rows.sort((a, b) => {
    const pa = planeOrder[a.tplane] ?? 99;
    const pb = planeOrder[b.tplane] ?? 99;
    if (pa !== pb) return pa - pb;
    // 第三軸值:高的在前;null 排到後面
    const za = (a.tz == null) ? -Infinity : a.tz;
    const zb = (b.tz == null) ? -Infinity : b.tz;
    if (za !== zb) return zb - za;
    return (b.tname || "").localeCompare(a.tname || "", undefined, { numeric: true, sensitivity: "base" });
  });
  for (const r of rows) {
    const sl = r.sl;
    const tid = r.tid;
    const tf = r.tf;
    const tname = r.tname;
    const targetIds = r.allTargetIds;
    const isDerived = !!sl.autoProp;
    const role = isDerived
      ? (sl.crossPlane ? "跨平面衍生" : "同平面衍生")
      : "主關聯";
    const totalInGroup = sl.groupId ? (groupTotals[sl.groupId] || 1) : 1;
    {
      const tPlane = r.tplane;
      const planeBadge = `[${tPlane}]`;
      const div = document.createElement("div");
      div.className = "item";
      div.style.flexDirection = "column";
      div.style.alignItems = "stretch";
      div.style.gap = "2px";
      div.title = `${role}・目標平面 ${tPlane}\n目標頁:${tname}\n群組共 ${totalInGroup} 項\n${isDerived ? "衍生項目自動產生,要刪請從主關聯所在檔案刪" : "點擊跳到指向的目標檔"}`;
      const row1 = document.createElement("div");
      row1.style.display = "flex";
      row1.style.justifyContent = "space-between";
      row1.style.gap = "6px";
      row1.style.alignItems = "center";
      const planeTag = document.createElement("span");
      planeTag.textContent = planeBadge;
      Object.assign(planeTag.style, {
        fontSize: "10px", color: "#9bb6e8",
        background: "rgba(79,157,255,0.12)",
        border: "1px solid rgba(79,157,255,0.35)",
        borderRadius: "3px", padding: "0 4px", flexShrink: "0",
      });
      row1.appendChild(planeTag);
      const name = document.createElement("span");
      name.style.fontWeight = "600";
      name.style.overflow = "hidden";
      name.style.textOverflow = "ellipsis";
      name.style.whiteSpace = "nowrap";
      name.style.flex = "1";
      name.textContent = tname;
      if (isDerived) name.style.color = "#b07cff";
      row1.appendChild(name);
      if (!isDerived) {
        // 主關聯:× 只移除「這一列對應的 target」;若 entry 移到沒 target 了,整條 entry 一起刪
        const del = document.createElement("button");
        del.textContent = "×";
        del.title = targetIds.length > 1
          ? `從這條主關聯移除 ${tname}(其他 target 仍保留;衍生會自動更新)`
          : "刪除這個切面(衍生項目會自動消失)";
        Object.assign(del.style, {
          fontSize: "11px", padding: "1px 8px", background: "transparent",
          border: "1px solid #555", color: "#ff7788",
          borderRadius: "3px", cursor: "pointer", flexShrink: "0",
        });
        del.onclick = (e) => {
          e.stopPropagation();
          const multi = targetIds.length > 1;
          const msg = multi
            ? `從主關聯移除 ${tname}?\n本條主關聯還有其他 target,只會去掉這一個`
            : `刪除切面「${tname}」?\n衍生到其他檔案的項目會自動消失`;
          if (!confirm(msg)) return;
          // sl 是 _deriveSectionLinksFor 回來的 clone(因為 dedupe 階段為了合併 targets 重新建物件),
          //   不能用引用比對找原物件;改用 id + groupId 找實際存在 af.sectionLinks 裡的 primary。
          const findReal = () => (af.sectionLinks || []).find(x =>
            !x.autoProp &&
            (sl.id != null ? x.id === sl.id : x.groupId === sl.groupId)
          );
          pushUndo();
          const realSl = findReal();
          if (!realSl) {
            console.warn("[切面 list ×] 找不到對應的真實 primary entry,refresh 後重試", { sl, afSectionLinks: af.sectionLinks });
            refreshSectionLinkList();
            if (typeof refreshFileList === "function") refreshFileList();
            render();
            return;
          }
          if (multi) {
            realSl.targetFileIds = (realSl.targetFileIds || []).filter(x => x !== tid);
            if (!realSl.targetFileIds.length) {
              af.sectionLinks = (af.sectionLinks || []).filter(x => x !== realSl);
            }
          } else {
            af.sectionLinks = (af.sectionLinks || []).filter(x => x !== realSl);
          }
          refreshSectionLinkList();
          if (typeof refreshFileList === "function") refreshFileList();
          render();
        };
        row1.appendChild(del);
      }
      const row2 = document.createElement("div");
      row2.style.color = "#9aa0a6";
      row2.style.fontSize = "10px";
      row2.textContent = `${role}・群組 ${totalInGroup} 項${sl.id != null ? `・#${sl.id}` : ""}`;
      div.appendChild(row1);
      div.appendChild(row2);
      div.onclick = () => {
        if (tid != null && tid !== af.id) activatePageWithBusy(tid, 0);
      };
      c.appendChild(div);
    }
  }
}

// 從 plane 字串拿到 in-plane 兩軸 + depth 軸名稱
function _planeAxisInfo(plane) {
  if (plane === "XZ") return { in: ["X", "Z"], depth: "Y" };
  if (plane === "YZ") return { in: ["Y", "Z"], depth: "X" };
  return { in: ["X", "Y"], depth: "Z" };   // 預設 XY
}

// 檔案是否「設定齊全」(可作為 propagation source)
export function _fileHasFullSetup(f) {
  if (!f) return false;
  const pg = f.pages && f.pages[0];
  if (!pg || !pg.plane) return false;
  if (!f.scaleRuler || !f.scaleRuler.ratio) return false;
  if (!f.planeOrigin) return false;
  return true;
}

// 平面 → 2D x/y 各對應的 3D 軸名稱
//   joint2DToWorld3D 內的對應(同步 1525~1532 那段 switch):
//     XY: u → X, v → Y
//     XZ: u → X, v → Z
//     YZ: u → Z, v → Y
function _planeAxisOf2D(plane) {
  if (plane === "XZ") return { x: "X", y: "Z" };
  if (plane === "YZ") return { x: "Z", y: "Y" };
  return { x: "X", y: "Y" };   // XY
}

// 判定切面線是否軸向對齊,並算出「被固定的 3D 軸」cutAxis 與 cutValue。
//   設計信念:切面線只允許平行 X/Y/Z 任一軸;對應的 3D 切面就是「軸向座標平面」(X=c / Y=c / Z=c)
//   回傳 null 表示不夠資訊或不軸向。
function _analyzeSectionLineAxis(sourceFile, srcEntry) {
  const srcPage = sourceFile && sourceFile.pages && sourceFile.pages[0];
  if (!srcPage || !srcPage.plane) return null;
  if (!_fileHasFullSetup(sourceFile)) return null;
  if (!srcEntry || !srcEntry.p1 || !srcEntry.p2) return null;
  const dx = srcEntry.p2.x - srcEntry.p1.x;
  const dy = srcEntry.p2.y - srcEntry.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const angTol = 0.1;        // ~5.7°,容忍 PDF / DXF 偏軸的線(超過視為斜線)
  const xRatio = Math.abs(dx) / len;
  const yRatio = Math.abs(dy) / len;
  const map = _planeAxisOf2D(srcPage.plane);
  let cutAxis;
  if (yRatio < angTol) cutAxis = map.y;     // 2D x-aligned (固定 2D y → 固定 map.y 軸)
  else if (xRatio < angTol) cutAxis = map.x; // 2D y-aligned (固定 2D x → 固定 map.x 軸)
  else return null;                          // 斜線拒絕
  const W1 = joint2DToWorld3D(sourceFile, srcPage, srcEntry.p1);
  const W2 = joint2DToWorld3D(sourceFile, srcPage, srcEntry.p2);
  if (!W1 || !W2) return null;
  const cutValue = W1[cutAxis.toLowerCase()];
  return { cutAxis, cutValue, srcPlane: srcPage.plane, W1, W2 };
}

// 給定 cutAxis = cutValue 的「3D 切面平面」,在目標檔 F 上算對應的 2D 切面線
//   - F 平面要包含 cutAxis 為 in-plane(否則切面平面平行於 F → 退化)
//   - 對 F 取 in-plane 另一軸做為「線方向」,延伸到大範圍後 clip 回 F bounds 的擴張範圍
function _buildSectionLineForFile(F, cutAxis, cutValue) {
  if (!_fileHasFullSetup(F)) return null;
  const Fpage = F.pages[0];
  const tInfo = _planeAxisInfo(Fpage.plane);
  if (tInfo.in.indexOf(cutAxis) < 0) return null;       // degenerate
  const otherAxis = tInfo.in[0] === cutAxis ? tInfo.in[1] : tInfo.in[0];
  const fz = (Fpage.z != null && Number.isFinite(Fpage.z)) ? Fpage.z : 0;
  const halfLen = 50000;
  const Pa3 = { x: 0, y: 0, z: 0 };
  const Pb3 = { x: 0, y: 0, z: 0 };
  Pa3[cutAxis.toLowerCase()] = cutValue;
  Pb3[cutAxis.toLowerCase()] = cutValue;
  Pa3[tInfo.depth.toLowerCase()] = fz;
  Pb3[tInfo.depth.toLowerCase()] = fz;
  Pa3[otherAxis.toLowerCase()] = -halfLen;
  Pb3[otherAxis.toLowerCase()] = halfLen;
  const a2d = world3DToJoint2D(F, Fpage, Pa3);
  const b2d = world3DToJoint2D(F, Fpage, Pb3);
  if (!a2d || !a2d.ok || !b2d || !b2d.ok) return null;
  // Clip 到「F bounds 擴張 50%」的長方形,讓線比 bg 範圍稍長,後續 _computeOutsideMarkerLine 會處理外移箭頭
  //   完全在擴張範圍外(回 null)→ 表示 F 的圖根本不涵蓋此切面位置 → 不要強加 entry
  const bounds = _getPageBoundsForFile(F);
  const padX = bounds.w * 0.5;
  const padY = bounds.h * 0.5;
  const expanded = { x: bounds.x - padX, y: bounds.y - padY, w: bounds.w + 2 * padX, h: bounds.h + 2 * padY };
  return _clipLineToBounds({ x: a2d.x, y: a2d.y }, { x: b2d.x, y: b2d.y }, expanded);
}

// 線 (p1, p2) 對矩形 b={x,y,w,h} 的 Liang-Barsky 參數裁切;失敗(整段在外)回 null
function _clipLineToBounds(p1, p2, b) {
  const x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
  let t0 = 0, t1 = 1;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const checks = [
    [-dx, p1.x - x1],
    [ dx, x2 - p1.x],
    [-dy, p1.y - y1],
    [ dy, y2 - p1.y],
  ];
  for (const [pp, qq] of checks) {
    if (Math.abs(pp) < 1e-9) { if (qq < 0) return null; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else        { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return {
    p1: { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
    p2: { x: p1.x + t1 * dx, y: p1.y + t1 * dy },
  };
}

// ---------- 衍生模型(derived sectionLinks) ----------
// 設計信念:file.sectionLinks 只儲存使用者實際畫的「主關聯(primary)」項目;
//   所有 autoProp(同平面平行兄弟、跨平面、parallel-multi、fallback)由 derive 函式
//   依當前所有檔案的 plane / origin / scale / page.z 即時計算,不寫入資料。
//   - 改 origin / scale / page.z → 衍生立刻反映
//   - 刪 primary → 衍生自動消失
//   - 載入時 strip autoProp 舊資料(loadProjectDataFromP / applySnap)

// 系統內是否有任一條 primary
function _systemHasAnyPrimary() {
  for (const f of state.files) {
    if (!Array.isArray(f.sectionLinks)) continue;
    if (f.sectionLinks.some(e => !e.autoProp)) return true;
  }
  return false;
}

// 用 union-find 計算「平面之間是否(直接或傳遞)互相連結」:
//   - 每條 primary 把 sourcePlane 與 targetPlane(= depth^-1(cutAxis))union 起來
//   - 兩個平面同 root → 互相連結(rule 4-6 的傳遞性自動成立)
//   - 只連 XZ-YZ 時,XY 仍是獨立 root → 不會被視為已連入
function _planeConnectionGroups() {
  const parent = { XY: "XY", XZ: "XZ", YZ: "YZ" };
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const f of state.files) {
    if (!Array.isArray(f.sectionLinks)) continue;
    const sp = f.pages && f.pages[0] && f.pages[0].plane;
    if (!sp) continue;
    for (const e of f.sectionLinks) {
      if (e.autoProp) continue;
      let ax = e.cutAxis;
      if (!ax) {
        const ai = _analyzeSectionLineAxis(f, e);
        if (ai) ax = ai.cutAxis;
      }
      if (!ax) continue;
      const tp = ["XY", "XZ", "YZ"].find(P => _planeAxisInfo(P).depth === ax);
      if (!tp || tp === sp) continue;
      union(sp, tp);
    }
  }
  return { find };
}

// F 是否「已參與切面系統」:F 的平面必須與其他至少一個平面直接或傳遞連結
//   (rule 8 嚴謹版:只連 XZ-YZ 時 XY 仍是孤立 component,不參與)
function _isFileParticipatingInSectionSystem(F) {
  if (!F || !_fileHasFullSetup(F)) return false;
  const fp = F.pages && F.pages[0] && F.pages[0].plane;
  if (!fp) return false;
  const { find } = _planeConnectionGroups();
  const root = find(fp);
  for (const p of ["XY", "XZ", "YZ"]) {
    if (p === fp) continue;
    if (find(p) === root) return true;
  }
  return false;
}

// 在 targetFile 上算 file G 的軌跡(sibling-on-target trace):
//   targetFile 的 in-plane 必含 G.depthAxis(任兩個不同平面必互含對方的 depth)
//   軌跡 = 沿 otherAxis 延伸的線,在 G.depthAxis = G.page.z 處
//   位置與 primary 的 cutValue 完全無關 — 純粹是 G 與 targetFile 的幾何關係
function _computeSiblingTraceOnTarget(G, targetFile) {
  if (!_fileHasFullSetup(G) || !_fileHasFullSetup(targetFile)) return null;
  if (G.id === targetFile.id) return null;
  const tgtPlane = targetFile.pages[0].plane;
  const gPlane = G.pages[0].plane;
  if (gPlane === tgtPlane) return null;
  const tgtInfo = _planeAxisInfo(tgtPlane);
  const gInfo = _planeAxisInfo(gPlane);
  const gDepthAxis = gInfo.depth;
  if (tgtInfo.in.indexOf(gDepthAxis) < 0) return null;     // 理論上不會發生
  const otherAxis = tgtInfo.in.find(a => a !== gDepthAxis);
  if (!otherAxis) return null;
  const lc = (s) => s.toLowerCase();
  const halfLen = 50000;
  const Fpage = targetFile.pages[0];
  const fDepthVal = (Fpage.z != null && Number.isFinite(Fpage.z)) ? Fpage.z : 0;
  const Gpage = G.pages[0];
  const gDepthVal = (Gpage.z != null && Number.isFinite(Gpage.z)) ? Gpage.z : 0;
  const Pa = { x: 0, y: 0, z: 0 }, Pb = { x: 0, y: 0, z: 0 };
  Pa[lc(gDepthAxis)]      = gDepthVal;
  Pb[lc(gDepthAxis)]      = gDepthVal;
  Pa[lc(tgtInfo.depth)]   = fDepthVal;
  Pb[lc(tgtInfo.depth)]   = fDepthVal;
  Pa[lc(otherAxis)]       = -halfLen;
  Pb[lc(otherAxis)]       =  halfLen;
  const a2d = world3DToJoint2D(targetFile, Fpage, Pa);
  const b2d = world3DToJoint2D(targetFile, Fpage, Pb);
  if (!a2d || !a2d.ok || !b2d || !b2d.ok) return null;
  const bounds = _getPageBoundsForFile(targetFile);
  const padX = bounds.w * 0.5, padY = bounds.h * 0.5;
  const expanded = { x: bounds.x - padX, y: bounds.y - padY, w: bounds.w + 2 * padX, h: bounds.h + 2 * padY };
  const clipped = _clipLineToBounds({ x: a2d.x, y: a2d.y }, { x: b2d.x, y: b2d.y }, expanded);
  if (!clipped) return null;
  return {
    _derived: true,
    // synthetic groupId — 跨呼叫穩定,讓 dedupe + merge 自然發生
    groupId: `_sib_${G.id}_on_${targetFile.id}`,
    p1: clipped.p1, p2: clipped.p2,
    targetFileIds: [G.id],
    autoProp: true,
    crossPlane: true,
    crossPlaneParallelMulti: true,
    cutAxis: gDepthAxis,
    cutValue: gDepthVal,
  };
}

// 給定 sourceFile 上的 primary,計算它對 targetFile 應產出的 case (a) 衍生 entry。
//   case (a) = 「primary 的 cutAxis 在 targetFile 的 in-plane 軸」→ 在 cutValue 處畫切線。
//   case (b)(sibling 軌跡)已搬到 _computeSiblingTraceOnTarget,跟 primary 解耦。
function _computeDerivedEntriesForTarget(sourceFile, primary, targetFile) {
  if (!sourceFile || !targetFile || sourceFile.id === targetFile.id) return [];
  if (!_fileHasFullSetup(sourceFile) || !_fileHasFullSetup(targetFile)) return [];
  const srcPlane = sourceFile.pages[0].plane;
  const tgtPlane = targetFile.pages[0].plane;
  const info = _analyzeSectionLineAxis(sourceFile, primary);
  if (!info) return [];     // 軸向化失敗 → primary 仍存在於源,但無衍生投影
  const { cutAxis, cutValue } = info;
  const tgtInfo = _planeAxisInfo(tgtPlane);
  const isSamePlane = (tgtPlane === srcPlane);
  const filterTargets = (ids) => (Array.isArray(ids) ? ids : [])
    .filter(t => t !== targetFile.id)
    .filter(t => {
      const tf = state.files.find(x => x.id === t);
      const tp = tf && tf.pages && tf.pages[0];
      return tp && tp.plane !== tgtPlane;
    });

  if (tgtInfo.in.indexOf(cutAxis) >= 0) {
    if (!isSamePlane) {
      // 第三平面 gating(寬鬆版,gates by _systemHasAnyPrimary;見 _isFileParticipatingInSectionSystem)
      if (!_isFileParticipatingInSectionSystem(targetFile)) return [];
    }
    const line = _buildSectionLineForFile(targetFile, cutAxis, cutValue);
    if (!line) return [];
    const propTargets = filterTargets(primary.targetFileIds);
    return [{
      _derived: true,
      groupId: primary.groupId,
      p1: line.p1, p2: line.p2,
      targetFileIds: propTargets.length ? propTargets : [sourceFile.id],
      autoProp: true,
      crossPlane: !isSamePlane,
      cutAxis, cutValue,
    }];
  }
  return [];
}

// 對 targetFile,回傳所有應顯示的 sectionLink entries(主關聯 + 衍生)。
//   1. targetFile 上的 primaries(使用者直接畫的)
//   2. case (a) 衍生:其他檔案的 primary 指定的具體切線(cutAxis=cutValue)
//   3. sibling traces(rule 8):系統有任一 primary 時,所有不同平面的設定齊全檔對 targetFile
//      自動產生「我在這個位置」的軌跡;跟 primary 的 cutValue 無關
//   最後依幾何座標 dedupe,優先序:primary > case (a) > sibling trace
function _deriveSectionLinksFor(targetFile) {
  const out = [];
  if (!targetFile) return out;
  // 1. primaries on targetFile
  const primaries = (targetFile.sectionLinks || []).filter(e => !e.autoProp);
  for (const p of primaries) out.push(p);
  const ownedGroups = new Set(primaries.map(p => p.groupId).filter(Boolean));
  // 2. case (a) 衍生
  for (const sourceFile of state.files) {
    if (sourceFile.id === targetFile.id) continue;
    if (!Array.isArray(sourceFile.sectionLinks)) continue;
    for (const primary of sourceFile.sectionLinks) {
      if (primary.autoProp) continue;
      if (primary.groupId && ownedGroups.has(primary.groupId)) continue;
      const entries = _computeDerivedEntriesForTarget(sourceFile, primary, targetFile);
      for (const e of entries) out.push(e);
    }
  }
  // 3. sibling traces — 對每個「平面已與 targetFile.plane 直接或傳遞連結」的設定齊全檔產生軌跡。
  //    同平面 + 同 page.z 的檔合併成一筆(共用切線、targetFileIds 列出全員,
  //    render 階段每個檔名各自繪成可點擊 span)。
  //    例:只有 XZ-YZ primary 時,XY 平面孤立 → XY 上不會出現 XZ/YZ 的 trace,反之亦然
  if (_fileHasFullSetup(targetFile) && _systemHasAnyPrimary()) {
    const tgtPlane = targetFile.pages[0].plane;
    const { find } = _planeConnectionGroups();
    const tgtRoot = find(tgtPlane);
    const decimals = Math.min(6, Math.max(0, state.coordDecimals || 0));
    const factor = Math.pow(10, decimals);
    const groups = new Map();   // key = "plane@roundedZ" → [G files]
    for (const G of state.files) {
      if (G.id === targetFile.id) continue;
      if (!_fileHasFullSetup(G)) continue;
      const gp = G.pages[0];
      if (gp.plane === tgtPlane) continue;
      if (find(gp.plane) !== tgtRoot) continue;
      const z = (gp.z != null && Number.isFinite(gp.z))
        ? Math.round(gp.z * factor) / factor : 0;
      const key = `${gp.plane}@${z}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(G);
    }
    for (const members of groups.values()) {
      if (!members.length) continue;
      // 第一個檔當代表算軌跡(同 plane + 同 z 的線位置相同)
      const trace = _computeSiblingTraceOnTarget(members[0], targetFile);
      if (!trace) continue;
      const sortedIds = members.map(m => m.id).sort((a, b) => a - b);
      trace.targetFileIds = sortedIds;
      // synthetic groupId 反映合併群組;以 _sib_ 開頭,優先級判定仍生效
      trace.groupId = `_sib_${sortedIds.join("_")}_on_${targetFile.id}`;
      out.push(trace);
    }
  }
  // 4. 依幾何座標 dedupe(rounded p1/p2),保留優先序高者:
  //    primary(無 autoProp)> case (a) 衍生(autoProp 無 _sib_ groupId)> sibling trace(_sib_ groupId)
  //    為避免衍生頁的 case-a 把 sibling trace「整條掩蓋」(只剩主關聯目標,缺 sibling 群組成員),
  //    這裡 dedupe 時優先級判定維持不變(留高優先級當代表,p1/p2/cutAxis/cutValue 來自高優先級),
  //    但「targetFileIds 取聯集」— 把被丟掉那條的 targets 併進來。標籤渲染就會列出全部成員。
  const dedupedByCoords = new Map();
  const _mergeTargets = (a, b) => {
    const set = new Set();
    for (const t of (a || [])) if (t != null) set.add(t);
    for (const t of (b || [])) if (t != null) set.add(t);
    return Array.from(set);
  };
  for (const e of out) {
    if (!e.p1 || !e.p2) continue;
    const a = `${Math.round(e.p1.x)},${Math.round(e.p1.y)}`;
    const b = `${Math.round(e.p2.x)},${Math.round(e.p2.y)}`;
    const coords = a < b ? `${a}|${b}` : `${b}|${a}`;
    const isPrimary = !e.autoProp;
    const isSibTrace = typeof e.groupId === "string" && e.groupId.startsWith("_sib_");
    const priority = isPrimary ? 2 : (isSibTrace ? 0 : 1);
    const existing = dedupedByCoords.get(coords);
    if (!existing) {
      // 第一次遇到此座標 — clone 一份(後續可能會被改寫 targetFileIds 聯集,不影響原 e)
      dedupedByCoords.set(coords, {
        entry: { ...e, targetFileIds: (e.targetFileIds || []).slice() },
        priority,
      });
    } else if (priority > existing.priority) {
      // 新進的優先級更高 → 用它當代表,但把舊的 targets 併入,讓 sibling 群組成員不會掉
      const merged = _mergeTargets(e.targetFileIds, existing.entry.targetFileIds);
      dedupedByCoords.set(coords, { entry: { ...e, targetFileIds: merged }, priority });
    } else if (priority < existing.priority) {
      // 舊的優先級高 → 保留舊代表,但把新的 targets 併進去
      existing.entry.targetFileIds = _mergeTargets(existing.entry.targetFileIds, e.targetFileIds);
    } else {
      // 同優先級
      if (existing.entry.groupId === e.groupId) continue;   // 同 groupId 同 coords → 純重複,跳過
      // 同優先級不同 groupId(較少見)→ 也把 targets 併進舊代表(p1/p2/cut* 還是用先到的)
      existing.entry.targetFileIds = _mergeTargets(existing.entry.targetFileIds, e.targetFileIds);
    }
  }
  return [...dedupedByCoords.values()].map(v => v.entry);
}

// 為檔案 F 的每條切面線,從其他檔案的 joints / members 推斷 F 上應該存在的節點與桿件。
//   - F 的切面線 + F 的 depth 軸 → 3D 中的「切面平面」
//   - 對其他檔(優先序 XZ → XY → YZ)取每個 joint,計算它在 F 切面平面上的距離;
//     落在 tol 內就投影到 F 的 2D(改 depth 為 F.page.z)、檢查 2D 是否在切面線段上,通過就建節點
//   - 桿件:若一條桿件的兩端 joint 都被處理過(idMap 有),且彼此不重複,在 F 上連桿件
//   - 平面衝突檢測:同一個切面有 ≥2 個同平面檔案都貢獻節點 → 紀錄為「多平行切面衝突」
//   - F 自己缺平面/原點/比例尺,或切面 entry 缺 p1/p2 → 跳過該 entry(只處理能處理的)
async function _populateSectionLinkJointsForFile(F, opts) {
  if (!F || !_fileHasFullSetup(F)) return null;
  const Fpage = F.pages && F.pages[0];
  if (!Fpage) return null;
  const fEntries = _deriveSectionLinksFor(F);
  if (!fEntries.length) return null;
  opts = opts || {};
  const tol3D = opts.tol3D != null ? opts.tol3D : 1.0;
  const tol2D = opts.tol2D != null ? opts.tol2D : 5.0;
  const dedupRadius = opts.dedupRadius != null ? opts.dedupRadius : 0.5;
  const planePriority = opts.planePriority || ["XY", "YZ", "XZ"];
  // mode: "joints"(只建節點)/ "members"(只建桿件)/ "both"(都建,預設)
  const mode = opts.mode === "joints" || opts.mode === "members" ? opts.mode : "both";
  const doJoints  = mode !== "members";
  const doMembers = mode !== "joints";
  // 時間基底 yield:每 yieldMs 毫秒(預設 50)yield 一次給瀏覽器處理事件,
  //   保證 cancel 按鈕 / Esc 可以在迴圈進行中被點到,且大檔不會被加上太多 overhead。
  const yieldMs = opts.yieldMs != null ? opts.yieldMs : 50;
  // 進度 callback:每 yield 點傳回 { fileName, processed };回傳 false 中斷處理
  const onProgress = opts.onProgress;
  const _yield = () => new Promise(r => setTimeout(r, 0));
  let _lastYield = Date.now();

  const stats = { processedLinks: 0, jointsAdded: 0, membersAdded: 0, conflicts: [], skipped: 0, mode };

  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  // ---- 優化 1:spatial hash for findExistingJoint(避免 O(n) linear scan)----
  //   cell 邊長 = dedupRadius * 2,只需檢查目標 cell 跟 8 鄰居就能涵蓋 < dedupRadius 範圍
  const cellSize = Math.max(dedupRadius * 2, 0.5);
  const _cellKey = (x, y) => `${Math.floor(x / cellSize)}|${Math.floor(y / cellSize)}`;
  const _jointGrid = new Map();
  for (const j of (Fpage.joints || [])) {
    const k = _cellKey(j.x, j.y);
    let arr = _jointGrid.get(k);
    if (!arr) { arr = []; _jointGrid.set(k, arr); }
    arr.push(j);
  }
  const findExistingJoint = (page, x, y) => {
    // page 參數保留簽名相容,實際只查 F 自己的網格
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = _jointGrid.get(`${cx + dx}|${cy + dy}`);
        if (!arr) continue;
        for (const j of arr) {
          if (Math.hypot(j.x - x, j.y - y) < dedupRadius) return j;
        }
      }
    }
    return null;
  };
  const _registerJoint = (j) => {
    const k = _cellKey(j.x, j.y);
    let arr = _jointGrid.get(k);
    if (!arr) { arr = []; _jointGrid.set(k, arr); }
    arr.push(j);
  };
  // ---- 優化 2:member key index(避免 O(n) some(...))----
  const _memberKeyOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const _memberKeys = new Set();
  for (const m of (Fpage.members || [])) _memberKeys.add(_memberKeyOf(m.j1, m.j2));
  // ---- 優化 3:joint2DToWorld3D memo(同 source joint 不重算)----
  const _worldCache = new Map();  // G.id → Map<sj.id, world3D|null>
  const _getWorld = (G, Gp, sj) => {
    let m = _worldCache.get(G.id);
    if (!m) { m = new Map(); _worldCache.set(G.id, m); }
    if (m.has(sj.id)) return m.get(sj.id);
    const w = joint2DToWorld3D(G, Gp, sj) || null;
    m.set(sj.id, w);
    return w;
  };
  // ---- 優化 4:bulk binding 模式 — 不每次 inferGlobalJoint,結束統一 infer 被動到的 ----
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };

  const fDepthAxis = _planeAxisInfo(Fpage.plane).depth.toLowerCase();

  // 候選來源檔(依平面優先序)— 只挑「圖頁有節點或桿件」的檔案,避免掃過空頁
  //   依 mode 決定條件:joints/both 需要 joints;members 需要 members;both 兩者任一即可
  const needJ = (mode !== "members");
  const needM = (mode !== "joints");
  const sourcesByPlane = { XY: [], XZ: [], YZ: [] };
  for (const G of state.files) {
    if (G.id === F.id) continue;
    if (!_fileHasFullSetup(G)) continue;
    const pg = G.pages[0];
    if (!sourcesByPlane[pg.plane]) continue;
    const hasJ = Array.isArray(pg.joints)  && pg.joints.length > 0;
    const hasM = Array.isArray(pg.members) && pg.members.length > 0;
    // 必須有需要的內容才納入:both 模式只要其一即可;joints 需要節點;members 需要桿件
    if (mode === "joints"  && !hasJ) continue;
    if (mode === "members" && !hasM) continue;
    if (mode === "both"    && !(hasJ || hasM)) continue;
    sourcesByPlane[pg.plane].push(G);
  }
  const orderedSources = [];
  for (const plane of planePriority) {
    for (const G of (sourcesByPlane[plane] || [])) orderedSources.push({ file: G, plane });
  }

  // ---- 預先過濾:對每個來源檔,把「結構性節點(接桿件)+ depth 對齊 F 平面」的 joint 先抓出來 ----
  //   每個 entry 包含 G / Gp / plane / sj / W / f2d,後續每條切線只要做 signedDist + segDist 兩個便宜檢查
  //   省掉每條切線都重跑 world3DToJoint2D / connectedJointIds 計算的成本(O(N_lines × N_joints) → O(N_joints + N_lines × N_passing))
  const eligibleByPlane = { XY: [], YZ: [], XZ: [] };
  {
    let _prefilterCount = 0;
    for (const { file: G, plane: Gplane } of orderedSources) {
      const Gp = G.pages[0];
      // 過濾孤立節點(無接桿件 → 多半是尺寸 / 標註 / 殘留),只在「該頁本身有 members」時生效。
      //   若頁面只有節點沒桿件(例如僅標柱位 / 軸線交點的純節點頁),所有節點都視為結構性,不過濾。
      const _connectedJointIds = new Set();
      let _hasAnyMember = false;
      for (const sm of (Gp.members || [])) {
        _hasAnyMember = true;
        if (sm.j1 != null) _connectedJointIds.add(sm.j1);
        if (sm.j2 != null) _connectedJointIds.add(sm.j2);
      }
      for (const sj of (Gp.joints || [])) {
        if (_hasAnyMember && !_connectedJointIds.has(sj.id)) continue;
        _prefilterCount++;
        // yield 給 UI / cancel(預過濾本身可能也要跑幾千次)
        if (Date.now() - _lastYield > yieldMs) {
          _lastYield = Date.now();
          if (onProgress) {
            const r = onProgress({ fileName: F.name, phase: "filter", processed: _prefilterCount });
            if (r === false) return stats;
          }
          await _yield();
        }
        const W = _getWorld(G, Gp, sj);
        if (!W) continue;
        // 嚴格 3D 對位 + 一次 world3DToJoint2D — 結果整個 F 處理過程都共用
        const f2d = world3DToJoint2D(F, Fpage, W, { tol: tol3D });
        if (!f2d || !f2d.ok) continue;
        eligibleByPlane[Gplane].push({ G, Gp, plane: Gplane, sj, W, f2d });
      }
    }
  }

  for (const e of fEntries) {
    if (!e.p1 || !e.p2) { stats.skipped++; continue; }
    if (e.crossPlaneFallback) { stats.skipped++; continue; }   // bg 中央 placeholder,沒幾何意義
    // F 的切面平面:過 FW1, FW2,法向 = cross(線方向, F depth 軸)
    const FW1 = joint2DToWorld3D(F, Fpage, e.p1);
    const FW2 = joint2DToWorld3D(F, Fpage, e.p2);
    if (!FW1 || !FW2) { stats.skipped++; continue; }
    const lineDir = { x: FW2.x - FW1.x, y: FW2.y - FW1.y, z: FW2.z - FW1.z };
    const dV = { x: 0, y: 0, z: 0 }; dV[fDepthAxis] = 1;
    const cutN = {
      x: lineDir.y * dV.z - lineDir.z * dV.y,
      y: lineDir.z * dV.x - lineDir.x * dV.z,
      z: lineDir.x * dV.y - lineDir.y * dV.x,
    };
    const nLen = Math.hypot(cutN.x, cutN.y, cutN.z);
    if (nLen < 1e-9) { stats.skipped++; continue; }
    cutN.x /= nLen; cutN.y /= nLen; cutN.z /= nLen;

    // (G.id, srcJointId) → F 上的目標 joint id (新建或既有)
    const idMap = new Map();
    // 真正的多平行切面衝突:同一個 plane 有 ≥ 2 個檔案投影到 F 上「同一個 target joint」。
    //   多排架平行結構(例如倉儲多個 XZ 排架在不同 Y 深度,各自有相同 X / Z 的柱位)
    //   每個排架投影到 F 切線上會落在不同 2D 點,雖然來自同 plane 多個檔案、卻不該算衝突。
    //   key: target joint id  value: { XY: Map<fileName, sj.id[]>, XZ: …, YZ: … }
    const _contribByTarget = new Map();

    // 處理順序:plane priority(XY → YZ → XZ),只走預過濾後的 eligible joints
    //   每個 eligible joint 已通過 depth 對位(world3DToJoint2D 的 tol);現在只要做切線兩個便宜檢查:
    //   (a) signedDist:joint 投影到 F 的 2D 後落在切面延伸線(線方向 × depth 軸)內
    //   (b) segDist:joint 落在切線段內(非無限延伸線)
    //   per-source 的 members 仍需要兩端 joint 都被「同一條切線」處理過(用 idMap 收集),mode === "joints" 時略過
    const contributedSrcByG = new Map();   // G.id → G(用於收集要處理 members 的來源檔)
    let _slProcCount = 0;
    for (const plane of planePriority) {
      for (const ent of (eligibleByPlane[plane] || [])) {
        const { G, sj, W, f2d } = ent;
        _slProcCount++;
        // yield 給 UI / cancel(每個 eligible joint 的迴圈內也要有機會中斷)
        if (Date.now() - _lastYield > yieldMs) {
          _lastYield = Date.now();
          if (onProgress) {
            const r = onProgress({ fileName: F.name, phase: "section", processed: _slProcCount });
            if (r === false) return stats;
          }
          await _yield();
        }
        const signedDist = (W.x - FW1.x) * cutN.x + (W.y - FW1.y) * cutN.y + (W.z - FW1.z) * cutN.z;
        if (Math.abs(signedDist) > tol3D) continue;
        if (segDist({ x: f2d.x, y: f2d.y }, e.p1, e.p2) > tol2D) continue;
        let target = findExistingJoint(Fpage, f2d.x, f2d.y);
        if (!target) {
          if (!doJoints) continue;   // members 模式 → 不建節點;沒既有 joint 就略過此 source joint
          target = { id: nextJointId++, x: f2d.x, y: f2d.y };
          Fpage.joints.push(target);
          _registerJoint(target);
          stats.jointsAdded++;
        }
        if (typeof _autoBindGlobalForMappedJoint === "function") {
          _autoBindGlobalForMappedJoint(sj, target, W, _bindOpts);
        }
        idMap.set(`${G.id}_${sj.id}`, target.id);
        contributedSrcByG.set(G.id, G);
        // 紀錄此 target joint 收到了哪個 plane 的哪個檔案的貢獻
        let perPlane = _contribByTarget.get(target.id);
        if (!perPlane) { perPlane = { XY: new Set(), XZ: new Set(), YZ: new Set() }; _contribByTarget.set(target.id, perPlane); }
        perPlane[plane] && perPlane[plane].add(G.name);
      }
    }
    // members:逐個有貢獻 joint 的來源檔處理,兩端 joint 都在 idMap(同切線)才連
    if (doMembers) {
      for (const G of contributedSrcByG.values()) {
        const Gp = G.pages[0];
        for (const sm of (Gp.members || [])) {
          const t1 = idMap.get(`${G.id}_${sm.j1}`);
          const t2 = idMap.get(`${G.id}_${sm.j2}`);
          if (t1 == null || t2 == null) continue;
          if (t1 === t2) continue;
          const mk = _memberKeyOf(t1, t2);
          if (_memberKeys.has(mk)) continue;
          if (!Array.isArray(Fpage.members)) Fpage.members = [];
          Fpage.members.push({ id: nextMemberId++, j1: t1, j2: t2 });
          _memberKeys.add(mk);
          stats.membersAdded++;
        }
      }
    }
    // 多平行切面衝突:同一個 target joint 收到同 plane ≥ 2 個檔案的投影
    //   把這類衝突 target 依 plane 聚合,匯總成「某 plane 上 N 個 target 有衝突,涉及檔案 [...]」
    const tag = e.id != null ? `#${e.id}` : (e.cutAxis ? `${e.cutAxis}=${e.cutValue}` : "(衍生)");
    const conflictByPlane = { XY: { tids: new Set(), files: new Set() }, XZ: { tids: new Set(), files: new Set() }, YZ: { tids: new Set(), files: new Set() } };
    for (const [tid, perPlane] of _contribByTarget) {
      for (const plane of ["XY", "XZ", "YZ"]) {
        const set = perPlane[plane];
        if (set && set.size >= 2) {
          conflictByPlane[plane].tids.add(tid);
          for (const n of set) conflictByPlane[plane].files.add(n);
        }
      }
    }
    for (const plane of Object.keys(conflictByPlane)) {
      const c = conflictByPlane[plane];
      if (c.tids.size >= 1) {
        const fileList = Array.from(c.files).join("、");
        stats.conflicts.push(`切面 ${tag}(${F.name})・${plane} 平面有 ${c.files.size} 個檔案投影到同一個節點(${c.tids.size} 個重疊位置)[${fileList}] → 多平行切面衝突`);
      }
    }
    stats.processedLinks++;
  }
  // 結束時統一 infer 被動到的 globalJoints(避免迴圈內每次都 O(total joints))
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  stats.touchedGlobals = _touchedGids.size;
  return stats;
}

// 檔案預覽縮圖:依 cachedBgImg / cachedBgSvg 把底圖畫進小 canvas(類似主畫布的反相效果)
//   套 clipRect 的處理方式跟主對話框 preview 一致:cachedBgImg 走 source-rect 裁切;
//   cachedBgSvg 改寫 viewBox 重新渲染。否則 DXF bbox 遠大於實際內容時,縮圖會被縮成一個小點。
export async function renderFileThumb(canvas, file) {
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0d0e10";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const W = canvas.width, H = canvas.height;
  const tag = `[thumb #${file && file.id} ${file && file.name}]`;
  const loadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => { console.warn(tag, "Image onerror", e); resolve(null); };
    img.src = src;
  });
  const drawFit = (img, sx, sy, sw, sh, invert) => {
    if (!img || !img.width || !img.height || sw <= 0 || sh <= 0) {
      console.warn(tag, "drawFit refuse", { hasImg: !!img, iw: img && img.width, ih: img && img.height, sx, sy, sw, sh });
      return false;
    }
    const sc = Math.min(W / sw, H / sh);
    const w = sw * sc, h = sh * sc;
    const x = (W - w) / 2, y = (H - h) / 2;
    if (invert) {
      ctx.save();
      try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
    }
    console.log(tag, "drawFit OK", { src: { sx: Math.round(sx), sy: Math.round(sy), sw: Math.round(sw), sh: Math.round(sh) },
      dst: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, invert });
    return true;
  };
  console.log(tag, "start", {
    canvas: { W, H },
    hasBgImg: !!file.cachedBgImg, bgImgLen: (file.cachedBgImg && file.cachedBgImg.length) || 0,
    hasBgSvg: !!file.cachedBgSvg, bgSvgLen: (file.cachedBgSvg && file.cachedBgSvg.length) || 0,
    bgW: file.bgWidth, bgH: file.bgHeight, cachedBgW: file.cachedBgWidth, cachedBgH: file.cachedBgHeight,
    clipRect: file.clipRect, bgImgDarkReady: file.bgImgDarkReady,
  });
  if (file.cachedBgImg) {
    const invert = !file.bgImgDarkReady;   // DXF 預烤 bitmap 已是深色,不需再 invert
    const img = await loadImg(file.cachedBgImg);
    if (img && img.width && img.height) {
      const bgW = file.cachedBgWidth  || file.bgWidth  || img.width;
      const bgH = file.cachedBgHeight || file.bgHeight || img.height;
      const clip = file.clipRect ? { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h }
                                 : { x: 0, y: 0, w: bgW, h: bgH };
      let sx = Math.max(0, clip.x * img.width  / bgW);
      let sy = Math.max(0, clip.y * img.height / bgH);
      let sw = Math.min(img.width  - sx, clip.w * img.width  / bgW);
      let sh = Math.min(img.height - sy, clip.h * img.height / bgH);
      console.log(tag, "bgImg loaded", { iw: img.width, ih: img.height, bgW, bgH, sx, sy, sw, sh });
      if (!(sw > 0 && sh > 0)) {
        console.warn(tag, "bgImg sw/sh degenerate, fall back to full image");
        sx = 0; sy = 0; sw = img.width; sh = img.height;
      }
      if (drawFit(img, sx, sy, sw, sh, invert)) return;
    } else {
      console.warn(tag, "bgImg load failed, hasImg=", !!img);
    }
  }
  if (file.cachedBgSvg) {
    const bgW = file.cachedBgWidth  || file.bgWidth  || 1200;
    const bgH = file.cachedBgHeight || file.bgHeight || 800;
    const clip = file.clipRect ? { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h }
                               : { x: 0, y: 0, w: bgW, h: bgH };
    const aspect = (clip.w > 0 && clip.h > 0) ? clip.w / clip.h : 1;
    let renderW = Math.min(1024, Math.max(W * 4, 256));
    let renderH = Math.round(renderW / aspect);
    if (renderH > 1024) { renderH = 1024; renderW = Math.round(renderH * aspect); }
    let sized = file.cachedBgSvg;
    const vb = `${clip.x} ${clip.y} ${clip.w} ${clip.h}`;
    const m_vb = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
    const m_w  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
    const m_h  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
    console.log(tag, "bgSvg pre-rewrite", {
      origViewBox: m_vb ? m_vb[1] : null, origWidth: m_w ? m_w[1] : null, origHeight: m_h ? m_h[1] : null,
      newViewBox: vb, renderW, renderH, aspect,
    });
    if (/<svg\b[^>]*\sviewBox=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)viewBox="[^"]*"/, `$1viewBox="${vb}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg viewBox="${vb}"`);
    }
    if (/<svg\b[^>]*\swidth=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${renderW}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg width="${renderW}"`);
    }
    if (/<svg\b[^>]*\sheight=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${renderH}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg height="${renderH}"`);
    }
    // 拿掉根 svg 上 inline style 裡會干擾離線渲染的 css 屬性 — DXF / PDF 解析時這些用於 in-page 渲染,
    //   但在 SVG-to-Image 時 width/height/clip-path 會強制覆蓋我們改的屬性,造成空白
    sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
      const cleaned = style
        .replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
        .replace(/;{2,}/g, ";")
        .replace(/^;|;$/g, "")
        .trim();
      return cleaned ? `${head} style="${cleaned}"` : head;
    });
    const m_vb2 = sized.match(/<svg\b[^>]*\sviewBox="([^"]+)"/);
    const m_w2  = sized.match(/<svg\b[^>]*\swidth="([^"]+)"/);
    const m_h2  = sized.match(/<svg\b[^>]*\sheight="([^"]+)"/);
    const m_st2 = sized.match(/<svg\b[^>]*\sstyle="([^"]+)"/);
    console.log(tag, "bgSvg post-rewrite", {
      viewBox: m_vb2 ? m_vb2[1] : null, width: m_w2 ? m_w2[1] : null, height: m_h2 ? m_h2[1] : null,
      style: m_st2 ? m_st2[1] : null,
      sizedLen: sized.length,
    });
    const blob = new Blob([sized], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      if (img) console.log(tag, "bgSvg image loaded", { iw: img.width, ih: img.height });
      if (img && drawFit(img, 0, 0, img.width, img.height, true)) return;
    } finally { URL.revokeObjectURL(url); }
    return;
  }
  console.warn(tag, "no bg cache, falling back to filename label");
  ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(file.name || "—", W / 2, H / 2);
}

// 切面關聯對話框 — 標題列拖曳(同 import dialog pattern;lazy init 因為 script 早於 DOM)
let _slDlgDragInited = false;
function setupSectionLinkDialogDrag() {
  if (_slDlgDragInited) return;
  const card = document.querySelector("#sectionLinkDialog .sl-card");
  const titlebar = document.querySelector("#sectionLinkDialog .sl-titlebar");
  if (!card || !titlebar) return;
  _slDlgDragInited = true;
  let drag = null;
  titlebar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // 點到關閉按鈕本身不要觸發拖曳
    if (e.target && e.target.classList.contains("sl-close")) return;
    const rect = card.getBoundingClientRect();
    card.style.position = "absolute";
    card.style.left = rect.left + "px";
    card.style.top  = rect.top  + "px";
    card.style.transform = "none";
    drag = { startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const maxX = window.innerWidth - 40;
    const maxY = window.innerHeight - 40;
    const nx = Math.max(-card.offsetWidth + 80, Math.min(maxX, drag.left + (e.clientX - drag.startX)));
    const ny = Math.max(0, Math.min(maxY, drag.top + (e.clientY - drag.startY)));
    card.style.left = nx + "px";
    card.style.top  = ny + "px";
  });
  window.addEventListener("mouseup", () => { drag = null; });
}

// 標示距離(智能,讀):依目前選取數量分支(支援 bgEdit 與 select 模式)
//   ≥ 1 條 → 立即計算 + 進入沿線滑動,點擊確認 / Esc 取消
//   無選取 + bgEdit → 進入 pending 流程逐條點選
$("bgEditMeasure") && ($("bgEditMeasure").onclick = () => startMeasureFromCurrentSelection());
$("bgEditMeasureSelect")   && ($("bgEditMeasureSelect").onclick   = () => reenterMeasureSlide());
$("bgEditMeasureMove")     && ($("bgEditMeasureMove").onclick     = () => reenterMeasureSlide());
$("bgEditMeasureDelLast")  && ($("bgEditMeasureDelLast").onclick  = () => deleteMeasurement());
$("bgEditMeasureClearAll") && ($("bgEditMeasureClearAll").onclick = () => clearAllMeasurements());

// 線到原點最短距離 / 軸距離 — 共用前置檢查:選取必須是「多線視為同一條」,且檔案需有原點
function _validateLineToOrigin(file) {
  console.log("[線到原點 validate] file=", file && file.name,
    "planeOrigin=", file && file.planeOrigin,
    "scaleRuler=", file && file.scaleRuler,
    "state.scale=", state.scale,
    "selectedBgPaths.size=", file && file.selectedBgPaths && file.selectedBgPaths.size);
  if (!file) { alert("請先載入底圖"); return null; }
  if (!file.planeOrigin) { alert(`請先設定平面座標原點(目前檔案「${file.name}」尚未設定原點)`); return null; }
  if (!state.scale || state.scale <= 0) {
    alert(`請先建立比例尺(目前檔案「${file.name}」尚無比例尺;有原點但無比例尺無法換算實際距離)`);
    return null;
  }
  if (!file.selectedBgPaths || file.selectedBgPaths.size === 0) {
    alert("請先選取一條(或多條共線)的底圖直線"); return null;
  }
  const distinct = distinctSelectedLineCount(file);
  const lines = _selectedBgLinesAsWorld(file);
  console.log("[線到原點 validate] selectedBgPaths=", [...file.selectedBgPaths],
    "distinctLineCount=", distinct, "linesAsWorld.length=", lines.length, "lines=", lines);
  if (distinct === 0) {
    alert(`選取的 ${file.selectedBgPaths.size} 條 bg 路徑都不是「單一線段」(可能是多段折線 / 曲線 / 矩形)。請先用「切成直線」拆分,再選一條直線`);
    return null;
  }
  if (distinct > 1) {
    alert(`選取共有 ${distinct} 條不同方向的線(共線視為一條)。線到原點功能需要所有選取共線 — 請只選同一條線(可多段共線)`);
    return null;
  }
  if (!lines.length) {
    alert("無法取出選取線段的世界座標(可能是 bg 線結構異常)");
    return null;
  }
  // 取最長的一段作為代表(最穩定的線方向)
  let rep = lines[0], maxLen = 0;
  for (const L of lines) {
    const d = Math.hypot(L.p2.x - L.p1.x, L.p2.y - L.p1.y);
    if (d > maxLen) { maxLen = d; rep = L; }
  }
  return rep;
}
// 共用收尾:把計算好的距離寫進 state.measure 並進入 slide 模式(沿原線方向滑動)
//   結束後 click 會觸發 commitMeasureSlide(已存在的 wrap.click handler);Esc 還原並結束
function _setOriginDistMeasure(rep, p1, p2, distWorld, axisName) {
  const distMm = distWorld / state.scale;
  const u = state.unitName || "mm";
  const labelTxt = `${distMm.toFixed(_measureDec())} ${u}`;
  // slide 方向 = 原線方向(讓使用者沿原線拖移,p1/p2 同步位移、距離不變)
  const lineDx = rep.p2.x - rep.p1.x, lineDy = rep.p2.y - rep.p1.y;
  const lineLen = Math.hypot(lineDx, lineDy) || 1;
  pushUndo();
  state.measure = {
    kind: "lineToOrigin",
    p1: { x: p1.x, y: p1.y },
    p2: { x: p2.x, y: p2.y },
    distance: distWorld,
    label: labelTxt,
    dx: lineDx / lineLen, dy: lineDy / lineLen,
    _backup: { p1: { ...p1 }, p2: { ...p2 } },
    sliding: true,
  };
  $("hud").textContent = `${axisName}原點距離 = ${labelTxt} — 拖游標沿線滑動位置,點擊確認 / Esc 還原`;
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
  render();
}
$("bgEditOriginDistH") && ($("bgEditOriginDistH").onclick = () => {
  console.log("[水平原點距離 click]");
  const file = getActiveFile();
  const rep = _validateLineToOrigin(file);
  if (!rep) return;
  const o = file.planeOrigin;
  const dx = rep.p2.x - rep.p1.x, dy = rep.p2.y - rep.p1.y;
  // 水平距離:線在 y=O.y 處的 x 座標 → 與 O.x 的差。若線是水平(dy ≈ 0),無法在 y=O.y 處取交點(除非線就在那高度)
  if (Math.abs(dy) < 1e-9) {
    alert("選取的線是水平線,無「水平原點距離」(請改用「垂直原點距離」或「最短距離」)");
    return;
  }
  const t = (o.y - rep.p1.y) / dy;
  const xAtOriginY = rep.p1.x + t * dx;
  const distWorld = Math.abs(xAtOriginY - o.x);
  const intersect = { x: xAtOriginY, y: o.y };
  console.log(`[水平原點距離] world=${distWorld.toFixed(4)}・原點 (${o.x.toFixed(2)}, ${o.y.toFixed(2)})・交點 (${intersect.x.toFixed(2)}, ${intersect.y.toFixed(2)})`);
  _setOriginDistMeasure(rep, { x: o.x, y: o.y }, intersect, distWorld, "水平");
});
$("bgEditOriginDistV") && ($("bgEditOriginDistV").onclick = () => {
  console.log("[垂直原點距離 click]");
  const file = getActiveFile();
  const rep = _validateLineToOrigin(file);
  if (!rep) return;
  const o = file.planeOrigin;
  const dx = rep.p2.x - rep.p1.x, dy = rep.p2.y - rep.p1.y;
  // 垂直距離:線在 x=O.x 處的 y 座標 → 與 O.y 的差。若線是垂直(dx ≈ 0),無交點(除非線就在那 X)
  if (Math.abs(dx) < 1e-9) {
    alert("選取的線是垂直線,無「垂直原點距離」(請改用「水平原點距離」或「最短距離」)");
    return;
  }
  const t = (o.x - rep.p1.x) / dx;
  const yAtOriginX = rep.p1.y + t * dy;
  const distWorld = Math.abs(yAtOriginX - o.y);
  const intersect = { x: o.x, y: yAtOriginX };
  console.log(`[垂直原點距離] world=${distWorld.toFixed(4)}・原點 (${o.x.toFixed(2)}, ${o.y.toFixed(2)})・交點 (${intersect.x.toFixed(2)}, ${intersect.y.toFixed(2)})`);
  _setOriginDistMeasure(rep, { x: o.x, y: o.y }, intersect, distWorld, "垂直");
});
$("bgEditOriginDistMin") && ($("bgEditOriginDistMin").onclick = () => {
  console.log("[與原點最短距離 click]");
  const file = getActiveFile();
  const rep = _validateLineToOrigin(file);
  if (!rep) return;
  const o = file.planeOrigin;
  const dx = rep.p2.x - rep.p1.x, dy = rep.p2.y - rep.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) { alert("線段長度太短,無法判定方向"); return; }
  // 原點投影到線上得到垂足
  const t = ((o.x - rep.p1.x) * dx + (o.y - rep.p1.y) * dy) / (len * len);
  const foot = { x: rep.p1.x + t * dx, y: rep.p1.y + t * dy };
  const distWorld = Math.hypot(foot.x - o.x, foot.y - o.y);
  console.log(`[與原點最短距離] world=${distWorld.toFixed(4)}・原點 (${o.x.toFixed(2)}, ${o.y.toFixed(2)})・垂足 (${foot.x.toFixed(2)}, ${foot.y.toFixed(2)})`);
  _setOriginDistMeasure(rep, { x: o.x, y: o.y }, foot, distWorld, "最短");
});

// 比例尺(智能):依目前選取數量分支
//   1 條 bg 線 → 用該線段長度法(bgCreateScaleRuler)
//   2 條 bg 線 → 用兩線距離法 + 進入沿線拖曳
//   其他(0 條 / 3+ 條) → 走 pending 流程,逐條提示點選
$("bgEditScaleRuler") && ($("bgEditScaleRuler").onclick = () => {
  const file = getActiveFile();
  const bgN = (file && file.selectedBgPaths) ? file.selectedBgPaths.size : 0;
  if (bgN === 1) {
    bgCreateScaleRuler();
    return;
  }
  if (bgN === 2) {
    const before = file.scaleRuler;
    bgCreateScaleRulerByTwoLines();
    if (file.scaleRuler && file.scaleRuler !== before) {
      clearAllBgSelection(file);
      startScaleRulerDrag();
    }
    return;
  }
  // 0 條或 3+ 條 → pending 流程
  $("btnScaleRuler").click();
});
$("bgEditScaleRulerMove") && ($("bgEditScaleRulerMove").onclick = () => startScaleRulerDrag());

// ---------- 在 bg svg 中加一條新 <line>(world / bgSvg-local 座標)----------
// 注意:bgSvg viewBox 不一定 = world coords。pdf.js / cached SVG 各自有不同 viewBox。
// 為了座標一致,新 line 寫到 bgSvg 內時要用 bgSvg 的「local」座標(getCTM inverse)。
// 簡化做法:先把 world 座標經 bgSvg 的 getScreenCTM 反推到 local。
function _worldToBgLocal(bgSvgEl, wx, wy) {
  const ctm = bgSvgEl.getScreenCTM();
  if (!ctm) return { x: wx, y: wy };
  // world → screen → 反 ctm → local
  const r = wrap.getBoundingClientRect();
  const screenX = wx * state.zoom + state.panX + r.left;
  const screenY = wy * state.zoom + state.panY + r.top;
  const inv = ctm.inverse();
  const sp = bgSvgEl.createSVGPoint(); sp.x = screenX; sp.y = screenY;
  const lp = sp.matrixTransform(inv);
  return { x: lp.x, y: lp.y };
}
// 把 bgSvg 內現有的「原始 PDF / DXF 內容」包進一個 <g class="bg-orig"> 群組(若尚未包過)。
//   目的:applyBgRotation 套 clipRect 時只 clip 原始底圖,使用者新增的 bg 線(標 data-bg-user="1")
//   留在 bgSvg root 不被 clip,可以延伸到拆分頁範圍外仍然顯示。
//   同時確保 <defs> 內有 <clipPath id="bgOrigClip">,讓 applyBgRotation 用 SVG 原生 clip-path 屬性
//   套用(比 CSS clip-path 在 <g> 上更可靠 — 不同瀏覽器對 reference box 的解讀不一致)。
function _ensureBgOrigGroup(bgSvgEl) {
  if (!bgSvgEl) return null;
  const ns = "http://www.w3.org/2000/svg";
  // 確保 defs + clipPath 元素存在
  let defs = bgSvgEl.querySelector(":scope > defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    bgSvgEl.insertBefore(defs, bgSvgEl.firstChild);
  }
  if (!defs.querySelector("#bgOrigClip")) {
    const cp = document.createElementNS(ns, "clipPath");
    cp.id = "bgOrigClip";
    cp.setAttribute("clipPathUnits", "userSpaceOnUse");
    defs.appendChild(cp);
  }
  let orig = bgSvgEl.querySelector(":scope > g.bg-orig");
  if (orig) return orig;
  orig = document.createElementNS(ns, "g");
  orig.setAttribute("class", "bg-orig");
  // 把現有子節點搬進 orig,跳過 <defs>(保留在 root)與 data-bg-user="1"(使用者線,留在 root)
  const kids = Array.from(bgSvgEl.childNodes);
  for (const k of kids) {
    if (k.nodeType === 1) {
      const tag = k.tagName ? k.tagName.toLowerCase() : "";
      if (tag === "defs") continue;
      if (k.dataset && k.dataset.bgUser === "1") continue;
    }
    orig.appendChild(k);
  }
  bgSvgEl.appendChild(orig);
  return orig;
}

// 從世界座標 (p1, p2) 在 bgSvg root 上建立一條使用者線(<line> 元素)。
//   不更新 file.userBgLines / cachedBgSvg — 由呼叫端決定。提供給 addBgLineWorld 與
//   undo/redo 後 syncUserBgLinesToDom 共用,確保兩者建立的 DOM 結構完全一致。
function _appendUserBgLineDom(bgSvgEl, p1World, p2World, idx, dasharray) {
  const ns = "http://www.w3.org/2000/svg";
  const a = _worldToBgLocal(bgSvgEl, p1World.x, p1World.y);
  const b = _worldToBgLocal(bgSvgEl, p2World.x, p2World.y);
  const ln = document.createElementNS(ns, "line");
  ln.setAttribute("x1", a.x.toFixed(3));
  ln.setAttribute("y1", a.y.toFixed(3));
  ln.setAttribute("x2", b.x.toFixed(3));
  ln.setAttribute("y2", b.y.toFixed(3));
  ln.setAttribute("stroke", "#000");
  ln.setAttribute("fill", "none");
  ln.setAttribute("vector-effect", "non-scaling-stroke");
  if (dasharray) ln.setAttribute("stroke-dasharray", dasharray);
  ln.classList.add("bg-stroke");
  ln.dataset.bgIdx = String(idx);
  ln.dataset.bgUser = "1";
  bgSvgEl.appendChild(ln);          // bgSvg root(bg-orig 群組外,不被 clip)
  return ln;
}

function addBgLineWorld(file, p1World, p2World, opts) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return null;
  let maxIdx = -1;
  bgSvgEl.querySelectorAll("[data-bg-idx]").forEach(el => {
    const n = parseInt(el.dataset.bgIdx, 10);
    if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
  });
  const newIdx = maxIdx + 1;
  const dasharray = (opts && opts.dasharray) || null;
  const ln = _appendUserBgLineDom(bgSvgEl, p1World, p2World, newIdx, dasharray);
  // 紀錄到 file.userBgLines,讓 undo/redo 與專案存檔可以重建
  if (!Array.isArray(file.userBgLines)) file.userBgLines = [];
  file.userBgLines.push({
    idx: newIdx,
    x1: p1World.x, y1: p1World.y,
    x2: p2World.x, y2: p2World.y,
    dasharray: dasharray || undefined,
  });
  try { file.cachedBgSvg = new XMLSerializer().serializeToString(bgSvgEl); } catch (_) {}
  updateBgStrokeWidth();
  return { idx: newIdx, el: ln };
}

// 把 file.userBgLines(權威資料)同步到 bgSvg DOM:先移除既有的 [data-bg-user="1"] 線,
//   再依資料逐條重建。專供 undo / redo 使用。
function syncUserBgLinesToDom(file) {
  if (!file) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  bgSvgEl.querySelectorAll('[data-bg-user="1"]').forEach(el => el.remove());
  const lines = Array.isArray(file.userBgLines) ? file.userBgLines : [];
  for (const ln of lines) {
    _appendUserBgLineDom(
      bgSvgEl,
      { x: ln.x1, y: ln.y1 },
      { x: ln.x2, y: ln.y2 },
      ln.idx,
      ln.dasharray || null
    );
  }
  try { file.cachedBgSvg = new XMLSerializer().serializeToString(bgSvgEl); } catch (_) {}
  updateBgStrokeWidth();
}

// 畫直線 / 畫虛線 / 複製線 / 中分線 / 等分線 相關按鈕的 active 視覺狀態
function _refreshBgDrawButtonStates() {
  const isDashed = !!(state.bgDrawLine && state.bgDrawLine.active && state.bgDrawLine.dasharray);
  const isSolid  = !!(state.bgDrawLine && state.bgDrawLine.active && !state.bgDrawLine.dasharray);
  const dl = $("bgEditDrawLine");
  if (dl) dl.classList.toggle("active", isSolid);
  const dd = $("bgEditDrawDashed");
  if (dd) dd.classList.toggle("active", isDashed);
  const cp = $("bgEditCopyLine");
  if (cp) cp.classList.toggle("active", !!(state.bgCopyLine && state.bgCopyLine.active));
  const bs = $("bgEditBisector");
  if (bs) bs.classList.toggle("active", !!(state.bgBisector && state.bgBisector.active));
  const eq = $("bgEditEquidist");
  if (eq) eq.classList.toggle("active", !!(state.bgEqui && state.bgEqui.active));
}

// ---------- 畫直線 / 畫虛線 ----------
//   兩者共用 state.bgDrawLine 狀態與 commit 流程,差別只在 dasharray:
//   實線 → null;虛線 → 預設樣式 "8 4"(跟「轉虛線」共用)。
function startBgDrawLine(opts) {
  if (state.tool !== "selectBg") setTool("selectBg");
  const dashed = !!(opts && opts.dashed);
  state.bgDrawLine = { active: true, p1: null, dasharray: dashed ? "8 4" : null };
  state.bgBisector = null;
  state.bgEqui = null;
  state.bgCopyLine = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = dashed
    ? "畫虛線:點選第一個點(自動吸 bg 端點 / 交點。Alt = 也吸線中段。Esc 取消)"
    : "畫直線:點選第一個點(自動吸 bg 端點 / 交點。Alt = 也吸線中段。Esc 取消)";
  render();
}
function exitBgDrawLine(msg) {
  if (!state.bgDrawLine) return;
  state.bgDrawLine = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
function commitBgDrawLineSecond(world) {
  const file = getActiveFile();
  if (!file || !state.bgDrawLine || !state.bgDrawLine.p1) return;
  const p1 = state.bgDrawLine.p1;
  const dasharray = state.bgDrawLine.dasharray || null;
  pushUndo();
  addBgLineWorld(file, p1, world, dasharray ? { dasharray } : undefined);
  state.bgDrawLine = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = dasharray ? "已加入 bg 虛線" : "已加入 bg 直線";
  render();
}
$("bgEditDrawLine") && ($("bgEditDrawLine").onclick = () => startBgDrawLine());
$("bgEditDrawDashed") && ($("bgEditDrawDashed").onclick = () => startBgDrawLine({ dashed: true }));

// ---------- 複製線(實線 / 虛線都支援) ----------
//   流程:
//     a) 進入時若已有選取的 bg 線 → 直接抓成 sources,進入「點基準點」
//     b) 進入時無選取 → 進入「選 source」,使用者點任一條 bg 線當來源後再進「點基準點」
//     c) 基準點設好後,每次點擊 = 放置一份新線(基準點不變,連續複製)
//   Esc 或切換到其他工具就退出。
function _captureSourceFromElement(elx) {
  if (!elx) return null;
  const L = bgSingleLineWorldEnds(elx);
  if (!L) return null;
  let dash = elx.getAttribute && elx.getAttribute("stroke-dasharray");
  if (!dash) {
    const sty = elx.getAttribute && elx.getAttribute("style");
    const m = sty && sty.match(/stroke-dasharray\s*:\s*([^;]+)/i);
    if (m) dash = m[1].trim();
  }
  return { p1: { x: L.p1.x, y: L.p1.y }, p2: { x: L.p2.x, y: L.p2.y }, dasharray: dash || null };
}
function startBgCopyLine() {
  if (state.tool !== "selectBg") setTool("selectBg");
  const file = getActiveFile();
  state.bgDrawLine = null;
  state.bgBisector = null;
  state.bgEqui = null;
  // 若已有選取 → 抓成 sources;否則 sources=[](用 pickingSource 旗標等使用者點線)
  const sources = [];
  if (file && file.selectedBgPaths && file.selectedBgPaths.size) {
    const bgSvgEl = document.getElementById("bgSvg");
    for (const idx of file.selectedBgPaths) {
      const elx = bgSvgEl && bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(idx))}"]`);
      const src = _captureSourceFromElement(elx);
      if (src) sources.push(src);
    }
    // 已轉成 sources,清掉視覺選取:複製線進行中不該有「選取狀態」殘留干擾
    clearAllBgSelection && clearAllBgSelection(file);
  }
  state.bgCopyLine = { active: true, sources, base: null };
  _refreshBgDrawButtonStates();
  if (sources.length) {
    $("hud").textContent = `複製線:選了 ${sources.length} 條 → 點基準點(自動吸 bg 端點 / 交點)`;
  } else {
    $("hud").textContent = `複製線:點一條要複製的 bg 線(實線 / 虛線都可)`;
  }
  render();
}
function exitBgCopyLine(msg) {
  if (!state.bgCopyLine) return;
  state.bgCopyLine = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
function commitBgCopyLineDest(world) {
  const file = getActiveFile();
  const cl = state.bgCopyLine;
  if (!file || !cl || !cl.active || !cl.base || !cl.sources.length) return;
  const dx = world.x - cl.base.x, dy = world.y - cl.base.y;
  pushUndo();
  let n = 0;
  for (const src of cl.sources) {
    const p1 = { x: src.p1.x + dx, y: src.p1.y + dy };
    const p2 = { x: src.p2.x + dx, y: src.p2.y + dy };
    addBgLineWorld(file, p1, p2, src.dasharray ? { dasharray: src.dasharray } : undefined);
    n++;
  }
  $("hud").textContent = `複製線:放置 ${n} 條(再點下一處,Esc 結束)`;
  render();
}
$("bgEditCopyLine") && ($("bgEditCopyLine").onclick = () => startBgCopyLine());

// ---------- 中分線 ----------
function startBgBisector() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size < 1) {
    alert("請先選 1 條 bg 線"); return;
  }
  const lines = _selectedBgLinesAsWorld(file);
  if (lines.length < 1) { alert("選取的不是單一直線(可先「切成直線」)"); return; }
  const L = lines[0];
  const dx = L.p2.x - L.p1.x, dy = L.p2.y - L.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { alert("選取的線段太短"); return; }
  const mid = { x: (L.p1.x + L.p2.x) / 2, y: (L.p1.y + L.p2.y) / 2 };
  const nx = -dy / len, ny = dx / len;
  state.bgBisector = { active: true, mid, nx, ny, halfLen: len / 2 };
  state.bgDrawLine = null;
  state.bgEqui = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = "中分線:移動滑鼠決定半長,點擊確認 / Esc 取消";
  render();
}
function exitBgBisector(msg) {
  if (!state.bgBisector) return;
  state.bgBisector = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
function updateBgBisectorPreview(clientX, clientY) {
  const b = state.bgBisector; if (!b) return;
  const w = screenToWorld(clientX, clientY);
  // 投影 (w - mid) 到法向量 (nx, ny);取絕對值為半長
  const dx = w.x - b.mid.x, dy = w.y - b.mid.y;
  const t = dx * b.nx + dy * b.ny;
  b.halfLen = Math.max(1, Math.abs(t));
  render();
}
function commitBgBisector() {
  const file = getActiveFile();
  const b = state.bgBisector; if (!file || !b) return;
  const p1 = { x: b.mid.x - b.nx * b.halfLen, y: b.mid.y - b.ny * b.halfLen };
  const p2 = { x: b.mid.x + b.nx * b.halfLen, y: b.mid.y + b.ny * b.halfLen };
  pushUndo();
  addBgLineWorld(file, p1, p2);
  state.bgBisector = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = `已加入中分線(半長 ${b.halfLen.toFixed(0)})`;
  render();
}
$("bgEditBisector") && ($("bgEditBisector").onclick = () => startBgBisector());

// ---------- 等分線(兩條近似平行 bg 線之間的等距平行線)----------
function startBgEqui() {
  const file = getActiveFile();
  const lines = _selectedBgLinesAsWorld(file);
  if (lines.length < 2) { alert("請選 2 條以上 bg 線(系統自動找平行對)"); return; }
  // 共線視為同一條(允許重疊 / 同條線多次選到)→ 各 group 取代表
  const groups = groupCollinearLines(lines);
  if (groups.length < 2) { alert("選取的線都共線(同一條),需選 2 條不同位置的平行線"); return; }
  const reps = groups.map(g => lines[g[0]]);
  // 在所有獨立線兩兩中,找第一對平行(夾角 ≤ 3°,sin ≤ 0.05)的
  let L1 = null, L2 = null, sinTheta = 0;
  outer:
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      const v1 = { x: reps[i].p2.x - reps[i].p1.x, y: reps[i].p2.y - reps[i].p1.y };
      const v2 = { x: reps[j].p2.x - reps[j].p1.x, y: reps[j].p2.y - reps[j].p1.y };
      const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
      if (len1 < 1e-6 || len2 < 1e-6) continue;
      const s = Math.abs((v1.x * v2.y - v1.y * v2.x) / (len1 * len2));
      if (s <= 0.05) {
        L1 = reps[i]; L2 = reps[j]; sinTheta = s;
        break outer;
      }
    }
  }
  if (!L1) {
    // 找不到嚴格平行 → 提示使用者
    alert(`選取的 ${reps.length} 條獨立線中找不到平行對(夾角都 > 3°),無法畫等分線`);
    return;
  }
  // 同向化(若 v2 反向就翻)
  const v1 = { x: L1.p2.x - L1.p1.x, y: L1.p2.y - L1.p1.y };
  const v2 = { x: L2.p2.x - L2.p1.x, y: L2.p2.y - L2.p1.y };
  const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
  const dot = v1.x * v2.x + v1.y * v2.y;
  const v2s = dot >= 0 ? v2 : { x: -v2.x, y: -v2.y };
  const ux1 = v1.x / len1, uy1 = v1.y / len1;
  const ux2 = v2s.x / len2, uy2 = v2s.y / len2;
  let dx = (ux1 + ux2) / 2, dy = (uy1 + uy2) / 2;
  const dl = Math.hypot(dx, dy);
  if (dl < 1e-6) { alert("方向計算失敗"); return; }
  dx /= dl; dy /= dl;
  const m1 = { x: (L1.p1.x + L1.p2.x) / 2, y: (L1.p1.y + L1.p2.y) / 2 };
  const m2 = { x: (L2.p1.x + L2.p2.x) / 2, y: (L2.p1.y + L2.p2.y) / 2 };
  const center = { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 };
  const halfLen = (len1 + len2) / 4;
  state.bgEqui = { active: true, center, dx, dy, halfLen };
  state.bgDrawLine = null;
  state.bgBisector = null;
  _refreshBgDrawButtonStates();
  const msg = (reps.length > 2)
    ? `等分線:從 ${reps.length} 條獨立線中找到平行對 — 移動滑鼠決定總長,點擊確認 / Esc 取消`
    : "等分線:移動滑鼠決定總長(對稱拉長),點擊確認 / Esc 取消";
  $("hud").textContent = msg;
  render();
}
function exitBgEqui(msg) {
  if (!state.bgEqui) return;
  state.bgEqui = null;
  _refreshBgDrawButtonStates();
  if (msg != null) $("hud").textContent = msg;
  render();
}
function updateBgEquiPreview(clientX, clientY) {
  const e = state.bgEqui; if (!e) return;
  const w = screenToWorld(clientX, clientY);
  // 投影 (w - center) 到方向 (dx, dy);取絕對值為半長
  const t = (w.x - e.center.x) * e.dx + (w.y - e.center.y) * e.dy;
  e.halfLen = Math.max(1, Math.abs(t));
  render();
}
function commitBgEqui() {
  const file = getActiveFile();
  const e = state.bgEqui; if (!file || !e) return;
  const p1 = { x: e.center.x - e.dx * e.halfLen, y: e.center.y - e.dy * e.halfLen };
  const p2 = { x: e.center.x + e.dx * e.halfLen, y: e.center.y + e.dy * e.halfLen };
  pushUndo();
  // 等分線視為中心線:用 CENTER pattern 虛線(stroke-dasharray)
  addBgLineWorld(file, p1, p2, { dasharray: "12 4 4 4" });
  state.bgEqui = null;
  _refreshBgDrawButtonStates();
  $("hud").textContent = `已加入等分線(半長 ${e.halfLen.toFixed(0)},虛線樣式)`;
  render();
}
$("bgEditEquidist") && ($("bgEditEquidist").onclick = () => startBgEqui());

// 轉虛線:對所有選取的 bg 線切換 stroke-dasharray
//   元素已有 dasharray → 移除(轉成實線)
//   元素無 dasharray → 套用預設 "8 4"(轉成虛線)
//   不影響選取狀態,只改線型
function bgToggleDashedOnSelection() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  pushUndo();
  let toDashed = 0, toSolid = 0;
  for (const idx of file.selectedBgPaths) {
    const el = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(idx))}"]`);
    if (!el) continue;
    if (el.hasAttribute("stroke-dasharray")) {
      el.removeAttribute("stroke-dasharray");
      toSolid++;
    } else {
      el.setAttribute("stroke-dasharray", "8 4");
      toDashed++;
    }
  }
  // 同步 cachedBgSvg
  try { file.cachedBgSvg = new XMLSerializer().serializeToString(bgSvgEl); } catch (_) {}
  $("hud").textContent = `轉虛線:${toDashed} 條變虛線、${toSolid} 條變實線`;
  render();
}
$("bgEditToDashed") && ($("bgEditToDashed").onclick = () => bgToggleDashedOnSelection());

// 比例尺沿線移動 — 點擊式互動:
//   1) 按按鈕 → 進入 drag 模式,記下原本 p1/p2(用於 Esc 還原)
//   2) 滑鼠 mouse-move → 即時把游標投影到比例尺的「參考線方向」軸上,sr.p1/p2 同步平移
//   3) 點擊畫布 → 確認當前位置(sr.p1/p2 已經就位),退出模式
//   4) Esc → 還原到 backup,退出模式
function startScaleRulerDrag() {
  const file = getActiveFile();
  if (!file || !file.scaleRuler) { alert("尚未建立比例尺。"); return; }
  pushUndo();
  state.scaleRulerDrag = {
    active: true,
    fileId: file.id,
    backup: {
      p1: { ...file.scaleRuler.p1 },
      p2: { ...file.scaleRuler.p2 },
    },
  };
  $("hud").textContent = "比例尺沿線移動:移動滑鼠預覽,點擊確定 / Esc 取消";
  render();
}
function _scaleRulerAxisUnit(sr) {
  const dx = sr.p2.x - sr.p1.x, dy = sr.p2.y - sr.p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  // twoLines:p1→p2 垂直於參考線 → 旋轉 90°
  // 線段型:沿 p1→p2 方向
  if (sr.type === "twoLines") return { ux: -dy / len, uy: dx / len };
  return { ux: dx / len, uy: dy / len };
}
function updateScaleRulerDragPreview(clientX, clientY) {
  const drag = state.scaleRulerDrag;
  if (!drag || !drag.active) return;
  const file = state.files.find(f => f.id === drag.fileId);
  if (!file || !file.scaleRuler) return;
  const sr = file.scaleRuler;
  const u = _scaleRulerAxisUnit({ ...sr, p1: drag.backup.p1, p2: drag.backup.p2 });
  if (!u) return;
  const w = screenToWorld(clientX, clientY);
  // 投影:游標相對 backup 中點 → 沿軸 (ux, uy) 的純量
  const cx = (drag.backup.p1.x + drag.backup.p2.x) / 2;
  const cy = (drag.backup.p1.y + drag.backup.p2.y) / 2;
  const t = (w.x - cx) * u.ux + (w.y - cy) * u.uy;
  // 套到 p1/p2 = backup + t * 軸
  sr.p1.x = drag.backup.p1.x + u.ux * t;
  sr.p1.y = drag.backup.p1.y + u.uy * t;
  sr.p2.x = drag.backup.p2.x + u.ux * t;
  sr.p2.y = drag.backup.p2.y + u.uy * t;
  // HUD 顯示已位移多少 mm
  const ratio = state.scale ? state.scale : sr.ratio;
  const distMm = ratio ? t * ratio : t;
  $("hud").textContent = `比例尺沿線移動:位移 ${distMm.toFixed(1)} ${state.unitName || "mm"}(點擊確定 / Esc 取消)`;
  render();
}
function commitScaleRulerDrag() {
  // sr.p1/p2 已經是預覽位置 → 直接退出即「採用」
  state.scaleRulerDrag = null;
  $("hud").textContent = "比例尺沿線移動完成";
  render();
}
function cancelScaleRulerDrag() {
  const drag = state.scaleRulerDrag;
  if (!drag) return;
  const file = state.files.find(f => f.id === drag.fileId);
  if (file && file.scaleRuler) {
    file.scaleRuler.p1 = drag.backup.p1;
    file.scaleRuler.p2 = drag.backup.p2;
  }
  state.scaleRulerDrag = null;
  $("hud").textContent = "比例尺沿線移動已取消";
  render();
}
$("ctxBgScaleRuler") && ($("ctxBgScaleRuler").onclick = (e) => { e.stopPropagation(); hideCtxMenu(); bgCreateScaleRuler(); });
$("bgEditSelectAll") && ($("bgEditSelectAll").onclick = () => withBusy("全選底圖線條中…", selectAllBgPaths));
$("bgEditClear")     && ($("bgEditClear").onclick    = () => withBusy("取消選取中…", () => clearAllBgSelection(getActiveFile())));
$("bgEditSplit")     && ($("bgEditSplit").onclick    = () => withBusy("拆分為直線中…", bgPathsSplitToLines));
$("bgEditToMember")  && ($("bgEditToMember").onclick = () => withBusy("轉為桿件中…", bgPathsToMembers));
$("bgEditDel")       && ($("bgEditDel").onclick      = () => withBusy("刪除中…", deleteSelectedBgPaths));
// ---------- 選取工具浮動面板 ----------
// 依目前選取狀態切換編輯按鈕的顯示
export function updateSelectToolsVisibility() {
  const hasMembers = state.selection.members && state.selection.members.size > 0;
  const hasJoints  = state.selection.joints  && state.selection.joints.size  > 0;
  const showLine  = hasMembers ? "" : "none";
  const showJoint = hasJoints  ? "" : "none";
  // 桿件編輯:選取裡有桿件才顯示
  if ($("selToolsExtend"))     $("selToolsExtend").style.display     = showLine;
  if ($("selToolsExtendBoth")) $("selToolsExtendBoth").style.display = showLine;
  // 點編輯(延桿系列):選取裡有節點才顯示;只選線時隱藏
  if ($("selToolsJExtH"))      $("selToolsJExtH").style.display      = showJoint;
  if ($("selToolsJExtV"))      $("selToolsJExtV").style.display      = showJoint;
  if ($("selToolsJExtHBoth"))  $("selToolsJExtHBoth").style.display  = showJoint;
  if ($("selToolsJExtVBoth"))  $("selToolsJExtVBoth").style.display  = showJoint;
  // 節點水平/垂直複製:選取裡有節點才顯示
  if ($("selToolsDupJointH"))  $("selToolsDupJointH").style.display  = showJoint;
  if ($("selToolsDupJointV"))  $("selToolsDupJointV").style.display  = showJoint;
  // 點點連結:至少要兩個節點才有意義
  const jointCount = state.selection.joints ? state.selection.joints.size : 0;
  const showConnect = jointCount >= 2 ? "" : "none";
  if ($("selToolsJConnectH"))  $("selToolsJConnectH").style.display  = showConnect;
  if ($("selToolsJConnectV"))  $("selToolsJConnectV").style.display  = showConnect;
  if ($("selToolsJConnectD"))  $("selToolsJConnectD").style.display  = showConnect;
  // 兩點合一:剛好 2 個節點才顯示
  const showMerge = jointCount === 2 ? "" : "none";
  if ($("selToolsJMerge"))     $("selToolsJMerge").style.display     = showMerge;
  // 標示距離(選取模式):至少選 1 個桿件才顯示
  const memberCount = state.selection.members ? state.selection.members.size : 0;
  if ($("selToolsMeasure"))    $("selToolsMeasure").style.display    = memberCount >= 1 ? "" : "none";
  // 切交點(選取):≥ 2 個桿件才有意義
  if ($("selToolsIntersectSel")) $("selToolsIntersectSel").style.display = memberCount >= 2 ? "" : "none";
}

function selToolsSelectAll() {
  const p = getPage(); if (!p) return;
  clearSelection();
  for (const j of p.joints) state.selection.joints.add(j.id);
  for (const m of p.members) state.selection.members.add(m.id);
  render(); refreshLists();
}
function selToolsSelectJoints() {
  const p = getPage(); if (!p) return;
  clearSelection();
  for (const j of p.joints) state.selection.joints.add(j.id);
  render(); refreshLists();
}
function selToolsSelectMembers() {
  const p = getPage(); if (!p) return;
  clearSelection();
  for (const m of p.members) state.selection.members.add(m.id);
  render(); refreshLists();
}
// axis: "horizontal" = 同 y(水平對齊);"vertical" = 同 x(垂直對齊)
// kind:  "all"     = 從節點+桿件取參考座標,並同時擴展節點+桿件
//        "joints"  = 只從「選取中的節點」取 y/x,擴展節點(沒選節點 → 不動)
//        "members" = 只從「選取中的桿件」取 y/x,擴展桿件(沒選桿件 → 不動)
// axis:        "horizontal" (同 Y) | "vertical" (同 X)
// kind:        "all" | "joints" | "members"
// orientation: undefined (任何方向) | "horizontal" | "vertical" | "diagonal"
//   只在 kind 含 members 時對 member 套用 orientation 過濾
function selToolsExtendAlong(axis, kind, orientation) {
  const p = getPage(); if (!p) return;
  const round = (n) => Math.round(n * 100) / 100;
  const eps = 0.5;
  const matchesOrient = (m) => {
    if (!orientation) return true;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) return false;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (orientation === "horizontal") return dy < eps && dx >= eps;
    if (orientation === "vertical")   return dx < eps && dy >= eps;
    if (orientation === "orthogonal") return dy < eps || dx < eps;        // 水平 ∪ 垂直
    if (orientation === "diagonal")   return dx >= eps && dy >= eps;
    return true;
  };
  // 取桿件「中點 + 端點對端點長度(在另一軸上)」當 key
  //   axis=horizontal:key = midY|dy(同列 + 端點垂直距離一致)
  //   axis=vertical  :key = midX|dx(同欄 + 端點水平距離一致)
  // 這個條件對水平/垂直桿件來說自然成立(dy=0 或 dx=0),對斜桿件起到「形狀一致」的過濾
  const memberKey = (m) => {
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) return null;
    const mid = round(axis === "horizontal" ? (a.y + b.y) / 2 : (a.x + b.x) / 2);
    const span = round(axis === "horizontal" ? Math.abs(a.y - b.y) : Math.abs(a.x - b.x));
    return `${mid}|${span}`;
  };
  const jointCoords = new Set();
  const memberKeys = new Set();
  if (kind === "all" || kind === "joints") {
    for (const id of state.selection.joints) {
      const j = jointById(id); if (!j) continue;
      jointCoords.add(round(axis === "horizontal" ? j.y : j.x));
    }
  }
  if (kind === "all" || kind === "members") {
    for (const id of state.selection.members) {
      const m = p.members.find(mm => mm.id === id);
      if (!m) continue;
      if (!matchesOrient(m)) continue;
      const k = memberKey(m);
      if (k) memberKeys.add(k);
    }
  }
  if (jointCoords.size === 0 && memberKeys.size === 0) return;
  if (kind === "all" || kind === "joints") {
    for (const j of p.joints) {
      const v = round(axis === "horizontal" ? j.y : j.x);
      if (jointCoords.has(v)) state.selection.joints.add(j.id);
    }
  }
  if (kind === "all" || kind === "members") {
    for (const m of p.members) {
      if (!matchesOrient(m)) continue;
      const k = memberKey(m);
      if (k && memberKeys.has(k)) state.selection.members.add(m.id);
    }
  }
  render(); refreshLists();
}
$("selToolsAll")      && ($("selToolsAll").onclick      = selToolsSelectAll);
$("selToolsJoints")   && ($("selToolsJoints").onclick   = selToolsSelectJoints);
$("selToolsMembers")  && ($("selToolsMembers").onclick  = selToolsSelectMembers);
$("selToolsRepeatHJ") && ($("selToolsRepeatHJ").onclick = () => selToolsExtendAlong("horizontal", "joints"));
$("selToolsRepeatVJ") && ($("selToolsRepeatVJ").onclick = () => selToolsExtendAlong("vertical",   "joints"));
$("selToolsRepeatOH") && ($("selToolsRepeatOH").onclick = () => selToolsExtendAlong("horizontal", "members", "orthogonal"));
$("selToolsRepeatOV") && ($("selToolsRepeatOV").onclick = () => selToolsExtendAlong("vertical",   "members", "orthogonal"));
$("selToolsRepeatDH") && ($("selToolsRepeatDH").onclick = () => selToolsExtendAlong("horizontal", "members", "diagonal"));
$("selToolsRepeatDV") && ($("selToolsRepeatDV").onclick = () => selToolsExtendAlong("vertical",   "members", "diagonal"));
// 阻止選取面板點擊冒泡到畫布
["selectTools"].forEach(id => {
  const el = $(id); if (!el) return;
  ["click","mousedown","mouseup","dblclick","wheel"].forEach(ev =>
    el.addEventListener(ev, (e) => e.stopPropagation()));
});

$("bgEditSelSquares")   && ($("bgEditSelSquares").onclick   = () => toggleShapeMarqueeMode("square"));
$("bgEditSelRects")     && ($("bgEditSelRects").onclick     = () => toggleShapeMarqueeMode("rect"));
$("bgEditSelCircles")   && ($("bgEditSelCircles").onclick   = () => toggleShapeMarqueeMode("circle"));
$("bgEditSelStraight") && ($("bgEditSelStraight").onclick = () => toggleShapeMarqueeMode("straight"));
$("bgEditSelStraightSolid") && ($("bgEditSelStraightSolid").onclick = () => toggleShapeMarqueeMode("straightSolid"));
$("bgEditSelDiagonals") && ($("bgEditSelDiagonals").onclick = () => toggleShapeMarqueeMode("diagonal"));
$("bgEditSelDashedDiagonals") && ($("bgEditSelDashedDiagonals").onclick = () => toggleShapeMarqueeMode("dashedDiagonal"));
$("bgEditClearShape")   && ($("bgEditClearShape").onclick   = () => clearAllShapeMarqueeModes());
$("bgEditMultiSelect") && ($("bgEditMultiSelect").onclick = () => toggleBgMultiSelect());
$("bgEditMarkIntersect") && ($("bgEditMarkIntersect").onclick = () => withBusy("計算交點中…", bgConvertToIntersections));
// 多線轉交點 + 桿件:組合操作
//   1. 加交點節點(只接受實際相交,不延伸)— bgConvertToIntersections strict
//   2. 視覺上把無實際相交的孤立線從選取剔除
//   3. 對「每條有 ≥ 2 個交點的線」依 t 排序,在連續兩個交點之間建桿件
//      (規則:桿件只能在交點與交點之間 — 端點到交點的尾段一律不建)
$("bgEditMarkIntersectAndMember") && ($("bgEditMarkIntersectAndMember").onclick = () =>
  withBusy("轉交點與桿件中…", async () => {
    const r = await bgConvertToIntersections({ strict: true });
    if (!r) return;
    const file = getActiveFile();
    // 視覺剔除:無實際相交的選取線
    if (file && file.selectedBgPaths && r.participatingSrcs) {
      const bgSvgEl = document.getElementById("bgSvg");
      const before = file.selectedBgPaths.size;
      const keep = new Set();
      for (const k of file.selectedBgPaths) {
        if (r.participatingSrcs.has(String(k))) keep.add(k);
        else if (bgSvgEl) {
          const el2 = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(k))}"]`);
          if (el2) el2.classList.remove("bg-selected");
        }
      }
      file.selectedBgPaths = keep;
      const dropped = before - keep.size;
      if (dropped > 0) $("hud").textContent = `已剔除 ${dropped} 條無實際相交的孤立線,剩 ${keep.size} 條`;
      if (keep.size === 0) {
        alert("選取的線之間沒有任何實際相交,無法產生桿件。");
        updateBgEditOpsVisibility();
        return;
      }
    }
    await busyTick();
    setBusyMessage("生成交點間桿件中…");
    const stat = bgBuildMembersBetweenIntersections(r.segIntersections);
    updateBgEditOpsVisibility();
    render(); refreshLists();
    $("hud").textContent =
      `交點 ${r.totalIntersections}・新增節點 ${r.addedJoints}・` +
      `桿件 ${stat.created}(已存在 ${stat.existed},僅交點之間)`;
  })
);

// 把每條 segment(以 segIdx 為 key)上的交點依 t 排序,於連續兩個交點之間建桿件
//   只接受交點之間的段;端點到交點的尾段不建。
//   回傳 { created, existed }(新增的桿件數 / 因已存在被跳過的數)
function bgBuildMembersBetweenIntersections(segIntersections) {
  const p = getPage();
  if (!p || !Array.isArray(p.members)) return { created: 0, existed: 0 };
  // 已存在桿件查表:無向 (j1, j2)
  const existKey = new Set();
  for (const m of p.members) {
    const k = m.j1 < m.j2 ? `${m.j1}|${m.j2}` : `${m.j2}|${m.j1}`;
    existKey.add(k);
  }
  let created = 0, existed = 0;
  for (const idxStr in segIntersections) {
    const ixs = (segIntersections[idxStr] || []).slice();
    if (ixs.length < 2) continue;
    ixs.sort((a, b) => a.t - b.t);
    // 同一 segment 上若多個交點對應同一個 jointId(極短距離合併),先去重
    const dedup = [];
    for (const ix of ixs) {
      if (ix.jointId == null) continue;
      if (dedup.length > 0 && dedup[dedup.length - 1].jointId === ix.jointId) continue;
      dedup.push(ix);
    }
    if (dedup.length < 2) continue;
    for (let i = 0; i < dedup.length - 1; i++) {
      const j1 = dedup[i].jointId, j2 = dedup[i + 1].jointId;
      if (j1 == null || j2 == null || j1 === j2) continue;
      const k = j1 < j2 ? `${j1}|${j2}` : `${j2}|${j1}`;
      if (existKey.has(k)) { existed++; continue; }
      addMember(j1, j2);
      existKey.add(k);
      created++;
    }
  }
  return { created, existed };
}

// 多線模式專用:對所有選取的底圖線段兩兩求交,在每個唯一交點新增節點。
//   opts.strict = true:只接受「線段實際相交 / 端點相觸」的交點(不允許延伸)
//                       線上參數 t / u 必須落在 [0, 1] 內(容差 = eps 世界單位 / 線段長)
//   opts.strict 未設(預設):允許延伸線交點,接受範圍 = 圖面尺寸 × 2
//   平行線(denom ≈ 0)直接略過。已有同位節點的交點不重複新增。
async function bgConvertToIntersections(opts) {
  const strict = !!(opts && opts.strict);
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size < 2) {
    alert("請至少選取 2 條底圖線。");
    return;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) { alert("找不到底圖。"); return; }

  // 收集所有選取 path 的線段(轉到世界座標)
  // pdf.js 出來的 bgSvg 內部 path 用自己的 viewBox 座標(非世界座標),
  // 必須經 getScreenCTM → screen → screenToWorld 才能跟 page joints 比對。
  const segs = [];
  for (const key of file.selectedBgPaths) {
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(key))}"]`);
    if (!el2 || el2.style.display === "none") continue;
    const sub = svgElementToSegments(el2);
    if (sub.length === 0) continue;
    const ctm = el2.getScreenCTM && el2.getScreenCTM();
    const owner = el2.ownerSVGElement || bgSvgEl;
    if (!ctm) {
      // 沒有 CTM(理論上不該發生)→ 退回把 path 座標當世界座標,起碼不 crash
      for (const s of sub) segs.push({ ...s, src: String(key), segIdx: segs.length });
      continue;
    }
    for (const s of sub) {
      const p1 = owner.createSVGPoint(); p1.x = s.x1; p1.y = s.y1;
      const p2 = owner.createSVGPoint(); p2.x = s.x2; p2.y = s.y2;
      const sp1 = p1.matrixTransform(ctm);    // path → screen
      const sp2 = p2.matrixTransform(ctm);
      const w1 = screenToWorld(sp1.x, sp1.y); // screen → world
      const w2 = screenToWorld(sp2.x, sp2.y);
      segs.push({ x1: w1.x, y1: w1.y, x2: w2.x, y2: w2.y, src: String(key), segIdx: segs.length });
    }
  }
  if (segs.length < 2) { alert("有效線段太少,無法求交。"); return; }

  // 延伸上限:圖面範圍 (clipRect 優先,否則整張底圖) 往外擴大一倍。
  //   原圖面 [bx, by, bx+bw, by+bh] → 接受範圍 [bx - bw/2, by - bh/2, bx + bw*1.5, by + bh*1.5]
  //   也就是每邊往外延伸半個圖面尺寸,總接受範圍 = 圖面尺寸 × 2
  const cr = file.clipRect;
  const bx = cr ? cr.x : 0;
  const by = cr ? cr.y : 0;
  const bw = cr ? cr.w : state.bgWidth;
  const bh = cr ? cr.h : state.bgHeight;
  const minX = bx - bw / 2, maxX = bx + bw * 1.5;
  const minY = by - bh / 2, maxY = by + bh * 1.5;
  const inBounds = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;

  const eps = 0.5;     // 同位容差(世界座標)
  const found = [];    // 候選交點 [{x, y}]
  const same = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
  const participatingSrcs = new Set();   // 真正參與「被接受相交」的線段 src(供 +桿件 流程過濾)
  // 每個 segment(以 segIdx 為 key)上接受到的交點:[{ t, x, y, jointId? }]
  // 用於 +桿件 流程把每條線只切出「交點與交點之間」的桿件
  const segIntersections = {};
  const ensureIxArr = (idx) => (segIntersections[idx] || (segIntersections[idx] = []));
  let inSeg = 0, extended = 0, rejected = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let k = i + 1; k < segs.length; k++) {
      const a = segs[i], b = segs[k];
      const r = lineLineIntersect(
        { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 },
        { x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }
      );
      if (!r) continue;                          // 平行
      // strict:只接受實際相交(t、u 都在 [0,1] 內,容差 = eps 世界單位 / 線段長)
      if (strict) {
        const lenA = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1;
        const lenB = Math.hypot(b.x2 - b.x1, b.y2 - b.y1) || 1;
        const tEpsA = eps / lenA, tEpsB = eps / lenB;
        if (r.t < -tEpsA || r.t > 1 + tEpsA) { rejected++; continue; }
        if (r.u < -tEpsB || r.u > 1 + tEpsB) { rejected++; continue; }
      } else if (!inBounds(r.x, r.y)) { continue; } // 非 strict:超出「圖面 × 2」接受範圍 reject
      // 此 (a, b) 配對被接受 → 不論是否與既有 found 同位,兩條都算參與
      participatingSrcs.add(a.src);
      participatingSrcs.add(b.src);
      ensureIxArr(a.segIdx).push({ t: r.t, x: r.x, y: r.y });
      ensureIxArr(b.segIdx).push({ t: r.u, x: r.x, y: r.y });
      if (!found.some(p => same(p, r))) {
        found.push(r);
        if (r.t > 0 && r.t < 1 && r.u > 0 && r.u < 1) inSeg++;
        else extended++;
      }
    }
    if ((i & 31) === 0) await busyTick();
  }

  if (found.length === 0) {
    alert(strict
      ? "沒有找到任何實際相交點(線段需真正交會 / 端點相觸)。"
      : "沒有找到任何交點(交點都超出圖面 ×2 的範圍)。");
    return { participatingSrcs, segIntersections, segs, addedJoints: 0, totalIntersections: 0 };
  }

  // 過濾掉已存在於 page joints 的位置
  const p = getPage();
  const existing = p.joints || [];
  const isNew = (ip) => !existing.some(j => Math.hypot(j.x - ip.x, j.y - ip.y) < eps);
  const toAdd = found.filter(isNew);
  if (toAdd.length > 0) {
    pushUndo();
    for (const ip of toAdd) p.joints.push({ id: nextJointId++, x: ip.x, y: ip.y });
  }
  // 把每個交點對應到 page joint id(新建或既有)— 提供給 +桿件 流程用
  for (const arr of Object.values(segIntersections)) {
    for (const ix of arr) {
      const j = p.joints.find(jt => Math.hypot(jt.x - ix.x, jt.y - ix.y) < eps);
      if (j) ix.jointId = j.id;
    }
  }
  render(); refreshLists();
  if (toAdd.length === 0) {
    $("hud").textContent = `所有 ${found.length} 個交點皆已有節點(線內 ${inSeg}・延伸 ${extended})`;
  } else {
    $("hud").textContent = `已新增 ${toAdd.length} 個交點節點(線內 ${inSeg}・延伸 ${extended})`;
  }
  return { participatingSrcs, segIntersections, segs, addedJoints: toAdd.length, totalIntersections: found.length };
}

function toggleBgMultiSelect() {
  state.bgMultiSelect = !state.bgMultiSelect;
  const btn = $("bgEditMultiSelect");
  if (btn) btn.classList.toggle("active", state.bgMultiSelect);
  updateBgEditOpsVisibility();
  if (state.bgMultiSelect) {
    $("hud").textContent = "多線選取:點擊與匡選累加(Esc 關閉)";
  } else {
    $("hud").textContent = "x: 0 · y: 0 · zoom: 100%";
  }
}
$("bgEditSquareToJoint") && ($("bgEditSquareToJoint").onclick = () => withBusy("加節點中…", bgSquaresToJoints));
$("bgEditRectToCenterMember") && ($("bgEditRectToCenterMember").onclick = () => withBusy("建中軸桿件中…", () => bgRectsToMembers("center")));
$("bgEditRectToTopMember")    && ($("bgEditRectToTopMember").onclick    = () => withBusy("建上邊桿件中…", () => bgRectsToMembers("top")));
$("bgEditRectToBottomMember") && ($("bgEditRectToBottomMember").onclick = () => withBusy("建下邊桿件中…", () => bgRectsToMembers("bottom")));
// 沒有選取任何 bg path 時隱藏「編輯」整區,只留「選取」操作
function updateBgEditOpsVisibility() {
  const sec = $("bgEditOpsSection");
  if (!sec) return;
  const file = getActiveFile();
  const selSize = (file && file.selectedBgPaths) ? file.selectedBgPaths.size : 0;
  const has = selSize > 0;
  // 編輯區永遠保持顯示(平面座標原點 / 比例尺 是常駐入口);其他按鈕逐個依需求顯示
  sec.style.display = "";
  const showSel = has ? "" : "none";
  // 永遠顯示(可在無選取時觸發 pending 流程)
  if ($("bgEditPlaneOrigin"))   $("bgEditPlaneOrigin").style.display   = "";
  if ($("bgEditScaleRulerTwo")) $("bgEditScaleRulerTwo").style.display = "";
  // 需要 1 條以上選取才有意義
  if ($("bgEditScaleRuler"))    $("bgEditScaleRuler").style.display    = showSel;
  if ($("bgEditSplit"))         $("bgEditSplit").style.display         = showSel;
  if ($("bgEditToMember"))      $("bgEditToMember").style.display      = showSel;
  if ($("bgEditDel"))           $("bgEditDel").style.display           = showSel;
  // 多線轉交點 / 多線轉交點+桿件:選 ≥ 2 條 bg 線即可(不再要求 多線選取 模式)
  const markBtn = $("bgEditMarkIntersect");
  const markMBtn = $("bgEditMarkIntersectAndMember");
  if (markBtn)  markBtn.style.display  = (selSize >= 2) ? "" : "none";
  if (markMBtn) markMBtn.style.display = (selSize >= 2) ? "" : "none";
  // 比例尺視覺位置移動:檔案有比例尺時才顯示(獨立於 bg path 選取)
  const hasRuler = !!(file && file.scaleRuler);
  if ($("bgEditScaleRulerMove")) $("bgEditScaleRulerMove").style.display = hasRuler ? "" : "none";
  // 畫直線:在 bgEdit 模式下永遠可見
  if ($("bgEditDrawLine")) $("bgEditDrawLine").style.display = "";
  // 中分線:剛好選 1 條獨立 bg 線時才能用
  const dn = (typeof distinctSelectedLineCount === "function") ? distinctSelectedLineCount(file) : selSize;
  if ($("bgEditBisector")) $("bgEditBisector").style.display = (dn === 1) ? "" : "none";
  // 線到原點 / 軸距離:選取必須是同一條(共線多段視為 1)、且檔案有原點與比例尺
  const hasOriginScale = !!(file && file.planeOrigin && file.scaleRuler && file.scaleRuler.ratio);
  const showL2O = (dn === 1 && hasOriginScale) ? "" : "none";
  if ($("bgEditOriginDistH"))   $("bgEditOriginDistH").style.display   = showL2O;
  if ($("bgEditOriginDistV"))   $("bgEditOriginDistV").style.display   = showL2O;
  if ($("bgEditOriginDistMin")) $("bgEditOriginDistMin").style.display = showL2O;
  // 標示距離線可移動 / 刪除按鈕:有任何標示距離(已固化或編輯中)就顯示
  const persistedCount = (file && Array.isArray(file.measurements)) ? file.measurements.length : 0;
  const hasMeasure = persistedCount > 0 || !!(state.measure && state.measure.p1 && state.measure.p2);
  if ($("bgEditMeasureSelect"))    $("bgEditMeasureSelect").style.display    = hasMeasure ? "" : "none";
  if ($("bgEditMeasureMove"))      $("bgEditMeasureMove").style.display      = hasMeasure ? "" : "none";
  if ($("bgEditMeasureDelLast"))   $("bgEditMeasureDelLast").style.display   = hasMeasure ? "" : "none";
  if ($("bgEditMeasureClearAll"))  $("bgEditMeasureClearAll").style.display  = (persistedCount > 1) ? "" : "none";
  // 等分線:選 2 條以上獨立 bg 線即可(實際是否平行由 startBgEqui 驗證)
  if ($("bgEditEquidist")) $("bgEditEquidist").style.display = (dn >= 2) ? "" : "none";
  // 轉虛線:選任 1 條以上 bg 線即可
  if ($("bgEditToDashed")) $("bgEditToDashed").style.display = (selSize >= 1) ? "" : "none";
  // 複製線:不依賴選取(無選取進入時,模式內第一個動作是點 bg 線當 source)→ 一律保持顯示
}
function toggleShapeMarqueeMode(mode) {
  if (!state.bgShapeMarquee) state.bgShapeMarquee = new Set();
  if (state.bgShapeMarquee.has(mode)) state.bgShapeMarquee.delete(mode);
  else state.bgShapeMarquee.add(mode);
  refreshShapeMarqueeUI();
}
function clearAllShapeMarqueeModes() {
  if (!state.bgShapeMarquee) state.bgShapeMarquee = new Set();
  state.bgShapeMarquee.clear();
  refreshShapeMarqueeUI();
}
function refreshShapeMarqueeUI() {
  const has = (m) => state.bgShapeMarquee && state.bgShapeMarquee.has(m);
  const hasSq = has("square"), hasRc = has("rect"), hasCi = has("circle"),
        hasSt = has("straight"), hasSS = has("straightSolid"),
        hasDg = has("diagonal"), hasDD = has("dashedDiagonal");
  $("bgEditSelSquares")   && $("bgEditSelSquares").classList.toggle("active", hasSq);
  $("bgEditSelRects")     && $("bgEditSelRects").classList.toggle("active",   hasRc);
  $("bgEditSelCircles")   && $("bgEditSelCircles").classList.toggle("active", hasCi);
  $("bgEditSelStraight")  && $("bgEditSelStraight").classList.toggle("active", hasSt);
  $("bgEditSelStraightSolid") && $("bgEditSelStraightSolid").classList.toggle("active", hasSS);
  $("bgEditSelDiagonals") && $("bgEditSelDiagonals").classList.toggle("active", hasDg);
  $("bgEditSelDashedDiagonals") && $("bgEditSelDashedDiagonals").classList.toggle("active", hasDD);
  $("bgEditSquareToJoint") && ($("bgEditSquareToJoint").style.display = hasSq ? "" : "none");
  $("bgEditRectToCenterMember") && ($("bgEditRectToCenterMember").style.display = hasRc ? "" : "none");
  $("bgEditRectToTopMember")    && ($("bgEditRectToTopMember").style.display    = hasRc ? "" : "none");
  $("bgEditRectToBottomMember") && ($("bgEditRectToBottomMember").style.display = hasRc ? "" : "none");
  const labels = [];
  if (hasSq) labels.push("正方形");
  if (hasRc) labels.push("長方形");
  if (hasCi) labels.push("圓形");
  if (hasSt) labels.push("直線");
  if (hasDg) labels.push("斜線");
  if (hasDD) labels.push("虛斜線");
  $("hud").textContent = labels.length
    ? `${labels.join("+")}匡選模式:拉方框選取(Esc 取消)`
    : "x: 0 · y: 0 · zoom: 100%";
}

// Stop bg edit panel clicks from bubbling to canvas
["bgEditTools"].forEach(id => {
  const el = $(id); if (!el) return;
  ["click","mousedown","mouseup","dblclick","wheel"].forEach(ev =>
    el.addEventListener(ev, (e) => e.stopPropagation()));
});
// 選取按鈕右鍵:過去開啟選取模式子選單(全部/點/線),現已移除
$("tool-select").addEventListener("contextmenu", (e) => {
  e.preventDefault();
});
$("btnFit").onclick = fitToView;
$("btnZoomSel").onclick = zoomToSelection;
// ---------- 放大 / 縮小 / 範圍放大 ----------
// 範圍放大:拖曳模式追蹤(wrap 相對座標)— 宣告在前,下面的閉包才能安全參照
let rangeZoomDragStart = null;
let rangeZoomSuppressClick = false; // 拖曳完成後 mouseup → click 會緊接著觸發,避免被視為額外點擊
function applyZoomAt(factor, sx, sy) {
  const wx = (sx - state.panX) / state.zoom;
  const wy = (sy - state.panY) / state.zoom;
  state.zoom = Math.max(0.0001, Math.min(50, state.zoom * factor));
  state.panX = sx - wx * state.zoom;
  state.panY = sy - wy * state.zoom;
  applyTransform();
  render();
}
function zoomByStep(factor) {
  const r = wrap.getBoundingClientRect();
  applyZoomAt(factor, r.width / 2, r.height / 2);
}
function exitRangeZoom() {
  state.rangeZoomMode = false;
  state.rangeZoomFirst = null;
  rangeZoomDragStart = null;
  document.body.classList.remove("range-zoom-mode");
  const btn = $("btnZoomRange"); if (btn) btn.classList.remove("active");
  const prev = $("rangeZoomPreview"); if (prev) prev.style.display = "none";
  wrap.style.cursor = "none";
  // 還原其他進行中的模式的 HUD 提示(範圍放大不應中斷其他步驟)
  if (state.originPending) {
    $("hud").textContent = "座標原點:請點選兩條相交的底圖線(Esc 取消);完成後同平面其他頁面會一起對齊";
  } else if (state.splitMode) {
    $("hud").textContent = state.splitFirstCorner
      ? "拆分頁面:請點擊矩形對角(Esc 取消)"
      : "拆分頁面:請點擊矩形第一個對角(Esc 取消)";
  }
}
$("btnZoomIn")    && ($("btnZoomIn").onclick    = () => zoomByStep(1.25));
$("btnZoomOut")   && ($("btnZoomOut").onclick   = () => zoomByStep(1/1.25));
$("btnZoomRange") && ($("btnZoomRange").onclick = () => {
  if (state.rangeZoomMode) { exitRangeZoom(); return; }
  state.rangeZoomMode = true;
  state.rangeZoomFirst = null;
  rangeZoomDragStart = null;
  document.body.classList.add("range-zoom-mode");
  $("btnZoomRange").classList.add("active");
  $("hud").textContent = "範圍放大:請拖曳或點兩下對角(Esc 取消)";
  wrap.style.cursor = "crosshair";
});

function finalizeRangeZoomRect(x1, y1, x2, y2) {
  const viewR = wrap.getBoundingClientRect();
  const ax = Math.min(x1, x2), ay = Math.min(y1, y2);
  const bx = Math.max(x1, x2), by = Math.max(y1, y2);
  const w = Math.max(bx - ax, 1), h = Math.max(by - ay, 1);
  exitRangeZoom();
  if (w < 4 || h < 4) { render(); return; }
  const scale = Math.min(viewR.width / w, viewR.height / h) * 0.95;
  const cx = ((ax + bx) / 2 - state.panX) / state.zoom;
  const cy = ((ay + by) / 2 - state.panY) / state.zoom;
  state.zoom = Math.max(0.0001, Math.min(50, state.zoom * scale));
  state.panX = viewR.width  / 2 - cx * state.zoom;
  state.panY = viewR.height / 2 - cy * state.zoom;
  applyTransform();
  render();
}
// ---------- 標示字體整體放大 / 縮小 / 顯示切換 ----------
export function updateLblToggleBtn() {
  const btn = $("btnLblToggle");
  if (btn) {
    const key = state.labelsVisible ? "tb.lblShown" : "tb.lblHidden";
    const fb  = state.labelsVisible ? "標示 顯示"  : "標示 隱藏";
    _setBtnLabel(btn, key, fb);
    btn.classList.toggle("active", !!state.labelsVisible);
  }
}
export function updateJointVisBtn() {
  const btn = $("btnJointVis");
  if (btn) {
    const key = state.jointsVisible ? "tb.jointShown" : "tb.jointHidden";
    const fb  = state.jointsVisible ? "節點 顯示"   : "節點 隱藏";
    _setBtnLabel(btn, key, fb);
    btn.classList.toggle("active", !!state.jointsVisible);
  }
}
export function updateMemberVisBtn() {
  const btn = $("btnMemberVis");
  if (btn) {
    const key = state.membersVisible ? "tb.memberShown" : "tb.memberHidden";
    const fb  = state.membersVisible ? "桿件 顯示"   : "桿件 隱藏";
    _setBtnLabel(btn, key, fb);
    btn.classList.toggle("active", !!state.membersVisible);
  }
}
function applyGeomVisibility() {
  document.body.classList.toggle("joints-hidden",  !state.jointsVisible);
  document.body.classList.toggle("members-hidden", !state.membersVisible);
}
function bumpLabelFontScale(mult) {
  const cur = state.labelFontScale || 1;
  state.labelFontScale = Math.max(0.3, Math.min(4, cur * mult));
  render();
}
$("btnLblBigger")  && ($("btnLblBigger").onclick  = () => bumpLabelFontScale(1.15));
$("btnLblSmaller") && ($("btnLblSmaller").onclick = () => bumpLabelFontScale(1/1.15));
$("btnLblReset")   && ($("btnLblReset").onclick   = () => { state.labelFontScale = 1; render(); });
function _toggleLabelsVisible() {
  state.labelsVisible = !state.labelsVisible;
  updateLblToggleBtn();
  render();
}
function _toggleJointsVisible() {
  state.jointsVisible = !state.jointsVisible;
  applyGeomVisibility();
  updateJointVisBtn();
}
function _toggleMembersVisible() {
  state.membersVisible = !state.membersVisible;
  applyGeomVisibility();
  updateMemberVisBtn();
}
$("btnLblToggle")  && ($("btnLblToggle").onclick  = _toggleLabelsVisible);
$("btnJointVis")   && ($("btnJointVis").onclick   = _toggleJointsVisible);
$("btnMemberVis")  && ($("btnMemberVis").onclick  = _toggleMembersVisible);
updateLblToggleBtn();
updateJointVisBtn();
updateMemberVisBtn();
applyGeomVisibility();

// 底圖顯示 / 隱藏切換 — 用 body.bg-hidden class 一併控制 #bg-canvas 與 #bgSvg
// 修改底圖模式下不論 state.bgVisible 為何,都強制顯示底圖(否則 paths 無法點選)
export function updateBgToggleBtn() {
  const btn = $("btnBgToggle");
  if (!btn) return;
  const key = state.bgVisible ? "tb.bgShown" : "tb.bgHidden";
  const fb  = state.bgVisible ? "底圖 顯示"  : "底圖 隱藏";
  _setBtnLabel(btn, key, fb);
  btn.classList.toggle("active", !!state.bgVisible);
}
function applyBgVisibility() {
  const shouldHide = !state.bgVisible && state.tool !== "selectBg";
  document.body.classList.toggle("bg-hidden", shouldHide);
}
$("btnBgToggle") && ($("btnBgToggle").onclick = () => {
  state.bgVisible = !state.bgVisible;
  applyBgVisibility();
  updateBgToggleBtn();
});
updateBgToggleBtn();

// 底圖修復:重新跑 activatePage 把當前頁的 bg 從快取 / pdf / image 重建。
//   觸發情境:操作中底圖突然消失 — 通常是 DOM 上的 bgSvg 被某個流程清掉但沒重畫。
//   不動到節點 / 桿件 / 標線 / scaleRuler / planeOrigin / clipRect 等,純粹 re-render bg。
//   隱性把 bgVisible 也設回 true,避免「修復」按下去看起來沒反應(其實是不可見)。
//   按鈕已移到主選單列「工具」→「底圖修復」;函式公開以便兩處都能呼叫
export async function _runBgRepair() {
  const af = getActiveFile();
  if (!af) { $("hud").textContent = "底圖修復:尚未選擇檔案"; return; }
  if (!state.bgVisible) { state.bgVisible = true; applyBgVisibility(); updateBgToggleBtn(); }
  const before = {
    hasBgImg: !!af.cachedBgImg, hasBgSvg: !!af.cachedBgSvg,
    hasPdf: !!af.pdf, hasImage: !!af.image, sourceFileId: af.sourceFileId || null,
  };
  console.log("[底圖修復] 開始", { fileId: af.id, name: af.name, pageIdx: state.pageIdx, ...before });
  await withBusy("重新渲染底圖中…", async () => {
    try {
      await activatePage(af.id, state.pageIdx || 0);
    } catch (e) {
      console.error("[底圖修復] activatePage 失敗:", e);
      throw e;
    }
  });
  const bgSvgEl = document.getElementById("bgSvg");
  const bgCanvasEl = document.getElementById("bg-canvas");
  const svgChildren = bgSvgEl ? bgSvgEl.childElementCount : -1;
  console.log("[底圖修復] 完成", { bgSvgChildren: svgChildren, hasBgCanvas: !!bgCanvasEl });
  $("hud").textContent = `底圖修復完成・${af.name}(${before.hasPdf ? "PDF" : before.hasImage ? "Image" : before.hasBgSvg ? "cached SVG" : before.hasBgImg ? "cached PNG" : before.sourceFileId ? "source 共享" : "空白"}・SVG 子元素 ${svgChildren})`;
}
$("btnBgRepair") && ($("btnBgRepair").onclick = _runBgRepair);

// 3D 一鍵處理(主視窗版本)—— 對應 3D 預覽 popup 內的「⚡ 一鍵處理」按鈕,但只跑主視窗能取用的步驟:
//   1) 整理所有頁面  2) 清除所有 globalJoint 綁定  3) 適配關聯(精準度)重建  4) 編排節點編號
//   5) 編排桿件編號  6-9) 失效 rank cache + 重 infer + UI 重整 + 重畫
//   各步驟個別 pushUndo,任一步失敗皆可 Ctrl+Z 回上一個 stable state。
export async function _run3DOneClickPipeline() {
  const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  if (!confirm(
    `3D 一鍵處理 — 依序跑下列 9 步:\n\n` +
    `1. 整理所有頁面(合併同位節點 / 刪重複桿件 / 共線中段拆段)\n` +
    `2. 清除所有 globalJoint 綁定(從乾淨狀態開始,避免舊綁定留錯資料)\n` +
    `3. 適配關聯(精準度 ${md} 位數)— 重建所有 globalJoint 綁定\n` +
    `4. 編排節點編號(全部頁面)\n` +
    `5. 編排桿件編號(全部頁面)\n` +
    `6. 失效 rank cache + 重 infer globalJoint\n` +
    `7. 重整切面 / page 座標區\n` +
    `8. 重整側欄列表\n` +
    `9. 重畫畫面\n\n` +
    `每步都會 pushUndo;失敗 / 取消可用 Ctrl+Z 逐步還原。要繼續嗎?`
  )) return;
  // 直接管 spinner — withBusy 不回傳 Promise,連串 await withBusy 不能保證序列化,
  //   也會在每步之間 sp.classList.remove("active") 造成閃爍 + 中間空窗。
  // 改法:spinner 從頭開到尾,每步只更新訊息;每步前後 double-rAF,確保新訊息先 paint
  //   再跑重 CPU 的同步工作(否則 JS 阻塞畫面,使用者看不到字)。
  const sp = document.getElementById("busySpinner");
  const msgEl = sp ? sp.querySelector(".msg") : null;
  const setMsg = (m) => { if (msgEl) msgEl.textContent = m; };
  const yieldFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (sp) sp.classList.add("active");
  let ok = true;
  try {
    setMsg("3D 一鍵處理 1/9:整理所有頁面…");
    await yieldFrame();
    if (typeof consolidateAllPagesWithConfirm === "function") {
      await consolidateAllPagesWithConfirm({ skipConfirm: true });
    }
    setMsg("3D 一鍵處理 2/9:清除所有 globalJoint 綁定…");
    await yieldFrame();
    if (typeof cleanupBadGlobalJoints === "function") {
      cleanupBadGlobalJoints({ clearAll: true, skipConfirm: true });
    }
    setMsg(`3D 一鍵處理 3/9:適配關聯(精準度 ${md})— 重建綁定…`);
    await yieldFrame();
    if (typeof _runFitMergeByPrecision === "function") {
      await _runFitMergeByPrecision({ skipConfirm: true });
    }
    setMsg("3D 一鍵處理 4/9:編排節點編號…");
    await yieldFrame();
    if (typeof relayoutNumberingAll === "function") {
      await relayoutNumberingAll({ skipConfirm: true });
    }
    setMsg("3D 一鍵處理 5/9:編排桿件編號…");
    await yieldFrame();
    if (typeof relayoutMembersNumberingAll === "function") {
      await relayoutMembersNumberingAll({ skipConfirm: true });
    }
    setMsg("3D 一鍵處理 6/9:失效 rank cache + 重 infer globalJoint…");
    await yieldFrame();
    pushUndo();
    if (typeof invalidateRankCache === "function") invalidateRankCache();
    if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
    setMsg("3D 一鍵處理 7/9:重整切面 / page 座標區…");
    await yieldFrame();
    if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
    if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
    setMsg("3D 一鍵處理 8/9:重整側欄列表…");
    await yieldFrame();
    try { refreshLists(); } catch (_) {}
    setMsg("3D 一鍵處理 9/9:重畫畫面…");
    await yieldFrame();
    try { render(); } catch (_) {}
    // 等最後一次 render 結束 + 一個 paint frame,再關 spinner — 避免畫面才剛要重排就先沒了訊息
    await yieldFrame();
  } catch (e) {
    ok = false;
    console.warn("[3D 一鍵處理] 失敗", e);
    alert("3D 一鍵處理途中發生錯誤:" + (e && e.message ? e.message : e) + "\n\n已完成的步驟保留;可用 Ctrl+Z 逐步還原。");
  } finally {
    if (sp) sp.classList.remove("active");
  }
  if (ok) {
    let pages = 0, joints = 0;
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        pages++; joints += (pg.joints || []).length;
      }
    }
    if ($("hud")) $("hud").textContent = `3D 一鍵處理完成 ・ ${pages} 頁 / ${joints} joint`;
    console.log("[3D 一鍵處理] 完成");
    // 若有撞號桿件 → 跳 popup 提示(跟切頁時同款,有「搜尋」+ 確定按鈕)
    try {
      if (state.memberCollisions && state.memberCollisions.size > 0) {
        _showAllCollisionsPopup();
      }
    } catch (e) { console.warn("[3D 一鍵處理] 撞號 popup 失敗:", e); }
  }
}

// 跨頁同步建點 toggle
export function updateCrossViewSyncBtn() {
  const btn = $("btnCrossViewSync");
  if (!btn) return;
  btn.classList.toggle("active", !!state.crossViewSync);
  // 只用底色 active 表達狀態,不加 ✓ 文字
  _setBtnLabel(btn, "tb.crossViewSync", "跨頁同步");
}
$("btnCrossViewSync") && ($("btnCrossViewSync").onclick = () => {
  state.crossViewSync = !state.crossViewSync;
  updateCrossViewSyncBtn();
  $("hud").textContent = state.crossViewSync
    ? "跨頁同步建點:啟動 — 在「節點」工具下建立節點時,所有相容平面的頁面都會建對應節點"
    : "跨頁同步建點:已關閉";
});
updateCrossViewSyncBtn();

$("btnPrewarmBgCache") && ($("btnPrewarmBgCache").onclick = () =>
  withBusy("掃描所有底圖中…", async () => {
    const n = await prewarmAllPagesBgCache();
    $("hud").textContent = `底圖掃描完成:建立 ${n} 個頁面的 bg 交點快取,可開始用跨頁同步建點吸到底圖實際交點`;
  })
);
$("btnDel").onclick = performDelete;
$("selToolsExtend")     && ($("selToolsExtend").onclick     = () => withBusy("桿件單端延伸中…", () => extendSelectedMembersToIntersect(false)));
$("selToolsExtendBoth") && ($("selToolsExtendBoth").onclick = () => withBusy("桿件兩端延伸中…", () => extendSelectedMembersToIntersect(true)));
$("selToolsJExtH")     && ($("selToolsJExtH").onclick     = () => withBusy("端點水平延桿中…",     () => extendJointAxisToIntersect("h", false)));
$("selToolsJExtV")     && ($("selToolsJExtV").onclick     = () => withBusy("端點垂直延桿中…",     () => extendJointAxisToIntersect("v", false)));
$("selToolsJExtHBoth") && ($("selToolsJExtHBoth").onclick = () => withBusy("端點兩側水平延桿中…", () => extendJointAxisToIntersect("h", true)));
$("selToolsJExtVBoth") && ($("selToolsJExtVBoth").onclick = () => withBusy("端點兩側垂直延桿中…", () => extendJointAxisToIntersect("v", true)));
$("selToolsDupJointH") && ($("selToolsDupJointH").onclick = () => withBusy("節點水平複製中…",     () => duplicateJointOnAxis("h")));
$("selToolsDupJointV") && ($("selToolsDupJointV").onclick = () => withBusy("節點垂直複製中…",     () => duplicateJointOnAxis("v")));
$("selToolsJConnectH") && ($("selToolsJConnectH").onclick = () => connectSelectedJoints("h"));
$("selToolsJConnectV") && ($("selToolsJConnectV").onclick = () => connectSelectedJoints("v"));
$("selToolsJConnectD") && ($("selToolsJConnectD").onclick = () => connectSelectedJointsDiagonal());
$("selToolsJMerge")    && ($("selToolsJMerge").onclick    = () => mergeTwoSelectedJoints());
$("selToolsMeasure")   && ($("selToolsMeasure").onclick   = () => startMeasureFromCurrentSelection());
$("selToolsAnchorToggle") && ($("selToolsAnchorToggle").onclick = () => toggleAnchorOnSelectedJoints());

// 切換選取節點的 isAnchor 標記。
//   若多數選取節點目前是 anchor → 全部取消;否則 → 全部標為 anchor
//   isAnchor 在 rank cache 內視為「2D 軸向交點」(等同 _isJointOrtho 為 true 的效果)→
//   就算只有單方向 member(柱腳)或完全沒 H+V,只要被使用者標記就算 anchored 座標
//   跨頁同步:若 joint 有 globalId(跨頁綁定同一物理點),所有共享 globalJoint 的 siblings
//     在其他頁面也會同步 toggle(因為錨點是物理屬性,同一個點應該各頁一致)
async function toggleAnchorOnSelectedJoints() {
  const p = getPage();
  if (!p) return;
  const ids = [...state.selection.joints];
  if (!ids.length) { alert("請先選取節點"); return; }
  // 統計「選取節點本身」目前狀態,決定 setTo(兩邊各半 → 偏向「標為」)
  let anchoredCount = 0;
  for (const id of ids) {
    const j = p.joints.find(x => x.id === id);
    if (j && j.isAnchor) anchoredCount++;
  }
  const setTo = anchoredCount < ids.length / 2;
  const verb = setTo ? "標為錨點" : "取消錨點";
  // 收集要變動的 joint:選取節點 + 所有共享 globalJoint 的跨頁對應 joint(siblings)
  //   用 Map(key=joint object)去重,避免同一物件被加兩次
  const targets = new Map();   // jointObj → jointObj
  for (const id of ids) {
    const j = p.joints.find(x => x.id === id);
    if (!j) continue;
    targets.set(j, j);
    if (j.globalId == null) continue;
    // 掃所有頁面找相同 globalId 的 sibling
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        for (const other of (pg.joints || [])) {
          if (other === j) continue;
          if (other.globalId === j.globalId) targets.set(other, other);
        }
      }
    }
  }
  const selectedCount = ids.length;
  const siblingCount = targets.size - selectedCount;
  const busyMsg = siblingCount
    ? `${verb}中…(${selectedCount} 選取 + ${siblingCount} 跨頁對應點)`
    : `${verb}中…(處理 ${selectedCount} 顆節點)`;
  // 大模型 pushUndo 可能 2~5 秒 → 加 busy spinner 讓使用者知道在跑
  await withBusy(busyMsg, async () => {
    pushUndo();
    let changed = 0, alreadyState = 0;
    for (const j of targets.values()) {
      const cur = !!j.isAnchor;
      if (cur !== setTo) {
        j.isAnchor = setTo || undefined;   // 不需要時直接 unset(讓 JSON 輸出乾淨)
        changed++;
      } else {
        alreadyState++;
      }
    }
    if (typeof invalidateRankCache === "function") invalidateRankCache();
    console.log(`[錨點切換] ${verb} 完成・變動 ${changed}・已是該狀態 ${alreadyState}・選取 ${selectedCount}・跨頁 siblings ${siblingCount}`);
    const siblingNote = siblingCount ? `(${selectedCount} 選取 + ${siblingCount} 跨頁對應)` : "";
    const summary = `${verb}完成 — 變動 ${changed} / ${targets.size} 顆${siblingNote}${alreadyState ? `,${alreadyState} 顆原本就是` : ""}`;
    $("hud").textContent = summary;
    render && render();
    refreshLists && refreshLists();
    // 確認 alert(短暫,給使用者明確完成回饋;若使用者覺得煩可日後拿掉)
    if (changed > 0) {
      setTimeout(() => {
        alert(`${summary}\n\n節點將以青色顯示。Rank 編號時這些 joint 會被視為錨點(等同有 H+V member 的真實交點),不會被推到後段。`);
      }, 30);
    } else {
      setTimeout(() => alert(`沒有變動 — 選取的 ${selectedCount} 顆節點${siblingCount ? `(及對應 ${siblingCount} 顆跨頁 siblings)` : ""}目前都已是「${setTo ? "錨點" : "非錨點"}」狀態。`), 30);
    }
  });
}

// 兩點合一:把選取的 2 個節點合併
//   合併點選擇:讓兩端原連的桿件「方向不變、只伸縮」
//     - 兩邊都有外部桿:對 A 的每根連桿 ↔ B 的每根連桿 兩兩求(無界線交點),取平均
//     - 只有一邊有外部桿:用那邊的座標(讓那些桿件完全不動)
//     - 兩邊都沒有外部桿:fallback 中點
//   1) 保留 id 較小者作為 anchor,移到合併點
//   2) 所有指向 drop 端點的 member 重新指向 anchor
//   3) 零長 member(j1==j2,即原本 anchor↔drop 之間那條)移除
//   4) 重複 member(已存在的端點對)移除
//   5) globalId 繼承(若 anchor 沒綁,且 drop 有綁 → 繼承)
function mergeTwoSelectedJoints() {
  const p = getPage();
  if (!p || p._orphan) return;
  const ids = [...state.selection.joints];
  if (ids.length !== 2) { alert("請先選取剛好 2 個節點。"); return; }
  const ja = p.joints.find(j => j.id === ids[0]);
  const jb = p.joints.find(j => j.id === ids[1]);
  if (!ja || !jb) return;
  pushUndo();
  const keep = ja.id < jb.id ? ja : jb;
  const drop = ja.id < jb.id ? jb : ja;
  // === 計算合併點(方向不變)===
  const collectLines = (j, otherJ) => {
    // 回傳 j 的所有外部連桿(不含 j↔otherJ 那條),每條轉成 (from = 另一端點, to = j)
    const out = [];
    for (const m of p.members) {
      let otherId = null;
      if (m.j1 === j.id) otherId = m.j2;
      else if (m.j2 === j.id) otherId = m.j1;
      if (otherId == null || otherId === otherJ.id) continue;
      const o = jointById(otherId);
      if (!o) continue;
      out.push({ p1: { x: o.x, y: o.y }, p2: { x: j.x, y: j.y } });
    }
    return out;
  };
  const linesA = collectLines(ja, jb);
  const linesB = collectLines(jb, ja);
  let mp;
  if (linesA.length > 0 && linesB.length > 0) {
    const pts = [];
    for (const la of linesA) {
      for (const lb of linesB) {
        const r = lineLineIntersect(la.p1, la.p2, lb.p1, lb.p2);
        if (r) pts.push(r);
      }
    }
    if (pts.length > 0) {
      const ax = pts.reduce((s, q) => s + q.x, 0) / pts.length;
      const ay = pts.reduce((s, q) => s + q.y, 0) / pts.length;
      mp = { x: ax, y: ay };
    } else {
      mp = { x: (ja.x + jb.x) / 2, y: (ja.y + jb.y) / 2 };  // 全部平行
    }
  } else if (linesA.length > 0) {
    mp = { x: ja.x, y: ja.y };       // 只有 A 端有外部桿件 → 留在 A
  } else if (linesB.length > 0) {
    mp = { x: jb.x, y: jb.y };       // 只有 B 端有外部桿件 → 留在 B
  } else {
    mp = { x: (ja.x + jb.x) / 2, y: (ja.y + jb.y) / 2 };  // 兩邊都沒桿件
  }
  keep.x = mp.x;
  keep.y = mp.y;
  // globalId 繼承(只在 anchor 沒綁、drop 有綁時繼承)
  if (keep.globalId == null && drop.globalId != null) {
    bindJointToGlobal(keep, drop.globalId);
  } else if (drop.globalId != null && drop.globalId !== keep.globalId) {
    // 衝突:解掉 drop 的綁定避免 GC 後不一致
    unbindJointFromGlobal(drop);
  }
  // 重新指向 drop 的 member 端點到 keep
  for (const m of p.members) {
    if (m.j1 === drop.id) m.j1 = keep.id;
    if (m.j2 === drop.id) m.j2 = keep.id;
  }
  // 刪 drop joint
  p.joints = p.joints.filter(j => j.id !== drop.id);
  // 移除零長 member(原本 keep↔drop 之間那條)
  const before = p.members.length;
  p.members = p.members.filter(m => m.j1 !== m.j2);
  const removedZero = before - p.members.length;
  // 去重(同一對端點 → 只留一條)
  const seen = new Set();
  const dedup = [];
  for (const m of p.members) {
    const k = m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(m);
  }
  const removedDup = p.members.length - dedup.length;
  p.members = dedup;
  // 選取狀態:剩下 anchor
  state.selection.joints.clear();
  state.selection.members.clear();
  state.selection.joints.add(keep.id);
  // 全局節點重新推算
  if (keep.globalId != null) {
    const g = findGlobalJointById(keep.globalId);
    if (g) inferGlobalJoint(g);
  }
  render(); refreshLists();
  $("hud").textContent = `兩點合一:保留 J${displayJointId(keep)}`
    + (removedZero ? `・移除零長桿件 ${removedZero}` : "")
    + (removedDup ? `・去重桿件 ${removedDup}` : "");
}

// 將選取節點兩兩連桿件:axis="h" 同 Y 分群、依 X 排序;axis="v" 同 X 分群、依 Y 排序
// 群組容差:state.scale 校準後 ≈ 1mm;像素時 ≈ 1px。共線視為同一群。
function connectSelectedJoints(axis) {
  const p = getPage();
  if (!p || p._orphan) return;
  const ids = [...(state.selection.joints || [])];
  if (ids.length < 2) { alert("請先選取至少 2 個節點"); return; }
  const joints = ids.map(id => p.joints.find(j => j.id === id)).filter(Boolean);
  if (joints.length < 2) return;

  const tol = state.scale ? Math.max(0.5, state.scale) : 1.0;     // 1 mm 容差(校準後),否則 1 px
  const groupKey = axis === "h" ? "y" : "x";
  const sortKey  = axis === "h" ? "x" : "y";

  // 把 joints 依 groupKey 排序,再相鄰差異 < tol 的歸成一群
  const sorted = [...joints].sort((a, b) => a[groupKey] - b[groupKey]);
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i][groupKey] - cur[cur.length - 1][groupKey]) < tol) {
      cur.push(sorted[i]);
    } else {
      groups.push(cur);
      cur = [sorted[i]];
    }
  }
  groups.push(cur);

  // 既有桿件去重表
  const existing = new Set(p.members.map(m => m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`));
  const memberKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;

  pushUndo();
  let addedM = 0, skippedM = 0, lonely = 0;
  for (const g of groups) {
    if (g.length < 2) { lonely++; continue; }
    const seq = [...g].sort((a, b) => a[sortKey] - b[sortKey]);
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i], b = seq[i + 1];
      if (a.id === b.id) continue;
      const k = memberKey(a.id, b.id);
      if (existing.has(k)) { skippedM++; continue; }
      p.members.push({ id: nextMemberId++, j1: a.id, j2: b.id });
      existing.add(k);
      addedM++;
    }
  }
  render(); refreshLists();
  $("hud").textContent = `${axis === "h" ? "水平" : "垂直"}連結:新增 ${addedM} 桿件`
    + (skippedM ? `・略過已存在 ${skippedM}` : "")
    + (lonely ? `・單點群組 ${lonely}` : "");
}
// 斜線連結:在選取節點中找出所有「共線(非水平/垂直)的子群」,沿斜線排序後相鄰兩兩連桿件
//   流程:
//   1. 枚舉所有節點對 (i, j),把方向正規化(方向 + offset 量化)當 lineKey 去重
//   2. 跳過水平 / 垂直(由 H/V 按鈕負責),只處理 |ux| 與 |uy| 都 > minDir 的斜線
//   3. 對每條未處理的線:收集所有選取節點裡垂直距離 ≤ tol 的,沿線方向 sort,相鄰連桿件
//   4. 既存桿件自動跳過(不重建)
function connectSelectedJointsDiagonal() {
  const p = getPage();
  if (!p || p._orphan) return;
  const ids = [...(state.selection.joints || [])];
  if (ids.length < 2) { alert("請先選取至少 2 個節點"); return; }
  const joints = ids.map(id => p.joints.find(j => j.id === id)).filter(Boolean);
  if (joints.length < 2) return;
  const tol = state.scale ? Math.max(0.5, state.scale) : 1.0;   // 1 mm 容差(校準後),否則 1 px
  const minDir = 0.05;   // 排除水平 / 垂直(這兩種由 H/V 按鈕處理),分量太小視為軸向
  const memberKey = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
  const existing = new Set(p.members.map(m => memberKey(m.j1, m.j2)));
  const processedLines = new Set();
  pushUndo();
  let addedM = 0, skippedM = 0, processedLineCount = 0;
  for (let i = 0; i < joints.length; i++) {
    for (let j = i + 1; j < joints.length; j++) {
      const A = joints[i], B = joints[j];
      const dx = B.x - A.x, dy = B.y - A.y;
      const len = Math.hypot(dx, dy);
      if (len < tol) continue;
      let nx = dx / len, ny = dy / len;
      // 正規化方向:讓 nx >= 0(同條線兩種方向視為同一條)
      if (nx < 0) { nx = -nx; ny = -ny; }
      else if (nx === 0 && ny < 0) { ny = -ny; }
      // 排除水平 / 垂直
      if (Math.abs(nx) < minDir || Math.abs(ny) < minDir) continue;
      // 線的 quantized key:方向角(0.001 rad bin)+ 法距(tol bin)
      //   法距 = A · perpDir,perpDir = (-ny, nx)
      const angle = Math.atan2(ny, nx);
      const angleBin = Math.round(angle * 1000);
      const offset = -A.x * ny + A.y * nx;
      const offsetBin = Math.round(offset / tol);
      const lineKey = `${angleBin}|${offsetBin}`;
      if (processedLines.has(lineKey)) continue;
      processedLines.add(lineKey);
      // 收集所有共線(垂直距離 ≤ tol)的選取節點
      const onLine = [];
      for (const J of joints) {
        const vx = J.x - A.x, vy = J.y - A.y;
        // 垂直距離 = | (J - A) · perpDir | = | -vx*ny + vy*nx |
        const perp = Math.abs(-vx * ny + vy * nx);
        if (perp <= tol) onLine.push(J);
      }
      if (onLine.length < 2) continue;
      // 沿斜線方向 sort(投影量 t = (J - A) · (nx, ny))
      onLine.sort((p1, p2) => {
        const t1 = (p1.x - A.x) * nx + (p1.y - A.y) * ny;
        const t2 = (p2.x - A.x) * nx + (p2.y - A.y) * ny;
        return t1 - t2;
      });
      // 相鄰兩兩連桿件
      for (let k = 0; k + 1 < onLine.length; k++) {
        const a = onLine[k], b = onLine[k + 1];
        if (a.id === b.id) continue;
        const mk = memberKey(a.id, b.id);
        if (existing.has(mk)) { skippedM++; continue; }
        p.members.push({ id: nextMemberId++, j1: a.id, j2: b.id });
        existing.add(mk);
        addedM++;
      }
      processedLineCount++;
    }
  }
  render(); refreshLists();
  $("hud").textContent = `斜線連結:處理 ${processedLineCount} 條斜線・新增 ${addedM} 桿件`
    + (skippedM ? `・略過已存在 ${skippedM}` : "");
}
$("selToolsMove")      && ($("selToolsMove").onclick      = () => startMoveMode("free"));
$("selToolsMoveH")     && ($("selToolsMoveH").onclick     = () => startMoveMode("h"));
$("selToolsMoveV")     && ($("selToolsMoveV").onclick     = () => startMoveMode("v"));
$("selToolsMoveDist")  && ($("selToolsMoveDist").onclick  = () => startMoveMode("dist"));
$("selToolsMoveAngle") && ($("selToolsMoveAngle").onclick = () => startMoveMode("angle"));
$("selToolsMoveRect")  && ($("selToolsMoveRect").onclick  = () => startMoveMode("rect"));
$("cmdInputField") && $("cmdInputField").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); handleCmdInputCommit(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); exitMoveMode(); }
});
// 阻止 cmd 輸入區的點擊冒泡到畫布
$("cmdInputBar") && ["click","mousedown","mouseup","dblclick","wheel"].forEach(ev =>
  $("cmdInputBar").addEventListener(ev, (e) => e.stopPropagation()));
function enterSplitMode() {
  state.splitMode = true;
  state.splitFirstCorner = null;
  $("btnSplit").classList.add("active");
  wrap.style.cursor = "none";
  $("hud").textContent = "拆分頁面:請點擊矩形第一個對角(Esc 取消)";
}
function exitSplitMode() {
  state.splitMode = false;
  state.splitFirstCorner = null;
  $("btnSplit").classList.remove("active");
  wrap.style.cursor = "none";
  applyTransform();
  render();
}
$("btnSplit").onclick = enterSplitMode;

function performDelete() {
  if (state.tool === "selectBg") {
    deleteSelectedBgPaths();
    return;
  }
  if (state.selection.joints.size === 0 && state.selection.members.size === 0
      && state.selection.fileIds.size > 0) {
    deleteSelectedFiles();
  } else {
    if (!_assertSelectionOnActivePage("刪除選取")) return;
    deleteSelection();
  }
}

function deleteSelectedBgPaths(opts) {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  if (!(opts && opts.skipConfirm)) {
    if (!confirm(`要刪除選取的 ${file.selectedBgPaths.size} 條底圖線條嗎?`)) return;
  }
  pushUndo();
  if (!file.deletedBgPaths) file.deletedBgPaths = new Set();
  file.selectedBgPaths.forEach(idx => {
    file.deletedBgPaths.add(idx);
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
    if (el2) el2.style.display = "none";
  });
  file.selectedBgPaths.clear();
}

// 把選取的底圖 path 解析成節點+桿件,加入當前頁
// 取得單一 bg <line> / 兩端 path 的兩端世界座標
// 把使用者輸入當數字運算式評估;只允許 0-9 . + - * / ( ) e E 與空白,避免任意 JS。
//   合法 → 回傳 number(包含 NaN 過濾);不合法 → 回傳 NaN
function evalNumExpr(input) {
  if (input == null) return NaN;
  const s = String(input).trim();
  if (!s) return NaN;
  if (!/^[0-9.+\-*/() eE]+$/.test(s)) return NaN;
  try {
    const v = (new Function(`"use strict"; return (${s});`))();
    return (typeof v === "number" && isFinite(v)) ? v : NaN;
  } catch (_) { return NaN; }
}

// 把世界座標點 p 投影到「通過 a, b 的無限延伸直線」上
export function _projectPointOnLine(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return { x: a.x, y: a.y };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
function bgSingleLineWorldEnds(el) {
  const segs = svgElementToSegments(el);
  if (segs.length !== 1) return null;
  const seg = segs[0];
  const ctm = el.getScreenCTM && el.getScreenCTM();
  let p1 = { x: seg.x1, y: seg.y1 }, p2 = { x: seg.x2, y: seg.y2 };
  if (ctm) {
    const owner = el.ownerSVGElement || document.getElementById("bgSvg");
    const sp1 = owner.createSVGPoint(); sp1.x = seg.x1; sp1.y = seg.y1;
    const sp2 = owner.createSVGPoint(); sp2.x = seg.x2; sp2.y = seg.y2;
    const wp1 = sp1.matrixTransform(ctm), wp2 = sp2.matrixTransform(ctm);
    p1 = screenToWorld(wp1.x, wp1.y);
    p2 = screenToWorld(wp2.x, wp2.y);
  }
  return { p1, p2 };
}

// 平面座標原點:從 2 條選取 bg 線的交點,或 1 個選取的模型節點
// 兩條線段是否共線(視為同一條無限線)— 平行 + 一條的中點到另一條的距離 ≈ 0
function linesAreCollinear(a, b, eps) {
  const av = { x: a.p2.x - a.p1.x, y: a.p2.y - a.p1.y };
  const bv = { x: b.p2.x - b.p1.x, y: b.p2.y - b.p1.y };
  const aLen = Math.hypot(av.x, av.y), bLen = Math.hypot(bv.x, bv.y);
  if (aLen < 1e-9 || bLen < 1e-9) return false;
  const cross = (av.x * bv.y - av.y * bv.x) / (aLen * bLen);
  if (Math.abs(cross) > 0.01) return false;       // 不平行
  // b 中點到 a 線的垂直距離
  const bm = { x: (b.p1.x + b.p2.x) / 2, y: (b.p1.y + b.p2.y) / 2 };
  const dx = bm.x - a.p1.x, dy = bm.y - a.p1.y;
  const dist = Math.abs(dx * av.y - dy * av.x) / aLen;
  return dist < eps;
}
// 把線段陣列依「共線」分群,回傳 group 陣列(每個 group = 共線索引的陣列)
function groupCollinearLines(lines, eps) {
  eps = eps || 0.5;
  const groups = [];
  for (let i = 0; i < lines.length; i++) {
    let placed = false;
    for (const g of groups) {
      if (linesAreCollinear(lines[i], lines[g[0]], eps)) {
        g.push(i); placed = true; break;
      }
    }
    if (!placed) groups.push([i]);
  }
  return groups;
}
// 把 file.selectedBgPaths 內所有 single line 收成 lines 陣列(world coords)
function _selectedBgLinesAsWorld(file) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!file || !file.selectedBgPaths || !bgSvgEl) return [];
  const out = [];
  for (const idx of file.selectedBgPaths) {
    const el = bgSvgEl.querySelector(`[data-bg-idx="${CSS.escape(String(idx))}"]`);
    if (!el) continue;
    const L = bgSingleLineWorldEnds(el);
    if (L) out.push(L);
  }
  return out;
}
// 計算「不同線」的數量(把共線視為一條)
function distinctSelectedLineCount(file) {
  const lines = _selectedBgLinesAsWorld(file);
  if (!lines.length) return 0;
  return groupCollinearLines(lines).length;
}
// 從 ≥ 2 條 bg 線推算共同交點:若所有「不同線」兩兩交點收斂到同一點 → 回傳該點;否則 null
function bgComputeOriginFromSelection(file) {
  const lines = _selectedBgLinesAsWorld(file);
  if (lines.length < 2) return null;
  const groups = groupCollinearLines(lines);
  if (groups.length < 2) return null;     // 全部共線 → 無交點
  const reps = groups.map(g => lines[g[0]]);
  const ips = [];
  for (let i = 0; i < reps.length; i++) {
    for (let j = i + 1; j < reps.length; j++) {
      const r = lineLineIntersect(reps[i].p1, reps[i].p2, reps[j].p1, reps[j].p2);
      if (r) ips.push(r);
    }
  }
  if (ips.length === 0) return null;
  const ax = ips.reduce((s, p) => s + p.x, 0) / ips.length;
  const ay = ips.reduce((s, p) => s + p.y, 0) / ips.length;
  // 收斂性檢查:所有交點離平均不超過 5 世界單位
  const tol = 5;
  for (const p of ips) {
    if (Math.hypot(p.x - ax, p.y - ay) > tol) return null;
  }
  return { x: ax, y: ay };
}

function bgCreatePlaneOrigin() {
  const file = getActiveFile();
  if (!file) return;
  // 依 state.originPending 判斷模式:`"local"` → 僅動本檔 + 完成後跳全局校準;否則 → 全平面傳播
  const isLocal = (state.originPending === "local");
  const _apply = isLocal ? _applyNewPlaneOriginLocalOnly : _applyNewPlaneOriginToAllSamePlane;
  const _afterDone = (r) => {
    if (isLocal && r && r.changed && $("hud")) {
      // 純 local fix:不自動觸發任何全局校準,避免動到 pg.z 或其他檔
      //   跨檔對齊由使用者手動處理(右側欄「全局節點校準」按鈕)
      $("hud").textContent += "・第三軸 pg.z 與其他檔皆未動;若需跨檔對齊請手動跑「全局節點校準」";
    }
  };
  // 模式 1:1 個模型節點被選取
  if (state.selection.joints && state.selection.joints.size === 1) {
    const jid = [...state.selection.joints][0];
    const j = jointById(jid);
    if (j) {
      const r = _apply(file, { x: j.x, y: j.y });
      if ($("hud")) {
        const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
        const head = isLocal ? `本檔原點已修正(僅本檔)` : `座標原點已設為節點 J${displayJointId(j)}・同平面其他 ${r.changed} 頁已同步對齊`;
        $("hud").textContent = `${head}${slTail}`;
      }
      _afterDone(r);
      return;
    }
  }
  // 模式 2:≥ 2 條 bg 線
  if (file.selectedBgPaths && file.selectedBgPaths.size >= 2) {
    const distinct = distinctSelectedLineCount(file);
    if (distinct < 2) { alert("選取的線都共線,沒有交點。請改選相交的兩條線。"); return; }
    const pt = bgComputeOriginFromSelection(file);
    if (!pt) {
      alert("選取的多條線交點不收斂(不在同一點)。請只選通過同一個節點的線。");
      return;
    }
    const r = _apply(file, { x: pt.x, y: pt.y });
    if ($("hud")) {
      const slTail = r.slUpdated ? `・切面 ${r.slUpdated} 條重算${r.tgtZUpdated ? `(目標 page.z ${r.tgtZUpdated})` : ""}` : "";
      const head = isLocal ? `本檔原點已修正(${distinct} 條線收斂交點)・僅本檔` : `座標原點已設定(${distinct} 條線收斂交點)・同平面其他 ${r.changed} 頁已同步對齊`;
      $("hud").textContent = `${head}${slTail}`;
    }
    _afterDone(r);
    return;
  }
  alert("請先做下列其一:\n• 在「底圖」選 ≥ 2 條相交的 bg 線\n• 或在「選取」模式下選 1 個節點");
}

// 比例尺(兩線距離):從兩條(理想平行)bg 線的垂直距離,輸入實際長度
function bgCreateScaleRulerByTwoLines() {
  const file = getActiveFile();
  if (!file) return;
  if (!file.selectedBgPaths || file.selectedBgPaths.size !== 2) {
    alert("請選取「兩條」底圖線段");
    return;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  const ids = [...file.selectedBgPaths];
  const els = ids.map(idx => bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`)).filter(Boolean);
  if (els.length !== 2) return;
  const L1 = bgSingleLineWorldEnds(els[0]);
  const L2 = bgSingleLineWorldEnds(els[1]);
  if (!L1 || !L2) { alert("請選取單一線段(若是矩形/多段 path,先「切成直線」)"); return; }
  const v1 = { x: L1.p2.x - L1.p1.x, y: L1.p2.y - L1.p1.y };
  const v2 = { x: L2.p2.x - L2.p1.x, y: L2.p2.y - L2.p1.y };
  const len1 = Math.hypot(v1.x, v1.y), len2 = Math.hypot(v2.x, v2.y);
  if (len1 < 1e-6 || len2 < 1e-6) { alert("線段長度太短"); return; }
  // 平行檢測:|sin θ| 應該很小
  const sinTheta = Math.abs((v1.x * v2.y - v1.y * v2.x) / (len1 * len2));
  if (sinTheta > 0.05) {
    if (!confirm(`兩線並非平行(夾角 ${(Math.asin(Math.min(1, sinTheta)) * 180 / Math.PI).toFixed(1)}°)。\n會以 L1 中點到 L2 的垂直投影距離為測量值。要繼續嗎?`)) return;
  }
  // L1 中點到 L2 直線的垂直投影。注意:bgSingleLineWorldEnds 回傳的是 SVG path 幾何座標
  // (即 stroke 中心線,SVG 預設 stroke-alignment 為 center),所以這個距離是「中心線到中心線」
  // 的垂直距離,不受兩條線視覺粗度的影響。
  const m1 = { x: (L1.p1.x + L1.p2.x) / 2, y: (L1.p1.y + L1.p2.y) / 2 };
  const t = ((m1.x - L2.p1.x) * v2.x + (m1.y - L2.p1.y) * v2.y) / (len2 * len2);
  const proj = { x: L2.p1.x + t * v2.x, y: L2.p1.y + t * v2.y };
  const measured = Math.hypot(proj.x - m1.x, proj.y - m1.y);
  if (measured < 1e-3) { alert("兩線距離為 0"); return; }
  const input = prompt(
    `兩線中心線垂直距離為 ${measured.toFixed(3)} 單位\n請輸入實際距離(mm,最小 1)\n(可用 + − × ÷ 與括號,例:23*1450 或 1450+1300):`,
    file.scaleRuler ? String(file.scaleRuler.real) : "");
  if (input == null) return;
  const real = evalNumExpr(input);
  if (Number.isNaN(real) || real < 1) { alert("請輸入有效的數字運算式(結果需 ≥ 1)"); return; }
  pushUndo();
  file.scaleRuler = { type: "twoLines", p1: m1, p2: proj, measured, real, ratio: real / measured };
  console.log(`[比例尺・兩線距離] ${measured.toFixed(2)} → ${real} mm`);
  // 比例尺更新後,若是 active file,state.scale 立即同步(不用再按校準)
  if (file.id === state.activeFileId) syncStateScaleFromActiveFile();
  updateScaleRulerButton();
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  else { refreshLists(); render(); }
}

// 建立比例尺:智慧分流
//   選 1 條 → 以該線段長度為測量值
//   選 2 條 → 以兩線垂直距離為測量值(必須平行,否則彈警告)
function bgCreateScaleRuler() {
  const file = getActiveFile();
  if (!file) return;
  const n = (file.selectedBgPaths && file.selectedBgPaths.size) || 0;
  if (n === 2) {
    // 委派給兩線距離版
    return bgCreateScaleRulerByTwoLines();
  }
  if (n !== 1) {
    alert("請選取 1 條(以線段長度)或 2 條(以兩線垂直距離)底圖線段建立比例尺");
    return;
  }
  const idx = [...file.selectedBgPaths][0];
  const bgSvgEl = document.getElementById("bgSvg");
  const el = bgSvgEl && bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
  if (!el) return;
  const segs = svgElementToSegments(el);
  if (segs.length !== 1) {
    alert("此元素不是單一線段(可能是矩形、polyline 或多段 path)。請先「切成直線」再建立比例尺");
    return;
  }
  const seg = segs[0];
  // local → world
  const ctm = el.getScreenCTM && el.getScreenCTM();
  let p1 = { x: seg.x1, y: seg.y1 }, p2 = { x: seg.x2, y: seg.y2 };
  if (ctm) {
    const owner = el.ownerSVGElement || bgSvgEl;
    const sp1 = owner.createSVGPoint(); sp1.x = seg.x1; sp1.y = seg.y1;
    const sp2 = owner.createSVGPoint(); sp2.x = seg.x2; sp2.y = seg.y2;
    const wp1 = sp1.matrixTransform(ctm);
    const wp2 = sp2.matrixTransform(ctm);
    p1 = screenToWorld(wp1.x, wp1.y);
    p2 = screenToWorld(wp2.x, wp2.y);
  }
  // p1, p2 是 SVG path 的幾何端點(即 stroke 中心線端點,不含 stroke 粗度)
  const measured = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (measured < 1e-3) { alert("線段長度為 0,無法當比例尺"); return; }
  const input = prompt(
    `此線段(中心線)於底圖中的長度為 ${measured.toFixed(3)} 單位\n請輸入實際長度(mm,最小 1)\n(可用 + − × ÷ 與括號,例:23*1450):`,
    file.scaleRuler ? String(file.scaleRuler.real) : "");
  if (input == null) return;
  const real = evalNumExpr(input);
  if (Number.isNaN(real) || real < 1) { alert("請輸入有效的數字運算式(結果需 ≥ 1)"); return; }
  pushUndo();
  file.scaleRuler = { bgIdx: idx, p1, p2, measured, real, ratio: real / measured };
  console.log(`[比例尺] 1 底圖單位 = ${file.scaleRuler.ratio.toFixed(4)} mm  (${measured.toFixed(2)} → ${real} mm)`);
  if (file.id === state.activeFileId) syncStateScaleFromActiveFile();
  updateScaleRulerButton();
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  else { refreshLists(); render(); }
}
export function updatePlaneOriginButton() {
  const btn = $("btnPlaneOrigin");
  if (!btn) return;
  const file = getActiveFile();
  if (state.originPending) {
    _setBtnLabel(btn, "tb.planeOriginPending", "座標原點…");
    btn.classList.add("active");
  } else if (file && file.planeOrigin) {
    // active 底色代表「已設定」
    _setBtnLabel(btn, "tb.planeOrigin", "座標原點");
    btn.classList.add("active");
  } else {
    _setBtnLabel(btn, "tb.planeOrigin", "座標原點");
    btn.classList.remove("active");
  }
}

export function updateScaleRulerButton() {
  const btn = $("btnScaleRuler");
  if (!btn) return;
  const file = getActiveFile();
  if (state.scaleRulerPending) {
    _setBtnLabel(btn, "tb.scaleRulerPending", "比例尺…");
    btn.classList.add("active");
  } else if (file && file.scaleRuler) {
    _setBtnLabel(btn, "tb.scaleRuler", "比例尺");
    btn.title = `比例尺已建立:${file.scaleRuler.measured.toFixed(2)} 單位 = ${file.scaleRuler.real} mm(每單位 ${file.scaleRuler.ratio.toFixed(4)} mm)。點擊重新進入底圖模式,可重設`;
    btn.classList.add("active");
  } else {
    _setBtnLabel(btn, "tb.scaleRuler", "比例尺");
    btn.title = "建立比例尺:自動進入底圖模式,選兩條平行線後輸入真實距離,可沿線拖曳放置";
    btn.classList.remove("active");
  }
  updateCalibrateButton();
  updatePlaneOriginButton && updatePlaneOriginButton();
  // 比例尺存在與否會影響「比例尺沿線移動」按鈕的顯示
  if (typeof updateBgEditOpsVisibility === "function") updateBgEditOpsVisibility();
}

export function updateCalibrateButton() {
  const btn = $("btnCalibrate");
  if (!btn) return;
  const file = getActiveFile();
  const hasRuler  = !!(file && file.scaleRuler);
  const hasOrigin = !!(file && file.planeOrigin);
  const ready = hasRuler && hasOrigin;
  if (state.scale && ready) {
    _setBtnLabel(btn, "tb.calibrate", "校準");
    btn.title = `已校準:1 px = ${(1/state.scale).toFixed(4)} ${state.unitName}(state.scale = ${state.scale.toFixed(4)} px/${state.unitName});節點與底圖座標保持原狀,以平面原點為 (0,0)。再次點擊可重新校準`;
    btn.classList.add("active");
  } else {
    _setBtnLabel(btn, "tb.calibrate", "校準");
    if (!hasRuler && !hasOrigin)      btn.title = "校準前需先建立「比例尺」與「平面座標原點」";
    else if (!hasRuler)               btn.title = "校準前需先建立「比例尺」";
    else if (!hasOrigin)              btn.title = "校準前需先建立「平面座標原點」";
    else                              btn.title = "套用比例尺與原點:設定 px↔mm 比例(state.scale),節點與底圖座標不動,僅紀錄比例供後續換算";
    btn.classList.remove("active");
  }
}

// 校準此平面所有點的真實位置:必須有比例尺與平面原點。
//   1) 用比例尺的 ratio (mm/px) 把每個節點換成「相對原點的真實 mm」並四捨五入到 1 mm 整數
//   2) 以固定 PX:MM = 0.1:1 (state.scale = 0.1 px/mm) 重新換回像素座標
//   3) 比例尺端點同步重縮放,維持畫面上的對位
//      → 結果:節點/桿件清單顯示一律是整數 mm,桿件長度精確到 1 mm
//      → 重複按校準不會累積浮點誤差
function calibratePlane() {
  const file = getActiveFile();
  if (!file) { alert("尚未載入底圖"); return; }
  const hasRuler  = !!file.scaleRuler;
  const hasOrigin = !!file.planeOrigin;
  if (!hasRuler && !hasOrigin) {
    alert("校準前需先建立:\n• 比例尺\n• 平面座標原點");
    return;
  }
  if (!hasRuler)  { alert("校準前需先建立「比例尺」"); return; }
  if (!hasOrigin) { alert("校準前需先建立「平面座標原點」"); return; }
  pushUndo();

  // 校準策略:不對節點 / 比例尺端點 / 底圖座標做任何空間搬動,只「記下」這張底圖的 px↔mm 比例。
  //   - 過去版本會把節點 reframe 到 0.1 px/mm 的標準框架,但底圖沒同步 → 兩層 mismatch
  //   - 改成只設 state.scale,所有「真實長度」用 (px - origin) / state.scale 即時算出
  //   - state.scale 直接從 active file 的 scaleRuler.ratio 推得 → 切檔案時自動跟著切
  const ratio = file.scaleRuler.ratio;
  if (!isFinite(ratio) || ratio <= 0) { alert("比例尺 ratio 無效,請重建比例尺。"); return; }
  syncStateScaleFromActiveFile();
  const o = file.planeOrigin;
  console.log(`[校準] 1 px = ${ratio.toFixed(6)} mm (state.scale = ${state.scale.toFixed(6)} px/mm);節點/底圖座標不動;原點 = (${o.x.toFixed(2)}, ${o.y.toFixed(2)})`);
  updateCalibrateButton();
  refreshLists();
  render();
}

// 從目前選取的 bg paths 中找出所有正方形,在每個正方形的中心新增一個節點
function bgSquaresToJoints() {
  const file = getActiveFile();
  const bgSvgEl = document.getElementById("bgSvg");
  if (!file || !bgSvgEl) return;
  if (!file.selectedBgPaths || file.selectedBgPaths.size === 0) {
    alert("請先用「正方形」匡選模式選取正方形");
    return;
  }
  const p = getPage();
  if (!p || p._orphan) return;

  const eps = 1.0;
  const centers = [];
  const selectedEls = [...file.selectedBgPaths]
    .map(idx => bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`))
    .filter(el => el && el.style.display !== "none" && el.dataset.bgPageBg !== "1");

  // ---- A. 從選取的 4 條軸向 line 找方形 ----
  const horizontals = [], verticals = [];
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line") continue;
    const ends = bgLineWorldEnds(el);
    if (!ends) continue;
    const dx = ends.b.x - ends.a.x, dy = ends.b.y - ends.a.y;
    if (Math.abs(dy) < eps && Math.abs(dx) >= eps) {
      horizontals.push({ x1: Math.min(ends.a.x, ends.b.x), x2: Math.max(ends.a.x, ends.b.x), y: (ends.a.y + ends.b.y) / 2 });
    } else if (Math.abs(dx) < eps && Math.abs(dy) >= eps) {
      verticals.push({ y1: Math.min(ends.a.y, ends.b.y), y2: Math.max(ends.a.y, ends.b.y), x: (ends.a.x + ends.b.x) / 2 });
    }
  }
  for (let i = 0; i < horizontals.length; i++) {
    for (let j = i + 1; j < horizontals.length; j++) {
      const ha = horizontals[i], hb = horizontals[j];
      if (Math.abs(ha.x1 - hb.x1) > eps || Math.abs(ha.x2 - hb.x2) > eps) continue;
      const top = Math.min(ha.y, hb.y), bot = Math.max(ha.y, hb.y);
      const left  = verticals.find(v => Math.abs(v.x - ha.x1) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      const right = verticals.find(v => Math.abs(v.x - ha.x2) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      if (!left || !right) continue;
      const w = ha.x2 - ha.x1, h = bot - top;
      if (Math.abs(w - h) > eps) continue;
      centers.push({ x: (ha.x1 + ha.x2) / 2, y: (top + bot) / 2 });
    }
  }

  // ---- B. 從選取的單一元素找方形 ----
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "line") continue;
    if (tag !== "path" && tag !== "polygon" && tag !== "polyline" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (segs.length < 4) continue;
    const worldSegs = segs.map(s => {
      const a = bgLocalToWorld(el, s.x1, s.y1);
      const b = bgLocalToWorld(el, s.x2, s.y2);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    });
    let allAxis = true;
    const xs = [], ys = [];
    for (const s of worldSegs) {
      const isH = Math.abs(s.ay - s.by) < eps;
      const isV = Math.abs(s.ax - s.bx) < eps;
      if (!isH && !isV) { allAxis = false; break; }
      xs.push(s.ax, s.bx); ys.push(s.ay, s.by);
    }
    if (!allAxis) continue;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w < eps || h < eps) continue;
    if (Math.abs(w - h) > eps) continue;
    centers.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
  }

  if (centers.length === 0) {
    alert("選取項目中未偵測到正方形");
    return;
  }
  pushUndo();
  const radius = 0.5;   // 只吸收浮點誤差,別用 snapPx 把鄰近細部點合併掉
  let added = 0;
  for (const c of centers) {
    let merged = false;
    for (const j of p.joints) {
      if (Math.hypot(j.x - c.x, j.y - c.y) < radius) { merged = true; break; }
    }
    if (!merged) {
      p.joints.push({ id: nextJointId++, x: c.x, y: c.y });
      added++;
    }
  }
  console.log(`[正方形 → 節點] 偵測 ${centers.length} 個正方形,新增 ${added} 個節點`);
  render(); refreshLists();
}

// 從目前選取(底圖層)抽出所有長方形 bbox,回傳 [{ minX, minY, maxX, maxY }]
function _bgFindSelectedRects() {
  const file = getActiveFile();
  const bgSvgEl = document.getElementById("bgSvg");
  if (!file || !bgSvgEl) return null;
  const eps = 1.0;
  const rects = [];
  const selectedEls = [...file.selectedBgPaths]
    .map(idx => bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`))
    .filter(el => el && el.style.display !== "none" && el.dataset.bgPageBg !== "1");

  // A. 從選取的 4 條軸向 line 找方框
  const horizontals = [], verticals = [];
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line") continue;
    const ends = bgLineWorldEnds(el);
    if (!ends) continue;
    const dx = ends.b.x - ends.a.x, dy = ends.b.y - ends.a.y;
    if (Math.abs(dy) < eps && Math.abs(dx) >= eps) {
      horizontals.push({ x1: Math.min(ends.a.x, ends.b.x), x2: Math.max(ends.a.x, ends.b.x), y: (ends.a.y + ends.b.y) / 2 });
    } else if (Math.abs(dx) < eps && Math.abs(dy) >= eps) {
      verticals.push({ y1: Math.min(ends.a.y, ends.b.y), y2: Math.max(ends.a.y, ends.b.y), x: (ends.a.x + ends.b.x) / 2 });
    }
  }
  for (let i = 0; i < horizontals.length; i++) {
    for (let j = i + 1; j < horizontals.length; j++) {
      const ha = horizontals[i], hb = horizontals[j];
      if (Math.abs(ha.x1 - hb.x1) > eps || Math.abs(ha.x2 - hb.x2) > eps) continue;
      const top = Math.min(ha.y, hb.y), bot = Math.max(ha.y, hb.y);
      const left  = verticals.find(v => Math.abs(v.x - ha.x1) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      const right = verticals.find(v => Math.abs(v.x - ha.x2) < eps && Math.abs(v.y1 - top) < eps && Math.abs(v.y2 - bot) < eps);
      if (!left || !right) continue;
      const w = ha.x2 - ha.x1, h = bot - top;
      if (Math.abs(w - h) < eps) continue;   // 正方形 → 跳過
      rects.push({ minX: ha.x1, minY: top, maxX: ha.x2, maxY: bot });
    }
  }

  // B. 從選取的單一 path / polygon / polyline / rect 元素找方框
  for (const el of selectedEls) {
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag === "line") continue;
    if (tag !== "path" && tag !== "polygon" && tag !== "polyline" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (segs.length < 4) continue;
    const worldSegs = segs.map(s => {
      const a = bgLocalToWorld(el, s.x1, s.y1);
      const b = bgLocalToWorld(el, s.x2, s.y2);
      return { ax: a.x, ay: a.y, bx: b.x, by: b.y };
    });
    let allAxis = true;
    const xs = [], ys = [];
    for (const s of worldSegs) {
      const isH = Math.abs(s.ay - s.by) < eps;
      const isV = Math.abs(s.ax - s.bx) < eps;
      if (!isH && !isV) { allAxis = false; break; }
      xs.push(s.ax, s.bx); ys.push(s.ay, s.by);
    }
    if (!allAxis) continue;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w < eps || h < eps) continue;
    if (Math.abs(w - h) < eps) continue;       // 正方形 → 跳過
    rects.push({ minX, minY, maxX, maxY });
  }

  return rects;
}

// 對選取的長方形建桿件,mode 決定建在哪一邊:
//   "center":中軸(沿長邊)
//   "top":   上邊(y 較小,在螢幕上方;水平/垂直長方形都用「上方水平邊」)
//   "bottom":下邊(y 較大,在螢幕下方;水平/垂直長方形都用「下方水平邊」)
function bgRectsToMembers(mode) {
  mode = mode || "center";
  const file = getActiveFile();
  const p = getPage();
  if (!file || !p || p._orphan) return;
  const rects = _bgFindSelectedRects();
  if (rects == null) return;
  if (rects.length === 0) {
    alert("選取項目中未偵測到長方形");
    return;
  }
  pushUndo();
  const radius = 0.5;
  const getOrCreateJoint = (x, y) => getOrCreateJointOnPage(p, x, y, radius);
  let memAdded = 0;
  for (const r of rects) {
    const w = r.maxX - r.minX, h = r.maxY - r.minY;
    let p1, p2;
    if (mode === "top") {
      // 上水平邊
      p1 = { x: r.minX, y: r.minY };
      p2 = { x: r.maxX, y: r.minY };
    } else if (mode === "bottom") {
      // 下水平邊
      p1 = { x: r.minX, y: r.maxY };
      p2 = { x: r.maxX, y: r.maxY };
    } else if (w >= h) {
      const midY = (r.minY + r.maxY) / 2;
      p1 = { x: r.minX, y: midY };
      p2 = { x: r.maxX, y: midY };
    } else {
      const midX = (r.minX + r.maxX) / 2;
      p1 = { x: midX, y: r.minY };
      p2 = { x: midX, y: r.maxY };
    }
    const a = getOrCreateJoint(p1.x, p1.y);
    const b = getOrCreateJoint(p2.x, p2.y);
    if (a.id === b.id) continue;
    const exists = p.members.some(m =>
      (m.j1 === a.id && m.j2 === b.id) || (m.j1 === b.id && m.j2 === a.id));
    if (!exists) {
      p.members.push({ id: nextMemberId++, j1: a.id, j2: b.id });
      memAdded++;
    }
  }
  clearAllBgSelection(file);
  console.log(`[長方形 → ${mode} 桿件] 偵測 ${rects.length} 個長方形,新增 ${memAdded} 條桿件`);
  render(); refreshLists();
}

// 向後相容:舊 callers 仍能呼叫到中軸版本
function bgRectsToCenterlineMembers() { bgRectsToMembers("center"); }

function bgPathsToMembers() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) {
    alert("請先在「底圖」模式下框選或點選底圖線條");
    return;
  }
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  // 接近的節點視為同一個(snap radius)
  // 容差只用來吸收浮點誤差,不能用 snapPx — 那會把細部矩形的角(例如 3 mm 寬)合併掉
  const snapR = 0.5;   // 0.5 世界單位(通常 mm)
  const getOrCreateJoint = (x, y) => getOrCreateJointOnPage(p, x, y, snapR);
  const log = { input: file.selectedBgPaths.size, segs: 0, jointsAdded: 0, membersAdded: 0, pageBgSkip: 0 };
  const beforeJoints = p.joints.length, beforeMembers = p.members.length;
  for (const idx of file.selectedBgPaths) {
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
    if (!el2) continue;
    if (el2.dataset.bgPageBg === "1") { log.pageBgSkip++; continue; }
    const segs = svgElementToSegments(el2);
    log.segs += segs.length;
    for (const s of segs) {
      const w1 = bgLocalToWorld(el2, s.x1, s.y1);
      const w2 = bgLocalToWorld(el2, s.x2, s.y2);
      const a = getOrCreateJoint(w1.x, w1.y);
      const b = getOrCreateJoint(w2.x, w2.y);
      if (a.id === b.id) continue;
      const exists = p.members.some(m =>
        (m.j1 === a.id && m.j2 === b.id) || (m.j1 === b.id && m.j2 === a.id));
      if (!exists) p.members.push({ id: nextMemberId++, j1: a.id, j2: b.id });
    }
  }
  // 線重疊但端點不重疊時,把節點落在桿件中段的情況自動拆桿
  splitMembersAtCollinearJoints();
  log.jointsAdded = p.joints.length - beforeJoints;
  log.membersAdded = p.members.length - beforeMembers;
  console.log("[轉為桿件]", log);
  // 清掉底圖綠色選取標記(視覺) + selectedBgPaths(資料);保留在修改底圖模式
  clearAllBgSelection(file);
  render(); refreshLists();
}

// 把選取的 bg path 拆成多條 <line>(對 rect、多段 path、polyline 都有效)
function bgPathsSplitToLines() {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  pushUndo();
  let maxIdx = 0;
  bgSvgEl.querySelectorAll("[data-bg-idx]").forEach(el => {
    const i = parseInt(el.dataset.bgIdx, 10) || 0;
    if (i > maxIdx) maxIdx = i;
  });
  const newSel = new Set();
  // 沿著父鏈往上找有效 stroke / stroke-width(pdf.js 常把屬性設在 <g> 上)
  function effectiveAttr(el, name) {
    let cur = el;
    while (cur && cur.getAttribute) {
      const v = cur.getAttribute(name) || (cur.style && cur.style[name === "stroke-width" ? "strokeWidth" : name]);
      if (v && v !== "none" && v !== "") return v;
      cur = cur.parentNode;
    }
    return null;
  }
  let _splitLog = { total: 0, noEl: 0, pageBg: 0, alreadyLine: 0, split: 0 };
  for (const idx of [...file.selectedBgPaths]) {
    _splitLog.total++;
    const el2 = bgSvgEl.querySelector(`[data-bg-idx="${idx}"]`);
    if (!el2) { _splitLog.noEl++; continue; }
    if (el2.dataset.bgPageBg === "1") { _splitLog.pageBg++; continue; }
    const segs = svgElementToSegments(el2);
    if (segs.length <= 1) {
      _splitLog.alreadyLine++;
      console.log(`[切成直線] idx=${idx} tag=${el2.tagName} segs=${segs.length} d=${(el2.getAttribute("d")||"").slice(0,80)} → 跳過(已是單一線段或不可解析)`);
      continue;
    }
    _splitLog.split++;
    console.log(`[切成直線] idx=${idx} tag=${el2.tagName} segs=${segs.length} → 拆`);
    const stroke = effectiveAttr(el2, "stroke") || "currentColor";
    const sw = effectiveAttr(el2, "stroke-width") || "1";
    const parent = el2.parentNode;
    const newEls = [];
    for (const s of segs) {
      const ln = document.createElementNS("http://www.w3.org/2000/svg", "line");
      ln.setAttribute("x1", s.x1); ln.setAttribute("y1", s.y1);
      ln.setAttribute("x2", s.x2); ln.setAttribute("y2", s.y2);
      ln.setAttribute("stroke", stroke);
      ln.setAttribute("stroke-width", sw);
      ln.style.vectorEffect = "non-scaling-stroke";
      ln.classList.add("bg-stroke", "bg-selected");
      maxIdx += 1;
      ln.dataset.bgIdx = String(maxIdx);
      attachBgPathHandlers(ln, file);
      newEls.push(ln);
      newSel.add(String(maxIdx));
    }
    for (const ne of newEls) parent.insertBefore(ne, el2);
    parent.removeChild(el2);
    file.selectedBgPaths.delete(idx);
  }
  newSel.forEach(k => file.selectedBgPaths.add(k));
  applyBgSelectMode();
  updateBgStrokeWidth();
  render();
  updateBgEditOpsVisibility();
  console.log("[切成直線] 結果:", _splitLog);
}

function attachBgPathHandlers(/* el2, file */) {
  // 已改為 document 層事件委派(見下方 bgSvgDelegate*),此函式保留為 no-op,
  // 維持外部 call sites 無需更動。減少 N 個元素的 listener 為 1 個,降低記憶體與 dispatch 成本。
}
// 事件委派:對 bgSvg 內所有 [data-bg-idx] 元素統一處理 click / contextmenu。
//   capture 模式 → 比 bubble 階段的 wrap.click / document.click 早觸發
//   stopPropagation → 阻止後續 wrap.click 把點擊當作畫布空白點處理
function _bgSvgDelegateClick(ev) {
  if (state.tool !== "selectBg") return;
  // 畫直線 / 複製線 / 中分線 / 等分線 / 切面定位 進行中 → 點擊由 wrap.click 處理,不走選取邏輯
  if ((state.bgDrawLine && state.bgDrawLine.active) ||
      (state.bgCopyLine && state.bgCopyLine.active) ||
      (state.bgBisector && state.bgBisector.active) ||
      (state.bgEqui && state.bgEqui.active) ||
      state.sectionLinkPlacing) return;
  const el2 = ev.target && ev.target.closest && ev.target.closest("[data-bg-idx]");
  if (!el2 || !el2.closest("#bgSvg")) return;
  const file = getActiveFile();
  if (!file) return;
  // 切面 pending:只接受單段直線(line / 單段 path / 單段 polyline)
  //   非直線(rect / circle / 多段 path / 太短)→ 直接擋掉,不要污染選取狀態
  //   防呆:state.sectionLinkPending 為 true 但 btnSectionLink 不在 active(狀態不一致)→ 視為已退出,清旗標
  if (state.sectionLinkPending) {
    const _btn = document.getElementById("btnSectionLink");
    const _reallyPending = _btn && _btn.classList.contains("active");
    if (!_reallyPending) {
      state.sectionLinkPending = false;
      state.sectionLinkPrevTool = null;
      if (typeof _restoreSectionLinkShapeMarquee === "function") _restoreSectionLinkShapeMarquee();
    } else if (!_isStraightBgLineElement(el2)) {
      ev.stopPropagation();
      $("hud").textContent = "切面:只能選直線(實線 / 虛線都可;不接受矩形 / 圓 / 多段折線)";
      return;
    }
  }
  ev.stopPropagation();
  hideCtxMenu();
  if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
  const key = String(el2.dataset.bgIdx);
  if (subtractiveSelect(ev)) {
    if (file.selectedBgPaths.has(key)) {
      file.selectedBgPaths.delete(key);
      el2.classList.remove("bg-selected");
    }
  } else if (ev.shiftKey || state.bgMultiSelect) {
    if (file.selectedBgPaths.has(key)) {
      file.selectedBgPaths.delete(key);
      el2.classList.remove("bg-selected");
    } else {
      file.selectedBgPaths.add(key);
      el2.classList.add("bg-selected");
    }
  } else {
    if (!state.originPending && !state.scaleRulerPending) clearAllBgSelection(file);
    file.selectedBgPaths.add(key);
    el2.classList.add("bg-selected");
  }
  updateBgEditOpsVisibility();
  checkBgPendingAfterSelect();
}
function _bgSvgDelegateContext(ev) {
  if (state.tool !== "selectBg") return;
  const el2 = ev.target && ev.target.closest && ev.target.closest("[data-bg-idx]");
  if (!el2 || !el2.closest("#bgSvg")) return;
  const file = getActiveFile();
  if (!file) return;
  ev.preventDefault(); ev.stopPropagation();
  if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
  const key = String(el2.dataset.bgIdx);
  if (!file.selectedBgPaths.has(key)) {
    clearAllBgSelection(file);
    file.selectedBgPaths.add(key);
    el2.classList.add("bg-selected");
  }
  updateBgEditOpsVisibility();
  showBgCtxMenu(ev.clientX, ev.clientY);
}
document.addEventListener("click", _bgSvgDelegateClick, true);
document.addEventListener("contextmenu", _bgSvgDelegateContext, true);
function clearAllBgSelection(file) {
  if (!file || !file.selectedBgPaths) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (bgSvgEl) {
    // 一次掃所有 .bg-selected,避免每個 idx 都呼叫 querySelector(N×N → N)
    bgSvgEl.querySelectorAll(".bg-selected").forEach(el => el.classList.remove("bg-selected"));
  }
  file.selectedBgPaths.clear();
  updateBgEditOpsVisibility();
}
function selectAllBgPaths() {
  const file = getActiveFile();
  if (!file) return;
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return;
  if (!file.selectedBgPaths) file.selectedBgPaths = new Set();
  bgSvgEl.querySelectorAll("[data-bg-idx]").forEach(el2 => {
    if (el2.style.display === "none") return;     // 已刪除的不選
    if (el2.dataset.bgPageBg === "1") return;     // 跳過頁背景級大方框
    file.selectedBgPaths.add(String(el2.dataset.bgIdx));
    el2.classList.add("bg-selected");
  });
  updateBgEditOpsVisibility();
}

function showBgCtxMenu(x, y) {
  const file = getActiveFile();
  if (!file || !file.selectedBgPaths || file.selectedBgPaths.size === 0) return;
  ctxPending = {
    bgPaths: new Set(file.selectedBgPaths),
    joints: new Set(), members: new Set(), orphans: new Set(), fileIds: new Set(),
  };
  $("ctxHead").textContent = `已選 ${file.selectedBgPaths.size} 條底圖線條`;
  $("ctxList").innerHTML = "";
  $("ctxRename").style.display = "none";
  $("ctxDuplicate") && ($("ctxDuplicate").style.display = "none");
  $("ctxOpenTab") && ($("ctxOpenTab").style.display = "none");
  $("ctxFilterGroup").style.display = "none";
  $("ctxBgSplit").style.display = "block";
  $("ctxBgToMember").style.display = "block";
  $("ctxBgToDashed") && ($("ctxBgToDashed").style.display = "block");
  // 建立比例尺:只在「正好一條」 bg 線段選取時顯示
  $("ctxBgScaleRuler") && ($("ctxBgScaleRuler").style.display = file.selectedBgPaths.size === 1 ? "block" : "none");
  $("ctxDelete").style.display = "block";
  const m = $("ctxMenu");
  m.style.display = "flex";
  m.style.left = "0px"; m.style.top = "0px";
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + "px";
  m.style.top  = Math.min(y, window.innerHeight - h - 4) + "px";
}

function svgElementToSegments(el2) {
  const segs = [];
  // 用 localName,避免某些瀏覽器把 SVG tagName 回傳成 "svg:path" 等帶 namespace 前綴的字串
  const tag = (el2.localName || el2.tagName.replace(/^.*:/, "")).toLowerCase();
  if (tag === "line") {
    segs.push({
      x1: parseFloat(el2.getAttribute("x1") || 0),
      y1: parseFloat(el2.getAttribute("y1") || 0),
      x2: parseFloat(el2.getAttribute("x2") || 0),
      y2: parseFloat(el2.getAttribute("y2") || 0),
    });
  } else if (tag === "path") {
    const d = el2.getAttribute("d") || "";
    segs.push(...parseStraightSegs(d));
  } else if (tag === "rect") {
    const x = parseFloat(el2.getAttribute("x") || 0);
    const y = parseFloat(el2.getAttribute("y") || 0);
    const w = parseFloat(el2.getAttribute("width") || 0);
    const h = parseFloat(el2.getAttribute("height") || 0);
    segs.push({ x1: x, y1: y, x2: x + w, y2: y });
    segs.push({ x1: x + w, y1: y, x2: x + w, y2: y + h });
    segs.push({ x1: x + w, y1: y + h, x2: x, y2: y + h });
    segs.push({ x1: x, y1: y + h, x2: x, y2: y });
  } else if (tag === "polyline" || tag === "polygon") {
    const pts = (el2.getAttribute("points") || "").split(/[\s,]+/).filter(s => s !== "").map(parseFloat);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      segs.push({ x1: pts[i], y1: pts[i+1], x2: pts[i+2], y2: pts[i+3] });
    }
    if (tag === "polygon" && pts.length >= 4) {
      const lastIx = pts.length - 2;
      segs.push({ x1: pts[lastIx], y1: pts[lastIx+1], x2: pts[0], y2: pts[1] });
    }
  }
  return segs;
}

function zoomToSelection() {
  const p = getPage();
  if (!p) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const id of state.selection.joints) {
    const j = p.joints.find(jj => jj.id === id);
    if (j) grow(j.x, j.y);
  }
  for (const id of state.selection.members) {
    const m = p.members.find(mm => mm.id === id);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (a) grow(a.x, a.y);
    if (b) grow(b.x, b.y);
  }
  if (!isFinite(minX)) {
    alert("請先選取節點或桿件。");
    return;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const r = wrap.getBoundingClientRect();
  // 0.7 為留白比例 → 邊界保留約 30% 空間
  const z = Math.min(r.width / w, r.height / h) * 0.7;
  state.zoom = Math.max(0.0001, Math.min(50, z));
  state.panX = r.width  / 2 - cx * state.zoom;
  state.panY = r.height / 2 - cy * state.zoom;
  applyTransform();
  render();
}
$("btnIntersect") && ($("btnIntersect").onclick = processIntersections);
$("selToolsIntersectSel") && ($("selToolsIntersectSel").onclick = processIntersectionsForSelection);
// 適配關聯:三種模式(只節點 / 只桿件 / 兩者),都對當前 active 檔
async function _runInferOnActiveFile(mode) {
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  if (!af) { alert("尚未選擇檔案"); return; }
  if (!_fileHasFullSetup(af)) { alert(`「${af.name}」設定不齊(平面 / 比例尺 / 原點)`); return; }
  pushUndo();
  const r = await _populateSectionLinkJointsForFile(af, { mode });
  if (!r) { $("hud").textContent = "本檔沒有切面線,無法推斷"; return; }
  const label = mode === "joints" ? "節點" : mode === "members" ? "桿件" : "節點+桿件";
  console.log(`[適配關聯:${label}] file=${af.name}・處理 ${r.processedLinks} 條・新增節點 ${r.jointsAdded}・桿件 ${r.membersAdded}・略過 ${r.skipped}` +
    (r.conflicts.length ? `・衝突 ${r.conflicts.length} 件` : ""));
  if (r.conflicts.length) {
    r.conflicts.forEach(c => console.warn("[切面衝突]", c));
    const head = r.conflicts.slice(0, 5).join("\n");
    const more = r.conflicts.length > 5 ? `\n…(共 ${r.conflicts.length} 件,詳見 console)` : "";
    alert(`偵測到多平行切面衝突:\n\n${head}${more}`);
  }
  const parts = [];
  if (r.jointsAdded)  parts.push(`節點 +${r.jointsAdded}`);
  if (r.membersAdded) parts.push(`桿件 +${r.membersAdded}`);
  if (!parts.length)  parts.push("無新增");
  $("hud").textContent = `適配關聯:${label}・${parts.join("、")}・處理 ${r.processedLinks} 條切面` +
    (r.conflicts.length ? `・⚠ 衝突 ${r.conflicts.length} 件` : "");
  render && render();
  refreshLists && refreshLists();
}
// 新版「適配關聯」(精準度配對全部檔案)
//   舊版 _runInferOnActiveFile / _runInferAllFiles (切面投影建節點) 仍保留,可被 console 或舊資料流呼叫
$("btnRelayoutCurrent") && ($("btnRelayoutCurrent").onclick = () => withBusy("編排節點編號(當頁)…", () => relayoutNumbering()));
$("btnRelayoutMembersCurrent") && ($("btnRelayoutMembersCurrent").onclick = () => withBusy("編排桿件編號(當頁)…", () => relayoutMembersNumbering()));
// 全部頁面:對 state.files 每個檔跑指定 mode("joints" / "members" / "both")
//   非同步 + 顯示可中斷的 pending 訊息(取消鈕);每個檔處理完後 busyTick + 檢查 cancel 旗標
async function _runInferAllFiles(mode, opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  const skipPushUndo = !!opts.skipPushUndo;
  const labelMap = { joints: "節點", members: "桿件", both: "節點 + 桿件" };
  const label = labelMap[mode] || "節點 + 桿件";
  const effMode = labelMap[mode] ? mode : "both";
  if (!state.files.length) { if (!skipConfirm) alert("沒有可處理的檔案"); return; }
  if (!skipConfirm && !confirm(`對全部 ${state.files.length} 個檔案跑「適配關聯${label}」?\n${
    effMode === "members" ? "只在兩端 joint 都已對應到目標既有節點時連桿(不建新節點)。" :
    effMode === "joints"  ? "會建節點並自動綁 globalJoint(不建桿件)。" :
                            "會建節點 + 桿件並自動綁 globalJoint。"
  }Ctrl+Z 可還原。\n處理時可從 spinner 上的「取消」按鈕中斷。`)) return;
  if (!skipPushUndo) pushUndo();
  const origFid = state.activeFileId, origPidx = state.pageIdx;
  let totalJ = 0, totalM = 0, totalLinks = 0, touched = 0;
  const allConflicts = [];
  let cancelled = false;
  const files = state.files.slice();
  const onEsc = (e) => {
    if (e.key === "Escape" && !cancelled) {
      e.preventDefault(); e.stopImmediatePropagation();
      cancelled = true;
      setBusyMessage("取消中…等當前檔處理完畢");
    }
  };
  document.addEventListener("keydown", onEsc, true);
  showBusyWithCancel(`適配關聯${label}(全部頁面)準備中…(共 ${files.length} 檔・Esc / 取消可中斷)`, () => {
    cancelled = true;
    setBusyMessage("取消中…等當前檔處理完畢");
  });
  await busyTick();
  let processedCount = 0;
  for (const f of files) {
    if (cancelled) break;
    processedCount++;
    setBusyMessage(`適配關聯${label} ${processedCount}/${files.length}・${f.name}`);
    await busyTick();
    if (cancelled) break;
    if (!_fileHasFullSetup(f)) continue;
    // 注意:不切換 state.activeFileId / pageIdx — _populateSectionLinkJointsForFile 用 F 參數運作,
    //   不讀全局 active state。切換 activeFileId 會讓 undo 後底圖 DOM 與 activeFile 對不上,
    //   造成 Cmd+Z 後 bg 消失。維持 origFid 不動才能讓 bg DOM / bgWidth / bgHeight 一致。
    const r = await _populateSectionLinkJointsForFile(f, {
      mode: effMode,
      onProgress: ({ fileName, processed }) => {
        if (cancelled) return false;
        setBusyMessage(`適配關聯${label} ${processedCount}/${files.length}・${fileName}(處理 ${processed} 節點)`);
      },
    });
    if (!r) continue;
    totalJ += r.jointsAdded; totalM += r.membersAdded; totalLinks += r.processedLinks;
    if (r.jointsAdded || r.membersAdded) touched++;
    for (const c of r.conflicts) allConflicts.push(`${f.name}: ${c}`);
  }
  // origFid/origPidx 從未被改過,但保留還原語義避免將來有人改了上面又忘了還原
  state.activeFileId = origFid; state.pageIdx = origPidx;
  document.removeEventListener("keydown", onEsc, true);
  hideBusy();
  const cancelTag = cancelled ? `(已中斷;處理到第 ${processedCount}/${files.length} 檔)` : "";
  console.log(`[適配關聯${label}(全部頁面)]${cancelTag} ${touched} 檔有變動・節點 +${totalJ}・桿件 +${totalM}・處理 ${totalLinks} 條切面・衝突 ${allConflicts.length} 件`);
  if (allConflicts.length) allConflicts.forEach(c => console.warn("[切面衝突]", c));
  render && render(); refreshLists && refreshLists();
  refreshFileList && refreshFileList();
  $("hud").textContent = `適配關聯${label}(全部頁面)${cancelTag}・${touched} 檔・節點 +${totalJ}・桿件 +${totalM}` +
    (allConflicts.length ? `・⚠ 衝突 ${allConflicts.length} 件` : "");
}
// 舊名稱保留(menu entry 用):
async function _runInferAllFilesBoth() { return _runInferAllFiles("both"); }

// 適配關聯(精準度):用 measureDecimals 把每顆 joint 的世界座標 round 後當 bucket key,
//   bucket 內 ≥ 2 顆來自不同檔 / 不同頁的 joint → 視為「同一物理點」,綁同一 globalJoint。
//   canonical 世界座標 = 該 bucket 的 round 後值(顯示什麼就存什麼)。
//   不依賴切面線、不需要建立節點(只「適配」既有節點)。
//   opts.skipConfirm:跳過確認對話框(批次 / 程式呼叫用)
//   回傳 { groupsCreated, jointsBound, mergedToExisting, totalScanned }
export function _runFitMergeByPrecision(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  const md = Math.max(0, Math.min(6, Number.isFinite(state.measureDecimals) ? state.measureDecimals : 0));
  const _round = (v) => {
    const r = parseFloat(v.toFixed(md));
    return r === 0 ? 0 : r;
  };
  const _setMsg = (m) => { if (typeof setBusyMessage === "function") setBusyMessage(m); };
  // _tick:直接用 busyTick(已內建 document.hidden 偵測 → 背景 tab 改用 microtask 快速路徑)
  const _tick = () => (typeof busyTick === "function") ? busyTick() : Promise.resolve();
  // 改 async 實作;外部 caller(menu dispatch 用 withBusy / 3D popup 用 await)能看到 spinner message 更新
  //   內部主動啟用 / 關閉主 spinner(showBusy / hideBusy)—— 確保:
  //     (1) 直接呼叫時(不走 withBusy)也看得到 spinner
  //     (2) 3D popup 的 startMirrorBusy polling 要 `.active` 才會鏡像 — 沒啟用就看不到 progress
  //   withBusy 包起來時:主 spinner 已是 active,showBusy 只是覆蓋 msg;hideBusy 會在 withBusy.finally 前先移除 .active → 沒副作用
  return (async () => {
  const _started = (typeof showBusy === "function");
  if (_started) showBusy(`適配關聯(精準度 ${md})準備中…`);
  try {
  // 掃描所有 joint,計算世界座標 + bucket key
  _setMsg(`適配關聯(精準度 ${md}):掃描節點中…`);
  await _tick();
  const buckets = new Map();   // "x|y|z" → [{file, page, key, joint, w}]
  let totalScanned = 0;
  for (const f of state.files) {
    if (!_fileHasFullSetup(f)) continue;
    for (const k of Object.keys(f.pages || {})) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) {
        totalScanned++;
        const w = (typeof _worldForRank === "function") ? _worldForRank(f, pg, j) : null;
        if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.z)) continue;
        const rx = _round(w.x), ry = _round(w.y), rz = _round(w.z);
        const key = `${rx}|${ry}|${rz}`;
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push({ file: f, page: pg, key: +k, j, w: { x: rx, y: ry, z: rz } });
      }
    }
  }
  _setMsg(`適配關聯(精準度 ${md}):掃描完成 ${totalScanned} 顆 ・ 計算候選 bucket…`);
  await _tick();
  // 預估會有多少 bucket 需要處理(只挑 ≥ 2 顆且來自不同檔 / 不同頁的)
  let candidateBuckets = 0;
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    const fids = new Set(arr.map(it => it.file.id + "|" + it.key));
    if (fids.size >= 2) candidateBuckets++;
  }
  if (!skipConfirm) {
    if (!candidateBuckets) {
      alert(`適配關聯:掃描 ${totalScanned} 顆節點,精準度 ${md} 位數下沒有可合併的 bucket(都不重疊)。`);
      return { groupsCreated: 0, jointsBound: 0, mergedToExisting: 0, totalScanned };
    }
  }
  // 統計既有綁定(用於 confirm 訊息 + 完成報告)
  _setMsg(`適配關聯(精準度 ${md}):統計既有綁定…`);
  await _tick();
  const existingGjs = Array.isArray(state.globalJoints) ? state.globalJoints.length : 0;
  const existingGms = Array.isArray(state.globalMembers) ? state.globalMembers.length : 0;
  let existingJointBindings = 0, existingMemberBindings = 0;
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) if (j.globalId != null) existingJointBindings++;
      for (const m of (pg.members || [])) if (m.globalMemberId != null) existingMemberBindings++;
    }
  }
  if (!skipConfirm) {
    const wipeMsg = (existingGjs || existingGms || existingJointBindings || existingMemberBindings)
      ? `\n\n⚠ 會先清除所有既有綁定(避免舊精準度 / 舊校準殘留污染新結果):\n  ・globalJoint 物件 ${existingGjs} 個 ・joint 綁定 ${existingJointBindings} 顆\n  ・globalMember 物件 ${existingGms} 個 ・member 綁定 ${existingMemberBindings} 條`
      : "";
    if (!confirm(`適配關聯:精準度 ${md} 位數 → 找到 ${candidateBuckets} 個可合併 bucket(共 ${totalScanned} 顆節點掃描中)。\n\n會把每組 bucket 內、來自不同檔 / 不同頁的 joint 綁定到同一個 globalJoint(canonical 座標 = round 後的值)。${wipeMsg}\n\nCtrl+Z 可還原。要繼續嗎?`)) {
      return { groupsCreated: 0, jointsBound: 0, mergedToExisting: 0, totalScanned };
    }
  }
  pushUndo();
  // 清除所有既有 global* 綁定 —— 從乾淨狀態重建,避免舊資料污染
  _setMsg(`適配關聯(精準度 ${md}):清除既有 ${existingGjs} gj / ${existingGms} gm…`);
  await _tick();
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) j.globalId = null;
      for (const m of (pg.members || [])) m.globalMemberId = null;
    }
  }
  state.globalJoints = [];
  state.globalMembers = [];
  if (typeof nextGlobalMemberId !== "undefined") nextGlobalMemberId = 1;
  if (typeof nextGlobalJointId !== "undefined") nextGlobalJointId = 1;
  _setMsg(`適配關聯(精準度 ${md}):建立 globalJoint(候選 ${candidateBuckets} bucket)…`);
  await _tick();
  let groupsCreated = 0, jointsBound = 0;
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue;
    const pageKeys = new Set(arr.map(it => it.file.id + "|" + it.key));
    if (pageKeys.size < 2) continue;   // 同一頁多個 joint 應該由「整理」處理
    // 一律新建 globalJoint(既有綁定已在前面清光,不再有 reuse 分支)
    const nextId = state.globalJoints.length
      ? Math.max(...state.globalJoints.map(g => g.id || 0)) + 1 : 1;
    const gid = nextId;
    const wRef = arr[0].w;
    state.globalJoints.push({ id: gid, label: `N${gid}`, x: wRef.x, y: wRef.y, z: wRef.z });
    groupsCreated++;
    // 綁定該 bucket 內所有 joint
    for (const it of arr) {
      it.j.globalId = gid;
      jointsBound++;
    }
  }
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  // 適配桿件:joint global 化完後立即跑桿件 binding
  _setMsg(`適配關聯(精準度 ${md}):綁定 globalMember…`);
  await _tick();
  const memberStats = autoBindGlobalMembers();
  if (!skipConfirm) {
    alert(`適配關聯完成・精準度 ${md} 位數\n` +
      `清除既有:${existingGjs} globalJoint / ${existingGms} globalMember ・ 解綁 ${existingJointBindings} joint / ${existingMemberBindings} member\n` +
      `新建 globalJoint: ${groupsCreated}・綁定 joint: ${jointsBound}・掃描 ${totalScanned} 顆\n` +
      `新建 globalMember: ${memberStats.created}・綁定 member: ${memberStats.bound}・掃描 ${memberStats.scanned} 條`);
  }
  console.log(`[適配關聯(精準度)] md=${md}・清除 ${existingGjs} gj / ${existingGms} gm ・ bucket 候選 ${candidateBuckets}・新建 globalJoint ${groupsCreated}・綁定 ${jointsBound}・掃描 joint ${totalScanned}・新建 globalMember ${memberStats.created}・綁定 member ${memberStats.bound}・掃描 member ${memberStats.scanned}`);
  $("hud").textContent = `適配關聯(精準度 ${md})・節點 ${jointsBound} / 桿件 ${memberStats.bound}`;
  render && render();
  refreshLists && refreshLists();
  // 若 3D 預覽視窗開著,主動通知重建 —— menu 路徑也要讓 3D 即時反映新的 globalMember 合併結果
  //   (3D popup 自己的批次 handler 在 finally 也會呼叫 rebuildData,重複呼叫無害)
  try {
    if (typeof _3dPreviewWindow !== "undefined" && _3dPreviewWindow && _3dPreviewWindow.win
        && !_3dPreviewWindow.win.closed && typeof _3dPreviewWindow.rebuildData === "function") {
      _3dPreviewWindow.rebuildData();
    }
  } catch (_) {}
  return { groupsCreated, jointsBound, mergedToExisting: 0, totalScanned, memberCreated: memberStats.created, memberBound: memberStats.bound };
  } finally {
    if (_started && typeof hideBusy === "function") hideBusy();
  }
  })();
}

// 全局桿件:依「兩端 globalJoint id 對」自動建立 / 綁定 state.globalMembers
//   member.globalMemberId 指向 state.globalMembers[].id
//   只處理「兩端 joint 都有 globalId」的 member;沒綁的 member 維持本地 m.id
function autoBindGlobalMembers() {
  if (!Array.isArray(state.globalMembers)) state.globalMembers = [];
  // 建索引:(gj_min, gj_max) → globalMember
  const idx = new Map();
  for (const gm of state.globalMembers) {
    const k = `${gm.gj1}|${gm.gj2}`;
    idx.set(k, gm);
  }
  let created = 0, bound = 0, scanned = 0;
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      const jmap = new Map((pg.joints || []).map(j => [j.id, j]));
      for (const m of (pg.members || [])) {
        scanned++;
        const j1 = jmap.get(m.j1), j2 = jmap.get(m.j2);
        if (!j1 || !j2) continue;
        if (j1.globalId == null || j2.globalId == null) continue;
        const a = Math.min(j1.globalId, j2.globalId);
        const b = Math.max(j1.globalId, j2.globalId);
        const k = `${a}|${b}`;
        let gm = idx.get(k);
        if (!gm) {
          const gid = nextGlobalMemberId++;
          gm = { id: gid, label: "M" + gid, gj1: a, gj2: b };
          state.globalMembers.push(gm);
          idx.set(k, gm);
          created++;
        }
        if (m.globalMemberId !== gm.id) {
          m.globalMemberId = gm.id;
          bound++;
        }
      }
    }
  }
  return { created, bound, scanned };
}

// 清除「綁定點實際世界座標分歧過大」的 globalJoint(典型成因:適配關聯把多平行切面的不同物理位置 joint 誤綁同一 globalJoint)
//   opts.threshold:bbox 任一軸最大差距 > threshold 視為「壞綁定」(預設 100 mm)
//   opts.clearAll:true → 直接清掉所有 globalJoint 綁定(不論分歧大小)
//   opts.skipConfirm:跳過 confirm 對話框(批次操作用)
//   回傳 { gjsRemoved, bindingsUnbound, totalGjs, badGjs }
export function cleanupBadGlobalJoints(opts) {
  opts = opts || {};
  const threshold = opts.threshold != null ? opts.threshold : 100;
  const clearAll = !!opts.clearAll;
  const skipConfirm = !!opts.skipConfirm;
  // 收集每個 globalJoint 的所有 binding + 反推各 binding 的實際世界座標
  const gjBindings = new Map();
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) {
        if (j.globalId == null) continue;
        const w = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(f, pg, j) : null;
        if (!w) continue;
        let arr = gjBindings.get(j.globalId);
        if (!arr) { arr = []; gjBindings.set(j.globalId, arr); }
        arr.push({ file: f, page: pg, joint: j, world: w });
      }
    }
  }
  // 找出「壞」的:多個 binding 但世界座標分歧 > threshold,或 clearAll
  const bad = [];
  for (const [gid, bindings] of gjBindings) {
    if (clearAll) { bad.push({ gid, bindings, delta: null }); continue; }
    if (bindings.length < 2) continue;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const b of bindings) {
      if (b.world.x<minX)minX=b.world.x; if (b.world.x>maxX)maxX=b.world.x;
      if (b.world.y<minY)minY=b.world.y; if (b.world.y>maxY)maxY=b.world.y;
      if (b.world.z<minZ)minZ=b.world.z; if (b.world.z>maxZ)maxZ=b.world.z;
    }
    const maxDelta = Math.max(maxX-minX, maxY-minY, maxZ-minZ);
    if (maxDelta > threshold) bad.push({ gid, bindings, delta: maxDelta });
  }
  if (!bad.length) {
    if (!skipConfirm) {
      alert(clearAll ? "目前沒有任何 globalJoint 綁定可清除" : `沒有 globalJoint 的綁定點分歧超過 ${threshold} mm — 全部都是乾淨的`);
    }
    return { gjsRemoved: 0, bindingsUnbound: 0, totalGjs: gjBindings.size, badGjs: 0 };
  }
  let totalBindings = 0;
  for (const b of bad) totalBindings += b.bindings.length;
  if (!skipConfirm) {
    const extraGmMsg = clearAll
      ? `\n・globalMember 物件(全部)也會一併移除、所有 member.globalMemberId 會設為 null`
      : "";
    const msg = clearAll
      ? `將清除所有 globalJoint 綁定:\n・globalJoint 物件 ${gjBindings.size} 個會被移除\n・joint.globalId ${totalBindings} 個會被設為 null${extraGmMsg}\n\nCtrl+Z 可還原。\n要繼續嗎?`
      : `偵測到 ${bad.length} 個 globalJoint 的綁定點實際世界座標分歧超過 ${threshold} mm(總共 ${totalBindings} 個 joint binding 被誤綁):\n・這些 globalJoint 物件會被移除\n・對應 joint.globalId 會設為 null\n・其餘綁定正確的 globalJoint 不受影響\n\n清完後建議再跑「三視圖自動配對」重新建立正確綁定。\nCtrl+Z 可還原。\n要繼續嗎?`;
    if (!confirm(msg)) return { gjsRemoved: 0, bindingsUnbound: 0, totalGjs: gjBindings.size, badGjs: bad.length };
  }
  pushUndo();
  let unbound = 0;
  const removedGids = new Set();
  for (const b of bad) {
    for (const bd of b.bindings) {
      bd.joint.globalId = null;
      unbound++;
    }
    removedGids.add(b.gid);
  }
  if (Array.isArray(state.globalJoints)) {
    state.globalJoints = state.globalJoints.filter(g => !removedGids.has(g.id));
  }
  // clearAll 模式:一併清掉 globalMember(沒有它們 globalJoint 就是殭屍指標的上層),
  //   並解除所有 m.globalMemberId,重置 counter。非 clearAll 模式保留 globalMember(可能還有效)。
  let gmsRemoved = 0, memberBindingsCleared = 0;
  if (clearAll) {
    gmsRemoved = Array.isArray(state.globalMembers) ? state.globalMembers.length : 0;
    state.globalMembers = [];
    for (const f of state.files) {
      for (const pg of Object.values(f.pages || {})) {
        if (!pg || pg._orphan) continue;
        for (const m of (pg.members || [])) {
          if (m.globalMemberId != null) { m.globalMemberId = null; memberBindingsCleared++; }
        }
      }
    }
    if (typeof nextGlobalMemberId !== "undefined") nextGlobalMemberId = 1;
  }
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  refreshFileList && refreshFileList();
  refreshLists && refreshLists();
  render && render();
  const msg = clearAll
    ? `已清除所有 global 綁定:移除 ${removedGids.size} globalJoint + ${gmsRemoved} globalMember,解除 ${unbound} joint + ${memberBindingsCleared} member binding`
    : `清除錯誤綁定:移除 ${removedGids.size} 個 globalJoint(分歧 > ${threshold} mm),解除 ${unbound} 個 joint binding;其餘正確綁定保留`;
  console.log(`[清理 globalJoint] ${msg}`);
  $("hud").textContent = msg + "。下一步建議:跑「三視圖自動配對」重建正確綁定";
  return { gjsRemoved: removedGids.size, bindingsUnbound: unbound, totalGjs: gjBindings.size, badGjs: bad.length, gmsRemoved, memberBindingsCleared };
}
$("btnConsolidate") && ($("btnConsolidate").onclick = () => withBusy("整理中…", consolidateGeometry));
$("btnExtendCheck") && ($("btnExtendCheck").onclick = () => startExtendableMemberCheckCurrentPage());

// 自動編「本頁數字」(填空式,保留既有設定):
//   1. 已有 groupNum 的頁面 → 一律保留,不動
//   2. 排序頁面:平面(XY → XZ → YZ → 未指派)→ |z| 升序(z 最接近 0 先排)→ 檔名倒序
//   3. 對每個「沒有 groupNum」的頁面,從 1 開始找「最小可用整數」(不在 takenNums 裡)分配
//   結果:每個平面內 z 最接近 0 的頁面會優先拿到較小數字(若它本來就沒 groupNum);
//   既有設定不會被覆蓋,全域不重複。
function autoAssignPageGroupNumbers(planeFilter) {
  const planeOrder = { XY: 0, XZ: 1, YZ: 2 };
  // 排序方式:select#autoPageGroupNumSort 為主("name" / "z");沒元件時預設 name
  const sortBy = ($("autoPageGroupNumSort") && $("autoPageGroupNumSort").value) || "name";
  // 全部頁:用來決定哪些 groupNum 已被佔用(避免跨平面重複)
  const allPages = [];
  const taken = new Set();
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      allPages.push({ file: f, pg, key: k });
      if (pg.groupNum != null && Number.isFinite(pg.groupNum)) taken.add(pg.groupNum);
    }
  }
  if (!allPages.length) { alert("沒有可編號的頁面"); return; }
  // 篩出符合 planeFilter 的「目標頁面」(planeFilter 為 null / 不傳 → 全部頁)
  const inScope = planeFilter
    ? allPages.filter(e => e.pg.plane === planeFilter)
    : allPages;
  if (!inScope.length) {
    alert(`目前沒有任何頁面是「${planeFilter}」平面`); return;
  }
  const missing = inScope.filter(e => e.pg.groupNum == null || !Number.isFinite(e.pg.groupNum));
  if (!missing.length) {
    $("hud").textContent = `${planeFilter || "所有"}平面的 ${inScope.length} 個頁面都已有本頁數字,沒東西要填`;
    return;
  }
  const sortLabel = sortBy === "name" ? "名稱升序" : "第三軸 |z| 升序";
  const planeLabel = planeFilter ? `${planeFilter} 平面` : "所有平面";
  if (!confirm(`將對 ${planeLabel}下 ${missing.length} 個沒有「本頁數字」的頁面自動填號(該平面已設定的 ${inScope.length - missing.length} 個保留不動)。\n排序方式:${sortLabel}。要繼續嗎?`)) return;
  pushUndo();
  const cmpName = (a, b) => String(a.file.name).localeCompare(String(b.file.name), undefined, { numeric: true, sensitivity: "base" });
  const sortPages = (arr) => {
    arr.sort((a, b) => {
      const pa = planeOrder[a.pg.plane] != null ? planeOrder[a.pg.plane] : 99;
      const pb = planeOrder[b.pg.plane] != null ? planeOrder[b.pg.plane] : 99;
      if (pa !== pb) return pa - pb;
      if (sortBy === "name") {
        const c = cmpName(a, b);
        if (c !== 0) return c;
        const aza = Math.abs(Number.isFinite(a.pg.z) ? a.pg.z : 0);
        const azb = Math.abs(Number.isFinite(b.pg.z) ? b.pg.z : 0);
        return aza - azb;
      }
      const za = Number.isFinite(a.pg.z) ? a.pg.z : 0;
      const zb = Number.isFinite(b.pg.z) ? b.pg.z : 0;
      const aza = Math.abs(za), azb = Math.abs(zb);
      if (aza !== azb) return aza - azb;
      if (za !== zb) return zb - za;
      return -cmpName(a, b);
    });
  };
  // 依平面分組(目前最多 1 個平面,因為 inScope 是 planeFilter 後的;但 planeFilter=null 時可能多平面)
  const byPlane = new Map();
  for (const ent of inScope) {
    const k = ent.pg.plane || "_none_";
    if (!byPlane.has(k)) byPlane.set(k, []);
    byPlane.get(k).push(ent);
  }
  // 該平面的「第一個數字」 = 該平面排序後第一頁的 groupNum;若它沒設定就分配最小可用整數,以它為起點
  const findSmallestUnused = () => {
    let c = 1;
    while (taken.has(c)) c++;
    return c;
  };
  const cap = state.globalCapacity || 10000;
  const overflowing = [];
  const summary = [];
  for (const [plane, pages] of byPlane) {
    sortPages(pages);
    // 確定該平面的起點
    let startNum = null;
    const first = pages[0];
    if (first.pg.groupNum != null && Number.isFinite(first.pg.groupNum)) {
      startNum = first.pg.groupNum;
    } else {
      const v = findSmallestUnused();
      first.pg.groupNum = v;
      taken.add(v);
      startNum = v;
      if (v > cap) overflowing.push({ name: first.file.name, plane: first.pg.plane, z: first.pg.z, n: v });
      summary.push({ name: first.file.name, plane: first.pg.plane || "—", z: first.pg.z != null ? first.pg.z : "—", newNum: v, anchor: true });
    }
    // 之後的頁面:cursor 從 startNum+1 開始往上跳;遇到既存 groupNum 就更新 cursor;
    //   missing 的頁面就找 cursor 起始的下一個未被佔用整數(嚴格往上,不會回頭撿小數字)
    let cursor = startNum + 1;
    for (let i = 1; i < pages.length; i++) {
      const ent = pages[i];
      if (ent.pg.groupNum != null && Number.isFinite(ent.pg.groupNum)) {
        if (ent.pg.groupNum >= cursor) cursor = ent.pg.groupNum + 1;
        continue;
      }
      while (taken.has(cursor)) cursor++;
      const v = cursor;
      ent.pg.groupNum = v;
      taken.add(v);
      cursor++;
      if (v > cap) overflowing.push({ name: ent.file.name, plane: ent.pg.plane, z: ent.pg.z, n: v });
      summary.push({ name: ent.file.name, plane: ent.pg.plane || "—", z: ent.pg.z != null ? ent.pg.z : "—", newNum: v });
    }
  }
  console.log(`[一鍵自動編 本頁數字] ${planeLabel}・排序=${sortLabel}・填 ${missing.length} 個(該平面保留 ${inScope.length - missing.length} 個既有,全域共 ${allPages.length} 頁):`, summary);
  if (overflowing.length) {
    console.warn(`[一鍵自動編 本頁數字] 有 ${overflowing.length} 筆超出可容納數字 ${cap}:`, overflowing);
  }
  refreshPageCoordSection();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render(); refreshLists();
  $("hud").textContent = `已填 ${missing.length} 個頁面的本頁數字(${planeLabel}・保留 ${inScope.length - missing.length} 個・${sortLabel})${overflowing.length ? `・⚠ ${overflowing.length} 筆超 cap` : ""}`;
}
// 兩顆「一鍵自動編 本頁數字」按鈕都只針對「當前 active 頁面所屬的平面」處理 —
//   想處理別的平面用編輯選單那三個 entry。沒設平面的當前頁就走「全部頁」。
function _autoAssignFromActivePage() {
  const p = (typeof getPage === "function") ? getPage() : null;
  const plane = p && p.plane;
  autoAssignPageGroupNumbers(plane || null);
}

// (舊版)合併重疊桿件邏輯 — 已被「整理」(_consolidateInPlace,btnConsolidate / 整理所有頁面)取代,
//   保留此函式以利之後若要做更寬容差版本時可重用;目前 UI 不暴露入口。
//   差異:_consolidateInPlace 用 0.5 容差(嚴),這版本 angTol=1e-2 / offsetTol=5(寬)。
function dedupOverlapOnPage(page, opts) {
  if (!page || !Array.isArray(page.members) || !page.members.length) {
    return { groups: 0, removed: 0, added: 0 };
  }
  const joints = page.joints || [];
  const jointById = new Map(joints.map(j => [j.id, j]));
  // 容差(opts 可覆寫 — 例如未來想做嚴 / 寬模式)
  const angTol     = (opts && opts.angTol     != null) ? opts.angTol     : 1e-2;   // ≈ 0.57°(寬一點容忍 DXF 微偏軸)
  const offsetTol  = (opts && opts.offsetTol  != null) ? opts.offsetTol  : 5.0;    // 5 單位(mm)
  const overlapTol = (opts && opts.overlapTol != null) ? opts.overlapTol : 5.0;    // 同上
  const debug = !!(opts && opts.debug);
  const lineMap = new Map();
  const memberRecords = [];
  for (const m of page.members) {
    const j1 = jointById.get(m.j1);
    const j2 = jointById.get(m.j2);
    if (!j1 || !j2) continue;
    const dx = j2.x - j1.x, dy = j2.y - j1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    let nx = dx / len, ny = dy / len;
    if (nx < -1e-12 || (Math.abs(nx) < 1e-12 && ny < 0)) { nx = -nx; ny = -ny; }
    const ang = Math.atan2(ny, nx);
    const offset = -ny * j1.x + nx * j1.y;
    const angRound = Math.round(ang / angTol);
    const offRound = Math.round(offset / offsetTol);
    const key = `${angRound}|${offRound}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    const rec = { m, j1, j2, ang, offset };
    lineMap.get(key).push(rec);
    memberRecords.push(rec);
  }
  if (debug) {
    console.log(`[dedupOverlap] page members=${page.members.length}・lineGroups=${lineMap.size}・容差: ang=${angTol} offset=${offsetTol} overlap=${overlapTol}`);
    let multi = 0;
    for (const [k, g] of lineMap) if (g.length >= 2) multi++;
    console.log(`[dedupOverlap]   有 ${multi} 個共線群組(≥2 條)`);
  }
  let groupsConsolidated = 0, removed = 0, added = 0;
  const removeIds = new Set();
  const newMembers = [];
  for (const [key, group] of lineMap) {
    if (group.length < 2) continue;     // 單一桿件,不會跟自己重疊
    // 用 group 第一條的 (j1, direction) 當參考軸
    const head = group[0];
    const dxH = head.j2.x - head.j1.x, dyH = head.j2.y - head.j1.y;
    const lenH = Math.hypot(dxH, dyH);
    const nxR = dxH / lenH, nyR = dyH / lenH;
    const ax = head.j1.x, ay = head.j1.y;
    const projT = (j) => (j.x - ax) * nxR + (j.y - ay) * nyR;
    const ranges = group.map(r => {
      const t1 = projT(r.j1);
      const t2 = projT(r.j2);
      return { ...r, t1, t2, lo: Math.min(t1, t2), hi: Math.max(t1, t2) };
    });
    ranges.sort((a, b) => a.lo - b.lo);
    // 合併 overlap unions
    const unions = [];
    let cur = null;
    for (const r of ranges) {
      if (!cur || r.lo > cur.hi + overlapTol) {
        if (cur) unions.push(cur);
        cur = { lo: r.lo, hi: r.hi, members: [r] };
      } else {
        cur.hi = Math.max(cur.hi, r.hi);
        cur.members.push(r);
      }
    }
    if (cur) unions.push(cur);
    for (const u of unions) {
      // 預先判斷:union 只有 1 條桿件,且線上沒有任何中段節點落在它的範圍 → 沒事可做,跳過
      //   (避免單純的 1 桿件 union 也走 remove + re-add 的 ID 重編)
      if (u.members.length < 2) {
        const r0 = u.members[0];
        const tLo = r0.lo, tHi = r0.hi;
        let hasExtra = false;
        for (const j of joints) {
          if (j.id === r0.j1.id || j.id === r0.j2.id) continue;
          const px = j.x - ax, py = j.y - ay;
          if (Math.abs(-nyR * px + nxR * py) > offsetTol) continue;
          const t = px * nxR + py * nyR;
          if (t < tLo + overlapTol || t > tHi - overlapTol) continue;     // 嚴格落在範圍內
          hasExtra = true; break;
        }
        if (!hasExtra) continue;
      }
      if (debug) {
        console.log(`[dedupOverlap]   union [${u.lo.toFixed(1)}, ${u.hi.toFixed(1)}] 含 ${u.members.length} 條桿件:`,
          u.members.map(r => `#${r.m.id}: j${r.m.j1}(${r.j1.x.toFixed(0)},${r.j1.y.toFixed(0)})-j${r.m.j2}(${r.j2.x.toFixed(0)},${r.j2.y.toFixed(0)}) t[${r.lo.toFixed(1)},${r.hi.toFixed(1)}]`));
      }
      // 1) 先收原桿件的端點;2) 再把「在這條線上、t 落在 union 範圍內」的所有 joints 也納入
      //    → 7 個共線節點即使中間節點不是任一桿件的端點,也會被當成斷點 → 結果一定切成 N-1 段
      //    去重:同 id 或同位置(t 在 overlapTol 內)視為同一個點
      const ptByT = [];
      const ptById = new Map();
      const _posMatch = (t1, t2) => Math.abs(t1 - t2) <= overlapTol;
      const tryAdd = (ent) => {
        if (ptById.has(ent.j.id)) return false;
        for (const p of ptByT) if (_posMatch(p.t, ent.t)) return false;
        ptById.set(ent.j.id, ent);
        ptByT.push(ent);
        return true;
      };
      for (const r of u.members) {
        tryAdd({ j: r.j1, t: r.t1 });
        tryAdd({ j: r.j2, t: r.t2 });
      }
      // 掃整頁的 joints,把「垂直距離 < offsetTol 且 t 落在 union 範圍內」的也加入
      //   normal vector = (-nyR, nxR);垂直距離 = |(-nyR)*(jx-ax) + nxR*(jy-ay)|
      let extraJoints = 0;
      for (const j of joints) {
        if (ptById.has(j.id)) continue;
        const px = j.x - ax, py = j.y - ay;
        const perp = Math.abs(-nyR * px + nxR * py);
        if (perp > offsetTol) continue;
        const t = px * nxR + py * nyR;
        if (t < u.lo - overlapTol || t > u.hi + overlapTol) continue;
        if (tryAdd({ j, t })) extraJoints++;
      }
      ptByT.sort((a, b) => a.t - b.t);
      if (debug) {
        console.log(`[dedupOverlap]     端點(${ptByT.length} 個・其中 ${extraJoints} 個是線上中段節點):`,
          ptByT.map(p => `j${p.j.id}@t=${p.t.toFixed(1)}(${p.j.x.toFixed(0)},${p.j.y.toFixed(0)})`));
      }
      // 移除原桿件
      for (const r of u.members) removeIds.add(r.m.id);
      // 新建相鄰 joint 連成的鏈狀桿件
      const expectedPairs = [];
      for (let i = 0; i < ptByT.length - 1; i++) {
        const a = ptByT[i].j, b = ptByT[i + 1].j;
        if (a.id === b.id) continue;
        // 同位置的 joint 偶爾會重複(不太可能,但保險)
        if (Math.abs(ptByT[i].t - ptByT[i + 1].t) < overlapTol) continue;
        expectedPairs.push([a.id, b.id]);
      }
      for (const [j1id, j2id] of expectedPairs) {
        newMembers.push({ id: nextMemberId++, j1: j1id, j2: j2id });
        added++;
      }
      removed += u.members.length;
      groupsConsolidated++;
    }
  }
  if (removeIds.size || newMembers.length) {
    page.members = page.members.filter(m => !removeIds.has(m.id));
    page.members.push(...newMembers);
  }
  if (debug) {
    console.log(`[dedupOverlap] 結束・groups=${groupsConsolidated} removed=${removed} added=${added}`);
    if (groupsConsolidated === 0) {
      console.log(`[dedupOverlap] (沒有發現任何重疊;若你預期應該有,請貼上方 log 看共線群組是否分到不同 key)`);
    }
  }
  return { groups: groupsConsolidated, removed, added };
}
function dedupOverlapAllPages() {
  const stats = [];
  let totalGroups = 0, totalRemoved = 0, totalAdded = 0, totalPagesTouched = 0;
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      const before = pg.members ? pg.members.length : 0;
      const r = dedupOverlapOnPage(pg);
      if (!r.groups) continue;
      totalGroups += r.groups;
      totalRemoved += r.removed;
      totalAdded += r.added;
      totalPagesTouched++;
      stats.push({
        file: f.name, page: k,
        beforeCount: before, afterCount: pg.members ? pg.members.length : 0,
        groups: r.groups, removed: r.removed, added: r.added,
        net: r.added - r.removed,
      });
    }
  }
  return { stats, totalGroups, totalRemoved, totalAdded, totalPagesTouched };
}
// 依關聯映射節點 — 對每個檔每條 primary section link:
//   - 若 targetFileIds 多於 1 個 → 通知並跳過(避免歧義)
//   - 否則找源頁上所有「落在這條切線(2D 線段內 + 3D cut 平面內)」的節點,投影到唯一 target 頁建節點
//   投影:joint2DToWorld3D → 把 depth 軸換成 target 頁的 z → world3DToJoint2D
//   去重:target 頁已有同位置(< dedupRadius)的節點就不重複建
//   不會動桿件 — 只建節點
function mapJointsViaSectionLinks() {
  if (!state.files.length) { alert("沒有可處理的檔案"); return; }
  const tol3D = 1.0;
  const tol2D = 5.0;
  const dedupRadius = 0.5;
  // 先 dry-scan 統計可處理 / 跳過的條數
  const allPrimaries = [];
  for (const F of state.files) {
    if (!_fileHasFullSetup(F)) continue;
    const sls = F.sectionLinks || [];
    for (const e of sls) {
      if (e.autoProp) continue;
      allPrimaries.push({ file: F, entry: e });
    }
  }
  if (!allPrimaries.length) {
    alert("目前沒有任何主關聯切面"); return;
  }
  const skipMulti = allPrimaries.filter(p => (p.entry.targetFileIds || []).length > 1);
  const skipNone  = allPrimaries.filter(p => (p.entry.targetFileIds || []).length === 0);
  const ok        = allPrimaries.filter(p => (p.entry.targetFileIds || []).length === 1);
  if (!confirm(
    `依關聯映射節點:\n` +
    `・主關聯總數:${allPrimaries.length}\n` +
    `・會處理(target=1):${ok.length}\n` +
    `・會跳過(target>1):${skipMulti.length}\n` +
    `・會跳過(target=0):${skipNone.length}\n` +
    `會把每條可處理主關聯的源頁節點投影到 target 頁建節點。\nCtrl+Z 可還原。要繼續嗎?`
  )) return;
  pushUndo();
  const stats = { processedLinks: 0, jointsAdded: 0, skipped: [] };
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };
  for (const p of skipMulti) stats.skipped.push({ host: p.file.name, entryId: p.entry.id, reason: `target 數 ${p.entry.targetFileIds.length} > 1` });
  for (const p of skipNone)  stats.skipped.push({ host: p.file.name, entryId: p.entry.id, reason: "無 target" });
  for (const { file: F, entry: e } of ok) {
    const Fpage = F.pages && F.pages[0];
    if (!Fpage || !e.p1 || !e.p2) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: "源頁設定不齊或切線端點缺" });
      continue;
    }
    if (!e.cutAxis || !Number.isFinite(e.cutValue)) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: "切線非軸向化" });
      continue;
    }
    const tid = e.targetFileIds[0];
    const T = state.files.find(x => x.id === tid);
    if (!T || !_fileHasFullSetup(T)) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: `target 不存在或設定不齊(id=${tid})` });
      continue;
    }
    const Tpage = T.pages && T.pages[0];
    if (!Tpage || !Tpage.plane) {
      stats.skipped.push({ host: F.name, entryId: e.id, reason: "target 頁未設平面" });
      continue;
    }
    const Tdepth = _planeAxisInfo(Tpage.plane).depth.toLowerCase();
    const tz = (Tpage.z != null && Number.isFinite(Tpage.z)) ? Tpage.z : 0;
    const cutAxLower = e.cutAxis.toLowerCase();
    let countAdded = 0, countConsidered = 0;
    // 段距函式(2D)
    const segDist2D = (px, py) => {
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) return Math.hypot(px - e.p1.x, py - e.p1.y);
      const t = Math.max(0, Math.min(1, ((px - e.p1.x) * dx + (py - e.p1.y) * dy) / len2));
      return Math.hypot(px - (e.p1.x + t * dx), py - (e.p1.y + t * dy));
    };
    for (const j of (Fpage.joints || [])) {
      const W = joint2DToWorld3D(F, Fpage, j);
      if (!W) continue;
      // 3D 切面平面檢查:joint 在 cutAxis = cutValue 平面上
      if (Math.abs(W[cutAxLower] - e.cutValue) > tol3D) continue;
      // 2D 線段檢查:確保 joint 確實落在切線段上(避免共面但離線段太遠)
      if (segDist2D(j.x, j.y) > tol2D) continue;
      countConsidered++;
      // 投影到 target:把 depth 軸換成 target.z
      const Wp = { x: W.x, y: W.y, z: W.z };
      Wp[Tdepth] = tz;
      const t2d = world3DToJoint2D(T, Tpage, Wp);
      if (!t2d || !t2d.ok) continue;
      // dedup
      let exists = null;
      for (const tj of (Tpage.joints || [])) {
        if (Math.hypot(tj.x - t2d.x, tj.y - t2d.y) < dedupRadius) { exists = tj; break; }
      }
      if (exists) {
        // 既有節點剛好在投影點 → 不新建,但仍嘗試把 src + 既有節點綁同一 globalId
        _autoBindGlobalForMappedJoint(j, exists, W, _bindOpts);
        continue;
      }
      if (!Array.isArray(Tpage.joints)) Tpage.joints = [];
      const newJoint = { id: nextJointId++, x: t2d.x, y: t2d.y };
      Tpage.joints.push(newJoint);
      _autoBindGlobalForMappedJoint(j, newJoint, W, _bindOpts);
      countAdded++;
    }
    stats.processedLinks++;
    stats.jointsAdded += countAdded;
    console.log(`[依關聯映射節點] ${F.name} #${e.id} → ${T.name}・候選 ${countConsidered} 個・新建 ${countAdded} 個`);
  }
  // 批次 infer 被動到的 globalJoints(避免每次綁定都 O(total joints))
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  console.log(`[依關聯映射節點] 完成・處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點・gids ${_touchedGids.size}・跳過 ${stats.skipped.length}`, stats.skipped);
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render && render();
  refreshLists && refreshLists();
  if (stats.skipped.length) {
    const top = stats.skipped.slice(0, 6).map(s => `「${s.host}」#${s.entryId}: ${s.reason}`).join("\n");
    alert(`映射完成。\n處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點。\n跳過 ${stats.skipped.length} 條(前 6 條):\n${top}`);
  } else {
    $("hud").textContent = `映射完成・處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點`;
  }
}

// 把映射 / 推斷動作裡的 source / target joint 綁同一個 globalJoint。
//   優先使用既有 gid;沒人有就新建。
//   opts.skipInfer = true → 不馬上跑 inferGlobalJoint(bulk 用,結束後統一 infer);
//   opts.touched = Set<gid> → 把被動到的 gid 收集起來(配合 skipInfer 後續批次 infer)
function _autoBindGlobalForMappedJoint(srcJoint, tgtJoint, world, opts) {
  if (!srcJoint || !tgtJoint || !world) return null;
  const skipInfer = !!(opts && opts.skipInfer);
  const touched = opts && opts.touched;
  let gid = null;
  if (srcJoint.globalId != null) gid = srcJoint.globalId;
  else if (tgtJoint.globalId != null) gid = tgtJoint.globalId;
  if (gid == null) {
    const g = createGlobalJoint();
    g.x = _snapCoordToPrecision(world.x);
    g.y = _snapCoordToPrecision(world.y);
    g.z = _snapCoordToPrecision(world.z);
    gid = g.id;
  }
  if (srcJoint.globalId == null) srcJoint.globalId = gid;
  if (tgtJoint.globalId == null) tgtJoint.globalId = gid;
  if (touched) touched.add(gid);
  if (!skipInfer) {
    const g2 = (typeof findGlobalJointById === "function") ? findGlobalJointById(gid) : null;
    if (g2 && typeof inferGlobalJoint === "function") inferGlobalJoint(g2);
  }
  return gid;
}

// 依關聯映射節點(本頁版)— 限制掃描範圍只到當前 active 檔的 sectionLinks
function mapJointsViaSectionLinksOnCurrentFile() {
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  if (!af) { alert("尚未選擇檔案"); return; }
  const tol3D = 1.0, tol2D = 5.0, dedupRadius = 0.5;
  const primaries = (af.sectionLinks || []).filter(e => !e.autoProp);
  if (!primaries.length) { alert(`「${af.name}」本頁沒有主關聯切面`); return; }
  const skipMulti = primaries.filter(e => (e.targetFileIds || []).length > 1);
  const skipNone  = primaries.filter(e => (e.targetFileIds || []).length === 0);
  const ok        = primaries.filter(e => (e.targetFileIds || []).length === 1);
  if (!confirm(
    `依關聯映射節點(本頁・${af.name}):\n` +
    `・主關聯總數:${primaries.length}\n` +
    `・會處理(target=1):${ok.length}\n` +
    `・會跳過(target>1):${skipMulti.length}\n` +
    `・會跳過(target=0):${skipNone.length}\n` +
    `Ctrl+Z 可還原。要繼續嗎?`
  )) return;
  pushUndo();
  const stats = { processedLinks: 0, jointsAdded: 0, skipped: [] };
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };
  for (const e of skipMulti) stats.skipped.push({ host: af.name, entryId: e.id, reason: `target 數 ${e.targetFileIds.length} > 1` });
  for (const e of skipNone)  stats.skipped.push({ host: af.name, entryId: e.id, reason: "無 target" });
  const Fpage = af.pages && af.pages[0];
  if (!Fpage || !_fileHasFullSetup(af)) {
    alert("本檔設定不齊(平面 / 比例尺 / 原點)"); return;
  }
  for (const e of ok) {
    if (!e.p1 || !e.p2 || !e.cutAxis || !Number.isFinite(e.cutValue)) {
      stats.skipped.push({ host: af.name, entryId: e.id, reason: "切線非軸向化或端點缺" });
      continue;
    }
    const tid = e.targetFileIds[0];
    const T = state.files.find(x => x.id === tid);
    if (!T || !_fileHasFullSetup(T)) {
      stats.skipped.push({ host: af.name, entryId: e.id, reason: `target 不存在或設定不齊(id=${tid})` });
      continue;
    }
    const Tpage = T.pages && T.pages[0];
    if (!Tpage || !Tpage.plane) {
      stats.skipped.push({ host: af.name, entryId: e.id, reason: "target 頁未設平面" });
      continue;
    }
    const Tdepth = _planeAxisInfo(Tpage.plane).depth.toLowerCase();
    const tz = (Tpage.z != null && Number.isFinite(Tpage.z)) ? Tpage.z : 0;
    const cutAxLower = e.cutAxis.toLowerCase();
    let countAdded = 0, countConsidered = 0;
    const segDist2D = (px, py) => {
      const dx = e.p2.x - e.p1.x, dy = e.p2.y - e.p1.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) return Math.hypot(px - e.p1.x, py - e.p1.y);
      const t = Math.max(0, Math.min(1, ((px - e.p1.x) * dx + (py - e.p1.y) * dy) / len2));
      return Math.hypot(px - (e.p1.x + t * dx), py - (e.p1.y + t * dy));
    };
    for (const j of (Fpage.joints || [])) {
      const W = joint2DToWorld3D(af, Fpage, j);
      if (!W) continue;
      if (Math.abs(W[cutAxLower] - e.cutValue) > tol3D) continue;
      if (segDist2D(j.x, j.y) > tol2D) continue;
      countConsidered++;
      const Wp = { x: W.x, y: W.y, z: W.z };
      Wp[Tdepth] = tz;
      const t2d = world3DToJoint2D(T, Tpage, Wp);
      if (!t2d || !t2d.ok) continue;
      let exists = null;
      for (const tj of (Tpage.joints || [])) {
        if (Math.hypot(tj.x - t2d.x, tj.y - t2d.y) < dedupRadius) { exists = tj; break; }
      }
      if (exists) {
        // 既有節點剛好在投影點 → 不新建,但仍嘗試把 src + 既有節點綁同一 globalId
        _autoBindGlobalForMappedJoint(j, exists, W, _bindOpts);
        continue;
      }
      if (!Array.isArray(Tpage.joints)) Tpage.joints = [];
      const newJoint = { id: nextJointId++, x: t2d.x, y: t2d.y };
      Tpage.joints.push(newJoint);
      _autoBindGlobalForMappedJoint(j, newJoint, W, _bindOpts);
      countAdded++;
    }
    stats.processedLinks++;
    stats.jointsAdded += countAdded;
    console.log(`[依關聯映射節點(本頁)] ${af.name} #${e.id} → ${T.name}・候選 ${countConsidered} 個・新建 ${countAdded} 個`);
  }
  // 批次 infer 被動到的 globalJoints
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  console.log(`[依關聯映射節點(本頁)] 完成・處理 ${stats.processedLinks}・新增 ${stats.jointsAdded}・gids ${_touchedGids.size}・跳過 ${stats.skipped.length}`, stats.skipped);
  refreshFileList && refreshFileList();
  refreshLists && refreshLists();
  render && render();
  if (stats.skipped.length) {
    const top = stats.skipped.slice(0, 6).map(s => `「${s.host}」#${s.entryId}: ${s.reason}`).join("\n");
    alert(`映射完成(本頁)。\n處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點。\n跳過 ${stats.skipped.length} 條(前 6 條):\n${top}`);
  } else {
    $("hud").textContent = `映射完成(本頁)・處理 ${stats.processedLinks} 條主關聯・新增 ${stats.jointsAdded} 個節點`;
  }
}

// 跳出一個多選列表對話框,右側帶 preview(reuse renderFileThumb)
//   - row click 切換選取;雙擊 = 只選該列並確定
//   - hover 或 click 任一列 → 右側 preview 切到該檔案
//   - candidate 需提供 .file(用於 renderFileThumb);.label / .right 顯示文字
//   回傳 Promise<Array<candidate>|null>(取消回 null)
function _pickTargetPageDialog(opts) {
  return new Promise((resolve) => {
    const { title, header, candidates } = opts;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
    const card = document.createElement("div");
    card.style.cssText = "background:#1c1d20;border:1px solid #555;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.6);padding:14px;width:min(900px, 90vw);max-height:85vh;display:flex;flex-direction:column;";
    const t = document.createElement("div");
    t.style.cssText = "font-weight:700;font-size:13px;color:#9bb6e8;margin-bottom:6px;";
    t.textContent = title || "選擇目標";
    card.appendChild(t);
    if (header) {
      const h = document.createElement("div");
      h.style.cssText = "font-size:11px;color:#9aa0a6;margin-bottom:8px;white-space:pre-line;";
      h.textContent = header;
      card.appendChild(h);
    }
    // 全選 / 全不選 + 計數
    const topBar = document.createElement("div");
    topBar.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;font-size:11px;color:#9aa0a6;";
    const selCount = document.createElement("span");
    const _btnStyle = "padding:2px 8px;font-size:11px;background:#2a2c30;color:#ddd;border:1px solid #444;border-radius:3px;cursor:pointer;";
    const selAllBtn = document.createElement("button");
    selAllBtn.textContent = "全選";
    selAllBtn.style.cssText = _btnStyle;
    const selNoneBtn = document.createElement("button");
    selNoneBtn.textContent = "全不選";
    selNoneBtn.style.cssText = _btnStyle;
    const btnGroup = document.createElement("div");
    btnGroup.style.cssText = "display:flex;gap:6px;";
    btnGroup.appendChild(selAllBtn);
    btnGroup.appendChild(selNoneBtn);
    topBar.appendChild(selCount);
    topBar.appendChild(btnGroup);
    card.appendChild(topBar);
    // body:左側列表 + 右側 preview
    const body = document.createElement("div");
    body.style.cssText = "display:flex;gap:10px;flex:1;min-height:360px;overflow:hidden;";
    // 左側列表
    const listEl = document.createElement("div");
    listEl.style.cssText = "flex:0 0 320px;overflow-y:auto;border:1px solid #333;border-radius:4px;background:#15161a;";
    // 右側 preview
    const previewWrap = document.createElement("div");
    previewWrap.style.cssText = "flex:1;display:flex;flex-direction:column;border:1px solid #333;border-radius:4px;background:#0d0e10;min-width:300px;";
    const previewHeader = document.createElement("div");
    previewHeader.style.cssText = "padding:6px 10px;font-size:11px;color:#9aa0a6;border-bottom:1px solid #333;flex:0 0 auto;";
    previewHeader.textContent = "預覽(hover 任一列即顯示)";
    previewWrap.appendChild(previewHeader);
    const previewStage = document.createElement("div");
    previewStage.style.cssText = "flex:1;display:flex;align-items:center;justify-content:center;padding:8px;position:relative;";
    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = 540; previewCanvas.height = 380;
    previewCanvas.style.cssText = "max-width:100%;max-height:100%;background:#0d0e10;display:block;";
    previewStage.appendChild(previewCanvas);
    previewWrap.appendChild(previewStage);
    body.appendChild(listEl);
    body.appendChild(previewWrap);
    card.appendChild(body);
    const rows = [];
    const selected = new Set();
    let previewFid = null;
    const updateCount = () => {
      selCount.textContent = `已選 ${selected.size} / ${candidates.length}`;
    };
    const setRowVisual = (row, on) => {
      if (on) {
        row.style.background = "rgba(79,157,255,0.18)";
        row.style.outline = "1px solid #4f9dff";
        row.style.outlineOffset = "-1px";
      } else {
        row.style.background = "transparent";
        row.style.outline = "none";
      }
      const cb = row.querySelector(".sl-cb");
      if (cb) cb.textContent = on ? "☑" : "☐";
    };
    const updatePreview = (c) => {
      if (!c || !c.file) return;
      previewFid = c.file.id;
      const pg = c.file.pages && c.file.pages[0];
      const planeTxt = pg && pg.plane ? pg.plane : "—";
      const zTxt = pg && pg.z != null ? `${_planeAxisInfo(planeTxt).depth}=${pg.z}` : "";
      previewHeader.textContent = `${c.file.name}・${planeTxt}${zTxt ? "・" + zTxt : ""}`;
      // 用既有的 renderFileThumb;它會自動處理 clipRect / svg viewBox
      if (typeof renderFileThumb === "function") {
        renderFileThumb(previewCanvas, c.file).catch(err => console.warn("[picker preview]", err));
      }
    };
    candidates.forEach((c, i) => {
      const row = document.createElement("div");
      row.style.cssText = "padding:8px 12px;border-bottom:1px solid #2a2c30;cursor:pointer;font-size:12px;color:#ddd;display:flex;align-items:center;gap:8px;";
      row.onmouseenter = () => {
        if (!selected.has(i)) row.style.background = "#24262b";
        updatePreview(c);
      };
      row.onmouseleave = () => { if (!selected.has(i)) row.style.background = "transparent"; };
      const cb = document.createElement("span");
      cb.className = "sl-cb";
      cb.style.cssText = "font-size:14px;color:#9bb6e8;flex-shrink:0;";
      cb.textContent = "☐";
      row.appendChild(cb);
      const left = document.createElement("span");
      left.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      left.textContent = c.label;
      row.appendChild(left);
      if (c.right) {
        const right = document.createElement("span");
        right.style.cssText = "color:#9aa0a6;font-size:10px;flex-shrink:0;";
        right.textContent = c.right;
        row.appendChild(right);
      }
      row.onclick = (e) => {
        e.stopPropagation();
        if (selected.has(i)) selected.delete(i);
        else selected.add(i);
        setRowVisual(row, selected.has(i));
        updateCount();
        updatePreview(c);
      };
      row.ondblclick = (e) => {
        e.stopPropagation();
        selected.clear(); selected.add(i);
        rows.forEach((r, ri) => setRowVisual(r, ri === i));
        updateCount();
        finish(true);
      };
      listEl.appendChild(row);
      rows.push(row);
    });
    // Footer
    const footer = document.createElement("div");
    footer.style.cssText = "margin-top:12px;display:flex;justify-content:flex-end;gap:8px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.style.cssText = "padding:6px 14px;font-size:12px;background:#2a2c30;color:#ddd;border:1px solid #444;border-radius:3px;cursor:pointer;";
    const okBtn = document.createElement("button");
    okBtn.textContent = "確定";
    okBtn.className = "primary";
    okBtn.style.cssText = "padding:6px 14px;font-size:12px;background:#2f4a78;color:#fff;border:1px solid #4a78c8;border-radius:3px;cursor:pointer;";
    footer.appendChild(cancelBtn); footer.appendChild(okBtn);
    card.appendChild(footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    selAllBtn.onclick = () => {
      candidates.forEach((_, i) => selected.add(i));
      rows.forEach(r => setRowVisual(r, true));
      updateCount();
    };
    selNoneBtn.onclick = () => {
      selected.clear();
      rows.forEach(r => setRowVisual(r, false));
      updateCount();
    };
    function finish(ok) {
      const picks = ok ? Array.from(selected).sort((a, b) => a - b).map(i => candidates[i]) : [];
      cleanup();
      resolve(ok && picks.length ? picks : null);
    }
    function cleanup() {
      document.removeEventListener("keydown", onKey, true);
      try { overlay.remove(); } catch (_) {}
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
      else if (e.key === "Enter" && selected.size > 0) { e.preventDefault(); e.stopImmediatePropagation(); finish(true); }
    }
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(false); });
    document.addEventListener("keydown", onKey, true);
    updateCount();
  });
}

// 把當前頁(active 檔的第一頁)的節點 + 桿件複製到指定的同平面頁面
export async function copyPageJointsMembersToSamePlanePage() {
  const sf = (typeof getActiveFile === "function") ? getActiveFile() : null;
  const sp = (typeof getPage === "function") ? getPage() : null;
  if (!sf || !sp) { alert("尚未選擇檔案 / 頁面"); return; }
  if (!sp.plane) { alert("本頁未設平面"); return; }
  if (!_fileHasFullSetup(sf)) { alert(`「${sf.name}」設定不齊(平面 / 比例尺 / 原點)`); return; }
  if (!Array.isArray(sp.joints) || !sp.joints.length) { alert("本頁沒有節點可複製"); return; }
  const candidates = [];
  for (const f of state.files) {
    if (f.id === sf.id) continue;
    if (!_fileHasFullSetup(f)) continue;
    const pg = f.pages && f.pages[0];
    if (!pg || pg.plane !== sp.plane) continue;
    candidates.push({ file: f, page: pg });
  }
  if (!candidates.length) {
    alert(`沒有其他 ${sp.plane} 平面、設定齊全的檔案可作為目標`);
    return;
  }
  const depthAxisName = _planeAxisInfo(sp.plane).depth;
  // 用 list dialog 選 target
  const items = candidates.map(c => ({
    label: c.file.name,
    right: `${c.page.plane}・${depthAxisName}=${c.page.z != null ? c.page.z : "—"}`,
    file: c.file, page: c.page,
  }));
  const picks = await _pickTargetPageDialog({
    title: "複製本頁節點+桿件到同平面頁(可多選)",
    header: `從「${sf.name}」(${sp.plane}・${depthAxisName}=${sp.z != null ? sp.z : "—"})複製 ${sp.joints.length} 個節點、${(sp.members || []).length} 條桿件\n勾選一個或多個目標頁(雙擊單列 = 只選該列並確定;Enter 確定;Esc 取消):`,
    candidates: items,
  });
  if (!picks || !picks.length) return;
  showBusy(`複製到 ${picks.length} 個目標頁…`);
  await busyTick();
  pushUndo();
  const dedupRadius = 0.5;
  let totalJ = 0, totalJReused = 0, totalM = 0;
  const perTarget = [];
  const _touchedGids = new Set();
  const _bindOpts = { skipInfer: true, touched: _touchedGids };
  for (const picked of picks) {
    const T = picked.file;
    const Tp = picked.page;
    const tDepth = _planeAxisInfo(Tp.plane).depth.toLowerCase();
    const tz = (Tp.z != null && Number.isFinite(Tp.z)) ? Tp.z : 0;
    const idMap = new Map();
    let countJ = 0, countM = 0, countJReused = 0;
    for (const j of sp.joints) {
      const W = joint2DToWorld3D(sf, sp, j);
      if (!W) continue;
      const Wp = { x: W.x, y: W.y, z: W.z };
      Wp[tDepth] = tz;
      const t2d = world3DToJoint2D(T, Tp, Wp);
      if (!t2d || !t2d.ok) continue;
      let existing = null;
      for (const tj of (Tp.joints || [])) {
        if (Math.hypot(tj.x - t2d.x, tj.y - t2d.y) < dedupRadius) { existing = tj; break; }
      }
      let target;
      if (existing) {
        target = existing;
        countJReused++;
      } else {
        target = { id: nextJointId++, x: t2d.x, y: t2d.y };
        if (!Array.isArray(Tp.joints)) Tp.joints = [];
        Tp.joints.push(target);
        countJ++;
      }
      idMap.set(j.id, target.id);
      if (typeof _autoBindGlobalForMappedJoint === "function") {
        _autoBindGlobalForMappedJoint(j, target, W, _bindOpts);
      }
    }
    for (const m of (sp.members || [])) {
      const t1 = idMap.get(m.j1);
      const t2 = idMap.get(m.j2);
      if (t1 == null || t2 == null || t1 === t2) continue;
      const exists = (Tp.members || []).some(mm =>
        (mm.j1 === t1 && mm.j2 === t2) || (mm.j1 === t2 && mm.j2 === t1));
      if (exists) continue;
      if (!Array.isArray(Tp.members)) Tp.members = [];
      Tp.members.push({ id: nextMemberId++, j1: t1, j2: t2 });
      countM++;
    }
    perTarget.push({ name: T.name, countJ, countJReused, countM });
    totalJ += countJ; totalJReused += countJReused; totalM += countM;
  }
  // 批次 infer 被動到的 globalJoints
  if (_touchedGids.size && typeof inferGlobalJoint === "function") {
    for (const gid of _touchedGids) {
      const g = findGlobalJointById(gid);
      if (g) inferGlobalJoint(g);
    }
  }
  console.log(`[複製到同平面頁] ${sf.name} → ${picks.length} 個目標・節點 +${totalJ}(沿用 ${totalJReused})・桿件 +${totalM}・gids ${_touchedGids.size}`, perTarget);
  refreshFileList && refreshFileList();
  refreshLists && refreshLists();
  render && render();
  hideBusy();
  $("hud").textContent = `複製完成:${sf.name} → ${picks.length} 個目標・節點 +${totalJ}(沿用 ${totalJReused})、桿件 +${totalM}`;
}

// 整理所有頁面 — 沿用 _consolidateInPlace(同 btnConsolidate),逐頁切換 active state 後執行
//   _consolidateInPlace 內部用 getPage() / jointById() 都依賴 state.activeFileId + state.pageIdx
//   async + showBusyWithCancel:逐頁 yield 一次讓 UI 有機會 paint,Esc / 取消按鈕中斷
export async function consolidateAllPagesWithConfirm(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  const skipPushUndo = !!opts.skipPushUndo;
  const titlePrefix = opts.titlePrefix || "整理所有頁面";
  if (!state.files.length) {
    if (!skipConfirm) alert("沒有可整理的檔案");
    return { tasks: 0, pagesTouched: 0, totalMerged: 0, totalDropped: 0, totalSplit: 0, cancelled: false };
  }
  // 預先收集要處理的頁面(只看有節點或桿件、且非 _orphan 的頁)
  const tasks = [];
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      if (!(pg.joints || []).length && !(pg.members || []).length) continue;
      tasks.push({ f, pg, key: +k });
    }
  }
  if (!tasks.length) {
    if (!skipConfirm) alert("沒有可整理的頁面(都沒有節點/桿件)");
    return { tasks: 0, pagesTouched: 0, totalMerged: 0, totalDropped: 0, totalSplit: 0, cancelled: false };
  }
  if (!skipConfirm && !confirm(`對 ${tasks.length} 個頁面跑「整理」?\n會合併同位置節點、刪重複桿件、共線中段拆段。\nCtrl+Z 可還原。\n處理時可從 spinner 上的「取消」按鈕或 Esc 中斷。`)) {
    return { tasks: tasks.length, pagesTouched: 0, totalMerged: 0, totalDropped: 0, totalSplit: 0, cancelled: true };
  }
  if (!skipPushUndo) pushUndo();
  const origFid = state.activeFileId, origPidx = state.pageIdx;
  let pagesTouched = 0, totalMerged = 0, totalDropped = 0, totalSplit = 0;
  const stats = [];
  let cancelled = false;
  const onEsc = (e) => {
    if (e.key === "Escape" && !cancelled) {
      e.preventDefault(); e.stopImmediatePropagation();
      cancelled = true;
      setBusyMessage("取消中…等當前頁處理完畢");
    }
  };
  document.addEventListener("keydown", onEsc, true);
  showBusyWithCancel(`${titlePrefix} 準備中…(共 ${tasks.length} 頁・Esc / 取消可中斷)`, () => {
    cancelled = true;
    setBusyMessage("取消中…等當前頁處理完畢");
  });
  await busyTick();
  let processed = 0;
  for (const t of tasks) {
    if (cancelled) break;
    processed++;
    setBusyMessage(`${titlePrefix} ${processed}/${tasks.length}・${t.f.name}・頁 ${t.key}`);
    await busyTick();
    if (cancelled) break;
    state.activeFileId = t.f.id;
    state.pageIdx = t.key;
    const r = _consolidateInPlace();
    if ((r.mergedJ + r.droppedM + r.splitM) > 0) {
      pagesTouched++;
      totalMerged += r.mergedJ;
      totalDropped += r.droppedM;
      totalSplit += r.splitM;
      stats.push({ file: t.f.name, page: t.key, ...r });
    }
  }
  // loop 過程切換了 activeFileId,bgWidth/bgHeight 與 bgSvg DOM 可能停留在最後一個檔案上;
  //   即使最終 activeFileId 還原成 origFid,DOM 仍對不上。用 activatePage 重新渲染原本那頁
  //   底圖(等同自動「底圖修復」),確保視覺一致且後續 undo / redo 行為正確
  const fileChanged = (state.activeFileId !== origFid || state.pageIdx !== origPidx);
  state.activeFileId = origFid;
  state.pageIdx = origPidx;
  document.removeEventListener("keydown", onEsc, true);
  hideBusy();
  if (fileChanged) {
    try { await activatePage(origFid, origPidx); }
    catch (e) { console.warn("[整理所有頁面] 重新渲染底圖失敗:", e); }
  }
  const cancelTag = cancelled ? `(已中斷;處理到第 ${processed}/${tasks.length} 頁)` : "";
  console.log(`[${titlePrefix}]${cancelTag} ${pagesTouched} 頁有變動・合併節點 ${totalMerged}・刪桿件 ${totalDropped}・拆段 ${totalSplit}`, stats);
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render && render();
  refreshLists && refreshLists();
  $("hud").textContent = `${titlePrefix}${cancelTag}:${pagesTouched} 頁有變動・合併節點 ${totalMerged}・刪桿件 ${totalDropped}・拆段 ${totalSplit}`;
  return { tasks: tasks.length, pagesTouched, totalMerged, totalDropped, totalSplit, cancelled };
}

// ---------- 檢查可延伸桿件:斷點偵測 ----------
// 對單一頁的每條桿件(端點 A、B),檢查是否有節點 J 落在延伸線上(段外),滿足:
//   - J 不是 A 或 B
//   - J 到 A-B 直線垂直距離 ≤ tolPerp
//   - J 在線段外(投影 t < 0 或 t > |AB|);線段內的別擔心,「整理」會拆段
//   - gap(從段端點到 J)≤ tolGap
//   - anchor → J 還沒有既存桿件
//   - **anchor 那端在延伸方向上沒有共線同向的桿件**(否則 anchor 已連到中段了,不該再跨過去延)
//   - **每側只報「離 anchor 最近」那個 target**(避免跨過中間 joint 一路延到遠處)
// 垂直桿件(|uy| > 0.95 → 偏離 Y 軸 ≤ ~18°)放寬 tolPerp / tolGap,因為:
//   - 柱子各樓層位置可能微微偏移,但仍是同一根柱
//   - 整根柱常被各樓層樓板節點切成短段,延伸距離本來就大
// 斜撐(diagonal)同樣放寬:平面圖斜撐端點常因角度微差 > 2mm 偏離柱中心,
//   gap 也常大於 50mm,沿用 horizontal 的緊容差幾乎都抓不到
function findExtendableMembersOnPage(file, page, opts) {
  opts = opts || {};
  const tolPerp = opts.tolPerp != null ? opts.tolPerp : 2.0;
  const tolPerpVert = opts.tolPerpVert != null ? opts.tolPerpVert : 5.0;
  // 斜撐(diagonal)放寬 perp / gap:斜線端點常因校準微差距離柱子節點 > 2mm,
  // 端點到柱子的 gap 也常比正交桿件大;若還是用 horizontal 的 2/50,XZ 平面斜撐幾乎抓不到
  const tolPerpDiag = opts.tolPerpDiag != null ? opts.tolPerpDiag : 8.0;
  const tolGap = opts.tolGap != null ? opts.tolGap : 50.0;
  const tolGapVert = opts.tolGapVert != null ? opts.tolGapVert : 200.0;
  const tolGapDiag = opts.tolGapDiag != null ? opts.tolGapDiag : 200.0;
  const vertThreshold = opts.vertThreshold != null ? opts.vertThreshold : 0.95;
  if (!page || !Array.isArray(page.members) || !Array.isArray(page.joints)) return [];
  const memberKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const existingPairs = new Set();
  for (const m of page.members) existingPairs.add(memberKey(m.j1, m.j2));
  const jointById = new Map();
  for (const j of page.joints) jointById.set(j.id, j);
  // 共線阻擋:回傳 true 表示 jointId 在方向 (dux, duy) 上已經有另一條同向 / 共線的 member
  //   (jointHasCollinearMemberInDirection 的可重入版本,接收 page 參數)
  const _hasCollinearOut = (excludeMemberId, jointId, dux, duy) => {
    const aJ = jointById.get(jointId);
    if (!aJ) return false;
    for (const mm of page.members) {
      if (mm.id === excludeMemberId) continue;
      let other = null;
      if (mm.j1 === jointId) other = jointById.get(mm.j2);
      else if (mm.j2 === jointId) other = jointById.get(mm.j1);
      if (!other) continue;
      const vx = other.x - aJ.x, vy = other.y - aJ.y;
      const vlen = Math.hypot(vx, vy);
      if (vlen < 1e-3) continue;
      const cross = Math.abs(vx * duy - vy * dux);   // 共線判定:垂直距離
      if (cross > 0.5) continue;
      const dot = vx * dux + vy * duy;                // 同向判定:點積為正
      if (dot > 1e-3) return true;
    }
    return false;
  };
  // 避免重複報告同一個 (anchor, target) 對 — 來自不同方向的兩條桿件可能都能延伸到 J
  const reportedAnchorTarget = new Set();
  const results = [];
  for (const m of page.members) {
    const A = jointById.get(m.j1);
    const B = jointById.get(m.j2);
    if (!A || !B) continue;
    const dx = B.x - A.x, dy = B.y - A.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-6) continue;
    const ux = dx / segLen, uy = dy / segLen;
    const isVertical = Math.abs(uy) > vertThreshold;
    const isHorizontal = Math.abs(ux) > vertThreshold;
    const isDiagonal = !isVertical && !isHorizontal;
    const useTolPerp = isVertical ? tolPerpVert : (isDiagonal ? tolPerpDiag : tolPerp);
    const useTolGap  = isVertical ? tolGapVert  : (isDiagonal ? tolGapDiag  : tolGap);
    // 先收所有共線 + 段外 joint,依「在 A 側 / B 側」分群並依 gap 排序
    const candA = [];   // t < 0,延伸方向 = -u(離開 A)
    const candB = [];   // t > segLen,延伸方向 = +u(離開 B)
    for (const J of page.joints) {
      if (J.id === m.j1 || J.id === m.j2) continue;
      const vx = J.x - A.x, vy = J.y - A.y;
      const t = vx * ux + vy * uy;
      const px = vx - t * ux, py = vy - t * uy;
      const perp = Math.hypot(px, py);
      if (perp > useTolPerp) continue;
      if (t < 0) candA.push({ J, gap: -t, perp });
      else if (t > segLen) candB.push({ J, gap: t - segLen, perp });
    }
    candA.sort((p, q) => p.gap - q.gap);
    candB.sort((p, q) => p.gap - q.gap);
    // 兩側各「只取最近一個」+ 方向阻擋檢查
    const sides = [
      { list: candA, extendFrom: "A", anchorId: m.j1, anchorJ: A, dux: -ux, duy: -uy },
      { list: candB, extendFrom: "B", anchorId: m.j2, anchorJ: B, dux:  ux, duy:  uy },
    ];
    for (const side of sides) {
      if (!side.list.length) continue;
      const best = side.list[0];
      if (best.gap > useTolGap) continue;
      if (existingPairs.has(memberKey(side.anchorId, best.J.id))) continue;
      // 方向阻擋:anchor 已在延伸方向有共線同向桿件 → 表示 anchor 已連到中段(或更遠),不該再跨過去延
      if (_hasCollinearOut(m.id, side.anchorId, side.dux, side.duy)) continue;
      const atKey = memberKey(side.anchorId, best.J.id);
      if (reportedAnchorTarget.has(atKey)) continue;
      reportedAnchorTarget.add(atKey);
      results.push({
        fileId: file.id, fileName: file.name,
        memberId: m.id, memberJ1: m.j1, memberJ2: m.j2,
        anchorJointId: side.anchorId, targetJointId: best.J.id,
        gap: best.gap, perpDist: best.perp, extendFrom: side.extendFrom,
        isVertical, isHorizontal,
        direction: isVertical ? "vertical" : (isHorizontal ? "horizontal" : "diagonal"),
        anchorX: side.anchorJ.x, anchorY: side.anchorJ.y,
        targetX: best.J.x, targetY: best.J.y,
        memberAx: A.x, memberAy: A.y, memberBx: B.x, memberBy: B.y,
        plane: page.plane || "?", pageZ: page.z != null ? page.z : 0,
      });
    }
  }
  return results;
}

// 掃描所有檔案 × 所有 page,把候選彙整在一起
//   排序:垂直(柱)先、水平次、斜線最後;同類別內 gap 小的先(便宜的修)
export function findAllExtendableMembers(opts) {
  const all = [];
  for (const f of state.files) {
    const pages = f.pages || {};
    for (const k of Object.keys(pages)) {
      const pg = pages[k];
      if (!pg || pg._orphan) continue;
      const cands = findExtendableMembersOnPage(f, pg, opts);
      for (const c of cands) {
        c.pageIdx = +k;
        all.push(c);
      }
    }
  }
  const dirRank = { vertical: 0, horizontal: 1, diagonal: 2 };
  all.sort((a, b) => {
    const da = dirRank[a.direction] ?? 3;
    const db = dirRank[b.direction] ?? 3;
    if (da !== db) return da - db;
    return a.gap - b.gap;
  });
  return all;
}

// 縮放主畫布到某個世界座標矩形(加邊距,讓使用者能看清楚周邊)
export function _zoomMainCanvasToRect(x1, y1, x2, y2, paddingFactor) {
  const r = wrap.getBoundingClientRect();
  const pad = paddingFactor != null ? paddingFactor : 0.5;   // 邊距 = 矩形短邊的一半
  const w = Math.max(1, Math.abs(x2 - x1));
  const h = Math.max(1, Math.abs(y2 - y1));
  const padX = w * pad, padY = h * pad;
  const minSide = Math.max(20, Math.min(w + 2 * padX, h + 2 * padY));   // 太小的矩形(同點 / 短桿)放大基準
  const tw = Math.max(w + 2 * padX, minSide);
  const th = Math.max(h + 2 * padY, minSide);
  const z = Math.min(r.width / tw, r.height / th);
  state.zoom = Math.max(0.0001, Math.min(50, z));
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  state.panX = r.width / 2 - cx * state.zoom;
  state.panY = r.height / 2 - cy * state.zoom;
  applyTransform();
  render();
}

// 把檔案底圖的指定世界座標區域畫到 canvas(類似 renderFileThumb 但用傳入的 region 取代 clipRect)
//   回傳 { sc, dx, dy, dw, dh, regionX, regionY }:可用 (wx - regionX) * sc + dx 把世界座標映射到 canvas 座標
//   供延伸檢查視窗的「放大預覽」用 — 在底圖上疊桿件 / 端點 / gap dashed 線
async function _renderFileRegion(canvas, file, region) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#0d0e10"; ctx.fillRect(0, 0, W, H);
  if (!file || !region || region.w <= 0 || region.h <= 0) return null;
  const loadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  // 路徑 1:cachedBgImg(光柵)— 用 source rect 裁切
  if (file.cachedBgImg) {
    const img = await loadImg(file.cachedBgImg);
    if (img && img.width && img.height) {
      const bgW = file.cachedBgWidth  || file.bgWidth  || img.width;
      const bgH = file.cachedBgHeight || file.bgHeight || img.height;
      let sx = region.x * img.width  / bgW;
      let sy = region.y * img.height / bgH;
      let sw = region.w * img.width  / bgW;
      let sh = region.h * img.height / bgH;
      // 邊界 clamp
      if (sx < 0) { sw += sx; sx = 0; }
      if (sy < 0) { sh += sy; sy = 0; }
      if (sx + sw > img.width)  sw = img.width  - sx;
      if (sy + sh > img.height) sh = img.height - sy;
      if (sw <= 0 || sh <= 0) return null;
      const sc = Math.min(W / region.w, H / region.h);
      const dw = region.w * sc, dh = region.h * sc;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      const invert = !file.bgImgDarkReady;
      ctx.save();
      if (invert) { try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {} }
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
      return { sc, dx, dy, dw, dh, regionX: region.x, regionY: region.y };
    }
  }
  // 路徑 2:cachedBgSvg(向量)— 改寫 viewBox 後 SVG → image
  if (file.cachedBgSvg) {
    let sized = file.cachedBgSvg;
    const vb = `${region.x} ${region.y} ${region.w} ${region.h}`;
    const aspect = region.w / region.h;
    let renderW = Math.min(1024, Math.max(W * 4, 256));
    let renderH = Math.round(renderW / aspect);
    if (renderH > 1024) { renderH = 1024; renderW = Math.round(renderH * aspect); }
    if (/<svg\b[^>]*\sviewBox=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)viewBox="[^"]*"/, `$1viewBox="${vb}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg viewBox="${vb}"`);
    }
    if (/<svg\b[^>]*\swidth=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${renderW}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg width="${renderW}"`);
    }
    if (/<svg\b[^>]*\sheight=/.test(sized)) {
      sized = sized.replace(/(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${renderH}"`);
    } else {
      sized = sized.replace(/<svg\b/, `<svg height="${renderH}"`);
    }
    sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
      const cleaned = style
        .replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
        .replace(/;{2,}/g, ";").replace(/^;|;$/g, "").trim();
      return cleaned ? `${head} style="${cleaned}"` : head;
    });
    const blob = new Blob([sized], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      if (img && img.width && img.height) {
        const sc = Math.min(W / img.width, H / img.height);
        const dw = img.width * sc, dh = img.height * sc;
        const dx = (W - dw) / 2, dy = (H - dh) / 2;
        ctx.save();
        try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
        // SVG 透過 viewBox 把整個 region 對應到整張圖,所以 effective sc = dw / region.w
        return { sc: dw / region.w, dx, dy, dw, dh, regionX: region.x, regionY: region.y };
      }
    } finally { URL.revokeObjectURL(url); }
  }
  // 沒有可用底圖快取:畫個底色 + 檔名
  ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("(無底圖快取)", W / 2, H / 2);
  return null;
}

// 把延伸檢查的標記畫到放大預覽 canvas:桿件實線 / gap 黃虛線 / 兩端圓點 + 點 / 桿件 ID 標號
//   也把同區域內「其他 joints / members」用淺灰色畫出,方便看清楚周邊環境
function _drawExtensionMarkers(canvas, transform, candidate, file, page) {
  if (!canvas || !transform || !candidate) return;
  const ctx = canvas.getContext("2d");
  const wxToCanvas = (wx) => transform.dx + (wx - transform.regionX) * transform.sc;
  const wyToCanvas = (wy) => transform.dy + (wy - transform.regionY) * transform.sc;
  // 區域(由 transform 推回 region;dw / sc = region.w)
  const regionX0 = transform.regionX, regionY0 = transform.regionY;
  const regionX1 = regionX0 + transform.dw / transform.sc;
  const regionY1 = regionY0 + transform.dh / transform.sc;
  const inRange = (x, y) => x >= regionX0 && x <= regionX1 && y >= regionY0 && y <= regionY1;
  ctx.save();
  // ---- 周邊環境:其他 members(亮一點的灰細線,黑底上要看得到)----
  let jointById = null;
  if (page && Array.isArray(page.members)) {
    jointById = new Map();
    for (const j of (page.joints || [])) jointById.set(j.id, j);
    ctx.strokeStyle = "rgba(200, 200, 200, 0.7)";
    ctx.lineWidth = 1.4;
    for (const m of page.members) {
      if (m.id === candidate.memberId) continue;   // 候選主桿件下面單獨亮畫
      const a = jointById.get(m.j1), b = jointById.get(m.j2);
      if (!a || !b) continue;
      if (!inRange(a.x, a.y) && !inRange(b.x, b.y)) continue;   // 兩端都在範圍外則略過
      ctx.beginPath();
      ctx.moveTo(wxToCanvas(a.x), wyToCanvas(a.y));
      ctx.lineTo(wxToCanvas(b.x), wyToCanvas(b.y));
      ctx.stroke();
    }
  }
  // ---- 候選主桿件:藍色實線(加粗對比) ----
  ctx.strokeStyle = "#4f9dff"; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(wxToCanvas(candidate.memberAx), wyToCanvas(candidate.memberAy));
  ctx.lineTo(wxToCanvas(candidate.memberBx), wyToCanvas(candidate.memberBy));
  ctx.stroke();
  // ---- gap(anchor → target):黃色虛線(加粗) ----
  ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 4]);
  ctx.beginPath();
  ctx.moveTo(wxToCanvas(candidate.anchorX), wyToCanvas(candidate.anchorY));
  ctx.lineTo(wxToCanvas(candidate.targetX), wyToCanvas(candidate.targetY));
  ctx.stroke();
  ctx.setLineDash([]);
  // ---- 其他 joints:亮一點的灰色點 + ID ----
  ctx.font = "10px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
  ctx.textBaseline = "middle";
  if (page && Array.isArray(page.joints)) {
    for (const j of page.joints) {
      if (!inRange(j.x, j.y)) continue;
      if (j.id === candidate.anchorJointId || j.id === candidate.targetJointId
          || j.id === candidate.memberJ1 || j.id === candidate.memberJ2) continue;   // 重點端點下面單獨畫
      const cx = wxToCanvas(j.x), cy = wyToCanvas(j.y);
      ctx.fillStyle = "#bbb";
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ccc";
      ctx.textAlign = "left";
      ctx.fillText(String((typeof displayJointId === "function") ? displayJointId(j) : j.id), cx + 5, cy - 8);
    }
  }
  // ---- 候選桿件的另一端(非 anchor 那端):藍色端點 + 標號(候選桿件本體的兩端之一)----
  if (page && Array.isArray(page.joints) && jointById) {
    const otherEndId = candidate.extendFrom === "A" ? candidate.memberJ2 : candidate.memberJ1;
    const oj = jointById.get(otherEndId);
    if (oj) {
      const cx = wxToCanvas(oj.x), cy = wyToCanvas(oj.y);
      ctx.fillStyle = "#4f9dff";
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
      const lbl = String((typeof displayJointId === "function") ? displayJointId(oj) : oj.id);
      const tw = ctx.measureText(lbl).width;
      const lx = cx + 7, ly = cy - 9;
      ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
      ctx.fillRect(lx - 2, ly - 7, tw + 4, 13);
      ctx.fillStyle = "#9bb6e8";
      ctx.textAlign = "left";
      ctx.fillText(lbl, lx, ly);
    }
  }
  // ---- anchor / target 標號:沿 gap 方向往「外」散開,避免兩端 ID 在小 gap 時黏在一起 ----
  //   - anchor 標號朝「遠離 target」的方向放
  //   - target 標號朝「遠離 anchor」的方向放
  //   - 兩端在 canvas 上太接近時退而用固定對角偏移
  const acx = wxToCanvas(candidate.anchorX), acy = wyToCanvas(candidate.anchorY);
  const tcx = wxToCanvas(candidate.targetX), tcy = wyToCanvas(candidate.targetY);
  const labelOffsetPx = 18;
  let aOffX, aOffY, tOffX, tOffY;
  {
    const dxc = acx - tcx, dyc = acy - tcy;
    const lenc = Math.hypot(dxc, dyc);
    if (lenc > 1) {
      // anchor 朝「遠離 target」(dxc, dyc 是 anchor - target)
      aOffX =  dxc / lenc * labelOffsetPx;
      aOffY =  dyc / lenc * labelOffsetPx;
      tOffX = -aOffX;
      tOffY = -aOffY;
    } else {
      // 兩端在像素上完全重疊 → 固定對角分散
      aOffX = -16; aOffY = -10;
      tOffX =  14; tOffY =  10;
    }
  }
  // ---- anchor 端點:綠色實心圓 + 綠色 ID(偏向遠離 target 那側)----
  {
    ctx.fillStyle = "#44dd66";
    ctx.beginPath(); ctx.arc(acx, acy, 5.5, 0, Math.PI * 2); ctx.fill();
    let lbl = String(candidate.anchorJointId);
    if (jointById) {
      const aj = jointById.get(candidate.anchorJointId);
      if (aj && typeof displayJointId === "function") lbl = String(displayJointId(aj));
    }
    // 文字加深色背景,避免跟桿件線 / 其他線疊在一起看不到
    const tw = ctx.measureText(lbl).width;
    const lx = acx + aOffX, ly = acy + aOffY;
    ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
    ctx.fillRect(lx - 2, ly - 7, tw + 4, 13);
    ctx.fillStyle = "#7ef0a0";
    ctx.textAlign = "left";
    ctx.fillText(lbl, lx, ly);
  }
  // ---- target 端點:紅色實心圓 + 白色外圈 + 紅色 ID(偏向遠離 anchor 那側)----
  {
    ctx.fillStyle = "#ff4444";
    ctx.beginPath(); ctx.arc(tcx, tcy, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(tcx, tcy, 8.5, 0, Math.PI * 2); ctx.stroke();
    let lbl = String(candidate.targetJointId);
    if (jointById) {
      const tj = jointById.get(candidate.targetJointId);
      if (tj && typeof displayJointId === "function") lbl = String(displayJointId(tj));
    }
    const tw = ctx.measureText(lbl).width;
    const lx = tcx + tOffX, ly = tcy + tOffY;
    ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
    ctx.fillRect(lx - 2, ly - 7, tw + 4, 13);
    ctx.fillStyle = "#ff8888";
    ctx.textAlign = "left";
    ctx.fillText(lbl, lx, ly);
  }
  // ---- 候選桿件 ID:畫在桿件中點(藍色)----
  {
    const mx = (candidate.memberAx + candidate.memberBx) / 2;
    const my = (candidate.memberAy + candidate.memberBy) / 2;
    const cx = wxToCanvas(mx), cy = wyToCanvas(my);
    const mLbl = (typeof displayMemberId === "function")
      ? String(displayMemberId({ id: candidate.memberId, j1: candidate.memberJ1, j2: candidate.memberJ2 }))
      : `M${candidate.memberId}`;
    // 在白底矩形上畫,避免跟桿件線重疊看不清
    ctx.font = "11px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
    const tw = ctx.measureText(mLbl).width;
    ctx.fillStyle = "rgba(15, 17, 22, 0.85)";
    ctx.fillRect(cx + 4, cy - 6, tw + 6, 14);
    ctx.fillStyle = "#4f9dff";
    ctx.textAlign = "left";
    ctx.fillText(mLbl, cx + 7, cy);
  }
  ctx.restore();
}

// 在縮圖 canvas 上疊加目前主畫布視窗位置的黃框
//   - canvas:已被 renderFileThumb 畫過底圖的縮圖 canvas
//   - file:對應的檔案(用來算 bg 顯示範圍)
async function _drawThumbViewportBox(canvas, file) {
  if (!canvas || !file) return;
  const ctx = canvas.getContext("2d");
  const wrapRect = wrap.getBoundingClientRect();
  // 主畫布目前的世界座標可見範圍
  const viewLeft = -state.panX / state.zoom;
  const viewTop  = -state.panY / state.zoom;
  const viewW = wrapRect.width / state.zoom;
  const viewH = wrapRect.height / state.zoom;
  // 縮圖內 bg 的 fit 範圍(對齊 renderFileThumb 的計算)
  const cr = file.clipRect;
  const bgX = cr ? cr.x : 0;
  const bgY = cr ? cr.y : 0;
  const bgW = cr ? cr.w : (file.bgWidth || state.bgWidth || 1200);
  const bgH = cr ? cr.h : (file.bgHeight || state.bgHeight || 800);
  if (bgW <= 0 || bgH <= 0) return;
  const sc = Math.min(canvas.width / bgW, canvas.height / bgH);
  const dw = bgW * sc, dh = bgH * sc;
  const dxOff = (canvas.width - dw) / 2, dyOff = (canvas.height - dh) / 2;
  const tx = dxOff + (viewLeft - bgX) * sc;
  const ty = dyOff + (viewTop  - bgY) * sc;
  const tw = viewW * sc, th = viewH * sc;
  ctx.save();
  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(tx, ty, tw, th);
  ctx.restore();
}

// 對單一候選執行延伸動作 — 完全比照「選取模式・桿件兩端 / 單端延伸」(extendSelectedMembersToIntersect)
//   對「延伸到既有 joint」的處理方式:
//     1. 把原桿件 anchor 端的 joint reference 改指到 target
//     2. 若原 anchor joint 沒被其他 member 引用了(變孤立)→ 從 page.joints 移除 + 解綁 globalId
//   pushUndo 由呼叫端控制(允許單條 / 批次的 undo group 不同)
function _applyMemberExtension(c) {
  const f = state.files.find(x => x.id === c.fileId);
  if (!f) return false;
  const pg = f.pages && f.pages[c.pageIdx];
  if (!pg || !Array.isArray(pg.members) || !Array.isArray(pg.joints)) return false;
  const m = pg.members.find(x => x.id === c.memberId);
  if (!m) return false;
  // 同位防呆:可能前一條候選已經把這支桿件動過,端點已經變了 → 偵測時的 anchor 不再對得上
  //   (e.g., 兩條共線的候選互相影響;碰到這情況直接跳過,讓使用者重跑檢查就好)
  let oldEndpointId;
  if (c.extendFrom === "A") {
    if (m.j1 !== c.anchorJointId) return false;
    if (m.j2 === c.targetJointId) return false;       // 改完會變零長,放棄
    oldEndpointId = m.j1;
    m.j1 = c.targetJointId;
  } else {
    if (m.j2 !== c.anchorJointId) return false;
    if (m.j1 === c.targetJointId) return false;
    oldEndpointId = m.j2;
    m.j2 = c.targetJointId;
  }
  // 清掉「原端點變孤立」的 joint — 對齊 extendSelectedMembersToIntersect 對既有 joint 的處理
  //   只清因延伸而換掉、且現在沒被任何 member 引用的
  const stillUsed = pg.members.some(mm => mm.j1 === oldEndpointId || mm.j2 === oldEndpointId);
  if (!stillUsed) {
    const orphan = pg.joints.find(j => j.id === oldEndpointId);
    if (orphan && orphan.globalId != null && typeof unbindJointFromGlobal === "function") {
      try { unbindJointFromGlobal(orphan); } catch (_) {}
    }
    pg.joints = pg.joints.filter(j => j.id !== oldEndpointId);
  }
  return true;
}

// 主入口:檢查所有頁面,跳出逐條檢視視窗
//   先跑「整理所有頁面」把同位節點 / 重複桿件 / 共線中段拆段先收乾淨,再做延伸檢查,
//   避免一堆假候選(因為斷點其實是中段節點切出來的)
export async function startExtendableMemberCheck() {
  if (!state.files.length) { alert("沒有可檢查的檔案"); return; }
  // 先 pushUndo 一次,涵蓋「整理 + 後續延伸動作」 — 整體可一鍵 Ctrl+Z 退回掃描前狀態
  pushUndo();
  const consolidateResult = await consolidateAllPagesWithConfirm({
    skipConfirm: true,
    skipPushUndo: true,
    titlePrefix: "整理所有頁面(延伸檢查前)",
  });
  if (consolidateResult && consolidateResult.cancelled) {
    $("hud").textContent = "延伸檢查取消(整理階段中斷)";
    return;
  }
  showBusy("掃描可延伸桿件…");
  await busyTick();
  let candidates = [];
  try { candidates = findAllExtendableMembers({}); }
  finally { hideBusy(); }
  if (!candidates.length) {
    alert(`沒有找到可延伸桿件 — 模型已經很乾淨 🎉\n(整理階段:合併 ${consolidateResult.totalMerged}・刪桿件 ${consolidateResult.totalDropped}・拆段 ${consolidateResult.totalSplit})`);
    return;
  }
  openMemberExtensionCheckDialog(candidates);
}

// 主入口(當頁):只掃描目前 active 頁,跳出逐條檢視視窗
//   先在當頁跑「整理」(_consolidateInPlace)清掉同位節點 / 重複桿件 / 中段拆段,
//   再做延伸檢查,避免假候選
async function startExtendableMemberCheckCurrentPage() {
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  if (!af) { alert("尚未選擇檔案"); return; }
  const pg = af.pages && af.pages[state.pageIdx];
  if (!pg) { alert("當前頁不存在"); return; }
  // pushUndo + 整理(整體可一鍵 Ctrl+Z 退回掃描前狀態)
  pushUndo();
  // 整理階段 pending — _consolidateInPlace 同步阻塞,先 showBusy + busyTick 讓 spinner 先 paint
  showBusy(`整理當頁中(延伸檢查前)・${af.name}・第 ${state.pageIdx + 1} 頁…`);
  await busyTick();
  let cr = { mergedJ: 0, droppedM: 0, splitM: 0 };
  try {
    if (typeof _consolidateInPlace === "function") cr = _consolidateInPlace();
  } finally {
    hideBusy();
  }
  if ((cr.mergedJ + cr.droppedM + cr.splitM) > 0) {
    console.log(`[整理(延伸檢查前)] 當頁:合併 ${cr.mergedJ} ・ 移除桿件 ${cr.droppedM} ・ 新拆桿件 ${cr.splitM}`);
    refreshLists && refreshLists();
    render && render();
  }
  showBusy("掃描當頁可延伸桿件…");
  await busyTick();
  let cands = [];
  try { cands = findExtendableMembersOnPage(af, pg, {}); }
  finally { hideBusy(); }
  // 補齊 pageIdx + 依方向 / gap 排序,讓 dialog 行為跟全頁面版一致
  for (const c of cands) c.pageIdx = state.pageIdx;
  const dirRank = { vertical: 0, horizontal: 1, diagonal: 2 };
  cands.sort((a, b) => {
    const da = dirRank[a.direction] ?? 3;
    const db = dirRank[b.direction] ?? 3;
    if (da !== db) return da - db;
    return a.gap - b.gap;
  });
  if (!cands.length) {
    const crTag = (cr.mergedJ + cr.droppedM + cr.splitM) > 0
      ? `\n(整理階段:合併 ${cr.mergedJ}・刪桿件 ${cr.droppedM}・拆段 ${cr.splitM})`
      : "";
    alert(`當前頁(${af.name}・第 ${state.pageIdx + 1} 頁)沒有可延伸桿件 — 已經很乾淨 🎉${crTag}`);
    return;
  }
  openMemberExtensionCheckDialog(cands);
}

// 逐條檢視「視窗」:獨立 browser popup;左 = 縮圖 + 視窗黃框、右 = 候選資訊 + 動作鈕
function openMemberExtensionCheckDialog(candidates) {
  // 過濾、處理過的記錄
  const remaining = candidates.slice();
  let currentIndex = 0;
  let extended = 0, skipped = 0;
  const initialTotal = remaining.length;
  // 動作歷史:供 Cmd+Z 回退使用 — [{ idx, action: "extend" | "skip" }]
  //   - "extend" 對應到一次 pushUndo,Cmd+Z 跑 main window 的 undo() + dialog index 回退
  //   - "skip" 沒 pushUndo → 只回退 dialog index 不跑 undo(否則會撤掉之前的 extend)
  const actionHistory = [];
  // 打開獨立的 browser popup window;被擋住 → alert 提示
  const popupFeatures = "popup=yes,width=960,height=820,scrollbars=no,resizable=yes";
  const win = window.open("", "STAAD_ExtendCheck_" + Date.now(), popupFeatures);
  if (!win) {
    alert("彈出視窗被瀏覽器擋住了。請允許這個網站開啟彈窗,再試一次。");
    return;
  }
  win.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head>
<title>檢查可延伸桿件 - STAAD</title>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; background: #0a0b0d; color: #ddd;
         font-family: -apple-system, system-ui, "Microsoft JhengHei", sans-serif;
         overflow: hidden; user-select: none; }
  button { padding: 5px 12px; font-size: 12px; background: #2a2c30;
           border: 1px solid #444; color: #ddd; border-radius: 3px;
           cursor: pointer; font-family: inherit; }
  button:hover { background: #33363a; }
  button.primary { background: #4f9dff; border-color: #4f9dff; color: #fff; }
  button.danger { background: #2a1a1a; border-color: #a04040; color: #ff8888; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
</style></head><body></body></html>`);
  win.document.close();
  const pdoc = win.document;
  // card = 整個 popup body 內容容器
  const card = pdoc.createElement("div");
  Object.assign(card.style, {
    background: "#1c1d20", color: "#ddd",
    width: "100%", height: "100vh",
    display: "flex", flexDirection: "column", overflow: "hidden",
  });
  pdoc.body.appendChild(card);
  // 標題列
  const titleBar = pdoc.createElement("div");
  Object.assign(titleBar.style, {
    padding: "8px 12px", borderBottom: "1px solid #333",
    display: "flex", alignItems: "center", justifyContent: "space-between",
    background: "#222428", flexShrink: "0",
  });
  const titleText = pdoc.createElement("div");
  titleText.style.fontWeight = "700";
  titleText.style.fontSize = "13px";
  titleText.style.color = "#9bb6e8";
  titleBar.appendChild(titleText);
  const closeBtn = pdoc.createElement("button");
  closeBtn.textContent = "✕";
  Object.assign(closeBtn.style, {
    background: "transparent", border: "none", color: "#999",
    cursor: "pointer", fontSize: "16px", padding: "0 4px",
  });
  closeBtn.onmouseenter = () => closeBtn.style.color = "#fff";
  closeBtn.onmouseleave = () => closeBtn.style.color = "#999";
  closeBtn.onclick = () => closeDialog();
  titleBar.appendChild(closeBtn);
  card.appendChild(titleBar);
  // 主內容
  const body = pdoc.createElement("div");
  Object.assign(body.style, {
    display: "flex", gap: "12px", padding: "12px", flex: "1", minHeight: "0",
    overflowY: "auto",
  });
  card.appendChild(body);
  // 左:預覽區(垂直堆疊兩個 canvas:放大預覽 + 整頁縮圖小地圖)
  const previewCol = pdoc.createElement("div");
  Object.assign(previewCol.style, {
    flexShrink: "0", display: "flex", flexDirection: "column", gap: "8px",
  });
  body.appendChild(previewCol);
  // 放大預覽 — 桿件 + 斷結處放大,標示桿件實線 + gap 黃虛線 + 兩端圓點
  const zoomLabel = pdoc.createElement("div");
  zoomLabel.textContent = "放大預覽(桿件 / 斷結處)";
  Object.assign(zoomLabel.style, { fontSize: "10px", color: "#9aa0a6" });
  previewCol.appendChild(zoomLabel);
  const zoomCanvas = pdoc.createElement("canvas");
  zoomCanvas.width = 420; zoomCanvas.height = 280;
  Object.assign(zoomCanvas.style, {
    background: "#0d0e10", border: "1px solid #333", display: "block",
  });
  previewCol.appendChild(zoomCanvas);
  // 色彩 legend:用 HTML 直接寫,跟 _drawExtensionMarkers 的色碼對應
  const legend = pdoc.createElement("div");
  Object.assign(legend.style, {
    fontSize: "10px", color: "#aaa", display: "flex", flexWrap: "wrap",
    gap: "8px 12px", lineHeight: "1.4", padding: "4px 2px",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  });
  legend.innerHTML =
    `<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#44dd66;vertical-align:-1px;margin-right:3px"></span>anchor(改 j1/j2 的端)</span>` +
    `<span><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:#ff4444;border:1.5px solid #fff;vertical-align:-2px;margin-right:3px"></span>target(該連到這)</span>` +
    `<span><span style="display:inline-block;width:14px;height:0;border-top:2px dashed #ffd23f;vertical-align:3px;margin-right:3px"></span>gap(要補的段)</span>` +
    `<span><span style="display:inline-block;width:14px;height:0;border-top:2px solid #4f9dff;vertical-align:3px;margin-right:3px"></span>候選桿件</span>` +
    `<span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#4f9dff;vertical-align:-1px;margin-right:3px"></span>桿件另一端</span>` +
    `<span><span style="display:inline-block;width:14px;height:0;border-top:1px solid rgba(160,160,160,0.6);vertical-align:3px;margin-right:3px"></span>周邊環境</span>`;
  previewCol.appendChild(legend);
  // 整頁縮圖 — 黃框標示放大區域位置
  const thumbLabel = pdoc.createElement("div");
  thumbLabel.textContent = "整頁縮圖(黃框=放大區域 · 滾輪縮放 / 拖曳平移 · 雙擊重置)";
  Object.assign(thumbLabel.style, { fontSize: "10px", color: "#9aa0a6", marginTop: "4px" });
  previewCol.appendChild(thumbLabel);
  const thumbCanvas = pdoc.createElement("canvas");
  thumbCanvas.width = 420; thumbCanvas.height = 360;
  Object.assign(thumbCanvas.style, {
    background: "#0d0e10", border: "1px solid #333", display: "block", cursor: "grab",
  });
  thumbCanvas.title = "滾輪縮放 / 拖曳平移 / 雙擊重置";
  previewCol.appendChild(thumbCanvas);
  // ---- 整頁縮圖:滾輪縮放 + 拖曳平移(對齊切面選擇視窗的 preview)----
  //   thumbState:本次顯示的 zoom / pan;切候選時若是新檔會 reset
  //   cachedThumbImg:已載入的 bg image + 來源裁切矩形(clipRect 或全頁),避免每次重畫都重新載
  const thumbState = { zoom: 1, offsetX: 0, offsetY: 0 };
  let cachedThumbImg = { fid: null, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };
  const _thumbLoadImg = (src) => new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  const drawThumbWithZoom = () => {
    const ctx = thumbCanvas.getContext("2d");
    ctx.fillStyle = "#0d0e10";
    ctx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
    const cached = cachedThumbImg;
    if (!cached || !cached.img || cached.srcW <= 0 || cached.srcH <= 0) {
      const f = state.files.find(x => x.id === (remaining[currentIndex] && remaining[currentIndex].fileId));
      ctx.fillStyle = "#7b818a"; ctx.font = "10px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText((f && f.name) || "—", thumbCanvas.width / 2, thumbCanvas.height / 2);
      return;
    }
    // bg image fit + zoom
    const fit = Math.min(thumbCanvas.width / cached.srcW, thumbCanvas.height / cached.srcH);
    const sc = fit * thumbState.zoom;
    const w = cached.srcW * sc, h = cached.srcH * sc;
    const x = (thumbCanvas.width  - w) / 2 + thumbState.offsetX;
    const y = (thumbCanvas.height - h) / 2 + thumbState.offsetY;
    if (cached.invert) {
      ctx.save();
      try { ctx.filter = "invert(1) hue-rotate(180deg)"; } catch (_) {}
      ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(cached.img, cached.srcX, cached.srcY, cached.srcW, cached.srcH, x, y, w, h);
    }
    // ---- 黃色虛線框:標示主畫布目前視窗在 bg 上的位置(跟著 zoom / pan 一起變換)----
    const f = state.files.find(x => x.id === (remaining[currentIndex] && remaining[currentIndex].fileId));
    if (f) {
      const wrapRect = wrap.getBoundingClientRect();
      const viewLeft = -state.panX / state.zoom;
      const viewTop  = -state.panY / state.zoom;
      const viewW = wrapRect.width / state.zoom;
      const viewH = wrapRect.height / state.zoom;
      // bg 在 cached image 內的對應範圍:用 clipRect(若有)或整頁,跟載入時計算一致
      const cr = f.clipRect;
      const bgX = cr ? cr.x : 0;
      const bgY = cr ? cr.y : 0;
      const bgW = cr ? cr.w : (f.bgWidth || state.bgWidth || 1200);
      const bgH = cr ? cr.h : (f.bgHeight || state.bgHeight || 800);
      if (bgW > 0 && bgH > 0) {
        // 把世界座標(viewLeft..+viewW, viewTop..+viewH)映射到 canvas 座標 = (x, y) 加上 (worldRel * sc)
        //   worldRel = (世界 - bgOrigin) / bgSize * srcSize(因為 cached.src* = bg 在 image 內的 sub-rect)
        const wxToCanvas = (wx) => x + ((wx - bgX) / bgW) * w;
        const wyToCanvas = (wy) => y + ((wy - bgY) / bgH) * h;
        const bx1 = wxToCanvas(viewLeft);
        const by1 = wyToCanvas(viewTop);
        const bx2 = wxToCanvas(viewLeft + viewW);
        const by2 = wyToCanvas(viewTop + viewH);
        ctx.save();
        ctx.strokeStyle = "#ffd23f";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(bx1, by1, bx2 - bx1, by2 - by1);
        ctx.restore();
      }
    }
  };
  // 載入該檔的 bg image 進 cachedThumbImg(裁切到 clipRect),只在新檔切到時跑
  const loadThumbBg = async (file) => {
    if (!file) return;
    if (cachedThumbImg.fid === file.id && cachedThumbImg.img) return;  // 已快取同檔
    cachedThumbImg = { fid: file.id, img: null, invert: false, srcX: 0, srcY: 0, srcW: 0, srcH: 0 };
    const bgW = file.cachedBgWidth  || file.bgWidth  || state.bgWidth  || 1200;
    const bgH = file.cachedBgHeight || file.bgHeight || state.bgHeight || 800;
    const clip = file.clipRect ? { x: file.clipRect.x, y: file.clipRect.y, w: file.clipRect.w, h: file.clipRect.h }
                               : { x: 0, y: 0, w: bgW, h: bgH };
    if (file.cachedBgImg) {
      const img = await _thumbLoadImg(file.cachedBgImg);
      if (img && cachedThumbImg.fid === file.id) {
        // src 矩形 = clipRect 換算到 image 像素座標
        const sx = Math.max(0, clip.x * img.width  / bgW);
        const sy = Math.max(0, clip.y * img.height / bgH);
        const sw = Math.min(img.width  - sx, clip.w * img.width  / bgW);
        const sh = Math.min(img.height - sy, clip.h * img.height / bgH);
        cachedThumbImg.img = img;
        cachedThumbImg.invert = !file.bgImgDarkReady;
        cachedThumbImg.srcX = sx; cachedThumbImg.srcY = sy;
        cachedThumbImg.srcW = sw > 0 ? sw : img.width;
        cachedThumbImg.srcH = sh > 0 ? sh : img.height;
      }
    } else if (file.cachedBgSvg) {
      // 改寫 viewBox 重新渲染 SVG → image(裁切到 clip)
      let sized = file.cachedBgSvg;
      const vb = `${clip.x} ${clip.y} ${clip.w} ${clip.h}`;
      const aspect = (clip.w > 0 && clip.h > 0) ? clip.w / clip.h : 1;
      let renderW = Math.min(1024, Math.max(thumbCanvas.width * 3, 512));
      let renderH = Math.round(renderW / aspect);
      if (renderH > 1024) { renderH = 1024; renderW = Math.round(renderH * aspect); }
      const setOrAdd = (re, attr, val) => {
        if (re.test(sized)) sized = sized.replace(new RegExp(`(<svg\\b[^>]*?\\s)${attr}="[^"]*"`), `$1${attr}="${val}"`);
        else sized = sized.replace(/<svg\b/, `<svg ${attr}="${val}"`);
      };
      setOrAdd(/<svg\b[^>]*\sviewBox=/, "viewBox", vb);
      setOrAdd(/<svg\b[^>]*\swidth=/, "width", renderW);
      setOrAdd(/<svg\b[^>]*\sheight=/, "height", renderH);
      sized = sized.replace(/(<svg\b[^>]*?)\sstyle="([^"]*)"/, (_, head, style) => {
        const cleaned = style.replace(/(?:^|;)\s*(width|height|clip-path|position|top|left|right|bottom)\s*:[^;]*;?/gi, ";")
          .replace(/;{2,}/g, ";").replace(/^;|;$/g, "").trim();
        return cleaned ? `${head} style="${cleaned}"` : head;
      });
      const blob = new Blob([sized], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      try {
        const img = await _thumbLoadImg(url);
        if (img && cachedThumbImg.fid === file.id) {
          cachedThumbImg.img = img;
          cachedThumbImg.invert = true;
          cachedThumbImg.srcX = 0; cachedThumbImg.srcY = 0;
          cachedThumbImg.srcW = img.width; cachedThumbImg.srcH = img.height;
        }
      } finally { URL.revokeObjectURL(url); }
    }
  };
  // ---- 滾輪縮放:以游標位置為 anchor,範圍 [0.2x, 20x](對齊切面 preview)----
  thumbCanvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (!cachedThumbImg.img) return;
    const rect = thumbCanvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * (thumbCanvas.width  / rect.width);
    const sy = (ev.clientY - rect.top)  * (thumbCanvas.height / rect.height);
    const cx = thumbCanvas.width / 2, cy = thumbCanvas.height / 2;
    const oldZoom = thumbState.zoom;
    const factor = Math.exp(-ev.deltaY * 0.0015);
    const newZoom = Math.max(0.2, Math.min(20, oldZoom * factor));
    if (newZoom === oldZoom) return;
    thumbState.offsetX = sx - cx - (newZoom / oldZoom) * (sx - cx - thumbState.offsetX);
    thumbState.offsetY = sy - cy - (newZoom / oldZoom) * (sy - cy - thumbState.offsetY);
    thumbState.zoom = newZoom;
    drawThumbWithZoom();
  }, { passive: false });
  // ---- 拖曳平移 ----
  let _thumbPanDrag = null;
  thumbCanvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (!cachedThumbImg.img) return;
    _thumbPanDrag = { startX: ev.clientX, startY: ev.clientY, startOffsetX: thumbState.offsetX, startOffsetY: thumbState.offsetY };
    thumbCanvas.style.cursor = "grabbing";
    ev.preventDefault();
  });
  const _onThumbPanMove = (ev) => {
    if (!_thumbPanDrag) return;
    const rect = thumbCanvas.getBoundingClientRect();
    const sx = thumbCanvas.width  / rect.width;
    const sy = thumbCanvas.height / rect.height;
    thumbState.offsetX = _thumbPanDrag.startOffsetX + (ev.clientX - _thumbPanDrag.startX) * sx;
    thumbState.offsetY = _thumbPanDrag.startOffsetY + (ev.clientY - _thumbPanDrag.startY) * sy;
    drawThumbWithZoom();
  };
  const _onThumbPanUp = () => {
    if (!_thumbPanDrag) return;
    _thumbPanDrag = null;
    thumbCanvas.style.cursor = cachedThumbImg.img ? "grab" : "default";
  };
  win.addEventListener("mousemove", _onThumbPanMove);
  win.addEventListener("mouseup", _onThumbPanUp);
  // ---- 雙擊:重置 zoom / pan ----
  thumbCanvas.addEventListener("dblclick", () => {
    thumbState.zoom = 1; thumbState.offsetX = 0; thumbState.offsetY = 0;
    drawThumbWithZoom();
  });
  // 右:資訊
  const info = pdoc.createElement("div");
  Object.assign(info.style, {
    flex: "1", minWidth: "0", fontSize: "12px", lineHeight: "1.7",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    overflowY: "auto",
  });
  body.appendChild(info);
  // 動作按鈕列
  const actions = pdoc.createElement("div");
  Object.assign(actions.style, {
    padding: "8px 12px", borderTop: "1px solid #333",
    display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center",
    background: "#1a1b1e", flexShrink: "0",
  });
  card.appendChild(actions);
  const mkBtn = (label, onClick, opts) => {
    const b = pdoc.createElement("button");
    b.textContent = label;
    Object.assign(b.style, {
      padding: "5px 12px", fontSize: "12px",
      background: opts && opts.primary ? "#4f9dff" : "#2a2c30",
      border: "1px solid " + (opts && opts.primary ? "#4f9dff" : "#444"),
      color: opts && opts.primary ? "#fff" : "#ddd",
      borderRadius: "3px", cursor: "pointer",
    });
    if (opts && opts.danger) {
      b.style.background = "#2a1a1a";
      b.style.borderColor = "#a04040";
      b.style.color = "#ff8888";
    }
    b.onclick = onClick;
    return b;
  };
  const btnPrev = mkBtn("← 上一條", () => navigate(-1));
  const btnNext = mkBtn("下一條 →", () => navigate(1));
  const btnSkip = mkBtn("跳過", () => doSkipCurrent());
  const btnExtend = mkBtn("延伸此桿", () => doExtendCurrent(), { primary: true });
  const btnExtendAll = mkBtn("全部延伸", () => doExtendAllRemaining());
  const btnSkipAll = mkBtn("全部跳過(關閉)", () => { skipped += remaining.length - currentIndex; closeDialog(); }, { danger: true });
  actions.appendChild(btnPrev);
  actions.appendChild(btnNext);
  actions.appendChild(btnSkip);
  const sp = pdoc.createElement("div");
  sp.style.flex = "1";
  actions.appendChild(sp);
  actions.appendChild(btnExtend);
  actions.appendChild(btnExtendAll);
  actions.appendChild(btnSkipAll);
  // 主邏輯
  let onKey;
  let _closed = false;
  function closeDialog() {
    if (_closed) return;
    _closed = true;
    try { win.removeEventListener("keydown", onKey, true); } catch (_) {}
    try { win.removeEventListener("mousemove", _onThumbPanMove); } catch (_) {}
    try { win.removeEventListener("mouseup", _onThumbPanUp); } catch (_) {}
    try { if (!win.closed) win.close(); } catch (_) {}
    const handled = extended + skipped;
    $("hud").textContent = `桿件延伸檢查完成・延伸 ${extended} 條・跳過 ${skipped}・剩 ${initialTotal - handled} 條未處理`;
    refreshLists && refreshLists();
    refreshFileList && refreshFileList();
    render && render();
  }
  // 使用者直接關掉 popup window → 觸發跟 closeDialog 一樣的清理
  win.addEventListener("beforeunload", () => { closeDialog(); });
  function advance() {
    currentIndex++;
    if (currentIndex >= remaining.length) {
      closeDialog();
      return;
    }
    refresh();
  }
  function navigate(delta) {
    const next = currentIndex + delta;
    if (next < 0 || next >= remaining.length) return;
    currentIndex = next;
    refresh();
  }
  async function refresh() {
    if (currentIndex >= remaining.length) { closeDialog(); return; }
    const c = remaining[currentIndex];
    titleText.textContent = `桿件延伸檢查 ${currentIndex + 1} / ${remaining.length}・延伸 ${extended}・跳過 ${skipped}`;
    // 顯示資訊
    const dirText = c.direction === "vertical" ? "垂直(Y軸 — 柱類)"
      : c.direction === "horizontal" ? "水平(X軸 — 樑類)" : "斜線";
    info.innerHTML =
      `<div><b style="color:#9bb6e8">檔案</b>:${c.fileName} ・ ${c.plane} 平面 ・ z=${c.pageZ}</div>` +
      `<div><b style="color:#9bb6e8">桿件</b> M${c.memberId} (J${c.memberJ1} ↔ J${c.memberJ2})</div>` +
      `<div><b style="color:#9bb6e8">方向</b>:${dirText}</div>` +
      `<div><b style="color:#9bb6e8">目標節點</b> J${c.targetJointId} @ (${c.targetX.toFixed(1)}, ${c.targetY.toFixed(1)})</div>` +
      `<div><b style="color:#9bb6e8">延伸自</b>:${c.extendFrom === "A" ? "A 端" : "B 端"} (J${c.anchorJointId})</div>` +
      `<div><b style="color:#9bb6e8">Gap</b>:${c.gap.toFixed(2)} ${c.isVertical ? "(柱:容忍 ≤200)" : "(梁/斜:容忍 ≤50)"}</div>` +
      `<div><b style="color:#9bb6e8">垂直偏移</b>:${c.perpDist.toFixed(2)}</div>`;
    // 切到該檔/頁,縮放主畫布
    if (state.activeFileId !== c.fileId || state.pageIdx !== c.pageIdx) {
      try { await activatePage(c.fileId, c.pageIdx); }
      catch (e) { console.warn("[延伸檢查] activatePage 失敗", e); }
    }
    const minX = Math.min(c.memberAx, c.memberBx, c.targetX);
    const minY = Math.min(c.memberAy, c.memberBy, c.targetY);
    const maxX = Math.max(c.memberAx, c.memberBx, c.targetX);
    const maxY = Math.max(c.memberAy, c.memberBy, c.targetY);
    _zoomMainCanvasToRect(minX, minY, maxX, maxY, 0.6);
    const f = state.files.find(x => x.id === c.fileId);
    // 放大預覽 canvas:用同樣的 region(再多放邊距,讓桿件周邊環境看得到)+ 疊桿件 / gap / 端點
    if (f) {
      try {
        // 計算 region(跟主畫布同步,但保證最小尺寸避免桿件貼邊)
        const pad = 0.6;
        const w0 = Math.max(1, maxX - minX), h0 = Math.max(1, maxY - minY);
        const region = {
          x: minX - w0 * pad,
          y: minY - h0 * pad,
          w: w0 * (1 + 2 * pad),
          h: h0 * (1 + 2 * pad),
        };
        // 給垂直 / 水平 / 重疊的線一個最小視覺方框(避免 w 或 h ≈ 0 時看不到 padding)
        const minSide = Math.max(region.w, region.h) * 0.5;
        if (region.w < minSide) { region.x -= (minSide - region.w) / 2; region.w = minSide; }
        if (region.h < minSide) { region.y -= (minSide - region.h) / 2; region.h = minSide; }
        // 不畫 bg image(被放大會糊,而且區域稀疏時整片黑) — 直接從結構幾何重建
        //   黑底 + 高對比的桿件 / 節點 overlay,看起來會比帶 bg 清楚得多
        const ctx = zoomCanvas.getContext("2d");
        ctx.fillStyle = "#0d0e10";
        ctx.fillRect(0, 0, zoomCanvas.width, zoomCanvas.height);
        const W = zoomCanvas.width, H = zoomCanvas.height;
        const sc = Math.min(W / region.w, H / region.h);
        const dw = region.w * sc, dh = region.h * sc;
        const tdx = (W - dw) / 2, tdy = (H - dh) / 2;
        const transform = { sc, dx: tdx, dy: tdy, dw, dh, regionX: region.x, regionY: region.y };
        const pgForLabels = f.pages && f.pages[c.pageIdx];
        _drawExtensionMarkers(zoomCanvas, transform, c, f, pgForLabels);
      } catch (e) { console.warn("[延伸檢查] 放大預覽失敗", e); }
      // 整頁縮圖(支援滾輪縮放 + 拖曳平移)
      //   切到新檔 → 重設 zoom/pan + 重新載 bg image;同檔不同候選 → 沿用 zoom/pan + 只重畫黃框
      try {
        const isNewFile = cachedThumbImg.fid !== f.id;
        if (isNewFile) {
          thumbState.zoom = 1; thumbState.offsetX = 0; thumbState.offsetY = 0;
          await loadThumbBg(f);
        }
        drawThumbWithZoom();
      } catch (e) { console.warn("[延伸檢查] 縮圖失敗", e); }
    }
    // 按鈕狀態
    btnPrev.disabled = currentIndex === 0;
    btnNext.disabled = currentIndex >= remaining.length - 1;
    btnPrev.style.opacity = btnPrev.disabled ? "0.4" : "1";
    btnNext.style.opacity = btnNext.disabled ? "0.4" : "1";
  }
  function doExtendCurrent() {
    if (currentIndex >= remaining.length) return;
    const c = remaining[currentIndex];
    pushUndo();
    const ok = _applyMemberExtension(c);
    if (ok) {
      extended++;
      actionHistory.push({ idx: currentIndex, action: "extend" });
    }
    advance();
  }
  function doSkipCurrent() {
    if (currentIndex >= remaining.length) return;
    actionHistory.push({ idx: currentIndex, action: "skip" });
    skipped++;
    advance();
  }
  // Cmd+Z 回退:依 actionHistory 最後一筆決定行為
  //   extend → 直接呼叫主畫面的 undo() 撤回 state + dialog index 回退 + 計數修正
  //   skip   → 沒 pushUndo,只回退 dialog index 不跑 undo(否則會誤撤上一個 extend)
  //   (popup 的 keydown 不會冒泡到主畫面,因此 undo 要在這裡明確呼叫)
  function handleDialogUndo() {
    const last = actionHistory.pop();
    if (!last) {
      // 沒歷史 → 把焦點還給主畫面讓使用者用主畫面的 Cmd+Z
      try { window.focus(); if (typeof undo === "function") undo(); } catch (_) {}
      return;
    }
    if (last.action === "extend") {
      extended = Math.max(0, extended - 1);
      currentIndex = last.idx;
      try { if (typeof undo === "function") undo(); } catch (_) {}
      setTimeout(() => { try { refresh(); } catch (_) {} }, 10);
    } else {
      skipped = Math.max(0, skipped - 1);
      currentIndex = last.idx;
      refresh();
    }
  }
  function doExtendAllRemaining() {
    const todo = remaining.slice(currentIndex);
    if (!todo.length) { closeDialog(); return; }
    if (!confirm(`一次延伸剩餘 ${todo.length} 條?\nCtrl+Z 可整批還原。`)) return;
    pushUndo();
    let added = 0;
    for (const c of todo) {
      if (_applyMemberExtension(c)) added++;
    }
    extended += added;
    // 批次當作一個 undo group,清掉歷史(再按 Cmd+Z 走 global undo 一次撤掉整批)
    actionHistory.length = 0;
    closeDialog();
  }
  // 鍵盤(綁在 popup window 上)
  onKey = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+Z:由 popup 自己呼叫主畫面 undo(popup keydown 不會冒泡到 main)
    if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      handleDialogUndo();
      return;
    }
    if (mod) return;
    if (e.key === "Escape") { e.preventDefault(); closeDialog(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); navigate(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); navigate(1); }
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); doExtendCurrent(); }
    else if (e.key === "s" || e.key === "S") { e.preventDefault(); doSkipCurrent(); }
  };
  win.addEventListener("keydown", onKey, true);
  // 第一條候選
  refresh();
  try { win.focus(); } catch (_) {}
}

// 一鍵清空所有頁面的本頁數字 — 把每個 page.groupNum 設成 null,refresh + render;Ctrl+Z 可還原
function clearAllPageGroupNumbers() {
  const pages = [];
  for (const f of state.files) {
    for (const [k, pg] of Object.entries(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      pages.push({ file: f, pg, key: k });
    }
  }
  const haveNum = pages.filter(e => e.pg.groupNum != null && Number.isFinite(e.pg.groupNum));
  if (!haveNum.length) {
    $("hud").textContent = "沒有任何頁面設定了本頁數字,沒東西要清";
    return;
  }
  if (!confirm(`將清空 ${haveNum.length} 個頁面的「本頁數字」(設為 null)。\n之後可用「一鍵自動編 本頁數字」整批重編。\nCtrl+Z 可還原。要繼續嗎?`)) return;
  pushUndo();
  const summary = [];
  for (const ent of haveNum) {
    summary.push({ name: ent.file.name, plane: ent.pg.plane || "—", oldNum: ent.pg.groupNum });
    ent.pg.groupNum = null;
  }
  console.log(`[一鍵清空 本頁數字] 清了 ${haveNum.length} 個頁面:`, summary);
  refreshPageCoordSection();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render(); refreshLists();
  $("hud").textContent = `已清空 ${haveNum.length} 個頁面的本頁數字`;
}

// ---------- canvas interaction ----------
wrap.addEventListener("mousemove", (e) => {
  updateCrosshair(e.clientX, e.clientY);
  if (panning) return;
  const w = screenToWorld(e.clientX, e.clientY);
  state.cursor.sx = w.x; state.cursor.sy = w.y;
  state.altDown = !!e.altKey;
  applyTransform();
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) {
    updateScaleRulerDragPreview(e.clientX, e.clientY);
    return;
  }
  if (state.bgDrawLine && state.bgDrawLine.active) {
    // 還沒點第一點時也要 render — 讓 hover 上 bg 端點 / 交點時就能看到鎖點圓圈與文字
    render();
    return;
  }
  if (state.bgCopyLine && state.bgCopyLine.active) {
    // 同樣 hover 顯示鎖點 + 預覽 ghost
    render();
    return;
  }
  if (state.sectionLinkPlacing) {
    render();   // 預覽切面定位:第一點前 = 游標十字;第一點後 = tip → 游標 + 箭頭
    return;
  }
  if (state.bgBisector && state.bgBisector.active) {
    updateBgBisectorPreview(e.clientX, e.clientY);
    return;
  }
  if (state.bgEqui && state.bgEqui.active) {
    updateBgEquiPreview(e.clientX, e.clientY);
    return;
  }
  if (state.measure && state.measure.sliding) {
    updateMeasureSlide(e.clientX, e.clientY);
    return;
  }
  if (state.tool === "line" && state.pendingLineStart) render();
  if (state.moveMode.active && state.moveMode.base) render();
  if (state.splitMode && state.splitFirstCorner) render();
  if (state.rangeZoomMode && (state.rangeZoomFirst || rangeZoomDragStart)) {
    const r = wrap.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const origin = rangeZoomDragStart || state.rangeZoomFirst;
    const ax = origin.x, ay = origin.y;
    const x1 = Math.min(ax, sx), y1 = Math.min(ay, sy);
    const x2 = Math.max(ax, sx), y2 = Math.max(ay, sy);
    const prev = $("rangeZoomPreview");
    if (prev) {
      prev.style.left = x1 + "px";
      prev.style.top  = y1 + "px";
      prev.style.width  = (x2 - x1) + "px";
      prev.style.height = (y2 - y1) + "px";
      prev.style.display = "block";
    }
  }
});
wrap.addEventListener("mouseleave", () => {
  $("crosshairH").style.display = "none";
  $("crosshairV").style.display = "none";
  $("crosshairBox").style.display = "none";
});
function updateCrosshair(clientX, clientY) {
  const cur = wrap.style.cursor;
  if (cur && cur !== "none") {
    $("crosshairH").style.display = "none";
    $("crosshairV").style.display = "none";
    $("crosshairBox").style.display = "none";
    return;
  }
  const r = wrap.getBoundingClientRect();
  const x = clientX - r.left, y = clientY - r.top;
  const h = $("crosshairH"), v = $("crosshairV"), b = $("crosshairBox");
  h.style.top  = y + "px"; h.style.display = "block";
  v.style.left = x + "px"; v.style.display = "block";
  b.style.left = x + "px"; b.style.top = y + "px"; b.style.display = "block";
}

wrap.addEventListener("click", (e) => {
  if (rangeZoomSuppressClick) { rangeZoomSuppressClick = false; return; }
  if (panning || state.spaceDown) return;
  // 若點擊命中工具列 / zoomTools / HUD 等浮層 UI,不視為畫布點擊
  if (e.target && e.target.closest && e.target.closest("#toolbar, #tabBar, #zoomTools, #bgEditTools, #selectTools, #hud, #cmdInputBar, #busySpinner, #menuBar")) return;
  // 比例尺沿線移動模式:點擊即確認當前位置
  if (state.scaleRulerDrag && state.scaleRulerDrag.active) {
    commitScaleRulerDrag();
    return;
  }
  // 畫直線模式:第一點 → 第二點
  //   自動鎖點:不需按鍵就會吸到 bg 端點 / 線交點(snapToBgVertex)
  //   Alt / Option:再放寬到吸 bg 線投影(線中央)— 優先吸附整個 bg 路徑
  if (state.bgDrawLine && state.bgDrawLine.active) {
    const w = screenToWorld(e.clientX, e.clientY);
    let p;
    if (e.altKey) {
      const bgSnap = snapToBgPaths(w);
      p = bgSnap || snap(w);
    } else {
      const v = snapToBgVertex(w);
      p = v || snap(w);
    }
    p = { x: p.x, y: p.y };
    if (!state.bgDrawLine.p1) {
      state.bgDrawLine.p1 = p;
      $("hud").textContent = "畫直線:點選第二個點(自動吸 bg 端點 / 交點;Shift = 鎖正交,Alt = 也吸線中段;Esc 取消)";
      render();
      return;
    }
    if (e.shiftKey || state.ortho) {
      const p1 = state.bgDrawLine.p1;
      if (Math.abs(p.x - p1.x) >= Math.abs(p.y - p1.y)) p.y = p1.y;
      else p.x = p1.x;
    }
    commitBgDrawLineSecond(p);
    return;
  }
  // 複製線模式:
  //   sources 還沒選 → 點 bg 線設為 source
  //   sources 有了但 base 還沒設 → 設基準點
  //   都有 → 放一份新線(基準點不變,連續複製)
  if (state.bgCopyLine && state.bgCopyLine.active) {
    const cl = state.bgCopyLine;
    if (!cl.sources.length) {
      // 用 elementFromPoint 直接抓游標下的 bg 元素;只接受有 data-bg-idx 的單一線段元素
      const targetEl = document.elementFromPoint(e.clientX, e.clientY);
      const idx = targetEl && targetEl.dataset && targetEl.dataset.bgIdx;
      if (!idx) {
        $("hud").textContent = "複製線:沒點到 bg 線,請點任一條 bg 線(實線 / 虛線都可)";
        return;
      }
      const src = _captureSourceFromElement(targetEl);
      if (!src) {
        $("hud").textContent = "複製線:這個元素不是單一線段(請改點 line / 單段 path / polyline)";
        return;
      }
      cl.sources = [src];
      $("hud").textContent = `複製線:已選 1 條,點基準點(自動吸 bg 端點 / 交點)`;
      render();
      return;
    }
    const w = screenToWorld(e.clientX, e.clientY);
    let p;
    if (e.altKey) {
      const bgSnap = snapToBgPaths(w);
      p = bgSnap || snap(w);
    } else {
      const v = snapToBgVertex(w);
      p = v || snap(w);
    }
    p = { x: p.x, y: p.y };
    if (!cl.base) {
      cl.base = p;
      $("hud").textContent = `複製線:基準點已設,移動滑鼠看預覽,點擊放置(可連續;Esc 結束)`;
      render();
      return;
    }
    if (e.shiftKey || state.ortho) {
      const b = cl.base;
      if (Math.abs(p.x - b.x) >= Math.abs(p.y - b.y)) p.y = b.y;
      else p.x = b.x;
    }
    commitBgCopyLineDest(p);
    return;
  }
  // 中分線模式:點擊即確認
  if (state.bgBisector && state.bgBisector.active) {
    commitBgBisector();
    return;
  }
  // 等分線模式:點擊即確認
  if (state.bgEqui && state.bgEqui.active) {
    commitBgEqui();
    return;
  }
  // 標示距離 sliding 模式:點擊即固定當前位置
  if (state.measure && state.measure.sliding) {
    commitMeasureSlide();
    return;
  }
  // 切面定位:對話框 OK 後 → 兩點點擊定位箭頭(兩點皆強制吸附到原 bg 切線的無限延伸線)
  if (state.sectionLinkPlacing) {
    const w = screenToWorld(e.clientX, e.clientY);
    const placing = state.sectionLinkPlacing;
    const projected = _projectPointOnLine(w, placing.repLine.p1, placing.repLine.p2);
    if (!placing.tip) {
      placing.tip = projected;
      $("hud").textContent = "切面定位:點擊第二點(箭頭尾端) — Esc 取消";
      render();
    } else {
      const tail = projected;
      const tip = placing.tip;
      const prevTool = placing.prevTool;
      // 用使用者點的 2 點當 p1(尖端)/ p2(尾端)— 取代原本 bg 線端點,兩點都在原切線上
      saveSectionLink(placing.file, { p1: tip, p2: tail }, placing.targetIds);
      state.sectionLinkPlacing = null;
      if (prevTool && prevTool !== "selectBg" && prevTool !== state.tool) setTool(prevTool);
      render();
    }
    return;
  }
  if (state.rangeZoomMode) {
    // 範圍放大:點兩下對角(或拖曳;拖曳在 mouseup 完成,此處只處理兩段式點擊)
    const r = wrap.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (!state.rangeZoomFirst) {
      state.rangeZoomFirst = { x: sx, y: sy };
      $("hud").textContent = "範圍放大:請點擊對角的第二點(Esc 取消)";
      return;
    }
    finalizeRangeZoomRect(state.rangeZoomFirst.x, state.rangeZoomFirst.y, sx, sy);
    return;
  }
  if (state.splitMode) {
    // 拆分模式:點兩下對角形成矩形
    const w = screenToWorld(e.clientX, e.clientY);
    const snapped = snap(w);
    if (!isInsideClip(getActiveFile(), snapped.x, snapped.y)) {
      $("hud").textContent = "拆分頁面:點擊位置在拆分頁範圍外,已忽略";
      return;
    }
    if (!state.splitFirstCorner) {
      state.splitFirstCorner = { x: snapped.x, y: snapped.y };
      $("hud").textContent = "拆分頁面:請點擊矩形對角(Esc 取消)";
      render();
      return;
    }
    const a = state.splitFirstCorner;
    const b = { x: snapped.x, y: snapped.y };
    const rect = {
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
    };
    state.splitFirstCorner = null;
    if (rect.w < 1 || rect.h < 1) { render(); return; }
    const p = getPage();
    const movedJ = new Set();
    const inside = (j) => j.x >= rect.x && j.x <= rect.x + rect.w
                       && j.y >= rect.y && j.y <= rect.y + rect.h;
    for (const j of p.joints) if (inside(j)) movedJ.add(j.id);
    const movedM = new Set();
    for (const mm of p.members) {
      const aJ = jointById(mm.j1), bJ = jointById(mm.j2);
      if (aJ && bJ && inside(aJ) && inside(bJ)) movedM.add(mm.id);
    }
    splitContext = { movedJ, movedM, rect };
    showSplitDim(rect);
    $("splitName").value = "拆分_" + (state.files.length + 1);
    $("splitDialog").style.display = "flex";
    setTimeout(() => $("splitName").focus(), 30);
    render();
    return;
  }
  if (state.manualAlign.active) return;     // 手動對齊模式下不處理任何點擊(畫線/校準/選取)
  if (state.moveMode.active) {
    const w = screenToWorld(e.clientX, e.clientY);
    const snapped = snap(w);
    handleMoveModeClick(snapped.x, snapped.y);
    return;
  }
  // 若 mousedown→mouseup 之間有實際移動,這是拖曳(平移或框選)結束的 click,不要當作普通點擊處理
  if (mouseDownPos) {
    const dx = e.clientX - mouseDownPos.x;
    const dy = e.clientY - mouseDownPos.y;
    const moved = Math.hypot(dx, dy) > 4;
    mouseDownPos = null;
    if (moved) return;
  }
  const w = screenToWorld(e.clientX, e.clientY);
  const snapped = snap(w);
  const _af = getActiveFile();
  // 校準功能已移除
  if (state.tool === "line") {
    if (!isInsideClip(_af, snapped.x, snapped.y)) {
      $("hud").textContent = "畫桿件:點擊位置在拆分頁範圍外,已忽略";
      return;
    }
    pushUndo();
    const j = ensureJointAt(snapped);
    if (!state.pendingLineStart) {
      state.pendingLineStart = j.id;
    } else {
      if (state.pendingLineStart !== j.id) {
        addMemberInteractive(state.pendingLineStart, j.id);
      }
      state.pendingLineStart = j.id;  // chain
    }
    render(); refreshLists();
    return;
  }
  if (state.tool === "point") {
    // 畫點:每按一下新增一個獨立節點(會 snap 到網格 / 既有節點)
    if (!isInsideClip(_af, snapped.x, snapped.y)) {
      $("hud").textContent = "畫節點:點擊位置在拆分頁範圍外,已忽略";
      return;
    }
    pushUndo();
    const j = ensureJointAt(snapped);
    if (state.crossViewSync) syncJointAcrossViews(j);
    render(); refreshLists();
    return;
  }
  if (state.tool === "select") {
    // selection happens via SVG element click handlers
    if (!additiveSelect(e)) clearSelection();
    render();
  }
  if (state.tool === "selectBg") {
    hideCtxMenu();
    // 多線選取開啟時:點擊空白不再清除既有選取(只能由 Esc 或關閉多線選取來清)
    if (!state.bgMultiSelect) clearAllBgSelection(getActiveFile());
  }
});

// double-click stops a chain
wrap.addEventListener("dblclick", () => {
  state.pendingLineStart = null;
  render();
});

// 除錯:document 攔截每次 click,印出 target
document.addEventListener("click", (e) => {
  if (!e.isTrusted) return;
  const t = e.target;
  console.log("[doc click] tag=", t.tagName, "id=", t.id, "class=", t.className, "text=", (t.textContent || "").slice(0, 20));
}, true);

// 點擊 UI 控制元件(工具列、側欄、HUD、對話框、選單等)時取消連續畫線狀態
const _uiSel = "#toolbar, #tabBar, #zoomTools, #hud, #ctxMenu, #planePicker, #splitDialog, #gbindDialog, #autoPairDialog, .sidebar, .collapser, .sidebar-resizer, #menuBar";
document.addEventListener("click", (e) => {
  if (!state.pendingLineStart) return;
  if (e.target.closest(_uiSel)) {
    state.pendingLineStart = null;
    render();
  }
}, true);

// 連續畫線時:在畫布上短時間內近距離連點兩下視為雙擊 → 結束連續畫線,且不建立第二個節點
let _lineLastClick = null;
document.addEventListener("click", (e) => {
  if (!e.isTrusted) return;                  // 忽略 dispatchEvent 的合成事件(例如點 label 轉發)
  if (state.tool !== "line") return;
  if (!e.target.closest("#stage")) return;
  const now = Date.now();
  if (_lineLastClick && (now - _lineLastClick.time) < 350 &&
      Math.hypot(e.clientX - _lineLastClick.x, e.clientY - _lineLastClick.y) < 8) {
    state.pendingLineStart = null;
    _lineLastClick = null;
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    render();
    return;
  }
  _lineLastClick = { time: now, x: e.clientX, y: e.clientY };
}, true);

// 在畫布內按右鍵 → 若有選取就跳出刪除選單
wrap.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (state.tool === "selectBg") {
    const file = getActiveFile();
    if (file && file.selectedBgPaths && file.selectedBgPaths.size > 0) {
      showBgCtxMenu(e.clientX, e.clientY);
    } else {
      hideCtxMenu();
    }
    return;
  }
  const hasSel = state.selection.joints.size + state.selection.members.size > 0;
  if (hasSel) showCtxMenu(e.clientX, e.clientY, null);
  else hideCtxMenu();
});

// ---------- snap ----------
// Alt 優先吸附:對 bg 路徑(端點 + 投影點)做吸附;在 bgEdit / 畫直線 模式下用
//   回傳 {x, y, kind}(若沒命中)→ null;caller 自行 fallback 到一般 snap()
// 自動鎖點 — 不需按 Alt:抓 bg 線條的「轉折點 / 端點」與「線交點」(供畫直線等模式預覽)
//   優先級:bg-vertex(端點)> bg-cross(交點)。
//   找不到回 null,呼叫端通常會 fallback 到 snap()(吸節點 / 桿件投影)。
//   用 page._bgSegsCache(activatePage 後填入,世界座標),不需要重新解析 SVG → 比 snapToBgPaths 快。
export function snapToBgVertex(world, opts) {
  const page = (typeof getPage === "function") ? getPage() : null;
  const segs = page && page._bgSegsCache;
  if (!Array.isArray(segs) || !segs.length) return null;
  const radius = (opts && opts.radius != null) ? opts.radius : ((state.snapPx || 12) / state.zoom);
  let best = null, bestD = radius;
  // 1. 端點(轉折點)
  for (const s of segs) {
    let d = Math.hypot(s.x1 - world.x, s.y1 - world.y);
    if (d < bestD) { bestD = d; best = { x: s.x1, y: s.y1, kind: "bg-vertex" }; }
    d = Math.hypot(s.x2 - world.x, s.y2 - world.y);
    if (d < bestD) { bestD = d; best = { x: s.x2, y: s.y2, kind: "bg-vertex" }; }
  }
  if (best) return best;
  // 2. 線段交點(只算靠近 world 的線段;避免 O(n²) 在大 DXF 失控)
  const probe = radius * 4;
  const near = [];
  for (const s of segs) {
    const dxAB = s.x2 - s.x1, dyAB = s.y2 - s.y1;
    const lenSq = dxAB * dxAB + dyAB * dyAB;
    if (lenSq < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((world.x - s.x1) * dxAB + (world.y - s.y1) * dyAB) / lenSq));
    const px = s.x1 + t * dxAB, py = s.y1 + t * dyAB;
    const d = Math.hypot(world.x - px, world.y - py);
    if (d <= probe) near.push(s);
  }
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const a = near[i], b = near[j];
      const x1 = a.x1, y1 = a.y1, x2 = a.x2, y2 = a.y2;
      const x3 = b.x1, y3 = b.y1, x4 = b.x2, y4 = b.y2;
      const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(denom) < 1e-9) continue;   // 平行
      const tA =  ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
      const tB = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
      // 只接受兩線段內的真交點;放寬一點容差吃端點剛好相接的情境
      if (tA < -0.01 || tA > 1.01 || tB < -0.01 || tB > 1.01) continue;
      const ix = x1 + tA * (x2 - x1);
      const iy = y1 + tA * (y2 - y1);
      const d = Math.hypot(ix - world.x, iy - world.y);
      if (d < bestD) { bestD = d; best = { x: ix, y: iy, kind: "bg-cross" }; }
    }
  }
  return best;
}

export function snapToBgPaths(world) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return null;
  const radius = state.snapPx / state.zoom;
  let best = null, bestD = radius;
  const els = bgSvgEl.querySelectorAll("[data-bg-idx]");
  // 簡易預過濾:用 getBoundingClientRect 把游標點轉成 svg-local 反查 bbox
  // 為求簡單,直接 iterate(DXF 大檔可能略慢,需要再加空間索引)
  for (const el of els) {
    if (el.style.display === "none") continue;
    if (el.dataset.bgPageBg === "1") continue;
    const tag = (el.localName || el.tagName.replace(/^.*:/, "")).toLowerCase();
    if (tag !== "line" && tag !== "path" && tag !== "polyline" && tag !== "polygon" && tag !== "rect") continue;
    const segs = svgElementToSegments(el);
    if (!segs.length) continue;
    const ctm = el.getScreenCTM();
    if (!ctm) continue;
    const owner = el.ownerSVGElement || bgSvgEl;
    for (const s of segs) {
      const sp1obj = owner.createSVGPoint(); sp1obj.x = s.x1; sp1obj.y = s.y1;
      const sp2obj = owner.createSVGPoint(); sp2obj.x = s.x2; sp2obj.y = s.y2;
      const ssp1 = sp1obj.matrixTransform(ctm), ssp2 = sp2obj.matrixTransform(ctm);
      const w1 = screenToWorld(ssp1.x, ssp1.y);
      const w2 = screenToWorld(ssp2.x, ssp2.y);
      // 端點
      let d = Math.hypot(w1.x - world.x, w1.y - world.y);
      if (d < bestD) { bestD = d; best = { x: w1.x, y: w1.y, kind: "bg-end" }; }
      d = Math.hypot(w2.x - world.x, w2.y - world.y);
      if (d < bestD) { bestD = d; best = { x: w2.x, y: w2.y, kind: "bg-end" }; }
      // 投影到線段
      const dxAB = w2.x - w1.x, dyAB = w2.y - w1.y;
      const lenSq = dxAB * dxAB + dyAB * dyAB;
      if (lenSq > 1e-9) {
        const t = Math.max(0, Math.min(1, ((world.x - w1.x) * dxAB + (world.y - w1.y) * dyAB) / lenSq));
        const px = w1.x + t * dxAB, py = w1.y + t * dyAB;
        d = Math.hypot(world.x - px, world.y - py);
        if (d < bestD) { bestD = d; best = { x: px, y: py, kind: "bg-line" }; }
      }
    }
  }
  return best;
}

export function snap(p) {
  const radius = state.snapPx / state.zoom;
  let best = null, bestD = radius;
  for (const j of getPage().joints) {
    const d = Math.hypot(j.x - p.x, j.y - p.y);
    if (d < bestD) { bestD = d; best = { x: j.x, y: j.y, joint: j }; }
  }
  if (state.snapMid) {
    for (const m of getPage().members) {
      const a = jointById(m.j1), b = jointById(m.j2);
      const mid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2 };
      const d = Math.hypot(mid.x - p.x, mid.y - p.y);
      if (d < bestD) { bestD = d; best = mid; }
    }
  }
  // 線條投影吸附:游標靠近任何已存在桿件時,吸附到該線上的投影點
  // 這也保證在線中間建立的新點一定落在線上(切開後兩段仍共線),不會被網格拉偏
  for (const mem of getPage().members) {
    const a = jointById(mem.j1), b = jointById(mem.j2);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const px = a.x + t * dx, py = a.y + t * dy;
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < bestD) { bestD = d; best = { x: px, y: py }; }
  }
  if (best) return best;
  // ortho snap relative to pendingLineStart or calibrate.p1
  let anchor = null;
  if (state.tool === "line" && state.pendingLineStart) {
    const j = jointById(state.pendingLineStart); anchor = { x: j.x, y: j.y };
  }
  let candidate = p;
  if (anchor && state.ortho) {
    const dx = Math.abs(p.x - anchor.x), dy = Math.abs(p.y - anchor.y);
    if (dx > dy) candidate = { x: p.x, y: anchor.y };
    else         candidate = { x: anchor.x, y: p.y };
  }
  // 鎖點:依 checkbox 組合決定 — 網格鎖點(單軸) / 網點鎖點(雙軸) / 線條優先(兩者皆勾時偏好單軸)
  const wantLine = !!state.snapToGridLines;
  const wantPoint = !!state.snapToGridPoints;
  if (wantLine || wantPoint) {
    const stepPx = (state.snapGrid.step || 1) * (state.scale || 1);
    if (stepPx > 0) {
      const nx = Math.round(candidate.x / stepPx) * stepPx;
      const ny = Math.round(candidate.y / stepPx) * stepPx;
      const dxToLine = Math.abs(candidate.x - nx);
      const dyToLine = Math.abs(candidate.y - ny);
      const snapToLine = () => (dxToLine <= dyToLine
        ? { x: nx, y: candidate.y }
        : { x: candidate.x, y: ny });
      const snapToPoint = () => ({ x: nx, y: ny });
      if (wantLine && wantPoint) {
        candidate = state.snapLinesPriority ? snapToLine() : snapToPoint();
      } else if (wantLine) candidate = snapToLine();
      else                  candidate = snapToPoint();
    }
  }
  return candidate;
}

// ---------- model ops ----------
export function jointById(id) { return getPage().joints.find(j => j.id === id); }

// 在指定頁面上找鄰近節點,沒有就新建。radius 用世界座標單位(通常 mm)
function getOrCreateJointOnPage(page, x, y, radius) {
  for (const j of page.joints) {
    if (Math.hypot(j.x - x, j.y - y) < radius) return j;
  }
  const j = { id: nextJointId++, x, y };
  page.joints.push(j);
  return j;
}

function ensureJointAt(p) {
  if (p.joint) return p.joint;
  // also re-search to merge with any existing joint within snap radius
  const radius = state.snapPx / state.zoom;
  for (const j of getPage().joints) {
    if (Math.hypot(j.x - p.x, j.y - p.y) < radius) return j;
  }
  const j = { id: nextJointId++, x: p.x, y: p.y };
  getPage().joints.push(j);
  return j;
}

// 跨頁同步建點(P1):
//   給已建立在當前頁的 joint,投影到 3D world,然後在所有相容平面的頁面 (file, page) 建立對應節點。
//   全部綁到同一個新 globalJoint(若 joint 已綁過則沿用)。
//   相容性檢查:目標頁的 page.z 要 ≈ world 的「out-of-plane 軸」(否則該 page 是不同的 slice,跳過)。
//   缺少必要設定(plane / ratio / origin)的頁面也會被 world3DToJoint2D 自然 skip。
function syncJointAcrossViews(joint) {
  const af = getActiveFile();
  const ap = getPage();
  if (!af || !ap) return;
  // 來源頁要能投影為 3D
  const world = joint2DToWorld3D(af, ap, joint);
  if (!world) {
    $("hud").textContent = "無法同步:當前頁缺少比例尺(原點可選)";
    return;
  }
  // 找相容頁(包含當前頁本身;當前頁要排除)
  const tol = Math.max(1.0, (state.snapPx || 12) / (state.scale || 1));
  const compat = findCompatiblePages(world, { tol })
    .filter(c => !(c.file.id === af.id && c.pageIdx === state.pageIdx));
  if (compat.length === 0) {
    $("hud").textContent = "跨頁同步:無其他相容頁面(檢查 plane / page.z / 比例尺 / 原點)";
    return;
  }
  // 取得或建立 globalJoint
  let g;
  if (joint.globalId != null) g = findGlobalJointById(joint.globalId);
  if (!g) {
    g = createGlobalJoint();
    joint.globalId = g.id;
  }
  // 建立對應節點 + 綁到同 globalJoint
  let created = 0, reused = 0, snappedToBg = 0, missingCache = 0;
  for (const c of compat) {
    // 檢查目標頁是否已有此 globalJoint 的綁定:有就略過(避免重複)
    const already = (c.page.joints || []).find(jj => jj.globalId === g.id);
    if (already) { reused++; continue; }
    // P2:嘗試吸到目標頁的底圖實際交點
    let pos = { x: c.x, y: c.y };
    if (Array.isArray(c.page._bgSegsCache)) {
      const snapHit = snapProjectionToBgIntersection(c.file, c.page, pos);
      if (snapHit) { pos = { x: snapHit.x, y: snapHit.y }; snappedToBg++; }
    } else {
      missingCache++;
    }
    // 目標頁是否已有同位節點:有就重用(綁過去)
    const radius = Math.max(1.0, (state.snapPx || 12) / (state.scale || 1));
    let target = (c.page.joints || []).find(jj =>
      Math.hypot(jj.x - pos.x, jj.y - pos.y) < radius);
    if (!target) {
      target = { id: nextJointId++, x: pos.x, y: pos.y };
      (c.page.joints || (c.page.joints = [])).push(target);
      created++;
    }
    target.globalId = g.id;
  }
  inferGlobalJoint(g);
  let msg = `跨頁同步:新建 ${created} 個節點(重用 ${reused},吸到底圖交點 ${snappedToBg})於 ${compat.length} 個相容頁,全綁到 ${g.label}`;
  if (missingCache > 0) msg += ` · ${missingCache} 個頁面尚未掃描底圖(可按「掃描所有底圖」)`;
  $("hud").textContent = msg;
}

// ---------- 移動指令(M)----------
// 對每條選取桿件,把端點延伸到「沿桿件方向最近的非共端點桿件」的交點
// bothEnds: true → 兩端都延伸;false(預設)→ 只延伸距離較近的那一端
// 端點被其他桿件共用 → 新建 joint 不動原 joint
function extendSelectedMembersToIntersect(bothEnds) {
  const p = getPage(); if (!p) return;
  if (state.selection.members.size === 0) {
    alert("請先選取至少一條桿件");
    return;
  }
  pushUndo();
  const eps = 1e-3;
  let moved = 0;
  const targets = [];   // { member, endKey: "j1"|"j2", x, y }
  for (const mid of state.selection.members) {
    const m = p.members.find(mm => mm.id === mid);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < eps) continue;
    let bestA = null, bestB = null;
    // 候選 1:其他桿件的延伸交點(原本邏輯)
    for (const o of p.members) {
      if (o.id === m.id) continue;
      if (o.j1 === m.j1 || o.j1 === m.j2 || o.j2 === m.j1 || o.j2 === m.j2) continue;
      const c = jointById(o.j1), d = jointById(o.j2);
      if (!c || !d) continue;
      const denom = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
      if (Math.abs(denom) < eps) continue;
      const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denom;
      const s = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denom;
      if (s < -eps || s > 1 + eps) continue;
      const px = a.x + t * (b.x - a.x);
      const py = a.y + t * (b.y - a.y);
      if (t < -eps) {
        if (bestA === null || (-t) < (-bestA.t)) bestA = { t, x: px, y: py };
      } else if (t > 1 + eps) {
        if (bestB === null || (t - 1) < (bestB.t - 1)) bestB = { t, x: px, y: py };
      }
    }
    // 候選 2:孤立節點(或任何 joint)落在沿線方向上 — 用該 joint 當延伸目標
    //   tol 0.5 world units;計算 J 到 a-b 線的垂直距離 + 沿線參數 t
    const jTol = 0.5;
    const dxAB = b.x - a.x, dyAB = b.y - a.y;
    for (const j of p.joints) {
      if (j.id === m.j1 || j.id === m.j2) continue;
      const t = ((j.x - a.x) * dxAB + (j.y - a.y) * dyAB) / lenSq;
      const px = a.x + t * dxAB, py = a.y + t * dyAB;
      const perp = Math.hypot(j.x - px, j.y - py);
      if (perp > jTol) continue;            // 不在線上
      if (t < -eps) {
        if (bestA === null || (-t) < (-bestA.t)) bestA = { t, x: j.x, y: j.y, jointId: j.id };
      } else if (t > 1 + eps) {
        if (bestB === null || (t - 1) < (bestB.t - 1)) bestB = { t, x: j.x, y: j.y, jointId: j.id };
      }
    }
    // 方向阻擋:若延伸該端的方向上已有共線同向桿件,跳過該端
    const aBlocked = bestA ? jointHasCollinearMemberInDirection(a, a.x - b.x, a.y - b.y) : true;
    const bBlocked = bestB ? jointHasCollinearMemberInDirection(b, b.x - a.x, b.y - a.y) : true;
    if (bothEnds) {
      if (bestA && !aBlocked) targets.push({ m, endKey: "j1", x: bestA.x, y: bestA.y, jointId: bestA.jointId });
      if (bestB && !bBlocked) targets.push({ m, endKey: "j2", x: bestB.x, y: bestB.y, jointId: bestB.jointId });
    } else {
      // 只挑距離較近的一端(|t| 最小或 t-1 最小);被阻擋的端視為不可延伸
      const dA = (bestA && !aBlocked) ? -bestA.t : Infinity;
      const dB = (bestB && !bBlocked) ? (bestB.t - 1) : Infinity;
      if (bestA && !aBlocked && dA <= dB)  targets.push({ m, endKey: "j1", x: bestA.x, y: bestA.y, jointId: bestA.jointId });
      else if (bestB && !bBlocked)         targets.push({ m, endKey: "j2", x: bestB.x, y: bestB.y, jointId: bestB.jointId });
    }
  }
  // 統一套用:目標若為既有 joint → 直接重指端點到該 joint;否則建新 joint(共用) / 移動原 joint
  const formerEndpoints = new Set();    // 因為延伸到既有 joint 而被「換掉」的原端點 id
  for (const t of targets) {
    if (t.jointId != null) {
      // 延伸到既有 joint:把 member 端點重指過去;紀錄被換掉的原端點 id 以便事後清理
      const oldId = t.m[t.endKey];
      t.m[t.endKey] = t.jointId;
      if (oldId !== t.jointId) formerEndpoints.add(oldId);
    } else {
      const jId = t.m[t.endKey];
      const shared = p.members.some(mm => mm !== t.m && (mm.j1 === jId || mm.j2 === jId));
      if (shared) {
        const nj = { id: nextJointId++, x: t.x, y: t.y };
        p.joints.push(nj);
        t.m[t.endKey] = nj.id;
      } else {
        const j = jointById(jId);
        if (j) { j.x = t.x; j.y = t.y; }
      }
    }
    moved++;
  }
  // 清掉「原端點變孤立」的 joint(只清因延伸而換掉、且現在沒被任何 member 引用的)
  let removedOrphans = 0;
  if (formerEndpoints.size) {
    const used = new Set();
    for (const m of p.members) { used.add(m.j1); used.add(m.j2); }
    const toRemove = p.joints.filter(j => formerEndpoints.has(j.id) && !used.has(j.id));
    for (const j of toRemove) {
      if (j.globalId != null && typeof unbindJointFromGlobal === "function") unbindJointFromGlobal(j);
    }
    const removedSet = new Set(toRemove.map(j => j.id));
    p.joints = p.joints.filter(j => !removedSet.has(j.id));
    removedOrphans = toRemove.length;
  }
  if (moved === 0) {
    alert("沒有可延伸的端點 — 找不到沿線方向的交叉桿件,或延伸方向已有桿件");
    return;
  }
  // 確保延伸建立的線不重複/重疊:合併同位節點、去重、共線拆段
  const cr = _consolidateInPlace();
  console.log(`[延伸至交點] 延伸 ${moved} 個端點;移除原端點 ${removedOrphans};整理 合併 ${cr.mergedJ} / 去重 ${cr.droppedM} / 拆段 ${cr.splitM}`);
  render(); refreshLists();
}

// 從選取節點沿軸向延伸,在最近的桿件交點建新 joint + 新桿件
// axis: "h" = 水平(沿 X);"v" = 垂直(沿 Y)
// bothSides: false → 只挑兩側最近的一邊;true → 兩邊各建一條
function extendJointAxisToIntersect(axis, bothSides) {
  const p = getPage(); if (!p) return;
  if (state.selection.joints.size === 0) {
    alert("請先選取至少一個節點");
    return;
  }
  pushUndo();
  const eps = 1e-3;
  let added = 0;
  for (const jid of [...state.selection.joints]) {
    const j = jointById(jid);
    if (!j) continue;
    let bestNeg = null, bestPos = null;   // 沿 axis 軸:Neg = 較小座標方向、Pos = 較大座標方向
    for (const m of p.members) {
      if (m.j1 === jid || m.j2 === jid) continue;     // 跳過與此節點相連的桿件
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      let px, py;
      if (axis === "h") {
        // 水平射線 y = j.y → 與 ab 交點
        const dy = b.y - a.y;
        if (Math.abs(dy) < eps) continue;             // 平行(目標也是水平)→ 跳過
        const t = (j.y - a.y) / dy;
        if (t < -eps || t > 1 + eps) continue;        // 不在 ab 線段內
        px = a.x + t * (b.x - a.x);
        py = j.y;
        const delta = px - j.x;
        if (Math.abs(delta) < eps) continue;          // 重合
        if (delta < 0) { if (bestNeg === null || px > bestNeg.x) bestNeg = { x: px, y: py, m }; }
        else           { if (bestPos === null || px < bestPos.x) bestPos = { x: px, y: py, m }; }
      } else {
        // 垂直射線 x = j.x → 與 ab 交點
        const dx = b.x - a.x;
        if (Math.abs(dx) < eps) continue;             // 平行(目標也是垂直)→ 跳過
        const t = (j.x - a.x) / dx;
        if (t < -eps || t > 1 + eps) continue;
        px = j.x;
        py = a.y + t * (b.y - a.y);
        const delta = py - j.y;
        if (Math.abs(delta) < eps) continue;
        if (delta < 0) { if (bestNeg === null || py > bestNeg.y) bestNeg = { x: px, y: py, m }; }
        else           { if (bestPos === null || py < bestPos.y) bestPos = { x: px, y: py, m }; }
      }
    }
    // 方向阻擋:若該方向已有共線同向桿件,跳過該側(避免重疊)
    const negDir = axis === "h" ? [-1, 0] : [0, -1];
    const posDir = axis === "h" ? [ 1, 0] : [0,  1];
    const negBlocked = jointHasCollinearMemberInDirection(j, negDir[0], negDir[1]);
    const posBlocked = jointHasCollinearMemberInDirection(j, posDir[0], posDir[1]);
    if (negBlocked) bestNeg = null;
    if (posBlocked) bestPos = null;

    let chosen = [];
    if (bothSides) {
      if (bestNeg) chosen.push(bestNeg);
      if (bestPos) chosen.push(bestPos);
    } else {
      // 兩側都有 → 挑距離較近的;只一側 → 挑那一側
      if (bestNeg && bestPos) {
        const dN = axis === "h" ? Math.abs(bestNeg.x - j.x) : Math.abs(bestNeg.y - j.y);
        const dP = axis === "h" ? Math.abs(bestPos.x - j.x) : Math.abs(bestPos.y - j.y);
        chosen.push(dN < dP ? bestNeg : bestPos);
      } else chosen.push(bestNeg || bestPos);
      chosen = chosen.filter(Boolean);
    }
    for (const c of chosen) {
      const nj = { id: nextJointId++, x: c.x, y: c.y };
      p.joints.push(nj);
      p.members.push({ id: nextMemberId++, j1: j.id, j2: nj.id });
      added++;
    }
  }
  if (added === 0) {
    alert("沒有可延伸的目標 — 找不到該方向上的桿件,或該方向已有桿件");
    return;
  }
  // 整理:合併同位節點、去重桿件、把節點落在桿件中段者 T 形拆段
  const cr = _consolidateInPlace();
  console.log(`[節點延伸] axis=${axis} bothSides=${bothSides} 新增 ${added};整理 合併 ${cr.mergedJ} / 去重 ${cr.droppedM} / 拆段 ${cr.splitM}`);
  render(); refreshLists();
}

// 節點水平 / 垂直複製:沿選取節點的水平(或垂直)線投射,在每條相交桿件上新增節點並 T 形拆段
//   與 extendJointAxisToIntersect 不同:這裡「不」從選取節點拉新桿件,
//   只是在「該射線碰到的每條現有桿件上」插入節點並把該桿件拆成兩段(類似沿線自動切交點)
function duplicateJointOnAxis(axis) {
  const p = getPage(); if (!p) return;
  if (state.selection.joints.size === 0) {
    alert("請先選取至少一個節點");
    return;
  }
  pushUndo();
  const eps = 1e-3;
  let added = 0, splitCount = 0;
  const selJids = [...state.selection.joints];
  for (const jid of selJids) {
    const j = jointById(jid);
    if (!j) continue;
    const rayCoord = (axis === "h") ? j.y : j.x;
    // 快照:此輪 ray 把 m 拆成兩段後,新段不會在同 y / 同 x 線上再次被掃到(無意義),
    // 所以快照一份在 ray 開始時就好,避免無限遞迴或重複切割
    const snapshot = p.members.slice();
    for (const m of snapshot) {
      // 與選取節點相連的桿件 → 該節點已是端點,不用再加
      if (m.j1 === jid || m.j2 === jid) continue;
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      let t;
      if (axis === "h") {
        const dy = b.y - a.y;
        if (Math.abs(dy) < eps) continue;      // 水平桿件與水平射線平行,跳過
        t = (rayCoord - a.y) / dy;
      } else {
        const dx = b.x - a.x;
        if (Math.abs(dx) < eps) continue;      // 垂直桿件與垂直射線平行,跳過
        t = (rayCoord - a.x) / dx;
      }
      // 只處理「嚴格在線段內部」的交點;端點在射線上 → 已是節點,不處理
      if (t < eps || t > 1 - eps) continue;
      const px = a.x + t * (b.x - a.x);
      const py = a.y + t * (b.y - a.y);
      // 該交點位置已有節點 → 複用(T 形拆段連到既有點)
      let nj = p.joints.find(jj => Math.hypot(jj.x - px, jj.y - py) < eps);
      if (!nj) {
        nj = { id: nextJointId++, x: px, y: py };
        p.joints.push(nj);
        added++;
      }
      // 把 m 從 members 移除,改成兩段短桿件(保留 m 原有的 capacity / constraint 等屬性)
      const idx = p.members.indexOf(m);
      if (idx < 0) continue;
      const baseProps = { ...m };
      delete baseProps.id; delete baseProps.j1; delete baseProps.j2;
      p.members.splice(idx, 1);
      p.members.push({ ...baseProps, id: nextMemberId++, j1: m.j1, j2: nj.id });
      p.members.push({ ...baseProps, id: nextMemberId++, j1: nj.id, j2: m.j2 });
      splitCount++;
    }
  }
  if (added === 0 && splitCount === 0) {
    alert(axis === "h" ? "水平線上沒有可新增節點的桿件" : "垂直線上沒有可新增節點的桿件");
    return;
  }
  console.log(`[節點${axis === "h" ? "水平" : "垂直"}複製] 新增節點 ${added}・拆段 ${splitCount}`);
  render(); refreshLists();
}

function startMoveMode(type) {
  if (state.selection.joints.size === 0) {
    alert("請先選取至少一個節點(切到選取工具,再點/框選節點)。");
    return;
  }
  if (!_assertSelectionOnActivePage("移動選取節點(M)")) return;
  if (state.tool !== "select") setTool("select");
  state.moveMode = {
    active: true,
    type: type || "free",
    base: null, lock: null,
    distance: null, angle: null, dx: null, dy: null,
  };
  updateMoveModeHUD();
  render();
}
function exitMoveMode() {
  state.moveMode = { active: false, type: null, base: null, lock: null, distance: null, angle: null, dx: null, dy: null };
  hideCmdInput();
  applyTransform();
  render();
}
export function moveModeTarget(cursorWorld) {
  const m = state.moveMode;
  if (!m.active || !m.base) return null;
  switch (m.type) {
    case "h": return { x: cursorWorld.x, y: m.base.y };
    case "v": return { x: m.base.x, y: cursorWorld.y };
    case "free": {
      if (m.lock === "h") return { x: cursorWorld.x, y: m.base.y };
      if (m.lock === "v") return { x: m.base.x, y: cursorWorld.y };
      return { x: cursorWorld.x, y: cursorWorld.y };
    }
    case "dist": {
      if (m.distance == null) return null;
      let dx = cursorWorld.x - m.base.x, dy = cursorWorld.y - m.base.y;
      if (m.lock === "h") dy = 0;
      else if (m.lock === "v") dx = 0;
      const len = Math.hypot(dx, dy) || 1;
      return { x: m.base.x + dx / len * m.distance, y: m.base.y + dy / len * m.distance };
    }
    case "angle": {
      if (m.distance == null || m.angle == null) return null;
      const a = m.angle * Math.PI / 180;
      return { x: m.base.x + Math.cos(a) * m.distance, y: m.base.y + Math.sin(a) * m.distance };
    }
    case "rect": {
      if (m.dx == null || m.dy == null) return null;
      return { x: m.base.x + m.dx, y: m.base.y + m.dy };
    }
  }
  return null;
}
function commitMove(tx, ty) {
  pushUndo();
  const dx = tx - state.moveMode.base.x;
  const dy = ty - state.moveMode.base.y;
  for (const id of state.selection.joints) {
    const jt = jointById(id);
    if (jt) { jt.x += dx; jt.y += dy; }
  }
  exitMoveMode();
  refreshLists();
}
export function handleMoveModeClick(x, y) {
  const m = state.moveMode;
  if (!m.active) return;
  if (!m.base) {
    m.base = { x, y };
    updateMoveModeHUD();
    render();
    return;
  }
  // 第二次點:若資料已備齊就確認;否則無動作(等待輸入)
  const t = moveModeTarget({ x, y });
  if (!t) return;
  commitMove(t.x, t.y);
}
function updateMoveModeHUD() {
  const m = state.moveMode;
  if (!m.active) return;
  let msg = "";
  if (!m.base) {
    msg = "移動:請點擊基準點(Esc 取消)";
    hideCmdInput();
  } else if (m.type === "dist") {
    if (m.distance == null) {
      msg = "距離移動:在下方輸入距離";
      showCmdInput("輸入距離:", "mm");
    } else {
      msg = "距離移動:移動方向(Shift 鎖水平 / Alt 鎖垂直),點擊確認";
      hideCmdInput();
    }
  } else if (m.type === "angle") {
    if (m.distance == null) {
      msg = "夾角移動:輸入距離";
      showCmdInput("輸入距離:", "mm");
    } else if (m.angle == null) {
      msg = "夾角移動:輸入夾角(0° = 右,90° = 上)";
      showCmdInput("輸入夾角:", "°");
    } else {
      msg = "夾角移動:Enter 確認";
      hideCmdInput();
    }
  } else if (m.type === "rect") {
    if (m.dx == null) {
      msg = "直角坐標移動:輸入水平位移(向右為正)";
      showCmdInput("水平位移:", "mm");
    } else if (m.dy == null) {
      msg = "直角坐標移動:輸入垂直位移(向上為正)";
      showCmdInput("垂直位移:", "mm");
    }
  } else if (m.type === "h") {
    msg = "水平移動:點擊目標(只能左右)";
    hideCmdInput();
  } else if (m.type === "v") {
    msg = "垂直移動:點擊目標(只能上下)";
    hideCmdInput();
  } else {
    msg = "移動:點擊目標(Shift 鎖水平 / Alt 鎖垂直)";
    hideCmdInput();
  }
  $("hud").textContent = msg;
}
function showCmdInput(prompt, unit) {
  const bar = $("cmdInputBar");
  if (!bar) return;
  bar.style.display = "flex";
  bar.querySelector(".cmd-prompt").textContent = prompt;
  bar.querySelector(".cmd-unit").textContent = unit || "";
  const f = $("cmdInputField");
  f.value = "";
  setTimeout(() => f.focus(), 0);
}
function hideCmdInput() {
  const bar = $("cmdInputBar");
  if (bar) bar.style.display = "none";
  // 釋放 focus,讓 Shift / Ctrl 等全域快捷鍵在隨後的 mouse 階段生效
  const f = $("cmdInputField");
  if (f) f.blur();
}
function handleCmdInputCommit() {
  const m = state.moveMode;
  if (!m.active) return;
  const f = $("cmdInputField");
  const v = evalNumExpr(f.value);
  if (Number.isNaN(v)) return;
  if (m.type === "dist") {
    m.distance = v;
    updateMoveModeHUD();
    render();
  } else if (m.type === "angle") {
    if (m.distance == null) m.distance = v;
    else if (m.angle == null) {
      m.angle = v;
      const t = moveModeTarget({ x: 0, y: 0 });
      if (t) { commitMove(t.x, t.y); return; }
    }
    updateMoveModeHUD();
    render();
  } else if (m.type === "rect") {
    if (m.dx == null) m.dx = v;
    else if (m.dy == null) {
      m.dy = v;
      const t = moveModeTarget({ x: 0, y: 0 });
      if (t) { commitMove(t.x, t.y); return; }
    }
    updateMoveModeHUD();
    render();
  }
}

// 將所有選取的桿件在中點插入節點(切成兩段)
function splitSelectedAtMidpoint() {
  const p = getPage();
  if (!p || p._orphan) return;
  if (state.selection.members.size === 0) return;
  pushUndo();
  const ids = [...state.selection.members];
  for (const mid of ids) {
    const m = p.members.find(x => x.id === mid);
    if (!m) continue;
    const a = jointById(m.j1), b = jointById(m.j2);
    if (!a || !b) continue;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const nj = { id: nextJointId++, x: cx, y: cy };
    p.joints.push(nj);
    p.members = p.members.filter(x => x !== m);
    p.members.push({ id: nextMemberId++, j1: m.j1, j2: nj.id });
    p.members.push({ id: nextMemberId++, j1: nj.id, j2: m.j2 });
  }
  clearSelection();
  render(); refreshLists();
}

// 在指定線段(memberId)上、最靠近 (clientX,clientY) 的位置插入新節點,並把該線段切成兩段
export function splitMemberAt(memberId, clientX, clientY) {
  const p = getPage();
  const m = p.members.find(x => x.id === memberId);
  if (!m) return;
  const a = jointById(m.j1), b = jointById(m.j2);
  if (!a || !b) return;
  const w = screenToWorld(clientX, clientY);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return;
  let t = ((w.x - a.x) * dx + (w.y - a.y) * dy) / len2;
  const minMargin = (state.snapPx / state.zoom) / Math.sqrt(len2);
  if (t < minMargin || t > 1 - minMargin) return;
  pushUndo();
  const px = a.x + t * dx, py = a.y + t * dy;
  const j = { id: nextJointId++, x: px, y: py };
  p.joints.push(j);
  p.members = p.members.filter(x => x !== m);
  p.members.push({ id: nextMemberId++, j1: m.j1, j2: j.id });
  p.members.push({ id: nextMemberId++, j1: j.id, j2: m.j2 });
  render(); refreshLists();
}

function addMember(j1, j2, targetPage) {
  const p = targetPage || getPage();
  if (!p) return;
  if (!Array.isArray(p.members)) p.members = [];
  const exists = p.members.some(m =>
    (m.j1 === j1 && m.j2 === j2) || (m.j1 === j2 && m.j2 === j1));
  if (exists) return;
  p.members.push({ id: nextMemberId++, j1, j2 });
}

// 跨頁同步桿件(P3):
//   給當前頁兩個 view-joint(剛新增桿件 A—B 的兩端),掃所有其他頁:
//     - 兩端的 globalJoint 都在該頁有 view-binding → 在該頁建對應桿件
//     - 缺一端 → 略過該頁
//   若兩端尚未綁定 globalJoint,呼叫端會先用 syncJointAcrossViews 把它們 promote 過去
//   回 { created, pages }
function syncMemberAcrossViews(j1Local, j2Local) {
  const af = getActiveFile();
  if (!af) return { created: 0, pages: 0 };
  if (!j1Local || !j2Local) return { created: 0, pages: 0 };
  const g1 = j1Local.globalId, g2 = j2Local.globalId;
  if (g1 == null || g2 == null || g1 === g2) return { created: 0, pages: 0 };
  let created = 0, scannedPages = 0;
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      if (f.id === af.id && +k === state.pageIdx) continue;   // 略過當前頁
      const t1 = (pg.joints || []).find(jj => jj.globalId === g1);
      const t2 = (pg.joints || []).find(jj => jj.globalId === g2);
      if (!t1 || !t2) continue;
      scannedPages++;
      const exists = (pg.members || []).some(m =>
        (m.j1 === t1.id && m.j2 === t2.id) || (m.j1 === t2.id && m.j2 === t1.id));
      if (exists) continue;
      addMember(t1.id, t2.id, pg);
      created++;
    }
  }
  return { created, pages: scannedPages };
}

// 在「桿件」工具下完成第二端點時呼叫:本頁建桿件 + (若 crossViewSync 開啟)跨頁建對應桿件
//   兩端若尚未有 globalJoint,先 syncJointAcrossViews(promote + 跨頁建節點),再 syncMemberAcrossViews
export function addMemberInteractive(j1id, j2id) {
  addMember(j1id, j2id);
  if (!state.crossViewSync) return;
  const p = getPage();
  if (!p) return;
  const j1 = (p.joints || []).find(jj => jj.id === j1id);
  const j2 = (p.joints || []).find(jj => jj.id === j2id);
  if (!j1 || !j2) return;
  // Auto-promote 端點 → 各自 promote 為 globalJoint 並把對應節點建到其他頁
  if (j1.globalId == null) syncJointAcrossViews(j1);
  if (j2.globalId == null) syncJointAcrossViews(j2);
  const r = syncMemberAcrossViews(j1, j2);
  if (r.pages > 0 || r.created > 0) {
    $("hud").textContent = `跨頁同步桿件:在 ${r.pages} 個頁面比對,新建 ${r.created} 條桿件`;
  }
}

function deleteSelection() {
  if (state.selection.joints.size + state.selection.members.size === 0) return;
  // 大模型 + 跨頁共點刪除可能要掃所有 file/page,給 pending message 避免使用者以為卡死
  //   先快速估算:若選取的 joint 有 globalId,且總頁面數 > 10 → 顯示 busy
  const totalPages = state.files.reduce((s, f) => s + Object.keys(f.pages || {}).length, 0);
  const hasGlobalSelected = state.selection.joints.size > 0 &&
    [...state.selection.joints].some(jid => {
      const p0 = getPage();
      const j = p0 && p0.joints.find(x => x.id === jid);
      return j && j.globalId != null;
    });
  if (hasGlobalSelected && totalPages > 10 && typeof withBusy === "function") {
    // 用 withBusy 包,讓 spinner / 取消鈕跑起來
    return withBusy(`刪除選取(跨 ${totalPages} 頁掃描共點)…`, () => _deleteSelectionCore());
  }
  return _deleteSelectionCore();
}
function _deleteSelectionCore() {
  pushUndo();
  const p = getPage();
  // 記下被刪桿件的端點,稍後檢查是否變孤立
  const checkOrphan = new Set();
  if (state.selection.members.size) {
    for (const m of p.members) {
      if (state.selection.members.has(m.id)) {
        checkOrphan.add(m.j1); checkOrphan.add(m.j2);
      }
    }
    p.members = p.members.filter(m => !state.selection.members.has(m.id));
  }
  // 處理選取的節點:若節點剛好是「桿件中間的點」(degree == 2 且大致共線)→ 合併成一條
  //   degree == 2 但不共線(如 L 形轉角)→ 保留舊行為(連同兩條桿件一併刪除)
  //   tolerance:相對於桿件長度的 1% 或絕對 1.0 世界單位,取較大者
  //              這個值能容忍 processIntersections / 校準 累積的數值漂移,但仍能擋掉真正轉角
  if (state.selection.joints.size) {
    for (const jid of state.selection.joints) {
      const conn = p.members.filter(m => m.j1 === jid || m.j2 === jid);
      let merged = false;
      if (conn.length === 2) {
        const [m1, m2] = conn;
        const otherOf = (mem) => mem.j1 === jid ? mem.j2 : mem.j1;
        const aId = otherOf(m1), bId = otherOf(m2);
        const a = jointById(aId), b = jointById(bId), c = jointById(jid);
        if (a && b && c && aId !== bId) {
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          const cross = Math.abs(dx * (c.y - a.y) - dy * (c.x - a.x));
          const distToLine = len > 0 ? cross / len : Infinity;
          const tol = Math.max(1.0, len * 0.01);
          const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / (len * len || 1);
          if (distToLine <= tol && t > 0 && t < 1) {
            p.members = p.members.filter(m => m !== m1 && m !== m2);
            const exists = p.members.some(m =>
              (m.j1 === aId && m.j2 === bId) || (m.j1 === bId && m.j2 === aId));
            if (!exists) p.members.push({ id: nextMemberId++, j1: aId, j2: bId });
            merged = true;
          }
        }
      }
      if (!merged) {
        // 不共線 / 連 0、1 或 3+ 條 → 連同所有相連桿件一併移除
        p.members = p.members.filter(m => m.j1 !== jid && m.j2 !== jid);
      }
    }
    // 收集被刪 joint 的 globalId(有綁定的才需要跨頁刪)
    const deletedGids = new Set();
    for (const j of p.joints) {
      if (state.selection.joints.has(j.id) && j.globalId != null) deletedGids.add(j.globalId);
    }
    p.joints = p.joints.filter(j => !state.selection.joints.has(j.id));
    // 跨頁刪除「共點」joint:不再對每頁掃 joints,改成先一次性建 globalId → 受影響頁面索引
    //   優點:
    //     1. 沒受影響的頁面完全不會被 touch(filter members / joints 都不跑)
    //     2. globalJoint 清理可直接用索引推算「剩餘 binding」,不需再掃一遍 state
    if (deletedGids.size) {
      // ── 步驟 A:建 gid → [{pg, jid}] 索引(排除當前頁 p,因為它已處理)──
      const gidIndex = new Map();    // gid → [{pg, jid}]
      const stillBoundOther = new Set();   // 其他頁仍綁著的 gid(不在 deletedGids 內)
      for (const f of state.files) {
        for (const pg of Object.values(f.pages || {})) {
          if (!pg || pg._orphan || pg === p) continue;
          for (const j of (pg.joints || [])) {
            if (j.globalId == null) continue;
            if (deletedGids.has(j.globalId)) {
              let arr = gidIndex.get(j.globalId);
              if (!arr) { arr = []; gidIndex.set(j.globalId, arr); }
              arr.push({ pg, jid: j.id });
            } else {
              stillBoundOther.add(j.globalId);
            }
          }
        }
      }
      // ── 步驟 B:依索引收集每頁要刪的 joint id ──
      const pageRemove = new Map();   // pg → Set(jids)
      for (const arr of gidIndex.values()) {
        for (const b of arr) {
          let s = pageRemove.get(b.pg);
          if (!s) { s = new Set(); pageRemove.set(b.pg, s); }
          s.add(b.jid);
        }
      }
      // ── 步驟 C:只 filter 受影響的頁面 ──
      let crossPages = 0, crossJoints = 0, crossMembers = 0;
      for (const [pg, removeJids] of pageRemove) {
        const beforeJ = pg.joints.length, beforeM = (pg.members || []).length;
        pg.members = (pg.members || []).filter(m => !removeJids.has(m.j1) && !removeJids.has(m.j2));
        pg.joints = pg.joints.filter(j => !removeJids.has(j.id));
        crossPages++;
        crossJoints += beforeJ - pg.joints.length;
        crossMembers += beforeM - pg.members.length;
      }
      if (crossPages) {
        console.log(`[共點刪除] 跨頁刪除 ${crossPages} 頁・節點 ${crossJoints}・桿件 ${crossMembers}・globalId ${deletedGids.size} 個(O(受影響頁面),不再掃整個 state)`);
        $("hud").textContent = `已刪除節點(連同其他平面 ${crossPages} 頁的 ${crossJoints} 個共點)`;
      }
      // ── 步驟 D:清掉孤兒 globalJoint。
      //   不變式:每頁 1 gid 最多 1 個 joint binding(bindJointToGlobal 強制)→
      //     deletedGids 對應的 globalJoint,在其他頁的 binding 都被步驟 C 刪光、
      //     當前頁的 binding 也被前面 p.joints.filter 刪光 → 一律可刪。
      //   防禦性:還是檢查當前頁殘留 binding(以防不變式被外部破壞)
      const stillBoundInP = new Set();
      for (const j of p.joints) if (j.globalId != null) stillBoundInP.add(j.globalId);
      if (Array.isArray(state.globalJoints)) {
        const before = state.globalJoints.length;
        state.globalJoints = state.globalJoints.filter(g => {
          if (!deletedGids.has(g.id)) return true;
          // gid 在 deletedGids:當前頁 / 其他頁都不該有 binding 了 — 雙重檢查
          return stillBoundInP.has(g.id) || stillBoundOther.has(g.id);
        });
        const removedGj = before - state.globalJoints.length;
        if (removedGj) console.log(`[共點刪除] 清掉沒有 binding 的 globalJoint ${removedGj} 個`);
      }
    }
  }
  // 移除孤立節點(來自被刪桿件的端點)
  if (checkOrphan.size) {
    const used = new Set();
    for (const m of p.members) { used.add(m.j1); used.add(m.j2); }
    p.joints = p.joints.filter(j => !checkOrphan.has(j.id) || used.has(j.id));
  }
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  clearSelection();
  render(); refreshLists();
}

export function clearSelection() {
  state.selection.joints.clear();
  state.selection.members.clear();
  state.selection.fileIds.clear();
  state.selection.fileAnchor = null;
  state.selection.sourceFileId = null;
  state.selection.sourcePageIdx = null;
}
// 防誤刪 guard:當 selection 不在當前 page 時,阻擋 mutation 操作。
//   R-01 修補:state.selection.joints 存 raw j.id,relayoutNumberingAll 後跨頁 j.id 可能撞號,
//   在 source page 之外按 delete 會誤刪同 id 但不同物理點的 joint。視覺已用 _selOnSrc 隔離,
//   操作層用這支 guard 擋住。
//   回傳 true = 可繼續;false = 已被使用者選擇取消或切換頁面,呼叫端應直接 return。
function _assertSelectionOnActivePage(opName) {
  // 沒選任何東西 → 不擋(不影響無 selection 場景)
  if (state.selection.joints.size === 0 && state.selection.members.size === 0) return true;
  // 沒記 source(舊資料 / 沒被 mark 過)→ 不擋(legacy 行為)
  if (state.selection.sourceFileId == null || state.selection.sourcePageIdx == null) return true;
  const onSrc = (state.selection.sourceFileId === state.activeFileId
              && state.selection.sourcePageIdx === (state.pageIdx || 0));
  if (onSrc) return true;
  // 不在 source page → 詢問使用者怎麼做
  const srcFile = state.files.find(f => f.id === state.selection.sourceFileId);
  const srcName = srcFile ? `${srcFile.name}#${state.selection.sourcePageIdx + 1}` : `file ${state.selection.sourceFileId}, page ${state.selection.sourcePageIdx + 1}`;
  const opt = confirm(
    `⚠ 操作「${opName || "目前動作"}」會作用在選取的 joint / member,\n` +
    `但當前選取是在「${srcName}」建立的,目前頁不是 source。\n\n` +
    `直接執行可能誤刪 / 誤動 j.id 巧合相同的不同物理點(relayoutNumberingAll 後 j.id 跨頁會撞號)。\n\n` +
    `點【確定】切回 source page 並執行操作。\n` +
    `點【取消】放棄此次操作(selection 仍保留)。`
  );
  if (opt) {
    if (typeof activatePageWithBusy === "function") {
      activatePageWithBusy(state.selection.sourceFileId, state.selection.sourcePageIdx);
    }
  }
  return false;
}
// 標記 selection 的「來源頁」— 只在 selection 從空變非空、或來源還沒設時設定;
//   避免使用者連續勾選跨頁時 source 跳來跳去(理論上不會發生,因為跨頁勾選會經過切頁)
export function _markSelectionSourceIfEmpty() {
  if (state.selection.sourceFileId == null) {
    state.selection.sourceFileId = state.activeFileId;
    state.selection.sourcePageIdx = state.pageIdx || 0;
  }
}

// 多選判定:按住 Shift 或開啟多選持續模式(Shift+S 切換)時,點選為追加
export function additiveSelect(e) {
  return !!(e && e.shiftKey) || !!state.multiSelectSticky;
}
// 反選判定:按住 Ctrl(或 Mac 的 Cmd / Meta)時,點選為從選取中移除
export function subtractiveSelect(e) {
  return !!(e && (e.ctrlKey || e.metaKey));
}

// Process intersections: for every pair of members, if they cross (not at endpoints),
// split both at the intersection joint.
// 把「節點落在某桿件中段」的情況拆桿:
// 例如桿件 (0,0)-(10,0) 與節點 (3,0) 共線且夾在中間 → 拆成 (0,0)-(3,0) + (3,0)-(10,0)
// 處理線重疊但端點不重疊的情況(例如 bg 上有兩條重疊但不同長度的線轉桿件)
function splitMembersAtCollinearJoints() {
  const p = getPage();
  if (!p) return;
  const eps = 1e-3;
  let changed = true, guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    outer:
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < eps) continue;
      const len = Math.sqrt(lenSq);
      for (const j of p.joints) {
        if (j.id === a.id || j.id === b.id) continue;
        const cross = Math.abs((j.x - a.x) * dy - (j.y - a.y) * dx);
        if (cross / len > eps) continue;          // 不共線
        const t = ((j.x - a.x) * dx + (j.y - a.y) * dy) / lenSq;
        if (t < eps || t > 1 - eps) continue;     // 不在內部
        // 在 j 點拆桿
        p.members.splice(i, 1);
        const existsA = p.members.some(mm => (mm.j1 === a.id && mm.j2 === j.id) || (mm.j1 === j.id && mm.j2 === a.id));
        const existsB = p.members.some(mm => (mm.j1 === j.id && mm.j2 === b.id) || (mm.j1 === b.id && mm.j2 === j.id));
        if (!existsA) p.members.push({ id: nextMemberId++, j1: a.id, j2: j.id });
        if (!existsB) p.members.push({ id: nextMemberId++, j1: j.id, j2: b.id });
        changed = true;
        break outer;
      }
    }
  }
}

// 切交點(選取版):只對 state.selection.members 內的桿件兩兩求交,在交點處建節點 + 拆段
//   - 拆段後新桿件自動加入選取(保持視覺一致,連續操作不需重選)
//   - 跟全頁版一樣會跑 splitMembersAtCollinearJoints 處理 T 形(但僅限拆完還在選取裡的桿件)
function processIntersectionsForSelection() {
  const p = getPage();
  const sel = state.selection.members;
  if (!sel || sel.size < 2) {
    alert("請先選取至少 2 條桿件再執行切交點(選取)");
    return;
  }
  pushUndo();
  let selIds = new Set(sel);
  let intersections = 0;
  let changed = true, guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    const selMembers = p.members.filter(m => selIds.has(m.id));
    outer:
    for (let i = 0; i < selMembers.length; i++) {
      for (let k = i + 1; k < selMembers.length; k++) {
        const m1 = selMembers[i], m2 = selMembers[k];
        const a = jointById(m1.j1), b = jointById(m1.j2);
        const c = jointById(m2.j1), d = jointById(m2.j2);
        if (!a || !b || !c || !d) continue;
        const inter = segIntersect(a, b, c, d);
        if (!inter) continue;
        const eps = 1e-3;
        const isEnd = (j) => Math.hypot(j.x - inter.x, j.y - inter.y) < eps;
        if (isEnd(a) || isEnd(b) || isEnd(c) || isEnd(d)) continue;
        const nj = ensureJointAt(inter);
        // split m1
        const i1 = p.members.indexOf(m1);
        if (i1 !== -1) p.members.splice(i1, 1);
        const m1a = { id: nextMemberId++, j1: a.id, j2: nj.id };
        const m1b = { id: nextMemberId++, j1: nj.id, j2: b.id };
        p.members.push(m1a, m1b);
        // split m2
        const i2 = p.members.indexOf(m2);
        if (i2 !== -1) p.members.splice(i2, 1);
        const m2a = { id: nextMemberId++, j1: c.id, j2: nj.id };
        const m2b = { id: nextMemberId++, j1: nj.id, j2: d.id };
        p.members.push(m2a, m2b);
        selIds.delete(m1.id); selIds.delete(m2.id);
        selIds.add(m1a.id); selIds.add(m1b.id);
        selIds.add(m2a.id); selIds.add(m2b.id);
        intersections++;
        changed = true;
        break outer;
      }
    }
  }
  state.selection.members = selIds;
  // T 形:節點(新建的交點 + 既有節點)落在還在選取的桿件中段 → 拆段
  //   全頁版 splitMembersAtCollinearJoints 會處理整頁;這裡僅針對選取桿件,但用全頁掃也合理(節點少時)
  if (typeof splitMembersAtCollinearJoints === "function") splitMembersAtCollinearJoints();
  console.log(`[切交點(選取)] 加 ${intersections} 個交點・選取桿件數 ${state.selection.members.size}`);
  $("hud").textContent = `切交點(選取):新增 ${intersections} 個交點(選取保持為拆段後 ${state.selection.members.size} 條)`;
  render(); refreshLists();
}
function processIntersections() {
  pushUndo();
  const p = getPage();
  let changed = true, guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    outer:
    for (let i = 0; i < p.members.length; i++) {
      for (let k = i + 1; k < p.members.length; k++) {
        const m1 = p.members[i], m2 = p.members[k];
        const a = jointById(m1.j1), b = jointById(m1.j2);
        const c = jointById(m2.j1), d = jointById(m2.j2);
        const inter = segIntersect(a, b, c, d);
        if (!inter) continue;
        // skip if intersection is an existing endpoint
        const eps = 1e-3;
        const isEnd = (j) => Math.hypot(j.x - inter.x, j.y - inter.y) < eps;
        if (isEnd(a) || isEnd(b) || isEnd(c) || isEnd(d)) continue;
        const nj = ensureJointAt(inter);
        // split m1
        p.members.splice(i, 1);
        p.members.push({ id: nextMemberId++, j1: a.id, j2: nj.id });
        p.members.push({ id: nextMemberId++, j1: nj.id, j2: b.id });
        // remove m2 (its index might have shifted because we removed i first)
        const k2 = p.members.indexOf(m2);
        if (k2 !== -1) p.members.splice(k2, 1);
        p.members.push({ id: nextMemberId++, j1: c.id, j2: nj.id });
        p.members.push({ id: nextMemberId++, j1: nj.id, j2: d.id });
        changed = true;
        break outer;
      }
    }
  }
  // T 形:某條桿件的端點落在另一條桿件中段(共線且夾在兩端之間)→ 拆桿
  splitMembersAtCollinearJoints();
  render(); refreshLists();
}

function segIntersect(p1, p2, p3, p4) {
  const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y,x3=p3.x,y3=p3.y,x4=p4.x,y4=p4.y;
  const denom = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / denom;
  const u = -((x1-x2)*(y1-y3) - (y1-y2)*(x1-x3)) / denom;
  const eps = 1e-6;
  if (t < eps || t > 1-eps || u < eps || u > 1-eps) return null;
  return { x: x1 + t*(x2-x1), y: y1 + t*(y2-y1) };
}
// 無線段邊界版:回傳「兩條無限延伸直線」的交點 + 各自的 t / u 參數。
// 平行(denom 太小)回傳 null。caller 自己決定接受多少延伸範圍。
function lineLineIntersect(p1, p2, p3, p4) {
  const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y,x3=p3.x,y3=p3.y,x4=p4.x,y4=p4.y;
  const denom = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / denom;
  const u = -((x1-x2)*(y1-y3) - (y1-y2)*(x1-x3)) / denom;
  return { x: x1 + t*(x2-x1), y: y1 + t*(y2-y1), t, u };
}

// 整理(in-place):確保節點不重複位置、桿件不重複,並把共線重疊或內部含節點的桿件拆段
//   不會 pushUndo / render / refreshLists,可由其他操作呼叫以共用清理邏輯
//   1) 合併同位置節點(緊容差 epsJ);把所有桿件端點重新指向倖存節點
//   2) 移除零長 / 重複桿件
//   3) 對每條桿件:若有第三節點落在其內部且共線(緊容差 epsC),於該節點處拆段
//      → 共線重疊的桿件會自動分解到共同端點上
//   4) 拆段後再次去重(共線重疊段在拆完後會與另一條桿件對到同一對端點)
function _consolidateInPlace() {
  const p = getPage();
  if (!p || p._orphan) return { mergedJ: 0, droppedM: 0, splitM: 0 };
  const epsJ = 0.5;        // 節點同位容差(世界座標 / 像素)
  const epsC = 0.5;        // 共線判定的垂直容差
  let mergedJ = 0, droppedM = 0, splitM = 0;

  // Pass 1:合併同位置節點
  const remap = new Map();
  const kept  = [];
  for (const j of p.joints) {
    let merged = null;
    for (const k of kept) {
      if (Math.hypot(k.x - j.x, k.y - j.y) < epsJ) { merged = k; break; }
    }
    if (merged) { remap.set(j.id, merged.id); mergedJ++; }
    else        { kept.push(j); remap.set(j.id, j.id); }
  }
  p.joints = kept;
  for (const m of p.members) {
    m.j1 = remap.get(m.j1) ?? m.j1;
    m.j2 = remap.get(m.j2) ?? m.j2;
  }

  // Pass 2:零長 / 重複桿件
  const dedupKey = (m) => m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`;
  {
    const seen = new Set();
    p.members = p.members.filter(m => {
      if (m.j1 === m.j2) { droppedM++; return false; }
      const k = dedupKey(m);
      if (seen.has(k)) { droppedM++; return false; }
      seen.add(k); return true;
    });
  }

  // Pass 3:在共線內部節點處拆段;迭代到穩定
  let changed = true, guard = 0;
  while (changed && guard++ < 500) {
    changed = false;
    outer:
    for (let i = 0; i < p.members.length; i++) {
      const m = p.members[i];
      const a = jointById(m.j1), b = jointById(m.j2);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < epsJ * epsJ) continue;
      const len = Math.sqrt(lenSq);
      for (const j of p.joints) {
        if (j.id === a.id || j.id === b.id) continue;
        // 垂直距離(共線)
        const cross = Math.abs((j.x - a.x) * dy - (j.y - a.y) * dx);
        if (cross / len > epsC) continue;
        // 投影參數,需在 (0, 1) 內(避免端點)
        const t = ((j.x - a.x) * dx + (j.y - a.y) * dy) / lenSq;
        const tEdge = epsJ / len;
        if (t < tEdge || t > 1 - tEdge) continue;
        // 拆段
        p.members.splice(i, 1);
        const exA = p.members.some(mm => (mm.j1 === a.id && mm.j2 === j.id) || (mm.j1 === j.id && mm.j2 === a.id));
        const exB = p.members.some(mm => (mm.j1 === j.id && mm.j2 === b.id) || (mm.j1 === b.id && mm.j2 === j.id));
        if (!exA) { p.members.push({ id: nextMemberId++, j1: a.id, j2: j.id }); splitM++; }
        if (!exB) { p.members.push({ id: nextMemberId++, j1: j.id, j2: b.id }); splitM++; }
        changed = true;
        break outer;
      }
    }
  }

  // Pass 4:再次去重(共線重疊拆完後會出現相同端點對)
  {
    const seen = new Set();
    p.members = p.members.filter(m => {
      if (m.j1 === m.j2) { droppedM++; return false; }
      const k = dedupKey(m);
      if (seen.has(k)) { droppedM++; return false; }
      seen.add(k); return true;
    });
  }

  // Pass 5:把節點吸到底圖線端點 / 交點(若 bgSnapTolerance > 0)
  //   依賴 page._bgSegsCache(activatePage 後填入)+ snapToBgVertex helper(返回端點 / 兩段交點)
  //   只在偏差 < tol 時移動;移動後可能 Pass 1 同位置合併沒抓到的節點變同位,但因為這已是最後一步,不再二次合併
  let snappedJ = 0;
  const bgTol = Math.max(0, Number(state.bgSnapTolerance) || 0);
  if (bgTol > 0 && Array.isArray(p._bgSegsCache) && p._bgSegsCache.length && typeof snapToBgVertex === "function") {
    for (const j of p.joints) {
      const hit = snapToBgVertex({ x: j.x, y: j.y }, { radius: bgTol });
      if (!hit) continue;
      const d = Math.hypot(hit.x - j.x, hit.y - j.y);
      if (d > 0 && d <= bgTol) {
        j.x = hit.x; j.y = hit.y;
        snappedJ++;
      }
    }
  }

  // 清掉已不存在的選取
  state.selection.joints  = new Set([...state.selection.joints ].filter(id => p.joints .some(j => j.id === id)));
  state.selection.members = new Set([...state.selection.members].filter(id => p.members.some(m => m.id === id)));

  return { mergedJ, droppedM, splitM, snappedJ };
}

// 是否從節點 j 已經有「在 (dx,dy) 方向」的桿件:用來阻擋會造成重疊的延伸
//   - 共線(垂直距離 ≈ 0)
//   - 同向(向量點積 > 0)
function jointHasCollinearMemberInDirection(j, dx, dy) {
  const p = getPage();
  if (!p || p._orphan) return false;
  const eps = 1e-3;
  const len = Math.hypot(dx, dy);
  if (len < eps) return false;
  const ux = dx / len, uy = dy / len;
  for (const m of p.members) {
    let other = null;
    if      (m.j1 === j.id) other = jointById(m.j2);
    else if (m.j2 === j.id) other = jointById(m.j1);
    if (!other) continue;
    const vx = other.x - j.x, vy = other.y - j.y;
    const vlen = Math.hypot(vx, vy);
    if (vlen < eps) continue;
    const cross = Math.abs(vx * uy - vy * ux);     // 共線判定:垂直距離
    if (cross > 0.5) continue;                      // 與 epsC 一致(0.5 px / world unit)
    const dot = vx * ux + vy * uy;                  // 同向判定
    if (dot > eps) return true;
  }
  return false;
}

function consolidateGeometry() {
  const p = getPage();
  if (!p || p._orphan) { alert("尚未載入底圖頁面"); return; }
  pushUndo();
  const r = _consolidateInPlace();
  console.log(`[整理] 合併節點 ${r.mergedJ} ・ 移除桿件 ${r.droppedM} ・ 新拆桿件 ${r.splitM}`);
  render(); refreshLists();
}

// 重排編號:依「列」(同 x 群組)分組,同列內由下而上(畫面 y 由大到小)從 base 起每節點 +1。
//   下一列的起始 = 上一列最大編號「進位到下一個百位」 + 1
//   例:列 1 含 4 個節點 → 1..4;列 2 從 101 開始 → 101..N;若列 2 結束於 235,列 3 從 301 開始
//   桿件依端點順序連續從 1 起重編。
//
// 對單一 page 套重排核心邏輯(joints + members 都重編)。回傳 {jointGroups, finalMax} 或 null。
// 不包含 pushUndo / render / refreshLists / 計數器同步,呼叫端負責。
function _relayoutPageCore(p, opts) {
  if (!p || p._orphan || !p.joints || !p.joints.length) return null;
  opts = opts || {};
  const interactive = opts.interactive !== false;
  const origin = opts.origin || null;            // 若有,起始點以原點 projection 為準,wrap-around 另一頭
  const membersOnly = !!opts.membersOnly;        // 只重編桿件 ID(節點 ID 保持不動)
  // 跨頁累加用:外部傳入桿件起始基底(預設 1);回傳的 maxMemberId 給下一頁繼承
  const memberStartBase = (Number.isFinite(opts.memberStartBase) && opts.memberStartBase >= 1)
    ? Math.floor(opts.memberStartBase) : 1;
  const tolGroup = 2;
  // 樑分群用較寬的容差 — 同一排樑的中點(midY for X 軸 / midX for Z 軸)在 CAD 模型常有
  //   數十毫米的飄移(連接細件、cap plate、anchor bolt 等位置略偏移),tolGroup=2 太緊會把
  //   同排切成 N 個小群 → gi 暴增 → 編號 2501 → 5801 跳號。用 500mm 容差合併同排。
  const tolBeamRow = 500;
  const cap = Math.max(10, state.relayoutCapacity || 100);
  const isVertical = state.relayoutDirection !== "horizontal";
  const nextBaseAfter = (lastId) => (Math.floor(lastId / cap) + 1) * cap + 1;
  const groupItems = (items, getMain, getSub, tol, subDesc, mainDesc) => {
    const sorted = [...items].sort((a, b) => getMain(a) - getMain(b));
    const groups = [];
    let cur = null, lastM = null;
    for (const it of sorted) {
      const m = getMain(it);
      if (cur === null || m - lastM > tol) { cur = []; groups.push(cur); }
      cur.push(it);
      lastM = m;
    }
    for (const g of groups) g.sort((a, b) => subDesc ? (getSub(b) - getSub(a)) : (getSub(a) - getSub(b)));
    return mainDesc ? groups.reverse() : groups;
  };
  // 把 array 旋轉:讓索引 idx 變第 0 位,前面被擠到尾巴(idx > 0 才旋轉;<=0 不動)
  const rotateAt = (arr, idx) => (idx <= 0 ? arr.slice() : arr.slice(idx).concat(arr.slice(0, idx)));
  // 找 array 中座標最接近 ref 值的索引
  const closestIdx = (arr, getCoord, ref) => {
    let bi = 0, bd = Infinity;
    for (let k = 0; k < arr.length; k++) {
      const d = Math.abs(getCoord(arr[k]) - ref);
      if (d < bd) { bd = d; bi = k; }
    }
    return bi;
  };
  // 用 origin 旋轉群陣列(外圈)+ 每群內部(內圈)
  //   mainCoord:原點在主軸的座標(isVertical → origin.x;水平 → origin.y)
  //   subCoord :原點在次軸的座標
  //   getMain / getSub:從 item 取主 / 次軸座標的 fn
  const applyOriginOrder = (groups, mainCoord, subCoord, getMain, getSub) => {
    if (origin == null) return groups;
    if (!groups.length) return groups;
    // 外圈:找哪一群的主軸座標最接近 origin.mainCoord
    //   每群至少 1 個 item,直接用 g[0] 的主軸值代表(因為同群主軸值一致)
    const outerIdx = closestIdx(groups, g => getMain(g[0]), mainCoord);
    const rotatedOuter = rotateAt(groups, outerIdx);
    // 內圈:對每群依次軸 origin.subCoord 旋轉
    return rotatedOuter.map(g => {
      const innerIdx = closestIdx(g, getSub, subCoord);
      return rotateAt(g, innerIdx);
    });
  };
  // 節點分群(membersOnly 模式下跳過)
  let jointGroups = [];
  let finalMax = 0;
  const oldToNew = new Map();
  if (!membersOnly) {
    if (isVertical) jointGroups = groupItems(p.joints, j => j.x, j => j.y, tolGroup, true, false);
    else            jointGroups = groupItems(p.joints, j => j.y, j => j.x, tolGroup, false, true);
    if (origin) {
      const mainCoord = isVertical ? origin.x : origin.y;
      const subCoord  = isVertical ? origin.y : origin.x;
      const getMain   = isVertical ? (j => j.x) : (j => j.y);
      const getSub    = isVertical ? (j => j.y) : (j => j.x);
      jointGroups = applyOriginOrder(jointGroups, mainCoord, subCoord, getMain, getSub);
    }
    const groupBases = [];
    let nextBase = 1;
    for (let c = 0; c < jointGroups.length; c++) {
      groupBases.push(nextBase);
      nextBase = nextBaseAfter(nextBase + jointGroups[c].length - 1);
    }
    finalMax = jointGroups.length
      ? groupBases[jointGroups.length - 1] + jointGroups[jointGroups.length - 1].length - 1 : 0;
    if (interactive && state.globalCapacity && finalMax > state.globalCapacity) {
      if (!confirm(`重排後最大內部編號 ${finalMax} 已超過全域容量 ${state.globalCapacity},仍要繼續?`)) return null;
    }
    for (let c = 0; c < jointGroups.length; c++) {
      const base = groupBases[c];
      for (let r = 0; r < jointGroups[c].length; r++) oldToNew.set(jointGroups[c][r].id, base + r);
    }
    for (const j of p.joints) j.id = oldToNew.get(j.id);
    for (const m of p.members) {
      m.j1 = oldToNew.get(m.j1) ?? m.j1;
      m.j2 = oldToNew.get(m.j2) ?? m.j2;
    }
  }
  // 桿件三相位 + 進位 — 用 page-local joint lookup,不依賴 active page
  //   分類門檻改為「比例容忍」(角度容忍):dx / len < 0.05 ≈ 與軸夾角 < 3° → 視為平行軸
  //   舊版用絕對 mm(eps=0.5):柱身節點若有 ≥ 0.5mm 漂移就被誤判成斜撐,造成同一柱段 ID 跳號
  const angleTol = 0.05;   // ≈ 3° 容忍
  const eps = 0.5;          // 同位節點(dx≈dy≈0)排除用
  const jointMap = new Map(p.joints.map(j => [j.id, j]));
  const memMid = (m) => {
    const a = jointMap.get(m.j1), b = jointMap.get(m.j2);
    if (!a || !b) return null;
    return { m, midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2,
             dx: Math.abs(a.x - b.x), dy: Math.abs(a.y - b.y) };
  };
  const horizontalsM = [], verticalsM = [], diagonalsM = [];
  for (const m of p.members) {
    const w = memMid(m); if (!w) continue;
    const len = Math.hypot(w.dx, w.dy);
    if (len < eps) continue;   // 同位節點 / 太短
    const dxRatio = w.dx / len;
    const dyRatio = w.dy / len;
    if (dyRatio < angleTol) horizontalsM.push(w);     // 幾乎平行 2D X 軸(水平)
    else if (dxRatio < angleTol) verticalsM.push(w);  // 幾乎平行 2D Y 軸(垂直 — 柱)
    else diagonalsM.push(w);                          // 斜撐
  }
  const groupForDir = (items) => {
    const groups = isVertical
      ? groupItems(items, it => it.midX, it => it.midY, tolGroup, true, false)
      : groupItems(items, it => it.midY, it => it.midX, tolGroup, false, true);
    if (!origin) return groups;
    const mainCoord = isVertical ? origin.x : origin.y;
    const subCoord  = isVertical ? origin.y : origin.x;
    const getMain   = isVertical ? (it => it.midX) : (it => it.midY);
    const getSub    = isVertical ? (it => it.midY) : (it => it.midX);
    return applyOriginOrder(groups, mainCoord, subCoord, getMain, getSub);
  };
  // 拓樸分群:同方向 member 共享 joint → 同一根「連續桿件」(柱 / 樑)
  //   解決:midpoint X 分群會被 joint X 漂移破壞;改用 union-find 不受幾何誤差影響
  const groupConnectedByJoint = (items, isVerticalDir) => {
    if (!items.length) return [];
    const parent = new Map(), rank = new Map();
    const makeSet = (id) => { if (!parent.has(id)) { parent.set(id, id); rank.set(id, 0); } };
    const find = (id) => {
      while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
      return id;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      const sa = rank.get(ra), sb = rank.get(rb);
      if (sa < sb) parent.set(ra, rb);
      else if (sa > sb) parent.set(rb, ra);
      else { parent.set(rb, ra); rank.set(ra, sa + 1); }
    };
    const jointToMembers = new Map();
    for (const it of items) {
      makeSet(it.m.id);
      for (const jid of [it.m.j1, it.m.j2]) {
        if (!jointToMembers.has(jid)) jointToMembers.set(jid, []);
        jointToMembers.get(jid).push(it.m.id);
      }
    }
    for (const arr of jointToMembers.values()) {
      if (arr.length < 2) continue;
      for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    }
    const groupMap = new Map();
    for (const it of items) {
      const r = find(it.m.id);
      if (!groupMap.has(r)) groupMap.set(r, []);
      groupMap.get(r).push(it);
    }
    // 每群內依「沿軸方向」排序(垂直 → 由下而上;水平 → 由左到右)
    //   SVG y 向下,DESC = 高 y = 下方 → 由下而上 = midY DESC
    for (const g of groupMap.values()) {
      if (isVerticalDir) g.sort((a, b) => b.midY - a.midY);
      else g.sort((a, b) => a.midX - b.midX);
    }
    const groups = [...groupMap.values()];
    // 群之間排序(離原點近的先)
    if (origin) {
      const ox = origin.x, oy = origin.y;
      groups.sort((g1, g2) => {
        const c1 = isVerticalDir ? g1[0].midX : g1[0].midY;
        const c2 = isVerticalDir ? g2[0].midX : g2[0].midY;
        const ref = isVerticalDir ? ox : oy;
        return Math.abs(c1 - ref) - Math.abs(c2 - ref);
      });
    } else {
      groups.sort((g1, g2) => {
        const c1 = isVerticalDir ? g1[0].midX : g1[0].midY;
        const c2 = isVerticalDir ? g2[0].midX : g2[0].midY;
        return c1 - c2;
      });
    }
    return groups;
  };
  // 斜撐分群:依「桿件所在 2D 線」(slope + perpendicular offset)
  //   同一條連續斜撐的多個 segment 會共享同一條線 → 編號連續(整條完整 → 下一條)
  const groupForDiag = (items) => {
    const eps = 2;   // perp offset bucket 寬度
    // 對每條 member 算 line key
    const keyed = items.map(mi => {
      const a = jointMap.get(mi.m.j1), b = jointMap.get(mi.m.j2);
      if (!a || !b) return null;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) return null;
      // 方向單位向量(canonicalize:ux > 0 或 ux=0, uy > 0)
      let ux = dx / len, uy = dy / len;
      if (ux < -1e-6 || (Math.abs(ux) < 1e-6 && uy < 0)) { ux = -ux; uy = -uy; }
      // 從 a 點往垂直方向投影:perp = -a.x * uy + a.y * ux (signed)
      const perp = -a.x * uy + a.y * ux;
      const perpKey = Math.round(perp / eps) * eps;
      // slope key:單位方向 round 到 3 decimal,避免浮點抖動
      const slopeKey = `${ux.toFixed(3)},${uy.toFixed(3)}`;
      // 沿線方向位置:t = a.x*ux + a.y*uy(用 midpoint 計算更穩定)
      const tParam = mi.midX * ux + mi.midY * uy;
      return { mi, lineKey: `${slopeKey}|${perpKey}`, perpKey, tParam, ux, uy };
    }).filter(Boolean);
    // 依 lineKey 分群
    const lineGroups = new Map();
    for (const k of keyed) {
      if (!lineGroups.has(k.lineKey)) lineGroups.set(k.lineKey, []);
      lineGroups.get(k.lineKey).push(k);
    }
    // 同線內依 tParam 排序(沿線從一端走到另一端,連續編號)
    const groups = [];
    for (const arr of lineGroups.values()) {
      arr.sort((a, b) => a.tParam - b.tParam);
      groups.push(arr.map(k => k.mi));
    }
    // 群之間依「離原點最近的 perp 距離」排序 — 靠近原點的線先編
    if (origin) {
      const ox = origin.x, oy = origin.y;
      groups.sort((g1, g2) => {
        const k1 = keyed.find(k => k.mi === g1[0]);
        const k2 = keyed.find(k => k.mi === g2[0]);
        if (!k1 || !k2) return 0;
        // 線到原點的 perp 距離:|perp - (-ox*uy + oy*ux)| 但 perp 是從世界 (0,0) 算的
        // 直接用 perp 排:距離 (0,0) 較近的先
        const d1 = Math.abs(k1.perpKey - (-ox * k1.uy + oy * k1.ux));
        const d2 = Math.abs(k2.perpKey - (-ox * k2.uy + oy * k2.ux));
        return d1 - d2;
      });
    } else {
      // 沒原點 → 依 perpKey 升序
      groups.sort((g1, g2) => {
        const k1 = keyed.find(k => k.mi === g1[0]);
        const k2 = keyed.find(k => k.mi === g2[0]);
        return (k1 ? k1.perpKey : 0) - (k2 ? k2.perpKey : 0);
      });
    }
    return groups;
  };
  // 分群策略(視 plane 不同):
  //   • horizontals(2D 水平樑):一律按「midY 分群」 — 同排樑 midY 一致 → 同群
  //     ⚠ 不能用 groupForDir():它依外層 isVertical 反向取軸 → 每根樑自成一群 → gi 暴增、編號跳號
  //   • verticals(2D 垂直):
  //       - XY / YZ 頁面 → 真正的 Y 軸柱,用拓樸(共享 joint)整合多段微漂移的柱身
  //       - XZ 頁面     → 其實是 Z 軸樑(平面圖縱樑),要用「midX 分群」才不會被切碎
  //   • D(斜撐):用「同線(slope + perp)」分群,連續斜撐一條線會合成一群
  const _groupHorizByMidY = (items) => {
    // 同排樑用 midY 分群、群內 midX 升序;群序 midY 升序(預設;有 origin 時依離原點近的優先)
    //   tol 用 tolBeamRow(500mm)而不是 tolGroup(2mm),避免同排細件位置略飄移而切碎
    let groups = groupItems(items, it => it.midY, it => it.midX, tolBeamRow, false, false);
    if (origin) {
      groups = applyOriginOrder(groups, origin.y, origin.x, it => it.midY, it => it.midX);
    }
    return groups;
  };
  const _groupVertByMidX = (items) => {
    // 同列樑用 midX 分群、群內 midY 降序(上往下);群序 midX 升序;tol 同上
    let groups = groupItems(items, it => it.midX, it => it.midY, tolBeamRow, true, false);
    if (origin) {
      groups = applyOriginOrder(groups, origin.x, origin.y, it => it.midX, it => it.midY);
    }
    return groups;
  };
  const _isXZPage = (p.plane === "XZ");
  const hGroups = _groupHorizByMidY(horizontalsM);            // X / Z 軸樑:midY 分群
  const vGroups = _isXZPage
    ? _groupVertByMidX(verticalsM)                            // XZ 頁的 verticals = Z 軸樑 → midX 分群
    : groupConnectedByJoint(verticalsM, true);                // XY / YZ 頁的 verticals = Y 軸柱 → topology
  const dGroups = groupForDiag(diagonalsM);
  const memOldToNew = new Map();
  // 桿件編號(全局 cap 版):各方向使用自己的 cap(state.memberCapY/X/Z/Diag,預設 99)
  //   每個方向用 group_idx * mult + pos(pos 從 0 起):
  //     gi=0,pi=0 → startBase
  //     gi=0,pi=1 → startBase+1
  //     gi=1,pi=0 → startBase + mult
  //     gi=1,pi=1 → startBase + mult + 1
  //   mult = cap + 1(cap=99 → 100,符合 XX·YY 格式)
  //   每換方向 → startBase 進位到下一個「0 整位」+ 1(199→201,8859→9001)
  //
  //   依 plane 決定 2D「水平 / 垂直」對應哪個真實軸,以及處理順序:
  //     XY:vGroups = Y 軸,hGroups = X 軸,dGroups = 斜 → 順序 Y → X → 斜
  //     YZ:vGroups = Y 軸,hGroups = Z 軸,dGroups = 斜 → 順序 Y → Z → 斜
  //     XZ:vGroups = Z 軸,hGroups = X 軸,dGroups = 斜 → 順序 X → Z → 斜
  const plane = p.plane || "XY";
  const catGroups = {};
  if (plane === "XY") { catGroups.Y = vGroups; catGroups.X = hGroups; catGroups.D = dGroups; }
  else if (plane === "YZ") { catGroups.Y = vGroups; catGroups.Z = hGroups; catGroups.D = dGroups; }
  else { catGroups.X = hGroups; catGroups.Z = vGroups; catGroups.D = dGroups; }
  const catCap = {
    Y: state.memberCapY || 99,
    X: state.memberCapX || 99,
    Z: state.memberCapZ || 99,
    D: state.memberCapDiag || 99,
  };
  const orderByPlane = {
    "XY": ["Y", "X", "D"],
    "YZ": ["Y", "Z", "D"],
    "XZ": ["X", "Z", "D"],
  };
  const phaseOrder = orderByPlane[plane] || ["Y", "X", "Z", "D"];
  // 進位:n 的最高位 +1,後面歸 0,再 +1(例 199→201、8859→9001)
  // 換 phase 進位:跟當前 phase 的 mult 對齊(線性,避免 digit-based 指數成長)
  //   nextZeroBoundary(n, mult) → 下一個 mult 倍數 +1
  const nextZeroBoundary = (n, m) => {
    if (!Number.isFinite(n) || n <= 0) return 1;
    const step = m && m >= 2 ? m : 100;
    return (Math.floor(n / step) + 1) * step + 1;
  };
  // 跨頁累加用:每個 cat(Y / X / Z / D)有自己獨立的 startBase。
  //   讓「X 軸跨頁連續走 100-block」、「Y 軸跨頁連續走」等需求成立,不會因為某頁 Y 群多
  //   把下一頁 X 推高。catStartBase 由 caller 傳入(opts.catStartBase),內部回傳 catMax。
  //
  //   opts.catStartBase: { Y, X, Z, D } — 每個 cat 的起始 ID
  //   opts.diagStartBase 仍接受(向下相容,等同 catStartBase.D)
  //   opts.memberStartBase 仍接受(向下相容;沒傳 catStartBase 時 Y/X/Z 共用此 base)
  const _catStartBaseIn = (opts.catStartBase && typeof opts.catStartBase === "object") ? opts.catStartBase : null;
  const diagStartBase = (Number.isFinite(opts.diagStartBase) && opts.diagStartBase >= 1)
    ? Math.floor(opts.diagStartBase) : null;
  const _catBase = (cat) => {
    if (_catStartBaseIn && Number.isFinite(_catStartBaseIn[cat]) && _catStartBaseIn[cat] >= 1) {
      return Math.floor(_catStartBaseIn[cat]);
    }
    if (cat === "D" && diagStartBase != null) return diagStartBase;
    return memberStartBase;   // fallback:跟原本同序列
  };
  // 每個 cat 跑完後在此頁內推進,跨 cat 之間用 nextZeroBoundary 對齊 mult
  const _catRunStart = { Y: _catBase("Y"), X: _catBase("X"), Z: _catBase("Z"), D: _catBase("D") };
  const catMax = { Y: 0, X: 0, Z: 0, D: 0 };
  let startBase = memberStartBase;    // 保留向下相容(若沒走 per-cat 模式)
  let lastMaxId = 0;
  let lastDiagMaxId = 0;
  // phaseOnly:caller 可指定本次只處理單一 cat("Y" / "X" / "Z" / "D"),其他 cat 跳過。
  //   讓上層做「Pass 1: Y → Pass 2: X → Pass 3: Z → Pass 4: D」的 4 階段獨立累加。
  //   各階段邏輯互不干擾 — 改 X 邏輯不影響 Y 已產出的結果。
  const phaseOnly = opts.phaseOnly || null;
  const _shouldProcess = (cat) => !phaseOnly || phaseOnly === cat;

  // 統一的 cat-by-cat 處理(所有 plane 都走這條;沒有特殊的 XZ band 邏輯)
  //   每個 cat 用自己的 runStart(catStartBase[cat]),處理完後在此頁內推進。
  //   phaseOnly 設定時只跑該 cat,其他全部跳過 → memOldToNew 只裝該 cat 的 mapping,
  //   不影響其他 cat 在這頁已有的 m.id。
  for (const cat of phaseOrder) {
    if (!_shouldProcess(cat)) continue;
    const groups = catGroups[cat] || [];
    if (!groups.length) continue;
    const cap = catCap[cat];
    const mult = cap + 1;
    const useStartBase = _catRunStart[cat];
    let phaseMax = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      for (let pi = 0; pi < g.length; pi++) {
        const id = useStartBase + gi * mult + pi;
        memOldToNew.set(g[pi].m.id, id);
        if (id > phaseMax) phaseMax = id;
      }
    }
    if (phaseMax > catMax[cat]) catMax[cat] = phaseMax;
    _catRunStart[cat] = nextZeroBoundary(phaseMax, mult);
  }
  lastMaxId = Math.max(catMax.Y, catMax.X, catMax.Z);
  lastDiagMaxId = catMax.D;
  const _pageMaxMainMemberId = lastMaxId;
  const _pageMaxDiagMemberId = lastDiagMaxId;
  const _pageMaxMemberId = Math.max(lastMaxId, lastDiagMaxId);
  for (const m of p.members) {
    const nid = memOldToNew.get(m.id);
    if (nid != null) m.id = nid;
  }
  p.members.sort((a, b) => a.id - b.id);
  // 同步全域計數器(只往大跳)
  let maxJ = 0; for (const j of p.joints) if (j.id > maxJ) maxJ = j.id;
  let maxM = 0; for (const m of p.members) if (m.id > maxM) maxM = m.id;
  if (maxJ + 1 > nextJointId)  nextJointId  = maxJ + 1;
  if (maxM + 1 > nextMemberId) nextMemberId = maxM + 1;
  return { jointGroups: jointGroups.length, finalMax, joints: p.joints.length, members: p.members.length,
           hGroups: hGroups.length, vGroups: vGroups.length, dGroups: dGroups.length,
           oldToNew, memOldToNew,
           maxMemberId: _pageMaxMemberId,
           maxMainMemberId: _pageMaxMainMemberId,
           maxDiagMemberId: _pageMaxDiagMemberId,
           catMax };
}
// 進位到下一個 mult 邊界 + 1 — 跨頁累加 startBase 用
//   舊版用「位數最高位 +1」(digit-based)會造成指數成長:99→101→201→...→1001→2001→...→10001→...
//     每次跨位數 ×10,55 頁 × 4 次呼叫就會炸到 10^17。
//   新版用「最大 cap 對齊的 mult」固定步進(cap=9999 → mult=10000):
//     199 → 201、8859 → 8901、99999 → 100001(線性,~50 倍頁面)。
function _nextMemberZeroBoundary(n) {
  if (!Number.isFinite(n) || n <= 0) return 1;
  // 用 4 個 cap 中的最大值 +1 當 mult,確保所有方向 phase 的 id 範圍夠用
  const caps = [
    state.memberCapY || 99,
    state.memberCapX || 99,
    state.memberCapZ || 99,
    state.memberCapDiag || 99,
  ];
  const mult = Math.max(...caps) + 1;
  return (Math.floor(n / mult) + 1) * mult + 1;
}

async function relayoutNumbering() {
  const p = getPage();
  if (!p || p._orphan) { alert("尚未載入底圖頁面"); return; }
  const file = getActiveFile();
  if (typeof setBusyMessage === "function") setBusyMessage(`編排節點編號 — pushUndo 中…`);
  pushUndo();
  // 切面節點/桿件推斷:在重編號之前,先針對 active file 的所有切面線(主關聯 + 衍生),
  //   依「XZ → XY → YZ」順序從其他檔案投影 joints/members 到本檔的切面線上;
  //   F 設定不全或單條切面缺資料 → 跳過該條/該檔。
  //   _populateSectionLinkJointsForFile 是 async,必須 await 才能拿到 stats(不然 slStats 是 Promise)
  let slStats = null;
  if (file && _fileHasFullSetup(file) && state.pageIdx === 0) {
    if (typeof setBusyMessage === "function") setBusyMessage(`切面節點/桿件推斷中…(${file.name})`);
    try { slStats = await _populateSectionLinkJointsForFile(file); }
    catch (e) { console.warn("[切面節點推斷] 失敗", e); slStats = null; }
  }
  if (typeof setBusyMessage === "function") setBusyMessage(`重排當頁編號中…(${p.joints.length} 節點 / ${p.members.length} 桿件)`);
  if (!p.joints.length) {
    if (slStats && (slStats.jointsAdded || slStats.membersAdded)) {
      // 推斷有結果但本來無節點 → 不能跑核心 relayout(空頁直接 render)
      console.log(`[切面節點推斷] 處理 ${slStats.processedLinks} 條切面・新增節點 ${slStats.jointsAdded}・桿件 ${slStats.membersAdded}`);
    } else {
      alert("此頁尚無節點"); return;
    }
  }
  const r = (p.joints.length > 0)
    ? _relayoutPageCore(p, { interactive: true, origin: (file && file.planeOrigin) || null })
    : null;
  if (r) {
    // 同步 active page 上的選取與 pendingLineStart
    state.selection.joints  = new Set([...state.selection.joints ].map(id => r.oldToNew.get(id) ?? id).filter(id => p.joints.some(j => j.id === id)));
    state.selection.members = new Set([...state.selection.members].map(id => r.memOldToNew.get(id) ?? id).filter(id => p.members.some(m => m.id === id)));
    if (typeof state.pendingLineStart === "number") {
      state.pendingLineStart = r.oldToNew.get(state.pendingLineStart) ?? null;
    }
    console.log(`[重排編號] 方向=${state.relayoutDirection}・節點群 ${r.jointGroups}・節點 ${r.joints}(最大內部 ${r.finalMax})・桿件 ${r.members}・桿件群 H${r.hGroups}+V${r.vGroups}+D${r.dGroups}`);
    // hud 確認(若下方 slStats 還有訊息,會被它覆寫)
    $("hud").textContent = `重排完成 ・ 節點 ${r.joints} 重編 ・ 桿件 ${r.members} 重編 ・ 最大內部編號 ${r.finalMax}`;
  } else {
    // _relayoutPageCore 回傳 null — 通常是空頁
    $("hud").textContent = `編排節點編號:此頁無節點可重編`;
  }
  if (slStats) {
    console.log(`[切面節點推斷] 處理 ${slStats.processedLinks} 條切面・新增節點 ${slStats.jointsAdded}・桿件 ${slStats.membersAdded}・略過 ${slStats.skipped}` +
      (slStats.conflicts.length ? `・衝突 ${slStats.conflicts.length} 件` : ""));
    if (slStats.conflicts.length) {
      slStats.conflicts.forEach(c => console.warn("[切面衝突]", c));
      const head = slStats.conflicts.slice(0, 5).join("\n");
      const more = slStats.conflicts.length > 5 ? `\n…(共 ${slStats.conflicts.length} 件,詳見 console)` : "";
      $("hud").textContent = `重排完成・推斷節點 ${slStats.jointsAdded}、桿件 ${slStats.membersAdded}・⚠ 多平行切面衝突 ${slStats.conflicts.length} 件`;
      alert(`偵測到多平行切面衝突:\n\n${head}${more}`);
    } else if (slStats.jointsAdded || slStats.membersAdded) {
      $("hud").textContent = `重排完成・切面新增節點 ${slStats.jointsAdded}、桿件 ${slStats.membersAdded}`;
    }
  }
  render(); refreshLists();
}

// 全局重排:逐頁套用同樣邏輯
export async function relayoutNumberingAll(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  let totalPages = 0;
  for (const f of state.files) {
    for (const k in (f.pages || {})) totalPages++;
  }
  if (!totalPages) { if (!skipConfirm) alert("沒有任何頁面可重排。"); return; }
  if (!skipConfirm && !confirm(`將對全部 ${state.files.length} 個檔案、共 ${totalPages} 個頁面逐頁重排編號。\n\n各頁的節點 / 桿件編號獨立(每頁從 1 開始)。\n建議搭配每頁的「本頁數字」設定避免全域重複。\n\n要繼續嗎?`)) return;
  pushUndo();
  // 起手:先綁定 globalMember + 清同頁重複桿件(避免編號被髒資料污染)
  const preBind = (typeof autoBindGlobalMembers === "function") ? autoBindGlobalMembers() : null;
  const preDedup = dedupSamePageMembers();
  if (preBind || preDedup.dupRemoved || preDedup.zeroLen) {
    console.log(`[全局重排編號] 前置清理 ・ globalMember 新建 ${preBind ? preBind.created : 0} / 綁定 ${preBind ? preBind.bound : 0} ・ 同頁去重 ${preDedup.dupRemoved}(零長 ${preDedup.zeroLen}, 影響 ${preDedup.pagesTouched} 頁)`);
  }
  let ok = 0, skipped = 0, processed = 0;
  showBusyWithCancel && showBusyWithCancel(`編排節點編號(全部頁面) 準備中…(共 ${totalPages} 頁)`, () => {});
  await (typeof busyTick === "function" ? busyTick() : Promise.resolve());
  // 平面處理順序:XY > YZ > XZ(每個 plane 集合內維持檔案 / 頁面原順序)
  const planeOrder = { "XY": 0, "YZ": 1, "XZ": 2 };
  const tasks = [];
  for (const f of state.files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      const order = planeOrder[pg && pg.plane] ?? 99;
      tasks.push({ f, pg, k, order });
    }
  }
  // stable sort:按 plane 順序,同 plane 內保持原順序
  tasks.sort((a, b) => a.order - b.order);
  // 跨頁累加桿件 startBase:每頁結束後用 _nextMemberZeroBoundary 進位 → 下一頁繼續編
  let memberStartBase = 1;
  let lastMemberMax = 0;
  for (const t of tasks) {
    processed++;
    if (typeof setBusyMessage === "function") setBusyMessage(`編排節點編號 ${processed}/${totalPages}・${t.f.name}・頁 ${t.k}・${t.pg.plane || "?"}・桿件起始 ${memberStartBase}`);
    await (typeof busyTick === "function" ? busyTick() : Promise.resolve());
    const r = _relayoutPageCore(t.pg, {
      interactive: false,
      origin: t.f.planeOrigin || null,
      memberStartBase,
    });
    if (r) {
      ok++;
      if (Number.isFinite(r.maxMemberId) && r.maxMemberId > 0) {
        lastMemberMax = r.maxMemberId;
        memberStartBase = _nextMemberZeroBoundary(r.maxMemberId);
      }
    } else skipped++;
  }
  if (typeof hideBusy === "function") hideBusy();
  state.selection.joints.clear();
  state.selection.members.clear();
  state.pendingLineStart = null;
  // 收尾:跨頁同物理桿件 ID 融合
  const unifyStats = unifyCrossPageMemberIds();
  if (unifyStats.gmsUnified || unifyStats.rewritten || unifyStats.conflicts) {
    console.log(`[全局重排編號] 跨頁融合 ・ gm ${unifyStats.gmsUnified} / 改寫 member ${unifyStats.rewritten}` +
      (unifyStats.conflicts ? ` / 衝突跳過 ${unifyStats.conflicts}` : ""));
  }
  console.log(`[全局重排編號] 完成 ${ok} 頁(略過空頁 ${skipped})・方向=${state.relayoutDirection}・cap=${state.relayoutCapacity}・桿件最終 max=${lastMemberMax}`);
  render(); refreshLists();
  if (!skipConfirm) alert(`全局重排編號完成:${ok} 頁已重編,${skipped} 頁略過(無節點)。\n桿件最終 max=${lastMemberMax}・跨頁融合 gm ${unifyStats.gmsUnified} / member ${unifyStats.rewritten}` +
    (unifyStats.conflicts ? `・衝突跳過 ${unifyStats.conflicts}` : ""));
}

// === 只重排桿件編號(不動節點 ID)===
//   套用 Y > X > Z > 斜撐 順序,從 planeOrigin 開始遞增循環。
//   節點 ID 保持不動,桿件的 j1 / j2 仍指向同一個節點。
async function relayoutMembersNumbering() {
  const p = getPage();
  if (!p || p._orphan) { alert("尚未載入底圖頁面"); return; }
  const file = getActiveFile();
  if (typeof setBusyMessage === "function") setBusyMessage(`編排桿件編號 — pushUndo 中…`);
  pushUndo();
  if (typeof setBusyMessage === "function") setBusyMessage(`重排當頁桿件編號中…(${(p.members || []).length} 桿件)`);
  const r = _relayoutPageCore(p, {
    interactive: true,
    origin: (file && file.planeOrigin) || null,
    membersOnly: true,
  });
  if (r) {
    // 同步選取上的 member id 對應
    state.selection.members = new Set([...state.selection.members]
      .map(id => r.memOldToNew.get(id) ?? id)
      .filter(id => p.members.some(m => m.id === id)));
    console.log(`[重排桿件編號] 方向=${state.relayoutDirection}・桿件 ${r.members}・桿件群 H${r.hGroups}+V${r.vGroups}+D${r.dGroups}・plane=${p.plane}`);
    $("hud").textContent = `桿件編號完成 ・ ${r.members} 條重編(plane=${p.plane}・順序 ${p.plane === "XZ" ? "X→Z→斜" : "Y→" + (p.plane === "YZ" ? "Z" : "X") + "→斜"})`;
  } else {
    $("hud").textContent = `編排桿件編號:此頁無桿件可重編`;
  }
  render(); refreshLists();
}
export async function relayoutMembersNumberingAll(opts) {
  opts = opts || {};
  const skipConfirm = !!opts.skipConfirm;
  let totalPages = 0;
  for (const f of state.files) for (const k in (f.pages || {})) totalPages++;
  if (!totalPages) { if (!skipConfirm) alert("沒有任何頁面可重排。"); return; }
  if (!skipConfirm && !confirm(`對全部 ${state.files.length} 個檔案、共 ${totalPages} 個頁面逐頁重排桿件編號。\n節點 ID 不動。Ctrl+Z 可還原。要繼續嗎?`)) return;
  pushUndo();
  // 起手:先綁定 globalMember + 清同頁重複(保證後續單頁編號不受髒資料影響)
  const preBind = (typeof autoBindGlobalMembers === "function") ? autoBindGlobalMembers() : null;
  const preDedup = dedupSamePageMembers();
  if (preBind || preDedup.dupRemoved || preDedup.zeroLen) {
    console.log(`[全局重排桿件編號] 前置清理 ・ globalMember 新建 ${preBind ? preBind.created : 0} / 綁定 ${preBind ? preBind.bound : 0} ・ 同頁去重 ${preDedup.dupRemoved}(零長 ${preDedup.zeroLen}, 影響 ${preDedup.pagesTouched} 頁)`);
  }
  let ok = 0, skipped = 0, processed = 0;
  showBusyWithCancel && showBusyWithCancel(`編排桿件編號(全部頁面) 準備中…(共 ${totalPages} 頁)`, () => {});
  await busyTick();
  // Y 軸(柱)優先 — XY / YZ 立面頁有 Y phase,先讓那些頁面跑完 → Y-axis 拿低位 ID;之後才 XZ
  const planeOrder = { "XY": 0, "YZ": 1, "XZ": 2 };
  // 樓層類型優先序:用 yyStart 升序排;XZ 頁才看 pg.floorType,其他平面不分樓層型
  const ftOrderOf = (pg) => {
    if (!pg || pg.plane !== "XZ") return 0;
    const key = pg.floorType || "default";
    const t = (state.floorTypes || []).find(x => x.key === key);
    return (t && Number.isFinite(t.yyStart)) ? t.yyStart : 9999;
  };
  const tasks = [];
  for (const f of state.files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      tasks.push({
        f, pg, k,
        order: planeOrder[pg && pg.plane] ?? 99,
        ftOrder: ftOrderOf(pg),
        elev: (pg && Number.isFinite(pg.z)) ? pg.z : Infinity,
      });
    }
  }
  // XZ 頁排序:plane 先(XY → YZ → XZ),XZ 內部再按 floorType yyStart → elev → 檔名 → 頁索引;
  //   讓「同一樓層類型的所有 XZ 頁先處理完,再換下一個 type」這個順序成立。
  tasks.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.ftOrder !== b.ftOrder) return a.ftOrder - b.ftOrder;
    if (a.elev !== b.elev) return a.elev - b.elev;
    if (a.f.name !== b.f.name) return a.f.name.localeCompare(b.f.name);
    return (+a.k) - (+b.k);
  });
  // ★ 4 個獨立的 code block,順序依照 user 規定:
  //   Stage 1: Y 軸柱 (XY / YZ 頁面) — 用原始未修改的 Y 軸邏輯,從 1 起跑跨頁累加
  //   Stage 2: XZ 平面 page-by-page,每頁順序為 row(X)→ column(Z)→ brace(D);
  //            頁面排序:floorType yyStart 升序(default 最後)→ 同型內 elev 升序;
  //            X/Z 共用單一累加器(從 max(2501, Pass1_max+1) 起);D 用獨立累加器(100001+)
  //   Stage 3: YZ 平面 brace(D 桿件)— 跨頁 D 累加器接續 Stage 2 的 D
  //   Stage 4: XY 平面 brace(D 桿件)— 同上
  //   各階段完全獨立 — 改某階段邏輯不會影響其他階段。
  let lastMemberMax = 0;
  const phaseMax = { Y: 0, X: 0, Z: 0, D: 0 };

  // 單頁單 phase 的呼叫 helper
  const _renumOnePage = (pg, fileOrigin, phaseKey, startBase) => {
    return _relayoutPageCore(pg, {
      interactive: false,
      origin: fileOrigin || null,
      membersOnly: true,
      phaseOnly: phaseKey,
      catStartBase: { Y: startBase, X: startBase, Z: startBase, D: startBase },
    });
  };

  // ============================================================
  // Stage 1: Y 軸(柱)— ★ 全域處理,不依頁面 / floorType / 節點分桿件順序 ★
  //
  //   作法:
  //     1. 跨頁掃所有 XY / YZ 頁面的 Y 軸 member(2D vertical),投影到 3D world coords
  //     2. 用 globalMemberId 去重(沒 globalMemberId 的用 (x, y, z) 端點 key 去重)
  //     3. 把同一根物理柱的多段(同 worldX、同 worldZ,不同 worldY)合成 1 個 group
  //     4. 群按 (worldX 升序 → worldZ 升序)排序;群內按 worldY 升序(由下而上)排
  //     5. 序貫編號:gi=0 第 1 根柱,gi=1 第 2 根柱…,IDs 1..N、101..、201..
  //     6. 把編號寫回所有 page-local 副本(看 globalMemberId 或座標匹配)
  //
  //   優點:Y 軸編號完全跟頁面切割無關,同根柱 ID 連續,跨頁副本同步。
  // ============================================================
  {
    if (typeof setBusyMessage === "function") setBusyMessage(`[1/4] Y 軸(柱)— 全域收集 …`);
    await busyTick();
    // 步驟 1+2:掃 XY/YZ 頁的 Y 軸 member,投影 → 3D。用 globalMemberId 去重。
    type ColMember = { pageMembers: any[]; world: { x: number; y1: number; y2: number; z: number; midY: number } };
    const colMemberByGm = new Map<number, ColMember>();   // globalMemberId → 物理 member
    const colMemberAnon: ColMember[] = [];                 // 沒 globalMemberId 的 member(以座標 fallback)
    const angleTol = 0.05, eps = 0.5;
    for (const f of state.files) {
      const ratio = (f.scaleRuler && f.scaleRuler.ratio > 0) ? f.scaleRuler.ratio : (state.scale ? 1 / state.scale : 1);
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k]; if (!pg || pg._orphan) continue;
        if (pg.plane !== "XY" && pg.plane !== "YZ") continue;
        const jById = new Map(pg.joints.map(j => [j.id, j]));
        for (const m of pg.members) {
          const a = jById.get(m.j1), b = jById.get(m.j2);
          if (!a || !b) continue;
          const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
          const len = Math.hypot(dx, dy);
          if (len < eps) continue;
          if (dx / len >= angleTol) continue;   // 不是 2D vertical → 不是 Y 軸
          // 投影:joint2DToWorld3D 用該 page 的 plane/origin/ratio
          const wa = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(f, pg, a) : null;
          const wb = (typeof joint2DToWorld3D === "function") ? joint2DToWorld3D(f, pg, b) : null;
          if (!wa || !wb) continue;
          const wX = (wa.x + wb.x) / 2, wZ = (wa.z + wb.z) / 2;
          const y1 = Math.min(wa.y, wb.y), y2 = Math.max(wa.y, wb.y);
          const entry: ColMember = {
            pageMembers: [{ pg, m, file: f }],
            world: { x: wX, y1, y2, z: wZ, midY: (y1 + y2) / 2 },
          };
          if (m.globalMemberId != null) {
            const existing = colMemberByGm.get(m.globalMemberId);
            if (existing) existing.pageMembers.push({ pg, m, file: f });
            else colMemberByGm.set(m.globalMemberId, entry);
          } else {
            colMemberAnon.push(entry);
          }
        }
      }
    }
    const allColMembers: ColMember[] = [...colMemberByGm.values(), ...colMemberAnon];
    // 步驟 3:群組同根柱(同 worldX、同 worldZ,容差 2mm)
    const _rk = (v) => Math.round(v / 2) * 2;   // 2mm bucket
    const columnGroups = new Map<string, ColMember[]>();
    for (const cm of allColMembers) {
      const key = `${_rk(cm.world.x)}|${_rk(cm.world.z)}`;
      if (!columnGroups.has(key)) columnGroups.set(key, []);
      columnGroups.get(key)!.push(cm);
    }
    // 步驟 4:外圈群序按 worldZ 升序 → worldX 升序(同一 Z-rank 切片上的柱子先全部編完;
    //   讓畫面上「同一橫排 axis line」的柱子連續編號:第 1 根 = 1xx、第 2 根 = 2xx …)
    //   內圈按 worldY 升序(由下而上)排
    const sortedCols = [...columnGroups.values()].sort((g1, g2) => {
      const z1 = g1[0].world.z, z2 = g2[0].world.z;
      if (Math.abs(z1 - z2) > 1) return z1 - z2;
      return g1[0].world.x - g2[0].world.x;
    });
    for (const g of sortedCols) g.sort((a, b) => a.world.midY - b.world.midY);
    // 步驟 5+6:序貫編號,寫回 page-local m.id
    const cap = state.memberCapY || 99, mult = cap + 1;
    let curStart = 1;
    let i = 0;
    for (const g of sortedCols) {
      i++;
      if (typeof setBusyMessage === "function" && (i % 50 === 0 || i === sortedCols.length)) {
        setBusyMessage(`[1/4] Y 軸(柱)・編號中 ${i}/${sortedCols.length}・起始 ${curStart}`);
        await busyTick();
      }
      let phaseMaxLocal = 0;
      for (let pi = 0; pi < g.length; pi++) {
        const giOffset = Math.floor(pi / cap);
        const piIn = pi % cap;
        const newId = curStart + giOffset * mult + piIn;
        for (const pm of g[pi].pageMembers) {
          pm.m.id = newId;
        }
        if (newId > phaseMaxLocal) phaseMaxLocal = newId;
      }
      if (phaseMaxLocal > phaseMax.Y) phaseMax.Y = phaseMaxLocal;
      curStart = _nextMemberZeroBoundary(phaseMaxLocal);
    }
    // 排序更新各頁的 members 陣列(讓 m.id 升序)
    for (const f of state.files) {
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k]; if (!pg || pg._orphan) continue;
        if (pg.plane !== "XY" && pg.plane !== "YZ") continue;
        pg.members.sort((a, b) => a.id - b.id);
      }
    }
    if (sortedCols.length) {
      processed += sortedCols.length;
      console.log(`[Stage 1] Y 軸全域編號完成:${sortedCols.length} 根柱,${allColMembers.length} 個段,max ID = ${phaseMax.Y}`);
    }
  }

  // ============================================================
  // Stage 2: XZ 平面 page-by-page — 每頁順序 row(X) → column(Z) → brace(D)
  //   X/Z 共用「主累加器」(從 max(2501, Stage1+1) 起)
  //   D 用獨立「斜撐累加器」(從 100001 起)
  // ============================================================
  {
    let mainCurStart = Math.max(2501,
      phaseMax.Y > 0 ? _nextMemberZeroBoundary(phaseMax.Y) : 1);
    let diagCurStart = 100001;
    console.log(`[Stage 2 XZ] 起始 mainCurStart=${mainCurStart} (phaseMax.Y=${phaseMax.Y}) / diagCurStart=${diagCurStart}`);
    for (const t of tasks) {
      if (t.pg.plane !== "XZ") continue;
      processed++;
      const pageTag = `${t.f.name}#${t.k}(z=${t.pg.z})`;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[2/4] XZ 平面・${pageTag}・main 起始 ${mainCurStart} / D 起始 ${diagCurStart}`);
      }
      await busyTick();
      const beforeMain = mainCurStart, beforeDiag = diagCurStart;
      // 同一頁依序 X → Z → D
      // X
      let r = _renumOnePage(t.pg, t.f.planeOrigin, "X", mainCurStart);
      const xMax = (r && r.catMax) ? r.catMax.X : 0;
      if (Number.isFinite(xMax) && xMax > 0) {
        if (xMax > phaseMax.X) phaseMax.X = xMax;
        mainCurStart = _nextMemberZeroBoundary(xMax);
      }
      // Z
      r = _renumOnePage(t.pg, t.f.planeOrigin, "Z", mainCurStart);
      const zMax = (r && r.catMax) ? r.catMax.Z : 0;
      if (Number.isFinite(zMax) && zMax > 0) {
        if (zMax > phaseMax.Z) phaseMax.Z = zMax;
        mainCurStart = _nextMemberZeroBoundary(zMax);
      }
      // D
      r = _renumOnePage(t.pg, t.f.planeOrigin, "D", diagCurStart);
      const dMax = (r && r.catMax) ? r.catMax.D : 0;
      if (Number.isFinite(dMax) && dMax > 0) {
        if (dMax > phaseMax.D) phaseMax.D = dMax;
        diagCurStart = _nextMemberZeroBoundary(dMax);
      }
      console.log(`[Stage 2 XZ] ${pageTag} X[${beforeMain}→max=${xMax}] Z[?→max=${zMax}] D[${beforeDiag}→max=${dMax}] → next main=${mainCurStart} diag=${diagCurStart}`);
    }
    // Stage 2b:也處理 X 軸在 XY 頁(這些在 user spec 沒提到,但若不處理會留下舊 m.id 跟新 ID 撞號)
    //   接續 main 累加器
    for (const t of tasks) {
      if (t.pg.plane !== "XY") continue;
      const pageTag = `${t.f.name}#${t.k}(XY,z=${t.pg.z})`;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[2b/4] X 軸@XY・${pageTag}・main 起始 ${mainCurStart}`);
      }
      await busyTick();
      const beforeMain = mainCurStart;
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "X", mainCurStart);
      const xMax = (r && r.catMax) ? r.catMax.X : 0;
      if (Number.isFinite(xMax) && xMax > 0) {
        if (xMax > phaseMax.X) phaseMax.X = xMax;
        mainCurStart = _nextMemberZeroBoundary(xMax);
      }
      console.log(`[Stage 2b X@XY] ${pageTag} X[${beforeMain}→max=${xMax}] → next main=${mainCurStart}`);
    }
    // Stage 2c:也處理 Z 軸在 YZ 頁
    for (const t of tasks) {
      if (t.pg.plane !== "YZ") continue;
      const pageTag = `${t.f.name}#${t.k}(YZ,z=${t.pg.z})`;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[2c/4] Z 軸@YZ・${pageTag}・main 起始 ${mainCurStart}`);
      }
      await busyTick();
      const beforeMain = mainCurStart;
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "Z", mainCurStart);
      const zMax = (r && r.catMax) ? r.catMax.Z : 0;
      if (Number.isFinite(zMax) && zMax > 0) {
        if (zMax > phaseMax.Z) phaseMax.Z = zMax;
        mainCurStart = _nextMemberZeroBoundary(zMax);
      }
      console.log(`[Stage 2c Z@YZ] ${pageTag} Z[${beforeMain}→max=${zMax}] → next main=${mainCurStart}`);
    }
  }

  // ============================================================
  // Stage 3: YZ 平面 brace(D)— 跨頁 D 累加器接續 Stage 2 的 D
  // ============================================================
  {
    let curStart = phaseMax.D > 0 ? _nextMemberZeroBoundary(phaseMax.D) : 100001;
    for (const t of tasks) {
      if (t.pg.plane !== "YZ") continue;
      processed++;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[3/4] YZ 平面 brace・${t.f.name}#${t.k}・起始 ${curStart}`);
      }
      await busyTick();
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "D", curStart);
      if (r && r.catMax && Number.isFinite(r.catMax.D) && r.catMax.D > 0) {
        if (r.catMax.D > phaseMax.D) phaseMax.D = r.catMax.D;
        curStart = _nextMemberZeroBoundary(r.catMax.D);
      }
    }
  }

  // ============================================================
  // Stage 4: XY 平面 brace(D)— 同上
  // ============================================================
  {
    let curStart = phaseMax.D > 0 ? _nextMemberZeroBoundary(phaseMax.D) : 100001;
    for (const t of tasks) {
      if (t.pg.plane !== "XY") continue;
      processed++;
      if (typeof setBusyMessage === "function") {
        setBusyMessage(`[4/4] XY 平面 brace・${t.f.name}#${t.k}・起始 ${curStart}`);
      }
      await busyTick();
      const r = _renumOnePage(t.pg, t.f.planeOrigin, "D", curStart);
      if (r && r.catMax && Number.isFinite(r.catMax.D) && r.catMax.D > 0) {
        if (r.catMax.D > phaseMax.D) phaseMax.D = r.catMax.D;
        curStart = _nextMemberZeroBoundary(r.catMax.D);
      }
    }
  }

  ok = state.files.reduce((s, f) => s + Object.keys(f.pages || {}).length, 0);
  skipped = 0;
  lastMemberMax = Math.max(phaseMax.Y, phaseMax.X, phaseMax.Z, phaseMax.D);
  if (typeof hideBusy === "function") hideBusy();
  state.selection.members.clear();
  // 收尾:跨頁同物理桿件 ID 融合(同 globalMemberId → 最小 id)
  const unifyStats = unifyCrossPageMemberIds();

  // ============================================================
  // 偵測撞號 — 不同 globalMemberId 但同 m.id 的桿件(只標記,不改 ID,讓使用者比對)
  //   原因常見:有些 plane(例如 X 軸在 XY 頁面)沒被 4 個 stage 處理到,留下舊 m.id 跟新 ID 撞號。
  //   策略:不重編號,維持原本 m.id;只把撞號 m.id 加進 state.memberCollisions
  //   (亮綠色高亮 + popup 警示;使用者可在搜尋視窗看到所有共用同 m.id 的桿件)
  // ============================================================
  state.memberCollisions = new Set();
  {
    const byId = new Map();
    for (const f of state.files) {
      for (const k of Object.keys(f.pages || {})) {
        const pg = f.pages[k];
        if (!pg || pg._orphan) continue;
        for (const m of pg.members) {
          if (!byId.has(m.id)) byId.set(m.id, []);
          byId.get(m.id).push({ file: f, pg, m });
        }
      }
    }
    let collisionCount = 0, memberCount = 0;
    for (const [id, list] of byId) {
      if (list.length <= 1) continue;
      // 用 globalMemberId 分組(同 gm = 同物理桿件副本,不算撞號)
      const gmGroups = new Map();
      for (const entry of list) {
        const gm = entry.m.globalMemberId != null ? `g${entry.m.globalMemberId}`
          : `_a${entry.file.id}_${entry.pg && entry.pg.plane}_${entry.m.j1}_${entry.m.j2}`;
        if (!gmGroups.has(gm)) gmGroups.set(gm, []);
        gmGroups.get(gm).push(entry);
      }
      if (gmGroups.size <= 1) continue;   // 全部是同一根物理桿件的跨頁副本 → 沒撞號
      // 真撞號:標記 id,不改編號(讓使用者用搜尋對比哪些桿件共用同 m.id)
      collisionCount++;
      state.memberCollisions.add(id);
      memberCount += list.length;
    }
    if (collisionCount) {
      console.warn(`[桿件編號重排] 偵測到 ${collisionCount} 組撞號 m.id,涉及 ${memberCount} 條桿件;在畫面上以亮綠色高亮,切到該頁時跳出 popup 提示`);
    } else {
      console.log(`[桿件編號重排] 無撞號`);
    }
  }
  if (unifyStats.gmsUnified || unifyStats.rewritten || unifyStats.conflicts) {
    console.log(`[全局重排桿件編號] 跨頁融合 ・ gm ${unifyStats.gmsUnified} / 改寫 member ${unifyStats.rewritten}` +
      (unifyStats.conflicts ? ` / 衝突跳過 ${unifyStats.conflicts}` : ""));
  }
  console.log(`[全局重排桿件編號] 完成 ${ok} 頁(略過空頁 ${skipped})・桿件最終 max=${lastMemberMax}`);
  render(); refreshLists();
  if (!skipConfirm) alert(`全局重排桿件編號完成:${ok} 頁已重編,${skipped} 頁略過。\n桿件最終 max=${lastMemberMax}・跨頁融合 gm ${unifyStats.gmsUnified} / member ${unifyStats.rewritten}` +
    (unifyStats.conflicts ? `・衝突跳過 ${unifyStats.conflicts}` : ""));
}

// ========== 跨頁桿件去重 / 融合 ==========
// 同一條物理桿件在 3D 中只應有一個 ID。此區兩個 helper 負責維持這個 invariant:
//   1) dedupSamePageMembers   —— 同頁 {j1,j2} 完全相同(不論方向) / 零長度桿件 → 保留第一條,其餘刪除
//   2) unifyCrossPageMemberIds —— 同 globalMemberId 的所有 page-local 副本,把 m.id 全部統一到最小值
// 不動節點、不拆共線重疊 —— 那些由「整理所有頁面」(consolidateAllPagesWithConfirm)處理。

// 單頁內重複桿件(同一對 joint)→ 刪掉其餘,只留第一條
//   也順手清掉零長度桿件(j1 === j2)
//   不呼叫 pushUndo —— 由 caller 負責
function dedupSamePageMembers() {
  let pagesTouched = 0, dupRemoved = 0, zeroLen = 0;
  for (const f of state.files || []) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan || !Array.isArray(pg.members)) continue;
      const seen = new Set();
      const kept = [];
      for (const m of pg.members) {
        if (m.j1 === m.j2) { zeroLen++; continue; }
        const k = m.j1 < m.j2 ? `${m.j1}-${m.j2}` : `${m.j2}-${m.j1}`;
        if (seen.has(k)) { dupRemoved++; continue; }
        seen.add(k);
        kept.push(m);
      }
      if (kept.length !== pg.members.length) {
        pg.members = kept;
        pagesTouched++;
      }
    }
  }
  // 清掉已失效的 active-page 選取
  const ap = (typeof getPage === "function") ? getPage() : null;
  if (ap && !ap._orphan) {
    state.selection.members = new Set([...state.selection.members].filter(id => ap.members.some(m => m.id === id)));
  }
  return { pagesTouched, dupRemoved, zeroLen };
}

// 跨頁同物理桿件 ID 統一:
//   對每個 state.globalMembers[gm],收集所有 m.globalMemberId === gm.id 的 page-local members
//   取最小的 m.id 當 canonical,把該 gm 下所有副本的 m.id 改成 canonical
//   碰撞保護:若目標頁上已有 *不同* member 佔用 canonical,該條保留原 id,記入 conflicts
//   前提:同頁已無重複桿件(dedupSamePageMembers 已跑過)—— 否則同頁會產生 duplicate id
//   呼叫時機:全局重編完成後,或獨立觸發
function unifyCrossPageMemberIds() {
  if (!Array.isArray(state.globalMembers)) state.globalMembers = [];
  // 收集 gmId → [{ pg, m }]
  const gmToRefs = new Map();
  for (const f of state.files || []) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan || !Array.isArray(pg.members)) continue;
      for (const m of pg.members) {
        if (m.globalMemberId == null) continue;
        let arr = gmToRefs.get(m.globalMemberId);
        if (!arr) { arr = []; gmToRefs.set(m.globalMemberId, arr); }
        arr.push({ pg, m });
      }
    }
  }
  let gmsUnified = 0, rewritten = 0, conflicts = 0;
  for (const refs of gmToRefs.values()) {
    if (refs.length < 2) continue;
    let canonical = Infinity;
    for (const r of refs) if (r.m.id < canonical) canonical = r.m.id;
    if (!Number.isFinite(canonical)) continue;
    let touched = 0;
    for (const r of refs) {
      if (r.m.id === canonical) continue;
      const clash = r.pg.members.find(mm => mm !== r.m && mm.id === canonical);
      if (clash) {
        // 同頁已有別的 member 佔用 canonical — 保守跳過(通常是 single-page relayout 導致的跨頁 id 重疊)
        conflicts++;
        continue;
      }
      r.m.id = canonical;
      rewritten++;
      touched++;
    }
    if (touched) gmsUnified++;
  }
  // 排序各頁 members + 同步 nextMemberId
  let maxId = 0;
  for (const f of state.files || []) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan || !Array.isArray(pg.members)) continue;
      pg.members.sort((a, b) => a.id - b.id);
      for (const m of pg.members) if (m.id > maxId) maxId = m.id;
    }
  }
  if (maxId + 1 > nextMemberId) nextMemberId = maxId + 1;
  return { gmsUnified, rewritten, conflicts };
}

// ---------- render ----------
// ---------- 自動對齊:偵測底圖最長水平/垂直線並旋轉 ----------
function extractSvgSegments(svgEl) {
  const segs = [];
  const paths = svgEl.querySelectorAll("path");
  for (const p of paths) {
    const stroke = p.getAttribute("stroke") || p.style.stroke || "";
    if (!stroke || stroke === "none") continue;
    const d = p.getAttribute("d") || "";
    const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[+-]?\d+)?/g) || [];
    let cur = null, start = null;
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      const num = (k) => parseFloat(tokens[k]);
      if (t === "M" || t === "m") {
        if (i + 2 < tokens.length) {
          const next = (t === "M" || !cur)
            ? { x: num(i + 1), y: num(i + 2) }
            : { x: cur.x + num(i + 1), y: cur.y + num(i + 2) };
          cur = next; start = { ...cur };
          i += 3;
        } else i++;
      } else if (t === "L" || t === "l") {
        if (i + 2 < tokens.length) {
          const next = (t === "L")
            ? { x: num(i + 1), y: num(i + 2) }
            : { x: cur.x + num(i + 1), y: cur.y + num(i + 2) };
          if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: next.x, y2: next.y });
          cur = next;
          i += 3;
        } else i++;
      } else if (t === "H" || t === "h") {
        if (i + 1 < tokens.length) {
          const next = { x: t === "H" ? num(i + 1) : cur.x + num(i + 1), y: cur.y };
          if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: next.x, y2: next.y });
          cur = next; i += 2;
        } else i++;
      } else if (t === "V" || t === "v") {
        if (i + 1 < tokens.length) {
          const next = { x: cur.x, y: t === "V" ? num(i + 1) : cur.y + num(i + 1) };
          if (cur) segs.push({ x1: cur.x, y1: cur.y, x2: next.x, y2: next.y });
          cur = next; i += 2;
        } else i++;
      } else if (t === "Z" || t === "z") {
        if (cur && start) segs.push({ x1: cur.x, y1: cur.y, x2: start.x, y2: start.y });
        cur = start ? { ...start } : null;
        i++;
      } else if (/[a-zA-Z]/.test(t)) {
        // 略過 C/S/Q/T/A 等曲線命令的引數
        i++;
        while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) i++;
      } else {
        i++;
      }
    }
  }
  return segs;
}

function detectAlignmentAngle() {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return null;
  const segs = extractSvgSegments(bgSvgEl);
  const tol = 30 * Math.PI / 180;
  let bestH = null, bestV = null;
  for (const s of segs) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    if (len < 5) continue;
    let a = Math.atan2(dy, dx);
    if (a > Math.PI / 2) a -= Math.PI;
    if (a < -Math.PI / 2) a += Math.PI;
    if (Math.abs(a) < tol) {
      if (!bestH || len > bestH.len) bestH = { len, angle: a };
    }
    if (Math.abs(Math.abs(a) - Math.PI / 2) < tol) {
      const correction = a > 0 ? Math.PI / 2 - a : -Math.PI / 2 - a;
      if (!bestV || len > bestV.len) bestV = { len, angle: a, correction };
    }
  }
  if (!bestH && !bestV) return null;
  let correction = 0, src = "";
  if (bestH && bestV) {
    if (bestH.len >= bestV.len) { correction = -bestH.angle; src = `水平線 ${bestH.len.toFixed(0)}`; }
    else { correction = bestV.correction; src = `垂直線 ${bestV.len.toFixed(0)}`; }
  } else if (bestH) { correction = -bestH.angle; src = `水平線 ${bestH.len.toFixed(0)}`; }
  else { correction = bestV.correction; src = `垂直線 ${bestV.len.toFixed(0)}`; }
  return { correction, src, bestH, bestV };
}

function enterManualAlign() {
  const file = getActiveFile();
  if (!file) { alert("請先載入檔案。"); return; }
  state.manualAlign.active = true;
  state.pendingLineStart = null;            // 進入對齊模式立刻取消畫線中狀態
  wrap.style.cursor = "move";
  $("hud").textContent = `手動對齊:拖曳上下左右平移底圖,Esc 完成`;
  render();
}
function exitManualAlign() {
  if (!state.manualAlign.active) return;
  state.manualAlign.active = false;
  wrap.style.cursor = "none";
  applyTransform();   // 復原 HUD
}
// 順時針旋轉底圖 90°(只在底圖模式可用)
//   - 底圖透過 file.rotation 累加 -90°(canvas 旋轉是逆時針正,所以順時針 = 負角)
//   - 同時旋轉本頁所有 joints / scaleRuler 端點 / planeOrigin / clipRect(讓結構跟底圖一起轉)
//   - 旋轉軸 = bg 中心 (bgWidth/2, bgHeight/2),跟 applyBgRotation 的視覺一致
//   - clipRect 旋轉後重算 AABB
function rotateBg90Clockwise() {
  if (state.tool !== "selectBg") {
    $("hud").textContent = "旋轉 90°:請先進入底圖模式";
    return;
  }
  const file = getActiveFile();
  if (!file) { alert("請先載入檔案。"); return; }
  pushUndo();
  // bg 中心(同 applyBgRotation 用的旋轉錨點)
  const cx = state.bgWidth / 2, cy = state.bgHeight / 2;
  // 順時針 90° → 點繞中心 (cx, cy) 的變換:(x, y) → (cx + (cy - y), cy + (x - cx))
  //   (在 canvas 座標系 y 向下,順時針旋轉 = 數學上 -90°)
  const rot = (x, y) => ({ x: cx + (cy - y), y: cy + (x - cx) });
  // 旋轉本頁 joints(joint 座標跟 bg 在同一座標系)
  const pg = file.pages && file.pages[state.pageIdx];
  let nJoints = 0;
  if (pg && Array.isArray(pg.joints)) {
    for (const j of pg.joints) {
      const r = rot(j.x, j.y);
      j.x = r.x; j.y = r.y;
      nJoints++;
    }
  }
  // 旋轉 scaleRuler 兩端點
  if (file.scaleRuler && file.scaleRuler.p1 && file.scaleRuler.p2) {
    const r1 = rot(file.scaleRuler.p1.x, file.scaleRuler.p1.y);
    const r2 = rot(file.scaleRuler.p2.x, file.scaleRuler.p2.y);
    file.scaleRuler.p1 = r1;
    file.scaleRuler.p2 = r2;
  }
  // 旋轉 planeOrigin
  if (file.planeOrigin) {
    const r = rot(file.planeOrigin.x, file.planeOrigin.y);
    file.planeOrigin = r;
  }
  // 旋轉 clipRect(轉完重新 AABB)
  if (file.clipRect) {
    const cr = file.clipRect;
    const corners = [
      rot(cr.x, cr.y),
      rot(cr.x + cr.w, cr.y),
      rot(cr.x + cr.w, cr.y + cr.h),
      rot(cr.x, cr.y + cr.h),
    ];
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    const nx = Math.min(...xs), ny = Math.min(...ys);
    const nw = Math.max(...xs) - nx, nh = Math.max(...ys) - ny;
    file.clipRect = { x: nx, y: ny, w: nw, h: nh };
  }
  // 旋轉 user 畫的 bg 線
  if (Array.isArray(file.userBgLines)) {
    for (const ln of file.userBgLines) {
      const r1 = rot(ln.x1, ln.y1);
      const r2 = rot(ln.x2, ln.y2);
      ln.x1 = r1.x; ln.y1 = r1.y;
      ln.x2 = r2.x; ln.y2 = r2.y;
    }
  }
  // 旋轉切面標線 p1 / p2(本檔的 sectionLinks)
  if (Array.isArray(file.sectionLinks)) {
    for (const sl of file.sectionLinks) {
      if (sl.p1) { const r = rot(sl.p1.x, sl.p1.y); sl.p1 = r; }
      if (sl.p2) { const r = rot(sl.p2.x, sl.p2.y); sl.p2 = r; }
    }
  }
  // 底圖視覺旋轉 — file.rotation 累加 +PI/2(CSS rotate 在 y-down 座標系下視覺上是順時針)
  file.rotation = (file.rotation || 0) + Math.PI / 2;
  applyBgRotation(file);
  // 同步 user 畫的 bg 線到 DOM(座標已改,需要重建)
  if (typeof syncUserBgLinesToDom === "function") syncUserBgLinesToDom(file);
  // bg cache(P2 跨頁同步用)需要重建,因為線段座標都變了
  if (pg) pg._bgSegsCache = null;
  if (typeof cacheActivePageBgSegs === "function") {
    try { cacheActivePageBgSegs(); } catch (_) {}
  }
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  // 旋轉後 sectionLink 的 p1/p2 雖然跟著轉,但 cutAxis / cutValue 是世界座標投影,
  //   旋轉後通常會換軸或變號 → 用新的像素 + 原點重新分析,並同步目標檔 page.z
  const sl = (typeof _resyncSectionLinksForFile === "function") ? _resyncSectionLinksForFile(file) : { slUpdated: 0, tgtZUpdated: 0 };
  if (typeof _afterCalibrationChanged === "function") _afterCalibrationChanged();
  else { render(); refreshLists(); }
  $("hud").textContent = `旋轉 90°(順時針)・${file.name}:${nJoints} 節點${pg && pg.members ? "・" + pg.members.length + " 桿件" : ""} 同步旋轉` +
    (sl.slUpdated ? `・切面 ${sl.slUpdated} 條重算` : "");
}
$("btnRotate90") && ($("btnRotate90").onclick = () => withBusy("旋轉 90°(底圖 + 節點 + 桿件)…", rotateBg90Clockwise));

// 在 vector 層底部繪製鎖點視覺(灰點 / 棋盤格)
export function drawSnapGrid() {
  if (!state.snapGrid || state.snapGrid.mode === 0) return;
  const stepWorld = (state.snapGrid.step || 1) * (state.scale || 1);
  if (stepWorld <= 0) return;

  // 視窗在世界座標的可見範圍
  const r = wrap.getBoundingClientRect();
  const tl = screenToWorld(r.left, r.top);
  const br = screenToWorld(r.right, r.bottom);
  const x1 = Math.min(tl.x, br.x), y1 = Math.min(tl.y, br.y);
  const x2 = Math.max(tl.x, br.x), y2 = Math.max(tl.y, br.y);

  // 動態調整實際顯示間距,避免太密;但仍保留鎖點計算用的真實 stepWorld
  let s = stepWorld;
  const maxCells = 120;            // 每方向最多 120 格(~14400 個視覺元素)
  while ((x2 - x1) / s > maxCells || (y2 - y1) / s > maxCells) s *= 5;

  const ix1 = Math.floor(x1 / s), ix2 = Math.ceil(x2 / s);
  const iy1 = Math.floor(y1 / s), iy2 = Math.ceil(y2 / s);

  // 主格(每 5 格)用較粗 / 較大來區分
  const majorEvery = 5;

  if (state.snapGrid.mode === 1) {
    // 點陣 — 鎖點位置畫成 1x1 ~ 3x3 px 的小方塊
    const minorSize = 1 / state.zoom;     // 1 CSS px
    const majorSize = 3 / state.zoom;     // 3 CSS px
    for (let ix = ix1; ix <= ix2; ix++) {
      for (let iy = iy1; iy <= iy2; iy++) {
        const isMajor = (ix % majorEvery === 0) && (iy % majorEvery === 0);
        const sz = isMajor ? majorSize : minorSize;
        const half = sz / 2;
        svg.appendChild(el("rect", {
          x: ix * s - half, y: iy * s - half,
          width: sz, height: sz,
          fill: "#9aa0a6",
          "fill-opacity": isMajor ? "0.65" : "0.4",
          stroke: "none",
        }));
      }
    }
  } else if (state.snapGrid.mode === 2) {
    // 線條方式 — 線寬隨縮放反向變化:放大越多 → 線越細
    const ymin = iy1 * s, ymax = iy2 * s;
    const xmin = ix1 * s, xmax = ix2 * s;
    const lineWidth = (basePx) => Math.max(0.2, basePx / state.zoom).toFixed(3);
    for (let ix = ix1; ix <= ix2; ix++) {
      const isMajor    = ix % majorEvery === 0;
      const isSuper    = ix % (majorEvery * majorEvery) === 0;
      const basePx     = isSuper ? 3 : isMajor ? 2 : 1;
      const opacity    = isSuper ? "0.55" : isMajor ? "0.4" : "0.22";
      svg.appendChild(el("line", {
        x1: ix * s, y1: ymin, x2: ix * s, y2: ymax,
        stroke: "#9aa0a6",
        "stroke-width": lineWidth(basePx),
        "stroke-opacity": opacity,
      }));
    }
    for (let iy = iy1; iy <= iy2; iy++) {
      const isMajor    = iy % majorEvery === 0;
      const isSuper    = iy % (majorEvery * majorEvery) === 0;
      const basePx     = isSuper ? 3 : isMajor ? 2 : 1;
      const opacity    = isSuper ? "0.55" : isMajor ? "0.4" : "0.22";
      svg.appendChild(el("line", {
        x1: xmin, y1: iy * s, x2: xmax, y2: iy * s,
        stroke: "#9aa0a6",
        "stroke-width": lineWidth(basePx),
        "stroke-opacity": opacity,
      }));
    }
  }
}

// Render 看門狗 + _renderImpl 移到 src/render/index.ts(Phase 6)
import { render } from "./render";
export { render };   // re-export 讓 dialog 等 module 仍能從 "./legacy" import render

export function el(tag, attrs, text) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

// ---------- context menu (右鍵刪除) ----------
let ctxTarget = null;        // 觸發右鍵的元素
let ctxPending = null;       // { joints:Set, members:Set, orphans:Set } 即將刪除的全部對象
export function showCtxMenu(x, y, target) {
  ctxTarget = target;
  const p = getPage();

  // 決定刪除集合
  // - target 在多選中 → 套用整個多選
  // - target 不在多選中 → 只刪這一個
  // - target 為 null → 使用目前選取
  const joints = new Set();
  const members = new Set();
  if (target) {
    const inSel = target.type === "joint"
      ? state.selection.joints.has(target.id)
      : state.selection.members.has(target.id);
    const multi = state.selection.joints.size + state.selection.members.size > 1;
    if (inSel && multi) {
      state.selection.joints.forEach((id) => joints.add(id));
      state.selection.members.forEach((id) => members.add(id));
    } else {
      if (target.type === "joint") joints.add(target.id);
      else members.add(target.id);
    }
  } else {
    state.selection.joints.forEach((id) => joints.add(id));
    state.selection.members.forEach((id) => members.add(id));
  }
  if (joints.size === 0 && members.size === 0) return;  // 沒有可刪內容

  // 預估孤立節點:被刪桿件的端點若已不被任何剩餘桿件用到 → 一起刪
  const checkOrphan = new Set();
  for (const m of p.members) if (members.has(m.id)) {
    checkOrphan.add(m.j1); checkOrphan.add(m.j2);
  }
  const remaining = p.members.filter(m =>
    !members.has(m.id) && !joints.has(m.j1) && !joints.has(m.j2));
  const used = new Set();
  for (const m of remaining) { used.add(m.j1); used.add(m.j2); }
  const orphans = new Set();
  for (const id of checkOrphan) {
    if (!joints.has(id) && !used.has(id)) orphans.add(id);
  }
  ctxPending = { joints, members, orphans };
  $("ctxRename").style.display = "none";
  $("ctxDuplicate") && ($("ctxDuplicate").style.display = "none");
  $("ctxOpenTab") && ($("ctxOpenTab").style.display = "none");
  $("ctxDelete").style.display = "block";
  $("ctxBgSplit").style.display = "none";
  $("ctxBgToMember").style.display = "none";
  $("ctxBgToDashed") && ($("ctxBgToDashed").style.display = "none");

  // 全局節點:單一 joint 才顯示
  const onlyOneJoint = (joints.size === 1 && members.size === 0);
  const theJoint = onlyOneJoint ? p.joints.find(j => j.id === [...joints][0]) : null;
  const hasGlobals = state.globalJoints.length > 0;
  const isBound = theJoint && theJoint.globalId != null;
  $("ctxPromoteGlobal").style.display = (theJoint && !isBound) ? "block" : "none";
  $("ctxBindGlobal").style.display    = (theJoint && hasGlobals) ? "block" : "none";
  $("ctxUnbindGlobal").style.display  = isBound ? "block" : "none";
  if (isBound) {
    const g = findGlobalJointById(theJoint.globalId);
    $("ctxBindGlobal").textContent = `改綁到其他全局節點… (目前: ${g ? g.label : "?"})`;
    $("ctxUnbindGlobal").textContent = `取消全局綁定 (${g ? g.label : "?"})`;
  } else {
    $("ctxBindGlobal").textContent = "綁定到既有 N…";
  }
  // 選取模式(選取點/選取線)已移除,改用 Shift+S 切換單/多選,ctxFilterGroup 不再顯示
  $("ctxFilterGroup").style.display = "none";
  if (showFilter) updateCtxFilterRadios();

  // 標題
  const total = joints.size + members.size + orphans.size;
  $("ctxHead").textContent = `將刪除 ${total} 項` +
    (orphans.size ? `(含 ${orphans.size} 孤立節點)` : "");

  // 列表內容
  const list = $("ctxList");
  list.innerHTML = "";
  const addItem = (text, cls) => {
    const d = document.createElement("div");
    d.className = "ctx-list-item" + (cls ? " " + cls : "");
    d.textContent = text;
    list.appendChild(d);
  };
  for (const id of [...members].sort((a, b) => a - b)) {
    const m = p.members.find(x => x.id === id);
    if (m) addItem(`桿件 M${m.id} (J${m.j1}–J${m.j2})`);
  }
  for (const id of [...joints].sort((a, b) => a - b)) {
    addItem(`節點 J${id}`);
  }
  if (orphans.size) {
    const lbl = document.createElement("div");
    lbl.className = "ctx-section-label";
    lbl.textContent = "連帶清除孤立節點";
    list.appendChild(lbl);
    for (const id of [...orphans].sort((a, b) => a - b)) {
      addItem(`節點 J${id}`, "orphan");
    }
  }

  // 顯示並夾在視窗內
  const m = $("ctxMenu");
  m.style.display = "flex";
  m.style.left = "0px"; m.style.top = "0px";
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.min(x, window.innerWidth - w - 4) + "px";
  m.style.top  = Math.min(y, window.innerHeight - h - 4) + "px";
  if (target.el) target.el.classList.add("ctx-active");
}
function hideCtxMenu() {
  $("ctxMenu").style.display = "none";
  if (ctxTarget && ctxTarget.el) ctxTarget.el.classList.remove("ctx-active");
  ctxTarget = null; ctxPending = null;
}
window.addEventListener("click", hideCtxMenu);
window.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".item")) hideCtxMenu();
});
window.addEventListener("scroll", (e) => {
  if (e.target && e.target.closest && e.target.closest("#ctxMenu")) return;
  hideCtxMenu();
}, true);
$("ctxMenu").addEventListener("click", (e) => e.stopPropagation());
$("ctxMenu").addEventListener("wheel",  (e) => e.stopPropagation());
function updateCtxFilterRadios() {
  document.querySelectorAll("#ctxFilterGroup .ctx-radio").forEach(el => {
    el.classList.toggle("on", el.dataset.filter === state.selectFilter);
  });
}
document.querySelectorAll("#ctxFilterGroup .ctx-radio").forEach(el => {
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    state.selectFilter = el.dataset.filter;
    updateCtxFilterRadios();
    updateSelectToolLabel();
    applyTransform();
    hideCtxMenu();
  });
});

$("ctxBgSplit") && ($("ctxBgSplit").onclick = (e) => {
  e.stopPropagation();
  hideCtxMenu();
  bgPathsSplitToLines();
});
$("ctxBgToMember") && ($("ctxBgToMember").onclick = (e) => {
  e.stopPropagation();
  hideCtxMenu();
  bgPathsToMembers();
});
$("ctxBgToDashed") && ($("ctxBgToDashed").onclick = (e) => {
  e.stopPropagation();
  hideCtxMenu();
  bgToggleDashedOnSelection();
});

$("ctxOpenTab") && ($("ctxOpenTab").onclick = (e) => {
  e.stopPropagation();
  if (!ctxPending || !ctxPending.fileIds || !ctxPending.fileIds.size) return;
  const ids = [...ctxPending.fileIds];
  hideCtxMenu();
  let firstId = null;
  for (const fid of ids) {
    const f = state.files.find(ff => ff.id === fid);
    if (!f) continue;
    addTab(fid, 0);
    if (firstId == null) firstId = fid;
  }
  // 一鍵開多個分頁時,切到第一個被開的檔案
  if (firstId != null && state.activeFileId !== firstId) activatePageWithBusy(firstId, 0);
});

$("ctxRename").onclick = (e) => {
  e.stopPropagation();
  if (!ctxPending || !ctxPending.fileIds || ctxPending.fileIds.size !== 1) return;
  const fid = [...ctxPending.fileIds][0];
  const file = state.files.find(f => f.id === fid);
  hideCtxMenu();
  if (!file) return;
  const name = prompt("新名稱:", file.name);
  if (!name || name === file.name) return;
  if (state.files.some(f => f.id !== fid && f.name === name)) {
    alert("名稱已存在,不可重複"); return;
  }
  pushUndo();
  file.name = name;
  refreshFileList(); refreshPageSelector();
};

// 複製檔案:複製選取的單一檔案(含底圖參照、比例尺、原點、標線),節點/桿件重新編號避免衝突
$("ctxDuplicate") && ($("ctxDuplicate").onclick = (e) => {
  e.stopPropagation();
  if (!ctxPending || !ctxPending.fileIds || ctxPending.fileIds.size !== 1) return;
  const fid = [...ctxPending.fileIds][0];
  hideCtxMenu();
  duplicateFileById(fid);
});

function duplicateFileById(fid, opts) {
  const src = state.files.find(f => f.id === fid);
  if (!src) return null;
  pushUndo();
  // 產生不重複的新名稱:原名稱 (副本) / (副本 2) / ...
  const baseName = src.name;
  let newName = `${baseName} (副本)`;
  let n = 2;
  while (state.files.some(f => f.name === newName)) {
    newName = `${baseName} (副本 ${n++})`;
  }
  // deep clone pages,並重新編號 joint / member 以免和既有檔案衝突
  const clonedPages = {};
  for (const key of Object.keys(src.pages || {})) {
    const pg = src.pages[key];
    const idMap = new Map();  // 舊 jointId → 新 jointId
    const newJoints = [];
    for (const j of (pg.joints || [])) {
      const nid = nextJointId++;
      idMap.set(j.id, nid);
      newJoints.push({ ...j, id: nid });
    }
    const newMembers = [];
    for (const m of (pg.members || [])) {
      const j1 = idMap.get(m.j1), j2 = idMap.get(m.j2);
      if (j1 == null || j2 == null) continue;   // 掉端點的直接跳過
      newMembers.push({ ...m, id: nextMemberId++, j1, j2 });
    }
    clonedPages[key] = {
      ...pg,
      joints: newJoints,
      members: newMembers,
    };
  }
  const clone = {
    id: nextFileId++,
    name: newName,
    type: src.type,
    pageCount: src.pageCount || 1,
    pdfPage: src.pdfPage,
    rotation: src.rotation || 0,
    offsetX: src.offsetX || 0,
    offsetY: src.offsetY || 0,
    clipRect: src.clipRect ? { ...src.clipRect } : null,
    scaleRuler: src.scaleRuler ? { ...src.scaleRuler } : null,
    planeOrigin: src.planeOrigin ? { ...src.planeOrigin } : null,
    bgWidth: src.bgWidth,
    bgHeight: src.bgHeight,
    detectedStrokeWidth: src.detectedStrokeWidth,
    imageWidth:  src.imageWidth,
    imageHeight: src.imageHeight,
    cachedBgWidth:  src.cachedBgWidth,
    cachedBgHeight: src.cachedBgHeight,
    pages: clonedPages,
    // 共享底圖資源(避免重新解析 PDF / 複製大型 buffer)
    sourceFileId: src.sourceFileId || src.id,
    pdf: src.pdf || null,
    image: src.image || null,
    cachedBgSvg: src.cachedBgSvg || null,
    cachedBgImg: src.cachedBgImg || null,
    // 不複製以下使用者正在處理的暫時選取狀態
    selectedBgPaths: null,
    deletedBgPaths: src.deletedBgPaths ? new Set(src.deletedBgPaths) : null,
  };
  state.files.push(clone);
  state.selection.fileIds.clear();
  state.selection.fileIds.add(clone.id);
  // 若指定了 pageZ → 寫入 clone 的 page[0].z;會影響後續 propagation 用到的 depth
  if (opts && Number.isFinite(opts.pageZ)) {
    if (!clone.pages) clone.pages = {};
    if (!clone.pages[0]) clone.pages[0] = { joints: [], members: [], z: 0 };
    clone.pages[0].z = opts.pageZ;
  }
  // 衍生模型:clone 出現在 state.files 後,所有切面線會在 render 時即時對 clone 推算,不必預先寫入
  console.log(`[複製檔案] ${src.name} → ${newName}(節點 ${Object.values(clonedPages).reduce((s, p) => s + p.joints.length, 0)} · 桿件 ${Object.values(clonedPages).reduce((s, p) => s + p.members.length, 0)})`);
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  refreshFileList(); refreshPageSelector();
  // opts.activate === false:複製後不切換 active page(切面 dialog 等情境用)
  if (!(opts && opts.activate === false)) {
    activatePage(clone.id, 0);
  }
  return clone;
}

export let splitContext = null;
export function _setSplitContext(ctx) { splitContext = ctx; }
export function showSplitDim(rect) {
  let dim = document.getElementById("splitDim");
  if (!dim) {
    dim = document.createElement("div");
    dim.id = "splitDim";
    stage.insertBefore(dim, svg);
  }
  dim.style.width = state.bgWidth + "px";
  dim.style.height = state.bgHeight + "px";
  dim.style.zIndex = "5";
  const w = state.bgWidth, h = state.bgHeight;
  const x1 = Math.max(0, rect.x), y1 = Math.max(0, rect.y);
  const x2 = Math.min(w, rect.x + rect.w), y2 = Math.min(h, rect.y + rect.h);
  dim.style.clipPath = `path(evenodd, "M0,0 H${w} V${h} H0 Z M${x1},${y1} H${x2} V${y2} H${x1} Z")`;
  dim.style.display = "block";
}
function hideSplitDim() {
  const dim = document.getElementById("splitDim");
  if (dim) dim.remove();
}
function openSplitDialog() {
  if (state.selection.joints.size + state.selection.members.size === 0) {
    alert("請先框選或選取要拆分的節點 / 桿件。");
    return;
  }
  const p = getPage();
  if (!p || p._orphan) { alert("請先載入並啟用一個頁面。"); return; }
  // 計算要搬移的圖元集合
  const movedJ = new Set(state.selection.joints);
  for (const id of state.selection.members) {
    const m = p.members.find(x => x.id === id);
    if (m) { movedJ.add(m.j1); movedJ.add(m.j2); }
  }
  const movedM = new Set(state.selection.members);
  for (const m of p.members) {
    if (movedJ.has(m.j1) && movedJ.has(m.j2)) movedM.add(m.id);
  }
  // 計算矩形(優先 marquee,否則 bbox)
  let rect = null;
  if (state.lastMarquee && state.lastMarquee.w > 0 && state.lastMarquee.h > 0) {
    rect = { ...state.lastMarquee };
  } else {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of movedJ) {
      const j = p.joints.find(x => x.id === id);
      if (!j) continue;
      if (j.x < minX) minX = j.x;
      if (j.x > maxX) maxX = j.x;
      if (j.y < minY) minY = j.y;
      if (j.y > maxY) maxY = j.y;
    }
    if (isFinite(minX)) {
      const pad = 20;
      rect = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    }
  }
  if (!rect) { alert("無法判斷拆分範圍。"); return; }
  splitContext = { movedJ, movedM, rect };
  showSplitDim(rect);
  $("splitName").value = "拆分_" + (state.files.length + 1);
  $("splitDialog").style.display = "flex";
  setTimeout(() => $("splitName").focus(), 30);
}
// 掃描目前 #bgSvg 中所有帶 data-bg-idx 的元素,回傳「螢幕 bbox 對應回世界座標後與 rect 重疊」的 index set。
//   用於拆分頁面時過濾底圖:讓新檔案只帶「框選範圍內」的 SVG 元素,不用共用整張大底圖。
//   實作注意:不能用 getBBox() — PDF 的 SVG 有巢狀 <g> transforms,getBBox 回傳的是父層本地座標,
//   跟 rect(stage 世界座標)不同空間會比對錯亂。改用 getBoundingClientRect() + screenToWorld()
//   走螢幕座標中繼,兩種結構(DXF 平鋪 / PDF 巢狀)都能正確處理。
function computeBgKeepForRect(rect) {
  const bgSvgEl = document.getElementById("bgSvg");
  if (!bgSvgEl) return null;
  const keep = new Set();
  const shapes = bgSvgEl.querySelectorAll("[data-bg-idx]");
  for (const el of shapes) {
    // 被使用者刪除的 bg 線(display:none)→ 不納入新檔
    if (el.style && el.style.display === "none") continue;
    const rc = el.getBoundingClientRect();
    if (rc.width === 0 && rc.height === 0) continue;   // 隱藏或沒渲染
    const p1 = screenToWorld(rc.left, rc.top);
    const p2 = screenToWorld(rc.right, rc.bottom);
    const bx1 = Math.min(p1.x, p2.x), by1 = Math.min(p1.y, p2.y);
    const bx2 = Math.max(p1.x, p2.x), by2 = Math.max(p1.y, p2.y);
    // AABB 重疊判定
    if (bx2 < rect.x) continue;
    if (bx1 > rect.x + rect.w) continue;
    if (by2 < rect.y) continue;
    if (by1 > rect.y + rect.h) continue;
    keep.add(String(el.dataset.bgIdx));
  }
  return keep;
}

// 解析 cachedBgSvg 文字,移除所有不在 keep 集合中的 data-bg-idx 元素,回傳縮減後的 SVG 文字
function filterCachedBgSvg(svgText, keep) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("SVG parse error");
  const root = doc.documentElement;
  const shapes = root.querySelectorAll("[data-bg-idx]");
  let removed = 0;
  for (const el of shapes) {
    if (!keep.has(String(el.dataset.bgIdx))) { el.remove(); removed++; }
  }
  console.log(`[拆分] 底圖過濾:保留 ${keep.size} 個元素,移除 ${removed} 個`);
  return new XMLSerializer().serializeToString(root);
}

async function applySplit() {
  if (!splitContext) return;
  const name = $("splitName").value.trim();
  if (!name) { alert("請輸入名稱"); $("splitName").focus(); return; }
  if (state.files.some(f => f.name === name)) { alert("名稱已存在,不可重複"); return; }
  const { movedJ, movedM, rect } = splitContext;
  const p = getPage();
  const src = getActiveFile();

  // 若來源有向量 SVG 快取(DXF / PDF 向量模式)→ 先過濾一份只含「框內元素」的獨立 SVG,
  // 讓新檔案自我封閉(不再共用整張大 cachedBgSvg);DXF 拆分後可大幅減少記憶體與專案檔體積。
  let filteredBgSvg = null;
  if (src && src.cachedBgSvg) {
    // 先隱藏對話框(z-index 2500 會擋住 busy spinner z-index 2000,使用者看不到進度)
    $("splitDialog").style.display = "none";
    showBusy("拆分底圖中…(過濾 SVG 元素)");
    await busyTick();
    try {
      const keep = computeBgKeepForRect(rect);
      if (keep) filteredBgSvg = filterCachedBgSvg(src.cachedBgSvg, keep);
    } catch (e) {
      console.warn("[拆分] 底圖過濾失敗,退回共用來源模式:", e);
      filteredBgSvg = null;
    }
    hideBusy();
  }

  pushUndo();
  // 拆分:把範圍內的圖元「複製」到新檔(非破壞性 — 原檔保留);為新檔的圖元重新分配 ID 避免跨檔衝突
  const idMap = new Map();
  const newJoints = [];
  for (const j of p.joints) {
    if (!movedJ.has(j.id)) continue;
    const clone = JSON.parse(JSON.stringify(j));
    const nid = nextJointId++;
    idMap.set(j.id, nid);
    clone.id = nid;
    newJoints.push(clone);
  }
  const newMembers = [];
  for (const m of p.members) {
    if (!movedM.has(m.id)) continue;
    const nj1 = idMap.get(m.j1), nj2 = idMap.get(m.j2);
    if (nj1 == null || nj2 == null) continue;  // 端點不在範圍中(跨界桿件)→ 略過
    const clone = JSON.parse(JSON.stringify(m));
    clone.id = nextMemberId++;
    clone.j1 = nj1;
    clone.j2 = nj2;
    newMembers.push(clone);
  }
  // 原檔不再移除任何圖元:保留完整內容,使用者若要清理可以手動刪除
  const file = {
    id: nextFileId++,
    name,
    sourceName: "(拆分)" + name,
    type: src && src.type ? src.type : "split",
    pageCount: 1,
    bgWidth: state.bgWidth,
    bgHeight: state.bgHeight,
    pages: { 0: { joints: newJoints, members: newMembers, z: p.z || 0 } },
  };
  if (src) {
    file.rotation = src.rotation || 0;
    file.offsetX = src.offsetX || 0;
    file.offsetY = src.offsetY || 0;
    file.detectedStrokeWidth = src.detectedStrokeWidth;
    // 拆分頁保留與來源一致的世界座標空間 → 比例尺 / 原點 的設定在新檔仍然成立,直接繼承
    //   即使 scaleRuler 的視覺線段位於 clipRect 之外,CSS clip-path 會把它隱藏,但 ratio 仍生效
    if (src.scaleRuler)  file.scaleRuler  = JSON.parse(JSON.stringify(src.scaleRuler));
    if (src.planeOrigin) file.planeOrigin = JSON.parse(JSON.stringify(src.planeOrigin));
    if (filteredBgSvg) {
      // 有獨立、縮減版的 SVG → 新檔自帶完整底圖,不再需要從來源讀取
      //   座標空間維持與來源一致(clipRect 仍有效),但 DOM 元素數量大幅減少
      //   sourceFileId 仍保留:fileTypeLabel 靠它判斷「拆分檔(-S 後綴)」;即使來源被刪,
      //   這個 ID 只會變成 dangling ref,fileTypeLabel 的走鏈會 graceful break,不影響渲染
      file.cachedBgSvg    = filteredBgSvg;
      file.cachedBgWidth  = src.cachedBgWidth  || state.bgWidth;
      file.cachedBgHeight = src.cachedBgHeight || state.bgHeight;
      file.sourceFileId   = src.sourceFileId || src.id;
      // 不帶 pdf / image / cachedBgImg:新檔渲染走 cachedBgSvg 路徑
    } else {
      // 無 SVG 快取(PDF raster / 原生圖片)→ 無法過濾,維持原本共用來源行為
      if (src.pdf) { file.pdf = src.pdf; file.pdfPage = src.pdfPage; }
      if (src.image) {
        file.image = src.image;
        file.imageWidth = src.imageWidth;
        file.imageHeight = src.imageHeight;
      }
      if (src.cachedBgSvg) file.cachedBgSvg = src.cachedBgSvg;
      if (src.cachedBgImg) file.cachedBgImg = src.cachedBgImg;
      if (src.cachedBgWidth)  file.cachedBgWidth  = src.cachedBgWidth;
      if (src.cachedBgHeight) file.cachedBgHeight = src.cachedBgHeight;
      // 追蹤來源檔案:專案儲存時可共用 PDF/圖片 buffer(以 sourceFileId 去重)
      file.sourceFileId = src.sourceFileId || src.id;
    }
  }
  file.clipRect = rect;
  state.lastMarquee = null;
  state.files.push(file);
  closeSplitDialog();
  clearSelection();
  refreshFileList(); refreshPageSelector();
  render(); refreshLists();
  activatePage(file.id, 0);
}
function closeSplitDialog() {
  $("splitDialog").style.display = "none";
  hideSplitDim();
  splitContext = null;
  state.splitMode = false;
  state.splitFirstCorner = null;
  $("btnSplit").classList.remove("active");
  applyTransform();
}
$("splitConfirm") && ($("splitConfirm").onclick = applySplit);
$("splitCancel")  && ($("splitCancel").onclick = closeSplitDialog);
$("splitName") && $("splitName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") applySplit();
  else if (e.key === "Escape") closeSplitDialog();
});

// 配對中:把點到的 view joint 綁到 pendingGlobalPair。回傳 true 表示已處理(呼叫端應 return)
export function tryConsumePendingGlobalPair(j) {
  if (state.pendingGlobalPair == null) return false;
  const gid = state.pendingGlobalPair;
  if (j.globalId === gid) {
    // 已綁:再點一次就視為「結束配對」
    state.pendingGlobalPair = null;
    $("hud").textContent = "全局節點配對結束";
    render(); refreshLists();
    return true;
  }
  pushUndo();
  bindJointToGlobal(j, gid);
  // pendingGlobalPair 保持,讓使用者可以連續綁多個視圖
  const g = findGlobalJointById(gid);
  const n = g ? countBindings(g.id) : 0;
  $("hud").textContent = `已綁 ${g ? g.label : ""} (共 ${n} 個視圖)— 繼續點選或按 Esc 結束`;
  render(); refreshLists();
  return true;
}

// ---------- 全局節點:ctx menu 操作 ----------
function getCtxSingleJoint() {
  if (!ctxPending) return null;
  if (ctxPending.joints.size !== 1 || ctxPending.members.size !== 0) return null;
  const id = [...ctxPending.joints][0];
  return getPage().joints.find(j => j.id === id) || null;
}
$("ctxPromoteGlobal").onclick = (e) => {
  e.stopPropagation();
  const j = getCtxSingleJoint();
  if (!j) return;
  pushUndo();
  const g = createGlobalJoint();
  bindJointToGlobal(j, g.id);
  state.pendingGlobalPair = g.id;
  hideCtxMenu();
  $("hud").textContent = `已建立全局節點 ${g.label} — 切到其他頁,點選對應節點即可綁到 ${g.label}(Esc 取消)`;
  render(); refreshLists();
};
$("ctxBindGlobal").onclick = (e) => {
  e.stopPropagation();
  const j = getCtxSingleJoint();
  if (!j) return;
  hideCtxMenu();
  openGbindDialog(j);
};
$("ctxUnbindGlobal").onclick = (e) => {
  e.stopPropagation();
  const j = getCtxSingleJoint();
  if (!j || j.globalId == null) return;
  pushUndo();
  unbindJointFromGlobal(j);
  hideCtxMenu();
  render(); refreshLists();
};

// ---------- 綁定挑選對話框 ----------
let gbindTargetJoint = null;
function openGbindDialog(joint) {
  gbindTargetJoint = joint;
  const list = $("gbindList");
  list.innerHTML = "";
  const sorted = [...state.globalJoints].sort((a, b) => a.id - b.id);
  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "#9aa0a6";
    empty.style.padding = "8px";
    empty.textContent = (typeof _t==="function"&&_t("list.noGlobalJoints"))||"(尚無全局節點)";
    list.appendChild(empty);
  }
  for (const g of sorted) {
    const n = countBindings(g.id);
    const row = document.createElement("div");
    row.className = "gbind-row";
    const isCur = (joint.globalId === g.id);
    row.innerHTML = `<span class="gbind-label">${g.label}${isCur ? " ✓" : ""}</span>`
      + `<span class="gbind-meta">${n} 個視圖綁定</span>`;
    row.onclick = () => {
      pushUndo();
      bindJointToGlobal(joint, g.id);
      // GC 原本綁的(若改綁過來,原 globalId 可能無人引用)— 由 unbind 路徑統一處理:
      // 但 bindJointToGlobal 沒走 unbind 流程,所以這裡顯式 GC
      // (其實不必:countBindings 會把新綁的也算進去,所以原 globalId 若還有他人綁就不會被刪)
      $("gbindDialog").style.display = "none";
      gbindTargetJoint = null;
      render(); refreshLists();
    };
    list.appendChild(row);
  }
  $("gbindDialog").style.display = "flex";
}
$("gbindCancel").onclick = () => {
  $("gbindDialog").style.display = "none";
  gbindTargetJoint = null;
};
$("gbindNew").onclick = () => {
  if (!gbindTargetJoint) return;
  pushUndo();
  const g = createGlobalJoint();
  bindJointToGlobal(gbindTargetJoint, g.id);
  state.pendingGlobalPair = g.id;
  $("gbindDialog").style.display = "none";
  $("hud").textContent = `已建立全局節點 ${g.label} — 切到其他頁,點選對應節點即可綁到 ${g.label}(Esc 取消)`;
  gbindTargetJoint = null;
  render(); refreshLists();
};

// ---------- 三視圖自動配對 對話框 ----------
let _apCandidates = [];
function _apFmtMember(m) {
  return `${m.fileName}#${m.pageIdx + 1} J${m.dispJ}<span style="color:#888">(${m.plane})</span>`;
}
function _apFmtCoord(v) { return v == null ? "?" : v.toFixed(0); }
function openAutoPairDialog() {
  const apUnit = $("apUnit"); if (apUnit) apUnit.textContent = state.unitName || "mm";
  $("apList").innerHTML = '<div style="color:#9aa0a6;padding:8px">點「掃描候選」開始</div>';
  $("apSummary").textContent = "";
  _apCandidates = [];
  $("autoPairDialog").style.display = "flex";
}
function closeAutoPairDialog() {
  $("autoPairDialog").style.display = "none";
  _apCandidates = [];
}
function rescanAutoPair() {
  const tol = parseFloat($("apTol").value) || 0;
  const includeBound = $("apIncludeBound").checked;
  _apCandidates = proposeAutoPairings({ tol, includeBound });
  const list = $("apList");
  list.innerHTML = "";
  let triples = 0, pairs = 0;
  for (const c of _apCandidates) { if (c.type === "triple") triples++; else pairs++; }
  $("apSummary").textContent = `找到 ${triples} 組三面 / ${pairs} 組雙面候選 — 公差 ${tol} ${state.unitName || "mm"}`;
  if (_apCandidates.length === 0) {
    list.innerHTML = '<div style="color:#9aa0a6;padding:8px">無候選 — 試著放寬公差,或確認頁面 plane 與 校準是否設好</div>';
    return;
  }
  _apCandidates.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "ap-row " + c.type;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (c.type === "triple"); // 三面預設勾,雙面預設不勾
    cb.dataset.idx = idx;
    const typeLabel = c.type === "triple" ? "三" : "雙";
    let coordTxt;
    if (c.type === "triple") {
      coordTxt = `(${_apFmtCoord(c.world.x)}, ${_apFmtCoord(c.world.y)}, ${_apFmtCoord(c.world.z)}) Δ${c.score.toFixed(1)}`;
    } else {
      coordTxt = `${c.sharedAxis.toUpperCase()}=${_apFmtCoord(c.members[0].world[c.sharedAxis])} Δ${c.score.toFixed(1)}`;
    }
    const sep = c.type === "triple" ? " + " : " ↔ ";
    row.appendChild(cb);
    const typeSpan = document.createElement("span");
    typeSpan.className = "ap-type"; typeSpan.textContent = typeLabel;
    row.appendChild(typeSpan);
    const mem = document.createElement("span");
    mem.className = "ap-members";
    mem.innerHTML = c.members.map(_apFmtMember).join(sep);
    row.appendChild(mem);
    const co = document.createElement("span");
    co.className = "ap-coord"; co.textContent = coordTxt;
    row.appendChild(co);
    list.appendChild(row);
  });
  // 全選 / 全不選工具列
  const tools = document.createElement("div");
  tools.style.cssText = "display:flex;gap:8px;padding:6px 8px;border-top:1px solid #444;font-size:11px";
  const bAll = document.createElement("a");
  bAll.href = "#"; bAll.textContent = "全選"; bAll.style.color = "#4fc3f7";
  bAll.onclick = (e) => { e.preventDefault(); list.querySelectorAll("input[type=checkbox]").forEach(c => c.checked = true); };
  const bNone = document.createElement("a");
  bNone.href = "#"; bNone.textContent = "全不選"; bNone.style.color = "#4fc3f7";
  bNone.onclick = (e) => { e.preventDefault(); list.querySelectorAll("input[type=checkbox]").forEach(c => c.checked = false); };
  const bTri = document.createElement("a");
  bTri.href = "#"; bTri.textContent = "只勾三面"; bTri.style.color = "#4fc3f7";
  bTri.onclick = (e) => {
    e.preventDefault();
    list.querySelectorAll(".ap-row").forEach(r => {
      const cb = r.querySelector("input[type=checkbox]");
      if (cb) cb.checked = r.classList.contains("triple");
    });
  };
  tools.appendChild(bAll); tools.appendChild(bNone); tools.appendChild(bTri);
  list.appendChild(tools);
}
$("autoPairBtn") && ($("autoPairBtn").onclick = openAutoPairDialog);

// Phase 8k:3D 立體預覽 popup 搬到 src/dialogs/preview3d.ts(~1700 行,大宗)
//   _3dPreviewWindow ref 還留在 legacy:i18n / busy / 主視窗 rebuild hook 都會讀,
//   preview3d 走 setP3dPreviewWindow setter 寫(ESM cross-module)。
export let _3dPreviewWindow: any = null;
export function setP3dPreviewWindow(v: any) { _3dPreviewWindow = v; }
import { open3DPreviewDialog } from "./dialogs/preview3d";
export { open3DPreviewDialog } from "./dialogs/preview3d";
$("btn3DPreview") && ($("btn3DPreview").onclick = open3DPreviewDialog);

// ===== 材料管理(工具 → 材料管理) =====
//   獨立 popup window;CRUD state.materials,使用者搜尋桿件時可從下拉選用
export let _materialMgrWin: any = null;
// Phase 8e:跨模組(materialMgr)要寫這個 ref → 必須走 setter
export function setMaterialMgrWin(v: any) { _materialMgrWin = v; }
// Phase 8e:openMaterialMgrWindow(材料管理 popup)搬到 src/dialogs/materialMgr.ts
import { openMaterialMgrWindow } from "./dialogs/materialMgr";

// Phase 8l:搜尋 popup(openSearchWindow / _searchModel / _renderSearchResults / _parseIdsWithRanges / history helpers)搬到 src/dialogs/search.ts(~2150 行)
//   _searchWin / _searchWinAutofill declaration + setter 留在 legacy(i18n.applyI18n 會 read _searchWin live binding)
export let _searchWin: any = null;
export function setSearchWin(v: any) { _searchWin = v; }
let _searchWinAutofill: any = null;
export function setSearchWinAutofill(v: any) { _searchWinAutofill = v; }
import { openSearchWindow } from "./dialogs/search";
export { openSearchWindow } from "./dialogs/search";

// 主頁面 Cmd/Ctrl+F → 開搜尋視窗(避免攔截 input 內的搜尋輸入)
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
  if (e.key !== "f" && e.key !== "F") return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
  e.preventDefault();
  openSearchWindow();
});

// 全局原點校準:用 prompt 讓使用者挑一個 globalJoint 當原點(預設第一個)→ 跑校準
$("btnSetGlobalOrigin") && ($("btnSetGlobalOrigin").onclick = () => {
  if (!Array.isArray(state.globalJoints) || state.globalJoints.length === 0) {
    alert("請先建立至少一個全局節點(在多個檔案上選同一個物理位置的節點 → 設為全局節點)");
    return;
  }
  // 列出 globalJoints 給使用者挑;每行附「世界座標 + 綁的 joint 數 + 跨幾個檔」,方便辨認
  const _fmtCoord = (v) => Number.isFinite(v) ? (Math.round(v * 10) / 10).toString() : "—";
  // 統計每個 globalJoint 被多少 joint / 多少 file 綁定
  const bindStats = new Map();   // gid → { jointCount, fileSet }
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      for (const j of (pg.joints || [])) {
        if (j.globalId == null) continue;
        let s = bindStats.get(j.globalId);
        if (!s) { s = { jointCount: 0, fileSet: new Set() }; bindStats.set(j.globalId, s); }
        s.jointCount++;
        s.fileSet.add(f.id);
      }
    }
  }
  const lines = state.globalJoints.map((g, i) => {
    const tag = g.label || ('N' + g.id);
    const coord = `(${_fmtCoord(g.x)}, ${_fmtCoord(g.y)}, ${_fmtCoord(g.z)})`;
    const s = bindStats.get(g.id) || { jointCount: 0, fileSet: new Set() };
    const lockMark = g.locked ? " 🔒" : "";
    const curMark = (state.globalOriginId === g.id) ? " ← 目前原點" : "";
    return `${i + 1}. ${tag}${lockMark} ・ ${coord} ・ 綁 ${s.jointCount} 顆 joint / ${s.fileSet.size} 檔${curMark}`;
  }).join("\n");
  const cur = state.globalOriginId;
  const curIdx = cur != null ? state.globalJoints.findIndex(g => g.id === cur) : -1;
  const def = (curIdx >= 0 ? curIdx : 0) + 1;
  const choice = prompt(
    `請輸入要當作世界原點的全局節點編號(1~${state.globalJoints.length}):\n\n${lines}\n\n` +
    `說明:座標 = 該全局節點目前的世界座標(mm)。\n` +
    `「綁 N 顆 joint / M 檔」= 共有 M 個檔案的 N 個本地 joint 指到這個全局節點。\n` +
    `校準後此全局節點會被鎖定在世界 (0, 0, 0),所有有綁定它的檔案會自動調整 planeOrigin / pageZ。`,
    String(def)
  );
  if (choice == null) return;
  const idx = parseInt(choice, 10) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= state.globalJoints.length) {
    alert("無效的編號");
    return;
  }
  const G = state.globalJoints[idx];
  calibrateAllFilesToGlobalOrigin({ globalJointId: G.id });
});
// 自訂世界原點座標:用 prompt 收三個數字 → 跑 calibrateAllFilesToCustomOrigin
$("btnSetCustomOrigin") && ($("btnSetCustomOrigin").onclick = () => {
  const filesWithScale = state.files.filter(f => f.scaleRuler && f.scaleRuler.ratio > 0);
  if (!filesWithScale.length) {
    alert("沒有任何檔案有比例尺,無法校準。請先在至少一個檔案建立比例尺。");
    return;
  }
  const raw = prompt(
    `輸入要當作世界原點的目前世界座標 (X, Y, Z),用逗號或空白分隔(單位 mm):\n\n` +
    `說明:輸入的 (X, Y, Z) = 目前模型中你想當作 (0, 0, 0) 的物理位置的世界座標。\n` +
    `例:輸入「1000, 0, 2500」→ 校準後,原本位於世界 (1000, 0, 2500) 的物理點會變成 (0, 0, 0);其他 joint 的世界座標都對應減去 (1000, 0, 2500)。\n\n` +
    `不需要對應任何已存在的 joint。會校準 ${filesWithScale.length} 個有比例尺的檔案。`,
    "0, 0, 0"
  );
  if (raw == null) return;
  const parts = raw.split(/[,\s]+/).filter(s => s.length > 0).map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) {
    alert("格式錯誤;請輸入三個數字(用逗號或空白分隔),例如:1000, 0, 2500");
    return;
  }
  calibrateAllFilesToCustomOrigin(parts[0], parts[1], parts[2]);
});
$("btnClearGlobalOrigin") && ($("btnClearGlobalOrigin").onclick = () => {
  if (state.globalOriginId == null) return;
  if (!confirm("解除全局原點指定?(只清狀態,各檔案的 planeOrigin / pageZ 不會還原)")) return;
  pushUndo();
  const G = state.globalJoints.find(g => g.id === state.globalOriginId);
  if (G) G.locked = false;
  state.globalOriginId = null;
  if (typeof refreshLists === "function") refreshLists();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  render();
});

// 顯示「解除原點」按鈕的條件 = 已指定全局原點時才顯示
export function _updateGlobalOriginUI() {
  // 沒有 globalJoints → 隱藏 globalJoint-based 校準按鈕,改顯示提示文字
  const hasGJ = Array.isArray(state.globalJoints) && state.globalJoints.length > 0;
  const calibWrap = $("globalOriginCalibBtns");
  const hint = $("globalJointHint");
  if (calibWrap) calibWrap.style.display = hasGJ ? "flex" : "none";
  if (hint)      hint.style.display      = hasGJ ? "none" : "";
  const btn = $("btnClearGlobalOrigin");
  if (btn) btn.style.display = (state.globalOriginId != null) ? "" : "none";
  // 更新「本頁設為全局原點」相關 UI
  const af = (typeof getActiveFile === "function") ? getActiveFile() : null;
  const isCurFileOrigin = !!(af && state.globalOriginFileId === af.id);
  const setBtn = $("btnSetFileAsOrigin");
  const unsetBtn = $("btnUnsetFileAsOrigin");
  if (setBtn) {
    if (isCurFileOrigin) {
      _setBtnLabel(setBtn, "rb.setOriginCurrent", "本頁 ✓ 全局原點");
      setBtn.style.background = "#2f7a3f";
    } else {
      _setBtnLabel(setBtn, "rb.setOrigin", "本頁原點 = 世界原點");
      setBtn.style.background = "";
    }
  }
  if (unsetBtn) unsetBtn.style.display = (state.globalOriginFileId != null) ? "" : "none";
  // info 文字:目前哪個檔案是全局原點
  const info = $("globalOriginInfo");
  if (info) {
    if (state.globalOriginFileId != null) {
      const ofile = state.files.find(f => f.id === state.globalOriginFileId);
      if (ofile) {
        const origin = ofile.planeOrigin;
        const op = ofile.pages && ofile.pages[0];
        const plane = op ? (op.plane || "?") : "?";
        const pz = op ? (op.z != null ? op.z : 0) : "?";
        info.style.display = "";
        info.textContent = `當前全局原點:${ofile.name}・${plane}・第三軸=${pz}` +
          (origin ? `・origin=(${origin.x.toFixed(0)}, ${origin.y.toFixed(0)})` : "・尚無 planeOrigin");
      } else {
        info.style.display = "none";
      }
    } else {
      info.style.display = "none";
    }
  }
}
_updateGlobalOriginUI();
$("btnSetFileAsOrigin") && ($("btnSetFileAsOrigin").onclick = () => {
  const af = getActiveFile();
  if (!af) { alert("請先選擇一個檔案"); return; }
  if (!af.planeOrigin) {
    alert(`目前檔案「${af.name}」尚未設定平面座標原點。請先設定原點再把它指定為全局原點。`);
    return;
  }
  if (!af.scaleRuler || !(af.scaleRuler.ratio > 0)) {
    alert(`目前檔案「${af.name}」尚未設定比例尺。請先建立比例尺。`);
    return;
  }
  pushUndo();
  state.globalOriginFileId = af.id;
  // 鎖定:這個檔案的 planeOrigin + pageZ 即是世界 (0,0,0)
  // 後續其他檔案的 planeOrigin 應由使用者手動設在同一物理位置
  if (typeof refreshLists === "function") refreshLists();
  if (typeof refreshFileList === "function") refreshFileList();
  _updateGlobalOriginUI();
  render();
  console.log(`[全局原點檔案] 設定 ${af.name} 為全局原點源`);
});
$("btnUnsetFileAsOrigin") && ($("btnUnsetFileAsOrigin").onclick = () => {
  if (state.globalOriginFileId == null) return;
  pushUndo();
  state.globalOriginFileId = null;
  if (typeof refreshLists === "function") refreshLists();
  if (typeof refreshFileList === "function") refreshFileList();
  _updateGlobalOriginUI();
  render();
});
$("apCancel") && ($("apCancel").onclick = closeAutoPairDialog);
$("apRescan") && ($("apRescan").onclick = rescanAutoPair);
$("apApply") && ($("apApply").onclick = () => {
  const list = $("apList");
  const checks = list.querySelectorAll("input[type=checkbox]:checked");
  if (!checks.length) { closeAutoPairDialog(); return; }
  const picked = [];
  checks.forEach(cb => {
    const idx = parseInt(cb.dataset.idx, 10);
    if (Number.isFinite(idx) && _apCandidates[idx]) picked.push(_apCandidates[idx]);
  });
  if (!picked.length) { closeAutoPairDialog(); return; }
  pushUndo();
  const r = applyAutoPairings(picked);
  closeAutoPairDialog();
  $("hud").textContent = `自動配對:建立 ${r.triples} 組三面 + ${r.pairs} 組雙面 → 共 ${r.triples + r.pairs} 個全局節點`;
  render(); refreshLists();
});

$("ctxDelete").onclick = (e) => {
  e.stopPropagation();
  if (!ctxPending) return;
  if (ctxPending.bgPaths && ctxPending.bgPaths.size) {
    hideCtxMenu();
    deleteSelectedBgPaths();
    return;
  }
  if (ctxPending.fileIds && ctxPending.fileIds.size) {
    state.selection.fileIds = new Set(ctxPending.fileIds);
    hideCtxMenu();
    deleteSelectedFiles();
    return;
  }
  clearSelection();
  ctxPending.joints.forEach((id) => state.selection.joints.add(id));
  ctxPending.members.forEach((id) => state.selection.members.add(id));
  hideCtxMenu();
  deleteSelection();
};

// ---------- side lists ----------
export function refreshLists() {
  // 同時更新檔案清單與頁次選單,確保節點/桿件數量同步
  if (typeof refreshFileList === "function") refreshFileList();
  if (typeof refreshPageSelector === "function") refreshPageSelector();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  if (typeof _refreshFloorTypeSidebar === "function") _refreshFloorTypeSidebar();
  const p = getPage();
  const af0 = getActiveFile();
  const orig = af0 && af0.planeOrigin;
  const jl = $("jointList"); jl.innerHTML = "";
  // 依內部 id 由小到大排序(顯示用的 displayJointId 與 id 同序;直接用 id 確保穩定)
  const jointsSorted = [...p.joints].sort((a, b) => a.id - b.id);
  // 軸名 header(對應 page.plane:XY → (x, y)、YZ → (z, y)、XZ → (x, z))。
  //   無 plane / 無校準 → 不顯示軸名(維持舊行為,row 顯示 px 或 raw)。
  const _axisLabelEl = $("jointListAxisLabel");
  if (_axisLabelEl) {
    let _axisLabelTxt = "";
    if (state.scale && p && p.plane) {
      const _probe = _inPlaneCoordsForJoint(af0, p, p.joints[0] || { x: 0, y: 0 });
      if (_probe) {
        _axisLabelTxt = ` (${_probe.axisA.toLowerCase()}, ${_probe.axisB.toLowerCase()})`;
      }
    }
    _axisLabelEl.textContent = _axisLabelTxt;
  }
  for (const j of jointsSorted) {
    const it = document.createElement("div");
    it.className = "item" + (state.selection.joints.has(j.id) ? " sel" : "");
    let real;
    if (state.scale) {
      const proj = _inPlaneCoordsForJoint(af0, p, j);
      if (proj) {
        // 用世界投影值 — flipX / flipY / planeOrigin / scaleRuler 已全套上,精準度走 measureDecimals
        real = `${fmtWorld3D(proj.valA)}, ${fmtWorld3D(proj.valB)} ${state.unitName}`;
      } else if (orig) {
        real = `${fmtWorld3D((j.x - orig.x)/state.scale)}, ${fmtWorld3D((orig.y - j.y)/state.scale)} ${state.unitName}`;
      } else {
        real = `${fmtWorld3D(j.x/state.scale)}, ${fmtWorld3D(-j.y/state.scale)} ${state.unitName}`;
      }
    } else {
      real = `${j.x.toFixed(0)}, ${j.y.toFixed(0)} px`;
    }
    it.innerHTML = `<span>J${displayJointId(j)}</span><span style="color:#9aa0a6">${real}</span>`;
    it.onclick = (e) => {
      if (!additiveSelect(e)) clearSelection();
      state.selection.joints.add(j.id);
      render(); refreshLists();
    };
    it.oncontextmenu = (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, { type: "joint", id: j.id, el: it });
    };
    jl.appendChild(it);
  }
  // 全局節點清單(縮減版 — 只列「目前這頁有綁的」全局節點;點任一筆 → 跳轉 popup;完整 CRUD 走「工具 → 全局節點管理」)
  const gl = $("globalJointList");
  if (gl) {
    gl.innerHTML = "";
    const af = getActiveFile();
    const allG = [...(state.globalJoints || [])].sort((a, b) => a.id - b.id);
    const curG = allG.filter(g => listGlobalBindings(g.id).some(b => b.fileId === (af && af.id) && b.pageIdx === state.pageIdx));
    if (allG.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#9aa0a6";
      empty.style.fontSize = "11px";
      empty.style.padding = "4px 2px";
      empty.textContent = (typeof _t==="function"&&_t("rb.globalJointHintShort"))||"(尚無全局節點 — 右鍵節點選「設為全局節點」)";
      gl.appendChild(empty);
    } else if (curG.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#9aa0a6";
      empty.style.fontSize = "11px";
      empty.style.padding = "4px 2px;line-height:1.5";
      empty.style.padding = "4px 2px";
      empty.innerHTML = `(本頁無綁定全局節點 — 共 ${allG.length} 個全局節點散佈在其他頁面)<br>完整清單與管理請到「工具 → 全局節點管理」`;
      gl.appendChild(empty);
    } else {
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:10px;color:#7b818a;padding:2px 2px 4px;line-height:1.4";
      hint.innerHTML = `本頁綁定 <b style="color:#4fc3f7">${curG.length}</b> / 共 <b>${allG.length}</b> ・ 點任一筆跳到綁定的其他頁面 ・ 完整管理:工具 → 全局節點管理`;
      gl.appendChild(hint);
    }
    for (const g of curG) {
      const binds = listGlobalBindings(g.id);
      const isPending = state.pendingGlobalPair === g.id;
      const hasW = (g.warnings && g.warnings.length > 0);
      const isOrigin = (state.globalOriginId === g.id);
      const it = document.createElement("div");
      it.className = "item";
      if (isPending) it.style.outline = "1px dashed #ffd23f";
      const coordTxt = (g.x != null || g.y != null || g.z != null)
        ? `(${fmtWorld3D(g.x)}, ${fmtWorld3D(g.y)}, ${fmtWorld3D(g.z)}) ${state.unitName || "?"}`
        : "(3D 未推得)";
      const warnDot = hasW ? `<span style="color:#ff7043">⚠</span>` : "";
      const originBadge = isOrigin ? `<span style="background:#ffe066;color:#000;padding:0 4px;border-radius:3px;font-size:9px;font-weight:700;margin-left:4px">原點</span>` : "";
      it.innerHTML = `<span style="color:#4fc3f7">${g.label}${isPending ? " ⋯" : ""} ${warnDot}${originBadge}</span>`
        + `<span style="color:#9aa0a6">${coordTxt}・${binds.length} 處</span>`;
      it.title = `全局節點 ${g.label}・${binds.length} 個視圖綁定`
        + (isOrigin ? "(目前為世界原點 0,0,0)" : "")
        + (isPending ? "(配對中)" : "")
        + (hasW ? "\n警告:\n" + g.warnings.map(w => "  • " + w.message).join("\n") : "")
        + "\n\n點擊 → 選要跳到的頁面";
      it.onclick = (ev) => {
        ev.stopPropagation();
        if (typeof showGlobalJointJumpPopup === "function") showGlobalJointJumpPopup(it, g.id);
      };
      gl.appendChild(it);
    }
  }

  const ml = $("memberList"); ml.innerHTML = "";
  // 桿件同樣依內部 id 由小到大排序
  const membersSorted = [...p.members].sort((a, b) => a.id - b.id);
  for (const m of membersSorted) {
    const it = document.createElement("div");
    it.className = "item" + (state.selection.members.has(m.id) ? " sel" : "");
    const a = jointById(m.j1), b = jointById(m.j2);
    let len = "";
    if (a && b && state.scale) {
      const d = Math.hypot(a.x-b.x, a.y-b.y) / state.scale;
      len = `${fmtCoord(d)} ${state.unitName}`;
    }
    it.innerHTML = `<span>M${displayMemberId(m)} (J${displayJointId({id:m.j1})}–J${displayJointId({id:m.j2})})</span><span style="color:#9aa0a6">${len}</span>`;
    it.onclick = (e) => {
      if (!additiveSelect(e)) clearSelection();
      state.selection.members.add(m.id);
      render(); refreshLists();
    };
    it.oncontextmenu = (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, { type: "member", id: m.id, el: it });
    };
    ml.appendChild(it);
  }
}

// ---------- inputs ----------
$("snapPx").onchange = (e) => state.snapPx = parseFloat(e.target.value);
$("snapAxis").onchange = (e) => { state.ortho = e.target.checked; };
$("snapMid").onchange = (e) => { state.snapMid = e.target.checked; };
$("snapGridStep").onchange = (e) => {
  state.snapGrid.step = parseFloat(e.target.value) || 1;
  updateSnapGridBtn();
  render();
};
$("bgSnapTolerance") && ($("bgSnapTolerance").onchange = (e) => {
  const v = Number(e.target.value);
  state.bgSnapTolerance = Number.isFinite(v) && v >= 0 ? v : 1;
  e.target.value = state.bgSnapTolerance;
});
$("coordDecimals") && ($("coordDecimals").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  state.coordDecimals = (Number.isFinite(v) && v >= 0 && v <= 6) ? v : 0;
  e.target.value = state.coordDecimals;
  refreshLists();
});
$("measureDecimals") && ($("measureDecimals").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  state.measureDecimals = (Number.isFinite(v) && v >= 0 && v <= 6) ? v : 0;
  e.target.value = state.measureDecimals;
  if (typeof _refreshAllMeasurementLabels === "function") _refreshAllMeasurementLabels();
  // 精準度改變 → globalJoint 座標也要重新對齊新精準度(0 → -0 / 224.7 → 225 之類)
  pushUndo();
  const touched = (typeof snapAllGlobalJointsToPrecision === "function") ? snapAllGlobalJointsToPrecision() : 0;
  if (touched) console.log(`[精準度] globalJoint 座標重新對齊 ${touched} 個`);
  // 顯示位數即 rank bucket 大小 → 改了之後 node 編號需要重算
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  render();
});

// 已載入檔案清單欄位顯示開關(在 popup 中)
function bindFileListShowCheckbox(id, key) {
  const el = $(id);
  if (!el) return;
  el.checked = !!(state.fileListShow && state.fileListShow[key] !== false);
  el.onchange = () => {
    if (!state.fileListShow) state.fileListShow = { type: true, plane: true, stats: true };
    state.fileListShow[key] = !!el.checked;
    refreshFileList();
  };
}
bindFileListShowCheckbox("fileListShowType",  "type");
bindFileListShowCheckbox("fileListShowPlane", "plane");
bindFileListShowCheckbox("fileListShowStats", "stats");

// Popup 顯示 / 隱藏:點 ⚙ 開關;點外面關閉
function positionFileListShowPopup() {
  const btn = $("fileListShowBtn"), pop = $("fileListShowPopup");
  if (!btn || !pop) return;
  const r = btn.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.top = (r.bottom + 4) + "px";
  // 偏左對齊到按鈕,但若超出右邊界就右對齊
  const popW = pop.offsetWidth || 220;
  let left = r.right - popW;
  if (left < 8) left = 8;
  pop.style.left = left + "px";
}
$("fileListShowBtn") && ($("fileListShowBtn").onclick = (e) => {
  e.stopPropagation();
  const pop = $("fileListShowPopup");
  if (!pop) return;
  const open = pop.style.display === "block";
  if (open) { pop.style.display = "none"; return; }
  pop.style.display = "block";
  positionFileListShowPopup();
});
document.addEventListener("click", (e) => {
  const pop = $("fileListShowPopup");
  if (!pop || pop.style.display !== "block") return;
  if (pop.contains(e.target)) return;
  if (e.target && e.target.id === "fileListShowBtn") return;
  pop.style.display = "none";
});
window.addEventListener("resize", () => {
  const pop = $("fileListShowPopup");
  if (pop && pop.style.display === "block") positionFileListShowPopup();
  if (typeof applyToolbarBounds === "function") applyToolbarBounds();
});
$("relayoutDirection") && ($("relayoutDirection").onchange = (e) => {
  state.relayoutDirection = (e.target.value === "horizontal") ? "horizontal" : "vertical";
});
$("relayoutCapacity") && ($("relayoutCapacity").onchange = (e) => {
  const v = parseInt(e.target.value, 10);
  state.relayoutCapacity = (Number.isFinite(v) && v >= 10) ? v : 100;
  e.target.value = state.relayoutCapacity;
});
// 桿件編號 cap(全局):每軸方向 / 斜桿
function _bindMemberCap(id, key) {
  const el = $(id);
  if (!el) return;
  el.value = String(state[key] || 99);
  el.onchange = (e) => {
    const v = parseInt(e.target.value, 10);
    state[key] = ([9, 99, 999, 9999].includes(v)) ? v : 99;
    e.target.value = String(state[key]);
  };
}
_bindMemberCap("memberCapY", "memberCapY");
_bindMemberCap("memberCapX", "memberCapX");
_bindMemberCap("memberCapZ", "memberCapZ");
_bindMemberCap("memberCapDiag", "memberCapDiag");
// 切面樣式:標籤字體 + 線條粗度,改完即重畫
function _ensureSectionLinkStyle() {
  if (!state.sectionLinkStyle) state.sectionLinkStyle = { fontPt: 15, strokeWidth: 30 };
}
$("slFontPt") && ($("slFontPt").onchange = (e) => {
  _ensureSectionLinkStyle();
  const v = parseInt(e.target.value, 10);
  state.sectionLinkStyle.fontPt = (Number.isFinite(v) && v >= 6 && v <= 200) ? v : 15;
  e.target.value = state.sectionLinkStyle.fontPt;
  render();
});
$("slStrokeWidth") && ($("slStrokeWidth").onchange = (e) => {
  _ensureSectionLinkStyle();
  const v = parseInt(e.target.value, 10);
  state.sectionLinkStyle.strokeWidth = (Number.isFinite(v) && v >= 1 && v <= 50) ? v : 30;
  e.target.value = state.sectionLinkStyle.strokeWidth;
  render();
});
export function updateSnapGridBtn() {
  const m = state.snapGrid.mode;
  const btn = $("snapGridBtn");
  if (!btn) return;
  btn.classList.toggle("active", m > 0);
  const u = state.unitName, st = state.snapGrid.step;
  const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
  if (m === 0)      btn.textContent = T("tb.snapOff", "鎖點 關閉");
  else if (m === 1) btn.textContent = `${T("tb.snapPoint", "鎖點 點")} · ${st}${u}`;
  else              btn.textContent = `${T("tb.snapGrid", "鎖點 網格")} · ${st}${u}`;
}
function cycleSnapGrid() {
  // 順序:網格 → 點 → 關閉 → 網格
  state.snapGrid.mode = (state.snapGrid.mode + 2) % 3;
  updateSnapGridBtn();
  render();
}

// 選取模式輪播:全部 → 只選點 → 只選線 → 全部
function cycleSelectFilter() {
  const order = ["all", "joints", "members"];
  const i = order.indexOf(state.selectFilter);
  state.selectFilter = order[(i + 1) % 3];
  updateSelectToolLabel();
  applyTransform();
}
function selectFilterLabel(f) {
  const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
  return f === "joints" ? T("hud.selectJoints","選取點")
       : f === "members" ? T("hud.selectMembers","選取線")
       : T("hud.selectAll","選取");
}
export function updateSelectToolLabel() {
  const btn = $("tool-select");
  if (!btn) return;
  const key = state.multiSelectSticky ? "tb.toolMulti" : "tb.toolSelect";
  const fb  = state.multiSelectSticky ? "多選"          : "選取";
  _setBtnLabel(btn, key, fb);
  btn.classList.toggle("multi", !!state.multiSelectSticky);
}

// Shift+S 連按浮動選單(放開 Shift 確認)
let pendingFilter = null;
function showSelectModePopup() {
  const btn = $("tool-select");
  const r = btn.getBoundingClientRect();
  const pop = $("selectModePopup");
  pop.style.left = r.left + "px";
  pop.style.top = (r.bottom + 4) + "px";
  pop.style.display = "block";
  if (pendingFilter === null) pendingFilter = state.selectFilter;
  updateSelectModePopup();
}
function hideSelectModePopup() {
  $("selectModePopup").style.display = "none";
}
function cyclePendingFilter() {
  const order = ["all", "joints", "members"];
  const cur = pendingFilter !== null ? pendingFilter : state.selectFilter;
  const i = order.indexOf(cur);
  pendingFilter = order[(i + 1) % 3];
  updateSelectModePopup();
}
function updateSelectModePopup() {
  const f = pendingFilter !== null ? pendingFilter : state.selectFilter;
  document.querySelectorAll("#selectModePopup .smp-item").forEach(el => {
    el.classList.toggle("active", el.dataset.filter === f);
  });
}
function commitPendingFilter() {
  if (pendingFilter !== null) {
    state.selectFilter = pendingFilter;
    pendingFilter = null;
    hideSelectModePopup();
    updateCtxFilterRadios && updateCtxFilterRadios();
    updateSelectToolLabel();
    applyTransform();
  }
}
// 點選 popup 項目也可直接設定
document.querySelectorAll("#selectModePopup .smp-item").forEach(el => {
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    pendingFilter = el.dataset.filter;
    commitPendingFilter();
  });
});
$("snapGridLineChk")  && ($("snapGridLineChk").onchange  = (e) => { state.snapToGridLines  = e.target.checked; });
$("snapGridPointChk") && ($("snapGridPointChk").onchange = (e) => { state.snapToGridPoints = e.target.checked; });
$("snapGridBtn").onclick = cycleSnapGrid;
$("snapLinesPriority").onchange = (e) => {
  state.snapLinesPriority = e.target.checked;
  render();
};
$("pageZ").onchange = (e) => { pushUndo(); getPage().z = parseFloat(e.target.value) || 0; _afterCalibrationChanged(); };

// ---------- export ----------
// buildModel + showBuildModelCollisionsIfAny 移到 src/core/buildModel.ts(Phase 3e)

// staadUnitKeyword / unitToMeter / meterToTarget 移到 src/utils/units.ts(Phase 2)

// Phase 8g:exportStaad button handler 抽成 named function 進 src/export/std.ts
import { exportStdFile } from "./export/std";
$("exportStaad") && ($("exportStaad").onclick = exportStdFile);

// Phase 8f:exportXlsxFile + CRC32/ZIP/OOXML 組裝 helpers 搬到 src/export/xlsx.ts
import { exportXlsxFile } from "./export/xlsx";
export { exportXlsxFile } from "./export/xlsx";

$("exportJson").onclick = () => {
  const data = {
    schema: "staad-tracer/2",
    scale: state.scale, unitName: state.unitName,
    files: state.files.map(f => ({
      id: f.id, name: f.name, type: f.type,
      pageCount: f.pageCount,
      pages: f.pages || {},
    })),
    activeFileId: state.activeFileId,
    pageIdx: state.pageIdx,
  };
  download("model.json", JSON.stringify(data, null, 2));
};

$("importJson").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const txt = await f.text();
  const data = JSON.parse(txt);
  pushUndo();
  state.scale = data.scale || null;
  state.unitName = data.unitName || "mm";
  if (data.files) {
    state.files = data.files.map(fs => ({
      id: fs.id, name: fs.name, type: fs.type,
      pageCount: fs.pageCount || Object.keys(fs.pages || {}).length || 1,
      pages: fs.pages || {},
    }));
    if (state.files.length) nextFileId = Math.max(nextFileId, ...state.files.map(f => f.id + 1));
    state.activeFileId = data.activeFileId ?? (state.files[0] && state.files[0].id) ?? null;
    state.pageIdx = data.pageIdx || 0;
  } else if (data.pages) {
    // 舊格式 v1:轉成單一檔案
    const pageCount = Math.max(1, ...Object.keys(data.pages).map(k => +k + 1));
    const file = {
      id: nextFileId++,
      name: "已匯入專案", type: "legacy",
      pageCount, pages: data.pages,
    };
    state.files = [file];
    state.activeFileId = file.id;
    state.pageIdx = data.pageIdx || 0;
  }
  for (const file of state.files) {
    for (const pg of Object.values(file.pages || {})) {
      for (const j of pg.joints) nextJointId = Math.max(nextJointId, j.id + 1);
      for (const m of pg.members) nextMemberId = Math.max(nextMemberId, m.id + 1);
    }
  }
  alert("已讀入「標線」資料(輕量格式,不含底圖)。\n\n要連同底圖一起儲存/讀回,請改用下方「完整專案(含底圖)」的儲存/讀入按鈕。");
  refreshFileList(); refreshPageSelector();
  render(); refreshLists();
  e.target.value = "";
};

$("saveProject") && ($("saveProject").onclick = () => _startSaveWithHook(false));
$("loadProject") && ($("loadProject").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await withBusy("讀入專案中…", () => loadProjectFull(f));
  e.target.value = "";
});

// Phase 8d:parseDxf / dxfBbox / dxfToSvg 搬到 src/utils/dxf.ts(純函式,無 DOM / state 依賴)
import { parseDxf, dxfBbox, dxfToSvg } from "./utils/dxf";
export { parseDxf, dxfBbox, dxfToSvg } from "./utils/dxf";
function download(name, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ---------- 專案儲存 / 讀取(含 PDF / 圖片底圖)----------
// Phase 8c:setBusyMessage / busyTick / showBusy / showBusyWithCancel / hideBusy 搬到 src/ui/busy.ts
import { setBusyMessage, busyTick, showBusy, showBusyWithCancel, hideBusy } from "./ui/busy";
export { setBusyMessage, busyTick, showBusy, showBusyWithCancel, hideBusy } from "./ui/busy";

// Phase 8i:專案儲存 / 讀取(blobToBase64 / base64ToArrayBuffer / fmtMB / startSave / saveProjectFull/As / buildProjectBlob / ensureRwPermission / writeProjectWithHandle)搬到 src/state/projectFile.ts
import { base64ToArrayBuffer, fmtMB, startSave, saveProjectFull, saveProjectAs, ensureRwPermission } from "./state/projectFile";
export { base64ToArrayBuffer, fmtMB, startSave, saveProjectFull, saveProjectAs, ensureRwPermission } from "./state/projectFile";

// Phase 8h:recent projects IDB(_openRecentDB / _saveRecentProject / _getRecentProjects / _removeRecentProject / _openRecentProject)搬到 src/state/recentProjects.ts
import { _saveRecentProject, _getRecentProjects, _removeRecentProject, _openRecentProject } from "./state/recentProjects";
export { _saveRecentProject, _getRecentProjects, _removeRecentProject, _openRecentProject } from "./state/recentProjects";

// Phase 8j:loadProjectFull(完整專案讀取)搬到 src/state/projectLoad.ts
import { loadProjectFull } from "./state/projectLoad";
export { loadProjectFull } from "./state/projectLoad";

$("clearAll").onclick = () => {
  // 只清節點 + 桿件,保留所有檔案與底圖、平面、原點、比例尺、切面線、標示等
  if (!confirm("確定要清除所有節點與桿件嗎?\n(圖檔 / 底圖 / 平面 / 原點 / 比例尺 / 切面線 / 標線等都不會被刪除)")) return;
  pushUndo();
  let totalJ = 0, totalM = 0, totalGJ = 0;
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg) continue;
      if (Array.isArray(pg.joints))  { totalJ += pg.joints.length;  pg.joints  = []; }
      if (Array.isArray(pg.members)) { totalM += pg.members.length; pg.members = []; }
    }
  }
  // 全局節點(綁定的 metadata)也一併清掉,因為沒了 joints 也綁不到誰
  if (Array.isArray(state.globalJoints)) { totalGJ = state.globalJoints.length; state.globalJoints = []; }
  state.globalMembers = [];
  state.globalOriginId = null;
  state.globalOriginFileId = null;
  nextJointId = 1; nextMemberId = 1; nextGlobalJointId = 1; nextGlobalMemberId = 1;
  clearSelection();
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  refreshFileList && refreshFileList();
  refreshPageSelector && refreshPageSelector();
  render && render();
  refreshLists && refreshLists();
  console.log(`[清除] 刪 ${totalJ} 個節點、${totalM} 條桿件、${totalGJ} 個全局節點;保留所有檔案與底圖`);
  $("hud").textContent = `已清除 ${totalJ} 個節點、${totalM} 條桿件、${totalGJ} 個全局節點`;
};

// ---------- sidebar 寬度與收合 ----------
const sidebarWidth = { left: 220, right: 220 };
function applySidebarWidth() {
  $("sbLeft").style.width = sidebarWidth.left + "px";
  $("sbRight").style.width = sidebarWidth.right + "px";
  $("leftResizer").style.left = (12 + sidebarWidth.left - 3) + "px";
  $("rightResizer").style.right = (12 + sidebarWidth.right - 3) + "px";
  // 收合按鈕位置:展開時貼著側欄外緣 4px;收合時固定在最邊
  if (!$("sbLeft").classList.contains("collapsed"))
    $("leftToggle").style.left = (12 + sidebarWidth.left + 4) + "px";
  if (!$("sbRight").classList.contains("collapsed"))
    $("rightToggle").style.right = (12 + sidebarWidth.right + 4) + "px";
  // HUD 由 CSS 固定在「中間下方偏右」(bottom 18px, left 75%, translateX -50%)
  // zoomTools:右側欄外緣 / 收合時靠視窗右邊
  const rightCollapsed = $("sbRight").classList.contains("collapsed");
  $("zoomTools").style.right = (rightCollapsed ? 12 : (12 + sidebarWidth.right + 28)) + "px";
  // bgEditTools / selectTools:左側欄外緣 / 收合時靠視窗左邊
  const leftCollapsed = $("sbLeft").classList.contains("collapsed");
  const leftPx = (leftCollapsed ? 12 : (12 + sidebarWidth.left + 28)) + "px";
  $("bgEditTools").style.left = leftPx;
  if ($("selectTools")) $("selectTools").style.left = leftPx;
  applyToolbarBounds();
}
function applyToolbarBounds() {
  const tb = $("toolbar");
  if (!tb) return;
  const sel = $("selectTools"), bgE = $("bgEditTools"), zoom = $("zoomTools");
  const visW = (el) => (el && el.offsetParent !== null) ? el.offsetWidth : 0;
  const leftToolW = Math.max(visW(sel), visW(bgE));
  const leftCollapsed = $("sbLeft").classList.contains("collapsed");
  const rightCollapsed = $("sbRight").classList.contains("collapsed");
  const leftBase = leftCollapsed ? 12 : (12 + sidebarWidth.left + 28);
  const rightBase = rightCollapsed ? 12 : (12 + sidebarWidth.right + 28);
  tb.style.left = (leftBase + leftToolW + 8) + "px";
  tb.style.right = (rightBase + visW(zoom) + 8) + "px";
  // 把左右 tool 區的 top 設在 toolbar 下方,避免遮住上方控制區
  const tbRect = tb.getBoundingClientRect();
  const topY = Math.max(100, Math.round(tbRect.bottom) + 8);
  const topPx = topY + "px";
  // 限制 tool 區最大高度為視窗高度 - top - 底部留白,讓內容超出時能 flex-wrap 換到下一欄
  const maxH = Math.max(120, window.innerHeight - topY - 16);
  const maxHPx = maxH + "px";
  if (sel)  { sel.style.top = topPx;  sel.style.maxHeight = maxHPx; }
  if (bgE)  { bgE.style.top = topPx;  bgE.style.maxHeight = maxHPx; }
  if (zoom) { zoom.style.top = topPx; }
}

// ---------- 檔案頁面分頁列 ----------
function addTab(fileId, pageIdx) {
  pageIdx = pageIdx || 0;
  if (!state.openTabs) state.openTabs = [];
  const exists = state.openTabs.some(t => t.fileId === fileId && (t.pageIdx || 0) === pageIdx);
  if (!exists) state.openTabs.push({ fileId, pageIdx });
  refreshTabBar();
}
function removeTab(fileId, pageIdx) {
  if (!state.openTabs) return;
  pageIdx = pageIdx || 0;
  const i = state.openTabs.findIndex(t => t.fileId === fileId && (t.pageIdx || 0) === pageIdx);
  if (i < 0) return;
  state.openTabs.splice(i, 1);
  refreshTabBar();
}
function refreshTabBar() {
  const el = $("tabBar");
  if (!el) return;
  if (!state.openTabs) state.openTabs = [];
  // 清掉指向已不存在檔案 / 越界頁的 tab
  state.openTabs = state.openTabs.filter(t => {
    const f = state.files.find(ff => ff.id === t.fileId);
    return f && (t.pageIdx || 0) < (f.pageCount || 1);
  });
  el.innerHTML = "";
  for (const t of state.openTabs) {
    const f = state.files.find(ff => ff.id === t.fileId);
    if (!f) continue;
    const pIdx = t.pageIdx || 0;
    const isActive = (state.activeFileId === t.fileId && state.pageIdx === pIdx);
    const tab = document.createElement("div");
    tab.className = "tab" + (isActive ? " active" : "");
    const multi = (f.pageCount || 1) > 1;
    tab.title = f.name + (multi ? ` · 第${pIdx + 1}頁` : "");
    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = f.name + (multi ? ` ·${pIdx + 1}` : "");
    tab.appendChild(name);
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "關閉分頁";
    close.onclick = (e) => { e.stopPropagation(); removeTab(t.fileId, pIdx); };
    tab.appendChild(close);
    tab.onclick = () => activatePageWithBusy(t.fileId, pIdx);
    tab.onmousedown = (e) => { if (e.button === 1) { e.preventDefault(); removeTab(t.fileId, pIdx); } };
    el.appendChild(tab);
  }
  el.style.display = state.openTabs.length ? "flex" : "none";
}
function bindResizer(handleId, side) {
  const handle = $(handleId);
  let startX, startW;
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = sidebarWidth[side];
    handle.classList.add("dragging");
    document.body.style.cursor = "ew-resize";
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const w = side === "left" ? startW + dx : startW - dx;
      sidebarWidth[side] = Math.max(220, Math.min(560, w));
      applySidebarWidth();
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}
bindResizer("leftResizer", "left");
bindResizer("rightResizer", "right");

function bindCollapser(toggleId, sidebarId, expanded, collapsed) {
  const t = $(toggleId), s = $(sidebarId);
  t.onclick = () => {
    const isCollapsed = s.classList.toggle("collapsed");
    t.classList.toggle("collapsed", isCollapsed);
    t.textContent = isCollapsed ? expanded : collapsed;
    t.title = isCollapsed ? "展開側欄" : "收合側欄";
    applySidebarWidth();
  };
}
bindCollapser("leftToggle", "sbLeft", "›", "‹");
bindCollapser("rightToggle", "sbRight", "‹", "›");
applySidebarWidth();

// ---------- page selector ----------
$("pageSelector").addEventListener("change", (e) => {
  const v = e.target.value;
  if (!v) return;
  const [fid, pidx] = v.split("/").map(Number);
  activatePageWithBusy(fid, pidx);
});

// ---------- hover 資訊 tooltip ----------
function ensureHoverTip() {
  let t = document.getElementById("hoverTip");
  if (!t) {
    t = document.createElement("div");
    t.id = "hoverTip";
    document.body.appendChild(t);
  }
  return t;
}
export function showHoverTip(html, ev) {
  const t = ensureHoverTip();
  t.innerHTML = html;
  t.style.display = "block";
  positionHoverTip(t, ev.clientX, ev.clientY);
}
export function moveHoverTip(ev) {
  const t = document.getElementById("hoverTip");
  if (!t || t.style.display === "none") return;
  positionHoverTip(t, ev.clientX, ev.clientY);
}
export function hideHoverTip() {
  const t = document.getElementById("hoverTip");
  if (t) t.style.display = "none";
}
function positionHoverTip(t, mx, my) {
  const off = 14;
  const r = t.getBoundingClientRect();
  let x = mx + off, y = my + off;
  if (x + r.width  > window.innerWidth)  x = mx - r.width  - off;
  if (y + r.height > window.innerHeight) y = my - r.height - off;
  t.style.left = Math.max(0, x) + "px";
  t.style.top  = Math.max(0, y) + "px";
}
function escHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
}
function tipRow(key, val) {
  return `<span class="ttip-row"><span class="ttip-key">${escHtml(key)}:</span> <span class="ttip-val">${escHtml(val)}</span></span>`;
}
export function fmtJointInfo(j) {
  const af = getActiveFile();
  const o  = af && af.planeOrigin;
  const id = displayJointId(j);
  // i18n helper:沒翻譯回 fallback
  const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
  const anchorTag = j.isAnchor ? ` <span style="color:#ff8c00;font-weight:700">▼ ${T("hover.anchor","錨點")}</span>` : "";
  const lines = [`<span class="ttip-title">${T("hover.joint.title","節點")} J${id}${anchorTag}</span>`];
  if (j.isAnchor) {
    lines.push(tipRow(T("hover.anchor","錨點"), "手動標記 — rank 編號時視為座標軸 anchor(等同 H+V 真實交點),不會被推到後段"));
  }
  if (state.scale && o) {
    const p0 = getPage();
    const proj = (typeof _inPlaneCoordsForJoint === "function") ? _inPlaneCoordsForJoint(af, p0, j) : null;
    if (proj) {
      // 軸名跟著本頁 plane(已套 flipX/Y);精準度走 measureDecimals
      lines.push(tipRow(T("hover.coord","真實座標") + ` (${proj.axisA.toLowerCase()}, ${proj.axisB.toLowerCase()})`,
        `(${fmtWorld3D(proj.valA)}, ${fmtWorld3D(proj.valB)}) ${state.unitName}`));
    } else {
      const rx = (j.x - o.x) / state.scale;
      const ry = (o.y - j.y) / state.scale;
      lines.push(tipRow(T("hover.coord","真實座標"), `(${fmtWorld3D(rx)}, ${fmtWorld3D(ry)}) ${state.unitName}`));
    }
  } else if (state.scale) {
    lines.push(tipRow(T("hover.coord","座標"), `(${fmtWorld3D(j.x/state.scale)}, ${fmtWorld3D(-j.y/state.scale)}) ${state.unitName}`));
    lines.push(tipRow(T("hover.tip","提示"), T("hover.noOrigin","尚未設定平面原點")));
  } else {
    lines.push(tipRow("px", `(${j.x.toFixed(0)}, ${j.y.toFixed(0)}) px`));
    lines.push(tipRow(T("hover.tip","提示"), T("hover.notCalibrated","尚未校準(無比例尺/原點)")));
  }
  const p = getPage();
  const conn = p.members.filter(m => m.j1 === j.id || m.j2 === j.id);
  const connTxt = conn.length
    ? conn.map(m => "M" + displayMemberId(m)).join(", ")
    : "—";
  lines.push(tipRow(T("hover.connectedMembers","連接桿件"), `${conn.length} ${T("dyn.members","條")} ${connTxt}`));
  // 全局節點關聯
  if (j.globalId != null) {
    const g = findGlobalJointById(j.globalId);
    if (g) {
      const binds = listGlobalBindings(g.id);
      const others = binds.filter(b => !(b.fileId === (af && af.id) && b.pageIdx === state.pageIdx));
      const otherTxt = others.length
        ? others.map(b => `${b.fileName}#${b.pageIdx + 1}`).join(", ")
        : "(僅本頁)";
      lines.push(tipRow("全局節點", g.label));
      lines.push(tipRow("跨視圖", `${binds.length} 處 · ${otherTxt}`));
      const u = state.unitName || "?";
      if (g.x != null || g.y != null || g.z != null) {
        lines.push(tipRow("3D 座標 (x, y, z)", `(${fmtWorld3D(g.x)}, ${fmtWorld3D(g.y)}, ${fmtWorld3D(g.z)}) ${u}`));
      } else {
        lines.push(tipRow("3D 座標", "未推得(需設定 page.plane + 校準)"));
      }
      if (g.warnings && g.warnings.length > 0) {
        lines.push(tipRow("⚠ 一致性", `${g.warnings.length} 條警告(見側欄 tooltip)`));
      }
    }
  }
  return lines.join("\n");
}
export function fmtMemberInfo(m) {
  const a = jointById(m.j1), b = jointById(m.j2);
  const af = getActiveFile();
  const o  = af && af.planeOrigin;
  const id = displayMemberId(m);
  const ja = displayJointId({id: m.j1});
  const jb = displayJointId({id: m.j2});
  const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
  const lines = [`<span class="ttip-title">${T("hover.member.title","桿件")} M${id}　(J${ja} – J${jb})</span>`];
  if (!a || !b) { lines.push(tipRow(T("hover.state","狀態"), T("hover.endpointMissing","端點不存在"))); return lines.join("\n"); }
  const dpx = Math.hypot(a.x - b.x, a.y - b.y);
  if (state.scale) {
    const len   = dpx / state.scale;
    const dx    = (b.x - a.x) / state.scale;
    const dy    = (a.y - b.y) / state.scale;   // 翻轉 y:工程慣例向上為正
    const angle = Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI;
    lines.push(tipRow(T("hover.length","長度"), `${fmtCoord(len)} ${state.unitName}`));
    lines.push(tipRow(T("hover.delta","Δx, Δy"), `(${fmtCoord(dx)}, ${fmtCoord(dy)}) ${state.unitName}`));
    lines.push(tipRow(T("hover.angle","夾角"), `${angle.toFixed(2)}°`));
    if (o) {
      const p0 = getPage();
      const projA = (typeof _inPlaneCoordsForJoint === "function") ? _inPlaneCoordsForJoint(af, p0, a) : null;
      const projB = (typeof _inPlaneCoordsForJoint === "function") ? _inPlaneCoordsForJoint(af, p0, b) : null;
      if (projA && projB) {
        // 端點座標也走 in-plane 投影(套 flipX/Y)+ 精準度
        lines.push(tipRow(`J${ja} (${projA.axisA.toLowerCase()}, ${projA.axisB.toLowerCase()})`,
          `(${fmtWorld3D(projA.valA)}, ${fmtWorld3D(projA.valB)}) ${state.unitName}`));
        lines.push(tipRow(`J${jb} (${projB.axisA.toLowerCase()}, ${projB.axisB.toLowerCase()})`,
          `(${fmtWorld3D(projB.valA)}, ${fmtWorld3D(projB.valB)}) ${state.unitName}`));
      } else {
        const ax = (a.x - o.x) / state.scale, ay = (o.y - a.y) / state.scale;
        const bx = (b.x - o.x) / state.scale, by = (o.y - b.y) / state.scale;
        lines.push(tipRow(`J${ja}`, `(${fmtWorld3D(ax)}, ${fmtWorld3D(ay)}) ${state.unitName}`));
        lines.push(tipRow(`J${jb}`, `(${fmtWorld3D(bx)}, ${fmtWorld3D(by)}) ${state.unitName}`));
      }
    } else {
      lines.push(tipRow(T("hover.tip","提示"), T("hover.noOrigin","尚未設定平面原點")));
    }
  } else {
    lines.push(tipRow(T("hover.length","長度"), `${dpx.toFixed(0)} px`));
    lines.push(tipRow(T("hover.tip","提示"), T("hover.notCalibrated","尚未校準(無比例尺/原點)")));
  }
  // 材料(若桿件已設定;global 屬性,任何頁面都同步)
  if (m && m.material) lines.push(tipRow(T("hover.material","材料"), String(m.material)));
  return lines.join("\n");
}

// ---------- 節點 ID 編碼:XXYYZZ(N=各軸最大位數)----------
//   軸坐標 rank-based:對所有檔案的所有節點,把世界 X / Y / Z 各自抽出來、以「正交先 → 非正交後」分群並排序、給 rank
//   Joint 的 displayId = padZero(X_rank, N) + padZero(Y_rank, N) + padZero(Z_rank, N)
//   正交判定:該 joint 的所有連接桿件中,至少有一條水平 + 至少一條垂直(2D 平面內)→ 正交
//   只有斜桿件 → 非正交,排到該軸 rank 的最後
//   Cache 會在 invalidateRankCache 被叫時失效;每次 displayJointId 進來時 lazy 重算
// _rankCache + invalidateRankCache 移到 src/core/rankCache.ts(Phase 3d)
function _isJointOrtho(j, page) {
  if (!page || !Array.isArray(page.members)) return false;
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  let hasH = false, hasV = false;
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    if (Math.abs(dx) < tol && Math.abs(dy) < tol) continue;
    if (Math.abs(dy) < tol && Math.abs(dx) > tol) hasH = true;
    if (Math.abs(dx) < tol && Math.abs(dy) > tol) hasV = true;
    if (hasH && hasV) return true;
  }
  return false;
}
// 判定 joint 是否「有任何斜撐 member 連接」 — rank cache 用此把 brace 相關座標推到後段
//   true = 有 ≥1 條 diagonal member(就算同時也有 H/V 也算)→ rank 會被 demote
//   false = 沒有斜撐(全 axis-aligned,或者完全沒 member)→ 正常 rank
function _jointHasAnyDiagonal(j, page) {
  if (!page || !Array.isArray(page.members) || !page.members.length) return false;
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    if (Math.abs(dx) < tol && Math.abs(dy) < tol) continue;
    // 既不是水平也不是垂直 → 斜向
    if (Math.abs(dy) >= tol && Math.abs(dx) >= tol) return true;
  }
  return false;
}
// 取得 joint 連接桿件的「單位方向向量陣列」— 給 perp / collinear 判定共用
export function _getJointMemberDirs(j, page) {
  const out = [];
  if (!page || !Array.isArray(page.members) || !page.members.length) return out;
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    const len = Math.hypot(dx, dy);
    if (len < tol) continue;
    out.push({ dx: dx / len, dy: dy / len });
  }
  return out;
}
// 任一對方向向量垂直?(2D 上,夾角 90° ± 約 3°)
export function _hasAnyPerpPair(dirs) {
  for (let i = 0; i < dirs.length; i++) {
    for (let k = i + 1; k < dirs.length; k++) {
      const dot = dirs[i].dx * dirs[k].dx + dirs[i].dy * dirs[k].dy;
      if (Math.abs(dot) < 0.05) return true;
    }
  }
  return false;
}
// 所有方向向量是否與第一條共線(平行或反向)— 用來判定「純連續直桿件」(2+ V 共線、無分岔)
export function _allDirsCollinear(dirs) {
  if (dirs.length < 2) return false;
  const d0 = dirs[0];
  for (let i = 1; i < dirs.length; i++) {
    const dot = Math.abs(d0.dx * dirs[i].dx + d0.dy * dirs[i].dy);
    if (Math.abs(dot - 1) > 0.05) return false;   // 不共線(parallel cos = ±1)
  }
  return true;
}
// 保留舊 API(供其他模組或日後參照)
function _jointHasPerpendicularPair(j, page) {
  return _hasAnyPerpPair(_getJointMemberDirs(j, page));
}
// 判定 joint 的連結狀況:
//   "axis"  → 有任何 H 或 V 的 member(平行該頁的水平 / 垂直軸)
//   "diag"  → 有 member,但全部是斜向(non-axis-aligned)
//   "empty" → 完全沒有 member
// rank 排序時,"diag" 的座標會被推到最後;"empty" / "axis" 按數值正常排
function _jointConnectivityKind(j, page) {
  if (!page || !Array.isArray(page.members) || !page.members.length) return "empty";
  const tol = 1e-3;
  const jointById = new Map((page.joints || []).map(jj => [jj.id, jj]));
  let hasH = false, hasV = false, hasD = false;
  for (const m of page.members) {
    let other = null;
    if (m.j1 === j.id) other = jointById.get(m.j2);
    else if (m.j2 === j.id) other = jointById.get(m.j1);
    if (!other) continue;
    const dx = other.x - j.x, dy = other.y - j.y;
    if (Math.abs(dx) < tol && Math.abs(dy) < tol) continue;   // 同位
    if (Math.abs(dy) < tol && Math.abs(dx) > tol) hasH = true;
    else if (Math.abs(dx) < tol && Math.abs(dy) > tol) hasV = true;
    else hasD = true;
  }
  if (hasH || hasV) return "axis";
  if (hasD) return "diag";
  return "empty";
}
// 取得節點「用來算 rank 的世界座標」:
//   - 若 joint.globalId 對應的 globalJoint 有 x/y/z(三軸都齊全) → 用全局位置(同 globalId 的各檔節點拿到同 rank → 同 display ID)
//   - 否則用節點本身的世界座標
// _worldForRank / _axisCap / _ensureRankCache 移到 src/core/rankCache.ts(Phase 3d)
// _displayIdForJointWith 移到 src/core/displayId.ts(Phase 3d)
export function displayJointId(j) {
  return _displayIdForJointWith(getActiveFile(), getPage(), j);
}
export function displayMemberId(m) {
  if (!m) return "?";
  // 直接用 per-page m.id;不再代換為 globalMember.id
  //   原因:globalMember.id 是「適配關聯當時的累加序號」,不會跟 rank-based 重編後的 m.id 同步,
  //   會讓「同一根柱整條 Y 軸應該連續編號 1921,1922,1923」變成 1921,1945,1980。
  //   跨頁同物理桿件用 m.globalMemberId 仍可內部識別(搜尋 / 對應分析用)。
  return m.id;
}
function pageHasGroupNum(num, exclude) {
  for (const file of state.files) {
    for (const [k, pg] of Object.entries(file.pages || {})) {
      if (exclude && pg === exclude) continue;
      if (pg.groupNum === num) return true;
    }
  }
  return false;
}
export function refreshPageCoordSection() {
  const p = getPage();
  $("planeSelect").value = (p && p.plane) || "";
  $("numberTolerance") && ($("numberTolerance").value = state.numberTolerance != null ? state.numberTolerance : 2);
  $("numberCapacityX") && ($("numberCapacityX").value = String(state.numberCapacityX || 99));
  $("numberCapacityY") && ($("numberCapacityY").value = String(state.numberCapacityY || 99));
  $("numberCapacityZ") && ($("numberCapacityZ").value = String(state.numberCapacityZ || 99));
  $("numberPriority") && ($("numberPriority").value = state.numberPriority || "h");
  // 第三軸:依本頁 plane 動態切換 label / tooltip
  //   XY → Z(深度,例如各立面對應不同 Z 切面)
  //   XZ → Y(標高,樓層平面圖)
  //   YZ → X(側視位置,各側視對應不同 X 切面)
  //   未設定 → 隱藏
  const plane = p && p.plane;
  const wrap = $("pageYWrap");
  const showY = !!plane;
  if (wrap) wrap.style.display = showY ? "block" : "none";
  // 左右 / 上下翻轉 checkbox + 套用按鈕:plane 設定後才顯示;同步當前狀態
  const flipWrapX = $("pageFlipXWrap");
  if (flipWrapX) flipWrapX.style.display = showY ? "flex" : "none";
  if ($("pageFlipX")) $("pageFlipX").checked = !!(p && p.flipX);
  const flipWrapY = $("pageFlipYWrap");
  if (flipWrapY) flipWrapY.style.display = showY ? "flex" : "none";
  if ($("pageFlipY")) $("pageFlipY").checked = !!(p && p.flipY);
  const syncWrap = $("pageFlipSyncWrap");
  if (syncWrap) syncWrap.style.display = showY ? "flex" : "none";
  const applyBtn = $("btnApplyFlipToSamePlane");
  if (applyBtn) applyBtn.style.display = showY ? "block" : "none";
  // 樓層類型下拉:只在 XZ 平面 page 顯示;選項即時從 state.floorTypes(filter kind=floor)重建
  const floorWrap = $("pageFloorTypeWrap");
  if (floorWrap) floorWrap.style.display = (plane === "XZ") ? "block" : "none";
  if (plane === "XZ") {
    const sel = $("pageFloorType");
    if (sel) {
      sel.innerHTML = "";
      const all = Array.isArray(state.floorTypes) && state.floorTypes.length
        ? state.floorTypes : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
      const types = all.filter(t => (t.kind || "floor") === "floor");
      const list = types.length ? types : [{ key: "default", label: "預設", yyStart: 1 }];
      for (const t of list) {
        const opt = document.createElement("option");
        opt.value = t.key;
        opt.textContent = `${t.label || t.key} (起始 ${t.yyStart || 1})`;
        sel.appendChild(opt);
      }
      const cur = (p && p.floorType) || "default";
      sel.value = list.some(t => t.key === cur) ? cur : list[0].key;
    }
  }
  // 斜撐起始下拉:只在 YZ / XY 平面 page 顯示;選項即時從 state.floorTypes(filter kind=brace)重建
  //   斜撐型可能完全沒設,清單會空 — 此時下拉只顯示「default」做 fallback。
  const braceWrap = $("pageBraceTypeWrap");
  const isBracePlane = (plane === "YZ" || plane === "XY");
  if (braceWrap) braceWrap.style.display = isBracePlane ? "block" : "none";
  if (isBracePlane) {
    const sel = $("pageBraceType");
    if (sel) {
      sel.innerHTML = "";
      const all = Array.isArray(state.floorTypes) ? state.floorTypes : [];
      const types = all.filter(t => (t.kind || "floor") === "brace");
      // 永遠提供 default 選項在最前(代表「不指派 brace 型」,joint 走原 demote-only 邏輯)
      const list = [{ key: "default", label: "default(不指派)", yyStart: null }].concat(types);
      for (const t of list) {
        const opt = document.createElement("option");
        opt.value = t.key;
        opt.textContent = (t.yyStart != null)
          ? `${t.label || t.key} (起始 ${t.yyStart})`
          : (t.label || t.key);
        sel.appendChild(opt);
      }
      const cur = (p && p.braceType) || "default";
      sel.value = list.some(t => t.key === cur) ? cur : "default";
    }
  }
  if (showY) {
    const labelEl = $("pageZLabel");
    const inputEl = $("pageZ");
    let labelTxt, labelTip, inputTip;
    if (plane === "XZ") {
      labelTxt = "Y 軸標高";
      labelTip = "STAAD 以 Y 軸為鉛直方向(標高)。XZ 為水平剖面,本頁的 Y 值 = 該層標高";
      inputTip = "本頁對應的 Y 軸標高(mm),例如 3 樓樓板高度 4500";
    } else if (plane === "XY") {
      labelTxt = "Z 深度";
      labelTip = "XY 為立面正視。Z 為前後深度;多張 XY 立面對應不同 Z 切面(例如前/後排柱)";
      inputTip = "本頁對應的 Z 深度位置(mm),例如前排立面 0、後排立面 6000";
    } else if (plane === "YZ") {
      labelTxt = "X 軸位置";
      labelTip = "YZ 為立面側視。X 為左右位置;多張 YZ 側視對應不同 X 切面";
      inputTip = "本頁對應的 X 位置(mm),例如左側面 0、右側面 12000";
    } else {
      labelTxt = "第三軸位置";
      labelTip = "本頁對應的第三軸位置";
      inputTip = "本頁對應的第三軸位置(mm)";
    }
    if (labelEl) { labelEl.textContent = labelTxt; labelEl.title = labelTip; }
    if (inputEl) inputEl.title = inputTip;
    $("pageZ").value = (p && p.z != null) ? p.z : 0;
  }
  if (p && p.groupNum) {
    const base = p.groupNum * state.globalCapacity;
    $("idPreview").textContent = `編號預覽:J/M ${base + 1}~${base + state.globalCapacity}`;
  } else {
    $("idPreview").textContent = "編號預覽:未設定共有數字";
  }
  refreshAxisIndicator();
}
// 平面座標指示器:依當前頁面 plane 更新右上角的軸名 + 顏色
//   XY:右 X(紅) / 上 Y(綠) — 預設
//   XZ:右 X(紅) / 上 Z(藍) — 平面俯視
//   YZ:右 Z(藍) / 上 Y(綠) — 立面側視
//   未設定:同 XY,標籤帶 "(?)" 表示未指派
export function refreshAxisIndicator() {
  const p = getPage();
  const plane = (p && p.plane) || "";
  const flipX = !!(p && p.flipX);
  const flipY = !!(p && p.flipY);
  const xLbl = $("axisXLabel"), yLbl = $("axisYLabel");
  const xLine = $("axisXLine"), yLine = $("axisYLine");
  const origin = $("axisOrigin");
  if (!xLbl || !yLbl) return;
  const COLORS = { X: "#ff5252", Y: "#4ade80", Z: "#3b82f6" };
  // 平面預設方向 — 水平軸往右;縱軸 XZ 往「下」、XY/YZ 往「上」
  let horizAxis = "X", vertAxis = "Y", note = "", baseVertDown = false;
  if (plane === "XZ")      { horizAxis = "X"; vertAxis = "Z"; baseVertDown = true;  }
  else if (plane === "YZ") { horizAxis = "Z"; vertAxis = "Y"; baseVertDown = false; }
  else if (plane === "XY") { horizAxis = "X"; vertAxis = "Y"; baseVertDown = false; }
  else { note = "(?)"; }
  // flipY 把縱軸方向反轉(原本往上 → 往下;原本往下 → 往上)
  const vertDown = flipY ? !baseVertDown : baseVertDown;
  xLbl.textContent = horizAxis + note;
  yLbl.textContent = vertAxis + note;
  xLbl.setAttribute("fill", COLORS[horizAxis] || "#ccc");
  yLbl.setAttribute("fill", COLORS[vertAxis] || "#ccc");
  // 原點位置:flipX → 右側 (58);否則左側 (20)。oy 維持中段 44 — 縱軸往上 / 下從這延伸。
  const oy = 44;
  const ox = flipX ? 58 : 20;
  const xEnd = flipX ? 20 : 58;
  if (origin) { origin.setAttribute("cx", String(ox)); origin.setAttribute("cy", String(oy)); }
  if (xLine) {
    xLine.setAttribute("x1", String(ox)); xLine.setAttribute("y1", String(oy));
    xLine.setAttribute("x2", String(xEnd)); xLine.setAttribute("y2", String(oy));
    xLine.setAttribute("stroke", COLORS[horizAxis] || "#ccc");
    xLine.setAttribute("marker-end", `url(#arrAx${horizAxis})`);
  }
  xLbl.setAttribute("x", flipX ? "4" : "62");
  xLbl.setAttribute("y", String(oy + 4));
  // 縱軸 → 上 / 下(從同樣 ox 出發)
  if (yLine) {
    yLine.setAttribute("x1", String(ox)); yLine.setAttribute("y1", String(oy));
    yLine.setAttribute("x2", String(ox)); yLine.setAttribute("y2", vertDown ? "74" : "14");
    yLine.setAttribute("stroke", COLORS[vertAxis] || "#ccc");
    yLine.setAttribute("marker-end", `url(#arrAx${vertAxis})`);
  }
  yLbl.setAttribute("x", String(ox - 6));
  yLbl.setAttribute("y", vertDown ? "86" : "10");
}
$("planeSelect").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  p.plane = e.target.value || null;
  _afterCalibrationChanged();
};
// 校準變動後的共同收尾:rank 失效 + globalJoint 重 infer + UI 重整 + 重畫。
// 適用於所有「會改變 2D ↔ 3D 對應」的操作 — planeOrigin / scaleRuler / page.plane /
//   page.flipX/Y / page.z / 旋轉 90°。每個 mutation 點呼叫一次,確保下游
//   (顯示 ID、globalJoint world、xlsx 匯出、3D 預覽)即時對齊新基準。
// 注意:_resyncSectionLinksForFile 是 file-specific,呼叫者自己決定要不要先跑;
//   本 helper 結尾會 refreshSectionLinkList 把已更新的切面 cutValue 反映到 UI。
export function _afterCalibrationChanged() {
  if (typeof invalidateRankCache === "function") invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  try { refreshLists(); } catch (_) {}
  try { render(); } catch (_) {}
}
// 翻轉變更後的共同收尾:active file 切面 resync(file-specific)→ 跑共同 calibration 收尾
function _afterFlipChanged(label) {
  const af = getActiveFile();
  if (af) {
    const r = (typeof _resyncSectionLinksForFile === "function")
      ? _resyncSectionLinksForFile(af) : { slUpdated: 0, tgtZUpdated: 0 };
    if (r.slUpdated) {
      console.log(`[${label}] ${af.name}・切面 cutValue 重算 ${r.slUpdated} 條;目標 page.z 同步 ${r.tgtZUpdated} 個`);
    }
  }
  _afterCalibrationChanged();
}
// 把本頁 flipX/flipY 設定推到所有同平面的其他頁面;回傳被改動的頁面數
function _propagateFlipToSamePlane(p) {
  if (!p || !p.plane) return 0;
  const fX = !!p.flipX, fY = !!p.flipY;
  let count = 0;
  const filesTouched = new Set();
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan || pg === p || pg.plane !== p.plane) continue;
      if (!!pg.flipX === fX && !!pg.flipY === fY) continue;
      pg.flipX = fX; pg.flipY = fY;
      count++;
      filesTouched.add(f);
    }
  }
  // 各被改動檔案重算切面 cutValue
  if (count && typeof _resyncSectionLinksForFile === "function") {
    for (const f of filesTouched) {
      try { _resyncSectionLinksForFile(f); } catch (_) {}
    }
  }
  return count;
}
// localStorage 持久化「同步到全部同平面」的勾選狀態(預設 ON)
try {
  const v = localStorage.getItem("flipSyncSamePlane");
  const el = $("pageFlipSync");
  if (el) el.checked = (v == null) ? true : (v !== "0");
} catch (_) {}
$("pageFlipSync") && ($("pageFlipSync").onchange = (e) => {
  try { localStorage.setItem("flipSyncSamePlane", e.target.checked ? "1" : "0"); } catch (_) {}
});
$("pageFloorType") && ($("pageFloorType").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan || p.plane !== "XZ") return;
  pushUndo();
  p.floorType = String(e.target.value || "default");
  // Y 軸 rank 連動 → 失效 rank cache、重建 globalJoints、重畫 + UI 同步
  invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  try { refreshLists(); } catch (_) {}
  render();
});
$("pageBraceType") && ($("pageBraceType").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan || (p.plane !== "YZ" && p.plane !== "XY")) return;
  pushUndo();
  p.braceType = String(e.target.value || "default");
  // Y 軸 rank 連動(brace bucket 重算)→ 失效 rank cache、重建 globalJoints、重畫 + UI 同步
  invalidateRankCache();
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  try { refreshLists(); } catch (_) {}
  render();
});
$("btnOpenFloorTypeMgr") && ($("btnOpenFloorTypeMgr").onclick = () => {
  if (typeof openFloorTypesDialog === "function") openFloorTypesDialog();
});
// 左欄樓層類型清單(read-only 簡覽,管理走「管理…」按鈕)
function _refreshFloorTypeSidebar() {
  const list = $("floorTypeList");
  if (!list) return;
  const allTypes = Array.isArray(state.floorTypes) && state.floorTypes.length
    ? state.floorTypes : [{ key: "default", label: "預設", yyStart: 1, kind: "floor" }];
  // 統計:floor → XZ page 數;brace → YZ + XY page 數
  const floorCounts = new Map();
  const braceCounts = new Map();
  for (const f of state.files) {
    for (const pg of Object.values(f.pages || {})) {
      if (!pg) continue;
      if (pg.plane === "XZ") {
        const tk = pg.floorType || "default";
        floorCounts.set(tk, (floorCounts.get(tk) || 0) + 1);
      } else if (pg.plane === "YZ" || pg.plane === "XY") {
        const tk = pg.braceType || "default";
        braceCounts.set(tk, (braceCounts.get(tk) || 0) + 1);
      }
    }
  }
  list.innerHTML = "";
  const addHead = (txt) => {
    const h = document.createElement("div");
    h.style.cssText = "color:#9bb6e8;font-size:10px;font-weight:700;margin:4px 0 2px;letter-spacing:0.5px";
    h.textContent = txt;
    list.appendChild(h);
  };
  const addRow = (t, counts) => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;align-items:center;padding:2px 0";
    const lbl = document.createElement("span");
    lbl.style.cssText = "flex:1;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    lbl.textContent = `${t.label || t.key}`;
    const meta = document.createElement("span");
    meta.style.cssText = "color:#7b818a;font-size:10px;font-variant-numeric:tabular-nums";
    meta.textContent = `起始 ${t.yyStart || 1} ・ ${counts.get(t.key) || 0} 頁`;
    row.appendChild(lbl);
    row.appendChild(meta);
    list.appendChild(row);
  };
  const floorTypes = allTypes.filter(t => (t.kind || "floor") === "floor");
  const braceTypes = allTypes.filter(t => (t.kind || "floor") === "brace");
  addHead("樓層類型(XZ)");
  if (!floorTypes.length) {
    const e = document.createElement("div");
    e.style.cssText = "color:#666;font-size:10px;font-style:italic;padding:1px 0";
    e.textContent = "(無)";
    list.appendChild(e);
  } else {
    for (const t of floorTypes) addRow(t, floorCounts);
  }
  addHead("斜撐起始(YZ / XY)");
  if (!braceTypes.length) {
    const e = document.createElement("div");
    e.style.cssText = "color:#666;font-size:10px;font-style:italic;padding:1px 0";
    e.textContent = "(無)";
    list.appendChild(e);
  } else {
    for (const t of braceTypes) addRow(t, braceCounts);
  }
}
// 節點編號管理 dialog —— window-like 視窗 + tabs(樓層類型 / 斜撐起始)+ pending state
//   兩 tab 共用同一 yyStart 池(1/11/21.../91 不重複),但各自 type 清單、各自頁面集合:
//     樓層類型 tab → XZ 頁面,寫到 pg.floorType
//     斜撐起始 tab → YZ + XY 頁面,寫到 pg.braceType
//   類型 CRUD(yyStart 限 1/11/21.../91 共池不重複, key→displayName 自動同步)、
//   下方分割兩窗(左 page list、右大畫面預覽)、Shift / Cmd 多勾選、
//   上方顯示當前 tab 各型已勾頁數、套用 / 完成 / × 三種收尾按鈕
// openFloorTypesDialog 移到 src/dialogs/floorTypes.ts(Phase 5)
import { openFloorTypesDialog } from "./dialogs/floorTypes";

// ===== 全局節點管理 dialog =====
//   左半邊:所有 globalJoint 清單(可搜尋 / 篩選 / 排序)
//   右半邊:選中筆的詳細資料 — 改 label、看世界座標、列綁定可單獨解除、設原點、刪節點
//   底部:關閉鈕
// openGlobalJointMgrDialog + showGlobalJointJumpPopup + hideGlobalJointJumpPopup 移到 src/dialogs/globalJoints.ts(Phase 5)
import { openGlobalJointMgrDialog, showGlobalJointJumpPopup, hideGlobalJointJumpPopup } from "./dialogs/globalJoints";

$("pageFlipX") && ($("pageFlipX").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  p.flipX = !!e.target.checked;
  const syncEl = $("pageFlipSync");
  let n = 0;
  if (syncEl && syncEl.checked) n = _propagateFlipToSamePlane(p);
  _afterFlipChanged("左右翻轉");
  if (n) console.log(`[左右翻轉] 同步到 ${n} 個同 ${p.plane} 平面頁面`);
});
$("pageFlipY") && ($("pageFlipY").onchange = (e) => {
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  p.flipY = !!e.target.checked;
  const syncEl = $("pageFlipSync");
  let n = 0;
  if (syncEl && syncEl.checked) n = _propagateFlipToSamePlane(p);
  _afterFlipChanged("上下翻轉");
  if (n) console.log(`[上下翻轉] 同步到 ${n} 個同 ${p.plane} 平面頁面`);
});
$("btnApplyFlipToSamePlane") && ($("btnApplyFlipToSamePlane").onclick = () => {
  const p = getPage();
  if (!p || p._orphan) { alert("請先載入並選定本頁的世界平面"); return; }
  const plane = p.plane;
  if (!plane) { alert("此頁尚未設定『世界平面』,無法套用。"); return; }
  const fX = !!p.flipX, fY = !!p.flipY;
  // 找出所有同平面、且不是本頁的頁面
  const targets = [];
  for (const f of state.files) {
    if (!f.pages) continue;
    for (const k of Object.keys(f.pages)) {
      const pg = f.pages[k];
      if (!pg || pg._orphan) continue;
      if (pg.plane !== plane) continue;
      if (pg === p) continue;
      // 已經跟本頁設定相同 → 不算需要動的
      if (!!pg.flipX === fX && !!pg.flipY === fY) continue;
      targets.push({ f, k, pg });
    }
  }
  if (!targets.length) { alert(`沒有需要更新的同平面頁面(${plane} 平面其他頁面的翻轉設定已經跟本頁一致)。`); return; }
  if (!confirm(
    `將「左右翻轉=${fX ? "開" : "關"}、上下翻轉=${fY ? "開" : "關"}」套用到 ${targets.length} 個同 ${plane} 平面頁面?\n` +
    `(各檔切面 cutValue 會跟著重算,可用 Ctrl+Z 還原)`
  )) return;
  pushUndo();
  const filesTouched = new Set();
  for (const { f, pg } of targets) {
    pg.flipX = fX;
    pg.flipY = fY;
    filesTouched.add(f);
  }
  // 為每個被改到的檔案重算切面 cutValue
  let slUpdated = 0, tgtZUpdated = 0;
  for (const f of filesTouched) {
    const r = (typeof _resyncSectionLinksForFile === "function")
      ? _resyncSectionLinksForFile(f) : { slUpdated: 0, tgtZUpdated: 0 };
    slUpdated += r.slUpdated; tgtZUpdated += r.tgtZUpdated;
  }
  invalidateRankCache();
  inferAllGlobalJoints();
  refreshPageCoordSection();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  refreshLists();
  render();
  if ($("hud")) {
    $("hud").textContent = `已套用翻轉(X=${fX ? "開" : "關"} / Y=${fY ? "開" : "關"})到 ${targets.length} 個 ${plane} 平面頁面` +
      (slUpdated ? `・切面 ${slUpdated} 條重算${tgtZUpdated ? `(目標 page.z ${tgtZUpdated})` : ""}` : "");
  }
  console.log(`[套用翻轉] plane=${plane} flipX=${fX} flipY=${fY} → ${targets.length} 頁`,
    targets.map(t => t.f.name));
});
$("numberTolerance") && ($("numberTolerance").onchange = (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v) || v <= 0) { alert("誤差範圍必須是大於 0 的數字"); refreshPageCoordSection(); return; }
  state.numberTolerance = v;
  invalidateRankCache();
  refreshPageCoordSection();
  render(); refreshLists();
});
const _onCapAxisChange = (axKey, stateKey) => (e) => {
  const v = parseInt(e.target.value, 10);
  if (v !== 9 && v !== 99 && v !== 999) { alert(`${axKey} 軸最大編號數必須是 9 / 99 / 999`); refreshPageCoordSection(); return; }
  state[stateKey] = v;
  invalidateRankCache();
  refreshPageCoordSection();
  render(); refreshLists();
};
$("numberCapacityX") && ($("numberCapacityX").onchange = _onCapAxisChange("X", "numberCapacityX"));
$("numberCapacityY") && ($("numberCapacityY").onchange = _onCapAxisChange("Y", "numberCapacityY"));
$("numberCapacityZ") && ($("numberCapacityZ").onchange = _onCapAxisChange("Z", "numberCapacityZ"));
// 編排優先 變更 → ID 排列順序變,refresh 即可(不需動 cache)
$("numberPriority") && ($("numberPriority").onchange = (e) => {
  state.numberPriority = (e.target.value === "v") ? "v" : "h";
  refreshPageCoordSection();
  render(); refreshLists();
});

// ---------- 平面選取盤(Shift+W) ----------
function openPlanePicker() {
  const p = getPage();
  if (!p || p._orphan) { alert("請先載入並啟用一個頁面。"); return; }
  state.planePicker.active = true;
  state.planePicker.sector = null;
  // 居中於畫布
  const r = wrap.getBoundingClientRect();
  state.planePicker.x = r.left + r.width / 2;
  state.planePicker.y = r.top + r.height / 2;
  const pp = $("planePicker");
  pp.style.left = state.planePicker.x + "px";
  pp.style.top  = state.planePicker.y + "px";
  pp.style.display = "block";
}
function closePlanePicker() {
  state.planePicker.active = false;
  $("planePicker").style.display = "none";
  ["ppXY", "ppYZ", "ppXZ", "ppCancel"].forEach(id => $(id).classList.remove("hot"));
}
function planePickerSectorAt(clientX, clientY) {
  const dx = clientX - state.planePicker.x;
  const dy = clientY - state.planePicker.y;
  if (Math.hypot(dx, dy) < 32) return null;     // 在中心圓裡不選
  const a = Math.atan2(dy, dx);                 // -π..π
  if (a >= -Math.PI/4 && a < Math.PI/4)        return "YZ";
  if (a >= Math.PI/4 && a < 3*Math.PI/4)       return "XZ";
  if (a >= -3*Math.PI/4 && a < -Math.PI/4)     return "XY";
  return "cancel";
}
window.addEventListener("mousemove", (e) => {
  if (!state.planePicker.active) return;
  const sec = planePickerSectorAt(e.clientX, e.clientY);
  if (sec === state.planePicker.sector) return;
  state.planePicker.sector = sec;
  const map = { XY: "ppXY", YZ: "ppYZ", XZ: "ppXZ", cancel: "ppCancel" };
  ["ppXY", "ppYZ", "ppXZ", "ppCancel"].forEach(id => $(id).classList.remove("hot"));
  if (sec && map[sec]) $(map[sec]).classList.add("hot");
});
window.addEventListener("mousedown", (e) => {
  if (!state.planePicker.active) return;
  e.preventDefault(); e.stopPropagation();
  const sec = planePickerSectorAt(e.clientX, e.clientY);
  closePlanePicker();
  if (!sec || sec === "cancel") return;
  const p = getPage();
  if (!p || p._orphan) return;
  pushUndo();
  p.plane = sec;
  // 提示輸入共有數字
  const cur = p.groupNum || "";
  const ans = prompt(`設定 ${sec} 平面的共有數字(1~10000,不可重複):`, cur);
  if (ans !== null) {
    const v = parseInt(ans, 10);
    if (v >= 1 && v <= 10000 && !pageHasGroupNum(v, p)) p.groupNum = v;
    else if (v) alert("數字不合法或已被使用,共有數字未變更。");
  }
  refreshPageCoordSection();
  inferAllGlobalJoints();
  render(); refreshLists();
}, true);
// 設定平面按鈕已從工具列移除;仍可用 Shift+W 開啟 plane picker(見 keydown 處理)
$("planePickerBtn") && ($("planePickerBtn").onclick = openPlanePicker);

// 空白底圖訊息:在尚未載入任何檔案時,在背景 canvas 上顯示「請從左側載入…」提示
//   抽成函式以便語言切換時重畫
export function paintEmptyCanvasMessage() {
  if (typeof bgctx === "undefined" || !bgctx) return;
  bgctx.fillStyle = "#fafafa"; bgctx.fillRect(0, 0, state.bgWidth, state.bgHeight);
  bgctx.fillStyle = "#888"; bgctx.font = "16px sans-serif";
  bgctx.textAlign = "center"; bgctx.textBaseline = "middle";
  bgctx.fillText((typeof _t === "function" && _t("canvas.empty")) || "請從左側載入 PDF 或圖片以開始描圖。", state.bgWidth / 2, state.bgHeight / 2);
  bgctx.textAlign = "start"; bgctx.textBaseline = "alphabetic";
}

// ---------- init ----------
function initBlank() {
  const oldSvgBg = document.getElementById("bgSvg");
  if (oldSvgBg) oldSvgBg.remove();
  bg.style.display = "block";
  const dpr = window.devicePixelRatio || 1;
  bg.width = Math.floor(state.bgWidth * dpr);
  bg.height = Math.floor(state.bgHeight * dpr);
  bg.style.width = state.bgWidth + "px";
  bg.style.height = state.bgHeight + "px";
  bgctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintEmptyCanvasMessage();
  fitToView(); render(); refreshLists();
  refreshFileList(); refreshPageSelector();
  if (typeof refreshTabBar === "function") refreshTabBar();
  updateSnapGridBtn && updateSnapGridBtn();
  refreshPageCoordSection && refreshPageCoordSection();
  updateSelectToolLabel && updateSelectToolLabel();
  updateScaleRulerButton && updateScaleRulerButton();
}
initBlank();

// ---------- 多專案分頁 ----------
// 設計:projects 陣列每個元素是一份完整的專案 state;活躍中的那份直接存在 state / 全局 nextIds / undoStack。
//   切換分頁 = snapshot 目前 state 到舊專案 + load 目標專案到 state。
//   未活躍專案的 pdf / image / cachedBgSvg 物件仍在記憶體(不序列化),切回去可直接 render。
//   關閉時若有未儲存變更會彈出「儲存 / 丟棄 / 取消」三選一對話框。
const projects = [];
let activeProjectId = null;
let nextProjId = 1;
export let projectDirty = false;    // 活躍專案自上次儲存後是否有變更
// Phase 8e:跨模組(materialMgr)要寫這個 flag → 必須走 setter,ES module 不能直接寫 let import
export function setProjectDirty(v: boolean) { projectDirty = !!v; }

function makeEmptyProjectData(name) {
  return {
    id: nextProjId++,
    name: name || "未命名",
    files: [],
    globalJoints: [],
    undoStack: [],
    redoStack: [],
    scale: null,
    unitName: "mm",
    globalCapacity: 10000,
    activeFileId: null,
    pageIdx: 0,
    openTabs: [],
    zoom: 1, panX: 0, panY: 0,
    nextJointId: 1, nextMemberId: 1, nextFileId: 1, nextGlobalJointId: 1,
    projectFileHandle: null,
    jobName: name || "",
    dirty: false,
  };
}

function snapshotActiveProjectInto(p) {
  if (!p) return;
  // 把當前 zoom/pan 存到所屬 page,讓專案分頁切回來時能還原
  _saveCurrentTabView();
  p.files = state.files;
  p.globalJoints = state.globalJoints;
  p.materials = Array.isArray(state.materials) ? state.materials : [];
  p.undoStack = undoStack.slice();
  p.redoStack = redoStack.slice();
  p.scale = state.scale;
  p.unitName = state.unitName;
  p.globalCapacity = state.globalCapacity;
  p.activeFileId = state.activeFileId;
  p.pageIdx = state.pageIdx;
  p.openTabs = Array.isArray(state.openTabs) ? state.openTabs.map(t => ({ ...t })) : [];
  p.zoom = state.zoom; p.panX = state.panX; p.panY = state.panY;
  p.nextJointId = nextJointId;
  p.nextMemberId = nextMemberId;
  p.nextFileId = nextFileId;
  p.nextGlobalJointId = nextGlobalJointId;
  p.projectFileHandle = state.projectFileHandle || null;
  p.jobName = ($("jobName") && $("jobName").value) || p.jobName || "";
  p.dirty = projectDirty;
}

function loadProjectDataFromP(p) {
  state.files = p.files || [];
  // 衍生模型遷移:舊專案檔內的 autoProp 副本不再儲存,載入時直接清掉。
  //   主關聯仍保留;衍生在 render 時即時推算。
  let _strippedAutoProp = 0;
  for (const f of state.files) {
    if (!Array.isArray(f.sectionLinks)) continue;
    const before = f.sectionLinks.length;
    f.sectionLinks = f.sectionLinks.filter(e => !e.autoProp);
    _strippedAutoProp += (before - f.sectionLinks.length);
  }
  if (_strippedAutoProp) console.log(`[載入遷移] 清除 ${_strippedAutoProp} 個舊版 autoProp 副本(衍生模型不需儲存)`);
  state.globalJoints = p.globalJoints || [];
  state.materials    = Array.isArray(p.materials) ? p.materials : [];
  undoStack.length = 0; undoStack.push(...(p.undoStack || []));
  redoStack.length = 0; redoStack.push(...(p.redoStack || []));
  state.scale = p.scale ?? null;
  state.unitName = p.unitName || "mm";
  state.globalCapacity = p.globalCapacity || 10000;
  state.activeFileId = p.activeFileId ?? null;
  state.pageIdx = p.pageIdx || 0;
  state.openTabs = Array.isArray(p.openTabs) ? p.openTabs.map(t => ({ ...t })) : [];
  state.zoom = p.zoom || 1; state.panX = p.panX || 0; state.panY = p.panY || 0;
  // 舊專案 / 沒有 per-page view 的:把 project-level zoom 寫入「上次活躍頁」的 _view,
  //   讓 activatePage 走完 render+fitToView 後仍能恢復原本視野
  if (p.activeFileId != null && Number.isFinite(p.zoom)) {
    const af = (p.files || []).find(f => f.id === p.activeFileId);
    if (af) {
      if (!af.pages) af.pages = {};
      const pidx = p.pageIdx || 0;
      if (!af.pages[pidx]) af.pages[pidx] = { joints: [], members: [], z: 0 };
      if (!af.pages[pidx]._view) {
        af.pages[pidx]._view = { zoom: p.zoom, panX: p.panX || 0, panY: p.panY || 0 };
      }
    }
  }
  nextJointId = p.nextJointId || 1;
  nextMemberId = p.nextMemberId || 1;
  nextFileId = p.nextFileId || 1;
  nextGlobalJointId = p.nextGlobalJointId || 1;
  state.projectFileHandle = p.projectFileHandle || null;
  if ($("jobName")) $("jobName").value = p.jobName || "";
  projectDirty = !!p.dirty;
  // 清掉暫態 UI(避免跨分頁洩漏)
  if (state.selection) { state.selection.joints.clear(); state.selection.members.clear(); state.selection.fileIds.clear(); }
  state.marquee = null;
  state.measure = null;
  state.measurePending = false;
  state.splitMode = false;
  state.splitFirstCorner = null;
  state.pendingLineStart = null;
}

async function activateProject(id) {
  if (activeProjectId === id) return;
  const cur = projects.find(p => p.id === activeProjectId);
  if (cur) snapshotActiveProjectInto(cur);
  const next = projects.find(p => p.id === id);
  if (!next) return;
  activeProjectId = id;
  loadProjectDataFromP(next);
  // 重新渲染:若有活躍檔案就 activatePage,否則 initBlank
  showBusy(`切換到「${next.name}」…`);
  await busyTick();
  try {
    if (next.activeFileId != null && state.files.some(f => f.id === next.activeFileId)) {
      await activatePage(next.activeFileId, next.pageIdx || 0);
    } else {
      initBlank();
    }
  } catch (e) { console.warn("[activateProject]", e); }
  finally { hideBusy(); }
  refreshProjectTabs();
  refreshProjectMenu();
}

// 顯示用的專案名稱:把規範值 "未命名" 依目前語言翻成 "Untitled" / "未命名"
function _dispProjName(name) {
  if (name === "未命名") return (typeof _t === "function" && _t("project.untitled")) || name;
  return name;
}
export function refreshProjectTabs() {
  const scroll = document.querySelector("#projectTabs .pt-scroll");
  if (!scroll) return;
  scroll.innerHTML = "";
  for (const p of projects) {
    const tab = document.createElement("div");
    tab.className = "pt-tab" + (p.id === activeProjectId ? " active" : "");
    tab.dataset.pid = String(p.id);
    const dispName = _dispProjName(p.name);
    const unsaved = (typeof _t === "function" && _t("project.unsaved")) || "(未儲存)";
    tab.title = dispName + (p.dirty || (p.id === activeProjectId && projectDirty) ? unsaved : "");
    const dirtyMark = (p.id === activeProjectId ? projectDirty : p.dirty) ? '<span class="pt-dirty">●</span>' : '';
    tab.innerHTML =
      `${dirtyMark}<span class="pt-name">${escapeHtml(dispName)}</span><span class="pt-close" title="關閉此分頁">✕</span>`;
    tab.addEventListener("click", (e) => {
      if (e.target && e.target.classList.contains("pt-close")) {
        e.stopPropagation();
        closeProjectById(p.id);
        return;
      }
      activateProject(p.id);
    });
    // 右鍵 → 重新命名(不彈原生瀏覽器選單,直接跳輸入對話框)
    tab.addEventListener("contextmenu", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const newName = await promptName("重新命名分頁", `目前名稱:${p.name}`, p.name);
      if (newName == null || newName === "" || newName === p.name) return;
      if (projects.some(x => x !== p && x.name === newName)) {
        alert("此名稱已被其他分頁使用");
        return;
      }
      p.name = newName;
      p.jobName = newName;
      const isActive = (p.id === activeProjectId);
      if (isActive && $("jobName")) $("jobName").value = newName;
      // 若已經存過檔 → 嘗試把磁碟檔案也一起改名
      //   Chromium 的 FileSystemFileHandle.move(newName) 可直接改名;
      //   Safari / Firefox 沒有此 API → 清掉 handle,讓下次「儲存專案」跳 save-as picker(新名已預填在 jobName)
      const h = isActive ? state.projectFileHandle : p.projectFileHandle;
      if (h) {
        const targetFileName = `${newName}.stproj.json`;
        if (typeof h.move === "function") {
          try {
            await h.move(targetFileName);
            console.log(`[rename] 磁碟檔案已改名 → ${targetFileName}`);
          } catch (err) {
            console.warn("[rename] handle.move 失敗,下次儲存會跳 save-as:", err);
            if (isActive) state.projectFileHandle = null;
            p.projectFileHandle = null;
          }
        } else {
          console.log("[rename] 瀏覽器無 handle.move API,下次儲存會跳 save-as");
          if (isActive) state.projectFileHandle = null;
          p.projectFileHandle = null;
        }
      }
      refreshProjectTabs();
      refreshProjectMenu();
    });
    scroll.appendChild(tab);
  }
  // 捲動到 active tab
  const active = scroll.querySelector(".pt-tab.active");
  if (active) active.scrollIntoView({ inline: "nearest", block: "nearest" });
}

export function refreshProjectMenu() {
  const list = document.getElementById("projectMenuList");
  if (!list) return;
  list.innerHTML = "";
  for (const p of projects) {
    const entry = document.createElement("div");
    entry.className = "menu-entry";
    entry.textContent = (p.id === activeProjectId ? "● " : "   ") + _dispProjName(p.name) + (p.dirty || (p.id === activeProjectId && projectDirty) ? " *" : "");
    entry.addEventListener("click", () => { activateProject(p.id); });
    list.appendChild(entry);
  }
}

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&apos;"}[c]));
}

// ---------- 通用對話框 helpers ----------
// 輸入名稱對話框:回傳字串或 null(取消)
// 數值輸入對話框,並提供「跳過」按鈕 → 回傳 number / "skip" / null(Esc / 取消)
function promptNumberWithSkip(title, label, defaultValue) {
  return new Promise(resolve => {
    const dlg = document.getElementById("genericDialog");
    const titleEl = document.getElementById("gdTitle");
    const msgEl = document.getElementById("gdMsg");
    const inpEl = document.getElementById("gdInput");
    const footerEl = document.getElementById("gdFooter");
    titleEl.textContent = title || "";
    msgEl.textContent = label || "";
    inpEl.style.display = "block";
    inpEl.type = "number";
    inpEl.value = (defaultValue == null || !Number.isFinite(defaultValue)) ? "" : String(defaultValue);
    footerEl.innerHTML = "";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    const skipBtn = document.createElement("button");
    skipBtn.textContent = "跳過";
    const okBtn = document.createElement("button");
    okBtn.className = "primary";
    okBtn.textContent = "確定";
    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(skipBtn);
    footerEl.appendChild(okBtn);
    const cleanup = () => {
      dlg.classList.remove("active");
      inpEl.type = "text";   // 還原給其他 promptName 用
      document.removeEventListener("keydown", onKey, true);
    };
    const close = (result) => { cleanup(); resolve(result); };
    const tryCommit = () => {
      const v = parseFloat(inpEl.value);
      if (!Number.isFinite(v)) { skipBtn.classList.add("primary"); inpEl.focus(); return; }
      close(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); tryCommit(); }
      else { e.stopImmediatePropagation(); }
    };
    cancelBtn.onclick = () => close(null);
    skipBtn.onclick = () => close("skip");
    okBtn.onclick = tryCommit;
    document.addEventListener("keydown", onKey, true);
    dlg.classList.add("active");
    setTimeout(() => { inpEl.focus(); inpEl.select(); }, 30);
  });
}

function promptName(title, label, defaultValue) {
  return new Promise(resolve => {
    const dlg = document.getElementById("genericDialog");
    const titleEl = document.getElementById("gdTitle");
    const msgEl = document.getElementById("gdMsg");
    const inpEl = document.getElementById("gdInput");
    const footerEl = document.getElementById("gdFooter");
    titleEl.textContent = title || "";
    msgEl.textContent = label || "";
    inpEl.style.display = "block";
    inpEl.value = defaultValue || "";
    footerEl.innerHTML = "";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    const okBtn = document.createElement("button");
    okBtn.className = "primary";
    okBtn.textContent = "確定";
    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(okBtn);
    const close = (result) => {
      dlg.classList.remove("active");
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(null); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); close(inpEl.value.trim()); }
      else { e.stopImmediatePropagation(); }
    };
    cancelBtn.onclick = () => close(null);
    okBtn.onclick = () => close(inpEl.value.trim());
    document.addEventListener("keydown", onKey, true);
    dlg.classList.add("active");
    setTimeout(() => { inpEl.focus(); inpEl.select(); }, 30);
  });
}

// 三選一確認(儲存 / 丟棄 / 取消)→ 回傳 "save" | "discard" | "cancel"
function confirm3(title, msg) {
  return new Promise(resolve => {
    const dlg = document.getElementById("genericDialog");
    document.getElementById("gdTitle").textContent = title || "";
    document.getElementById("gdMsg").textContent = msg || "";
    document.getElementById("gdInput").style.display = "none";
    const footerEl = document.getElementById("gdFooter");
    footerEl.innerHTML = "";
    const mkBtn = (label, cls) => { const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls; return b; };
    const cancelBtn  = mkBtn("取消");
    const discardBtn = mkBtn("丟棄", "warn");
    const saveBtn    = mkBtn("儲存", "primary");
    footerEl.appendChild(cancelBtn);
    footerEl.appendChild(discardBtn);
    footerEl.appendChild(saveBtn);
    const close = (r) => { dlg.classList.remove("active"); document.removeEventListener("keydown", onKey, true); resolve(r); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close("cancel"); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); close("save"); }
      else { e.stopImmediatePropagation(); }
    };
    cancelBtn.onclick  = () => close("cancel");
    discardBtn.onclick = () => close("discard");
    saveBtn.onclick    = () => close("save");
    document.addEventListener("keydown", onKey, true);
    dlg.classList.add("active");
  });
}

// ---------- 新增 / 關閉專案 ----------
export async function newProjectPrompt() {
  const defaultName = `未命名_${projects.length + 1}`;
  const name = await promptName("新增專案", "請輸入新專案名稱:", defaultName);
  if (name == null || name === "") return;
  if (projects.some(p => p.name === name)) {
    alert("專案名稱已存在,請換一個");
    return;
  }
  // snapshot 目前專案
  const cur = projects.find(p => p.id === activeProjectId);
  if (cur) snapshotActiveProjectInto(cur);
  // 建立新的空白專案
  const p = makeEmptyProjectData(name);
  projects.push(p);
  activeProjectId = p.id;
  loadProjectDataFromP(p);
  initBlank();
  refreshProjectTabs();
  refreshProjectMenu();
}

async function closeProjectById(id) {
  const p = projects.find(x => x.id === id);
  if (!p) return;
  const isActive = (id === activeProjectId);
  const dirty = isActive ? projectDirty : p.dirty;
  if (dirty) {
    const choice = await confirm3("關閉專案", `專案「${p.name}」有未儲存的變更,是否儲存?`);
    if (choice === "cancel") return;
    if (choice === "save") {
      // 若不是當前 active,先切過去才能儲存(startSave 操作 active state)
      if (!isActive) await activateProject(id);
      try { await _startSaveWithHook(false); }
      catch (e) { console.warn("[close] 儲存失敗", e); alert("儲存失敗,已取消關閉"); return; }
    }
  }
  // 從陣列移除
  const idx = projects.findIndex(x => x.id === id);
  if (idx >= 0) projects.splice(idx, 1);
  if (isActive) {
    // 切到相鄰的分頁;若空了就自動新增一個空白
    activeProjectId = null;
    if (projects.length) {
      const target = projects[Math.min(idx, projects.length - 1)];
      await activateProject(target.id);
    } else {
      const np = makeEmptyProjectData("未命名");
      projects.push(np);
      activeProjectId = np.id;
      loadProjectDataFromP(np);
      initBlank();
      refreshProjectTabs();
      refreshProjectMenu();
    }
  } else {
    refreshProjectTabs();
    refreshProjectMenu();
  }
}
export async function closeCurrentProject() {
  if (activeProjectId != null) await closeProjectById(activeProjectId);
}

// ---------- dirty flag hooks ----------
// 覆寫 pushUndo 把「有變更」訊號吸進 projectDirty(僅在 dirty 狀態轉換時重新渲染 tabs,避免高頻刷新)
const _origPushUndo = pushUndo;
pushUndo = function () {
  const wasDirty = projectDirty;
  projectDirty = true;
  if (!wasDirty) refreshProjectTabs();
  return _origPushUndo.apply(this, arguments);
};

// 初始化第一個預設專案(把目前已在 state 裡的空白環境包成 project)
(function initFirstProject() {
  const p = makeEmptyProjectData("未命名");
  // 目前 state 已經 initBlank,直接接管
  p.files = state.files;
  p.globalJoints = state.globalJoints || [];
  p.materials = Array.isArray(state.materials) ? state.materials : [];
  p.undoStack = undoStack.slice();
  p.redoStack = redoStack.slice();
  p.scale = state.scale;
  p.unitName = state.unitName;
  p.globalCapacity = state.globalCapacity;
  p.activeFileId = state.activeFileId;
  p.pageIdx = state.pageIdx;
  p.openTabs = Array.isArray(state.openTabs) ? state.openTabs.map(t => ({ ...t })) : [];
  p.zoom = state.zoom; p.panX = state.panX; p.panY = state.panY;
  p.nextJointId = nextJointId;
  p.nextMemberId = nextMemberId;
  p.nextFileId = nextFileId;
  p.nextGlobalJointId = nextGlobalJointId;
  projects.push(p);
  activeProjectId = p.id;
  refreshProjectTabs();
  refreshProjectMenu();
})();

// 專案分頁列:垂直滾輪 → 水平捲動
(function setupProjectTabsWheel() {
  const scroll = document.querySelector("#projectTabs .pt-scroll");
  if (!scroll) return;
  scroll.addEventListener("wheel", (e) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    scroll.scrollLeft += e.deltaY;
  }, { passive: false });
})();

// 儲存成功後清 dirty 旗標(原本是 monkey-patch startSave;Phase 8i 抽 startSave 到模組後
//   改成 named wrapper,所有 caller 走 _startSaveWithHook 取代直接呼叫 startSave)
export async function _startSaveWithHook(forceAs) {
  const prevHandle = state.projectFileHandle;
  const r = await startSave(forceAs);
  // 儲存成功標誌:handle 非 null 或下載完成(無 error 拋出即視為成功)
  setProjectDirty(false);
  // 同步當前 project 的 handle
  const cur = projects.find(p => p.id === activeProjectId);
  if (cur) {
    cur.projectFileHandle = state.projectFileHandle || null;
    cur.dirty = false;
  }
  refreshProjectTabs();
  refreshProjectMenu();
  return r;
}

// ---------- 工具列顯示模式(文字 / 圖示 / 文字+圖示) ----------
//   body class:tb-mode-text / tb-mode-icon / tb-mode-both;預設 both;狀態存在 localStorage
const _TB_MODE_KEY = "staad.toolbar.displayMode";
export function _applyToolbarMode(mode) {
  const m = (mode === "text" || mode === "icon" || mode === "both") ? mode : "both";
  document.body.classList.remove("tb-mode-text", "tb-mode-icon", "tb-mode-both");
  document.body.classList.add("tb-mode-" + m);
  try { localStorage.setItem(_TB_MODE_KEY, m); } catch (_) {}
  // 同步 submenu 的勾選符號
  const map = { "text": "tb-mode-text", "icon": "tb-mode-icon", "both": "tb-mode-both" };
  document.querySelectorAll("#tbModeMenu .submenu .menu-entry").forEach(e => {
    e.classList.toggle("checked", e.dataset.action === map[m]);
  });
}
(function _initToolbarMode() {
  let saved = "both";
  try { const v = localStorage.getItem(_TB_MODE_KEY); if (v === "text" || v === "icon" || v === "both") saved = v; } catch (_) {}
  _applyToolbarMode(saved);
})();

// ---------- 子工具列(selectTools / bgEditTools)圖示裝飾 ----------
//   原本只有純文字按鈕;這裡定義 id → SVG 對照表,然後用裝飾器把每個按鈕內容包成
//   <span class="btn-icon">…</span><span class="btn-text">…</span>,讓「工具列顯示模式」一樣作用。
const _GENERIC_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.4"/></svg>';
const _ICON_SVG = {
  // === selectTools: 選取群組 ===
  "selToolsAll":        '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><polyline points="9 12 11 14 16 9"/></svg>',
  "selToolsJoints":     '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/></svg>',
  "selToolsMembers":    '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><line x1="7" y1="17" x2="17" y2="7"/></svg>',
  "selToolsRepeatHJ":   '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><polyline points="2 6 22 6 18 4 22 6 18 8"/></svg>',
  "selToolsRepeatVJ":   '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/><polyline points="18 2 18 22 16 18 18 22 20 18"/></svg>',
  "selToolsRepeatOH":   '<svg viewBox="0 0 24 24"><line x1="3" y1="7" x2="15" y2="7"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="17" x2="15" y2="17"/><polyline points="18 8 21 11 18 14"/></svg>',
  "selToolsRepeatOV":   '<svg viewBox="0 0 24 24"><line x1="7" y1="3" x2="7" y2="15"/><line x1="12" y1="3" x2="12" y2="15"/><line x1="17" y1="3" x2="17" y2="15"/><polyline points="8 18 11 21 14 18"/></svg>',
  "selToolsRepeatDH":   '<svg viewBox="0 0 24 24"><line x1="3" y1="18" x2="11" y2="10"/><line x1="9" y1="18" x2="17" y2="10"/><polyline points="18 8 21 11 18 14"/></svg>',
  "selToolsRepeatDV":   '<svg viewBox="0 0 24 24"><line x1="6" y1="3" x2="14" y2="11"/><line x1="6" y1="9" x2="14" y2="17"/><polyline points="8 18 11 21 14 18"/></svg>',
  // === selectTools: 編輯群組 ===
  "selToolsExtend":     '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><line x1="8" y1="12" x2="14" y2="12"/><polyline points="14 9 17 12 14 15"/></svg>',
  "selToolsExtendBoth": '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><line x1="8" y1="12" x2="16" y2="12"/><polyline points="9 9 6 12 9 15"/><polyline points="15 9 18 12 15 15"/></svg>',
  "selToolsJExtH":      '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><line x1="7" y1="12" x2="19" y2="12"/><polyline points="16 9 19 12 16 15"/></svg>',
  "selToolsJExtV":      '<svg viewBox="0 0 24 24"><circle cx="12" cy="19" r="2"/><line x1="12" y1="17" x2="12" y2="5"/><polyline points="9 8 12 5 15 8"/></svg>',
  "selToolsJExtHBoth":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><line x1="3" y1="12" x2="21" y2="12"/><polyline points="6 9 3 12 6 15"/><polyline points="18 9 21 12 18 15"/></svg>',
  "selToolsJExtVBoth":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2"/><line x1="12" y1="3" x2="12" y2="21"/><polyline points="9 6 12 3 15 6"/><polyline points="9 18 12 21 15 18"/></svg>',
  "selToolsDupJointH":  '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/><line x1="6" y1="8" x2="6" y2="16"/><line x1="18" y1="8" x2="18" y2="16"/></svg>',
  "selToolsDupJointV":  '<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21"/><circle cx="12" cy="6" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18" r="1.6"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="18" x2="16" y2="18"/></svg>',
  "selToolsJConnectH":  '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>',
  "selToolsJConnectV":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><line x1="12" y1="7" x2="12" y2="17"/></svg>',
  "selToolsJConnectD":  '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="12" r="1.6"/><line x1="6.5" y1="17.5" x2="17.5" y2="6.5"/></svg>',
  "selToolsJMerge":     '<svg viewBox="0 0 24 24"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6c4 0 4 6 10 6"/><path d="M7 18c4 0 4-6 10-6"/></svg>',
  "selToolsMeasure":    '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="7" rx="1"/><line x1="6" y1="9" x2="6" y2="13"/><line x1="10" y1="9" x2="10" y2="13"/><line x1="14" y1="9" x2="14" y2="13"/><line x1="18" y1="9" x2="18" y2="13"/></svg>',
  "selToolsAnchorToggle":'<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.2"/><line x1="12" y1="7" x2="12" y2="20"/><path d="M5 14a7 7 0 0 0 14 0"/><line x1="9" y1="11" x2="15" y2="11"/></svg>',
  "selToolsIntersectSel":'<svg viewBox="0 0 24 24"><line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  "btnDel":             '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
  // === selectTools: 移動群組 ===
  "selToolsMove":       '<svg viewBox="0 0 24 24"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
  "selToolsMoveH":      '<svg viewBox="0 0 24 24"><polyline points="6 8 3 11 6 14"/><polyline points="18 8 21 11 18 14"/><line x1="3" y1="11" x2="21" y2="11"/></svg>',
  "selToolsMoveV":      '<svg viewBox="0 0 24 24"><polyline points="8 6 11 3 14 6"/><polyline points="8 18 11 21 14 18"/><line x1="11" y1="3" x2="11" y2="21"/></svg>',
  "selToolsMoveDist":   '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="6" rx="1"/><line x1="6" y1="9" x2="6" y2="12"/><line x1="12" y1="9" x2="12" y2="12"/><line x1="18" y1="9" x2="18" y2="12"/><polyline points="20 18 22 20 20 22"/></svg>',
  "selToolsMoveAngle":  '<svg viewBox="0 0 24 24"><path d="M4 20 L20 4"/><path d="M4 20 L20 20"/><path d="M14 20a4 4 0 0 0 0-4"/></svg>',
  "selToolsMoveRect":   '<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20"/><line x1="4" y1="20" x2="4" y2="6"/><polyline points="2 9 4 6 7 9"/><polyline points="17 22 20 20 17 18"/></svg>',
  // === bgEditTools: 選取群組 ===
  "bgEditSelectAll":    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><polyline points="9 12 11 14 16 9"/></svg>',
  "bgEditClear":        '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><line x1="8" y1="8" x2="16" y2="16"/><line x1="16" y1="8" x2="8" y2="16"/></svg>',
  "bgEditMultiSelect":  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="14" height="14" rx="1" stroke-dasharray="3 2"/><rect x="8" y="8" width="14" height="14" rx="1" stroke-dasharray="3 2"/></svg>',
  "bgEditSelSquares":   '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>',
  "bgEditSelRects":     '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="10" rx="1"/></svg>',
  "bgEditSelCircles":   '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  "bgEditSelStraight":  '<svg viewBox="0 0 24 24"><line x1="3" y1="21" x2="21" y2="3"/></svg>',
  "bgEditSelStraightSolid": '<svg viewBox="0 0 24 24"><line x1="3" y1="21" x2="21" y2="3"/><circle cx="3" cy="21" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="3" r="1.4" fill="currentColor" stroke="none"/></svg>',
  "bgEditSelDiagonals": '<svg viewBox="0 0 24 24"><line x1="3" y1="18" x2="18" y2="3"/><line x1="6" y1="21" x2="21" y2="6"/></svg>',
  "bgEditSelDashedDiagonals": '<svg viewBox="0 0 24 24"><line x1="3" y1="21" x2="21" y2="3" stroke-dasharray="3 2"/></svg>',
  "bgEditClearShape":   '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2"/><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>',
  // === bgEditTools: 編輯群組 ===
  "bgEditPlaneOrigin":  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><line x1="12" y1="1" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="23"/><line x1="1" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="23" y2="12"/></svg>',
  "bgEditScaleRuler":   '<svg viewBox="0 0 24 24"><path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/></svg>',
  "bgEditDrawLine":     '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/><line x1="6.4" y1="17.6" x2="17.6" y2="6.4"/></svg>',
  "bgEditDrawDashed":   '<svg viewBox="0 0 24 24"><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/><line x1="6.4" y1="17.6" x2="17.6" y2="6.4" stroke-dasharray="3 2"/></svg>',
  "bgEditCopyLine":     '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="12" height="12" rx="1"/><rect x="3" y="9" width="12" height="12" rx="1"/></svg>',
  "bgEditBisector":     '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="3 2"/></svg>',
  "bgEditEquidist":     '<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12" stroke-dasharray="3 2"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  "bgEditToDashed":     '<svg viewBox="0 0 24 24"><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15" stroke-dasharray="3 2"/></svg>',
  "bgEditSplit":        '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
  "bgEditToMember":     '<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12"/><polyline points="18 9 21 12 18 15"/><circle cx="3" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
  "bgEditMarkIntersect":'<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="18"/><line x1="3" y1="18" x2="21" y2="6"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
  "bgEditMarkIntersectAndMember":'<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="18"/><line x1="3" y1="18" x2="21" y2="6"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="3" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="21" cy="18" r="1.4" fill="currentColor" stroke="none"/></svg>',
  "bgEditRectToCenterMember": '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6"/><line x1="3" y1="12" x2="21" y2="12" stroke-dasharray="3 2"/></svg>',
  "bgEditRectToTopMember":    '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6"/><line x1="3" y1="9" x2="21" y2="9" stroke-dasharray="3 2"/></svg>',
  "bgEditRectToBottomMember": '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6"/><line x1="3" y1="15" x2="21" y2="15" stroke-dasharray="3 2"/></svg>',
  "bgEditSquareToJoint":'<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  "bgEditDel":          '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  "bgEditScaleRulerMove":'<svg viewBox="0 0 24 24"><path d="M3 17L17 3l4 4L7 21z"/><polyline points="6 6 3 9 6 12"/><polyline points="18 6 21 9 18 12"/></svg>',
  "bgEditMeasureSelect": '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="7" rx="1"/><polyline points="9 12 11 14 16 9"/></svg>',
  "bgEditMeasureMove":  '<svg viewBox="0 0 24 24"><rect x="2" y="9" width="20" height="7" rx="1"/><polyline points="6 6 3 9 6 12"/><polyline points="18 6 21 9 18 12"/></svg>',
};

function _decorateSubToolButtons() {
  // 把 #selectTools / #bgEditTools 內每個 button 的內容包成 icon + text 兩個 span
  //   - text span 附 data-i18n="subtool.<id>",讓 _applyI18n 直接套字典(若字典裡有此 key)
  //   - 若 button 沒 id,就維持原文字、不加 i18n 屬性
  //   - title 屬性附 data-i18n-title="tip.<id>"(同樣 fallback 行為)
  ["#selectTools", "#bgEditTools"].forEach(sel => {
    const root = document.querySelector(sel);
    if (!root) return;
    root.querySelectorAll("button").forEach(btn => {
      if (btn.querySelector(".btn-icon")) return;            // 已裝飾
      const id = btn.id || "";
      const icon = _ICON_SVG[id] || _GENERIC_ICON;
      const text = btn.textContent.trim();
      const i18nAttr = id ? ` data-i18n="subtool.${id}"` : "";
      btn.innerHTML =
        `<span class="btn-icon">${icon}</span>` +
        `<span class="btn-text"${i18nAttr}>${text}</span>`;
      // tooltip i18n key:若該 id 存在 _I18N["tip." + id],套字典時會覆寫
      if (id && !btn.dataset.i18nTitle) btn.dataset.i18nTitle = "tip." + id;
    });
  });
}
_decorateSubToolButtons();
// 主工具列 button:批次加上 data-i18n-title="tip.<id>";切英文時自動套精簡 en tooltip
(function _decorateTopToolbarI18n() {
  document.querySelectorAll("#toolbar button").forEach(btn => {
    if (btn.id && !btn.dataset.i18nTitle) btn.dataset.i18nTitle = "tip." + btn.id;
  });
})();
// 再跑一次 _applyI18n,套用裝飾器剛加上的 data-i18n / data-i18n-title
try { _applyI18n(); } catch (_) {}

// Phase 8b:i18n (字典 + _t/_tx/_addI18n/_applyI18n/_applyI18nOnDoc/_setBtnLabel/_setLanguage) 搬到 src/i18n/index.ts
import { _t, _tx, _addI18n, _applyI18n, _applyI18nOnDoc, _setBtnLabel, _setLanguage, readSavedLang } from "./i18n";
export { _t, _tx, _addI18n, _applyI18n, _applyI18nOnDoc, _setBtnLabel, _setLanguage } from "./i18n";
// 原本是 (function _initLang(){...})() 在 i18n 區塊的尾端跑;為了保持「i18n module 載入時
// 還不算完全 init 完畢、要等 legacy 走到對應位置」的舊時序,把 IIFE 拉回 legacy 這條位置上。
(function _initLang() {
  _setLanguage(readSavedLang());
})();

// Phase 8m:頂部主選單列 + 最近開啟專案 子選單 搬到 src/ui/menubar.ts(~192 行)
import "./ui/menubar";

// ============================================================================
// Phase 1 — 把常用 global expose 給 window,維持 console debugging / 既有測試體驗
// 移到模組後,變數預設只在 module scope;Phase 9 cleanup 會移除這段。
// ============================================================================
(function _phase1ExposeGlobals() {
  const names = [
    "state", "$", "getPage", "getActiveFile",
    "render", "refreshLists", "fitToView",
    "invalidateRankCache", "inferAllGlobalJoints", "listGlobalBindings",
    "buildModel", "displayJointId", "displayMemberId",
    "openFloorTypesDialog", "openGlobalJointMgrDialog",
    "calibrateAllFilesToGlobalOrigin", "calibrateAllFilesToCustomOrigin",
    "_run3DOneClickPipeline", "_ensureRankCache",
    "showBuildModelCollisionsIfAny",
    "pushUndo", "clearSelection",
  ];
  for (const n of names) {
    try {
      const v = eval(n);
      if (typeof v !== "undefined") (window as any)[n] = v;
    } catch (_) {}
  }
  console.log("[phase 1] exposed " + names.length + " names to window for console debug");
})();
