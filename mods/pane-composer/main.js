// The pane header of the unified-chat layout: the shipped `pane` header (icon, name,
// folder, status; split, zoom and close on hover) with a composer switch in the hover
// cluster that says which composer owns this terminal's input.
//   Unified: Herdr's chat bar is the input; a Claude Code terminal blanks the hint
//            line under its own prompt (adapters/claude/herdr-composer).
//   Harness: the agent's native prompt is the input; the chat bar is hidden while
//            this terminal has the focus. Nothing shows at rest: the switch, one word
//            naming the current composer, appears with the hover buttons; a click flips it.
// The choice is per terminal, kept in the shared value `unified-chat.composer`, and
// mirrored to ~/.local/state/unified-chat/composer/<terminal>.json for Claude.
// The bar follows the window's actual focus (`focused()`, the terminal the bar would
// talk to): the focused terminal's header runs layout.show/hide once per change of
// (terminal, mode). The pane flag `focused` is per tab and every tab's headers stay
// alive, so it is not the signal; the window's focus is.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, shared, setShared, readTextFile, writeTextFile, exec, nextCommand, focused } from "herdr";
import { MODES, SHARED_KEY, BAR_ID, composerMode, withMode, stateFilePath, stateDirectory, stateFileText, barCommand, barKey, barTarget } from "./composer-mode.js";


const LABELS = { unified: "Unified", harness: "Harness" };
// The (terminal, mode) pair this header copy last reconciled the bar for.
let appliedKey = null;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// Mirror the choice for the Claude Code mod. Best effort: a terminal that is not
// Claude, or sits on another machine, has nobody reading the file.
async function writeState(address, mode) {
  const path = stateFilePath(home(), address);
  if (!path) return;
  await exec("mkdir", ["-p", stateDirectory(home())]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readTextFile(path);
    try { await writeTextFile(path, stateFileText(mode), current); return; } catch { /* stale snapshot: read again */ }
  }
}

// Bring the composer bar in line with the focused terminal's choice. Only the focused
// terminal's own header acts (module state is per header copy, so a shared memo is not
// available), once per change of (terminal, mode); the command goes out in a task, after
// the frame, since render is not a place for host calls.
function reconcileBar(p, cx) {
  const f = focused();
  const target = barTarget(f);
  if (!target || !p.terminal || (p.terminal !== target && p.terminal !== f.terminal)) return;
  const key = barKey(f, shared(SHARED_KEY));
  if (key === appliedKey) return;
  appliedKey = key;
  const command = barCommand(composerMode(shared(SHARED_KEY), target));
  cx.spawn(async () => {
    try { run(command, { id: BAR_ID }); } catch { appliedKey = null; }
  });
}

export default class PaneComposer extends View {
  init(_initial, cx) {
    this.hovered = false;
    // `herdr-app do pane-composer.toggle|unified|harness` (or a keys.json binding) acts on
    // the focused terminal's header; the other copies ignore it.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const p = this.me();
        if (!p?.terminal || p.terminal !== barTarget(focused())) continue;
        const current = composerMode(shared(SHARED_KEY), p.terminal);
        const wanted = command === "toggle" ? (current === "unified" ? "harness" : "unified") : MODES.includes(command) ? command : null;
        if (wanted && wanted !== current) { this.choose(p, wanted, cx); cx.notify(); }
      }
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-composer/${icon}.svg`).size(14));
  }

  choose(p, mode, cx) {
    const address = p.terminal;
    setShared(SHARED_KEY, withMode(shared(SHARED_KEY), address, mode));
    cx.spawn(async () => { try { await writeState(address, mode); } catch { /* the toggle still applies to Herdr */ } });
    // The bar follows the focus, so a choice made on an unfocused header brings the
    // focus here; the re-render that follows reconciles the bar.
    if (barTarget(focused()) !== address) run("pane.focus", { pane: p.pane });
    if (mode === "unified") run("unified-chat.focus");
  }

  // The switch: one word in the hover cluster, the current composer, drawn like its
  // icon buttons (dim at rest, highlighted under the pointer); a click flips it.
  toggle(t, p, mode) {
    const other = mode === "unified" ? "harness" : "unified";
    return div().id(`pane-composer-${p.pane}`).flex_none().px(6).py(3).rounded(4).text_size(11)
      .text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.choose(p, other, cx); cx.notify(); })
      .child(LABELS[mode]);
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const mode = p.terminal ? composerMode(shared(SHARED_KEY), p.terminal) : null;
    reconcileBar(p, cx);
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .when(mode != null, (el) => el.child(this.toggle(t, p, mode)))
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
