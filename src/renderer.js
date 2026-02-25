// src/renderer.js
function $(id) {
  return document.getElementById(id);
}

function logLocal(msg, isError = false) {
  const el = $("log");
  const t = new Date().toLocaleTimeString();
  el.innerHTML =
    `<div class="${isError ? "err" : ""}">[${t}] ${msg}</div>` + el.innerHTML;
}

function fmtRes(d) {
  if (d?.resolution?.width)
    return `${d.resolution.width}x${d.resolution.height}`;
  return "?";
}

// ===== Loop parse (0 = infinite) =====
function parseLoopInput(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return 1;

  if (s === "∞" || /^inf(inite)?$/i.test(s)) return 0;

  const n = Number(s);
  if (!Number.isFinite(n)) return 1;

  if (n <= 0) return 0;
  return Math.max(1, Math.floor(n));
}

function fmtLoopCount(loopCount) {
  if (loopCount === 0) return "∞";
  return String(loopCount ?? "?");
}

// ===== TEXT template preview (for Add TEXT button to actually type into focused input) =====
function _uiTextVars() {
  // Optional: reuse Instagram panel input if present
  const igSong = $("igSongText") ? String($("igSongText").value || "") : "";
  const macroText = $("macroText") ? String($("macroText").value || "") : "";
  return {
    IG_SONG: igSong,
    MACRO_TEXT: macroText,
  };
}

function resolveTextTemplateUi(raw, vars = {}) {
  let out = String(raw ?? "");

  // RAND_LINE first
  out = out.replace(/\{\{\s*RAND_LINE\s*:\s*([A-Z0-9_]+)\s*\}\}/gi, (_, k) => {
    const key = String(k || "");
    const v = vars[key] ?? vars[key.toUpperCase()] ?? vars[key.toLowerCase()];
    const lines = String(v ?? "")
      .split(/\r?\n/)
      .map((x) => String(x).trim())
      .filter(Boolean);
    if (!lines.length) return "";
    return lines[Math.floor(Math.random() * lines.length)];
  });

  // RAND inline list
  out = out.replace(/\{\{\s*RAND\s*:\s*([^}]+)\}\}/g, (_, body) => {
    const parts = String(body || "")
      .split("|")
      .map((x) => String(x).trim())
      .filter(Boolean);
    if (!parts.length) return "";
    return parts[Math.floor(Math.random() * parts.length)];
  });

  // Simple {{VAR}}
  out = out.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_, k) => {
    const key = String(k || "");
    const v = vars[key] ?? vars[key.toUpperCase()] ?? vars[key.toLowerCase()];
    return v == null ? "" : String(v);
  });

  return out;
}

// ===== selection =====
let selectedDeviceId = "";
const devicesById = new Map();

// ===== Layout state (from main) =====
let layoutState = {
  scalePct: 50,
  cols: 4,
  rows: 0,
  margin: 8,
  forceResizeOnApply: true,
  deviceOrder: [],
  groups: [],
  broadcastDefaults: { baseDelayMs: 90, jitterMs: 160, xyJitterPct: 0.004 },
  groupMacroDefaults: { baseDelayMs: 120, jitterMs: 280 },
  deviceAliases: {},

  // ✅ Core 5
  autoStartEnabled: false,
  autoWakeOnRecover: true,
};

// Drag reorder local working list
let uiOrder = [];

// ===== Macro state =====
let recordedSteps = [];
const macroRuntimeByDevice = new Map();
const macroPrevRunningByDevice = new Map();

// ===== Groups =====
let groups = [];
let selectedGroupId = "";

// Alias edit guard / draft
let aliasDraftByDevice = new Map();
let aliasDirtyDeviceId = "";
let lastSelectedDeviceIdForAlias = "";

function setMacroUiEnabled(enabled) {
  $("macroPlayBtn").disabled = !enabled;
  $("macroRecStartBtn").disabled = !enabled;
  $("macroSaveBtn").disabled = !enabled;
  $("macroStopBtn").disabled = false;
}

function renderMacroStatus(deviceId) {
  const st = macroRuntimeByDevice.get(deviceId);
  const el = $("macroStatus");
  if (!el) return;

  if (!deviceId) {
    el.textContent = "Macro: (no device)";
    setMacroUiEnabled(true);
    return;
  }

  if (!st || !st.running) {
    el.textContent = "Macro: IDLE";
    setMacroUiEnabled(true);
    return;
  }

  const idx = st.stepIndex ?? 0;
  const cnt = st.stepCount ?? "?";
  const type = st.stepType || "";

  const li = st.loopIndex ?? 0;
  const lc = st.loopCount; // 0 => infinite
  const loopPart = lc != null ? ` • loop ${li || 1}/${fmtLoopCount(lc)}` : "";

  el.textContent = `Macro: RUNNING${loopPart} • step ${idx}/${cnt}${
    type ? ` • ${type}` : ""
  }`;
  setMacroUiEnabled(false);
}

