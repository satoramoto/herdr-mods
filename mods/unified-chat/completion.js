// No cursor guessing: a change identifies exactly where an @ was inserted,
// including in the middle of Unicode text. The popup carries this immutable
// anchor; if the draft changes before selection, the marker is not removed.
export function mentionTrigger(before, after) {
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  if (after.length !== before.length + 1 || after[start] !== "@" ||
      after.slice(start + 1) !== before.slice(start) || (start > 0 && !/\s/.test(after[start - 1]))) return null;
  return { text: after, start, end: start + 1 };
}

export function removeMentionMarker(text, anchor) {
  return anchor && text === anchor.text && text.slice(anchor.start, anchor.end) === "@"
    ? text.slice(0, anchor.start) + text.slice(anchor.end) : text;
}

export function slashHead(text) {
  const match = /^(\s*\/)(\S+)(\s+)([\s\S]*)$/.exec(text);
  return match ? { name: match[2], start: match[1].length + match[2].length + match[3].length } : null;
}

// UTF-16 offsets match GPUI retained text state. Tokenize arguments without
// evaluating shell syntax, preserving quotes, following arguments and flags.
export function argumentRange(text, cursor = text.length, directory = false) {
  const head = slashHead(text);
  if (!head || !Number.isInteger(cursor) || cursor < head.start || cursor > text.length) return null;
  if (cursor > 0 && /[\uD800-\uDBFF]/.test(text[cursor - 1]) && /[\uDC00-\uDFFF]/.test(text[cursor] ?? "")) return null;
  if (directory) return { ...head, end: text.length, query: text.slice(head.start, cursor), quote: "", directory: true };
  let start = head.start, quote = "", escaped = false, end = text.length;
  for (let index = head.start; index < text.length; index++) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) {
      if (index >= cursor) { end = index; break; }
      start = index + 1;
    }
  }
  const raw = text.slice(start, cursor);
  const equal = /^--[^=\s]+=/.exec(raw);
  if (equal) start += equal[0].length;
  const token = text.slice(start, cursor);
  const opening = ["'", '"'].includes(token[0]) ? token[0] : "";
  let query = "", quoted = "";
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "\\" && quoted !== "'" && /[\s\\"'$`]/.test(token[index + 1] ?? "")) { query += token[++index]; continue; }
    if (quoted && char === quoted) { quoted = ""; continue; }
    if (!quoted && ["'", '"'].includes(char)) { quoted = char; continue; }
    query += char;
  }
  return { name: head.name, start, end, query, quote: opening, directory: false };
}

export function argumentValue(value, range) {
  if (range.directory) return value; // /cd consumes its entire raw argument.
  if (range.quote === "'") return `'${value.replace(/'/g, "'\\''")}'`;
  if (range.quote === '"' || /[^A-Za-z0-9_./:@+-]/.test(value)) return `"${value.replace(/[\\"$`]/g, "\\$&")}"`;
  return value;
}

export function applyArgumentEdit(current, edit) {
  if (current !== edit.expected || !Number.isInteger(edit.start) || !Number.isInteger(edit.end) ||
      edit.start < 0 || edit.end < edit.start || edit.end > current.length || typeof edit.value !== "string") {
    throw new Error("Draft changed. Completion was not applied; your edits are kept.");
  }
  return current.slice(0, edit.start) + edit.value + current.slice(edit.end);
}
