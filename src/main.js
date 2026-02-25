// src/main.js
const { app, BrowserWindow, ipcMain, clipboard } = require("electron");

const path = require("path");
const fs = require("fs");
const { randomUUID, createHash } = require("crypto");
const http = require("http");
const https = require("https");

const { DeviceRegistry } = require("./controller/deviceRegistry");
const { scrcpy } = require("./controller/scrcpyController");
const input = require("./controller/inputControllerAdb");
const inputSmart = require("./controller/inputControllerSmart");

// Macro core
const { MacroRecorder } = require("./macro/macroRecorder");
const { listMacros, loadMacro, saveMacro } = require("./macro/macroStore");
const { runMacroOnDevice } = require("./macro/macroRunner");

// V2 Hook
const { ScrcpyHook } = require("./macro/scrcpyHook");

// Groups
const { GroupManager } = require("./controller/groupManager");
const { GroupBroadcast } = require("./controller/groupBroadcast");

// Logger
const { Logger } = require("./controller/logger");

// Agent socket helpers
const { ensureForward, sendJsonLine } = require("./controller/socketClient");

if (require("electron-squirrel-startup")) {
  app.quit();
}

const registry = new DeviceRegistry();
let mainWindow = null;

// Macro state
const recorder = new MacroRecorder();
const hook = new ScrcpyHook();

// running: deviceId -> { stop:boolean, token:number, ... }
const runningMacroByDevice = new Map();

function safeSend(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch {}
}

