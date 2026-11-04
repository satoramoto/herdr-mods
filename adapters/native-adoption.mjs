import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";

const exec = promisify(execFile);
// The app adopts labels for unplaced terminals; it does not relocate an
// already placed pane. Park first (keeps the program alive), then relabel.
export async function moveLiveTerminal(terminal, target, binaries = {}) {
  const call = async (program, args) => JSON.parse((await exec(binaries[program] ?? program, args, { timeout: 10000 })).stdout);
  const before = await call("herdr-core", ["get", terminal.address]);
  if (before.state !== "live" || before.created_ms !== terminal.created_ms) throw new Error("Terminal changed before adoption; nothing was moved.");
  if (before.labels?.["herdr.space"] === target) return before;
  const events = new EventEmitter();
  const stream = spawn(binaries["herdr-core"] ?? "herdr-core", ["events", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  stream.on("error", () => events.emit("change"));
  stream.stdout.on("data", () => events.emit("change"));
  const locations = async () => {
    const view = await call("herdr-app", ["ls"]);
    return view.spaces.flatMap((space) => space.tabs.flatMap((tab) => tab.terminals.filter((p) => p.terminal === terminal.address).map(() => space.id)));
  };
  async function waitForPlacement(space) {
    return new Promise((resolve, reject) => {
      let inspecting = false, changed = false, done = false;
      const finish = (error) => { if (done) return; done = true; clearTimeout(timeout); events.off("change", inspect); error ? reject(error) : resolve(); };
      const matches = (places) => space === null ? places.length === 0 : places.length === 1 && places[0] === space;
      const timeout = setTimeout(async () => {
        try { finish(matches(await locations()) ? null : new Error("Herdr did not acknowledge the pane move; terminal remains alive.")); }
        catch (error) { finish(error); }
      }, 6000);
      async function inspect() {
        if (done) return;
        if (inspecting) { changed = true; return; }
        inspecting = true;
        try { if (matches(await locations())) finish(); }
        catch (error) { finish(error); }
        finally { inspecting = false; }
        if (changed && !done) { changed = false; void inspect(); }
      }
      events.on("change", inspect);
      void inspect();
    });
  }
  try {
    await call("herdr-app", ["do", "terminal.park", JSON.stringify({ terminal: terminal.address })]);
    await waitForPlacement(null);
    await call("herdr-core", ["label", terminal.address, `herdr.space=${target}`, "herdr.tab="]);
    await waitForPlacement(target);
    const after = await call("herdr-core", ["get", terminal.address]);
    if (after.pid !== before.pid || after.created_ms !== before.created_ms) throw new Error("Terminal identity changed during adoption.");
    return after;
  } catch (error) {
    // Restore the old opt-in labels on failure, but never touch a recycled
    // terminal, rerun a command, or kill a program as rollback.
    const current = await call("herdr-core", ["get", terminal.address]).catch(() => null);
    if (current?.state === "live" && current.created_ms === before.created_ms) {
      await call("herdr-core", ["label", terminal.address, `herdr.space=${before.labels?.["herdr.space"] ?? ""}`, `herdr.tab=${before.labels?.["herdr.tab"] ?? ""}`]).catch(() => {});
      if (before.keep) await call("herdr-core", ["keep", terminal.address]).catch(() => {});
    }
    throw error;
  } finally { stream.kill("SIGTERM"); }
}
