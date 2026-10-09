export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

export const fiveHour = (limits: readonly Limit[]): Limit | undefined =>
  limits.find(l => l.kind === 'five_hour')

/** Trigger once per window: at/over threshold, and not the window already drained. */
export const shouldTrigger = (
  limit: Limit | undefined,
  threshold: number,
  lastDrained: string | null,
): boolean =>
  limit !== undefined &&
  limit.percentUsed >= threshold &&
  (limit.resetsAt === undefined || limit.resetsAt !== lastDrained)

/** When to resume: the reset time plus a buffer; five hours from `now` if the reset is unknown. */
export const resumeAt = (resetsAt: string | null, now: number, bufferMs: number): number => {
  const at = resetsAt === null ? NaN : Date.parse(resetsAt)

  return (Number.isNaN(at) ? now + FIVE_HOURS_MS : at) + bufferMs
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'agent'

/** First 8 hex chars of a SHA-256: enough to keep sessions' checkpoints apart. */
export const shortHash = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return Array.from(new Uint8Array(bytes))
    .slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/** <dir>/<name>-<agentId>-<sessionHash>.md, one file per agent per session. */
export const agentCheckpoint = (dir: string, name: string, agentId: string, hash: string): string =>
  `${dir}/${slug(name)}-${slug(agentId)}-${hash}.md`

export const orchestratorCheckpoint = (dir: string, hash: string): string =>
  `${dir}/orchestrator-${hash}.md`

export const stopMessage = (percent: number, path: string): string =>
  `RATE-LIMIT GUARD: the 5-hour usage window is at ${percent}%. Stop at the next safe point ` +
  `(finish the current atomic unit of work; do not start new subtasks or long tool calls). ` +
  `Write a checkpoint to exactly ${path} (use that filename, it is unique to you) covering: ` +
  `what is done, what is in progress, exact next steps, files touched, and any state needed to ` +
  `resume cold. Then reply "CHECKPOINTED" and stop. Work resumes automatically after the window resets.`

export const orchestratorStopMessage = (percent: number, dir: string, hash: string): string =>
  `RATE-LIMIT GUARD: the 5-hour usage window is at ${percent}%. Every running subagent has been told to ` +
  `checkpoint and stop, each to its own ${dir}/<name>-<agentId>-${hash}.md. You must: (1) not start or ` +
  `dispatch any new work; (2) collect each subagent's "CHECKPOINTED" reply (wait for in-flight ones; ` +
  `do not wait on any that stall); (3) write your own orchestrator checkpoint to exactly ` +
  `${orchestratorCheckpoint(dir, hash)} (overall goal, plan, which subagents finished / were stopped / ` +
  `never started, their checkpoint files, and the exact next steps); (4) reply "CHECKPOINTED" and stop. ` +
  `Work resumes automatically after the window resets.`

export const resumeMessage = (dir: string, hash: string): string =>
  `RATE-LIMIT GUARD: the usage window has reset. Read ${orchestratorCheckpoint(dir, hash)} and the ` +
  `per-agent checkpoints matching ${dir}/*-${hash}.md (ignore files with a different hash: they belong ` +
  `to other sessions), then continue the work: re-dispatch subagents from their checkpoints and carry on ` +
  `from where you stopped. Rename each checkpoint to *.consumed.md once resumed.`