async function pullLayoutFromMain() {
  try {
    const cfg = await window.forgeAPI.getLayout();
    if (!cfg) return;

    layoutState = { ...layoutState, ...cfg };

    $("scaleSel").value = String(layoutState.scalePct ?? 50);
    $("gridCols").value = String(layoutState.cols ?? 4);
    $("gridRows").value = String(layoutState.rows ?? 0);
    $("gridMargin").value = String(layoutState.margin ?? 8);
    $("forceResizeChk").checked = !!layoutState.forceResizeOnApply;

    // ✅ Core 5: autoStart flag from main
    $("autoStartChk").checked = !!layoutState.autoStartEnabled;

    const bd = layoutState.broadcastDefaults || {};
    if (bd.baseDelayMs != null) $("gbBaseDelay").value = String(bd.baseDelayMs);
    if (bd.jitterMs != null) $("gbJitter").value = String(bd.jitterMs);
    if (bd.xyJitterPct != null) $("gbXyJitter").value = String(bd.xyJitterPct);

    const gd = layoutState.groupMacroDefaults || {};
    if (gd.baseDelayMs != null) $("gmBaseDelay").value = String(gd.baseDelayMs);
    if (gd.jitterMs != null) $("gmJitter").value = String(gd.jitterMs);

    if (Array.isArray(layoutState.deviceOrder))
      uiOrder = [...layoutState.deviceOrder];
    if (Array.isArray(layoutState.groups)) groups = [...layoutState.groups];

    if (
      layoutState.deviceAliases &&
      typeof layoutState.deviceAliases === "object"
    ) {
      layoutState.deviceAliases = { ...layoutState.deviceAliases };
    }
  } catch {}
}

function readLayoutFromUI() {
  const scalePct = Number($("scaleSel").value || 50);
  const cols = Number($("gridCols").value || 4);
  const rows = Number($("gridRows").value || 0);
  const margin = Number($("gridMargin").value || 8);
  const forceResizeOnApply = !!$("forceResizeChk").checked;
  const autoStartEnabled = !!$("autoStartChk").checked;
  return { scalePct, cols, rows, margin, forceResizeOnApply, autoStartEnabled };
}

async function pushLayoutToMain(extra = {}) {
  const patch = { ...readLayoutFromUI(), ...extra };
  try {
    const cfg = await window.forgeAPI.setLayout(patch);
    if (cfg) layoutState = { ...layoutState, ...cfg };
  } catch {}
}

function ensureInUiOrder(devices) {
  const existing = new Set(uiOrder);
  for (const d of devices)
    if (!existing.has(d.deviceId)) uiOrder.push(d.deviceId);
  const alive = new Set(devices.map((d) => d.deviceId));
  uiOrder = uiOrder.filter((id) => alive.has(id));
}

function sortDevicesForRender(devices) {
  const idx = new Map();
  uiOrder.forEach((id, i) => idx.set(id, i));
  return [...devices].sort((a, b) => {
    const ia = idx.has(a.deviceId) ? idx.get(a.deviceId) : 1e9;
    const ib = idx.has(b.deviceId) ? idx.get(b.deviceId) : 1e9;
    if (ia !== ib) return ia - ib;
    return String(a.deviceId).localeCompare(String(b.deviceId));
  });
}

let dragSrcId = "";

function getDisplayName(d) {
  const alias = String(d?.alias || "").trim();
  if (alias) return alias;
  return d?.model || d?.deviceId || "Unknown";
}

