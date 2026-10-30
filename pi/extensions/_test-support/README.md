# Shared Pi test support

Every extension under `pi/extensions/` imports `@earendil-works/*` packages that only exist inside
Pi's managed install, never in the extension's own `node_modules`. Point a suite's `npm test` at the
loader here instead of copying it:

```json
{
  "scripts": {
    "test": "node --experimental-strip-types --import ../_test-support/register-loader.mjs --test ./tests/*.test.ts"
  }
}
```

Keep the suite's own test file globs. Paths are relative to the extension directory, because `npm`
runs the script with that directory as the working directory.

## What `register-loader.mjs` does

1. Locates `@earendil-works/pi-coding-agent` exactly like the shipped Pi launcher does: `PI_PACKAGE_ROOT`
   first, then the managed install behind the `pi` launcher (`realpath $(which pi)` →
   `../install/current-version` → `install/releases/<version>/node_modules/...`), then `npm root -g`.
   If none of them hold the package it fails once with a message naming `PI_PACKAGE_ROOT`.
2. Resolves every `@earendil-works/*` specifier — bare (`@earendil-works/pi-tui`) or deep
   (`@earendil-works/pi-tui/dist/utils.js`) — plus `typebox` with Pi's own `package.json` as parent,
   so all packages come from one Pi release and never from a stale global or leftover `node_modules`.
3. Isolates `HOME`, `PI_CODING_AGENT_DIR` (`$HOME/agent`, created empty) and `TMPDIR` in a fresh
   `mkdtemp` directory before any test imports Pi, and removes it on exit. A test may still create its
   own temporary agent dir, as long as it stays under `tmpdir()`.

It exports nothing: it is used only through `--import`.

## Suites that need more than the loader

When an old per-extension loader did extra work, keep that in a tiny local `tests/setup.mjs` and load
it after the shared one (`--import ../_test-support/register-loader.mjs --import ./tests/setup.mjs`):

- Pi mocks and TUI aliases (replace the runtime specifier with a local module);
- suite-specific environment (`PI_BASH_WAIT_SECONDS`, worker-process agent dirs, offline switches);
- module resolution shims such as mapping relative `./x.js` imports to `./x.ts`.

`setup.mjs` may only add to what the shared loader did; never re-resolve `@earendil-works/*` itself.

## Tests that need Pi internals

`pi-package.mjs` gives a test the installed package root (and file URLs under it) without hard-coding
an install location:

```js
import { piModuleUrl } from "../../_test-support/pi-package.mjs";

const { loadExtensions } = await import(piModuleUrl("dist/core/extensions/loader.js"));
```

It relies on the bare specifier that the shared loader resolves, so it only works in a suite started
with `--import ../_test-support/register-loader.mjs`.
