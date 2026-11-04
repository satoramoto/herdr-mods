# Harness parity playbook

The unified chat bar only becomes *the* interface once every native prompt it
covers can be hidden. OpenCode reached "API milestone, not safe to hide yet"
(README). This document turns that pass into a repeatable procedure, records
what each remaining harness exposes today, and ranks the work.

Audited on 2026-11-04 against the installed versions:
OpenCode 2.2.5 · Claude Code 2.1.316 · Codex CLI 0.166.0 · pi 1.4.0.
`npm run harness:audit` regenerates the machine-side half of this
(`evidence/harness-audit.json`); the doc-side half is the matrix below.

## 1. The procedure (what the OpenCode pass actually did)

1. **Pin the version and the authorities.** The installed binary wins over
   memory: `<harness> --help`, the shipped docs or protocol schema, the TUI
   source for the exact version, and the published docs. Record the URLs in the
   harness section so the audit can be repeated when the harness updates.
2. **Enumerate the native prompt, not the API.** Walk the native input box and
   list every job it does. Those jobs are the matrix rows below (identity,
   lifecycle, metadata, submit, queue, interrupt, model/effort/mode, approvals,
   questions, commands, mentions and files, attachments, activity, draft).
3. **Find the control tier for each row.** From strongest to weakest:
   - **A. Shared server or daemon.** The TUI's state lives in a process we can
     also talk to (Codex app-server daemon, OpenCode server). Exact session,
     receipts, server-owned queue.
   - **B. In-process bridge.** A plugin or extension loaded by the TUI opens a
     same-user Unix socket and proxies the harness's own SDK (OpenCode `tui.js`;
     pi extensions). The bridge publishes its socket path inside the OSC record.
   - **C. Reporters.** Hooks, status lines and extensions that can only *emit*:
     session id, model, mode, context usage, blocked/idle transitions.
   - **D. Terminal relay.** `hc send --if idle`, `hc keys`, `hc interrupt`.
     Typed slash commands and key chords. Works everywhere, proves nothing.
4. **Report first.** Before any control, the harness must publish the
   `unified-chat` OSC 7501 record (`agent`, `terminalID`, `sessionID`, `model`,
   `modelID`, `provider`, `mode`, `variant`, `used`, `window`, `percent`,
   `updatedAt`, optional `bridge`). `metadata.js` validates the session-id shape
   per harness; readers expire records after 45 s. Root lifecycle status stays
   with Herdr core's own integration; the record never overrides it.
5. **Build the four files per harness** (see §2) and keep the control module
   pure so `node --test` covers every request/response without a harness.
6. **Prove it with an owned session.** A smoke script creates its own session
   and terminal, exercises every implemented row, never touches a user session,
   never leaves persistent approvals, and writes `evidence/<harness>-api-result.json`.
7. **Fill the coverage table and gate the hide switch.** A row is "covered" only
   with a pure test plus an owned-session smoke. The hide switch for a harness
   stays off until every row is covered *and* the harness offers a supported way
   to hide its prompt that cannot swallow an approval or question.

## 2. Adapter contract (what "adding a harness" means in this repo)

| Piece | Path | Job |
|---|---|---|
| Reporter | `adapters/<harness>/` | Emits the `unified-chat` record from inside the harness (plugin, hook, status line). Installed by `scripts/install-<harness>.mjs`, which edits only entries it owns and keeps a backup. |
| Bridge or client | `adapters/<harness>/` | Tier A client (Codex `app-server.mjs`) or tier B socket server (OpenCode `controls.js` + `socket.js`). Same request vocabulary as OpenCode's `controls.js`: `snapshot`, `catalog`, `state`, `submit`, `receipt`, `interrupt`, `permission-reply`, `form-reply`, `files`, `complete-arguments`, `command`, `variant`, `activity`. |
| Control module | `mods/unified-chat/<harness>-control.js` | Pure: options, labels, request builders, input validation. Tested in `test/<harness>-control.test.js`. |
| Panel | `mods/unified-chat/<harness>-panel.js` | Herdr-styled menu/sheet from `style.js`; chosen in `main.js` by the record's `agent`. |
| Smoke | `scripts/<harness>-api-smoke.mjs` | Owned session only; writes `evidence/<harness>-api-result.json`. |
| Docs | this file + README | Matrix row status, sources, verified-vs-inferred, hide-switch gate. |

