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
