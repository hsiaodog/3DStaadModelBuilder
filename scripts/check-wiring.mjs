#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 靜態接線稽核 (Layer 1)
//
// 抓兩類「缺東西就壞掉」的 bug,不需要瀏覽器:
//
//   [ERROR] 缺 DOM 節點:程式裡 $("id") / getElementById("id") /
//           querySelector("#id") 用到的 id,在 app.html 找不到、
//           而且也沒有任何 src 程式碼動態產生它 → 執行期會拿到 null → 爆。
//
//   [WARN]  死按鈕:app.html 裡有 id 的 <button>,但整個 src 連字面上
//           都沒出現過這個 id → 很可能沒接 handler(也可能是事件委派,
//           所以只當 warning)。
//
// 限制:$(變數) / $(`${...}`) 這種非字面 id 無法靜態驗證,只回報數量。
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "app.html");
const SRC = join(ROOT, "src");

// ── 1. 收集 app.html 的 id 與 button id ──────────────────────────────────
const html = readFileSync(HTML, "utf-8");
const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));

const htmlButtonIds = new Set();
for (const m of html.matchAll(/<button\b[^>]*\bid=["']([^"']+)["'][^>]*>/g)) {
  htmlButtonIds.add(m[1]);
}

// ── 2. 走訪 src,收集程式碼產生的 id + 字面查詢 + 整體文字 ────────────────
const codeCreatedIds = new Set();      // id="..." 出現在 src(動態注入的節點)
const lookups = [];                    // { id, file, line } 字面 id 查詢
let dynamicLookupCount = 0;            // $(變數) / $(`...`) 無法驗證
const srcFiles = [];

(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if ([".ts", ".js", ".mjs"].includes(extname(p)) && !p.endsWith(".d.ts")) srcFiles.push(p);
  }
})(SRC);

