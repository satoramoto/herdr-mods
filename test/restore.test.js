import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRegistry, validateRegistry, reportedSession, reconcile, restoreArgs } from "../adapters/opencode/restore-model.js";

const session = (id = "ses_one") => ({ id, location: { directory: "/project" } });
const terminal = (id = "ses_one") => ({
  address: "t4", created_ms: 10, state: "live", foreground: { name: "opencode.exe", argv: ["opencode"] },
  labels: { "herdr.space": "space", "herdr.tab": "tab" },
  records: { "unified-chat": { msg: JSON.stringify({ terminalID: "t4", sessionID: id }) } },
});
const snapshot = (overrides = {}) => ({ generation: "server1", terminals: [terminal()], sessions: { ses_one: session() }, now: 1000, ...overrides });
const tracked = () => reconcile(emptyRegistry(), snapshot()).state;

test("only pane-exact local shared clients are registered; no historical discovery", () => {
  const { state, actions } = reconcile(emptyRegistry(), snapshot({ sessions: { ses_one: session(), ses_unrelated: session("ses_unrelated") } }));
  assert.deepEqual(Object.keys(state.bindings), ["ses_one"]);
  assert.equal(state.bindings.ses_one.tab, "tab");
  assert.deepEqual(actions, []);
});

test("private, explicit-server, remote, shell, home and ambiguous reports are excluded", () => {
  for (const argv of [["opencode", "--standalone"], ["opencode", "--server", "http://remote"], ["opencode", "--server=http://remote"]]) {
    const t = terminal(); t.foreground.argv = argv; assert.equal(reportedSession(t), null);
  }
  assert.equal(reportedSession({ ...terminal(), address: "remote/t4" }), null);
  assert.equal(reportedSession({ ...terminal(), foreground: { name: "zsh" } }), null);
  assert.equal(reportedSession(terminal(null)), null);
  assert.equal(reportedSession({ ...terminal(), records: { "unified-chat": { msg: "broken" } } }), null);
});

test("surviving clients are never duplicated after server restart", () => {
  const result = reconcile(tracked(), snapshot({ generation: "server2" }));
  assert.deepEqual(result.actions, []);
  assert.equal(result.state.bindings.ses_one.pending, false);
});

test("missing client is restored once to its recorded tab, not by replaying work", () => {
  const shell = { ...terminal(), foreground: { name: "zsh", argv: ["zsh"] } };
  const { state, actions } = reconcile(tracked(), snapshot({ generation: "server2", terminals: [shell] }));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].sessionID, "ses_one");
  const args = restoreArgs(actions[0]);
  assert.deepEqual(args.slice(-5), ["--", "opencode", "--session", "ses_one", "/project"]);
  assert.ok(args.includes("herdr.tab=tab"));
  assert.ok(!args.some((arg) => /npm|prompt|force/.test(arg)));
  state.bindings.ses_one.attempted = true;
  assert.deepEqual(reconcile(state, snapshot({ generation: "server2", terminals: [shell] })).actions, []);
});

test("a reconnecting TUI without hydrated records is not duplicated", () => {
  const result = reconcile(tracked(), snapshot({ generation: "server2", terminals: [{ ...terminal(), records: {} }] }));
  assert.deepEqual(result.actions, []);
  assert.equal(result.state.bindings.ses_one.pending, true);
});

test("intentional quit stays closed on subsequent server startup", () => {
  const closed = reconcile(tracked(), snapshot({ terminals: [], now: 40000 })).state;
  assert.equal(closed.bindings.ses_one.open, false);
  assert.deepEqual(reconcile(closed, snapshot({ generation: "server2", terminals: [] })).actions, []);
});

test("session switching retires the old selection; child sessions are not restored", () => {
  const switched = reconcile(tracked(), snapshot({ terminals: [terminal("ses_two")], sessions: { ses_two: session("ses_two") } })).state;
  assert.equal(switched.bindings.ses_one.open, false);
  assert.equal(switched.bindings.ses_two.open, true);
  assert.deepEqual(reconcile(emptyRegistry(), snapshot({ sessions: { ses_one: { ...session(), parentID: "ses_parent" } } })).state.bindings, {});
});

test("missing/deleted session and transient lookup failure never launch a client", () => {
  for (const sessions of [{ ses_one: null }, {}]) {
    const result = reconcile(tracked(), snapshot({ generation: "server2", terminals: [], sessions }));
    assert.deepEqual(result.actions, []);
  }
});

test("invalid saved bindings fail closed rather than being silently discarded", () => {
  assert.throws(() => validateRegistry({ version: 2 }), /retained unchanged/);
  assert.throws(() => validateRegistry({ version: 1, bindings: { bad: {} } }), /retained unchanged/);
});

test("paths are distinct argv entries, not interpolated shell commands", () => {
  const binding = { ...tracked().bindings.ses_one, directory: "/project/a'; touch /bad" };
  assert.equal(restoreArgs(binding).at(-1), binding.directory);
  assert.throws(() => restoreArgs({ ...binding, sessionID: "ses_bad; command" }), /Invalid restore target/);
});
