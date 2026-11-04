import { test } from "node:test";
import assert from "node:assert/strict";
import { activeFields, fieldError, formAnswer } from "../mods/unified-chat/forms.js";
import { createOperations } from "../adapters/opencode/operations.js";

test("forms retain false and zero; enforce every supported answer type and constraint", () => {
  const fields = [
    { key: "yes", type: "boolean", required: true },
    { key: "count", type: "integer", minimum: 0, maximum: 10 },
    { key: "number", type: "number" },
    { key: "mail", type: "string", format: "email" },
    { key: "uri", type: "string", format: "uri" },
    { key: "date", type: "string", format: "date" },
    { key: "at", type: "string", format: "date-time" },
    { key: "pattern", type: "string", pattern: "^a+$", minLength: 2, maxLength: 4 },
    { key: "many", type: "multiselect", required: true, minItems: 1, maxItems: 2, custom: true, options: [{ value: "a" }] },
    { key: "external", type: "external" },
  ];
  const answer = { yes: false, count: 0, number: 0.5, mail: "a@b.test", uri: "https://example.test/", date: "2026-11-03", at: "2026-11-03T12:00:00Z", pattern: "aaa", many: ["a", "custom"], external: true };
  assert.deepEqual(formAnswer({ fields }, answer), answer);
  assert.match(fieldError(fields[1], 1.5), /integer/);
  assert.match(fieldError(fields[2], Infinity), /finite/);
  assert.match(fieldError(fields[5], "2026-02-31"), /YYYY/);
  assert.match(fieldError(fields[7], "bbb"), /match/);
  assert.match(fieldError(fields[8], []), /required/);
  assert.match(fieldError(fields[9], false), /Acknowledge/);
});

test("ordered conditional fields exclude inactive answers, including array membership and neq", () => {
  const form = { fields: [
    { key: "kind", type: "string" },
    { key: "choice", type: "multiselect", options: [{ value: "x" }] },
    { key: "active", type: "string", required: true, when: [{ key: "choice", op: "eq", value: "x" }] },
    { key: "inactive", type: "string", required: true, when: [{ key: "kind", op: "neq", value: "a" }] },
  ] };
  const answers = { kind: "a", choice: ["x"], active: "answer", inactive: "stale answer" };
  assert.deepEqual(activeFields(form, answers).map((field) => field.key), ["kind", "choice", "active"]);
  assert.ok(!("inactive" in formAnswer(form, answers)));
  assert.throws(() => formAnswer(form, { kind: "a", choice: ["x"] }), /required/);
});

test("permission replies preserve explicit once/always/reject and feedback, and reject stale scopes/foreign sessions", async () => {
  const calls = [];
  const pending = { id: "per_fixture", sessionID: "ses_child", action: "shell", resources: ["git diff"], save: ["git diff *"] };
  const session = { id: "ses_parent", location: { directory: "/work" } };
  const context = { data: { session: { family: () => ["ses_parent", "ses_child"] } }, client: { permission: {
    get: async () => pending, reply: async (value) => calls.push(value),
  } } };
  const request = createOperations(context, () => session, () => {});
  const input = { action: "permission-reply", ownerSessionID: "ses_child", id: pending.id,
    expected: { action: pending.action, resources: pending.resources, save: pending.save } };
  for (const decision of ["once", "always", "reject"]) await request({ ...input, decision, message: decision === "reject" ? "Use a read-only alternative" : undefined });
  assert.deepEqual(calls.map((value) => value.decision), ["once", "always", "reject"]);
  assert.equal(calls[2].message, "Use a read-only alternative");
  await assert.rejects(request({ ...input, decision: "once", expected: { ...input.expected, resources: ["different command"] } }), /scope changed/);
  await assert.rejects(request({ ...input, decision: "once", ownerSessionID: "ses_foreign" }), /session family/);
  assert.equal(calls.length, 3);
});

test("form replies validate current pending schema, exclude inactive fields and never reply on discovery", async () => {
  const calls = [], session = { id: "ses_one", location: { directory: "/work" } };
  const form = { id: "frm_fixture", sessionID: session.id, fields: [{ key: "confirm", type: "boolean", required: true }] };
  const context = { client: { session: { form: {
    list: async () => [form], reply: async (value) => calls.push(value), cancel: async (value) => calls.push(value),
  } } } };
  const request = createOperations(context, () => session, () => {});
  await assert.rejects(request({ action: "form-reply", id: form.id, answer: {} }), /required/);
  assert.equal(calls.length, 0);
  await request({ action: "form-reply", id: form.id, answer: { confirm: false, notAField: "ignored" } });
  assert.deepEqual(calls[0].answer, { confirm: false });
  await assert.rejects(request({ action: "form-cancel", id: "frm_stale" }), /no longer pending/);
  await request({ action: "form-cancel", id: form.id });
  assert.equal(calls.length, 2);
});
