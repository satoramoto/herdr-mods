// Install the fold sidebar (spaces → agents as one tree) into the Herdr app home.
// Inspectable: copies owned files and edits only the personal layout's sidebar.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const mod = "fold";
const installed = join(home, "mods", mod);
const uiOnly = process.argv.includes("--ui-only");
const command = (name, args) => execFileSync(name, args, { encoding: "utf8" }).trim();
const existsText = async (path) => { try { return await readFile(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
async function atomic(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.installing`;
  await writeFile(temporary, text, { flag: "wx" });
  await rename(temporary, path);
}
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

// The session worker's paths, when the All sessions view is installed: dropping a
// session on a space hands it to that worker. Without it, drops are ignored.
const sessions = JSON.parse((await existsText(join(home, "data/sessions-config.json"))) ?? "null");
const marker = join(home, `.${mod}-install.json`);
const owned = JSON.parse((await existsText(marker)) ?? "null");
if (await existsText(join(installed, "main.js")) && owned?.source !== source) throw new Error(`mods/${mod} is already in use by another installation; not overwriting it.`);

command("herdr-app", ["check", join(source, "mods", mod)]);
for (const name of ["main.js", "tree.js", "git.js", "mod.json"]) await atomic(join(installed, name), await readFile(join(source, "mods", mod, name), "utf8"));
await atomic(join(installed, "config.js"), sessions
  ? `export const workerPath = ${JSON.stringify(sessions.workerPath)};\nexport const nodePath = ${JSON.stringify(sessions.binaries?.node ?? process.execPath)};\n`
  : await readFile(join(source, "mods", mod, "config.js"), "utf8"));
command("herdr-app", ["check", installed]);
await atomic(marker, JSON.stringify({ source, installedAt: Date.now() }, null, 2) + "\n");
if (uiOnly) { console.log("Updated the fold mod; layout untouched."); process.exit(0); }

// The personal layout: the sidebar's two list blocks become one.
const status = JSON.parse(command("herdr-app", ["status"]));
const layoutPath = join(home, "layouts", `${status.layout}.json`);
const text = await readFile(layoutPath, "utf8");
const layout = JSON.parse(text);
if (!layout.cloned_from) throw new Error("Switch to a personal (cloned) layout first; shipped layouts are not modified.");
if (find(layout, mod)) { console.log("Layout already shows the fold."); process.exit(0); }
const lists = find(layout, "sidebar-lists");
const known = (b, mods) => !b || mods.includes(b.content?.mod);
if (!lists || !known(find(layout, "spaces"), ["spaces", "sheep-spaces"]) || !known(find(layout, "agents"), ["agents", "sheep", "sessions"])) {
  throw new Error("Sidebar was customized; refusing to replace unrelated panels.");
}
lists.children = [{ id: mod, type: "block", content: { mod }, size: { weight: 1 }, min: 90 }];
const backup = `${layoutPath}.before-${mod}`;
if (!await existsText(backup)) await writeFile(backup, text, { flag: "wx" });
if (await readFile(layoutPath, "utf8") !== text) throw new Error("Layout changed concurrently; nothing written.");
await atomic(layoutPath, JSON.stringify(layout, null, 2) + "\n");
console.log(JSON.stringify({ installed, layout: layoutPath }, null, 2));
