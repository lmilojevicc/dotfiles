# Workflow and source rationale

This describes the user-authored `prompts/main.md`, moved unchanged from `ORCHESTRATOR_APPEND_SYSTEM.md` and explicitly listed in `config.json` for main/orchestrator sessions. Common/child source lists start empty; worker/reviewer receive the existing configured Chadineer skill without replacing native child instructions. Add ordinary policy or skill sources through the same config manifest, not role-file magic (see [composition](design.md#policy-and-skill-configuration)). Missing inputs warn and skip rather than preventing startup: fail-open instruction delivery is not security enforcement.

## Direct versus delegated work

Main communicates with the user and owns observable acceptance, authorization, product/architecture decisions, task ordering, budgets, workspace/provisioning, integration, Git, and releases. Substantive discovery, implementation, checks, and review go to bounded children. One cohesive worker can inspect, implement, and verify a coupled seam; no compulsory scout/planner chain. Use one writer per workspace, separate worktrees for concurrent writers, and independent read-only fanout only when useful.

The approved hybrid exception is deliberately conservative: main may do a genuinely tiny mechanically obvious change only when scope/behavior are already known, there is no material uncertainty, and verification is trivial. It is not a claim of certainty. Any doubt, investigation, multi-step task, or substantive review means delegate; eventual line count is not eligibility. Git/provisioning/release ownership is a separate main duty, not this substantive-work exception. User and higher-priority scope/permission restrictions still win.

## Evidence and applicable gates

Use criteria → targeted discovery/decisions → proportionate plan → one writer → focused verification → applicable fresh review → parent adjudication → bounded fixes → integrated evidence. Tiny/copy/docs work needs proportionate checks, not a code-review ceremony. Substantive code requires both meaningful executable evidence and one fresh general review of actual changes. Neither a confident model nor a majority vote is verification.

| Perspective | Trigger | Evidence |
| --- | --- | --- |
| General correctness/maintainability | Substantive code; lightweight disposition for other work | Criteria, actual changes/contracts, behavioral assertions, failures and gaps |
| Security | Identity/authorization, untrusted input, secrets, sensitive data or external effects | Relevant trust-boundary inspection and allow/deny/abuse checks |
| UI/accessibility | User-visible interaction/navigation/layout/forms | Running flows, keyboard/focus/labels, relevant automated and manual checks |
| Performance | Hot paths, large data, resource-sensitive operations or explicit budgets | Equivalent baseline/candidate workloads and qualified measurements |
| Compatibility/data safety | Public API, serialization/schema/config defaults or migrations | Supported-consumer contracts, old/new behavior and migration/recovery evidence |

Do not force three reviewers. Consolidate overlapping perspectives without concealing actual high-risk gaps. Reviewers remain read-only and use supported tools; if check execution is unavailable, an authorized verifier runs it. Initially give fresh reviewers the actual candidate, criteria, interfaces, and check evidence rather than other reviewers' verdicts or just the writer's narrative. Fresh context reduces anchoring; it does not prove statistical independence.

Parent triages supported findings, rejects optional/out-of-scope polish, delegates accepted fixes to the writer, and re-verifies the fix blast radius and changed integrated candidate. Default cap: three review rounds, counting fresh review after a worker pass. Stop early when criteria and applicable gates pass. At the cap, or upon unresolved scope/authority/data-loss risk/critical evidence gaps, escalate or explicitly revise scope/budget; never auto-accept. Preserve failure/flakiness evidence; do not weaken tests or suppress diagnostics to make gates green. Prompt gates are guidance, not a runtime acceptance/CI engine.

Builtin `/review-loop` and `/parallel-review` recipes are not edited. Their preference for three reviewers, main inspection, and autofix wording must be applied subject to these role boundaries: substantive inspection/checks/fixes remain delegated; a main summary is not independent review. Availability of builtin tools or a recipe does not grant authority.

## Source rationale

Policy choices follow the user-approved synthesis; they are not an empirically proven optimum for Pi. [Anthropic subagents](https://code.claude.com/docs/en/sub-agents) supports targeted delegation and also acknowledges quick/direct changes; that trade-off motivated the narrow approved exception, not broad direct-work permission. [Google review guidance](https://google.github.io/eng-practices/review/reviewer/looking-for.html) supports meaningful tests, contract fit, and conceptual simplicity rather than fewer lines/files. [YAGNI](https://martinfowler.com/bliki/Yagni.html) rejects speculative capability without excusing poor code health. [NIST verification guidance](https://www.nist.gov/itl/executive-order-14028-improving-nations-cybersecurity/software-supply-chain-security-guidance-18) motivates applicable techniques, not a mandatory reviewer count. These are rationale links, not claims that the worker fetched or newly validated external sources.

Local runtime sources originally inspected for Pi 1.0.2 / pi-subagents 0.76.0 and subsequently Pi 1.0.4 / pi-subagents 0.76.1; current work reinspected Pi 1.1.0 extension docs, declarations/examples and runner rendering, plus pi-subagents 0.77.0 launch metadata, factory hook order and boundary seams. The actual offline native/SDK checks now cover pre-boundary routing, full-body skill snapshots and reload (see [design](design.md#setup-and-tested-contract)). Original broader source inventory:

- Pi `docs/{extensions,sdk,configuration,settings,packages,security,sessions,session-format,message-types}.md`, exact exported declarations, `dist/core/resource-loader.js`, `dist/core/agent-session.js`, and `dist/core/extensions/{loader,runner}.js`: startup/reload APPEND snapshots, runtime recreation, base prompt options at each run, run-specific hook returns, and error/lifecycle behavior.
- pi-subagents `docs/{agents,configuration,extension-api,workflows,tool-reference,standalone-background}.md`, builtin agents and review recipes: modes, tool boundaries, aliases, admission and workflow limits.
- pi-subagents `src/agents/agents.js`: canonical alias resolution and builtin discovery; `src/runs/shared/child-launch.js`: escaped canonical tag and required snapshot; `child-session.js`: prompt-runtime priority, loader, startup errors and disposal; `subagent-prompt-runtime.js`: native prefixes; `src/runs/foreground/subagent-executor.js`: `getSessionId()`/`parentPiSessionId` lookups; `src/runs/background/async-execution.js`: parent-ID snapshots; `src/shared/{required-child-extensions,fork-context}.js`: exact-key registry/admission and native history fork.
- Local `chadineer/index.ts` and tests: marker skip/strip compatibility, without claiming ancestry or enforcement.

No framework adoption, prompt-mode overrides, dependency upgrades, global installs, or builtin replacement is part of this change. Revisit overlays or topology only with concrete task evidence; measure outcomes rather than assuming more permanent instructions or reviewers improve them.
