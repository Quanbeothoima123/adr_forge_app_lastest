// src/tiktok/httpJson.js
const http = require("http");
const https = require("https");

function postJson(urlStr, bodyObj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error("Invalid URL"));
      return;
    }

    const lib = u.protocol === "https:" ? https : http;
    const payload = Buffer.from(JSON.stringify(bodyObj), "utf8");

    const req = lib.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
        path: u.pathname + (u.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({
            status: res.statusCode || 0,
            raw,
            json,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error("HTTP timeout"));
      } catch {}
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { postJson };

