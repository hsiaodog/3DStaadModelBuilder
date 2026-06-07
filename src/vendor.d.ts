// Vite 特殊 import query 的型別宣告。
// Vite 用 `?raw` 把檔案內容當字串 inline 進來(見 src/main.ts 的 pdf.js 載入),
// 但 tsc 不認得這個 query → 會噴 TS2307 "Cannot find module"。
// 補上 ambient 宣告後 tsc 才能 clean exit,讓 `npm run typecheck` 變成可靠的 CI 關卡。
declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*?url" {
  const url: string;
  export default url;
}

declare module "*?worker" {
  const workerConstructor: { new (): Worker };
  export default workerConstructor;
}
// (__APP_VERSION__ / __APP_REPO__ 已在 src/env.d.ts 宣告)