Routing rule in the composer: a terminal is a `<harness>` target only while its
own record says so (`claudeFor`, `bridgeFor`); otherwise it is a plain
terminal-relay target. Never infer the harness from process names or screen text.

## 3. Capability matrix

Legend: **A/B/C/D** tier available (see §1.3) · **✓** implemented in this repo ·
**◐** reporter only · **✗** no surface found · **?** needs an owned-session test.

| Row (job of the native prompt) | OpenCode 2.2.5 | Claude Code 2.1.316 | Codex 0.166.0 | pi 1.4.0 |
|---|---|---|---|---|
| Session identity | ✓ B plugin record | ✓ C statusLine `session_id` | ✓ C hook `session_id` = thread id; A `thread/loaded/list` | C extension `sessionManager.getSessionId()` |
| Lifecycle (working/blocked/idle) | core integration | core hook (SessionStart only) + ◐ | core hook + A `thread/status/changed` (`activeFlags`: `waitingOnApproval`, `waitingOnUserInput`) | core extension (`agent_start`/`agent_settled`, `herdr:blocked`) |
| Model / effort / mode shown | ✓ B | ✓ C (`model`, `effort.level`, `fast_mode`; `permission_mode` via hook) | ✓ A `thread/resume` (`model`, `reasoningEffort`, `approvalPolicy`, `sandbox`) | C `pi.getModel()`, `pi.getThinkingLevel()` |
| Context usage | ✓ B sampled | ✓ C `context_window` | ✓ A `thread/tokenUsage/updated` (`last`, `total`, `modelContextWindow`) | C `ctx.getContextUsage()` |
| Submit with receipt | ✓ B `session.prompt` → `msg_` id | D `hc send` only (SDK streaming input exists but owns its own process) | ✓ A `turn/start` → `turn.id`; `clientUserMessageId` | B `pi.sendUserMessage()`; RPC `prompt` → `disposition` |
| Queue / steer | ✓ B native inbox | D (native queue; Up to edit; no list API) | ✓ steer A `turn/steer` (`expectedTurnId`); queue view `thread/queue/changed` pending | B steer/followUp (`app.message.followUp`); RPC `streamingBehavior` |
| Interrupt | ✓ B `session.interrupt` | D `hc interrupt` (Esc) | ✓ A `turn/interrupt` (`threadId`, `turnId`) | B/D (`app.interrupt`, RPC `abort`) |
| Change model | ✓ B `switchModel` | ✓ D `/model <alias or id>` | ✓ A `turn/start.model`; `model/list` | B `pi.setModel()`; `/model` |
| Change effort / variant | ✓ B `variant` | ✓ D `/effort <level or auto>` | ✓ A `turn/start.effort`; `supportedReasoningEfforts` | B `pi.setThinkingLevel()`; `/thinking` |
| Change permission mode | n/a (session `permissions`) | ✓ D Shift+Tab cycle, `/plan`; no set-by-name | A `turn/start.approvalPolicy` (`on-request`, `never`, granular); `sandboxPolicy` | n/a (no built-in approvals) |
| Approvals list + reply | ✓ B `permission.list/reply` | C `PermissionRequest` hook decides allow/deny; no list; answer = keystrokes | A `ServerRequest` `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` (decisions `accept`, `acceptForSession`, `decline`, `cancel`) — fan-out to a second client **?** | B via extension `tool_call` gate + `ctx.ui.confirm` (extension-owned) |
| Questions / forms | ✓ B `session.form.*` | C `Notification` only; AskUserQuestion has no external answer | A `item/tool/requestUserInput` (`questions[]`, `options`, `isSecret`), `mcpServer/elicitation/request` | B `ctx.ui.select/input/confirm` are extension-owned; RPC extension UI |
| Slash catalogue + argument completion | ✓ B keymap + server commands | ✗ (`supportedCommands` is SDK-only) | A `skills/list`, `hooks/list`; built-in TUI slash list not exposed | B `pi.getCommands()` (extension, prompt, skill); built-in TUI commands not listed |
| Mentions / file search | ✓ B `file.find` | ✗ | ✓ A `fuzzyFileSearch` (`query`, `roots`) | ✗ (filesystem via `hc`) |
| Attachments | ✓ B files, skills, agents | ✗ for TTY (`[Image #N]` paste only) | A `UserInput`: `text`, `image`, `localImage`, `audio`, `skill`, `mention` | B `images[]` on prompt |
| Activity / cost | ✓ B | ◐ C `cost.total_cost_usd` (estimate) | A `thread/turns/list`, `thread/items/list`, token usage | RPC `get_session_stats` |
| Shell command | ✓ B `session.shell` | D `!` prefix | ✓ A `thread/shellCommand`, `command/exec` | RPC `bash`; `!` prefix |
| Read / write the native draft | ✗ (unsent agent/auto state unavailable) | ✗ | ✗ | B `ctx.ui.getEditorText/setEditorText` (TUI only) |
| Hide the native prompt | ✗ no supported slot | ✗ | ✗ | B `ctx.ui.setEditorComponent` (`modal-editor.ts` replaces the editor) |

