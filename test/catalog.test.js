import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalSession, mergeCatalog, rescuePlan, launchArgs, resumeCommand } from "../adapters/session-catalog.js";
import { metadataFromLines, openCodeSessions } from "../scripts/session-sources.mjs";

const id = "11111111-2222-3333-4444-555555555555";
const empty = () => ({ version: 1, sessions: {} });
const options = (now = 1000) => ({ now, coreGeneration: "core1", serverGeneration: "server1" });
function terminal(agent = "claude", sessionID = id, args = [agent]) {
  return { address: "t1", created_ms: 100, state: "live", cwd: "/project", foreground: { name: agent, argv: args, cwd: "/project" },
    labels: { "herdr.space": "original", "herdr.tab": "tab" },
    records: { "unified-chat": { msg: JSON.stringify({ agent, terminalID: "t1", sessionID, updatedAt: 1000 }) } } };
}

test("every reporting harness is cataloged, including unknown ones without resume adapters", () => {
  for (const agent of ["claude", "codex", "pi", "omp", "gemini", "copilot", "cursor-agent", "opencode", "goose", "aider"]) {
    const state = mergeCatalog(empty(), [], [terminal(agent, agent === "opencode" ? "ses_one" : id)], options());
    assert.equal(Object.values(state.sessions).length, 1, agent);
    assert.equal(Object.values(state.sessions)[0].connected, true, agent);
  }
  const custom = { ...terminal("custom"), status: { app: "custom-harness", state: "working" }, records: {} };
  const state = mergeCatalog(empty(), [], [custom], options());
  assert.equal(Object.values(state.sessions)[0].agent, "custom-harness");
  assert.equal(Object.values(state.sessions)[0].resumable, false);
});

test("unknown identities remain listed after disconnect rather than being discarded", () => {
  const live = mergeCatalog(empty(), [], [{ ...terminal("copilot"), records: {} }], options());
  const disconnected = mergeCatalog(live, [], [], options(50000));
  const row = Object.values(disconnected.sessions)[0];
  assert.equal(row.connected, false);
  assert.equal(row.resumable, false);
  assert.deepEqual(rescuePlan(disconnected, []), []);
});

test("native Claude background orphan is attachable in the catalog, not cloned/resumed", () => {
  const background = { agent: "claude", sessionID: id, backgroundID: "11111111", directory: "/project", active: true, attachable: true };
  const state = mergeCatalog(empty(), [background], [], options());
  const [row] = rescuePlan(state, []);
  assert.deepEqual(resumeCommand(row), ["claude", "attach", "11111111"]);
  const args = launchArgs(row, { space: "recovery" });
  assert.ok(args.includes("herdr.space=recovery"));
  assert.deepEqual(args.slice(-4), ["--", "claude", "attach", "11111111"]);
  assert.ok(!args.some((arg) => /prompt|force|dangerously/.test(arg)));
});

test("a connected Claude attachment is not rescued twice, even via a short native ID", () => {
  const background = { agent: "claude", sessionID: id, backgroundID: "11111111", directory: "/project", active: true, attachable: true };
  const t = { ...terminal(), records: {}, foreground: { name: "claude", argv: ["claude", "attach", "11111111"] } };
  const state = mergeCatalog(empty(), [background], [t], options());
  assert.equal(state.sessions["claude:background:11111111"].connected, true);
  assert.deepEqual(rescuePlan(state, [t]), []);
});

test("an already rescued native background session is not reopened after intentional detach", () => {
  const row = { agent: "claude", sessionID: id, backgroundID: "11111111", directory: "/project", active: true, attachable: true, rescueSeen: true };
  const state = mergeCatalog(empty(), [row], [], options());
  assert.deepEqual(rescuePlan(state, []), []);
  state.sessions["claude:background:11111111"].restorePending = true;
  assert.equal(rescuePlan(state, []).length, 1);
});

test("a native background UUID changing on cold attach cannot create another view", () => {
  const oldID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const first = { agent: "claude", sessionID: oldID, backgroundID: "job123", directory: "/project", active: true, attachable: true, source: "claude-background" };
  let state = mergeCatalog(empty(), [first], [], options());
  state.sessions["claude:background:job123"].attempted = true;
  state.sessions["claude:background:job123"].rescueSeen = true;
  const changed = { ...first, sessionID: id };
  const t = { ...terminal(), records: {}, foreground: { name: "claude", argv: ["claude", "attach", "job123"] } };
  state = mergeCatalog(state, [changed], [t], options(2000));
  assert.equal(state.sessions["claude:background:job123"].connected, true);
  assert.equal(state.sessions["claude:background:job123"].sessionID, id);
  assert.deepEqual(rescuePlan(state, [t]), []);
  assert.equal(Object.values(state.sessions).filter((row) => !row.aliasOf).length, 1);
});

