// Installs the Claude Code side of the unified chat bar: the statusLine command
// (model, effort, context), the hook that records the permission mode, and the
// herdr-composer mod that blanks Claude's hint line while Herdr's composer is the
// input. Edits only ~/.claude/settings.json's statusLine, our own hook entries and
// our own CLAUDE_CODE_PLUGIN_DIRS entry, and keeps a backup.
import { mkdir, readFile, writeFile, rename, copyFile, chmod, access, readdir } from "node:fs/promises";
import { delimiter } from "node:path";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const hooksDir = join(claudeHome, "hooks");
const settingsPath = join(claudeHome, "settings.json");
const scripts = { statusline: "unified-chat-statusline.py", mode: "unified-chat-mode.py" };
// The herdr-composer mod (a Claude Code plugin folder) and where its copy lives.
const modSource = join(source, "adapters", "claude", "herdr-composer");
const modDir = join(hooksDir, "unified-chat-composer");
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

// Copy the mod folder file by file (no symlinks, no deletions of files we did not write).
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(join(from, entry.name), target);
    else if (entry.isFile()) await writeAtomic(target, await readFile(join(from, entry.name), "utf8"));
  }
}
await copyTree(modSource, modDir);

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

// CLAUDE_CODE_PLUGIN_DIRS loads the mod in every session (it idles outside Herdr); keep
// other entries, add ours once.
settings.env ??= {};
const dirs = String(settings.env.CLAUDE_CODE_PLUGIN_DIRS ?? "").split(delimiter).filter(Boolean);
if (!dirs.includes(modDir)) settings.env.CLAUDE_CODE_PLUGIN_DIRS = [...dirs, modDir].join(delimiter);

if (JSON.stringify(settings) !== before) {
  const backup = `${settingsPath}.before-unified-chat-claude`;
  if (await exists(settingsPath) && !(await exists(backup))) await copyFile(settingsPath, backup);
  await writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
console.log(JSON.stringify({ hooksDir, settingsPath, statusLine: settings.statusLine.command, modeHookEvents: EVENTS, composerMod: modDir, pluginDirs: settings.env.CLAUDE_CODE_PLUGIN_DIRS }, null, 2));
console.log("Running Claude sessions report the permission mode from their next prompt or tool call; sessions started before this install may need a restart to load the hook.");
