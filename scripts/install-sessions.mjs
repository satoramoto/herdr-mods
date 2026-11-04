// Opt-in all-harness session registry and the All sessions view. Never restarts a harness.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const configPath = join(home, "data/sessions-config.json");
const legacyConfigPath = join(home, "data/sheep-config.json");
const mod = "sessions";
const installedMod = join(home, "mods", mod);
const legacyMod = join(home, "mods/sheep");
const unit = "herdr-sessions.service";
const unitPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user", unit);
const marker = "# Managed by herdr-mods/scripts/install-sessions.mjs";
const command = (name, args) => execFileSync(name, args, { encoding: "utf8" }).trim();
const quote = (s) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
const existsText = async (path) => { try { return await readFile(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
async function atomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.installing`;
  await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
const uiFiles = ["drag-model.js", "presentation.js", "main.js", "mod.json"];

// An installation under the earlier name carries over: its config file is renamed, its mod folder removed.
if (!(await existsText(configPath)) && (await existsText(legacyConfigPath))) await rename(legacyConfigPath, configPath);
const oldText = await existsText(configPath);
const old = oldText ? JSON.parse(oldText) : null;
if (old && old.source !== source) throw new Error("Refusing to overwrite another session-registry installation.");
if (!old && await existsText(join(installedMod, "main.js"))) throw new Error(`The ${mod} mod name is already in use.`);
delete old?.spacesClone; delete old?.spacesInstalledHash; delete old?.fold;

async function installMod(config) {
  command("herdr-app", ["check", join(source, "mods", mod)]);
  for (const name of uiFiles) await atomic(join(installedMod, name), await readFile(join(source, "mods", mod, name), "utf8"));
  await atomic(join(installedMod, "config.js"), `export const registryPath = ${JSON.stringify(config.registryPath)};\nexport const workerPath = ${JSON.stringify(config.workerPath)};\nexport const nodePath = ${JSON.stringify(config.binaries.node)};\n`);
  command("herdr-app", ["check", installedMod]);
  if (await existsText(join(legacyMod, "main.js"))) { await rm(legacyMod, { recursive: true }); console.log("Removed the mod installed under the earlier name."); }
}

if (process.argv.includes("--ui-only")) {
  if (!old) throw new Error("Install the session registry before updating its UI.");
  await installMod(old);
  await atomic(configPath, JSON.stringify(old, null, 2) + "\n");
  console.log("Updated the All sessions view; service unchanged.");
  process.exit(0);
}
const oldUnit = await existsText(unitPath);
if (oldUnit && !oldUnit.startsWith(marker)) throw new Error("Refusing to overwrite an unowned service.");
const binaries = {};
for (const name of ["node", "herdr-app", "herdr-core", "python3", "opencode", "claude", "codex", "pi", "gemini"]) {
  try {
    // The user's .local/bin agent wrappers run `mise use -g` (writes config).
    // Resolve already-installed binaries without invoking those wrappers.
    const fromMise = ["opencode", "claude", "codex", "pi", "gemini"].includes(name);
    try { binaries[name] = fromMise ? command("mise", ["which", name]) : command("which", [name]); }
    catch { binaries[name] = command("which", [name]); }
  } catch { /* Uninstalled harnesses stay visible but cannot be launched. */ }
}
const config = { ...old, source, recoverySpace: old?.recoverySpace, panelTab: old?.panelTab,
  registryPath: old?.registryPath ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "herdr-sessions/sessions.json"),
  binaries, workerPath: join(source, "scripts/herdr-sessions.mjs") };
await atomic(configPath, JSON.stringify(config, null, 2) + "\n");
await installMod(config);
await atomic(unitPath, `${marker}
[Unit]
Description=All-harness session registry for Herdr

[Service]
Type=simple
Environment=${quote(`SESSIONS_CONFIG=${configPath}`)}
Environment=${quote(`PATH=${process.env.PATH}`)}
ExecStart=${quote(binaries.node)} ${quote(config.workerPath)} --watch
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`);
command("systemd-analyze", ["--user", "verify", unitPath]);
command("systemctl", ["--user", "daemon-reload"]);
// Retire only the narrow service created by this repository earlier.
const legacyPath = join(dirname(unitPath), "opencode-herdr-restore.service");
if ((await existsText(legacyPath))?.startsWith("# Managed by herdr-mods/scripts/install-restore.mjs")) {
  command("systemctl", ["--user", "disable", "--now", "opencode-herdr-restore.service"]);
}
command("systemctl", ["--user", "enable", unit]);
command("systemctl", ["--user", "restart", unit]);
console.log(JSON.stringify({ configPath, recoverySpace: config.recoverySpace, registryPath: config.registryPath, service: unit }, null, 2));
