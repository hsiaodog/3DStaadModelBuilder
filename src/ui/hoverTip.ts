// Hover 資訊 tooltip — 滑鼠移到 joint / member 時跳出的非黏滯小視窗
//   showHoverTip / moveHoverTip / hideHoverTip:管理單一 DOM(#hoverTip)的顯示位置
//   fmtJointInfo / fmtMemberInfo:把 joint / member 的物件轉成 HTML 字串給 tip 顯示
//   tipRow / escHtml:內部 helper(只給本檔內用)
//
//   依賴 legacy.ts 的 state / projection / displayId helpers
//   (legacy.ts 同名 export 改成 re-export 自此檔,保持外部 importer 不用動)
// @ts-nocheck

import {
  state, getPage, getActiveFile,
  displayJointId, displayMemberId, jointById,
  fmtWorld3D, fmtCoord,
  _inPlaneCoordsForJoint,
  findGlobalJointById,
} from "../app/integration";
import { listGlobalBindings } from "../core/globalJoints";
import { supportTypeOf } from "../core/support";
import { releaseTypeOf, releaseLabel } from "../core/memberRelease";
import { _t } from "../i18n";

function ensureHoverTip() {
  let t = document.getElementById("hoverTip");
  if (!t) {
    t = document.createElement("div");
    t.id = "hoverTip";
    document.body.appendChild(t);
  }
  return t;
}

function positionHoverTip(t, mx, my) {
  const off = 14;
  const r = t.getBoundingClientRect();
  let x = mx + off, y = my + off;
  if (x + r.width  > window.innerWidth)  x = mx - r.width  - off;
  if (y + r.height > window.innerHeight) y = my - r.height - off;
  t.style.left = Math.max(0, x) + "px";
  t.style.top  = Math.max(0, y) + "px";
}

export function showHoverTip(html, ev) {
  const t = ensureHoverTip();
  t.innerHTML = html;
  t.style.display = "block";
  positionHoverTip(t, ev.clientX, ev.clientY);
}

export function moveHoverTip(ev) {
  const t = document.getElementById("hoverTip");
  if (!t || t.style.display === "none") return;
  positionHoverTip(t, ev.clientX, ev.clientY);
}

export function hideHoverTip() {
  const t = document.getElementById("hoverTip");
  if (t) t.style.display = "none";
}

function escHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function tipRow(key, val) {
  return `<span class="ttip-row"><span class="ttip-key">${escHtml(key)}:</span> <span class="ttip-val">${escHtml(val)}</span></span>`;
}

export function fmtJointInfo(j) {
  const af = getActiveFile();
  const o  = af && af.planeOrigin;
  const id = displayJointId(j);
  // i18n helper:沒翻譯回 fallback
  const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
  const _supType = supportTypeOf(j);
  const _supLabel: Record<string, string> = {
    FIXED: "FIXED(6 自由度全鎖)", PINNED: "PINNED(只鎖位移)",
    FIXED_BUT: "FIXED BUT(部分釋放)", SPRING: "SPRING(彈簧)", ENFORCED: "ENFORCED(強制位移)",
  };
  const supTag = _supType
    ? ` <span style="color:#ff8c00;font-weight:700">▼ ${T("hover.support","支承")}</span>` +
      ` <span style="color:#5ab9ff;font-weight:700">[${_supType}]</span>`
    : "";
  const lines = [`<span class="ttip-title">${T("hover.joint.title","節點")} J${id}${supTag}</span>`];
  if (_supType) {
    lines.push(tipRow(T("hover.support","支承"), _supLabel[_supType] || _supType));
    lines.push(tipRow("", "支承點在 rank 編號時自動視為座標軸錨點,不會被推到後段"));
  }
  if (state.scale && o) {
    const p0 = getPage();
    const proj = (typeof _inPlaneCoordsForJoint === "function") ? _inPlaneCoordsForJoint(af, p0, j) : null;
    if (proj) {
      // 軸名跟著本頁 plane(已套 flipX/Y);精準度走 measureDecimals
      lines.push(tipRow(T("hover.coord","真實座標") + ` (${proj.axisA.toLowerCase()}, ${proj.axisB.toLowerCase()})`,
        `(${fmtWorld3D(proj.valA)}, ${fmtWorld3D(proj.valB)}) ${state.unitName}`));
    } else {
      const rx = (j.x - o.x) / state.scale;
      const ry = (o.y - j.y) / state.scale;
      lines.push(tipRow(T("hover.coord","真實座標"), `(${fmtWorld3D(rx)}, ${fmtWorld3D(ry)}) ${state.unitName}`));
    }
  } else if (state.scale) {
    lines.push(tipRow(T("hover.coord","座標"), `(${fmtWorld3D(j.x/state.scale)}, ${fmtWorld3D(-j.y/state.scale)}) ${state.unitName}`));
    lines.push(tipRow(T("hover.tip","提示"), T("hover.noOrigin","尚未設定平面原點")));
  } else {
    lines.push(tipRow("px", `(${j.x.toFixed(0)}, ${j.y.toFixed(0)}) px`));
    lines.push(tipRow(T("hover.tip","提示"), T("hover.notCalibrated","尚未校準(無比例尺/原點)")));
  }
  const p = getPage();
  const conn = p.members.filter(m => m.j1 === j.id || m.j2 === j.id);
  const connTxt = conn.length
    ? conn.map(m => "M" + displayMemberId(m)).join(", ")
    : "—";
  lines.push(tipRow(T("hover.connectedMembers","連接桿件"), `${conn.length} ${T("dyn.members","條")} ${connTxt}`));
  // 全局節點關聯
  if (j.globalId != null) {
    const g = findGlobalJointById(j.globalId);
    if (g) {
      const binds = listGlobalBindings(g.id);
      const others = binds.filter(b => !(b.fileId === (af && af.id) && b.pageIdx === state.pageIdx));
      const otherTxt = others.length
        ? others.map(b => `${b.fileName}#${b.pageIdx + 1}`).join(", ")
        : "(僅本頁)";
      lines.push(tipRow("全局節點", g.label));
      lines.push(tipRow("跨視圖", `${binds.length} 處 · ${otherTxt}`));
      const u = state.unitName || "?";
      if (g.x != null || g.y != null || g.z != null) {
        lines.push(tipRow("3D 座標 (x, y, z)", `(${fmtWorld3D(g.x)}, ${fmtWorld3D(g.y)}, ${fmtWorld3D(g.z)}) ${u}`));
      } else {
        lines.push(tipRow("3D 座標", "未推得(需設定 page.plane + 校準)"));
      }
      if (g.warnings && g.warnings.length > 0) {
        lines.push(tipRow("⚠ 一致性", `${g.warnings.length} 條警告(見側欄 tooltip)`));
      }
    }
  }
  return lines.join("\n");
}

