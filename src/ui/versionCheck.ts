// 版本檢查 — 對 GitHub Releases API 查最新版本,跟本地 __APP_VERSION__ 比較。
//
// 設計重點:
//   • 啟動時自動檢查一次(只在 6 小時內沒查過時)— 避免每次刷新都打 GitHub API。
//     GitHub 對未驗證請求是 60 req/IP/hr,單一使用者每天才 1–2 次,夠用。
//   • 結果寫進 localStorage(staad.versionCheck),內含 lastCheckedAt / latest /
//     skippedVersion / dismissedAt。下次開 app 直接讀,不需重打 API。
//   • 使用者可在通知 banner 上選「略過此版本」,該版本後續不再提示;新版本出來再提示。
//   • 手動觸發(說明 → 檢查更新)永遠打一次 API,結果一樣寫快取,並彈出結果對話框。
//
// 對外:
//   • showAboutDialog() — 「關於」對話框,顯示版本 + GitHub repo 連結
//   • checkForUpdatesManual() — 手動按鈕,強制 fetch + 顯示結果
//   • checkForUpdatesAuto() — 啟動時 idle 呼叫,有快取就略過,有新版本才顯示 banner
// @ts-nocheck

const CACHE_KEY = "staad.versionCheck";
const CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 6 小時

// 把 "v0.1.0" / "0.1.0" / "release-0.1.0" 統一拆成 [major, minor, patch]
function parseVersion(s: string): number[] | null {
  if (!s) return null;
  const m = String(s).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [+m[1], +m[2], +(m[3] || 0)];
}

// 正:a > b、0:相等、負:a < b
function cmpVersion(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function _readCache(): any {
  try {
    const s = localStorage.getItem(CACHE_KEY);
    return s ? JSON.parse(s) : {};
  } catch (_) { return {}; }
}
function _writeCache(obj: any) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch (_) {}
}

async function _fetchLatestRelease(): Promise<{ tag: string; url: string; name: string; body: string; publishedAt: string } | null> {
  const repo = (typeof __APP_REPO__ !== "undefined") ? __APP_REPO__ : "";
  if (!repo) return null;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const resp = await fetch(url, { headers: { "Accept": "application/vnd.github+json" } });
    if (!resp.ok) return null;
    const j = await resp.json();
    return {
      tag: String(j.tag_name || ""),
      url: String(j.html_url || ""),
      name: String(j.name || j.tag_name || ""),
      body: String(j.body || ""),
      publishedAt: String(j.published_at || ""),
    };
  } catch (_) {
    return null;
  }
}

function _currentVersion(): string {
  return (typeof __APP_VERSION__ !== "undefined") ? __APP_VERSION__ : "0.0.0";
}
function _repo(): string {
  return (typeof __APP_REPO__ !== "undefined") ? __APP_REPO__ : "";
}

// ---------- UI ----------

function _ensureBanner(): HTMLDivElement {
  let bar = document.getElementById("versionBanner") as HTMLDivElement;
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "versionBanner";
  Object.assign(bar.style, {
    position: "fixed", top: "0", left: "0", right: "0",
    background: "linear-gradient(90deg, #1e3a8a, #1e40af)", color: "#fff",
    padding: "8px 16px", fontSize: "12px", fontFamily: "inherit",
    display: "none", alignItems: "center", gap: "12px", zIndex: "10000",
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
  });
  document.body.appendChild(bar);
  return bar;
}

function _showBanner(latest: { tag: string; url: string; name: string }) {
  const bar = _ensureBanner();
  const cur = _currentVersion();
  bar.innerHTML = `
    <span style="font-weight:700">🎉 新版本可下載</span>
    <span>${cur} → <strong>${latest.tag}</strong>${latest.name && latest.name !== latest.tag ? ` (${latest.name})` : ""}</span>
    <span style="flex:1"></span>
    <a id="vbView" href="${latest.url}" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline;cursor:pointer">查看 / 下載</a>
    <button id="vbSkip" style="background:transparent;border:1px solid rgba(255,255,255,0.4);color:#fff;padding:3px 10px;border-radius:3px;cursor:pointer;font-family:inherit;font-size:11px">略過此版本</button>
    <button id="vbClose" title="關閉(下次 app 啟動仍會檢查)" style="background:transparent;border:none;color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:0 4px">×</button>
  `;
  bar.style.display = "flex";
  document.getElementById("vbSkip")?.addEventListener("click", () => {
    const cache = _readCache();
    cache.skippedVersion = latest.tag;
    _writeCache(cache);
    bar.style.display = "none";
  });
  document.getElementById("vbClose")?.addEventListener("click", () => {
    const cache = _readCache();
    cache.dismissedAt = Date.now();
    _writeCache(cache);
    bar.style.display = "none";
  });
}

export function showAboutDialog() {
  const repo = _repo();
  const cur = _currentVersion();
  const url = repo ? `https://github.com/${repo}` : "";
  const releasesUrl = repo ? `https://github.com/${repo}/releases` : "";
  const msg =
    `STAAD 描圖工具\n\n` +
    `版本:${cur}\n` +
    (repo ? `儲存庫:${repo}\n` : "") +
    `\nGitHub: ${url}\n` +
    `Releases: ${releasesUrl}\n\n` +
    `按「確定」開啟 Releases 頁面;按「取消」關閉。`;
  if (window.confirm(msg) && releasesUrl) {
    window.open(releasesUrl, "_blank", "noopener");
  }
}

export async function checkForUpdatesManual() {
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = "檢查更新中…";
  const latest = await _fetchLatestRelease();
  const cur = _currentVersion();
  if (!latest) {
    if (hud) hud.textContent = "檢查更新失敗(無法連線或 GitHub API 限制)";
    window.alert(`無法取得最新版本資訊。\n可能原因:離線、GitHub API 限制、或尚未發佈任何 release。\n\n目前版本:${cur}`);
    return;
  }
  // 更新快取
  const cache = _readCache();
  cache.lastCheckedAt = Date.now();
  cache.latest = latest;
  _writeCache(cache);
  const diff = cmpVersion(latest.tag, cur);
  if (diff > 0) {
    if (hud) hud.textContent = `有新版本:${latest.tag}`;
    _showBanner(latest);
    if (window.confirm(`發現新版本:${latest.tag}\n目前:${cur}\n\n按「確定」開啟 GitHub release 頁面下載。`)) {
      window.open(latest.url, "_blank", "noopener");
    }
  } else if (diff === 0) {
    if (hud) hud.textContent = `已是最新版本(${cur})`;
    window.alert(`已是最新版本(${cur})`);
  } else {
    if (hud) hud.textContent = `本機版本(${cur})比 GitHub(${latest.tag})新`;
    window.alert(`本機版本 ${cur} 比 GitHub 最新 release(${latest.tag})還新 — 你正在跑 dev / pre-release build`);
  }
}

export async function checkForUpdatesAuto() {
  const cache = _readCache();
  const cur = _currentVersion();
  // 已在 cooldown 內 → 用快取的 latest 判斷,不打 API
  let latest = cache.latest;
  const fresh = cache.lastCheckedAt && (Date.now() - cache.lastCheckedAt < CHECK_COOLDOWN_MS);
  if (!fresh) {
    latest = await _fetchLatestRelease();
    if (latest) {
      cache.lastCheckedAt = Date.now();
      cache.latest = latest;
      _writeCache(cache);
    }
  }
  if (!latest || !latest.tag) return;
  if (cmpVersion(latest.tag, cur) <= 0) return;                       // 已是最新或更新
  if (cache.skippedVersion === latest.tag) return;                    // 使用者勾過略過
  _showBanner(latest);
}
