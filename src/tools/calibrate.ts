// Phase 8a — 校準功能(把指定座標/全局節點搬到世界原點)
//   calibrateAllFilesToGlobalOrigin:選一個 globalJoint 當原點 (0,0,0),對所有綁定到它
//     的檔案重算 planeOrigin / pageZ。需要每個檔案都有 scaleRuler 比例尺,且有 joint 綁定到該
//     globalJoint。沒綁定 / 沒比例尺的檔案會被列出來跳過。
//   calibrateAllFilesToCustomOrigin:純座標位移,把世界 (px,py,pz) 搬到 (0,0,0)。所有有
//     比例尺的檔案都會被位移;不需要 globalJoint 綁定。會解除原本的「globalJoint 原點」指定。
//
//   兩者皆 pushUndo,結束時 render + refreshLists + 各種按鈕狀態同步。
//   依賴 legacy.ts 的 _resyncSectionLinksForFile / refreshSectionLinkList / updatePlaneOriginButton /
//   updateCalibrateButton / refreshPageCoordSection / _updateGlobalOriginUI(都已 export)。
// @ts-nocheck

import {
  state, pushUndo, render, refreshLists,
  _resyncSectionLinksForFile,
  updatePlaneOriginButton, updateCalibrateButton,
  refreshPageCoordSection, refreshSectionLinkList,
  _updateGlobalOriginUI,
} from "../legacy";
import { inferAllGlobalJoints } from "../core/globalJoints";