## 4. Per-harness findings

### OpenCode 2.2.5 — done (tier B)

Everything in the matrix is implemented through the TUI plugin bridge
(`adapters/opencode`), checked by `npm run test:opencode-api`, evidence in
`evidence/opencode-api-result.json`. Remaining gates are listed in the README
table "Coverage required before any hide switch". The one structural limit: no
supported way to hide or replace the native prompt.

### Claude Code 2.1.316 — tier C reporters + tier D relay

What exists today in this repo: statusLine reporter (`unified-chat-statusline.py`),
permission-mode hook (`unified-chat-mode.py`), `claude-control.js`/`claude-panel.js`
typing `/model`, `/effort`, `/plan` and Shift+Tab through `hc`.

Surfaces, from the docs read on 2026-11-04 (cli-reference, hooks, statusline,
commands, keybindings, interactive-mode, headless, agent-view, agent-sdk,
permission-modes, remote-control, sessions, model-config, channels, env-vars at
`code.claude.com/docs/en/`):

- **Into an open TTY session there is no API.** The Agent SDK (`setPermissionMode`,
  `setModel`, `interrupt` with `still_queued`/`cancel_queued`, `supportedCommands`,
  `supportedModels`, `getContextUsage`) only drives a process the SDK started with
  streaming input (`-p --input-format stream-json`). `claude --resume <id> "<prompt>"`
  dispatches a turn into a *background* session (`--bg`), refusing `/` and `!`
  prompts. Remote Control and channels forward prompts and approvals to claude.ai
  or an MCP channel server, not to a local socket.
- **Reporters are rich.** Hook input carries `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, `effort.level`, `hook_event_name`; `Notification` gives
  `notification_type` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`,
  `agent_needs_input`, …); `PermissionRequest` carries `tool_name`, `tool_input`,
  `permission_suggestions` and may answer `allow`/`deny` (`updatedInput`,
  `updatedPermissions`, `message`, `interrupt`); `PreToolUse` may answer
  `allow|deny|ask|defer`; `Elicitation` may answer MCP elicitations. The statusLine
  payload adds `model`, `effort`, `context_window`, `cost`, `rate_limits`,
  `workspace`, `agent`, `fast_mode`.
- **Controls stay typed.** `/model`, `/effort`, `/fast`, `/config key=value`,
  `/plan`, `/compact`, `/rename`, `/output-style` accept arguments; Shift+Tab cycles
  default → acceptEdits → plan → (bypassPermissions) → (auto); `keybindings.json`
  can bind `command:<name>` but has no insert-text or set-mode action.
