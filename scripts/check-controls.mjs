// Exercise loaded catalogue/variant rows in the real native renderer without
// opening a window, focusing a terminal, or executing any command.
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp("/tmp/opencode/unified-chat-panel-check-");
try {
  for (const name of ["opencode-panel.js", "completion.js", "ui-control.js", "prompt.js", "metadata.js"]) {
    await copyFile(join(root, "mods/unified-chat", name), join(scratch, name));
  }
  for (const kind of ["commands", "slash", "arguments", "variants", "mentions", "queue", "recovery", "history", "models", "agents", "attachments", "activity", "tools"]) {
    await writeFile(join(scratch, "main.js"), `
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { theme } from "herdr";
import { OpenCodePanel } from "./opencode-panel.js";
export default class PanelCheck extends View {
  init(_initial, cx) {
    this.panel = new OpenCodePanel();
    this.panel.kind = ${JSON.stringify(kind === "recovery" ? "queue" : kind)};
    this.panel.handle = cx.focus_handle();
    this.panel.search = InputState.new({ value: "" });
    this.panel.index = 0;
    this.panel.target = { bridge: {} };
    this.panel.snapshot = { variants: ["low", "high"], commands: [
      { id: "agent.list", kind: "ui", title: "Switch agent", slash: { name: "agents", aliases: ["agent"] } },
      { id: "session.cd", kind: "ui", title: "Change directory", slash: { name: "cd", arguments: true } },
      { id: "team/review", kind: "server", title: "Review", slash: { name: "team/review", arguments: true } },
    ] };
    this.panel.mentions = [{ id: "review", kind: "skill", description: "Review changes" }];
    this.panel.submissions = [];
    this.panel.legacy = [];
    this.panel.rich = { history: [{ text: "Historical prompt", parts: [], mode: "normal" }], stashes: [{ text: "Stashed prompt", parts: [], mode: "normal" }] };
    this.panel.catalogue = [{ id: "fixture", name: "Fixture model / agent", providerID: "p", enabled: true }];
    if (${JSON.stringify(kind)} === "arguments") this.panel.argumentResult = { command: { id: "session.cd" }, kind: "directory", items: [{ kind: "argument", key: "/inert/dir with spaces", label: "dir with spaces/", edit: { expected: "/cd dir", start: 4, end: 7, value: "dir with spaces/" } }] };
    if (${JSON.stringify(kind)} === "activity") this.panel.activity = { cost: 0, tokens: { input: 123 }, status: { type: "idle" }, family: [{ id: "ses_fixture", title: "Inert family fixture", agent: "build", status: { type: "idle" } }], shells: [{ id: "sh_fixture", command: "inert fixture command", status: "running", cwd: "/inert" }] };
    if (${JSON.stringify(kind)} === "attachments") {
      this.panel.rich.parts = [{ kind: "file", name: "fixture.txt", uri: "file:///inert-fixture" }];
      this.panel.preview = { description: "text/plain · inert fixture", text: "Complete inert preview fixture" };
    }
    if (${JSON.stringify(kind)} === "recovery") {
      this.panel.submissions = [{ id: "msg_uncertain", draft: { text: "Uncertain saved draft", parts: [] }, state: "uncertain" }];
      this.panel.selectedSaved = { ...this.panel.submissions[0], source: "submission", key: "msg_uncertain", kind: "receipt" };
      this.panel.target = { bridge: {} };
    }
    this.panel.state = { inbox: [{ id: "msg_fixture", type: "user", payload: { text: "Queued prompt" }, delivery: "queue" }] };
    if (${JSON.stringify(kind)} === "queue") this.panel.selectedQueue = this.panel.state.inbox[0];
  }
  render() { return this.panel.render(theme()); }
}`);
    console.log(`${kind}: ${execFileSync("herdr-app", ["check", scratch], { encoding: "utf8" }).trim()}`);
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
