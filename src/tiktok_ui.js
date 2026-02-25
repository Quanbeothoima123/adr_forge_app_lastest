// src/tiktok_ui.js
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  function ts(t) {
    try {
      return new Date(t).toLocaleTimeString();
    } catch {
      return "";
    }
  }

  function setBadgeRunning(isRunning) {
    const b = $("tiktokRunBadge");
    if (!b) return;
    b.textContent = `RUNNING: ${isRunning ? "YES" : "NO"}`;
    b.className = "badge " + (isRunning ? "ok" : "bad");
  }

  function appendTikTokLog(msg, isErr = false) {
    const el = $("tiktokLog");
    if (!el) return;
    const line = `<div class="${isErr ? "err" : ""}">[${ts(Date.now())}] ${msg}</div>`;
    el.innerHTML = line + el.innerHTML;

    // cap DOM size
    const maxLines = 220;
    const parts = el.innerHTML.split("</div>");
    if (parts.length > maxLines) {
      el.innerHTML = parts.slice(0, maxLines).join("</div>");
    }
  }

  async function loadLayoutAndFillCfg() {
    try {
      const cfg = await window.forgeAPI.getLayout();
      const tc = cfg?.tiktokConfig || {};

      if ($("tiktokEndpoint")) $("tiktokEndpoint").value = tc.endpointUrl || "";
      if ($("tiktokToken")) $("tiktokToken").value = tc.token || "";
      if ($("tiktokGroupId"))
        $("tiktokGroupId").value = tc.groupId || "Farm_HCM";

      if ($("tiktokBatchSize"))
        $("tiktokBatchSize").value = String(tc.batchSize ?? 15);
      if ($("tiktokFlushMs"))
        $("tiktokFlushMs").value = String(tc.flushEveryMs ?? 15000);
      if ($("tiktokHttpMs"))
        $("tiktokHttpMs").value = String(tc.httpTimeoutMs ?? 12000);

      if ($("tiktokClipPollEvery"))
        $("tiktokClipPollEvery").value = String(tc.clipboardPollEveryMs ?? 260);
      if ($("tiktokClipPollTimeout"))
        $("tiktokClipPollTimeout").value = String(
          tc.clipboardPollTimeoutMs ?? 3500
        );
      if ($("tiktokLiveMax"))
        $("tiktokLiveMax").value = String(tc.liveMaxConsecutive ?? 3);
    } catch {}
  }

  async function saveTikTokConfigOnly() {
    const endpointUrl = String($("tiktokEndpoint")?.value || "").trim();
    const token = String($("tiktokToken")?.value || "").trim();
    const groupId = String($("tiktokGroupId")?.value || "").trim();

    const patch = {
      tiktokConfig: {
        endpointUrl,
        token,
        groupId,
        batchSize: Number($("tiktokBatchSize")?.value || 15),
        flushEveryMs: Number($("tiktokFlushMs")?.value || 15000),
        httpTimeoutMs: Number($("tiktokHttpMs")?.value || 12000),
        clipboardPollEveryMs: Number($("tiktokClipPollEvery")?.value || 260),
        clipboardPollTimeoutMs: Number(
          $("tiktokClipPollTimeout")?.value || 3500
        ),
        liveMaxConsecutive: Number($("tiktokLiveMax")?.value || 3),
      },
    };

    await window.forgeAPI.setLayout(patch);
    appendTikTokLog("Config saved.");
  }

  async function reloadTikTokGroups() {
    const sel = $("tiktokGroupSel");
    if (!sel) return;

    sel.innerHTML = "";
    let groups = [];
    try {
      groups = await window.forgeAPI.groupList();
    } catch {
      groups = [];
    }

    for (const g of groups) {
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = `${g.name} (${g.id}) • ${g.devices?.length || 0} devices`;
      sel.appendChild(opt);
    }

    // default: chọn theo config groupId nếu trùng, không thì chọn first
    try {
      const cfg = await window.forgeAPI.getLayout();
      const gidCfg = String(cfg?.tiktokConfig?.groupId || "").trim();
      if (gidCfg && groups.find((x) => x.id === gidCfg)) sel.value = gidCfg;
      else if (groups.length) sel.value = groups[0].id;
    } catch {}
  }

  async function reloadTikTokMacros() {
    const sel = $("tiktokMacroSel");
    if (!sel) return;

    sel.innerHTML = "";
    let list = [];
    try {
      list = await window.forgeAPI.listMacros();
    } catch {
      list = [];
    }

    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = m.id;
      const name = m.meta?.name || m.id;
      opt.textContent = `${name} (${m.id})`;
      sel.appendChild(opt);
    }

    // default macro: theo config nếu có
    try {
      const cfg = await window.forgeAPI.getLayout();
      const mid = String(cfg?.tiktokConfig?.macroId || "").trim();
      if (mid && list.find((x) => x.id === mid)) sel.value = mid;
      else if (list.length) sel.value = list[0].id;
    } catch {}
  }

  function renderTikTokStatus(st) {
    if (!st) return;
    setBadgeRunning(!!st.running);

    const box = $("tiktokStatusBox");
    if (!box) return;

    const started = st.startedAt
      ? new Date(st.startedAt).toLocaleString()
      : "-";
    const lastFlush = st.lastFlushAt
      ? new Date(st.lastFlushAt).toLocaleTimeString()
      : "-";

    const head = `
      <div><b>Running:</b> ${st.running ? "YES" : "NO"} • <b>Group:</b> ${st.groupId || "-"} • <b>Macro:</b> ${st.macroId || "-"}</div>
      <div class="muted small">Started: ${started} • Queue: ${st.queueSize || 0} • Pushed: ${st.pushedCount || 0} • Fail: ${st.failCount || 0} • LastFlush: ${lastFlush}</div>
    `;

    const devices = Array.isArray(st.devices) ? st.devices : [];
    const rows = devices
      .map((d) => {
        const lastAt = d.lastAt ? new Date(d.lastAt).toLocaleTimeString() : "-";
        const live = d.liveSkip || 0;
        const ok = d.ok || 0;
        const fail = d.fail || 0;
        const lastUrl = (d.lastUrl || "").toString();
        const lastErr = (d.lastErr || "").toString();
        return `
          <div style="border-top:1px solid #f2f2f2; padding-top:6px; margin-top:6px;">
            <div><b>${d.deviceId}</b> • ok=${ok} • fail=${fail} • liveSkip=${live} • lastAt=${lastAt}</div>
            ${lastUrl ? `<div class="mono small muted" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${lastUrl}</div>` : ""}
            ${lastErr ? `<div class="err small">ERR: ${lastErr}</div>` : ""}
          </div>
        `;
      })
      .join("");

    box.innerHTML =
      head + (rows ? rows : `<div class="muted small">(no device stats)</div>`);
  }

  async function refreshStatusOnce() {
    try {
      const st = await window.forgeAPI.tiktokStatus();
      renderTikTokStatus(st);
    } catch {}
  }

  async function startHarvest() {
    await saveTikTokConfigOnly();

    const groupId = String($("tiktokGroupSel")?.value || "").trim();
    const macroId = String($("tiktokMacroSel")?.value || "").trim();

    if (!groupId) throw new Error("Chưa chọn group");
    if (!macroId) throw new Error("Chưa chọn macro");

    const configPatch = {
      endpointUrl: String($("tiktokEndpoint")?.value || "").trim(),
      token: String($("tiktokToken")?.value || "").trim(),
      groupId: String($("tiktokGroupId")?.value || "").trim() || groupId,

      batchSize: Number($("tiktokBatchSize")?.value || 15),
      flushEveryMs: Number($("tiktokFlushMs")?.value || 15000),
      httpTimeoutMs: Number($("tiktokHttpMs")?.value || 12000),

      clipboardPollEveryMs: Number($("tiktokClipPollEvery")?.value || 260),
      clipboardPollTimeoutMs: Number($("tiktokClipPollTimeout")?.value || 3500),
      liveMaxConsecutive: Number($("tiktokLiveMax")?.value || 3),
    };

    const st = await window.forgeAPI.tiktokStart(groupId, macroId, configPatch);
    renderTikTokStatus(st);
    appendTikTokLog(`Harvest started: group=${groupId} macro=${macroId}`);
  }

  async function stopHarvest() {
    const st = await window.forgeAPI.tiktokStop();
    renderTikTokStatus(st);
    appendTikTokLog("Harvest stopped.");
  }

  function wireEvents() {
    $("tiktokReloadGroupsBtn")?.addEventListener("click", () =>
      reloadTikTokGroups().catch(() => {})
    );
    $("tiktokReloadMacrosBtn")?.addEventListener("click", () =>
      reloadTikTokMacros().catch(() => {})
    );

    $("tiktokSaveCfgBtn")?.addEventListener("click", async () => {
      try {
        await saveTikTokConfigOnly();
      } catch (e) {
        appendTikTokLog(`Save config failed: ${e?.message || e}`, true);
      }
    });

    $("tiktokStartBtn")?.addEventListener("click", async () => {
      try {
        await startHarvest();
      } catch (e) {
        appendTikTokLog(`Start failed: ${e?.message || e}`, true);
      }
    });

    $("tiktokStopBtn")?.addEventListener("click", async () => {
      try {
        await stopHarvest();
      } catch (e) {
        appendTikTokLog(`Stop failed: ${e?.message || e}`, true);
      }
    });

    // receive status/log from main
    window.forgeAPI.onTikTokStatus((st) => {
      renderTikTokStatus(st);
    });

    window.forgeAPI.onTikTokLog((p) => {
      const msg = p?.msg || JSON.stringify(p);
      const isErr =
        String(msg).toLowerCase().includes("fail") ||
        String(msg).toLowerCase().includes("error");
      appendTikTokLog(msg, isErr);
    });
  }

  (async function bootTikTokUI() {
    try {
      wireEvents();
      await loadLayoutAndFillCfg();
      await reloadTikTokGroups();
      await reloadTikTokMacros();
      await refreshStatusOnce();
      appendTikTokLog("TikTok Harvest UI ready.");
    } catch (e) {
      appendTikTokLog(`TikTok UI boot error: ${e?.message || e}`, true);
    }

    // light polling (optional, status already pushed via event)
    setInterval(() => refreshStatusOnce().catch(() => {}), 2500);
  })();
})();

