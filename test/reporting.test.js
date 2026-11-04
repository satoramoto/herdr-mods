import { test } from "node:test";
import assert from "node:assert/strict";
import { reportingHealth } from "../adapters/reporting.js";
test("reporting audit requires a real supported status", () => {
  for (const status of [undefined, "running", { title: "idle" }]) assert.equal(reportingHealth({ status }).reporting, false);
  for (const state of ["idle", "working", "blocked", "done", "error"]) assert.equal(reportingHealth({ report: { state } }).status, state);
});
