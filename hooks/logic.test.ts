import { expect, test } from 'claude-code/testing'

import {
  agentCheckpoint,
  fiveHour,
  orchestratorCheckpoint,
  resumeAt,
  resumeMessage,
  shortHash,
  shouldTrigger,
  FIVE_HOURS_MS,
} from './logic'

const w = (percentUsed: number, resetsAt?: string) => ({ kind: 'five_hour', percentUsed, resetsAt })

test('triggers at the threshold, once per window', () => {
  expect(shouldTrigger(w(89.9, 'a'), 90, null)).toBe(false)
  expect(shouldTrigger(w(90, 'a'), 90, null)).toBe(true)
  expect(shouldTrigger(w(95, 'a'), 90, 'a')).toBe(false)
  expect(shouldTrigger(w(95, 'b'), 90, 'a')).toBe(true)
  expect(shouldTrigger(undefined, 90, null)).toBe(false)
})

test('watches only the five_hour window', () => {
  expect(fiveHour([{ kind: 'seven_day', percentUsed: 99 }])).toBeUndefined()
  expect(fiveHour([{ kind: 'seven_day', percentUsed: 99 }, w(50)])?.percentUsed).toBe(50)
})

test('resumes after reset plus buffer, or five hours out when unknown', () => {
  const reset = '2026-10-09T15:00:00.000Z'
  expect(resumeAt(reset, 0, 60_000)).toBe(Date.parse(reset) + 60_000)
  expect(resumeAt(null, 1000, 0)).toBe(1000 + FIVE_HOURS_MS)
})

test('checkpoint names carry agent id and session hash, and are sanitized', async () => {
  const hash = await shortHash('session-1')
  expect(hash).toMatch(/^[0-9a-f]{8}$/)
  expect(await shortHash('session-1')).toBe(hash)
  expect(await shortHash('session-2')).not.toBe(hash)
  expect(agentCheckpoint('d', 'sleeper a', 'ab12', hash)).toBe(`d/sleeper-a-ab12-${hash}.md`)
  expect(agentCheckpoint('d', '../x', 'ab/12', hash)).toBe(`d/x-ab-12-${hash}.md`)
  expect(orchestratorCheckpoint('d', hash)).toBe(`d/orchestrator-${hash}.md`)
  expect(resumeMessage('d', hash)).toContain(`d/*-${hash}.md`)
})
