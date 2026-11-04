import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreSubmissions, admitInOrder, admissionBlock } from "../mods/unified-chat/admission.js";

const item = (id, key = "session") => ({ id, key, state: "waiting", draft: { text: id, parts: [] } });
test("lost first acknowledgement blocks later FIFO admissions without retrying either", async () => {
  const first = item("first"), second = item("second"), calls = [];
  const items = new Map([[first.id, first], [second.id, second]]);
  const previous = admitInOrder({ items, item: first, previous: Promise.resolve(), send: async () => { calls.push("first"); throw new Error("lost ack"); } });
  await assert.rejects(previous, /lost ack/);
  const result = await admitInOrder({ items, item: second, previous: previous.catch(() => {}), send: async () => calls.push("second") });
  assert.equal(result, null); assert.equal(first.state, "uncertain"); assert.equal(second.state, "withheld");
  assert.deepEqual(calls, ["first"]); assert.equal(admissionBlock(items, "session"), first);
});
test("acknowledged FIFO releases the next item; another session is independent", async () => {
  const first = item("first"), second = item("second"), other = item("other", "other-session"), calls = [];
  const items = new Map([[first.id, first], [second.id, second], [other.id, other]]);
  const send = async (entry) => { calls.push(entry.id); items.delete(entry.id); return { accepted: true }; };
  await admitInOrder({ items, item: first, send: () => send(first) });
  await admitInOrder({ items, item: second, send: () => send(second) });
  first.state = "uncertain"; items.set(first.id, first);
  await admitInOrder({ items, item: other, send: () => send(other) });
  assert.deepEqual(calls, ["first", "second", "other"]);
});
test("reload distinguishes definitely-unsent waiting drafts from uncertain in-flight sends", () => {
  const restored = restoreSubmissions({ a: item("a"), b: { ...item("b"), state: "sending" } });
  assert.equal(restored.get("a").state, "withheld"); assert.equal(restored.get("b").state, "uncertain");
});
test("Stop withholds scheduled sends before they reach the server", async () => {
  const entry = { ...item("stopped"), state: "withheld" }; let calls = 0;
  assert.equal(await admitInOrder({ items: new Map([[entry.id, entry]]), item: entry, send: async () => calls++ }), null);
  assert.equal(calls, 0);
});