export function calibrateAllFilesToGlobalOrigin(opts) {
  opts = opts || {};
  if (!Array.isArray(state.globalJoints) || state.globalJoints.length === 0) {
    alert("請先建立至少一個全局節點(在多個檔案上選同一個物理位置的節點 → 設為全局節點)");
    return false;
  }
  // 用 opts.globalJointId、state.globalOriginId、或第一個 globalJoint 作 fallback
  let G = null;
  if (opts.globalJointId != null) G = state.globalJoints.find(g => g.id === opts.globalJointId);
  if (!G && state.globalOriginId != null) G = state.globalJoints.find(g => g.id === state.globalOriginId);
  if (!G) G = state.globalJoints[0];
  if (!G) { alert("找不到可用的全局節點"); return false; }
  const Gx = 0, Gy = 0, Gz = 0;
  // 找出每個有綁定到 G 的檔案
  const filesWithJ = [], filesNoJ = [], filesNoScale = [];
  for (const f of state.files) {
    let linkedJ = null, pageK = null;
    for (const k of Object.keys(f.pages || {})) {
      const pg = f.pages[k];
      if (!pg || !Array.isArray(pg.joints)) continue;
      for (const j of pg.joints) {
        if (j.globalId === G.id) { linkedJ = j; pageK = k; break; }
      }
      if (linkedJ) break;
    }
    if (!linkedJ) { filesNoJ.push(f.name); continue; }
    if (!f.scaleRuler || !(f.scaleRuler.ratio > 0)) { filesNoScale.push(f.name); continue; }
    filesWithJ.push({ file: f, joint: linkedJ, pageK });
  }
  if (!filesWithJ.length) {
    alert(`無法校準:沒有任何檔案綁定到全局節點「${G.label || ('N' + G.id)}」(右鍵節點 → 綁定到既有 N${G.id})`);
    return false;
  }
  if (!opts.skipConfirm) {
    const lines = [];
    lines.push(`即將指定全局節點「${G.label || ('N' + G.id)}」為世界原點 (0, 0, 0)`);
    lines.push(`下列 ${filesWithJ.length} 個檔案會被校準(planeOrigin 與 pageZ 自動調整):`);
    for (const x of filesWithJ) lines.push(`  • ${x.file.name}`);
    if (filesNoJ.length) {
      lines.push(``);
      lines.push(`下列 ${filesNoJ.length} 個檔案沒有綁定此全局節點(會跳過,維持原本):`);
      for (const n of filesNoJ) lines.push(`  • ${n}`);
    }
    if (filesNoScale.length) {
      lines.push(``);
      lines.push(`下列 ${filesNoScale.length} 個檔案缺比例尺(會跳過):`);
      for (const n of filesNoScale) lines.push(`  • ${n}`);
    }
    lines.push(``);
    lines.push(`建議在校準前儲存專案。要繼續嗎?`);
    if (!confirm(lines.join("\n"))) return false;
  }
  pushUndo();
  for (const { file: f, joint: J, pageK } of filesWithJ) {
    const page = f.pages[pageK];
    const ratio = f.scaleRuler.ratio;
    const plane = page.plane || "XY";
    const jx = J.x, jy = J.y;
    let newOriginX, newOriginY, newPageZ;
    // 反推使 joint2DToWorld3D(F, page, J) === (Gx, Gy, Gz)
    // 水平軸 +X/+Z = 螢幕右 → ox = jx - axisH/r;XZ 縱軸 Z 向下 → oy = jy - Gz/r;
    // XY/YZ 縱軸 +Y = 螢幕上 → oy = jy + Gy/r
    switch (plane) {
      case "XZ":   // u→X(向右), -v→Z(向下), off→Y
        newOriginX = jx - Gx / ratio;
        newOriginY = jy - Gz / ratio;
        newPageZ = Gy;
        break;
      case "YZ":   // u→Z(向右), v→Y(向上), off→X
        newOriginX = jx - Gz / ratio;
        newOriginY = jy + Gy / ratio;
        newPageZ = Gx;
        break;
      case "XY":   // u→X(向右), v→Y(向上), off→Z
      default:
        newOriginX = jx - Gx / ratio;
        newOriginY = jy + Gy / ratio;
        newPageZ = Gz;
        break;
    }
    f.planeOrigin = { x: newOriginX, y: newOriginY };
    page.z = newPageZ;
  }
  // 鎖定 G 為世界原點 (0, 0, 0),記在 state
  G.x = Gx; G.y = Gy; G.z = Gz;
  G.locked = true;
  state.globalOriginId = G.id;
  // 每個被校準的檔案 planeOrigin / pageZ 都動過 → 切面 cutValue 也要同步重算
  let _slUpdatedTotal = 0;
  for (const { file: f } of filesWithJ) {
    const r = (typeof _resyncSectionLinksForFile === "function") ? _resyncSectionLinksForFile(f) : { slUpdated: 0 };
    _slUpdatedTotal += r.slUpdated;
  }
  if (_slUpdatedTotal) console.log(`[全局原點] 切面關聯重算 ${_slUpdatedTotal} 條`);
  // 重新推算其他 globalJoints 的 world 座標(現在已對齊)
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshLists === "function") refreshLists();
  if (typeof updatePlaneOriginButton === "function") updatePlaneOriginButton();
  if (typeof updateCalibrateButton === "function") updateCalibrateButton();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  render();
  if (!opts.skipAlert) {
    alert(`全局原點校準完成:\n• 已校準 ${filesWithJ.length} 個檔案\n• 全局節點「${G.label || ('N' + G.id)}」鎖定為世界 (0, 0, 0)`);
  }
  console.log(`[全局原點] 設定 G#${G.id} 為原點;校準 ${filesWithJ.length} 個檔案`,
    filesWithJ.map(x => x.file.name));
  return true;
}

