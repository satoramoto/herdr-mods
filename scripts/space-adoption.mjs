// Instrument a personal clone of the shipped Spaces mod; fail on upstream
// structure changes instead of applying a partial/guessed mutation.
export function withSessionDrops(source) {
  if (source.includes('from "./space-drop.js"')) return source;
  const change = (before, after) => {
    if (source.split(before).length !== 2) throw new Error("Spaces integration changed upstream; original clone retained. Manual adaptation required.");
    source = source.replace(before, after);
  };
  source = 'import { clearSessionDrag, sessionDragOver, sessionDropActive, dropSession } from "./space-drop.js";\n' + source;
  change('      .on_mouse_down("left", () => {\n        this.pressed = i;',
    '      .when(sessionDropActive(w), el => el.border(1).border_color(t.accent).bg(t.hover))\n      .on_mouse_down("left", () => {\n        clearSessionDrag();\n        this.pressed = i;');
  change('      .on_mouse_move((_e, cx) => {\n        const source = spaces()[this.pressed];',
    '      .on_mouse_move((_e, cx) => {\n        sessionDragOver(w, _e);\n        const source = spaces()[this.pressed];');
  change('      .on_mouse_up("left", (_e, cx) => {\n        const from = this.pressed;',
    '      .on_mouse_up("left", (_e, cx) => {\n        if (dropSession(w, _e, cx)) { this.pressed = null; this.over = null; return; }\n        const from = this.pressed;');
  change('      .on_click(() => run("space.select", { id: w.id }))\n      .child(div().text_color',
    '      .on_mouse_down("left", () => clearSessionDrag())\n      .on_mouse_move(event => sessionDragOver(w, event))\n      .on_mouse_up("left", (event, cx) => dropSession(w, event, cx))\n      .when(sessionDropActive(w), el => el.bg(t.hover).border(1).border_color(t.accent))\n      .on_click(() => run("space.select", { id: w.id }))\n      .child(div().text_color');
  change('        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })',
    '        .on_mouse_up("left", (_e, cx) => { this.pressed = null; clearSessionDrag(); cx.notify(); })');
  return source;
}
