// src/controller/socketClient.js
const net = require("net");
const { runAdb } = require("./adb");
const logger = require("./logger");

const DEVICE_AGENT_PORT = 27183;

// cache forward để khỏi spam adb forward liên tục
// key = `${deviceId}:${hostPort}:${devicePort}`
const _forwardCache = new Map();

function _cacheKey(deviceId, hostPort, devicePort) {
  return `${deviceId}:${hostPort}:${devicePort}`;
}

/**
 * Ensure adb forward exists:
 * adb -s <deviceId> forward tcp:<hostPort> tcp:<devicePort>
 *
 * Cơ chế:
 * - Nếu mới forward trong 20s => skip
 * - Nếu forward fail => thử remove forward rồi forward lại
 */
async function ensureForward(
  deviceId,
  hostPort,
  devicePort = DEVICE_AGENT_PORT
) {
  const did = String(deviceId || "").trim();
  if (!did) throw new Error("ensureForward: deviceId required");

  const hp = Number(hostPort);
  if (!Number.isFinite(hp) || hp <= 0)
    throw new Error("ensureForward: bad hostPort");

  const dp = Number(devicePort);
  if (!Number.isFinite(dp) || dp <= 0)
    throw new Error("ensureForward: bad devicePort");

  const key = _cacheKey(did, hp, dp);
  const lastAt = _forwardCache.get(key) || 0;
  const now = Date.now();

  // 20s là đủ vì forward không tự biến mất (trừ khi adb restart)
  if (now - lastAt < 20_000) return true;

  const forwardArgs = ["-s", did, "forward", `tcp:${hp}`, `tcp:${dp}`];

  try {
    await runAdb(forwardArgs, 8000);
    _forwardCache.set(key, now);
    return true;
  } catch (e) {
    logger?.warn?.("agent:forward_fail_try_remove", {
      deviceId: did,
      hostPort: hp,
      devicePort: dp,
      err: String(e?.message || e || ""),
    });

    // remove rồi forward lại
    try {
      await runAdb(["-s", did, "forward", "--remove", `tcp:${hp}`], 6000);
    } catch {}

    await runAdb(forwardArgs, 8000);
    _forwardCache.set(key, Date.now());
    return true;
  }
}

/**
 * Send ONE JSON line to localhost:<hostPort> and read ONE line response.
 * Agent trả:
 *  - "OK"
 *  - "OK {...json...}"
 *  - "ERR ..."
 *
 * return: { ok:boolean, line:string }
 */
function sendJsonLine(hostPort, payload, timeoutMs = 1500) {
  const hp = Number(hostPort);
  if (!Number.isFinite(hp) || hp <= 0) {
    return Promise.resolve({ ok: false, line: "ERR bad hostPort" });
  }

  const tmo = Math.max(300, Number(timeoutMs) || 1500);

  return new Promise((resolve) => {
    let done = false;
    let buf = "";

    const finish = (ok, line) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve({ ok, line: String(line || "").trim() });
    };

    const socket = net.createConnection({ host: "127.0.0.1", port: hp }, () => {
      try {
        const line = JSON.stringify(payload) + "\n";
        socket.write(line, "utf8");
      } catch (e) {
        finish(false, `ERR write_failed ${e?.message || e}`);
      }
    });

    socket.setTimeout(tmo);

    socket.on("timeout", () => finish(false, "ERR timeout"));
    socket.on("error", (e) => finish(false, `ERR ${e?.message || e}`));

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");

      // giới hạn để tránh treo nếu agent gửi quá nhiều
      if (buf.length > 20000) {
        return finish(false, "ERR response_too_large");
      }

      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        const ok = line.startsWith("OK");
        finish(ok, line);
      }
    });

    socket.on("close", () => {
      if (!done) finish(false, "ERR closed");
    });
  });
}

// ✅ Backward compatibility: một số file cũ có thể gọi sendJson()
// => alias sang sendJsonLine()
function sendJson(hostPort, payload, timeoutMs = 1500) {
  return sendJsonLine(hostPort, payload, timeoutMs);
}

module.exports = {
  ensureForward,
  sendJsonLine,
  sendJson, // ✅ quan trọng để hết lỗi "sendJson is not a function"
};