// 自訂世界原點校準 — 不需要對應到任何 globalJoint,直接把指定的 (px, py, pz) 世界座標移到 (0, 0, 0)。
//   等同所有 joint 的世界座標都減去 (px, py, pz)。
//   每個檔案的 planeOrigin 依該檔第一個有 plane 的 page 推 shift 軸;各頁 page.z 依各自 plane 軸 shift。
export function calibrateAllFilesToCustomOrigin(px, py, pz, opts) {
  opts = opts || {};
  if (![px, py, pz].every(Number.isFinite)) {
    alert("座標必須是有效數字");
    return false;
  }
  const filesWithScale = [], filesNoScale = [];
  for (const f of state.files) {
    if (!f.scaleRuler || !(f.scaleRuler.ratio > 0)) { filesNoScale.push(f.name); continue; }
    filesWithScale.push(f);
  }
  if (!filesWithScale.length) {
    alert("沒有任何檔案有比例尺,無法校準");
    return false;
  }
  if (!opts.skipConfirm) {
    const lines = [
      `將世界座標 (${px}, ${py}, ${pz}) 移到原點 (0, 0, 0)`,
      `(所有 joint 的世界座標都減去 (${px}, ${py}, ${pz}))`,
      ``,
      `下列 ${filesWithScale.length} 個檔案會被校準(planeOrigin / pageZ 自動調整):`,
    ];
    for (const f of filesWithScale) lines.push(`  • ${f.name}`);
    if (filesNoScale.length) {
      lines.push("");
      lines.push(`下列 ${filesNoScale.length} 個檔案缺比例尺(跳過):`);
      for (const n of filesNoScale) lines.push(`  • ${n}`);
    }
    lines.push("");
    lines.push("校準後現有的「全局節點原點」指定會被解除。建議先儲存專案。要繼續嗎?");
    if (!confirm(lines.join("\n"))) return false;
  }
  pushUndo();
  for (const f of filesWithScale) {
    const ratio = f.scaleRuler.ratio;
    let refPage = null;
    for (const pg of Object.values(f.pages || {})) {
      if (pg && !pg._orphan && pg.plane) { refPage = pg; break; }
    }
    if (refPage && f.planeOrigin) {
      const ox = f.planeOrigin.x, oy = f.planeOrigin.y;
      switch (refPage.plane) {
        case "XZ": f.planeOrigin = { x: ox + px / ratio, y: oy - pz / ratio }; break;
        case "YZ": f.planeOrigin = { x: ox + pz / ratio, y: oy - py / ratio }; break;
        case "XY":
        default:   f.planeOrigin = { x: ox + px / ratio, y: oy - py / ratio }; break;
      }
    }
    for (const pg of Object.values(f.pages || {})) {
      if (!pg || pg._orphan) continue;
      if (pg.z == null || !Number.isFinite(pg.z)) continue;
      switch (pg.plane) {
        case "XZ": pg.z -= py; break;
        case "YZ": pg.z -= px; break;
        case "XY":
        default:   pg.z -= pz; break;
      }
    }
  }
  // 解除原本的 globalJoint 原點指定(因為現在原點是自訂座標,不對應任何 joint)
  if (state.globalOriginId != null) {
    const G = (state.globalJoints || []).find(g => g.id === state.globalOriginId);
    if (G) G.locked = false;
    state.globalOriginId = null;
  }
  let _slUpdatedTotal = 0;
  for (const f of filesWithScale) {
    const r = (typeof _resyncSectionLinksForFile === "function") ? _resyncSectionLinksForFile(f) : { slUpdated: 0 };
    _slUpdatedTotal += r.slUpdated;
  }
  if (_slUpdatedTotal) console.log(`[自訂原點] 切面關聯重算 ${_slUpdatedTotal} 條`);
  if (typeof inferAllGlobalJoints === "function") inferAllGlobalJoints();
  if (typeof refreshLists === "function") refreshLists();
  if (typeof updatePlaneOriginButton === "function") updatePlaneOriginButton();
  if (typeof updateCalibrateButton === "function") updateCalibrateButton();
  if (typeof refreshPageCoordSection === "function") refreshPageCoordSection();
  if (typeof refreshSectionLinkList === "function") refreshSectionLinkList();
  if (typeof _updateGlobalOriginUI === "function") _updateGlobalOriginUI();
  render();
  if (!opts.skipAlert) {
    alert(`自訂世界原點校準完成:\n• 已校準 ${filesWithScale.length} 個檔案\n• 原本世界 (${px}, ${py}, ${pz}) 現在落在 (0, 0, 0)`);
  }
  console.log(`[自訂原點] 套用 shift (${px}, ${py}, ${pz});校準 ${filesWithScale.length} 個檔案`,
    filesWithScale.map(f => f.name));
  return true;
}