function renderDevices(devices) {
  const wrap = $("devices");
  wrap.innerHTML = "";

  if (!devices.length) {
    wrap.innerHTML = `<div class="muted">(Không thấy thiết bị — kiểm tra adb devices -l)</div>`;
    return;
  }

  const list = sortDevicesForRender(devices);

  for (const d of list) {
    const div = document.createElement("div");
    div.className =
      "deviceItem" + (d.deviceId === selectedDeviceId ? " selected" : "");
    div.dataset.deviceId = d.deviceId;
    div.draggable = true;

    const badgeClass = d.agentReady ? "badge ok" : "badge bad";
    const badgeText = d.agentReady ? "READY" : "AGENT OFF";

    const title = getDisplayName(d);
    const sub = d.model && d.alias ? `Model: ${d.model}` : "";

    const onlineMs = Number(d.totalOnlineMs || 0);
    const onlineMin = Math.floor(onlineMs / 60000);

    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
        <div style="min-width:0;">
          <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${title}
          </div>
          ${sub ? `<div class="kv muted">${sub}</div>` : ""}
          <div class="kv muted mono" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${d.deviceId}
          </div>
          <div class="kv muted">
            Android ${d.androidVersion || "?"} • ${fmtRes(d)} • ${d.state}
          </div>
          <div class="kv muted small">
            Online total: ~${onlineMin}m • ADB errors: ${d.adbErrorCount || 0}
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
          <span class="${badgeClass}">${badgeText}</span>
        </div>
      </div>
    `;

    div.addEventListener("click", () => {
      selectedDeviceId = d.deviceId;
      refreshUI();
      renderMacroStatus(selectedDeviceId);
    });

    // drag & drop reorder
    div.addEventListener("dragstart", (e) => {
      dragSrcId = d.deviceId;
      div.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", d.deviceId);
      } catch {}
    });

    div.addEventListener("dragend", () => {
      div.classList.remove("dragging");
      dragSrcId = "";
      for (const el of wrap.querySelectorAll(".deviceItem.dropHint")) {
        el.classList.remove("dropHint");
      }
    });

    div.addEventListener("dragover", (e) => {
      e.preventDefault();
      div.classList.add("dropHint");
      e.dataTransfer.dropEffect = "move";
    });

    div.addEventListener("dragleave", () => {
      div.classList.remove("dropHint");
    });

    div.addEventListener("drop", async (e) => {
      e.preventDefault();
      div.classList.remove("dropHint");

      const targetId = d.deviceId;
      const srcId =
        dragSrcId ||
        (() => {
          try {
            return e.dataTransfer.getData("text/plain");
          } catch {
            return "";
          }
        })();

      if (!srcId || srcId === targetId) return;

      const from = uiOrder.indexOf(srcId);
      const to = uiOrder.indexOf(targetId);
      if (from < 0 || to < 0) return;

      uiOrder.splice(from, 1);
      uiOrder.splice(to, 0, srcId);

      await pushLayoutToMain({ deviceOrder: uiOrder });
      refreshUI();
    });

    wrap.appendChild(div);
  }
}

function renderGroupDevicesPanel() {
  const panel = $("groupDevicesPanel");
  const gid = String(selectedGroupId || $("groupSel").value || "").trim();
  if (!gid) {
    panel.textContent = "(chọn group để xem danh sách thiết bị)";
    return;
  }

  const g = groups.find((x) => x.id === gid);
  if (!g) {
    panel.textContent = "(group không tồn tại)";
    return;
  }

  const ids = Array.isArray(g.devices) ? g.devices : [];
  if (!ids.length) {
    panel.textContent = "(group rỗng)";
    return;
  }

  const rows = [];
  for (const did of ids) {
    const d = devicesById.get(did);
    const alias = d?.alias || layoutState.deviceAliases?.[did] || "";
    const title = alias ? alias : d?.model || did;

    const state = d?.state || "OFFLINE";
    const badge =
      state === "ONLINE"
        ? `<span class="badge ok">ONLINE</span>`
        : `<span class="badge bad">${state}</span>`;
    const model = d?.model ? ` • ${d.model}` : "";

    rows.push(`
      <div class="gRow">
        <div style="min-width:0;">
          <div class="gTitle" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</div>
          <div class="muted small mono" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${did}</div>
          <div class="muted small">Android ${d?.androidVersion || "?"}${model}</div>
        </div>
        <div>${badge}</div>
      </div>
    `);
  }

  panel.innerHTML = rows.join("");
}

async function updateSelectedInfo() {
  const aliasInput = $("aliasInput");

  if (!selectedDeviceId) {
    $("selectedInfo").textContent = "(chọn thiết bị bên trái)";
    $("runningBadge").textContent = "RUNNING: ?";
    if (aliasInput) aliasInput.value = "";
    renderMacroStatus("");
    lastSelectedDeviceIdForAlias = "";
    return;
  }

  const d = devicesById.get(selectedDeviceId);
  if (!d) return;

  const title = getDisplayName(d);

  $("selectedInfo").innerHTML = `
    <div><b>${title}</b></div>
    <div class="muted mono">${selectedDeviceId}</div>
    <div class="muted">State: ${d.state} • Android ${d.androidVersion || "?"} • Res: ${fmtRes(d)} • AgentReady: ${d.agentReady ? "YES" : "NO"}</div>
    ${d.model ? `<div class="muted small">Model: ${d.model}</div>` : ""}
    <div class="muted small">ADB errors: ${d.adbErrorCount || 0} ${d.lastAdbErrorMsg ? `• last: ${d.lastAdbErrorMsg}` : ""}</div>
  `;

  const deviceChanged = lastSelectedDeviceIdForAlias !== selectedDeviceId;
  lastSelectedDeviceIdForAlias = selectedDeviceId;

  if (aliasInput) {
    const isFocused = document.activeElement === aliasInput;
    const isDirtyThisDevice = aliasDirtyDeviceId === selectedDeviceId;

    const stableAlias = String(d.alias || "").trim();

    if (deviceChanged) {
      aliasDirtyDeviceId = "";
      const draft = aliasDraftByDevice.get(selectedDeviceId);
      aliasInput.value = draft != null ? draft : stableAlias;
    } else {
      if (isFocused || isDirtyThisDevice) {
        // user đang gõ -> KHÔNG overwrite
      } else {
        aliasInput.value = stableAlias;
      }
    }
  }

  try {
    const running = await window.forgeAPI.scrcpyIsRunning(selectedDeviceId);
    const badge = $("runningBadge");
    badge.textContent = `RUNNING: ${running ? "YES" : "NO"}`;
    badge.className = "badge " + (running ? "ok" : "bad");
  } catch {}

  renderMacroStatus(selectedDeviceId);
}

// ===== Hybrid parse =====
function parseHybrid(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("Empty coordinate");

  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1).trim());
    if (!Number.isFinite(n)) throw new Error(`Invalid percent: ${s}`);
    return { value: n, unit: "pct" };
  }

  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${s}`);

  if (n >= 0 && n <= 1) return { value: n, unit: "pct" };
  return { value: n, unit: "px" };
}

