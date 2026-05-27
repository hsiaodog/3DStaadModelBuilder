// 全域 debug 暴露(devtools console 抓資料用)
//   各模組原本散著 `(window as any)._lastFooBar = ...`,集中走這個 helper:
//     • 型別乾淨,少寫一堆 cast
//     • 名稱保留向下相容(window._lastFooBar 在 console 仍然查得到)
//     • 看 src/utils/debug.ts 就知道全部 debug surface 是哪些
//
//   List of stable keys:
//     _lastRankCacheStats          — 每軸 unique 座標統計(rankCache.ts:_ensureRankCache)
//     _lastRankCacheYBuckets       — Y 軸 per-bucket Y 值清單 + maxRank(rankCache.ts)
//     _lastRankCacheBucketOverflows — Y bucket 撐爆 cap 的細節(rankCache.ts)
//     _rankCacheBuildVersion       — rank cache 程式碼版本字串(v2-twopass)
//     _lastBuildModelCollisions    — 匯出 buildModel 時撞號 fallback 紀錄(buildModel.ts)
//     _lastDiagDClassify           — _relayoutPageCore 分類成 D 軸的桿件 dx/dy 紀錄
//     _lastSLCount                 — 切面 link merged group 上次數量(render/index.ts)

export function setDebugVar<T>(name: string, value: T): T {
  if (typeof window !== "undefined") (window as any)[name] = value;
  return value;
}

export function getDebugVar<T = any>(name: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as any)[name] as T | undefined;
}

// 對 Map / Object 型別的累加:取現有(沒有則建)再寫,並回傳給 caller 接續操作
export function getOrInitDebugObj<T extends object>(name: string, init: () => T): T {
  if (typeof window === "undefined") return init();
  const w = window as any;
  if (!w[name]) w[name] = init();
  return w[name] as T;
}
