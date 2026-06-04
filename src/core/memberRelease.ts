// 桿件釋放(member release / member type)— 型別、共用存取器、顯示標籤
//
//   桿件的「力學端部條件」,對應 STAAD 的:
//     MEMBER RELEASE  — 桿件兩端(START=j1 端 / END=j2 端)各自釋放指定自由度
//     MEMBER TRUSS    — 桁架桿(只傳軸力)
//     MEMBER TENSION  — 只受拉
//     MEMBER COMPRESSION — 只受壓
//     MEMBER CABLE    — 索單元
//
//   與「節點支承 support」同架構:Member.release 是單一物件,type + 參數;唯一真實來源。
//   RELEASE 之外的四種是「桿件行為類型」,無端部參數(整根桿件套用)。
//   釋放是物理屬性 → 同 globalMemberId 的跨頁副本要一起變動(見 tools/memberRelease.ts)。

import type { DOF } from "./support";
import { DOF_KEYS } from "./support";

export type MemberReleaseType = "RELEASE" | "TRUSS" | "TENSION" | "COMPRESSION" | "CABLE";

export interface MemberRelease {
  type: MemberReleaseType;
  /** RELEASE 專用:START(j1 端)釋放的自由度 */
  start?: DOF[];
  /** RELEASE 專用:END(j2 端)釋放的自由度 */
  end?: DOF[];
}

export const RELEASE_TYPE_META: { type: MemberReleaseType; label: string; desc: string }[] = [
  { type: "RELEASE",     label: "端部釋放 RELEASE",   desc: "兩端(START / END)各自選要釋放的自由度" },
  { type: "TRUSS",       label: "桁架 TRUSS",          desc: "只傳軸力(兩端不傳彎矩 / 剪力)" },
  { type: "TENSION",     label: "只受拉 TENSION",      desc: "只承受拉力(受壓時失效)" },
  { type: "COMPRESSION", label: "只受壓 COMPRESSION",  desc: "只承受壓力(受拉時失效)" },
  { type: "CABLE",       label: "索 CABLE",            desc: "索單元(只受拉、考慮垂度)" },
];

/** 取得桿件釋放類型;沒有回 null。 */
export function releaseTypeOf(m: any): MemberReleaseType | null {
  if (!m || !m.release || !m.release.type) return null;
  return m.release.type;
}

/** 此桿件是否有有效釋放(空的 RELEASE 不算)。匯出 / 渲染 / 搜尋判定用。 */
export function hasRelease(m: any): boolean {
  const r = m && m.release;
  if (!r || !r.type) return false;
  if (r.type === "RELEASE") {
    return !!((r.start && r.start.length) || (r.end && r.end.length));
  }
  return true;   // TRUSS / TENSION / COMPRESSION / CABLE
}

/** 給 UI 顯示的完整標籤(含兩端釋放的自由度)。無釋放回空字串。 */
export function releaseLabel(r: any): string {
  if (!r || !r.type) return "";
  if (r.type !== "RELEASE") return r.type;   // TRUSS / TENSION / …
  const s = (r.start || []).filter((d: any) => DOF_KEYS.includes(d));
  const e = (r.end || []).filter((d: any) => DOF_KEYS.includes(d));
  const parts: string[] = [];
  if (s.length) parts.push(`起 ${s.join(" ")}`);
  if (e.length) parts.push(`末 ${e.join(" ")}`);
  return parts.length ? parts.join(" · ") : "RELEASE";
}

// ===== 顯示用:把 release 轉成「端部圖示 + 線型」描述,2D / 3D 共用同一套判定 =====
//   端部圖示:hinge(空心圓=含彎矩釋放)/ roller(方塊=只釋放平移)/ none(無釋放)
//   線型:solid / dashed(TENSION)/ dotted(COMPRESSION)/ wavy(CABLE)
export type ReleaseEndGlyph = "none" | "hinge" | "roller";
export type ReleaseLineStyle = "solid" | "dashed" | "dotted" | "wavy";
export interface ReleaseRenderInfo {
  /** START(j1 端)圖示 */ startGlyph: ReleaseEndGlyph;
  /** END(j2 端)圖示 */   endGlyph: ReleaseEndGlyph;
  /** 整根桿件線型 */       lineStyle: ReleaseLineStyle;
}

/** 一組釋放自由度 → 端部圖示:含彎矩(MX/MY/MZ)→ hinge;只含平移(FX/FY/FZ)→ roller;空 → none。 */
export function endReleaseGlyph(dofs?: DOF[]): ReleaseEndGlyph {
  if (!Array.isArray(dofs) || !dofs.length) return "none";
  if (dofs.some((d) => d === "MX" || d === "MY" || d === "MZ")) return "hinge";
  if (dofs.some((d) => d === "FX" || d === "FY" || d === "FZ")) return "roller";
  return "none";
}

/** 桿件 → 顯示描述;無有效釋放回 null。 */
export function releaseRenderInfo(m: any): ReleaseRenderInfo | null {
  const r = m && m.release;
  if (!r || !r.type || !hasRelease(m)) return null;
  switch (r.type) {
    case "RELEASE":     return { startGlyph: endReleaseGlyph(r.start), endGlyph: endReleaseGlyph(r.end), lineStyle: "solid" };
    case "TRUSS":       return { startGlyph: "hinge", endGlyph: "hinge", lineStyle: "solid" };   // 兩端鉸接(只傳軸力)
    case "TENSION":     return { startGlyph: "none",  endGlyph: "none",  lineStyle: "dashed" };
    case "COMPRESSION": return { startGlyph: "none",  endGlyph: "none",  lineStyle: "dotted" };
    case "CABLE":       return { startGlyph: "none",  endGlyph: "none",  lineStyle: "wavy" };
  }
  return null;
}

/** 分組鍵:相同釋放設定的桿件在匯出時可壓進同一組(TO range)。 */
export function releaseGroupKey(r: any): string {
  if (!r || !r.type) return "";
  if (r.type !== "RELEASE") return r.type;
  const s = (r.start || []).filter((d: any) => DOF_KEYS.includes(d)).join(" ");
  const e = (r.end || []).filter((d: any) => DOF_KEYS.includes(d)).join(" ");
  return `RELEASE|S:${s}|E:${e}`;
}
