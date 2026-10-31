# bash-jobs

Pi's `bash` tool, made as asynchronous as it can be: no command holds the agent for long. A command still running after 10 seconds keeps running in the background as a numbered job; the model gets its output so far, keeps working, and receives a message with the result when the job exits. Nothing is killed for running long, so dev servers, watchers, slow builds and commands that hang or loop all leave the agent free.

## For the model

- **`bash`** as usual, plus **`background: true`** to start a server, watcher or long build in the background at once. The call still waits one second, so a command that fails straight away (port in use, typo) reports the failure inline. `run_in_background`, `is_background` and string values are accepted too, for models trained on other agents. **`timeout`** keeps Pi's meaning: the command is killed after that many seconds, in the foreground or the background.
- **`jobs`**, a second tool, with one `action`:
  - `list`: every job, running or ended, with its pid and log path.
  - `output` (`id`): what the job printed since the model last looked (the bash result counts as a look), at most the last 16 KB; the full log path is always included.
  - `wait` (`id` optional, `timeout` default 30 s, at most 600 s): wait for one job, or every running job, to exit, and return its result. When the time runs out the job keeps running and the answer shows its new output.
  - `kill` (`id`): SIGTERM to the whole process group, SIGKILL after 2 s.
- **No foreground sleeping.** A command that starts with `sleep N` (N ≥ 5 s: `sleep 30`, `sleep 10 && curl …`, `sleep 1m; tail log`) is not run; the answer says that jobs report back on their own and names the running ones. A sleep inside a loop is left alone: the loop moves to the background like any long command.

When a job ends, the extension sends a `bash-job` message with its exit status, last 30 lines and log path. It steers a running turn, or starts a turn when the agent is idle. A job the model already waited on, read to its end, or stopped sends no message; a `wait` that a stopped turn or Esc gave up on counts as no answer, so the message still comes. After a print or JSON run has finished, nothing is sent.

A command that exits but leaves processes running in its process group (`npm run dev &`) becomes a job as well, so `kill` works and the processes are stopped with the session. A process that escaped the group (`setsid`) and keeps the output pipes open no longer blocks the call; it is let go after one second.

Commands run with stdin closed and with `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `EDITOR` and `VISUAL` set to `true`, `PAGER` and `GIT_PAGER` set to `cat`, `GIT_TERMINAL_PROMPT=0` and `PYTHONUNBUFFERED=1`. Without a terminal, `git commit` or `git rebase -i` would otherwise sit in nvim forever, a prompt would wait for input that never comes, and Python's buffered output would leave job logs empty.

## Lifecycle

- Job output goes to `$TMPDIR/pi-bash-jobs/<session id>-<pi pid>/job-<N>.log`, capped at 64 MB.
- Quitting, `/new`, `/resume` and `/fork` stop every job (SIGTERM, then SIGKILL) and delete the logs. If Pi itself is killed, its exit handler sends SIGKILL to the job groups; only `kill -9` of Pi leaves them running, and the next Pi to start removes the directories of Pi processes that are gone.
- `/reload` keeps jobs running: the new runtime picks them up and reports any that ended in between.
- `/jobs` lists jobs for you; `/jobs kill <n>` stops one and tells the model on its next turn, without waking it. In the TUI the answer is a notification; over RPC (BB) it is a `bash-job` message in the transcript instead, which does not start a turn.
- In the TUI, the footer shows how many jobs are running.

## Configuration

`PI_BASH_WAIT_SECONDS` changes the 10-second wait. The extension reads Pi's `shellPath` and `shellCommandPrefix` settings like the built-in tool. It replaces `bash` only on macOS and Linux and registers nothing on Windows.

## Tests

`npm test` runs real processes and a real Pi session with the faux model, so it needs no provider or network. It covers the foreground wait, moving to the background, leftover and escaped processes, timeouts, abort, SIGTERM escalation, the unread-output cursor, every `jobs` action, the sleep guard, the wake-up message and when it is skipped, the tool text, `/jobs` in the TUI and over RPC, and reload versus quit.
