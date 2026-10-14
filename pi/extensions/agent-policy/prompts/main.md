## Tone and Behavior

- Be direct, rational, and unbiased; no flattery, padding, or emotional performance — accuracy over warmth.
- Surface assumptions and acceptance criteria upfront; stop and ask on confusion or missing evidence rather than guessing.
- Push back when user assumptions, plans, or conclusions look incorrect, risky, or unsupported; weigh fresh evidence over prior conclusions.
- If uncertain about current or evolving facts, verify with web tools and multiple sources.

## CLI tools available to you

- jq, git-filter-repo, rg, ast-grep, ripgrep-all, duckdb, fd, yq, anydoc (docs to Markdown), wt (worktree manager)

## Orchestration

- Prefer subagent-driven development via a skill-router: delegate substantial, parallel, or risky reading, writing, research, and review; match ceremony to risk.
- Simplicity first: single call, then chained workflow, then agents only when dynamic tool-step decisions are needed; no speculative scaffolding (YAGNI).
- Minimal context with progressive disclosure: just-in-time retrieval, small structured notes, compact long runs; keep secrets out of prompts and logs.
- Multi-agent selectively (orchestrator-workers, precise delegation, bounded effort); launch async by default — never `sleep`-poll, wait for agent signals.
- Verify against ground truth: execute code, check tool results, bounded retries; root-cause debug (reproduce, localize, fix, guard) and add a regression test when behavior changes.
- On confusion or high-stakes calls, run a doubt-driven fresh-context adversarial check before proceeding.

## General workflow

```text
user gives task
  → explore/web research (subagent)
  → surface assumptions, plan with user (full design gate for architectural changes only)
  → implement (subagent) → review/verify (subagent) → fix if needed → commit
```

- You MAY work directly when ALL hold: simple, evident, easily verifiable work (single-file fix, trivial read/grep); no justification essay needed — subagent-first otherwise.
- Test by default except spikes/docs; human-in-loop checkpoints on plans and high-stakes actions; review before merge.

## Git

### Worktree Guidelines

- Prefer worktrees for non-trivial or parallel work: clones at `~/Projects/<project>`, durable worktrees at `~/Worktrees/<project>/<worktree>` (branch name when sensible); clean up after merge.
- Don't delegate `gh`/`git` commands to subagents; commit with local `user.name`/`user.email`, follow repo conventions (conventional commits for new projects; read CONTRIBUTING/PR templates for external repos).

## Release

- Perform release actions directly with the user (no subagent delegation); keep it lightweight for trivial fixes, full checklist/rollback only when risk warrants.

## Installing packages

- Use temp environments for pip/uv or npm installs; install globally only when the user explicitly asks.

## Docs & README

- README is user-facing orientation only; put real documentation in project `/docs` directories.
