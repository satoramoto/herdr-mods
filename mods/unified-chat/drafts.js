// Structured draft state is separate from text and delivery. Each terminal /
// native session retains its own attachments, shell mode, history and stashes.
const clone = (value) => JSON.parse(JSON.stringify(value));
export class RichDrafts {
  constructor(saved = {}) {
    this.entries = new Map(Object.entries(saved).filter(([, value]) => value && typeof value === "object"));
  }
  get(key) {
    if (!this.entries.has(key)) this.entries.set(key, { parts: [], mode: "normal", history: [], stashes: [] });
    const value = this.entries.get(key);
    for (const name of ["parts", "history", "stashes"]) if (!Array.isArray(value[name])) value[name] = [];
    return value;
  }
  attach(key, part) {
    if (!["skill", "agent", "file", "reference"].includes(part?.kind)) throw new Error("Invalid attachment.");
    const entry = this.get(key);
    if (entry.parts.some((item) => (item.uri ?? item.capture?.hash ?? `${item.kind}:${item.id}`) === (part.uri ?? part.capture?.hash ?? `${part.kind}:${part.id}`))) return;
    if (entry.parts.length >= 32) throw new Error("At most 32 attachments are allowed.");
    entry.parts.push(clone(part));
  }
  remove(key, index) { this.get(key).parts.splice(index, 1); }
  capture(key, text) { const entry = this.get(key); return clone({ text, parts: entry.parts, mode: entry.mode ?? "normal", ...(entry.selection ? { selection: entry.selection } : {}) }); }
  record(key, draft) { const entry = this.get(key); entry.history.push(clone(draft)); entry.history = entry.history.slice(-200); entry.cursor = null; }
  submitted(key, draft) {
    const entry = this.get(key);
    this.record(key, draft);
    entry.parts = []; entry.cursor = null;
    if (draft.mode === "shell") entry.mode = "normal";
  }
  restore(key, draft) { const entry = this.get(key); entry.parts = clone(draft.parts ?? []); entry.mode = draft.mode ?? "normal"; entry.selection = clone(draft.selection ?? null); return draft.text; }
  history(key, direction, current) {
    const entry = this.get(key);
    if (entry.cursor == null) { entry.cursor = entry.history.length; entry.unsent = clone(current); }
    entry.cursor = Math.max(0, Math.min(entry.history.length, entry.cursor + direction));
    return clone(entry.cursor === entry.history.length ? entry.unsent : entry.history[entry.cursor]);
  }
  stash(key, draft) { this.get(key).stashes.push(clone(draft)); this.get(key).parts = []; }
  pop(key) { return this.get(key).stashes.pop() ?? null; }
  snapshot() { return Object.fromEntries(this.entries); }
}
