#!/bin/bash
# 啟動本機 HTTP server 並用 Chrome 開啟 STAAD 描圖工具。
# 雙擊此檔即可啟動。必須在 http://localhost 之下、且用 Chromium 系瀏覽器(Chrome / Edge),
# File System Access API 才會可用 —— 否則開檔會「無 handle」:最近清單無法直接重開、
# 存檔只能「另存」而無法直接覆寫原專案檔。
cd "$(dirname "$0")"

# 要開的頁面:優先用建置好的單檔 STAAD-Tracer.html;若不存在退回 app.html
PAGE="STAAD-Tracer.html"
[ -f "$PAGE" ] || PAGE="app.html"

PORT=8765
# 若 PORT 已被佔用,往後找一個空的(最多嘗試 20 個)
while lsof -i tcp:${PORT} >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  if [ "$PORT" -gt 8785 ]; then
    echo "找不到可用的 port (8765~8785 都被佔用)。請手動關閉佔用的程式或改 PORT。"
    read -p "按 Enter 結束…"
    exit 1
  fi
done
URL="http://localhost:${PORT}/${PAGE}"

echo "啟動本機 server: ${URL}"
echo "(按 Ctrl+C 結束 server,關閉這個終端機視窗也會結束)"

# 0.5 秒後開啟瀏覽器(讓 server 先就緒)。
#   優先用 Google Chrome(File System Access API 才可用);沒裝 Chrome 才退回系統預設瀏覽器。
open_browser() {
  sleep 0.5
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -a "Google Chrome" "${URL}"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -a "Microsoft Edge" "${URL}"
  else
    echo "⚠ 找不到 Chrome / Edge,改用系統預設瀏覽器開啟。"
    echo "  若是 Safari / Firefox,開檔仍會「無 handle」(無法直接重開 / 覆寫),建議改用 Chrome。"
    open "${URL}"
  fi
}
( open_browser ) &

# 啟動 Python 內建的簡易 HTTP server(macOS 內建,不需安裝)
exec python3 -m http.server "${PORT}"
