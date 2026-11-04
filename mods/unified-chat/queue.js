import { decodeResult } from "./model.js";

export function messageBlock(target, text) {
  if (!target) return "Select an agent first.";
  if (!text.trim()) return "Write a message first.";
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return "Remove terminal control characters before sending.";
  return null;
}

export class Outbox {
  constructor(saved = {}) {
    this.queues = new Map();
    this.pending = new Map();
    for (const [key, queue] of Object.entries(saved)) {
      if (!queue || !Array.isArray(queue.items)) continue;
      const items = queue.items.filter((item) => item && typeof item.id === "string" && typeof item.text === "string")
        .map((item) => ({ ...item, state: item.state === "sending" ? "uncertain" : item.state ?? "queued" }));
      this.queues.set(key, {
        items, paused: items.length > 0 || Boolean(queue.paused), awaitingTurn: queue.awaitingTurn ?? null,
        reason: items.length ? "Restored queue. Check the terminal, then resume." : queue.reason ?? null,
      });
    }
  }

  get(key) {
    if (!this.queues.has(key)) this.queues.set(key, { items: [], paused: false, reason: null, awaitingTurn: null });
    return this.queues.get(key);
  }

  enqueue(target, text) {
    const blocked = messageBlock(target, text);
    if (blocked) throw new Error(blocked);
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text, state: "queued" };
    this.get(target.key).items.push(item);
    return item;
  }

  remove(key, id) {
    const queue = this.get(key);
    const item = queue.items.find((entry) => entry.id === id);
    if (item?.state === "sending") return false;
    queue.items = queue.items.filter((entry) => entry.id !== id);
    return true;
  }

  pause(key, reason = "Paused by you.") {
    const queue = this.get(key);
    queue.paused = true;
    queue.reason = reason;
  }

  resume(key) {
    const queue = this.get(key);
    if (queue.items.some((item) => item.state === "uncertain")) {
      throw new Error("Inspect the terminal and remove the uncertain delivery before resuming.");
    }
    queue.paused = false;
    queue.reason = null;
  }

  dispatch(targets) {
    const actions = [];
    for (const target of targets) {
      const queue = this.queues.get(target.key);
      if (!queue || queue.paused || this.pending.has(target.key) || !queue.items.length) continue;
      if (target.status !== "idle" && target.status !== "done") continue;
      // A stale idle repaint after submission is NOT a completed turn. Core's
      // turn increases when the harness leaves working, even if we missed it.
      if (queue.awaitingTurn != null) {
        if (!Number.isFinite(target.turn) || target.turn <= queue.awaitingTurn) continue;
        queue.awaitingTurn = null;
      }
      const item = queue.items[0];
      if (item.state !== "queued") continue;
      const action = {
        key: target.key, id: item.id, address: target.address, turn: target.turn,
        args: ["send", "--json", ...(target.status === "idle" ? ["--if", "idle"] : []), "--", target.address, item.text],
      };
      item.state = "sending";
      this.pending.set(target.key, action);
      actions.push(action);
    }
    return actions;
  }

  complete(action, result) {
    if (this.pending.get(action.key) !== action) return;
    let body;
    try { body = decodeResult(result); }
    catch (error) {
      const knownNotSent = result.code === 9 || result.code === 10;
      this.fail(action, error, knownNotSent);
      return;
    }
    const queue = this.get(action.key);
    this.pending.delete(action.key);
    if (body?.started !== true || !Number.isFinite(body.turn ?? action.turn)) {
      const item = queue.items.find((entry) => entry.id === action.id);
      if (item) item.state = "uncertain";
      this.pause(action.key, "Submitted, but activity wasn't confirmed. Inspect the terminal before retrying.");
      return;
    }
    queue.items = queue.items.filter((entry) => entry.id !== action.id);
    queue.awaitingTurn = body.turn ?? action.turn;
  }

  fail(action, error, knownNotSent = false) {
    if (this.pending.get(action.key) !== action) return;
    this.pending.delete(action.key);
    const item = this.get(action.key).items.find((entry) => entry.id === action.id);
    if (item) item.state = knownNotSent ? "queued" : "uncertain";
    this.pause(action.key, `${String(error?.message ?? error)} Check the terminal before resuming.`);
  }

  snapshot() { return Object.fromEntries(this.queues); }
}
