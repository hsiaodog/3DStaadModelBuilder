// AutoCAD 風命令列視窗(底部整條 + 可展開/滾動歷史,LoL 聊天式)
//
//   • 按 / 或 : 叫出並聚焦輸入框(打字中 / 對話框內不觸發)
//   • 輸入時即時模糊比對 → 自動完成下拉(↑↓ 選、Tab 補、Enter 執行)
//   • 沒開下拉時 ↑↓ = 回溯歷史指令(localStorage 持久化)
//   • 歷史區可滾動、閒置自動淡出收合、可釘住常開、可清空(clear)
//   • Esc:先關下拉,再關視窗 / 取消
// @ts-nocheck

import { resolve, exactMatch, initButtonCommands, registerCommand, getCommands, getCommandById, bumpUsage, annotateTitlesWithCommands } from "./registry";
import { state, render, startMoveMode, moveModeTarget, commitMove, evalNumExpr } from "../app/integration";

const HIST_KEY = "staad.cmdHistory";
const HIST_MAX = 200;
const FADE_MS = 5000;   // 5 秒沒輸入 → 歷史自動消失

let _root, _hist, _histWrap, _input, _suggest, _pinBtn, _promptLbl;
let _promptSeq = null;    // 參數提問序列:{ cmd, specs, values, idx }
let _suppressClickLog = false;   // 指令觸發的 el.click() 期間,別重複記成手動操作
let _open = false;
let _pinned = false;
let _fadeTimer = null;
let _cmdHistory = [];     // 使用者輸入過的字串(回溯用)
let _histIdx = -1;        // 回溯游標
let _sugItems = [];       // 目前下拉候選
let _sugSel = -1;         // 下拉高亮 index
let _draft = "";          // 回溯時暫存目前草稿

// ---------- 樣式 ----------
function _injectStyle() {
  if (document.getElementById("cmdConsoleStyle")) return;
  const s = document.createElement("style");
  s.id = "cmdConsoleStyle";
  s.textContent = `
  /* 不要 overflow:hidden — 會把往上彈的自動完成下拉切掉;z-index 要高過左右工具面板(1500) */
  #cmdConsole{position:fixed;left:12px;right:12px;bottom:0;z-index:1700;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;
    color:#d8d8d8;pointer-events:none;}
  /* 歷史高度由 JS 依互動狀態設 inline max-height(1 / 3 / 15 筆);預設收起 */
  #cmdConsole .cc-histwrap{max-height:0;overflow-y:auto;background:rgba(18,20,24,.86);backdrop-filter:blur(3px);
    border-radius:8px 8px 0 0;opacity:1;transition:opacity .3s ease, max-height .2s ease;pointer-events:auto;}
  #cmdConsole .cc-histwrap.cc-hidden{opacity:0;}
  #cmdConsole .cc-hist{padding:6px 10px;}
  #cmdConsole .cc-line{white-space:pre-wrap;word-break:break-word;}
  #cmdConsole .cc-echo{color:#7fd1ff;}
  #cmdConsole .cc-ok{color:#9ccc65;}
  #cmdConsole .cc-err{color:#ff7070;}
  #cmdConsole .cc-info{color:#bbb;}
  #cmdConsole .cc-manual{color:#e0b86a;}
  #cmdConsole .cc-row{display:flex;align-items:center;gap:6px;background:rgba(10,11,14,.95);border-top:1px solid #3a3a3a;
    padding:4px 8px;pointer-events:auto;}
  #cmdConsole .cc-prompt{color:#ffb74d;flex:none;user-select:none;}
  #cmdConsole .cc-input{flex:1;background:transparent;border:0;outline:0;color:#fff;font:inherit;}
  #cmdConsole .cc-pin{flex:none;cursor:pointer;color:#888;background:transparent;border:1px solid #444;border-radius:3px;
    padding:0 7px;font:15px/1.4 sans-serif;}
  #cmdConsole .cc-pin.on{color:#ffb74d;border-color:#ffb74d;}
  #cmdConsole .cc-suggest{position:absolute;left:8px;bottom:34px;min-width:280px;max-width:60vw;max-height:40vh;overflow-y:auto;
    background:rgba(20,22,28,.98);border:1px solid #444;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.5);
    pointer-events:auto;display:none;z-index:5;}
  #cmdConsole .cc-sg{display:flex;justify-content:space-between;gap:14px;padding:4px 10px;cursor:pointer;}
  #cmdConsole .cc-sg .nm{color:#fff;}
  #cmdConsole .cc-sg .gp{color:#888;font-size:11px;}
  #cmdConsole .cc-sg.sel,#cmdConsole .cc-sg:hover{background:#2b5278;}
  `;
  document.head.appendChild(s);
}

