import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formAnswer } from "./forms.js";

export const API_FEATURES = ["structured-prompts", "native-inbox", "file-search", "argument-completion", "blocking-state", "permissions", "forms"];

function inboxView(item, fullText = false) {
  if (item.type !== "user") return { id: item.id, type: item.type, delivery: item.delivery };
  return { ...item, payload: { ...item.payload,
    text: fullText ? item.payload.text : item.payload.text.slice(0, 1024),
    textTruncated: !fullText && item.payload.text.length > 1024,
    files: item.payload.files?.map(({ name, mime }) => ({ name, mime })),
  } };
}

function boundedText(value, name, max = 1024 * 1024) {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`Invalid ${name}.`);
  return value;
}

export function promptPayload(request) {
  const text = boundedText(request.text, "prompt");
  const delivery = request.delivery ?? "queue";
  if (!["queue", "steer"].includes(delivery)) throw new Error("Invalid delivery mode.");
  const parts = request.parts ?? [];
  if (!Array.isArray(parts) || parts.length > 32) throw new Error("At most 32 attachments are allowed.");
  const payload = { text, delivery };
  for (const part of parts) {
    if (part.kind === "skill") (payload.skills ??= []).push({ id: boundedText(part.id, "skill ID", 256) });
    else if (part.kind === "agent") (payload.agents ??= []).push({ name: boundedText(part.id, "agent ID", 256) });
    else if (part.kind === "file" || part.kind === "reference") {
      const uri = boundedText(part.uri, "attachment URI", 30 * 1024 * 1024);
      if (!/^(file:|data:)/.test(uri)) throw new Error("Unsupported attachment URI.");
      (payload.files ??= []).push({ uri, name: boundedText(part.name ?? part.id ?? "attachment", "attachment name", 4096) });
    } else throw new Error("Unsupported attachment type.");
  }
  if (!text.trim() && !parts.length) throw new Error("Write a message or attach a file first.");
  if (request.id != null) {
    if (!/^msg_[a-zA-Z0-9_-]{8,128}$/.test(request.id)) throw new Error("Invalid submission identity.");
    payload.id = request.id;
  }
  if (request.resume === false) payload.resume = false;
  return payload;
}

async function prepareSelection(context, session, request, selected) {
  const location = session.location ?? context.location ?? context.data.location.default();
  if (request.selection?.agent) {
    await context.data.location.agent.sync(location);
    const agent = context.data.location.agent.list(location)?.find((item) => item.id === request.selection.agent && !item.hidden && item.mode !== "subagent");
    if (!agent) throw new Error("The selected primary agent is no longer available.");
    selected(request); await context.client.session.switchAgent({ sessionID: session.id, agent: agent.id });
  }
  const native = context.ui.model.current();
  const ref = request.selection?.model ?? (native ? { id: native.modelID, providerID: native.providerID, ...(native.variant ? { variant: native.variant } : {}) } : null);
  if (!ref) return;
  await context.data.location.model.sync(location);
  const model = context.data.location.model.list(location)?.find((item) => item.id === ref.id && item.providerID === ref.providerID && item.enabled !== false && (!item.type || item.type === "chat"));
  if (!model || (ref.variant && !model.variants?.some((variant) => variant.id === ref.variant))) throw new Error("The selected model or variant is no longer available.");
  selected(request); await context.client.session.switchModel({ sessionID: session.id, model: ref });
}

