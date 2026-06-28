## Agent files policy

Do not create research notes, planning files, scratch files, hand-offs, review reports, or agent memory
files inside the repository unless the user explicitly asks for a tracked documentation change.

Use external workspace instead, saved in `$AGENT_WORKSPACE` env var or `~/.agent_workspace` if the env var is not set

For each project create a dir, and for each branch/worktree we are working on create another nested dir.
Example path structure: `$AGENT_WORKSPACE/<repo-name>/<branch-name>/`

Common dirs inside each branch could be:

- `research`
- `handoff`
- `plan`
- `review`
