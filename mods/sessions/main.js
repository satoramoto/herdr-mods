// All sessions: every harness session the registry knows, connected or saved. Click a
// connected one to open its terminal, a saved one to reconnect it by its exact native
// identity. Drag a row onto a space in the sidebar to re-adopt it there.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, readTextFile, exec, run, terminals, focused, shared, setShared, openOverlay, closeOverlay, props } from "herdr";
import { registryPath, workerPath, nodePath } from "./config.js";
import { FILTERS, agentLabel, groupsFor, ageLabel } from "./presentation.js";
import { DRAG_KEY, TARGET_KEY, startDrag, dragMoved } from "./drag-model.js";

const filterOf = () => FILTERS.find((item) => item.id === shared("sessions.filter")) ?? FILTERS[0];
const ICONS = new Set(["opencode", "claude", "codex", "pi", "gemini", "copilot", "cursor", "amp", "hermes", "grok", "kimi", "mastracode"]);

export default class Sessions extends View {
  init(_props, cx) {
    if (props()?.filterMenu) return;
    this.rows = []; this.pending = new Set(); this.folded = new Set();
    this.dragFocus = cx.focus_handle();
    this.dragOwner = `sessions-${Date.now()}-${Math.random()}`;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
  }
  refresh(cx) {
    if (this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(registryPath);
        if (!text) throw new Error("Session tracker is starting…");
        const data = JSON.parse(text);
        if (data.version !== 1 || !data.sessions) throw new Error("Session registry needs inspection.");
        this.rows = Object.values(data.sessions).filter((row) => !row.aliasOf);
        this.recoverySpace = data.recoverySpace;
        this.updatedAt = data.updatedAt;
        this.errors = data.errors ?? [];
        this.error = null;
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.reading = false; cx.notify(); }
    });
  }
  open(row, cx) {
    if (row.connected && terminals().some((t) => t.address === row.terminal && t.state === "live")) {
      run("agent.focus", { terminal: row.terminal });
      if (props()?.overlay) closeOverlay(props().overlay);
      return;
    }
    if (!row.resumable || this.pending.has(row.key)) return;
    this.pending.add(row.key);
    cx.spawn(async (cx) => {
      try {
        const result = await exec(nodePath, [workerPath, "--resume", row.key]);
        if (result.code !== 0) throw new Error(result.stderr || "Could not reconnect this session.");
        const reply = JSON.parse(result.stdout);
        const address = reply.result?.address ?? reply.terminal;
        if (address) {
          run("agent.focus", { terminal: address });
          if (props()?.overlay) closeOverlay(props().overlay);
        }
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.pending.delete(row.key); this.refresh(cx); cx.notify(); }
    });
  }
  filterMenu(t) {
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Show sessions"))
      .children(FILTERS.map((item) => h_flex().id(`sessions-filter-${item.id}`).h(31).px(8).gap(9).rounded(7)
        .items_center().text_color(t.foreground).cursor_pointer().hover((el) => el.bg(t.hover))
        .on_click(() => { setShared("sessions.filter", item.id); closeOverlay(props().overlay); })
        .child(div().flex_1().child(item.label))
        .when(filterOf().id === item.id, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none()))));
  }
  icon(row, t, all) {
    const program = all.find((item) => item.address === row.terminal && item.state === "live")?.program;
    if (program?.icon) return program.tint ? svg(program.icon).size(16).flex_none().text_color(t.foreground) : image(program.icon).size(16).flex_none();
    const icon = `icons/${ICONS.has(row.agent) ? row.agent : "agent"}.svg`;
    return row.agent === "claude" ? image(icon).size(16).flex_none() : svg(icon).size(16).flex_none().text_color(t.foreground);
  }
  status(row, t) {
    if (this.pending.has(row.key) || row.connected && row.status === "working") {
      return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    }
    if (row.status === "blocked" || row.active && !row.connected) {
      return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold()
        .text_color(t.blocked).flex().items_center().justify_center().child("!");
    }
    if (row.connected && row.status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    return div().size(7).mx(3).flex_none().rounded(4).border(row.connected ? 1.5 : 1).border_color(row.connected ? t.idle ?? t.dim : t.dim);
  }
  row(row, t, all, selected) {
    const on = row.connected && row.terminal === selected;
    const available = row.connected || row.resumable;
    const label = row.title || row.sessionID || row.key;
    const info = `${agentLabel(row.agent)} · ${row.sessionID ?? "resume ID unavailable"}\n${row.directory ?? "project unknown"}\n${row.lastError ?? (row.connected ? "Open live terminal" : row.unavailableDirectory ? "Original project directory is unavailable; no substitute will be used" : row.resumable ? "Reconnect exact session; no prompt replay" : "Visible, but no safe native resume adapter")}`;
    return h_flex().id(`session-${row.key}`).px(8).h(30).flex_none().min_w(0).rounded(8).items_center().gap(9)
      .when(on, (el) => el.bg(t.selected))
      .when(available, (el) => el.cursor_pointer().hover((el) => el.bg(t.hover)))
      .tooltip(`${info}\nDrag onto a space to adopt without restarting`)
      .on_mouse_down("left", (event, cx) => {
        cx.stop_propagation();
        this.suppressClick = false;
        setShared(DRAG_KEY, startDrag(row, event.position, Date.now(), this.dragOwner));
        setShared(TARGET_KEY, null);
        this.dragFocus.focus();
      })
      .on_mouse_move((event) => {
        const drag = shared(DRAG_KEY);
        if (drag?.owner === this.dragOwner && dragMoved(drag, event.position)) this.suppressClick = true;
      })
      .on_mouse_up("left", (event) => {
        const drag = shared(DRAG_KEY);
        if (drag?.owner === this.dragOwner) {
          this.suppressClick ||= dragMoved(drag, event.position);
          setShared(DRAG_KEY, null); setShared(TARGET_KEY, null);
        }
      })
      .on_click((_e, cx) => { if (!this.suppressClick) this.open(row, cx); this.suppressClick = false; })
      .child(this.icon(row, t, all))
      .child(div().flex_1().min_w(0).truncate().text_color(!row.connected && !on ? t.muted : t.foreground).child(label))
      .child(div().w(190).flex_none().truncate().text_size(11).text_color(t.dim).child(row.directory?.replace(/^.*\//, "") || agentLabel(row.agent)))
      .when(Boolean(ageLabel(row.updatedAt)), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim)
        .tooltip("Last recorded activity").child(ageLabel(row.updatedAt))))
      .child(this.status(row, t));
  }
  render() {
    const t = theme();
    if (props()?.filterMenu) return this.filterMenu(t);
    const completed = shared("sessions.adoption.completed");
    const placed = this.rows.map((row) => completed?.at > this.updatedAt && completed.key === row.key
      ? { ...row, adoptedSpace: completed.space, space: completed.space } : row);
    const groups = groupsFor(placed, filterOf().id);
    const all = terminals();
    const selected = focused()?.shown ?? focused()?.terminal;
    const rows = groups.flatMap((group) => {
      const open = !this.folded.has(group.id);
      return [h_flex().id(`sessions-group-${group.id}`).px(8).pt(8).h(30).flex_none().gap(6).items_center()
        .text_size(11).font_medium().text_color(t.dim).cursor_pointer().hover((el) => el.text_color(t.foreground))
        .on_click((_e, cx) => { open ? this.folded.add(group.id) : this.folded.delete(group.id); cx.notify(); })
        .child(div().truncate().child(group.label)).child(div().child(String(group.rows.length))).child(div().flex_1())
        .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none())),
      ...(open ? group.rows.map((row) => this.row(row, t, all, selected)) : [])];
    });
    return v_flex().size_full().min_h(0).min_w(0).text_size(13).text_color(t.foreground)
      .track_focus(this.dragFocus)
      .on_key_down((event, cx) => {
        if (event.key === "escape" && shared(DRAG_KEY)?.owner === this.dragOwner) {
          setShared(DRAG_KEY, null); setShared(TARGET_KEY, null); this.suppressClick = true; cx.stop_propagation();
        }
      })
      .on_mouse_down_out(() => {
        if (shared(DRAG_KEY)?.owner === this.dragOwner) { setShared(DRAG_KEY, null); setShared(TARGET_KEY, null); }
      })
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().gap(6)
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("All sessions"))
        .child(div().text_size(11).text_color(t.dim).child(String(placed.length)))
        .child(div().flex_1())
        .when(Boolean(props()?.overlay), (el) => el.child(div().id("close-sessions").cursor_pointer()
          .on_click(() => closeOverlay(props().overlay)).child("Close")))
        .child(div().id("sessions-filter").text_color(t.dim).cursor_pointer().hover((el) => el.text_color(t.foreground))
          .tooltip(`Show sessions: ${filterOf().label}`).on_click(() => openOverlay({ mod: "sessions", kind: "popup", width: 220, height: 145, props: { filterMenu: true } }))
          .child(svg("mods/workspace-chrome/layers.svg").size(14))))
      .when(Boolean(this.error), (el) => el.child(div().px(16).pb(6).flex_none().text_size(11).text_color(t.blocked).child(this.error)))
      .when(Boolean(shared("sessions.adoption.error")), (el) => el.child(div().px(16).pb(6).flex_none().text_size(11).text_color(t.blocked).child(shared("sessions.adoption.error"))))
      .when(Date.now() - (this.updatedAt ?? 0) > 60000, (el) => el.child(div().px(16).pb(6).flex_none().text_size(11).text_color(t.blocked).child("Tracker data is stale")))
      .child(div().px(16).py(6).text_size(11).text_color(t.dim).child("Click to open or reconnect. Drag onto a space in the sidebar to re-adopt; then reconnect there."))
      .child(v_flex().id("sessions-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().mode("always").children(rows)
        .when(!rows.length, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child("No sessions in this view."))))
      .when(Boolean(this.errors?.length), (el) => el.child(div().px(16).py(6).flex_none().text_size(11).text_color(t.dim).child(this.errors.join("\n"))));
  }
}
