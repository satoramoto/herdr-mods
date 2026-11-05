import { test } from "node:test";
import assert from "node:assert/strict";
import { composerMode, withMode, stateFilePath, stateFileText, barCommand, barKey, barTarget, MODES } from "../mods/pane-composer/composer-mode.js";

test("unified is the default; only harness choices are stored", () => {
  assert.deepEqual(MODES, ["unified", "harness"]);
  assert.equal(composerMode(undefined, "t5x"), "unified");
  assert.equal(composerMode({ t5x: "harness" }, "t5x"), "harness");
  assert.equal(composerMode({ t5x: "bogus" }, "t5x"), "unified");
  assert.deepEqual(withMode(null, "t5x", "harness"), { t5x: "harness" });
  assert.deepEqual(withMode({ t5x: "harness", t60: "harness" }, "t5x", "unified"), { t60: "harness" });
});

test("the state file is per local terminal and never path-like", () => {
  assert.equal(stateFilePath("/home/ryan", "t5x"), "/home/ryan/.local/state/unified-chat/composer/t5x.json");
  assert.equal(stateFilePath("/home/ryan", "box/t7"), null);
  assert.equal(stateFilePath("/home/ryan", "../x"), null);
  assert.equal(stateFilePath("/home/ryan", null), null);
  assert.deepEqual(JSON.parse(stateFileText("harness", 5)), { composer: "harness", updatedAt: 5 });
  assert.deepEqual(JSON.parse(stateFileText("anything", 5)), { composer: "unified", updatedAt: 5 });
});

test("the bar hides for the harness composer and shows for the unified one", () => {
  assert.equal(barCommand("harness"), "layout.hide");
  assert.equal(barCommand("unified"), "layout.show");
});

test("the bar follows the terminal the window focuses, keyed with its mode", () => {
  assert.equal(barTarget(null), null);
  assert.equal(barTarget({ terminal: "t5x", shown: null, agent: null }), "t5x");
  assert.equal(barTarget({ terminal: "t5x", shown: "t70", agent: null }), "t70");
  assert.equal(barTarget({ terminal: null, shown: null, agent: null }), null);
  assert.equal(barKey({ terminal: "t5x", shown: null }, { t5x: "harness" }), "t5x:harness");
  assert.equal(barKey({ terminal: "t5w", shown: null }, { t5x: "harness" }), "t5w:unified");
  assert.equal(barKey({ terminal: null, shown: null }, {}), null);
});
