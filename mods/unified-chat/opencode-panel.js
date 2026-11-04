import { div, image } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState } from "gpui-base";
import { run, closeOverlay, props, appHome, setShared, exec } from "herdr";
import { commandOptions } from "./prompt.js";
import { requestControl } from "./ui-control.js";
import { applyArgumentEdit, slashHead } from "./completion.js";

// Controller owned by a UnifiedChat popup copy. It never sends a prompt or
// answers an approval. Actions invoke the exact client's documented UI command.
export class OpenCodePanel {
  init(initial, cx) {
    this.target = initial.target;
    this.anchor = initial.anchor;
    this.kind = initial.panel;
    this.draftText = initial.draftText ?? initial.query ?? "";
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search live OpenCode commands…", value: initial.query ?? "" });
    this.search.on("change", (_event, cx) => {
      this.index = 0;
      this.maybeArguments(cx);
      if (this.kind === "mentions") this.findFiles(cx);
      if (this.kind === "arguments") this.findArguments(cx);
      cx.notify();
    });
    this.search.on("submit", (_event, cx) => this.select(this.options()[this.index ?? 0], cx));
    this.index = 0;
    this.loading = true;
    this.submissions = initial.submissions ?? [];
    this.legacy = initial.legacy ?? [];
    this.rich = initial.rich ?? { history: [], stashes: [] };
    this.search.focus();
    cx.bind_keys([
      { keystroke: "down", action: "opencode-panel-next", context: "OpenCodePanel > Input" },
      { keystroke: "up", action: "opencode-panel-previous", context: "OpenCodePanel > Input" },
    ]);
    if (this.kind === "arguments") this.bindArgumentKey(cx);
    cx.spawn(async (cx) => {
      try {
        if (["history", "attachments", "tools"].includes(this.kind) || !this.target.bridge) return;
        this.snapshot = await this.request({ action: "snapshot" });
        this.maybeArguments(cx);
        if (["models", "agents"].includes(this.kind)) this.catalogue = (await this.request({ action: "catalog", collection: this.kind === "models" ? "model" : "agent" })).items;
        if (this.kind === "mentions") {
          const [skills, agents, references] = await Promise.all(["skill", "agent", "reference"].map((collection) => this.request({ action: "catalog", collection })));
          this.mentions = [...skills.items.map((item) => ({ ...item, kind: "skill" })),
            ...agents.items.filter((item) => item.mode !== "primary").map((item) => ({ ...item, kind: "agent" })),
            ...references.items.map((item) => ({ ...item, kind: "reference" }))];
          this.findFiles(cx);
        }
        if (this.kind === "queue") this.state = await this.request({ action: "state" });
        if (this.kind === "activity") this.activity = await this.request({ action: "activity" });
        if (this.kind === "arguments") this.findArguments(cx, 0);
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.loading = false; this.search.focus(); cx.notify(); }
    });
  }

  bindArgumentKey(cx) {
    if (this.argumentKeyBound) return;
    this.argumentKeyBound = true;
    cx.bind_keys([{ keystroke: "tab", action: "opencode-panel-choose", context: "OpenCodePanel > Input" }]);
  }

  maybeArguments(cx) {
    if (!["slash", "commands"].includes(this.kind)) return;
    const head = slashHead(this.search.value());
    if (!head || !(this.snapshot?.commands ?? []).some((item) => item.slash?.arguments &&
      [item.slash.name, ...(item.slash.aliases ?? [])].includes(head.name))) return;
    this.kind = "arguments"; this.bindArgumentKey(cx);
  }

  findArguments(cx, delay = 120) {
    const generation = (this.argumentGeneration ?? 0) + 1;
    this.argumentGeneration = generation;
    this.argumentResult = null; this.argumentPending = true;
    const text = this.search.value();
    cx.timer.after(delay, (cx) => {
      if (generation !== this.argumentGeneration) return;
      cx.spawn(async (cx) => {
        try {
          const result = await this.request({ action: "complete-arguments", text });
          if (generation !== this.argumentGeneration || text !== this.search.value()) return;
          this.argumentResult = result; this.error = result.reason ?? null;
        } catch (error) { if (generation === this.argumentGeneration) this.error = String(error.message ?? error); }
        finally { if (generation === this.argumentGeneration) this.argumentPending = false; cx.notify(); }
      });
    });
  }

