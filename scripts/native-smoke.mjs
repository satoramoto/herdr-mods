import { readFile, writeFile, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkAttached } from "./check-attached.mjs";

// Visible QA windows require explicit opt-in; the default native smoke is an
// offscreen loader/state check of the actual attached composer panel.
if (!process.argv.includes("--visible-fixture")) {
  console.log(JSON.stringify(await checkAttached(), null, 2));
  process.exit(0);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appHome = process.env.HERDR_APP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-app");
const scratch = await mkdtemp("/tmp/opencode/herdr-composer-qa-");
const name = `unified-chat-qa-${Date.now()}`;
const modPath = join(appHome, "mods", name);
const logPath = join(scratch, "received.jsonl");
const resultPath = join(scratch, "native-result.json");
const width = Number(process.env.HERDR_QA_WIDTH ?? 760);
if (!Number.isFinite(width) || width < 320 || width > 1200) throw new Error("QA width must be 320–1200.");
const call = (program, args) => execFileSync(program, args, { encoding: "utf8" }).trim();
let address;
try {
  const started = JSON.parse(call("hc", ["run", "--json", "--bg", "--no-parent", "--no-notify", "--name", `composer-qa-${Date.now()}`, "--", "node", join(root, "test", "status-agent.mjs"), logPath]));
  address = started.address ?? started.terminal?.address ?? started.terminal;
  if (typeof address !== "string") throw new Error(`Unexpected fixture run result: ${JSON.stringify(started)}`);
  await mkdir(modPath);
  for (const file of ["layout.js", "admission.js", "completion.js", "drafts.js", "forms.js", "ui-control.js", "attention-panel.js", "prompt.js", "opencode-panel.js", "model.js", "queue.js", "metadata.js"]) await copyFile(join(root, "mods", "unified-chat", file), join(modPath, file));
  await copyFile(join(root, "mods", "unified-chat", "main.js"), join(modPath, "composer.js"));
  await copyFile(join(root, "test", "native-view.js"), join(modPath, "main.js"));
  await writeFile(join(modPath, "fixture.js"), `export const fixtureAddress = ${JSON.stringify(address)};\nexport const logPath = ${JSON.stringify(logPath)};\nexport const resultPath = ${JSON.stringify(resultPath)};\n`);
  await writeFile(join(modPath, "mod.json"), JSON.stringify({ place: "none", overlay: { width, height: 300 } }));
  console.log(call("herdr-app", ["check", modPath]));
  call("herdr-app", ["do", "mod.open", JSON.stringify({ name })]);
  if (process.argv.includes("--screenshot")) {
    await mkdir(join(root, "evidence"), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 180));
    console.log(call("herdr-app", ["shot", join(root, "evidence", `native-${width}.png`)]));
  }
  const deadline = Date.now() + 45000;
  let result;
  while (!result) {
    try { result = JSON.parse(await readFile(resultPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (Date.now() > deadline) throw new Error("Native smoke did not finish; inspect herdr-app status.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(join(root, "evidence", "native-result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  if (address) {
    try { call("hc", ["kill", address]); } catch {}
    try { call("hc", ["rm", address]); } catch {}
  }
  // Only this uniquely named test mod and scratch directory are removed.
  await rm(modPath, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