function mustSelected() {
  if (!selectedDeviceId) throw new Error("Chưa chọn thiết bị");
  const d = devicesById.get(selectedDeviceId);
  if (!d) throw new Error("Thiết bị không tồn tại");
  if (d.state !== "ONLINE")
    throw new Error(`Thiết bị không ONLINE (${d.state})`);
  return selectedDeviceId;
}

function mustGroupSelected() {
  const gid = String(selectedGroupId || $("groupSel").value || "").trim();
  if (!gid) throw new Error("Chưa chọn group");
  return gid;
}

function readFanoutOpts() {
  const baseDelayMs = Number($("gbBaseDelay").value || 90);
  const jitterMs = Number($("gbJitter").value || 160);
  const xyJitterPct = Number($("gbXyJitter").value || 0);
  return { baseDelayMs, jitterMs, xyJitterPct };
}

function readGroupMacroDefaults() {
  const baseDelayMs = Number($("gmBaseDelay").value || 120);
  const jitterMs = Number($("gmJitter").value || 280);
  return { baseDelayMs, jitterMs };
}

async function act(name, fn) {
  try {
    await fn();
    logLocal(name);
    refreshUI();
  } catch (e) {
    logLocal(`${name} failed: ${e.message}`, true);
  }
}

// auto-save broadcast settings (persist)
async function persistBroadcastDefaults() {
  await pushLayoutToMain({ broadcastDefaults: readFanoutOpts() });
}
async function persistGroupMacroDefaults() {
  await pushLayoutToMain({ groupMacroDefaults: readGroupMacroDefaults() });
}

// ===== Groups UI =====
async function reloadGroups() {
  try {
    groups = await window.forgeAPI.groupList();
  } catch {
    groups = [];
  }

  const sel = $("groupSel");
  sel.innerHTML = "";
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = `${g.name} (${g.id}) • ${g.devices?.length || 0} devices`;
    sel.appendChild(opt);
  }

  if (!selectedGroupId && groups.length) selectedGroupId = groups[0].id;
  if (selectedGroupId) sel.value = selectedGroupId;

  sel.onchange = () => {
    selectedGroupId = sel.value;
    renderGroupDevicesPanel();
  };

  renderGroupDevicesPanel();
}

$("groupReloadBtn").addEventListener("click", () =>
  act("group reload", reloadGroups)
);

$("groupCreateBtn").addEventListener("click", () =>
  act("group create", async () => {
    const id = String($("groupId").value || "").trim();
    const name = String($("groupName").value || "").trim();
    if (!id) throw new Error("group id required");
    await window.forgeAPI.groupCreate(id, name || id);
    selectedGroupId = id;
    await reloadGroups();
  })
);

$("groupRenameBtn").addEventListener("click", () =>
  act("group rename", async () => {
    const gid = mustGroupSelected();
    const name = String($("groupName").value || "").trim();
    if (!name) throw new Error("group name required");
    await window.forgeAPI.groupRename(gid, name);
    await reloadGroups();
  })
);

$("groupRemoveBtn").addEventListener("click", () =>
  act("group remove", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupRemove(gid);
    selectedGroupId = "";
    await reloadGroups();
  })
);