// ---------- DOM ----------
function _ensureDom() {
  if (_root) return;
  _injectStyle();
  _root = document.createElement("div");
  _root.id = "cmdConsole";
  _root.className = "";
  _root.innerHTML = `
    <div class="cc-histwrap cc-hidden"><div class="cc-hist"></div></div>
    <div class="cc-suggest"></div>
    <div class="cc-row">
      <span class="cc-prompt">Command:</span>
      <input class="cc-input" type="text" autocomplete="off" spellcheck="false"
        placeholder="輸入指令(中/英/短碼皆可)— 按 / 或 : 開啟,↑↓ 回溯,Tab 自動完成" />
      <button class="cc-pin" title="釘住歷史:顯示 15 筆常開 / 再按回 1 筆">≡</button>
    </div>`;
  document.body.appendChild(_root);
  _histWrap = _root.querySelector(".cc-histwrap");
  _hist = _root.querySelector(".cc-hist");
  _suggest = _root.querySelector(".cc-suggest");
  _input = _root.querySelector(".cc-input");
  _pinBtn = _root.querySelector(".cc-pin");
  _promptLbl = _root.querySelector(".cc-prompt");

  _input.addEventListener("input", _onInput);
  _input.addEventListener("keydown", _onInputKey);
  // 點輸入框 → 顯示最後 3 筆(清掉「點過歷史」的展開狀態)
  _input.addEventListener("focus", () => { _root.classList.add("focus"); _root.classList.remove("hist-zoom"); _refreshHist(); });
  _input.addEventListener("blur", () => { _root.classList.remove("focus"); _refreshHist(); });
  // 點歷史紀錄區 → 展開 15 筆並可滾動
  _histWrap.addEventListener("click", () => { _root.classList.add("hist-zoom"); _refreshHist(); });
  // 釘住:15 筆常開 ↔ 回 1 筆
  _pinBtn.addEventListener("click", () => {
    _pinned = !_pinned;
    _pinBtn.classList.toggle("on", _pinned);
    _pinBtn.textContent = _pinned ? "⊟" : "≡";   // 釘住 → 收合圖示;未釘 → 展開清單圖示
    _root.classList.remove("hist-zoom");
    _refreshHist();
  });
  _suggest.addEventListener("mousedown", (e) => {
    const row = e.target.closest(".cc-sg");
    if (!row) return;
    e.preventDefault();
    const i = +row.dataset.i;
    if (_sugItems[i]) { _input.value = _sugItems[i].matchedName; _runCurrent(); }
  });

  _loadHistory();
  _wireLayout();
  _layout();
}