- **Gaps with no surface:** draft text, queue list/cancel for a TTY session, the
  `/` and `@` pickers, answering AskUserQuestion, `supportedCommands` outside the
  SDK, a stable transcript schema.

Next for Claude (ranked):
1. Add `Notification`/`PermissionRequest`/`Stop` hook reporting into the record
   (blocked reason, pending tool name) so the attention panel can at least *show*
   Claude's prompt and offer a one-click `hc keys` reply with the scope visible.
2. Owned-session smoke: `claude --session-id <uuid> -n <name>` under `hc run`,
   verify the record, `/model`, `/effort`, Shift+Tab mode change observed through
   the hook, Esc interrupt. Writes `evidence/claude-api-result.json`.
3. Evaluate the **SDK-hosted mode** as the real parity path: Herdr launches
   `claude -p --input-format stream-json` itself and renders the stream, instead of
   a TTY. That is the only route to receipts, queue control and mode-by-name.

### Codex 0.166.0 — tier A, implemented through a sidecar bridge

Implemented (`adapters/codex`, `npm run codex:install`, `npm run test:codex-api`,
evidence in `evidence/codex-api-result.json`): the record, model and effort
pickers, `turn/start` with receipt, steer, interrupt, shell mode, file search,
image attachments. Approvals, questions and the queue stay native for now.

- The interactive TUI runs its threads on the **shared app-server daemon**
  (`codex app-server --listen unix:// --managed-daemon`, process `codex-tui`
  connected to `/tmp/codex-daemon-1000/<hash>`, symlinked from
  `~/.codex/app-server-control/app-server-control.sock`). The socket speaks
  **WebSocket over HTTP Upgrade**, one JSON-RPC message per text frame, no token.
  `adapters/codex/app-server.mjs` is the client.
