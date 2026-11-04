// Copied into an ephemeral QA mod by scripts/native-smoke.mjs. Its only target
// is the fixture we just created; no user agent can receive test input.
import UnifiedChat from "./composer.js";
import { terminals, props, closeOverlay, writeTextFile, readTextFile } from "herdr";
import { fixtureAddress, resultPath, logPath } from "./fixture.js";

export default class NativeSmoke extends UnifiedChat {
  init(initial, cx) {
    super.init(initial, cx);
    this.showQueue = true;
    cx.spawn(async (cx) => {
      const wait = async (check, name) => {
        const deadline = Date.now() + 15000;
        while (!await check()) {
          if (Date.now() > deadline) throw new Error(`Timed out: ${name}`);
          await cx.sleep(50);
        }
      };
      const events = async () => (await readTextFile(logPath) ?? "").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const count = async (type) => (await events()).filter((event) => event.type === type).length;
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const stage = async (text) => {
        this.model.select(this.current().key);
        this.model.edit(text); this.restoreEditor(); this.editor.focus();
        await cx.sleep(60);
        window.dispatch_action("unified-chat-enqueue");
        await wait(() => this.model.text() === "", "native Send action");
      };
      let result;
      try {
        await wait(() => this.current()?.status === "idle", "fixture ready");
        this.model.select(this.current().key);
        this.model.edit("first"); this.restoreEditor(); this.editor.focus();
        this.editor.set_selected_range({ start: 5, end: 5 });
        await cx.sleep(100);
        window.dispatch_action("unified-chat-newline");
        await wait(() => this.editor.value() === "first\n", "native newline action");
        assert(await count("message") === 0, "newline sent a message");
        await stage("--literal first line\nsecond line with 'quotes' and $(not executed)");
        await stage("second queued message");
        await wait(async () => await count("message") === 1, "first delivery");
        await wait(() => !this.outbox.pending.size, "first acknowledgement");
        assert(this.outbox.get(this.current().key).items.length === 1, "second item did not wait");
        await wait(() => this.current()?.status === "working", "working status reached the native view");
        const stopStarted = Date.now();
        window.dispatch_action("unified-chat-stop"); window.dispatch_action("unified-chat-stop");
        await wait(async () => await count("stop") === 2, "two independent stop presses");
        const stopMilliseconds = Date.now() - stopStarted;
        await wait(() => this.current()?.status === "idle", "fixture stopped");
        assert(stopMilliseconds < 2500, "second stop was held behind an observation timeout");
        assert(await count("message") === 1, "Stop accidentally restarted the queue");
        const key = this.current().key;
        assert(this.outbox.get(key).paused, "Stop did not pause the queue");
        this.outbox.resume(key); this.needsPump = true; this.save(); cx.notify();
        await wait(async () => await count("message") === 2, "second delivery after Resume");
        await wait(() => this.current()?.status === "blocked", "fixture permission state");
        await wait(() => !this.outbox.pending.size, "second acknowledgement");
        await stage("must wait for permission");
        await cx.sleep(600);
        assert(await count("message") === 2, "blocked prompt received queued input");
        const received = (await events()).filter((event) => event.type === "message").map((event) => event.text);
        assert(received[0] === "--literal first line\nsecond line with 'quotes' and $(not executed)", "multiline text was modified");
        assert(received[1] === "second queued message", "queue order changed");
        result = { passed: true, nativeSendAction: true, nativeNewlineAction: true, multilineExact: true, fifo: true, stopPresses: 2, stopMilliseconds, stoppedQueueStayedPaused: true, blockedPromptProtected: true };
      } catch (error) { result = { passed: false, error: String(error.message ?? error), status: this.current()?.status, queues: this.outbox.snapshot(), events: await events() }; }
      await writeTextFile(resultPath, JSON.stringify(result, null, 2), null);
      if (props()?.overlay) closeOverlay(props().overlay);
    });
  }

  current() {
    const terminal = terminals().find((item) => item.address === fixtureAddress && item.state === "live");
    if (!terminal) return null;
    return {
      address: fixtureAddress, key: `${fixtureAddress}@${terminal.created_ms}`, terminal,
      turn: terminal.turn, status: typeof terminal.status === "string" ? terminal.status : terminal.status?.state,
      label: "QA fixture", space_name: "Isolated test",
    };
  }
  allTargets() { const target = this.current(); return target ? [target] : []; }
  refreshMetadata() {}
}