  publishCompletion(edit, _cx) {
    run(`unified-chat.complete:${encodeURIComponent(JSON.stringify(edit))}`);
    this.close();
  }

  close() {
    if (this.dismiss) this.dismiss();
    else if (props()?.overlay) closeOverlay(props().overlay);
  }

  savedAction(action, item, cx) {
    if (action === "discard" && this.confirmDiscard !== item.key) { this.confirmDiscard = item.key; cx.notify(); return; }
    run(`unified-chat.draft:${encodeURIComponent(JSON.stringify({ key: this.target.key, action,
      source: item.source, index: item.savedIndex, id: item.id }))}`);
    this.close();
  }

  findFiles(cx) {
    const generation = (this.fileGeneration ?? 0) + 1;
    this.fileGeneration = generation;
    const query = this.search.value().replace(/^@/, "");
    cx.timer.after(150, (cx) => {
      if (generation !== this.fileGeneration) return;
      cx.spawn(async (cx) => {
        try {
          const result = await this.request({ action: "files", query });
          if (generation === this.fileGeneration) this.files = result.items;
        } catch (error) { if (generation === this.fileGeneration) this.error = String(error.message ?? error); }
        cx.notify();
      });
    });
  }

  queueAction(action, item, cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (action === "edit") {
          const value = await this.request({ action: "queued-export", id: item.id, captureHome: appHome() });
          const token = `unified-chat.queued-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          setShared(token, value);
          run(`unified-chat.queued-edit:${encodeURIComponent(JSON.stringify({ key: this.target.key, id: item.id, token }))}`);
          this.close(); return;
        }
        await this.request({ action, id: item.id, delivery: item.delivery === "queue" ? "steer" : "queue" });
        this.state = await this.request({ action: "state" }); this.selectedQueue = null; this.error = null;
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  async request(input) {
    return requestControl(this.target, input);
  }

  options() {
    if (this.loading && !this.snapshot) return [];
    if (this.kind === "arguments") return this.argumentResult?.items ?? [];
    if (this.kind === "tools") return [
      ["history", "History / stash"], ["attachments", "Preview attachments"], ["sessions", "All sessions"],
      ["workspace-commands", "Herdr workspace commands"],
      ["queue", this.target.bridge ? "Native inbox and retained drafts" : "Queue and retained drafts"],
      ...(this.target.bridge ? [["models", "Choose live chat model"], ["agents", "Choose primary agent"], ["variants", "Choose reasoning variant"], ["mentions", "Attach skill, agent, file or reference"], ["clipboard", "Paste clipboard image / files"], ["shell", "Toggle explicit shell mode"], ["activity", "Activity, subagents and shell output"], ["attention", "Review permissions / questions"]] : []),
    ].map(([id, label]) => ({ id, label, kind: "tool", key: `tool:${id}` })).filter((item) => item.label.toLowerCase().includes(this.search.value().toLowerCase()));
    if (this.kind === "activity") return [
      ...(this.activity?.family ?? []).map((item) => ({ ...item, kind: "family", key: `family:${item.id}`, label: item.title, description: `${item.agent ?? "agent unknown"} · ${JSON.stringify(item.status)}` })),
      ...(this.activity?.shells ?? []).map((item) => ({ ...item, kind: "shell-output", key: `shell:${item.id}`, label: item.command, description: `Location-wide shell · ${item.status} · ${item.cwd}` })),
    ].filter((item) => item.label.toLowerCase().includes(this.search.value().toLowerCase()));
    if (this.kind === "attachments") return (this.rich.parts ?? []).map((part, savedIndex) => ({ part, savedIndex, kind: "attachment", key: `attachment:${savedIndex}`, label: part.name ?? part.id, description: part.capture?.mime ?? part.kind }));
    if (this.kind === "models" || this.kind === "agents") return [
      { kind: "selection-reset", key: "selection-reset", label: this.kind === "models" ? "Use native client model selection" : "Use committed session agent", description: "Clear composer override" },
      ...(this.catalogue ?? [])
      .filter((item) => this.kind === "models" ? item.enabled !== false && (!item.type || item.type === "chat") : item.mode !== "subagent")
      .filter((item) => `${item.name} ${item.id} ${item.providerID ?? ""}`.toLowerCase().includes(this.search.value().toLowerCase()))
      .map((item) => ({ ...item, key: `${item.providerID ?? "agent"}:${item.id}`, kind: this.kind === "models" ? "model" : "primary-agent", label: item.name, description: item.providerID ?? item.description })),
    ];
    if (this.kind === "variants") return [{ id: null, label: "Model default", kind: "variant" },
      ...(this.rich.selection?.model ? this.rich.selection.modelVariants ?? [] : this.snapshot?.variants ?? []).map((id) => ({ id, label: id, kind: "variant" }))];
    if (this.kind === "mentions") {
      const query = this.search.value().replace(/^@/, "").toLowerCase();
      return [...(this.mentions ?? []).filter((item) => item.id.toLowerCase().includes(query)), ...(this.files ?? [])]
        .map((item) => ({ ...item, label: `@${item.name ?? item.id}`, key: `${item.kind}:${item.id}` }));
    }
    if (this.kind === "queue") return [
      ...(this.state?.inbox ?? []).filter((item) => item.type === "user").map((item) => ({ ...item, kind: "inbox", label: item.payload.text || "[attachments]", description: item.delivery, key: item.id })),
      ...this.submissions.map((item) => ({ ...item, source: "submission", kind: "receipt", label: item.draft.text || "[attachments]", description: item.state, key: item.id })),
      ...this.legacy.map((item) => ({ ...item, source: "legacy", kind: "saved", label: item.text, description: `Legacy terminal queue · ${item.state}`, key: `legacy:${item.id}` })),
    ].filter((item) => item.label.toLowerCase().includes(this.search.value().toLowerCase()));
    if (this.kind === "history") return [
      ...(this.rich.stashes ?? []).map((draft, savedIndex) => ({ draft, savedIndex, source: "stash", kind: "saved", key: `stash:${savedIndex}`, label: draft.text || "[attachments]", description: "Stash · restore" })).reverse(),
      ...(this.rich.history ?? []).map((draft, savedIndex) => ({ draft, savedIndex, source: "history", kind: "saved", key: `history:${savedIndex}`, label: draft.text || "[attachments]", description: `${draft.mode} · history` })).reverse(),
    ].filter((item) => item.label.toLowerCase().includes(this.search.value().toLowerCase()));
    return commandOptions(this.snapshot?.commands ?? [], this.search.value(), this.kind === "slash");
  }

  select(item, cx) {
    if (!item || this.busy) return;
    if (item.kind === "argument") {
      try {
        const value = applyArgumentEdit(this.search.value(), item.edit);
        this.publishCompletion({ key: this.target.key, expected: this.draftText, value }, cx);
      } catch (error) { this.error = String(error.message ?? error); cx.notify(); }
      return;
    }
    if (item.kind === "selection-reset") {
      run(`unified-chat.selection:${encodeURIComponent(JSON.stringify({ key: this.target.key, selection: this.kind === "models" ? { model: null, modelName: null, modelVariants: null } : { agent: null } }))}`);
      this.close(); return;
    }
    if (item.kind === "tool") {
      this.close();
      run(`unified-chat.tool:${encodeURIComponent(JSON.stringify({ key: this.target.key, tool: item.id }))}`);
      return;
    }
    if (item.kind === "family" || item.kind === "shell-output") {
      this.busy = true;
      cx.spawn(async (cx) => {
        try {
          const value = await this.request({ action: item.kind === "family" ? "navigate-family" : "shell-output", id: item.id });
          if (item.kind === "family") this.close();
          else this.preview = { description: `Captured shell output · ${value.size} bytes · cursor ${value.cursor}`, text: value.output, truncated: value.truncated };
        } catch (error) { this.error = String(error.message ?? error); }
        this.busy = false; cx.notify();
      });
      return;
    }
    if (item.kind === "attachment") {
      this.busy = true;
      cx.spawn(async (cx) => {
        try {
          const result = await exec("node", [`${appHome()}/mods/unified-chat/opencode-control.mjs`, "--preview", JSON.stringify(item.part)]);
          if (result.code !== 0) throw new Error(result.stderr?.trim() || "Attachment preview failed.");
          this.preview = JSON.parse(result.stdout); this.error = null;
        } catch (error) { this.error = String(error.message ?? error); }
        this.busy = false; cx.notify();
      });
      return;
    }
    if (["model", "primary-agent"].includes(item.kind) || (item.kind === "variant" && this.rich.selection?.model)) {
      const selection = item.kind === "model" ? { model: { id: item.id, providerID: item.providerID }, modelName: item.name, modelVariants: item.variants ?? [] }
        : item.kind === "primary-agent" ? { agent: item.id } : { model: { ...this.rich.selection.model, variant: item.id ?? undefined } };
      run(`unified-chat.selection:${encodeURIComponent(JSON.stringify({ key: this.target.key, selection }))}`);
      this.close(); return;
    }
    if (["receipt", "saved"].includes(item.kind)) { this.selectedSaved = item; this.confirmDiscard = null; cx.notify(); return; }
    if (item.kind === "inbox") {
      this.busy = true;
      cx.spawn(async (cx) => {
        try { const value = await this.request({ action: "queued-detail", id: item.id }); this.selectedQueue = { ...item, ...value.item }; }
        catch (error) { this.error = String(error.message ?? error); }
        this.busy = false; cx.notify();
      });
      return;
    }
    if (this.kind === "mentions") {
      run(`unified-chat.attach:${encodeURIComponent(JSON.stringify({ key: this.target.key, anchor: this.anchor, part: { kind: item.kind, id: item.id, name: item.name ?? item.id, ...(item.uri ? { uri: item.uri } : {}) } }))}`);
      this.close(); return;
    }
    if (item.kind === "server" || item.slash?.arguments) {
      // This is an edit, not execution. The receiving composer verifies the
      // target and refuses to overwrite an existing non-command draft.
      run(`unified-chat.insert:${encodeURIComponent(JSON.stringify({ key: this.target.key, text: `${item.label} `, complete: true }))}`);
      this.close();
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (item.kind === "receipt") {
          const result = await this.request({ action: "receipt", id: item.id });
          if (!result.found) throw new Error("No receipt found. This is not proof of non-delivery; inspect the session before resending. The saved draft has not been discarded.");
          run(`unified-chat.receipt:${encodeURIComponent(JSON.stringify({ key: this.target.key, id: item.id, found: true }))}`);
        }
        else if (item.kind === "variant") await this.request({ action: "variant", value: item.id });
        else {
          // Mentions still need native attachment editing. Do not pretend that
          // inserting the string @foo would transmit a structured skill/file.
          run("agent.focus", { terminal: this.target.address });
          if (this.kind !== "mentions" || item.kind === "skill") {
            await this.request({ action: "command", id: this.kind === "mentions" ? "prompt.skills" : item.id });
          }
          if (this.kind === "slash") {
            run(`unified-chat.insert:${encodeURIComponent(JSON.stringify({ key: this.target.key, text: "", focus: false }))}`);
          }
        }
        this.close();
        if (!["variant", "receipt"].includes(item.kind)) run("agent.focus", { terminal: this.target.address });
      } catch (error) { this.error = String(error.message ?? error); }
      this.busy = false; cx.notify();
    });
  }

  checkReceipt(item, cx) {
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const result = await this.request({ action: "receipt", id: item.id });
        if (!result.found) throw new Error("No receipt found. Inspect the session before resending; absence is not proof of non-delivery.");
          run(`unified-chat.receipt:${encodeURIComponent(JSON.stringify({ key: this.target.key, id: item.id, found: true }))}`);
        this.close();
      } catch (error) { this.error = String(error.message ?? error); }
      this.busy = false; cx.notify();
    });
  }

  render(t) {
    const options = this.options();
    const title = this.kind === "arguments" ? "Live command arguments · Tab completes the draft, never runs it" : this.kind === "tools" ? "Composer tools" : this.kind === "activity" ? "Session activity, family and location shell jobs" : this.kind === "attachments" ? "Captured attachment previews" : this.kind === "models" ? "Live chat models" : this.kind === "agents" ? "Live primary agents" : this.kind === "history" ? "History and stashed drafts" : this.kind === "variants" ? "Reasoning variant" : this.kind === "mentions" ? "Attach skill, agent, file, folder or reference" : this.kind === "queue" ? "OpenCode native inbox / delivery receipts" : "OpenCode commands";
    return v_flex().id("opencode-panel").key_context("OpenCodePanel").track_focus(this.handle)
      .on_action("opencode-panel-next", (_e, cx) => { cx.stop_propagation(); this.index = ((this.index ?? 0) + 1) % Math.max(1, options.length); cx.notify(); })
      .on_action("opencode-panel-previous", (_e, cx) => { cx.stop_propagation(); this.index = ((this.index ?? 0) + options.length - 1) % Math.max(1, options.length); cx.notify(); })
      .on_action("opencode-panel-choose", (_e, cx) => { cx.stop_propagation(); this.select(this.options()[this.index ?? 0], cx); })
      .size_full().min_h(0).p(10).gap(8).bg(t.popover).text_color(t.foreground)
      .child(div().text_size(13).font_medium().child(title))
      .child(Input.new(this.search).h(30).flex_none().px(8).rounded(5).border_1().border_color(t.input).text_size(12))
      .when(this.kind === "arguments", (el) => el.child(h_flex().gap(8).flex_none()
        .child(div().flex_1().text_size(11).text_color(t.muted).child(this.argumentResult?.kind === "directory" ? "Directories from the selected server; /cd preserves literal spaces." : "Live filesystem argument suggestions; commands expose no enum/flag schema. Edit arbitrary arguments here."))
        .child(Button.new("apply-command-arguments").h(28).text_size(12).disabled(!this.argumentResult?.command || this.argumentPending)
          .on_click((_e, cx) => this.publishCompletion({ key: this.target.key, expected: this.draftText, value: this.search.value() }, cx)).child("Apply arguments"))))
      .when(this.kind === "mentions", (el) => el.child(div().text_size(11).text_color(t.muted)
        .child("Structured API attachments · search files with optional #start-end line range · select to attach")))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.activity), (el) => el.child(div().text_size(11).text_color(t.muted).child(`Reported cost: ${this.activity?.cost == null ? "unknown" : `$${this.activity.cost}`} · status: ${JSON.stringify(this.activity?.status)} · tokens: ${JSON.stringify(this.activity?.tokens ?? "unknown")}`)))
      .when(Boolean(this.preview), (el) => el.child(v_flex().flex_none().max_h(240).overflow_y_scroll().gap(5)
        .child(div().text_size(11).text_color(t.muted).child(this.preview?.description ?? ""))
        .when(Boolean(this.preview?.image), (el) => el.child(image(this.preview.image).max_w(650).max_h(200)))
        .when(Boolean(this.preview?.text), (el) => el.child(div().text_size(12).child(this.preview.text)))
        .when(Boolean(this.preview?.truncated), (el) => el.child(div().text_size(11).text_color(t.muted).child("Preview truncated; the complete captured file is attached.")))))
      .when(this.kind === "history", (el) => el.child(Button.new("stash-current").h(28).text_size(12)
        .on_click((_e, cx) => this.savedAction("stash", {}, cx)).child("Stash current draft (text + attachments)")))
      .child(v_flex().id("opencode-options").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .when(this.loading || this.argumentPending, (el) => el.child(div().p(8).text_size(12).text_color(t.muted).child("Loading from the selected OpenCode client…")))
        .children(options.map((item, index) => Button.new(`opencode-option-${item.key ?? item.id ?? index}`)
          .flex_none().min_w(0).w_full().px(8).py(7).rounded(5).flex().items_center().gap(10)
          .bg(index === this.index ? t.selected : t.popover).hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_event, cx) => this.select(item, cx))
          .child(div().min_w(0).flex_1().text_size(12).truncate().child(item.label))
          .child(div().min_w(0).flex_1().text_size(11).text_color(t.muted).truncate().child(item.description ?? ""))
          .child(div().flex_none().text_size(10).text_color(t.dim).child(item.kind === "argument" ? "complete" : item.kind === "server" || item.slash?.arguments ? "insert" : this.kind === "mentions" ? item.kind : ["variant", "inbox", "receipt"].includes(item.kind) ? "select" : "native"))))
        .when(!this.loading && !options.length, (el) => el.child(div().p(8).text_size(12).text_color(t.muted).child("No matching live commands."))))
      .when(Boolean(this.selectedQueue), (el) => el.child(v_flex().flex_none().gap(6)
        .child(div().max_h(90).overflow_y_scroll().text_size(12).child(this.selectedQueue?.payload?.text ?? "[attachments]"))
        .child(h_flex().gap(10)
          .child(Button.new("native-inbox-edit").h(28).px(10).rounded(5).bg(t.raised).text_size(12)
            .on_click((_e, cx) => this.queueAction("edit", this.selectedQueue, cx)).child("Undo queued → edit"))
          .child(Button.new("native-inbox-cancel").h(28).px(10).rounded(5).bg(t.raised).text_size(12)
            .on_click((_e, cx) => this.queueAction("inbox-cancel", this.selectedQueue, cx)).child("Cancel queued prompt"))
          .child(Button.new("native-inbox-delivery").h(28).px(10).rounded(5).bg(t.raised).text_size(12)
             .on_click((_e, cx) => this.queueAction("inbox-delivery", this.selectedQueue, cx)).child(this.selectedQueue?.delivery === "queue" ? "Steer instead" : "Queue instead")))))
      .when(Boolean(this.selectedSaved), (el) => el.child(v_flex().flex_none().gap(6)
        .child(div().max_h(100).overflow_y_scroll().text_size(12).child(this.selectedSaved?.draft?.text ?? this.selectedSaved?.text ?? ""))
        .child(div().text_size(11).text_color(t.blocked).child(this.selectedSaved?.error ?? "Restoring preserves your current draft in Stashes. Uncertain sends stay blocked until receipt/manual review."))
        .child(h_flex().gap(8)
          .when(this.selectedSaved?.kind === "receipt" && this.selectedSaved?.state === "uncertain" && Boolean(this.target.bridge), (el) => el.child(Button.new("receipt-check").h(28).text_size(12)
            .on_click((_e, cx) => this.checkReceipt(this.selectedSaved, cx)).child("Check durable receipt")))
          .child(Button.new("saved-restore").h(28).text_size(12).disabled(["sending", "waiting"].includes(this.selectedSaved?.state))
            .on_click((_e, cx) => this.savedAction("restore", this.selectedSaved, cx)).child("Restore draft"))
          .when(["submission", "legacy"].includes(this.selectedSaved?.source), (el) => el.child(Button.new("saved-discard").h(28).text_size(12).disabled(["sending", "waiting"].includes(this.selectedSaved?.state))
            .on_click((_e, cx) => this.savedAction("discard", this.selectedSaved, cx)).child(this.confirmDiscard === this.selectedSaved?.key ? "Confirm: reviewed; release barrier" : "Reviewed in terminal; dismiss…"))))))
      .child(h_flex().flex_none().justify_between().text_size(10.5).text_color(t.dim)
        .child("↑↓ select · Return choose · Escape close")
        .child("Native prompt stays available"));
  }
}
