# Herdr mods

## Unified chat

A native composer for the selected agent, independent of its terminal UI.

- **Return** sends into that agent's queue. **Cmd/Ctrl+Return** inserts a newline; Shift+Return also works.
- Normal **Send queues**; **Alt+Return** steers in connected OpenCode. OpenCode owns its native inbox; other harnesses use a local ready-only FIFO. Slash/UI and explicit shell-mode actions execute their normal command semantics, not model-prompt queuing.
- **Stop / Escape** interrupts OpenCode through its exact API client, or sends one other-harness stop key per press. It also withholds local waiting admissions. Escape in shell mode exits that mode first.
- Each agent/session keeps its draft and queue when you switch targets. Working and blocked agents still accept messages into the queue, but permission prompts never receive queued input.
- **Terminal ↗** always returns to the native terminal, including unsupported client-local/plugin interactions.
- OpenCode reports its selected model, mode, reasoning variant and sampled context usage/window through a TUI metadata reporter, with an optional private bridge for explicit controls. Other harnesses show **not reported** for fields they do not provide, not invented defaults.

### Native-prompt replacement: API milestone, NOT safe to hide yet

Audited against installed **OpenCode 2.2.5**, its matching TUI source and the V2
CLI, keybind, command, permissions, API and TUI-plugin documentation.

The composer follows OpenCode's compact arrangement using Herdr's native primitives,
inherited UI font and standard theme-aware input border, background and focus state.
Agent/model/variant sit directly beneath the text; a quiet footer contains the
recipient, sampled context, native-terminal link and quiet text actions.
That same footer carries the workspace machine/branch and agent/attention counts;
the duplicate standard workspace status bar is hidden in this layout. Narrow
views retain machine/project details on hover. Herdr's global command palette
is available through `…` → **Herdr workspace commands** and its existing shortcut.
Visual hierarchy stays theme-native: a small mode badge, stronger model text,
muted provider/reasoning details, status dots and workspace icons. Attention counts
are highlighted separately from the total agent count. Sampled context has a tiny
meter and percentage (full token details on hover); Send carries the action accent.
There is no separate button toolbar: auxiliary actions live in the attached `…`
menu. Queue/review indicators appear only when relevant, and Stop appears while
working. Location and full recipient details are available on hover. The default
height is 140px, growing for attachments, errors and the local queue.
Agent/model selectors use the live session catalogue
and retain explicit composer selections with the draft. Without an override, the
agent label is the committed session agent and the model is the native client's
reported selection. The public SDK does not expose native unsent agent or
auto-accept mode; the composer never invents the native `auto` indicator.

The optional OpenCode adapter publishes a private same-user Unix socket in its
existing metadata record. Requests include the exact terminal and selected session.
The adapter uses **that terminal client's authenticated SDK and cached live data**,
not a guessed server URL, default service, screen scraping, or simulated key presses.
Local TUIs connected to private/remote servers therefore retain their connection
context; terminals on another machine need a future remote transport. Windows
currently retains metadata/native fallback without this Unix control bridge.

Implemented and checked:

- Live command palette, slash names/aliases, descriptions, shortcuts and custom
  server-command discovery. Typing `/` opens the searchable picker. Built-in and
  plugin UI commands hand off to the real native UI; argument-taking and custom
  prompt commands open an argument editor, never execute on completion selection.
- **Tab** in a slash-command draft opens live argument completion; continuing
  `/cd ...` in the slash picker also enters it directly. The selected client's SDK
  lists server directories for `/cd` (including live aliases), and server files/
  directories for other live argument-taking commands. Relative, absolute, parent,
  nested, space-containing and Unicode paths are supported. Generic argument quoting,
  preceding flags and attachments are preserved; `/cd` retains literal spaces.
  Apply arguments edits arbitrary text without execution. Stale draft/session/location
  responses fail closed, and newer searches discard older results.
- Composer control panels are native surfaces anchored to the composer itself,
  not detached windows or pointer-positioned mod overlays. They share its lifetime
  and recipient; Close, Escape, clicking outside or changing recipients dismisses
  them. Default automated checks do not open visible QA windows.
- Structured prompt/command admission through the exact TUI client's authenticated
  SDK. Native drafts are never typed into. API disconnect retains the draft and
  does not silently fall back to terminal delivery for an identified OpenCode session.
- Live primary-agent and chat-model selection, including per-model variants;
  composer choices are validated and committed on send. Without a composer model
  override, reasoning variants use `context.ui.model.variant`.
