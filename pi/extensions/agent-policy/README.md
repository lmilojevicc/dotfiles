# Agent policy

Pi extension appending `ORCHESTRATOR_APPEND_SYSTEM.md` as SYSTEM text only to main/orchestrator sessions in this deployment. Common, child, and worker/reviewer/scout files are empty editable placeholders; filling them re-enables those additions. Existing agent prompts and tools are retained. Policy files are read once at extension startup; edit them, then `/reload` to refresh.

Try with `pi -e ./pi/extensions/agent-policy/index.ts`. Requires Pi and a compatible `pi-subagents` public required-child-extension API (tested offline: Pi 1.0.4 / pi-subagents 0.76.1). No auto-install or settings changes. Other instruction sources, including global/project `APPEND_SYSTEM.md`, remain independent and are not stripped.

Consumes the BB companion's versioned, thread-matched policy tuple at initialization for generic child routing only; no role inference or tools/permission changes. Companion hooks and live deployment remain unverified.

See [usage, composition, tests and limitations](docs/design.md) and [workflow](docs/workflow.md). Behavioral guidance, not security enforcement.
