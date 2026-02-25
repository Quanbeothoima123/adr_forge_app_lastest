// controller/agentInput.js
const { ensureForward, sendJson } = require("./socketClient");

const BASE_HOST_PORT = 28100; // host port base, per device slot

function hostPortForDevice(deviceId) {
  // bạn có thể thay bằng slot index mapping nếu muốn ổn định tuyệt đối
  // tạm thời dùng hash đơn giản để tránh trùng
  let h = 0;
  for (const c of String(deviceId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BASE_HOST_PORT + (h % 200);
}

async function ping(deviceId) {
  const hostPort = hostPortForDevice(deviceId);
  await ensureForward(deviceId, hostPort);
  await sendJson(hostPort, { type: "PING" }, 1000);
  return true;
}

async function tap(deviceId, x, y) {
  const hostPort = hostPortForDevice(deviceId);
  await ensureForward(deviceId, hostPort);
  await sendJson(hostPort, { type: "TAP", x, y }, 1200);
  return true;
}

async function swipe(deviceId, x1, y1, x2, y2, durationMs = 220) {
  const hostPort = hostPortForDevice(deviceId);
  await ensureForward(deviceId, hostPort);
  await sendJson(hostPort, { type: "SWIPE", x1, y1, x2, y2, durationMs }, 1500);
  return true;
}

async function longPress(deviceId, x, y, durationMs = 600) {
  const hostPort = hostPortForDevice(deviceId);
  await ensureForward(deviceId, hostPort);
  await sendJson(hostPort, { type: "LONG_PRESS", x, y, durationMs }, 1500);
  return true;
}

async function key(deviceId, key) {
  const hostPort = hostPortForDevice(deviceId);
  await ensureForward(deviceId, hostPort);
  await sendJson(hostPort, { type: "KEY", key }, 1200);
  return true;
}

async function text(deviceId, text) {
  const hostPort = hostPortForDevice(deviceId);
  await ensureForward(deviceId, hostPort);
  await sendJson(hostPort, { type: "TEXT", text }, 2000);
  return true;
}

module.exports = { ping, tap, swipe, longPress, key, text };

