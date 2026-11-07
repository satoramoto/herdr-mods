// Previews: every Storybook under the project roots, and every preview server running on
// this machine, in one list. A project row knows whether something already serves it, on
// which port, and since when; Start only shows when nothing does, so the same Storybook is
// never started twice. Servers running outside any known project are listed too.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, run, closeOverlay, props, window as appWindow, theme, layout, notify, exec } from "herdr";
import { roots, depth } from "./config.js";
import { scanProjects, observeRunning, probe } from "./observe.js";
import { KINDS, match, order, conflict, freePort, startArgv, url, ago, summary, basename } from "./parse.js";

const RESCAN = 5 * 60 * 1000; // the folders change rarely; a header button rescans now
const STARTING = 30 * 1000; // how long a just-started project hides its Start button before it is seen running

// The layout blocks that show this mod, each with whether it or an ancestor is hidden.
function blocks(node, hiddenAbove = false, out = []) {
  if (!node) return out;
  const hidden = hiddenAbove || Boolean(node.hidden);
  if (node.type === "block" && node.content?.mod === "previews") out.push({ id: node.id, hidden });
  for (const child of node.children ?? []) blocks(child, hidden, out);
  return out;
}

const inside = (dir, folder) => Boolean(folder) && (dir === folder || dir.startsWith(folder.replace(/\/+$/, "") + "/") || folder.startsWith(dir + "/"));

export default class Previews extends View {
  init(p, cx) {
    this.big = Boolean(p?.big ?? props()?.big ?? props()?.overlay);
    this.projects = [];
    this.scannedAt = 0;
    this.live = { instances: [], sockets: [], at: 0 };
    this.probes = {}; // pid -> { ready, stories, at }
    this.starting = {}; // dir -> when Start was pressed
    this.warned = new Set(); // duplicate sets already toasted
    this.hover = null;
    this.polling = false;
    this.again = false;
    this.stale = true;
    this.error = null;
    // Dormant while its block is hidden: the heartbeat checks a boolean and returns; the
    // first tick after it shows again catches up.
    cx.timer.every(10000, (cx) => { if (!this.visible()) return; if (this.stale || appWindow()?.active) this.poll(cx); });
    cx.timer.every(60000, (cx) => { if (this.visible()) this.poll(cx); });
    cx.timer.every(30000, (cx) => { if (this.visible()) cx.notify(); }); // uptimes move
    this.poll(cx);
  }

  visible() {
    if (this.big) return true;
    const mine = blocks(layout());
    return mine.length === 0 || mine.some((b) => !b.hidden);
  }
  myBlock() { return blocks(layout()).find((b) => !b.hidden)?.id ?? "previews"; }

