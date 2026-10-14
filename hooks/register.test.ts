import { expect, mock, test } from 'claude-code/testing'

const RESET = '2026-10-09T15:00:00.000Z'
const reading = (percentUsed: number) => ({
  context: { window: 200000 } as never,
  rateLimits: [
    { kind: 'five_hour', percentUsed, resetsAt: RESET },
    { kind: 'seven_day', percentUsed: 99 },
  ],
  changed: ['rateLimits' as const],
})

test('90% starts the drain once; the reset resumes the orchestrator', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse(RESET) - 3_600_000 })
  const submitted: string[] = []
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })

  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as never)
  await $.session.measure(reading(89))
  expect(submitted.length).toBe(0)

  await $.session.measure(reading(91))
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('checkpoint')

  // A second reading in the same window does not trigger again.
  await $.session.measure(reading(93))
  expect(submitted.length).toBe(1)

  // Before reset + buffer: still waiting.
  await clock.advance(3_600_000)

  // After reset + 60s buffer: resumes, re-armed.
  await clock.advance(90_000)
  expect(submitted.length).toBe(2)
  expect(submitted[1]).toContain('has reset')
})

// Drains at 91%, then lets the clock pass the reset; returns what ran before the resume prompt.
async function drainAndResume(
  $: Parameters<Parameters<typeof test>[1]>[0],
  on: Parameters<Parameters<typeof test>[1]>[1],
) {
  const clock = mock.clock(on, { now: Date.parse(RESET) - 3_600_000 })
  const events: string[] = []
  on('prompt.submit', (_$, e) => {
    events.push(`submit:${e.text.slice(0, 20)}`)
    return { text: e.text } as never
  })
  on('command.run', { command: 'clear' }, () => {
    events.push('clear')
    return { text: '' }
  })
  on('session.compact', () => {
    events.push('compact')
    return { skip: 'test' } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as never)
  await $.session.measure(reading(91))
  events.length = 0
  await clock.advance(3_600_000 + 90_000)

  return events
}

test('by default the resume clears the session first', async ($, on) => {
  const events = await drainAndResume($, on)
  expect(events).toEqual(['clear', 'submit:RATE-LIMIT GUARD: th'])
})

test('compact mode compacts, then resumes', { options: { resumeMode: 'compact' } }, async ($, on) => {
  const events = await drainAndResume($, on)
  expect(events).toEqual(['compact', 'submit:RATE-LIMIT GUARD: th'])
})

test('continue mode resumes in place', { options: { resumeMode: 'continue' } }, async ($, on) => {
  const events = await drainAndResume($, on)
  expect(events).toEqual(['submit:RATE-LIMIT GUARD: th'])
})

// The file system stood in for by hooks: a map of path -> text. The engine hands over absolute paths.
const key = (path: string) => path.slice(path.indexOf('.claude/'))

function fakeFs(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, string>) {
  on('fs.read', (_$, e) => {
    const text = files.get(key(e.path))
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    files.set(key(e.path), e.text)
    return { value: undefined }
  })
}

const MARK = '.claude/checkpoints/.drained.json'

test('the drained mark is written to disk when the guard fires', async ($, on) => {
  const files = new Map<string, string>()
  fakeFs(on, files)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as never)
  await $.session.measure(reading(91))
  expect(JSON.parse(files.get(MARK) ?? '{}').resetsAt).toBe(RESET)
})

test('a drained mark on disk survives a wiped state (/clear)', async ($, on) => {
  const submitted: string[] = []
  fakeFs(on, new Map([[MARK, JSON.stringify({ resetsAt: RESET })]]))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: true } as never)
  await $.session.measure(reading(95))
  expect(submitted.length).toBe(0)
})
