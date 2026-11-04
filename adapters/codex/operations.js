// Codex bridge operations: the composer's request vocabulary (the same one the
// OpenCode adapter answers) translated into app-server JSON-RPC calls on the
// exact thread this terminal's TUI is running. Pure apart from `context.request`,
// so a fake daemon can test every branch.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const PROTOCOL = 1;
// Only what an owned-thread smoke has proven. Approvals and questions arrive as
// server requests on a subscribed connection; they join this list once fan-out
// to a second client is verified.
export const CODEX_FEATURES = ["structured-prompts", "file-search"];

const SANDBOX = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "full-access" };

export function policyLabel(policy) {
  if (typeof policy === "string") return policy;
  if (policy && typeof policy === "object" && policy.granular) return "granular";
  return null;
}

export function sandboxLabel(sandbox) {
  const type = typeof sandbox === "string" ? sandbox : sandbox?.type;
  return SANDBOX[type] ?? type ?? null;
}

// Context used, on the same basis as the OpenCode sample: the last request's
// input, cache and output. `total` is the thread lifetime and never shown.
export function contextUsage(tokenUsage) {
  const last = tokenUsage?.last;
  const parts = last && [last.inputTokens, last.cachedInputTokens, last.outputTokens];
  const used = parts?.every((value) => Number.isFinite(value) && value >= 0) ? parts.reduce((sum, value) => sum + value, 0) : null;
  const window = Number.isFinite(tokenUsage?.modelContextWindow) ? tokenUsage.modelContextWindow : null;
  return { used, window };
}

function modelName(models, id) {
  return models.find((item) => item.id === id || item.model === id)?.displayName ?? id ?? null;
}

// The `unified-chat` OSC record for a Codex terminal.
export function codexRecord({ terminalID, threadId, info, models = [], usage, hookMode = null, bridge = null, revision = 0, now = Date.now() }) {
  const { used, window } = contextUsage(usage);
  return {
    agent: "codex", terminalID, sessionID: threadId,
    mode: policyLabel(info?.approvalPolicy), sandbox: sandboxLabel(info?.sandbox), hookMode,
    status: info?.status?.type ?? null, flags: info?.status?.activeFlags ?? [],
    model: modelName(models, info?.model), modelID: info?.model ?? null, provider: "openai",
    variant: info?.effort ?? null,
    used, window, percent: used != null && window > 0 ? Math.round(used / window * 100) : null, inputLimit: null,
    sampledAt: used != null ? (usage?.sampledAt ?? now) : null,
    bridge, revision, updatedAt: now,
  };
}