const LOOKUP_RE = /(?:\$\(|getElementById\(|querySelector(?:All)?\()\s*(["'`])([^"'`]*)\1\s*\)/g;
const DYNAMIC_RE = /\$\(\s*(?:`[^`]*\$\{|[A-Za-z_$][\w$]*\s*\))/g;

let allSrcText = "";
for (const f of srcFiles) {
  const text = readFileSync(f, "utf-8");
  allSrcText += "\n" + text;
  const rel = f.slice(ROOT.length + 1);

  // 動態注入的 id:三種寫法都算
  //   <div id="x">(template string 內)、 el.id = "x"、 el.setAttribute("id","x")
  for (const m of text.matchAll(/\bid=["'`]([^"'`${]+)["'`]/g)) codeCreatedIds.add(m[1]);
  for (const m of text.matchAll(/\.id\s*=\s*["'`]([^"'`${]+)["'`]/g)) codeCreatedIds.add(m[1]);
  for (const m of text.matchAll(/setAttribute\(\s*["']id["']\s*,\s*["'`]([^"'`${]+)["'`]/g)) codeCreatedIds.add(m[1]);

  // 字面 id 查詢(含 querySelector("#id"))
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    const isComment = trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
    if (!isComment) {
      for (const m of line.matchAll(LOOKUP_RE)) {
        let id = m[2];
        if (id.includes("${")) { dynamicLookupCount++; continue; } // template literal 動態 id
        if (id.startsWith("#")) id = id.slice(1);     // querySelector("#foo")
        else if (m[0].includes("querySelector")) continue; // 非 id 選擇器(.class、tag…)略過
        if (!id || /[ .#\[\]>:()]/.test(id)) continue;  // 複合選擇器略過
        lookups.push({ id, file: rel, line: i + 1, text: line });
      }
      for (const _ of line.matchAll(DYNAMIC_RE)) dynamicLookupCount++;
    }
  });
}

const knownIds = new Set([...htmlIds, ...codeCreatedIds]);

// ── 3. 判定 ──────────────────────────────────────────────────────────────
// 一個查詢只有在「立刻解參考」且「沒有 guard」時才是必爆的 bug:
//   危險:$("x").onclick=…   $("x")[k]=…       (x 不存在 → null.foo → throw)
//   安全:$("x") && $("x").foo    if ($("x"))    $("x")?.foo    const e=$("x"); if(e)…
// 同一行只要對該 id 有 guard,就視為刻意可選(legacy / 條件式 UI),不算 bug。
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function isGuarded(line, id) {
  const L = `\\$\\("${esc(id)}"\\)|getElementById\\("${esc(id)}"\\)`;
  return new RegExp(`(?:${L})\\s*(?:\\?\\.|&&|\\?|\\)|;|,|==|!=)`).test(line)  // 後接 guard 運算子
      || new RegExp(`if\\s*\\(\\s*(?:${L})`).test(line)                       // if ($("x"))
      || new RegExp(`(?:${L})\\s*$`).test(line.trimEnd());                    // const e = $("x");
}
function isDeref(line, id) {
  const L = `(?:\\$\\("${esc(id)}"\\)|getElementById\\("${esc(id)}"\\))`;
  if (new RegExp(`${L}\\s*\\?\\.`).test(line)) return false;                  // $("x")?.foo 安全
  // lookup 後可夾 `as Type` / `!`(non-null)/ 一個收尾 ) ,再接 .foo 或 [k] → 必爆
  return new RegExp(`${L}(?:\\s+as\\s+[^).;]+)?\\s*!?\\s*\\)?\\s*(?:\\.|\\[)`).test(line);
}

const unknown = lookups.filter((l) => !knownIds.has(l.id));
// 必爆:有解參考且整行對該 id 沒 guard
const dangerous = unknown.filter((l) => isDeref(l.text, l.id) && !isGuarded(l.text, l.id));
// 可選:有引用但都有 guard / 沒解參考 → 只當資訊
const optionalIds = new Set(unknown.filter((l) => !dangerous.includes(l)).map((l) => l.id));
const missing = dangerous;

const referencedIds = new Set(lookups.map((l) => l.id));
const deadButtons = [...htmlButtonIds].filter(
  (id) => !referencedIds.has(id) && !allSrcText.includes(id)   // 字面完全沒出現 → 連委派都沒
);

// ── 4. 報告 ──────────────────────────────────────────────────────────────
const line = "─".repeat(64);
console.log(line);
console.log("靜態接線稽核 (check-wiring)");
console.log(line);
console.log(`app.html:  ${htmlIds.size} 個 id (其中 ${htmlButtonIds.size} 個 <button>)`);
console.log(`src:       ${srcFiles.length} 檔, ${lookups.length} 個字面 id 查詢, ${codeCreatedIds.size} 個動態產生 id`);
console.log(`未驗證:    ${dynamicLookupCount} 個 $(變數)/$(\`...\`) 動態查詢(靜態無法檢查)`);
console.log(line);

if (missing.length) {
  // 同一 id 可能多處引用,聚合顯示
  const byId = new Map();
  for (const m of missing) (byId.get(m.id) ?? byId.set(m.id, []).get(m.id)).push(`${m.file}:${m.line}`);
  console.log(`\n❌ ERROR: ${missing.length} 處「無 guard 直接解參考一個不存在的 id」(執行期必爆 null):`);
  for (const [id, locs] of [...byId.entries()].sort()) {
    console.log(`   • "${id}"`);
    for (const loc of locs) console.log(`        ${loc}`);
  }
} else {
  console.log("\n✅ 沒有無 guard 解參考缺失 DOM 節點的查詢。");
}

if (optionalIds.size) {
  console.log(`\nℹ️  INFO: ${optionalIds.size} 個 id 不在 app.html,但程式都有 guard($("x") &&…/if($("x"))),視為刻意可選:`);
  console.log(`        ${[...optionalIds].sort().join(", ")}`);
}

if (deadButtons.length) {
  console.log(`\n⚠️  WARN: ${deadButtons.length} 個 <button> 的 id 在 src 完全沒被引用(可能是死按鈕):`);
  for (const id of deadButtons.sort()) console.log(`   • "${id}"`);
} else {
  console.log("\n✅ 每個有 id 的 <button> 都至少被 src 提到一次。");
}

console.log("\n" + line);
process.exit(missing.length ? 1 : 0);   // 只有缺節點才讓 CI 失敗;死按鈕僅警告
