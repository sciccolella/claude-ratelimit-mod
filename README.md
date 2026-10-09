# rate-limit-guard

A Claude Code mod that protects long multi-agent runs from the 5-hour usage limit. When the window reaches a threshold (default 90%) it:

1. tells every running subagent to stop at a safe point and write a checkpoint,
2. tells the orchestrator to collect their replies, write its own checkpoint and stop,
3. waits for the window to reset, then prompts the orchestrator to read the checkpoints and continue.

Only the `five_hour` window is watched, and only on a subscription (on API billing there are no rate-limit windows to read).

## Install

```
/plugin install rate-limit-guard --marketplace sciccolella/claude-ratelimit-mod
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `threshold` | 90 | Percent of the 5-hour window that triggers the stop |
| `checkpointDir` | `.claude/checkpoints` | Where checkpoints are written |
| `autoResume` | true | Prompt the orchestrator to continue after the reset |
| `resumeBufferSeconds` | 60 | Extra seconds to wait after the reset time |

## Checkpoint files

- Agents: `<dir>/<name>-<agentId>-<sessionHash>.md`, with the exact path given in each agent's stop message.
- Orchestrator: `<dir>/orchestrator-<sessionHash>.md`.
- `<sessionHash>` is the first 8 hex chars of the SHA-256 of the session id. The resume prompt only reads files with the current session's hash.

## Commands

- `/rate-limit-guard-status` shows each rate-limit window the API reports (percentage and reset time) and the guard state (`armed` or `draining`). In testing only the 5-hour window was reported; a weekly window did not appear, so the guard watches the 5-hour window only.
- `/rate-limit-guard-rearm` clears the "already drained" mark so the guard can fire again in the same window (useful for testing).

## Limits

- The stop messages are advisory: an agent mid-tool-call acts on it at its next turn, and a stalled agent may never checkpoint.
- Usage updates after each model response, so one large turn can overshoot the threshold before the guard reacts.
- Auto-resume lives in the running session. If you close it, resume from the checkpoint files in a new session by hand.
- Agents with status `idle` are not messaged.

## Test

```
claude plugin validate .
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