// ========= settings persistence =========
function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readSettingsFile() {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSettingsFile(obj) {
  try {
    const p = settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function normalizeScalePct(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return 50;
  const allowed = [25, 50, 75, 100];
  let best = allowed[0];
  let bestDist = Math.abs(p - best);
  for (const a of allowed) {
    const d = Math.abs(p - a);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

function parseLoopCount(loopRaw) {
  // Convention: loop <= 0 => infinite (UI shows ∞)
  const s = typeof loopRaw === "string" ? loopRaw.trim() : "";
  if (s) {
    if (s === "∞" || /^inf(inite)?$/i.test(s))
      return { infinite: true, total: 0 };
    const n = Number(s);
    if (Number.isFinite(n)) {
      if (n <= 0) return { infinite: true, total: 0 };
      return { infinite: false, total: Math.max(1, Math.floor(n)) };
    }
    return { infinite: false, total: 1 };
  }

  const n = Number(loopRaw);
  if (!Number.isFinite(n)) return { infinite: false, total: 1 };
  if (n <= 0) return { infinite: true, total: 0 };
  return { infinite: false, total: Math.max(1, Math.floor(n)) };
}

// ========= Device order =========
let deviceOrder = [];
function setDeviceOrder(newOrder) {
  if (!Array.isArray(newOrder)) return;
  const seen = new Set();
  const cleaned = [];
  for (const id of newOrder) {
    const s = String(id || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    cleaned.push(s);
  }
  deviceOrder = cleaned;
}

function sortDevicesByOrder(devices) {
  const idx = new Map();
  deviceOrder.forEach((id, i) => idx.set(id, i));
  return [...devices].sort((a, b) => {
    const ia = idx.has(a.deviceId) ? idx.get(a.deviceId) : 1e9;
    const ib = idx.has(b.deviceId) ? idx.get(b.deviceId) : 1e9;
    if (ia !== ib) return ia - ib;
    return String(a.deviceId).localeCompare(String(b.deviceId));
  });
}

// ========= layout config =========
const layoutConfig = {
  scalePct: 50,
  cols: 4,
  rows: 0,
  margin: 8,
  forceResizeOnApply: true,

  autoStartEnabled: false,
  autoWakeOnRecover: true,
};

// persist: broadcast defaults + group macro defaults + device aliases
let broadcastDefaults = {
  baseDelayMs: 90,
  jitterMs: 160,
  xyJitterPct: 0.004,
};

let groupMacroDefaults = {
  baseDelayMs: 120,
  jitterMs: 280,
};

// deviceId -> alias
let deviceAliases = {}; // { [deviceId]: "My Name" }

// ========= TikTok Harvest (NEW CORE) persisted config =========
let tiktokConfig = {
  endpointUrl:
    "https://script.google.com/macros/s/AKfycby6saWjkNjYMrCevS9V769yaF8jJDeVCY5X8eeNW8tx9-fqbUB2VemXZL-EnJpiN68d/exec",
  token: "secret-farm-12345",
  groupId: "Farm_HCM",
  macroId: "",

  // batching
  batchSize: 15,
  flushEveryMs: 15000,
  httpTimeoutMs: 12000,

  // live detection keywords
  liveKeywords: [
    "Nhấn để xem LIVE",
    "phiên LIVE",
    "Đang LIVE",
    "Gửi quà",
    "Tặng quà",
  ],

  // if gặp LIVE liên tiếp -> thoát
  liveMaxConsecutive: 3,

  // after each cycle always swipe next
  swipeAfterEach: true,

  // poll clipboard
  clipboardPollEveryMs: 260,
  clipboardPollTimeoutMs: 8000,

  // general loop delay
  loopDelayMs: 180,

  // ⚠️ Fallback tap theo toạ độ (không khuyến nghị) - để false để tránh máy yếu bấm nhầm
  allowCoordinateFallback: false,

  copyAttemptsPerVideo: 1,

  swipeOnFailAfter: 1,

  liveMinHits: 2,
};


// ========= Instagram Upload (NEW) persisted config =========
let igConfig = {
  macroId: "",
  songText: "",
  // (future) media options, caption, etc.
};

// ========= Groups (persisted) =========
let groupManager = new GroupManager([]);

function getGroupsForSave() {
  return groupManager.toJSON();
}

function getLayoutConfig() {
  return {
    ...layoutConfig,
    deviceOrder,
    groups: getGroupsForSave(),
    broadcastDefaults,
    groupMacroDefaults,
    deviceAliases,

    // ✅ include tiktok core config
    tiktokConfig,

    // ✅ include instagram config
    igConfig,
  };
}

function persistSettings() {
  writeSettingsFile({ v: 6, ...getLayoutConfig() });
}

function setLayoutConfig(patch = {}) {
  if (patch.scalePct != null)
    layoutConfig.scalePct = normalizeScalePct(patch.scalePct);

  if (patch.cols != null) {
    const c = Math.round(Number(patch.cols));
    layoutConfig.cols = Number.isFinite(c)
      ? Math.max(1, Math.min(20, c))
      : layoutConfig.cols;
  }

  if (patch.rows != null) {
    const r = Math.round(Number(patch.rows));
    layoutConfig.rows = Number.isFinite(r)
      ? Math.max(0, Math.min(20, r))
      : layoutConfig.rows;
  }

  if (patch.margin != null) {
    const m = Math.round(Number(patch.margin));
    layoutConfig.margin = Number.isFinite(m)
      ? Math.max(0, Math.min(60, m))
      : layoutConfig.margin;
  }

  if (patch.forceResizeOnApply != null) {
    layoutConfig.forceResizeOnApply = !!patch.forceResizeOnApply;
  }

  if (patch.autoStartEnabled != null) {
    layoutConfig.autoStartEnabled = !!patch.autoStartEnabled;
  }

  if (patch.autoWakeOnRecover != null) {
    layoutConfig.autoWakeOnRecover = !!patch.autoWakeOnRecover;
  }

  if (patch.deviceOrder != null) {
    setDeviceOrder(patch.deviceOrder);
  }

  if (patch.groups != null && Array.isArray(patch.groups)) {
    groupManager = new GroupManager(patch.groups);
  }

  if (patch.broadcastDefaults && typeof patch.broadcastDefaults === "object") {
    const bd = patch.broadcastDefaults;
    if (bd.baseDelayMs != null)
      broadcastDefaults.baseDelayMs = Math.max(0, Number(bd.baseDelayMs) || 0);
    if (bd.jitterMs != null)
      broadcastDefaults.jitterMs = Math.max(0, Number(bd.jitterMs) || 0);
    if (bd.xyJitterPct != null)
      broadcastDefaults.xyJitterPct = Math.max(0, Number(bd.xyJitterPct) || 0);
  }

  if (
    patch.groupMacroDefaults &&
    typeof patch.groupMacroDefaults === "object"
  ) {
    const gd = patch.groupMacroDefaults;
    if (gd.baseDelayMs != null)
      groupMacroDefaults.baseDelayMs = Math.max(0, Number(gd.baseDelayMs) || 0);
    if (gd.jitterMs != null)
      groupMacroDefaults.jitterMs = Math.max(0, Number(gd.jitterMs) || 0);
  }

  if (patch.deviceAliases && typeof patch.deviceAliases === "object") {
    deviceAliases = { ...deviceAliases, ...patch.deviceAliases };
    for (const k of Object.keys(deviceAliases)) {
      const v = String(deviceAliases[k] ?? "").trim();
      if (!v) delete deviceAliases[k];
      else deviceAliases[k] = v;
    }
  }

  // ✅ tiktok config patch
  if (patch.tiktokConfig && typeof patch.tiktokConfig === "object") {
    tiktokConfig = { ...tiktokConfig, ...patch.tiktokConfig };
    // sanitize numbers
    tiktokConfig.batchSize = Math.max(1, Number(tiktokConfig.batchSize) || 15);
    tiktokConfig.flushEveryMs = Math.max(
      2000,
      Number(tiktokConfig.flushEveryMs) || 15000,
    );
    tiktokConfig.httpTimeoutMs = Math.max(
      2000,
      Number(tiktokConfig.httpTimeoutMs) || 12000,
    );
    tiktokConfig.clipboardPollEveryMs = Math.max(
      120,
      Number(tiktokConfig.clipboardPollEveryMs) || 260,
    );
    tiktokConfig.clipboardPollTimeoutMs = Math.max(
      800,
      Number(tiktokConfig.clipboardPollTimeoutMs) || 3500,
    );
    tiktokConfig.liveMaxConsecutive = Math.max(
      1,
      Number(tiktokConfig.liveMaxConsecutive) || 3,
    );
    tiktokConfig.loopDelayMs = Math.max(
      0,
      Number(tiktokConfig.loopDelayMs) || 180,
    );
    tiktokConfig.copyAttemptsPerVideo = Math.max(
      1,
      Number(tiktokConfig.copyAttemptsPerVideo) || 2,
    );
    tiktokConfig.swipeOnFailAfter = Math.max(
      1,
      Number(tiktokConfig.swipeOnFailAfter) || 2,
    );
    tiktokConfig.liveMinHits = Math.max(
      1,
      Number(tiktokConfig.liveMinHits) || 2,
    );

    if (!Array.isArray(tiktokConfig.liveKeywords))
      tiktokConfig.liveKeywords = [
        "Nhấn để xem LIVE",
        "phiên LIVE",
        "Đang LIVE",
        "Gửi quà",
        "Tặng quà",
      ];
  }

  // ✅ ig config patch
  if (patch.igConfig && typeof patch.igConfig === "object") {
    igConfig = { ...igConfig, ...patch.igConfig };
    igConfig.macroId = String(igConfig.macroId || "").trim();
    igConfig.songText = String(igConfig.songText || "");
  }


  persistSettings();
}

function setDeviceAlias(deviceId, alias) {
  const did = String(deviceId || "").trim();
  if (!did) throw new Error("deviceId required");
  const a = String(alias ?? "").trim();

  if (!a) {
    delete deviceAliases[did];
  } else {
    deviceAliases[did] = a;
  }
  persistSettings();
  return { ok: true, deviceId: did, alias: deviceAliases[did] || "" };
}

// ========= slot manager =========
const slotByDevice = new Map();
let nextSlot = 0;

function allocSlot(deviceId) {
  if (slotByDevice.has(deviceId)) return slotByDevice.get(deviceId);
  const s = nextSlot++;
  slotByDevice.set(deviceId, s);
  return s;
}

function freeSlot(deviceId) {
  slotByDevice.delete(deviceId);
}

const SCRCPY_BASE_PORT = 27200;
function portForSlot(slotIndex) {
  return SCRCPY_BASE_PORT + (slotIndex % 200);
}

// ========= window =========
function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
  return win;
}

function ensureOnline(ctx) {
  if (!ctx) throw new Error("Device not found");
  if (ctx.state !== "ONLINE")
    throw new Error(`Device not ONLINE (${ctx.state})`);
  return ctx;
}

function computeScrcpyCellAndMaxSize(deviceSnapshot, scalePct) {
  const res = deviceSnapshot?.resolution;
  const scale = normalizeScalePct(scalePct) / 100;

  const baseW100 = 360;
  const targetW = clampInt(baseW100 * scale, 160, 1200);

  if (!res || !res.width || !res.height) {
    const targetH = clampInt(780 * scale, 240, 1800);
    const maxSize = clampInt(Math.max(targetW, targetH), 160, 2400);
    return { width: targetW, height: targetH, maxSize };
  }

  const h = Math.round(targetW * (res.height / res.width));
  const targetH = clampInt(h, 240, 2000);

  const deviceMaxDim = Math.max(res.width, res.height);
  const maxSize = clampInt(Math.round(deviceMaxDim * scale), 160, 6000);

  return { width: targetW, height: targetH, maxSize };
}

function rawToPx(raw, axisMax) {
  if (!raw || !Number.isFinite(axisMax) || axisMax <= 0)
    throw new Error("Missing resolution to convert coordinates");

  const unit = String(raw.unit || "px");
  const val = Number(raw.value);

  if (!Number.isFinite(val)) throw new Error("Invalid coordinate");

  if (unit === "pct") {
    let p = val;
    if (p <= 1) p = p * 100;
    p = Math.max(0, Math.min(100, p));
    const px = Math.round((p / 100) * axisMax);
    return clampInt(px, 0, axisMax - 1);
  }

  return clampInt(val, 0, axisMax - 1);
}

function rawToPct(raw, axisMax) {
  if (!raw || !Number.isFinite(axisMax) || axisMax <= 0)
    throw new Error("Missing resolution to convert coordinates");

  const unit = String(raw.unit || "px");
  const val = Number(raw.value);

  if (!Number.isFinite(val)) throw new Error("Invalid coordinate");

  if (unit === "pct") {
    let p = val;
    if (p > 1) p = p / 100;
    return Math.max(0, Math.min(1, p));
  }

  return Math.max(0, Math.min(1, val / axisMax));
}

// ========= Core 4: Broadcast Engine instance =========
function loadMacroByIdFromStore(id) {
  return loadMacro(app.getPath("userData"), id);
}

let groupBroadcast = null;
function initGroupBroadcast() {
  groupBroadcast = new GroupBroadcast({
    registry,
    getGroup: (groupId) => groupManager.get(groupId),
    loadMacroById: loadMacroByIdFromStore,
    runningMacroByDevice,
    sendMacroState,
    sendMacroProgress,
  });
}

function sendMacroState(deviceId, state) {
  safeSend("macro:state", { deviceId, ...state });
}

function sendMacroProgress(deviceId, payload) {
  safeSend("macro:progress", { deviceId, ...payload });
}

// ========= Core 5: logger + auto recover =========
let logger = null;

// prevent spam restart
const autoRecoverPending = new Set();

function ensureInOrder(deviceId) {
  if (!deviceOrder.includes(deviceId)) {
    deviceOrder.push(deviceId);
    persistSettings();
  }
}

async function autoRecoverScrcpy(deviceId, reason) {
  if (!layoutConfig.autoStartEnabled) return;
  if (autoRecoverPending.has(deviceId)) return;

  const ctx = registry.get(deviceId);
  if (!ctx || ctx.state !== "ONLINE") return;

  autoRecoverPending.add(deviceId);

  try {
    ensureInOrder(deviceId);

    // wait a bit after reconnect so adb is stable
    await sleep(450);

    const snap = ctx.snapshot();
    const slotIndex = Math.max(0, deviceOrder.indexOf(deviceId));
    allocSlot(deviceId);
    const port = portForSlot(slotIndex);

    const { width, height, maxSize } = computeScrcpyCellAndMaxSize(
      snap,
      layoutConfig.scalePct,
    );

    await scrcpy.start(deviceId, {
      maxFps: 30,
      bitRate: "8M",
      port,
      window: {
        width,
        height,
        maxSize,
        layout: {
          mode: "grid",
          slotIndex,
          cols: layoutConfig.cols,
          rows: layoutConfig.rows > 0 ? layoutConfig.rows : null,
          margin: layoutConfig.margin,
        },
        borderless: false,
        alwaysOnTop: false,
        timeoutMs: 15000,
      },
      zOrder: { sendToBottom: true, noActivate: true },
    });

    logger?.health("autoRecover scrcpy:started", { deviceId, reason });

    if (layoutConfig.autoWakeOnRecover) {
      try {
        await input.wake(deviceId);
        logger?.health("autoRecover wake:ok", { deviceId });
      } catch (e) {
        logger?.error("autoRecover wake:fail", {
          deviceId,
          message: String(e?.message || e || ""),
        });
      }
    }
  } catch (e) {
    logger?.error("autoRecover scrcpy:fail", {
      deviceId,
      reason,
      message: String(e?.message || e || ""),
    });
  } finally {
    setTimeout(() => autoRecoverPending.delete(deviceId), 1500);
  }
}

function attachRegistryLoggingAndRecover() {
  registry.on("device:state", (evt) => {
    const { deviceId, prev, next, changed, snapshot } = evt || {};
    if (!deviceId) return;

    if (changed) {
      logger?.info("device:state", {
        deviceId,
        prev,
        next,
        onlineSince: snapshot?.onlineSince || null,
        totalOnlineMs: snapshot?.totalOnlineMs || 0,
        adbErrorCount: snapshot?.adbErrorCount || 0,
      });

      if (prev !== "ONLINE" && next === "ONLINE") {
        autoRecoverScrcpy(deviceId, "reconnect");
      }

      if (prev === "ONLINE" && next !== "ONLINE") {
        try {
          if (scrcpy.isRunning(deviceId)) {
            scrcpy.stop(deviceId).catch(() => {});
            freeSlot(deviceId);
          }
        } catch {}
      }
    }
  });

  registry.on("device:adbError", (evt) => {
    logger?.error("device:adbError", evt);
  });

  registry.on("registry:adbDown", (evt) => {
    logger?.error("registry:adbDown", evt);
  });
}

function attachProcessGuards() {
  process.on("uncaughtException", (e) => {
    logger?.error("process:uncaughtException", {
      message: String(e?.stack || e),
    });
  });
  process.on("unhandledRejection", (e) => {
    logger?.error("process:unhandledRejection", {
      message: String(e?.stack || e),
    });
  });
}

// ===============================
// TikTok Harvest (NEW CORE)
// ===============================
const TIKTOK_QUEUE_FILE = () =>
  path.join(app.getPath("userData"), "tiktok_queue.json");

function nowIso() {
  return new Date().toISOString();
}

function hostClipboardGet() {
  try {
    return String(clipboard.readText() || "");
  } catch {
    return "";
  }
}

// mutex để tránh 2 worker cùng lúc chờ clipboard
let _clipMutex = Promise.resolve();
async function withClipboardMutex(fn) {
  const prev = _clipMutex;
  let release;
  _clipMutex = new Promise((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function extractFirstHttpUrl(text) {
  const s = String(text || "");
  const m = s.match(/https?:\/\/[^\s]+/i);
  if (!m) return "";
  let u = m[0].trim();
  // trim dấu câu hay dính cuối
  u = u.replace(/[)\],.;]+$/g, "");
  return u;
}

function extractTikTokUrl(text) {
  const u = extractFirstHttpUrl(text);
  if (!u) return "";
  if (!/tiktok\.com\//i.test(u)) return "";
  return u;
}

function isTikTokUrl(text) {
  return !!extractTikTokUrl(text);
}

function maskUrl(u, max = 120) {
  const s = String(u || "");
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function sha1(s) {
  return createHash("sha1")
    .update(String(s || ""), "utf8")
    .digest("hex");
}

// agent forward host port (avoid collision; stable by deviceOrder index)
const AGENT_HOST_BASE = 38183; // local port start
function agentHostPortForDevice(deviceId) {
  ensureInOrder(deviceId);
  const idx = Math.max(0, deviceOrder.indexOf(deviceId));
  return AGENT_HOST_BASE + (idx % 2000); // big enough
}

// agent call: returns {ok, line}
async function agentCallLine(deviceId, payload, timeoutMs = 1200) {
  const hostPort = agentHostPortForDevice(deviceId);
  await ensureForward(deviceId, hostPort);
  return await sendJsonLine(hostPort, payload, timeoutMs);
}

// parse "OK <json>" line
function parseOkJson(line) {
  const s = String(line || "");
  if (!s.startsWith("OK")) return null;
  const rest = s.slice(2).trim();
  if (!rest) return {};
  try {
    return JSON.parse(rest);
  } catch {
    return null;
  }
}

// ✅ CLIPBOARD_GET có thể trả:
//   - OK {"text":"..."}  (json)
//   - OK <base64>        (base64)
//   - OK https://...     (plain)
function parseOkTextDual(line) {
  const s = String(line || "");
  if (!s.startsWith("OK")) return "";
  const rest = s.slice(2).trim();
  if (!rest) return "";

  // 1) JSON: OK {"text":"..."} hoặc OK "..."
  try {
    const v = JSON.parse(rest);
    if (typeof v === "string") return v;

    if (v && typeof v === "object") {
      for (const k of [
        "text",
        "value",
        "clipboard",
        "clip",
        "data",
        "content",
      ]) {
        if (v[k] != null) return String(v[k]);
      }
    }
  } catch {}

  // 2) Plain text (URL)
  if (/^https?:\/\//i.test(rest)) return rest;

  // 3) base64
  if (/^[A-Za-z0-9+/=]+$/.test(rest) && rest.length >= 8) {
    try {
      const decoded = Buffer.from(rest, "base64").toString("utf8").trim();
      if (decoded) return decoded;
    } catch {}
  }

  return "";
}

async function agentClipboardGet(deviceId) {
  const r = await agentCallLine(deviceId, { type: "CLIPBOARD_GET" }, 1800);
  if (!r.ok) throw new Error(r.line || "ERR clipboard");

  const text = parseOkTextDual(r.line);

  // DEBUG: nếu rỗng thì log raw để xem agent trả gì
  if (!text) {
    tiktokLog("clipboard:empty", {
      deviceId,
      line: String(r.line || "").slice(0, 160),
    });
  }
  return text;
}

async function agentFindText(deviceId, query) {
  const q = String(query || "").trim();
  if (!q) return { found: false };
  const r = await agentCallLine(
    deviceId,
    { type: "FIND_TEXT", query: q, ignoreCase: true, mode: "contains" },
    2200,
  );
  if (!r.ok) return { found: false, error: r.line || "" };
  const obj = parseOkJson(r.line);
  if (!obj) return { found: false };
  return obj;
}

async function agentClickText(deviceId, query) {
  const q = String(query || "").trim();
  if (!q) return { found: false, clicked: false };

  const r = await agentCallLine(
    deviceId,
    { type: "CLICK_TEXT", query: q, ignoreCase: true, mode: "contains" },
    2200,
  );
  if (!r.ok) return { found: false, clicked: false, error: r.line || "" };

  const obj = parseOkJson(r.line);
  if (!obj) return { found: false, clicked: false };
  return obj; // {found, clicked, text, x1,y1,x2,y2}
}


async function agentFindId(deviceId, query) {
  const q = String(query || "").trim();
  if (!q) return { found: false };

  const r = await agentCallLine(
    deviceId,
    { type: "FIND_ID", query: q, ignoreCase: true, mode: "contains" },
    2200,
  );
  if (!r.ok) return { found: false, error: r.line || "" };

  const obj = parseOkJson(r.line);
  return obj || { found: false };
}

async function agentFindDesc(deviceId, query) {
  const q = String(query || "").trim();
  if (!q) return { found: false };

  const r = await agentCallLine(
    deviceId,
    { type: "FIND_DESC", query: q, ignoreCase: true, mode: "contains" },
    2200,
  );
  if (!r.ok) return { found: false, error: r.line || "" };

  const obj = parseOkJson(r.line);
  return obj || { found: false };
}

async function agentClickDesc(deviceId, query) {
  const q = String(query || "").trim();
  if (!q) return { found: false, clicked: false };

  const r = await agentCallLine(
    deviceId,
    { type: "CLICK_DESC", query: q, ignoreCase: true, mode: "contains" },
    2200,
  );
  if (!r.ok) return { found: false, clicked: false, error: r.line || "" };

  const obj = parseOkJson(r.line);
  return obj || { found: false, clicked: false };
}

async function agentClickId(deviceId, query) {
  const q = String(query || "").trim();
  if (!q) return { found: false, clicked: false };

  const r = await agentCallLine(
    deviceId,
    { type: "CLICK_ID", query: q, ignoreCase: true, mode: "contains" },
    2200,
  );
  if (!r.ok) return { found: false, clicked: false, error: r.line || "" };

  const obj = parseOkJson(r.line);
  return obj || { found: false, clicked: false };
}

async function agentOpenShare(deviceId) {
  const r = await agentCallLine(deviceId, { type: "OPEN_SHARE" }, 3800);
  if (!r.ok) return { opened: false, raw: r.line || "" };
  const obj = parseOkJson(r.line);
  return { opened: !!obj?.opened, obj };
}

async function waitClipboardTikTokUrl(deviceId, baselineRaw, cfg) {
  const every = Math.max(120, Number(cfg.clipboardPollEveryMs) || 260);
  const timeout = Math.max(800, Number(cfg.clipboardPollTimeoutMs) || 8000);

  const baselineUrl = extractTikTokUrl(baselineRaw);
  const started = Date.now();

  let tries = 0;
  let lastRaw = "";
  let lastUrl = "";

  while (Date.now() - started < timeout) {
    tries++;
    lastRaw = await agentClipboardGet(deviceId);
    lastUrl = extractTikTokUrl(lastRaw);

    // chưa có url -> chờ tiếp
    if (!lastUrl) {
      await sleep(every);
      continue;
    }

    // baseline không có url -> lấy luôn
    if (!baselineUrl) {
      return {
        ok: true,
        status: "ok",
        url: lastUrl,
        baselineUrl,
        lastUrl,
        tries,
        elapsedMs: Date.now() - started,
      };
    }

    // url đổi so với baseline -> success chuẩn
    if (lastUrl !== baselineUrl) {
      return {
        ok: true,
        status: "ok",
        url: lastUrl,
        baselineUrl,
        lastUrl,
        tries,
        elapsedMs: Date.now() - started,
      };
    }

    // vẫn giống baseline -> tiếp tục đợi (nhưng có ghi nhận lastUrl)
    await sleep(every);
  }

  // timeout
  if (lastUrl && baselineUrl && lastUrl === baselineUrl) {
    return {
      ok: true, // coi như "dup" để worker có thể swipe đi tiếp, tránh kẹt
      status: "dup",
      url: lastUrl,
      baselineUrl,
      lastUrl,
      tries,
      elapsedMs: Date.now() - started,
      reason: "same_as_baseline_timeout",
    };
  }

  return {
    ok: false,
    status: "timeout",
    url: "",
    baselineUrl,
    lastUrl,
    tries,
    elapsedMs: Date.now() - started,
    reason: lastUrl ? "no_change_or_not_tiktok_url" : "no_url_timeout",
  };
}

async function waitClipboardTikTokUrlAny(
  deviceId,
  baselineAgentRaw,
  baselineHostRaw,
  cfg,
) {
  const every = Math.max(120, Number(cfg.clipboardPollEveryMs) || 260);
  const timeout = Math.max(800, Number(cfg.clipboardPollTimeoutMs) || 8000);

  const baselineAgentUrl = extractTikTokUrl(baselineAgentRaw);
  const baselineHostUrl = extractTikTokUrl(baselineHostRaw);
  const base = baselineAgentUrl || baselineHostUrl;

  const started = Date.now();
  let tries = 0;

  let lastAgentUrl = "";
  let lastHostUrl = "";
  let lastPicked = "";

  while (Date.now() - started < timeout) {
    tries++;

    // agent
    try {
      const aRaw = await agentClipboardGet(deviceId);
      lastAgentUrl = extractTikTokUrl(aRaw);
    } catch {}

    // host
    const hRaw = hostClipboardGet();
    lastHostUrl = extractTikTokUrl(hRaw);

    // prefer agent nếu có
    lastPicked = lastAgentUrl || lastHostUrl;

    if (lastPicked) {
      // baseline rỗng => lấy luôn
      if (!base) {
        return {
          ok: true,
          status: "ok",
          url: lastPicked,
          tries,
          elapsedMs: Date.now() - started,
          source: lastAgentUrl ? "agent" : "host",
        };
      }

      // baseline có => chỉ success nếu URL đổi
      if (lastPicked !== base) {
        return {
          ok: true,
          status: "ok",
          url: lastPicked,
          tries,
          elapsedMs: Date.now() - started,
          source: lastAgentUrl ? "agent" : "host",
        };
      }

      // == baseline => tiếp tục đợi, KHÔNG return ngay
    }

    await sleep(every);
  }

  // timeout: nếu có URL nhưng không đổi => dup
  if (lastPicked && base && lastPicked === base) {
    return {
      ok: true,
      status: "dup",
      url: lastPicked,
      tries,
      elapsedMs: Date.now() - started,
      reason: "same_as_baseline_timeout",
    };
  }

  return {
    ok: false,
    status: "timeout",
    url: "",
    tries,
    elapsedMs: Date.now() - started,
    reason: "no_url_timeout",
  };
}

// giữ lại signature cũ cho các chỗ khác (nếu có)
async function pollClipboardForTikTokUrl(deviceId, baseline, cfg) {
  const r = await waitClipboardTikTokUrl(deviceId, baseline, cfg);
  return r.url || "";
}


async function waitForElement(deviceId, spec, timeoutMs = 10000, pollMs = 200) {
  const started = Date.now();
  const s = spec || {};
  const id = s.id ? String(s.id) : "";
  const desc = s.desc ? String(s.desc) : "";
  const text = s.text ? String(s.text) : "";

  while (Date.now() - started < timeoutMs) {
    // Priority: id -> desc -> text
    if (id) {
      const r = await agentFindId(deviceId, id).catch(() => null);
      if (r?.found) return { ok: true, hit: r };
    }
    if (desc) {
      const r = await agentFindDesc(deviceId, desc).catch(() => null);
      if (r?.found) return { ok: true, hit: r };
    }
    if (text) {
      const r = await agentFindText(deviceId, text).catch(() => null);
      if (r?.found) return { ok: true, hit: r };
    }
    await sleep(pollMs);
  }
  return { ok: false, hit: null, reason: "timeout" };
}

// Wait until element exists AND its bounds are stable across 2 consecutive polls.
// This prevents weak devices from clicking before UI has finished rendering.
async function waitForStableElement(deviceId, spec, timeoutMs = 10000, pollMs = 200) {
  const started = Date.now();
  let lastSig = "";
  let stable = 0;

  while (Date.now() - started < timeoutMs) {
    const r = await waitForElement(deviceId, spec, pollMs, Math.max(80, pollMs));
    if (r?.ok && r.hit) {
      const sig = `${r.hit.x1},${r.hit.y1},${r.hit.x2},${r.hit.y2}`;
      if (sig === lastSig) stable++;
      else stable = 0;
      lastSig = sig;

      if (stable >= 1) return { ok: true, hit: r.hit };
    } else {
      lastSig = "";
      stable = 0;
    }
    await sleep(pollMs);
  }
  return { ok: false, hit: null, reason: "timeout" };
}

function _centerFromBounds(obj) {
  const x1 = Number(obj?.x1),
    y1 = Number(obj?.y1),
    x2 = Number(obj?.x2),
    y2 = Number(obj?.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

async function isShareSheetOpen(deviceId) {
  // Share sheet TikTok thường có "Gửi đến" (VN) hoặc "Send to" (EN)
  const markers = [
    "Gửi đến",
    "Gửi tới",
    "Gửi cho",
    "Send to",
    "Sao chép liên kết",
    "Copy link",
    "Liên kết",
    "Link",
  ];

  for (const m of markers) {
    const r = await agentFindText(deviceId, m);
    if (r?.found) return true;
  }
  return false;
}

async function openShareSheet(ctx) {
  const deviceId = ctx.deviceId;
  const cfg = tiktokConfig || {};

  // 0) nếu đang mở sẵn
  try {
    if (await isShareSheetOpen(deviceId)) return true;
  } catch {}

  // 0.5) Smart-wait: chờ nút Share trên màn hình video "ổn định" rồi mới click.
  // Ưu tiên resource-id / content-desc từ Accessibility tree (KHÔNG dùng tọa độ làm chính).
  // TikTok VN thường: com.ss.android.ugc.trill:id/f8q + contentDesc "Chia sẻ video..."
  try {
    await waitForStableElement(
      deviceId,
      { id: ":id/f8q", desc: "Chia sẻ video" },
      4500,
      220,
    );
  } catch {}

  // 1) thử agent OPEN_SHARE (Android side đã smart-wait + ưu tiên id/desc)
  try {
    const r = await agentOpenShare(deviceId);
    if (r?.opened) {
      // Smart-wait share sheet mở hẳn (poll)
      const started = Date.now();
      while (Date.now() - started < 4500) {
        if (await isShareSheetOpen(deviceId)) return true;
        // nếu lỡ mở comment sheet => back ra
        if (await isCommentSheetOpen(deviceId)) {
          await closeCommentSheetIfOpen(ctx);
        }
        await sleep(160);
      }
    }
  } catch {}

  // 1.5) fallback: click trực tiếp theo ID/Desc (không phụ thuộc OPEN_SHARE)
  // (phòng trường hợp OPEN_SHARE fail do UI khác phiên bản)
  const clickAttempts = [
    () => agentClickId(deviceId, ":id/f8q"),
    () => agentClickDesc(deviceId, "Chia sẻ video"),
    () => agentClickDesc(deviceId, "Share video"),
    () => agentClickDesc(deviceId, "Chia sẻ"),
    () => agentClickDesc(deviceId, "Share"),
  ];

  for (const fn of clickAttempts) {
    try {
      const r = await fn();
      if (r?.found && (r?.clicked || r?.x1 != null)) {
        // nếu node không clickable => tap center
        if (r?.found && !r?.clicked) {
          const c = _centerFromBounds(r);
          if (c) await agentCallLine(deviceId, { type: "TAP", x: c.x, y: c.y }, 1200);
        }

        // wait share sheet open
        const started = Date.now();
        while (Date.now() - started < 4200) {
          if (await isShareSheetOpen(deviceId)) return true;
          if (await isCommentSheetOpen(deviceId)) {
            await closeCommentSheetIfOpen(ctx);
          }
          await sleep(160);
        }
      }
    } catch {}
  }

  // 2) ⚠️ fallback cuối: TAP theo toạ độ icon share (chỉ khi user cho phép)
  if (cfg.allowCoordinateFallback) {
    try {
      const snap =
        typeof ctx.snapshot === "function" ? ctx.snapshot() : ctx.snapshot || {};
      const res = snap?.resolution || {};
      const w = res.width || snap?.w || snap?.width;
      const h = res.height || snap?.h || snap?.height;

      if (w && h) {
        const x = Math.round(w * 0.93);

        // quét từ 0.62 -> 0.88, step 0.06 (ít hơn để giảm rủi ro bấm nhầm)
        const yRatios = [];
        for (let yr = 0.62; yr <= 0.88; yr += 0.06)
          yRatios.push(Number(yr.toFixed(2)));

        for (const yr of yRatios) {
          const y = Math.round(h * yr);
          await agentCallLine(deviceId, { type: "TAP", x, y }, 1200);
          tiktokLog("share:tap_probe", { deviceId, x, y, yr });

          // smart-wait thay vì sleep cố định
          const started = Date.now();
          while (Date.now() - started < 1800) {
            if (await isShareSheetOpen(deviceId)) return true;
            // nếu lỡ bấm vào Comment -> thoát ra rồi tiếp tục dò Share
            if (await isCommentSheetOpen(deviceId)) {
              tiktokLog("share:hit_comment", { deviceId, x, y, yr });
              await closeCommentSheetIfOpen(ctx);
              await sleep(160);
              break;
            }
            await sleep(120);
          }
        }
      }
    } catch {}
  }

  return false;
}


async function closeShareSheetIfOpen(ctx) {
  const deviceId = ctx.deviceId;
  let open = false;
  try {
    open = await isShareSheetOpen(deviceId);
  } catch {
    open = false;
  }

  if (!open) return false;

  await ctx.enqueue(async () => {
    try {
      await input.back(deviceId);
    } catch {}
  });

  await sleep(140);
  return true;
}

async function clickCopyLinkOnShareSheet(ctx) {
  const deviceId = ctx.deviceId;

  // Nếu share sheet chưa mở thì khỏi mò copy link
  if (!(await isShareSheetOpen(deviceId))) return false;

  // ưu tiên text/desc; có thể bổ sung theo ngôn ngữ máy
  const keywords =
    Array.isArray(tiktokConfig.copyLinkKeywords) &&
    tiktokConfig.copyLinkKeywords.length
      ? tiktokConfig.copyLinkKeywords
      : ["Sao chép liên kết", "Copy link", "Copy Link"];

  // Smart-wait: chờ nút Copy Link xuất hiện + bounds ổn định rồi mới click
  // (máy yếu load chậm -> nếu click sớm dễ bấm nhầm icon app share khác)
  let ready = false;
  for (const kw of keywords) {
    const r = await waitForStableElement(
      deviceId,
      { desc: kw, text: kw },
      10000,
      220,
    ).catch(() => null);
    if (r?.ok) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    tiktokLog("copybtn:not_ready", { deviceId, reason: "timeout_wait_copy_link" });
    return false;
  }

  // thử vài lần: click_text -> click_desc -> tap center -> scroll sheet -> thử lại
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 1) CLICK_TEXT
    for (const kw of keywords) {
      const r = await agentClickText(deviceId, kw);
      if (r?.found && r?.clicked) {
        tiktokLog("copybtn:clicked", { deviceId, kw, attempt });
        return true;
      }
    }

    // 1.5) CLICK_DESC (nhiều UI để label ở contentDescription)
    for (const kw of keywords) {
      const r = await agentClickDesc(deviceId, kw);
      if (r?.found && r?.clicked) {
        tiktokLog("copybtn:clicked_desc", { deviceId, kw, attempt });
        return true;
      }
      if (r?.found && !r?.clicked) {
        const c = _centerFromBounds(r);
        if (c) {
          await agentCallLine(deviceId, { type: "TAP", x: c.x, y: c.y }, 1200);
          tiktokLog("copybtn:tap_center_desc", { deviceId, kw, attempt });
          await sleep(180);
          return true;
        }
      }
    }

    // 2) fallback: FIND_DESC / FIND_TEXT rồi TAP center (trường hợp node không clickable)
    for (const kw of keywords) {
      let f = await agentFindDesc(deviceId, kw).catch(() => null);
      if (!f?.found) f = await agentFindText(deviceId, kw).catch(() => null);

      if (f?.found) {
        const c = _centerFromBounds(f);
        if (c) {
          await agentCallLine(deviceId, { type: "TAP", x: c.x, y: c.y }, 1200);
          tiktokLog("copybtn:tap_center", { deviceId, kw, attempt });
          await sleep(180);
          break;
        }
      }
    }

    // 3) scroll nhẹ trong share sheet để lộ nút (nếu bị đẩy xuống)
    const snap = ctx.snapshot?.() || {};
    const res = snap.resolution || { width: 1080, height: 1920 };
    const x = Math.round(res.width * 0.5);
    const y1 = Math.round(res.height * 0.86);
    const y2 = Math.round(res.height * 0.6);

    try {
      await ctx.enqueue(async () => {
        await input.swipe(deviceId, x, y1, x, y2, 220);
      });
    } catch {}

    await sleep(240);

    // sau scroll, nếu nút copy link mất / UI đổi => smart-wait lại 1 nhịp ngắn
    for (const kw of keywords) {
      const rr = await waitForStableElement(deviceId, { desc: kw, text: kw }, 2200, 220).catch(() => null);
      if (rr?.ok) break;
    }
  }

  return false;
}


async function postJson(urlStr, bodyObj, timeoutMs = 12000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;

      const body = JSON.stringify(bodyObj || {});
      const opts = {
        method: "POST",
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = lib.request(opts, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const out = Buffer.concat(chunks).toString("utf8");
          const code = res.statusCode || 0;

          // ✅ Google Apps Script thường trả 302 + Location (redirect sang script.googleusercontent.com)
          // Nếu coi 302 là fail => queue không pop => push lại => trùng link hàng loạt
          const hasLocation = !!res.headers?.location;
          const ok =
            (code >= 200 && code < 300) ||
            (code >= 300 && code < 400 && hasLocation);

          resolve({ ok, code, out });
        });
      });

      req.on("error", (e) => resolve({ ok: false, code: 0, out: String(e) }));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("timeout"));
      });

      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, code: 0, out: String(e) });
    }
  });
}

