// Explicit migration: park every pane of the legacy recovery project (the earlier
// installer created one named "Sheep") before closing it.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const home = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const config = JSON.parse(await readFile(join(home, "data/sessions-config.json"), "utf8"));
const call = (program, args) => JSON.parse(execFileSync(config.binaries?.[program] ?? program, args, { encoding: "utf8", timeout: 10000 }));
const app = (...args) => call("herdr-app", args);
const space = app("ls").spaces.find((s) => s.id === config.recoverySpace);
if (!space) { console.log("No legacy recovery project remains."); process.exit(0); }
const LEGACY_NAME = "Sheep";
if (space.machine || space.name !== LEGACY_NAME) throw new Error("Recovery space was renamed or is remote; inspect it manually.");
const addresses = [...new Set(space.tabs.flatMap((t) => t.terminals ?? []).map((p) => p.terminal))];
for (const address of addresses) {
  const before = call("herdr-core", ["get", address]);
  if (before.state !== "live") throw new Error(`Inspect finished terminal ${address} before retiring its project.`);
  // Clear opt-in labels so a parked pane cannot be automatically re-adopted.
  call("herdr-core", ["label", address, "herdr.space=", "herdr.tab="]);
  app("do", "terminal.park", JSON.stringify({ terminal: address }));
  const after = call("herdr-core", ["get", address]);
  if (after.state !== "live" || after.created_ms !== before.created_ms || after.pid !== before.pid) {
    throw new Error(`Terminal identity changed for ${address}; project was not closed.`);
  }
}
const remaining = app("ls").spaces.find((s) => s.id === space.id);
if (remaining?.tabs.some((t) => t.terminals?.length)) throw new Error("Project still has panes; nothing was closed. Inspect and retry.");
if (remaining) app("do", "space.close", JSON.stringify({ id: space.id, confirmed: true }));
console.log("Removed the recovery project; parked terminals remain alive and can be re-adopted from All sessions.");
