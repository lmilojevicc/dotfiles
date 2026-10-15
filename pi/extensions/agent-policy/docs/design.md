# Agent-policy usage and design

## Setup and tested contract

For an explicit trial, use `pi -e ./pi/extensions/agent-policy/index.ts`. Normal discovery can load this extension from the extension directory. No settings, builtin agent definitions, prompt modes, tool allowlists, or dependency versions are changed; no framework is installed.

Tested locally: **Pi 1.1.0 / pi-subagents 0.77.0**. The BB main-layer change was re-verified on **Node 22.23.2**; earlier checks used Node 26.11.1. The native factory/SDK, executor UUID capture, BB capture/reload, and policy/skill/APPEND snapshot checks run offline without requests. In 0.77.0 the actual child hook order is **native filtering → ordinary extensions (including agent-policy) → final native boundary**. The old complete-boundary classifier therefore injected orchestrator policy into initial foreground children: the boundary did not exist when agent-policy ran. This failure was reproduced against the installed pair before the routing repair. The extension now routes from strict generated launch headers before the boundary, retaining older complete-boundary, leading-prefix, and captured-env routes.

The boundary stays last, after the single policy block, in ordinary/fanout, replace/append, structured/unstructured launches. Native filtering and role prompt bodies are not replaced. No dependency settings or installed packages were changed. The manifest's peer ranges are not a tested-version matrix. Revalidate after upgrades, especially native launch layout, boundary text, hook order, canonical tags, UUID lookup, and required-extension admission. Previous Pi 1.0.4 / pi-subagents 0.76.1 checks do not establish compatibility with other pairs.

`peer.ts` resolves the public `pi-subagents/required-child-extensions` export through normal peer resolution, then the existing `getAgentDir()/npm/package.json` anchor. Pi supplies its SDK alias; independently installed packages are not automatically Node peers. There are no production machine-specific paths, installation scans, automatic installs, or private registry imports. A present incompatible export is an error, not permission to select another implementation. Provisioning remains main-owned.

## Policy and skill configuration

**Extension-local `config.json` is the only supplemental source manifest.** One loader treats ordinary Markdown policy files and `SKILL.md` identically. Optional keys:

| Key | Applies to | Value |
| --- | --- | --- |
| `common` (alias `all`) | Every session | Ordered file-path array |
| `child` | Every subagent, including generic BB-only workers | Ordered file-path array |
| `main` (alias `orchestrator`) | Main/root sessions on ordinary hosts | Ordered file-path array |
| `mainBb` | Main/root sessions in a BB-origin host (nonblank `BB_THREAD_ID`) | Ordered file-path array |
| `agents` | Exact native child names | Object of name → ordered file-path array |

`common`, `main` and `mainBb` are canonical. `main`/`mainBb` are alternatives, not
layers: a BB root composes `common → mainBb`, an ordinary root composes
`common → main`, and an absent/empty `mainBb` never falls back to `main`.
`mainBb` has no alias. If a canonical key and its alias are both present, warn
explicitly and use the canonical value, even if that value is invalid; the ignored
alias does not become a fallback. Alias-only and canonical-only configs produce
identical snapshots. `{}` and omitted fields are valid empty layers. Unknown
top-level fields warn and are ignored. No version field, named bundles, trees,
globs, discovery, watchers, or second config mechanism is supported.

Initial checked-in configuration:

```json
{
  "common": [],
  "child": [],
  "main": ["./prompts/main.md"],
  "mainBb": ["./prompts/main-bb.md"],
  "agents": {
    "worker": ["~/Projects/skills/skills/chadineer/SKILL.md"],
    "reviewer": ["~/Projects/skills/skills/chadineer/SKILL.md"]
  }
}
```