- Structured `@skill`, `@agent`, project-reference and server-file/folder attachments,
  including reference-alias subpaths and `#start-end` ranges. Captured dropped/clipboard files and images use
  immutable private bytes, not paths assumed to exist on a remote server. Attachment
  chips remove parts explicitly, with validated captured-image/text previews;
  native clipboard integration still needs physical QA. Inserting `@` mid-draft
  keeps an immutable edit anchor and does not erase surrounding or subsequently changed text.
- Native inbox list, full text detail, cancel, queue/steer and blank-Enter promotion.
  Undo/edit captures every attachment locally and saves a stash **before** cancellation;
  ambiguous cancellation leaves the copy for review, never automatically resubmitting it.
- Per-session structured history and stashes, browsable through History / stash;
  Ctrl+Shift+Up/Down traverses history. Restoring a saved draft stashes current edits.
  `!` in an empty input or the Shell control enters explicit shell mode; Escape exits.
- Permission scope/details, once/always/reject, rejection feedback, session-family
  aggregation and stale-scope checks. Always requires a second confirmation of saved
  project patterns. Typed/conditional question forms cover text/options/custom choices,
  numbers/integers, booleans, multiselect, formats and acknowledged external actions.
- A durable local admission ledger with serialized FIFO. A lost acknowledgement
  blocks later sends and retains their drafts as definitely-unsent/withheld. Receipt
  checks never automatically resend. Manual dismissal is a two-step review action;
  legacy terminal-relay queues remain accessible for recovery without automatic migration.
- Exact session/terminal/protocol validation and an always-visible native escape hatch.
- Activity shows reported cost/tokens/status, navigable session-family entries and
  read-only location-wide shell output. The attached `…` menu keeps auxiliary
  actions available at every width. Narrow composers omit provider/variant/context
  labels; variants remain available in the menu. Recipient selection is attached too.

#### Coverage required before any hide switch

| Surface | Remaining work / acceptance gate |
|---|---|
| Sending | Server commands lack caller-supplied receipt IDs; uncertain command completion requires manual review. Multi-client admission/selection races still need an acceptance test. |
| `/` | Live filesystem argument and `/cd` directory completion is implemented and owned-session native tested. Remaining: native recents, server-home discovery (`~` is not guessed from the client), native-equivalent inline/cursor UX, and command-provided flag/enum schemas (not exposed by 2.2.5). Current popup completes the end-of-query argument; backend edit ranges support an explicit UTF-16 cursor. |
| `@` | Full native-equivalent inline token editing/completion. Current parts are separate chips; inserted-`@` anchors and alias subpath/range search are implemented. |
| Attachments | Physical clipboard/drop QA, pasted path expansion, model-media support warnings and large-paste placeholder UX. Captured-image/text previews are implemented. |
| Editing | Native-equivalent physical IME/selection/undo/redo QA, external editor and active editor selection/context. History/stash UI is implemented. |
| Agent/model | Native unsent agent/auto-mode getters are unavailable; explicit composer selections are independent until committed. Favorites/recents, provider-account selection and limits still use native UI. |
| Blocking UI | Physical interaction and reload tests across every form field and external action; durable form drafts across app restart (currently shared runtime state). Always approval is unit/renderer tested; owned API smoke deliberately does not create permanent rules. |
| Session state | Home/new-session creation, switching/fork/revert/undo/redo, working directory/worktrees, background/retry/error/compaction and reconnect/handoff without stale routing |
| Footer/composer | Provider budget/limits, native interrupt-arming display and shell-job mutation controls; native extension slots are not mirrored. Reported activity/cost/tokens, family navigation, shell-output reads and shell mode are implemented. |
| Failure recovery | Restart/reconnect and remote/private-server physical acceptance; cross-machine/Windows IPC is not implemented. Uncertain-send/withheld FIFO logic and exact-route validation are automated. |

Every row needs automated coverage plus an owned-session native smoke test before
hiding. The documented TUI slots currently expose prompt **footer** extension and
composer-top insertion, not a supported replacement/hide API for the entire native
prompt. Do not walk private renderable trees, crop terminal rows or hide an input
that may become an approval/question. Keep the native prompt visible until both
coverage and a supported visibility mechanism exist.

