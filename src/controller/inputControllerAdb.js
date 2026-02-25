// src/controller/inputControllerAdb.js
const { runAdb } = require("./adb");

async function shell(deviceId, cmd, timeoutMs = 8000) {
  const args = ["-s", deviceId, "shell", cmd];
  return runAdb(args, timeoutMs);
}

function keycodeFromName(name) {
  const k = String(name || "").toUpperCase();

  // common keys
  if (k === "HOME") return 3;
  if (k === "BACK") return 4;
  if (k === "RECENTS") return 187;
  if (k === "ENTER") return 66;

  // power/screen
  if (k === "POWER") return 26;
  if (k === "SLEEP" || k === "SCREEN_OFF") return 223; // KEYCODE_SLEEP
  if (k === "WAKE" || k === "WAKEUP") return 224; // KEYCODE_WAKEUP

  // allow numeric keycodes
  const n = Number(k);
  if (Number.isFinite(n)) return Math.round(n);

  // fallback: try pass as-is (adb accepts keyevent NAME sometimes on some builds)
  return k;
}

async function key(deviceId, keyNameOrCode, timeoutMs = 8000) {
  const code = keycodeFromName(keyNameOrCode);
  return shell(deviceId, `input keyevent ${code}`, timeoutMs);
}

async function home(deviceId) {
  return key(deviceId, "HOME");
}

async function back(deviceId) {
  return key(deviceId, "BACK");
}

async function recents(deviceId) {
  return key(deviceId, "RECENTS");
}

async function wake(deviceId) {
  // Prefer WAKEUP; fallback to POWER toggle if needed.
  try {
    await key(deviceId, "WAKEUP", 8000);
    return true;
  } catch {
    await key(deviceId, "POWER", 8000);
    return true;
  }
}

async function screenOff(deviceId) {
  // Prefer SLEEP (turn screen off). Fallback to POWER toggle.
  try {
    await key(deviceId, "SLEEP", 8000);
    return true;
  } catch {
    await key(deviceId, "POWER", 8000);
    return true;
  }
}

async function shutdown(deviceId) {
  // Best effort: try poweroff first
  // 1) reboot -p
  try {
    await shell(deviceId, "reboot -p", 12000);
    return true;
  } catch {}

  // 2) sys.powerctl shutdown
  try {
    await shell(deviceId, "setprop sys.powerctl shutdown", 12000);
    return true;
  } catch {}

  // 3) svc power shutdown (not always available)
  try {
    await shell(deviceId, "svc power shutdown", 12000);
    return true;
  } catch (e) {
    throw new Error(
      "Shutdown failed (device may require privileges / ROM restriction)."
    );
  }
}

async function tap(deviceId, x, y) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  return shell(deviceId, `input tap ${px} ${py}`, 8000);
}

async function swipe(deviceId, x1, y1, x2, y2, durationMs = 220) {
  const a = Math.round(Number(x1));
  const b = Math.round(Number(y1));
  const c = Math.round(Number(x2));
  const d = Math.round(Number(y2));
  const dur = Math.max(80, Math.round(Number(durationMs) || 220));
  return shell(deviceId, `input swipe ${a} ${b} ${c} ${d} ${dur}`, 10000);
}

module.exports = {
  shell,
  key,
  home,
  back,
  recents,
  wake,
  screenOff,
  shutdown,
  tap,
  swipe,
};

