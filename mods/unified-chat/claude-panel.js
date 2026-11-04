import { div } from "gpui-kit";
import { v_flex, Button, Input, InputState } from "gpui-base";
import { hc } from "herdr";
import { decodeResult } from "./model.js";
import { claudeOptions, claudeAction } from "./claude-control.js";
import { menu, item, divider, field } from "./style.js";

const NOTES = {
  models: "Types /model into Claude's terminal · saved as the default for new sessions",
  variants: "Types /effort · max lasts this session",
  agents: "Shown again after Claude's next prompt or tool call",
};

// Controls for a Claude Code terminal, owned by the composer like the OpenCode panel.
// Every choice becomes one typed line or one key press in that terminal, only while
// Claude is idle; nothing is sent as a prompt.
export class ClaudePanel {
  init(initial, cx) {
    this.target = initial.target;
    this.kind = initial.panel;
    this.index = 0;
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: this.kind === "models" ? "Alias or full model id…" : "Filter…", value: initial.query ?? "" });
    this.search.on("change", (_event, cx) => { this.index = 0; cx.notify(); });
    this.search.on("submit", (_event, cx) => this.select(this.options()[this.index ?? 0], cx));
    this.search.focus();
    cx.bind_keys([
      { keystroke: "down", action: "claude-panel-next", context: "ClaudePanel > Input" },
      { keystroke: "up", action: "claude-panel-previous", context: "ClaudePanel > Input" },
    ]);
  }

  options() { return claudeOptions(this.kind, this.search.value()); }

  select(item, cx) {
    const action = claudeAction(this.kind, item);
    if (!action || this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const args = action.hc === "send"
          ? ["send", "--json", "--if", "idle", "--", this.target.address, action.text]
          : ["keys", "--json", this.target.address, ...action.keys];
        decodeResult(await hc(args));
        this.dismiss?.();
      } catch (error) {
        this.error = String(error.message ?? error);
      }
      this.busy = false;
      cx.notify();
    });
  }

  render(t) {
    const options = this.options();
    // A menu, not a dialog: a handful of rows sized to their content. Only the model
    // menu carries a field, so a full model id can be typed.
    return menu(v_flex().id("claude-panel").key_context("ClaudePanel").track_focus(this.handle).w_full(), t)
      .on_action("claude-panel-next", (_e, cx) => { cx.stop_propagation(); this.index = ((this.index ?? 0) + 1) % Math.max(1, options.length); cx.notify(); })
      .on_action("claude-panel-previous", (_e, cx) => { cx.stop_propagation(); this.index = ((this.index ?? 0) + options.length - 1) % Math.max(1, options.length); cx.notify(); })
      .when(this.kind === "models", (el) => el.child(field(t, Input.new(this.search), null).h(32).mx(2).mt(2).mb(4).rounded(7)))
      .children(options.map((option, index) => item(Button.new(`claude-option-${option.id}`).flex_none().min_w(0).w_full(), t, index === this.index)
        .disabled(Boolean(this.busy))
        .on_click((_event, cx) => this.select(option, cx))
        .child(div().min_w(0).flex_1().truncate().child(option.label))
        .child(div().flex_none().text_size(11).text_color(t.dim).truncate().child(option.description ?? ""))))
      .when(!options.length, (el) => el.child(div().px(8).py(6).text_size(11).text_color(t.dim).child("Nothing matches.")))
      .child(divider(t))
      .child(div().px(8).pt(2).pb(4).text_size(11).text_color(this.error ? t.blocked : t.dim)
        .child(this.error ?? (this.busy ? "Typing into Claude…" : NOTES[this.kind] ?? "")));
  }
}
