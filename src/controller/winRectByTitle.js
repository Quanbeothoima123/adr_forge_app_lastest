// controller/winRectByTitle.js
// Windows-only helper (PowerShell + WinAPI) to get window rectangles by title.

const { spawn } = require("child_process");

function toPsEncodedCommand(psScript) {
  return Buffer.from(psScript, "utf16le").toString("base64");
}

function _runPsGetRect(psScript, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    const encoded = toPsEncodedCommand(psScript);
    const p = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true }
    );

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      reject(new Error("getWindowRect timeout"));
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.stderr.on("data", (d) => (err += d.toString("utf8")));

    p.on("close", () => {
      clearTimeout(timer);
      const s = out.trim();
      if (!s) return resolve(null);

      const parts = s.split(",").map((x) => Number(x));
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        return resolve(null);
      }

      const [L, T, R, B] = parts;
      return resolve({ x: L, y: T, w: Math.max(0, R - L), h: Math.max(0, B - T) });
    });

    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function getWindowRectByTitleContains(titleNeedle, timeoutMs = 1200) {
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
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
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

$needle = ${JSON.stringify(titleNeedle)}
$hwnd = FindWindowContainsTitle $needle
if ($hwnd -eq [IntPtr]::Zero) { Write-Output ""; exit 0 }

$rect = New-Object Win32+RECT
[void][Win32]::GetWindowRect($hwnd, [ref]$rect)
Write-Output ("{0},{1},{2},{3}" -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
exit 0
`;

  return _runPsGetRect(ps, timeoutMs);
}

// ✅ Client rect in screen coords (excludes title bar + borders)
function getWindowClientRectByTitleContains(titleNeedle, timeoutMs = 1200) {
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
  public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
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

$needle = ${JSON.stringify(titleNeedle)}
$hwnd = FindWindowContainsTitle $needle
if ($hwnd -eq [IntPtr]::Zero) { Write-Output ""; exit 0 }

$rc = New-Object Win32+RECT
[void][Win32]::GetClientRect($hwnd, [ref]$rc)

$ptTL = New-Object Win32+POINT
$ptTL.X = $rc.Left
$ptTL.Y = $rc.Top
[void][Win32]::ClientToScreen($hwnd, [ref]$ptTL)

$ptBR = New-Object Win32+POINT
$ptBR.X = $rc.Right
$ptBR.Y = $rc.Bottom
[void][Win32]::ClientToScreen($hwnd, [ref]$ptBR)

Write-Output ("{0},{1},{2},{3}" -f $ptTL.X, $ptTL.Y, $ptBR.X, $ptBR.Y)
exit 0
`;

  return _runPsGetRect(ps, timeoutMs);
}

module.exports = {
  getWindowRectByTitleContains,
  getWindowClientRectByTitleContains,
};


