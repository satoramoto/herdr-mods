import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptionPlan, sameHarnessIdentity } from "../adapters/adoption.js";
import { startDrag, dragMoved, canDrop } from "../mods/sessions/drag-model.js";

const row = { key: "opencode:ses_one", agent: "opencode", sessionID: "ses_one", connected: true, terminal: "t1", terminalCreated: 42, directory: "/project" };
const terminal = { address: "t1", state: "live", created_ms: 42 };
const target = { id: "music", machine: null };
const expected = { terminal: "t1", created: 42 };

test("live adoption relabels one existing terminal, never launching or replaying work", () => {
  const plan = adoptionPlan(row, target, terminal, expected);
  assert.deepEqual(plan.labels, ["label", "t1", "herdr.space=music", "herdr.tab="]);
  assert.deepEqual(plan.placement, { adoptedSpace: "music", space: "music", tab: null });
  assert.equal(plan.terminal, "t1");
  assert.ok(!JSON.stringify(plan).includes("run"));
});
test("saved adoption places an entry without launching its harness or changing cwd", () => {
  const plan = adoptionPlan({ ...row, connected: false }, target, null, { terminal: null, created: null });
  assert.equal(plan.labels, null);
  assert.equal(plan.terminal, null);
  assert.equal(plan.placement.adoptedSpace, "music");
  assert.ok(!Object.hasOwn(plan.placement, "directory"));
});
test("stale/recycled, remote, missing and changed-session drags fail closed", () => {
  for (const candidate of [{ ...terminal, created_ms: 43 }, { ...terminal, state: "finished" }, null]) {
    assert.throws(() => adoptionPlan(row, target, candidate, expected), /changed/);
  }
  assert.throws(() => adoptionPlan(row, { ...target, machine: "remote" }, terminal, expected), /this machine/);
  assert.throws(() => adoptionPlan(undefined, target, terminal, expected), /identity/);
  assert.throws(() => adoptionPlan({ ...row, connected: false }, target, null, expected), /disconnected/);
  assert.equal(sameHarnessIdentity(row, { agent: "opencode", sessionID: "ses_other" }), false);
  assert.equal(sameHarnessIdentity(row, { agent: "opencode", sessionID: "ses_one" }), true);
});
test("drag requires real movement, a fresh pointer gesture and a local destination", () => {
  const drag = startDrag(row, { x: 10, y: 10 }, 1000);
  assert.deepEqual(drag.expected, expected);
  assert.equal(dragMoved(drag, { x: 11, y: 10 }, 1100), false);
  assert.equal(canDrop(drag, target, { x: 30, y: 40 }, 1100), true);
  assert.equal(canDrop(drag, target, { x: 30, y: 40 }, 20000), false);
  assert.equal(canDrop(null, target, { x: 30, y: 40 }, 1100), false);
  assert.equal(canDrop({ key: "broken", at: 1000 }, target, { x: 30, y: 40 }, 1100), false);
  assert.equal(canDrop(drag, { ...target, machine: "remote" }, { x: 30, y: 40 }, 1100), false);
});