$("groupAddSelectedBtn").addEventListener("click", () =>
  act("group add selected", async () => {
    const gid = mustGroupSelected();
    const did = mustSelected();
    await window.forgeAPI.groupAddDevice(gid, did);
    await reloadGroups();
  })
);

$("groupRemoveSelectedBtn").addEventListener("click", () =>
  act("group remove selected", async () => {
    const gid = mustGroupSelected();
    const did = mustSelected();
    await window.forgeAPI.groupRemoveDevice(gid, did);
    await reloadGroups();
  })
);

// broadcast input changes => persist
["gbBaseDelay", "gbJitter", "gbXyJitter"].forEach((id) => {
  $(id).addEventListener("change", () => persistBroadcastDefaults());
  $(id).addEventListener("input", () => persistBroadcastDefaults());
});

// group macro defaults persist
["gmBaseDelay", "gmJitter"].forEach((id) => {
  $(id).addEventListener("change", () => persistGroupMacroDefaults());
  $(id).addEventListener("input", () => persistGroupMacroDefaults());
});

// ✅ Core 5: AutoStart checkbox => persist to main
$("autoStartChk").addEventListener("change", () =>
  pushLayoutToMain({ autoStartEnabled: !!$("autoStartChk").checked })
);

// Alias hooks
(function initAliasHooks() {
  const inp = $("aliasInput");
  if (!inp) return;

  inp.addEventListener("focus", () => {
    if (selectedDeviceId) aliasDirtyDeviceId = selectedDeviceId;
  });

  inp.addEventListener("input", () => {
    if (!selectedDeviceId) return;
    aliasDirtyDeviceId = selectedDeviceId;
    aliasDraftByDevice.set(selectedDeviceId, String(inp.value || ""));
  });
})();

// Alias save/clear
$("aliasSaveBtn").addEventListener("click", () =>
  act("save alias", async () => {
    const did = selectedDeviceId;
    if (!did) throw new Error("Chưa chọn thiết bị");
    const alias = String($("aliasInput").value || "").trim();
    const r = await window.forgeAPI.deviceAliasSet(did, alias);

    if (alias) layoutState.deviceAliases[did] = alias;
    else delete layoutState.deviceAliases[did];

    aliasDirtyDeviceId = "";
    aliasDraftByDevice.delete(did);

    logLocal(`Alias saved: ${did} = "${r.alias || ""}"`);
    renderGroupDevicesPanel();
  })
);

$("aliasClearBtn").addEventListener("click", () =>
  act("clear alias", async () => {
    const did = selectedDeviceId;
    if (!did) throw new Error("Chưa chọn thiết bị");
    await window.forgeAPI.deviceAliasSet(did, "");
    delete layoutState.deviceAliases[did];
    $("aliasInput").value = "";

    aliasDirtyDeviceId = "";
    aliasDraftByDevice.delete(did);

    logLocal(`Alias cleared: ${did}`);
    renderGroupDevicesPanel();
  })
);

// Group Broadcast buttons
$("gbHomeBtn").addEventListener("click", () =>
  act("broadcast HOME", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupKey(gid, "HOME", readFanoutOpts());
  })
);

$("gbBackBtn").addEventListener("click", () =>
  act("broadcast BACK", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupKey(gid, "BACK", readFanoutOpts());
  })
);

$("gbRecentsBtn").addEventListener("click", () =>
  act("broadcast RECENTS", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupKey(gid, "RECENTS", readFanoutOpts());
  })
);

$("gbWakeBtn").addEventListener("click", () =>
  act("broadcast WAKE", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupWake(gid, readFanoutOpts());
  })
);

$("gbScreenOffBtn").addEventListener("click", () =>
  act("broadcast SCREEN OFF", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupScreenOff(gid, readFanoutOpts());
  })
);

$("gbShutdownBtn").addEventListener("click", () =>
  act("broadcast SHUTDOWN", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupShutdown(gid, readFanoutOpts());
  })
);

