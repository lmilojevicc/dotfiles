# Agent-policy usage and design

## Setup and tested contract

For an explicit trial, use `pi -e ./pi/extensions/agent-policy/index.ts`. Normal discovery can load this extension from the extension directory. No settings, builtin agent definitions, prompt modes, tool allowlists, or dependency versions are changed; no framework is installed.

Tested locally: **Pi 1.0.2 / pi-subagents 0.76.0 / Node 26.10.0**. The installed peer changed from the prior 0.75.0 fixture to 0.76.0; the existing public registry, native prefix/tag ordering, factory and executor seams were reinspected and the retained offline integration tests rerun. No dependency settings or installed packages were changed. The manifest's peer ranges are not a tested-version matrix. Revalidate after upgrades, especially native prompt prefixes, hook ordering, canonical tags, UUID lookup, and required-extension admission. Older verification claims (Pi 0.87.1 / pi-subagents 0.73.1) do not establish current compatibility.

`peer.ts` resolves the public `pi-subagents/required-child-extensions` export through normal peer resolution, then the existing `getAgentDir()/npm/package.json` anchor. Pi supplies its SDK alias; independently installed packages are not automatically Node peers. There are no production machine-specific paths, installation scans, automatic installs, or private registry imports. A present incompatible export is an error, not permission to select another implementation. Provisioning remains main-owned.

## Orchestrator-only deployment and editable composition

`ORCHESTRATOR_APPEND_SYSTEM.md` preserves the current user-authored main draft byte-for-byte under its new name. `COMMON_APPEND_SYSTEM.md`, `SUBAGENT_APPEND_SYSTEM.md`, and `roles/{worker,reviewer,scout}.md` are empty editable placeholders. This deployment adds policy only to main/orchestrator sessions, not children. Builtin role bodies, tools, global/project APPEND files, and other instruction sources are unchanged.

Extension initialization reads all six known policy files once, including roles that may be selected later. Like native `APPEND_SYSTEM.md`, edits (even before the first prompt) require `/reload`, which recreates the extension runtime and its snapshot. Session-start/tree events alone do not refresh it; a host that actually replaces the runtime creates a new snapshot.

Each `before_agent_start` selects from that snapshot and returns `{ systemPrompt }` only, never user messages. Pi starts each run's hook chain from its base prompt options, so the cached policy must be reapplied every run; this is not repeated chat-message injection:

- Main: `COMMON_APPEND_SYSTEM.md` + `ORCHESTRATOR_APPEND_SYSTEM.md`.
- Child: common + `SUBAGENT_APPEND_SYSTEM.md` + an optional exact `roles/worker.md`, `roles/reviewer.md`, or `roles/scout.md` overlay.
- Unknown/custom roles: common + generic child file, never a fallback worker overlay.

Empty/whitespace-only contents are skipped; nonblank contents are retained verbatim. Filling shared/child/role files re-enables their respective additions. Composition remains reusable, but no child boundaries or role duties are added by the empty configuration.

Nonempty composition uses one `agent-policy:v1:start/end` block. Replacement removes complete owned policy blocks, including inherited main/old-role blocks, even when the new composition is empty. Empty composition adds no policy block or child marker. Unmarked prose, native role bodies, and unrelated instructions remain intact; this is not heuristic stripping of inherited history. Missing/unreadable files and unterminated owned blocks remain errors; another profile/role is never substituted. All six files, including unused overlays, must now be readable at initialization. Empty files are valid. Edit Markdown or code, then `/reload`.

## Classification, canonical role routing, and ordering

`child-profile.ts` isolates the inspected native contract:

1. Capture `PI_SUBAGENT_CHILD === '1'` during extension initialization, not repeatedly from mutable shared-process env. This background signal is supplementary, not the foreground route.
2. Otherwise classify a child only when SYSTEM text starts (ignoring leading whitespace) with a native ordinary-child or explicit-fanout prefix. Root tags and a quoted prefix later in a prompt cannot reclassify main.
3. Only after child classification, take the first standalone `<active_agent ...>` line in SYSTEM text. It must exactly match the launch-generated `<active_agent name="..."/>` shape; only canonical `worker`, `reviewer`, and `scout` names select overlays. Unknown/unsafe/malformed names fall back to generic and cannot derive filesystem paths. Later tags in role prose do not override the launch tag.

The installed `child-launch.js` prepends an XML-escaped tag using the resolved `childAgentName`. `resolveAgentName` normalizes builtin aliases (developer/coder/implementer/develop → worker, advisor → oracle) upstream; this extension does not add fuzzy matching, alias tables, model classification, or a configurable taxonomy. `child-session.js` prioritizes the native prompt-runtime hook ahead of ordinary extensions; that hook prefixes the native boundary before this hook sees the prompt, in replace and append modes.

Tags and prefixes are **routing metadata, not authentication or tool authorization**. Arbitrary SYSTEM text or another extension can spoof them; later extensions can overwrite the result. Manual UI forks remain main unless launched through native child machinery.

## Required propagation and UUID lifecycle

