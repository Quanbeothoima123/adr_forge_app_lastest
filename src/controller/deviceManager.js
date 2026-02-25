// controller/deviceManager.js
const { runAdb } = require("./adb");

const AGENT_ACCESSIBILITY_ID =
  "com.androidforge.agent/com.androidforge.agent.ForgeAccessibilityService";

function parseDevices(output) {
  const lines = output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const deviceLines = lines.slice(1); // skip "List of devices attached"

  return deviceLines
    .map((line) => {
      const parts = line.split(/\s+/);
      const deviceId = parts[0] || "";
      const adbState = parts[1] || "";

      let state = "UNKNOWN";
      if (adbState === "device") state = "ONLINE";
      else if (adbState === "offline") state = "OFFLINE";
      else if (adbState === "unauthorized") state = "UNAUTHORIZED";

      // Try parse model from adb devices -l: model:XYZ
      let model = null;
      const modelPart = parts.find((p) => p.startsWith("model:"));
      if (modelPart) model = modelPart.split(":")[1] || null;

      return { deviceId, state, model, raw: line };
    })
    .filter((d) => d.deviceId.length > 0);
}

async function listDevicesRaw() {
  const out = await runAdb(["devices", "-l"], 8000);
  return parseDevices(out);
}

async function getAndroidVersion(deviceId) {
  const out = await runAdb(
    ["-s", deviceId, "shell", "getprop", "ro.build.version.release"],
    8000
  );
  return out.trim() || null;
}

async function getModel(deviceId) {
  const out = await runAdb(
    ["-s", deviceId, "shell", "getprop", "ro.product.model"],
    8000
  );
  return out.trim() || null;
}

function parseWmSize(output) {
  const physicalMatch = output.match(/Physical size:\s*(\d+)x(\d+)/i);
  const overrideMatch = output.match(/Override size:\s*(\d+)x(\d+)/i);

  const pick = overrideMatch || physicalMatch;
  if (!pick) return null;

  return { width: Number(pick[1]), height: Number(pick[2]) };
}

async function getResolution(deviceId) {
  const out = await runAdb(["-s", deviceId, "shell", "wm", "size"], 8000);
  return parseWmSize(out);
}

async function fetchDeviceInfo(deviceId, existingModelMaybeNull) {
  const [version, modelFallback, res] = await Promise.allSettled([
    getAndroidVersion(deviceId),
    existingModelMaybeNull
      ? Promise.resolve(existingModelMaybeNull)
      : getModel(deviceId),
    getResolution(deviceId),
  ]);

  return {
    androidVersion: version.status === "fulfilled" ? version.value : null,
    model:
      modelFallback.status === "fulfilled"
        ? modelFallback.value
        : existingModelMaybeNull || null,
    resolution: res.status === "fulfilled" ? res.value : null,
  };
}

// Check AndroidForgeAgent accessibility enabled
async function checkAgentReady(deviceId) {
  // This returns a colon-separated list of enabled services, or "null"
  const out = await runAdb(
    [
      "-s",
      deviceId,
      "shell",
      "settings",
      "get",
      "secure",
      "enabled_accessibility_services",
    ],
    8000
  );

  const s = (out || "").trim();
  if (!s || s === "null") return false;

  // Some ROMs return multiple services joined by ':'
  return s.includes(AGENT_ACCESSIBILITY_ID);
}

module.exports = {
  listDevicesRaw,
  fetchDeviceInfo,
  checkAgentReady,
  AGENT_ACCESSIBILITY_ID,
};

