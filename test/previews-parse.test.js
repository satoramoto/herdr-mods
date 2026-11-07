import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePs, parseSs, classify, instances, resolveScript, project, nearestLock, startArgv, match, conflict, order, freePort, ago, label, url, summary } from "../mods/previews/parse.js";

const PS = `
 788417  788416     197 npm run storybook
 788440  788417     197 sh -c storybook dev -p 6006 --no-open
 788443  788440     197 node /home/ryan/Projects/ryangavin/big-red-synth/node_modules/.bin/storybook dev -p 6006 --no-open --disable-telemetry
2923748 2923729   45749 node /tmp/zen-math-play/node_modules/.bin/vite --host 127.0.0.1 --port 4197 --strictPort
2923749 2923729   45749 node /tmp/zen-math-play/node_modules/.bin/storybook dev --host 127.0.0.1 --port 6027 --ci --no-open
   4000       1      10 node /x/node_modules/.bin/vite build
   4001       1      10 node /x/node_modules/.bin/next dev --port 3001
   4002       1      10 /usr/bin/zsh -c eval 'npm run storybook > /tmp/storybook.log 2>&1'
`;
const SS = `
LISTEN 0      4096       127.0.0.1:4000  0.0.0.0:* users:(("bundle",pid=81968,fd=8))
LISTEN 0      511        127.0.0.1:6027  0.0.0.0:* users:(("node-MainThread",pid=2923749,fd=40))
LISTEN 0      511        127.0.0.1:4197  0.0.0.0:* users:(("node-MainThread",pid=2923748,fd=22))
LISTEN 0      4096       127.0.0.1:40973 0.0.0.0:*
LISTEN 0      511                *:6006        *:* users:(("node-MainThread",pid=788443,fd=40))
LISTEN 0      4096           [::1]:631      [::]:*
LISTEN 0      4096   127.0.0.53%lo:53    0.0.0.0:*
`;

test("ps lines parse into pid, parent, uptime and the command line", () => {
  const p = parsePs(PS);
  assert.equal(p.length, 8);
  assert.deepEqual(p[2], { pid: 788443, ppid: 788440, elapsed: 197, args: "node /home/ryan/Projects/ryangavin/big-red-synth/node_modules/.bin/storybook dev -p 6006 --no-open --disable-telemetry" });
});

test("ss lines parse into port, host and owning pid; ports without a known owner still count", () => {
  const s = parseSs(SS);
  assert.deepEqual(s.find((x) => x.port === 6006), { pid: 788443, port: 6006, host: "0.0.0.0" });
  assert.deepEqual(s.find((x) => x.port === 6027), { pid: 2923749, port: 6027, host: "127.0.0.1" });
  assert.deepEqual(s.find((x) => x.port === 40973), { pid: null, port: 40973, host: "127.0.0.1" });
  assert.deepEqual(s.find((x) => x.port === 631), { pid: null, port: 631, host: "::1" });
  assert.deepEqual(s.find((x) => x.port === 53), { pid: null, port: 53, host: "127.0.0.53" });
});

test("a command line is classified by the server bin it runs, not by the script that names it", () => {
  assert.deepEqual(classify("node /p/node_modules/.bin/storybook dev -p 6006 --no-open"), { kind: "storybook", port: 6006, host: null });
  assert.deepEqual(classify("node storybook dev --port=6022 --host 0.0.0.0"), { kind: "storybook", port: 6022, host: "0.0.0.0" });
  assert.equal(classify("sh -c storybook dev --port=6022"), null); // the shell is never the server, whatever its string says
  assert.equal(classify("/usr/bin/zsh -c eval 'cat > x <<EOF storybook dev -p 6006 EOF'"), null);
  assert.equal(classify("node /p/node_modules/.bin/start-storybook -p 9009").kind, "storybook");
  assert.equal(classify("npm run storybook"), null);
  assert.equal(classify("/usr/bin/zsh -c eval 'npm run storybook > log 2>&1'"), null);
  assert.equal(classify("node /p/node_modules/.bin/storybook build"), null);
  assert.equal(classify("node /p/node_modules/.bin/vite build"), null);
  assert.deepEqual(classify("node /p/node_modules/.bin/vite --host --port 4197"), { kind: "vite", port: 4197, host: "0.0.0.0" });
  assert.equal(classify("node /p/node_modules/.bin/vite preview").kind, "vite");
  assert.equal(classify("node /p/node_modules/.bin/next dev --port 3001").port, 3001);
  assert.equal(classify("node /p/node_modules/.bin/astro dev").kind, "astro");
  assert.equal(classify("node /p/node_modules/.bin/webpack serve").kind, "webpack");
  assert.equal(classify("vim storybook.config.js"), null);
});