  poll(cx, rescan = false) {
    if (this.polling) { this.again = this.again || rescan; return; }
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        if (rescan || Date.now() - this.scannedAt > RESCAN) { this.projects = await scanProjects(roots, depth); this.scannedAt = Date.now(); }
        this.live = await observeRunning();
        const within = (promise) => Promise.race([promise, new Promise((resolve) => cx.timer.after(3000, () => resolve(null)))]);
        const seen = new Set();
        for (const inst of this.live.instances) {
          seen.add(inst.pid);
          const was = this.probes[inst.pid];
          if (was?.ready && Date.now() - was.at < 60000) continue; // a serving one is re-asked once a minute (its story count), a building one every poll
          this.probes[inst.pid] = { ...(await probe(inst, within)), at: Date.now() };
        }
        for (const pid of Object.keys(this.probes)) if (!seen.has(+pid)) delete this.probes[pid];
        for (const p of this.projects) if (this.live.instances.some((i) => i.cwd && inside(i.cwd, p.dir))) delete this.starting[p.dir];
        this.warn();
        this.error = null;
      } catch (error) { this.error = String(error?.message ?? error); }
      this.stale = false;
      this.polling = false;
      cx.notify();
      if (this.again) { const again = this.again; this.again = false; this.poll(cx, again === true); }
    });
  }

  model() {
    const m = match(this.projects, this.live.instances);
    return { ...m, projects: order(m.projects, spaces().filter((s) => !s.machine).map((s) => s.folder)) };
  }

  // One toast per set of servers that serve the same project, the first time it is seen.
  warn() {
    for (const p of match(this.projects, this.live.instances).projects) {
      if (p.running.length < 2) continue;
      const key = `${p.dir}:${p.running.map((i) => i.pid).sort((a, b) => a - b).join(",")}`;
      if (this.warned.has(key)) continue;
      this.warned.add(key);
      notify({ title: `${p.running.length} Storybooks serve ${p.name}`, body: `${p.running.map((i) => `pid ${i.pid} on :${i.port}`).join(", ")}. Stop the extras from Previews.`, level: "warning", action: { name: "mod.open", args: { name: "previews" } } });
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────

  // A new tab in the project's space (or the current one) running its storybook script,
  // on its own port when free, else the next free one.
  start(p, cx) {
    const port = freePort(p.port, new Set(this.live.sockets.map((s) => s.port)));
    const space = spaces().find((s) => !s.machine && inside(p.dir, s.folder));
    if (space && !space.active) run("space.select", { id: space.id });
    run("terminal.open", { argv: startArgv(p, port), folder: p.dir, place: "tab" });
    this.starting[p.dir] = Date.now();
    cx.notify();
  }
  stop(inst, cx) {
    cx.spawn(async (cx) => {
      try { await exec("kill", ["-TERM", String(inst.pid)]); } catch (error) { this.error = String(error?.message ?? error); }
      await new Promise((resolve) => cx.timer.after(800, resolve));
      this.poll(cx);
    });
  }
  open(inst, cx) { cx.open_url(url(inst.host, inst.port)); }

  // ── drawing ───────────────────────────────────────────────────────────────

  button(t, id, glyph, tip, act, warn = false) {
    const color = warn ? t.blocked : t.muted;
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_size(12).text_color(color).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(warn ? t.blocked : t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => act(cx)).child(glyph);
  }

  dot(t, state) {
    const color = { duplicate: t.blocked, ready: t.done, starting: t.working, stopped: t.dim }[state];
    const el = div().size(7).flex_none().rounded(4);
    if (state === "stopped") return el.border(1.5).border_color(t.dim);
    if (state === "starting") return el.bg(color).loop("opacity", { from: 0.3, to: 1, period: 700 });
    return el.bg(color);
  }

  projectRow(p, t, now) {
    const inst = p.running[0];
    const pr = inst ? this.probes[inst.pid] : null;
    const dup = p.running.length > 1;
    const starting = !inst && this.starting[p.dir] != null && now - this.starting[p.dir] < STARTING;
    const state = dup ? "duplicate" : inst ? (pr?.ready ? "ready" : "starting") : starting ? "starting" : "stopped";
    const con = conflict(p, this.live.sockets, this.live.instances);
    const taken = new Set(this.live.sockets.map((s) => s.port));
    const port = inst?.port ?? (con ? freePort(p.port, taken) : p.port);
    const detail = inst
      ? [dup ? `${p.running.length} running` : pr?.stories != null ? `${pr.stories} stories` : state === "starting" ? "starting…" : "serving", ago(inst.elapsed)].join(" · ")
      : starting ? "starting…" : con ? `:${con.port} busy (${con.by}), would use :${port}` : p.version ? `Storybook ${p.version}` : p.command ? "Storybook" : "no storybook script";
    const acts = [];
    if (inst) {
      acts.push(this.button(t, `open-${p.dir}`, "↗", `Open ${url(inst.host, inst.port)}`, (cx) => this.open(inst, cx)));
      for (const i of p.running) acts.push(this.button(t, `stop-${i.pid}`, "■", `Stop pid ${i.pid} (:${i.port}, ${ago(i.elapsed)})`, (cx) => this.stop(i, cx), dup));
    } else if (!starting) acts.push(this.button(t, `start-${p.dir}`, "▶", `Start in a tab: ${startArgv(p, port).join(" ")}`, (cx) => this.start(p, cx)));
    const space = spaces().find((s) => !s.machine && inside(p.dir, s.folder));
    const hovered = this.hover === p.dir;
    let el = v_flex().id(`pv-${p.dir}`).px(6).pt(3).pb(4).flex_none().rounded(7).hover((s) => s.bg(t.hover))
      .tooltip(`${p.dir}\n${p.command ?? "no storybook script"}${inst ? `\npid ${inst.pid}` : ""}${space ? "\nclick: show its space" : ""}`)
      .on_hover((on, cx) => { const was = this.hover; this.hover = on ? p.dir : this.hover === p.dir ? null : this.hover; if (was !== this.hover) cx.notify(); });
    if (space) el = el.cursor_pointer().on_click(() => run("space.select", { id: space.id }));
    el = el.child(h_flex().items_center().gap(7).text_size(12.5).h(22)
      .child(this.dot(t, state))
      .child(div().flex_1().min_w(0).truncate().when(Boolean(inst), (e) => e.font_semibold()).child(p.name))
      .when(!hovered && !this.big && !dup, (e) => e.child(div().flex_none().text_size(11).text_color(inst ? t.foreground : t.dim).child(`:${port}`)))
      .when(hovered || this.big || dup, (e) => e.child(h_flex().gap(2).flex_none().children(acts))))
      .child(div().pl(14).text_size(11).text_color(t.dim).truncate().child(`${p.label} · ${detail}`));
    if (this.big) el = el.child(div().pl(14).text_size(10.5).text_color(t.dim).truncate().child(`${inst ? `pid ${inst.pid} · ${url(inst.host, inst.port)}` : `:${port}`} · ${p.manager}${p.command ? ` · ${p.command}` : ""}`));
    return el;
  }

  strayRow(i, t) {
    const pr = this.probes[i.pid];
    const where = i.cwd ? basename(i.cwd) : "unknown folder";
    const acts = [this.button(t, `open-${i.pid}`, "↗", `Open ${url(i.host, i.port)}`, (cx) => this.open(i, cx)), this.button(t, `stop-${i.pid}`, "■", `Stop pid ${i.pid}`, (cx) => this.stop(i, cx))];
    const hovered = this.hover === `pid${i.pid}`;
    return v_flex().id(`stray-${i.pid}`).px(6).pt(3).pb(4).flex_none().rounded(7).hover((s) => s.bg(t.hover)).tooltip(`${i.cwd ?? "cwd unreadable"}\n${i.args}`)
      .on_hover((on, cx) => { const k = `pid${i.pid}`; const was = this.hover; this.hover = on ? k : this.hover === k ? null : this.hover; if (was !== this.hover) cx.notify(); })
      .child(h_flex().items_center().gap(7).text_size(12.5).h(22)
        .child(this.dot(t, pr?.ready ? "ready" : "starting"))
        .child(div().flex_1().min_w(0).truncate().child(`${KINDS[i.kind].label} · ${where}`))
        .when(!hovered && !this.big, (e) => e.child(div().flex_none().text_size(11).child(`:${i.port}`)))
        .when(hovered || this.big, (e) => e.child(h_flex().gap(2).flex_none().children(acts))))
      .child(div().pl(14).text_size(11).text_color(t.dim).truncate().child(`${i.cwd ?? `pid ${i.pid}`} · ${pr?.stories != null ? `${pr.stories} stories · ` : ""}${ago(i.elapsed)}`));
  }

  render() {
    const t = theme();
    const now = Date.now();
    const m = this.model();
    const sum = summary(m);
    const rows = m.projects.map((p) => this.projectRow(p, t, now));
    if (m.strays.length) {
      rows.push(div().px(6).pt(8).pb(2).text_size(10.5).text_color(t.dim).child("Also running"));
      for (const i of m.strays) rows.push(this.strayRow(i, t));
    }
    if (!rows.length) rows.push(div().px(6).py(8).text_size(11.5).text_color(t.dim).child(this.scannedAt ? `No .storybook under ${roots.join(", ")}` : "Looking for Storybooks…"));
    const open = () => run("mod.open", { name: "previews" });
    const close = () => { const id = props()?.overlay; id ? closeOverlay(String(id)) : run("mod.open", { name: "previews" }); };
    const dot = (color, n, tip) => h_flex().gap(3).items_center().tooltip(tip).child(div().size(6).rounded(3).bg(color)).child(String(n));
    const scanned = this.scannedAt ? `scanned ${ago((now - this.scannedAt) / 1000)} ago` : "scanning…";
    return v_flex().size_full().min_h(0).min_w(0).bg(this.big ? t.surface : t.chrome).text_size(13).text_color(t.foreground).overflow_hidden()
      .child(h_flex().h(31).pl(this.big ? 14 : 16).pr(8).flex_none().items_center().gap(8).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().truncate().child("Previews"))
        .when(sum.running > 0, (el) => el.child(dot(t.done, sum.running, "preview servers running")))
        .when(sum.duplicates.length > 0, (el) => el.child(dot(t.blocked, sum.duplicates.length, "projects served twice")))
        .child(this.button(t, "previews-rescan", "↻", "Look for projects again", (cx) => this.poll(cx, true)))
        .when(!this.big, (el) => el.child(this.button(t, "previews-open", "⤢", "Open Previews in a window", open))
          .child(this.button(t, "previews-hide", "–", "Put Previews away (layout.toggle brings it back)", () => run("layout.hide", { id: this.myBlock() }))))
        .when(this.big, (el) => el.child(this.button(t, "previews-close", svg("mods/pane/close.svg").size(12), "Close", close))))
      .child(v_flex().id("previews-list").flex_1().min_h(0).px(6).pb(8).overflow_y_scrollbar().mode("always").children(rows))
      .child(h_flex().h(22).px(this.big ? 14 : 12).flex_none().items_center().text_size(10.5).text_color(this.error ? t.blocked : t.dim).border_t(1).border_color(t.border)
        .child(div().flex_1().truncate().child(this.error ?? `${sum.projects} projects · ${sum.running} running · ${scanned}`)));
  }
}