At `session_start` and before a run, register this `index.ts` under `dotfiles.agent-policy` using the public API and **`ctx.sessionManager.getSessionId()`**, never `getSessionFile()`. Native executor required-extension lookup uses the Pi ID (normally UUID) even for file-backed sessions; file paths used elsewhere for artifact/status ownership are a different contract. Keep one registration for the current ID, dispose only the owned registration on replacement/shutdown, and re-register at session start/reload. File-path changes with the same ID do not change registration ownership.

The registry canonicalizes files into an immutable snapshot, permits one owner per ID, and supplies an idempotent disposer. Conflicts surface; we do not merge privately, overwrite, or dispose another owner. Hosts with another owner need authorized host composition, not a second registration. Native inherited launch snapshots remain package-owned.

Required paths survive native foreground's disabled ambient discovery and explicit `extensions: []`. They do **not** widen tools, permissions, depth, or capability ceilings: a ceiling denying extensions rejects a required native launch. The registration leaves `requireForAllRunners` at the package default (false): external runners are excluded rather than forcibly denied by this policy; remote/external policy transport or all-runner enforcement is not claimed. Disabling this extension at the root means it cannot register or compose policy. Disposing a registration affects future lookups, not already captured launch snapshots.

## Chadineer compatibility and errors

Chadineer stays optional, opt-in, off by default, with existing commands/state/root behavior unchanged. With empty child composition, agent-policy neither strips Chadineer blocks nor emits a skip marker, so Chadineer operates independently. With populated child policy, the existing interoperability remains: agent-policy strips only Chadineer-owned blocks if Chadineer runs first; Chadineer skips on `agent-policy:v1:subagent` if policy runs first. Unmarked legacy/role instructions are retained. Reload both runtimes when updating hooks; this does not retroactively clean history.

Policy-file failures now occur at extension initialization, before a session context/UI exists, and throw an explicit `agent-policy` error with the underlying filesystem cause into Pi's extension-load diagnostics. They no longer wait for a selected profile's first run. Registration and prompt-composition failures still notify the UI, log headlessly, and throw to Pi's extension error channel. Required startup/load failures can reject native child creation under the installed package contract. Pi catches before-run hook errors and may continue without injection: this is **not fail-closed enforcement**. Check errors before claiming propagation.

## Validation and coverage limits

```sh
node --test pi/extensions/agent-policy/tests/*.test.ts
node --test pi/extensions/chadineer/tests/*.test.ts
```

Unit tests cover profile/role/fallback routing, metadata lookalikes, transitions, role-text retention, eager six-file snapshots, no per-run reads, pre-first-prompt edits, missing/unreadable-file load errors, blank-file omission, exact orchestrator SYSTEM text, stale-block cleanup, both Chadineer hook orders with empty/populated policies, UUID/path independence, switches/reload/shutdown, conflicts, and peer resolution/errors.

Installed tests use real SDK resource loaders, sessions/managers, extension runner, public registry, native launch planner, child factory, prompt-runtime/fanout hooks, builtin discovery/alias resolution, and the **actual foreground executor** UUID lookup. Private installed registry reads are observation only in tests. Host aliases bridge installed peers without installing/mutating packages. Auth/catalog paths are temporary, refresh is disabled, and a non-requested model fixture is supplied. No model/network requests, paid work, detached jobs, or publication occur.

A separate real SDK loader/session test edits temporary policy and native APPEND files after initialization but before the first prompt, verifies cached main and newly selected blank roles, invokes actual `session.reload()`, and checks refreshed text, UUID disposal/re-registration, and load diagnostics for a removed overlay. No interactive command or model request is needed.

The executor test deliberately stops at an injected create seam, records its explicit required snapshot/canonical tag with `extensions: []`, and returns a synthetic error before model resolution. It covers file-backed and in-memory parents. A synthetic stored transcript exercises the installed resolver's real JSONL fork; its captured launch is then opened through the real SDK child factory and checked at the prompt boundary. Separate native-factory checks cover no policy markers in empty-config children, retained builtin bodies, unknown/unsafe names, builtin aliases, replace and builtin delegate append modes, and independent APPEND discovery. Those role fixtures use `read` only instead of all builtin tool/provider prerequisites; production definitions are untouched. The captured fork swaps the executor fixture's provider boundary for the parent's real empty provider registry before SDK creation. Planner/factory checks simulate background runner hosting in-process (with both ambient loading and explicit empty extensions), nested inherited config, explicit fanout, inherited parent prompt transitions, and serialized recovery requirements. They do **not** execute the full detached/background executor, nested tasks, restarted jobs, or model requests.

Test paths default to the inspected local installations; override with `PI_POLICY_TEST_SDK` and `PI_POLICY_TEST_SUBAGENTS`. Absent fixtures skip installed coverage; present fixtures pin the tested pair. Check skipped counts. Interactive `/reload` command dispatch, full resume/replacement flows, detached OS processes, remote/external hosts, other versions, enforced role permissions, and model compliance remain untested. No blanket propagation/security guarantee follows from these checks.

See [workflow and source rationale](workflow.md) for the orchestrator guidance.