- Verified live on 2026-11-04: a second connection can `thread/read` any loaded
  thread and `thread/resume` the TUI's thread (model, reasoning effort, approval
  policy, sandbox, cwd, turns). `thread/resume` needs a rollout on disk, which a
  thread only gets with its first user message, so the reporter falls back to
  `thread/read` and retries the resume on the first `turn/started`.
  `thread/status/changed` notifications reach every connection, not only
  subscribers. `thread/turns/list` is refused before the first message
  ("not materialized") and on legacy-history threads ("list_turns is not
  supported yet"); `thread/read` with `includeTurns` still returns their turns.
  A `turn/start` from the bridge returns the turn id, `turn/interrupt` stops it,
  and the turn is then found by id (smoke with `--allow-generation`).
- Protocol schema from `codex app-server generate-json-schema`: 106 client
  requests, 85 notifications, 10 server requests. Rows map to `thread/resume`,
  `turn/start` (`input[]`, `model`, `effort`, `approvalPolicy`, `cwd`,
  `clientUserMessageId`), `turn/steer` (`expectedTurnId`), `turn/interrupt`,
  `thread/queue/changed`, `thread/status/changed` (`active.activeFlags`),
  `thread/tokenUsage/updated`, `fuzzyFileSearch`, `skills/list`, `model/list`,
  `thread/shellCommand`, server requests `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`,
  `item/tool/requestUserInput`, `mcpServer/elicitation/request`.
- Hooks (`learn.chatgpt.com/docs/hooks`): 14 events, stdin JSON with `session_id`,
  `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`, `permission_mode`
  (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`); `PermissionRequest`
  may decide `allow`/`deny`. Configured in `~/.codex/hooks.json` and trusted once
  with `/hooks`. The hook's own `permission_mode` is kept as `hookMode` in the
  record; the footer shows the daemon's approval policy.
- Config (`learn.chatgpt.com/docs/config-file/config-reference`): `approval_policy`
  `on-request|never|{granular}`, `sandbox_mode` `read-only|workspace-write|danger-full-access`,
  `model_reasoning_effort`, `tui.keymap.<context>.<action>`, `tui.notifications`,
  `notify` (external command, payload fields not read).

Still unverified: whether a second subscriber receives the TUI's approval
`ServerRequest`s and whether its reply resolves the TUI dialog
(`serverRequest/resolved` suggests yes); whether a bridge-started turn renders in
the TUI (both share the thread, so it should); the `notify` payload.

Next for Codex (ranked):
1. Approval fan-out smoke: owned thread, a turn that triggers a command approval
   under `approvalPolicy: "on-request"`, assert the reporter's connection gets
   `item/commandExecution/requestApproval` and that answering it resolves the
   request. Then map it into the attention panel and add `permissions` and
   `forms` to `CODEX_FEATURES`.
2. Queue view from `thread/queue/changed` + `QueuedSubmission` (native inbox
   equivalent), and `thread/tokenUsage/updated` already feeds context usage.
3. Skills (`skills/list`) as `@skill` attachments (`UserInput.skill`).

### pi 1.4.0 — tier B through an extension

- Docs ship with the install (`~/.local/share/mise/installs/pi/latest/pi/docs`).
  RPC mode (`pi --mode rpc`) is a **separate headless process**: it cannot attach
  to an open TUI. The open TUI is reachable only by an extension, exactly like
  OpenCode's plugin; Herdr's own `~/.pi/agent/extensions/herdr-agent-state.ts`
  already runs there and reports lifecycle over `HERDR_SOCKET_PATH`.
- Extension API (`docs/extensions.md`, examples): `pi.on(event)` for `input`,
  `before_agent_start`, `agent_start`, `turn_end`, `agent_end`, `agent_settled`,
  `tool_call` (gate), `message_*`, `session_*`; `pi.sendUserMessage()`,
  `pi.sendMessage()`, `pi.setModel()`, `pi.setThinkingLevel()`, `pi.getCommands()`,
  `pi.registerCommand()`, `pi.registerShortcut()`, `pi.appendEntry()`;
  `ctx.ui.getEditorText/setEditorText/setEditorComponent/setFooter/setHeader/
  notify/select/confirm/input`, `ctx.getContextUsage()`, `ctx.isIdle()`,
  `ctx.sessionManager.getSessionId()/getSessionFile()`.
- RPC command vocabulary (for a future Herdr-hosted pi, or as the model for the
  bridge): `prompt` (`streamingBehavior: steer|followUp`, `images[]`), `steer`,
  `follow_up`, `abort`, `clear_queue`, `get_state`, `get_messages`, `set_model`,
  `get_available_models`, `set_thinking_level`, `compact`, `bash`,
  `get_session_stats`, `get_commands`, `set_session_name`, plus extension UI
  requests `select|confirm|input|editor|notify|setStatus|setWidget|set_editor_text`.
- pi has no built-in approval prompts; "blocked" is whatever an extension asks
  (`herdr:blocked` events). Built-in TUI slash commands (`/settings`, `/model`
  picker…) are not in `get_commands`.
- Unique: `ctx.ui.setEditorComponent()` can **replace the editor** (shipped
  example `modal-editor.ts`), which is the only supported native-prompt hide
  switch among the four harnesses.

Next for pi (ranked):
1. `adapters/pi/unified-chat.ts`: publish the record (session id, model,
   thinking level, context usage) and open a same-user socket with the OpenCode
   action vocabulary mapped to the API above. Install beside the Herdr extension.
2. `pi-control.js` + panel: models (`getAvailableModels` equivalent via
   `ctx.modelRegistry`), thinking levels, commands.
3. Owned-session smoke with `pi --no-session -e <adapter>` under `hc run`.

## 5. Adding the next harness: checklist

1. `npm run harness:audit` → note version, reporters, control tier.
2. Collect authorities (CLI help, shipped docs, protocol schema, published docs);
   add their URLs to a new section in §4.
3. Fill the matrix column from the native prompt's jobs; mark `?` where only an
   owned-session test can answer.
4. Reporter first (`adapters/<harness>/`), `metadata.js` session-id shape, install
   script with backup and owned-entry edits only.
5. Control module + tests, panel from `style.js`, routing in `main.js`.
6. Owned-session smoke → `evidence/<harness>-api-result.json`.
7. Update the matrix and the README coverage table; keep the hide switch gated.
