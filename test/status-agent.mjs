// Isolated terminal fixture. Never calls a model or runs received text.
import { appendFileSync } from "node:fs";

const log = process.argv[2];
const record = (event) => appendFileSync(log, JSON.stringify(event) + "\n");
const report = (state) => process.stdout.write(`\x1b]7501;state=${state}:app=opencode:title=Q29tcG9zZXIgUUE=\x1b\\`);
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdout.write("\x1b[?2004hComposer QA: receives text, never executes it.\r\n");
report("idle");
let buffer = "";
let draft = "";
let pasting = false;
let messages = 0;
let stops = 0;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.length) {
    if (buffer.startsWith("\x1b[200~")) { pasting = true; buffer = buffer.slice(6); continue; }
    if (buffer.startsWith("\x1b[201~")) { pasting = false; buffer = buffer.slice(6); continue; }
    if (pasting) {
      const end = buffer.indexOf("\x1b[201~");
      if (end < 0) {
        // Preserve a possible incomplete closing marker across PTY chunks.
        const safe = Math.max(0, buffer.length - 5);
        draft += buffer.slice(0, safe); buffer = buffer.slice(safe); break;
      }
      draft += buffer.slice(0, end); buffer = buffer.slice(end); continue;
    }
    const char = buffer[0]; buffer = buffer.slice(1);
    if (char === "\x1b") {
      stops += 1; record({ type: "stop", count: stops });
      if (stops % 2 === 0) report("idle");
    } else if (char === "\r") {
      messages += 1; record({ type: "message", text: draft }); draft = "";
      report("working");
      if (messages === 2) setTimeout(() => report("blocked"), 200);
    } else draft += char;
  }
});
