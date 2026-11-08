# bash-improved

Pi's own `bash` tool with Claude Code's background tasks. No bash command can hold the agent for long: a command started with `run_in_background`, or still running after 10 seconds, keeps running as a background task. The model gets its output so far, keeps working, and gets a message with the result when the task exits. Nothing is killed for running long, so dev servers, watchers, slow builds and commands that hang or loop all leave the agent free.

The `bash` tool is Pi's own (`createBashToolDefinition`) with only its process runner swapped, so its output, truncation, rendering and `shellPath`/`shellCommandPrefix` settings stay Pi's.

## For the model

There is still only the one `bash` tool; everything below happens inside it.

- **`bash`** as usual, plus:
  - **`run_in_background: true`** starts a server, watcher or long build in the background at once. The call still waits one second, so a command that fails straight away (port in use, typo) reports the failure inline. `background`, `is_background`, `runInBackground` and string values are accepted too.
  - **`description`**: what the command does in 5–10 words; the user sees it while the task runs.
  - **`timeout`** keeps Pi's meaning: the command is killed after that many seconds, in the foreground or the background. A timeout that comes at most 5 s after the wait keeps the command in the foreground until it ends or is killed, rather than making a task that dies a moment later.
  - **`ready: {port?, host?, log?, timeout?}`** starts a server in the background and returns once it is ready: the port accepts TCP connections (on `127.0.0.1` or `::1` unless `host` is given) and/or an output line matches the `log` regular expression (colour codes stripped). When both are given, both must hold. The result says `Ready: …`, `NOT ready after 30s: …` (the server keeps running) or `Not ready: it exited …` (an error, and no later message). `timeout` defaults to 30 s, at most 600 s. The call also returns as soon as the user sends a message.
  - **`cwd`** (or `workdir`, `working_directory`) runs the command in that directory, absolute, relative to the session's directory or under `~`. A missing directory or a file is refused before anything runs.
- **`tasks`**, typed as a bash command of its own, manages background tasks. The extension answers it itself, so it shows as an ordinary bash command in Pi and BB:
  - `tasks` (or `tasks list`): every task, running or ended, with its pid and log path.
  - `tasks output <id>`: what the task printed since the model last saw its output (the bash result counts), at most the last 16 KB; `tasks <id>` is short for it.
  - `tasks wait <id> [--timeout <secs>]`: wait for it to exit (default 30 s, at most 600 s) and print its result; the exit status is the task's own, like the shell's `wait`. When the time runs out the task keeps running and the answer shows its new output.
  - `tasks stop <id>` (or `kill`): SIGTERM to the whole process group, SIGKILL after 2 s.
  - Ids may be written `3`, `%3`, `#3` or `task-3`; a leading `cd <dir> &&` is ignored. A command that starts with `tasks` and goes on (`tasks stop 1; sleep 1; …`) is refused before anything runs, since the rest would run while `tasks` did nothing. After other commands or later in a pipeline, `tasks` is a stand-in on `PATH` that says to run it on its own.
- **No foreground sleeping.** A command that starts with `sleep N` (N ≥ 5 s: `sleep 30`, `sleep 10 && curl …`, `sleep 1m; tail log`) is not run; the answer says that tasks report back on their own and names the running ones. A sleep inside a loop is left alone: the loop moves to the background like any long command.

**A message from the user does not wait for a command.** If the user sends one while a call is waiting (after the first second, so instant failures still report inline), the command moves to the background at once and the result says so; `tasks wait` and a `ready` wait return early the same way. Messages already queued when the call started do not count: a follow-up is only delivered once the agent stops, so ending the wait for it would only make the model call again.

When a task ends, the extension sends a `background-task` message with its exit status, last 30 lines and log path. Tasks that end within half a second of each other share one message (`2 background tasks ended (1 failed).`, then each report). It steers a running turn, or starts a turn when the agent is idle. A task the model already waited for, read to its end, or stopped sends no message; a wait that a stopped turn or Esc gave up on counts as no answer, so the message still comes. After a print or JSON run has finished, nothing is sent.

