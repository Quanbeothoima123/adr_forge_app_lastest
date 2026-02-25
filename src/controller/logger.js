// controller/logger.js
const fs = require("fs");
const path = require("path");

let _current = null; // current Logger instance (set when constructed)

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function ts(d = new Date()) {
  return d.toLocaleTimeString();
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return '"[unserializable]"';
  }
}

class Logger {
  constructor({ userDataPath, onLine }) {
    this.userDataPath = userDataPath;
    this.onLine = typeof onLine === "function" ? onLine : null;

    this.dir = path.join(userDataPath, "logs");
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {}

    this._curKey = "";
    this._curFile = "";

    // ✅ register singleton so other modules can log via require("./logger").audit(...)
    _current = this;
  }

  _ensureFile() {
    const k = dateKey(new Date());
    if (k !== this._curKey) {
      this._curKey = k;
      this._curFile = path.join(this.dir, `forge-${k}.log`);
    }
    return this._curFile;
  }

  _write(line) {
    const file = this._ensureFile();
    try {
      fs.appendFileSync(file, line + "\n", "utf8");
    } catch {}
    if (this.onLine) {
      try {
        this.onLine(line);
      } catch {}
    }
  }

  _log(level, msg, meta) {
    const line =
      `[${ts(new Date())}] ${level} ` +
      (msg || "") +
      (meta ? " " + safeJson(meta) : "");

    this._write(line);

    // console mirror
    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
  }

  info(msg, meta) {
    this._log("INFO", msg, meta);
  }
  health(msg, meta) {
    this._log("HEALTH", msg, meta);
  }
  audit(msg, meta) {
    this._log("AUDIT", msg, meta);
  }
  warn(msg, meta) {
    this._log("WARN", msg, meta);
  }
  error(msg, meta) {
    this._log("ERROR", msg, meta);
  }

  tailLines(maxLines = 300) {
    const file = this._ensureFile();
    try {
      if (!fs.existsSync(file)) return [];
      const raw = fs.readFileSync(file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      return lines.slice(-Math.max(1, maxLines));
    } catch {
      return [];
    }
  }
}

// ---- module-level proxy methods (so other files can do: const logger=require("./logger"); logger.audit(...)) ----
function _proxy(method, fallbackConsoleLevel = "log") {
  return (...args) => {
    if (_current && typeof _current[method] === "function") {
      return _current[method](...args);
    }
    // fallback if called before Logger is created
    const msg = args?.[0] || "";
    const meta = args?.[1];
    const line =
      `[${ts(new Date())}] ${method.toUpperCase()} ` +
      msg +
      (meta ? " " + safeJson(meta) : "");
    if (fallbackConsoleLevel === "error") console.error(line);
    else if (fallbackConsoleLevel === "warn") console.warn(line);
    else console.log(line);
  };
}

module.exports = {
  Logger,

  // proxy logging functions
  info: _proxy("info", "log"),
  health: _proxy("health", "log"),
  audit: _proxy("audit", "log"),
  warn: _proxy("warn", "warn"),
  error: _proxy("error", "error"),

  // optional proxy tail
  tailLines: (maxLines = 300) => (_current ? _current.tailLines(maxLines) : []),
};

