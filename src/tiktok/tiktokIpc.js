// src/tiktok/tiktokIpc.js
const { TikTokHarvestManager } = require("./tiktokHarvestManager");

function attachTikTokIpc({
  ipcMain,
  app,
  registry,
  getGroupById,
  logger,
  loadMacroByIdFromStore,
}) {
  const mgr = new TikTokHarvestManager({
    userDataPath: app.getPath("userData"),
    registry,
    getGroupById,
    logger,
  });

  ipcMain.handle("tiktok:status", async () => mgr.status());

  ipcMain.handle("tiktok:start", async (_, payload) => {
    return mgr.start(payload || {}, { loadMacroByIdFromStore });
  });

  ipcMain.handle("tiktok:stop", async () => {
    return mgr.stop();
  });

  return mgr;
}

module.exports = { attachTikTokIpc };

