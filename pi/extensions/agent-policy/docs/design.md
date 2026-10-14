# Agent-policy usage and design

## Setup and tested contract

For an explicit trial, use `pi -e ./pi/extensions/agent-policy/index.ts`. Normal discovery can load this extension from the extension directory. No settings, builtin agent definitions, prompt modes, tool allowlists, or dependency versions are changed; no framework is installed.

Tested locally: **Pi 1.1.0 / pi-subagents 0.77.0 / Node 26.11.1**. The native factory/SDK, executor UUID capture, BB capture/reload, and policy/skill/APPEND snapshot checks run offline without requests. In 0.77.0 the actual child hook order is **native filtering → ordinary extensions (including agent-policy) → final native boundary**. The old complete-boundary classifier therefore injected orchestrator policy into initial foreground children: the boundary did not exist when agent-policy ran. This failure was reproduced against the installed pair before the routing repair. The extension now routes from strict generated launch headers before the boundary, retaining older complete-boundary, leading-prefix, and captured-env routes.

The boundary stays last, after the single policy block, in ordinary/fanout, replace/append, structured/unstructured launches. Native filtering and role prompt bodies are not replaced. No dependency settings or installed packages were changed. The manifest's peer ranges are not a tested-version matrix. Revalidate after upgrades, especially native launch layout, boundary text, hook order, canonical tags, UUID lookup, and required-extension admission. Previous Pi 1.0.4 / pi-subagents 0.76.1 checks do not establish compatibility with other pairs.

`peer.ts` resolves the public `pi-subagents/required-child-extensions` export through normal peer resolution, then the existing `getAgentDir()/npm/package.json` anchor. Pi supplies its SDK alias; independently installed packages are not automatically Node peers. There are no production machine-specific paths, installation scans, automatic installs, or private registry imports. A present incompatible export is an error, not permission to select another implementation. Provisioning remains main-owned.

## Policy layers and configured skills

`ORCHESTRATOR_APPEND_SYSTEM.md` remains the existing main draft, unchanged. `COMMON_APPEND_SYSTEM.md`, `SUBAGENT_APPEND_SYSTEM.md`, and `roles/{worker,reviewer,scout}.md` remain empty editable placeholders. Filling them re-enables those layers. Builtin role bodies, tools, global/project APPEND files, and other instruction sources are unchanged.

Optional **extension-local `injections.json`** contains exactly `main` and `agents`. Both fields are required when the file is present; no version field, unknown fields, coercion, or skip-missing option is supported. `main` and each agent value must be ordered arrays of nonblank file-path strings; `agents` must be an object. Empty arrays are valid. Agent keys are exact upstream-canonical names, independent of the three legacy overlays; lookup uses a Map (including own keys such as `__proto__` and `constructor`). An unconfigured/unknown name gets no named skill or fallback role. Names never derive filesystem paths.

Initial checked-in configuration:

```json
{
  "main": [],
  "agents": {
    "worker": ["~/Projects/skills/skills/chadineer/SKILL.md"],
    "reviewer": ["~/Projects/skills/skills/chadineer/SKILL.md"]
  }
}
```

This references the existing skill; it does not author a new security skill or agent profile. For example, a user who already has a configured native `security-reviewer` agent could explicitly map their own inputs like this (**illustrative paths only**, not bundled files):

```json
{
  "main": [],
  "agents": {
    "worker": ["~/Projects/skills/skills/chadineer/SKILL.md"],
    "reviewer": ["~/Projects/skills/skills/chadineer/SKILL.md"],
    "security-reviewer": ["./skills/my-security-review/SKILL.md", "/absolute/path/to/your/checklist.md"]
  }
}
```

Relative paths resolve against the config directory, not the session cwd. `~/` expands to the runtime user's home directory; absolute paths are supported. Skill paths are **inputs, not extensions** and do not enter the required-extension registry. No discovery, watchers, recursive reference injection, registry, or prompt-budget framework is added. A missing config means legacy composition is unchanged. A present malformed/unreadable config or any missing/unreadable referenced file is an explicit initialization error, even for unused mappings.

Extension initialization eagerly reads all six known policy files, the config, and every referenced skill. Like native `APPEND_SYSTEM.md`, edits (even before the first prompt) require `/reload`, which recreates the runtime and its snapshot. Hooks and session-start/tree events do not reread files. **Each child runtime takes its own snapshot when instantiated**; parent launch transport carries the required extension entry point, not parent skill content. New children can see newer files while an already loaded parent/child keeps its snapshot.

Each `before_agent_start` selects cached SYSTEM text and returns `{ systemPrompt }` only, never user/custom/tool-result messages. Pi starts each run's hook chain from its base prompt options, so the cached policy must be reapplied every run:

