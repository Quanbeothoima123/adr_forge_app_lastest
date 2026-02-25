// src/controller/scrcpyController.js
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const logger = require("./logger");

function toPsEncodedCommand(psScript) {
  // PowerShell -EncodedCommand expects UTF-16LE base64
  return Buffer.from(psScript, "utf16le").toString("base64");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class ScrcpyController extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map(); // deviceId -> { proc, title, port }
    this.pendingStart = new Set(); // deviceId
    this.pendingStop = new Set(); // deviceId
  }

  isRunning(deviceId) {
    const s = this.procs.get(deviceId);
    return !!(s && s.proc && !s.proc.killed);
  }

  async start(deviceId, opts = {}) {
    if (this.isRunning(deviceId)) return true;
    if (this.pendingStart.has(deviceId)) return true;

    this.pendingStart.add(deviceId);

    try {
      const title = `forge:${deviceId}`;

      const maxFps = opts.maxFps ?? 30;
      const bitRate = opts.bitRate ?? "8M";

      const win = opts.window || {};
      const borderless = win.borderless === true ? true : false; // default false
      const alwaysOnTop = !!win.alwaysOnTop;

      const targetW = Number.isFinite(win.width) ? Number(win.width) : 360;
      const targetH = Number.isFinite(win.height) ? Number(win.height) : 800;

      const corner = win.corner || "top-left";
      const margin = Number.isFinite(win.margin) ? Number(win.margin) : 8;

      const layout = win.layout || null; // { mode:'grid', slotIndex, cols, rows, margin? }

      const maxSize = Number.isFinite(win.maxSize) ? Number(win.maxSize) : null;

      const args = [
        "-s",
        deviceId,
        "--no-audio",
        "--window-title",
        title,
        "--max-fps",
        String(maxFps),
        "--video-bit-rate",
        String(bitRate),
      ];

      if (maxSize && maxSize >= 120)
        args.push("-m", String(Math.round(maxSize)));

      if (Number.isFinite(targetW) && targetW >= 120)
        args.push("--window-width", String(Math.round(targetW)));
      if (Number.isFinite(targetH) && targetH >= 200)
        args.push("--window-height", String(Math.round(targetH)));

      if (Number.isFinite(opts.port)) args.push("--port", String(opts.port));
      if (borderless) args.push("--window-borderless");
      if (alwaysOnTop) args.push("--always-on-top");

      logger.audit("scrcpy:start", {
        deviceId,
        title,
        port: opts.port ?? null,
        maxFps,
        bitRate,
      });

      const proc = spawn("scrcpy", args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: false,
      });

      proc.on("error", (err) => {
        logger.error("scrcpy:spawn_error", {
          deviceId,
          err: err?.message || String(err),
        });
        this.stop(deviceId).catch(() => {});
      });

      proc.stderr.on("data", (d) => {
        const s = d.toString("utf8").trim();
        if (s)
          logger.info("scrcpy:stderr", { deviceId, line: s.slice(0, 600) });
      });

      proc.on("close", (code, signal) => {
        this.procs.delete(deviceId);
        logger.audit("scrcpy:closed", { deviceId, code, signal });
        this.emit("closed", { deviceId, code, signal });
      });

      this.procs.set(deviceId, { proc, title, port: opts.port });

      const rules = {
        width: targetW,
        height: targetH,
        corner,
        margin: Number.isFinite(layout?.margin)
          ? Number(layout.margin)
          : margin,

        layoutMode: layout?.mode || "corner",
        slotIndex:
          layout?.mode === "grid" && Number.isFinite(layout?.slotIndex)
            ? Number(layout.slotIndex)
            : 0,
        cols:
          layout?.mode === "grid" && Number.isFinite(layout?.cols)
            ? Number(layout.cols)
            : null,
        rows:
          layout?.mode === "grid" && Number.isFinite(layout?.rows)
            ? Number(layout.rows)
            : null,

        sendToBottom: !!(opts.zOrder && opts.zOrder.sendToBottom),
        noActivate: !!(opts.zOrder && opts.zOrder.noActivate),

        // Start: do NOT force resize (allow manual)
        forceSize: false,

        timeoutMs: Number.isFinite(win.timeoutMs)
          ? Number(win.timeoutMs)
          : 15000,
      };

      this._applyWindowRulesByTitle(title, rules).catch((e) => {
        logger.warn("scrcpy:window_rules_failed", {
          deviceId,
          msg: e?.message || String(e),
        });
      });

      return true;
    } finally {
      this.pendingStart.delete(deviceId);
    }
  }

  async stop(deviceId) {
    if (this.pendingStop.has(deviceId)) return;
    this.pendingStop.add(deviceId);

    try {
      const s = this.procs.get(deviceId);
      if (!s) return;

      logger.audit("scrcpy:stop", { deviceId });

      this.procs.delete(deviceId);

      if (process.platform === "win32" && s.proc?.pid) {
        try {
          spawn("taskkill", ["/PID", String(s.proc.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          await sleep(80);
        } catch {}
      } else {
        try {
          s.proc.kill("SIGKILL");
        } catch {}
      }
    } finally {
      this.pendingStop.delete(deviceId);
    }
  }

  async stopAll() {
    const ids = Array.from(this.procs.keys());
    for (const id of ids) {
      try {
        await this.stop(id);
      } catch {}
    }
  }

  async applyLayout(items, layout, cell, options = {}) {
    if (!Array.isArray(items) || items.length === 0) return true;

    logger.audit("scrcpy:applyLayout", {
      count: items.length,
      layout: layout || {},
      cell: cell || {},
      options: options || {},
    });

    const mode = layout?.mode || "grid";
    const cols = Number.isFinite(layout?.cols) ? Number(layout.cols) : null;
    const rows = Number.isFinite(layout?.rows) ? Number(layout.rows) : null;
    const margin = Number.isFinite(layout?.margin) ? Number(layout.margin) : 8;

    const width = Number.isFinite(cell?.width) ? Number(cell.width) : 360;
    const height = Number.isFinite(cell?.height) ? Number(cell.height) : 800;

    const sendToBottom = !!options.sendToBottom;
    const noActivate = !!options.noActivate;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Number(options.timeoutMs)
      : 15000;
    const forceSize = !!options.forceSize;

    for (const it of items) {
      const title = it?.title;
      if (!title) continue;

      const rules = {
        width,
        height,
        margin,
        corner: "top-left",
        layoutMode: mode,
        slotIndex: Number.isFinite(it.slotIndex) ? Number(it.slotIndex) : 0,
        cols,
        rows,
        sendToBottom,
        noActivate,
        forceSize,
        timeoutMs,
      };

      try {
        await this._applyWindowRulesByTitle(title, rules);
      } catch (e) {
        logger.warn("scrcpy:applyLayout_failed", {
          title,
          msg: e?.message || String(e),
        });
      }

      await sleep(35);
    }

    return true;
  }

  // (phần _applyWindowRulesByTitle giữ nguyên 100% logic của bạn)
  _applyWindowRulesByTitle(title, rules) {
    const width = Number(rules.width || 360);
    const height = Number(rules.height || 800);
    const margin = Number(rules.margin || 8);
    const corner = String(rules.corner || "top-left");

    const layoutMode = String(rules.layoutMode || "corner");
    const slotIndex = Number.isFinite(rules.slotIndex)
      ? Number(rules.slotIndex)
      : 0;

    const cols = Number.isFinite(rules.cols) ? Number(rules.cols) : -1;
    const rows = Number.isFinite(rules.rows) ? Number(rules.rows) : -1;

    const sendToBottom = !!rules.sendToBottom;
    const noActivate = !!rules.noActivate;
    const forceSize = !!rules.forceSize;
    const timeoutMs = Number(rules.timeoutMs || 15000);

    const ps = `
$ProgressPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public static readonly IntPtr HWND_TOP = new IntPtr(0);

  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
}
"@ | Out-Null

function FindWindowContainsTitle($needle) {
  $script:found = [IntPtr]::Zero
  [Win32]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $t = $sb.ToString()
    if ($t -and $t.Contains($needle)) { $script:found = $hWnd; return $false }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  return $script:found
}

Add-Type -AssemblyName System.Windows.Forms | Out-Null
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$needle = ${JSON.stringify(title)}
$w = ${Math.round(width)}
$h = ${Math.round(height)}
$m = ${Math.round(margin)}
$corner = ${JSON.stringify(corner)}
$layoutMode = ${JSON.stringify(layoutMode)}
$slotIndex = ${slotIndex}
$colsFixed = ${Number.isFinite(cols) ? cols : -1}
$rowsFixed = ${Number.isFinite(rows) ? rows : -1}
$sendToBottom = ${sendToBottom ? "$true" : "$false"}
$noActivate = ${noActivate ? "$true" : "$false"}
$forceSize = ${forceSize ? "$true" : "$false"}
$timeoutMs = ${timeoutMs}

$deadline = (Get-Date).AddMilliseconds($timeoutMs)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and $hwnd -eq [IntPtr]::Zero) {
  $hwnd = FindWindowContainsTitle $needle
  Start-Sleep -Milliseconds 120
}
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }

function ComputeXY {
  param($wa, $w, $h, $m, $layoutMode, $slotIndex, $colsFixed, $rowsFixed, $corner)

  $X = $wa.Left + $m
  $Y = $wa.Top  + $m

  if ($layoutMode -eq "grid") {
    $cols = $colsFixed
    if ($cols -lt 1) {
      $cols = [Math]::Floor(($wa.Width - $m) / ($w + $m))
      if ($cols -lt 1) { $cols = 1 }
    }

    $col = $slotIndex % $cols
    $row = [Math]::Floor($slotIndex / $cols)

    if ($rowsFixed -ge 1 -and $row -ge $rowsFixed) { $row = $rowsFixed - 1 }

    $X = $wa.Left + $m + ($col * ($w + $m))
    $Y = $wa.Top  + $m + ($row * ($h + $m))

    if ($Y + 120 + $m -gt $wa.Bottom) {
      $Y = [Math]::Max($wa.Top + $m, $wa.Bottom - 160 - $m)
    }
  } else {
    if ($corner -eq "top-left") {
      $X = $wa.Left + $m; $Y = $wa.Top + $m
    } elseif ($corner -eq "top-right") {
      $X = $wa.Right - $w - $m; $Y = $wa.Top + $m
    } elseif ($corner -eq "bottom-left") {
      $X = $wa.Left + $m; $Y = $wa.Bottom - $h - $m
    } else {
      $X = $wa.Right - $w - $m; $Y = $wa.Bottom - $h - $m
    }
  }

  return @($X, $Y)
}

$xy = ComputeXY $wa $w $h $m $layoutMode $slotIndex $colsFixed $rowsFixed $corner
$X = $xy[0]; $Y = $xy[1]

for ($i=0; $i -lt 10; $i++) {
  if ($forceSize) {
    $flags = [Win32]::SWP_SHOWWINDOW
    if ($noActivate) { $flags = $flags -bor [Win32]::SWP_NOACTIVATE }
    [void][Win32]::SetWindowPos($hwnd, [Win32]::HWND_TOP, $X, $Y, $w, $h, $flags)
  } else {
    $flagsMoveOnly = [Win32]::SWP_NOSIZE -bor [Win32]::SWP_SHOWWINDOW
    if ($noActivate) { $flagsMoveOnly = $flagsMoveOnly -bor [Win32]::SWP_NOACTIVATE }
    [void][Win32]::SetWindowPos($hwnd, [Win32]::HWND_TOP, $X, $Y, 0, 0, $flagsMoveOnly)
  }
  Start-Sleep -Milliseconds 120
}

if ($sendToBottom) {
  $flagsBottom = [Win32]::SWP_NOMOVE -bor [Win32]::SWP_NOSIZE -bor [Win32]::SWP_SHOWWINDOW
  if ($noActivate) { $flagsBottom = $flagsBottom -bor [Win32]::SWP_NOACTIVATE }
  [void][Win32]::SetWindowPos($hwnd, [Win32]::HWND_BOTTOM, 0,0,0,0, $flagsBottom)
}

exit 0
`;

    return new Promise((resolve, reject) => {
      const encoded = toPsEncodedCommand(ps);

      const p = spawn(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encoded,
        ],
        { windowsHide: true }
      );

      p.stderr.on("data", (d) => {
        const s = d.toString("utf8").trim();
        if (s && !s.includes("CLIXML"))
          logger.warn("ps:stderr", { title, line: s.slice(0, 600) });
      });
      p.stdout.on("data", (d) => {
        const s = d.toString("utf8").trim();
        if (s) logger.info("ps:stdout", { title, line: s.slice(0, 600) });
      });

      p.on("close", (code) => {
        if (code === 0) return resolve(true);
        reject(new Error(`powershell exited code=${code}`));
      });
      p.on("error", reject);
    });
  }
}

module.exports = { scrcpy: new ScrcpyController() };

