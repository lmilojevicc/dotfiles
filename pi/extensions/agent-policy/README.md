# Agent policy

Pi extension adding explicitly configured Markdown policy and full skill bodies as one owned `agent_policy` prompt section. **One extension-local `config.json`, one loader**: `common` (alias `all`) applies everywhere, `child` to all subagents, `main` (alias `orchestrator`) to root sessions on ordinary hosts, `mainBb` to root sessions in a BB-origin host, and `agents.<exact-native-name>` to that native child. All fields are optional. Native personas, prompt modes, tools and capability ceilings are retained, not replaced.

The initial config has empty common/child lists, `main: ["./prompts/main.md"]` (the unchanged orchestrator draft), `mainBb: ["./prompts/main-bb.md"]` (the BB delegation variant), and the existing `~/.agents/skills/chadineer/SKILL.md` for worker/reviewer. Ordinary `.md` and `SKILL.md` sources use the same ordered full-body loader. Add sources through config, not magic role files. Explicit skill assignment ignores frontmatter invocation gating; the source skill is not edited.

Config and every unique configured source are snapshotted at extension startup. Edit them, then `/reload`; each new child takes its own snapshot. Missing/invalid config or sources **warn and skip only affected inputs**, preserving valid siblings. Missing whole config gives empty supplemental composition, not a hardcoded main fallback. Warnings reach the UI and, on every non-TUI host (RPC included, where BB drops notifications), stderr once per runtime at session start (or before the first run if no start event occurred). This is **fail-open instruction delivery, not security enforcement**. Required-extension API conflicts and capability denials remain errors.

Migration: `injections.json` was removed, not retained as a second mechanism. The main draft moved byte-for-byte from `ORCHESTRATOR_APPEND_SYSTEM.md` to `prompts/main.md`; five empty common/child/role placeholders were deleted. Neither legacy files nor legacy config auto-load. See [configuration and migration](docs/design.md#policy-and-skill-configuration).

Try with `pi -e ./pi/extensions/agent-policy/index.ts`. Requires Pi and a compatible `pi-subagents` public required-child-extension API (tested offline: Pi 1.1.0 / pi-subagents 0.77.0). No auto-install or settings changes. Independent instruction sources, including global/project `APPEND_SYSTEM.md`, remain intact.

Consumes two independent BB signals: a nonblank `BB_THREAD_ID` marks host origin and swaps the root layer to `mainBb` (no fallback to `main` when it is absent), while the companion's versioned, thread-matched policy tuple drives generic child routing only. No name inference, tool changes, or permissions. Native launch-layout tags are routing metadata, not authentication, with an explicitly accepted exact root-lookalike ambiguity.

See [composition, warnings, tests and limitations](docs/design.md) and [workflow](docs/workflow.md).
