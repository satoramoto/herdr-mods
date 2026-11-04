import { test } from "node:test";
import assert from "node:assert/strict";
import { subTree, kidStatus, agentName, orderedSpaces, topStatus, duration } from "../mods/fold/tree.js";

test("sub-agents nest under their parent, depth first, with tree lines", () => {
  const all = [
    { address: "t1", state: "live", parent: null },
    { address: "t2", state: "live", parent: "t1" },
    { address: "t3", state: "live", parent: "t2" },
    { address: "t4", state: "live", parent: "t1" },
    { address: "t5", state: "done", parent: "t1" },
  ];
  assert.deepEqual(subTree(all, "t1").map((s) => [s.t.address, s.lines.join("")]), [["t2", "├"], ["t3", "│└"], ["t4", "└"]]);
  const listed = new Map([["t2", "working"]]);
  assert.equal(kidStatus({ address: "t2", status: "idle" }, listed), "working");
  assert.equal(kidStatus({ address: "t9", status: "error" }, listed), "blocked");
  assert.equal(kidStatus({ address: "t9", status: "done" }, listed), "idle");
});

test("an agent reads by its tab's title; a numbered tab falls back to the program", () => {
  const ps = [{ tab: "tb1", terminal: "t1", title: "✳ Fix login", program: { name: "Claude Code", key: "claude", agent: true } }];
  const tabs = [{ id: "tb1", name: "1", named: false }, { id: "tb2", name: "review", named: true }, { id: "tb3", name: "2", named: false }];
  assert.equal(agentName({ tab: "tb1", program: { name: "Claude Code" } }, tabs, ps), "Fix login");
  assert.equal(agentName({ tab: "tb2", program: { name: "Codex" } }, tabs, ps), "review");
  assert.equal(agentName({ tab: "tb3", program: { name: "Codex" } }, tabs, []), "Codex");
  assert.equal(agentName({ tab: "gone", title: "", program: { name: "Pi" } }, tabs, []), "Pi");
});

test("worktree spaces sit under their checkout, only once it is listed", () => {
  const sp = [{ id: "a" }, { id: "wt" }, { id: "b" }, { id: "late" }];
  const git = { a: { repo: "r1", linked: false }, wt: { repo: "r1", linked: true }, b: null, late: { repo: "r2", linked: true } };
  const out = orderedSpaces(sp, (w) => git[w.id], new Set(["a", "wt", "b"]));
  assert.deepEqual(out.map((r) => [r.w.id, r.tree]), [["a", null], ["wt", "└─"], ["b", null]]);
});

test("status roll-up and durations", () => {
  assert.equal(topStatus(["idle", "working", "blocked", "done"]), "blocked");
  assert.equal(topStatus([]), null);
  assert.equal(duration(30000), "<1m");
  assert.equal(duration(25 * 3600000), "1d");
});
