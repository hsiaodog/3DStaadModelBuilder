// 中央 state — 全程式共享的可變狀態 + 全域 ID 計數器 + setters
//
//   • state: 主物件,所有 UI 模式 / 選取 / 工具 pending / 視覺 toggle 等都讀寫這裡
//   • nextJointId / nextMemberId / nextFileId / nextGlobalJointId / nextGlobalMemberId:
//     全域單調遞增 ID(專案切換時由 projectTabs.loadProjectDataFromP 重設)
//   • allocJointId / allocMemberId: 配 id + 自動 ++(取代 post-increment;ESM 不允許跨模組對 let 做 ++)
//   • setNextXxxId: 跨模組設值用(projectLoad / projectTabs / snapshot 會呼叫)
// @ts-nocheck

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
  memberDirFilter: "all" as "all" | "vertical" | "horizontal" | "orthogonal" | "diagonal",
  // ↑ 桿件方向篩選:在 selectFilter 之上再細分;「垂直/水平/正交/斜」按鈕切換時使用
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
  bgDistStr: "",                             // 畫直線 / 複製線:CAD 直距輸入,目前打字中的距離字串(顯示單位;游標定方向)
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
  labelsVisible: true,      // 標示顯示 / 隱藏切換(legacy 合併旗標,read-only;新程式請用下面兩個)
  jointLabelsVisible: true, // 節點標號顯示 / 隱藏(獨立於桿件)
  memberLabelsVisible: true,// 桿件標號顯示 / 隱藏(獨立於節點)
  bgVisible: true,          // 底圖顯示 / 隱藏切換(影響 bg-canvas + bgSvg 的可見性)
  jointsVisible: true,      // 節點圓圈 + 錨點 + 節點編號 顯示 / 隱藏(body.joints-hidden CSS)
  membersVisible: true,     // 桿件線 + 桿件編號 顯示 / 隱藏(body.members-hidden CSS)
  rangeZoomMode: false,     // 範圍放大模式
  rangeZoomFirst: null,     // 第一個對角點(wrap 相對座標 {x,y})
  multiSelectSticky: false, // 多選持續模式(Shift+S 切換):開啟後點選為追加
  originPending: false,     // 座標原點 pending:進入 selectBg 後游標自動鎖點交點,點擊設為原點
  originSnap: null,         // 座標原點:目前游標鎖到的交點/端點 {x,y,kind} 或 null(沒鎖到)
  originFailCount: 0,       // 座標原點:連續「點在沒有交點處」的次數,達 3 自動取消
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

// ===== 全域單調遞增 ID 計數器 + 配 id 的 helper =====
//   ESM 不允許跨模組對 `let` 做 ++,所以提供 alloc/set 函式給其他模組使用。
//   專案切換時由 projectTabs.loadProjectDataFromP 透過 setter 重設。
export let nextJointId = 1, nextMemberId = 1, nextFileId = 1, nextGlobalJointId = 1, nextGlobalMemberId = 1;
export function allocJointId() { return nextJointId++; }
export function allocMemberId() { return nextMemberId++; }
export function allocFileId() { return nextFileId++; }
export function allocGlobalJointId() { return nextGlobalJointId++; }
export function allocGlobalMemberId() { return nextGlobalMemberId++; }
export function setNextJointId(v: number) { nextJointId = v; }
export function setNextMemberId(v: number) { nextMemberId = v; }
export function setNextFileId(v: number) { nextFileId = v; }
export function setNextGlobalJointId(v: number) { nextGlobalJointId = v; }
export function setNextGlobalMemberId(v: number) { nextGlobalMemberId = v; }
