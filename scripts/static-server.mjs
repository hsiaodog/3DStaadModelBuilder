#!/usr/bin/env node
// 零依賴靜態檔案伺服器,專給 Playwright 冒煙測試載入已 build 的單檔 STAAD-Tracer.html。
// (用 http 而非 file:// — 避免 module worker / blob 在 file:// 下被瀏覽器擋掉。)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT || 4173);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm" };

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/STAAD-Tracer.html";
    const full = normalize(join(ROOT, p));
    if (!full.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(full);
    res.writeHead(200, { "Content-Type": TYPES[extname(full)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`static-server: http://localhost:${PORT}`));
