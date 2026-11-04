import { test } from "node:test";
import assert from "node:assert/strict";
import { Composer, targetsFrom, targetFromFocus, decodeResult } from "../mods/unified-chat/model.js";

const a = { key: "t1@1", address: "t1", status: "idle" };
const b = { key: "remote/t2@2", address: "remote/t2", status: "idle" };

test("target routing follows the shown terminal, never a random agent or shell", () => {
  assert.equal(targetFromFocus([a, b], { shown: b.address, terminal: a.address }), b);
  assert.equal(targetFromFocus([a, b], { terminal: "shell", agent: a.address }), null);
  assert.equal(targetFromFocus([a, b], { terminal: a.address }, b.address), b);
  assert.equal(targetFromFocus([a], { terminal: a.address }, "missing"), null);
  assert.equal(targetFromFocus([a], null), null);
});

test("only live agents are targets; recycled addresses and switched sessions get distinct keys", () => {
  const agent = { address: "t1", status: "idle", program: { name: "Claude Code" } };
  assert.deepEqual(targetsFrom([agent], []), []);
  assert.deepEqual(targetsFrom([agent], [{ address: "t1", state: "finished" }]), []);
  const first = targetsFrom([agent], [{ address: "t1", state: "live", created_ms: 10, status: "working" }])[0];
  const next = targetsFrom([agent], [{ address: "t1", state: "live", created_ms: 20, status: "idle", report: { title: "one" }, records: { ses_one: { app: "opencode", title: "one" } } }])[0];
  const switched = targetsFrom([agent], [{ address: "t1", state: "live", created_ms: 20, status: "idle", report: { title: "two" }, records: { ses_two: { app: "opencode", title: "two" } } }])[0];
  assert.notEqual(first.key, next.key);
  assert.notEqual(next.key, switched.key);
  assert.equal(first.status, "working");
  assert.equal(next.label, "Claude Code");
});

test("drafts follow targets, survive reload, and ignore malformed stored entries", () => {
  const model = new Composer();
  model.select(a.key); model.edit("For A");
  model.select(b.key); model.edit("For B");
  model.select(a.key);
  assert.equal(model.text(), "For A");
  const restored = new Composer({ ...model.snapshot(), bad: { invalid: true } });
  restored.select(b.key);
  assert.equal(restored.text(), "For B");
  assert.equal(restored.text("bad"), "");
});

test("core JSON errors are decoded from stdout or stderr", () => {
  assert.throws(() => decodeResult({ code: 0, stdout: '{"error":{"message":"Blocked"}}' }), /Blocked/);
  assert.throws(() => decodeResult({ code: 9, stdout: "", stderr: '{"error":{"message":"Permission prompt"}}' }), /Permission prompt/);
});

test("missing terminal reports never inherit an idle display status", () => {
  const [target] = targetsFrom([{ address: "t1", status: "idle" }], [{ address: "t1", state: "live" }]);
  assert.equal(target.status, "unknown");
});
