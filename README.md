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
| `resumeMode` | `continue` | `continue` keeps the full transcript, `compact` compacts the session, `clear` runs `/clear` before resuming. `/rate-limit-guard-resume-mode` overrides it for one session |

## Checkpoint files

- Agents: `<dir>/<name>-<agentId>-<sessionHash>.md`, with the exact path given in each agent's stop message.
- Orchestrator: `<dir>/orchestrator-<sessionHash>.md`.
- `<sessionHash>` is the first 8 hex chars of the SHA-256 of the session id. The resume prompt only reads files with the current session's hash.

## Commands

Each command also has a short name: `/rlg-status`, `/rlg-resume-mode`, `/rlg-rearm`.

- `/rate-limit-guard-status` shows each rate-limit window the API reports (percentage and reset time), the guard state (`armed` or `draining`) and the resume mode in effect. In testing only the 5-hour window was reported; a weekly window did not appear, so the guard watches the 5-hour window only.
- `/rate-limit-guard-resume-mode [clear|compact|continue|default]` sets the resume mode for the current session only, overriding `resumeMode`; `default` drops the override and a bare call shows the mode in effect. It runs immediately, even mid-turn. The override is lost on `/clear`, so after a `clear` resume the new session goes back to the default.
- `/rate-limit-guard-rearm` clears the "already drained" mark so the guard can fire again in the same window (useful for testing). The mark is also kept in `<checkpointDir>/.drained.json`, so it survives `/clear` and also holds for a new session in the same project: once a window has been drained, the guard does not fire again in it until you re-arm.

## Resume mode

The wait for the reset (up to 5 hours) outlasts the prompt-cache TTL, so resuming in the same session re-sends the whole old transcript uncached. By default (`continue`) the guard accepts that cost and resumes with the full transcript. The checkpoint files already hold the state, so `clear` runs `/clear` first and the resume prompt names the old session's checkpoint files. `compact` keeps a model-written summary instead, at the cost of one model call over the cold transcript. To opt a single long run into `clear` or `compact` without changing the setting, run `/rate-limit-guard-resume-mode clear` (or `compact`) in that session. If the clear or compact fails, the guard resumes in the current session anyway.

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
