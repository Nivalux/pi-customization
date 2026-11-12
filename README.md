# run_wait — wait on processes without sleep loops

Two tools for the **pi** coding agent: start a command in the background and
**return the moment it exits** — not when a wait window expires.

Replaces this pattern:

```bash
nohup your_command > output.log 2>&1 &
PID=$!
for i in {1..90}; do
    kill -0 $PID 2>/dev/null || break
    sleep 2
done
```

The poll loop overshoots by half a poll interval on average, and every iteration
that finds nothing costs a tool round trip. `run_wait` waits on the process `exit`
event instead: a 4 second command costs 4 seconds whether `maxWaitSec` is 20 or 600.

## Install

```bash
npm run install:extension     # links extensions/run-wait.ts into $PI_CODING_AGENT_DIR/extensions
npm run uninstall:extension
```

Or list it in `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/cache/projects/pi-customization/extensions/run-wait.ts"] }
```

Or per project: `.pi/extensions/run-wait.ts` (the project must be trusted).
Run `/reload` or start a new session afterwards.

## run_wait

```
run_wait {
  command: "npm run build",
  output: "/tmp/build.log",
  maxWaitSec: 120
}
```

| Parameter      | Required | Meaning                                                                                                                       |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `command`      | yes      | Shell command (bash, `-c`).                                                                                                    |
| `output`       | no       | Path for stdout **and** stderr. Parent directories are created, relative paths resolve against the session cwd. Default: `$TMPDIR/pi-run-wait/<session>/<cmd>-<id>.log`. |
| `append`       | no       | Append to the log file instead of truncating.                                                                                  |
| `cwd`          | no       | Working directory, defaults to the session cwd.                                                                                |
| `env`          | no       | Extra environment variables, merged over the current ones.                                                                     |
| `maxWaitSec`   | no       | Maximum wait. Default 60, cap 3600.                                                                                            |
| `readyPattern` | no       | Regex tested against the output tail. On match the result returns immediately with `status: ready` and the process keeps running. |
| `tailLines`    | no       | Lines of output in the result. Default 40.                                                                                     |
| `onTimeout`    | no       | `detach` (default: the process keeps running and `wait_job` can resume it) or `kill` (whole process tree).                      |

The result carries status, exit code, elapsed time, pid, job id, log path and the output
tail. A command that exits on its own is **not** a tool error — exit code 3 comes back as a
normal result so the agent can still read the log.

## wait_job

```
wait_job { "job": "a1b2c3", "maxWaitSec": 300 }
```

Attaches to an existing job id with the same `maxWaitSec`/`readyPattern`/`tailLines`/
`onTimeout`. Omit `job` to list every job in the session, which is what to do when the job
id fell out of context.

## Behaviour worth knowing

- **The process runs in its own process group** (`detached`), so `kill` reaches grandchildren
  too — `bash -c 'build & wait'` leaves no orphans. SIGTERM, then SIGKILL after a 5 second grace.
- **A timeout is not a failure.** `onTimeout: detach` is the default: the job keeps running and
  the next `wait_job` picks up where the last one stopped.
- **Servers and daemons:** `readyPattern: "listening on"` returns as soon as the line lands in
  the log and the process stays alive. `wait_job { job, onTimeout: "kill" }` stops it again.
- **Session teardown cleans up.** A `session_shutdown` handler kills anything still running when
  the session ends, so a dev server does not outlive it.
- **Logs are never deleted.** `$TMPDIR/pi-run-wait/` grows one file per job per session.

## Development

```bash
npm run link-modules    # link the pi packages into node_modules (types for tsc, jiti for the test)
npm run typecheck       # tsc against the real pi declarations
npm run test            # 39 checks: early exit, timeout, resume, readyPattern, process-tree kill, abort, renderers
```

The test loads the extension through jiti and calls `execute()` directly, with no model call
involved. `link-modules` resolves the installed package from the `pi` binary; set
`RUN_WAIT_PACKAGE_ROOT` when your install looks different.
