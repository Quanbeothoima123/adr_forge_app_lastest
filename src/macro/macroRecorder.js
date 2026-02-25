// src/macro/macroRecorder.js
// Macro recorder (pct-based) + special "random points" capture mode.
//
// Why random points capture?
// Instagram media picker UI differs across devices; generating random taps by
// dividing a region often mis-hits. Instead, the user selects candidate
// thumbnails (points) while recording, then playback picks 1 point randomly.

class MacroRecorder {
  constructor() {
    this._recording = false;
    this._deviceId = "";
    this._deviceRes = null;

    this._steps = [];

    // Virtual time: macroNow = realNow - _timeOffsetMs
    this._timeOffsetMs = 0;
    this._lastMacroTs = 0;

    // Random points capture
    this._randPtsActive = false;
    this._randPts = [];
    this._randStartMacroTs = null; // macro timestamp when capture started
  }

  isRecording() {
    return this._recording;
  }

  getDeviceId() {
    return this._deviceId;
  }

  isRandPointsActive() {
    return this._randPtsActive;
  }

  start({ deviceId, deviceRes }) {
    this._recording = true;
    this._deviceId = deviceId;
    this._deviceRes = deviceRes || null;

    this._steps = [];

    this._timeOffsetMs = 0;
    this._lastMacroTs = Date.now();

    this._randPtsActive = false;
    this._randPts = [];
    this._randStartMacroTs = null;
  }

  stop() {
    const out = { steps: this._steps.slice() };

    this._recording = false;
    this._deviceId = "";
    this._deviceRes = null;

    this._steps = [];

    this._timeOffsetMs = 0;
    this._lastMacroTs = 0;

    this._randPtsActive = false;
    this._randPts = [];
    this._randStartMacroTs = null;

    return out;
  }

  _macroNow() {
    return Date.now() - (this._timeOffsetMs || 0);
  }

  _push(step) {
    if (!this._recording) return;

    const nowMacro = this._macroNow();
    const dtMs = Math.max(0, nowMacro - (this._lastMacroTs || nowMacro));
    this._lastMacroTs = nowMacro;

    this._steps.push({
      ...step,
      dtMs,
      t: Date.now(),
    });
  }

  // =========================
  // Random points capture mode
  // =========================

  randPointsStart() {
    if (!this._recording) return { ok: false, error: "not_recording" };

    this._randPtsActive = true;
    this._randPts = [];
    this._randStartMacroTs = this._macroNow();

    return { ok: true };
  }

  // Called by recordTapPct when in capture mode
  _randPointsAdd(xPct, yPct) {
    const xp = Number(xPct);
    const yp = Number(yPct);
    if (!Number.isFinite(xp) || !Number.isFinite(yp)) return;

    this._randPts.push({ xPct: xp, yPct: yp });
  }

  randPointsStop() {
    if (!this._recording) return { ok: false, error: "not_recording" };
    if (!this._randPtsActive) return { ok: false, error: "not_active" };

    this._randPtsActive = false;

    const points = this._randPts.slice();
    const startMacroTs = this._randStartMacroTs;

    this._randPts = [];
    this._randStartMacroTs = null;

    if (!points.length || startMacroTs == null) {
      return { ok: true, inserted: false, count: 0 };
    }

    // Insert ONE step at the moment capture started.
    // dtMs cho step random: lấy thời gian tới lúc bấm Start pick points,
    // và clamp để tránh trường hợp bạn suy nghĩ/đợi quá lâu làm macro run bị chậm.
    const dtMsRaw = Math.max(0, startMacroTs - (this._lastMacroTs || startMacroTs));
    const dtMs = Math.min(dtMsRaw, 800);
    this._steps.push({
      type: "TAP_RANDOM_POINTS",
      points,
      dtMs,
      // dùng timestamp lúc Start pick points để tách hẳn thời gian pick khỏi timeline
      t: startMacroTs,
    });

    // Compress macro timeline: remove time spent selecting points.
    // After increasing offset, macroNow becomes startMacroTs.
    const nowMacro = this._macroNow();
    const pauseMacro = Math.max(0, nowMacro - startMacroTs);
    this._timeOffsetMs += pauseMacro;

    // Anchor next dtMs to the pick step moment (no huge delay).
    this._lastMacroTs = startMacroTs;

    return { ok: true, inserted: true, count: points.length };
  }

  // =====================
  // Recorded from scrcpy
  // =====================

  // pct 0..1
  recordTapPct(xPct, yPct) {
    if (!this._recording) return { ok: false, captured: false };

    if (this._randPtsActive) {
      this._randPointsAdd(xPct, yPct);
      return { ok: true, captured: true, count: this._randPts.length };
    }

    this._push({
      type: "TAP",
      xPct: Number(xPct),
      yPct: Number(yPct),
    });

    return { ok: true, captured: false };
  }

  recordSwipePct(x1Pct, y1Pct, x2Pct, y2Pct, durationMs) {
    if (!this._recording) return { ok: false, captured: false };

    // While choosing random points, ignore swipes to avoid "breaking" macro timeline.
    // (User can still swipe in scrcpy, but it won't be recorded.)
    if (this._randPtsActive) {
      return { ok: true, captured: true, count: this._randPts.length };
    }

    this._push({
      type: "SWIPE",
      x1Pct: Number(x1Pct),
      y1Pct: Number(y1Pct),
      x2Pct: Number(x2Pct),
      y2Pct: Number(y2Pct),
      durationMs: Number(durationMs) || 220,
    });

    return { ok: true, captured: false };
  }

  recordLongPressPct(xPct, yPct, durationMs) {
    if (!this._recording) return { ok: false, captured: false };

    if (this._randPtsActive) {
      return { ok: true, captured: true, count: this._randPts.length };
    }

    this._push({
      type: "LONG_PRESS",
      xPct: Number(xPct),
      yPct: Number(yPct),
      durationMs: Number(durationMs) || 600,
    });

    return { ok: true, captured: false };
  }

  // =====================
  // Manual inject from UI
  // =====================

  injectText(text) {
    this._push({
      type: "TEXT",
      text: String(text ?? ""),
    });
  }

  injectKey(key) {
    const k = String(key || "").toUpperCase();
    this._push({
      type: "KEY",
      key: k,
    });
  }

  injectWait(durationMs) {
    this._push({
      type: "WAIT",
      durationMs: Number(durationMs) || 0,
    });
  }

  // Kept for backward compatibility (older macros)
  injectRandomPickMedia({ xLeftPct, xRightPct, yPct, count } = {}) {
    this._push({
      type: "RANDOM_PICK_MEDIA",
      xLeftPct: Number(xLeftPct),
      xRightPct: Number(xRightPct),
      yPct: Number(yPct),
      count: Number(count),
    });
  }
}

module.exports = { MacroRecorder };


