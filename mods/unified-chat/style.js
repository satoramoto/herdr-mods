// Herdr's own vocabulary, written once and used by the chat bar and every panel it
// opens. Each atom is one recipe lifted from a shipped mod, so a theme swap, light
// or dark, carries through and the composer reads like the rest of the window.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";

export const RADIUS = 8;

// A card is drawn like a pane frame: background, the input border, accent while in use.
export const card = (el, t, on) => el.rounded(RADIUS).bg(t.background).border_1().border_color(on ? t.accent : t.input);
// A popover frame, as Herdr draws around its own overlays.
export const panel = (el, t) => el.rounded(RADIUS).bg(t.popover).border_1().border_color(t.border).shadow_md();
// A keycap-sized raised label (menu shortcuts, Ctrl+P).
export const chip = (el, t) => el.rounded(3).px(4).bg(t.raised);

// An overlay body, as the picker and the prompt dialog lay theirs out.
export const sheet = (el, t) => el.size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13).text_color(t.foreground);
// Its title row: the name at 15 semibold, a dim hint (Esc) at the right.
export const heading = (t, title, hint = "Esc") => h_flex().flex_none().items_center().gap(10)
  .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(title))
  .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)));
// A search field: Herdr's input frame (36px, 9px corners, accent border) around an Input element.
export const field = (t, input, icon = "mods/workspace-chrome/search.svg") => h_flex().h(36).flex_none().px(10).gap(8).items_center()
  .rounded(9).border_1().border_color(t.accent).bg(t.background)
  .when(Boolean(icon), (el) => el.child(svg(icon).size(15).flex_none().text_color(t.dim)))
  .child(input.flex_1().h_full().text_size(12.8).text_color(t.foreground));
// A list row: 32px, 7px corners, the selected one carries the hover fill.
export const option = (el, t, on) => el.px(10).h(32).rounded(7).gap(10).flex().items_center().cursor_pointer()
  .when(on, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover));
// A quiet explanatory line.
export const note = (t, text) => div().flex_none().text_size(11.5).text_color(t.dim).child(text);
// Dialog buttons: primary is solid ink on paper, the rest raised with the input border.
export const action = (el, t, primary = false) => el.h(32).px(14).flex_none().flex().items_center().rounded(RADIUS).border_1()
  .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
  .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88));

// A menu, as Herdr's context menu draws one: tight padding, 31px rows, 7px corners,
// the selected row on `selected`, a shortcut-sized dim label at the right.
export const menu = (el, t) => el.p(5).gap(0).bg(t.popover).text_size(12.8).text_color(t.foreground);
export const item = (el, t, on) => el.h(31).px(8).gap(9).rounded(7).flex().items_center().cursor_pointer()
  .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover));
export const divider = (t) => div().mx(7).my(4).h(1).flex_none().bg(t.border);