$("gbSwipeUpBtn").addEventListener("click", () =>
  act("broadcast swipe up", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "up", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

$("gbSwipeDownBtn").addEventListener("click", () =>
  act("broadcast swipe down", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "down", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

$("gbSwipeLeftBtn").addEventListener("click", () =>
  act("broadcast swipe left", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "left", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

$("gbSwipeRightBtn").addEventListener("click", () =>
  act("broadcast swipe right", async () => {
    const gid = mustGroupSelected();
    await window.forgeAPI.groupSwipeDir(gid, "right", {
      ...readFanoutOpts(),
      durationMs: 220,
    });
  })
);

// Layout controls
["scaleSel", "gridCols", "gridRows", "gridMargin", "forceResizeChk"].forEach(
  (id) => {
    $(id).addEventListener("change", () =>
      pushLayoutToMain({ deviceOrder: uiOrder })
    );
    $(id).addEventListener("input", () =>
      pushLayoutToMain({ deviceOrder: uiOrder })
    );
  }
);

$("applyLayoutBtn").addEventListener("click", () =>
  act("apply layout", async () => {
    await pushLayoutToMain({ deviceOrder: uiOrder });
    const forceResize = !!$("forceResizeChk").checked;
    const r = await window.forgeAPI.scrcpyApplyLayout({ forceResize });
    logLocal(
      `Apply layout: ${r?.count ?? "?"} windows (forceResize=${
        r?.forceResize ?? forceResize
      })`
    );
  })
);

$("startAllBtn").addEventListener("click", async () => {
  try {
    await pushLayoutToMain({ deviceOrder: uiOrder });
    const ids = await window.forgeAPI.scrcpyStartAll();
    logLocal(`StartAll: ${ids.length} devices`);
  } catch (e) {
    logLocal(e.message, true);
  }
});

$("stopAllBtn").addEventListener("click", async () => {
  try {
    await window.forgeAPI.scrcpyStopAll();
    logLocal("StopAll done");
  } catch (e) {
    logLocal(e.message, true);
  }
});

$("startBtn").addEventListener("click", () =>
  act("scrcpy start", async () => {
    await pushLayoutToMain({ deviceOrder: uiOrder });
    const id = mustSelected();
    await window.forgeAPI.scrcpyStart(id);
  })
);

$("stopBtn").addEventListener("click", () =>
  act("scrcpy stop", async () => {
    const id = mustSelected();
    await window.forgeAPI.scrcpyStop(id);
  })
);

// Single device quick controls
$("wakeBtn").addEventListener("click", () =>
  act("wake", async () => {
    const id = mustSelected();
    await window.forgeAPI.wake(id);
  })
);

$("screenOffBtn").addEventListener("click", () =>
  act("screen off", async () => {
    const id = mustSelected();
    await window.forgeAPI.screenOff(id);
  })
);

$("shutdownBtn").addEventListener("click", () =>
  act("shutdown", async () => {
    const id = mustSelected();
    await window.forgeAPI.shutdown(id);
  })
);

$("homeBtn").addEventListener("click", () =>
  act("home", async () => {
    const id = mustSelected();
    await window.forgeAPI.home(id);
  })
);

$("backBtn").addEventListener("click", () =>
  act("back", async () => {
    const id = mustSelected();
    await window.forgeAPI.back(id);
  })
);

$("recentsBtn").addEventListener("click", () =>
  act("recents", async () => {
    const id = mustSelected();
    await window.forgeAPI.recents(id);
  })
);

$("swipeUpBtn").addEventListener("click", () =>
  act("swipe up", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "up");
  })
);

$("swipeDownBtn").addEventListener("click", () =>
  act("swipe down", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "down");
  })
);

$("swipeLeftBtn").addEventListener("click", () =>
  act("swipe left", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "left");
  })
);

$("swipeRightBtn").addEventListener("click", () =>
  act("swipe right", async () => {
    const id = mustSelected();
    await window.forgeAPI.swipeDir(id, "right");
  })
);

$("tapBtn").addEventListener("click", () =>
  act("tap", async () => {
    const id = mustSelected();
    const x = parseHybrid($("tapX").value);
    const y = parseHybrid($("tapY").value);
    await window.forgeAPI.tapRaw(id, x, y);
  })
);

$("swipeBtn").addEventListener("click", () =>
  act("swipe raw", async () => {
    const id = mustSelected();
    const x1 = parseHybrid($("swX1").value);
    const y1 = parseHybrid($("swY1").value);
    const x2 = parseHybrid($("swX2").value);
    const y2 = parseHybrid($("swY2").value);
    const dur = Number($("swDur").value || 220);
    await window.forgeAPI.swipeRaw(id, x1, y1, x2, y2, dur);
  })
);

// Macro UI
async function reloadMacroList() {
  const list = await window.forgeAPI.listMacros();
  const sel = $("macroList");
  sel.innerHTML = "";
  for (const m of list) {
    const opt = document.createElement("option");
    opt.value = m.id;
    const name = m.meta?.name || m.id;
    opt.textContent = `${name} (${m.id})`;
    sel.appendChild(opt);
  }
}

$("macroReloadBtn").addEventListener("click", () =>
  act("macro reload", reloadMacroList)
);

$("macroRecStartBtn").addEventListener("click", () =>
  act("macro record start", async () => {
    const id = mustSelected();
    const st = macroRuntimeByDevice.get(id);
    if (st?.running) throw new Error("Macro is running. Stop first.");

    await window.forgeAPI.macroRecordStart(id);
    recordedSteps = [];
    logLocal("Recording started (V2: click/drag trực tiếp trên scrcpy window)");
  })
);

