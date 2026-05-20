// 全局節點 binding 查詢 + infer + 校準等核心邏輯
//   暫時跟舊版 API 對齊;後續 phase 可拆 inferGlobalJoint / calibrate 子函式進來
//   joint2DToWorld3D 已搬到 ./projection,這裡 import 使用

import { state } from "../legacy";
import type { GlobalJoint } from "../types";

export interface GlobalBinding {
  fileId: number;
  fileName: string;
  pageIdx: number;
  jointId: number;
}

/** 列出所有綁到此 globalId 的 view joint 位置(跨頁) */
export function listGlobalBindings(gid: number): GlobalBinding[] {
  const out: GlobalBinding[] = [];
  const files = (state as any).files;
  for (const f of files) {
    for (const k in (f.pages || {})) {
      const pg = f.pages[k];
      for (const j of (pg.joints || [])) {
        if ((j as any).globalId === gid) {
          out.push({ fileId: f.id, fileName: f.name, pageIdx: +k, jointId: j.id });
        }
      }
    }
  }
  return out;
}
