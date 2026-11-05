// Install the pane header with the composer toggle into the Herdr app home and make
// the personal layout's panes use it. Inspectable: copies owned files, edits only the
// pane header of the shown (cloned) layout, keeps a backup. --ui-only: the mod alone.
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const mod = "pane-composer";
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

const marker = join(home, `.${mod}-install.json`);
const owned = JSON.parse((await existsText(marker)) ?? "null");
if (await existsText(join(installed, "main.js")) && owned?.source !== source) throw new Error(`mods/${mod} is already in use by another installation; not overwriting it.`);

command("herdr-app", ["check", join(source, "mods", mod)]);
for (const name of ["main.js", "composer-mode.js", "mod.json", "close.svg", "split-down.svg", "split-right.svg", "unzoom.svg", "zoom.svg"]) {
  await atomic(join(installed, name), await readFile(join(source, "mods", mod, name), "utf8"));
}
command("herdr-app", ["check", installed]);
await atomic(marker, JSON.stringify({ source, installedAt: Date.now() }, null, 2) + "\n");
if (uiOnly) { console.log("Updated the pane-composer mod; layout untouched."); process.exit(0); }

// The personal layout: the tab block's pane header becomes ours.
const status = JSON.parse(command("herdr-app", ["status"]));
const layoutPath = join(home, "layouts", `${status.layout}.json`);
const text = await readFile(layoutPath, "utf8");
const layout = JSON.parse(text);
if (!layout.cloned_from) throw new Error("Switch to a personal (cloned) layout first; shipped layouts are not modified.");
const main = find(layout, "main");
const header = main?.content?.pane?.header;
if (!header?.content) throw new Error("The layout's main tab block has no pane header; adapt the recipe first.");
if (header.content.mod === mod) { console.log("Layout already uses the pane-composer header."); process.exit(0); }
if (header.content.mod !== "pane") throw new Error(`The pane header is a custom mod (${header.content.mod}); refusing to replace it.`);
header.content = { ...header.content, mod };
const backup = `${layoutPath}.before-${mod}`;
if (!await existsText(backup)) await writeFile(backup, text, { flag: "wx" });
if (await readFile(layoutPath, "utf8") !== text) throw new Error("Layout changed concurrently; nothing written.");
await atomic(layoutPath, JSON.stringify(layout, null, 2) + "\n");
command("herdr-app", ["do", "layout.switch", JSON.stringify({ name: status.layout })]);
console.log(JSON.stringify({ installed, layout: layoutPath, backup }, null, 2));
console.log("For Claude Code terminals also run: npm run claude:install (adds the herdr-composer mod that blanks Claude's hint line).");
