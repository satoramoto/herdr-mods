// The saved ledger is authoritative across view reloads. A lost acknowledgement
// is a FIFO barrier, not permission to send the next draft or retry this one.
export function restoreSubmissions(saved = {}) {
  return new Map(Object.entries(saved).map(([id, item]) => [id, {
    ...item, state: ["waiting", "withheld"].includes(item.state) ? "withheld" : "uncertain",
  }]));
}

export function admissionBlock(items, key, beforeID = null) {
  for (const item of items.values()) {
    if (item.id === beforeID) break;
    if (item.key === key) return item;
  }
  return null;
}

export async function admitInOrder({ items, item, previous, send }) {
  await previous;
  if (item.state === "withheld" || admissionBlock(items, item.key, item.id)) {
    item.state = "withheld";
    item.error = "Not submitted: an earlier admission needs review, or Stop was pressed.";
    return null;
  }
  item.state = "sending";
  try { return await send(); }
  catch (error) { item.state = "uncertain"; item.error = String(error.message ?? error); throw error; }
}
