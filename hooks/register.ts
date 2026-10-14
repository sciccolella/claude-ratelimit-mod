import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  agentCheckpoint,
  fiveHour,
  formatLimits,
  orchestratorStopMessage,
  resumeAt,
  resumeMessage,
  shortHash,
  shouldTrigger,
  stopMessage,
} from './logic'

const phase = { plugin: 'rate-limit-guard', key: 'phase' } as const
const resetsAt = { plugin: 'rate-limit-guard', key: 'resetsAt' } as const
const lastDrained = { plugin: 'rate-limit-guard', key: 'lastDrained' } as const

// idle is left out: a finished subagent or a teammate between turns has nothing to checkpoint.
const LIVE = new Set(['pending', 'running', 'waiting'])
const POLL_MS = 30_000

type ResumeMode = 'continue' | 'compact' | 'clear'
type Config = { dir: string; isAutoResume: boolean; bufferMs: number; resumeMode: ResumeMode }

const RESUME_MODES = new Set<string>(['continue', 'compact', 'clear'])
const COMPACT_INSTRUCTIONS =
  'Keep only the overall goal and the paths of the checkpoint files; the checkpoints hold the state.'

let poll: Timer | undefined

// $.state is per session and /clear wipes it, so the drained mark also lives in a file:
// without it the cleared session re-fires in the window it already drained.
const markFile = (dir: string) => `${dir}/.drained.json`

async function loadDrained($: EngineInterface, dir: string): Promise<string | null> {
  const { value } = await $.state.get(lastDrained)
  if (typeof value === 'string') return value
  try {
    const parsed = JSON.parse(await $.fs.read(markFile(dir)))
    return typeof parsed?.resetsAt === 'string' ? parsed.resetsAt : null
  } catch {
    return null
  }
}

// A failed write must not stop the guard: the in-memory mark still holds until a clear.
async function saveDrained($: EngineInterface, dir: string, at: string | null) {
  await $.state.set(lastDrained, at)
  await $.fs.write(markFile(dir), JSON.stringify({ resetsAt: at })).catch(() => {})
}

// A failed id lookup must not stop the guard: fall back to a fixed hash.
async function sessionHash($: EngineInterface): Promise<string> {
  return shortHash(await $.session.id().catch(() => 'unknown-session'))
}

// Poll rather than one long timer: it survives clock drift and a laptop sleep.
function watchForReset($: EngineInterface, cfg: Config) {
  poll?.cancel()
  if (!cfg.isAutoResume) return

  poll = $.clock.every(POLL_MS, async () => {
    const [{ value: p }, { value: at }] = await Promise.all([
      $.state.get(phase),
      $.state.get(resetsAt),
    ])
    if (p !== 'draining') return poll?.cancel()

    const now = await $.clock.now()
    if (now < resumeAt(at ?? null, now, cfg.bufferMs)) return

    poll?.cancel()
    await $.state.set(phase, 'armed')
    $.ui.status(undefined)
    $.ui.toast('rate-limit-guard: window reset, resuming')
    // Taken before a clear: the new session id would hash to a different checkpoint name.
    const hash = await sessionHash($)
    // After a 5h wait the prompt cache is cold, so re-sending the old transcript is the expensive part.
    // A failed clear or compact must not stop the resume: continue in the same session instead.
    if (cfg.resumeMode === 'clear') await $.command.run({ command: 'clear' }).catch(() => {})
    if (cfg.resumeMode === 'compact') {
      await $.session.compact({ instructions: COMPACT_INSTRUCTIONS }).catch(() => {})
    }
    await $.prompt.submit({ text: resumeMessage(cfg.dir, hash) })
  })
}

export const register: Register = (on, options) => {
  const threshold = Number(options.threshold ?? 90)
  const dir = String(options.checkpointDir ?? '.claude/checkpoints')
  const isAutoResume = options.autoResume !== false
  const bufferMs = Number(options.resumeBufferSeconds ?? 60) * 1000
  const mode = String(options.resumeMode ?? 'clear')
  const resumeMode = RESUME_MODES.has(mode) ? (mode as ResumeMode) : 'clear'
  const cfg: Config = { dir, isAutoResume, bufferMs, resumeMode }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'rate-limit-guard-rearm',
      description: 'Re-arm the rate-limit guard for the current window (clears the drained mark)',
    })
    await $.command.register({
      name: 'rate-limit-guard-status',
      description: 'Show the rate-limit windows and the guard state',
    })
    // A hot reload re-runs this; a draining session keeps polling.
    if ((await $.state.get(phase)).value === undefined) {
      await $.state.set(phase, 'armed')
      await $.state.set(resetsAt, null)
      await $.state.set(lastDrained, await loadDrained($, dir))
    }
    if ((await $.state.get(phase)).value === 'draining') watchForReset($, cfg)

    return next(e)
  })

  on('command.run', { command: 'rate-limit-guard-status' }, async $ => {
    const { rateLimits } = await $.session.usage()
    const { value: held } = await $.state.get(phase)

    return { text: `${formatLimits(rateLimits, threshold)}\nguard: ${held ?? 'unknown'}` }
  })

  on('command.run', { command: 'rate-limit-guard-rearm' }, async $ => {
    poll?.cancel()
    await $.state.set(phase, 'armed')
    await $.state.set(resetsAt, null)
    await saveDrained($, dir, null)
    $.ui.status(undefined)

    return { text: 'rate-limit-guard re-armed: it can fire again in the current window.' }
  })

  on('session.measure', async ($, e, next) => {
    const limit = fiveHour(e.rateLimits)
    const held = await $.state.get(phase)
    const drained = await loadDrained($, dir)

    if (
      held.value !== 'draining' &&
      limit !== undefined &&
      shouldTrigger(limit, threshold, drained)
    ) {
      // ifVersion: two measures in a burst must not both trigger.
      const claim = await $.state.set(phase, 'draining', { ifVersion: held.version })

      if (claim.isSet) {
        await $.state.set(resetsAt, limit.resetsAt ?? null)
        await saveDrained($, dir, limit.resetsAt ?? null)
        $.ui.status(`rate-limit-guard: ${limit.percentUsed}% — checkpointing`)
        $.ui.toast(`5-hour window at ${limit.percentUsed}%: asking agents to checkpoint and stop`)

        // A failed listing must not stop the orchestrator from being told.
        const agents = (await $.agent.list().catch(() => [])).filter(a => LIVE.has(a.status))
        const hash = await sessionHash($)
        await Promise.allSettled(
          agents.map(a =>
            $.session.send({
              to: { agentId: a.id },
              text: stopMessage(
                limit.percentUsed,
                agentCheckpoint(dir, a.name ?? (a.description || a.type), a.id, hash),
              ),
            }),
          ),
        )
        void $.prompt.submit({ text: orchestratorStopMessage(limit.percentUsed, dir, hash) })
        watchForReset($, cfg)
      }
    }

    return next(e)
  })

  // The orchestrator may be mid-turn for a long while; keep the instruction in its system prompt too.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if ((await $.state.get(phase)).value !== 'draining') return out

    return {
      sections: [
        ...out.sections,
        {
          id: 'rate-limit-guard:draining',
          scope: 'session',
          text:
            `The 5-hour usage limit is nearly exhausted. Start no new work. Finish the current unit, ` +
            `write checkpoints to ${dir}/, and stop. Work resumes automatically after the reset.`,
        },
      ],
    }
  })
}
