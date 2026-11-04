import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp("/tmp/opencode/unified-chat-attention-check-");
try {
  for (const name of ["attention-panel.js", "forms.js", "ui-control.js"]) await copyFile(join(root, "mods/unified-chat", name), join(scratch, name));
  for (const kind of ["list", "permission", "form"]) {
    await writeFile(join(scratch, "main.js"), `
import { View } from "gpui-kit";
import { TextareaState } from "gpui-base";
import { theme } from "herdr";
import { AttentionPanel } from "./attention-panel.js";
import { formAnswer } from "./forms.js";
export default class AttentionCheck extends View {
  init(_initial, cx) {
    this.panel = new AttentionPanel();
    this.panel.inputs = new Map(); this.panel.raw = {}; this.panel.externalReady = {};
    this.panel.feedback = TextareaState.new({ rows: 2 });
    const permission = { id: "per_fixture", sessionID: "ses_fixture", action: "shell", resources: ["git diff"], save: ["git diff *"], metadata: { command: "git diff", explanation: "Full inert fixture detail" } };
    const form = { id: "frm_fixture", sessionID: "ses_fixture", title: "All supported question fields", fields: [
      { key: "yes", type: "boolean", default: false, required: true },
      { key: "count", type: "integer", default: 0, minimum: 0 },
      { key: "fraction", type: "number", default: 0.5 },
      { key: "text", type: "string", default: "alpha", pattern: "^a", minLength: 1 },
      { key: "choice", type: "string", options: [{ value: "x", label: "X" }], custom: true, default: "custom" },
      { key: "many", type: "multiselect", options: [{ value: "a", label: "A" }], custom: true, default: ["a"] },
      { key: "date", type: "string", format: "date", default: "2026-11-03" },
      { key: "uri", type: "string", format: "uri", default: "https://example.test/" },
      { key: "external", type: "external", url: "https://example.test/inert-fixture", title: "External action" },
    ] };
    this.panel.state = { permissions: [permission], forms: [form] };
    if (${JSON.stringify(kind)} === "permission") this.panel.permission = permission;
    if (${JSON.stringify(kind)} === "form") {
      this.panel.chooseForm(form, cx); this.panel.raw.external = true;
      formAnswer(form, this.panel.values());
    }
  }
  render() { return this.panel.render(theme()); }
}`);
    console.log(`${kind}: ${execFileSync("herdr-app", ["check", scratch], { encoding: "utf8" }).trim()}`);
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
