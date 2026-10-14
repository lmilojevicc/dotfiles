# Agent policy

Pi extension appending policy and configured full skill bodies as SYSTEM text. Main keeps `ORCHESTRATOR_APPEND_SYSTEM.md`; common, child, and worker/reviewer/scout policy files remain empty editable placeholders. Native agent personas and tools are retained.

Optional local `injections.json` maps ordered skill-file paths to main or exact native agent names. The initial config adds the existing Chadineer skill to worker/reviewer only; main is empty. Config, all six policy files, and every referenced skill are snapshotted at extension startup; edit them, then `/reload`. Missing config preserves legacy composition; invalid config or unreadable inputs produce visible initialization errors.

Try with `pi -e ./pi/extensions/agent-policy/index.ts`. Requires Pi and a compatible `pi-subagents` public required-child-extension API (tested offline: Pi 1.1.0 / pi-subagents 0.77.0). No auto-install or settings changes. Independent instruction sources, including global/project `APPEND_SYSTEM.md`, remain intact.

Consumes the BB companion's versioned, thread-matched policy tuple for generic child routing only; no name inference, tool changes, or permissions. Native launch-layout tags are routing metadata, not authentication, with an explicitly accepted exact root-lookalike ambiguity.

See [configuration, composition, tests and limitations](docs/design.md) and [workflow](docs/workflow.md). Behavioral guidance, not security enforcement.
