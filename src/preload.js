// src/preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forgeAPI", {
  listDevices: () => ipcRenderer.invoke("devices:list"),

  // logs
  logTail: (maxLines) => ipcRenderer.invoke("log:tail", { maxLines }),
  onLogLine: (cb) => {
    ipcRenderer.on("log:line", (_, line) => cb(line));
  },

  // ✅ device alias
  deviceAliasSet: (deviceId, alias) =>
    ipcRenderer.invoke("device:aliasSet", { deviceId, alias }),
  deviceAliasGetAll: () => ipcRenderer.invoke("device:aliasGetAll"),

  // layout
  getLayout: () => ipcRenderer.invoke("layout:get"),
  setLayout: (patch) => ipcRenderer.invoke("layout:set", patch),

  // scrcpy
  scrcpyStart: (deviceId) => ipcRenderer.invoke("scrcpy:start", { deviceId }),
  scrcpyStop: (deviceId) => ipcRenderer.invoke("scrcpy:stop", { deviceId }),
  scrcpyIsRunning: (deviceId) =>
    ipcRenderer.invoke("scrcpy:isRunning", { deviceId }),
  scrcpyStartAll: () => ipcRenderer.invoke("scrcpy:startAll"),
  scrcpyStopAll: () => ipcRenderer.invoke("scrcpy:stopAll"),
  scrcpyApplyLayout: (payload) =>
    ipcRenderer.invoke("scrcpy:applyLayout", payload),

  onScrcpyClosed: (cb) => {
    ipcRenderer.on("scrcpy:closed", (_, payload) => cb(payload));
  },

  // controls
  home: (deviceId) => ipcRenderer.invoke("control:home", { deviceId }),
  back: (deviceId) => ipcRenderer.invoke("control:back", { deviceId }),
  recents: (deviceId) => ipcRenderer.invoke("control:recents", { deviceId }),
  wake: (deviceId) => ipcRenderer.invoke("control:wake", { deviceId }),

  screenOff: (deviceId) =>
    ipcRenderer.invoke("control:screenOff", { deviceId }),
  shutdown: (deviceId) => ipcRenderer.invoke("control:shutdown", { deviceId }),

  tapRaw: (deviceId, x, y) =>
    ipcRenderer.invoke("control:tapRaw", { deviceId, x, y }),

  // pct-based tap (optionally bypass macro recorder)
  tapPct: (deviceId, xPct, yPct, opts) =>
    ipcRenderer.invoke("control:tapPct", { deviceId, xPct, yPct, opts }),

  // TEXT inject into focused field (requires Accessibility agent)
  text: (deviceId, text) =>
    ipcRenderer.invoke("control:text", { deviceId, text }),

  swipeRaw: (deviceId, x1, y1, x2, y2, durationMs) =>
    ipcRenderer.invoke("control:swipeRaw", {
      deviceId,
      x1,
      y1,
      x2,
      y2,
      durationMs,
    }),

  swipeDir: (deviceId, dir) =>
    ipcRenderer.invoke("control:swipeDir", { deviceId, dir }),

  // macros (single device)
  listMacros: () => ipcRenderer.invoke("macro:list"),
  macroRecordStart: (deviceId) =>
    ipcRenderer.invoke("macro:recordStart", { deviceId }),
  macroRecordStop: () => ipcRenderer.invoke("macro:recordStop"),
  macroRecordAddText: (text) =>
    ipcRenderer.invoke("macro:recordAddText", { text }),
  macroRecordAddKey: (key) => ipcRenderer.invoke("macro:recordAddKey", { key }),
  macroRecordAddWait: (durationMs) =>
    ipcRenderer.invoke("macro:recordAddWait", { durationMs }),
  macroRecordAddRandomPick: (config) =>
    ipcRenderer.invoke("macro:recordAddRandomPick", config || {}),

  // IG: random points capture (record-time helper)
  macroRandPointsStart: () => ipcRenderer.invoke("macro:randPointsStart"),
  macroRandPointsStop: () => ipcRenderer.invoke("macro:randPointsStop"),
  onMacroRandPointsCount: (cb) => {
    ipcRenderer.on("macro:randPointsCount", (_, payload) => cb(payload));
  },
  macroSave: (name, description, steps) =>
    ipcRenderer.invoke("macro:save", { name, description, steps }),
  macroLoad: (id) => ipcRenderer.invoke("macro:load", { id }),
  macroPlay: (deviceId, macroId, options) =>
    ipcRenderer.invoke("macro:play", { deviceId, macroId, options }),
  macroStop: (deviceId) => ipcRenderer.invoke("macro:stop", { deviceId }),

  onMacroState: (cb) => {
    ipcRenderer.on("macro:state", (_, payload) => cb(payload));
  },
  onMacroProgress: (cb) => {
    ipcRenderer.on("macro:progress", (_, payload) => cb(payload));
  },

  // ======================
  // Groups
  // ======================
  groupList: () => ipcRenderer.invoke("group:list"),
  groupCreate: (id, name) => ipcRenderer.invoke("group:create", { id, name }),
  groupRename: (id, name) => ipcRenderer.invoke("group:rename", { id, name }),
  groupRemove: (id) => ipcRenderer.invoke("group:remove", { id }),

  groupAddDevice: (groupId, deviceId) =>
    ipcRenderer.invoke("group:addDevice", { groupId, deviceId }),
  groupRemoveDevice: (groupId, deviceId) =>
    ipcRenderer.invoke("group:removeDevice", { groupId, deviceId }),

  // Broadcast Engine
  groupTapPct: (groupId, xPct, yPct, opts) =>
    ipcRenderer.invoke("group:tapPct", { groupId, xPct, yPct, opts }),
  groupSwipePct: (groupId, x1Pct, y1Pct, x2Pct, y2Pct, durationMs, opts) =>
    ipcRenderer.invoke("group:swipePct", {
      groupId,
      x1Pct,
      y1Pct,
      x2Pct,
      y2Pct,
      durationMs,
      opts,
    }),
  groupSwipeDir: (groupId, dir, opts) =>
    ipcRenderer.invoke("group:swipeDir", { groupId, dir, opts }),

  groupKey: (groupId, key, opts) =>
    ipcRenderer.invoke("group:key", { groupId, key, opts }),

  groupWake: (groupId, opts) =>
    ipcRenderer.invoke("group:wake", { groupId, opts }),
  groupScreenOff: (groupId, opts) =>
    ipcRenderer.invoke("group:screenOff", { groupId, opts }),
  groupShutdown: (groupId, opts) =>
    ipcRenderer.invoke("group:shutdown", { groupId, opts }),

  // Group Macro
  groupMacroPlay: (groupId, macroId, options, fanoutOpts) =>
    ipcRenderer.invoke("group:macroPlay", {
      groupId,
      macroId,
      options,
      fanoutOpts,
    }),
  groupMacroStopGroup: (groupId) =>
    ipcRenderer.invoke("group:macroStopGroup", { groupId }),
  groupMacroStopDevice: (groupId, deviceId) =>
    ipcRenderer.invoke("group:macroStopDevice", { groupId, deviceId }),
  groupMacroSnapshot: (groupId) =>
    ipcRenderer.invoke("group:macroSnapshot", { groupId }),

  // ======================
  // ✅ TikTok Harvest (NEW)
  // ======================
  tiktokStatus: () => ipcRenderer.invoke("tiktok:status"),
  tiktokStart: (groupId, macroId, config) =>
    ipcRenderer.invoke("tiktok:start", { groupId, macroId, config }),
  tiktokStop: () => ipcRenderer.invoke("tiktok:stop"),

  onTikTokStatus: (cb) => {
    ipcRenderer.on("tiktok:status", (_, payload) => cb(payload));
  },
  onTikTokLog: (cb) => {
    ipcRenderer.on("tiktok:log", (_, payload) => cb(payload));
  },
});


