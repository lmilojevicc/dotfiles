# bash-jobs

Pi's `bash` tool, except that no command can hold the agent for long. A command still running after 30 seconds keeps running in the background as a job; the model gets its output so far, carries on, and receives a message with the result when the job exits. Nothing is killed for running long, so dev servers, watchers and slow builds work as before.

The model needs no new tool. It uses `bash` as usual, with:

- **`background: true`** to start a server, watcher or long build in the background at once. The call still waits one second, so a command that fails straight away (port in use, typo) reports the failure inline. `run_in_background`, `is_background` and string values are accepted too, for models trained on other agents.
- **Job control across calls**, as in an interactive shell: `jobs` lists jobs, `wait %N` waits for one and `kill %N` stops it, anywhere in a command (`wait %2 && npm test`, `kill %1; npm run dev`). Every command sources a small script that defines these three as functions; `%N` reaches an earlier call's job only when the command started no background jobs of its own, otherwise bash's meaning applies. Run on its own, `wait %N` is handled by the extension: it waits up to 30 s (or `timeout` seconds, at most 10 minutes) and returns the job's exit status and last output, and `kill %N` escalates to SIGKILL after 2 s.
- **`timeout`** keeps Pi's meaning: the command is killed after that many seconds, in the foreground or the background.

The prompt guidelines tell the model not to sleep or poll for a job to finish, to `wait %N` before answering when its answer depends on a job (ending the turn is the final answer for subagents and print runs, and their jobs stop with it), and to check a server's readiness with one bounded `curl` loop.

When a job ends, the extension sends a `bash-job` message with its exit status, last 30 lines and log path. It steers a running turn, or starts a turn when the agent is idle. A job the model already waited on or stopped sends no message; a `wait %N` that a stopped turn or Esc gave up on counts as no answer, so the message still comes. After a print or JSON run has finished, nothing is sent.

A command that exits but leaves processes running in its process group (`npm run dev &`) becomes a job as well, so `kill %N` works and the processes are stopped with the session. A process that escaped the group (`setsid`) and keeps the output pipes open no longer blocks the call; it is let go after one second.

Commands run with `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `EDITOR` and `VISUAL` set to `true`, `PAGER` and `GIT_PAGER` set to `cat`, `GIT_TERMINAL_PROMPT=0` and `PYTHONUNBUFFERED=1`. Without a terminal, `git commit` or `git rebase -i` would otherwise sit in nvim forever, and Python's buffered output would leave job logs empty.

Running the same command again while it still runs as a job is refused: the call fails like a `wait %N` for a missing job, so the model cannot mistake it for a fresh run, and it points at `kill %N`.

While jobs run, a `background_jobs` section in the system prompt lists them (number, command, pid, log), so the model still knows a server is up many turns later or after a compaction. It is set when a run starts and holds no running times, so it changes only when jobs start or end; Pi sends the model just that change, and drops the section when no job runs. A named section is also the only form that survives other extensions: one that returns `systemPrompt` forces the whole prompt for that run and drops every later section, which is why `tests/prompt-sections.test.ts` pins the order with agent-policy and model-instructions.

## Lifecycle

- Job output goes to `$TMPDIR/pi-bash-jobs/<session id>-<pi pid>/job-<N>.log`, capped at 64 MB. The same directory holds the job-control script and, per job, its process group (`job-<N>.pgid`, removed when it ends), exit status (`job-<N>.status`), the pid of each shell waiting for it in `wait %N` (`job-<N>.waiting`, which decides whether a `wait` still needs the end message) and a `job-<N>.watched` marker, created once a `wait %N` has read the status or a `kill %N` has sent its signal.
- Quitting, `/new`, `/resume` and `/fork` stop every job (SIGTERM, then SIGKILL) and delete the logs. When jobs still run, the extension first leaves a `bash-job` message in the session listing them and saying that the Pi process ended, because the next process on that session file gets no word from them: BB restarts Pi when you change the model, the thinking level or environment variables. Jobs that already ended get no such message. If Pi itself is killed, its exit handler sends SIGKILL to the job groups; only `kill -9` of Pi leaves them running, and the next Pi to start removes the directories of Pi processes that are gone.
- `/reload` keeps jobs running: the new runtime picks them up and reports any that ended in between.
- Job numbers continue from the highest one in the session, so a resumed session never reuses a number the model has seen.
- `/jobs` lists jobs for you; `/jobs kill <n>` stops one and tells the model on its next turn, without waking it. In the TUI the answer is a notification; over RPC (BB) it is a `bash-job` message in the transcript instead, which does not start a turn.
- In the TUI, the footer shows how many jobs are running.

## Configuration

`PI_BASH_WAIT_SECONDS` changes the 30-second wait. The extension reads Pi's `shellPath` and `shellCommandPrefix` settings like the built-in tool. It replaces `bash` only on macOS and Linux and registers nothing on Windows.

## Tests

`npm test` runs real processes and a real Pi session with the faux model, so it needs no provider or network. It covers the foreground wait, moving to the background, leftover and escaped processes, timeouts, abort, SIGTERM escalation, job control, duplicate refusal, a `wait %N` whose shell was killed, the wake-up message, the running-jobs prompt section, the tool text, `/jobs` in the TUI and over RPC, and the message a shutdown leaves for the next process on the session file. `prompt-sections.test.ts` also runs agent-policy (and model-instructions) before this extension and asserts that a later provider request still carries both sections.
