import { div } from "gpui-kit";
import { v_flex, h_flex, Button, Textarea, TextareaState } from "gpui-base";
import { shared, setShared } from "herdr";
import { requestControl } from "./ui-control.js";
import { activeFields, formAnswer } from "./forms.js";
import { sheet, heading, action as dialogButton } from "./style.js";

const DRAFTS = "unified-chat.form-drafts";

export class AttentionPanel {
  init(initial, cx) {
    this.target = initial.target; this.inputs = new Map(); this.raw = {}; this.externalReady = {};
    this.feedback = TextareaState.new({ placeholder: "Optional feedback when rejecting", rows: 2 });
    this.load(cx);
  }
  load(cx) {
    this.loading = true;
    cx.spawn(async (cx) => {
      try { this.state = await requestControl(this.target, { action: "state" }); this.error = null; }
      catch (error) { this.error = String(error.message ?? error); }
      this.loading = false; cx.notify();
    });
  }
  values() {
    const answers = { ...this.raw };
    for (const field of this.form?.fields ?? []) {
      if (["number", "integer"].includes(field.type) && typeof answers[field.key] === "string") {
        if (!answers[field.key].trim()) delete answers[field.key];
        else answers[field.key] = Number(answers[field.key]);
      }
    }
    return answers;
  }
  saveForm(cx) {
    setShared(DRAFTS, { ...(shared(DRAFTS) ?? {}), [this.form.id]: this.raw }); cx.notify();
  }
  chooseForm(form, cx) {
    this.permission = null; this.form = form; this.error = null; this.externalReady = {}; this.inputs = new Map();
    this.raw = { ...Object.fromEntries(form.fields.filter((field) => field.default !== undefined).map((field) => [field.key, field.default])), ...(shared(DRAFTS)?.[form.id] ?? {}) };
    for (const field of form.fields) {
      if (!["string", "number", "integer", "multiselect"].includes(field.type)) continue;
      const editor = TextareaState.new({ value: typeof this.raw[field.key] === "string" ? this.raw[field.key] : ["number", "integer"].includes(field.type) ? String(this.raw[field.key] ?? "") : "",
        placeholder: field.placeholder ?? (field.type === "multiselect" ? "One custom choice per line" : "Your answer"), rows: 2 });
      editor.on("change", (_event, cx) => {
        if (field.type === "multiselect") {
          const known = new Set(field.options.map((option) => option.value));
          const selected = Array.isArray(this.raw[field.key]) ? this.raw[field.key].filter((value) => known.has(value)) : [];
          this.raw[field.key] = [...new Set([...selected, ...editor.value().split("\n").filter(Boolean)])];
        } else this.raw[field.key] = editor.value();
        this.saveForm(cx);
      });
      this.inputs.set(field.key, editor);
    }
    cx.notify();
  }
  mutate(input, cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await requestControl(this.target, input);
        if (input.action.startsWith("form-")) {
          const saved = { ...(shared(DRAFTS) ?? {}) }; delete saved[input.id]; setShared(DRAFTS, saved);
        }
        this.permission = null; this.form = null; this.confirmAlways = false;
        this.state = await requestControl(this.target, { action: "state" }); this.error = null;
      } catch (error) { this.error = String(error.message ?? error); }
      this.busy = false; cx.notify();
    });
  }
  decide(decision, cx) {
    if (decision === "always" && !this.confirmAlways) { this.confirmAlways = true; cx.notify(); return; }
    const item = this.permission;
    this.mutate({ action: "permission-reply", id: item.id, ownerSessionID: item.sessionID, decision,
      expected: { action: item.action, resources: item.resources, save: item.save ?? [] },
      message: decision === "reject" ? this.feedback.value() : undefined }, cx);
  }
  button(t, id, label, action, disabled = false) {
    return dialogButton(Button.new(id).disabled(disabled || Boolean(this.busy)), t)
      .when(disabled, (el) => el.text_color(t.dim)).on_click((_event, cx) => action(cx)).child(label);
  }
  field(t, field) {
    const value = this.raw[field.key];
    const choice = (label, next, key) => this.button(t, `form-${field.key}-${key}`, `${Array.isArray(value) ? value.includes(next) ? "☑ " : "☐ " : value === next ? "● " : "○ "}${label}`, (cx) => {
      this.raw[field.key] = field.type === "multiselect" ? (Array.isArray(value) && value.includes(next) ? value.filter((item) => item !== next) : [...(Array.isArray(value) ? value : []), next]) : next;
      this.saveForm(cx);
    });
    return v_flex().flex_none().min_w(0).gap(5).p(8).rounded(6).border_1().border_color(t.border)
      .child(div().text_size(12).child(`${field.title ?? field.key}${field.required ? " *" : ""}`))
      .when(Boolean(field.description), (el) => el.child(div().text_size(11).text_color(t.muted).child(field.description)))
      .when(field.type === "boolean", (el) => el.child(h_flex().gap(8).children([choice("Yes", true, "yes"), choice("No", false, "no")])))
      .when(Boolean(field.options), (el) => el.child(v_flex().gap(3).children((field.options ?? []).map((option, index) => choice(`${option.label}${option.description ? ` — ${option.description}` : ""}`, option.value, index)))))
      .when(this.inputs.has(field.key) && (!field.options || field.custom), (el) => el.child(Textarea.new(this.inputs.get(field.key)).h(52).w_full().text_size(12).px(6).py(4).bg(t.background)))
      .when(field.type === "external", (el) => el.child(v_flex().gap(6)
        .child(div().text_size(12).text_color(t.accent).child(field.url))
        .child(h_flex().gap(8)
          .child(this.button(t, `external-open-${field.key}`, "Open displayed URL", (cx) => {
            try { cx.open_url(field.url); this.externalReady[field.key] = true; cx.notify(); } catch (error) { this.error = String(error); cx.notify(); }
          }))
          .child(this.button(t, `external-copy-${field.key}`, "Copy URL", (cx) => { cx.write_to_clipboard(field.url); this.externalReady[field.key] = true; cx.notify(); })))
        .child(this.button(t, `external-done-${field.key}`, value === true ? "✓ Acknowledged" : "I completed the external action", (cx) => { this.raw[field.key] = true; this.saveForm(cx); }, !this.externalReady[field.key] && value !== true))));
  }
  render(t) {
    const requests = [...(this.state?.permissions ?? []).map((item) => ({ ...item, kind: "permission" })), ...(this.state?.forms ?? []).map((item) => ({ ...item, kind: "form" }))];
    return sheet(v_flex(), t)
      .child(heading(t, "Permissions and questions", null)
        .child(this.button(t, "attention-refresh", "Refresh", (cx) => this.load(cx))))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("attention-body").flex_1().min_h(0).overflow_y_scrollbar().gap(8)
        .when(this.loading, (el) => el.child(div().text_size(12).child("Loading live requests…")))
        .when(!this.permission && !this.form, (el) => el.children(requests.map((item) => this.button(t, `request-${item.id}`, `${item.kind === "permission" ? item.action : item.title} · ${item.sessionID}`, (cx) => {
          if (item.kind === "form") this.chooseForm(item, cx);
          else { this.permission = item; this.confirmAlways = false; this.feedback.set_value(""); cx.notify(); }
        }))).when(!this.loading && !requests.length, (el) => el.child(div().text_size(12).text_color(t.muted).child("No pending permission requests or questions in this session family."))))
        .when(Boolean(this.permission), (el) => el.child(v_flex().gap(8)
          .child(div().text_size(13).child(this.permission?.action ?? ""))
          .child(div().text_size(12).child(this.permission?.message ?? "Review the complete requested resources:"))
          .child(div().text_size(12).child(JSON.stringify(this.permission?.resources ?? [], null, 2)))
          .child(div().text_size(11).text_color(t.muted).child(JSON.stringify(this.permission?.metadata ?? {}, null, 2)))
          .child(div().text_size(12).text_color(t.blocked).child(`Allow always saves these project-scoped patterns:\n${JSON.stringify(this.permission?.save ?? [], null, 2)}`))
          .child(Textarea.new(this.feedback).h(55).w_full().text_size(12).bg(t.background))
          .child(h_flex().gap(8).children([
            this.button(t, "permission-once", "Allow once", (cx) => this.decide("once", cx)),
            this.button(t, "permission-always", this.confirmAlways ? "Confirm permanent patterns above" : "Allow always…", (cx) => this.decide("always", cx)),
            this.button(t, "permission-reject", "Reject with feedback", (cx) => this.decide("reject", cx)),
          ]))))
        .when(Boolean(this.form), (el) => el.child(v_flex().gap(8)
          .child(div().text_size(13).child(this.form?.title ?? "Question"))
          .children((this.form ? activeFields(this.form, this.values()) : []).map((field) => this.field(t, field)))
          .child(h_flex().gap(8).children([
            this.button(t, "form-submit", "Review and submit answers", (cx) => {
              try { const answer = formAnswer(this.form, this.values()); this.mutate({ action: "form-reply", id: this.form.id, ownerSessionID: this.form.sessionID, answer }, cx); }
              catch (error) { this.error = String(error.message ?? error); cx.notify(); }
            }),
            this.button(t, "form-cancel", "Cancel question", (cx) => this.mutate({ action: "form-cancel", id: this.form.id, ownerSessionID: this.form.sessionID }, cx)),
          ])))))
      .when(Boolean(this.permission || this.form), (el) => el.child(this.button(t, "attention-back", "Back to pending requests (keep draft)", (cx) => { this.permission = null; this.form = null; cx.notify(); })));
  }
}