$("macroRecStopBtn").addEventListener("click", () =>
  act("macro record stop", async () => {
    const r = await window.forgeAPI.macroRecordStop();
    recordedSteps = r.steps || [];
    logLocal(`Recording stopped. steps=${recordedSteps.length}`);
  })
);

$("macroAddTextBtn").addEventListener("click", () =>
  act("macro add text", async () => {
    const id = mustSelected();
    const textTpl = $("macroText").value || "";

    // 1) record TEXT step into macro (template string)
    await window.forgeAPI.macroRecordAddText(textTpl);

    // 2) immediately type into focused input on device (preview resolved vars)
    const preview = resolveTextTemplateUi(textTpl, _uiTextVars());
    if (String(preview).length) {
      try {
        await window.forgeAPI.text(id, preview);
      } catch (e) {
        // don't fail the whole "Add TEXT" action; still keep the recorded step
        logLocal(`TEXT preview typing failed: ${e?.message || e}`, true);
      }
    }

    logLocal(`TEXT step added: "${textTpl}" → typed: "${preview}"`);
  })
);

$("macroAddKeyBtn").addEventListener("click", () =>
  act("macro add key", async () => {
    const key = $("macroKeySel").value;
    await window.forgeAPI.macroRecordAddKey(key);
    logLocal(`KEY step added: ${key}`);
  })
);

$("macroAddWaitBtn").addEventListener("click", () =>
  act("macro add wait", async () => {
    const ms = Number($("macroWaitMs").value || 0);
    await window.forgeAPI.macroRecordAddWait(ms);
    logLocal(`WAIT step added: ${ms}ms`);
  })
);

$("macroSaveBtn").addEventListener("click", () =>
  act("macro save", async () => {
    const name = $("macroName").value || "macro_" + Date.now();
    const desc = $("macroDesc").value || "";
    if (!recordedSteps.length)
      throw new Error("No recorded steps. Stop Record first.");
    await window.forgeAPI.macroSave(name, desc, recordedSteps);
    logLocal(`Saved macro: ${name}`);
    await reloadMacroList();
  })
);

$("macroPlayBtn").addEventListener("click", () =>
  act("macro play", async () => {
    const id = mustSelected();
    const st = macroRuntimeByDevice.get(id);
    if (st?.running)
      throw new Error("Macro is already running on this device.");

    const macroId = $("macroList").value;
    if (!macroId) throw new Error("Select a macro");

    const loop = parseLoopInput($("macroLoop").value); // 0 => infinite
    const speed = Number($("macroSpeed").value || 1.0);
    const xyJitterPct = Number($("macroJitterXY").value || 0.0);
    const delayJitterPct = Number($("macroJitterDelay").value || 0.0);

    macroRuntimeByDevice.set(id, {
      running: true,
      macroId,
      loopIndex: 1,
      loopCount: loop,
      stepIndex: 0,
      stepCount: "?",
      stepType: "",
    });
    renderMacroStatus(id);

    logLocal(
      `Play macro ${macroId} on ${id} (loop=${loop === 0 ? "∞" : loop})`
    );

    const macroTextVar = String($("macroText").value || "");

    await window.forgeAPI.macroPlay(id, macroId, {
      loop,
      speed,
      xyJitterPct,
      delayJitterPct,
      textVars: {
        MACRO_TEXT: macroTextVar,
      },
    });
  })
);

$("macroStopBtn").addEventListener("click", () =>
  act("macro stop", async () => {
    const id = mustSelected();
    await window.forgeAPI.macroStop(id);
    logLocal("Stop requested");
  })
);

// Group Macro
$("groupMacroPlayBtn").addEventListener("click", () =>
  act("group macro play", async () => {
    const gid = mustGroupSelected();
    const macroId = $("macroList").value;
    if (!macroId) throw new Error("Select a macro");

    const loop = parseLoopInput($("macroLoop").value); // 0 => infinite
    const speed = Number($("macroSpeed").value || 1.0);
    const xyJitterPct = Number($("macroJitterXY").value || 0.0);
    const delayJitterPct = Number($("macroJitterDelay").value || 0.0);

    const gmBaseDelay = Number($("gmBaseDelay").value || 120);
    const gmJitter = Number($("gmJitter").value || 280);

    await persistGroupMacroDefaults();

    const macroTextVar = String($("macroText").value || "");

    const r = await window.forgeAPI.groupMacroPlay(
      gid,
      macroId,
      {
        loop,
        speed,
        xyJitterPct,
        delayJitterPct,
        textVars: {
          MACRO_TEXT: macroTextVar,
        },
      },
      { baseDelayMs: gmBaseDelay, jitterMs: gmJitter }
    );

    logLocal(
      `Group macro started: group=${gid} macro=${macroId} loop=${
        loop === 0 ? "∞" : loop
      } started=${r?.started?.length || 0}`
    );
  })
);