`prompts/main.md` is the existing orchestrator draft, moved byte-for-byte (SHA1 `5de0f6a003d01f7d362f90119662070103423d9f`). `prompts/main-bb.md` is its BB-origin counterpart: same tone, verification, Git and release discipline, with the delegation topology rewritten for BB's own surfaces (`bb_fork_workflow_run` / `bb fork-workflows`, `process`, `bb thread`, and `bb secret` for user-typed credentials) instead of Pi's gated native subagent tools. The Chadineer path references the user's existing source; it is not a new skill or profile. Native role personas, tool allowlists, prompt modes, global/project APPEND files, and unrelated instruction sources are unchanged.

For example, aliases and arbitrary exact names can use ordinary policy and skill files together (**illustrative paths only**, not bundled sources):

```json
{
  "all": ["./policies/shared.md"],
  "child": ["./policies/child.md"],
  "orchestrator": ["./prompts/main.md"],
  "agents": {
    "security-reviewer": ["./skills/my-security-review/SKILL.md", "/absolute/path/to/checklist.md"]
  }
}
```

This adds instructions to an already configured native `security-reviewer`; it does not define that agent, replace its persona, or change its tools. Agent keys are exact upstream-canonical names, stored in a Map (including own keys like `__proto__` and `constructor`). No worker fallback, fuzzy aliases, BB name inference, or role-file auto-loading occurs. Names never derive source paths.

Relative paths resolve against the config directory, not session cwd. `~/` expands to the runtime user's home; absolute paths are supported. Entries must be nonblank strings without NUL characters. Sources are **inputs, not extensions**: they do not enter the required-extension registry. Each unique normalized absolute path is read once, even across mappings or on failure. Symlink identity is not collapsed. Effective alias collisions skip the ignored alias inputs.

### Snapshots, order and full bodies

Initialization eagerly reads config and all effective configured files, including unused agent mappings. Hooks and session-start/tree events never reread them. Edits or deletions even before the first prompt are invisible until **`/reload` recreates the runtime**. Each child independently snapshots inputs at its own creation; the required registry transports only the extension entry point, not parent source content. A new child can see newer files while already loaded sessions keep their snapshots.

Each `before_agent_start` returns `{ systemPrompt }` only, preserving the original prompt and never injecting user/custom/tool-result messages. Pi starts each run's hook chain from base prompt options, so cached composition is reapplied every run:

- Main: **common → main** on ordinary hosts, **common → mainBb** in a BB-origin host, with marker `agent-policy:v1:main` or `agent-policy:v1:main-bb` respectively.
- Named native child: **common → child → agents[exact name]**.
- Unnamed/unconfigured native child: **common → child**, no worker fallback.
- BB-only worker: **common → child**, never native-name inputs inferred from an inherited tag.

Sources follow layer order, then config array order. **Deduplication is first occurrence by normalized absolute path within the assembled lists.** For example common `[b, a, b]`, child `[c, a]`, and worker `[a, d, c]` output `b, a, c, d`; main `[d, a]` instead outputs `b, a, d`. Duplicate contents at distinct paths are distinct sources.

Only initial YAML frontmatter with exact `---` opening/closing lines is stripped, optionally preceded by a UTF-8 BOM. LF and CRLF are supported. No YAML semantic parsing is performed. Unterminated or malformed delimiter lines (including trailing delimiter whitespace) warn and skip that source; later Markdown `---` stays intact. Frontmatter-only and whitespace-only bodies validly omit without warnings. Instruction-body text and links stay verbatim; files are not summarized or converted into catalog hints.

Each nonblank body has a source/reference-directory header:

```text
## Policy source: /absolute/path/to/SKILL.md
Resolve this source's relative file references against /absolute/path/to.

<full instruction body>
```

This is model guidance for relative references, not rewriting, recursive reads, guaranteed file access, or invocation gating. Explicit full-body skill assignment deliberately ignores frontmatter invocation flags, including `user-invoked`.

Nonempty composition uses one owned `agent-policy:v1:start/end` SYSTEM block. Replacement removes complete stale owned blocks, even when new composition is empty. Empty composition adds no block or child marker. Unmarked prose and full native personas remain intact. Unterminated owned blocks remain prompt-composition errors, not file-input warnings.

