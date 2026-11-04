import { test } from "node:test";
import assert from "node:assert/strict";
import { Outbox, messageBlock } from "../mods/unified-chat/queue.js";

const a = { key: "t1@1", address: "t1", status: "idle", turn: 0 };
const b = { key: "remote/t2@2", address: "remote/t2", status: "idle", turn: 0 };
const ok = (body) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });

test("every Send admits to a FIFO, including while working or blocked, without typing", () => {
  const outbox = new Outbox();
  for (const status of ["working", "blocked", "idle"]) outbox.enqueue({ ...a, status }, status);
  assert.deepEqual(outbox.get(a.key).items.map((item) => item.text), ["working", "blocked", "idle"]);
  assert.equal(outbox.pending.size, 0);
  assert.ok(messageBlock(null, "hi"));
  assert.ok(messageBlock(a, "  "));
  assert.ok(messageBlock(a, "\u001b"));
});

test("only a ready target dispatches; permission prompts never receive input", () => {
  const outbox = new Outbox();
  outbox.enqueue(a, "A");
  for (const status of ["working", "blocked", "error", null]) assert.deepEqual(outbox.dispatch([{ ...a, status }]), []);
  const [action] = outbox.dispatch([a]);
  assert.deepEqual(action.args, ["send", "--json", "--if", "idle", "--", "t1", "A"]);
  assert.deepEqual(outbox.dispatch([a]), []);
});

test("the next entry waits for an actual turn boundary, not a stale idle repaint", () => {
  const outbox = new Outbox();
  outbox.enqueue(a, "first"); outbox.enqueue(a, "second");
  const [first] = outbox.dispatch([a]);
  outbox.complete(first, ok({ started: true, turn: 0 }));
  assert.deepEqual(outbox.dispatch([a]), []);
  assert.deepEqual(outbox.dispatch([{ ...a, status: "working" }]), []);
  const [second] = outbox.dispatch([{ ...a, turn: 1 }]);
  assert.equal(second.args.at(-1), "second");
});

test("queues are isolated and unrelated ready agents can progress independently", () => {
  const outbox = new Outbox();
  outbox.enqueue(a, "A"); outbox.enqueue(b, "B");
  const [action] = outbox.dispatch([{ ...a, status: "working" }, b]);
  assert.equal(action.address, b.address);
  assert.equal(outbox.get(a.key).items[0].state, "queued");
});

test("a switched or recycled session never receives an old session's queue", () => {
  const outbox = new Outbox();
  outbox.enqueue(a, "old session");
  assert.deepEqual(outbox.dispatch([{ ...a, key: "t1@2" }]), []);
});

test("Stop pauses before the harness can report idle; Resume is explicit", () => {
  const outbox = new Outbox(); outbox.enqueue(a, "next");
  outbox.pause(a.key, "Stopped by you.");
  assert.deepEqual(outbox.dispatch([a]), []);
  outbox.resume(a.key);
  assert.equal(outbox.dispatch([a]).length, 1);
});

test("uncertain delivery halts the queue, retaining the entry for inspection", () => {
  const outbox = new Outbox(); outbox.enqueue(a, "maybe"); outbox.enqueue(a, "later");
  const [action] = outbox.dispatch([a]);
  outbox.complete(action, ok({ started: false, turn: 0 }));
  assert.equal(outbox.get(a.key).items[0].state, "uncertain");
  assert.throws(() => outbox.resume(a.key), /uncertain/);
  assert.deepEqual(outbox.dispatch([{ ...a, turn: 2 }]), []);
  outbox.remove(a.key, action.id); outbox.resume(a.key);
  assert.equal(outbox.dispatch([a])[0].args.at(-1), "later");
});

test("known readiness races retain an unsent entry, paused, rather than retrying", () => {
  const outbox = new Outbox(); outbox.enqueue(a, "draft");
  const [action] = outbox.dispatch([a]);
  outbox.complete(action, { code: 10, stdout: "", stderr: "status mismatch" });
  assert.equal(outbox.get(a.key).items[0].state, "queued");
  assert.equal(outbox.get(a.key).paused, true);
});

test("recovered queues always pause; interrupted submissions become uncertain", () => {
  const outbox = new Outbox(); outbox.enqueue(a, "in flight"); outbox.enqueue(a, "not yet sent");
  outbox.dispatch([a]);
  const restored = new Outbox(outbox.snapshot());
  assert.equal(restored.get(a.key).paused, true);
  assert.deepEqual(restored.get(a.key).items.map((item) => item.state), ["uncertain", "queued"]);
  assert.deepEqual(restored.dispatch([a]), []);
});

test("an in-flight entry cannot be removed before its delivery is known", () => {
  const outbox = new Outbox(); const item = outbox.enqueue(a, "hello");
  outbox.dispatch([a]);
  assert.equal(outbox.remove(a.key, item.id), false);
});