// ---------- 對齊中央畫布:左右不蓋到 sidebar ----------
const _GAP = 12;
function _sidebarVisible(el) {
  return el && !el.classList.contains("collapsed") && el.getBoundingClientRect().width > 0
      && el.getBoundingClientRect().right > 0 && el.getBoundingClientRect().left < window.innerWidth;
}
function _layout() {
  if (!_root) return;
  const L = document.getElementById("sbLeft");
  const R = document.getElementById("sbRight");
  let left = _GAP, right = _GAP;
  if (_sidebarVisible(L)) left = Math.max(_GAP, L.getBoundingClientRect().right + _GAP);
  if (_sidebarVisible(R)) right = Math.max(_GAP, window.innerWidth - R.getBoundingClientRect().left + _GAP);
  _root.style.left = left + "px";
  _root.style.right = right + "px";
}
function _wireLayout() {
  window.addEventListener("resize", _layout);
  const L = document.getElementById("sbLeft");
  const R = document.getElementById("sbRight");
  // sidebar 寬度被 resizer 拖動 → ResizeObserver;收合/展開切 class → MutationObserver;動畫收尾 → transitionend
  try {
    const ro = new ResizeObserver(() => _layout());
    if (L) ro.observe(L);
    if (R) ro.observe(R);
  } catch (_) {}
  try {
    const mo = new MutationObserver(() => _layout());
    if (L) mo.observe(L, { attributes: true, attributeFilter: ["class", "style"] });
    if (R) mo.observe(R, { attributes: true, attributeFilter: ["class", "style"] });
  } catch (_) {}
  if (L) L.addEventListener("transitionend", _layout);
  if (R) R.addEventListener("transitionend", _layout);
}

// ---------- 開關 ----------
export function openConsole() {
  _ensureDom();
  _open = true;
  _layout();
  _input.focus();      // focus handler → 顯示最後 3 筆
  _input.select();
}
export function closeConsole() {
  if (!_root) return;
  _open = false;
  _hideSuggest();
  _input.blur();
  _histHide();
}
export function toggleConsole() { _open ? closeConsole() : openConsole(); }

// ---------- 歷史顯示(1 / 3 / 15 筆,依互動狀態)----------
// 預設只露最後 1 筆;點輸入框 → 3 筆;點歷史區 → 15 筆可滾動;釘住 → 15 筆常開。
function _histVisibleLevel() {
  if (_pinned) return 15;
  if (_root.classList.contains("hist-zoom")) return 15;
  if (_root.classList.contains("focus")) return 3;
  return 1;
}
function _refreshHist() {
  if (!_hist || !_histWrap) return;
  const n = _histVisibleLevel();
  const lastN = [..._hist.children].slice(-n);
  let h = 0; for (const k of lastN) h += k.offsetHeight || 0;
  const cap = Math.round(window.innerHeight * 0.4);
  _histWrap.classList.remove("cc-hidden");
  _histWrap.style.maxHeight = Math.min(h + 10, cap) + "px";
  _histWrap.scrollTop = _histWrap.scrollHeight;
  _scheduleHide();
}
function _histHide() {
  if (!_histWrap) return;
  _histWrap.classList.add("cc-hidden");
  _histWrap.style.maxHeight = "0px";
  _root.classList.remove("hist-zoom");
}
function _scheduleHide() {
  if (_fadeTimer) clearTimeout(_fadeTimer);
  if (_pinned) return;                 // 釘住 → 不自動消失
  _fadeTimer = setTimeout(_histHide, FADE_MS);
}

// ---------- 歷史輸出 ----------
function _print(text, kind = "info") {
  _ensureDom();
  const d = document.createElement("div");
  d.className = "cc-line cc-" + kind;
  d.textContent = text;
  _hist.appendChild(d);
  _refreshHist();
}
// 手動操作記一筆(🖱 前綴、暖色)
function _logManual(text) {
  _ensureDom();
  const d = document.createElement("div");
  d.className = "cc-line cc-manual";
  d.textContent = "🖱 " + text;
  _hist.appendChild(d);
  _refreshHist();
}

// ---------- 參數解析(Phase C) ----------
// 把一段原始字串解析成某型別的值;回傳 {ok, value} 或 {ok:false}
function _parseArg(spec, raw) {
  const s = (raw == null ? "" : String(raw)).trim();
  if (!s) return { ok: false };
  if (spec.type === "vector") {
    const parts = s.split(/[, ]+/).filter(Boolean);
    if (parts.length < 2) return { ok: false };
    const x = evalNumExpr(parts[0]), y = evalNumExpr(parts[1]);
    if (Number.isNaN(x) || Number.isNaN(y)) return { ok: false };
    return { ok: true, value: [x, y] };
  }
  if (spec.type === "number") {
    const v = evalNumExpr(s);
    return Number.isNaN(v) ? { ok: false } : { ok: true, value: v };
  }
  return { ok: true, value: s };   // string
}
function _argHint(spec) {
  const p = spec.prompt?.zh || spec.name;
  return spec.unit ? `${p}(${spec.unit})` : p;
}

