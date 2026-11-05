# herdr-composer

A Claude Code mod for terminals that run inside Herdr. When Herdr's unified
composer is the input for a terminal, Claude's own prompt area is quieter: the
hint line under the prompt (`? for shortcuts`, `shift+tab to cycle`) and the
session-mode labels are blanked. The prompt box itself has no plugin surface in
Claude Code 2.1.318 and stays visible; the permission-mode pill is drawn by the
engine beside the hint and stays too.

The mod does nothing outside Herdr (no `HC_TERMINAL_ID`) or in headless runs.
Inside Herdr it polls `~/.local/state/unified-chat/composer/<terminal>.json`
once a second; Herdr's pane-header toggle (`mods/pane-composer`) writes
`{"composer":"unified"}` or `{"composer":"harness"}` there. No file means
unified. Installed by `npm run claude:install`, which copies this folder to
`~/.claude/hooks/unified-chat-composer` and names it in `CLAUDE_CODE_PLUGIN_DIRS`
in the `env` block of `~/.claude/settings.json`.
