// src/macro/macroRunner.js
const input = require("../controller/inputControllerSmart");
const crypto = require("crypto");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ✅ NEW: sleep but can be interrupted by shouldStop (stop group/single macro faster)
async function sleepInterruptible(totalMs, shouldStop, tickMs = 60) {
  let remain = Math.max(0, Number(totalMs) || 0);
  const tick = Math.max(15, Number(tickMs) || 60);

  while (remain > 0) {
    if (shouldStop && shouldStop()) return false;
    const s = Math.min(remain, tick);
    await sleep(s);
    remain -= s;
  }
  return true;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function jitterPct(p, jitter) {
  if (!jitter) return p;
  const j = (Math.random() * 2 - 1) * jitter;
  return clamp01(p + j);
}

function pctToPx(pct01, axisMax) {
  return Math.max(0, Math.min(axisMax - 1, Math.round(pct01 * axisMax)));
}

function _getTextVars(options = {}) {
  const v = options?.textVars ?? options?.vars;
  return v && typeof v === "object" ? v : {};
}

function _randInt(n) {
  const m = Math.max(0, Number(n) || 0);
  if (!m) return 0;
  try {
    // Node >=14 supports crypto.randomInt
    if (typeof crypto.randomInt === "function") return crypto.randomInt(m);
  } catch {}
  return Math.floor(Math.random() * m);
}

/**
 * Template resolver for TEXT steps.
 *
 * Supported tokens:
 *  - {{VAR_NAME}}                 -> replaced by vars.VAR_NAME (case-insensitive)
 *  - {{RAND_LINE:VAR_NAME}}       -> pick random non-empty line from vars.VAR_NAME
 *  - {{RAND:opt1|opt2|opt3}}      -> pick random option from inline list
 */
function resolveTextTemplate(raw, vars = {}) {
  let out = String(raw ?? "");

  // RAND_LINE first (so it can reference vars)
  out = out.replace(/\{\{\s*RAND_LINE\s*:\s*([A-Z0-9_]+)\s*\}\}/gi, (_, k) => {
    const key = String(k || "");
    const v = vars[key] ?? vars[key.toUpperCase()] ?? vars[key.toLowerCase()];
    const lines = String(v ?? "")
      .split(/\r?\n/)
      .map((x) => String(x).trim())
      .filter(Boolean);
    if (!lines.length) return "";
    return lines[Math.floor(Math.random() * lines.length)];
  });

  // RAND inline list
  out = out.replace(/\{\{\s*RAND\s*:\s*([^}]+)\}\}/g, (_, body) => {
    const parts = String(body || "")
      .split("|")
      .map((x) => String(x).trim())
      .filter(Boolean);
    if (!parts.length) return "";
    return parts[Math.floor(Math.random() * parts.length)];
  });

  // Simple {{VAR}}
  out = out.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_, k) => {
    const key = String(k || "");
    const v = vars[key] ?? vars[key.toUpperCase()] ?? vars[key.toLowerCase()];
    return v == null ? "" : String(v);
  });

  return out;
}


function randInt(n) {
  const m = Math.floor(Number(n) || 0);
  if (m <= 1) return 0;
  try {
    return crypto.randomInt(m);
  } catch {
    return Math.floor(Math.random() * m);
  }
}


function getDeviceId(ctx) {
  // best-effort
  try {
    const s = ctx.snapshot?.();
    if (s?.deviceId) return s.deviceId;
  } catch {}
  return ctx.deviceId || ctx.id || ctx._deviceId || "";
}

