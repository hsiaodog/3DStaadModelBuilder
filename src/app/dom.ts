// 核心 DOM 參照 — 全程式共用的主要畫布 / 容器 element
//
//   $        — getElementById short-hand
//   wrap     — #canvas-wrap(畫布容器,接收 pan/zoom + mouse events)
//   stage    — #stage(承載 bg + svg 的內層;transform 套在這個 element)
//   bg       — #bg-canvas(底圖 raster,PDF/image 渲染目標)
//   bgctx    — bg.getContext("2d")(底圖 2D context)
//   svg      — #vector(向量層,節點 / 桿件 / labels 都畫在這)
// @ts-nocheck

export const $ = (id: string) => document.getElementById(id);
export const wrap = $("canvas-wrap");
export const stage = $("stage");
export const bg = $("bg-canvas");
export const bgctx = bg.getContext("2d");
export const svg = $("vector");
