// Inspectable local installation: no downloads, key changes or shipped-file edits.
import { readFile, writeFile, mkdir, access, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fitComposerLayout } from "../mods/unified-chat/layout.js";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const mod = "unified-chat";
const layoutName = "unified-chat";
const markerPath = join(home, ".unified-chat-install.json");
const call = (...args) => execFileSync("herdr-app", args, { encoding: "utf8" }).trim();
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
async function writeAtomic(path, text) {
  const temporary = `${path}.installing`;
  await writeFile(temporary, text, { flag: "wx" });
  await rename(temporary, path);
}
function find(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const marker = await exists(markerPath) ? await readJson(markerPath) : null;
const installedMod = join(home, "mods", mod);
const layoutPath = join(home, "layouts", `${layoutName}.json`);
if ((await exists(installedMod) || await exists(layoutPath)) && marker?.source !== source) {
  throw new Error("unified-chat is already in use. Refusing to overwrite an unowned mod/layout.");
}
const base = await readJson(join(home, "layouts", "main.json"));
if (!find(base, "work")?.children) throw new Error("This Herdr main layout has no work column; adapt the recipe first.");
console.log(call("check", join(source, "mods", mod)));
const before = JSON.parse(call("status"));
await mkdir(installedMod, { recursive: true });
for (const name of ["layout.js", "admission.js", "completion.js", "drafts.js", "forms.js", "ui-control.js", "attention-panel.js", "claude-panel.js", "claude-control.js", "style.js", "attachments.mjs", "prompt.js", "opencode-panel.js", "opencode-control.mjs", "main.js", "model.js", "queue.js", "metadata.js", "opencode-bridge.mjs", "mod.json"]) {
  const text = await readFile(join(source, "mods", mod, name), "utf8");
  await writeAtomic(join(installedMod, name), text);
}
// Keep ownership information before switching layouts, so an interrupted install
// can be retried without treating our own partial install as somebody else's.
await writeAtomic(markerPath, JSON.stringify({ source, previousLayout: marker?.previousLayout ?? before.layout, opencode: Boolean(marker?.opencode) }, null, 2) + "\n");
console.log(call("check", installedMod));
if (!await exists(layoutPath)) call("do", "layout.clone", JSON.stringify({ name: "main", as: layoutName }));
const layout = await readJson(layoutPath);
const previousLayout = JSON.stringify(layout);
fitComposerLayout(layout);
// The composer now carries the standard workspace status in its single footer.
// Preserve custom status mods rather than silently hiding their own features.
const status = find(layout, "status");
if (status?.content?.mod === "workspace-status") status.hidden = true;
if (JSON.stringify(layout) !== previousLayout) {
  // Existing installations can predate the three-row composer's height budget.
  await writeAtomic(layoutPath, JSON.stringify(layout, null, 2) + "\n");
}
if (process.argv.includes("--opencode") || marker?.opencode) {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const adapterHome = join(configHome, "opencode", "unified-chat-metadata");
  const cliPath = join(configHome, "opencode", "cli.json");
  if (await exists(adapterHome) && !marker?.opencode) throw new Error("OpenCode adapter folder already exists; refusing to overwrite it.");
  const cliText = await readFile(cliPath, "utf8");
  const cli = JSON.parse(cliText);
  if (cli.plugins != null && !Array.isArray(cli.plugins)) throw new Error("Unexpected OpenCode plugins configuration.");
  await mkdir(adapterHome, { recursive: true });
  await writeAtomic(markerPath, JSON.stringify({ source, previousLayout: marker?.previousLayout ?? before.layout, opencode: true }, null, 2) + "\n");
  await writeAtomic(join(adapterHome, "forms.js"), await readFile(join(source, "mods/unified-chat/forms.js"), "utf8"));
  await writeAtomic(join(adapterHome, "prompt-completion.js"), await readFile(join(source, "mods/unified-chat/completion.js"), "utf8"));
  for (const name of ["command-completion.js", "operations.js", "controls.js", "socket.js", "tui.js"]) {
    await writeAtomic(join(adapterHome, name), await readFile(join(source, "adapters", "opencode", name), "utf8"));
  }
  await writeAtomic(join(adapterHome, "metadata.js"), await readFile(join(source, "mods", mod, "metadata.js"), "utf8"));
  const entry = "./unified-chat-metadata";
  const plugins = cli.plugins ?? [];
  if (!plugins.some((item) => item === entry || item?.package === entry)) {
    const backup = `${cliPath}.before-unified-chat`;
    if (!await exists(backup)) await writeFile(backup, cliText, { flag: "wx" });
    cli.plugins = [...plugins, entry];
    if (await readFile(cliPath, "utf8") !== cliText) throw new Error("OpenCode settings changed during installation; retry instead of overwriting them.");
    await writeAtomic(cliPath, JSON.stringify(cli, null, 2) + "\n");
  }
  await writeAtomic(markerPath, JSON.stringify({ source, previousLayout: marker?.previousLayout ?? before.layout, opencode: true }, null, 2) + "\n");
  console.log("Installed OpenCode metadata reporter and private explicit-action bridge. Existing CLI settings preserved; original backed up.");
}
call("do", "layout.switch", JSON.stringify({ name: layoutName }));
console.log(`Installed ${installedMod}\nSelected layout: ${layoutName}\nReturn to the previous layout: herdr-app do layout.switch '${JSON.stringify({ name: marker?.previousLayout ?? before.layout })}'`);