- Main: common + orchestrator policy + configured `main` skills.
- Native child: common + generic child policy + optional exact worker/reviewer/scout overlay + configured skills for the native name.
- Unknown/custom child: common + generic child policy + only explicitly configured exact-name skills; never a fallback worker overlay.
- BB-only worker: common + generic child policy, no named skills or legacy role overlay.

Full skill bodies appear in config array order **after** existing policy layers, in the existing **single owned policy SYSTEM block**. Only initial YAML frontmatter with exact `---` opening/closing lines is stripped, optionally preceded by a UTF-8 BOM; LF and CRLF are supported. No YAML semantic parsing is performed. Missing or malformed delimiter lines (including delimiter-line trailing whitespace) are errors; later Markdown `---` lines stay intact. Frontmatter-only/whitespace-only bodies are omitted. Other instruction-body text and links remain verbatim; files are neither summarized nor converted into a skill catalog hint.

Each nonblank body is prefixed with its resolved source path and reference directory, for example:

```text
## Injected skill: /absolute/path/to/SKILL.md
Resolve this skill's relative file references against /absolute/path/to.

<full instruction body>
```

This is model guidance for relative references, not link rewriting, automatic file reads, invocation gating, or guaranteed file access. Frontmatter invocation flags do not gate an explicitly configured full-body injection.

Nonblank policy Markdown stays verbatim; empty layers are skipped. Nonempty composition uses one `agent-policy:v1:start/end` block. Replacement removes complete owned policy blocks, including inherited main/old-role/old-skill blocks, even when the new composition is empty. Empty composition adds no policy block or child marker. Unmarked prose, complete native worker/reviewer personas, and unrelated instructions remain intact. Missing/unreadable policy files and unterminated owned blocks remain errors; another profile/role is never substituted. All six policy files, including unused overlays, must be readable at initialization. Empty files are valid.

## Classification, canonical role routing, and ordering

`child-profile.ts` isolates the inspected native contract:

1. Capture `PI_SUBAGENT_CHILD === '1'` during extension initialization, not repeatedly from mutable shared-process env. This runner signal is supplementary, not the foreground route.
2. Recognize strict generated launch metadata **before the final boundary**: an exact `<active_agent name="..."/>` at the start of the replace-mode base (ignoring leading whitespace), followed by exactly a blank-line separator and a nonblank body; or the same header at the start of the SDK `\n\n<addendum>\n` content with its closing `\n</addendum>`. No loose anywhere-tag scan is used for this new route. Quoted/misplaced tags, single-newline root tags, extra attributes, wrong quoting, empty names, and malformed XML escapes cannot select it. The launcher's four XML escapes are decoded to recover the exact name, with no fuzzy aliases or casing changes.
3. Retain older leading ordinary-child/explicit-fanout prefixes and complete appended ordinary/fanout boundaries (with optional exact structured-output suffix and launch metadata). Complete trailing policy/Chadineer-owned blocks are ignored for old-boundary classification only; normal cleanup/error behavior remains. Older prefix/env children retain first-standalone-tag name routing, only **after native classification**. No user/history scanning occurs.
4. Select the native name independently from the optional worker/reviewer/scout legacy overlay. Generated-layout metadata wins over quoted preamble/role tags. BB-only classification never admits a name or overlay.

The installed `child-launch.js` uses resolved `childAgentName` for the escaped tag. Upstream resolves builtin aliases (developer/coder/implementer/develop → worker, advisor → oracle); this extension does not add alias tables, model classification, or a taxonomy. A native launch without generated metadata needs one of the retained env/prefix/old-boundary signals; waiting for a later boundary is not possible in a foreground ordinary hook.

**Explicitly accepted ambiguity:** a root deliberately supplying the same exact generated SYSTEM header/layout also routes as child, including named skill selection. A tag alone does not, and tags in user/history messages never do. Likewise, a valid generated launch header still routes if a later boundary is missing/malformed: the header route cannot depend on that future hook. These are routing signals, **not authentication**. Arbitrary SYSTEM text or another extension can spoof them; later extensions can overwrite the result. No tool authorization, security enforcement, or reliable ancestry follows from this parser. A normal UI fork without such metadata stays main.

## BB companion policy marker (not yet deployed live)

The producer companion is `~/Projects/bb-plugins/plugins/pi-agent-policy`. It owns BB's experimental provider-hook integration; this extension only consumes the environment tuple for provider `pi`:

