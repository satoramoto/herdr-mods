# Unified chat

A compact native composer below the active tab's terminals. It gives status-reporting harnesses one consistent place to write without changing their existing UI.

## What you see

Inside the workspace column, between the terminal region and status bar, reserve 140 logical pixels for a theme-aware composer. Keep OpenCode's arrangement with Herdr's native primitives and inherited UI font. Use the same input treatment as Herdr's shipped prompt: background theme color, 1px input border (accent on focus), modest rounded corners and 12px horizontal padding. Text comes first, with neutral agent/model/provider/variant labels along the lower edge. Avoid a terminal-style accent rail, forced monospace, boxed action buttons, a recipient header or a separate utility toolbar. Put auxiliary actions in a quiet attached `…` menu. Show review and queue counts only when actionable. Beneath the prompt, one muted line contains recipient/status dot, sampled context, native-terminal link and plain Send/Commands/Stop actions. Show directory and full recipient details on hover; errors get their own line.

For other harnesses, Queue expands to 256px with a local FIFO. Connected OpenCode opens its native inbox/receipt panel instead. Attachments request 33 extra pixels and errors 26. Keep existing tabs, sidebar, Files/Changes, pane headers and terminals. Below 640px wide, omit provider/variant/context labels; keep variants in the menu. Menus and recipient selection stay attached to the prompt.

Use the composer's footer as the single workspace status line too. Read the active space's machine/branch and global live agent/blocked counts using Herdr's reactive primitives. Machine/branch appear beside the recipient at 1000px and above, and remain in its tooltip below that. Counts open the attached agent picker; narrow views retain the attention count. Hide only the standard `workspace-status` block in this personal layout. Keep Herdr's global palette accessible from the `…` menu as “Herdr workspace commands”, using `app.palette`; its existing global shortcut is unchanged.

Give concepts distinct weight without creating another toolbar: the mode is a small accent-colored badge, the model is semibold, provider and variant are secondary, and the recipient is medium-weight beside its status dot. Reuse Herdr's workspace-chrome SVG primitives for machine, branch, agents and terminal. Replace the local machine's repeated text with its icon; keep the name in the tooltip. Only the attention count gets warning emphasis, not the entire agent summary. Use a native Progress primitive for sampled context, with a percentage and full token details on hover; at 90% use the theme's warning color. Unknown context has no meter. Send uses the theme accent, Stop the warning color, and command shortcuts use a quiet small key label. No fixed palette or custom font.

## How it behaves

Return admits a normal draft to the queue; Alt+Return steers in connected OpenCode. Cmd/Ctrl+Return and Shift+Return insert newlines. Snapshot text, structured parts, selection and exact target; immediately allow a fresh draft. OpenCode uses structured API admission and its server-owned inbox, never terminal typing. Other harnesses use a ready-only FIFO and core turn-boundary acknowledgements. Explicit shell mode and slash/UI commands retain their command semantics, not model-prompt semantics.

Stop/Escape withholds scheduled local admissions, then calls the exact OpenCode client's interrupt API with resume disabled, or uses `hc interrupt --timeout 0` for other harnesses. Remain repeatable while requests are in flight. Escape exits explicit shell mode first. Never debounce, automatically double-press, use `--force` or kill terminals.

Follow the displayed/focused agent, never a random fallback or shell. Qualify drafts/queues with machine-aware address, creation time and the harness-reported session ID when present. Save drafts and queues together in localStorage. Recovered queues pause; interrupted in-flight entries become uncertain and cannot silently retry. Keep failures inspectable and removable. Do not steal focus on load.

Provide history/stash browsing, structured skill/agent/file/reference attachment selection, file ranges, immutable local file/image captures, previews/removal and reference subpath search. Save a full queued draft locally before cancelling it for editing. A lost acknowledgement is a FIFO barrier: retain later drafts as definitely-unsent, never retry automatically. Review permissions with full scope and explicit once/always/reject; confirm saved patterns twice. Render typed/conditional questions, including false/zero and external-action acknowledgement. Activity shows reported cost/tokens/status, session-family navigation and read-only location-wide shell output.

Tab in a slash draft opens a live argument editor. Typing `/cd ` in the slash picker transitions directly to directory suggestions. Resolve enabled commands/aliases from the actual TUI registry and server catalogue; use its SDK file.list for path arguments, and directory-only results for native session.cd semantics. Never invoke command callbacks while completing. Preserve generic quoting, flags, following arguments and attachments; treat `/cd`'s argument as a literal path with spaces. Validate unchanged draft/recipient before applying an edit, discard stale searches, and revalidate session/location after asynchronous reads. Do not infer remote home from local environment or invent flag/enum schemas.

