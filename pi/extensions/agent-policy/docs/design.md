# Agent-policy usage and design

## Setup and tested contract

For an explicit trial, use `pi -e ./pi/extensions/agent-policy/index.ts`. Normal discovery can load this extension from the extension directory. No settings, builtin agent definitions, prompt modes, tool allowlists, or dependency versions are changed; no framework is installed.

Tested locally: **Pi 1.0.4 / pi-subagents 0.76.1 / Node 26.10.0**. The native factory/SDK, BB capture/reload, and policy/APPEND snapshot checks pass offline. In 0.76.1, `rewriteSubagentPrompt` appends the complete child boundary after the base prompt instead of prepending it. The adapter now recognizes that exact generated SYSTEM layout plus launch metadata, including replace/append modes, ordinary/fanout boundaries and optional structured-output suffix. Older leading-prefix and captured-env routing remain supported. No dependency settings or installed packages were changed. The manifest's peer ranges are not a tested-version matrix. Revalidate after upgrades, especially native boundary text/layout, hook ordering, canonical tags, UUID lookup, and required-extension admission. Previous Pi 1.0.2 / pi-subagents 0.76.0 verification does not establish compatibility for other versions.

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
2. Otherwise classify from either the older leading ordinary-child/explicit-fanout prefix (ignoring leading whitespace), or the complete 0.76.1 appended layout. The latter requires the exact ordinary/fanout boundary at the SYSTEM tail, optionally followed by the exact structured-output instructions, plus an exact launch tag and blank-line separator at the base prompt's start (replace mode) or at the start of the SDK `<addendum>` content (append mode). Complete trailing agent-policy/Chadineer-owned blocks are ignored for classification only, preserving repeated composition and hook ordering; normal removal/error behavior is unchanged. Root tags alone, incomplete/quoted/nonterminal suffixes, and tags elsewhere in prose cannot select this route. No user/history scanning occurs.
3. Only after **native** child classification, route canonical `worker`, `reviewer`, or `scout` overlays. For the complete appended layout, use its matched launch tag rather than quoted preamble/role tags. Older children retain first-standalone-tag routing. The tag must exactly match `<active_agent name="..."/>`; unknown/unsafe/malformed names remain generic and cannot derive filesystem paths.

The installed `child-launch.js` prepends an XML-escaped tag using the resolved `childAgentName`. `resolveAgentName` normalizes builtin aliases (developer/coder/implementer/develop → worker, advisor → oracle) upstream; this extension does not add fuzzy matching, alias tables, model classification, or a configurable taxonomy. `child-session.js` prioritizes the native prompt-runtime hook ahead of ordinary extensions. The previously validated 0.76.0 hook prefixed the native boundary in replace and append modes; inspected 0.76.1 retains hook priority but appends that boundary, now covered by the exact-layout adapter.

## BB companion policy marker (not yet deployed live)

The producer companion is `~/Projects/bb-plugins/plugins/pi-agent-policy`. It owns BB's experimental provider-hook integration; this extension only consumes the environment tuple for provider `pi`:

- `PI_AGENT_POLICY_BB_PROFILE=workflow-worker:v1` selects generic subagent composition only when `BB_THREAD_ID` and `PI_AGENT_POLICY_BB_THREAD_ID` are both nonempty trimmed strings, at most 256 characters, with no control characters, and match exactly.
- `PI_AGENT_POLICY_BB_PROFILE=none:v1` is an explicit neutral reset for ordinary sessions/commands. The companion contributes the versioned profile and matching identity for every command, so a worker signal must not leak into a later ordinary command.
- Absent signals are normal. Unknown/malformed profiles or missing/malformed/mismatched tuple identities degrade to existing native/main routing with one redacted warning per runtime (UI when available, stderr headlessly). A valid neutral tuple is quiet. `BB_THREAD_ID` alone never selects a worker.

The own tuple is validated and captured once in the extension factory, before asynchronous peer loading. Environment changes after factory initialization have no effect until a new runtime is created by the BB provider's rebuild/reload boundary (or Pi `/reload`). Session events alone do not recapture it; this extension never mutates env or sets `PI_SUBAGENT_CHILD`.

