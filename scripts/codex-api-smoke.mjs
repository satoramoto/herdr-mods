// Owned Codex thread only, on the already-running app-server daemon. Starts the
// reporter sidecar against that thread with a scratch file standing in for the
// terminal, exercises the control socket read-only, then deletes the thread.
// `--allow-generation` additionally starts one real turn and interrupts it at once.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { openAppServer } from "../adapters/codex/app-server.mjs";
import { controlRequest } from "../mods/unified-chat/opencode-control.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowGeneration = process.argv.includes("--allow-generation");
const scratch = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || "/tmp", "unified-chat-codex-qa-"));
const terminalID = "qa";
let daemon, threadId, reporter;
const result = { passed: false, generation: allowGeneration };
try {
  daemon = await openAppServer({ clientInfo: { name: "herdr-codex-smoke", version: "0" }, timeout: 15000 });
  const started = await daemon.request("thread/start", { cwd: scratch });
  threadId = started.thread.id;
  result.ownedThread = threadId;
  const pty = join(scratch, "terminal.txt"), statePath = join(scratch, "state.json");
  await readFile(pty).catch(async () => (await import("node:fs/promises")).writeFile(pty, ""));
  reporter = spawn(process.execPath, [join(root, "adapters/codex/unified-chat-reporter.mjs"), "--thread", threadId, "--terminal", terminalID, "--pty", pty, "--parent", String(process.pid), "--state", statePath], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; reporter.stderr.on("data", (c) => { stderr += c; });
  const deadline = Date.now() + 15000;
  let bridge;
  while (!bridge && Date.now() < deadline) {
    try { bridge = JSON.parse(await readFile(statePath, "utf8")).bridge; } catch { /* not yet */ }
    if (!bridge) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(bridge?.path, `reporter published no bridge: ${stderr}`);
  const records = (await readFile(pty, "utf8")).split("\x1b]7501;").slice(1).map((s) => s.split("\x1b\\")[0]);
  const record = JSON.parse(Buffer.from(records.at(-1).split("msg=")[1], "base64").toString());
  assert.equal(record.agent, "codex"); assert.equal(record.sessionID, threadId); assert.equal(record.terminalID, terminalID);
  assert.equal(record.bridge.path, bridge.path);
  result.record = { model: record.model, mode: record.mode, sandbox: record.sandbox, variant: record.variant, status: record.status };

  const call = (input) => controlRequest(bridge.path, { version: 1, terminalID, sessionID: threadId, ...input });
  const snapshot = await call({ action: "snapshot" });
  assert.equal(snapshot.sessionID, threadId); assert.ok(snapshot.selected.id); assert.ok(snapshot.variants.length > 0);
  result.snapshot = { model: snapshot.selected.id, variant: snapshot.selected.variant, variants: snapshot.variants, directory: snapshot.directory };
  const models = await call({ action: "catalog", collection: "model" });
  assert.ok(models.items.some((m) => m.id === snapshot.selected.id));
  result.models = models.items.length;
  const other = snapshot.variants.find((v) => v !== snapshot.selected.variant) ?? snapshot.variants[0];
  const changed = await call({ action: "variant", value: other });
  assert.equal(changed.selected.variant, other);
  await assert.rejects(call({ action: "variant", value: "not-an-effort" }));
  await assert.rejects(call({ version: 1, terminalID: "other", sessionID: threadId, action: "snapshot" }), /Recipient changed/);
  const files = await call({ action: "files", query: "state" });
  assert.ok(files.items.some((f) => f.id.endsWith("state.json")), JSON.stringify(files).slice(0, 300));
  result.liveFileSearch = true;
  const idle = await call({ action: "interrupt" });
  assert.equal(idle.idle, true);
  const missing = await call({ action: "receipt", id: "01900000-0000-7000-8000-000000000000" });
  assert.equal(missing.found, false);
  await assert.rejects(call({ action: "submit", text: "/model" }), /native TUI/);
  await assert.rejects(call({ action: "submit", text: "" }), /Write a message/);
  result.readOnlyChecks = true;
  if (allowGeneration) {
    const sent = await call({ action: "submit", text: "Reply with the single word OK.", delivery: "queue" });
    assert.equal(sent.accepted, true); assert.ok(sent.id);
    const stop = await call({ action: "interrupt" });
    const receipt = await call({ action: "receipt", id: sent.id });
    assert.equal(receipt.found, true);
    result.generation = { turnId: sent.id, interrupted: stop.result?.turnId === sent.id, receipt: receipt.found };
  }
  result.passed = true;
} finally {
  reporter?.kill("SIGTERM");
  if (daemon && threadId) await daemon.request("thread/delete", { threadId }).catch((e) => { result.cleanupError = e.message; });
  daemon?.close();
  await rm(scratch, { recursive: true, force: true });
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(join(root, "evidence", "codex-api-result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
