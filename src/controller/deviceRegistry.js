// controller/deviceRegistry.js
const { EventEmitter } = require("events");
const {
  listDevicesRaw,
  fetchDeviceInfo,
  checkAgentReady,
} = require("./deviceManager");
const { DeviceContext } = require("./deviceContext");

class DeviceRegistry extends EventEmitter {
  constructor() {
    super();
    this.map = new Map(); // deviceId -> DeviceContext
    this._pollTimer = null;
    this._isPolling = false;

    // track last poll adb failure
    this._lastPollErrorAt = 0;
    this._pollErrorCount = 0;
    this._lastPollErrorMsg = "";
  }

  startPolling(intervalMs = 1500) {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this.pollOnce(), intervalMs);
    this.pollOnce();
  }

  stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  get(deviceId) {
    return this.map.get(deviceId) || null;
  }

  listSnapshots() {
    return Array.from(this.map.values()).map((ctx) => ctx.snapshot());
  }

  _emitState(ctx, transition) {
    // transition: {changed, prev, next}
    try {
      this.emit("device:state", {
        deviceId: ctx.deviceId,
        prev: transition?.prev,
        next: transition?.next,
        changed: !!transition?.changed,
        snapshot: ctx.snapshot(),
      });
    } catch {}
  }

  _emitAdbError(ctx, err, phase) {
    try {
      this.emit("device:adbError", {
        deviceId: ctx?.deviceId || "",
        phase: phase || "",
        message: String(err?.message || err || ""),
        at: Date.now(),
        snapshot: ctx ? ctx.snapshot() : null,
      });
    } catch {}
  }

  async pollOnce() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      const devices = await listDevicesRaw();
      const seen = new Set(devices.map((d) => d.deviceId));

      // Mark removed devices as OFFLINE
      for (const [id, ctx] of this.map.entries()) {
        if (!seen.has(id)) {
          const t = ctx.updateFromDiscovery({
            state: "OFFLINE",
            model: ctx.model,
          });
          this._emitState(ctx, t);
        }
      }

      // Add/update devices
      for (const d of devices) {
        let ctx = this.map.get(d.deviceId);
        if (!ctx) {
          ctx = new DeviceContext(d.deviceId);
          this.map.set(d.deviceId, ctx);
        }

        const transition = ctx.updateFromDiscovery({
          state: d.state,
          model: d.model,
        });
        if (transition.changed) this._emitState(ctx, transition);

        // If ONLINE and missing info, fetch info in its own queue
        if (
          ctx.state === "ONLINE" &&
          (!ctx.androidVersion || !ctx.resolution || !ctx.model)
        ) {
          ctx
            .enqueue(async () => {
              if (ctx.state !== "ONLINE") return;
              try {
                const info = await fetchDeviceInfo(ctx.deviceId, ctx.model);
                ctx.setInfo(info);
              } catch (e) {
                ctx.markAdbError(e);
                this._emitAdbError(ctx, e, "fetchDeviceInfo");
              }
            })
            .catch(() => {});
        }

        // If ONLINE, periodically check agent readiness (not too often)
        if (ctx.shouldCheckAgent(5000)) {
          ctx
            .enqueue(async () => {
              if (ctx.state !== "ONLINE") return;
              try {
                const ok = await checkAgentReady(ctx.deviceId);
                ctx.setAgentReady(ok);
              } catch (e) {
                ctx.markAdbError(e);
                this._emitAdbError(ctx, e, "checkAgentReady");
              }
            })
            .catch(() => {});
        }
      }
    } catch (e) {
      // ADB is down or frozen. Don't crash; emit registry-level error for health/logging.
      this._pollErrorCount += 1;
      this._lastPollErrorAt = Date.now();
      this._lastPollErrorMsg = String(e?.message || e || "");

      try {
        this.emit("registry:adbDown", {
          at: this._lastPollErrorAt,
          count: this._pollErrorCount,
          message: this._lastPollErrorMsg,
        });
      } catch {}
    } finally {
      this._isPolling = false;
    }
  }
}

module.exports = { DeviceRegistry };