test("instances keep the server process, not the shells and scripts around it, with the port it listens on", () => {
  const list = instances(parsePs(PS), parseSs(SS), { 788443: "/home/ryan/Projects/ryangavin/big-red-synth", 2923749: "/tmp/zen-math-play", 2923748: "/tmp/zen-math-play" });
  assert.deepEqual(list.map((i) => i.pid).sort((a, b) => a - b), [4001, 788443, 2923748, 2923749]);
  const sb = list.find((i) => i.pid === 788443);
  assert.equal(sb.kind, "storybook");
  assert.equal(sb.port, 6006);
  assert.equal(sb.host, "0.0.0.0");
  assert.equal(sb.listening, true);
  assert.equal(sb.cwd, "/home/ryan/Projects/ryangavin/big-red-synth");
  const next = list.find((i) => i.pid === 4001);
  assert.equal(next.port, 3001); // from its arguments: no socket yet
  assert.equal(next.listening, false);
  assert.equal(next.cwd, null);
  assert.equal(instances(parsePs("1 0 5 node /p/node_modules/.bin/storybook dev"), [])[0].port, 6006); // the kind's default
});

test("urls open on localhost when the server binds every interface", () => {
  assert.equal(url("0.0.0.0", 6006), "http://localhost:6006/");
  assert.equal(url("127.0.0.1", 6027), "http://127.0.0.1:6027/");
});

test("a script that runs another script resolves to the final command", () => {
  const scripts = { storybook: "npm run dev", dev: "storybook dev -p 6010", loop: "npm run loop", plain: "echo hi" };
  assert.equal(resolveScript(scripts, "storybook"), "storybook dev -p 6010");
  assert.equal(resolveScript(scripts, "plain"), "echo hi");
  assert.equal(resolveScript(scripts, "loop"), "npm run loop"); // bounded, not infinite
  assert.equal(resolveScript(scripts, "missing"), null);
});

test("a project knows its name, label, start script, port, host, package manager and Storybook version", () => {
  const roots = ["/home/ryan/Projects"];
  const p = project({ dir: "/home/ryan/Projects/hidden-signals", pkg: { name: "hidden-signals", scripts: { storybook: "storybook dev --host 127.0.0.1 --port 4208 --exact-port --ci --no-open" }, devDependencies: { storybook: "^10.6.5" } }, lockfiles: ["package-lock.json"], roots });
  assert.equal(p.name, "hidden-signals");
  assert.equal(p.label, "hidden-signals");
  assert.equal(p.script, "storybook");
  assert.equal(p.port, 4208);
  assert.equal(p.host, "127.0.0.1");
  assert.equal(p.manager, "npm");
  assert.equal(p.version, "10.6.5");
  const scoped = project({ dir: "/home/ryan/Projects/satoramoto/zen/yahaha", pkg: { name: "@satoramoto/yahaha", scripts: { dev: "storybook dev -p 6022", storybook: "npm run dev" } }, lockfiles: ["pnpm-lock.yaml"], roots });
  assert.equal(scoped.name, "yahaha");
  assert.equal(scoped.label, "satoramoto/zen/yahaha");
  assert.equal(scoped.port, 6022);
  assert.equal(scoped.manager, "pnpm");
  const viaDev = project({ dir: "/x/widgets", pkg: { name: "w", scripts: { dev: "storybook dev -p 7007" } }, lockfiles: ["yarn.lock"], roots });
  assert.equal(viaDev.script, "dev");
  assert.equal(viaDev.port, 7007);
  const bare = project({ dir: "/x/bare", pkg: null, lockfiles: ["bun.lockb"], roots });
  assert.equal(bare.name, "bare");
  assert.equal(bare.script, null);
  assert.equal(bare.port, 6006);
  assert.equal(bare.manager, "bun");
  assert.equal(bare.version, null);
});

test("the nearest lockfile above a folder decides its package manager", () => {
  const locks = { "/m": ["pnpm-lock.yaml"], "/m/packages/other": ["yarn.lock"] };
  assert.deepEqual(nearestLock("/m/packages/ui", locks), ["pnpm-lock.yaml"]);
  assert.deepEqual(nearestLock("/m/packages/other", locks), ["yarn.lock"]);
  assert.deepEqual(nearestLock("/elsewhere/x", locks), []);
});

