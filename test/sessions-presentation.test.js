import { test } from "node:test";
import assert from "node:assert/strict";
import { groupsFor, agentLabel, ageLabel } from "../mods/sessions/presentation.js";

test("native list groups retain every visible session and omit identity aliases", () => {
  const rows = [
    { key: "saved", updatedAt: 10 }, { key: "connected", connected: true },
    { key: "background", active: true }, { key: "alias", aliasOf: "connected" },
  ];
  const groups = groupsFor(rows);
  assert.deepEqual(groups.map((group) => group.label), ["Connected", "Background", "Disconnected"]);
  assert.deepEqual(groups.flatMap((group) => group.rows.map((row) => row.key)), ["connected", "background", "saved"]);
  assert.equal(groupsFor(rows, "live").flatMap((g) => g.rows).length, 2);
  assert.equal(groupsFor(rows, "disconnected").flatMap((g) => g.rows).length, 2);
});
test("list labels use native harness names and honest activity ages", () => {
  assert.equal(agentLabel("claude"), "Claude Code");
  assert.equal(agentLabel("opencode"), "OpenCode");
  assert.equal(ageLabel(undefined), "");
  assert.equal(ageLabel(1000, 601000), "10m");
  assert.equal(ageLabel(1000, 86401000), "1d");
});

