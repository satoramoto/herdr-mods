// One sidebar: machines → spaces → agents, as a folder tree. A space row keeps the
// shipped Spaces look (avatar, repo · branch ↑↓, right-click menu, drag to reorder);
// under it sit its live agents, sub-agents nested, as the shipped Agents mod draws them.
// A session dragged out of the All sessions window (mods/sessions) can be dropped on a
// space row to re-adopt it there.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, focused, run, openOverlay, exec, theme, shared, setShared, window, layout, setAgentOrder } from "herdr";
import { GitWatch } from "./git.js";
import { workerPath, nodePath } from "./config.js";
import { kidStatus, subTree, agentName, topStatus, duration } from "./tree.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// What a stored color name looks like on an avatar (the same in every mod that
// draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;

// The drag contract with mods/sessions/drag-model.js: a payload in shared "sessions.drag",
// the space it hovers in "sessions.drag-target". A drop counts once the pointer moved.
const DRAG_KEY = "sessions.drag", TARGET_KEY = "sessions.drag-target";
const dragMoved = (d, p, now = Date.now()) => Boolean(d?.key && Number.isFinite(d.at) && now >= d.at && now - d.at <= 15000
  && Number.isFinite(d.origin?.x) && Number.isFinite(d.origin?.y) && Number.isFinite(p?.x) && Number.isFinite(p?.y)
  && Math.hypot(p.x - d.origin.x, p.y - d.origin.y) >= 6);
const canDrop = (d, space, p) => Boolean(space?.id && !space.machine && dragMoved(d, p));
const adoptable = !workerPath.startsWith("/nonexistent");
const remember = (key, set) => localStorage.setItem(key, JSON.stringify([...set]));
const recall = (key) => new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));