Render control panels as a native Popup whose trigger is the composer itself and whose content is part of that same view. Do not open a separate mod overlay/window for completion or other composer controls. Escape, Close, outside click and recipient changes dismiss the attached panel. Default QA must use the native offscreen loader/state check, not visible QA windows; visible fixtures require explicit opt-in.

OpenCode's optional TUI reporter supplies actual visible-session metadata in a named OSC record. Show mode, selected model, variant, sampled context usage and model window. Context must come from a matching model's latest completed request, not cumulative session tokens; show unknown when unavailable. Expire stale reports. No prompt/transcript text belongs in the record.

## Built from

- `mods/unified-chat/main.js`: native `gpui-kit` View, `gpui-base` TextareaState, Textarea, Buttons and flex elements.
- `model.js`: pure live-target selection and drafts. `queue.js`: persistent FIFO state and delivery acknowledgements. `metadata.js`: pure session attribution and formatting.
- `drafts.js` retains structured history/stashes/selections; `admission.js` enforces uncertain-send FIFO barriers. `completion.js` anchors an inserted `@` without guessing the cursor or erasing changed text. `attachments.mjs` is the external private-cache/capture/preview helper.
- `completion.js` also parses argument edit ranges without shell evaluation. Adapter `command-completion.js` supplies exact-client, read-only server path suggestions; its installed `prompt-completion.js` must be the shared implementation, not the source-tree shim.
- Read reactive `agents()`, `terminals()`, `focused()` and `theme()` without polling them. A dirty-work timer dispatches queued actions only after live data/render changes.
- Recipient selection shares the composer's anchored Popup; navigation uses `agent.focus`. Terminal delivery uses `hc()`. The optional local API fallback runs `opencode-bridge.mjs` via Node.
- `adapters/opencode/tui.js` reads documented OpenCode V2 cached client APIs and writes one metadata-only `id=unified-chat` status record, leaving root status untouched. It emits on changes and every 15 seconds, and clears its record on disposal.
- `mod.json` uses `place: none`. Clone `main` as `unified-chat`, then insert `unified-chat-bar` before the workspace status block, height 140/min 140/max at least 315 (expanded queue + attachments + error). `layout.js` shares the view/installer height budget and migrates the previous 174px default, preserving larger personal allocations. Keep metadata and footer at 24px; let the editor fill the remaining clipped region.
- `prompt.js` formats native-style labels and live command search. `opencode-panel.js` displays the live catalogue. The optional adapter's `controls.js` and `socket.js`, with the external `opencode-control.mjs` IPC client, use the exact TUI's supported SDK. No native-prompt hide switch is implemented: the README coverage gates are still open.
- `operations.js` makes exact-client structured SDK calls. `ui-control.js` stages sensitive bodies in private request files. `attention-panel.js` renders approvals/forms; `forms.js` shares validation with the adapter. The installed adapter needs actual shared `metadata.js` and `forms.js` implementations, not the source-tree re-export shims.

## Watch out

The supported OpenCode SDK cannot replace/hide the whole native prompt or read native unsent agent/auto-permission state. Do not cover or crop it. Explicit composer selections remain separate until committed. OpenCode's inbox is server-owned, but local scheduled admissions require this layout to remain alive. Other-harness FIFO dispatch is local. Never claim exactly-once delivery across crashes, command callbacks without caller receipt IDs, or native session changes during terminal relay.

Use argument arrays and `--` before positional text; never shell-interpolate messages. A scoped GPUI **descendant** context (`UnifiedChatComposer > Input`) overrides the textarea's Enter bindings without changing other app inputs. Use native action handlers; plain Enter must not first insert a newline. Native retained state belongs in init/events; synchronous `cx` must never outlive its callback.

An ordinary install changes no Herdr settings/keys or shipped files. `--opencode` appends a separately owned metadata/private-action plugin to CLI configuration and backs up that file; preserve unrelated settings and Herdr-managed integrations. Discovery is read-only; explicit actions can submit prompts, run shells, answer requests and mutate inbox entries. Installation must refuse unowned names and use installed API declarations as authority.

## Done when

- Pure tests cover identity, drafts, FIFO, independent targets, readiness, status races, uncertainty, recovery and metadata sampling.
- `npm run check` passes the actual native module loader/render check.
- Live screenshots show the composer and actual metadata, with the original footer still accessible.
- `npm run test:native` proves the native action path, exact multiline delivery, FIFO, repeatable double Stop and blocked-prompt protection using only its own fixture.
- `npm run check:controls` and `npm run check:attention` render loaded interactive states. `npm run test:opencode-api` verifies an owned API session plus the actual GPUI Send/uncertain-ack path, with model generation disabled and no permanent approvals.
- The original layout remains available, no user agent receives test input, and physical keyboard/harness QA limitations are stated honestly.