function boundedText(value, name, max = 1024 * 1024) {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}.`);
  return value;
}

// Composer attachments become Codex `UserInput` items. Only what Codex accepts
// without inventing a transport: images as data/local paths; anything else refuses.
export function inputItems(text, parts = []) {
  if (!Array.isArray(parts) || parts.length > 32) throw new Error("At most 32 attachments are allowed.");
  const items = [];
  if (text.trim() || !parts.length) items.push({ type: "text", text });
  for (const part of parts) {
    if (part.kind !== "file" && part.kind !== "reference") throw new Error(`Codex accepts file and image attachments only, not ${part.kind}.`);
    const uri = boundedText(part.uri, "attachment URI", 30 * 1024 * 1024);
    if (/^data:image\//.test(uri)) items.push({ type: "image", url: uri });
    else if (uri.startsWith("file:")) {
      const path = decodeURIComponent(new URL(uri).pathname);
      if (/\.(png|jpe?g|gif|webp)$/i.test(path)) items.push({ type: "localImage", path });
      else items.push({ type: "text", text: `@${path}` });
    } else throw new Error("Unsupported attachment URI.");
  }
  if (!text.trim() && !parts.length) throw new Error("Write a message or attach a file first.");
  return items;
}

// context: { request(method, params), terminalID, threadId, info(), models(), usage(),
//            override(), setOverride(next), applied(next), changed() }
export function createCodexOperations(context) {
  const { terminalID, threadId } = context;
  function check(request) {
    if (request.version !== PROTOCOL || request.terminalID !== terminalID || request.sessionID !== threadId) {
      throw new Error("Recipient changed. Nothing was sent to a different terminal/thread.");
    }
  }
  const call = (method, params) => context.request(method, { threadId, ...params });
  // Newest first. A thread has no turn list until its first user message, and
  // legacy-history threads refuse thread/turns/list; thread/read still carries
  // their turns.
  async function turns(limit) {
    try {
      const result = await call("thread/turns/list", { limit, itemsView: "summary", sortDirection: "desc" });
      return result?.data ?? [];
    } catch (error) {
      const message = String(error.message ?? error);
      if (/not materialized/i.test(message)) return [];
      if (!/not supported/i.test(message)) throw error;
      const read = await call("thread/read", { includeTurns: true });
      return [...(read?.thread?.turns ?? [])].reverse().slice(0, limit);
    }
  }
  async function latestTurn() { return (await turns(1))[0] ?? null; }
  function currentModel(models) {
    const override = context.override();
    const id = override.model ?? context.info().model;
    const model = models.find((item) => item.id === id || item.model === id) ?? null;
    return { id, model, effort: override.effort ?? context.info().effort ?? model?.defaultReasoningEffort ?? null };
  }
  async function snapshot() {
    const models = await context.models();
    const info = context.info();
    const current = currentModel(models);
    const { used, window } = contextUsage(context.usage());
    return {
      version: PROTOCOL, terminalID, sessionID: threadId, directory: info.cwd ?? null,
      metadata: { sessionID: threadId, mode: policyLabel(info.approvalPolicy), model: modelName(models, current.id), provider: "openai", variant: current.effort, used, window, updatedAt: Date.now() },
      selected: { id: current.id, providerID: "openai", variant: current.effort ?? undefined },
      variants: (current.model?.supportedReasoningEfforts ?? []).map((item) => item.reasoningEffort),
      providerName: "OpenAI", commands: [], permissionCount: null, formCount: null, nativeRequired: true,
    };
  }
  return async function request(input) {
    check(input);
    const action = input.action;
    if (action === "snapshot") return snapshot();
    if (action === "catalog") {
      if (input.collection !== "model") throw new Error("Unsupported catalogue.");
      const models = await context.models();
      return { sessionID: threadId, items: models.filter((item) => !item.hidden).map((item) => ({
        id: item.id, name: item.displayName ?? item.id, description: item.description ?? "", providerID: "openai",
        variants: (item.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort), enabled: true, type: "chat",
      })) };
    }
    if (action === "variant") {
      if (input.value != null && typeof input.value !== "string") throw new Error("Invalid variant.");
      const models = await context.models();
      const current = currentModel(models);
      if (input.value != null && !current.model?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === input.value)) throw new Error("This model no longer has that reasoning effort.");
      context.setOverride({ effort: input.value ?? null });
      context.changed();
      return snapshot();
    }
    if (action === "state") return { sessionID: threadId, inbox: [], permissions: [], forms: [] };
    if (action === "activity") {
      const info = context.info();
      const recent = await turns(10);
      return { sessionID: threadId, cost: null, tokens: context.usage()?.total ?? null, status: info.status?.type ?? null,
        family: [{ id: threadId, title: info.name ?? threadId, agent: null, status: info.status?.type ?? null }],
        turns: recent.map((turn) => ({ id: turn.id, status: turn.status, startedAt: turn.startedAt ?? null })), shells: [] };
    }
    if (action === "files") {
      const query = boundedText(input.query ?? "", "file query", 4096);
      const match = /^(.*)#(\d+)(?:-(\d+))?$/.exec(query);
      const base = match?.[1] ?? query;
      const root = context.info().cwd;
      if (!root) throw new Error("The thread has no working directory yet.");
      const result = await context.request("fuzzyFileSearch", { query: base, roots: [root] });
      return { sessionID: threadId, items: (result?.files ?? result?.data ?? []).slice(0, 30).map((item) => {
        const path = resolve(item.root ?? root, item.path);
        const uri = pathToFileURL(path);
        if (match) {
          if (+match[2] < 1 || (match[3] && +match[3] < +match[2])) throw new Error("Invalid file line range.");
          uri.searchParams.set("start", match[2]);
          if (match[3]) uri.searchParams.set("end", match[3]);
        }
        return { kind: "file", id: item.path, name: item.path + (match ? `#${match[2]}${match[3] ? `-${match[3]}` : ""}` : ""), uri: uri.href, directory: false };
      }) };
    }
    if (action === "submit") {
      const text = boundedText(input.text ?? "", "prompt");
      if (input.mode === "shell") {
        if (input.parts?.length) throw new Error("Shell commands cannot include prompt attachments.");
        if (!text.trim()) throw new Error("Write a shell command first.");
        await call("thread/shellCommand", { command: text });
        context.changed();
        return { sessionID: threadId, accepted: true, kind: "shell", id: null };
      }
      if (input.mode != null && input.mode !== "normal") throw new Error("Invalid composer mode.");
      if (/^\s*\//.test(text)) throw new Error("Codex slash commands run only in its native TUI. Use Terminal ↗; your draft is kept.");
      const items = inputItems(text, input.parts ?? []);
      const models = await context.models();
      const override = { ...context.override() };
      if (input.selection?.model) {
        const chosen = models.find((item) => item.id === input.selection.model.id);
        if (!chosen) throw new Error("The selected model is no longer available.");
        override.model = chosen.id;
        if (input.selection.model.variant != null) {
          if (!chosen.supportedReasoningEfforts?.some((item) => item.reasoningEffort === input.selection.model.variant)) throw new Error("The selected reasoning effort is no longer available.");
          override.effort = input.selection.model.variant;
        }
      }
      const delivery = input.delivery ?? "queue";
      if (!["queue", "steer"].includes(delivery)) throw new Error("Invalid delivery mode.");
      if (delivery === "steer") {
        const turn = await latestTurn();
        if (turn?.status === "inProgress") {
          const steered = await call("turn/steer", { expectedTurnId: turn.id, input: items, clientUserMessageId: input.id ?? null });
          context.changed();
          return { sessionID: threadId, accepted: true, kind: "prompt", id: steered?.turnId ?? turn.id, steered: true };
        }
      }
      const started = await call("turn/start", { input: items, clientUserMessageId: input.id ?? null,
        ...(override.model ? { model: override.model } : {}), ...(override.effort ? { effort: override.effort } : {}) });
      if (!started?.turn?.id) throw new Error("Submission returned no durable receipt. Inspect before retrying.");
      context.applied(override);
      context.changed();
      return { sessionID: threadId, accepted: true, kind: "prompt", id: started.turn.id };
    }
    if (action === "receipt") {
      if (typeof input.id !== "string" || !input.id) throw new Error("Invalid receipt ID.");
      return { sessionID: threadId, found: (await turns(20)).some((turn) => turn.id === input.id), id: input.id, queued: false };
    }
    if (action === "interrupt") {
      const turn = await latestTurn();
      if (turn?.status !== "inProgress") return { sessionID: threadId, result: null, idle: true };
      await call("turn/interrupt", { turnId: turn.id });
      context.changed();
      return { sessionID: threadId, result: { turnId: turn.id } };
    }
    if (["queued-detail", "inbox-cancel", "inbox-delivery"].includes(action)) throw new Error("Codex owns its queue; edit queued turns in the native TUI.");
    if (["permission-reply", "form-reply", "form-cancel"].includes(action)) throw new Error("Codex approvals are answered in its native TUI until fan-out is verified.");
    if (["complete-arguments", "command", "navigate-family", "shell-output"].includes(action)) throw new Error("Not available for Codex through this bridge.");
    throw new Error("Unsupported Codex bridge action.");
  };
}
