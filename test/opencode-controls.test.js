import { test } from "node:test";
import assert from "node:assert/strict";
import { createControls, liveCommands } from "../adapters/opencode/controls.js";
import { bridgeFor, commandOptions, promptLabels } from "../mods/unified-chat/prompt.js";

function fixture() {
  let route = { type: "session", sessionID: "ses_one" }, mode = "base", chosen = "high";
  const calls = [];
  const collection = (items) => ({ list: () => items, sync: async () => { calls.push("sync"); } });
  const session = { id: "ses_one", agent: "build", location: { directory: "/work" }, model: { id: "m", providerID: "p" } };
  const context = {
    ui: {
      router: { current: () => route }, model: { current: () => ({ modelID: "m", providerID: "p", variant: chosen }),
        variant: { list: () => ["low", "high"], set: (value) => { if (value && !["low", "high"].includes(value)) return false; chosen = value; return true; } } },
    },
    data: {
      session: { get: () => session, message: { list: () => [] }, permission: { list: () => undefined }, form: { list: () => undefined } },
      location: { default: () => session.location, model: collection([{ id: "m", providerID: "p", name: "Live Model" }]),
        provider: collection([{ id: "p", name: "Provider" }]), command: collection([{ name: "team/review", description: "Team command" }]),
        skill: collection([{ id: "review", name: "Review", content: "private skill body", path: "/private" }]),
        agent: collection([]), reference: collection([]) },
    },
    keymap: { mode: { current: () => mode }, shortcuts: () => ["ctrl+p"], commands: () => [
      { id: "palette", title: "Commands", palette: true, run: () => calls.push("palette") },
      { id: "agents", title: "Switch agent", slash: { name: "agents", aliases: ["agent"] }, run: (input) => calls.push(input ?? "agents") },
      { id: "disabled", slash: { name: "disabled" }, enabled: () => false, run: () => calls.push("BAD") },
    ] },
  };
  return { context, calls, route: (value) => { route = value; }, mode: (value) => { mode = value; }, controls: createControls(context, "t1") };
}
const request = (extra = {}) => ({ version: 1, terminalID: "t1", sessionID: "ses_one", ...extra });

test("live registry includes aliases, custom commands and shortcuts, not disabled entries", () => {
  const { context } = fixture();
  const commands = liveCommands(context, { directory: "/work" });
  assert.deepEqual(commandOptions(commands, "/agent", true).map((item) => item.label), ["/agent", "/agents"]);
  assert.equal(commandOptions(commands, "team", true)[0].kind, "server");
  assert.ok(!JSON.stringify(commands).includes("disabled"));
});

test("snapshot uses the real client's unsent model/variant, exact location, and honest unknown approval state", async () => {
  const { controls } = fixture();
  const data = await controls.request(request({ action: "snapshot" }));
  assert.equal(data.sessionID, "ses_one");
  assert.equal(data.metadata.variant, "high");
  assert.equal(data.directory, "/work");
  assert.equal(data.permissionCount, null);
  assert.equal(data.nativeRequired, true);
});

test("wrong session, terminal, protocol, home route and disposed bridge fail closed", async () => {
  const f = fixture();
  for (const input of [{ sessionID: "ses_other" }, { terminalID: "t2" }, { version: 2 }]) {
    await assert.rejects(f.controls.request(request({ action: "snapshot", ...input })), /Recipient changed/);
  }
  f.route({ type: "home" });
  await assert.rejects(f.controls.request(request({ action: "snapshot" })), /Recipient changed/);
  f.controls.dispose();
  await assert.rejects(f.controls.request(request({ action: "snapshot" })), /reloaded/);
});

test("session changes during asynchronous catalogue sync cannot return another session's controls", async () => {
  const f = fixture();
  f.context.data.location.command.sync = async () => f.route({ type: "session", sessionID: "ses_other" });
  await assert.rejects(f.controls.request(request({ action: "snapshot" })), /Recipient changed/);
});

test("commands are explicit, live-validated and refuse native approval/dialog modes", async () => {
  const f = fixture();
  await f.controls.request(request({ action: "command", id: "agents", input: "plan" }));
  assert.deepEqual(f.calls, ["plan"]);
  await assert.rejects(f.controls.request(request({ action: "command", id: "disabled" })), /no longer available/);
  f.mode("permission");
  await assert.rejects(f.controls.request(request({ action: "command", id: "palette" })), /dialog\/question/);
  assert.deepEqual(f.calls, ["plan"]);
});

test("variant selection uses the supported UI API and refuses unlisted variants", async () => {
  const f = fixture();
  assert.equal((await f.controls.request(request({ action: "variant", value: "low" }))).metadata.variant, "low");
  await assert.rejects(f.controls.request(request({ action: "variant", value: "made-up" })), /no longer has/);
  assert.equal((await f.controls.request(request({ action: "variant", value: null }))).metadata.variant, null);
});

test("catalogues omit skill contents, filesystem paths and hidden entries", async () => {
  const f = fixture();
  const result = await f.controls.request(request({ action: "catalog", collection: "skill" }));
  assert.deepEqual(result.items, [{ id: "review", name: "Review", description: "", mode: undefined }]);
  assert.ok(!JSON.stringify(result).includes("private"));
  await assert.rejects(f.controls.request(request({ action: "catalog", collection: "credentials" })), /Unsupported/);
});

test("control reports require a fresh, exact local terminal/session and never guess a remote IPC path", () => {
  const payload = { terminalID: "t1", sessionID: "ses_one", updatedAt: Date.now(), bridge: { version: 1, path: "/tmp/opencode/example/control.sock" } };
  const target = { address: "t1", sessionID: "ses_one", terminal: { address: "t1", records: { "unified-chat": { app: "unified-chat", msg: JSON.stringify(payload) } } } };
  assert.equal(bridgeFor(target).version, 1);
  assert.equal(bridgeFor({ ...target, sessionID: "ses_other" }), null);
  assert.equal(bridgeFor({ ...target, address: "remote/t1" }), null);
});

test("native-like labels keep unknown values honest and distinguish sampled context", () => {
  assert.equal(promptLabels(null).mode, "Mode not reported");
  assert.equal(promptLabels({ mode: "build", used: 138200, window: 628000 }).context, "~138.2k (22%)");
  assert.equal(promptLabels({ mode: "build" }).mode, "Build");
  assert.equal(promptLabels({ model: "New selection", updatedAt: 2000 }, { metadata: { model: "Stale selection", updatedAt: 1000 } }).model, "New selection");
});