### Warning-only file inputs and migration

File/config input delivery is **fail-open, not security enforcement**. Missing/unreadable whole config, malformed JSON or a non-object config warn and produce empty supplemental composition; there is no hardcoded main fallback. Unknown keys, invalid field types, invalid mapping/path entries, missing/unreadable sources and malformed initial frontmatter warn with config/mapping/source context and skip only affected inputs. Valid siblings continue loading. Blank bodies are valid quiet omissions.

The snapshot exposes diagnostics. At `session_start`, or the first `before_agent_start` if no start event occurred, report each diagnostic once per runtime with `ctx.ui.notify(message, "warning")` when UI exists, otherwise stderr. Session switches/resume/tree events neither reload inputs nor repeat warnings. `/reload` creates a fresh snapshot and reports its current diagnostics. BB fallback warnings remain independently included in the same once-per-runtime reporting. Fix input paths and reload rather than treating successful child startup as proof every instruction was delivered.

Migration from the previous layout:

1. Replace `injections.json` with `config.json`, carrying old `agents` mappings and any old `main` sources into their desired lists.
2. Include `./prompts/main.md` in `main` if the orchestrator guidance is wanted. The shipped config does so explicitly, not via fallback.
3. If you populated the old common, child or role files locally, move/reference those Markdown files explicitly through `common`, `child`, and `agents.<name>`.

The shipped `injections.json` was removed. `ORCHESTRATOR_APPEND_SYSTEM.md` moved to `prompts/main.md`; five empty `COMMON_APPEND_SYSTEM.md`, `SUBAGENT_APPEND_SYSTEM.md`, and `roles/{worker,reviewer,scout}.md` placeholders were deleted. There is no automatic compatibility loading of these legacy paths, no magic roles directory, and no second loader/config. Config-only additions are sufficient for new sources.

## Classification, canonical role routing, and ordering

`child-profile.ts` isolates the inspected native contract:

1. Capture `PI_SUBAGENT_CHILD === '1'` during extension initialization, not repeatedly from mutable shared-process env. This runner signal is supplementary, not the foreground route.
2. Recognize strict generated launch metadata **before the final boundary**: an exact `<active_agent name="..."/>` at the start of the replace-mode base (ignoring leading whitespace), followed by exactly a blank-line separator and a nonblank body; or the same header at the start of the SDK `\n\n<addendum>\n` content with its closing `\n</addendum>`. No loose anywhere-tag scan is used for this new route. Quoted/misplaced tags, single-newline root tags, extra attributes, wrong quoting, empty names, and malformed XML escapes cannot select it. The launcher's four XML escapes are decoded to recover the exact name, with no fuzzy aliases or casing changes.
3. Retain older leading ordinary-child/explicit-fanout prefixes and complete appended ordinary/fanout boundaries (with optional exact structured-output suffix and launch metadata). Complete trailing policy/Chadineer-owned blocks are ignored for old-boundary classification only; normal cleanup/error behavior remains. Older prefix/env children retain first-standalone-tag name routing, only **after native classification**. No user/history scanning occurs.
4. Select the exact native name independently of source configuration. Generated-layout metadata wins over quoted preamble/role tags. BB-only classification never admits a native name.

The installed `child-launch.js` uses resolved `childAgentName` for the escaped tag. Upstream resolves builtin aliases (developer/coder/implementer/develop → worker, advisor → oracle); this extension does not add alias tables, model classification, or a taxonomy. A native launch without generated metadata needs one of the retained env/prefix/old-boundary signals; waiting for a later boundary is not possible in a foreground ordinary hook.

