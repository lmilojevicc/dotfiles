# Skill Search

A Pi extension for discovering and reading skills from repositories the user has explicitly approved. It provides progressive disclosure without installing skills: agents first search names and full descriptions, then materialize only a selected skill at the searched revision.

## Approval configuration

Approvals are user-global and stored at:

```text
~/.pi/agent/skill-repositories.json
```

(`~/.pi/agent` means Pi's effective agent directory.)

```json
{
  "version": 1,
  "repositories": [
    { "repository": "owner/public-skills" },
    { "repository": "other/skills", "branch": "main" }
  ]
}
```

The file is written atomically with mode `0600`. A malformed existing file fails closed and is never replaced automatically. Project configuration cannot approve repositories.

Manage approvals interactively:

```text
/skill-repos list
/skill-repos add owner/repo
/skill-repos add github.com/owner/repo main
/skill-repos add https://github.com/owner/repo main
/skill-repos remove owner/repo
```

Only unauthenticated public repositories on `https://github.com` are supported. Credentials, ports, query strings, fragments, extra path components, tokens, private repositories, other hosts, and generic Git remotes are intentionally unsupported.

## Agent tools

### `search_skills`

Searches only approved repositories. It matches the query against each valid skill's name and complete frontmatter description and returns:

- skill name and description
- approved repository and resolved branch
- exact commit revision
- repository `SKILL.md` path
- opaque, session-local skill ID

Search does not materialize or execute repository files. Returned names and descriptions are untrusted repository metadata, not higher-priority instructions. Duplicate skill names remain separate results with distinct provenance. One failing repository does not hide results from other approved repositories.

When no branch is configured, each search resolves GitHub's current default branch. Every search resolves the branch's current commit; IDs bind reads to that exact commit, so branch movement cannot change a selected skill between search and read. A later search resolves the branch again.

### `read_skill`

Accepts only an opaque ID issued by `search_skills`. It rechecks the repository and configured branch approval, then downloads every safe regular file below the selected `SKILL.md` directory at the exact searched commit. It returns bounded `SKILL.md` text, provenance, and the private materialized directory path.

The complete skill directory includes references, assets, and scripts. Executable files retain executable intent (`0700`); other files use `0600`. Directories use `0700`. The extension **never installs or executes** any downloaded file. Agents must treat all skill instructions and files as untrusted content, review scripts, and follow normal user intent before running anything.

Opaque IDs expire with the Pi session. Removing an approval invalidates matching IDs. Changing its configured branch invalidates earlier IDs.

## Transport and safety

The extension uses the GitHub REST recursive-tree API and immutable `raw.githubusercontent.com` blob URLs. It does not clone repositories or extract archives. Requests use fixed hosts, no credentials/cookies, manual redirect handling, cancellation, timeouts, bounded streaming, and Git blob SHA verification. Approved repository refreshes have no aggregate deadline: every individual request remains bounded, and the caller can cancel a long-running search.

Materialization rejects:

- truncated or oversized repository trees
- unsafe, absolute, traversing, overlong, or backslash paths
- case-folded or Unicode-normalized collisions detected up front, plus any exact-spelling collision exposed by the target filesystem
- symlinks, submodules, and unknown object types
- files or selected skills exceeding limits

A selected skill is written to a staging directory and atomically renamed only after all files pass validation. Failed or cancelled staging work is removed. Approval removal aborts matching in-progress reads. IDs and temporary files are reset on every `session_start` and removed on `session_shutdown`.

Default limits:

| Resource | Limit |
| --- | ---: |
| Tree response | 8 MiB |
| Tree entries | 25,000 |
| `SKILL.md` download | 256 KiB |
| Files per selected skill | 512 |
| One file | 10 MiB |
| Selected skill total | 50 MiB |
| One HTTP request | 15 seconds |
| Materialization | 60 seconds |
| Repository concurrency | 2 |
| Blob concurrency | 4 |

Unauthenticated GitHub API rate limits apply. Rate-limit failures report the reset time when GitHub provides it. Add fewer repositories or retry after reset; the extension does not accept a token.

Tool output is bounded below Pi's 50 KiB / 2,000-line limits. If returned `SKILL.md` text is truncated, the complete file remains available at the reported temporary path.

## Development

Tests use injected fake GitHub responses and never access the live network:

```bash
npm test
```

Production metadata parsing uses Pi's public `parseFrontmatter` export, so valid YAML scalar behavior stays aligned with Pi. To smoke-test registration against the installed Pi runtime without loading other extensions, use a disposable agent directory from this extension directory:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" pi --no-extensions -e "$PWD/index.ts"
```

Pi should start with `search_skills`, `read_skill`, and `/skill-repos` registered. Exit without adding repositories when only checking registration.
