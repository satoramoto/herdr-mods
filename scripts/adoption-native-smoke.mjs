// One non-model terminal fixture. No user terminal is typed into or stopped.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { moveLiveTerminal } from "../adapters/native-adoption.mjs";

const exec = promisify(execFile);
const call = async (program, args) => JSON.parse((await exec(program, args, { timeout: 8000 })).stdout);
const topology = await call("herdr-app", ["ls"]);
// Two existing local spaces to move the fixture between, named by ADOPT_FROM / ADOPT_TO.
const names = { from: process.env.ADOPT_FROM, to: process.env.ADOPT_TO };
if (!names.from || !names.to) throw new Error("Set ADOPT_FROM and ADOPT_TO to the names of two existing spaces.");
const from = topology.spaces.find((s) => s.name === names.from && !s.machine);
const to = topology.spaces.find((s) => s.name === names.to && !s.machine);
if (!from || !to) throw new Error(`Fixture needs existing local spaces "${names.from}" and "${names.to}"; none were created.`);
const events = new EventEmitter();
const stream = spawn("herdr-core", ["events", "--json"]);
stream.stdout.on("data", () => events.emit("change"));
let address;
async function placement(space) {
  return new Promise((resolve, reject) => {
    let inspecting = false, changed = false;
    const timeout = setTimeout(() => finish(new Error(`Fixture did not appear in ${space} after a core event`)), 8000);
    function finish(error, value) { clearTimeout(timeout); events.off("change", inspect); error ? reject(error) : resolve(value); }
    async function inspect() {
      if (inspecting) { changed = true; return; }
      inspecting = true;
      try {
        const view = await call("herdr-app", ["ls"]);
        const locations = view.spaces.flatMap((s) => s.tabs.flatMap((t) => t.terminals.filter((p) => p.terminal === address).map(() => s.id)));
        if (locations.length === 1 && locations[0] === space) { finish(null, locations); return; }
      } catch (error) { finish(error); return; }
      finally { inspecting = false; }
      if (changed) { changed = false; void inspect(); }
    }
    events.on("change", inspect);
    void inspect();
  });
}
try {
  const result = await call("herdr-core", ["run", "--bg", "--no-parent", "--no-notify", "--name", "adoption-fixture", "--cwd", "/tmp/opencode", "--label", `herdr.space=${from.id}`, "--", "node", "-e", "setInterval(()=>{},60000)"]);
  address = result.address;
  await placement(from.id);
  const before = await call("herdr-core", ["get", address]);
  await moveLiveTerminal(before, to.id);
  await placement(to.id);
  const after = await call("herdr-core", ["get", address]);
  if (before.pid !== after.pid || before.cwd !== after.cwd) throw new Error("Fixture identity changed.");
  console.log(JSON.stringify({ fixture: address, moved: true, samePid: true, sameCwd: true, from: from.name, to: to.name }));
} finally {
  if (address) { await call("herdr-core", ["kill", address]); await call("herdr-core", ["rm", address]); }
  stream.kill("SIGTERM");
}
