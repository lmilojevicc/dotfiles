# Model picker

`/model-picker` opens a compact provider/model browser. The configured prefix followed by `m` opens the same picker through `prefix-keybinds` (unless overridden). It dispatches a public Pi event rather than submitting a slash command, leaving the editor and expanded paste contents untouched even during streaming or compaction. If the picker is absent, the prefix action warns without replacing the draft.

- **Enter on a model:** switch this session and save its provider + model ID as the **global startup default**.
- **Tab / Shift+Tab:** move between providers and models. Up/down and page keys navigate the focused pane; Enter in providers returns to models.
- **Search:** fuzzy-match provider, ID or name, with punctuation-insensitive exact and substring matches ranked first. Search stays in place when changing provider. All and every available provider show live query counts, including zero matches.
- **Escape:** clear search first, then close without switching or saving. Native `tui.select.*` keybindings (including remaps) are honored. Left/right, home/end and deletion remain search editing keys.
- `*` marks the current session model independently of the highlighted row. Opening preselects that model when present. Identity includes both provider and ID.

The terminal-bounded overlay uses the active Pi theme and stays above host widgets/footer instead of competing for editor space. It resizes with the terminal. Narrow or short terminals show only the focused pane; Tab still switches panes. Compact hints prioritize Enter save (or back to models) and Escape clear/close. `[session]` identifies a restricted catalogue. At least 20 columns and 4 rows are required (long remapped key hints may need more); smaller layouts show “Resize required”, disable editing/navigation/confirmation, and allow Escape to close. Confirmation waits until the selected row has rendered. Lists scroll, identifiers are width-clipped safely, and the search Input retains Pi cursor/IME support. Roomier terminals show the selected model's name, context/output limits, input types, reasoning capability and catalogue base pricing (not measured performance).

## Catalogue and defaults

Opening uses the cached available registry; it does not discover providers, refresh credentials or make model API calls. A nonempty `ctx.scopedModels` strictly limits both panes and search. Cycling scope is never changed. There is no background refresh; reopen after Pi updates its catalogue.

The native `/model` command and `app.model.select` remain unchanged. This extension does not patch Pi internals, manage roles or maintain preference lists. It requires interactive terminal mode, not RPC/print/JSON.

Each confirmed selection loads a fresh public `SettingsManager` using the current project trust state. Load errors prevent switching. A failed model switch never saves the global default. A thrown switch reports that the active model **may have changed**: Pi can assign it before a transcript write fails. Successful switches persist the paired global default using native locking and field merging, preserving unrelated/concurrent valid settings edits. Both load and queued save errors are checked; a switched-but-unsaved result is reported explicitly, without pretending to roll back the session.

Trusted **project settings override global defaults**. CLI options and restored sessions can also override startup selection. This extension does not update Pi's in-memory settings cache: the native selector's saved-default marker can remain stale until **reload or restart**. It never reloads automatically.

### Settings safety boundary

Existing malformed JSON and non-object global roots (arrays, null, scalars) are rejected before loading and checked again immediately before saving. Missing and empty files follow Pi's native semantics. Invalid JSON introduced before the native locked write is rejected by Pi without overwriting it.

Pi 0.84.4 does not validate object roots inside its locked write, and its file storage is not exported through the public package API. A concurrent edit to a **valid JSON array** in the tiny interval after the final preflight check but before the queued native write can therefore be normalized/overwritten by Pi. Preflight validation cannot eliminate that native race. No private imports or alternate settings storage are used. Native writes also do not promise atomic-rename/crash durability.

## Replacing the old extension

The `model-favorites` extension code/UI has been removed. The legacy `model-favorites.json` file is **never read, written, migrated or deleted** by this extension; leave it as-is.

Deployment uses the existing directory-wide extensions symlink; no setup or settings changes are needed. **Fully restart Pi after deploying this replacement** to remove any old in-process selector patches. `/reload` alone cannot undo patches installed by the removed extension. Worktrees are not automatically deployed by the home symlink.

## Tests

```sh
npm --prefix pi/extensions/model-picker test
npm --prefix pi/extensions/prefix-keybinds test
```

Tests use Node's built-in runner, the globally installed Pi runtime/TUI and temporary SettingsManager directories; no dependency installs, model requests or real user configuration writes. Runtime tests load both extensions through Pi's real loader, check native selector prototype stability, and drive the installed TUI/host overlay through an in-memory terminal with a ten-line below-editor widget. They exercise real collapsed paste storage, direct prefix dispatch during streaming/compaction, cancel/confirm/errors, resize visibility, and the installed AgentSession mutation-before-throw path. No physical PTY or live model service is exercised. Node must support `--experimental-strip-types` and `module.registerHooks` (tested with Node 26.8.1 / Pi 0.84.4).