Sources: [TUI SDK](https://opencode.ai/v2/docs/build/plugins/cli),
[HTTP API](https://opencode.ai/v2/docs/api),
[keybinds](https://opencode.ai/v2/docs/cli/keybinds),
[commands](https://opencode.ai/v2/docs/commands),
[permissions](https://opencode.ai/v2/docs/permissions),
[CLI settings](https://opencode.ai/v2/docs/cli/config).

### Install locally

Requires a running Herdr desktop 0.1.9 and `herdr-app`/`hc` on PATH. No npm dependencies or downloads.

```sh
npm test
npm run check
npm run install:local
```

For the OpenCode bridge (tested against OpenCode V2 2.2.5):

```sh
npm run install:local -- --opencode
```

The installer creates `~/.config/herdr-app/mods/unified-chat/` and a personal **unified-chat** layout cloned from `main`. It preserves the original layout, Herdr settings and keys, refuses unowned naming collisions, and supports rerunning from this source folder. `HERDR_APP_HOME` and `XDG_CONFIG_HOME` are respected.

The optional adapter is copied to `~/.config/opencode/unified-chat-metadata/` and appended to the existing CLI plugin list. Other OpenCode settings remain unchanged, and `cli.json.before-unified-chat` preserves the original. Configuration reloads live; don't restart the user's clients/service. Subsequent installs also update an adapter installed by this repository. Metadata publishing is read-only; explicit bridge actions can submit prompts, run commands/shells, interrupt, mutate inbox entries, reply to permissions/questions or change a selected variant. Discovery never invokes these actions.

For Claude Code sessions (model, effort and permission mode in the footer, and the pickers that change them):

```sh
npm run claude:install
```

This copies two scripts to `~/.claude/hooks/`: `unified-chat-statusline.py`, the statusLine command that reports model, effort and context, and `unified-chat-mode.py`, a hook that records the session's permission mode, which the statusLine payload itself does not carry. It sets `statusLine` only when absent or already ours, adds its own hook entries for SessionStart, UserPromptSubmit, PreToolUse and Stop, and keeps `settings.json.before-unified-chat-claude`. The mode shows after Claude's next prompt or tool call; sessions started before the install load the hook on restart.

Claude Code has no control socket, so the footer's pickers for a Claude terminal type into it through `hc send`/`hc keys`, only while it is idle and never as a prompt: `/model <alias or id>`, `/effort <level>`, `/plan`, and Shift+Tab for the next permission mode (Claude has no command that sets one by name). The footer updates on Claude's next statusLine refresh, within about 15 seconds.

Switch back through Herdr's layout picker or:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

No global keys are installed. The Return/Escape bindings apply only inside the composer. Optional app commands for a shown copy are `unified-chat.focus`, `unified-chat.send`, `unified-chat.stop` and `unified-chat.terminal`.

### Sidebar: spaces → agents as one tree

```sh
npm test
npm run fold:install   # replaces the sidebar's Spaces and Agents blocks with one tree
npm run fold:ui        # hot-reload the mod only; layout untouched
```

`mods/fold` is the whole sidebar. Each machine lists its spaces (worktrees under
their checkout, avatar, `repo · branch ↑↓`, right-click menu, drag to reorder);
under each space sit its live agents from `agents()`, sub-agents nested from
`terminals()` parents, pin on hover, click to focus. The chevron folds a space;
folded, it shows how many agents it hides and their most urgent state. The
narrow rail shows numbered spaces. It reads only Herdr's live data: no registry,
no worker, no polling of files.

The installer edits only a personal (cloned) layout and keeps
`<layout>.json.before-fold`. The pure tree model (`mods/fold/tree.js`) is covered
by `test/fold-tree.test.js`.

### All sessions view (Linux, opt-in)

```sh
npm run sessions:install   # registry worker as a user service + the window
npm run sessions:ui        # hot-reload the window only
npm run sessions:preview
```

**Sessions** in the unified chatbar opens the `sessions` window: every harness
session the registry knows, grouped Connected / Background / Disconnected with a
filter. Connected rows open the existing terminal. Disconnected rows reconnect by
an exact, verified native session command when available; unknown identities stay
visible rather than being guessed. **Drag a row onto a space in the sidebar to
re-adopt it there**: a live terminal moves without restarting; a saved one records
its destination and reconnects there on click. Drops are ignored until the view
is installed (`npm run fold:ui` after `sessions:install` wires the sidebar to the worker).

The `herdr-sessions.service` user service keeps `~/.local/state/herdr-sessions/sessions.json`
up to date and never restarts a harness or server. Its config is
`~/.config/herdr-app/data/sessions-config.json`. All observed live harness terminals
are cataloged, including status-reporting agents without a known resume adapter;
entries persist after clients disconnect. Native metadata discovery lists saved
OpenCode, Claude, Codex, Pi, OMP and Gemini sessions where their local stores/API
are available. Stored prompts, responses, tool output and credentials are not copied.
OpenCode is queried only through its authenticated CLI; Codex metadata is queried
read-only; native-file parsing retains only identity/project/title metadata.

Recovery uses a session's original existing tab or explicitly adopted space; it
never creates a recovery project or launches every saved conversation. An earlier
installer created a recovery space named "Sheep"; `npm run sessions:retire-recovery`
parks its live terminals without ending them and closes it once empty.

Pointer gestures use documented GPUI handlers; physical dragging still needs a
human QA pass. The native move path is verified with an owned non-model fixture
(`npm run test:adoption:native`), cleaned up afterward.

```sh
systemctl --user status herdr-sessions.service
journalctl --user -u herdr-sessions.service
systemctl --user disable --now herdr-sessions.service  # leaves harnesses running
```

### Earlier OpenCode-only watcher (superseded by the session registry)

```sh
npm run restore:preview
npm run restore:install
```

This installs `opencode-herdr-restore.service` in the user systemd manager. Every
10 seconds it observes the **existing** local shared OpenCode service and local
Herdr core. It records exact session IDs reported by live OpenCode terminals,
their project directories, and their Herdr space/tab IDs. It does not start a
missing OpenCode server, load historical sessions, or change shared-server pane
environment variables. Private/explicit servers and remote terminals are excluded.

After the server's process identity changes, clients still attached are left
alone. A missing client is resumed with `opencode --session <id>` in a new kept
terminal in its original existing tab; occupied terminals are never typed into.
Only the client is restored: prompts, tests, builds and dev servers are **not**
replayed. A surviving TUI reconnecting without hydrated metadata is not duplicated.
An observed ordinary client quit stays closed (30-second observation grace).
Session switching retires the previous selection; child sessions are not adopted.
Launch attempts are persisted before execution and not blindly retried on errors.
Deleted tabs/sessions are not recreated. A missing window defers restoration until
the app returns; the sidecar never issues focus commands.

Placement is stored privately in `~/.local/state/opencode-herdr/sessions.json`;
invalid state is retained and reported, never reset. Preview does not write state
or launch clients. The sidecar starts at login and can be stopped without touching
OpenCode/Herdr or jobs:

```sh
systemctl --user disable --now opencode-herdr-restore.service
journalctl --user -u opencode-herdr-restore.service
```

Keep this checkout in place while installed (the unit runs its script). Re-running
the installer updates only its owned unit. No restart of either user's server is
needed. Unit tests use synthetic snapshots and never restart real services.

### Queue and delivery boundaries

Connected OpenCode uses its **server-owned native inbox**. Local admission is serialized per exact target, saved before transmission and never automatically retried. Unknown in-flight sends become uncertain after reload; scheduled-but-unsent entries become withheld. Both remain in Queue, with restore/receipt/manual-review controls. An uncertain earlier send blocks later admissions. Stop withholds scheduled sends; stopping server execution uses `resume:false`.

Other harnesses retain a local FIFO in this composer copy. It dispatches while its layout remains alive, including when another agent/space is viewed. Switching layouts or quitting stops local dispatch. Recovered queues pause for inspection. Old terminal-relay OpenCode queues are not automatically migrated or replayed; recover them explicitly in Queue.

Only live, status-reporting agents are recipients. Address, creation time and a reported session ID (when available) qualify targets; changing sessions inside a terminal cannot intentionally route an older session's queue into the new session. Ready-state sends use core's `--if idle`. Core's CLI has no `--if done`, so finished agents use normal guarded send; that retains the blocked-prompt guard but cannot atomically exclude a change to working. Changing native session selection while a core send is waiting is another terminal-relay limitation—structured harness adapters are the eventual remedy.

Submission is not completion. Other-harness terminal sends require observed activity and a turn boundary before the next local entry dispatches; OpenCode requires an API acknowledgement, with completion/scheduling owned by the server. Stop never kills terminals and never automatically resumes a local queue.

### Metadata and trust

The OpenCode TUI adapter emits a small named OSC 7501 record containing **metadata only** plus its private IPC endpoint and capabilities. Publishing never changes lifecycle state or transmits prompts/transcripts. Explicit requests can read live catalogues/state, submit structured prompts/commands/shells, interrupt, mutate the native inbox, reply to permissions/forms, or select variants. Sensitive/large request bodies use private request files rather than argv. State summaries omit attachment bodies; full copies are requested only for explicit edit/export or owned test assertions. A selected native command retains its own behavior/dialogs. Discovery/background refresh never invokes commands or grants permission. Records expire after 45 seconds without a heartbeat.

Context is sampled input + cache + output from the latest completed request using the selected model—not session-lifetime token totals, a live tokenizer, or evidence that work is done. The tooltip identifies the sample and input limit. Unknown usage remains unknown.

For local shared-service OpenCode sessions already reporting an exact session ID, an external Node helper can also read metadata through authenticated `opencode api` GETs. It reads model/session data and up to three recent assistant records, returning only metadata to Herdr. Private/explicit servers and unconnected remote clients are not silently guessed. The TUI reporter avoids this fallback and works with the data its actual connected server provides.

The composer uses `hc send`/`hc interrupt` only for other-harness queued messages/Stop, never `--force` or terminal kill. Ordinary prompt text is never shell-evaluated. **Explicit shell mode intentionally runs its text as a server-side shell command.** Drafts/history/stashes and admission metadata are plaintext in Herdr's local storage; captured attachment bytes live in a private same-user cache. No native-prompt hiding is implemented.

### Checks

```sh
npm test          # pure queue, routing, draft and metadata behavior
npm run check    # actual Herdr native loader/render check
npm run check:controls  # loaded command/slash/variant/mention rows, no live actions
npm run check:attention # permission + every form field's native renderer
npm run test:native
npm run test:opencode-api # owned session/terminal only, generation disabled
```

The default native smoke loads the actual composer with its attached completion
surface offscreen. It validates native retained-state edits, structured-attachment
preservation, stale-draft rejection and the anchored render without opening a window.
The earlier visible terminal/key-action fixture is available only with explicit
`--visible-fixture` opt-in; it is never launched by default. Physical keyboard,
focus/dismissal and every harness version still need hands-on QA.

The API smoke creates/deletes its own OpenCode session and terminal. It verifies exact
multiline text, captured bytes, skill identity, receipts, complete queued-draft copying,
native inbox cancellation, persisted typed form answers (including false/zero), inert
permission once/reject, and one explicit `printf` shell command. No persistent approval
rules are created and prompt generation is disabled (`resume:false`). Evidence is in
`evidence/opencode-api-result.json`. Real server completion responses are also
fed through the native offscreen attached-panel smoke, including slash-to-argument
transition, draft edits, attachment preservation and stale-draft rejection. No
visible QA window is opened. Directory creation between reads verifies results
are live, not cached menus. Earlier visible-fixture evidence covered key dispatch
and uncertain-ack FIFO; it is not presented as fresh OS-key testing of the attached UI.

### Harness reporting and chatbar integration

See `HARNESSES.md` for the parity playbook: the procedure used for OpenCode,
the capability matrix for Claude Code, Codex and pi, and `npm run harness:audit`,
which inventories installed harnesses and their control surfaces read-only.

Run `npm run reporting:audit` against the running core. It queries terminal
reports without launching harnesses or sending prompts. A report present now is
not proof of correct lifecycle transitions: test an owned session through start,
working, permission/question blocked, idle/done, error, session switch and exit.

Current Herdr agents use **OSC 7501** root status reports. A generic launch wrapper
cannot reliably detect permission prompts or completion. Each harness needs native
hooks/events (or its own built-in Herdr integration) emitting those transitions
from the terminal client. Never derive readiness from screen text or silence.
The chatbar now treats absent terminal status as unknown, even if the UI agent
list says idle; unknown targets do not dispatch queued messages.

Keep three capabilities separate:
- Root lifecycle status controls queue readiness and core turn tracking.
- Exact session identity controls reconnect and session-specific routing.
- Optional named `unified-chat` metadata supplies model/mode/context. Its idle
  record is not the agent's root readiness signal.

The inspected machine has legacy Claude and OpenCode session integrations using
`HERDR_PANE_ID` / `HERDR_SOCKET_PATH` and `pane.report_agent_session`; these alone
are not evidence of current core OSC reporting. Preserve those files for the old
app. Prefer current harness-native integration where available, and add separate
adapters for missing native event APIs. The existing OpenCode metadata adapter
only supplies metadata; it deliberately does not overwrite root readiness.
Codex launched through hc requires `--no-daemon` per the installed core guide.
No universal status adapter or live harness verification is claimed here.

Validation in the restricted development session: pure suites passed. The older
restore-worker suite timed out, and native render/window checks were blocked by
Wayland/socket permissions. Before applying, run `npm test`, `npm run check`, and
`npm run check:sessions` from a normal desktop terminal. Install the composer with
`npm run install:local`, then update the sidebar with `npm run sessions:ui`.
The running session worker needs restarting to load its updated recovery policy;
this does not restart harnesses (`systemctl --user restart herdr-sessions.service`).
