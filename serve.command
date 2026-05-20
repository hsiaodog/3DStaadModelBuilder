#!/bin/bash
# 啟動本機 HTTP server 並開啟 STAAD 描圖工具。
# 雙擊此檔即可啟動。需要在 http://localhost 之下,File System Access API 才會可用
# (file:// 開啟瀏覽器會無法直接覆寫專案檔)。
cd "$(dirname "$0")"

PORT=8765
URL="http://localhost:${PORT}/index.html"

# 若 PORT 已被佔用,往後找一個空的(最多嘗試 20 個)
while lsof -i tcp:${PORT} >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  if [ "$PORT" -gt 8785 ]; then
    echo "找不到可用的 port (8765~8785 都被佔用)。請手動關閉佔用的程式或改 PORT。"
    read -p "按 Enter 結束…"
    exit 1
  fi
done
URL="http://localhost:${PORT}/index.html"

echo "啟動本機 server: ${URL}"
echo "(按 Ctrl+C 結束 server,關閉這個終端機視窗也會結束)"

# 0.5 秒後開啟瀏覽器(讓 server 先就緒)
( sleep 0.5 && open "${URL}" ) &

# 啟動 Python 內建的簡易 HTTP server(macOS 內建,不需安裝)
exec python3 -m http.server "${PORT}"
