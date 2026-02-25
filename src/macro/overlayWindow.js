// macro/overlayWindow.js
const { BrowserWindow } = require("electron");

function createOverlay() {
  const win = new BrowserWindow({
    width: 300,
    height: 600,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { contextIsolation: true },
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
    <html><body style="margin:0; background:rgba(255,0,0,0.12); border:2px solid rgba(255,0,0,0.55); font-family:Arial;">
      <div style="position:absolute; top:8px; left:8px; padding:6px 10px; border-radius:8px; background:rgba(0,0,0,0.55); color:#fff; font-size:12px;">
        RECORDING
      </div>
    </body></html>
  `)
  );
  return win;
}

module.exports = { createOverlay };

