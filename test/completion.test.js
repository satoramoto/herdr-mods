import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionTrigger, removeMentionMarker } from "../mods/unified-chat/completion.js";

test("mention anchors preserve text around a cursor in the middle of Unicode/multiline input", () => {
  const before = "日本語 🌱\nlook here then continue", after = "日本語 🌱\nlook @here then continue";
  const anchor = mentionTrigger(before, after);
  assert.ok(anchor); assert.equal(removeMentionMarker(after, anchor), before);
  assert.equal(removeMentionMarker(after + "new edit", anchor), after + "new edit");
});
test("toolbar attachments do not erase trailing text, email addresses or another mention", () => {
  assert.equal(mentionTrigger("foo", "foo@"), null);
  assert.equal(mentionTrigger("", "email@host.test"), null);
  assert.equal(removeMentionMarker("draft @existing", null), "draft @existing");
  assert.equal(mentionTrigger("", "@").start, 0);
});
