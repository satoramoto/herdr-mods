// Install Previews (every Storybook under the project roots and every preview server running,
// in one list) into the Herdr app home. Inspectable: copies owned files and adds one block to
// the personal layout's sidebar, under the lists already there.
//   --ui-only        update the mod's files, leave the layout alone
//   --root <path>    a folder to scan (repeatable; default: the value in mods/previews/config.js)
//   --depth <n>      how deep to look under each root (default 6)
//   --key <chord>    bind the chord to layout.toggle:previews in keys.json (global), if free
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const mod = "previews";
const installed = join(home, "mods", mod);
const args = process.argv.slice(2);
const uiOnly = args.includes("--ui-only");
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flags = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [resolve(args[i + 1])] : []));
const command = (name, a) => execFileSync(name, a, { encoding: "utf8" }).trim();
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
for (const name of ["main.js", "parse.js", "observe.js", "mod.json"]) await atomic(join(installed, name), await readFile(join(source, "mods", mod, name), "utf8"));
const defaults = await import(join(source, "mods", mod, "config.js"));
const roots = flags("--root");
const config = { roots: roots.length ? roots : owned?.config?.roots ?? defaults.roots, depth: parseInt(flag("--depth") ?? owned?.config?.depth ?? defaults.depth, 10) };
await atomic(join(installed, "config.js"), `// Written by scripts/install-previews.mjs; edit to scan elsewhere.\nexport const roots = ${JSON.stringify(config.roots)};\nexport const depth = ${config.depth};\n`);
command("herdr-app", ["check", installed]);
await atomic(marker, JSON.stringify({ source, config, installedAt: Date.now() }, null, 2) + "\n");
// A key that puts Previews away and brings it back; only a free chord, only ours to change later.
const chord = flag("--key");
if (chord) {
  const keysPath = join(home, "keys.json");
  const keysText = (await existsText(keysPath)) ?? "{}";
  const keys = JSON.parse(keysText);
  keys.global ??= {};
  const taken = keys.global[chord];
  if (taken && taken !== `layout.toggle:${mod}`) throw new Error(`${chord} is already bound to ${JSON.stringify(taken)}; pick another.`);
  if (!taken) {
    const backup = `${keysPath}.before-${mod}`;
    if (!await existsText(backup)) await writeFile(backup, keysText, { flag: "wx" });
    keys.global[chord] = `layout.toggle:${mod}`;
    await atomic(keysPath, JSON.stringify(keys, null, 2) + "\n");
    console.log(`${chord} toggles Previews.`);
  }
}
if (uiOnly) { console.log("Updated the previews mod; layout untouched."); process.exit(0); }

// The personal layout: one more block in the sidebar's list column, under what is there.
const status = JSON.parse(command("herdr-app", ["status"]));
const layoutPath = join(home, "layouts", `${status.layout}.json`);
const text = await readFile(layoutPath, "utf8");
const layout = JSON.parse(text);
if (!layout.cloned_from) throw new Error("Switch to a personal (cloned) layout first; shipped layouts are not modified.");
if (find(layout, mod)) { console.log("Layout already shows Previews."); process.exit(0); }
const lists = find(layout, "sidebar-lists");
if (!lists?.children) throw new Error("No sidebar-lists column in this layout; add a { \"content\": { \"mod\": \"previews\" } } block by hand.");
lists.children.push({ id: mod, type: "block", content: { mod }, size: { weight: 0.5 }, min: 120 });
const backup = `${layoutPath}.before-${mod}`;
if (!await existsText(backup)) await writeFile(backup, text, { flag: "wx" });
if (await readFile(layoutPath, "utf8") !== text) throw new Error("Layout changed concurrently; nothing written.");
await atomic(layoutPath, JSON.stringify(layout, null, 2) + "\n");
console.log(JSON.stringify({ installed, layout: layoutPath }, null, 2));
