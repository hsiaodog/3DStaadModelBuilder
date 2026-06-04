// 單位 / STAAD keyword 轉換 — 純函式,沒 state 依賴

/** 把內部單位名轉成 STAAD UNIT 指令需要的 keyword */
export function staadUnitKeyword(v: string): string {
  return (
    { meter: "METER", mmb: "MMS", centimeter: "CENTIMETER", feet: "FEET" } as Record<string, string>
  )[v] || "METER";
}

/** 內部單位名 → 公尺換算係數(用於 calibration 中介轉換) */
export function unitToMeter(name: string): number {
  return ({ m: 1, mm: 0.001, cm: 0.01, ft: 0.3048 } as Record<string, number>)[name] || 1;
}

/** 公尺 → 目標單位換算係數(對應上方 staadUnitKeyword 的同套 v) */
export function meterToTarget(v: string): number {
  return (
    { meter: 1, mmb: 1000, centimeter: 100, feet: 1 / 0.3048 } as Record<string, number>
  )[v] || 1;
}
