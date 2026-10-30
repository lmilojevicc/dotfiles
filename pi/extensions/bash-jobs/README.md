# bash-jobs

Pi's `bash` tool, except that no command can hold the agent for long. A command still running after 30 seconds keeps running in the background as a job; the model gets its output so far, carries on, and receives a message with the result when the job exits. Nothing is killed for running long, so dev servers, watchers and slow builds work as before.

The model needs no new tool. It uses `bash` as usual, with:

- **`background: true`** to start a server, watcher or long build in the background at once. The call still waits one second, so a command that fails straight away (port in use, typo) reports the failure inline. `run_in_background`, `is_background` and string values are accepted too, for models trained on other agents.
- **Job control across calls**, as in an interactive shell: `jobs` lists jobs, `wait %N` waits for one and `kill %N` stops it, anywhere in a command (`wait %2 && npm test`, `kill %1; npm run dev`). Every command sources a small script that defines these three as functions; `%N` reaches an earlier call's job only when the command started no background jobs of its own, otherwise bash's meaning applies. Run on its own, `wait %N` is handled by the extension: it waits up to 30 s (or `timeout` seconds, at most 10 minutes) and returns the job's exit status and last output, and `kill %N` escalates to SIGKILL after 2 s.
- **`timeout`** keeps Pi's meaning: the command is killed after that many seconds, in the foreground or the background.

The prompt guidelines tell the model not to sleep or poll for a job to finish, to `wait %N` before answering when its answer depends on a job (ending the turn is the final answer for subagents and print runs, and their jobs stop with it), and to check a server's readiness with one bounded `curl` loop.

When a job ends, the extension sends a `bash-job` message with its exit status, last 30 lines and log path. It steers a running turn, or starts a turn when the agent is idle. A job the model already waited on or stopped sends no message. After a print or JSON run has finished, nothing is sent.

A command that exits but leaves processes running in its process group (`npm run dev &`) becomes a job as well, so `kill %N` works and the processes are stopped with the session. A process that escaped the group (`setsid`) and keeps the output pipes open no longer blocks the call; it is let go after one second.

Commands run with `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `EDITOR` and `VISUAL` set to `true`, `PAGER` and `GIT_PAGER` set to `cat`, `GIT_TERMINAL_PROMPT=0` and `PYTHONUNBUFFERED=1`. Without a terminal, `git commit` or `git rebase -i` would otherwise sit in nvim forever, and Python's buffered output would leave job logs empty.

Running the same command again while it still runs as a job is refused with a pointer to `kill %N`.

While jobs run, a `background_jobs` section in the system prompt lists them (number, command, pid, log), so the model still knows a server is up many turns later or after a compaction. It is set when a run starts and holds no running times, so it changes only when jobs start or end; Pi sends the model just that change, and drops the section when no job runs.

## Lifecycle

- Job output goes to `$TMPDIR/pi-bash-jobs/<session id>-<pi pid>/job-<N>.log`, capped at 64 MB. The same directory holds the job-control script and, per job, its process group (`job-<N>.pgid`, removed when it ends), exit status (`job-<N>.status`) and a `job-<N>.watched` marker for jobs a command waited on or killed.
- Quitting, `/new`, `/resume` and `/fork` stop every job (SIGTERM, then SIGKILL) and delete the logs. If Pi itself is killed, its exit handler sends SIGKILL to the job groups; only `kill -9` of Pi leaves them running, and the next Pi to start removes the directories of Pi processes that are gone.
- `/reload` keeps jobs running: the new runtime picks them up and reports any that ended in between.
- Job numbers continue from the highest one in the session, so a resumed session never reuses a number the model has seen.
- `/jobs` lists jobs for you; `/jobs kill <n>` stops one and tells the model on its next turn, without waking it.
- In the TUI, the footer shows how many jobs are running.

## Configuration

`PI_BASH_WAIT_SECONDS` changes the 30-second wait. The extension reads Pi's `shellPath` and `shellCommandPrefix` settings like the built-in tool. It replaces `bash` only on macOS and Linux and registers nothing on Windows.

## Tests

`npm test` runs real processes and a real Pi session with the faux model, so it needs no provider or network. It covers the foreground wait, moving to the background, leftover and escaped processes, timeouts, abort, SIGTERM escalation, job control, duplicate refusal, the wake-up message, the running-jobs prompt section, the tool text and shutdown.
