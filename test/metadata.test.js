import { test } from "node:test";
import assert from "node:assert/strict";
import { openCodeSession, inspectOpenCode, metadataText, reportedMetadata, contextPercent } from "../mods/unified-chat/metadata.js";

test("TUI metadata is session-exact, address-checked, and expires instead of guessing", () => {
  const payload = { sessionID: "ses_selected", terminalID: "t1", updatedAt: 1000 };
  const terminal = { address: "remote/t1", records: { "unified-chat": { app: "unified-chat", msg: JSON.stringify(payload) } } };
  assert.equal(reportedMetadata(terminal, 2000).sessionID, "ses_selected");
  assert.equal(reportedMetadata(terminal, 50000), null);
  assert.equal(reportedMetadata({ ...terminal, address: "t2" }, 2000), null);
});

test("session mapping uses reported IDs and refuses ambiguous records", () => {
  const records = { ses_one: { app: "opencode", title: "one" }, ses_two: { app: "opencode", title: "two" } };
  assert.equal(openCodeSession({ records }), null);
  assert.equal(openCodeSession({ records, report: { title: "two" } }), "ses_two");
  assert.equal(openCodeSession({ records: { ses_one: records.ses_one } }), null);
  assert.equal(openCodeSession({ records: { ses_one: records.ses_one }, report: { title: "one" } }), "ses_one");
  assert.equal(openCodeSession({ cwd: "/project" }), null);
});

test("a fresh home-screen report cannot fall back to an older session", () => {
  const terminal = {
    address: "t1", report: { title: "old session" }, records: {
      ses_old: { app: "opencode", title: "old session" },
      "unified-chat": { app: "unified-chat", msg: JSON.stringify({ terminalID: "t1", sessionID: null, updatedAt: Date.now() }) },
    },
  };
  assert.equal(openCodeSession(terminal), null);
});

test("metadata reports selected model/mode/variant, not a default or cumulative token total", () => {
  const session = { id: "ses_one", agent: "build", model: { id: "m", providerID: "p", variant: "high" }, tokens: { input: 9999999 } };
  const models = [{ id: "m", providerID: "p", name: "Model", limit: { context: 200000, input: 180000 } }];
  const messages = [
    { type: "assistant", model: session.model, time: { created: 3 } },
    { type: "assistant", model: session.model, time: { completed: 2 }, tokens: { input: 1000, output: 500, reasoning: 900, cache: { read: 20000, write: 0 } } },
  ];
  const result = inspectOpenCode(session, models, messages);
  assert.equal(result.used, 21500);
  assert.equal(result.window, 200000);
  assert.equal(result.mode, "build");
  assert.equal(result.variant, "high");
  assert.match(metadataText(result), /~21.5k \/ 200k · 11%/);
});

test("old-model usage and missing data are not shown as the current context", () => {
  const data = inspectOpenCode({ id: "ses_one", model: { id: "new", providerID: "p" } }, [], [
    { type: "assistant", model: { id: "old", providerID: "p" }, time: { completed: 1 }, tokens: { input: 999 } },
  ]);
  assert.equal(data.used, null);
  assert.equal(data.window, null);
  assert.match(metadataText(null), /not reported/);
});

test("existing installed Claude metadata support is retained, without inventing a mode", () => {
  const payload = { terminalID: "t1", sessionID: "12345678-1234-1234-1234-123456789abc", agent: "claude", model: "Claude", used: 1000, window: 100000, percent: 4, updatedAt: Date.now() };
  const terminal = { address: "t1", records: { "unified-chat": { app: "unified-chat", msg: JSON.stringify(payload) } } };
  assert.equal(reportedMetadata(terminal).agent, "claude");
  assert.equal(contextPercent(payload), 4);
  assert.ok(!metadataText(payload).includes("Mode not reported"));
  payload.percent = "NaN";
  terminal.records["unified-chat"].msg = JSON.stringify(payload);
  assert.equal(reportedMetadata(terminal), null);
});
