// AutoCAD 風短碼 / 額外同義詞別名表
//
//   key   = 按鈕 id 或選單 data-action
//   value = 額外可觸發的名稱(英文短碼 + 中英同義詞);跟自動抓到的中文標籤等價
//
//   只是「補充」名稱 —— 沒列的功能仍可用自動抓到的中文標籤觸發。
//   短碼盡量比照 AutoCAD,且保持唯一(exactMatch 才不會撞)。
// @ts-nocheck

export const ALIASES: Record<string, string[]> = {
  // ── 工具切換 ──
  "tool-select":     ["S", "select", "選取工具"],
  "tool-bgsel":      ["BG", "selectbg", "底圖選取", "底圖工具"],
  "tool-point":      ["P", "PO", "point", "node", "節點工具", "畫點"],
  "tool-line":       ["L", "line", "畫線", "直線工具"],

  // ── 移動 / 複製 ──
  "selToolsMove":      ["freemove", "自由移動"],   // M / move 留給參數型 cmd:move(無參數時也會進自由移動)
  "selToolsMoveH":     ["MH", "movex", "水平移動"],
  "selToolsMoveV":     ["MV", "movey", "垂直移動"],
  "selToolsMoveDist":  ["MD", "movedist", "距離移動"],
  "selToolsMoveAngle": ["MA", "moveangle", "夾角移動"],
  "selToolsMoveRect":  ["MR", "moverect", "直角座標移動", "座標移動"],
  "selToolsDupJointH": ["DJH", "copyjointx", "節點水平複製"],
  "selToolsDupJointV": ["DJV", "copyjointy", "節點垂直複製"],

  // ── 編輯 / 量測 ──
  "selToolsMeasure":   ["DI", "dist", "measure", "量距", "標示距離"],
  "selToolsIntersectSel": ["IN", "intersect", "切交點", "交點"],
  "selToolsJMerge":    ["J", "join", "merge", "兩點合一", "合併節點"],
  "selToolsExtend":    ["EX", "extend", "桿件延伸", "單端延伸"],
  "selToolsExtendBoth":["EXB", "extendboth", "兩端延伸"],
  "selToolsJExtH":     ["jexth", "端點水平延桿"],
  "selToolsJExtV":     ["jextv", "端點垂直延桿"],
  "selToolsJConnectH": ["connecth", "點點水平連結", "水平連結"],
  "selToolsJConnectV": ["connectv", "點點垂直連結", "垂直連結"],
  "selToolsJConnectD": ["connectd", "點點斜線連結", "斜線連結"],
  "btnDel":            ["E", "erase", "del", "delete", "刪除"],
  "selToolsAll":       ["SA", "selectall", "全選"],

  // ── 選取過濾 ──
  "selToolsJoints":  ["filterjoint", "只選點", "點過濾"],
  "selToolsMembers": ["filtermember", "只選線", "線過濾"],
  "selToolsDirV":    ["filterv", "vertical", "選垂直線"],
  "selToolsDirH":    ["filterh", "horizontal", "選水平線"],
  "selToolsDirO":    ["filtero", "ortho", "正交", "選正交線"],
  "selToolsDirD":    ["filterd", "diagonal", "brace", "選斜線"],

  // ── 支承 / 釋放 ──
  "selToolsSupportSet":    ["support", "設定支承"],
  "selToolsSupportFixed":  ["fix", "fixed", "固接"],
  "selToolsSupportPinned": ["pin", "pinned", "銷接"],
  "selToolsSupportClear":  ["clearsupport", "清除支承"],
  "selToolsReleaseSet":    ["release", "釋放"],
  "selToolsReleasePinned": ["releasepin", "兩端鉸接"],
  "selToolsReleaseTruss":  ["truss", "桁架"],
  "selToolsReleaseClear":  ["clearrelease", "清除釋放"],

  // ── 座標 / 比例 / 底圖姿態 ──
  "btnScaleRuler":    ["SC", "scale", "ruler", "比例尺"],
  "btnPlaneOrigin":   ["O", "origin", "UCS", "座標原點"],
  "btnFixLocalOrigin":["OL", "originlocal", "本檔原點", "修正原點"],
  "btnCalibrate":     ["CAL", "calibrate", "校準"],
  "btnRecomputeWorld":["recompute", "重算座標", "重新計算座標"],
  "btnRotate90":      ["RO", "rotate", "旋轉", "旋轉90"],
  "btnConsolidate":   ["consolidate", "整理", "整併"],
  "btnExtendCheck":   ["extendcheck", "延伸檢查", "可延伸檢查"],
  "btnSplit":         ["splitpage", "拆分頁面", "拆頁"],
  "btnSectionLink":   ["section", "切面", "切面關聯"],
  "btnCrossViewSync": ["crosssync", "跨頁同步", "跨頁建點"],
  "btnPrewarmBgCache":["prewarm", "預掃底圖", "底圖快取"],
  "btnRelayoutCurrent":       ["renumber", "編號", "編排節點編號"],
  "btnRelayoutMembersCurrent":["renumbermember", "編排桿件編號"],

  // ── 顯示 / 可見性 / 標號 ──
  "btnBgToggle":       ["bgtoggle", "togglebg", "底圖顯示", "顯示底圖"],
  "btnJointVis":       ["jointvis", "節點顯示", "顯示節點"],
  "btnMemberVis":      ["membervis", "桿件顯示", "顯示桿件"],
  "btnJointLblToggle": ["jointlabel", "節點標號"],
  "btnMemberLblToggle":["memberlabel", "桿件標號"],
  "snapGridBtn":       ["snap", "鎖點", "網格"],   // grid 留給參數型 cmd:grid
  "btnLblBigger":      ["labelbigger", "字體放大", "標號放大"],
  "btnLblSmaller":     ["labelsmaller", "字體縮小", "標號縮小"],
  "btnLblReset":       ["labelreset", "字體還原"],

  // ── 縮放 ──
  "btnZoomIn":    ["ZI", "zoomin", "放大"],
  "btnZoomOut":   ["ZO", "zoomout", "縮小"],
  "btnZoomSel":   ["ZS", "zoomsel", "放大選取"],
  "btnZoomRange": ["ZW", "zoomwindow", "範圍放大"],
  "btnFit":       ["Z", "ZE", "fit", "zoomextents", "整圖", "回復顯示"],

  // ── 底圖編輯(畫線 / 轉換) ──
  "bgEditDrawLine":     ["DL", "drawline", "畫直線"],
  "bgEditDrawDashed":   ["DD", "drawdashed", "畫虛線"],
  "bgEditCopyLine":     ["CO", "copyline", "複製線"],
  "bgEditBisector":     ["bisector", "中分線"],
  "bgEditEquidist":     ["equidist", "等分線"],
  "bgEditToDashed":     ["todashed", "轉虛線"],
  "bgEditSplit":        ["split", "拆分直線"],
  "bgEditToMember":     ["tomember", "轉桿件", "轉為桿件"],
  "bgEditDel":          ["bgdel", "刪除底圖線"],
  "bgEditSelectAll":    ["bgselectall", "全選底圖"],
  "bgEditClear":        ["bgclear", "取消選取"],
  "bgEditMarkIntersect":["markintersect", "多線轉交點"],
  "bgEditMarkIntersectAndMember": ["markintersectmember", "交點加桿件"],
  "bgEditSquareToJoint":["squarejoint", "正方形轉節點"],
  "bgEditRectToCenterMember": ["rectcenter", "置中桿件"],
  "bgEditMeasure":      ["bgmeasure", "底圖量距"],
  "bgEditOriginDistH":  ["origindisth", "水平原點距離"],
  "bgEditOriginDistV":  ["origindistv", "垂直原點距離"],
  "bgEditOriginDistMin":["origindistmin", "原點最短距離"],

  // ── 右側欄(全局 / 翻轉) ──
  "btnSetGlobalOrigin":  ["globalorigin", "全局節點校準"],
  "btnSetCustomOrigin":  ["customorigin", "自訂原點"],
  "autoPairBtn":         ["autopair", "三視圖配對", "自動配對"],
  "btnSetFileAsOrigin":  ["pageorigin", "本頁為世界原點"],

  // ── 選單 actions ──
  "save-project":     ["save", "儲存專案"],
  "save-project-as":  ["saveas", "另存"],
  "open-project":     ["open", "開啟專案"],
  "open-new-project": ["new", "新專案"],
  "export-std":       ["std", "匯出std"],
  "export-xlsx":      ["xlsx", "excel", "匯出excel"],
  "export-json":      ["json", "匯出標線"],
  "import-json":      ["importjson", "讀入標線"],
  "clear-all":        ["clearall", "清除全部"],
  "run-3d-pipeline":  ["pipeline", "一鍵", "3dpipeline", "一鍵處理"],
  "open-3d-preview":  ["3D", "preview", "3d預覽"],
  "open-search":      ["F", "find", "search", "搜尋"],
  "open-material-mgr":["material", "材料管理"],
  "open-structure-pipeline": ["pipelinemgr", "pipeline管理"],
  "open-floor-types": ["floortype", "樓層類型"],
  "relayout-all":     ["relayoutall", "全部重編號"],
  "consolidate-all-pages": ["consolidateall", "全部整理"],
  "recompute-world-all":   ["recomputeall", "全部重算"],
  "about":            ["about", "關於"],
  "check-updates":    ["update", "檢查更新"],
  "auto-backup":      ["backup", "自動備份"],
};