$("groupMacroStopGroupBtn").addEventListener("click", () =>
  act("group macro stop group", async () => {
    const gid = mustGroupSelected();
    const r = await window.forgeAPI.groupMacroStopGroup(gid);
    logLocal(`Stop group requested: stopped=${r?.stopped ?? "?"}`);
  })
);

$("groupMacroStopSelectedBtn").addEventListener("click", () =>
  act("group macro stop selected device", async () => {
    const gid = mustGroupSelected();
    const did = mustSelected();
    const r = await window.forgeAPI.groupMacroStopDevice(gid, did);
    logLocal(
      `Stop device requested: ${did} stopped=${r?.stopped ? "YES" : "NO"}`
    );
  })
);

// macro state/progress events
window.forgeAPI.onMacroState((p) => {
  const { deviceId, running, macroId, loopIndex, loopCount } = p || {};
  if (!deviceId) return;

  const prevRunning = !!macroPrevRunningByDevice.get(deviceId);
  const nextRunning = !!running;

  if (prevRunning && !nextRunning) {
    const d = devicesById.get(deviceId);
    const name = getDisplayName(d || { deviceId });
    logLocal(`Macro finished/stopped on ${name} (${deviceId})`);
  }

  macroPrevRunningByDevice.set(deviceId, nextRunning);

  const cur = macroRuntimeByDevice.get(deviceId) || {};
  macroRuntimeByDevice.set(deviceId, {
    ...cur,
    running: nextRunning,
    macroId: macroId || cur.macroId || "",
    stepIndex: nextRunning ? (cur.stepIndex ?? 0) : 0,
    stepCount: nextRunning ? (cur.stepCount ?? "?") : 0,
    stepType: nextRunning ? (cur.stepType ?? "") : "",
    loopIndex: nextRunning ? (loopIndex ?? cur.loopIndex ?? 1) : 0,
    loopCount: nextRunning ? (loopCount ?? cur.loopCount) : cur.loopCount,
  });

  if (deviceId === selectedDeviceId) renderMacroStatus(deviceId);
});

window.forgeAPI.onMacroProgress((p) => {
  const { deviceId, stepIndex, stepCount, stepType, loopIndex, loopCount } =
    p || {};
  if (!deviceId) return;
  const cur = macroRuntimeByDevice.get(deviceId) || {};
  macroRuntimeByDevice.set(deviceId, {
    ...cur,
    running: true,
    stepIndex,
    stepCount,
    stepType,
    ...(loopIndex != null ? { loopIndex } : {}),
    ...(loopCount != null ? { loopCount } : {}),
  });
  if (deviceId === selectedDeviceId) renderMacroStatus(deviceId);
});

// scrcpy closed
window.forgeAPI.onScrcpyClosed(({ deviceId, code, signal }) => {
  logLocal(
    `scrcpy closed: ${deviceId} (code=${code ?? "?"}, signal=${signal ?? "?"})`,
    true
  );
  refreshUI();
});

// ✅ Core 5: receive logs from main (file-backed)
window.forgeAPI.onLogLine((line) => {
  // already has timestamp + level
  const isErr = String(line).includes(" ERROR ");
  const el = $("log");
  el.innerHTML =
    `<div class="${isErr ? "err" : ""}">${line}</div>` + el.innerHTML;
});

// refresh loop
async function refreshUI() {
  const devices = await window.forgeAPI.listDevices();

  devicesById.clear();
  for (const d of devices) {
    devicesById.set(d.deviceId, d);
    if (d.alias) layoutState.deviceAliases[d.deviceId] = d.alias;
  }

  ensureInUiOrder(devices);

  if (!selectedDeviceId) {
    const firstOnline = devices.find((d) => d.state === "ONLINE");
    if (firstOnline) selectedDeviceId = firstOnline.deviceId;
  }

  renderDevices(devices);
  renderGroupDevicesPanel();
  await updateSelectedInfo();
}

(async function boot() {
  // preload last log tail
  try {
    const lines = await window.forgeAPI.logTail(80);
    for (const l of lines) {
      const isErr = String(l).includes(" ERROR ");
      const el = $("log");
      el.innerHTML =
        `<div class="${isErr ? "err" : ""}">${l}</div>` + el.innerHTML;
    }
  } catch {}

  logLocal("Control Panel loaded. (Core5 logging + autoStart moved to main)");

  await pullLayoutFromMain();
  await reloadGroups();
  await refreshUI();
  await reloadMacroList();
  setInterval(refreshUI, 1500);
})();

