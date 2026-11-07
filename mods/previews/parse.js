// What a preview server looks like from the outside: the command lines that are one, the
// ports they listen on, the projects that could run one, and which running server belongs
// to which project. Pure: observe.js and scripts/previews.mjs feed it, the tests too.

// The servers recognised on the machine. `port` is the kind's default, `path` what to ask
// for to know it is serving (Storybook's index lists the stories).
export const KINDS = {
  storybook: { label: "Storybook", port: 6006, path: "/index.json" },
  vite: { label: "Vite", port: 5173, path: "/" },
  next: { label: "Next", port: 3000, path: "/" },
  astro: { label: "Astro", port: 4321, path: "/" },
  webpack: { label: "webpack", port: 8080, path: "/" },
};

// `ps -eo pid=,ppid=,etimes=,args=`: one process a line, the command line last, unquoted.
export function parsePs(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], elapsed: +m[3], args: m[4].trim() });
  }
  return out;
}

// `ss -ltnpH`: every listening TCP socket; `users:(("node",pid=N,fd=M))` only for the
// user's own processes, so `pid` is null for the rest (still a busy port).
export function parseSs(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+(?:\s+users:\((.*)\))?/.exec(line);
    if (!m) continue;
    const local = m[1];
    const i = local.lastIndexOf(":");
    const port = parseInt(local.slice(i + 1), 10);
    if (!Number.isFinite(port)) continue;
    let host = local.slice(0, i);
    host = host === "*" || host === "0.0.0.0" || host === "[::]" ? "0.0.0.0" : host.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const pids = [...(m[2] ?? "").matchAll(/pid=(\d+)/g)].map((p) => +p[1]);
    if (pids.length === 0) out.push({ pid: null, port, host });
    for (const pid of pids) out.push({ pid, port, host });
  }
  return out;
}

export function portFromArgs(args) {
  const m = /(?:^|\s)(?:-p|--port)(?:\s+|=)(\d+)\b/.exec(args ?? "");
  return m ? +m[1] : null;
}

export function hostFromArgs(args) {
  const m = /(?:^|\s)(?:-h|--host)(?:\s+|=)([^\s-]\S*)/.exec(args ?? "");
  if (m) return m[1];
  return /(?:^|\s)--host(?:\s|$)/.test(args ?? "") ? "0.0.0.0" : null;
}

// A shell running a command string: whatever it names, the process that serves is its child
// (or replaced it), so the string itself is never a server, however it reads.
const SHELL = /^(?:\S*\/)?(?:sh|bash|zsh|dash|fish|ksh)\s+(?:-\S*\s+)*-c\s/;

// What kind of preview server a command line is, or null. The server's own invocation
// (the bin, with its subcommand), not the npm / pnpm / sh wrappers that name a script.
export function classify(args) {
  const a = args ?? "";
  if (SHELL.test(a)) return null;
  let kind = null;
  if (/(?:^|[\s/])(?:storybook(?:\.c?js)?\s+(?:dev|start)|start-storybook)(?:\s|$)/.test(a)) kind = "storybook";
  else if (/(?:^|[\s/])next(?:\.js)?\s+(?:dev|start)(?:\s|$)/.test(a)) kind = "next";
  else if (/(?:^|[\s/])astro(?:\.js)?\s+(?:dev|preview)(?:\s|$)/.test(a)) kind = "astro";
  else if (/(?:^|[\s/])(?:webpack-dev-server|webpack(?:\.js)?\s+serve)(?:\s|$)/.test(a)) kind = "webpack";
  else if (/(?:^|[\s/])vite(?:\.js)?(?:\s+(?:dev|serve|preview))?(?:\s|$)/.test(a) && !/(?:^|[\s/])vite(?:\.js)?\s+build(?:\s|$)/.test(a)) kind = "vite";
  if (!kind) return null;
  return { kind, port: portFromArgs(a), host: hostFromArgs(a) };
}

// The running preview servers: each classified process, with the port it listens on (the
// socket's, else the one its arguments ask for, else the kind's default), its host and its
// working directory (`cwds`: pid -> folder). A wrapper whose child is the same server
// (`sh -c storybook dev …` around `node …/storybook dev …`) is dropped for the child.
export function instances(processes, sockets, cwds = {}) {
  const found = processes.map((p) => ({ ...p, ...(classify(p.args) ?? {}) })).filter((p) => p.kind);
  const byPid = new Map(found.map((p) => [p.pid, p]));
  const wrappers = new Set();
  for (const p of found) if (byPid.get(p.ppid)?.kind === p.kind) wrappers.add(p.ppid);
  return found.filter((p) => !wrappers.has(p.pid)).map((p) => {
    const listening = sockets.filter((s) => s.pid === p.pid);
    const port = listening[0]?.port ?? p.port ?? KINDS[p.kind].port;
    const host = listening[0]?.host ?? p.host ?? "127.0.0.1";
    return { pid: p.pid, ppid: p.ppid, elapsed: p.elapsed, args: p.args, kind: p.kind, cwd: cwds[p.pid] ?? null, port, host, listening: listening.length > 0 };
  });
}

export const url = (host, port) => `http://${!host || host === "0.0.0.0" || host === "::" ? "localhost" : host}:${port}/`;

// A package script's final command: `npm run dev` → the dev script, a few hops at most.
export function resolveScript(scripts, name, hops = 0) {
  const command = scripts?.[name];
  if (typeof command !== "string") return null;
  if (hops > 4) return command;
  const m = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)\s*$/.exec(command);
  return m && scripts[m[1]] != null ? resolveScript(scripts, m[1], hops + 1) : command;
}

