import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

// Executable doubles exercise the full CLI worker without touching real core,
// OpenCode, Herdr, terminals, model sessions, or any existing registry.
async function fixture(t, { missingTab = false } = {}) {
  const folder = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "herdr-restore-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const registry = join(folder, "sessions.json");
  const calls = join(folder, "calls.jsonl");
  const executable = join(folder, "fake-cli.mjs");
  await writeFile(executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args)+'\\n');
const out = value => console.log(JSON.stringify(value));
if (args[0] === 'server') out({pid:1});
else if (args[0] === 'service') console.log('http://127.0.0.1:1234');
else if (args[0] === 'api') {
  if (args[2] === '/api/info') out({hostname:'test',pid:Number(process.env.FAKE_PID)});
  else out({data:{id:'ses_test',location:{directory:'/fixture'}}});
} else if (args[0] === 'ls') out(process.env.FAKE_APP === '1' ? {spaces:[]} : {terminals:[]});
else if (args[0] === 'run') out({address:'tnew'});
else throw new Error('Unexpected fixture command: '+args);
`, { mode: 0o700 });
  const fakeApp = join(folder, "fake-app.mjs");
  await writeFile(fakeApp, `#!${process.execPath}
console.log(JSON.stringify({spaces:[{id:'space',tabs:${missingTab ? "[]" : "[{id:'tab'}]"}}]}));
`, { mode: 0o700 });
  await writeFile(registry, JSON.stringify({ version: 1, generation: "previous-server", bindings: {
    ses_test: { sessionID: "ses_test", directory: "/fixture", space: "space", tab: "tab", terminal: "told", open: true, lastSeen: 1 },
  } }));
  const env = { ...process.env, OPENCODE_HERDR_REGISTRY: registry, OPENCODE_HERDR_OPENCODE: executable,
    OPENCODE_HERDR_CORE: executable, OPENCODE_HERDR_APP: fakeApp, FAKE_CALLS: calls, FAKE_PID: String(process.pid) };
  return { folder, registry, calls, executable, env };
}

test("preview discovers a simulated restart but neither writes nor launches", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.registry, "utf8");
  const child = spawn(process.execPath, [resolve("scripts/opencode-herdr-restore.mjs"), "--once"], { env: f.env });
  let output = ""; let errors = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { errors += data; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
  assert.deepEqual(JSON.parse(output).wouldRestore, ["ses_test"]);
  assert.equal(await readFile(f.registry, "utf8"), before);
  assert.ok(!(await readFile(f.calls, "utf8")).includes('"run"'));
});

test("worker resumes only a client, persists attempt before launch, and exits cleanly", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [resolve("scripts/opencode-herdr-restore.mjs"), "--watch"], { env: f.env });
  t.after(() => child.kill("SIGTERM"));
  let output = ""; let errors = "";
  child.stderr.on("data", (data) => { errors += data; });
  const restored = new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => { output += data; if (output.includes('"restored"')) resolve(); });
    child.on("exit", (code) => { if (!output.includes('"restored"')) reject(new Error(`Exited ${code}: ${errors}`)); });
  });
  await restored;
  assert.equal(JSON.parse(await readFile(f.registry, "utf8")).bindings.ses_test.attempted, true);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(JSON.parse);
  const launches = calls.filter((args) => args[0] === "run");
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].slice(-5), ["--", f.executable, "--session", "ses_test", "/fixture"]);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  assert.equal((await exited)[0], 0, errors);
});
