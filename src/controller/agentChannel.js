// src/controller/agentChannel.js
const { runAdb } = require("./adb");
const { sendJsonLine } = require("./socketClient");

const DEVICE_PORT = 27183;

function getStdout(x) {
  if (typeof x === "string") return x;
  if (x && typeof x.stdout === "string") return x.stdout;
  return String(x ?? "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class AgentChannel {
  constructor({ logger } = {}) {
    this.logger = logger || null;
    this.forwardByDevice = new Map(); // deviceId -> { hostPort, lastOkMs }
  }

  async _allocForward(deviceId) {
    const out = getStdout(
      await runAdb(
        ["-s", deviceId, "forward", "tcp:0", `tcp:${DEVICE_PORT}`],
        8000
      )
    ).trim();

    const port = parseInt(out, 10);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`adb forward tcp:0 failed: "${out}"`);
    }
    this.forwardByDevice.set(deviceId, { hostPort: port, lastOkMs: 0 });
    return port;
  }

  async _getForwardPort(deviceId) {
    const cur = this.forwardByDevice.get(deviceId);
    if (!cur) return this._allocForward(deviceId);
    return cur.hostPort;
  }

  _markOk(deviceId) {
    const cur = this.forwardByDevice.get(deviceId);
    if (cur) cur.lastOkMs = Date.now();
  }

  async send(deviceId, payload, timeoutMs = 1200) {
    let port = await this._getForwardPort(deviceId);

    try {
      const r = await sendJsonLine(port, payload, timeoutMs);
      if (r.ok) this._markOk(deviceId);
      return r.line;
    } catch (e) {
      // forward might be stale -> re-alloc once
      this.logger?.error?.("agent:send:fail", {
        deviceId,
        message: String(e?.message || e || ""),
      });

      await sleep(80);
      port = await this._allocForward(deviceId);
      const r2 = await sendJsonLine(port, payload, timeoutMs);
      if (r2.ok) this._markOk(deviceId);
      return r2.line;
    }
  }

  async ping(deviceId) {
    const line = await this.send(deviceId, { type: "PING" }, 1000);
    return line.startsWith("OK");
  }

  async key(deviceId, key) {
    return this.send(deviceId, { type: "KEY", key }, 1200);
  }

  async tap(deviceId, x, y) {
    return this.send(
      deviceId,
      { type: "TAP", x: Math.round(x), y: Math.round(y) },
      1200
    );
  }

  async swipe(deviceId, x1, y1, x2, y2, durationMs = 220) {
    return this.send(
      deviceId,
      {
        type: "SWIPE",
        x1: Math.round(x1),
        y1: Math.round(y1),
        x2: Math.round(x2),
        y2: Math.round(y2),
        durationMs: Math.max(50, Math.round(durationMs)),
      },
      2000
    );
  }

  async clipboardGet(deviceId) {
    const line = await this.send(deviceId, { type: "CLIPBOARD_GET" }, 1500);
    if (!line.startsWith("OK")) throw new Error(line);

    const rest = line.slice(2).trim(); // base64
    if (!rest) return "";
    try {
      return Buffer.from(rest, "base64").toString("utf8");
    } catch {
      return "";
    }
  }

  async findText(
    deviceId,
    query,
    { contains = true, caseInsensitive = true } = {}
  ) {
    const line = await this.send(
      deviceId,
      {
        type: "FIND_TEXT",
        query,
        contains: !!contains,
        caseInsensitive: !!caseInsensitive,
      },
      1500
    );
    if (!line.startsWith("OK")) throw new Error(line);
    const rest = line.slice(2).trim();
    return rest === "1";
  }
}

module.exports = { AgentChannel };

