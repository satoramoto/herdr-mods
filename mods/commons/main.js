// ScaleSpace Commons: the research repo and the pain stack as a festival campsite, drawn
// isometrically. Five track tents on the ridge with their swarm sites below, the Manuscript
// Hall, gallery, bandstand and observatory in the meadow, the Power Plant, depot, Lab Barn
// and APU in the yard. Agents are sims who stand where they work; git status is the weather.
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, terminals, theme, run, closeOverlay, props, window as appWindow, watchFolder, settings, layout } from "herdr";
import { repoPath, painRoot, painPort } from "./config.js";
import { observeRepo, observePain } from "./observe.js";
import { scene, order, district, relative, simName, seeded, HARNESS } from "./world.js";
import { project, box, tent, slab, blob, bounds, fit, origin, shade, mix, faces } from "./iso.js";

const RECENT = 10 * 60 * 1000;
const chrome = (name) => `mods/workspace-chrome/${name}.svg`;

// The layout blocks that show this mod, each with whether it or an ancestor is hidden.
function blocks(node, hiddenAbove = false, out = []) {
  if (!node) return out;
  const hidden = hiddenAbove || Boolean(node.hidden);
  if (node.type === "block" && node.content?.mod === "commons") out.push({ id: node.id, hidden });
  for (const child of node.children ?? []) blocks(child, hidden, out);
  return out;
}

// What each role is painted with, from the theme so light and dark both read.
function palette(t, stats) {
  return {
    "track-A": t.ansi3, "track-B": t.ansi2, "track-C": t.ansi4, "track-D": t.ansi5, "track-E": t.ansi1,
    hall: t.accent, press: t.ansi6, gallery: mix(t.ansi3, t.raised, 0.4), bandstand: mix(t.ansi3, t.raised, 0.7), mara: t.ansi5,
    observatory: mix(t.muted, t.raised, 0.4), board: t.ansi3, gate: t.muted,
    plant: stats.engine?.up ? (stats.engine.healthy === false ? mix(t.ansi1, t.muted, 0.5) : t.ansi5) : t.dim, chimney: t.muted,
    reactor: t.ansi6, barn: mix(t.ansi1, t.raised, 0.35), reservoir: t.ansi4,
    crate: t.raised, "crate-hot": t.accent, "jar-ok": t.ansi2, "jar-bad": t.ansi1, frame: t.foreground, popup: t.muted,
  };
}

export default class Commons extends View {
  init(p, cx) {
    this.big = Boolean(p?.big ?? props()?.big ?? props()?.overlay);
    this.repo = null;
    this.obs = null;
    this.pain = null;
    this.size = { width: 0, height: 0 };
    this.hover = null;
    this.polling = false;
    try { this.trails = JSON.parse(localStorage.getItem("commons.trails") ?? "{}"); } catch { this.trails = {}; }
    this.stale = true;
    // Dormant while its block is hidden: the heartbeat only checks a boolean, nothing runs,
    // nothing is exec'd, and the first tick after it shows again catches up.
    cx.timer.every(10000, (cx) => { if (!this.visible()) return; if (this.stale || appWindow()?.active) this.poll(cx, true); });
    cx.timer.every(60000, (cx) => { if (this.visible()) this.poll(cx, true); });
    cx.timer.every(30000, (cx) => { if (this.visible()) cx.notify(); }); // recency fades
    cx.spawn(async (cx) => {
      for (;;) {
        const repo = this.repo ?? repoPath;
        try { await watchFolder(repo); } catch { return; }
        if (this.visible()) this.poll(cx, false); else this.stale = true;
      }
    });
    this.poll(cx, true);
  }

  // Drawn somewhere: the window copy always (closing it ends the copy), a block copy
  // when at least one block showing this mod has no hidden ancestor.
  visible() {
    if (this.big) return true;
    const mine = blocks(layout());
    return mine.length === 0 || mine.some((b) => !b.hidden);
  }
  // The block to hide from the header: the first shown one.
  myBlock() { return blocks(layout()).find((b) => !b.hidden)?.id ?? "commons"; }

  // The research repo: a shown space's folder named like it, else the configured path.
  findRepo() {
    const base = repoPath.replace(/\/+$/, "").split("/").pop();
    const hit = spaces().find((s) => !s.machine && (s.folder === repoPath || s.folder?.replace(/\/+$/, "").split("/").pop() === base));
    return hit?.folder || repoPath;
  }

