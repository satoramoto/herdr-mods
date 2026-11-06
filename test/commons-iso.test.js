import { test } from "node:test";
import assert from "node:assert/strict";
import { project, box, tent, slab, bounds, fit, origin, shade, mix, faces, blob } from "../mods/commons/iso.js";

test("tiles project 2:1 and height lifts straight up", () => {
  assert.deepEqual(project(0, 0, 0, 10, 100, 50), [100, 50]);
  assert.deepEqual(project(1, 0, 0, 10, 100, 50), [110, 55]);
  assert.deepEqual(project(0, 1, 0, 10, 100, 50), [90, 55]);
  assert.deepEqual(project(0, 0, 2, 10, 100, 50), [100, 40]);
});

test("a box has a roof and two walls that meet at its front corner", () => {
  const b = box(0, 0, 1, 1, 1, 10, 100, 50);
  assert.deepEqual(b.top, [[100, 45], [110, 50], [100, 55], [90, 50]]);
  assert.deepEqual(b.left[1], b.right[0], "the walls share the front top corner");
  assert.deepEqual(b.left[2], [100, 60], "and the front bottom corner sits one unit below");
  const t = tent(0, 0, 2, 2, 2, 10, 100, 50);
  assert.deepEqual(t.left[0], t.right[0], "both faces meet at the apex");
  assert.equal(slab(0, 0, 2, 2, 10, 100, 50).length, 4);
  assert.deepEqual(bounds([b.top, b.left, b.right]), { x: 90, y: 45, w: 20, h: 15 });
});

test("the unit fits the grid into the block and the origin centers it", () => {
  const u = fit(18, 14, 4.5, 250, 320, 6);
  assert.ok(u > 2 && u * 32 <= 238, `width bound holds: ${u}`);
  const [ox, oy] = origin(18, 14, 4.5, u, 250, 320);
  assert.ok(ox > 0 && oy > 0);
  assert.equal(fit(18, 14, 4.5, 10, 10), 2, "never below the floor");
});

test("shades move toward white or black, a mix lands between", () => {
  assert.equal(shade("#808080", 0.5), "#c0c0c0");
  assert.equal(shade("#808080", -0.5), "#404040");
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(shade("#fff", 0), "#ffffff");
  const f = faces("#808080");
  assert.ok(f.top > f.left && f.left > f.right);
  assert.equal(blob(0, 0, 10, 5).length, 14);
});
