import { posix, win32 } from "node:path";
import { slashHead, argumentRange, argumentValue } from "./prompt-completion.js";

// The native 2.2.5 argument-autocomplete policy identifies session.cd by its
// live command ID, not its slash name. Other argument-taking commands expose no
// argument schema, so offer filesystem arguments without inventing enum values.
export function completionKind(command) {
  return command.id === "session.cd" ? "directory" : "path";
}

export function directorySearch(query, directory) {
  const path = /^[A-Za-z]:[\\/]|^\\\\/.test(directory) ? win32 : posix;
  if (query === "~" || query.startsWith("~/")) return null;
  const last = Math.max(query.lastIndexOf("/"), path === win32 ? query.lastIndexOf("\\") : -1);
  const parentOnly = /^(?:\.\.[\\/])*\.\.$/.test(query);
  const prefix = parentOnly ? query + "/" : last < 0 ? "" : query.slice(0, last + 1);
  const leaf = parentOnly ? "" : query.slice(last + 1);
  return { path, prefix, leaf, directory: path.resolve(directory, prefix || ".") };
}

export async function completeArguments(context, selected, request) {
  const session = selected(request), sessionID = session.id;
  const text = request.text;
  if (typeof text !== "string" || text.length > 1024 * 1024 || /[\0\r]/.test(text)) throw new Error("Invalid completion text.");
  const head = slashHead(text);
  if (!head) return { sessionID, text, items: [], reason: "Type /command followed by an argument." };
  const location = session.location ?? context.location ?? context.data.location.default();
  const sourceDirectory = location.directory;
  const verify = () => {
    const current = selected(request);
    if ((current.location ?? context.location ?? context.data.location.default()).directory !== sourceDirectory) throw new Error("Working directory changed; refresh completion before choosing a path.");
  };
  await context.data.location.command.sync(location); verify();
  const ui = context.keymap.commands().filter((item) => item.slash &&
    (typeof item.enabled === "function" ? item.enabled() : item.enabled !== false))
    .find((item) => [item.slash.name, ...(item.slash.aliases ?? [])].includes(head.name));
  const server = context.data.location.command.list(location)?.find((item) => item.name === head.name);
  const command = ui?.slash.arguments ? ui : server ? { id: server.name } : null;
  if (!command) return { sessionID, text, items: [], reason: "This live command does not accept arguments, or is no longer available." };
  const kind = ui?.slash.arguments ? completionKind(ui) : "path";
  const range = argumentRange(text, request.cursor ?? text.length, kind === "directory");
  if (!range || /[\r\n\0]/.test(range.query)) throw new Error("Invalid completion cursor or path.");
  const search = directorySearch(range.query, location.directory);
  if (!search) return { sessionID, text, kind, command: { id: command.id, name: head.name }, items: [], reason: "Server home is not exposed by this API. Use an absolute or relative server path; no local home directory was guessed." };
  const result = await context.client.file.list({ location, path: search.directory });
  verify();
  const items = result.data.filter((entry) => kind !== "directory" || entry.type === "directory").map((entry) => {
    const absolute = search.path.resolve(result.location.directory, entry.path);
    const name = search.path.basename(absolute);
    return { absolute, name, directory: entry.type === "directory" };
  }).filter((entry) => entry.name.toLowerCase().startsWith(search.leaf.toLowerCase()) &&
    (search.leaf.startsWith(".") || !entry.name.startsWith(".")))
    .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    .slice(0, 50).map((entry) => {
      const value = search.prefix + entry.name + (entry.directory ? "/" : "");
      return { kind: "argument", key: entry.absolute, label: value, directory: entry.directory,
        description: entry.directory ? "server directory" : "server file", edit: {
          expected: text, start: range.start, end: range.end, value: argumentValue(value, range),
        } };
    });
  if (search.prefix && !search.leaf) items.unshift({ kind: "argument", key: `exact:${search.directory}`,
    label: range.query, directory: true, description: "use this server directory",
    edit: { expected: text, start: range.start, end: range.end, value: argumentValue(range.query, range) } });
  return { sessionID, text, kind, command: { id: command.id, name: head.name }, items };
}
