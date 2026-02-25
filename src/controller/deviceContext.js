// controller/deviceContext.js
class DeviceContext {
  constructor(deviceId) {
    this.deviceId = deviceId;

    this.state = "UNKNOWN";
    this.model = null;
    this.androidVersion = null;
    this.resolution = null;

    this.agentReady = false;
    this._lastAgentCheckAt = 0;

    this.firstSeenAt = Date.now();
    this.lastSeenAt = Date.now();

    // ----- Core 5: health metrics -----
    this.onlineSince = null; // timestamp when became ONLINE
    this.totalOnlineMs = 0; // accumulated online time
    this.lastStateChangeAt = Date.now();

    this.adbErrorCount = 0;
    this.lastAdbErrorAt = 0;
    this.lastAdbErrorMsg = "";

    this._chain = Promise.resolve();
    this._disposed = false;
  }

  _applyStateTransition(nextState) {
    const prev = this.state;
    if (prev === nextState) return { changed: false, prev, next: nextState };

    const now = Date.now();

    // accumulate online time if leaving ONLINE
    if (prev === "ONLINE" && this.onlineSince) {
      this.totalOnlineMs += Math.max(0, now - this.onlineSince);
      this.onlineSince = null;
    }

    // entering ONLINE
    if (nextState === "ONLINE") {
      this.onlineSince = now;
    } else {
      // any non-online -> agent considered not ready
      this.agentReady = false;
    }

    this.state = nextState;
    this.lastStateChangeAt = now;

    return { changed: true, prev, next: nextState };
  }

  updateFromDiscovery({ state, model }) {
    this.lastSeenAt = Date.now();

    const nextState = state || "UNKNOWN";
    const transition = this._applyStateTransition(nextState);

    if (model) this.model = model;
    if (this.state !== "ONLINE") this.agentReady = false;

    return transition; // {changed, prev, next}
  }

  setInfo({ model, androidVersion, resolution }) {
    if (model) this.model = model;
    if (androidVersion) this.androidVersion = androidVersion;
    if (resolution) this.resolution = resolution;
  }

  setAgentReady(isReady) {
    this.agentReady = !!isReady;
    this._lastAgentCheckAt = Date.now();
  }

  shouldCheckAgent(thresholdMs = 5000) {
    if (this.state !== "ONLINE") return false;
    return Date.now() - this._lastAgentCheckAt > thresholdMs;
  }

  markAdbError(err) {
    this.adbErrorCount += 1;
    this.lastAdbErrorAt = Date.now();
    this.lastAdbErrorMsg = String(err?.message || err || "");
  }

  // online time including current session
  getOnlineMsNow() {
    if (this.state === "ONLINE" && this.onlineSince) {
      return this.totalOnlineMs + Math.max(0, Date.now() - this.onlineSince);
    }
    return this.totalOnlineMs;
  }

  snapshot() {
    return {
      deviceId: this.deviceId,
      state: this.state,
      model: this.model,
      androidVersion: this.androidVersion,
      resolution: this.resolution,
      agentReady: this.agentReady,
      firstSeenAt: this.firstSeenAt,
      lastSeenAt: this.lastSeenAt,
      onlineSince: this.onlineSince,
      totalOnlineMs: this.getOnlineMsNow(),
      adbErrorCount: this.adbErrorCount,
      lastAdbErrorAt: this.lastAdbErrorAt,
      lastAdbErrorMsg: this.lastAdbErrorMsg,
    };
  }

  dispose() {
    this._disposed = true;
  }

  enqueue(taskFn) {
    // IMPORTANT: nếu task trước lỗi, chain vẫn tiếp tục -> tránh “crash khi spam”
    this._chain = this._chain
      .catch(() => {})
      .then(async () => {
        if (this._disposed)
          throw new Error(`DeviceContext disposed: ${this.deviceId}`);
        return await taskFn();
      });

    return this._chain;
  }
}

module.exports = { DeviceContext };