// 把輸入解析成 { cmd, args[] }:支援「整串名稱」與「首字當指令、其餘當參數(move 10,0)」
function _resolveInput(q) {
  const tokens = q.split(/\s+/).filter(Boolean);
  let c = exactMatch(q);                                  // a) 整串完全相符(含空白的中文名)
  if (c) return { cmd: c, args: [] };
  if (tokens.length) {
    c = exactMatch(tokens[0]);                            // b) 首 token 完全相符 + 其餘當參數
    if (c) return { cmd: c, args: tokens.slice(1) };
  }
  const r = resolve(q, 1);                                // c) 整串模糊
  if (r[0] && r[0].baseScore >= 200) return { cmd: r[0].cmd, args: [] };
  if (tokens.length > 1) {                                // d) 首 token 模糊 + 其餘當參數
    const r2 = resolve(tokens[0], 1);
    if (r2[0] && r2[0].baseScore >= 500) return { cmd: r2[0].cmd, args: tokens.slice(1) };
  }
  return null;
}

// ---------- 執行 ----------
function _runCommandString(text) {
  const q = (text || "").trim();
  if (!q) return;
  if (_promptSeq) { _feedPrompt(q); return; }    // 提問進行中 → 這行是參數值
  _pushHistory(q);
  _print("> " + q, "echo");
  const res = _resolveInput(q);
  if (!res) {
    const near = resolve(q, 5).map(c => c.matchedName);
    _print(`找不到指令「${q}」` + (near.length ? `;你是不是要找:${near.join(" / ")}` : "(輸入 help 看清單)"), "err");
    return;
  }
  const { cmd, args } = res;
  const specs = cmd.args || [];
  if (!specs.length) { _invoke(cmd, []); return; }
  // 有參數規格:先吃行內參數,缺的再逐一提問
  const values = [];
  for (let i = 0; i < specs.length; i++) {
    if (args[i] != null) {
      const p = _parseArg(specs[i], args[i]);
      if (!p.ok) { _print(`✗ 參數「${_argHint(specs[i])}」格式不正確:${args[i]}`, "err"); return; }
      values.push(p.value);
    } else break;
  }
  if (values.length === specs.length) { _invoke(cmd, values); return; }
  if (values.length === 0 && cmd.argsOptional) { _invoke(cmd, []); return; }   // 可省參數 → 走互動模式
  _beginPrompt(cmd, specs, values);
}

function _invoke(cmd, values) {
  const el = cmd.el || null;
  // 執行前快照按鈕狀態(.active 開關 + 文字),用來判斷指令是「打開/關閉、作用/取消」
  const b0 = el ? { a: el.classList.contains("active"), t: (el.textContent || "").trim() } : null;
  try {
    _suppressClickLog = true;     // 接下來 run() 內若有 el.click(),不要被當成手動操作記一筆
    let r;
    try { r = cmd.run ? cmd.run(values) : null; }
    finally { _suppressClickLog = false; }
    if (r && r.ok === false) { _print(`✗ ${cmd.label?.zh || cmd.names[0]}:${r.msg || "無法執行"}`, "err"); return; }
    bumpUsage(cmd.id);
    const name = cmd.label?.zh || cmd.names[0];
    let line;
    if (r && r.msg) {
      line = `✓ ${name} — ${r.msg}`;
    } else if (el && b0) {
      const a1 = el.classList.contains("active");
      const t1 = (el.textContent || "").trim();
      if (t1 && t1 !== b0.t)      line = `✓ ${t1}`;                              // 文字本身表達了狀態(顯示↔隱藏…)
      else if (a1 !== b0.a)       line = `✓ ${name}:${a1 ? "作用中" : "已取消"}`;  // 只有 .active 變 → 開/關
      else                        line = `✓ ${name}`;
    } else {
      line = `✓ ${name}`;
    }
    _print(line, "ok");
  } catch (e) {
    _print(`✗ 執行「${cmd.names[0]}」時發生錯誤:${e && e.message ? e.message : e}`, "err");
    console.error("[command]", cmd.id, e);
  }
}

