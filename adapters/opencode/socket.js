import { createServer } from "node:net";
import { mkdtemp, chmod, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MAX_REQUEST, PROTOCOL } from "./controls.js";
import { API_FEATURES } from "./operations.js";

// Same-user IPC, not an HTTP listener. No shell, credentials, or transcripts.
export async function startControlSocket(controls) {
  if (process.platform === "win32") return null;
  const base = await access("/tmp/opencode").then(() => "/tmp/opencode", () => tmpdir());
  const directory = await mkdtemp(join(base, "unified-chat-"));
  await chmod(directory, 0o700);
  const path = join(directory, "control.sock");
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(15000, () => socket.destroy());
    let bytes = 0, text = "", handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REQUEST) { socket.destroy(); return; }
      text += chunk;
      if (!text.includes("\n")) return;
      handled = true;
      void Promise.resolve().then(() => controls.request(JSON.parse(text.split("\n", 1)[0])))
        .then((data) => socket.end(JSON.stringify({ data }) + "\n"),
          (error) => socket.end(JSON.stringify({ error: String(error.message ?? error) }) + "\n"));
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
  } catch (error) {
    server.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
  server.unref();
  return {
    report: { version: PROTOCOL, path, features: API_FEATURES },
    async close() {
      controls.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
