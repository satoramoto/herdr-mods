// A session being dragged out of the All sessions window, carried in shared state so a
// space row in the sidebar (mods/fold) can take the drop. Keys are the contract.
export const DRAG_KEY = "sessions.drag";
export const TARGET_KEY = "sessions.drag-target";
export function startDrag(row, position, now = Date.now(), owner = "sessions") {
  if (!row?.key || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return null;
  return { key: row.key, owner, at: now, origin: position,
    expected: { terminal: row.connected ? row.terminal : null, created: row.connected ? row.terminalCreated : null } };
}
export function dragMoved(payload, position, now = Date.now()) {
  return Boolean(payload?.key && Number.isFinite(payload.at) && now >= payload.at && now - payload.at <= 15000
    && Number.isFinite(payload.origin?.x) && Number.isFinite(payload.origin?.y)
    && Number.isFinite(position?.x) && Number.isFinite(position?.y)
    && Math.hypot(position.x - payload.origin.x, position.y - payload.origin.y) >= 6);
}
export function canDrop(payload, target, position, now = Date.now()) {
  return Boolean(target?.id && !target.machine && dragMoved(payload, position, now));
}