// ---------- 參數提問序列 ----------
function _beginPrompt(cmd, specs, values) {
  _promptSeq = { cmd, specs, values, idx: values.length };
  _hideSuggest();
  _askCurrentArg();
}
function _askCurrentArg() {
  const sp = _promptSeq.specs[_promptSeq.idx];
  _print(`需要參數:${_argHint(sp)}(Esc 取消)`, "info");
  if (_promptLbl) _promptLbl.textContent = `${_argHint(sp)} ▸`;
  _input.placeholder = sp.type === "vector" ? "例如 10,0" : "輸入數值(可用算式)";
}
function _feedPrompt(raw) {
  const sp = _promptSeq.specs[_promptSeq.idx];
  const p = _parseArg(sp, raw);
  if (!p.ok) { _print(`✗ 格式不正確,請再輸入一次:${_argHint(sp)}`, "err"); return; }
  _promptSeq.values.push(p.value);
  _promptSeq.idx++;
  if (_promptSeq.idx < _promptSeq.specs.length) { _askCurrentArg(); return; }
  const { cmd, values } = _promptSeq;
  _endPrompt();
  _invoke(cmd, values);
}
function _endPrompt() {
  _promptSeq = null;
  if (_promptLbl) _promptLbl.textContent = "Command:";
  _input.placeholder = "輸入指令(中/英/短碼皆可)— 按 / 或 : 開啟,↑↓ 回溯,Tab 自動完成";
}
function _runCurrent() {
  if (_promptSeq) {                          // 提問中:這行是參數值
    _runCommandString(_input.value);
    _input.value = ""; _histIdx = -1;
    return;
  }
  // 下拉有高亮 → 用高亮那條;否則用輸入框文字
  if (_sugSel >= 0 && _sugItems[_sugSel]) {
    _runCommandString(_sugItems[_sugSel].matchedName);
  } else {
    _runCommandString(_input.value);
  }
  _input.value = "";
  _hideSuggest();
  _histIdx = -1;
}

// ---------- 自動完成 ----------
function _onInput() {
  _scheduleHide();   // 有在打字 → 重置「5 秒沒輸入」計時
  if (_promptSeq) { _hideSuggest(); return; }   // 提問中不顯示指令候選
  const q = _input.value.trim();
  if (!q) { _hideSuggest(); return; }
  _sugItems = resolve(q, 8);
  _renderSuggest();
}
function _renderSuggest() {
  if (!_sugItems.length) { _hideSuggest(); return; }
  _sugSel = -1;
  _suggest.innerHTML = _sugItems.map((it, i) =>
    `<div class="cc-sg" data-i="${i}"><span class="nm">${_esc(it.matchedName)}</span><span class="gp">${_esc(it.cmd.group || "")}</span></div>`
  ).join("");
  _suggest.style.display = "block";
}
function _hideSuggest() { _sugItems = []; _sugSel = -1; if (_suggest) _suggest.style.display = "none"; }
function _moveSug(delta) {
  if (!_sugItems.length) return false;
  _sugSel = (_sugSel + delta + _sugItems.length) % _sugItems.length;
  [..._suggest.children].forEach((c, i) => c.classList.toggle("sel", i === _sugSel));
  const sel = _suggest.children[_sugSel];
  if (sel) sel.scrollIntoView({ block: "nearest" });
  return true;
}