// runtime state
const tiktok = {
  running: false,
  startedAt: 0,
  groupId: "",
  macroId: "",
  workers: new Map(), // deviceId -> { stop, stats }
  queue: [],
  flushing: false,
  flushTimer: null,
  lastFlushAt: 0,
  pushedCount: 0,
  failCount: 0,
};

function tiktokLog(msg, extra = {}) {
  logger?.info("tiktok", { msg, ...extra });
  safeSend("tiktok:log", { t: Date.now(), msg, ...extra });
}

// queue persistence
function loadQueueFromDisk() {
  try {
    const p = TIKTOK_QUEUE_FILE();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveQueueToDisk(arr) {
  try {
    const p = TIKTOK_QUEUE_FILE();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr, null, 2), "utf8");
  } catch {}
}

function enqueueLink(item) {
  if (!item?.url) return;
  tiktok.queue.push(item);
  saveQueueToDisk(tiktok.queue);
}

async function flushQueueIfNeeded(force = false) {
  tiktokLog("flush:check", {
    force,
    running: tiktok.running,
    qlen: tiktok.queue.length,
    lastFlushAt: tiktok.lastFlushAt,
    batchSize: tiktokConfig.batchSize,
    flushEveryMs: tiktokConfig.flushEveryMs,
  });

  if (tiktok.flushing) return;
  if (!tiktok.running && !force) return;

  const cfg = tiktokConfig;
  const qlen = tiktok.queue.length;

  const dueByCount = qlen >= (Number(cfg.batchSize) || 15);
  const dueByTime =
    qlen > 0 && Date.now() - (tiktok.lastFlushAt || 0) >= cfg.flushEveryMs;

  if (!force && !dueByCount && !dueByTime) return;
  if (qlen === 0) return;

  tiktok.flushing = true;
  try {
    const batchSize = Math.max(1, Number(cfg.batchSize) || 15);
    const batch = tiktok.queue.slice(0, batchSize);

    // POST each item (Apps Script appendRow). Bạn có thể đổi sang gửi array nếu muốn tối ưu.
    for (const it of batch) {
      const body = {
        token: cfg.token,
        groupId: it.groupId,
        deviceId: it.deviceId,
        url: it.url,
        ts: it.tsClientMs || it.ts || Date.now(),
        meta: {
          ...(it.meta || {}),
          hash: it.hash || sha1(it.url),
          receivedBy: "android-forge",
        },
      };

      let ok = false;
      try {
        const r = await postJson(cfg.endpointUrl, body, cfg.httpTimeoutMs);
        ok = !!r.ok;
        if (!ok) {
          tiktok.failCount++;
          tiktokLog("push:fail", {
            deviceId: it.deviceId,
            code: r.code,
            out: String(r.out || "").slice(0, 300),
          });
        }
      } catch (e) {
        tiktok.failCount++;
        tiktokLog("push:error", {
          deviceId: it.deviceId,
          err: String(e?.message || e || ""),
        });
        ok = false;
      }

      if (ok) {
        tiktokLog("push:ok", {
          deviceId: it.deviceId,
          url: maskUrl(it.url, 120),
        });

        tiktok.pushedCount++;
        // remove 1 from front (exact item)
        tiktok.queue.shift();
        saveQueueToDisk(tiktok.queue);
      } else {
        // stop flushing on first failure to avoid hammering
        break;
      }
    }

    tiktok.lastFlushAt = Date.now();
  } finally {
    tiktok.flushing = false;
    safeSend("tiktok:status", buildTikTokStatus());
  }
}

