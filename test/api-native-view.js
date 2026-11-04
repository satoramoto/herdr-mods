// Runs only in the uniquely named owned API QA window. No existing agent is a
// candidate recipient. All prompt generation is disabled by this test override.
import UnifiedChat from "./composer.js";
import { props, closeOverlay, writeTextFile } from "herdr";
import { fixtureTarget, capturedPart, resultPath } from "./fixture.js";
import { OpenCodePanel } from "./opencode-panel.js";

export default class ApiNativeSmoke extends UnifiedChat {
  current() { return fixtureTarget; }
  allTargets() { return [fixtureTarget]; }
  refreshMetadata() {}
  openControls(panel, query) { this.requestedCompletion = { panel, query }; }
  async control(target, input) {
    const value = await super.control(target, input.action === "submit" ? { ...input, resume: false } : input);
    if (input.action === "submit" && this.loseAcknowledgement) {
      this.loseAcknowledgement = false;
      throw new Error("Owned QA: deliberately lost acknowledgement after API admission");
    }
    return value;
  }
  init(initial, cx) {
    super.init(initial, cx);
    cx.spawn(async (cx) => {
      const wait = async (predicate, label) => {
        const deadline = Date.now() + 15000;
        while (!await predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await cx.sleep(50); }
      };
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const stage = async (text) => {
        this.model.edit(text); this.restoreEditor(); this.editor.focus(); await cx.sleep(60);
        window.dispatch_action("unified-chat-enqueue");
        await wait(() => this.model.text() === "", "native API send action");
      };
      let result;
      try {
        this.model.select(fixtureTarget.key);
        this.rich.attach(fixtureTarget.key, capturedPart);
        const completionBaseline = (await this.control(fixtureTarget, { action: "state" })).inbox;
        const directoryBaseline = (await this.control(fixtureTarget, { action: "snapshot" })).directory;
        const completionPanel = async (text) => {
          this.model.edit(text); this.restoreEditor(); this.editor.focus();
          await cx.sleep(60); window.dispatch_action("unified-chat-complete");
          await wait(() => this.requestedCompletion?.panel === "arguments", "native Tab argument action");
          this.requestedCompletion = null;
          const panel = new OpenCodePanel();
          panel.request = (input) => this.control(fixtureTarget, input);
          panel.publishCompletion = (edit, cx) => { this.applyCommandCompletion(edit, cx); this.panel = null; cx.notify(); };
          const report = JSON.parse(fixtureTarget.terminal.records["unified-chat"].msg);
          this.panel = panel;
          panel.init({ panel: "arguments", query: text, draftText: text, target: { ...fixtureTarget, bridge: report.bridge } }, cx);
          cx.notify();
          await wait(() => !panel.argumentPending && panel.argumentResult?.items.length, "live native completion results");
          return panel;
        };
        const directoryPanel = await completionPanel("/cd comp");
        directoryPanel.index = directoryPanel.options().findIndex((item) => item.label === "completion dir 🌱/");
        assert(directoryPanel.index >= 0, "live directory result missing in native panel");
        directoryPanel.search.focus(); await cx.sleep(60);
        window.dispatch_action("opencode-panel-choose");
        await wait(() => !this.panel, "native completion choice");
        assert(this.model.text() === "/cd completion dir 🌱/", "native directory choice did not edit exact literal path");
        assert(this.rich.get(fixtureTarget.key).parts.length === 1, "completion removed structured attachments");
        const argumentPanel = await completionPanel("/qa-arguments --keep=literal comp");
        argumentPanel.index = argumentPanel.options().findIndex((item) => item.label === "completion.txt");
        assert(argumentPanel.index >= 0, "live command file argument missing");
        argumentPanel.search.focus(); await cx.sleep(60); window.dispatch_action("opencode-panel-choose");
        await wait(() => !this.panel, "native argument choice");
        assert(this.model.text() === "/qa-arguments --keep=literal completion.txt", "argument completion changed other arguments");
        const stalePanel = await completionPanel("/cd comp");
        this.model.edit("/cd keep newer edits");
        stalePanel.index = 0; stalePanel.search.focus(); await cx.sleep(60); window.dispatch_action("opencode-panel-choose");
        await wait(() => Boolean(stalePanel.error), "stale draft completion rejection");
        assert(this.model.text() === "/cd keep newer edits", "stale completion overwrote edits");
        this.panel = null; cx.notify();
        // Continue typing an argument in the automatically opened slash picker,
        // without first selecting a menu row or issuing a second Tab action.
        this.model.edit("/"); this.restoreEditor();
        const typedPanel = new OpenCodePanel();
        const ownedReport = JSON.parse(fixtureTarget.terminal.records["unified-chat"].msg);
        typedPanel.request = (input) => this.control(fixtureTarget, input);
        typedPanel.publishCompletion = (edit, cx) => { this.applyCommandCompletion(edit, cx); this.panel = null; cx.notify(); };
        this.panel = typedPanel;
        typedPanel.init({ panel: "slash", query: "/", draftText: "/", target: { ...fixtureTarget, bridge: ownedReport.bridge } }, cx);
        cx.notify();
        await wait(() => Boolean(typedPanel.snapshot), "live slash command registry");
        typedPanel.search.set_value("/cd completion dir 🌱/ne");
        await wait(() => typedPanel.kind === "arguments" && !typedPanel.argumentPending && typedPanel.argumentResult?.items.length, "type-through directory completion");
        typedPanel.index = typedPanel.options().findIndex((item) => item.label === "completion dir 🌱/nested folder/");
        assert(typedPanel.index >= 0, "nested directory suggestion missing");
        typedPanel.search.focus(); await cx.sleep(60); window.dispatch_action("opencode-panel-choose");
        await wait(() => !this.panel, "type-through nested directory choice");
        assert(this.model.text() === "/cd completion dir 🌱/nested folder/", "typed nested directory was not completed");
        assert(JSON.stringify((await this.control(fixtureTarget, { action: "state" })).inbox) === JSON.stringify(completionBaseline), "choosing completion changed the native inbox");
        assert((await this.control(fixtureTarget, { action: "snapshot" })).directory === directoryBaseline, "directory completion executed /cd");
        const text = "Owned GPUI API Send: 日本語 🌱\nexact second line";
        await stage(text);
        await wait(() => !this.submissions.size, "native API durable admission");
        const state = await this.control(fixtureTarget, { action: "state" });
        const queued = state.inbox.find((item) => item.payload?.text === text);
        assert(Boolean(queued), "native Send did not admit exact Unicode/multiline text");
        assert(queued.payload.files?.length === 1, "native Send lost structured attachment");
        assert(this.rich.get(fixtureTarget.key).history.at(-1).parts.length === 1, "history lost structured parts");
        await this.control(fixtureTarget, { action: "inbox-cancel", id: queued.id });
        this.loseAcknowledgement = true;
        this.model.edit("Owned uncertain first"); this.restoreEditor(); this.enqueue(cx);
        // apiEnqueue synchronously captures a second draft before the first
        // callback can observe its intentionally lost acknowledgement.
        this.model.edit("Owned withheld second"); this.restoreEditor(); this.enqueue(cx);
        await wait(() => !this.apiChains.size, "uncertain-send barrier");
        const ledger = [...this.submissions.values()];
        assert(ledger.some((item) => item.state === "uncertain" && item.draft.text === "Owned uncertain first"), "uncertain draft not retained");
        assert(ledger.some((item) => item.state === "withheld" && item.draft.text === "Owned withheld second"), "later send did not remain withheld");
        const after = await this.control(fixtureTarget, { action: "state" });
        assert(after.inbox.filter((item) => item.type === "user").length === 1, "later send crossed uncertain FIFO barrier");
        for (const item of after.inbox.filter((item) => item.type === "user")) await this.control(fixtureTarget, { action: "inbox-cancel", id: item.id });
        result = { passed: true, nativeComposerApiSend: true, unicodeMultilineExact: true, structuredAttachment: true,
          structuredHistory: true, retainedUncertainDraft: true, laterSendWithheld: true, noAutomaticRetry: true,
          nativeTabArgumentCompletion: true, nativeDirectoryChoice: true, nativeArgumentChoice: true,
          completionPreservedAttachmentsAndFlags: true, staleCompletionRejected: true, completionDidNotExecute: true,
          slashTypeThroughCompletion: true };
      } catch (error) { result = { passed: false, error: String(error.message ?? error), ledger: [...this.submissions.values()] }; }
      await writeTextFile(resultPath, JSON.stringify(result, null, 2), null);
      if (props()?.overlay) closeOverlay(props().overlay);
    });
  }
}