- `PI_AGENT_POLICY_BB_PROFILE=workflow-worker:v1` selects generic subagent composition only when `BB_THREAD_ID` and `PI_AGENT_POLICY_BB_THREAD_ID` are both nonempty trimmed strings, at most 256 characters, with no control characters, and match exactly.
- `PI_AGENT_POLICY_BB_PROFILE=none:v1` is an explicit neutral reset for ordinary sessions/commands. The companion contributes the versioned profile and matching identity for every command, so a worker signal must not leak into a later ordinary command.
- Absent signals are normal. Unknown/malformed profiles or missing/malformed/mismatched tuple identities degrade to existing native/main routing with one redacted warning per runtime (UI when available, stderr headlessly). A valid neutral tuple is quiet. `BB_THREAD_ID` alone never selects a worker.

The own tuple is validated and captured once in the extension factory, before asynchronous peer loading. Environment changes after factory initialization have no effect until a new runtime is created by the BB provider's rebuild/reload boundary (or Pi `/reload`). Session events alone do not recapture it; this extension never mutates env or sets `PI_SUBAGENT_CHILD`.

Native child env/prefix/launch-layout routing takes precedence, including native canonical role overlays, regardless of the BB signal. A BB-only worker gets common + generic child policy, **never** worker/reviewer/scout overlays inferred from arbitrary or inherited `<active_agent>` tags. There is no BB role contract, heuristic prompt matching, user/history scan, tool/permission change, or BB registry identity. UUID registration remains the native Pi session UUID. With empty common/generic child policy, recognized BB-only workers receive no policy block and stale owned main/role/skill blocks are still removed, regardless of configured native-name skills.

These are untrusted policy routing signals, not authorization. Tests exercise the consumer and SDK initialization boundary offline, not BB's experimental hooks or a live workflow. No live deployment or BB end-to-end integration is claimed.

Tags and prefixes are **routing metadata, not authentication or tool authorization**; the accepted exact SYSTEM lookalike ambiguity applies even without native machinery.

## Required propagation and UUID lifecycle

At `session_start` and before a run, register this `index.ts` under `dotfiles.agent-policy` using the public API and **`ctx.sessionManager.getSessionId()`**, never `getSessionFile()`. Native executor required-extension lookup uses the Pi ID (normally UUID) even for file-backed sessions; file paths used elsewhere for artifact/status ownership are a different contract. Keep one registration for the current ID, dispose only the owned registration on replacement/shutdown, and re-register at session start/reload. File-path changes with the same ID do not change registration ownership.

The registry canonicalizes files into an immutable snapshot, permits one owner per ID, and supplies an idempotent disposer. Conflicts surface; we do not merge privately, overwrite, or dispose another owner. Hosts with another owner need authorized host composition, not a second registration. Native inherited launch snapshots remain package-owned.

Required paths survive native foreground's disabled ambient discovery and explicit `extensions: []`. They do **not** widen tools, permissions, depth, or capability ceilings: a ceiling denying extensions rejects a required native launch. The registration leaves `requireForAllRunners` at the package default (false): external runners are excluded rather than forcibly denied by this policy; remote/external policy transport or all-runner enforcement is not claimed. Disabling this extension at the root means it cannot register or compose policy. Disposing a registration affects future lookups, not already captured launch snapshots.

## Chadineer compatibility and errors

Chadineer stays optional, opt-in, off by default, with existing commands/state/root behavior unchanged. With empty effective child composition, agent-policy neither strips Chadineer blocks nor emits a skip marker, so Chadineer operates independently. With nonempty child composition (including skill-only children), the existing interoperability remains: agent-policy strips only Chadineer-owned blocks if Chadineer runs first; Chadineer skips on `agent-policy:v1:subagent` if policy runs first. Unmarked legacy/role instructions are retained. Reload both runtimes when updating hooks; this does not retroactively clean history.

Policy/config/skill-file and frontmatter failures occur at extension initialization, before a session context/UI exists, and throw an explicit `agent-policy` error with config/mapping/source context and the underlying cause into Pi's extension-load diagnostics. They no longer wait for a selected profile's first run. Registration and prompt-composition failures still notify the UI, log headlessly, and throw to Pi's extension error channel. Required startup/load failures can reject native child creation under the installed package contract. Pi catches before-run hook errors and may continue without injection: this is **not fail-closed enforcement**. Check errors before claiming propagation.

## Validation and coverage limits

```sh
node --test pi/extensions/agent-policy/tests/*.test.ts
node --test pi/extensions/chadineer/tests/*.test.ts
```

Unit tests cover the BB marker/identity matrix, bounded/redacted malformed signals, native precedence, generic-only BB role behavior, neutral/root routing, once-per-runtime UI/headless warnings, and stale empty-child cleanup, as well as profile/role/fallback routing, metadata lookalikes, transitions, role-text retention, eager policy/config/all-skill snapshots, no per-run reads, pre-first-prompt edits, missing/unreadable-file load errors, blank-file omission, exact orchestrator SYSTEM text, stale-block cleanup, both Chadineer hook orders with empty/populated policies, UUID/path independence, switches/reload/shutdown, conflicts, and peer resolution/errors.

