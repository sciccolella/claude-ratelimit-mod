export type Phase = 'armed' | 'draining'

declare module 'claude-code' {
  interface PluginState {
    'rate-limit-guard': {
      /** armed: watching; draining: told everyone to checkpoint, waiting for the reset. */
      phase: Phase
      /** ISO reset time of the five_hour window that was drained, or null. */
      resetsAt: string | null
      /** resetsAt of the last window we drained, so one window triggers once. */
      lastDrained: string | null
    }
  }
}