function buildTikTokStatus() {
  const devices = [];
  for (const [deviceId, w] of tiktok.workers.entries()) {
    devices.push({ deviceId, ...w.stats });
  }
  return {
    running: tiktok.running,
    startedAt: tiktok.startedAt,
    groupId: tiktok.groupId,
    macroId: tiktok.macroId,
    queueSize: tiktok.queue.length,
    pushedCount: tiktok.pushedCount,
    failCount: tiktok.failCount,
    lastFlushAt: tiktok.lastFlushAt,
    devices,
    config: { ...tiktokConfig, token: "***" },
  };
}

function startFlushTimer() {
  stopFlushTimer();
  tiktok.flushTimer = setInterval(
    () => {
      flushQueueIfNeeded(false).catch(() => {});
    },
    Math.max(1500, Number(tiktokConfig.flushEveryMs) || 15000),
  );
}

function stopFlushTimer() {
  if (tiktok.flushTimer) {
    clearInterval(tiktok.flushTimer);
    tiktok.flushTimer = null;
  }
}

async function swipeNext(ctx, opts) {
  const strong = !!opts?.strong;

  // ctx.snapshot() của bạn đa số là sync, nên gọi kiểu an toàn:
  const snap =
    typeof ctx.snapshot === "function" ? ctx.snapshot() : ctx.snapshot || {};
  const res = snap?.resolution || snap?.res || {};
  const w = res.width || snap?.w || snap?.width;
  const h = res.height || snap?.h || snap?.height;

  if (!w || !h) {
    tiktokLog("swipe:skip_no_resolution", {
      deviceId: ctx.deviceId,
      keys: Object.keys(snap || {}).slice(0, 20),
      hasResolution: !!snap?.resolution,
    });
    return;
  }

  // Vuốt thẳng đứng.
  // FIX: TikTok "photo-mode" / slideshow có dot-navigation ở giữa đáy màn hình.
  // Nếu swipe bắt đầu đúng vùng dots (x≈0.5, y≈0.8) thì TikTok dễ hiểu nhầm gesture và không lướt sang video tiếp theo.
  // → Chọn x lệch về trái + bắt đầu cao hơn một chút để tránh dots.
  const xPct = 0.25 + Math.random() * 0.06; // tránh caption bên trái quá sát + né icon bên phải
  const x = Math.round(w * xPct);

  // Vuốt bắt đầu ở giữa màn hình (cao hơn vùng dots) để tránh bị "kẹt" slideshow.
  const y1 = Math.round(h * (strong ? 0.68 : 0.65));
  const y2 = Math.round(h * (strong ? 0.05 : 0.12));
  const dur = strong ? 650 : 440;

  await input.swipe(ctx.deviceId, x, y1, x, y2, dur);

  // Nếu đang ở photo-mode/dot-navigation, đôi khi cần 2 lần vuốt mạnh để thoát.
  if (strong) {
    await sleep(160);
    await input.swipe(ctx.deviceId, x, y1, x, y2, 560);
  }

  tiktokLog("swipe:done", {
    deviceId: ctx.deviceId,
    strong,
    x,
    y1,
    y2,
    dur,
    w,
    h,
  });
}

