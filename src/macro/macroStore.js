// src/macro/macroStore.js
const fs = require("fs");
const path = require("path");

function macrosDir(userDataPath) {
  return path.join(userDataPath, "macros");
}

function safeId(id) {
  return String(id || "")
    .trim()
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 80);
}

function macroFile(userDataPath, id) {
  return path.join(macrosDir(userDataPath), `${safeId(id)}.json`);
}

function listMacros(userDataPath) {
  const dir = macrosDir(userDataPath);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

  const out = [];
  for (const f of files) {
    try {
      const p = path.join(dir, f);
      const raw = fs.readFileSync(p, "utf8");
      const obj = JSON.parse(raw);

      out.push({
        id: obj?.meta?.id || f.replace(/\.json$/i, ""),
        meta: obj?.meta || {},
      });
    } catch {
      // ignore broken file
    }
  }

  // newest first if has createdAt
  out.sort((a, b) => (b.meta?.createdAt || 0) - (a.meta?.createdAt || 0));
  return out;
}

function loadMacro(userDataPath, id) {
  const p = macroFile(userDataPath, id);
  if (!fs.existsSync(p)) throw new Error("Macro not found: " + id);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function saveMacro(userDataPath, macroObj) {
  const dir = macrosDir(userDataPath);
  fs.mkdirSync(dir, { recursive: true });

  const id = macroObj?.meta?.id || "macro";
  const p = macroFile(userDataPath, id);
  fs.writeFileSync(p, JSON.stringify(macroObj, null, 2), "utf8");
  return { ok: true, path: p, id };
}

module.exports = { listMacros, loadMacro, saveMacro };

