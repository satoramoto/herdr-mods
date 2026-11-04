// Installs the Codex reporter for the unified chat bar: a hook that starts one
// sidecar per TUI session, which publishes the unified-chat record and serves the
// composer's control socket through the shared app-server daemon. Edits only our
// own entries in ~/.codex/hooks.json and keeps a backup. Codex asks you to trust
// new hooks once (/hooks inside Codex) before they run.
import { mkdir, readFile, writeFile, rename, copyFile, chmod, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const targetDir = join(codexHome, "hooks", "unified-chat");
const hooksPath = join(codexHome, "hooks.json");
const FILES = ["app-server.mjs", "operations.js", "unified-chat-reporter.mjs", "unified-chat-hook.mjs"];
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];

const exists = (path) => access(path).then(() => true, () => false);
async function writeAtomic(path, text) { await writeFile(`${path}.tmp`, text); await rename(`${path}.tmp`, path); }

await mkdir(targetDir, { recursive: true });
for (const name of FILES) {
  const target = join(targetDir, name);
  await writeAtomic(target, await readFile(join(source, "adapters", "codex", name), "utf8"));
  await chmod(target, 0o644);
}

const command = `node ${join(targetDir, "unified-chat-hook.mjs")}`;
const hooks = (await exists(hooksPath)) ? JSON.parse(await readFile(hooksPath, "utf8")) : {};
const before = JSON.stringify(hooks);
hooks.hooks ??= {};
let added = [];
for (const event of EVENTS) {
  const groups = hooks.hooks[event] ??= [];
  const hook = { type: "command", command, timeout: 10 };
  const ours = groups.find((group) => (group.hooks ?? []).some((item) => String(item.command ?? "").includes("unified-chat-hook")));
  if (ours) ours.hooks = ours.hooks.map((item) => (String(item.command ?? "").includes("unified-chat-hook") ? hook : item));
  else { groups.push({ hooks: [hook] }); added.push(event); }
}
if (JSON.stringify(hooks) !== before) {
  const backup = `${hooksPath}.before-unified-chat-codex`;
  if (await exists(hooksPath) && !(await exists(backup))) await copyFile(hooksPath, backup);
  await writeAtomic(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
}
console.log(JSON.stringify({ targetDir, hooksPath, command, events: EVENTS, addedEvents: added }, null, 2));
if (added.length) console.log("Codex runs new hooks only after you trust them: open Codex and run /hooks once. Sessions already open need a new prompt (or restart) before they report.");