async function isLiveScreen(deviceId, cfg) {
  const kws = Array.isArray(cfg.liveKeywords) ? cfg.liveKeywords : [];
  const minHits = Math.max(1, Number(cfg.liveMinHits) || 2);

  let hit = 0;
  for (const kw of kws) {
    const r = await agentFindText(deviceId, kw);
    if (r?.found) {
      hit++;
      if (hit >= minHits) return true;
    }
  }
  return false;
}

async function runTikTokWorker(deviceId, groupId, macroId) {
  const ctx0 = registry.get(deviceId);
  if (!ctx0) return;

  const state = tiktok.workers.get(deviceId);
  if (!state) return;

  state.stats = state.stats || {};
  state.stats.deviceId = deviceId;
  state.stats.ok = state.stats.ok || 0;
  state.stats.fail = state.stats.fail || 0;
  state.stats.liveSkip = state.stats.liveSkip || 0;
  state.stats.liveConsecutive = state.stats.liveConsecutive || 0;
  state.stats.lastUrl = state.stats.lastUrl || "";
  state.stats.lastErr = state.stats.lastErr || "";
  state.stats.shareFailStreak = state.stats.shareFailStreak || 0;
  state.stats.copyFailStreak = state.stats.copyFailStreak || 0;

  tiktokLog("worker:start", { deviceId, groupId, macroId });

  while (tiktok.running && !state.stop) {
    const cfg = tiktokConfig; // ✅ tiktokConfig là OBJECT, không phải function

    try {
      const ctx = registry.get(deviceId);
      if (!ctx || ctx.state !== "ONLINE") {
        state.stats.lastErr = "offline";
        await sleep(600);
        continue;
      }

      const snap = ctx.snapshot?.() || {};
      if (!snap.agentReady) {
        state.stats.lastErr = "agent_not_ready";
        await sleep(650);
        continue;
      }

      // ===== LIVE detect =====
      const live = await isLiveScreen(deviceId, cfg);
      if (live) {
        state.stats.liveSkip++;
        state.stats.liveConsecutive++;

        await ctx.enqueue(async () => {
          await swipeNext(ctx, { strong: true });
        });

        if (
          state.stats.liveConsecutive >= (Number(cfg.liveMaxConsecutive) || 3)
        ) {
          tiktokLog("live:stuck", { deviceId, n: state.stats.liveConsecutive });
          state.stats.liveConsecutive = 0;
          await closeShareSheetIfOpen(ctx);
          await sleep(200);
        }

        state.stats.lastAt = Date.now();
        safeSend("tiktok:status", buildTikTokStatus());
        await sleep(Math.max(80, cfg.loopDelayMs));
        continue;
      }

      state.stats.liveConsecutive = 0;

      // ===== Baseline (chỉ để log) =====
      let baselineUrl = "";
      try {
        const bA = await agentClipboardGet(deviceId).catch(() => "");
        const bH = hostClipboardGet();
        baselineUrl = extractTikTokUrl(bA) || extractTikTokUrl(bH) || "";
      } catch {}

      const maxAttempts = Math.max(1, Number(cfg.copyAttemptsPerVideo) || 1);

      let success = false;
      let finalUrl = "";
      let finalStatus = "";
      let failReason = "";
      let forceSwipe = false;

      for (let attempt = 1; attempt <= maxAttempts && !success; attempt++) {
        tiktokLog("sm:begin", {
          deviceId,
          attempt,
          baseline: maskUrl(baselineUrl, 80),
        });

        // OPEN_SHARE
        let opened = false;
        try {
          opened = await openShareSheet(ctx);
        } catch {
          opened = false;
        }
        tiktokLog("sm:share", { deviceId, attempt, opened });

        if (!opened) {
          state.stats.shareFailStreak++;
          failReason = "share_not_opened";
          await closeShareSheetIfOpen(ctx);
          await sleep(220);

          // nếu fail liên tục -> force swipe mạnh để thoát slideshow/kẹt UI
          if (
            state.stats.shareFailStreak >= (Number(cfg.swipeOnFailAfter) || 1)
          ) {
            forceSwipe = true;
          }
          continue;
        } else {
          state.stats.shareFailStreak = 0;
        }

        // CLICK_COPY + WAIT_CLIPBOARD (mutex)
        let clicked = false;
        let w = null;

        await withClipboardMutex(async () => {
          const baseA = await agentClipboardGet(deviceId).catch(() => "");
          const baseH = hostClipboardGet();

          try {
            clicked = await clickCopyLinkOnShareSheet(ctx);
          } catch {
            clicked = false;
          }
          tiktokLog("sm:copybtn", { deviceId, attempt, clicked });

          // ✅ gọi đúng signature positional
          w = await waitClipboardTikTokUrlAny(
            deviceId,
            baseA,
            baseH,
            cfg,
          ).catch((e) => ({
            ok: false,
            status: "error",
            reason: String(e?.message || e || ""),
          }));
        });

        await closeShareSheetIfOpen(ctx);

        // ✅ chỉ success khi status === "ok" và có url
        if (w?.ok && w.status === "ok" && w.url) {
          tiktokLog("sm:clipboard:ok", {
            deviceId,
            attempt,
            status: w.status,
            elapsedMs: w.elapsedMs,
            tries: w.tries,
            url: maskUrl(w.url, 120),
          });

          success = true;
          finalUrl = w.url || "";
          finalStatus = w.status || "ok";
          failReason = "";
        } else {
          tiktokLog("sm:clipboard:fail", {
            deviceId,
            attempt,
            status: w?.status || "fail",
            reason:
              w?.reason ||
              (w?.status === "dup"
                ? "same_as_baseline"
                : clicked
                  ? "clipboard_timeout"
                  : "copybtn_not_clicked"),
            elapsedMs: w?.elapsedMs || 0,
            tries: w?.tries || 0,
          });

          success = false;
          finalUrl = "";
          finalStatus = w?.status || "timeout";
          failReason =
            w?.reason ||
            (w?.status === "dup"
              ? "same_as_baseline"
              : clicked
                ? "clipboard_timeout"
                : "copybtn_not_clicked");

          // nếu dup/timeout liên tục -> force swipe mạnh
          if (w?.status === "dup" || w?.status === "timeout") {
            forceSwipe = true;
          }
        }

        if (!success) await sleep(240);
      }

      // ===== ENQUEUE / DEDUPE =====
      if (success && finalUrl && isTikTokUrl(finalUrl)) {
        const url = extractTikTokUrl(finalUrl) || String(finalUrl || "").trim();

        if (url && url === state.stats.lastUrl) {
          tiktokLog("copy:dup", {
            deviceId,
            url: maskUrl(url, 120),
            status: finalStatus,
          });
          // dup_same_as_last => coi như fail để swipe mạnh thoát kẹt
          state.stats.fail++;
          state.stats.lastErr = "dup_same_as_last";
          state.stats.copyFailStreak++;
          forceSwipe = true;
        } else {
          const item = {
            groupId,
            deviceId,
            url,
            tsClientMs: Date.now(),
            hash: sha1(url),
            meta: { note: "TikTokHarvest" },
          };

          enqueueLink(item); // ✅ persist queue
          state.stats.ok++;
          state.stats.lastUrl = url;
          state.stats.lastErr = "";
          state.stats.copyFailStreak = 0;

          tiktokLog("copy:ok", {
            deviceId,
            url: maskUrl(url, 120),
            status: finalStatus,
          });
          await flushQueueIfNeeded(false);
        }
      } else {
        state.stats.fail++;
        state.stats.lastErr = failReason || "copy_not_confirmed";
        state.stats.copyFailStreak++;

        tiktokLog("copy:fail", {
          deviceId,
          reason: state.stats.lastErr,
          baseline: maskUrl(baselineUrl, 80),
          failStreak: state.stats.copyFailStreak,
        });

        await closeShareSheetIfOpen(ctx);
      }

      // ===== SWIPE policy =====
      const swipeOnFailAfter = Math.max(1, Number(cfg.swipeOnFailAfter) || 1);
      const shouldSwipe =
        !!cfg.swipeAfterEach &&
        (success ||
          forceSwipe ||
          state.stats.copyFailStreak >= swipeOnFailAfter);

      if (shouldSwipe) {
        await ctx.enqueue(async () => {
          await swipeNext(ctx, { strong: forceSwipe });
        });

        tiktokLog("sm:swipe", {
          deviceId,
          strong: !!forceSwipe,
          success,
          failStreak: state.stats.copyFailStreak,
        });

        if (!success) state.stats.copyFailStreak = 0;
      } else {
        await sleep(300);
      }

      state.stats.lastAt = Date.now();
      safeSend("tiktok:status", buildTikTokStatus());
      await sleep(Math.max(40, cfg.loopDelayMs));
    } catch (e) {
      state.stats.fail++;
      state.stats.lastErr = String(e?.message || e || "");
      tiktokLog("worker:error", {
        deviceId,
        err: state.stats.lastErr.slice(0, 200),
      });
      safeSend("tiktok:status", buildTikTokStatus());
      await sleep(650);
    }
  }

  tiktokLog("worker:stop", { deviceId });
}

