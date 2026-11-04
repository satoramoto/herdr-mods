// Owned OpenCode session + terminal only. resume:false prevents model generation.
// Never sends to, interrupts, or closes an existing user session/terminal.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { controlRequest } from "../mods/unified-chat/opencode-control.mjs";
import { captureFiles, hydrateParts } from "../mods/unified-chat/attachments.mjs";
import { checkAttached } from "./check-attached.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp("/tmp/opencode/unified-chat-api-qa-");
const run = (program, args, timeout = 20000) => execFileSync(program, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }).trim();
const api = (method, path, body) => {
  const value = run("opencode", ["api", method, path, ...(body ? ["--data", JSON.stringify(body)] : [])]);
  return value ? JSON.parse(value) : null;
};
let sessionID, address, watcher, readyTimer;
try {
  await writeFile(join(scratch, "notes.txt"), "Immutable local attachment\nsecond line\n");
  await mkdir(join(scratch, "completion dir 🌱", "nested folder"), { recursive: true });
  await writeFile(join(scratch, "completion.txt"), "Inert command completion fixture");
  const qaPlugin = join(scratch, "qa-plugin");
  await mkdir(qaPlugin);
  await writeFile(join(qaPlugin, "package.json"), JSON.stringify({ name: "owned-completion-qa", type: "module", exports: { "./tui": "./tui.js" } }));
  await writeFile(join(qaPlugin, "tui.js"), `import { Plugin } from "@opencode/plugin/tui";
import { writeFileSync } from "node:fs";
export default Plugin.define({ id: "owned.completion.qa", setup(context) {
  context.keymap.layer(() => ({ mode: "global", commands: [{ id: "owned.qa.arguments", title: "Inert owned argument fixture",
    slash: { name: "qa-arguments", arguments: true }, run() { writeFileSync(${JSON.stringify(join(scratch, "qa-command-invoked"))}, "unexpected execution"); throw new Error("Completion must never execute this command"); } }] }));
} });\n`);
  const created = api("post", "/api/session", { title: "Unified composer owned API QA", location: { directory: scratch } });
  sessionID = created.data.id;
  const configHome = process.env.XDG_CONFIG_HOME ?? `${process.env.HOME}/.config`;
  const config = { session: { permissions: "prompt" }, plugins: [join(configHome, "opencode/herdr-opencode"), join(root, "adapters/opencode"), qaPlugin] };
  const nonce = `composer-api-qa-${Date.now()}`;
  // HC's first idle report can precede route hydration. Wait for the exact
  // session report using fact-change events, not sleeps or readiness polling.
  let inspect;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error("Owned TUI did not report the exact API session within 30 seconds.")), 30000);
    watcher = spawn("hc", ["events", "--json", "--label", `unified.qa=${nonce}`], { stdio: ["ignore", "pipe", "pipe"] });
    watcher.on("error", reject);
    inspect = () => {
      if (!address) return;
      try {
        const terminal = JSON.parse(run("hc", ["get", address]));
        const report = JSON.parse(terminal.records?.["unified-chat"]?.msg ?? "null");
        if (report?.sessionID === sessionID && report.bridge?.features?.includes("structured-prompts")) { clearTimeout(readyTimer); resolve(report); }
      } catch { /* A later fact-change event can finish hydration. */ }
    };
    watcher.stdout.on("data", inspect);
  });
  const started = JSON.parse(run("hc", ["run", "--json", "--bg", "--no-parent", "--no-notify", "--label", `unified.qa=${nonce}`, "--name", nonce, "--cwd", scratch,
    "--", "env", `OPENCODE_CLI_CONFIG_CONTENT=${JSON.stringify(config)}`, "opencode", "--session", sessionID, scratch]));
  address = started.address ?? started.terminal?.address ?? started.terminal;
  assert.equal(typeof address, "string");
  inspect();
  const report = await ready;
  watcher.kill(); watcher = null;
  assert.equal(report.sessionID, sessionID);
  assert.ok(report.bridge.features.includes("structured-prompts"));
  const call = (input) => controlRequest(report.bridge.path, { version: 1, terminalID: address, sessionID, ...input });
  const snapshot = await call({ action: "snapshot" });
  const directories = await call({ action: "complete-arguments", text: "/cd comp" });
  assert.equal(directories.kind, "directory");
  assert.ok(directories.items.some((item) => item.label === "completion dir 🌱/"));
  assert.ok(!directories.items.some((item) => item.label === "completion.txt"));
  const nested = await call({ action: "complete-arguments", text: "/cd completion dir 🌱/ne" });
  assert.ok(nested.items.some((item) => item.edit.value === "completion dir 🌱/nested folder/"));
  await mkdir(join(scratch, "completion newly created"));
  const freshDirectories = await call({ action: "complete-arguments", text: "/cd comp" });
  assert.ok(freshDirectories.items.some((item) => item.label === "completion newly created/"));
  const args = await call({ action: "complete-arguments", text: "/qa-arguments --keep=literal comp" });
  assert.equal(args.kind, "path");
  assert.ok(args.items.some((item) => item.label === "completion.txt"));
  assert.ok(args.items.some((item) => item.edit.value === '"completion dir 🌱/"'));
  const skillCatalogue = await call({ action: "catalog", collection: "skill" });
  const skill = skillCatalogue.items[0];
  const captured = await captureFiles([join(scratch, "notes.txt")], scratch);
  const id = `msg_uc_api_qa_${Date.now()}`;
  const text = "QA literal $(not executed)\nline two with 'quotes'";
  const result = await call({ action: "submit", id, text, parts: [...captured, ...(skill ? [{ kind: "skill", id: skill.id }] : [])], delivery: "queue", resume: false });
  assert.equal(result.id, id);
  const state = await call({ action: "state" });
  const queued = state.inbox.find((item) => item.id === id);
  assert.equal(queued.payload.text, text);
  assert.equal(queued.delivery, "queue");
  const detail = await call({ action: "queued-detail", id, includeBodies: true });
  const bytes = Buffer.from(detail.item.payload.files[0].data, "base64").toString("utf8");
  assert.equal(bytes, "Immutable local attachment\nsecond line\n");
  if (skill) assert.equal(queued.payload.skills[0].id, skill.id);
  const exported = await call({ action: "queued-export", id, captureHome: scratch });
  assert.equal(exported.draft.text, text);
  const restoredParts = await hydrateParts(exported.draft.parts);
  assert.equal(Buffer.from(restoredParts[0].uri.split(",")[1], "base64").toString("utf8"), bytes);
  assert.ok((await call({ action: "state" })).inbox.some((item) => item.id === id), "Copying a queued draft must not cancel it");
  assert.equal((await call({ action: "receipt", id })).found, true);
  await call({ action: "inbox-cancel", id });
  assert.ok(!(await call({ action: "state" })).inbox.some((item) => item.id === id));
  const form = api("post", `/api/session/${sessionID}/form`, { title: "Inert owned question fixture", fields: [
    { key: "boolean", type: "boolean", required: true },
    { key: "integer", type: "integer", minimum: 0, required: true },
    { key: "choices", type: "multiselect", custom: true, options: [{ value: "a", label: "A" }] },
  ] }).data;
  assert.ok((await call({ action: "state" })).forms.some((item) => item.id === form.id));
  await call({ action: "form-reply", id: form.id, answer: { boolean: false, integer: 0, choices: ["a", "custom"] } });
  const answered = api("get", `/api/session/${sessionID}/form/${form.id}`).data;
  assert.deepEqual(answered.state, { status: "answered", answer: { boolean: false, integer: 0, choices: ["a", "custom"] } });
  assert.ok(!(await call({ action: "state" })).forms.some((item) => item.id === form.id));
  api("patch", `/api/session/${sessionID}`, { permissions: [{ action: "unified-chat.qa.*", resource: "*", effect: "ask" }] });
  for (const decision of ["once", "reject"]) {
    // An inert permission fixture: no corresponding tool or shell is executed,
    // and no persistent approval pattern is ever created by this smoke.
    const permission = api("post", `/api/session/${sessionID}/permission`, { action: `unified-chat.qa.${nonce}.${decision}`, resources: ["inert-fixture-only"] }).data;
    assert.equal(permission.effect, "ask");
    const pending = (await call({ action: "state" })).permissions.find((item) => item.id === permission.id);
    assert.ok(pending);
    await call({ action: "permission-reply", id: pending.id, decision, expected: { action: pending.action, resources: pending.resources, save: pending.save ?? [] },
      ...(decision === "reject" ? { message: "Owned inert QA rejection" } : {}) });
    assert.ok(!(await call({ action: "state" })).permissions.some((item) => item.id === pending.id));
  }
  const shellID = `msg_uc_shell_qa_${Date.now()}`;
  await call({ action: "submit", id: shellID, mode: "shell", text: "/usr/bin/printf 'owned-shell-qa'" });
  const shell = api("get", `/api/session/${sessionID}/message/${shellID}`).data;
  assert.equal(shell.type, "shell");
  assert.equal(shell.command, "/usr/bin/printf 'owned-shell-qa'");
  assert.equal((await call({ action: "receipt", id: shellID })).found, true);
  const fixtureTarget = { address, sessionID, key: `${address}:${sessionID}`, status: "idle", label: "Owned API QA", space_name: "QA",
    terminal: { address, records: { "unified-chat": { app: "unified-chat", msg: JSON.stringify({ ...report, updatedAt: Date.now() }) } } } };
  const nativeResult = await checkAttached({ target: fixtureTarget, part: captured[0], completion: directories, commands: snapshot.commands });
  console.log(JSON.stringify(nativeResult, null, 2));
  assert.equal(nativeResult.passed, true, nativeResult.error);
  assert.equal(await readFile(join(scratch, "qa-command-invoked")).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }), false, "Completion executed the owned command callback");
  const after = api("get", `/api/session/${sessionID}`).data;
  assert.equal(after.cost, 0);
  assert.ok(!after.time.busy, "QA must not begin a model execution");
  const evidence = { passed: true, ownedSession: sessionID, ownedTerminal: address, exactClient: true,
    multilineExact: true, capturedFileBytesExact: true, structuredSkill: Boolean(skill), durableReceipt: true,
    nativeInboxCancel: true, completeQueuedDraftCopy: true, typedQuestionReply: true, falseAndZeroPreserved: true,
    permissionOnceAndReject: true, noPersistentPermissionChange: true, explicitShellAdmission: true, nativeComposer: nativeResult,
    liveDirectoryCompletion: true, liveArgumentCompletion: true, nestedSpaceUnicodePaths: true,
    filesystemChangesReflected: true, completionNeverExecuted: true,
    modelGenerationStarted: false, cost: after.cost, liveCommandEntries: snapshot.commands.length };
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(join(root, "evidence/opencode-api-result.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  clearTimeout(readyTimer); watcher?.kill();
  if (address) { try { run("hc", ["kill", address]); } catch {} try { run("hc", ["rm", address]); } catch {} }
  if (sessionID) { try { api("delete", `/api/session/${sessionID}`); } catch {} }
  await rm(scratch, { recursive: true, force: true });
}
