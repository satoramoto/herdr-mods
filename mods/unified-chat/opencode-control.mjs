import { createConnection } from "node:net";
import { lstat, mkdir, chmod, readFile, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { captureFiles, captureClipboard, hydrateParts, captureInboxDraft, previewAttachment } from "./attachments.mjs";

export async function controlRequest(path, request) {
  if (request.action === "queued-export") {
    const value = await controlRequest(path, { ...request, action: "queued-detail", includeBodies: true });
    return { sessionID: value.sessionID, id: value.item.id, draft: await captureInboxDraft(value.item, request.captureHome) };
  }
  if (request.action === "submit" && request.parts) request = { ...request, parts: await hydrateParts(request.parts) };
  if (!isAbsolute(path) || !path.endsWith("/control.sock")) throw new Error("Invalid OpenCode control endpoint.");
  const [directory, socket] = await Promise.all([lstat(dirname(path)), lstat(path)]);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || !socket.isSocket() || directory.uid !== uid || socket.uid !== uid ||
      (directory.mode & 0o077) || (socket.mode & 0o077)) throw new Error("OpenCode control endpoint is not private to this user.");
  return new Promise((resolve, reject) => {
    const connection = createConnection(path);
    let text = "";
    const fail = (error) => { connection.destroy(); reject(error); };
    connection.setEncoding("utf8");
    connection.setTimeout(12000, () => fail(new Error("OpenCode control request timed out; do not blindly retry an action.")));
    connection.on("error", reject);
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    connection.on("data", (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > 32 * 1024 * 1024) fail(new Error("OpenCode response is too large."));
    });
    connection.on("end", () => {
      connection.destroy();
      try {
        const response = JSON.parse(text);
        if (response.error) throw new Error(response.error);
        resolve(response.data);
      } catch (error) { reject(error); }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let result;
    if (process.argv[2] === "--prepare") {
      const directory = join(process.argv[3], "data", "unified-chat-requests");
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      result = { directory };
    } else if (process.argv[2] === "--preview") result = await previewAttachment(JSON.parse(process.argv[3]));
    else if (process.argv[2] === "--capture") result = { parts: await captureFiles(JSON.parse(process.argv[4]), process.argv[3]) };
    else if (process.argv[2] === "--clipboard") result = { parts: await captureClipboard(process.argv[3]) };
    else if (process.argv[2] === "--request-file") {
      const path = process.argv[3];
      const [folder, file] = await Promise.all([lstat(dirname(path)), lstat(path)]);
      if (!/^request-[a-zA-Z0-9-]+\.json$/.test(basename(path)) || !dirname(path).endsWith("/unified-chat-requests") ||
          !file.isFile() || folder.uid !== process.getuid?.() || file.uid !== process.getuid?.() || (folder.mode & 0o077) || file.size > 2 * 1024 * 1024) throw new Error("Invalid private request file.");
      let request;
      try { request = JSON.parse(await readFile(path, "utf8")); } finally { await unlink(path); }
      result = await controlRequest(process.argv[4], request);
    } else result = await controlRequest(process.argv[2], JSON.parse(process.argv[3]));
    console.log(JSON.stringify(result));
  } catch (error) { console.error(String(error.message ?? error)); process.exitCode = 1; }
}