// No endpoint, authentication, cwd or session inference: all requests go through
// the connected TUI's SDK, with a fresh route check immediately before mutation.
export function createOperations(context, selected, changed) {
  return async (request) => {
    const session = selected(request);
    const sessionID = session.id;
    const location = session.location ?? context.location ?? context.data.location.default();
    const api = context.client;
    if (request.action === "activity") {
      const shells = await api.shell.list({ location }); selected(request);
      const family = [...new Set([sessionID, ...(context.data.session.family?.(sessionID) ?? [])])];
      return { sessionID, cost: session.cost, tokens: session.tokens, status: context.data.session.status?.(sessionID) ?? null,
        family: family.map((id) => { const value = context.data.session.get(id); return { id, title: value?.title ?? id, agent: value?.agent, status: context.data.session.status?.(id) ?? null }; }),
        shells: shells.data.map(({ id, command, status, cwd }) => ({ id, command, status, cwd })) };
    }
    if (request.action === "shell-output") {
      const value = await api.shell.output({ location, id: boundedText(request.id, "shell ID", 256), cursor: String(request.cursor ?? 0), limit: "16000" });
      selected(request); return { sessionID, ...value.data };
    }
    if (request.action === "navigate-family") {
      if (request.id !== sessionID && !context.data.session.family?.(sessionID)?.includes(request.id)) throw new Error("That session is no longer in this family.");
      selected(request); context.ui.router.navigate({ type: "session", sessionID: request.id });
      changed(); return { sessionID, native: true };
    }
    if (request.action === "state") {
      const family = [...new Set([sessionID, ...(context.data.session?.family?.(sessionID) ?? [])])];
      const [inbox, permissions, forms] = await Promise.all([
        api.session.inbox.list({ sessionID }),
        Promise.all(family.map((owner) => api.permission.list({ sessionID: owner }))).then((groups) => groups.flat()),
        Promise.all(family.map((owner) => api.session.form.list({ sessionID: owner }))).then((groups) => groups.flat()),
      ]);
      selected(request);
      return { sessionID, inbox: inbox.map((item) => inboxView(item)), permissions, forms };
    }
    if (["permission-reply", "form-reply", "form-cancel"].includes(request.action)) {
      const owner = request.ownerSessionID ?? sessionID;
      const validateOwner = () => {
        selected(request);
        if (owner !== sessionID && !context.data.session?.family?.(sessionID)?.includes(owner)) throw new Error("The request no longer belongs to this session family.");
      };
      validateOwner();
      if (request.action === "permission-reply") {
        if (!["once", "always", "reject"].includes(request.decision)) throw new Error("Invalid permission decision.");
        const pending = await api.permission.get({ sessionID: owner, requestID: request.id });
        if (pending.sessionID !== owner) throw new Error("Permission identity mismatch.");
        if (!request.expected || JSON.stringify({ action: pending.action, resources: pending.resources, save: pending.save ?? [] }) !== JSON.stringify(request.expected)) throw new Error("The permission scope changed. Review it again.");
        validateOwner();
        await api.permission.reply({ sessionID: owner, requestID: request.id, decision: request.decision,
          ...(request.message ? { message: boundedText(request.message, "rejection feedback", 100000) } : {}) });
      } else {
        const pending = await api.session.form.list({ sessionID: owner });
        const form = pending.find((item) => item.id === request.id && item.sessionID === owner);
        if (!form) throw new Error("This form is no longer pending.");
        validateOwner();
        if (request.action === "form-cancel") await api.session.form.cancel({ sessionID: owner, formID: form.id });
        else await api.session.form.reply({ sessionID: owner, formID: form.id, answer: formAnswer(form, request.answer ?? {}) });
      }
      changed(); return { sessionID, updated: true };
    }
    if (request.action === "queued-detail") {
      const inbox = await api.session.inbox.list({ sessionID });
      const item = inbox.find((entry) => entry.id === request.id && entry.type === "user");
      selected(request);
      if (!item) throw new Error("This queued prompt is no longer pending.");
      return { sessionID, item: request.includeBodies === true ? item : inboxView(item, true) };
    }
    if (request.action === "files") {
      const query = boundedText(request.query ?? "", "file query", 4096);
      const match = /^(.*)#(\d+)(?:-(\d+))?$/.exec(query);
      const base = match?.[1] ?? query;
      let fileLocation = location, fileQuery = base, alias = "";
      if (base.includes("/") && context.data.location.reference) {
        await context.data.location.reference.sync(location); selected(request);
        const reference = context.data.location.reference.list(location)?.find((item) => !item.hidden && base.startsWith(`${item.name}/`));
        if (reference) { fileLocation = { directory: reference.path }; fileQuery = base.slice(reference.name.length + 1); alias = `${reference.name}/`; }
      }
      const result = await api.file.find({ location: fileLocation, query: fileQuery, limit: "30" });
      selected(request);
      return { sessionID, items: result.data.map((item) => {
        const uri = pathToFileURL(resolve(result.location.directory, item.path));
        if (match && item.type === "file") {
          if (+match[2] < 1 || (match[3] && +match[3] < +match[2])) throw new Error("Invalid file line range.");
          uri.searchParams.set("start", match[2]);
          if (match[3]) uri.searchParams.set("end", match[3]);
        }
        return { kind: "file", id: alias + item.path, name: alias + item.path + (match && item.type === "file" ? `#${match[2]}${match[3] ? `-${match[3]}` : ""}` : ""), uri: uri.href, directory: item.type === "directory" };
      }) };
    }
    if (request.action === "submit") {
      const payload = promptPayload(request);
      // UI commands are not model prompts, and must never enter the user inbox.
      const slash = request.mode === "shell" ? null : /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(payload.text.trimStart());
      if (slash) {
        await context.data.location.command.sync(location);
        selected(request);
        const command = context.keymap.commands().find((item) => item.slash &&
          (typeof item.enabled === "function" ? item.enabled() : item.enabled !== false) &&
          [item.slash.name, ...(item.slash.aliases ?? [])].includes(slash[1]));
        const runUI = async () => {
          if (request.parts?.length) throw new Error("UI commands do not accept structured attachments. Your draft is kept.");
          if (context.keymap.mode.current() !== "base") throw new Error("Close the native modal before running a UI command.");
          selected(request); await command.run(slash[2]); changed();
          return { sessionID, accepted: true, kind: "ui-command", native: true };
        };
        // Match native argumentSlash precedence: argument-taking UI commands
        // win conflicts with a same-name server command, including aliases.
        if (command?.slash.arguments) return runUI();
        const serverCommand = context.data.location.command.list(location)?.find((item) => item.name === slash[1]);
        if (serverCommand) {
          await prepareSelection(context, session, request, selected);
          selected(request);
          const { id: _id, resume: _resume, ...args } = payload;
          const result = await api.session.command({ sessionID, ...args, name: slash[1], text: slash[2] ?? "" });
          changed(); return { sessionID, accepted: true, kind: "server-command", id: result?.id ?? null };
        }
        if (!command) throw new Error("Unknown or unavailable slash command.");
        return runUI();
      }
      if (request.mode === "shell") {
        if (payload.files?.length || payload.skills?.length || payload.agents?.length) throw new Error("Shell commands cannot include prompt attachments.");
        selected(request);
        await api.session.shell({ sessionID, command: payload.text, id: payload.id });
        changed(); return { sessionID, accepted: true, kind: "shell", id: payload.id };
      }
      if (request.mode != null && request.mode !== "normal") throw new Error("Invalid composer mode.");
      // The caller captures a selected model/agent from this exact client's live
      // catalogue. Commit it explicitly instead of typing into the native draft.
      await prepareSelection(context, session, request, selected);
      if (session.revert) { selected(request); await api.session.revert.commit({ sessionID }); }
      selected(request);
      const item = await api.session.prompt({ sessionID, ...payload });
      if (!item?.id || item.sessionID !== sessionID) throw new Error("Submission returned no durable receipt. Inspect before retrying.");
      changed(); return { sessionID, accepted: true, kind: "prompt", id: item.id };
    }
    if (request.action === "receipt") {
      if (!/^msg_/.test(request.id ?? "")) throw new Error("Invalid receipt ID.");
      const inbox = await api.session.inbox.list({ sessionID });
      const queued = inbox.find((item) => item.id === request.id);
      if (queued) return { sessionID, found: true, id: queued.id, queued: true };
      try {
        const message = await api.session.message.get({ sessionID, messageID: request.id });
        selected(request);
        return { sessionID, found: ["user", "shell"].includes(message?.type), id: request.id, queued: false };
      } catch (error) {
        // A connection failure is not evidence that a send failed.
        if (error.status === 404 || error.statusCode === 404) return { sessionID, found: false, id: request.id };
        throw error;
      }
    }
    if (request.action === "inbox-cancel" || request.action === "inbox-delivery") {
      const inbox = await api.session.inbox.list({ sessionID });
      if (!inbox.some((item) => item.id === request.id && item.type === "user")) throw new Error("This queued prompt is no longer pending.");
      selected(request);
      if (request.action === "inbox-cancel") await api.session.inbox.cancel({ sessionID, inboxID: request.id });
      else {
        if (!["queue", "steer"].includes(request.delivery)) throw new Error("Invalid delivery mode.");
        await api.session.inbox.update({ sessionID, inboxID: request.id, delivery: request.delivery });
      }
      changed(); return { sessionID, updated: true };
    }
    if (request.action === "interrupt") {
      selected(request);
      const result = await api.session.interrupt({ sessionID, resume: "false" });
      changed(); return { sessionID, result };
    }
    return null;
  };
}
