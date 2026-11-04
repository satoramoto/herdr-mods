import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperations, promptPayload } from "../adapters/opencode/operations.js";
import { RichDrafts } from "../mods/unified-chat/drafts.js";

function fixture() {
  const calls = [], inbox = [];
  let active = true;
  const session = { id: "ses_fixture", agent: "build", location: { directory: "/server/project" } };
  const client = {
    session: {
      prompt: async (input) => { calls.push(["prompt", input]); const item = { id: input.id ?? "msg_server", sessionID: session.id, type: "user", payload: input, delivery: input.delivery }; inbox.push(item); return item; },
      command: async (input) => { calls.push(["command", input]); },
      shell: async (input) => { calls.push(["shell", input]); },
      switchModel: async (input) => calls.push(["model", input]),
      switchAgent: async (input) => calls.push(["agent", input]),
      inbox: { list: async () => inbox, cancel: async (input) => { calls.push(["cancel", input]); }, update: async (input) => calls.push(["delivery", input]) },
      message: { get: async () => ({ type: "user" }) },
      form: { list: async () => [] }, interrupt: async (input) => calls.push(["interrupt", input]),
    }, permission: { list: async () => [] },
    file: { find: async (input) => { calls.push(["files", input]); return { location: session.location, data: [{ path: "src/a b.js", type: "file" }] }; } },
  };
  const context = { client,
    ui: { model: { current: () => ({ providerID: "p", modelID: "m", variant: "high" }) } },
    data: { location: {
      command: { sync: async () => {}, list: () => [{ name: "review" }] },
      model: { sync: async () => {}, list: () => [{ id: "m", providerID: "p", enabled: true, variants: [{ id: "high" }] }] },
      agent: { sync: async () => {}, list: () => [{ id: "plan", mode: "primary" }] },
    } }, keymap: { commands: () => [{ id: "cd", slash: { name: "cd", arguments: true }, run: async (input) => calls.push(["ui", input]) }], mode: { current: () => "base" } },
  };
  const selected = () => { if (!active) throw new Error("Recipient changed"); return session; };
  return { calls, inbox, context, active: (value) => { active = value; }, request: createOperations(context, selected, () => {}) };
}

test("structured prompts preserve text, file/skill/agent identity and queue vs steer without typing", async () => {
  const f = fixture();
  const text = "Literal $(not executed) and 'quotes'\nsecond line";
  const result = await f.request({ action: "submit", id: "msg_fixture_1234", text, delivery: "queue", resume: false,
    parts: [{ kind: "skill", id: "review" }, { kind: "agent", id: "explore" }, { kind: "file", uri: "data:text/plain;base64,SGk=", name: "a.txt" }] });
  assert.equal(result.accepted, true);
  assert.equal(result.id, "msg_fixture_1234");
  assert.deepEqual(f.calls.map(([kind]) => kind), ["model", "prompt"]);
  const sent = f.calls.at(-1)[1];
  assert.equal(sent.text, text); assert.equal(sent.delivery, "queue"); assert.equal(sent.resume, false);
  assert.deepEqual(sent.skills, [{ id: "review" }]); assert.deepEqual(sent.agents, [{ name: "explore" }]);
  assert.equal(sent.files[0].name, "a.txt");
  assert.ok(!("nativeDraft" in sent));
});

test("custom commands preserve raw arguments/attachments and UI commands never become model prompts", async () => {
  const f = fixture();
  await f.request({ action: "submit", text: '/review "two words" $(literal)', parts: [{ kind: "skill", id: "s" }] });
  assert.equal(f.calls.at(-1)[0], "command");
  assert.equal(f.calls.at(-1)[1].text, '"two words" $(literal)');
  await f.request({ action: "submit", text: "/cd /server/other" });
  assert.deepEqual(f.calls.at(-1), ["ui", "/server/other"]);
  await assert.rejects(f.request({ action: "submit", text: "/unknown" }), /Unknown/);
  assert.ok(!f.calls.some(([kind]) => kind === "prompt"));
});

test("argument-taking UI commands and aliases retain native precedence over server-name conflicts", async () => {
  const f = fixture();
  f.context.data.location.command.list = () => [{ name: "cd" }, { name: "chdir" }];
  f.context.keymap.commands = () => [{ id: "session.cd", slash: { name: "cd", aliases: ["chdir"], arguments: true }, run: async (input) => f.calls.push(["ui", input]) }];
  await f.request({ action: "submit", text: "/chdir path with spaces" });
  assert.deepEqual(f.calls, [["ui", "path with spaces"]]);
});

test("network errors never automatically retry an admission", async () => {
  const f = fixture(); let attempts = 0;
  f.context.client.session.prompt = async () => { attempts++; throw new Error("connection lost after write"); };
  await assert.rejects(f.request({ action: "submit", id: "msg_uncertain_1", text: "one request" }), /connection lost/);
  assert.equal(attempts, 1);
});

test("shell mode is explicit, preserves absolute commands and never invokes slash-command dispatch", async () => {
  const f = fixture();
  await f.request({ action: "submit", id: "msg_shell_12345", text: "/usr/bin/printf literal", mode: "shell" });
  assert.deepEqual(f.calls, [["shell", { sessionID: "ses_fixture", command: "/usr/bin/printf literal", id: "msg_shell_12345" }]]);
  await assert.rejects(f.request({ action: "submit", text: "echo x", mode: "shell", parts: [{ kind: "skill", id: "s" }] }), /cannot include/);
});