test("legacy UUID/short-id duplicates collapse by job id without deleting old saved transcripts", () => {
  const oldID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const previous = empty();
  for (const [sessionID, source] of [[oldID, "saved"], [id, "claude-background"], ["job123", undefined]]) {
    previous.sessions[`claude:${sessionID}`] = { agent: "claude", sessionID, source, directory: "/project", backgroundID: "job123", launch: { address: "t1" } };
  }
  const t = { ...terminal(), records: {}, foreground: { name: "claude", argv: ["claude", "attach", "job123"] } };
  const state = mergeCatalog(previous, [{ agent: "claude", sessionID: id, directory: "/project", backgroundID: "job123", active: true, attachable: true, source: "claude-background" }], [t], options());
  assert.equal(state.sessions["claude:background:job123"].connected, true);
  assert.equal(state.sessions[`claude:${id}`].aliasOf, "claude:background:job123");
  assert.equal(state.sessions["claude:job123"].aliasOf, "claude:background:job123");
  assert.equal(state.sessions[`claude:${oldID}`].aliasOf, undefined);
  assert.equal(state.sessions[`claude:${oldID}`].backgroundID, undefined);
  assert.deepEqual(resumeCommand(state.sessions[`claude:${oldID}`]), ["claude", "--resume", oldID]);
  assert.deepEqual(rescuePlan(state, [t]), []);
});

test("saved history is always visible but is never all auto-launched", () => {
  const state = mergeCatalog(empty(), [{ agent: "opencode", sessionID: "ses_saved", directory: "/project", title: "saved" }], [], options());
  assert.equal(Object.values(state.sessions).length, 1);
  assert.deepEqual(rescuePlan(state, []), []);
});

test("core loss recovers all verified harnesses to their recorded placement", () => {
  for (const [agent, sessionID] of [["claude", id], ["codex", id], ["pi", "/sessions/exact.jsonl"], ["opencode", "ses_one"]]) {
    const live = mergeCatalog(empty(), [], [terminal(agent, sessionID)], options());
    const state = mergeCatalog(live, [], [], { ...options(2000), coreGeneration: "core2" });
    const [row] = rescuePlan(state, []);
    assert.equal(row.agent, agent);
    assert.ok(launchArgs(row, { space: row.space, tab: row.tab }).includes("herdr.tab=tab"));
    if (agent === "codex") assert.ok(resumeCommand(row).includes("--no-daemon"));
  }
});

test("server outage does not erase a pending OpenCode recovery", () => {
  const live = mergeCatalog(empty(), [], [terminal("opencode", "ses_one")], options());
  const offline = mergeCatalog(live, [], [], { ...options(50000), serverGeneration: null });
  assert.equal(offline.sessions["opencode:ses_one"].open, true);
  const recovered = mergeCatalog(offline, [], [], { ...options(60000), serverGeneration: "server2" });
  assert.equal(rescuePlan(recovered, []).length, 1);
});

test("closing a client keeps its catalog entry without auto-reopening it", () => {
  const live = mergeCatalog(empty(), [], [terminal()], options());
  const closed = mergeCatalog(live, [{ agent: "claude", sessionID: id, directory: "/project" }], [], options(40000));
  assert.equal(closed.sessions[`claude:${id}`].open, false);
  const restarted = mergeCatalog(closed, [], [], { ...options(50000), coreGeneration: "core2" });
  assert.deepEqual(rescuePlan(restarted, []), []);
  assert.equal(Object.keys(restarted.sessions).length, 1);
});

test("external processes, remote and private-server sessions are visible but never duplicated", () => {
  for (const row of [
    { agent: "claude", sessionID: id, directory: "/project", runningExternal: true },
    { agent: "opencode", sessionID: "ses_one", directory: "/project", privateServer: true },
  ]) assert.equal(resumeCommand(row), null);
  const t = { ...terminal("opencode", "ses_one"), address: "remote/t1", records: {}, foreground: { name: "opencode", argv: ["opencode", "--session", "ses_one"] } };
  assert.equal(terminalSession(t).privateServer, true);
});

test("paths and session IDs are passed as argv, never through a shell", () => {
  const row = { agent: "pi", sessionID: "/sessions/a'; nope.jsonl", directory: "/project/a'; nope", key: "pi:exact" };
  const args = launchArgs(row, { space: "recovery" });
  assert.equal(args.at(-1), row.sessionID);
  assert.equal(args[args.indexOf("--cwd") + 1], row.directory);
});

test("native-file discovery extracts metadata only, omitting bodies and sidechains", () => {
  const text = [
    { type: "queue-operation", sessionId: id, content: "PRIVATE PROMPT" },
    { type: "user", sessionId: id, cwd: "/project", message: { content: "PRIVATE BODY" } },
    { type: "custom-title", customTitle: "Named conversation" },
  ].map(JSON.stringify).join("\n");
  const result = metadataFromLines(text, "claude", "/sessions/file");
  assert.equal(result.sessionID, id);
  assert.equal(result.title, "Named conversation");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(metadataFromLines(text + '\n{"isSidechain":true}', "claude", "/sessions/file"), null);
});

test("a deleted historical project never hides the rest of OpenCode's catalog", async () => {
  const requests = [];
  const source = await openCodeSessions(async (_program, args) => {
    requests.push(args);
    if (args[0] === "service") return "http://127.0.0.1:1234";
    if (args[2] === "/api/info") return JSON.stringify({ pid: process.pid, hostname: "test" });
    if (args[2] === "/api/session/active") return '{"data":{}}';
    if (args[2].startsWith("/api/session?")) return JSON.stringify({ data: [{ id: "ses_saved", title: "Saved", location: { directory: "/nonexistent/sessions-test-project" }, time: { updated: 1 } }] });
    throw new Error("Deleted projects must not be loaded to query their background jobs");
  });
  assert.equal(source.rows.length, 1);
  assert.equal(source.rows[0].title, "Saved");
  assert.ok(!requests.some((args) => args[2]?.startsWith("/api/shell")));
});