  poll(cx, withPain) {
    if (this.polling) { this.again = true; return; }
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        this.repo = this.findRepo();
        this.obs = await observeRepo(this.repo);
        if (withPain || !this.pain) {
          const within = (promise) => Promise.race([promise, new Promise((resolve) => cx.timer.after(4000, () => resolve(null)))]);
          this.pain = await observePain({ root: painRoot, port: painPort }, within);
        }
      } catch (error) { this.error = String(error?.message ?? error); }
      this.wear();
      this.stale = false;
      this.polling = false;
      cx.notify();
      if (this.again) { this.again = false; this.poll(cx, false); }
    });
  }

  // Every poll, the routes walked now wear a little deeper into the grass (kept across runs).
  // Routes nobody walks fade back into the grass, half a step a poll.
  wear() {
    if (!this.lastRoutes) return;
    const active = new Set(this.lastRoutes.map((r) => `${r.from}>${r.to}`));
    for (const k of Object.keys(this.trails)) if (!active.has(k)) { this.trails[k] -= 0.5; if (this.trails[k] <= 0) delete this.trails[k]; }
    for (const k of active) this.trails[k] = Math.min(40, (this.trails[k] ?? 0) + 1);
    try { localStorage.setItem("commons.trails", JSON.stringify(this.trails)); } catch {}
  }

  // Where each agent stands: the district of its folder, or of the newest file in the repo
  // when it is working there; outside the repo it waits at the gate.
  places(list, ps, now) {
    const where = {}, names = {};
    const tabs = spaces().flatMap((s) => s.tabs);
    const newest = this.obs?.recent?.[0];
    for (const a of list) {
      names[a.address] = simName(a, tabs, ps);
      const pane = ps.find((p) => p.pane === a.pane);
      const rel = relative(pane?.cwd ?? null, this.repo ?? repoPath);
      if (rel === null) { where[a.address] = "gate"; continue; }
      const fresh = newest && now - newest.at * 1000 < RECENT;
      where[a.address] = a.status === "working" && fresh ? district(newest.path) : rel === "" ? "hall" : district(rel + "/");
    }
    return { where, names };
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  fill(points, color, opacity) {
    const el = window.paint_path(PathBuilder.fill().add_polygon(points, true).build(), color).absolute().left(0).top(0).size_full();
    return opacity == null ? el : el.opacity(opacity);
  }
  stroke(points, color, closed, dashed, opacity) {
    let b = PathBuilder.stroke(1);
    if (dashed) b = b.dash_array([3, 3]);
    const el = window.paint_path(b.add_polygon(points, closed).build(), color).absolute().left(0).top(0).size_full();
    return opacity == null ? el : el.opacity(opacity);
  }

  thing(th, t, colors, g, lit) {
    const { u, ox, oy } = g;
    const color = colors[th.role] ?? t.muted;
    const f = faces(lit ? shade(color, 0.18) : color);
    const out = [];
    if (th.kind === "tent") {
      const s = tent(th.x, th.y, th.w, th.d, th.h, u, ox, oy);
      out.push(this.fill(slab(th.x, th.y, th.w, th.d, u, ox, oy), shade(color, -0.45), 0.5), this.fill(s.left, f.left), this.fill(s.right, f.right));
      return out;
    }
    if (th.kind === "water") {
      const b = box(th.x, th.y, th.w, th.d, th.h, u, ox, oy);
      out.push(this.fill(b.left, f.right), this.fill(b.right, f.right), this.fill(b.top, color, 0.85).loop("opacity", { from: 0.7, to: 0.95, period: 2600 }));
      return out;
    }
    if (th.state === "planned") {
      const b = box(th.x, th.y, th.w, th.d, 2.2, u, ox, oy);
      out.push(this.fill(slab(th.x, th.y, th.w, th.d, u, ox, oy), shade(color, -0.2), 0.45));
      out.push(this.stroke(b.top, t.dim, true, true, 0.6), this.stroke(b.left, t.dim, true, true, 0.6), this.stroke(b.right, t.dim, true, true, 0.6));
      return out;
    }
    const b = box(th.x, th.y, th.w, th.d, th.h, u, ox, oy);
    out.push(this.fill(b.left, f.left), this.fill(b.right, f.right), this.fill(b.top, f.top));
    if (th.erratum) {
      const patch = slab(th.x + 0.2, th.y + 0.2, 0.45, 0.45, u, ox, oy - th.h * u / 2);
      out.push(this.fill(patch, shade(color, -0.55)));
    }
    if (th.state === "running") {
      const s = box(th.x, th.y, th.w, th.d, 2.2, u, ox, oy);
      out.push(this.stroke(s.top, t.foreground, true, true, 0.5), this.stroke(s.left, t.foreground, true, true, 0.5), this.stroke(s.right, t.foreground, true, true, 0.5));
      const [sx, sy] = project(th.x + th.w / 2, th.y + th.d / 2, th.h + 0.3, u, ox, oy);
      out.push(div().absolute().left(sx - 2).top(sy - 2).size(4).rounded(2).bg(t.ansi3).loop("opacity", { from: 0.2, to: 1, period: 500 }));
    }
    if (th.state === "complete") {
      const [px, py] = project(th.x + th.w * 0.8, th.y + th.d * 0.2, th.h, u, ox, oy);
      const top = py - u * 0.55;
      out.push(this.stroke([[px, py], [px, top]], t.foreground, false, false, 0.8));
      out.push(this.fill([[px, top], [px + u * 0.35, top + u * 0.12], [px, top + u * 0.24]], colors[th.role] ?? t.accent));
    }
    return out;
  }

  // A hit target over a thing: its tooltip, hover light, and for a swarm or doc, where it opens.
  target(th, g, id) {
    const { u, ox, oy } = g;
    const polys = th.kind === "tent" ? Object.values(tent(th.x, th.y, th.w, th.d, th.h, u, ox, oy)) : Object.values(box(th.x, th.y, th.w, th.d, Math.max(th.h, 0.3), u, ox, oy));
    const r = bounds(polys);
    return div().id(`hit-${id}`).absolute().left(r.x).top(r.y).w(Math.max(r.w, 6)).h(Math.max(r.h, 6)).tooltip(th.tip)
      .on_hover((on, cx) => { const was = this.hover; this.hover = on ? th.id : (this.hover === th.id ? null : this.hover); if (was !== this.hover) cx.notify(); });
  }

  // A creature: an agent (a figure), a sub-agent (a smaller one circling), a carrier ant
  // (a dot with its load), the truck, the tech, the duck, a crow. Motion is native: a route
  // swings left/top between two ends; an orbit or a wander uses two periods, so the path
  // is a loop or a figure the eye can't predict.
  sim(s, t, g, colors) {
    const { u, ox, oy } = g;
    const [px, py] = project(s.x, s.y, s.z ?? 0, u, ox, oy);
    const r = seeded(s.id);
    const scale = s.kind === "agent" || s.kind === "tech" ? 1 : s.kind === "sub" ? 0.62 : 0.5;
    const head = Math.max(2, u * 0.42 * scale), body = Math.max(3, u * 0.6 * scale), w = Math.max(2, u * 0.42 * scale);
    const color = s.kind === "tech" ? t.muted : s.kind === "duck" ? shade(t.foreground, 0.2) : s.kind === "crow" ? shade(t.foreground, -0.6) : s.kind === "truck" ? colors["crate-hot"] : s.kind === "carrier" ? t.foreground : (t[HARNESS[s.app]] ?? t.muted);
    const tall = body + head;
    let el = div().id(`sim-${s.id}`).absolute().left(px - w / 2).top(py - tall).w(w).h(tall).cursor_pointer()
      .tooltip(`${s.name}${s.status ? `\n${s.status}` : ""} · ${s.district.replace(/^swarm-/, "swarm ").replace(/^track-/, "track ")}`);
    if (s.pane) el = el.on_click(() => run("pane.focus", { pane: s.pane }));
    else if (s.parent) el = el.on_click(() => run("terminal.peek", { terminal: s.address }));
    if (s.kind === "duck") {
      el = el.child(div().absolute().left(0).top(head * 0.4).w(w * 1.3).h(body * 0.7).rounded(body * 0.35).bg(color))
        .child(div().absolute().left(w * 0.9).top(0).size(head * 0.8).rounded(head * 0.4).bg(color))
        .child(div().absolute().left(w * 1.5).top(head * 0.3).w(head * 0.5).h(head * 0.3).rounded(1).bg(t.ansi3));
    } else if (s.kind === "crow") {
      el = el.child(div().absolute().left(0).top(head * 0.6).w(w * 1.6).h(Math.max(1, head * 0.25)).rounded(1).bg(color).loop("height", { from: Math.max(1, head * 0.2), to: Math.max(1, head * 0.5), period: 260 + r * 120, easing: "ease-in-out" }))
        .child(div().absolute().left(w * 0.5).top(head * 0.45).size(head * 0.5).rounded(head * 0.25).bg(color));
    } else if (s.kind === "truck") {
      const b = Math.max(3, u * 0.5);
      el = el.child(div().absolute().left(0).top(tall - b).size(b).rounded(1).bg(color)).child(div().absolute().left(-1).top(tall - 2).w(b + 2).h(2).rounded(1).bg(shade(t.foreground, -0.5)));
    } else if (s.kind === "carrier") {
      const load = colors[s.load] ?? t.accent;
      el = el.child(div().absolute().left(0).top(head).w(w).h(body).rounded(w / 2).bg(color).opacity(0.85))
        .child(div().absolute().left(-w * 0.2).top(0).w(w * 1.4).h(head).rounded(1).bg(load));
    } else {
      el = el.child(div().absolute().left(0).top(0).size(head).rounded(head / 2).bg(shade(color, 0.35)))
        .child(div().absolute().left(0).top(head - 1).w(w).h(body).rounded(Math.max(1, u * 0.1 * scale)).bg(color));
      if (s.status === "working" && !s.route) el = el.loop("top", { from: py - tall - Math.max(2, u * 0.2), to: py - tall, period: 480 });
      if (s.status === "blocked") el = el.child(div().absolute().left(w / 2 - 4).top(-head - 4).w(8).h(10).text_size(Math.max(8, u * 0.6)).font_bold().text_color(t.blocked).child("!"));
      if (s.status === "working" && s.kind === "agent") el = el.child(div().absolute().left(w + 1).top(head * 0.6).size(Math.max(2, u * 0.12)).rounded(2).bg(t.ansi3).loop("opacity", { from: 0.1, to: 1, period: 300 + r * 200 }));
    }
    if (s.route) {
      const [qx, qy] = project(s.route.to.x, s.route.to.y, s.z ?? 0, u, ox, oy);
      el = el.loop("left", { from: px - w / 2, to: qx - w / 2, period: s.route.period, easing: "ease-in-out" }).loop("top", { from: py - tall, to: qy - tall, period: s.route.period, easing: "ease-in-out" });
    } else if (s.orbit) {
      const ax = s.orbit.rx * u, ay = s.orbit.ry * u / 2;
      el = el.loop("left", { from: px - w / 2 - ax, to: px - w / 2 + ax, period: s.orbit.period, easing: "ease-in-out" }).loop("top", { from: py - tall - ay, to: py - tall + ay, period: s.orbit.period * 0.53, easing: "ease-in-out" });
    } else if (s.wander) {
      const ax = s.wander.rx * u, ay = s.wander.ry * u / 2;
      el = el.loop("left", { from: px - w / 2 - ax, to: px - w / 2 + ax, period: s.wander.px, easing: "ease-in-out" }).loop("top", { from: py - tall - ay, to: py - tall + ay, period: s.wander.py, easing: "ease-in-out" });
    } else if (s.sway) {
      el = el.loop("left", { from: px - w / 2 - s.sway.dx * u, to: px - w / 2 + s.sway.dx * u, period: s.sway.period, easing: "ease-in-out" });
    }
    return el;
  }

  map(t, sc, W, H) {
    const colors = palette(t, sc.stats);
    const u = fit(sc.grid.gx, sc.grid.gy, sc.grid.hmax, W, H, 6);
    const [ox, oy] = origin(sc.grid.gx, sc.grid.gy, sc.grid.hmax, u, W, H);
    const g = { u, ox, oy };
    const kids = [];
    const night = sc.phase === "night", dusk = sc.phase === "dusk";
    const dim = (c) => (night ? shade(c, -0.4) : dusk ? mix(c, t.ansi3, 0.12) : c);
    // Ground: the hill, a lighter meadow in the middle, the yard; then the trails worn in.
    kids.push(this.fill(slab(-0.5, -0.5, sc.grid.gx + 1, sc.grid.gy + 1, u, ox, oy), dim(mix(t.ansi2, t.surface, 0.72))));
    kids.push(this.fill(slab(3.5, 7.5, 7.5, 6, u, ox, oy), dim(mix(t.ansi2, t.surface, 0.62)), 0.9));
    kids.push(this.fill(slab(14.5, 1.5, 3.5, 12, u, ox, oy), dim(mix(t.muted, t.surface, 0.75)), 0.9));
    for (const tr of sc.trails) kids.push(this.stroke([project(tr.from.x, tr.from.y, 0, u, ox, oy), project(tr.to.x, tr.to.y, 0, u, ox, oy)], mix(t.ansi3, t.foreground, 0.4), false, false, Math.min(0.7, 0.22 + tr.weight * 0.03)));
    this.lastRoutes = sc.routes;
    for (const c of sc.cables) kids.push(this.stroke([project(c.from.x, c.from.y, 0, u, ox, oy), project(c.to.x, c.to.y, 0, u, ox, oy)], t.dim, false, true, 0.6));
    const things = sc.things.slice().sort(order);
    for (const th of things) {
      kids.push(...this.thing(th, t, colors, g, this.hover === th.id));
      // Lit windows after dark on anything with a wall to put them in.
      if (night && th.kind === "box" && th.h >= 1 && th.w >= 1 && th.state !== "planned") {
        const n = Math.min(3, Math.floor(th.w * 1.5));
        for (let i = 0; i < n; i++) {
          const [wx, wy] = project(th.x + (i + 0.5) * th.w / n, th.y + th.d, th.h * 0.55, u, ox, oy);
          kids.push(div().absolute().left(wx - 1).top(wy).w(Math.max(2, u * 0.16)).h(Math.max(2, u * 0.2)).bg(t.ansi3).opacity(0.85).when(seeded(th.id + i) > 0.6, (el) => el.loop("opacity", { from: 0.3, to: 0.9, period: 1500 + seeded(th.id) * 2000 })));
        }
      }
    }
    // String lights along the ridge come on at dusk.
    if (night || dusk) for (let i = 0; i <= 24; i++) {
      const [lx, ly] = project(1 + i * (12 / 24), 2.6, 1.6 + 0.25 * Math.sin(i * 1.1), u, ox, oy);
      kids.push(div().absolute().left(lx - 1).top(ly - 1).size(Math.max(2, u * 0.12)).rounded(2).bg([t.ansi3, t.ansi1, t.ansi4, t.ansi2][i % 4]).loop("opacity", { from: 0.35, to: 1, period: 900 + (i % 5) * 180 }));
    }
    // A ring where a file changed moments ago.
    for (const f of sc.flashes) {
      const [fx, fy] = project(f.at.x + f.at.w / 2, f.at.y + f.at.d / 2, 0, u, ox, oy);
      const rr = u * 1.4;
      kids.push(div().absolute().left(fx - rr / 2).top(fy - rr / 4).w(rr).h(rr / 2).rounded(rr / 2).border(1).border_color(t.ansi3).loop("opacity", { from: 0.9, to: 0, period: 1200, easing: "ease-out" }).loop("width", { from: rr * 0.3, to: rr, period: 1200, easing: "ease-out" }));
    }
    // Smoke and the APU's glow when a model is loaded; the dome and the observatory's.
    const loaded = sc.stats.loaded.length > 0 && sc.stats.engine?.up;
    const puffs = loaded ? Math.min(3, 1 + Math.floor((sc.stats.gpu ?? 0) / 35)) : 0;
    const [cx0, cy0] = project(16.62, 2.42, 4.3, u, ox, oy);
    for (let i = 0; i < puffs; i++) {
      const r = u * (0.35 + i * 0.18);
      kids.push(div().absolute().left(cx0 - r / 2 + i * u * 0.25).top(cy0 - r - i * u * 0.5).size(r).rounded(r / 2).bg(t.muted)
        .loop("opacity", { from: 0.15, to: 0.6, period: Math.max(500, 1400 - (sc.stats.gpu ?? 0) * 8) + i * 300 }).loop("top", { from: cy0 - r - i * u * 0.5 - u * 0.3, to: cy0 - r - i * u * 0.5, period: Math.max(600, 1800 - (sc.stats.gpu ?? 0) * 10) + i * 200 }));
    }
    const [rx, ry] = project(13.5, 8, 1.4, u, ox, oy);
    const dome = u * 1.3;
    kids.push(div().absolute().left(rx - dome / 2).top(ry - dome * 0.7).size(dome).rounded(dome / 2).bg(colors.reactor).when(loaded, (el) => el.loop("opacity", { from: 0.55, to: 1, period: 1600 })).when(!loaded, (el) => el.opacity(0.75)));
    const [obx, oby] = project(1.5, 12, 2.8, u, ox, oy);
    const od = u * 1.1;
    kids.push(div().absolute().left(obx - od / 2).top(oby - od * 0.65).size(od).rounded(od / 2).bg(shade(colors.observatory, 0.15)));
    for (const c of sc.clouds) {
      const [px, py] = project(c.over.x + c.over.w / 2, c.over.y + c.over.d / 2, 3.4, u, ox, oy);
      const r = u * (0.8 + 0.15 * Math.min(c.count, 6));
      kids.push(this.fill(blob(px, py, r, r * 0.45), t.dim, 0.5).tooltip(`${c.count} modified near ${c.district}`));
    }
    for (const s of sc.sims) kids.push(this.sim(s, t, g, colors));
    for (const th of things) if (th.tip) kids.push(this.target(th, g, th.id));
    if (this.big) for (const th of things) if (th.label) {
      const [lx, ly] = project(th.x + th.w / 2, th.y + th.d / 2, th.h + (th.id === "observatory" || th.id === "reactor" ? 2 : 0.9), u, ox, oy);
      kids.push(div().absolute().left(lx - 60).top(ly - 8).w(120).text_size(10).text_color(t.muted).flex().justify_center().whitespace_nowrap().child(th.label));
    }
    return kids;
  }

  render() {
    const t = theme();
    const now = Date.now();
    const list = agents(), ps = panes();
    const { where, names } = this.places(list, ps, now);
    const sc = scene({ ...(this.obs ?? {}), pain: this.pain ?? {} }, { agents: list, terminals: terminals(), where, names, now, trails: this.trails, hour: new Date(now).getHours() });
    const W = this.size.width || (this.big ? 900 : 250), H = this.size.height || (this.big ? 600 : 320);
    // The window is the overlay mod.json describes, so `mod.open commons` (a key, the palette) opens it too.
    const open = () => run("mod.open", { name: "commons" });
    const close = () => { const id = props()?.overlay; id ? closeOverlay(String(id)) : run("mod.open", { name: "commons" }); };
    const button = (id, glyph, tip, act) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(6).text_size(13).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(act).child(glyph);
    const dot = (color, n, tip) => h_flex().gap(3).items_center().tooltip(tip).child(div().size(6).rounded(3).bg(color)).child(String(n));
    return v_flex().size_full().min_h(0).min_w(0).bg(this.big ? t.surface : t.chrome).text_size(13).text_color(t.foreground).overflow_hidden()
      .child(h_flex().h(31).pl(this.big ? 14 : 16).pr(8).flex_none().items_center().gap(8).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().truncate().child(this.big ? "ScaleSpace Commons" : "Commons"))
        .when(sc.stats.working > 0, (el) => el.child(dot(t.working, sc.stats.working, "agents building")))
        .when(sc.stats.blocked > 0, (el) => el.child(dot(t.blocked, sc.stats.blocked, "agents waiting for you")))
        .when(sc.stats.modified + sc.stats.untracked > 0, (el) => el.child(dot(t.muted, sc.stats.modified + sc.stats.untracked, "uncommitted files")))
        .child(div().text_color(t.dim).tooltip("creatures about").child(`${sc.stats.ants} about`))
        .when(!this.big, (el) => el.child(button("commons-open", "⤢", "Open the Commons in a window", open))
          .child(button("commons-hide", "–", "Put the Commons away (layout.toggle brings it back)", () => run("layout.hide", { id: this.myBlock() }))))
        .when(this.big, (el) => el.child(button("commons-close", svg("mods/pane/close.svg").size(12), "Close", close))))
      .child(div().id("commons-map").flex_1().min_h(0).relative().overflow_hidden()
        .on_size_change((size, cx) => { const z = Number(settings()?.zoom) || 1; const next = { width: size.width / z, height: size.height / z }; if (Math.abs(next.width - this.size.width) > 1 || Math.abs(next.height - this.size.height) > 1) { this.size = next; cx.notify(); } })
        .children(this.map(t, sc, W, H)))
      .child(h_flex().h(22).px(this.big ? 14 : 12).flex_none().items_center().text_size(10.5).text_color(t.dim).border_t(1).border_color(t.border)
        .child(div().flex_1().truncate().frames(sc.ticker.length ? sc.ticker : ["Looking around…"], 4000)));
  }
}
