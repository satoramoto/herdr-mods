import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeOptions, claudeAction, modeLabel, MODELS, EFFORTS } from "../mods/unified-chat/claude-control.js";

test("model options filter by alias and accept a full model id", () => {
  assert.equal(claudeOptions("models").length, MODELS.length);
  assert.deepEqual(claudeOptions("models", "opus").map((item) => item.id), ["opus", "opusplan", "opus[1m]"]);
  const typed = claudeOptions("models", "claude-opus-5-5");
  assert.equal(typed[0].id, "claude-opus-5-5");
  assert.equal(typed[0].description, "Full model id");
  assert.equal(claudeOptions("models", "rm -rf /").length, 0);
});

test("effort options are Claude's levels plus auto", () => {
  assert.deepEqual(EFFORTS.map((item) => item.id), ["low", "medium", "high", "xhigh", "max", "auto"]);
  assert.deepEqual(claudeOptions("variants", "xh").map((item) => item.id), ["xhigh"]);
});

test("choices become one typed line or one key press, never a prompt", () => {
  assert.deepEqual(claudeAction("models", { id: "sonnet" }), { hc: "send", text: "/model sonnet" });
  assert.deepEqual(claudeAction("variants", { id: "max" }), { hc: "send", text: "/effort max" });
  assert.deepEqual(claudeAction("agents", { id: "plan" }), { hc: "send", text: "/plan" });
  assert.deepEqual(claudeAction("agents", { id: "cycle" }), { hc: "keys", keys: ["shift+tab"] });
  assert.equal(claudeAction("models", { id: "opus\n/exit" }), null);
  assert.equal(claudeAction("agents", { id: "other" }), null);
  assert.equal(claudeAction("models", null), null);
});

test("permission modes read like Claude's own labels", () => {
  assert.equal(modeLabel("default"), "Manual");
  assert.equal(modeLabel("auto"), "Auto");
  assert.equal(modeLabel("bypassPermissions"), "Bypass permissions");
  assert.equal(modeLabel("something-new"), "something-new");
  assert.equal(modeLabel(null), null);
});
