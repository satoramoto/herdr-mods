// herdr-composer: inside a Herdr terminal (HC_TERMINAL_ID set), Herdr's unified
// composer is the input, so the dim lines under Claude's prompt (the shortcut hint,
// the permission-mode pill, the session-mode labels) are blanked. The prompt box
// itself has no plugin surface and stays. Herdr's pane-header toggle writes
//   ~/.local/state/unified-chat/composer/<terminal>.json  {"composer":"unified"|"harness"}
// and this module polls it once a second. No file, or no HC_TERMINAL_ID: Claude
// draws its own lines as usual.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ComposerMode } from '../types'

const mode = atom({ plugin: 'herdr-composer', key: 'mode' } as const, null)

export function parseMode(text: string | null | undefined): ComposerMode {
  // Anything unreadable means the default for a Herdr terminal: the unified composer.
  if (!text) return 'unified'
  try {
    const data = JSON.parse(text) as { composer?: unknown }
    return data.composer === 'harness' ? 'harness' : 'unified'
  } catch {
    return 'unified'
  }
}

export function stateFile(home: string, terminal: string): string | null {
  // The terminal id is a short core address (t5x); refuse anything path-like.
  if (!/^[a-z0-9_-]{1,32}$/i.test(terminal)) return null
  return `${home}/.local/state/unified-chat/composer/${terminal}.json`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const terminal = await $.env.get('HC_TERMINAL_ID')
    const home = await $.env.get('HOME')
    const path = terminal && home ? stateFile(home, terminal) : null
    if (!path || !e.isInteractive) return next(e)

    let last: ComposerMode | null = null
    const poll = async () => {
      let text: string | null = null
      try {
        text = await $.fs.read(path)
      } catch {
        text = null
      }
      const current = parseMode(text)
      if (current !== last) {
        last = current
        await update($, mode, () => current)
      }
    }
    await poll()
    $.clock.every(1000, poll)

    return next(e)
  })

  // The hint line under the prompt (`? for shortcuts`, the permission-mode pill).
  // Rewriting `hint` keeps the engine's pills, so draw an empty tree in its place.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if ((await read($, mode)) !== 'unified') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // The dim mode labels at the right of the prompt footer (`focus`, `memory paused`).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if ((await read($, mode)) !== 'unified') return next(e)
    return next({ ...e, props: { ...e.props, modes: [] } })
  })
}