test("the start command runs the script with its package manager, passing a port only when it must change", () => {
  const npm = { script: "storybook", manager: "npm", port: 6006 };
  assert.deepEqual(startArgv(npm), ["npm", "run", "storybook"]);
  assert.deepEqual(startArgv(npm, 6007), ["npm", "run", "storybook", "--", "--port", "6007"]);
  assert.deepEqual(startArgv({ script: "dev", manager: "pnpm", port: 6006 }, 6008), ["pnpm", "run", "dev", "--port", "6008"]);
  assert.deepEqual(startArgv({ script: null, manager: "npm", port: 6006 }), ["npx", "storybook", "dev", "--port", "6006"]);
  assert.deepEqual(startArgv({ script: null, manager: "bun", port: 6006 }, 6010), ["bunx", "storybook", "dev", "--port", "6010"]);
});

test("a running server belongs to the deepest project folder its cwd is in; the rest are strays", () => {
  const projects = [{ dir: "/p/zen", kind: "storybook" }, { dir: "/p/zen/yahaha", kind: "storybook" }, { dir: "/p/brs", kind: "storybook" }];
  const list = [
    { pid: 1, kind: "storybook", cwd: "/p/zen/yahaha" },
    { pid: 2, kind: "storybook", cwd: "/p/zen/src/deeper" },
    { pid: 3, kind: "storybook", cwd: "/tmp/scratch" },
    { pid: 4, kind: "vite", cwd: "/p/brs" },
    { pid: 5, kind: "storybook", cwd: "/p/brs" },
    { pid: 6, kind: "storybook", cwd: "/p/brs" },
    { pid: 7, kind: "storybook", cwd: null },
  ];
  const m = match(projects, list);
  assert.deepEqual(m.projects.find((p) => p.dir === "/p/zen/yahaha").running.map((i) => i.pid), [1]);
  assert.deepEqual(m.projects.find((p) => p.dir === "/p/zen").running.map((i) => i.pid), [2]);
  assert.deepEqual(m.projects.find((p) => p.dir === "/p/brs").running.map((i) => i.pid), [5, 6]);
  assert.deepEqual(m.strays.map((i) => i.pid), [3, 4, 7]);
  assert.deepEqual(summary(m), { projects: 3, running: 7, duplicates: [m.projects[2]] });
});

test("a stopped project whose port is taken says by whom, and the next free port is offered", () => {
  const sockets = [{ pid: 10, port: 6006, host: "0.0.0.0" }, { pid: null, port: 6007, host: "127.0.0.1" }];
  const list = [{ pid: 10, kind: "storybook", cwd: "/p/brs", port: 6006 }];
  assert.deepEqual(conflict({ port: 6006, running: [] }, sockets, list), { port: 6006, by: "brs" });
  assert.deepEqual(conflict({ port: 6007, running: [] }, sockets, list), { port: 6007, by: "another process" });
  assert.equal(conflict({ port: 6008, running: [] }, sockets, list), null);
  assert.equal(conflict({ port: 6006, running: [list[0]] }, sockets, list), null);
  assert.equal(freePort(6006, new Set([6006, 6007])), 6008);
  assert.equal(freePort(6010, new Set([6006])), 6010);
});

test("running projects come first, then those a shown space is in, then by label", () => {
  const ps = [
    { dir: "/p/c", label: "c", running: [] },
    { dir: "/p/b", label: "b", running: [{ pid: 1 }] },
    { dir: "/p/a", label: "a", running: [] },
    { dir: "/p/d/sub", label: "d/sub", running: [] },
  ];
  assert.deepEqual(order(ps, ["/p/d"]).map((p) => p.label), ["b", "d/sub", "a", "c"]);
});

test("labels are relative to a root; durations read as people say them", () => {
  assert.equal(label("/home/r/Projects/a/b", ["/home/r/Projects/"]), "a/b");
  assert.equal(label("/tmp/x", ["/home/r/Projects"]), "x");
  assert.equal(ago(45), "45s");
  assert.equal(ago(197), "3m");
  assert.equal(ago(45749), "12h 42m");
  assert.equal(ago(200000), "2d 7h");
  assert.equal(ago(NaN), "");
});