**Explicitly accepted ambiguity:** a root deliberately supplying the same exact generated SYSTEM header/layout also routes as child, including named skill selection. A tag alone does not, and tags in user/history messages never do. Likewise, a valid generated launch header still routes if a later boundary is missing/malformed: the header route cannot depend on that future hook. These are routing signals, **not authentication**. Arbitrary SYSTEM text or another extension can spoof them; later extensions can overwrite the result. No tool authorization, security enforcement, or reliable ancestry follows from this parser. A normal UI fork without such metadata stays main.

## BB companion policy marker (not yet deployed live)

Two independent BB signals are consumed. Host origin uses the plain `BB_THREAD_ID`
that BB sets for every BB-origin session (root, workflow worker, side chat); the
versioned companion tuple below owns worker/child routing. The companion is the
producer `~/Projects/bb-plugins/plugins/pi-agent-policy`; this extension only reads
environment, for provider `pi`:

- **Host origin (`BB_THREAD_ID`)**: any nonblank value, including unfamiliar
  formats, makes the session BB-origin and routes roots to the `mainBb` layer
  instead of `main`. This mirrors the `pi-subagents-host-gate` host rule; it works
  with or without the companion, and also applies to nested/bashed `pi` launches
  that inherit the variable. Whitespace-only values are absent. Ordinary (non-BB)
  hosts keep `main`.
- `PI_AGENT_POLICY_BB_PROFILE=workflow-worker:v1` selects generic subagent composition only when `BB_THREAD_ID` and `PI_AGENT_POLICY_BB_THREAD_ID` are both nonempty trimmed strings, at most 256 characters, with no control characters, and match exactly.
- `PI_AGENT_POLICY_BB_PROFILE=none:v1` is an explicit neutral reset for ordinary sessions/commands. The companion contributes the versioned profile and matching identity for every command, so a worker signal must not leak into a later ordinary command.
- Absent signals are normal. Unknown/malformed profiles or missing/malformed/mismatched tuple identities degrade to existing native/main routing with one redacted warning per runtime (UI when available, stderr headlessly). A valid neutral tuple is quiet. `BB_THREAD_ID` alone never selects a worker.

BB-origin roots compose **common → mainBb** and carry the
`agent-policy:v1:main-bb` marker. `mainBb` is a separate optional layer with no
alias: an absent or empty `mainBb` yields no root policy rather than falling back
to `main` (the same explicit, no-magic-fallback rule as `child`). BB workers keep
common → child and never receive `mainBb` or named native sources.

The own tuple is validated and captured once in the extension factory, before asynchronous peer loading. Environment changes after factory initialization have no effect until a new runtime is created by the BB provider's rebuild/reload boundary (or Pi `/reload`). Session events alone do not recapture it; this extension never mutates env or sets `PI_SUBAGENT_CHILD`.

Native child env/prefix/launch-layout routing takes precedence, including exact native-name source selection, regardless of the BB signal. A BB-only worker gets common + generic child policy, **never** worker/reviewer/scout named sources inferred from arbitrary or inherited `<active_agent>` tags. There is no BB role contract, heuristic prompt matching, user/history scan, tool/permission change, or BB registry identity. UUID registration remains the native Pi session UUID. With empty common/child composition, recognized BB-only workers receive no policy block and stale owned main/role/skill blocks are still removed, regardless of configured native-name skills.

These are untrusted policy routing signals, not authorization. Tests exercise the consumer and SDK initialization boundary offline, not BB's experimental hooks or a live workflow. No live deployment or BB end-to-end integration is claimed.

Tags and prefixes are **routing metadata, not authentication or tool authorization**; the accepted exact SYSTEM lookalike ambiguity applies even without native machinery.

## Required propagation and UUID lifecycle

At `session_start` and before a run, register this `index.ts` under `dotfiles.agent-policy` using the public API and **`ctx.sessionManager.getSessionId()`**, never `getSessionFile()`. Native executor required-extension lookup uses the Pi ID (normally UUID) even for file-backed sessions; file paths used elsewhere for artifact/status ownership are a different contract. Keep one registration for the current ID, dispose only the owned registration on replacement/shutdown, and re-register at session start/reload. File-path changes with the same ID do not change registration ownership.

