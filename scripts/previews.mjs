// The Previews mod's view of the machine from a shell, for people and agents alike: which
// Storybooks exist under the roots, which preview servers run, and a way to get a project's
// URL without ever starting a second server for it.
//   node scripts/previews.mjs                list projects and running servers
//   node scripts/previews.mjs --json         the same as JSON
//   node scripts/previews.mjs url <name>     the URL serving that project; exit 1 when nothing does
//   node scripts/previews.mjs ensure <name>  start it only if nothing serves it, wait until it does, print the URL
// <name> is a project's package name, its folder name, or its label under a root ("satoramoto/zen/yahaha").
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readlinkSync, openSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KINDS, parsePs, parseSs, instances, project, nearestLock, match, order, conflict, freePort, startArgv, url, ago, summary } from "../mods/previews/parse.js";

const config = await import("../mods/previews/config.js");
const args = process.argv.slice(2);
const json = args.includes("--json");
const verb = args.find((a) => !a.startsWith("--"));
const name = args[args.indexOf(verb) + 1];
const quiet = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const out = (cmd, a) => quiet(() => execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 64 << 20 }), "");
const PRUNE = ["node_modules", ".git", "dist", "build", ".next", ".cache", "storybook-static", ".pnpm-store"];
const LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

function scan(roots, depth) {
  const or = (names, test) => names.flatMap((n, i) => [...(i ? ["-o"] : []), ...test(n)]);
  const text = out("find", [...roots, "-maxdepth", String(depth), "(", ...or(PRUNE, (n) => ["-name", n]), ")", "-prune", "-o",
    "(", "(", "-type", "d", "-name", ".storybook", ")", "-o", "(", "-type", "f", "(", ...or(LOCKS, (n) => ["-name", n]), ")", ")", ")", "-print"]);
  const dirs = [], lockDirs = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const i = line.lastIndexOf("/");
    if (line.slice(i + 1) === ".storybook") dirs.push(line.slice(0, i)); else (lockDirs[line.slice(0, i)] ??= []).push(line.slice(i + 1));
  }
  return dirs.sort().map((dir) => project({ dir, pkg: quiet(() => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), null), lockfiles: nearestLock(dir, lockDirs), roots }));
}
function running() {
  const processes = parsePs(out("ps", ["-eo", "pid=,ppid=,etimes=,args="])), sockets = parseSs(out("ss", ["-ltnpH"]));
  const cwds = {};
  for (const i of instances(processes, sockets)) cwds[i.pid] = quiet(() => readlinkSync(`/proc/${i.pid}/cwd`), null);
  return { instances: instances(processes, sockets, cwds), sockets };
}
async function serving(inst) {
  try { const r = await fetch(`${url(inst.host, inst.port)}${KINDS[inst.kind].path.slice(1)}`, { signal: AbortSignal.timeout(2000) }); return r.status === 200; } catch { return false; }
}

const projects = scan(config.roots, config.depth);
const live = running();
const m = match(projects, live.instances);
m.projects = order(m.projects);
// An exact label or folder first; a bare name only when one project carries it.
function find(q) {
  const exact = m.projects.find((p) => p.label === q || p.dir === q || p.dir.replace(/\/+$/, "") === q.replace(/\/+$/, ""));
  if (exact) return exact;
  const named = m.projects.filter((p) => p.name === q || p.dir.replace(/\/+$/, "").split("/").pop() === q);
  if (named.length > 1) { console.error(`${JSON.stringify(q)} is ${named.length} projects; say which: ${named.map((p) => p.label).join(", ")}`); process.exit(2); }
  return named[0] ?? null;
}

if (verb === "url" || verb === "ensure") {
  if (!name) { console.error(`usage: previews.mjs ${verb} <name>`); process.exit(2); }
  const p = find(name);
  if (!p) { console.error(`no Storybook project called ${JSON.stringify(name)} under ${config.roots.join(", ")}`); process.exit(2); }
  if (p.running.length) {
    const inst = p.running[0];
    if (p.running.length > 1) console.error(`note: ${p.running.length} servers serve ${p.name} (pids ${p.running.map((i) => i.pid).join(", ")}); using :${inst.port}`);
    console.log(url(inst.host, inst.port));
    process.exit(0);
  }
  if (verb === "url") { console.error(`${p.name} is not running`); process.exit(1); }
  const port = freePort(p.port, new Set(live.sockets.map((s) => s.port)));
  const argv = startArgv(p, port);
  const logs = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "herdr-previews");
  mkdirSync(logs, { recursive: true });
  const log = openSync(join(logs, `${p.name}.log`), "a");
  const child = spawn(argv[0], argv.slice(1), { cwd: p.dir, detached: true, stdio: ["ignore", log, log], env: { ...process.env, CI: process.env.CI ?? "1" } });
  child.unref();
  console.error(`started ${argv.join(" ")} in ${p.dir} (pid ${child.pid}, log ${join(logs, `${p.name}.log`)})`);
  const inst = { kind: "storybook", host: p.host === "localhost" ? "127.0.0.1" : p.host, port };
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    if (await serving(inst)) { console.log(url(inst.host, inst.port)); process.exit(0); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`gave up waiting for ${url(inst.host, inst.port)}; see the log`);
  process.exit(1);
}

if (json) { console.log(JSON.stringify({ roots: config.roots, ...m, sockets: live.sockets, summary: summary(m) }, null, 2)); process.exit(0); }
const pad = (s, n) => String(s).padEnd(n);
const wide = Math.max(8, ...m.projects.map((p) => p.label.length));
for (const p of m.projects) {
  const inst = p.running[0];
  const con = conflict(p, live.sockets, live.instances);
  const state = p.running.length > 1 ? `DUPLICATE ×${p.running.length}` : inst ? "running" : "stopped";
  const where = inst ? `${url(inst.host, inst.port)}  pid ${p.running.map((i) => i.pid).join(",")}  up ${ago(inst.elapsed)}` : con ? `:${p.port} busy (${con.by}); would use :${freePort(p.port, new Set(live.sockets.map((s) => s.port)))}` : `:${p.port}  ${startArgv(p).join(" ")}`;
  console.log(`${pad(state, 13)} ${pad(p.label, wide)}  ${where}`);
}
if (m.strays.length) {
  console.log("\nalso running:");
  for (const i of m.strays) console.log(`${pad(KINDS[i.kind].label, 13)} ${pad(i.cwd ?? `pid ${i.pid}`, wide)}  ${url(i.host, i.port)}  pid ${i.pid}  up ${ago(i.elapsed)}`);
}
const s = summary(m);
console.log(`\n${s.projects} projects · ${s.running} running${s.duplicates.length ? ` · ${s.duplicates.length} served twice` : ""}`);