test("composer-owned primary agent/model selections are committed before exact prompt admission", async () => {
  const f = fixture();
  await f.request({ action: "submit", text: "chosen", selection: { agent: "plan", model: { id: "m", providerID: "p" } } });
  assert.deepEqual(f.calls.map(([kind]) => kind), ["agent", "model", "prompt"]);
  assert.equal(f.calls[0][1].agent, "plan");
  await assert.rejects(f.request({ action: "submit", text: "nope", selection: { agent: "removed" } }), /no longer available/);
});

test("session switching during model hydration aborts before mutation or prompt admission", async () => {
  const f = fixture();
  f.context.data.location.model.sync = async () => f.active(false);
  await assert.rejects(f.request({ action: "submit", text: "must not arrive" }), /Recipient changed/);
  assert.deepEqual(f.calls, []);
});

test("native inbox actions validate exact still-pending user IDs", async () => {
  const f = fixture();
  f.inbox.push({ id: "msg_pending", type: "user", delivery: "queue" });
  await f.request({ action: "inbox-delivery", id: "msg_pending", delivery: "steer" });
  await f.request({ action: "inbox-cancel", id: "msg_pending" });
  await assert.rejects(f.request({ action: "inbox-cancel", id: "msg_other" }), /no longer pending/);
  assert.deepEqual(f.calls.map(([kind]) => kind), ["delivery", "cancel"]);
  assert.equal((await f.request({ action: "receipt", id: "msg_pending" })).queued, true);
});

test("activity shows honest live cost/status and location-wide shells; family navigation rejects foreign sessions", async () => {
  const f = fixture(), navigated = [];
  f.context.data.session = { family: () => ["ses_fixture", "ses_child"], get: (id) => ({ id, title: id, agent: "build" }), status: () => ({ type: "idle" }) };
  f.context.ui.router = { navigate: (route) => navigated.push(route) };
  f.context.client.shell = {
    list: async ({ location }) => ({ location, data: [{ id: "sh_fixture", command: "fixture", status: "running", cwd: location.directory }] }),
    output: async (input) => { assert.equal(input.location.directory, "/server/project"); return { data: { output: "bytes", cursor: 5, size: 5, truncated: false } }; },
  };
  const value = await f.request({ action: "activity" });
  assert.equal(value.family.length, 2); assert.equal(value.shells[0].cwd, "/server/project");
  assert.equal(value.cost, undefined, "missing cost must never be invented");
  assert.equal((await f.request({ action: "shell-output", id: "sh_fixture" })).output, "bytes");
  await assert.rejects(f.request({ action: "navigate-family", id: "ses_foreign" }), /no longer in this family/);
  await f.request({ action: "navigate-family", id: "ses_child" });
  assert.deepEqual(navigated, [{ type: "session", sessionID: "ses_child" }]);
});

test("file ranges are server-scoped structured file URIs, with no local cwd guessing", async () => {
  const f = fixture();
  const result = await f.request({ action: "files", query: "src/a#10-20" });
  assert.equal(result.items[0].uri, "file:///server/project/src/a%20b.js?start=10&end=20");
  assert.equal(f.calls[0][1].location.directory, "/server/project");
  await assert.rejects(f.request({ action: "files", query: "src/a#20-10" }), /Invalid file line range/);
});

test("reference alias subpaths search the server's reference location, never the local filesystem", async () => {
  const f = fixture();
  f.context.data.location.reference = { sync: async () => {}, list: () => [{ name: "docs", path: "/server/reference" }] };
  f.context.client.file.find = async (input) => {
    assert.equal(input.location.directory, "/server/reference"); assert.equal(input.query, "src/a");
    return { location: input.location, data: [{ path: "src/a.md", type: "file" }] };
  };
  const result = await f.request({ action: "files", query: "docs/src/a#2-4" });
  assert.equal(result.items[0].uri, "file:///server/reference/src/a.md?start=2&end=4");
  assert.equal(result.items[0].name, "docs/src/a.md#2-4");
});

test("empty attachment-only prompts work; invalid deliveries, control bytes and arbitrary URLs fail", () => {
  assert.equal(promptPayload({ text: "", parts: [{ kind: "file", uri: "file:///a", name: "a" }] }).files.length, 1);
  assert.throws(() => promptPayload({ text: "" }), /Write a message/);
  assert.throws(() => promptPayload({ text: "hello", delivery: "force" }), /delivery/);
  assert.throws(() => promptPayload({ text: "\0" }), /Invalid/);
  assert.throws(() => promptPayload({ text: "hello", parts: [{ kind: "file", uri: "https://untrusted" }] }), /Unsupported attachment/);
});

test("structured drafts, history, unsent edits and stashes remain session-isolated", () => {
  const drafts = new RichDrafts();
  drafts.attach("one", { kind: "skill", id: "review" });
  drafts.attach("one", { kind: "skill", id: "review" });
  assert.equal(drafts.get("one").parts.length, 1);
  assert.equal(drafts.get("two").parts.length, 0);
  const sent = drafts.capture("one", "earlier"); drafts.submitted("one", sent);
  assert.equal(drafts.get("one").parts.length, 0);
  assert.equal(drafts.history("one", -1, { text: "unsent", parts: [], mode: "normal" }).text, "earlier");
  assert.equal(drafts.history("one", 1, {}).text, "unsent");
  drafts.stash("one", sent);
  assert.deepEqual(drafts.pop("one"), sent);
  assert.equal(drafts.pop("two"), null);
  const recovered = new RichDrafts(JSON.parse(JSON.stringify(drafts.snapshot())));
  assert.deepEqual(recovered.get("one").history[0].parts, [{ kind: "skill", id: "review" }]);
});