The registry canonicalizes files into an immutable snapshot, permits one owner per ID, and supplies an idempotent disposer. Conflicts surface; we do not merge privately, overwrite, or dispose another owner. Hosts with another owner need authorized host composition, not a second registration. Native inherited launch snapshots remain package-owned.

Required paths survive native foreground's disabled ambient discovery and explicit `extensions: []`. They do **not** widen tools, permissions, depth, or capability ceilings: a ceiling denying extensions rejects a required native launch. The registration leaves `requireForAllRunners` at the package default (false): external runners are excluded rather than forcibly denied by this policy; remote/external policy transport or all-runner enforcement is not claimed. Disabling this extension at the root means it cannot register or compose policy. Disposing a registration affects future lookups, not already captured launch snapshots.

## Chadineer compatibility and errors

Chadineer stays optional, opt-in, off by default, with existing commands/state/root behavior unchanged. With empty effective child composition, agent-policy neither strips Chadineer blocks nor emits a new skip marker, so Chadineer operates independently. If a legacy-first Chadineer hook observes an inherited stale child marker, it can skip that run before agent-policy removes the stale block; the existing order-sensitive behavior is unchanged. With nonempty child composition (including skill-only children), the existing interoperability remains: agent-policy strips only Chadineer-owned blocks if Chadineer runs first; Chadineer skips on `agent-policy:v1:subagent` if policy runs first. Unmarked legacy/role instructions are retained. Reload both runtimes when updating hooks; this does not retroactively clean history.

File/config/frontmatter failures are captured as snapshot warnings, not extension-load exceptions, so missing source files do not reject required native child creation. Required-extension API resolution, registry conflicts, capability admission and owned-block composition retain their existing error handling; runtime registration/composition errors still notify the UI, log headlessly and throw to Pi's extension error channel. Pi can catch before-run hook errors and continue without injection. Neither successful registration nor these instructions imply fail-closed enforcement.

## Validation and coverage limits

```sh
node --test pi/extensions/agent-policy/tests/*.test.ts
node --test pi/extensions/chadineer/tests/*.test.ts
```

Unit tests cover config aliases and canonical collisions, optional fields, invalid JSON/types/keys/path entries, missing/unreadable config and sources (including unused mappings), valid sibling preservation, frontmatter, deployed-config smoke reads, byte-exact moved main body, one read per unique source, layer order and first-occurrence deduplication. Runtime coverage retains profile/name/fallback routing, generated metadata lookalikes and older boundary/env routes, transitions, full-role text retention, eager snapshots before first prompt/deletion, no per-hook reads, missing-source empty-child behavior, stale cleanup, both Chadineer orders, UUID/path independence, lifecycle disposal and registry conflicts, plus peer errors. BB coverage includes tuple/identity validation, host-origin detection from any nonblank `BB_THREAD_ID` (including whitespace-only absence and companion-only tuples), native precedence, generic-only composition, `mainBb` selection versus the ordinary `main` layer, no-fallback on an empty `mainBb`, the distinct `agent-policy:v1:main-bb` marker with stale ordinary-main replacement/idempotence, neutral routing and once-per-runtime UI/headless diagnostics. File warnings report before the first prompt (or on the first hook when session_start is absent), do not repeat across session events, and refresh on runtime recreation.

Installed tests use real SDK resource loaders, sessions/managers, extension runner, public registry, native launch planner, child factory, prompt-runtime/fanout hooks, builtin discovery/alias resolution, and the **actual foreground executor** UUID lookup. Private installed registry reads are observation only in tests. Host aliases bridge installed peers without installing/mutating packages. Auth/catalog paths are temporary, refresh is disabled, and a non-requested model fixture is supplied. No model/network requests, paid work, detached jobs, or publication occur.

