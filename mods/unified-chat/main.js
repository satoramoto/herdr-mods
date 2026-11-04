import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, Textarea, TextareaState, Popup, Progress, ProgressTrack, ProgressIndicator } from "gpui-base";
import { agents, spaces, terminals, focused, theme, props, run, hc, exec, appHome, nextCommand, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { Composer, targetsFrom, targetFromFocus, decodeResult } from "./model.js";
import { Outbox, messageBlock } from "./queue.js";
import { metadataText, reportedMetadata } from "./metadata.js";
import { COMPOSER_HEIGHT, EXPANDED_HEIGHT, QUEUE_HEIGHT } from "./layout.js";
import { bridgeFor, promptLabels } from "./prompt.js";
import { OpenCodePanel } from "./opencode-panel.js";
import { RichDrafts } from "./drafts.js";
import { AttentionPanel } from "./attention-panel.js";
import { requestControl } from "./ui-control.js";
import { admitInOrder, restoreSubmissions } from "./admission.js";
import { mentionTrigger, removeMentionMarker, slashHead, applyArgumentEdit } from "./completion.js";

const STORAGE = "unified-chat.state.v2";
const STATUS = { idle: "Ready", done: "Ready", working: "Working", blocked: "Needs you" };
const INPUT_CONTEXT = "UnifiedChatComposer > Input";

export default class UnifiedChat extends View {
  init(initial, cx) {
    if (initial?.panel) {
      this.panel = initial.panel === "attention" ? new AttentionPanel() : new OpenCodePanel(); this.panel.init(initial, cx); return;
    }
    this.picker = Boolean(initial?.picker);
    this.handle = cx.focus_handle();
    this.recipientHandle = cx.focus_handle();
    if (this.picker) return;
    let saved = {};
    try {
      const value = localStorage.getItem(STORAGE);
      saved = value ? JSON.parse(value) : { drafts: JSON.parse(localStorage.getItem("unified-chat.drafts.v1") ?? "{}") };
    } catch { this.storageError = "Saved state couldn't be read. Check the terminal before rebuilding your queue."; }
    this.model = new Composer(saved?.drafts && typeof saved.drafts === "object" ? saved.drafts : {});
    this.outbox = new Outbox(saved?.queues && typeof saved.queues === "object" ? saved.queues : {});
    this.rich = new RichDrafts(saved?.rich ?? {});
    this.submissions = restoreSubmissions(saved?.submissions);
    this.apiChains = new Map();
    this.metadata = new Map();
    this.metadataPending = new Set();
    this.metadataChecked = new Map();
    this.controls = new Map();
    this.controlsPending = new Set();
    this.controlsChecked = new Map();
    this.stopPending = new Map();
    this.stopSequence = 0;
    cx.bind_keys([
      { keystroke: "enter", action: "unified-chat-enqueue", context: INPUT_CONTEXT },
      { keystroke: "secondary-enter", action: "unified-chat-newline", context: INPUT_CONTEXT },
      { keystroke: "cmd-enter", action: "unified-chat-newline", context: INPUT_CONTEXT },
      { keystroke: "escape", action: "unified-chat-stop", context: INPUT_CONTEXT },
      { keystroke: "escape", action: "unified-chat-stop", context: "UnifiedChatComposer" },
      { keystroke: "ctrl-p", action: "unified-chat-commands", context: INPUT_CONTEXT },
      { keystroke: "ctrl-shift-up", action: "unified-chat-history-previous", context: INPUT_CONTEXT },
      { keystroke: "ctrl-shift-down", action: "unified-chat-history-next", context: INPUT_CONTEXT },
      { keystroke: "alt-return", action: "unified-chat-steer", context: INPUT_CONTEXT },
      { keystroke: "tab", action: "unified-chat-complete", context: INPUT_CONTEXT },
      { keystroke: "escape", action: "unified-chat-close-panel", context: "UnifiedChatAttachedPanel" },
      { keystroke: "escape", action: "unified-chat-close-panel", context: "UnifiedChatAttachedPanel > Input" },
    ]);
    this.editor = TextareaState.new({ placeholder: "Write a message…", rows: 2 });
    this.editor.set_soft_wrap(true);
    this.editor.on("change", (_event, cx) => {
      if (this.restoring) return;
      const mention = mentionTrigger(this.model.text(), this.editor.value());
      const key = this.model.selected;
      if (key && this.editor.value() === "!" && !this.model.text() && this.rich.get(key).mode !== "shell") {
        this.rich.get(key).mode = "shell"; this.model.edit(""); this.restoreEditor();
      } else this.model.edit(this.editor.value());
      this.saveOrWarn();
      if (this.model.text() === "/" && bridgeFor(this.current())) this.openControls("slash", "/");
      if (mention && bridgeFor(this.current())) this.openControls("mentions", "", mention);
      cx.notify();
    });
    this.editor.on("focus", (_event, cx) => { this.editing = true; cx.notify(); });
    this.editor.on("blur", (_event, cx) => { this.editing = false; cx.notify(); });
    this.editor.on("paste_other", (_event, cx) => {
      this.captureAttachments(null, cx);
    });
    // Only inspect live app data after a render marked it changed. This timer
    // drives our dispatch work, not polling/redrawing terminals or agent lists.
    cx.timer.every(250, (cx) => {
      if (this.pendingPanel) {
        const initial = this.pendingPanel; this.pendingPanel = null;
        if (initial.target.key === this.current()?.key) {
          const panel = initial.panel === "attention" ? new AttentionPanel() : new OpenCodePanel();
          panel.dismiss = () => { this.attachedPanel = null; this.editor.focus(); this.needsPanelNotify = true; };
          this.attachedPanel = panel; panel.init(initial, cx); cx.notify();
        }
      }
      if (this.needsPanelNotify) { this.needsPanelNotify = false; cx.notify(); }
      if (this.needsPump) this.pump(cx);
      if (this.needsMetadata) { this.needsMetadata = false; this.refreshMetadata(cx); this.refreshControls(cx); }
      if (this.needsResize) { this.needsResize = false; this.resizeComposer(); }
      const target = this.current();
      if (this.needsControls && target && !this.controlsPending.has(target.key) && Date.now() - (this.controlsChecked.get(target.key) ?? 0) >= 500) {
        this.needsControls = false; this.refreshControls(cx);
      }
    });
    cx.timer.every(10000, (cx) => {
      const target = this.current();
      if (target && reportedMetadata(target.terminal)?.revision !== this.controls.get(target.key)?.revision) this.controlsChecked.delete(target.key);
      if (target?.terminal.records?.["unified-chat"] && !reportedMetadata(target.terminal)) cx.notify();
      this.refreshMetadata(cx);
      this.refreshControls(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.editor.focus();
        else if (command === "send") this.enqueue(cx);
        else if (command === "stop") this.stop(cx);
        else if (command === "terminal") this.focusTerminal();
        else if (command.startsWith("complete:")) {
          try { this.applyCommandCompletion(JSON.parse(decodeURIComponent(command.slice(9))), cx); }
          catch (error) { this.error = String(error.message ?? error); }
        }
        else if (command.startsWith("tool:")) {
          try {
            const edit = JSON.parse(decodeURIComponent(command.slice(5)));
            if (edit.key !== this.current()?.key || edit.key !== this.model.selected) throw new Error("Recipient changed. Tool was not applied.");
            if (edit.tool === "clipboard") this.captureAttachments(null, cx);
            else if (edit.tool === "queue") this.toggleQueue(cx);
            else if (edit.tool === "workspace-commands") run("app.palette");
            else if (edit.tool === "shell") { const entry = this.rich.get(edit.key); entry.mode = entry.mode === "shell" ? "normal" : "shell"; this.saveOrWarn(); this.editor.focus(); }
            else if (edit.tool === "sessions") openOverlay({ mod: "sessions", kind: "window", key: "all-sessions", width: 0.8, height: 0.8, props: { role: "all" } });
            else if (["history", "attachments", "activity", "attention", "mentions", "queue", "models", "agents", "variants"].includes(edit.tool)) this.openControls(edit.tool);
          } catch (error) { this.error = String(error.message ?? error); }
        }
        else if (command.startsWith("queued-edit:")) {
          try {
            const edit = JSON.parse(decodeURIComponent(command.slice(12)));
            const target = this.current(), value = shared(edit.token);
            if (edit.key !== target?.key || edit.key !== this.model.selected || value?.id !== edit.id) throw new Error("Recipient changed; queued input was not cancelled.");
            const draft = value.draft;
            // Persist full captured bytes + text before cancelling. On timeout,
            // the copy stays in Stashes and is never automatically resubmitted.
            this.rich.get(edit.key).stashes.push(draft); this.save(); setShared(edit.token, null);
            cx.spawn(async (cx) => {
              try {
                await this.control(target, { action: "inbox-cancel", id: edit.id });
                if (this.current()?.key !== target.key) throw new Error("Recipient changed. Cancelled draft is retained in its session's Stashes.");
                const current = this.rich.capture(edit.key, this.model.text());
                if (current.text || current.parts.length) this.rich.stash(edit.key, current);
                this.model.edit(this.rich.restore(edit.key, draft)); this.restoreEditor(); this.editor.focus();
                this.error = null;
              } catch (error) { this.error = `${String(error.message ?? error)} A full copy is retained in History / stash. Check the inbox before resending.`; }
              this.saveOrWarn(); this.needsResize = true; this.needsMetadata = true; cx.notify();
            });
          } catch (error) { this.error = String(error.message ?? error); }
        }
        else if (command.startsWith("selection:")) {
          try {
            const edit = JSON.parse(decodeURIComponent(command.slice(10)));
            if (edit.key !== this.current()?.key || edit.key !== this.model.selected) throw new Error("Recipient changed; selection was not applied.");
            const entry = this.rich.get(edit.key);
            entry.selection = { ...(entry.selection ?? {}), ...edit.selection };
            this.saveOrWarn();
          } catch (error) { this.error = String(error.message ?? error); }
        }
        else if (command.startsWith("draft:")) {
          try {
            const edit = JSON.parse(decodeURIComponent(command.slice(6)));
            const key = this.model.selected;
            if (edit.key !== key || key !== this.current()?.key) throw new Error("Recipient changed. Saved draft was not moved.");
            if (edit.action === "stash") {
              this.rich.stash(key, this.rich.capture(key, this.model.text())); this.model.edit("");
            } else {
              const entry = this.rich.get(key);
              const item = edit.source === "submission" ? this.submissions.get(edit.id) : edit.source === "legacy" ? this.outbox.get(key).items.find((item) => item.id === edit.id) : null;
              if (item && ["sending", "waiting"].includes(item.state)) throw new Error("Wait for the active admission before recovering this draft.");
              const draft = edit.source === "history" ? entry.history[edit.index] : edit.source === "stash" ? entry.stashes[edit.index] : item?.draft ?? (item ? { text: item.text, parts: [], mode: "normal" } : null);
              if (!draft) throw new Error("That saved draft is no longer available.");
              if (edit.action === "discard") {
                if (edit.source === "submission") this.submissions.delete(edit.id);
                else if (edit.source === "legacy") this.outbox.remove(key, edit.id);
              } else {
                const current = this.rich.capture(key, this.model.text());
                if (current.text || current.parts.length) this.rich.stash(key, current);
                this.model.edit(this.rich.restore(key, draft));
                if (edit.source === "stash") entry.stashes.splice(edit.index, 1);
                // Keep uncertain originals as a barrier until receipt/manual
                // review. Definitely-unsent drafts can safely leave the ledger.
                if (item?.state === "withheld" && edit.source === "submission") this.submissions.delete(edit.id);
              }
            }
            this.restoreEditor(); this.saveOrWarn(); this.needsResize = true; this.editor.focus();
          } catch (error) { this.error = String(error.message ?? error); }
        }
        else if (command.startsWith("attach:")) {
          try {
            const edit = JSON.parse(decodeURIComponent(command.slice(7)));
            if (edit.key !== this.current()?.key || edit.key !== this.model.selected) throw new Error("Recipient changed; attachment was not inserted.");
            this.rich.attach(edit.key, edit.part);
            this.model.edit(removeMentionMarker(this.model.text(), edit.anchor));
            this.restoreEditor(); this.saveOrWarn(); this.needsResize = true; this.editor.focus();
          } catch (error) { this.error = String(error.message ?? error); }
        }
        else if (command.startsWith("receipt:")) {
          const data = JSON.parse(decodeURIComponent(command.slice(8)));
          const item = this.submissions.get(data.id);
          if (item?.key === data.key && data.found) { this.rich.record(item.key, item.draft); this.submissions.delete(data.id); this.saveOrWarn(); }
        }
        else if (command.startsWith("insert:")) {
          try {
            const edit = JSON.parse(decodeURIComponent(command.slice(7)));
            if (edit.key !== this.current()?.key || edit.key !== this.model.selected) throw new Error("Recipient changed; command was not inserted.");
            if (this.model.text().trim() && !/^\/\S*$/.test(this.model.text().trim())) throw new Error("Draft kept. Clear it before inserting a command.");
            this.model.edit(edit.text); this.restoreEditor();
            if (edit.focus !== false) this.editor.focus();
            this.saveOrWarn();
            if (edit.complete) this.openControls("arguments", edit.text);
          } catch (error) { this.error = String(error.message ?? error); }
        }
        cx.notify();
      }
    });
  }

  allTargets() { return targetsFrom(agents(), terminals()); }
  current() { return targetFromFocus(this.allTargets(), focused(), props()?.terminal); }

  restoreEditor() {
    this.restoring = true;
    this.editor.set_value(this.model.text());
    this.restoring = false;
  }

  completeCommand(cx) {
    const target = this.current(), text = this.model.text();
    if (!bridgeFor(target) || this.rich.get(target.key).mode === "shell" || !/^\s*\//.test(text)) { cx.propagate(); return; }
    cx.stop_propagation();
    this.openControls(slashHead(text) ? "arguments" : "slash", text);
  }

  applyCommandCompletion(edit, cx) {
    if (edit.key !== this.current()?.key || edit.key !== this.model.selected) throw new Error("Recipient changed; command completion was not applied.");
    const text = this.model.text();
    this.model.edit(applyArgumentEdit(text, { expected: edit.expected, start: 0, end: text.length, value: edit.value }));
    this.restoreEditor(); this.saveOrWarn(); this.editor.focus(); cx.notify();
  }

  sync() {
    const target = this.current();
    const key = target?.key ?? null;
    if (key !== this.model.selected) {
      this.attachedPanel = null; this.pendingPanel = null;
      this.attachedPicker = false;
      this.model.select(key);
      this.restoreEditor();
      this.error = null;
      this.needsMetadata = true;
      this.needsResize = true;
    }
    return target;
  }

  save() {
    localStorage.setItem(STORAGE, JSON.stringify({ drafts: this.model.snapshot(), queues: this.outbox.snapshot(), rich: this.rich.snapshot(), submissions: Object.fromEntries(this.submissions) }));
    this.storageError = null;
  }
  saveOrWarn() {
    try { this.save(); }
    catch { this.storageError = "Local saving failed. Draft stays in memory; queue dispatch is paused."; }
  }

  enqueue(cx, delivery = "queue") {
    const target = this.current();
    const text = this.model.text();
    if (bridgeFor(target)?.features?.includes("structured-prompts")) { this.apiEnqueue(cx, target, delivery); return; }
    try {
      if (target?.key !== this.model.selected) throw new Error("Recipient changed. Review the draft before sending.");
      if (/^ses_/.test(target?.sessionID ?? "")) throw new Error("OpenCode API bridge is disconnected. Draft kept; use Terminal ↗ rather than relaying into an occupied native draft.");
      if (this.rich.get(target.key).parts.length) throw new Error("Structured attachments require the connected OpenCode API. Nothing was sent through the terminal.");
      const item = this.outbox.enqueue(target, text);
      this.model.edit("");
      try { this.save(); }
      catch (error) {
        this.outbox.remove(target.key, item.id);
        this.model.edit(text);
        throw new Error("Queue couldn't be saved. Your draft is kept; nothing was submitted.");
      }
      this.restoreEditor();
      this.error = null;
      this.needsPump = true;
    } catch (error) { this.error = String(error.message ?? error); }
    cx.notify();
  }

  apiEnqueue(cx, target, delivery) {
    const draft = this.rich.capture(target.key, this.model.text());
    if (this.storageError) { this.error = this.storageError; cx.notify(); return; }
    if ([...this.submissions.values()].some((item) => item.key === target.key && ["uncertain", "withheld"].includes(item.state)) || this.outbox.get(target.key).items.length) {
      this.error = "Resolve retained/legacy drafts in Queue before sending more. Your current draft is kept."; cx.notify(); return;
    }
    if (!draft.text.trim() && !draft.parts.length) {
      cx.spawn(async (cx) => {
        try {
          const state = await this.control(target, { action: "state" });
          const next = state.inbox.find((item) => item.type === "user");
          if (!next) throw new Error("Write a message or attach a file first.");
          await this.control(target, { action: "inbox-delivery", id: next.id, delivery: "steer" });
          this.error = null; this.controlsChecked.delete(target.key); this.needsMetadata = true;
        } catch (error) { this.error = String(error.message ?? error); }
        cx.notify();
      });
      return;
    }
    if (this.model.selected !== target.key) { this.error = "Recipient changed; review the draft."; cx.notify(); return; }
    const id = `msg_uc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const item = { id, key: target.key, state: "waiting", draft, delivery };
    this.submissions.set(id, item);
    this.model.edit(""); this.rich.get(target.key).parts = [];
    if (draft.mode === "shell") this.rich.get(target.key).mode = "normal";
    try { this.save(); }
    catch { this.submissions.delete(id); this.model.edit(this.rich.restore(target.key, draft)); this.error = "Draft could not be saved. Nothing was submitted."; this.restoreEditor(); cx.notify(); return; }
    this.restoreEditor(); this.needsResize = true;
    const previous = this.apiChains.get(target.key) ?? Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    this.apiChains.set(target.key, next);
    cx.spawn(async (cx) => {
      try {
        const result = await admitInOrder({ items: this.submissions, item, previous, send: () => {
          this.save();
          return this.control(target, { action: "submit", id, ...draft, delivery });
        } });
        if (!result) { this.error = item.error; return; }
        if (result.accepted !== true || result.sessionID !== target.sessionID) throw new Error("No durable acknowledgement.");
        this.rich.record(target.key, draft); this.submissions.delete(id);
        if (result.native && this.current()?.key === target.key) run("agent.focus", { terminal: target.address });
        this.error = null;
      } catch (error) {
        item.state = "uncertain"; item.error = String(error.message ?? error);
        this.error = "Submission not confirmed. Its draft is retained in Queue → Check receipt; do not blindly resend.";
      } finally {
        release();
        if (this.apiChains.get(target.key) === next) this.apiChains.delete(target.key);
        this.saveOrWarn(); this.controlsChecked.delete(target.key); this.needsMetadata = true; cx.notify();
      }
    });
    cx.notify();
  }

  captureAttachments(paths, cx) {
    const target = this.current();
    if (!bridgeFor(target)?.features?.includes("structured-prompts")) { this.error = "File/image attachments require the OpenCode API bridge."; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const result = await exec("node", [`${appHome()}/mods/unified-chat/opencode-control.mjs`, paths ? "--capture" : "--clipboard", appHome(), ...(paths ? [JSON.stringify(paths)] : [])]);
        if (result.code !== 0) throw new Error(result.stderr?.trim() || "Attachment capture failed.");
        const value = JSON.parse(result.stdout);
        if (this.current()?.key !== target.key) throw new Error("Recipient changed; captured files were not attached to another session.");
        for (const part of value.parts) this.rich.attach(target.key, part);
        this.error = null; this.saveOrWarn(); this.needsResize = true;
      } catch (error) { this.error = String(error.message ?? error); }
      cx.notify();
    });
  }

  history(direction, cx) {
    const key = this.model.selected;
    if (!key) return;
    const draft = this.rich.history(key, direction, this.rich.capture(key, this.model.text()));
    this.model.edit(this.rich.restore(key, draft)); this.restoreEditor(); this.saveOrWarn(); this.needsResize = true; cx.notify();
  }

  resizeComposer() {
    try { run("layout.resize", { id: "unified-chat-bar", px: this.composerHeight ?? COMPOSER_HEIGHT }); } catch {}
  }

  pump(cx) {
    this.needsPump = false;
    const actions = this.outbox.dispatch(this.allTargets().filter((target) => !/^ses_/.test(target.sessionID ?? "")));
    if (!actions.length) return;
    try { this.save(); }
    catch {
      for (const action of actions) this.outbox.fail(action, new Error("Queue couldn't be saved; nothing submitted."), true);
      this.saveOrWarn();
      cx.notify();
      return;
    }
    for (const action of actions) cx.spawn(async (cx) => {
      try {
        // Do not deliver to a different OpenCode session selected inside the
        // same terminal since the action was scheduled.
        if (!this.allTargets().some((target) => target.key === action.key)) {
          this.outbox.fail(action, new Error("Recipient is no longer displayed in its terminal."), true);
        } else this.outbox.complete(action, await hc(action.args));
      } catch (error) { this.outbox.fail(action, error); }
      this.saveOrWarn();
      this.needsPump = true;
      cx.notify();
    });
    cx.notify();
  }

  stop(cx) {
    const target = this.current();
    if (!target || target.key !== this.model.selected) return;
    if (this.rich.get(target.key).mode === "shell") { this.rich.get(target.key).mode = "normal"; this.saveOrWarn(); cx.notify(); return; }
    // Stop pauses our queue before touching the harness, so an idle report
    // cannot immediately launch the next queued message.
    this.outbox.pause(target.key, "Stopped by you. Resume when you're ready.");
    for (const item of this.submissions.values()) if (item.key === target.key && item.state === "waiting") item.state = "withheld";
    this.saveOrWarn();
    if (target.status !== "working" && !this.stopPending.has(target.key)) { cx.notify(); return; }
    const sequence = ++this.stopSequence;
    this.stopPending.set(target.key, sequence);
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        // No observation timeout: return immediately so a second click/Escape
        // can send the second stop key. Never debounce or auto-double it.
        if (bridgeFor(target)?.features?.includes("structured-prompts")) await this.control(target, { action: "interrupt" });
        else decodeResult(await hc(["interrupt", "--json", "--timeout", "0", "--", target.address]));
      } catch (error) {
        if (this.stopPending.get(target.key) === sequence && this.model.selected === target.key) this.error = String(error.message ?? error);
      } finally {
        if (this.stopPending.get(target.key) === sequence) this.stopPending.delete(target.key);
        cx.notify();
      }
    });
    cx.notify();
  }

  refreshMetadata(cx) {
    const target = this.current();
    if (!target?.sessionID || reportedMetadata(target.terminal) || target.address.includes("/") || this.metadataPending.has(target.key)) return;
    const argv = target.terminal.foreground?.argv ?? target.terminal.argv ?? [];
    // Discovery of the default shared service would be wrong for a private or
    // explicitly selected service. Require a dedicated adapter for those.
    if (argv.some((arg) => arg === "--standalone" || arg.startsWith("--server"))) return;
    if (Date.now() - (this.metadataChecked.get(target.key) ?? 0) < 5000) return;
    this.metadataChecked.set(target.key, Date.now());
    this.metadataPending.add(target.key);
    cx.spawn(async (cx) => {
      try {
        const result = await exec("node", [`${appHome()}/mods/unified-chat/opencode-bridge.mjs`, target.sessionID]);
        if (result.code !== 0) throw new Error("OpenCode metadata is unavailable.");
        const metadata = JSON.parse(result.stdout);
        if (metadata.sessionID !== target.sessionID) throw new Error("Session identity mismatch.");
        this.metadata.set(target.key, metadata);
      } catch {
        // Never keep a plausible-but-stale model/mode after a failed refresh.
        this.metadata.delete(target.key);
      } finally {
        this.metadataPending.delete(target.key);
        cx.notify();
      }
    });
  }

  focusTerminal() {
    const target = this.current();
    if (target) run("agent.focus", { terminal: target.address });
  }
  openControls(panel = "commands", query = "", anchor = null) {
    const target = this.current();
    const bridge = bridgeFor(target);
    if (!target || (!bridge && !["history", "queue", "attachments", "tools"].includes(panel))) { this.error = "Live OpenCode controls are not connected. Use Terminal ↗; the native prompt remains available."; return; }
    this.attachedPicker = false;
    this.pendingPanel = { panel, query, anchor, draftText: this.model.text(), submissions: [...this.submissions.values()].filter((item) => item.key === target.key),
        legacy: this.outbox.get(target.key).items, rich: this.rich.get(target.key),
        target: { address: target.address, sessionID: target.sessionID, key: target.key, bridge } };
  }

  async control(target, input) {
    if (this.current()?.key !== target.key) throw new Error("Recipient changed. Nothing was applied.");
    const bridge = bridgeFor(this.current());
    if (!bridge) throw new Error("Live OpenCode controls disconnected. Use Terminal ↗.");
    return requestControl({ ...target, bridge }, input);
  }

  nativeCommand(id, cx) {
    const target = this.current();
    if (!target) return;
    cx.spawn(async (cx) => {
      try {
        run("agent.focus", { terminal: target.address });
        await this.control(target, { action: "command", id });
      } catch (error) { this.error = String(error.message ?? error); }
      cx.notify();
    });
  }

  refreshControls(cx) {
    const target = this.current();
    if (!bridgeFor(target) || this.controlsPending.has(target.key) || Date.now() - (this.controlsChecked.get(target.key) ?? 0) < 500) return;
    this.controlsChecked.set(target.key, Date.now());
    this.controlsPending.add(target.key);
    cx.spawn(async (cx) => {
      try {
        const value = await this.control(target, { action: "snapshot" });
        if (value.sessionID !== target.sessionID) throw new Error("Session identity mismatch.");
        this.controls.set(target.key, { ...value, revision: reportedMetadata(target.terminal)?.revision });
        if (bridgeFor(target)?.features?.includes("native-inbox")) this.nativeState = { key: target.key, ...await this.control(target, { action: "state" }) };
      } catch { this.controls.delete(target.key); }
      finally { this.controlsPending.delete(target.key); cx.notify(); }
    });
  }
  choose() {
    this.attachedPanel = null; this.pendingPanel = null; this.attachedPicker = true;
    this.recipientHandle.focus();
  }

  dismissControls(cx) {
    this.attachedPanel = null; this.pendingPanel = null; this.attachedPicker = false;
    this.editor.focus(); cx.notify();
  }

  toggleQueue(cx) {
    if (/^ses_/.test(this.current()?.sessionID ?? "") || [...this.submissions.values()].some((item) => item.key === this.current()?.key)) { this.openControls("queue"); return; }
    this.showQueue = !this.showQueue;
    this.resizeComposer();
    cx.notify();
  }

  button(t, id, label, action, { disabled = false, title = label } = {}) {
    return Button.new(id).disabled(disabled).flex_none().h(24).px(4).rounded(4).flex().items_center().justify_center()
      .text_size(12).text_color(disabled ? t.dim : t.muted)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .tooltip(title).on_click((event, cx) => {
        cx.stop_propagation();
        if (!disabled) action(event, cx);
      }).child(label);
  }

  renderPicker(t) {
    const targets = this.allTargets();
    return v_flex().w_full().max_h(360).p(6).gap(3).bg(t.popover).text_color(t.foreground)
      .child(div().px(8).py(6).text_size(11).text_color(t.muted).child("Write to an agent"))
      .child(v_flex().id("target-list").min_h(0).overflow_y_scrollbar().gap(2)
        .children(targets.map((target) => Button.new(`choose-${target.key}`).w_full().px(10).py(9).gap(8).rounded(7)
          .flex().items_center().cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_event, cx) => {
             run("agent.focus", { terminal: target.address });
            if (this.attachedPicker) this.dismissControls(cx);
            else if (props()?.overlay) closeOverlay(props().overlay);
            run("unified-chat.focus");
          })
          .child(div().size(6).flex_none().rounded(3).bg(t[target.status] ?? t.dim))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_size(12.5).font_medium().truncate().child(target.label))
            .child(div().text_size(11).text_color(t.muted).truncate().child(`${target.space_name} · ${target.address}`)))
          .child(div().text_size(11).text_color(t.muted).child(STATUS[target.status] ?? "Unknown"))))
        .when(!targets.length, (el) => el.child(div().p(10).text_size(12).text_color(t.muted).child("No status-reporting agents are available."))));
  }

  renderQueue(t, target, queue) {
    return v_flex().flex_none().h(QUEUE_HEIGHT).gap(4).min_w(0)
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(queue.paused ? t.blocked : t.muted)
          .tooltip(queue.reason ?? "FIFO; sends only when the agent is ready")
          .child(queue.reason ?? "FIFO · waits for the agent to finish"))
        .child(this.button(t, "queue-pause", queue.paused ? "Resume" : "Pause", (_event, cx) => {
          try {
            queue.paused ? this.outbox.resume(target.key) : this.outbox.pause(target.key);
            this.save(); this.error = null; this.needsPump = true;
          } catch (error) { this.error = String(error.message ?? error); }
          cx.notify();
        }, { disabled: !target })))
      .child(v_flex().id("queue-items").flex_1().min_h(0).overflow_y_scrollbar().gap(3)
        .children(queue.items.map((item, index) => h_flex().id(`queued-${item.id}`).flex_none().min_w(0).gap(7).items_center()
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${index + 1}`))
          .child(div().flex_1().min_w(0).text_size(12).truncate().tooltip(item.text).child(item.text.replace(/\n/g, " ↵ ")))
          .child(div().flex_none().text_size(10).text_color(item.state === "uncertain" ? t.blocked : t.dim).child(item.state))
          .child(this.button(t, `remove-${item.id}`, "×", (_event, cx) => {
            this.outbox.remove(target.key, item.id); this.saveOrWarn(); cx.notify();
          }, { disabled: item.state === "sending", title: "Remove from queue; uncertain deliveries may already have reached the agent" }))))
        .when(!queue.items.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("No queued messages."))));
  }

  render() {
    const t = theme();
    if (this.panel) return this.panel.render(t);
    if (this.picker) return this.renderPicker(t);
    const target = this.sync();
    this.needsPump = true;
    const queue = target ? this.outbox.get(target.key) : { items: [], paused: false };
    const parts = target ? this.rich.get(target.key).parts : [];
    const blocked = messageBlock(target, this.model.text() || (parts.length ? "[attachments]" : ""));
    const metadata = target ? reportedMetadata(target.terminal) ?? this.metadata.get(target.key) : null;
    if (bridgeFor(target) && metadata?.revision !== this.controls.get(target.key)?.revision) this.needsControls = true;
    const connected = Boolean(bridgeFor(target));
    const compact = (this.width ?? 800) < 640;
    const wide = (this.width ?? 800) >= 1000;
    const space = spaces().find((item) => item.active);
    const workspaceAgents = agents();
    const needsAttention = workspaceAgents.filter((item) => item.status === "blocked").length;
    const workspace = [space?.machine ?? "This computer", space?.branch].filter(Boolean).join(" · ");
    const workspaceStatus = `${workspaceAgents.length} agents${needsAttention ? ` · ${needsAttention} needs you` : ""}`;
    const controls = connected ? this.controls.get(target.key) : null;
    const labels = promptLabels(metadata, controls);
    const rich = target ? this.rich.get(target.key) : {};
    if (rich.selection?.agent) labels.mode = `${rich.selection.agent} *`;
    if (rich.selection?.model) { labels.model = `${rich.selection.modelName ?? rich.selection.model.id} *`; labels.provider = rich.selection.model.providerID; labels.variant = rich.selection.model.variant ?? "default"; }
    if (rich.mode === "shell") labels.mode = "Shell (!)";
    const details = metadataText(metadata);
    const help = "Return queues · Cmd/Ctrl+Return or Shift+Return inserts a newline · Escape stops (repeatable)";
    const hint = this.error ?? this.storageError ?? (queue.paused ? queue.reason : null);
    const state = this.nativeState?.key === target?.key ? this.nativeState : null;
    const requests = (state?.permissions?.length ?? 0) + (state?.forms?.length ?? 0);
    const queued = (state?.inbox?.filter((item) => item.type === "user").length ?? 0) + queue.items.length + [...this.submissions.values()].filter((item) => item.key === target?.key).length;
    const stopping = target && (target.status === "working" || this.stopPending.has(target.key));
    const height = (this.showQueue ? EXPANDED_HEIGHT : COMPOSER_HEIGHT) + (parts.length ? 33 : 0) + (hint ? 26 : 0);
    if (height !== this.composerHeight) { this.composerHeight = height; this.needsResize = true; }
    const infoTitle = metadata
      ? `${details}\nContext is input + cache + output from the last reported request, not a live count. Sample: ${metadata.sampledAt ? new Date(metadata.sampledAt).toLocaleTimeString() : "not reported"}. Input limit: ${metadata.inputLimit ?? "not reported"}.\n${help}`
      : `Not exposed by this harness, or no verified adapter is connected. OpenCode shared-service sessions report metadata through its local API.\n${help}`;
    const composer = v_flex().id("unified-chat").track_focus(this.handle).key_context("UnifiedChatComposer")
      .on_size_change((size, cx) => {
        const previous = this.width ?? 800; this.width = size.width;
        if ((previous < 640) !== (this.width < 640) || (previous < 1000) !== (this.width < 1000)) cx.notify();
      })
      .on_action("unified-chat-enqueue", (_event, cx) => { cx.stop_propagation(); this.enqueue(cx); })
      .on_action("unified-chat-newline", (_event, cx) => { cx.stop_propagation(); this.editor.replace("\n"); })
      .on_action("unified-chat-stop", (_event, cx) => { cx.stop_propagation(); this.stop(cx); })
      .on_action("unified-chat-commands", (_event, cx) => { cx.stop_propagation(); this.openControls(); cx.notify(); })
      .on_action("unified-chat-complete", (_event, cx) => this.completeCommand(cx))
      .on_action("unified-chat-history-previous", (_event, cx) => { cx.stop_propagation(); this.history(-1, cx); })
      .on_action("unified-chat-history-next", (_event, cx) => { cx.stop_propagation(); this.history(1, cx); })
      .on_action("unified-chat-steer", (_event, cx) => { cx.stop_propagation(); this.enqueue(cx, "steer"); })
      .on_drop((event, cx) => this.captureAttachments(event.paths, cx))
      .size_full().min_w(0).min_h(0).overflow_hidden().bg(t.canvas).px(10).pt(4).pb(6).gap(4)
       .text_size(13).text_color(t.foreground)
       .when(this.showQueue, (el) => el.child(this.renderQueue(t, target, queue)))
       .child(v_flex().flex_1().min_h(0).min_w(0).overflow_hidden().rounded(8).border_1()
         .border_color(this.editing ? t.accent : t.input).bg(t.background).px(12).py(10).gap(6)
        .when(parts.length > 0, (el) => el.child(h_flex().flex_none().h(28).gap(5).min_w(0).overflow_x_scroll()
          .child(this.button(t, "preview-attachments", "Preview", () => this.openControls("attachments")))
          .children(parts.map((part, index) => this.button(t, `attachment-${index}`, `${part.kind === "file" ? "File" : "@"} ${part.name ?? part.id} ×`, (_e, cx) => {
            this.rich.remove(target.key, index); this.saveOrWarn(); this.needsResize = true; cx.notify();
          }, { title: `Remove ${part.name ?? part.id}; structured ${part.kind} attachment` })))))
        .child(div().flex_1().min_h(0).min_w(0).overflow_hidden()
          .child(Textarea.new(this.editor).disabled(!target).size_full().min_h(0).min_w(0).text_size(13).text_color(t.foreground)))
         .child(h_flex().flex_none().h(24).min_w(0).gap(8).items_center()
          .child(h_flex().flex_1().min_w(0).gap(5).items_center()
             .child(Button.new("composer-mode").flex_none().h(22).px(7).rounded(4).bg(t.raised).text_size(11).font_medium().text_color(connected ? rich.mode === "shell" ? t.blocked : t.accent : t.dim)
              .disabled(!connected).tooltip("Choose from the live catalogue. * marks a composer override; clear it in this picker. Native unsent agent/auto-permission state is not exposed.")
               .on_click((_e, cx) => { if (rich.mode === "shell") { rich.mode = "normal"; this.saveOrWarn(); cx.notify(); } else this.openControls("agents"); }).child(labels.mode))
             .when(rich.mode !== "shell", (el) => el
             .child(Button.new("composer-model").min_w(0).flex_shrink_1().h(24).px(3).text_size(12.5).font_semibold().truncate().text_color(t.foreground)
               .disabled(!connected).tooltip("Choose a live model for structured submission. * marks a composer override; clear it in this picker to follow the native client again.")
               .on_click(() => this.openControls("models")).child(labels.model))
             .when(Boolean(labels.provider) && !compact, (el) => el.child(div().min_w(0).flex_shrink_1().truncate().text_size(11).text_color(t.dim).child(labels.provider)))
             .when(!compact, (el) => el
             .child(Button.new("composer-variant").flex_none().h(20).px(6).rounded(4).bg(t.raised).text_size(10.5).font_medium().text_color(t.muted)
               .disabled(!connected).tooltip("Select from this model's live reasoning variants")
               .on_click(() => this.openControls("variants")).child(labels.variant)))))
           .when(connected && (requests > 0 || target?.status === "blocked"), (el) => el.child(this.button(t, "composer-attention", requests ? `${requests} to review` : "Review", () => this.openControls("attention"), { title: "Review permissions and question forms" }).text_color(t.blocked).font_semibold().bg(t.raised).px(7)))
           .when(queued > 0 || queue.paused || this.showQueue, (el) => el.child(this.button(t, "composer-queue", `${queued} queued${queue.paused ? " · paused" : ""}`, (_e, cx) => this.toggleQueue(cx), { title: "Inbox, retained drafts and delivery receipts" }).text_color(queue.paused ? t.blocked : t.working).font_medium()))
           .child(this.button(t, "composer-tools", "…", () => this.openControls("tools"), { disabled: !target, title: "Attachments, history, queue, shell and session tools" }))))
       .when(Boolean(hint), (el) => el.child(div().flex_none().h(22).px(3).min_w(0).truncate().text_size(11).text_color(t.blocked).tooltip(hint).child(hint)))
       .child(h_flex().flex_none().h(24).min_w(0).gap(compact ? 5 : 12).items_center()
         .child(Button.new("composer-target").flex_1().min_w(0).h(24).gap(6).flex().items_center().justify_start().cursor_pointer()
           .tooltip(`${workspace}\n${workspaceStatus}\n${target ? `${target.label} · ${target.space_name} · ${target.address}\n${STATUS[target.status] ?? "Unknown"}\n` : ""}${labels.directory}\nChange recipient; drafts stay with their agent`)
           .on_click((_e, cx) => { this.choose(); cx.notify(); })
           .child(div().size(6).flex_none().rounded(3).bg(target ? t[target.status] ?? t.dim : t.dim))
           .child(div().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(target?.label ?? "Choose an agent"))
           .when(wide, (el) => el
             .child(svg(`mods/workspace-chrome/${space?.machine ? "server" : "monitor"}.svg`).size(13).flex_none().text_color(t.dim))
             .when(Boolean(space?.machine), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(space.machine)))
             .when(Boolean(space?.branch), (el) => el
               .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.dim))
               .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(space.branch)))))
         .when(!compact || needsAttention > 0, (el) => el.child(this.button(t, "composer-workspace-agents", h_flex().gap(5).items_center()
           .when(!compact, (el) => el
             .child(svg("mods/workspace-chrome/layers.svg").size(13).text_color(t.dim))
             .child(div().font_medium().text_color(t.foreground).child(workspaceAgents.length))
             .child(div().text_size(11).text_color(t.dim).child("agents")))
           .when(needsAttention > 0, (el) => el.child(h_flex().gap(4).items_center().px(5).rounded(4).bg(t.raised).text_color(t.blocked)
             .child(div().font_semibold().child(needsAttention)).child(div().text_size(11).child("needs you")))),
           (_e, cx) => { this.choose(); cx.notify(); }, { title: `${workspace}\n${workspaceStatus}\nBrowse agents` })))
         .when(!compact, (el) => el.child(h_flex().flex_none().gap(5).items_center().tooltip(`Context: ${labels.context}\n${infoTitle}`)
           .when(labels.contextPercent != null, (el) => el.child(Progress.new("composer-context").value(Math.max(0, Math.min(100, labels.contextPercent))).w(28).h(4)
             .child(ProgressTrack.new().size_full().rounded(2).bg(t.raised).overflow_hidden()
               .child(ProgressIndicator.new().h_full().w(28 * Math.max(0, Math.min(100, labels.contextPercent)) / 100).bg(labels.contextPercent >= 90 ? t.blocked : t.accent)))))
           .child(div().text_size(10.5).font_medium().text_color(labels.contextPercent >= 90 ? t.blocked : t.muted).child(labels.contextPercent != null ? `${labels.contextPercent}%` : labels.context === "Context not reported" ? "Context —" : labels.context))))
         .child(this.button(t, "composer-terminal", svg("mods/workspace-chrome/terminal.svg").size(14), () => this.focusTerminal(), { disabled: !target, title: `Focus the native terminal\n${labels.directory}` }))
         .when(Boolean(stopping) || rich.mode === "shell", (el) => el.child(this.button(t, "composer-stop", rich.mode === "shell" ? "Exit shell" : "Stop", (_e, cx) => this.stop(cx), { title: "Escape: exit shell mode or interrupt. Press again if needed; also pauses the queue." }).text_color(t.blocked)))
         .child(this.button(t, "composer-send", rich.mode === "shell" ? "Run ↵" : "Send ↵", (_e, cx) => this.enqueue(cx), { disabled: Boolean(blocked), title: blocked ?? help }).font_semibold().text_color(blocked ? t.dim : t.accent))
         .when(connected, (el) => el.child(this.button(t, "composer-commands", h_flex().gap(6).items_center()
           .child(div().text_size(11).child("Commands"))
           .when(!compact, (el) => el.child(div().px(4).rounded(3).bg(t.raised).text_size(10).text_color(t.dim).child("Ctrl+P"))),
           (_e, cx) => { this.openControls(); cx.notify(); }, { title: "Live command palette (Ctrl+P)" }))));
    // A native anchored surface owned by this exact composer view: no mod
    // window, detached overlay, independent focus target or moving popup.
    return Popup.new("composer-attached-controls", composer).size_full().min_h(0).anchor("bottom_left")
      .when(Boolean(this.attachedPanel) || this.attachedPicker, (el) => el.content(v_flex().key_context("UnifiedChatAttachedPanel")
        .when(this.attachedPicker, (el) => el.track_focus(this.recipientHandle))
        .w(Math.min(760, Math.max(280, (this.width ?? 800) - 20))).h(this.attachedPanel instanceof AttentionPanel ? 520 : 360)
        .bg(t.popover).rounded(6).border_1().border_color(t.border).overflow_hidden()
        .on_action("unified-chat-close-panel", (_e, cx) => { cx.stop_propagation(); this.dismissControls(cx); })
        .on_mouse_down_out((_e, cx) => { this.attachedPanel = null; this.pendingPanel = null; this.attachedPicker = false; cx.notify(); })
        .child(h_flex().flex_none().h(26).px(8).justify_between().items_center()
          .child(div().text_size(10.5).text_color(t.muted).child(this.attachedPicker ? "Recipient" : "Composer controls"))
          .child(Button.new("close-attached-controls").h(24).px(6).text_size(12).on_click((_e, cx) => this.dismissControls(cx)).child("Close")))
        .child(div().flex_1().min_h(0).child(this.attachedPicker ? this.renderPicker(t) : this.attachedPanel.render(t)))));
  }
}
