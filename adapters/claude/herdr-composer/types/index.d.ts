// Which composer owns this terminal's input: Herdr's unified bar, or Claude's own prompt.
export type ComposerMode = 'unified' | 'harness'

declare module 'claude-code' {
  interface PluginState {
    'herdr-composer': { mode: ComposerMode | null }
  }
}