A BB-specific real SDK loader/session test sets the tuple before factory loading, mutates it before the first prompt, verifies frozen worker/main/native classification, and recreates runtimes with actual `session.reload()` for neutral reset and worker↔BB-main↔ordinary-main transitions, including `BB_THREAD_ID` alone selecting `mainBb` and its removal restoring `main`. It checks SYSTEM-only output, unchanged tools and UUID registry, no role inference, exact main/main-bb markers, no cross-layer leakage, stale-block replacement/idempotence, malformed fallback, and ignored user/history lookalikes. No provider or model request occurs.

A separate real SDK loader/session test edits temporary policy, config, skills, and native APPEND files after initialization but before the first prompt, verifies cached main and newly selected names, invokes actual `session.reload()`, and checks refreshed mappings/bodies, UUID disposal/re-registration, and warning-only continuation after removed skill and named-source files. Required registrations survive; valid sibling bodies remain. No interactive command or model request is needed.

The native integration test verifies actual 0.77.0 hook ordering and complete boundary constants, plus absence of orchestrator policy in children with main-only config. A temporary populated-policy/config matrix exercises **160 real native child creations**: foreground and in-process runner hosting × ordinary/fanout × replace/append × structured/unstructured × worker/reviewer/scout/security-reviewer/unknown × BB absent/positive. The full installed worker/reviewer persona bodies remain intact; only the correct ordered sources and exact-name mappings appear; tools and UUID registrations stay unchanged, with the native boundary last. Every matrix child also warns at actual required startup for a missing unused mapping without failing extension load. A separate required planner/factory regression removes the worker’s selected skill source and verifies warning-only startup, valid common/child/named siblings, full worker persona, unchanged read tools, UUID registration and native final boundary. A separate two-child check proves independent child config and source snapshots (editing a referenced file and adding a config mapping after first creation but before its first prompt is invisible there and visible to the next child). Unit negatives cover root-only/misplaced/quoted/malformed tags and incomplete append layout, while exact generated root SYSTEM lookalikes intentionally select child and are tested/documented rather than called authentication.

The executor test deliberately stops at an injected create seam, records its explicit required snapshot/canonical tag with `extensions: []`, and returns a synthetic error before model resolution. It covers file-backed and in-memory parents. A synthetic stored transcript exercises the installed resolver's real JSONL fork; its captured launch is then opened through the real SDK child factory and checked at the prompt boundary. Separate native-factory checks cover no policy markers in main-only-config children, retained builtin bodies, unknown/unsafe names, builtin aliases, replace and builtin delegate append modes, and independent APPEND discovery. Those role fixtures use `read` only instead of all builtin tool/provider prerequisites; production definitions are untouched. The captured fork swaps the executor fixture's provider boundary for the parent's real empty provider registry before SDK creation. Planner/factory checks simulate background runner hosting in-process (with both ambient loading and explicit empty extensions), nested inherited config, explicit fanout, inherited parent prompt transitions, and serialized recovery requirements. They do **not** execute the full detached/background executor, nested tasks, restarted jobs, or model requests.

Test paths default to the inspected current local installations; override with `PI_POLICY_TEST_SDK` and `PI_POLICY_TEST_SUBAGENTS`. Absent fixtures skip installed coverage; present fixtures pin the tested pair. Check skipped counts. Interactive `/reload` command dispatch, full resume/replacement flows, detached OS processes, remote/external hosts, other versions, enforced role permissions, and model compliance remain untested. No blanket propagation/security guarantee follows from these checks.

In this isolated worktree, the adjacent Chadineer command runs **10 tests: 9 pass, 1 fails** because its existing static-prompt test reads `pi/APPEND_SYSTEM.md`, which is already absent at this branch's base checkout; that fixture predates and is outside this change's write scope and is not suppressed. Agent-policy tests pass **69/69, zero skips** on the tested pair with `PI_POLICY_TEST_SDK` pointed at the installed Pi 1.1.0 tree; installed coverage is included in those counts.

See [workflow and source rationale](workflow.md) for the orchestrator guidance.
