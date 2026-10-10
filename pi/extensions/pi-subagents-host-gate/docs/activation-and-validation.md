# Activation and validation

## Sole-entry activation

1. Place this entire folder in the source `pi/extensions/` tree first. It has no
   `index.ts`, `index.js` or package manifest, so Pi's default one-level extension
   discovery does **not** load it yet. Do not rename `loader.ts` to an index file.
2. In **one atomic settings update**, replace only the `"npm:pi-subagents"`
   package entry with `{ "source": "npm:pi-subagents", "extensions": [] }` and add
   `"extensions/pi-subagents-host-gate/loader.ts"` once to `extensions`. Preserve
   all other current fields and any existing skills/prompts filters. Do not
   activate the loader before disabling the package extension: both factories
   would otherwise register native features.
3. The installed extension/settings paths are source symlinks. This worktree is
   outside live discovery; the integration owner must place the folder into the
   actual symlink source and apply just these two declaration changes to its
   current, possibly dirty settings. No installed settings or active session
   data were read/written here. No live reload has been performed.
4. Start a fresh process/runtime through the normal host workflow. Each factory
   captures the current BB marker; there is no polling. Preserve upstream's
   restart requirement after package updates rather than trying to replace
   cached upstream versions with a custom cache-busting loader.

Rollback: in one atomic settings update restore the original package extension
loading (the original string entry, or original extension filter if it had one)
and remove the explicit gate path. The folder can then be removed; merely
removing it while still configured produces an ordinary extension load error.

This controls only extension registration. Installed package skills/prompts are
not disabled. A trusted project's package declaration can override the personal
package filter; explicit native paths or manual launches can also bypass the
sole-entry arrangement. This is not an enforcement/security layer.

## Public module and host mapping contract

`loader.ts` delegates once to the public default export using its supplied
`ExtensionAPI`, awaits initialization and preserves its return/error. The BB
check happens before the callback that calls `getAgentDir()`, resolves the peer,
imports it and invokes it. Nonblank IDs are not validated against a guessed ID
format, including malformed/unfamiliar strings; blank/Unicode-whitespace-only
strings count as absent. Node env values are strings or absent.

Resolution uses a normal peer first, then `getAgentDir()/npm/package.json` as the
managed npm anchor only when the local package is absent. Present local packages
with missing exports/main targets retain their original resolution error instead
of silently selecting another version. Missing peers, broken imports, nonfactory
defaults and registration errors are
explicit outside BB; none is loaded in BB. No automatic installation occurs.

The dynamic import stays in the TypeScript extension loaded by **Pi's own jiti**.
Its transpilation propagates the host's module mapping to the resolved public
entry and transitive peer imports. This is important because managed
`pi-subagents` has no physical SDK peer links. Plain Node ESM loading is not the
supported execution path. Production does not create another jiti, duplicate
registrations, construct another Pi runtime or import upstream/SDK private paths.
No new runtime dependencies or manifests are needed.

Upstream's public entry remains responsible for HERDR mode, native child guards
and installed-versus-loaded version checks. The gate never sets
`PI_SUBAGENT_CHILD`, alters policy classification, or implements these guards.
Unit tests preserve upstream-like return/errors verbatim; the installed public
entry's actual guards/version check are source-observed, not invoked via live
child/HERDR launches.

## Checked environment and evidence

Tested with `/opt/homebrew/bin/node` **v26.10.0**, installed public SDK
`@earendil-works/pi-coding-agent` **1.0.4**, and public `pi-subagents` **0.76.1**.
Tests use the real public SDK `DefaultResourceLoader`/discovery, not a private
loader or copied alias table. The unbundled installed SDK loader is verified;
Bun/compiled/bundled CLI variants are not separately exercised.

```sh
/opt/homebrew/bin/node --test pi/extensions/pi-subagents-host-gate/tests/*.test.ts
/opt/homebrew/bin/node --test pi/extensions/agent-policy/tests/*.test.ts
/opt/homebrew/bin/node --test pi/extensions/chadineer/tests/*.test.ts
```

Results: **40 + 46 + 10 passed**, no skipped tests. Temporary agent dirs/cwds
contain isolated settings, managed-package symlinks and APPEND fixtures. The
new suite stops at registration (no `session_start`, sessions, model catalog,
credentials or requests needed); existing policy regressions use their offline
credential/catalog/session fixtures. No native workers or paid calls are
launched. Test-only reads of the installed public entry observe its guards.

The real ordinary gate registers the same 3 tools, 19 commands and 16 hook types
(with matching per-hook counts) as directly loading the upstream public entry
through the same SDK host. Commands have exactly one owning extension, and
bundled skills/prompts remain loaded. BB registers zero native tools, commands,
hooks, flags, shortcuts and control/event-bus subscriptions while an unrelated
extension still loads. Missing/broken peers work in BB and fail explicitly in
ordinary Pi. Loader reloads recreate BB/ordinary routing; policy-profile markers
alone never suppress native registration. Ambient directory discovery does not
load this folder without its explicit entry.

Unit tests cover blank markers, unfamiliar IDs, both BB profiles, pre-await host
capture, identical API forwarding, awaited async initialization, exact-once
invocation, explicit bad exports, unchanged errors/returns and no env mutation.
The config test checks the gate's two resource declarations without pinning
unrelated user-editable model/preferences. During integration, the owner compares
all other fields and existing user edits with the immediate pre-change snapshot.