A command that exits but leaves processes running in its process group (`npm run dev &`) becomes a task as well, so `tasks stop` works and the processes are stopped with the session. A process that escaped the group (`setsid`) and keeps the output pipes open no longer blocks the call; it is let go after one second.

Commands run with stdin closed and with editors (`GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `EDITOR`, `VISUAL`) set to `true`; pagers (`PAGER`, `GIT_PAGER`, `MANPAGER`, `SYSTEMD_PAGER`, `GH_PAGER`, `BAT_PAGER`, `DELTA_PAGER`) set to `cat`, `AWS_PAGER` empty and `LESS=FRX`; prompts turned off (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS=false`, `GH_PROMPT_DISABLED=1`, `DEBIAN_FRONTEND=noninteractive`, `PIP_NO_INPUT=1`, `TF_INPUT=0`, `CLOUDSDK_CORE_DISABLE_PROMPTS=1`, `COMPOSER_NO_INTERACTION=1`); npm's fund, audit and update notices and pip's version check off; and `PYTHONUNBUFFERED=1`. Without a terminal, `git commit` or `git rebase -i` would otherwise sit in an editor forever, a prompt would wait for input that never comes, and Python's buffered output would leave task logs empty. `CI`, `TERM`, `NO_COLOR` and the locale are left alone, since they change how tests and snapshots behave.

## For the user

- In the TUI, a widget above the editor shows each running task, like Claude Code: `⏵ Running background command: <description> 5m 57s`, up to three, then `+N more · /tasks to manage`.
- **`/tasks`** opens a picker of every task; pick one to show its output (in a read-only editor dialog) or stop it. `/tasks stop <id>` stops one directly, `/tasks <id>` shows its output.
- A task the user stops does not wake the agent; the model learns about it on its next turn.
- Over RPC (BB), dialogs work through BB's interaction prompts, so `/tasks` works there too. BB drops notifications and widgets, so plain answers (no tasks, a task already ended) appear as `background-task` messages in the transcript instead, which do not start a turn.

## Lifecycle

- Task output goes to `$TMPDIR/pi-bash-tasks/<session id>-<pi pid>/task-<N>.log`, capped at 64 MB (`PI_BASH_TASKS_DIR` moves the root).
- The same directory holds `state.json` (the session's tasks, its Pi pid and `BB_THREAD_ID`) for other programs such as BB's pi-tasks plugin. Creating `stop-<id>` there stops that task as the user, like `/tasks stop <id>`.
- Quitting, `/new`, `/resume` and `/fork` stop every task (SIGTERM, then SIGKILL) and delete the logs. If Pi itself is killed, its exit handler sends SIGKILL to the task groups; only `kill -9` of Pi leaves them running, and the next Pi to start removes the directories of Pi processes that are gone.
- `/reload` keeps tasks running: the new runtime picks them up and reports any that ended in between.

## Configuration

`PI_BASH_WAIT_SECONDS` changes the 10-second wait. The extension replaces `bash` only on macOS and Linux and registers nothing on Windows.

Because `bash` now comes from this extension rather than Pi itself, renderers that only style Pi's built-in `bash` (pi-zentui's semantic Bash coloring) fall back to Pi's plain bash rendering.

## Tests

`npm test` runs real processes and a real Pi session with the faux model, so it needs no provider or network. It covers the foreground wait, moving to the background, ending a wait early for a user message, short timeouts, `ready` by port and log (ready, not ready, exited, bad values), `cwd`, batched messages, leftover and escaped processes, timeouts, abort, SIGTERM escalation, the unread-output cursor, every `tasks` command and its parsing, the sleep guard, the wake-up message and when it is skipped, the tool text, the widget, `/tasks` in the TUI and over RPC, `state.json` and stop requests, and reload versus quit.