Native child env/prefix/complete-layout routing takes precedence, including native canonical role overlays, regardless of the BB signal. A BB-only worker gets common + generic child policy, **never** worker/reviewer/scout overlays inferred from arbitrary or inherited `<active_agent>` tags. There is no BB role contract, heuristic prompt matching, user/history scan, tool/permission change, or BB registry identity. UUID registration remains the native Pi session UUID. With deployed empty child composition, recognized BB workers receive no policy block and stale owned main/role blocks are still removed.

These are untrusted policy routing signals, not authorization. Tests exercise the consumer and SDK initialization boundary offline, not BB's experimental hooks or a live workflow. No live deployment or BB end-to-end integration is claimed.

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

Unit tests cover the BB marker/identity matrix, bounded/redacted malformed signals, native precedence, generic-only BB role behavior, neutral/root routing, once-per-runtime UI/headless warnings, and stale empty-child cleanup, as well as profile/role/fallback routing, metadata lookalikes, transitions, role-text retention, eager six-file snapshots, no per-run reads, pre-first-prompt edits, missing/unreadable-file load errors, blank-file omission, exact orchestrator SYSTEM text, stale-block cleanup, both Chadineer hook orders with empty/populated policies, UUID/path independence, switches/reload/shutdown, conflicts, and peer resolution/errors.

Installed tests use real SDK resource loaders, sessions/managers, extension runner, public registry, native launch planner, child factory, prompt-runtime/fanout hooks, builtin discovery/alias resolution, and the **actual foreground executor** UUID lookup. Private installed registry reads are observation only in tests. Host aliases bridge installed peers without installing/mutating packages. Auth/catalog paths are temporary, refresh is disabled, and a non-requested model fixture is supplied. No model/network requests, paid work, detached jobs, or publication occur.

A BB-specific real SDK loader/session test sets the tuple before factory loading, mutates it before the first prompt, verifies frozen worker/main/native classification, and recreates runtimes with actual `session.reload()` for neutral reset and worker↔main transitions. It checks SYSTEM-only output, unchanged tools and UUID registry, no role inference, stale-block replacement/idempotence, malformed fallback, and ignored user/history lookalikes. No provider or model request occurs.

A separate real SDK loader/session test edits temporary policy and native APPEND files after initialization but before the first prompt, verifies cached main and newly selected blank roles, invokes actual `session.reload()`, and checks refreshed text, UUID disposal/re-registration, and load diagnostics for a removed overlay. No interactive command or model request is needed.

The native integration test verifies the actual 0.76.1 appended layout against the installed package's complete boundary constants, plus effective empty/populated child composition and absence of orchestrator policy. A temporary populated-policy matrix exercises real native ordinary/fanout, replace/append, structured/unstructured launches and all three canonical overlays both with no BB marker and with BB-positive. Native overlays take precedence; tools and UUID registrations remain unchanged by policy composition. Unit negatives cover partial/quoted/misplaced suffixes, malformed metadata, root tags, and complete generated-layout lookalikes in user/history messages.

The executor test deliberately stops at an injected create seam, records its explicit required snapshot/canonical tag with `extensions: []`, and returns a synthetic error before model resolution. It covers file-backed and in-memory parents. A synthetic stored transcript exercises the installed resolver's real JSONL fork; its captured launch is then opened through the real SDK child factory and checked at the prompt boundary. Separate native-factory checks cover no policy markers in empty-config children, retained builtin bodies, unknown/unsafe names, builtin aliases, replace and builtin delegate append modes, and independent APPEND discovery. Those role fixtures use `read` only instead of all builtin tool/provider prerequisites; production definitions are untouched. The captured fork swaps the executor fixture's provider boundary for the parent's real empty provider registry before SDK creation. Planner/factory checks simulate background runner hosting in-process (with both ambient loading and explicit empty extensions), nested inherited config, explicit fanout, inherited parent prompt transitions, and serialized recovery requirements. They do **not** execute the full detached/background executor, nested tasks, restarted jobs, or model requests.

Test paths default to the inspected local installations; override with `PI_POLICY_TEST_SDK` and `PI_POLICY_TEST_SUBAGENTS`. Absent fixtures skip installed coverage; present fixtures pin the tested pair. Check skipped counts. Interactive `/reload` command dispatch, full resume/replacement flows, detached OS processes, remote/external hosts, other versions, enforced role permissions, and model compliance remain untested. No blanket propagation/security guarantee follows from these checks.

See [workflow and source rationale](workflow.md) for the orchestrator guidance.
