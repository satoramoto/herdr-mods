import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexOperations, codexRecord, contextUsage, inputItems, policyLabel, sandboxLabel } from "../adapters/codex/operations.js";

const MODELS = [
  { id: "gpt-6-astra", model: "gpt-6-astra", displayName: "GPT-6-Astra", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map((e) => ({ reasoningEffort: e, description: e })) },
  { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", hidden: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }] },
];

function harness({ turns = [] } = {}) {
  const calls = [];
  let info = { model: "gpt-6-astra", effort: "medium", approvalPolicy: "on-request", sandbox: { type: "workspaceWrite" }, cwd: "/work", name: "Thread", status: { type: "idle" } };
  let override = {};
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") return { data: turns };
    if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [] } };
    if (method === "turn/steer") return { turnId: params.expectedTurnId };
    if (method === "turn/interrupt") return {};
    if (method === "fuzzyFileSearch") return { files: [{ path: "src/a.js", root: "/work", file_name: "a.js", score: 1, match_type: "fuzzy" }] };
    if (method === "thread/shellCommand") return {};
    throw new Error(`unexpected ${method}`);
  };
  const ops = createCodexOperations({ request, terminalID: "t1", threadId: "thread-1", info: () => info, models: async () => MODELS, usage: () => null,
    override: () => override, setOverride: (next) => { override = { ...override, ...next }; }, applied: (next) => { info = { ...info, ...next }; override = {}; }, changed: () => {} });
  const call = (input) => ops({ version: 1, terminalID: "t1", sessionID: "thread-1", ...input });
  return { call, calls, info: () => info };
}

test("snapshot and catalogue describe the thread's model and efforts", async () => {
  const { call } = harness();
  const snapshot = await call({ action: "snapshot" });
  assert.deepEqual(snapshot.selected, { id: "gpt-6-astra", providerID: "openai", variant: "medium" });
  assert.deepEqual(snapshot.variants, ["low", "medium", "high"]);
  assert.equal(snapshot.metadata.model, "GPT-6-Astra");
  const catalogue = await call({ action: "catalog", collection: "model" });
  assert.deepEqual(catalogue.items.map((item) => item.id), ["gpt-6-astra"]);
  await assert.rejects(call({ action: "catalog", collection: "skill" }), /Unsupported/);
});

test("requests for another terminal or thread are refused", async () => {
  const { call } = harness();
  await assert.rejects(call({ action: "snapshot", terminalID: "t2" }), /Recipient changed/);
  await assert.rejects(call({ action: "snapshot", sessionID: "thread-2" }), /Recipient changed/);
});

test("a submit becomes one turn/start carrying the composer's model and effort", async () => {
  const { call, calls, info } = harness();
  await call({ action: "variant", value: "high" });
  await assert.rejects(call({ action: "variant", value: "ultra" }), /no longer has/);
  const sent = await call({ action: "submit", id: "msg_1", text: "hello", selection: { model: { id: "gpt-6-astra", variant: "low" } } });
  assert.deepEqual(sent, { sessionID: "thread-1", accepted: true, kind: "prompt", id: "turn-1" });
  const start = calls.find((c) => c.method === "turn/start");
  assert.deepEqual(start.params, { threadId: "thread-1", input: [{ type: "text", text: "hello" }], clientUserMessageId: "msg_1", model: "gpt-6-astra", effort: "low" });
  assert.equal(info().effort, "low");
  await assert.rejects(call({ action: "submit", text: "/model" }), /native TUI/);
  await assert.rejects(call({ action: "submit", text: "", parts: [] }), /Write a message/);
});

test("steer uses the active turn and falls back to a new turn when idle", async () => {
  const busy = harness({ turns: [{ id: "turn-9", status: "inProgress" }] });
  const steered = await busy.call({ action: "submit", text: "also this", delivery: "steer" });
  assert.equal(steered.id, "turn-9"); assert.equal(steered.steered, true);
  const idle = harness();
  const started = await idle.call({ action: "submit", text: "now", delivery: "steer" });
  assert.equal(started.id, "turn-1");
  assert.deepEqual(await idle.call({ action: "interrupt" }), { sessionID: "thread-1", result: null, idle: true });
  assert.deepEqual(await busy.call({ action: "interrupt" }), { sessionID: "thread-1", result: { turnId: "turn-9" } });
  assert.equal((await busy.call({ action: "receipt", id: "turn-9" })).found, true);
  assert.equal((await busy.call({ action: "receipt", id: "turn-0" })).found, false);
});

test("attachments map to Codex input items or refuse", () => {
  assert.deepEqual(inputItems("x", [{ kind: "file", uri: "data:image/png;base64,AAAA" }]), [{ type: "text", text: "x" }, { type: "image", url: "data:image/png;base64,AAAA" }]);
  assert.deepEqual(inputItems("", [{ kind: "file", uri: "file:///tmp/a.png" }]), [{ type: "localImage", path: "/tmp/a.png" }]);
  assert.deepEqual(inputItems("", [{ kind: "reference", uri: "file:///tmp/notes.md" }]), [{ type: "text", text: "@/tmp/notes.md" }]);
  assert.throws(() => inputItems("x", [{ kind: "skill", id: "s" }]), /file and image/);
});

test("file search returns file URIs with optional ranges", async () => {
  const { call } = harness();
  const files = await call({ action: "files", query: "a#3-5" });
  assert.equal(files.items[0].uri, "file:///work/src/a.js?start=3&end=5");
  assert.equal(files.items[0].name, "src/a.js#3-5");
});

test("record and labels read like Codex's own settings", () => {
  assert.equal(policyLabel({ granular: {} }), "granular");
  assert.equal(sandboxLabel({ type: "readOnly" }), "read-only");
  assert.deepEqual(contextUsage({ last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 }, modelContextWindow: 1000 }), { used: 160, window: 1000 });
  const record = codexRecord({ terminalID: "t1", threadId: "thread-1", models: MODELS, now: 5,
    info: { model: "gpt-6-astra", effort: "high", approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    usage: { last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 }, modelContextWindow: 1000, sampledAt: 4 } });
  assert.equal(record.agent, "codex"); assert.equal(record.model, "GPT-6-Astra"); assert.equal(record.mode, "never");
  assert.equal(record.sandbox, "full-access"); assert.equal(record.percent, 16); assert.deepEqual(record.flags, ["waitingOnApproval"]);
  assert.equal(record.updatedAt, 5);
});
