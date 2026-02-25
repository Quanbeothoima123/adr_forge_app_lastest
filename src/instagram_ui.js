// instagram_ui.js
// Instagram Upload panel helpers.
// - Runs a selected macro with TEXT token {{IG_SONG}} available.
// - Provides "random media points" capture mode while recording:
//     Start capture -> click candidate thumbnails in scrcpy -> Stop capture
//   This inserts one step into the macro: TAP_RANDOM_POINTS { points: [...] }

(function () {
  const $ = (id) => document.getElementById(id);

  function logIg(msg, isErr = false) {
    const box = $("igStatusBox");
    if (!box) return;
    const line = `${new Date().toLocaleTimeString()} | ${msg}`;
    box.textContent = line;
    box.style.color = isErr ? "#c0392b" : "";
  }

  function getSelectedDeviceId() {
    if (typeof window.mustSelected === "function") {
      return window.mustSelected();
    }
    throw new Error("Không tìm thấy mustSelected() - kiểm tra thứ tự load script.");
  }

  async function reloadMacros(selectMacroId) {
    const sel = $("igMacroSel");
    if (!sel) return;

    const list = await window.forgeAPI.listMacros();
    sel.innerHTML = "";

    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m.id;
      const name = m.meta?.name || m.id;
      opt.textContent = `${name} (${m.id})`;
      sel.appendChild(opt);
    }

    if (selectMacroId) sel.value = selectMacroId;
  }

  async function loadAndFill() {
    const layout = await window.forgeAPI.getLayout();
    const cfg = layout?.igConfig || {};

    if ($("igSongText")) $("igSongText").value = String(cfg.songText || "");
    await reloadMacros(String(cfg.macroId || ""));

    // ✅ khi load panel, hiển thị số points đúng theo macro đang chọn
    await refreshPointsCountFromMacro();

    logIg("IG panel ready");
  }

  async function saveCfg() {
    const macroId = String($("igMacroSel").value || "").trim();
    const songText = String($("igSongText").value || "");

    await window.forgeAPI.setLayout({
      igConfig: {
        macroId,
        songText,
      },
    });

    logIg("Saved igConfig to settings.json");
  }

  function readSharedMacroOptions() {
    // Reuse Macro panel settings (loop/speed/jitter)
    const loopRaw = $("macroLoop")?.value;
    const speedRaw = $("macroSpeed")?.value;
    const xyRaw = $("macroJitterXY")?.value;
    const delayRaw = $("macroJitterDelay")?.value;

    const loop = typeof window.parseLoopInput === "function" ? window.parseLoopInput(loopRaw) : Number(loopRaw || 1);
    const speed = Number(speedRaw || 1.0);
    const xyJitterPct = Number(xyRaw || 0.0);
    const delayJitterPct = Number(delayRaw || 0.0);

    return { loop, speed, xyJitterPct, delayJitterPct };
  }

  function setRandPtsCount(n) {
    const el = $("igRandPtsCount");
    if (!el) return;
    el.textContent = String(n ?? 0);
  }

  async function refreshPointsCountFromMacro() {
    const macroId = String($("igMacroSel")?.value || "").trim();
    if (!macroId) {
      setRandPtsCount(0);
      return;
    }
    try {
      const macro = await window.forgeAPI.macroLoad(macroId);
      const steps = Array.isArray(macro?.steps) ? macro.steps : [];
      const s = steps.find((x) => String(x?.type || "").toUpperCase() === "TAP_RANDOM_POINTS");
      const cnt = Array.isArray(s?.points) ? s.points.length : 0;
      setRandPtsCount(cnt);
    } catch {
      // nếu lỗi đọc macro thì đừng crash UI
      setRandPtsCount(0);
    }
  }

  async function startRandPointsCapture() {
    getSelectedDeviceId(); // just validate selection
    setRandPtsCount(0);

    // UI state
    if ($("igRandPtsStartBtn")) $("igRandPtsStartBtn").disabled = true;
    if ($("igRandPtsStopBtn")) $("igRandPtsStopBtn").disabled = false;

    const r = await window.forgeAPI.macroRandPointsStart();
    if (!r?.ok) {
      if ($("igRandPtsStartBtn")) $("igRandPtsStartBtn").disabled = false;
      if ($("igRandPtsStopBtn")) $("igRandPtsStopBtn").disabled = true;
      if (String(r?.error || "") === "not_recording") {
        throw new Error("Bạn phải Start Record macro trước, rồi mới Start pick points");
      }
      throw new Error(r?.error || "Không thể start random points");
    }

    logIg("Start random points: hãy click các thumbnail trong scrcpy, rồi bấm Stop");
  }

  async function stopRandPointsCapture() {
    const r = await window.forgeAPI.macroRandPointsStop();
    if (!r?.ok) throw new Error(r?.error || "Không thể stop random points");

    // UI state
    if ($("igRandPtsStartBtn")) $("igRandPtsStartBtn").disabled = false;
    if ($("igRandPtsStopBtn")) $("igRandPtsStopBtn").disabled = true;

    if (r.inserted) {
      logIg(`Stop random points: saved ${r.count} points → inserted TAP_RANDOM_POINTS step`);
    } else {
      logIg("Stop random points: (no points captured)");
    }

    // ✅ đảm bảo UI hiển thị count theo đúng macro đang chọn
    await refreshPointsCountFromMacro();
  }

  async function runOnSelected() {
    const deviceId = getSelectedDeviceId();
    const macroId = String($("igMacroSel").value || "").trim();
    if (!macroId) throw new Error("Chưa chọn macro");

    const songText = String($("igSongText").value || "");
    const opts = readSharedMacroOptions();

    await window.forgeAPI.macroPlay(deviceId, macroId, {
      ...opts,
      textVars: {
        IG_SONG: songText,
      },
      // ✅ không cần record lại macro: TEXT step đầu tiên sẽ lấy theo Song trên IG panel
      overrideFirstTextVarKey: "IG_SONG",
    });

    logIg(`Running on ${deviceId} | macro=${macroId} | IG_SONG="${songText}"`);
  }

  async function stopSelected() {
    const deviceId = getSelectedDeviceId();
    await window.forgeAPI.macroStop(deviceId);
    logIg(`Stop requested on ${deviceId}`);
  }

  function wire() {
    if (!$("igMacroSel")) return; // panel not present

    // default state
    if ($("igRandPtsStopBtn")) $("igRandPtsStopBtn").disabled = true;

    $("igReloadMacrosBtn").addEventListener("click", () => {
      reloadMacros($("igMacroSel").value)
        .then(() => refreshPointsCountFromMacro())
        .catch((e) => logIg(String(e?.message || e), true));
    });

    // ✅ đổi macro thì points phải đổi theo macro đó
    $("igMacroSel").addEventListener("change", () => {
      refreshPointsCountFromMacro().catch((e) => logIg(String(e?.message || e), true));
    });

    $("igSaveCfgBtn").addEventListener("click", () => {
      saveCfg().catch((e) => logIg(String(e?.message || e), true));
    });

    $("igRunBtn").addEventListener("click", () => {
      runOnSelected().catch((e) => logIg(String(e?.message || e), true));
    });

    $("igStopBtn").addEventListener("click", () => {
      stopSelected().catch((e) => logIg(String(e?.message || e), true));
    });

    $("igRandPtsStartBtn")?.addEventListener("click", () => {
      startRandPointsCapture().catch((e) => logIg(String(e?.message || e), true));
    });

    $("igRandPtsStopBtn")?.addEventListener("click", () => {
      stopRandPointsCapture().catch((e) => logIg(String(e?.message || e), true));
    });

    // Live count updates while capturing points
    if (typeof window.forgeAPI.onMacroRandPointsCount === "function") {
      window.forgeAPI.onMacroRandPointsCount((p) => {
        if (p && typeof p.count === "number") setRandPtsCount(p.count);
      });
    }

    loadAndFill().catch((e) => logIg(String(e?.message || e), true));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();