async function runMacroOnDevice(ctx, macro, options = {}, runtime = {}) {
  const shouldStop = runtime.shouldStop || (() => false);
  const onProgress = runtime.onProgress || (() => {});

  const speed = Number(options.speed ?? 1.0) || 1.0;
  const xyJitterPct = Number(
    options.xyJitterPct ?? macro?.settings?.randomize?.xyJitterPct ?? 0
  );
  const delayJitterPct = Number(
    options.delayJitterPct ?? macro?.settings?.randomize?.delayJitterPct ?? 0
  );

  const steps = Array.isArray(macro?.steps) ? macro.steps : [];
  if (!steps.length) return;

  let lastTapPct = null;

  // ✅ IG Upload: cho phép override TEXT đầu tiên bằng biến runtime (ví dụ: IG_SONG)
  const overrideFirstTextVarKey = String(options?.overrideFirstTextVarKey || "").trim();
  let overrideFirstTextUsed = false;

  // tránh random chọn cùng 1 điểm liên tục trong 1 lần chạy
  let lastRandPointsIdx = -1;

  // ✅ ensure ctx.deviceId exists (inputControllerSmart expects ctx.deviceId)
  const deviceId = getDeviceId(ctx);
  if (!ctx.deviceId) ctx.deviceId = deviceId;

  for (let i = 0; i < steps.length; i++) {
    if (shouldStop()) break;

    const s = steps[i];
    const type = String(s.type || "").toUpperCase();

    onProgress({
      deviceId,
      stepIndex: i + 1,
      stepCount: steps.length,
      stepType: type,
    });

    // delay between steps (dtMs) — ✅ interruptible (stop won't "carry on")
    const dt = Number(s.dtMs ?? 60);
    const baseDelay = Math.max(0, Math.round(dt / speed));
    const jitter = baseDelay * delayJitterPct * (Math.random() * 2 - 1);
    const targetDelay = Math.max(0, Math.round(baseDelay + jitter));
    if (targetDelay > 0) {
      const ok = await sleepInterruptible(targetDelay, shouldStop, 60);
      if (!ok) break;
    }

    if (shouldStop()) break;

    const snap = ctx.snapshot?.() || {};
    const res = snap.resolution || {};
    const w = res.width || 1080;
    const h = res.height || 1920;

    if (type === "TAP") {
      const xPct = jitterPct(Number(s.xPct), xyJitterPct);
      const yPct = jitterPct(Number(s.yPct), xyJitterPct);
      const x = pctToPx(xPct, w);
      const y = pctToPx(yPct, h);
      lastTapPct = { xPct, yPct };

      if (shouldStop()) break;
      await input.tap(ctx, x, y);
      continue;
    }

    if (type === "LONG_PRESS") {
      const xPct = jitterPct(Number(s.xPct), xyJitterPct);
      const yPct = jitterPct(Number(s.yPct), xyJitterPct);
      const x = pctToPx(xPct, w);
      const y = pctToPx(yPct, h);
      lastTapPct = { xPct, yPct };
      const dur = Math.max(80, Number(s.durationMs || 600));

      if (shouldStop()) break;
      await input.longPress(ctx, x, y, dur);
      continue;
    }

    if (type === "SWIPE") {
      const x1Pct = jitterPct(Number(s.x1Pct), xyJitterPct);
      const y1Pct = jitterPct(Number(s.y1Pct), xyJitterPct);
      const x2Pct = jitterPct(Number(s.x2Pct), xyJitterPct);
      const y2Pct = jitterPct(Number(s.y2Pct), xyJitterPct);

      const x1 = pctToPx(x1Pct, w);
      const y1 = pctToPx(y1Pct, h);
      const x2 = pctToPx(x2Pct, w);
      const y2 = pctToPx(y2Pct, h);

      const dur = Math.max(80, Number(s.durationMs || 220));

      if (shouldStop()) break;
      await input.swipe(ctx, x1, y1, x2, y2, dur);
      continue;
    }




    // ✅ Random pick from a user-recorded list of candidate points
    // Used by Instagram Upload panel: TAP_RANDOM_POINTS { points:[{xPct,yPct}...] }
    if (type === "TAP_RANDOM_POINTS" || type === "RAND_POINTS" || type === "RANDOM_POINTS") {
      const pts = Array.isArray(s.points)
        ? s.points
        : (Array.isArray(s.pointsPct) ? s.pointsPct : []);

      if (pts.length > 0) {
        let idx = randInt(pts.length);
        // tránh lặp cùng 1 idx trong cùng 1 lượt run (nhìn giống "luôn chọn ảnh đầu")
        if (pts.length > 1 && idx === lastRandPointsIdx) {
          for (let k = 0; k < 4; k++) {
            const j = randInt(pts.length);
            if (j !== lastRandPointsIdx) {
              idx = j;
              break;
            }
          }
        }
        lastRandPointsIdx = idx;

        const p = pts[idx];
        const xPct = jitterPct(Number(p.xPct), xyJitterPct);
        const yPct = jitterPct(Number(p.yPct), xyJitterPct);
        const x = pctToPx(xPct, w);
        const y = pctToPx(yPct, h);
        lastTapPct = { xPct, yPct };

        if (shouldStop()) break;
        await input.tap(ctx, x, y);

        // Cho UI kịp update selection (Instagram picker dễ bị "đứng" ở item đầu nếu Next bị bấm quá sớm)
        const settle = Math.max(60, Math.round(240 / speed));
        const ok = await sleepInterruptible(settle, shouldStop, 40);
        if (!ok) break;
      }
      continue;
    }
    // ✅ Random pick media (for Instagram picker after you filtered PHOTO/VIDEO)
    // The step stores a region and visible count; each run picks a random slot.
    // Schema (defaults are safe-ish, but you should tune in UI once):
    //  - xLeftPct, xRightPct: thumbnail strip left/right bounds (0..1)
    //  - yPct: vertical center of thumbnail strip (0..1)
    //  - count: visible thumbnail count
    if (
      type === "RANDOM_PICK_MEDIA" ||
      type === "RAND_PICK_MEDIA" ||
      type === "RANDOM_PICK"
    ) {
      const xLeftPct = clamp01(Number(s.xLeftPct ?? s.x1Pct ?? 0.12));
      const xRightPct = clamp01(Number(s.xRightPct ?? s.x2Pct ?? 0.88));
      const yBasePct = clamp01(Number(s.yPct ?? 0.79));
      const count = Math.max(1, Math.floor(Number(s.count ?? 5)));

      const idx = randInt(count);
      const span = Math.max(0.001, xRightPct - xLeftPct);
      const xBasePct = clamp01(
        xLeftPct + ((idx + 0.5) / count) * span
      );

      const xPct = jitterPct(xBasePct, xyJitterPct);
      const yPct = jitterPct(yBasePct, xyJitterPct);
      const x = pctToPx(xPct, w);
      const y = pctToPx(yPct, h);
      lastTapPct = { xPct, yPct };

      if (shouldStop()) break;
      await input.tap(ctx, x, y);
      continue;
    }

    if (type === "KEY") {
      const key = String(s.key || "").toUpperCase();

      if (shouldStop()) break;
      await input.key(ctx, key);
      continue;
    }

    if (type === "WAIT") {
      const ms = Math.max(0, Number(s.durationMs || s.ms || 0));
      const scaled = ms ? Math.round(ms / speed) : 0;

      if (scaled > 0) {
        const ok = await sleepInterruptible(scaled, shouldStop, 60);
        if (!ok) break;
      }
      continue;
    }

    if (type === "TEXT") {
      const vars = _getTextVars(options);
      const raw = String(s.text || "");
      let text = resolveTextTemplate(raw, vars);

      // ✅ IG Upload: cho phép thay đổi Song trên UI mà không cần record lại macro.
      // Nếu gọi run từ Instagram panel, main/renderer sẽ truyền overrideFirstTextVarKey='IG_SONG'.
      if (!overrideFirstTextUsed && overrideFirstTextVarKey) {
        const k = overrideFirstTextVarKey;
        const v = vars[k] ?? vars[k.toUpperCase()] ?? vars[k.toLowerCase()];
        if (v != null && String(v).trim() !== "") {
          text = String(v);
          overrideFirstTextUsed = true;
        }
      }

      if (shouldStop()) break;

      // TEXT trong smart controller yêu cầu agentReady = true
      // (đúng mục tiêu của bạn cho Unicode)
      try {
        let r = await input.text(ctx, text);

        if (shouldStop()) break;

        // fallback: nếu agent trả ERR no_focus / not_editable và có lastTapPct
        if (typeof r === "string" && r.startsWith("ERR") && lastTapPct) {
          if (r.includes("no_focus") || r.includes("not_editable")) {
            const x = pctToPx(lastTapPct.xPct, w);
            const y = pctToPx(lastTapPct.yPct, h);

            if (shouldStop()) break;
            await input.tap(ctx, x, y);

            const ok = await sleepInterruptible(120, shouldStop, 40);
            if (!ok) break;

            if (shouldStop()) break;
            r = await input.text(ctx, text);
          }
        }

        if (typeof r === "string" && r.startsWith("ERR")) {
          throw new Error(r);
        }
      } catch (e) {
        // normalize error message (giữ đúng error bạn đang expect)
        const msg = String(e?.message || e || "");
        if (msg.toLowerCase().includes("agent not ready")) {
          throw new Error("ERR unicode_not_supported_without_agent");
        }
        throw e;
      }
      continue;
    }

    // unknown step -> ignore
  }

  // optional progress "done" marker (UI currently logs on macro:state)
  try {
    onProgress({ deviceId, done: true, stepCount: steps.length });
  } catch {}
}

module.exports = { runMacroOnDevice };


