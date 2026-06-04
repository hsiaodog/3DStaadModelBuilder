// 三視圖自動配對對話框 — 掃描可能的「同一物理節點在 XY / YZ / XZ 三平面各自的對應」候選
//   三面(triple)= 三條 plane 上的 joint 共指同一 3D 點
//   雙面(pair) = 兩條 plane 上的 joint 沿共享軸對應
//
//   • openAutoPairDialog / closeAutoPairDialog / rescanAutoPair
//   • _apCandidates 是模組共享 state(rescanAutoPair 寫,「套用」按鈕 read — handler 仍在 legacy.ts)
//   • wireTriViewPairButtons — autoPairBtn onclick(由 legacy.ts 延後綁,避免 TDZ)
// @ts-nocheck

import { $, state } from "../app/integration";
import { proposeAutoPairings } from "../core/autopair";

export let _apCandidates: any[] = [];
export function getApCandidates() { return _apCandidates; }
export function setApCandidates(v: any[]) { _apCandidates = v; }

function _apFmtMember(m) {
  return `${m.fileName}#${m.pageIdx + 1} J${m.dispJ}<span style="color:#888">(${m.plane})</span>`;
}
function _apFmtCoord(v) { return v == null ? "?" : v.toFixed(0); }

export function openAutoPairDialog() {
  const apUnit = $("apUnit"); if (apUnit) apUnit.textContent = state.unitName || "mm";
  $("apList").innerHTML = '<div style="color:#9aa0a6;padding:8px">點「掃描候選」開始</div>';
  $("apSummary").textContent = "";
  _apCandidates = [];
  $("autoPairDialog").style.display = "flex";
}

export function closeAutoPairDialog() {
  $("autoPairDialog").style.display = "none";
  _apCandidates = [];
}

export function rescanAutoPair() {
  const tol = parseFloat($("apTol").value) || 0;
  const includeBound = $("apIncludeBound").checked;
  _apCandidates = proposeAutoPairings({ tol, includeBound });
  const list = $("apList");
  list.innerHTML = "";
  let triples = 0, pairs = 0;
  for (const c of _apCandidates) { if (c.type === "triple") triples++; else pairs++; }
  $("apSummary").textContent = `找到 ${triples} 組三面 / ${pairs} 組雙面候選 — 公差 ${tol} ${state.unitName || "mm"}`;
  if (_apCandidates.length === 0) {
    list.innerHTML = '<div style="color:#9aa0a6;padding:8px">無候選 — 試著放寬公差,或確認頁面 plane 與 校準是否設好</div>';
    return;
  }
  _apCandidates.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "ap-row " + c.type;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (c.type === "triple"); // 三面預設勾,雙面預設不勾
    cb.dataset.idx = idx;
    const typeLabel = c.type === "triple" ? "三" : "雙";
    let coordTxt;
    if (c.type === "triple") {
      coordTxt = `(${_apFmtCoord(c.world.x)}, ${_apFmtCoord(c.world.y)}, ${_apFmtCoord(c.world.z)}) Δ${c.score.toFixed(1)}`;
    } else {
      coordTxt = `${c.sharedAxis.toUpperCase()}=${_apFmtCoord(c.members[0].world[c.sharedAxis])} Δ${c.score.toFixed(1)}`;
    }
    const sep = c.type === "triple" ? " + " : " ↔ ";
    row.appendChild(cb);
    const typeSpan = document.createElement("span");
    typeSpan.className = "ap-type"; typeSpan.textContent = typeLabel;
    row.appendChild(typeSpan);
    const mem = document.createElement("span");
    mem.className = "ap-members";
    mem.innerHTML = c.members.map(_apFmtMember).join(sep);
    row.appendChild(mem);
    const co = document.createElement("span");
    co.className = "ap-coord"; co.textContent = coordTxt;
    row.appendChild(co);
    list.appendChild(row);
  });
  // 全選 / 全不選工具列
  const tools = document.createElement("div");
  tools.style.cssText = "display:flex;gap:8px;padding:6px 8px;border-top:1px solid #444;font-size:11px";
  const bAll = document.createElement("a");
  bAll.href = "#"; bAll.textContent = "全選"; bAll.style.color = "#4fc3f7";
  bAll.onclick = (e) => { e.preventDefault(); list.querySelectorAll("input[type=checkbox]").forEach(c => c.checked = true); };
  const bNone = document.createElement("a");
  bNone.href = "#"; bNone.textContent = "全不選"; bNone.style.color = "#4fc3f7";
  bNone.onclick = (e) => { e.preventDefault(); list.querySelectorAll("input[type=checkbox]").forEach(c => c.checked = false); };
  const bTri = document.createElement("a");
  bTri.href = "#"; bTri.textContent = "只勾三面"; bTri.style.color = "#4fc3f7";
  bTri.onclick = (e) => {
    e.preventDefault();
    list.querySelectorAll(".ap-row").forEach(r => {
      const cb = r.querySelector("input[type=checkbox]");
      if (cb) cb.checked = r.classList.contains("triple");
    });
  };
  tools.appendChild(bAll); tools.appendChild(bNone); tools.appendChild(bTri);
  list.appendChild(tools);
}

export function wireTriViewPairButtons() {
  const btn = $("autoPairBtn");
  if (btn) btn.onclick = openAutoPairDialog;
}