// ---------- 鍵盤 ----------
function _onInputKey(e) {
  const sugOpen = _suggest.style.display === "block" && _sugItems.length;
  if (e.key === "Enter") {
    e.preventDefault(); _runCurrent(); return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    if (_promptSeq) { _print("已取消參數輸入", "info"); _endPrompt(); _input.value = ""; return; }
    if (sugOpen) { _hideSuggest(); } else { closeConsole(); }
    return;
  }
  if (_promptSeq) return;   // 提問中:Tab/方向鍵不做指令導覽,保留游標預設行為
  if (e.key === "Tab") {
    e.preventDefault();
    if (sugOpen) {
      if (_sugSel < 0) _moveSug(1);
      if (_sugItems[_sugSel]) { _input.value = _sugItems[_sugSel].matchedName; _onInput(); }
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (sugOpen) _moveSug(1); else _recall(1);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (sugOpen) _moveSug(-1); else _recall(-1);
    return;
  }
}

// ---------- 指令回溯(↑↓ 在沒開下拉時) ----------
function _recall(dir) {
  if (!_cmdHistory.length) return;
  if (_histIdx === -1) { _draft = _input.value; _histIdx = _cmdHistory.length; }
  _histIdx += dir;
  if (_histIdx < 0) _histIdx = 0;
  if (_histIdx >= _cmdHistory.length) { _histIdx = -1; _input.value = _draft; return; }
  _input.value = _cmdHistory[_histIdx];
  _hideSuggest();
  // 游標移到尾端
  requestAnimationFrame(() => { _input.selectionStart = _input.selectionEnd = _input.value.length; });
}
function _pushHistory(q) {
  if (_cmdHistory[_cmdHistory.length - 1] !== q) _cmdHistory.push(q);
  if (_cmdHistory.length > HIST_MAX) _cmdHistory = _cmdHistory.slice(-HIST_MAX);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(_cmdHistory)); } catch (_) {}
}
function _loadHistory() {
  try { const a = JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); if (Array.isArray(a)) _cmdHistory = a.slice(-HIST_MAX); } catch (_) {}
}

function _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- 內建命令 ----------
function _registerBuiltins() {
  registerCommand({
    id: "cmd:help", names: ["help", "?", "說明", "指令清單"], label: { zh: "說明", en: "Help" }, group: "命令列",
    run: () => {
      const all = getCommands();
      const byGroup = {};
      for (const c of all) (byGroup[c.group || "其他"] ||= []).push(c.names[0]);
      _print(`共 ${all.length} 條指令。直接打中文/英文/短碼即可;Tab 自動完成,↑↓ 回溯。`, "info");
      for (const g of Object.keys(byGroup)) _print(`【${g}】 ${byGroup[g].slice(0, 30).join("、")}${byGroup[g].length > 30 ? " …" : ""}`, "info");
      return { ok: true };
    },
  });
  registerCommand({
    id: "cmd:clear", names: ["clear", "cls", "清空"], label: { zh: "清空歷史", en: "Clear" }, group: "命令列",
    run: () => { if (_hist) _hist.innerHTML = ""; return { ok: true }; },
  });

  // ── 參數型指令(Phase C)──
  // move dx,dy:把選取節點平移 (dx,dy)(沿用直角座標移動的單位/方向);無參數 → 進互動自由移動
  registerCommand({
    id: "cmd:move", names: ["move", "M", "移動到", "位移"], label: { zh: "移動選取", en: "Move" }, group: "參數指令",
    argsOptional: true,
    args: [{ name: "delta", type: "vector", prompt: { zh: "位移 dx,dy(右+ 上+)", en: "dx,dy" }, unit: "mm" }],
    run: (a) => {
      if (!a || !a.length) { startMoveMode("free"); return state.moveMode?.active ? { ok: true, msg: "互動移動:點基準點" } : { ok: false, msg: "請先選取節點" }; }
      const [dx, dy] = a[0];
      startMoveMode("rect");
      if (!state.moveMode || !state.moveMode.active) return { ok: false, msg: "請先選取節點" };
      state.moveMode.base = { x: 0, y: 0 };
      state.moveMode.dx = dx; state.moveMode.dy = dy;
      const t = moveModeTarget({ x: 0, y: 0 });
      if (t) commitMove(t.x, t.y);
      return { ok: true, msg: `移動 (${dx}, ${dy})` };
    },
  });
  // grid <step>:設定鎖點網格間距
  registerCommand({
    id: "cmd:grid", names: ["grid", "gridstep", "網格間距", "格距"], label: { zh: "網格間距", en: "Grid step" }, group: "參數指令",
    args: [{ name: "step", type: "number", prompt: { zh: "網格間距", en: "step" }, unit: "mm" }],
    run: (a) => {
      const v = a[0];
      if (!(v > 0)) return { ok: false, msg: "間距需為正數" };
      if (!state.snapGrid) state.snapGrid = { mode: 0, step: 1 };
      state.snapGrid.step = v;
      render();
      return { ok: true, msg: `網格間距 = ${v}` };
    },
  });
}

