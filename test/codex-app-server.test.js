import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, decodeFrames } from "../adapters/codex/app-server.mjs";

test("client frames are masked text frames that decode back to the same text", () => {
  for (const text of ["{}", "x".repeat(125), "y".repeat(126), "z".repeat(70000)]) {
    const frame = encodeFrame(text);
    assert.equal(frame[0], 0x81);
    assert.ok(frame[1] & 0x80, "client frames carry the mask bit");
    const { frames, rest } = decodeFrames(frame);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].opcode, 1);
    assert.equal(frames[0].payload.toString(), text);
    assert.equal(rest.length, 0);
  }
});

test("partial server frames stay buffered until complete", () => {
  const payload = Buffer.from('{"id":1}');
  const server = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const cut = decodeFrames(server.subarray(0, 4));
  assert.equal(cut.frames.length, 0);
  assert.equal(cut.rest.length, 4);
  const whole = decodeFrames(Buffer.concat([cut.rest, server.subarray(4), Buffer.from([0x88, 0x00])]));
  assert.deepEqual(whole.frames.map((frame) => frame.opcode), [1, 8]);
  assert.equal(whole.frames[0].payload.toString(), '{"id":1}');
});
