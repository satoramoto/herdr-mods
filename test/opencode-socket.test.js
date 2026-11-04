import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { startControlSocket } from "../adapters/opencode/socket.js";
import { controlRequest } from "../mods/unified-chat/opencode-control.mjs";

test("same-user IPC round trip is private, propagates errors, and cleans up its own endpoint", async (t) => {
  if (process.platform === "win32") return t.skip("Unix IPC bridge");
  let disposed = false;
  const bridge = await startControlSocket({ dispose() { disposed = true; }, request(input) {
    if (input.action !== "snapshot") throw new Error("Unsupported action");
    return { sessionID: input.sessionID };
  } });
  try {
    assert.equal((await lstat(bridge.report.path)).mode & 0o777, 0o600);
    assert.deepEqual(await controlRequest(bridge.report.path, { action: "snapshot", sessionID: "ses_fixture" }), { sessionID: "ses_fixture" });
    await assert.rejects(controlRequest(bridge.report.path, { action: "not-allowed" }), /Unsupported action/);
  } finally { await bridge.close(); }
  assert.ok(disposed);
  await assert.rejects(access(bridge.report.path));
});

test("ordinary files and non-private IPC locations cannot masquerade as the client bridge", async () => {
  const directory = await mkdtemp("/tmp/opencode/unified-chat-test-");
  try {
    const path = `${directory}/control.sock`;
    await writeFile(path, "not a socket", { mode: 0o600 });
    await assert.rejects(controlRequest(path, {}), /not private/);
    await assert.rejects(controlRequest("relative/control.sock", {}), /Invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
