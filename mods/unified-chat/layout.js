// One flat prompt (editor + metadata) and a quiet shortcut footer.
export const COMPOSER_HEIGHT = 140;
export const EXPANDED_HEIGHT = 256;
export const QUEUE_HEIGHT = 108;

function find(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Upgrade only the composer's height constraints, leaving personal layout edits.
export function fitComposerLayout(layout) {
  const work = find(layout, "work");
  if (!work?.children) throw new Error("The personal layout changed; refusing to replace its structure.");
  let bar = find(layout, "unified-chat-bar");
  if (!bar) {
    const statusIndex = work.children.findIndex((node) => node.id === "status");
    bar = { id: "unified-chat-bar", type: "block", content: { mod: "unified-chat" } };
    work.children.splice(statusIndex < 0 ? work.children.length : statusIndex, 0, bar);
  }
  if (bar.type !== "block" || bar.content?.mod !== "unified-chat") {
    throw new Error("unified-chat-bar is used by different content; refusing to replace it.");
  }
  // Migrate our previous default, while keeping deliberately larger allocations.
  if (bar.min === 174) bar.min = COMPOSER_HEIGHT;
  if (bar.size?.px === 174) bar.size.px = COMPOSER_HEIGHT;
  bar.min = Math.max(bar.min ?? 0, COMPOSER_HEIGHT);
  bar.max = Math.max(bar.max ?? 0, bar.min, EXPANDED_HEIGHT + 33 + 26);
  if (!bar.size || "px" in bar.size) {
    bar.size = { ...bar.size, px: Math.max(bar.size?.px ?? 0, bar.min) };
    bar.max = Math.max(bar.max, bar.size.px);
  }
  return bar;
}