// The agent's icon from the app's program table: a one-color glyph or a picture.
function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Fold extends View {
  init(_props, cx) {
    this.machineFolded = recall("machines.folded");
    this.git = new GitWatch(this.machineFolded);
    this.folded = recall("fold.spaces"); // space ids whose agents are put away
    this.agentFolded = new Set(); // agent addresses whose sub-agents are put away
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); // address -> { s, at }
    this.pressed = null; // space index being dragged to reorder
    this.over = null;
    this.hovered = null;
    this.git.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.git.refreshMachines(cx));
    cx.timer.every(250, (cx) => this.git.tick(cx));
    cx.timer.every(30000, (cx) => cx.notify()); // the durations move
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // ── agents ────────────────────────────────────────────────────────────────

  status(t, a) {
    if (a.status === "working") return svg(chrome("spinner")).size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked") return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? t.done : t.dim + "00");
  }

  subRow(t, s, shown) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = programIcon(k.program, 13, t.foreground);
    const on = k.address === shown;
    return h_flex().id(`sub-${k.address}`).pl(12).pr(8).rounded(7).h(24).flex_none().items_center().text_size(12)
      .when(on, (el) => el.bg(t.raised)).hover((el) => el.bg(t.hover))
      .on_click(() => run("terminal.peek", { terminal: k.address }))
      .children(s.lines.map((l) => div().self_start().mt(-4).w(9).h(16).mr(4).flex_none()
        .when(Boolean(l), (el) => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", (el) => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), (el) => el.child(div().mr(7).child(pic)))
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }));
  }

  agentRow(a, t, subs, now, name) {
    const pic = programIcon(a.program, 14, t.foreground);
    const when = this.changed[a.address]?.at ?? 0;
    const idle = a.status === "idle" && !a.focused;
    const open = !this.agentFolded.has(a.address);
    const top = topStatus(subs.map((s) => kidStatus(s.t, this.listed)));
    const pin = div().id(`pin-${a.address}`).flex_none().p(2).rounded(4).text_color(a.pinned ? t.foreground : t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(a.pinned ? "Unpin" : "Pin to the top of its space")
      .on_click((_e, cx) => { cx.stop_propagation(); run("terminal.pin", { terminal: a.address, pinned: !a.pinned }); this.hovered = null; cx.notify(); })
      .child(svg(chrome(a.pinned ? "pin-off" : "pin")).size(12));
    const fold = div().id(`agent-fold-${a.address}`).h(18).px(3).gap(3).flex().items_center().rounded(4).text_size(11)
      .text_color(open ? t.dim : (t[top] ?? t.dim)).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); open ? this.agentFolded.add(a.address) : this.agentFolded.delete(a.address); cx.notify(); })
      .child(svg(chrome(open ? "chevron-down" : "chevron-right")).size(11).flex_none())
      .when(!open, (el) => el.child(String(subs.length)));
    return h_flex().id(`ag-${a.address}`).pl(5).pr(8).h(26).flex_none().rounded(7).items_center().gap(7).text_size(12.5)
      .when(a.focused, (el) => el.bg(t.selected)).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (on) this.hovered = a.address; else if (this.hovered === a.address) this.hovered = null; cx.notify(); })
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(name))
      .when(a.pinned && this.hovered !== a.address, (el) => el.child(svg(chrome("pin")).size(11).flex_none().text_color(t.dim)))
      .when(subs.length > 0, (el) => el.child(fold))
      .when(this.hovered === a.address, (el) => el.child(pin))
      .when(this.hovered !== a.address && Boolean(when), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(duration(now - when))))
      .child(this.status(t, a));
  }

  // ── drops from the All sessions window ─────────────────────────────────────

  clearDrag() { setShared(DRAG_KEY, null); setShared(TARGET_KEY, null); }
  dragOver(space, event) {
    if (!adoptable) return;
    const target = canDrop(shared(DRAG_KEY), space, event.position) ? space.id : null;
    if (shared(TARGET_KEY) !== target) setShared(TARGET_KEY, target);
  }
  dropActive(space) {
    const drag = shared(DRAG_KEY);
    return Boolean(drag && Date.now() >= drag.at && Date.now() - drag.at <= 15000 && shared(TARGET_KEY) === space.id);
  }
  // Hands the session to the worker, which moves a live terminal without restarting it
  // or records the destination for a saved one.
  drop(space, event, cx) {
    const drag = shared(DRAG_KEY);
    if (!drag) return false;
    const valid = adoptable && canDrop(drag, space, event.position);
    this.clearDrag();
    if (!valid) return false;
    cx.stop_propagation();
    setShared("sessions.adoption.error", null);
    cx.spawn(async () => {
      try {
        const result = await exec(nodePath, [workerPath, "--adopt", drag.key, "--space", space.id, "--expected", JSON.stringify(drag.expected)]);
        if (result.code !== 0) throw new Error(result.stderr || "Could not adopt this session.");
        const reply = JSON.parse(result.stdout);
        setShared("sessions.adoption.completed", { key: reply.adopted, space: reply.space, at: Date.now() });
      } catch (error) { setShared("sessions.adoption.error", String(error.message ?? error)); }
    });
    return true;
  }

  // ── spaces ────────────────────────────────────────────────────────────────

  menu(w) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Only what's unusual, after the name: "herdr · spike ↑2 ↓1". The repo or branch
  // goes when the name already says it, and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" · ");
    return h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(11).text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)));
  }

  // The space's own row. `kids`: how many rows sit under it; `top`: their most urgent state.
  spaceRow({ w, i, g, tree }, t, kids, top) {
    const on = w.active;
    const color = (shared("space.colors") ?? {})[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    // The space's color as a gentle wash over the header band; alpha is two hex digits.
    const tint = (alpha) => (/^#[0-9a-f]{6}$/i.test(fill) ? fill + alpha : t.raised);
    const folded = this.folded.has(w.id);
    const chevron = div().id(`fold-${w.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        folded ? this.folded.delete(w.id) : this.folded.add(w.id);
        remember("fold.spaces", this.folded);
        cx.notify();
      })
      .child(svg(chrome(folded ? "chevron-right" : "chevron-down")).size(11));
    const open = !folded && kids > 0;
    // The card's header band: full width, square bottom corners when the agent list hangs below it.
    return v_flex().relative().id(`space-${w.id}`).px(9).h(tree ? 32 : 34).flex_none().justify_center()
      .when(open, (el) => el.rounded_t(8)).when(!open, (el) => el.rounded(8))
      .bg(tint(on ? "2e" : "12"))
      .when(!on, (el) => el.hover((s) => s.bg(tint("20"))))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, (line) => line.bottom(0))
          .when(this.pressed > i, (line) => line.top(0))))
      .when(this.dropActive(w), (el) => el.border(1).border_color(t.accent).bg(t.hover))
      .on_mouse_down("left", () => { this.clearDrag(); this.pressed = i; this.over = i; })
      .on_mouse_move((event, cx) => {
        this.dragOver(w, event);
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (event, cx) => {
        if (this.drop(w, event, cx)) { this.pressed = null; this.over = null; return; }
        const from = this.pressed, over = this.over;
        this.pressed = null; this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(h_flex().gap(6).items_center()
        .when(Boolean(tree), (el) => el.child(svg(chrome("branch")).size(13).flex_none().text_color(t.dim)))
        .child(div().flex_shrink(0).max_w(150).truncate().font_medium().text_color(t.foreground).child(w.name))
        .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
        .when(folded && kids > 0, (el) => el.child(h_flex().flex_none().gap(4).items_center().ml(4)
          .child(div().text_size(10.5).text_color(t.dim).child(String(kids)))
          .when(Boolean(top) && top !== "idle", (el) => el.child(this.status(t, { status: top })))))
        .when(kids > 0, (el) => el.child(chevron)));
  }

  compactRow({ w, i }, t) {
    const glyph = w.status === "blocked" || w.status === "done" ? "●" : "·";
    return h_flex().id(`space-${w.id}`).h(26).flex_none().justify_center().gap(4)
      .when(w.active, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
      .when(this.dropActive(w), (el) => el.bg(t.hover).border(1).border_color(t.accent))
      .on_mouse_down("left", () => this.clearDrag())
      .on_mouse_move((event) => this.dragOver(w, event))
      .on_mouse_up("left", (event, cx) => this.drop(w, event, cx))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(t[w.status] ?? t.unknown).child(glyph));
  }

  // A space and everything under it: pinned agents first, then the rest, sub-agents under their parent.
  spaceRows(r, t, ctx) {
    const { w } = r;
    const mine = ctx.list.filter((a) => a.space === w.id);
    const ordered = [...mine.filter((a) => a.pinned), ...mine.filter((a) => !a.pinned)];
    const kids = ordered.length;
    const urgency = ordered.map((a) => topStatus([a.status, ...subTree(ctx.all, a.address).map((s) => kidStatus(s.t, this.listed))]));
    const head = this.spaceRow(r, t, kids, topStatus(urgency));
    ctx.order.push(...ordered.map((a) => a.address));
    const body = [];
    if (!this.folded.has(w.id)) {
      for (const a of ordered) {
        const subs = subTree(ctx.all, a.address);
        body.push(this.agentRow(a, t, subs, ctx.now, agentName(a, ctx.tabs, ctx.ps)));
        if (!this.agentFolded.has(a.address)) body.push(...subs.map((s) => this.subRow(t, s, ctx.shown)));
      }
    }
    // Each space is a card: a header band, then its agents on a quieter surface under a divider.
    return [v_flex().id(`card-${w.id}`).flex_none().mb(6).rounded(9).bg(t.surface).border(1).border_color(t.border)
      .when(w.active, (el) => el.border_color(t.input))
      .child(head)
      .when(body.length > 0, (el) => el.child(v_flex().px(5).pt(5).pb(6).border_t(1).border_color(t.border).children(body)))];
  }

  // Rows under a header per machine once one isn't this computer.
  grouped(t, collapsed, ctx) {
    const rows = this.git.ordered();
    const draw = (r) => (collapsed ? [this.compactRow(r, t)] : this.spaceRows(r, t, ctx));
    const remote = [...new Set([...rows.map((r) => r.w.machine).filter(Boolean), ...this.git.machines.map((m) => m.name)])].sort();
    const loadingRow = (m) => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return this.git.loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    return [null, ...remote].flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.git.machines.find((k) => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.machineFolded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.machineFolded.delete(m) : this.machineFolded.add(m);
          remember("machines.folded", this.machineFolded);
          cx.notify();
        })
        .child(svg(chrome(m ? "server" : "monitor")).size(13).flex_none())
        .when(!collapsed, (el) => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, (el) => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, (el) => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(chrome(folded ? "chevron-right" : "chevron-down")).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg(chrome("plus")).size(12)).when(!collapsed, (el) => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [this.git.loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Every space gets a stable avatar color, the least used one first.
  assignColors(sp) {
    const ids = new Set(sp.map((p) => p.id));
    const stored = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(stored).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = (c) => Object.values(kept).filter((v) => v === c).length;
      kept[p.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const sp = spaces();
    this.assignColors(sp);
    const list = agents();
    const now = Date.now();
    this.track(list, now);
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const ctx = { list, now, all: terminals(), ps: panes(), tabs: sp.flatMap((s) => s.tabs), shown: focused()?.shown ?? focused()?.terminal, order: [] };
    const rows = this.grouped(t, collapsed, ctx);
    setAgentOrder(ctx.order);
    return v_flex().size_full().min_h(0).min_w(0).bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(h_flex().h(31).pl(16).pr(10).flex_none().items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, (el) => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("New space").on_click(() => run("space.new")).child(svg(chrome("plus")).size(14))))
      .when(list.length === 0 && !collapsed && rows.length > 0, (el) => el.child(div().px(14).pb(6).flex_none().text_size(11).text_color(t.dim)
        .child("Agents appear under their space when they report status.")))
      .when(!collapsed && Boolean(shared("sessions.adoption.error")), (el) => el.child(div().px(16).pb(4).flex_none().text_size(11).text_color(t.blocked).child(shared("sessions.adoption.error"))))
      .child(v_flex().id("fold-list").flex_1().min_h(0).px(collapsed ? 0 : 6).pb(10).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.clearDrag(); cx.notify(); })
        .children(rows))
      .when(collapsed, (el) => el.child(h_flex().h(28).flex_none().items_center().justify_center()
        .child(div().id("collapse").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleSidebar).child("»"))));
  }
}