async function tiktokStartRuntime({ groupId, macroId, configPatch }) {
  // stop existing
  await tiktokStopRuntime();

  // patch config (optional)
  if (configPatch && typeof configPatch === "object") {
    tiktokConfig = { ...tiktokConfig, ...configPatch };
    setLayoutConfig({ tiktokConfig }); // persist + sanitize
  }

  const gid = String(groupId || tiktokConfig.groupId || "").trim();
  const mid = String(macroId || tiktokConfig.macroId || "").trim();
  if (!gid) throw new Error("groupId required");
  // if (!mid) throw new Error("macroId required");

  const g = groupManager.get(gid);
  if (!g) throw new Error(`group not found: ${gid}`);

  const ids = Array.from(g.devices || []);
  if (!ids.length) throw new Error("group is empty");

  // queue load
  tiktok.queue = loadQueueFromDisk();

  tiktok.running = true;
  tiktok.lastFlushAt = 0;
  tiktok.pushedCount = 0;
  tiktok.failCount = 0;

  tiktok.startedAt = Date.now();
  tiktok.groupId = gid;
  tiktok.macroId = mid;

  // persist chosen ids
  tiktokConfig.groupId = gid;
  tiktokConfig.macroId = mid;
  setLayoutConfig({ tiktokConfig });

  // workers
  tiktok.workers.clear();
  for (const did of ids) {
    tiktok.workers.set(did, { stop: false, stats: {} });
  }

  startFlushTimer();
  safeSend("tiktok:status", buildTikTokStatus());
  tiktokLog("harvest:start", {
    groupId: gid,
    macroId: mid,
    devices: ids.length,
  });

  // run in background (still in same process)
  for (const did of ids) {
    runTikTokWorker(did, gid, mid).catch((e) => {
      tiktokLog("worker:spawn_error", {
        deviceId: did,
        err: String(e?.message || e || "").slice(0, 200),
      });
    });
    await sleep(120);
  }
}

async function tiktokStopRuntime() {
  if (!tiktok.running && tiktok.workers.size === 0) {
    stopFlushTimer();
    return;
  }

  tiktok.running = false;
  for (const [_, w] of tiktok.workers.entries()) {
    w.stop = true;
  }
  stopFlushTimer();

  // force flush remaining (best effort)
  try {
    await flushQueueIfNeeded(true);
  } catch {}

  tiktokLog("harvest:stop", { queueLeft: tiktok.queue.length });
  safeSend("tiktok:status", buildTikTokStatus());
}

// ===============================

