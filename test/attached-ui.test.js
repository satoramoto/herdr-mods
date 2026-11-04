import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("composer control panels are view-owned anchored content, never detached mod overlays", async () => {
  const source = await readFile(new URL("../mods/unified-chat/main.js", import.meta.url), "utf8");
  const controls = source.slice(source.indexOf('  openControls('), source.indexOf('  async control('));
  assert.ok(controls.includes("this.pendingPanel ="));
  assert.ok(!controls.includes("openOverlay("));
  assert.ok(source.includes('Popup.new("composer-attached-controls", composer)'));
  assert.ok(source.includes('key_context("UnifiedChatAttachedPanel")'));
  assert.ok(source.includes('this.attachedPanel = null; this.pendingPanel = null;'));
});

test("default owned API smoke never opens a visible QA mod/window", async () => {
  const source = await readFile(new URL("../scripts/opencode-api-smoke.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("await checkAttached("));
  assert.ok(!source.includes('"mod.open"'));
  const native = await readFile(new URL("../scripts/native-smoke.mjs", import.meta.url), "utf8");
  assert.ok(native.indexOf('!process.argv.includes("--visible-fixture")') < native.indexOf('"mod.open"'));
});
