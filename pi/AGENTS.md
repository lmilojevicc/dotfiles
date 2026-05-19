## Agent artifact policy

Do not create research notes, planning files, scratch Markdown, manual testing reports, goal files, or agent memory
directories inside the repository unless the user explicitly asks for a tracked documentation change.

Use this external workspace instead:

- Plans: `$AGENT_WORK/repos/<repo>/plans/`
- Goals: `$AGENT_WORK/repos/<repo>/goals/`
- Research: `$AGENT_WORK/repos/<repo>/research/`
- Autoresearch: `$AGENT_WORK/repos/<repo>/autoresearch/`
- Posters: `$AGENT_WORK/repos/<repo>/posters/`
- Subagent context: `$AGENT_WORK/repos/<repo>/subagents/context/`
- Subagent handoffs: `$AGENT_WORK/repos/<repo>/subagents/handoffs/`
- Subagent reviews: `$AGENT_WORK/repos/<repo>/subagents/reviews/`

For `pi-subagents`, always set output paths intentionally:

- Do not let `context-build/*.md`, `handoff/*.md`, `research.md`, `context.md`, or `plan.md` land in the repo by default.
- Prefer temporary chain artifacts for one-off planning/review work.
- For durable artifacts, write them under the `$AGENT_WORK/repos/<repo>/subagents/` directories above.
- Use `output: false` for reviewer/cleanup agents unless the user explicitly asks for review files.
- If any of the skills suggests repo-local paths such as `goals/<slug>/`, `context-build/*.md`, or `handoff/*.md`, redirect them to `$AGENT_WORK` unless the user explicitly requests repo-local files.
- Repo-local Markdown is allowed only for intentional project documentation, existing checklist updates, or files the user explicitly asked to create in the repository.

Before committing:

1. Run `git status --short`.
2. Do not add untracked Markdown files unless explicitly requested.
3. Do not commit `.pi/`, `.opencode/`, `.poster/`, `.sisyphus/`, `.worktrees/`, `goals/`,
   `.multiloop/`, `context-build/`, `handoff/`, `docs/superpowers/`, `.serena/`, `memory-bank/`,
   or superpower related files.

Durable findings should be summarized into the external Obsidian `$AGENT_WORK` vault, not dumped into the repo.

For further usage of vault you will find information at `$AGENT_WORK/AGENTS.md`
