// Installs only the opt-in session-restoration sidecar, not UI or agent config.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
const unitPath = join(config, "systemd/user/opencode-herdr-restore.service");
const owner = "# Managed by herdr-mods/scripts/install-restore.mjs";
const which = (name) => execFileSync("which", [name], { encoding: "utf8" }).trim();
const quote = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
const node = which("node");
const opencode = which("opencode");
const core = which("herdr-core");
const app = which("herdr-app");
const flock = which("flock");
try {
  const existing = await readFile(unitPath, "utf8");
  if (!existing.startsWith(owner)) throw new Error("Refusing to replace an unowned restore service.");
} catch (error) { if (error.code !== "ENOENT") throw error; }
await access(join(source, "scripts/opencode-herdr-restore.mjs"));
await mkdir(dirname(unitPath), { recursive: true });
await writeFile(unitPath, `${owner}
[Unit]
Description=Restore OpenCode clients to their Herdr tabs after server restart

[Service]
Type=simple
Environment=${quote(`OPENCODE_HERDR_OPENCODE=${opencode}`)}
Environment=${quote(`OPENCODE_HERDR_CORE=${core}`)}
Environment=${quote(`OPENCODE_HERDR_APP=${app}`)}
Environment=${quote(`PATH=${process.env.PATH}`)}
ExecStart=${quote(flock)} --nonblock %t/opencode-herdr-restore.lock ${quote(node)} ${quote(join(source, "scripts/opencode-herdr-restore.mjs"))} --watch
Restart=on-failure
RestartSec=10
TimeoutStopSec=25
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`);
execFileSync("systemd-analyze", ["--user", "verify", unitPath], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "--now", "opencode-herdr-restore.service"], { stdio: "inherit" });
console.log(`Installed ${unitPath}\nOnly the sidecar was started; OpenCode, Herdr and their jobs were not restarted.`);
