// 共用排序 comparator
//   wrap-from-origin:0 first → 正向 ascending → 負向 ascending(從最遠回到 0)
//   例:[-1000, -15, 0, 100, 200, 1000] → [0, 100, 200, 1000, -1000, -200, -15]
//   用於 relayout 桿件 / 節點排序 — 從世界原點 (0,0,0) 出發、由近往遠編號

export function wrapPosSort(a: number, b: number): number {
  if (a === 0) return b === 0 ? 0 : -1;
  if (b === 0) return 1;
  if (a > 0 && b < 0) return -1;
  if (a < 0 && b > 0) return 1;
  return a - b;
}
