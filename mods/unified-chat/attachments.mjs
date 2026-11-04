import { readFile, writeFile, mkdir, lstat, stat, chmod } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAX_BYTES = 20 * 1024 * 1024;
const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".pdf": "application/pdf", ".svg": "text/plain", ".txt": "text/plain", ".md": "text/plain", ".json": "application/json" };

async function store(bytes, name, mime, home) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Attachment is empty or exceeds 20 MiB.");
  const directory = join(home, "data", "unified-chat-attachments");
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, hash + (extname(name).match(/^\.[a-zA-Z0-9]{1,8}$/)?.[0] ?? ".bin"));
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  return { kind: "file", id: hash, name, capture: { path, hash, mime, bytes: bytes.length } };
}

export async function captureFiles(paths, home) {
  if (!Array.isArray(paths) || paths.length > 32) throw new Error("At most 32 files can be attached at once.");
  const parts = []; let total = 0;
  for (const path of paths) {
    if (typeof path !== "string" || path.includes("\0")) throw new Error("Invalid attachment path.");
    const source = await stat(path);
    if (!source.isFile()) throw new Error("Drop files, not directories. Use @ for server-side directories.");
    if (source.size + total > MAX_BYTES) throw new Error("Attachments exceed the combined 20 MiB limit.");
    const bytes = await readFile(path); total += bytes.length;
    parts.push(await store(bytes, basename(path), mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream", home));
  }
  return parts;
}

export async function captureClipboard(home) {
  let types, read;
  try {
    types = execFileSync("wl-paste", ["--list-types"], { encoding: "utf8", timeout: 3000 });
    read = (type) => execFileSync("wl-paste", ["--no-newline", "--type", type], { timeout: 5000, maxBuffer: MAX_BYTES + 1024 });
  } catch {
    types = execFileSync("xclip", ["-selection", "clipboard", "-o", "-t", "TARGETS"], { encoding: "utf8", timeout: 3000 });
    read = (type) => execFileSync("xclip", ["-selection", "clipboard", "-o", "-t", type], { timeout: 5000, maxBuffer: MAX_BYTES + 1024 });
  }
  const available = types.split(/\s+/);
  const mime = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/tiff", "image/bmp"].find((item) => available.includes(item));
  if (mime) {
    let bytes = read(mime), outputMime = mime;
    if (["image/tiff", "image/bmp"].includes(mime)) {
      bytes = execFileSync("python3", ["-c", "import sys,io;from PIL import Image;Image.open(io.BytesIO(sys.stdin.buffer.read())).save(sys.stdout.buffer,format='PNG')"], { input: bytes, timeout: 5000, maxBuffer: MAX_BYTES });
      outputMime = "image/png";
    }
    return [await store(bytes, `clipboard.${outputMime.split("/")[1]}`, outputMime, home)];
  }
  if (available.includes("text/uri-list")) {
    const paths = read("text/uri-list").toString("utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((uri) => fileURLToPath(uri));
    return captureFiles(paths, home);
  }
  throw new Error("Clipboard has no supported image or copied files. Text paste stays in the editor.");
}

export async function hydrateParts(parts = []) {
  let total = 0;
  return Promise.all(parts.map(async (part) => {
    if (!part.capture) return part;
    const { path, hash, mime } = part.capture;
    if (!/^[a-f0-9]{64}$/.test(hash ?? "") || !path?.includes("/unified-chat-attachments/") || !basename(path).startsWith(hash)) throw new Error("Invalid captured attachment.");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > MAX_BYTES) throw new Error("Captured attachment is not a private regular file.");
    const bytes = await readFile(path); total += bytes.length;
    if (total > MAX_BYTES || createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Captured attachment changed or exceeds the size limit.");
    return { kind: "file", id: part.id, name: part.name, uri: `data:${mime};base64,${bytes.toString("base64")}` };
  }));
}

export async function captureInboxDraft(item, home) {
  const payload = item.payload;
  const parts = [];
  let total = 0;
  for (const file of payload.files ?? []) {
    const bytes = Buffer.from(file.data, "base64"); total += bytes.length;
    if (total > MAX_BYTES) throw new Error("Queued attachments exceed the local 20 MiB capture limit. Use the native editor.");
    parts.push(await store(bytes, file.name ?? "queued-attachment", file.mime, home));
  }
  for (const skill of payload.skills ?? []) parts.push({ kind: "skill", id: skill.id, name: skill.id });
  for (const agent of payload.agents ?? []) parts.push({ kind: "agent", id: agent.name, name: agent.name });
  return { text: payload.text, mode: "normal", parts };
}

export async function previewAttachment(part) {
  if (!part.capture) return { description: part.uri ?? `${part.kind}: ${part.id}`, text: "Server-side reference; use the native file viewer for its current contents." };
  // Reuse all private-cache/hash validation before previewing a stored path.
  const [verified] = await hydrateParts([part]);
  const { mime, bytes, path } = part.capture;
  if (/^image\/(png|jpeg|webp|gif|avif)$/.test(mime)) return { image: path, description: `${mime} · ${bytes} bytes` };
  const data = Buffer.from(verified.uri.split(",")[1], "base64");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return { description: `${mime} · ${bytes} bytes`, text: "Binary attachment captured immutably. No text preview available." }; }
  return { description: `${mime} · ${bytes} bytes`, text: text.slice(0, 16000), truncated: text.length > 16000 };
}
