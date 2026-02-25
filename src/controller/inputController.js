// controller/inputController.js
const net = require("net");
const { runAdb } = require("./adb");

const AGENT_PORT = 27183;
const forwardCache = new Map();

async function ensureForward(deviceId) {
  const cached = forwardCache.get(deviceId);
  const now = Date.now();

  if (cached && now - cached.updatedAt < 60_000) return cached.localPort;

  const out = await runAdb(
    ["-s", deviceId, "forward", "tcp:0", `tcp:${AGENT_PORT}`],
    8000
  );

  const localPort = parseInt(String(out).trim(), 10);
  if (!Number.isFinite(localPort) || localPort <= 0) {
    throw new Error(`adb forward failed: output="${out}"`);
  }

  forwardCache.set(deviceId, { localPort, updatedAt: now });
  return localPort;
}

function dropForwardCache(deviceId) {
  forwardCache.delete(deviceId);
}

function sendJsonLine(host, port, obj, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    let buf = "";

    const finishOk = (val) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(val);
    };

    const finishErr = (err) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      reject(err);
    };

    const timer = setTimeout(() => {
      finishErr(new Error("socket timeout waiting response"));
    }, timeoutMs);

    socket.on("error", (e) => {
      clearTimeout(timer);
      finishErr(e);
    });

    socket.on("close", () => {
      if (!done) {
        clearTimeout(timer);
        finishErr(new Error("socket closed before response"));
      }
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timer);
        const line = buf.slice(0, idx).trim();
        if (line === "OK") return finishOk("OK");
        if (line.startsWith("ERR")) return finishErr(new Error(line));
        return finishOk(line);
      }
    });

    socket.connect(port, host, () => {
      socket.write(JSON.stringify(obj) + "\n", "utf8");
    });
  });
}

function isRetryableError(e) {
  const msg = String(e?.message || e || "");
  return (
    msg.includes("timeout") ||
    msg.includes("closed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE")
  );
}

async function callAgent(deviceId, payload, timeoutMs) {
  // retry 1 lần nếu timeout/closed (thường do forward stale hoặc agent vừa wake)
  try {
    const localPort = await ensureForward(deviceId);
    return await sendJsonLine("127.0.0.1", localPort, payload, timeoutMs);
  } catch (e) {
    if (!isRetryableError(e)) throw e;

    dropForwardCache(deviceId);
    const localPort2 = await ensureForward(deviceId);
    return await sendJsonLine("127.0.0.1", localPort2, payload, timeoutMs);
  }
}

async function ping(deviceId) {
  await callAgent(deviceId, { type: "PING" }, 4000);
  return true;
}

async function tap(deviceId, x, y) {
  await callAgent(deviceId, { type: "TAP", x, y }, 3000);
  return true;
}

async function longPress(deviceId, x, y, durationMs = 600) {
  await callAgent(
    deviceId,
    { type: "LONG_PRESS", x, y, durationMs: Number(durationMs) },
    5000
  );
  return true;
}

async function swipe(deviceId, x1, y1, x2, y2, durationMs = 220) {
  await callAgent(
    deviceId,
    { type: "SWIPE", x1, y1, x2, y2, durationMs: Number(durationMs) },
    5000
  );
  return true;
}

async function key(deviceId, keyName) {
  await callAgent(
    deviceId,
    { type: "KEY", key: String(keyName).toUpperCase() },
    3500
  );
  return true;
}

async function home(deviceId) {
  return key(deviceId, "HOME");
}

async function back(deviceId) {
  return key(deviceId, "BACK");
}

module.exports = { ping, tap, longPress, swipe, key, home, back };