export function fmtMemberInfo(m) {
  const a = jointById(m.j1), b = jointById(m.j2);
  const af = getActiveFile();
  const o  = af && af.planeOrigin;
  const id = displayMemberId(m);
  const ja = displayJointId({ id: m.j1 });
  const jb = displayJointId({ id: m.j2 });
  const T = (k, fb) => (typeof _t === "function" && _t(k)) || fb;
  const lines = [`<span class="ttip-title">${T("hover.member.title","桿件")} M${id}　(J${ja} – J${jb})</span>`];
  if (!a || !b) { lines.push(tipRow(T("hover.state","狀態"), T("hover.endpointMissing","端點不存在"))); return lines.join("\n"); }
  const dpx = Math.hypot(a.x - b.x, a.y - b.y);
  if (state.scale) {
    const len   = dpx / state.scale;
    const dx    = (b.x - a.x) / state.scale;
    const dy    = (a.y - b.y) / state.scale;   // 翻轉 y:工程慣例向上為正
    const angle = Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI;
    lines.push(tipRow(T("hover.length","長度"), `${fmtCoord(len)} ${state.unitName}`));
    lines.push(tipRow(T("hover.delta","Δx, Δy"), `(${fmtCoord(dx)}, ${fmtCoord(dy)}) ${state.unitName}`));
    lines.push(tipRow(T("hover.angle","夾角"), `${angle.toFixed(2)}°`));
    if (o) {
      const p0 = getPage();
      const projA = (typeof _inPlaneCoordsForJoint === "function") ? _inPlaneCoordsForJoint(af, p0, a) : null;
      const projB = (typeof _inPlaneCoordsForJoint === "function") ? _inPlaneCoordsForJoint(af, p0, b) : null;
      if (projA && projB) {
        // 端點座標也走 in-plane 投影(套 flipX/Y)+ 精準度
        lines.push(tipRow(`J${ja} (${projA.axisA.toLowerCase()}, ${projA.axisB.toLowerCase()})`,
          `(${fmtWorld3D(projA.valA)}, ${fmtWorld3D(projA.valB)}) ${state.unitName}`));
        lines.push(tipRow(`J${jb} (${projB.axisA.toLowerCase()}, ${projB.axisB.toLowerCase()})`,
          `(${fmtWorld3D(projB.valA)}, ${fmtWorld3D(projB.valB)}) ${state.unitName}`));
      } else {
        const ax = (a.x - o.x) / state.scale, ay = (o.y - a.y) / state.scale;
        const bx = (b.x - o.x) / state.scale, by = (o.y - b.y) / state.scale;
        lines.push(tipRow(`J${ja}`, `(${fmtWorld3D(ax)}, ${fmtWorld3D(ay)}) ${state.unitName}`));
        lines.push(tipRow(`J${jb}`, `(${fmtWorld3D(bx)}, ${fmtWorld3D(by)}) ${state.unitName}`));
      }
    } else {
      lines.push(tipRow(T("hover.tip","提示"), T("hover.noOrigin","尚未設定平面原點")));
    }
  } else {
    lines.push(tipRow(T("hover.length","長度"), `${dpx.toFixed(0)} px`));
    lines.push(tipRow(T("hover.tip","提示"), T("hover.notCalibrated","尚未校準(無比例尺/原點)")));
  }
  // 材料(若桿件已設定;global 屬性,任何頁面都同步)
  if (m && m.material) lines.push(tipRow(T("hover.material","材料"), String(m.material)));
  // 桿件釋放 / 行為類型(RELEASE / TRUSS / TENSION / COMPRESSION / CABLE)
  const _rt = releaseTypeOf(m);
  if (_rt) {
    lines.push(tipRow(T("hover.release","桿件釋放"),
      _rt === "RELEASE" ? releaseLabel(m.release) : _rt));
  }
  return lines.join("\n");
}
