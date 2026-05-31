// 節點支承(support / boundary condition)— 型別、向下相容 migration、共用存取器
//
// Phase 1(資料模型):把舊的 `Joint.supportType: "FIXED"|"PINNED"` 升級為結構化的
//   `Joint.support` 物件,可表達 FIXED / PINNED / FIXED BUT(部分釋放)/ SPRING(彈簧)/
//   ENFORCED(強制位移)。
//
//   ★ 「編號錨點」概念已移除:有支承的點自動視為座標軸錨點(support ⟹ rank anchor,
//     見 core/rankCache.ts),不再有獨立的手動 isAnchor 旗標。舊欄位 isAnchor 在 migration
//     時清掉(其支承意義已轉成 support)。
//
//   唯一真實來源是 `j.support`。`supportTypeOf()` 仍能讀未 migrate 的舊記憶體物件(後援),
//   但載入 / 還原專案時 migrateAllSupports() 會把整包資料就地升級,存檔即為新格式。

export type SupportType = "FIXED" | "PINNED" | "FIXED_BUT" | "SPRING" | "ENFORCED";
export type DOF = "FX" | "FY" | "FZ" | "MX" | "MY" | "MZ";
export type SpringKey = "KFX" | "KFY" | "KFZ" | "KMX" | "KMY" | "KMZ";

export interface Support {
  type: SupportType;
  /** FIXED_BUT / ENFORCED BUT:放鬆(自由)的自由度 */
  released?: DOF[];
  /** SPRING:各方向勁度(kN/m、kN·m/rad)*/
  springs?: Partial<Record<SpringKey, number>>;
  /** ENFORCED:強制位移量 */
  enforced?: Partial<Record<DOF, number>>;
}

export const SPRING_KEYS: SpringKey[] = ["KFX", "KFY", "KFZ", "KMX", "KMY", "KMZ"];
export const DOF_KEYS: DOF[] = ["FX", "FY", "FZ", "MX", "MY", "MZ"];

/** 把單一 joint 的舊 `supportType` / `isAnchor` 欄位 migrate 成新的 `support` 物件(idempotent)。 */
export function migrateJointSupport(j: any): void {
  if (!j) return;
  // 已是新格式 → 清掉殘留的 legacy 欄位即可
  if (j.support && typeof j.support === "object") {
    delete j.supportType;
    delete j.isAnchor;
    return;
  }
  // 舊格式:只有 isAnchor 的點才有支承(舊版 isAnchor ⟹ FIXED/PINNED);supportType 未設 → 預設 FIXED
  if (j.isAnchor) {
    j.support = { type: j.supportType === "PINNED" ? "PINNED" : "FIXED" };
  }
  delete j.supportType;
  delete j.isAnchor;   // 「編號錨點」概念已移除 — 支承意義已轉成 support
}

/** 走訪 files → pages → joints 做 migration。載入 / 還原專案時呼叫一次。 */
export function migrateAllSupports(files: any[]): void {
  if (!Array.isArray(files)) return;
  for (const f of files) {
    for (const pg of Object.values((f && f.pages) || {})) {
      const joints = (pg as any) && (pg as any).joints;
      if (Array.isArray(joints)) for (const j of joints) migrateJointSupport(j);
    }
  }
}

/** 取得 joint 的支承類型;沒有支承回 null。相容未 migrate 的舊記憶體物件(後援讀 supportType)。 */
export function supportTypeOf(j: any): SupportType | null {
  if (!j) return null;
  if (j.support && j.support.type) return j.support.type;
  // 後援:尚未 migrate 的舊物件(僅 isAnchor+supportType 的存檔)
  if (j.isAnchor) return j.supportType === "PINNED" ? "PINNED" : "FIXED";
  return null;
}

/** 此 joint 是否有支承(匯出 / 渲染判定用)。 */
export function hasSupport(j: any): boolean {
  return supportTypeOf(j) != null;
}

/** 給 UI 顯示用的完整支承標籤(比 STAAD 規格更易讀,含釋放自由度 / 彈簧勁度 / 強制位移量)。
 *    FIXED / PINNED
 *    FIXED BUT FX FY        (FIXED_BUT 的釋放自由度)
 *    SPRING KFY 15000 KMX 200
 *    ENFORCED BUT FX [FZ=5]  (釋放 + 強制位移量)
 *  無支承回空字串。 */
export function supportLabel(support: any): string {
  if (!support || !support.type) return "";
  switch (support.type) {
    case "FIXED": return "FIXED";
    case "PINNED": return "PINNED";
    case "FIXED_BUT": {
      const rel = (support.released || []).filter((d: any) => DOF_KEYS.includes(d));
      return rel.length ? `FIXED BUT ${rel.join(" ")}` : "FIXED";
    }
    case "SPRING": {
      const parts: string[] = [];
      for (const k of SPRING_KEYS) {
        const v = support.springs && support.springs[k];
        if (v != null && Number.isFinite(v)) parts.push(`${k} ${v}`);
      }
      return parts.length ? `SPRING ${parts.join(" ")}` : "SPRING";
    }
    case "ENFORCED": {
      const rel = (support.released || []).filter((d: any) => DOF_KEYS.includes(d));
      const vals: string[] = [];
      for (const d of DOF_KEYS) {
        const v = support.enforced && support.enforced[d];
        if (v != null && Number.isFinite(v)) vals.push(`${d}=${v}`);
      }
      let s = "ENFORCED";
      if (rel.length) s += ` BUT ${rel.join(" ")}`;
      if (vals.length) s += ` [${vals.join(" ")}]`;
      return s;
    }
    default: return support.type;
  }
}

/** 產生該支承在 STAAD SUPPORTS 區塊中、節點 id 之後的「關鍵字尾段」。
 *  相同設定的點會得到相同字串 → 匯出時可分組壓 TO range。
 *    FIXED                       → "FIXED"
 *    PINNED                      → "PINNED"
 *    FIXED_BUT released[MX MY]   → "FIXED BUT MX MY"
 *    SPRING springs{KFY:1500}    → "FIXED BUT KFY 1500"
 *    ENFORCED (+released)        → "ENFORCED" / "ENFORCED BUT FX FY"
 *  註:ENFORCED 的位移量需另外寫在 SUPPORT DISPLACEMENT 載重(本工具不輸出載重),此處只標關鍵字。
 */
export function supportStaadSpec(support: any): string {
  if (!support || !support.type) return "FIXED";
  switch (support.type) {
    case "PINNED": return "PINNED";
    case "FIXED_BUT": {
      const rel = (support.released || []).filter((d: any) => DOF_KEYS.includes(d));
      return rel.length ? `FIXED BUT ${rel.join(" ")}` : "FIXED";
    }
    case "SPRING": {
      const parts: string[] = [];
      for (const k of SPRING_KEYS) {
        const v = support.springs && support.springs[k];
        if (v != null && Number.isFinite(v)) parts.push(`${k} ${v}`);
      }
      return parts.length ? `FIXED BUT ${parts.join(" ")}` : "FIXED";
    }
    case "ENFORCED": {
      const rel = (support.released || []).filter((d: any) => DOF_KEYS.includes(d));
      return rel.length ? `ENFORCED BUT ${rel.join(" ")}` : "ENFORCED";
    }
    case "FIXED":
    default: return "FIXED";
  }
}
