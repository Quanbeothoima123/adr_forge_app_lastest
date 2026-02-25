// src/controller/adb.js
const { spawn } = require("child_process");
const logger = require("./logger");

/**
 * Global ADB concurrency limiter to reduce "adb freeze" when controlling 5-10 devices.
 * - Limits number of simultaneous adb processes.
 * - Keeps per-call timeout.
 */
const MAX_ADB_CONCURRENCY = 4;

let _active = 0;
const _q = [];

function _dequeue() {
  if (_active >= MAX_ADB_CONCURRENCY) return;
  const job = _q.shift();
  if (!job) return;

  _active++;
  job()
    .catch(() => {})
    .finally(() => {
      _active--;
      _dequeue();
    });
}

function _enqueueJob(jobFn) {
  return new Promise((resolve, reject) => {
    _q.push(async () => {
      try {
        const r = await jobFn();
        resolve(r);
      } catch (e) {
        reject(e);
      }
    });
    _dequeue();
  });
}

function runAdb(args, timeoutMs = 8000) {
  const startedAt = Date.now();
  const cmdStr = `adb ${args.join(" ")}`;

  return _enqueueJob(() => {
    return new Promise((resolve, reject) => {
      const p = spawn("adb", args, { stdio: ["ignore", "pipe", "pipe"] });

      let out = "";
      let err = "";

      const timer = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {}
        const durMs = Date.now() - startedAt;
        logger.error("adb:timeout", { cmd: cmdStr, timeoutMs, durMs });
        reject(new Error(`adb timeout: ${cmdStr}`));
      }, timeoutMs);

      p.stdout.on("data", (d) => (out += d.toString("utf8")));
      p.stderr.on("data", (d) => (err += d.toString("utf8")));

      p.on("close", (code) => {
        clearTimeout(timer);
        const durMs = Date.now() - startedAt;

        // slow adb warning (useful for long-run)
        if (durMs >= 2500) {
          logger.warn("adb:slow", { cmd: cmdStr, durMs, code });
        }

        if (code === 0) return resolve(out.trim());

        const e = new Error(`adb failed (code ${code}): ${err.trim()}`);
        logger.error("adb:failed", {
          cmd: cmdStr,
          durMs,
          code,
          stderr: (err || "").trim().slice(0, 2000),
        });
        reject(e);
      });

      p.on("error", (e) => {
        clearTimeout(timer);
        const durMs = Date.now() - startedAt;
        logger.error("adb:spawn_error", {
          cmd: cmdStr,
          durMs,
          err: e?.message || String(e),
        });
        reject(e);
      });
    });
  });
}

module.exports = { runAdb };