app.whenReady().then(() => {
  // init window first for log streaming
  mainWindow = createWindow();

  logger = new Logger({
    userDataPath: app.getPath("userData"),
    onLine: (line) => safeSend("log:line", line),
  });

  attachProcessGuards();

  // load settings
  const saved = readSettingsFile();
  if (saved && typeof saved === "object") {
    setDeviceOrder(saved.deviceOrder || []);
    layoutConfig.scalePct = normalizeScalePct(
      saved.scalePct ?? layoutConfig.scalePct,
    );
    layoutConfig.cols = clampInt(saved.cols ?? layoutConfig.cols, 1, 20);
    layoutConfig.rows = clampInt(saved.rows ?? layoutConfig.rows, 0, 20);
    layoutConfig.margin = clampInt(saved.margin ?? layoutConfig.margin, 0, 60);
    layoutConfig.forceResizeOnApply = !!(
      saved.forceResizeOnApply ?? layoutConfig.forceResizeOnApply
    );

    layoutConfig.autoStartEnabled = !!(
      saved.autoStartEnabled ?? layoutConfig.autoStartEnabled
    );
    layoutConfig.autoWakeOnRecover = !!(
      saved.autoWakeOnRecover ?? layoutConfig.autoWakeOnRecover
    );

    if (Array.isArray(saved.groups)) {
      groupManager = new GroupManager(saved.groups);
    }

    if (
      saved.broadcastDefaults &&
      typeof saved.broadcastDefaults === "object"
    ) {
      broadcastDefaults = { ...broadcastDefaults, ...saved.broadcastDefaults };
    }
    if (
      saved.groupMacroDefaults &&
      typeof saved.groupMacroDefaults === "object"
    ) {
      groupMacroDefaults = {
        ...groupMacroDefaults,
        ...saved.groupMacroDefaults,
      };
    }
    if (saved.deviceAliases && typeof saved.deviceAliases === "object") {
      deviceAliases = { ...saved.deviceAliases };
      for (const k of Object.keys(deviceAliases)) {
        const v = String(deviceAliases[k] ?? "").trim();
        if (!v) delete deviceAliases[k];
        else deviceAliases[k] = v;
      }
    }

    if (saved.tiktokConfig && typeof saved.tiktokConfig === "object") {
      tiktokConfig = { ...tiktokConfig, ...saved.tiktokConfig };
    }

    if (saved.igConfig && typeof saved.igConfig === "object") {
      igConfig = { ...igConfig, ...saved.igConfig };
      igConfig.macroId = String(igConfig.macroId || "").trim();
      igConfig.songText = String(igConfig.songText || "");
    }
  }

  initGroupBroadcast();
  attachRegistryLoggingAndRecover();

  // start polling after listeners attached
  registry.startPolling(1500);

  // scrcpy close handling
  scrcpy.on("closed", ({ deviceId, code, signal }) => {
    freeSlot(deviceId);
    safeSend("scrcpy:closed", { deviceId, code, signal });

    logger?.audit("scrcpy:closed", { deviceId, code, signal });

    if (layoutConfig.autoStartEnabled) {
      autoRecoverScrcpy(deviceId, "scrcpy_closed");
    }
  });

  // ========= IPC: logs =========
  ipcMain.handle("log:tail", async (_, { maxLines }) => {
    return logger?.tailLines(Number(maxLines) || 250) || [];
  });

  // ========= devices =========
  ipcMain.handle("devices:list", async () => {
    const list = registry.listSnapshots();
    const sorted = sortDevicesByOrder(list);
    return sorted.map((d) => ({
      ...d,
      alias: deviceAliases[d.deviceId] || "",
    }));
  });

  // alias get/set
  ipcMain.handle("device:aliasSet", async (_, { deviceId, alias }) => {
    const r = setDeviceAlias(deviceId, alias);
    logger?.audit("device:aliasSet", { deviceId, alias: r.alias || "" });
    return r;
  });

  ipcMain.handle("device:aliasGetAll", async () => {
    return { ...deviceAliases };
  });

  // layout
  ipcMain.handle("layout:get", async () => getLayoutConfig());
  ipcMain.handle("layout:set", async (_, patch) => {
    setLayoutConfig(patch);
    logger?.audit("layout:set", {
      autoStartEnabled: layoutConfig.autoStartEnabled,
      autoWakeOnRecover: layoutConfig.autoWakeOnRecover,
      scalePct: layoutConfig.scalePct,
      cols: layoutConfig.cols,
      rows: layoutConfig.rows,
      margin: layoutConfig.margin,
      hasTikTok: !!tiktokConfig?.endpointUrl,
    });
    return getLayoutConfig();
  });

  // ========= scrcpy lifecycle =========
  ipcMain.handle("scrcpy:start", async (_, { deviceId }) => {
    const cfg = getLayoutConfig();
    const ctx = ensureOnline(registry.get(deviceId));
    const snap = ctx.snapshot();

    ensureInOrder(deviceId);

    const slotIndex = Math.max(0, deviceOrder.indexOf(deviceId));
    allocSlot(deviceId);
    const port = portForSlot(slotIndex);

    const { width, height, maxSize } = computeScrcpyCellAndMaxSize(
      snap,
      cfg.scalePct,
    );

    await scrcpy.start(deviceId, {
      maxFps: 30,
      bitRate: "8M",
      port,
      window: {
        width,
        height,
        maxSize,
        layout: {
          mode: "grid",
          slotIndex,
          cols: cfg.cols,
          rows: cfg.rows > 0 ? cfg.rows : null,
          margin: cfg.margin,
        },
        borderless: false,
        alwaysOnTop: false,
        timeoutMs: 15000,
      },
      zOrder: { sendToBottom: true, noActivate: true },
    });

    logger?.audit("scrcpy:start", { deviceId });
    return { ok: true };
  });

  ipcMain.handle("scrcpy:stop", async (_, { deviceId }) => {
    await scrcpy.stop(deviceId);
    freeSlot(deviceId);
    logger?.audit("scrcpy:stop", { deviceId });
    return true;
  });

  ipcMain.handle("scrcpy:isRunning", async (_, { deviceId }) => {
    return scrcpy.isRunning(deviceId);
  });

  ipcMain.handle("scrcpy:startAll", async () => {
    const cfg = getLayoutConfig();
    const online = registry.listSnapshots().filter((d) => d.state === "ONLINE");

    for (const d of online) ensureInOrder(d.deviceId);

    const orderedOnline = sortDevicesByOrder(online);
    const started = [];

    for (const d of orderedOnline) {
      try {
        const ctx = ensureOnline(registry.get(d.deviceId));
        const snap = ctx.snapshot();

        const slotIndex = Math.max(0, deviceOrder.indexOf(d.deviceId));
        allocSlot(d.deviceId);
        const port = portForSlot(slotIndex);

        const { width, height, maxSize } = computeScrcpyCellAndMaxSize(
          snap,
          cfg.scalePct,
        );

        await scrcpy.start(d.deviceId, {
          maxFps: 30,
          bitRate: "8M",
          port,
          window: {
            width,
            height,
            maxSize,
            layout: {
              mode: "grid",
              slotIndex,
              cols: cfg.cols,
              rows: cfg.rows > 0 ? cfg.rows : null,
              margin: cfg.margin,
            },
            borderless: false,
            alwaysOnTop: false,
            timeoutMs: 15000,
          },
          zOrder: { sendToBottom: true, noActivate: true },
        });

        started.push(d.deviceId);
        logger?.audit("scrcpy:startAll:item", { deviceId: d.deviceId });
      } catch (e) {
        logger?.error("scrcpy:startAll:itemFail", {
          deviceId: d.deviceId,
          message: String(e?.message || e || ""),
        });
      }

      await sleep(180);
    }

    logger?.audit("scrcpy:startAll", { count: started.length });
    return started;
  });

  ipcMain.handle("scrcpy:stopAll", async () => {
    await scrcpy.stopAll();
    slotByDevice.clear();
    nextSlot = 0;
    logger?.audit("scrcpy:stopAll", {});
    return true;
  });

  ipcMain.handle("scrcpy:applyLayout", async (_, payload = {}) => {
    const cfg = getLayoutConfig();
    const forceResize =
      payload.forceResize != null
        ? !!payload.forceResize
        : !!cfg.forceResizeOnApply;

    const all = registry.listSnapshots();
    const runningOnline = all.filter(
      (d) => d.state === "ONLINE" && scrcpy.isRunning(d.deviceId),
    );

    const ordered = sortDevicesByOrder(runningOnline);

    const items = ordered.map((d) => {
      const s = scrcpy.procs.get(d.deviceId);
      return {
        deviceId: d.deviceId,
        title: s?.title || `forge:${d.deviceId}`,
        slotIndex: Math.max(0, deviceOrder.indexOf(d.deviceId)),
      };
    });

    let cell = { width: 360, height: 780, maxSize: 540 };
    if (ordered.length) {
      const ctx = registry.get(ordered[0].deviceId);
      if (ctx) cell = computeScrcpyCellAndMaxSize(ctx.snapshot(), cfg.scalePct);
    }

    await scrcpy.applyLayout(
      items,
      {
        mode: "grid",
        cols: cfg.cols,
        rows: cfg.rows > 0 ? cfg.rows : null,
        margin: cfg.margin,
      },
      { width: cell.width, height: cell.height },
      {
        forceSize: forceResize,
        sendToBottom: true,
        noActivate: true,
        timeoutMs: 15000,
      },
    );

    logger?.audit("scrcpy:applyLayout", { count: items.length, forceResize });
    return { ok: true, count: items.length, forceResize };
  });

  // ========= Control panel actions =========
  ipcMain.handle("control:home", async (_, { deviceId }) => {
    logger?.audit("control:home", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.home(deviceId));
  });

  ipcMain.handle("control:back", async (_, { deviceId }) => {
    logger?.audit("control:back", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.back(deviceId));
  });

  ipcMain.handle("control:recents", async (_, { deviceId }) => {
    logger?.audit("control:recents", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.recents(deviceId));
  });

  ipcMain.handle("control:wake", async (_, { deviceId }) => {
    logger?.audit("control:wake", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.wake(deviceId));
  });

  ipcMain.handle("control:screenOff", async (_, { deviceId }) => {
    logger?.audit("control:screenOff", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.screenOff(deviceId));
  });

  ipcMain.handle("control:shutdown", async (_, { deviceId }) => {
    logger?.audit("control:shutdown", { deviceId });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(() => input.shutdown(deviceId));
  });

  ipcMain.handle("control:tapRaw", async (_, { deviceId, x, y }) => {
    logger?.audit("control:tapRaw", { deviceId, x, y });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const px = rawToPx(x, res.width);
      const py = rawToPx(y, res.height);

      if (recorder.isRecording()) {
        const xp = rawToPct(x, res.width);
        const yp = rawToPct(y, res.height);
        recorder.recordTapPct(xp, yp);
      }

      return input.tap(deviceId, px, py);
    });
  });

  // pct-based tap (0..1). Useful for UI-driven actions (e.g. Instagram random pick)
  // opts.record=true will also push TAP into recorder when recording.
  ipcMain.handle("control:tapPct", async (_, { deviceId, xPct, yPct, opts }) => {
    logger?.audit("control:tapPct", { deviceId, xPct, yPct, opts });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const xp = Math.max(0, Math.min(1, Number(xPct)));
      const yp = Math.max(0, Math.min(1, Number(yPct)));

      const px = Math.max(0, Math.min(res.width - 1, Math.round(xp * res.width)));
      const py = Math.max(
        0,
        Math.min(res.height - 1, Math.round(yp * res.height))
      );

      const record = !!(opts && typeof opts === "object" && opts.record);
      if (record && recorder.isRecording()) {
        recorder.recordTapPct(xp, yp);
      }

      return input.tap(deviceId, px, py);
    });
  });

  // TEXT inject into focused input (requires Accessibility agent)
  ipcMain.handle("control:text", async (_, { deviceId, text }) => {
    logger?.audit("control:text", { deviceId, text: String(text || "").slice(0, 80) });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(async () => {
      return inputSmart.text(ctx, String(text ?? ""));
    });
  });

  ipcMain.handle("control:swipeRaw", async (_, payload) => {
    logger?.audit("control:swipeRaw", payload);
    const ctx = ensureOnline(registry.get(payload.deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const x1 = rawToPx(payload.x1, res.width);
      const y1 = rawToPx(payload.y1, res.height);
      const x2 = rawToPx(payload.x2, res.width);
      const y2 = rawToPx(payload.y2, res.height);

      const dur = Number(payload.durationMs) || 220;

      if (recorder.isRecording()) {
        const x1p = rawToPct(payload.x1, res.width);
        const y1p = rawToPct(payload.y1, res.height);
        const x2p = rawToPct(payload.x2, res.width);
        const y2p = rawToPct(payload.y2, res.height);
        recorder.recordSwipePct(x1p, y1p, x2p, y2p, dur);
      }

      return input.swipe(payload.deviceId, x1, y1, x2, y2, dur);
    });
  });

  ipcMain.handle("control:swipeDir", async (_, { deviceId, dir }) => {
    logger?.audit("control:swipeDir", { deviceId, dir });
    const ctx = ensureOnline(registry.get(deviceId));
    return ctx.enqueue(async () => {
      const snap = ctx.snapshot();
      const res = snap.resolution;
      if (!res?.width || !res?.height)
        throw new Error("Device resolution not ready yet (wait 1-2s)");

      const w = res.width;
      const h = res.height;

      const xMid = Math.round(w * 0.5);
      const yMid = Math.round(h * 0.5);

      const xL = Math.round(w * 0.2);
      const xR = Math.round(w * 0.8);
      const yT = Math.round(h * 0.25);
      const yB = Math.round(h * 0.75);

      const d = String(dir || "").toLowerCase();
      if (d === "up") return input.swipe(deviceId, xMid, yB, xMid, yT, 220);
      if (d === "down") return input.swipe(deviceId, xMid, yT, xMid, yB, 220);
      if (d === "left") return input.swipe(deviceId, xR, yMid, xL, yMid, 220);
      if (d === "right") return input.swipe(deviceId, xL, yMid, xR, yMid, 220);

      throw new Error("Unknown dir");
    });
  });

  // ========= Macro IPC =========
  ipcMain.handle("macro:list", async () => listMacros(app.getPath("userData")));

  ipcMain.handle("macro:recordStart", async (_, { deviceId }) => {
    logger?.audit("macro:recordStart", { deviceId });

    const ctx = ensureOnline(registry.get(deviceId));
    const snap = ctx.snapshot();
    const res = snap.resolution;
    if (!res?.width || !res?.height)
      throw new Error("Device resolution not ready yet");

    const running = scrcpy.isRunning(deviceId);
    if (!running)
      throw new Error(
        "scrcpy is not running for this device. Start scrcpy first.",
      );

    recorder.start({ deviceId, deviceRes: res });

    await hook.start({
      deviceId,
      deviceRes: res,
      onStep: (s) => {
        if (s.type === "TAP") {
          const r = recorder.recordTapPct(s.xPct, s.yPct);
          if (r && r.captured) {
            safeSend("macro:randPointsCount", { count: r.count ?? 0 });
          }
        }
        if (s.type === "LONG_PRESS")
          recorder.recordLongPressPct(s.xPct, s.yPct, s.durationMs);
        if (s.type === "SWIPE")
          recorder.recordSwipePct(
            s.x1Pct,
            s.y1Pct,
            s.x2Pct,
            s.y2Pct,
            s.durationMs,
          );
      },
    });

    return { ok: true };
  });

  ipcMain.handle("macro:recordStop", async () => {
    logger?.audit("macro:recordStop", {});
    try {
      hook.stop();
    } catch {}
    const { steps } = recorder.stop();
    return { ok: true, steps };
  });

  ipcMain.handle("macro:recordAddText", async (_, { text }) => {
    logger?.audit("macro:recordAddText", { text });
    recorder.injectText(text);

    // ✅ UX improvement: while recording, also type the text into the currently focused field
    // (needed for Instagram music search: user taps search field -> Add TEXT -> continue selecting song)
    try {
      if (recorder.isRecording()) {
        const deviceId = recorder.getDeviceId();
        const ctx = deviceId ? registry.get(deviceId) : null;
        if (ctx && ctx.state === "ONLINE") {
          await ctx.enqueue(async () => inputSmart.text(ctx, String(text ?? "")));
        }
      }
    } catch {}

    return { ok: true };
  });

  ipcMain.handle("macro:recordAddKey", async (_, { key }) => {
    logger?.audit("macro:recordAddKey", { key });
    recorder.injectKey(key);
    return { ok: true };
  });

  ipcMain.handle("macro:recordAddWait", async (_, { durationMs }) => {
    logger?.audit("macro:recordAddWait", { durationMs });
    recorder.injectWait(durationMs);
    return { ok: true };
  });

  // Special step: random pick media (Instagram picker)
  ipcMain.handle("macro:recordAddRandomPick", async (_, cfg) => {
    logger?.audit("macro:recordAddRandomPick", cfg);
    recorder.injectRandomPickMedia(cfg || {});
    return { ok: true };
  });

  // =============================
  // ✅ Instagram Upload helper: record-time random thumbnail points
  // =============================
  ipcMain.handle("macro:randPointsStart", async () => {
    logger?.audit("macro:randPointsStart", {});
    const r = recorder.randPointsStart();
    if (r?.ok) safeSend("macro:randPointsCount", { count: 0 });
    return r;
  });

  ipcMain.handle("macro:randPointsStop", async () => {
    logger?.audit("macro:randPointsStop", {});
    const r = recorder.randPointsStop();
    if (r?.ok) safeSend("macro:randPointsCount", { count: r.count ?? 0 });
    return r;
  });

  ipcMain.handle("macro:save", async (_, { name, description, steps }) => {
    const id =
      String(name || "")
        .trim()
        .replace(/\s+/g, "_")
        .toLowerCase() || randomUUID();

    const macro = {
      meta: {
        id,
        name: name || id,
        description: description || "",
        version: 2,
        createdAt: Date.now(),
      },
      settings: {
        randomize: { xyJitterPct: 0.003, delayJitterPct: 0.12 },
        playbackSpeed: 1.0,
      },
      steps: Array.isArray(steps) ? steps : [],
    };

    logger?.audit("macro:save", {
      id,
      name: macro.meta.name,
      steps: macro.steps.length,
    });
    return saveMacro(app.getPath("userData"), macro);
  });

  ipcMain.handle("macro:load", async (_, { id }) => {
    logger?.audit("macro:load", { id });
    return loadMacro(app.getPath("userData"), id);
  });

  ipcMain.handle("macro:play", async (_, { deviceId, macroId, options }) => {
    logger?.audit("macro:play", { deviceId, macroId, options });

    const ctx = ensureOnline(registry.get(deviceId));
    const macro = loadMacro(app.getPath("userData"), macroId);

    const stepsLen = Array.isArray(macro?.steps) ? macro.steps.length : 0;
    if (!stepsLen) throw new Error("Macro has no steps: " + macroId);

    if (runningMacroByDevice.has(deviceId)) {
      throw new Error("Macro already running on this device. Stop it first.");
    }

    const state = {
      stop: false,
      token: Date.now(),
      startedAt: Date.now(),
      macroId,
      source: "single",
    };
    runningMacroByDevice.set(deviceId, state);

    const lc = parseLoopCount(options?.loop);
    const loopCountForUi = lc.infinite ? 0 : lc.total;

    sendMacroState(deviceId, {
      running: true,
      macroId,
      loopCount: loopCountForUi,
      loopIndex: 1,
    });

    return ctx.enqueue(async () => {
      try {
        for (let li = 0; lc.infinite || li < lc.total; li++) {
          if (state.stop) break;

          const loopIndexForUi = li + 1;

          await runMacroOnDevice(ctx, macro, options || {}, {
            shouldStop: () => state.stop,
            token: state.token,
            onProgress: (p) =>
              sendMacroProgress(deviceId, {
                ...p,
                loopIndex: loopIndexForUi,
                loopCount: loopCountForUi,
              }),
          });
        }

        return { ok: true };
      } finally {
        runningMacroByDevice.delete(deviceId);
        sendMacroState(deviceId, { running: false, macroId: "" });
      }
    });
  });

  ipcMain.handle("macro:stop", async (_, { deviceId }) => {
    logger?.audit("macro:stop", { deviceId });
    const s = runningMacroByDevice.get(deviceId);
    if (s) {
      s.stop = true;
      s.token = Date.now();
    }
    return { ok: true };
  });

  // ========= Groups IPC =========
  ipcMain.handle("group:list", async () => groupManager.list());

  ipcMain.handle("group:create", async (_, { id, name }) => {
    const g = groupManager.create(id, name);
    persistSettings();
    logger?.audit("group:create", { id: g.id, name: g.name });
    return {
      ok: true,
      group: { id: g.id, name: g.name, devices: Array.from(g.devices) },
    };
  });

  ipcMain.handle("group:rename", async (_, { id, name }) => {
    const g = groupManager.rename(id, name);
    persistSettings();
    logger?.audit("group:rename", { id: g.id, name: g.name });
    return {
      ok: true,
      group: { id: g.id, name: g.name, devices: Array.from(g.devices) },
    };
  });

  ipcMain.handle("group:remove", async (_, { id }) => {
    groupManager.remove(id);
    persistSettings();
    logger?.audit("group:remove", { id });
    return { ok: true };
  });

  ipcMain.handle("group:addDevice", async (_, { groupId, deviceId }) => {
    groupManager.addDevice(groupId, deviceId);
    persistSettings();
    logger?.audit("group:addDevice", { groupId, deviceId });
    return { ok: true };
  });

  ipcMain.handle("group:removeDevice", async (_, { groupId, deviceId }) => {
    groupManager.removeDevice(groupId, deviceId);
    persistSettings();
    logger?.audit("group:removeDevice", { groupId, deviceId });
    return { ok: true };
  });

  // ---- Group Broadcast ----
  ipcMain.handle("group:tapPct", async (_, { groupId, xPct, yPct, opts }) => {
    logger?.audit("group:tapPct", { groupId, xPct, yPct, opts });
    return groupBroadcast.tapPct(
      groupId,
      Number(xPct),
      Number(yPct),
      opts || {},
    );
  });

  ipcMain.handle(
    "group:swipePct",
    async (_, { groupId, x1Pct, y1Pct, x2Pct, y2Pct, durationMs, opts }) => {
      logger?.audit("group:swipePct", {
        groupId,
        x1Pct,
        y1Pct,
        x2Pct,
        y2Pct,
        durationMs,
        opts,
      });
      return groupBroadcast.swipePct(
        groupId,
        Number(x1Pct),
        Number(y1Pct),
        Number(x2Pct),
        Number(y2Pct),
        Number(durationMs || 220),
        opts || {},
      );
    },
  );

  ipcMain.handle("group:swipeDir", async (_, { groupId, dir, opts }) => {
    logger?.audit("group:swipeDir", { groupId, dir, opts });
    return groupBroadcast.swipeDir(groupId, dir, opts || {});
  });

  ipcMain.handle("group:key", async (_, { groupId, key, opts }) => {
    logger?.audit("group:key", { groupId, key, opts });
    return groupBroadcast.key(groupId, key, opts || {});
  });

  ipcMain.handle("group:wake", async (_, { groupId, opts }) => {
    logger?.audit("group:wake", { groupId, opts });
    return groupBroadcast.wake(groupId, opts || {});
  });

  ipcMain.handle("group:screenOff", async (_, { groupId, opts }) => {
    logger?.audit("group:screenOff", { groupId, opts });
    return groupBroadcast.screenOff(groupId, opts || {});
  });

  ipcMain.handle("group:shutdown", async (_, { groupId, opts }) => {
    logger?.audit("group:shutdown", { groupId, opts });
    return groupBroadcast.shutdown(groupId, opts || {});
  });

  // ---- Group Macro ----
  ipcMain.handle(
    "group:macroPlay",
    async (_, { groupId, macroId, options, fanoutOpts }) => {
      logger?.audit("group:macroPlay", {
        groupId,
        macroId,
        options,
        fanoutOpts,
      });
      return groupBroadcast.playMacro(
        groupId,
        macroId,
        options || {},
        fanoutOpts || {},
      );
    },
  );

  ipcMain.handle("group:macroStopGroup", async (_, { groupId }) => {
    logger?.audit("group:macroStopGroup", { groupId });
    return groupBroadcast.stopGroup(groupId);
  });

  ipcMain.handle("group:macroStopDevice", async (_, { groupId, deviceId }) => {
    logger?.audit("group:macroStopDevice", { groupId, deviceId });
    return groupBroadcast.stopDevice(groupId, deviceId);
  });

  ipcMain.handle("group:macroSnapshot", async (_, { groupId }) => {
    return groupBroadcast.snapshot(groupId);
  });

  // ======================
  // TikTok Harvest IPC (NEW)
  // ======================
  ipcMain.handle("tiktok:status", async () => {
    return buildTikTokStatus();
  });

  ipcMain.handle("tiktok:start", async (_, payload = {}) => {
    const groupId = String(
      payload.groupId || tiktokConfig.groupId || "",
    ).trim();
    const macroId = String(
      payload.macroId || tiktokConfig.macroId || "",
    ).trim();
    const configPatch =
      payload.config && typeof payload.config === "object"
        ? payload.config
        : {};

    logger?.audit("tiktok:start", { groupId, macroId });

    await tiktokStartRuntime({ groupId, macroId, configPatch });
    return buildTikTokStatus();
  });

  ipcMain.handle("tiktok:stop", async () => {
    logger?.audit("tiktok:stop", {});
    await tiktokStopRuntime();
    return buildTikTokStatus();
  });

  app.on("before-quit", () => {
    persistSettings();
    logger?.info("app:beforeQuit", {});
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  // show last log lines in UI quickly
  try {
    const tail = logger.tailLines(120);
    for (const line of tail) safeSend("log:line", line);
  } catch {}

  logger?.info("app:ready", {
    autoStartEnabled: layoutConfig.autoStartEnabled,
    autoWakeOnRecover: layoutConfig.autoWakeOnRecover,
    tiktokEndpoint: !!tiktokConfig.endpointUrl,
  });
});

app.on("window-all-closed", () => {
  registry.stopPolling();
  scrcpy.stopAll();
  if (process.platform !== "darwin") app.quit();
});

