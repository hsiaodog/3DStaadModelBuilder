// 全域常數 — 純值,沒任何 state 依賴

/** Undo / redo 堆疊上限(超過後最舊的會被丟掉)*/
export const MAX_UNDO = 100;

/**
 * 樓層類型 / 斜撐起始 共用的 YY 起始階池(每 10 一階,共 10 階)
 * 此池跨「樓層」「斜撐」kind 共享,同階不可被兩個不同型佔用
 */
export const ALLOWED_YY = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91] as const;
