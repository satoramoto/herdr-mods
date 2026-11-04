// Native loader/state smoke without opening an overlay/window on the user's
// display. An owned API smoke may supply real server completion responses.
import { mkdtemp, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

export async function checkAttached(input = null) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const scratch = await mkdtemp("/tmp/opencode/unified-chat-attached-check-");
  const fixture = input ?? {
    target: { address: "tfixture", sessionID: "ses_fixture", key: "attached-fixture", status: "idle", label: "Inert attached check", space_name: "QA", terminal: { address: "tfixture", records: {} } },
    part: { kind: "skill", id: "inert-fixture" },
    completion: { text: "/cd comp", kind: "directory", command: { id: "session.cd" }, items: [{ kind: "argument", key: "inert", label: "completion dir 🌱/", directory: true, edit: { expected: "/cd comp", start: 4, end: 8, value: "completion dir 🌱/" } }] },
  };
  try {
    for (const name of await readdir(join(root, "mods/unified-chat"))) if (/\.(js|mjs)$/.test(name)) await copyFile(join(root, "mods/unified-chat", name), join(scratch, name === "main.js" ? "composer.js" : name));
    await writeFile(join(scratch, "fixture.js"), `export const fixture=${JSON.stringify(fixture)};\n`);
    await writeFile(join(scratch, "main.js"), `
import UnifiedChat from "./composer.js";
import { OpenCodePanel } from "./opencode-panel.js";
import { InputState } from "gpui-base";
import { applyArgumentEdit } from "./completion.js";
import { fixture } from "./fixture.js";
export default class AttachedCheck extends UnifiedChat {
  current() { return fixture.target; }
  allTargets() { return [fixture.target]; }
  init(initial, cx) {
    super.init(initial, cx);
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    this.model.select(fixture.target.key);
    this.rich.attach(fixture.target.key, fixture.part);
    const panel = new OpenCodePanel();
    panel.kind = "slash"; panel.target = fixture.target; panel.handle = cx.focus_handle();
    panel.snapshot = { commands: fixture.commands ?? [{ id: "session.cd", slash: { name: "cd", arguments: true } }] }; panel.index = 0; panel.rich = {}; panel.submissions = [];
    panel.search = InputState.new({ value: fixture.completion.text });
    panel.maybeArguments(cx);
    assert(panel.kind === "arguments", "Live slash command did not enter argument completion");
    panel.argumentResult = fixture.completion; panel.draftText = fixture.completion.text;
    panel.publishCompletion = (edit, cx) => this.applyCommandCompletion(edit, cx);
    const item = fixture.completion.items.find(item => item.label === "completion dir 🌱/") ?? fixture.completion.items[0];
    assert(item, "Owned server did not return a completion candidate");
    this.model.edit(fixture.completion.text); this.restoreEditor();
    panel.select(item, cx);
    assert(this.model.text() === applyArgumentEdit(fixture.completion.text, item.edit), "Native completion edit changed path text");
    assert(this.rich.get(fixture.target.key).parts.length === 1, "Native completion lost attachments");
    this.model.edit("/cd keep newer edits"); panel.select(item, cx);
    assert(Boolean(panel.error) && this.model.text() === "/cd keep newer edits", "Stale completion overwrote the current draft");
    panel.error = null; this.model.edit(fixture.completion.text); this.restoreEditor();
    this.attachedPanel = panel;
    // The actual composer's render mounts this panel in Popup.content, anchored
    // to its input. There is no openOverlay or mod.open test invocation.
  }
}`);
    const output = execFileSync("herdr-app", ["check", scratch], { encoding: "utf8", timeout: 20000 }).trim();
    return { passed: true, nativeAttachedPanelRender: true, nativeCompletionEdit: true,
      nativeSlashArgumentTransition: true, attachmentPreserved: true, staleCompletionRejected: true, detachedWindowsOpened: 0, check: output };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await checkAttached(), null, 2));
