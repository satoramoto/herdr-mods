// Installs the Claude Code reporters for the unified chat bar: the statusLine command
// (model, effort, context) and the hook that records the permission mode. Edits only
// ~/.claude/settings.json's statusLine and our own hook entries, and keeps a backup.
import { mkdir, readFile, writeFile, rename, copyFile, chmod, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const hooksDir = join(claudeHome, "hooks");
const settingsPath = join(claudeHome, "settings.json");
const scripts = { statusline: "unified-chat-statusline.py", mode: "unified-chat-mode.py" };
// Events whose payload carries permission_mode and that fire often enough to track it.
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"];

const exists = (path) => access(path).then(() => true, () => false);
async function writeAtomic(path, text) {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

await mkdir(hooksDir, { recursive: true });
for (const name of Object.values(scripts)) {
  const target = join(hooksDir, name);
  await writeAtomic(target, await readFile(join(source, "adapters", "claude", name), "utf8"));
  await chmod(target, 0o755);
}

const settings = (await exists(settingsPath)) ? JSON.parse(await readFile(settingsPath, "utf8")) : {};
const before = JSON.stringify(settings);
const statusCommand = `python3 ${join(hooksDir, scripts.statusline)}`;
const modeCommand = `python3 ${join(hooksDir, scripts.mode)}`;

// The statusLine: set it when absent or when it is already ours; never replace someone else's.
if (!settings.statusLine || String(settings.statusLine.command ?? "").includes(scripts.statusline)) {
  settings.statusLine = { type: "command", command: statusCommand, refreshInterval: settings.statusLine?.refreshInterval ?? 15 };
} else {
  console.error(`Kept the existing statusLine (${settings.statusLine.command}); the chat bar will not see Claude's model until it reports through ${scripts.statusline}.`);
}

settings.hooks ??= {};
for (const event of EVENTS) {
  const groups = settings.hooks[event] ??= [];
  const ours = groups.find((group) => (group.hooks ?? []).some((hook) => String(hook.command ?? "").includes(scripts.mode)));
  const hook = { type: "command", command: modeCommand, timeout: 5 };
  if (ours) ours.hooks = ours.hooks.map((item) => (String(item.command ?? "").includes(scripts.mode) ? hook : item));
  else groups.push({ hooks: [hook] });
}

if (JSON.stringify(settings) !== before) {
  const backup = `${settingsPath}.before-unified-chat-claude`;
  if (await exists(settingsPath) && !(await exists(backup))) await copyFile(settingsPath, backup);
  await writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
console.log(JSON.stringify({ hooksDir, settingsPath, statusLine: settings.statusLine.command, modeHookEvents: EVENTS }, null, 2));
console.log("Running Claude sessions report the permission mode from their next prompt or tool call; sessions started before this install may need a restart to load the hook.");
