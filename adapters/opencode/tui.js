import { Plugin } from "@opencode/plugin/tui";
import { inspectOpenCode } from "./metadata.js";
import { createControls } from "./controls.js";
import { startControlSocket } from "./socket.js";

// Runs in the terminal client, not the shared server. Emits one named OSC
// record. Its optional same-user bridge controls this exact client through the
// documented plugin SDK, never the focused terminal or a guessed server.
export default Plugin.define({
  id: "satoramoto.unified-chat.metadata",
  async setup(context) {
    const terminalID = process.env.HC_TERMINAL_ID;
    if (!terminalID) return;
    let disposed = false;
    let signature;
    let publishedAt = 0;
    let pending;
    let bridge;
    let revision = 0;
    const emit = (fields) => process.stdout.write(`\x1b]7501;${fields}\x1b\\`);
    const publish = () => {
      if (disposed) return;
      try {
        const route = context.ui.router.current();
        const session = route.type === "session" ? context.data.session.get(route.sessionID) : null;
        if (!session) {
          const now = Date.now();
          if (signature !== "home" || now - publishedAt >= 15000) {
            signature = "home"; publishedAt = now;
            const payload = Buffer.from(JSON.stringify({ terminalID, sessionID: null, updatedAt: now }), "utf8").toString("base64");
            emit(`id=unified-chat:state=idle:app=unified-chat:msg=${payload}`);
          }
          return;
        }
        const location = session.location ?? context.location ?? context.data.location.default();
        const models = context.data.location.model.list(location) ?? [];
        const selected = context.ui.model.current();
        // V2's selected model reference is authoritative for unsent selections;
        // use the session reference if the client has not hydrated one yet.
        const ref = selected?.id && selected?.providerID ? selected
          : selected?.modelID && selected?.providerID ? { id: selected.modelID, providerID: selected.providerID, variant: selected.variant }
          : session.model;
        const messages = [...(context.data.session.message.list(session.id) ?? [])]
          .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
        const { updatedAt: _ignored, ...metadata } = inspectOpenCode({ ...session, model: ref }, models, messages);
        const next = JSON.stringify({ ...metadata, terminalID, bridge: bridge?.report, revision });
        const now = Date.now();
        if (next === signature && now - publishedAt < 15000) return;
        signature = next; publishedAt = now;
        const payload = Buffer.from(JSON.stringify({ ...metadata, terminalID, bridge: bridge?.report, revision, updatedAt: now }), "utf8").toString("base64");
        emit(`id=unified-chat:state=idle:app=unified-chat:msg=${payload}`);
      } catch {
        // Reporting must never break the harness. Stale records expire in the
        // consumer; no guessed/default model is substituted after an error.
      }
    };
    try { bridge = await startControlSocket(createControls(context, terminalID, () => { signature = undefined; publish(); })); }
    catch { /* Metadata remains usable if local IPC is unavailable. Never claim controls are connected. */ }
    const unsubscribe = context.data.listen(({ details }) => {
      if (/^(permission\.|form\.|session\.(inbox\.|execution\.|agent\.selected|model\.selected))/.test(details.type)) revision++;
      if (!pending) pending = setTimeout(() => { pending = undefined; publish(); }, 200);
    });
    const interval = setInterval(publish, 1000);
    interval.unref?.();
    publish();
    return async () => {
      disposed = true;
      clearInterval(interval); clearTimeout(pending); unsubscribe();
      emit("id=unified-chat:state=clear");
      await bridge?.close();
    };
  },
});
