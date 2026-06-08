// 命令登錄(Command Registry)— AutoCAD 風命令列的核心
//
//   • 每個按鈕 / 選單項目自動變成一條命令(零手工對應):
//       - 選單:menubar.ts 把它的 actions map 丟進 registerMenuActions()
//       - 按鈕:initButtonCommands() 啟動時掃 button[id],run = () => el.click()
//   • 中文標籤 / 英文標籤 / AutoCAD 短碼 全部等價,可模糊比對觸發
//   • resolve(query) 回傳排名後的候選命令(給自動完成 + 直接執行用)
// @ts-nocheck

import { ALIASES } from "./aliases";
import { getI18nEntry } from "../i18n";

// Command = { id, names[], label{zh,en}, group, run(args?), requireFile, hidden }
const _cmds = new Map();           // id -> Command
let _buttonsScanned = false;

export function registerCommand(cmd) {
  if (!cmd || !cmd.id) return;
  const prev = _cmds.get(cmd.id);
  // 合併:後註冊的補欄位,但保留既有 run(選單 action 優先於按鈕 click)
  const merged = Object.assign({}, prev, cmd);
  // names 去重(大小寫不敏感)
  const seen = new Set();
  merged.names = [].concat(prev?.names || [], cmd.names || [])
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(s => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  if (prev?.run && !cmd.run) merged.run = prev.run;
  _cmds.set(cmd.id, merged);
}

export function getCommands() {
  return [..._cmds.values()].filter(c => !c.hidden);
}
export function getCommandById(id) { return _cmds.get(id); }

// ---- 標籤抽取 helpers ----
function _cleanLabel(s) {
  return (s || "").replace(/\s+/g, " ").replace(/[.…]+$/, "").trim();
}
// 從 data-i18n key 抓中英兩種文字
function _i18nBoth(key) {
  const e = getI18nEntry(key);
  if (e) return { zh: e["zh-TW"] || "", en: e["en"] || "" };
  return null;
}

// 從 tooltip 抓「前段」當命令名:去掉冒號/括號後的長說明
function _titleHead(title) {
  if (!title) return "";
  const h = _cleanLabel(String(title).split(/[（(:：—]|\s\(/)[0]);
  return h;
}
// 把一個 DOM 元素轉成命令的 names / label
function _namesFromEl(el, extraId) {
  const names = [];
  let label = { zh: "", en: "" };
  // 1) data-i18n(按鈕文字)— 最可靠的中英對照
  const key = el.getAttribute("data-i18n");
  if (key) {
    const both = _i18nBoth(key);
    if (both) { label = both; names.push(both.zh, both.en); }
  }
  // 2) data-i18n-title(tooltip 的中英對照)— icon 按鈕主要靠這個拿英文名
  const tkey = el.getAttribute("data-i18n-title");
  if (tkey) {
    const both = _i18nBoth(tkey);
    if (both) {
      names.push(_titleHead(both.zh), _titleHead(both.en));
      if (!label.zh) label = { zh: _titleHead(both.zh), en: _titleHead(both.en) };
    }
  }
  // 3) 按鈕文字
  const txt = _cleanLabel(el.textContent);
  if (txt && txt.length <= 20) { names.push(txt); if (!label.zh) label.zh = txt; }
  // 4) 純 title 的前段(icon 按鈕沒文字時的中文名來源)
  const head = _titleHead(el.getAttribute("title"));
  if (head && head.length <= 20 && !/^tip\./.test(head)) {   // 排除還沒套 i18n 的 key
    names.push(head);
    if (!label.zh) label.zh = head;
  }
  // 5) 別名表(AutoCAD 短碼 + 中英同義詞,用 id / action 當 key)
  const al = ALIASES[extraId];
  if (al) names.push(...al);
  return { names, label };
}

// ---- 選單 actions → 命令 ----
// menubar.ts 在 setupMenuBar 末段呼叫:registerMenuActions(actions)
export function registerMenuActions(actions) {
  for (const action of Object.keys(actions || {})) {
    const fn = actions[action];
    if (typeof fn !== "function") continue;
    const entry = document.querySelector(`#menuBar .menu-entry[data-action="${action}"]`);
    let names, label;
    if (entry) {
      ({ names, label } = _namesFromEl(entry, action));
    } else {
      // 沒有對應 menu-entry(例如搜尋鈕 / 純 action)→ 仍要帶上別名表
      names = [...(ALIASES[action] || [])];
      label = { zh: names[0] || action, en: action };
    }
    // 找所屬選單群組(File/Edit/Tools…)
    const group = entry?.closest(".menu-item")?.querySelector(".menu-title")?.textContent?.trim() || "選單";
    registerCommand({
      id: `menu:${action}`,
      names: names.length ? names : [action],
      label,
      group,
      el: entry || null,
      run: () => fn(),
    });
  }
}

// ---- 按鈕 → 命令 ----
const _SKIP_BTN = new Set([
  // 純 UI 開關 / 容器類按鈕,當命令沒意義的可在這裡排除(目前先全收)
]);
export function initButtonCommands() {
  if (_buttonsScanned) return;
  _buttonsScanned = true;
  const btns = document.querySelectorAll("button[id]");
  btns.forEach(btn => {
    const id = btn.id;
    if (!id || _SKIP_BTN.has(id)) return;
    if (_cmds.has(`btn:${id}`)) return;
    const { names, label } = _namesFromEl(btn, id);
    if (!names.length) return;                  // 沒有任何可讀名稱 → 跳過
    registerCommand({
      id: `btn:${id}`,
      names,
      label: label.zh || label.en ? label : { zh: id, en: id },
      group: "按鈕",
      el: btn,
      run: () => {
        const el = document.getElementById(id);
        if (!el) return { ok: false, msg: `找不到按鈕 #${id}` };
        if (el.disabled) return { ok: false, msg: `「${label.zh || id}」目前無法使用` };
        el.click();
        return { ok: true };
      },
    });
  });
}

// ---- 使用頻率(常用指令排前面) ----
const USAGE_KEY = "staad.cmdUsage";
let _usage = {};
try { _usage = JSON.parse(localStorage.getItem(USAGE_KEY) || "{}") || {}; } catch (_) { _usage = {}; }
export function bumpUsage(id) {
  if (!id) return;
  _usage[id] = (_usage[id] || 0) + 1;
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(_usage)); } catch (_) {}
}

// ---- 模糊比對 ----
// 分數:完全相等 > 前綴 > 縮寫(字首) > 子字串 > 子序列(模糊)
//   短查詢(≤2 字)不做子序列,避免單一字母把整張表都比中。
function _acronym(name) {
  const parts = name.split(/[\s\-_/]+/).filter(Boolean);
  if (parts.length < 2) return "";
  return parts.map(w => w[0]).join("").toLowerCase();
}
function _score(query, name) {
  const q = query.toLowerCase(), n = name.toLowerCase();
  if (!q) return 0;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 850 - (n.length - q.length);
  const ac = _acronym(name);
  if (ac.length >= 2) {
    if (ac === q) return 780;
    if (ac.startsWith(q)) return 700 - (ac.length - q.length);
  }
  const idx = n.indexOf(q);
  if (idx >= 0) return 550 - idx - (n.length - q.length) * 0.1;
  if (q.length <= 2) return -1;                 // 太短 → 不做模糊,避免洪水
  // 子序列(把 query 字元依序在 name 裡找到)
  let i = 0;
  for (let c = 0; c < n.length && i < q.length; c++) if (n[c] === q[i]) i++;
  if (i === q.length) return 200 - n.length * 0.1;
  return -1;
}

// 回傳 [{cmd, score, matchedName}] 由高到低(同分時常用的排前面)
export function resolve(query, limit = 8) {
  const q = (query || "").trim();
  if (!q) return [];
  const out = [];
  for (const cmd of _cmds.values()) {
    if (cmd.hidden) continue;
    let best = -1, bestName = "";
    for (const name of cmd.names) {
      const s = _score(q, name);
      if (s > best) { best = s; bestName = name; }
    }
    if (best > 0) {
      const boost = Math.min(_usage[cmd.id] || 0, 60) * 1.5;   // 常用度加權(上限避免壓過相關性)
      out.push({ cmd, score: best + boost, baseScore: best, matchedName: bestName });
    }
  }
  out.sort((a, b) => b.score - a.score || a.matchedName.length - b.matchedName.length
    || a.cmd.names[0].localeCompare(b.cmd.names[0]));
  return out.slice(0, limit);
}

// 在每個有對應 DOM 元素的指令(按鈕 / 選單項)的 title tooltip 後面,
// 補上「可輸入的指令名」,讓使用者 hover 就學到命令列怎麼打。
const _HINT = "⌨ 指令:";
// 算出某指令要顯示在 tooltip 的「可輸入名稱」清單(最多 6 個,去掉跟按鈕字面重複的)
function _hintNames(cmd, el) {
  const visible = (el.textContent || "").trim();
  const show = [], seen = new Set();
  for (const n of (cmd.names || [])) {
    const t = String(n).trim(); if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    if (t === visible && show.length) continue;
    show.push(t);
    if (show.length >= 6) break;
  }
  return show;
}
function _applyHint(el, cmd) {
  const show = _hintNames(cmd, el);
  if (!show.length) return;
  let base = el.getAttribute("title") || "";
  const i = base.indexOf(_HINT);
  if (i >= 0) base = base.slice(0, i).replace(/\n+$/, "");
  const want = (base ? base + "\n\n" : "") + _HINT + show.join(" / ");
  if (el.getAttribute("title") === want) return;   // 已正確 → 不重設(避免 observer 無限迴圈)
  el.setAttribute("title", want);
}
// 在每個有 DOM 元素的指令 tooltip 補上「可輸入的指令名」;並用 MutationObserver
// 監看 title 變動(i18n 重套 / updateXxxButton 重設 label 都會改 title),自動補回。
export function annotateTitlesWithCommands() {
  for (const cmd of _cmds.values()) {
    const el = cmd.el;
    if (!el) continue;
    _applyHint(el, cmd);
    if (!el._cmdHintObserved) {
      el._cmdHintObserved = true;
      try {
        const mo = new MutationObserver(() => _applyHint(el, cmd));
        mo.observe(el, { attributes: true, attributeFilter: ["title"] });
      } catch (_) {}
    }
  }
}

// 找「完全相符(名稱相等)」的單一命令 — 給直接執行用
export function exactMatch(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return null;
  for (const cmd of _cmds.values()) {
    if (cmd.hidden) continue;
    if (cmd.names.some(n => n.toLowerCase() === q)) return cmd;
  }
  return null;
}
