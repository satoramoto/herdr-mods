import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPOSER_HEIGHT, EXPANDED_HEIGHT, LINE_HEIGHT, MAX_ROWS, QUEUE_HEIGHT, fitComposerLayout } from "../mods/unified-chat/layout.js";

const layoutWith = (bar) => ({
  id: "root", type: "row", children: [{ id: "work", type: "column", children: [
    { id: "main", content: { tab: "active" } },
    ...(bar ? [bar] : []),
    { id: "status", content: { mod: "workspace-status" } },
  ] }],
});
const composer = (overrides = {}) => ({
  id: "unified-chat-bar", type: "block", content: { mod: "unified-chat" }, ...overrides,
});

test("composer height fits a one-line editor over the single footer line, with room to grow", () => {
  // outer 4+8, card border 2, editor padding 8+8, footer 34, one 18px line
  const minimum = 4 + 8 + 2 + 8 + 8 + 34 + 18;
  assert.ok(COMPOSER_HEIGHT >= minimum);
  // The expanded budget holds the queue plus a fully grown editor.
  assert.ok(EXPANDED_HEIGHT >= COMPOSER_HEIGHT + LINE_HEIGHT * (MAX_ROWS - 1) + QUEUE_HEIGHT + 4);
});

test("new composer is inserted before status with safe minimum and expansion room", () => {
  const layout = layoutWith();
  const bar = fitComposerLayout(layout);
  assert.deepEqual(layout.children[0].children.map((node) => node.id), ["main", "unified-chat-bar", "status"]);
  assert.equal(bar.size.px, COMPOSER_HEIGHT);
  assert.equal(bar.min, COMPOSER_HEIGHT);
  assert.equal(bar.max, EXPANDED_HEIGHT + 33 + 26);
});

test("rerunning install upgrades the overflowing 104px layout without replacing personal edits", () => {
  const bar = composer({ size: { px: 104 }, min: 96, max: 340, background: "canvas" });
  const layout = layoutWith(bar);
  layout.children[0].children[0].content.pane = { radius: 10 };
  const before = structuredClone(layout);
  fitComposerLayout(layout);
  before.children[0].children[1].size.px = COMPOSER_HEIGHT;
  before.children[0].children[1].min = COMPOSER_HEIGHT;
  // The old default ceiling grows just enough for a fully grown editor over the queue.
  before.children[0].children[1].max = EXPANDED_HEIGHT + 33 + 26;
  assert.deepEqual(layout, before);
  const upgraded = structuredClone(layout);
  fitComposerLayout(layout);
  assert.deepEqual(layout, upgraded);
});

test("larger personal composer sizes and weighted allocations are preserved", () => {
  const bar = composer({ size: { px: 300 }, min: 180, max: 400 });
  fitComposerLayout(layoutWith(bar));
  assert.deepEqual(bar.size, { px: 300 });
  assert.equal(bar.min, 180);
  assert.equal(bar.max, 400);
  const weighted = composer({ size: { weight: 2 } });
  fitComposerLayout(layoutWith(weighted));
  assert.deepEqual(weighted.size, { weight: 2 });
});

test("unexpected layout structure and reused block IDs are refused", () => {
  assert.throws(() => fitComposerLayout({ id: "root" }), /structure/);
  assert.throws(() => fitComposerLayout(layoutWith(composer({ content: { mod: "other" } }))), /different content/);
});
