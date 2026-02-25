// controller/inputControllerSmart.js
const adb = require("./inputControllerAdb");
const agent = require("./agentInput");

async function tap(ctx, x, y) {
  if (ctx.agentReady) return agent.tap(ctx.deviceId, x, y);
  return adb.tap(ctx.deviceId, x, y);
}

async function swipe(ctx, x1, y1, x2, y2, durationMs) {
  if (ctx.agentReady)
    return agent.swipe(ctx.deviceId, x1, y1, x2, y2, durationMs);
  return adb.swipe(ctx.deviceId, x1, y1, x2, y2, durationMs);
}

async function longPress(ctx, x, y, durationMs) {
  if (ctx.agentReady) return agent.longPress(ctx.deviceId, x, y, durationMs);
  return adb.longPress(ctx.deviceId, x, y, durationMs);
}

async function key(ctx, key) {
  // agent hỗ trợ HOME/BACK hiện tại
  if (ctx.agentReady) return agent.key(ctx.deviceId, key);
  // fallback adb: map key string -> adb keyevent
  const k = String(key || "").toUpperCase();
  if (k === "BACK") return adb.back(ctx.deviceId);
  if (k === "HOME") return adb.home(ctx.deviceId);
  if (k === "RECENTS") return adb.recents(ctx.deviceId);
  throw new Error("Unknown key for fallback adb");
}

async function text(ctx, text) {
  if (!ctx.agentReady)
    throw new Error("Agent not ready (TEXT requires Accessibility agent)");
  return agent.text(ctx.deviceId, String(text ?? ""));
}

module.exports = { tap, swipe, longPress, key, text };