Installed tests use real SDK resource loaders, sessions/managers, extension runner, public registry, native launch planner, child factory, prompt-runtime/fanout hooks, builtin discovery/alias resolution, and the **actual foreground executor** UUID lookup. Private installed registry reads are observation only in tests. Host aliases bridge installed peers without installing/mutating packages. Auth/catalog paths are temporary, refresh is disabled, and a non-requested model fixture is supplied. No model/network requests, paid work, detached jobs, or publication occur.

A BB-specific real SDK loader/session test sets the tuple before factory loading, mutates it before the first prompt, verifies frozen worker/main/native classification, and recreates runtimes with actual `session.reload()` for neutral reset and worker↔main transitions. It checks SYSTEM-only output, unchanged tools and UUID registry, no role inference, stale-block replacement/idempotence, malformed fallback, and ignored user/history lookalikes. No provider or model request occurs.

A separate real SDK loader/session test edits temporary policy, config, skills, and native APPEND files after initialization but before the first prompt, verifies cached main and newly selected names, invokes actual `session.reload()`, and checks refreshed mappings/bodies, UUID disposal/re-registration, and load diagnostics for removed skill and overlay files. No interactive command or model request is needed.

The native integration test verifies actual 0.77.0 hook ordering and complete boundary constants, plus absence of orchestrator policy in children with absent config. A temporary populated-policy/config matrix exercises **160 real native child creations**: foreground and in-process runner hosting × ordinary/fanout × replace/append × structured/unstructured × worker/reviewer/scout/security-reviewer/unknown × BB absent/positive. The full installed worker/reviewer persona bodies remain intact; only the correct ordered skills and exact overlays appear; tools and UUID registrations stay unchanged, with the native boundary last. A separate two-child check proves independent child snapshots (editing a referenced file after first creation but before its first prompt is invisible there and visible to the next child). Unit negatives cover root-only/misplaced/quoted/malformed tags and incomplete append layout, while exact generated root SYSTEM lookalikes intentionally select child and are tested/documented rather than called authentication.

Skill-loader/runtime tests cover relative/absolute/home paths, ordered full bodies and reference headers, LF/CRLF/BOM frontmatter, malformed delimiters, blank bodies, strict config fields/arrays, prototype keys, missing config versus malformed config/missing configured files, unused eager mappings, pre-first-prompt snapshots and no per-hook reads, exact arbitrary names, BB generic-only/native precedence, stale skill/role transitions, and both Chadineer orders including skill-only children.

The executor test deliberately stops at an injected create seam, records its explicit required snapshot/canonical tag with `extensions: []`, and returns a synthetic error before model resolution. It covers file-backed and in-memory parents. A synthetic stored transcript exercises the installed resolver's real JSONL fork; its captured launch is then opened through the real SDK child factory and checked at the prompt boundary. Separate native-factory checks cover no policy markers in empty-config children, retained builtin bodies, unknown/unsafe names, builtin aliases, replace and builtin delegate append modes, and independent APPEND discovery. Those role fixtures use `read` only instead of all builtin tool/provider prerequisites; production definitions are untouched. The captured fork swaps the executor fixture's provider boundary for the parent's real empty provider registry before SDK creation. Planner/factory checks simulate background runner hosting in-process (with both ambient loading and explicit empty extensions), nested inherited config, explicit fanout, inherited parent prompt transitions, and serialized recovery requirements. They do **not** execute the full detached/background executor, nested tasks, restarted jobs, or model requests.

Test paths default to the inspected current local installations; override with `PI_POLICY_TEST_SDK` and `PI_POLICY_TEST_SUBAGENTS`. Absent fixtures skip installed coverage; present fixtures pin the tested pair. Check skipped counts. Interactive `/reload` command dispatch, full resume/replacement flows, detached OS processes, remote/external hosts, other versions, enforced role permissions, and model compliance remain untested. No blanket propagation/security guarantee follows from these checks.

In this isolated worktree, the adjacent Chadineer command runs **10 tests: 9 pass, 1 fails** because its existing static-prompt test reads absent `pi/APPEND_SYSTEM.md` (the main draft is now extension-local). That adjacent fixture is outside this change’s write scope and is not suppressed. Agent-policy tests pass **58/58, zero skips** on the tested pair; installed coverage is included in those counts.

See [workflow and source rationale](workflow.md) for the orchestrator guidance.
