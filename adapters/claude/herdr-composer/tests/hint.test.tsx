import { expect, test } from 'claude-code/testing'

const HINT = {
  plugin: 'herdr-composer',
  component: 'PromptHint',
  requestId: 'prompt-hint',
  props: { hint: '? for shortcuts', isDraft: false, isWorking: false },
} as const

const MODES = {
  plugin: 'herdr-composer',
  component: 'SessionMode',
  requestId: 'session-mode',
  props: { modes: ['focus'] },
} as const

// Nothing sits beneath the plugin in a test: this hook stands for the engine's own line.
const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const text = e.component === 'PromptHint' ? e.props.hint : e.props.modes.join(' & ')
    return <Text>{text || 'engine-empty'}</Text>
  })

test('the unified composer blanks the hint and the mode labels', async ($, on) => {
  on('state.get', () => ({ value: { value: 'unified', version: 1 } }))
  engine(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const hint = await $.ui.mount({ ...HINT, surface })
    expect(await hint.find({ type: 'Text', text: /shortcuts/ })).toBeUndefined()
    await hint.unmount()
    const modes = await $.ui.mount({ ...MODES, surface })
    expect(await modes.find({ type: 'Text', text: /focus/ })).toBeUndefined()
    expect((await modes.find({ type: 'Text' }))?.text).toBe('engine-empty')
    await modes.unmount()
  }
})

test('the harness composer leaves the engine lines alone', async ($, on) => {
  on('state.get', () => ({ value: { value: 'harness', version: 1 } }))
  engine(on)
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
  await hint.unmount()
  const modes = await $.ui.mount({ ...MODES, surface: 'terminal' })
  expect((await modes.find({ type: 'Text' }))?.text).toBe('focus')
  await modes.unmount()
})

test('outside Herdr nothing is written, so the engine draws', async ($, on) => {
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  engine(on)
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await hint.find({ type: 'Text' }))?.text).toBe('? for shortcuts')
  await hint.unmount()
})