export const basename = (dir) => dir.replace(/\/+$/, "").split("/").pop();

// `dir` under one of the roots, as "owner/repo/sub"; the folder's name when not.
export function label(dir, roots = []) {
  for (const root of roots) {
    const r = root.replace(/\/+$/, "");
    if (dir === r) return basename(dir);
    if (dir.startsWith(r + "/")) return dir.slice(r.length + 1);
  }
  return basename(dir);
}

const managerOf = (lockfiles) => lockfiles.includes("pnpm-lock.yaml") ? "pnpm" : lockfiles.includes("yarn.lock") ? "yarn" : lockfiles.some((l) => /^bun\.lockb?$/.test(l)) ? "bun" : "npm";

// A folder with a `.storybook`: how it is started (its `storybook` script, or whichever
// script runs `storybook dev`), the port and host that command asks for, the package
// manager its lockfile names, and the Storybook version it depends on.
export function project({ dir, pkg, lockfiles = [], roots = [] }) {
  const scripts = pkg?.scripts ?? {};
  const script = scripts.storybook != null ? "storybook" : Object.keys(scripts).find((k) => classify(resolveScript(scripts, k) ?? "")?.kind === "storybook") ?? null;
  const command = script ? resolveScript(scripts, script) : null;
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const version = (deps.storybook ?? deps["@storybook/react"] ?? deps["@storybook/vue3"] ?? deps["@storybook/svelte"] ?? deps["@storybook/web-components"] ?? null)?.replace(/^[\^~>=]+/, "") ?? null;
  return {
    dir, kind: "storybook", label: label(dir, roots),
    name: (typeof pkg?.name === "string" && pkg.name.replace(/^@[^/]+\//, "")) || basename(dir),
    script, command, port: portFromArgs(command) ?? KINDS.storybook.port, host: hostFromArgs(command) ?? "localhost",
    manager: managerOf(lockfiles), version,
  };
}

// The nearest lockfile at or above `dir`: a monorepo keeps one at its root.
export function nearestLock(dir, lockDirs) {
  let d = dir.replace(/\/+$/, "");
  for (;;) {
    if (lockDirs[d]) return lockDirs[d];
    const i = d.lastIndexOf("/");
    if (i <= 0) return [];
    d = d.slice(0, i);
  }
}

// What to run, from the project's folder, to start it on `port`. The script as the
// package manager runs it; the port appended only when it differs from the script's own.
export function startArgv(p, port = p.port) {
  const argv = p.script
    ? { npm: ["npm", "run", p.script], pnpm: ["pnpm", "run", p.script], yarn: ["yarn", "run", p.script], bun: ["bun", "run", p.script] }[p.manager]
    : [{ npm: "npx", pnpm: "pnpm", yarn: "yarn", bun: "bunx" }[p.manager], "storybook", "dev"];
  if (!p.script || port !== p.port) argv.push(...(p.script && p.manager === "npm" ? ["--"] : []), "--port", String(port));
  return argv;
}

// Which running server is which project's: the deepest project folder the server's working
// directory is in, of the same kind. The rest are strays (a scratch folder, a worktree
// nobody scanned, a server with no readable cwd).
export function match(projects, list) {
  const deepest = [...projects].sort((a, b) => b.dir.length - a.dir.length);
  const running = new Map(projects.map((p) => [p.dir, []]));
  const strays = [];
  for (const inst of list) {
    const home = inst.cwd ? deepest.find((p) => p.kind === inst.kind && (inst.cwd === p.dir || inst.cwd.startsWith(p.dir + "/"))) : null;
    if (home) running.get(home.dir).push(inst); else strays.push(inst);
  }
  return { projects: projects.map((p) => ({ ...p, running: running.get(p.dir) })), strays };
}

export const freePort = (wanted, taken) => { let port = wanted; while (taken.has(port)) port += 1; return port; };

// A stopped project whose port something else holds: who, so the row can say.
export function conflict(p, sockets, list) {
  if (p.running?.length) return null;
  const s = sockets.find((s) => s.port === p.port);
  if (!s) return null;
  const inst = list.find((i) => i.pid === s.pid);
  return { port: p.port, by: inst ? (inst.cwd ? basename(inst.cwd) : KINDS[inst.kind].label) : s.pid ? `pid ${s.pid}` : "another process" };
}

// Running first (the most recent start first within), then projects a shown space is in,
// then by label.
export function order(projects, openFolders = []) {
  const open = (p) => openFolders.some((f) => f === p.dir || p.dir.startsWith(f.replace(/\/+$/, "") + "/") || f.startsWith(p.dir + "/"));
  return [...projects].sort((a, b) => {
    const ra = a.running?.length ? 1 : 0, rb = b.running?.length ? 1 : 0;
    if (ra !== rb) return rb - ra;
    const oa = open(a) ? 1 : 0, ob = open(b) ? 1 : 0;
    if (oa !== ob) return ob - oa;
    return a.label.localeCompare(b.label);
  });
}

export function ago(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function summary(model) {
  const projects = model.projects ?? [];
  const running = projects.reduce((n, p) => n + (p.running?.length ?? 0), 0) + (model.strays?.length ?? 0);
  const duplicates = projects.filter((p) => (p.running?.length ?? 0) > 1);
  return { projects: projects.length, running, duplicates };
}
