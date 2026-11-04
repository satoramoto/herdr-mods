// Codex app-server client over the shared local daemon's Unix socket.
//
// Verified against Codex 0.166.0: the interactive TUI hosts its threads on the
// managed daemon (`codex app-server --listen unix:// --managed-daemon`), whose
// socket speaks WebSocket (HTTP Upgrade) carrying one JSON-RPC message per text
// frame. Same-user only; no token is exchanged for the Unix transport.
//
// This module is transport only. Every method is the caller's choice; the audit
// uses read-only ones (initialize, thread/loaded/list, thread/list).
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
export const CONTROL_SOCKET = join(CODEX_HOME, "app-server-control", "app-server-control.sock");

// One masked client text frame (RFC 6455 §5.2). Clients must mask.
export function encodeFrame(text, mask = randomBytes(4)) {
  const data = Buffer.from(text, "utf8");
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x81, 0x80 | n])
    : n < 65536 ? Buffer.concat([Buffer.from([0x81, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })()])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  const masked = Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]));
  return Buffer.concat([head, mask, masked]);
}

// Server frames are unmasked. Returns complete frames and the unread remainder.
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    const masked = Boolean(buffer[offset + 1] & 0x80);
    let length = buffer[offset + 1] & 0x7f;
    let i = offset + 2;
    if (length === 126) { if (buffer.length < i + 2) break; length = buffer.readUInt16BE(i); i += 2; }
    else if (length === 127) { if (buffer.length < i + 8) break; length = Number(buffer.readBigUInt64BE(i)); i += 8; }
    let mask = null;
    if (masked) { if (buffer.length < i + 4) break; mask = buffer.subarray(i, i + 4); i += 4; }
    if (buffer.length < i + length) break;
    let payload = buffer.subarray(i, i + length);
    if (mask) payload = Buffer.from(payload.map((byte, k) => byte ^ mask[k % 4]));
    frames.push({ opcode, payload });
    offset = i + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export async function resolveSocket(path = CONTROL_SOCKET) {
  try { return resolve(dirname(path), await readlink(path)); } catch { return path; }
}

// Opens the socket, completes the Upgrade handshake and `initialize`.
// Returns { request, notify, notifications, close, serverInfo }.
export async function openAppServer({ socketPath, clientInfo = { name: "herdr-unified-chat", version: "0" }, capabilities = {}, timeout = 5000 } = {}) {
  const path = await resolveSocket(socketPath);
  const socket = connect(path);
  const pending = new Map();
  const notifications = [];
  let listeners = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let nextId = 1;

  const fail = (error) => { for (const [, entry] of pending) entry.reject(error); pending.clear(); };
  const deliver = (message) => {
    if (message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id);
      if (message.error) entry.reject(Object.assign(new Error(message.error.message ?? "app-server error"), { data: message.error }));
      else entry.resolve(message.result);
    } else if (message.method) {
      notifications.push(message);
      for (const listener of listeners) listener(message);
    }
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) { fail(new Error(`Codex app-server refused the WebSocket upgrade: ${head.split("\r\n")[0]}`)); socket.destroy(); return; }
      upgraded = true;
      upgradeDone();
    }
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === 8) { fail(new Error("Codex app-server closed the connection.")); socket.end(); return; }
      if (frame.opcode !== 1) continue;
      try { deliver(JSON.parse(frame.payload.toString("utf8"))); } catch { /* ignore a malformed frame */ }
    }
  });
  socket.on("error", (error) => fail(error));
  socket.on("close", () => fail(new Error("Codex app-server connection closed.")));

  let upgradeDone;
  const upgraded$ = new Promise((resolveUpgrade, reject) => {
    upgradeDone = resolveUpgrade;
    pending.set("upgrade", { resolve: resolveUpgrade, reject });
    setTimeout(() => reject(new Error("Timed out waiting for the Codex app-server upgrade.")), timeout).unref();
  });
  await new Promise((resolveConnect, reject) => { socket.once("connect", resolveConnect); socket.once("error", reject); });
  const key = randomBytes(16).toString("base64");
  socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await upgraded$;
  pending.delete("upgrade");

  const send = (message) => socket.write(encodeFrame(JSON.stringify(message)));
  const request = (method, params = {}) => new Promise((resolveRequest, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveRequest, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Codex app-server did not answer ${method} within ${timeout}ms.`)); } }, timeout).unref();
    send({ jsonrpc: "2.0", id, method, params });
  });
  const notify = (method, params = {}) => send({ jsonrpc: "2.0", method, params });

  const serverInfo = await request("initialize", { clientInfo, capabilities });
  notify("initialized");
  return {
    serverInfo, request, notify, notifications,
    onNotification(listener) { listeners.push(listener); return () => { listeners = listeners.filter((item) => item !== listener); }; },
    close() { socket.end(); socket.destroy(); },
  };
}
