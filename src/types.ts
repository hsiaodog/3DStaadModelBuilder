// State shape stubs — Phase 2 暫定的型別輪廓
// 之後 phase 拆 state 時會擴充;目前 legacy.ts 仍 @ts-nocheck 不用這些

/** 樓層類型 / 斜撐起始 — state.floorTypes 元素 */
export interface FloorType {
  key: string;
  label: string;
  yyStart: number;
  kind: "floor" | "brace";
}

/** 跨頁共用節點(state.globalJoints 元素) */
export interface GlobalJoint {
  id: number;
  label?: string;
  /** 推算 / 校準後的世界座標(mm) */
  x?: number;
  y?: number;
  z?: number;
  /** 是否被鎖定為世界 (0,0,0) */
  locked?: boolean;
  /** infer / calibrate 過程偵測到的問題 */
  warnings?: Array<{ message: string; severity?: "info" | "warn" | "error" }>;
}

/** 桿件 globalMember(跨頁同物理桿件去重)*/
export interface GlobalMember {
  id: number;
  /** 兩端 globalJoint id */
  g1?: number;
  g2?: number;
}

/** 單一頁 — file.pages[k] 的元素 */
export interface Page {
  /** 該頁第三軸位置(plane = XZ → Y;YZ → X;XY → Z 標高)*/
  z?: number;
  plane?: "XY" | "YZ" | "XZ" | "";
  flipX?: boolean;
  flipY?: boolean;
  /** 樓層類型 key — 只在 plane==="XZ" 有用 */
  floorType?: string;
  /** 斜撐起始 key — 只在 plane==="YZ" / "XY" 有用 */
  braceType?: string;
  /** 拆分頁的 orphan 標記(該頁已被另一檔搶走 / 被刪除)*/
  _orphan?: boolean;
  joints: Joint[];
  members: Member[];
  /** 拆分頁:該頁的群組編號(原檔分頁順序)*/
  groupNum?: number;
}

/** 平面圖檔(state.files 元素)*/
export interface FileEntry {
  id: number;
  name: string;
  /** 各頁的 dict;key 為頁 index 字串 */
  pages: Record<string, Page>;
  /** planeOrigin pixel 位置(此檔的 2D 原點)*/
  planeOrigin?: { x: number; y: number };
  /** 比例尺 ratio:1 px = ratio mm */
  scaleRuler?: { ratio: number; [k: string]: unknown };
  /** 是否為當前世界原點(state.globalOriginFileId 對應)*/
  isOrigin?: boolean;
  /** 底圖(cached)*/
  cachedBgImg?: string;
  cachedBgSvg?: string;
  cachedBgWidth?: number;
  cachedBgHeight?: number;
  bgWidth?: number;
  bgHeight?: number;
  bgImgDarkReady?: boolean;
  clipRect?: { x: number; y: number; w: number; h: number };
  /** 拆分頁時記載原始檔 id */
  sourceFileId?: number;
  type?: string;
  pdf?: unknown;
  image?: unknown;
}

/** 單一 joint(node)*/
export interface Joint {
  id: number;
  /** 2D pixel position(SVG 座標)*/
  x: number;
  y: number;
  /** 綁到 globalJoint 的 id */
  globalId?: number | null;
  /** 節點支承 / 邊界條件(FIXED / PINNED / FIXED BUT / SPRING / ENFORCED)。
   *  有支承的點會自動被編號演算法視為座標軸錨點(見 core/rankCache.ts)。*/
  support?: import("./core/support").Support;
  /** @deprecated 舊欄位 — 載入時 migrateJointSupport() 會升級為 support 並清掉 */
  supportType?: "FIXED" | "PINNED";
  /** @deprecated 舊「編號錨點」旗標 — 概念已移除,migration 會清掉(support ⟹ anchor)*/
  isAnchor?: boolean;
}

/** 單一桿件(member / 線)*/
export interface Member {
  id: number;
  j1: number;
  j2: number;
  globalMemberId?: number | null;
  /** 材料 lookup key */
  material?: string;
  /** 桿件釋放 / 行為類型(MEMBER RELEASE / TRUSS / TENSION / COMPRESSION / CABLE)*/
  release?: import("./core/memberRelease").MemberRelease;
}

/** Rank cache(Y / X / Z 軸各自的「世界座標 → rank」map)*/
export interface RankCache {
  x: Map<number, number>;
  y: Map<number, number>;
  z: Map<number, number>;
  /** 各軸的 anchor 段最大 rank;> anchorMax 即 demote-only 段 */
  anchorMax: { x: number; y: number; z: number };
  /** 階段 3 新增:Y 軸來自 brace-kind 桶的 rank Set(_isBraceJoint 用)*/
  braceRanks?: Set<number>;
  dirty: boolean;
  signature?: string;
  /** demoted globalJoint id 集合(per-joint demote)*/
  demotedGids?: Set<number>;
  unboundDemoted?: WeakSet<Joint>;
  gidPlanes?: Map<number, Set<string>>;
}
