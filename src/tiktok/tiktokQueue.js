// src/tiktok/tiktokQueue.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { postJson } = require("./httpJson");

function sha1(s) {
  return crypto
    .createHash("sha1")
    .update(String(s || ""), "utf8")
    .digest("hex");
}

function safeReadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function atomicWriteJson(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

class TikTokQueue {
  constructor({ userDataPath, logger } = {}) {
    this.userDataPath = userDataPath;
    this.logger = logger || null;

    this.pendingPath = path.join(userDataPath, "tiktok_pending.json");
    this.seenPath = path.join(userDataPath, "tiktok_seen.json");

    this.pending = safeReadJson(this.pendingPath, []);
    this.seen = new Set(safeReadJson(this.seenPath, []));

    this.stats = {
      enqueued: 0,
      deduped: 0,
      flushed: 0,
      failed: 0,
      lastError: "",
      lastFlushMs: 0,
    };

    this.cfg = {
      endpointUrl: "",
      token: "",
      sheetGroupId: "",
      batchSize: 20,
      timeoutMs: 15000,
    };

    this._flushing = false;
  }

  setConfig(cfg) {
    this.cfg = { ...this.cfg, ...(cfg || {}) };
  }

  _save() {
    // keep seen limited
    const seenArr = Array.from(this.seen);
    const limit = 20000;
    const trimmed =
      seenArr.length > limit ? seenArr.slice(seenArr.length - limit) : seenArr;

    atomicWriteJson(this.pendingPath, this.pending);
    atomicWriteJson(this.seenPath, trimmed);
  }

  enqueue({ groupId, deviceId, url, ts, meta } = {}) {
    const u = String(url || "").trim();
    if (!u) return false;

    const id = sha1(u);
    if (this.seen.has(id)) {
      this.stats.deduped++;
      return false;
    }
    if (this.pending.some((x) => x.id === id)) {
      this.stats.deduped++;
      return false;
    }

    this.pending.push({
      id,
      groupId: String(groupId || "").trim(),
      deviceId: String(deviceId || "").trim(),
      url: u,
      ts: ts ? Number(ts) : "",
      meta: meta && typeof meta === "object" ? meta : {},
      enqueuedAtMs: Date.now(),
    });

    this.stats.enqueued++;
    this._save();
    return true;
  }

  size() {
    return this.pending.length;
  }

  snapshot() {
    return {
      pending: this.pending.length,
      stats: { ...this.stats },
      cfg: { ...this.cfg, token: this.cfg.token ? "***" : "" },
    };
  }

  async flushOnce() {
    const { endpointUrl, token, batchSize, timeoutMs } = this.cfg;
    if (!endpointUrl || !token)
      return { ok: false, error: "missing endpoint/token" };
    if (!this.pending.length) return { ok: true, accepted: 0 };

    if (this._flushing) return { ok: true, accepted: 0, busy: true };
    this._flushing = true;

    try {
      const take = Math.max(1, Math.min(Number(batchSize) || 20, 200));
      const batch = this.pending.slice(0, take);

      const payload = {
        token,
        items: batch.map((x) => ({
          groupId: x.groupId,
          deviceId: x.deviceId,
          url: x.url,
          ts: x.ts || "",
          meta: x.meta || {},
        })),
      };

      const res = await postJson(
        endpointUrl,
        payload,
        Math.max(3000, Number(timeoutMs) || 15000)
      );

      const ok = !!(res.json && res.json.ok === true);
      if (!ok) {
        const err =
          (res.json && (res.json.error || res.json.message)) ||
          res.raw ||
          "unknown";
        this.stats.failed++;
        this.stats.lastError = String(err).slice(0, 240);
        this.logger?.error?.("tiktok:flush:fail", {
          status: res.status,
          error: this.stats.lastError,
        });
        return { ok: false, error: this.stats.lastError, status: res.status };
      }

      // success
      for (const x of batch) this.seen.add(x.id);
      this.pending = this.pending.slice(batch.length);

      this.stats.flushed += batch.length;
      this.stats.lastError = "";
      this.stats.lastFlushMs = Date.now();
      this._save();

      this.logger?.audit?.("tiktok:flush:ok", {
        accepted: batch.length,
        remaining: this.pending.length,
      });

      return {
        ok: true,
        accepted: batch.length,
        remaining: this.pending.length,
      };
    } finally {
      this._flushing = false;
    }
  }
}

module.exports = { TikTokQueue };
