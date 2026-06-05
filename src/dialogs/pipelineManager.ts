// @ts-nocheck
// 結構 Pipeline 管理視窗(popup)— 列出結構類型,以 YAML 編輯 / 匯入 / 匯出 / 設為使用中。
//   YAML 直接編輯(含教學註解)→「套用變更」解析後存進 state + localStorage(隨專案存檔)。
import {
  getAllPipelines, getActiveStructureType, setActiveStructureType,
  upsertPipeline, removePipeline,
} from "../core/pipeline/pipelineSettings";
import { pipelineToYaml, pipelineFromYaml } from "../core/pipeline/pipelineYaml";

let _win: any = null;
let _onChange: any = null;

export function openPipelineManager(onChange?: () => void) {
  _onChange = onChange || null;
  if (_win && !_win.closed) { try { _win.focus(); _win._refresh && _win._refresh(); } catch (_) {} return; }
  const W = Math.max(720, Math.floor(((window.screen && window.screen.availWidth) || 1280) * 0.6));
  const H = Math.max(560, Math.floor(((window.screen && window.screen.availHeight) || 800) * 0.75));
  const win = window.open("", "STAAD_PipelineMgr_" + Date.now(), `popup=yes,width=${W},height=${H},scrollbars=no,resizable=yes`);
  if (!win) { alert("彈出視窗被擋住,請允許彈窗"); return; }
  _win = win;
  win.document.write(`<!DOCTYPE html><html lang="zh-Hant"><head><title>結構 Pipeline 管理</title><meta charset="utf-8"><style>
    *{box-sizing:border-box} html,body{height:100%}
    body{margin:0;padding:10px;background:#0a0b0d;color:#ddd;font-family:-apple-system,system-ui,"Microsoft JhengHei",sans-serif;font-size:12px;display:flex;flex-direction:column;gap:8px}
    h3{margin:0;font-size:13px;color:#9bb6e8}
    .bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
    button{background:#2a2c30;color:#ddd;border:1px solid #444;border-radius:3px;padding:4px 10px;cursor:pointer;font:inherit}
    button:hover{background:#33363a}
    button.primary{background:#4f9dff;border-color:#4f9dff;color:#fff;font-weight:700}
    .main{display:flex;gap:8px;flex:1;min-height:0}
    .left{width:210px;flex-shrink:0;border:1px solid #2a2d33;border-radius:4px;overflow:auto;background:#16181c}
    .row{padding:6px 8px;cursor:pointer;border-bottom:1px solid #1f2126;display:flex;align-items:center;gap:6px}
    .row:hover{background:rgba(255,255,255,.05)}
    .row.sel{background:#2f4a78;color:#fff}
    .row .star{color:#ffd23f;font-size:11px;width:10px}
    .right{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}
    textarea{flex:1;width:100%;background:#0f1014;color:#cfe7e2;border:1px solid #2a2d33;border-radius:4px;
      font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px;line-height:1.45;padding:8px;resize:none;white-space:pre;overflow:auto}
    .msg{font-size:11px;color:#9aa0a6;min-height:16px;flex:1}
    .active-tag{margin-left:auto;color:#ffd23f;font-weight:700}
  </style></head><body></body></html>`);
  win.document.close();
  const doc = win.document;
  doc.body.innerHTML = `
    <h3>結構 Pipeline 管理 — 選定後「3D 一鍵處理」會依此 pipeline 規劃步驟</h3>
    <div class="bar">
      <button id="pmNew">新增類型(複製目前)</button>
      <button id="pmImport">匯入 .yaml</button>
      <input id="pmFile" type="file" accept=".yaml,.yml,text/yaml,application/x-yaml,text/plain" style="display:none">
      <button id="pmExport">匯出 .yaml</button>
      <button id="pmSetActive" class="primary">設為使用中</button>
      <button id="pmDelete">刪除</button>
      <span class="active-tag" id="pmActive"></span>
    </div>
    <div class="main">
      <div class="left" id="pmList"></div>
      <div class="right">
        <textarea id="pmYaml" spellcheck="false"></textarea>
        <div class="bar">
          <button id="pmApply" class="primary">套用變更(解析 YAML 並儲存)</button>
          <span class="msg" id="pmMsg"></span>
        </div>
      </div>
    </div>`;
  const $ = (id: string) => doc.getElementById(id);
  let selectedKey = getActiveStructureType();
  const setMsg = (m: string, err?: boolean) => { const e = $("pmMsg"); if (e) { e.textContent = m || ""; e.style.color = err ? "#ff7676" : "#9aa0a6"; } };

  const _loadYaml = () => {
    const p = getAllPipelines().find(x => x.structureType === selectedKey);
    try { ($("pmYaml") as any).value = p ? pipelineToYaml(p) : ""; } catch (_) { ($("pmYaml") as any).value = ""; }
  };
  const _refresh = () => {
    const all = getAllPipelines();
    const active = getActiveStructureType();
    if (!all.some(p => p.structureType === selectedKey)) selectedKey = active;
    const at = $("pmActive"); if (at) at.textContent = `使用中:${(all.find(p => p.structureType === active) || {}).label || active}`;
    const list = $("pmList"); list.innerHTML = "";
    for (const p of all) {
      const row = doc.createElement("div");
      row.className = "row" + (p.structureType === selectedKey ? " sel" : "");
      row.innerHTML = `<span class="star">${p.structureType === active ? "★" : ""}</span><span>${p.label || p.structureType}</span>`;
      row.title = p.structureType;
      row.addEventListener("click", () => { selectedKey = p.structureType; _refresh(); });
      list.appendChild(row);
    }
    _loadYaml();
  };

  $("pmApply").addEventListener("click", () => {
    try {
      const p = pipelineFromYaml(($("pmYaml") as any).value);
      upsertPipeline(p);
      selectedKey = p.structureType;
      setMsg(`已套用並儲存「${p.label}」(${p.structureType})。`);
      _refresh(); _onChange && _onChange();
    } catch (e: any) { setMsg(e && e.message ? e.message : String(e), true); }
  });
  $("pmExport").addEventListener("click", () => {
    const yamlText = ($("pmYaml") as any).value;
    const name = (selectedKey || "pipeline") + ".yaml";
    const blob = new Blob([yamlText], { type: "text/yaml" });
    const url = URL.createObjectURL(blob); const a = doc.createElement("a");
    a.href = url; a.download = name; doc.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    setMsg(`已匯出 ${name}`);
  });
  $("pmImport").addEventListener("click", () => { ($("pmFile") as any).value = ""; ($("pmFile") as any).click(); });
  $("pmFile").addEventListener("change", () => {
    const f = ($("pmFile") as any).files && ($("pmFile") as any).files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { ($("pmYaml") as any).value = String(reader.result || ""); setMsg(`已載入 ${f.name} — 檢視後按「套用變更」儲存`); };
    reader.readAsText(f, "utf-8");
  });
  $("pmSetActive").addEventListener("click", () => {
    setActiveStructureType(selectedKey); setMsg(`已設為使用中:${selectedKey}`); _refresh(); _onChange && _onChange();
  });
  $("pmDelete").addEventListener("click", () => {
    if (selectedKey === "warehouse") { setMsg("內建『自動倉儲』不可刪除(可編輯覆寫)。", true); return; }
    if (!win.confirm(`刪除結構類型「${selectedKey}」?`)) return;
    removePipeline(selectedKey); selectedKey = getActiveStructureType(); setMsg("已刪除。"); _refresh(); _onChange && _onChange();
  });
  $("pmNew").addEventListener("click", () => {
    const key = (win.prompt("新結構類型代號(英數,如 factory / chimney):", "") || "").trim();
    if (!key) return;
    const base = getAllPipelines().find(x => x.structureType === selectedKey) || getAllPipelines()[0];
    const clone = JSON.parse(JSON.stringify(base)); clone.structureType = key; clone.label = key;
    try { ($("pmYaml") as any).value = pipelineToYaml(clone); selectedKey = key; setMsg(`已建立範本「${key}」— 編輯後按「套用變更」儲存`); } catch (e: any) { setMsg(e.message, true); }
  });

  win._refresh = _refresh;
  _refresh();
  win.addEventListener("beforeunload", () => { _win = null; });
}