// ---------- 全域熱鍵:/ 或 : 叫出 ----------
function _isTypingTarget(el) {
  if (!el) return false;
  const t = (el.tagName || "").toLowerCase();
  return t === "input" || t === "textarea" || t === "select" || el.isContentEditable;
}
function _wireHotkey() {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === "/" || e.key === ":") && !_isTypingTarget(document.activeElement)) {
      e.preventDefault();
      e.stopPropagation();
      openConsole();
    }
  }, true);   // capture:比 canvasEvents 的 keydown 早,避免被當快捷鍵

  // 手動點按鈕 / 選單 → 也記進命令列歷史。capture 階段:先拿到「點擊前」狀態,
  //   再用 setTimeout 等該元素自己的 onclick 跑完(更新 .active / 文字)後讀「點擊後」狀態算出開/關。
  document.addEventListener("click", (e) => {
    if (_suppressClickLog) return;                       // 指令觸發的 click → _invoke 已記過
    const t = e.target;
    const el = t && t.closest && t.closest('button[id], #menuBar .menu-entry[data-action]');
    if (!el) return;
    const id = el.matches("button[id]") ? `btn:${el.id}` : `menu:${el.dataset.action}`;
    const cmd = getCommandById(id);
    if (!cmd) return;
    const b0 = { a: el.classList.contains("active"), t: (el.textContent || "").trim() };
    setTimeout(() => {
      const name = cmd.label?.zh || cmd.names[0];
      const a1 = el.classList.contains("active");
      const t1 = (el.textContent || "").trim();
      let detail;
      if (t1 && t1 !== b0.t)  detail = t1;
      else if (a1 !== b0.a)   detail = `${name}:${a1 ? "作用中" : "已取消"}`;
      else                    detail = name;
      _logManual(detail);
    }, 0);
  }, true);
}

// ---------- 初始化 ----------
let _inited = false;
export function initCommandConsole() {
  if (_inited) return;
  _inited = true;
  const boot = () => {
    _ensureDom();
    initButtonCommands();    // 掃所有 button[id] 變成命令(選單 action 由 menubar.ts 先註冊)
    _registerBuiltins();
    annotateTitlesWithCommands();   // 在每個按鈕/選單 hover tooltip 補上「可輸入的指令名」
    (window as any).__afterI18n = annotateTitlesWithCommands;   // 語言切換 / i18n 重套後自動補回
    _wireHotkey();
    // 測試 / 除錯 hook:列舉、解析、執行指令(供 Playwright 全面測試逐條跑)
    (window as any).__cmd = {
      list: () => getCommands().map(c => ({ id: c.id, name: c.names[0], group: c.group, hasArgs: !!(c.args && c.args.length) })),
      resolveId: (q) => { const r = resolve(q, 1); return r[0] ? r[0].cmd.id : null; },
      run: (id) => { const c = getCommandById(id); if (!c) throw new Error("no command " + id); return c.run ? c.run([]) : null; },
    };
    _print("命令列就緒 — 按 / 或 : 開始,輸入 help 看全部指令。", "info");
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}

// 模組載入即初始化(由 integration.ts 在 menubar 之後 import)
initCommandConsole();
