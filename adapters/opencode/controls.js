import { inspectOpenCode } from "./metadata.js";
import { createOperations } from "./operations.js";
import { pathToFileURL } from "node:url";
import { completeArguments, completionKind } from "./command-completion.js";

export const PROTOCOL = 1;
export const MAX_REQUEST = 32 * 1024 * 1024;

function reachable(context) {
  return context.keymap.commands().filter((item) => item.id &&
    (typeof item.enabled === "function" ? item.enabled() : item.enabled !== false));
}

export function liveCommands(context, location) {
  return [
    ...reachable(context).filter((item) => item.slash || item.palette).map((item) => ({
      kind: "ui", id: item.id, title: item.title ?? item.id,
      description: item.description ?? item.title ?? "", slash: item.slash,
      ...(item.slash?.arguments ? { argumentCompletion: completionKind(item) } : {}),
      shortcuts: [...context.keymap.shortcuts(item.id)],
    })),
    ...(context.data.location.command.list(location) ?? []).map((item) => ({
      kind: "server", id: item.name, title: item.name, description: item.description ?? "",
      slash: { name: item.name, arguments: true },
      argumentCompletion: "path",
    })),
  ];
}

// This lives in the *actual terminal client*. Its authenticated SDK connection
// remains authoritative for shared, private and remotely connected servers.
export function createControls(context, terminalID, changed = () => {}) {
  let disposed = false;
  function selected(request) {
    if (disposed) throw new Error("OpenCode bridge was reloaded. Refresh before trying again.");
    const route = context.ui.router.current();
    if (request.version !== PROTOCOL || request.terminalID !== terminalID ||
        route.type !== "session" || route.sessionID !== request.sessionID) {
      throw new Error("Recipient changed. Nothing was sent to a different terminal/session.");
    }
    const session = context.data.session.get(route.sessionID);
    if (!session) throw new Error("The selected session is not hydrated yet.");
    return session;
  }
  function snapshot(session) {
    const location = session.location ?? context.location ?? context.data.location.default();
    const model = context.ui.model.current();
    const ref = model ? { id: model.modelID, providerID: model.providerID, variant: model.variant } : session.model;
    const messages = [...context.data.session.message.list(session.id)]
      .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
    const metadata = inspectOpenCode({ ...session, model: ref }, context.data.location.model.list(location) ?? [], messages);
    return {
      version: PROTOCOL, terminalID, sessionID: session.id, directory: location.directory,
      metadata, selected: ref, variants: [...context.ui.model.variant.list()],
      providerName: context.data.location.provider.list(location)?.find((item) => item.id === ref?.providerID)?.name,
      commands: liveCommands(context, location),
      permissionCount: context.data.session.permission.list(session.id)?.length ?? null,
      formCount: context.data.session.form.list(session.id, location)?.length ?? null,
      nativeRequired: true,
    };
  }
  const operations = createOperations(context, selected, changed);
  return {
    dispose() { disposed = true; },
    async request(request) {
      const session = selected(request);
      const location = session.location ?? context.location ?? context.data.location.default();
      if (request.action === "complete-arguments") return completeArguments(context, selected, request);
      if (["state", "activity", "shell-output", "navigate-family", "files", "submit", "receipt", "queued-detail", "inbox-cancel", "inbox-delivery", "interrupt", "permission-reply", "form-reply", "form-cancel"].includes(request.action)) return operations(request);
      if (request.action === "snapshot") {
        await context.data.location.command.sync(location);
        selected(request);
        return snapshot(selected(request));
      }
      if (request.action === "catalog") {
        if (!["skill", "agent", "reference", "model"].includes(request.collection)) throw new Error("Unsupported catalogue.");
        const collection = context.data.location[request.collection];
        await collection.sync(location);
        selected(request);
        return { sessionID: session.id, items: (collection.list(location) ?? []).filter((item) => !item.hidden).map((item) => ({
          id: item.id ?? item.name, name: item.name ?? item.id, description: item.description ?? "", mode: item.mode,
          ...(request.collection === "reference" ? { uri: pathToFileURL(item.path).href } : {}),
          ...(request.collection === "model" ? { providerID: item.providerID, variants: item.variants?.map((variant) => variant.id), enabled: item.enabled, type: item.type } : {}),
        })) };
      }
      if (request.action === "command") {
        // Do not answer a permission/question or dispatch a hidden lower layer
        // through an already-open native modal.
        if (context.keymap.mode.current() !== "base") throw new Error("Finish the native dialog/question first; use Terminal ↗.");
        const command = reachable(context).find((item) => item.id === request.id);
        if (!command || (!command.palette && !command.slash && !["agent.list", "model.list", "prompt.skills"].includes(command.id))) {
          throw new Error("That command is no longer available in the selected OpenCode client.");
        }
        if (request.input != null && typeof request.input !== "string") throw new Error("Invalid command arguments.");
        selected(request);
        await command.run(request.input);
        changed();
        return { sessionID: session.id, native: true };
      }
      if (request.action === "variant") {
        if (context.keymap.mode.current() !== "base") throw new Error("Finish the native dialog/question first.");
        if (request.value != null && typeof request.value !== "string") throw new Error("Invalid variant.");
        if (!context.ui.model.variant.set(request.value ?? undefined)) throw new Error("This model no longer has that variant.");
        changed();
        return snapshot(session);
      }
      throw new Error("Unsupported OpenCode bridge action.");
    },
  };
}
