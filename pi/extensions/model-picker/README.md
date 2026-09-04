# Model picker

`/model-picker` opens a compact provider/model browser. The configured prefix followed by `m` opens the same picker through `prefix-keybinds` (unless overridden). It dispatches a public Pi event rather than submitting a slash command, leaving the editor and expanded paste contents untouched even during streaming or compaction. If the picker is absent, the prefix action warns without replacing the draft.

- **Enter on a model:** switch this session and save its provider + model ID as the **global startup default**.
- **Tab / Shift+Tab:** move between providers and models. Up/down and page keys navigate the focused pane; Enter in providers returns to models.
- **Search:** fuzzy-match provider, ID or name, with punctuation-insensitive exact and substring matches ranked first. Search stays in place when changing scope. The sidebar lists All, Favorites, then available providers, each with live query counts including zero matches.
- **Escape:** clear search first, then close without switching or saving. Native `tui.select.*` keybindings (including remaps) are honored. Left/right, home/end and deletion remain search editing keys.
- **Ctrl+F on a visible model:** toggle its favorite. `★` marks favorites; `*` independently marks the current session model. Stars and counts update only after saving. In All/provider scopes, toggling keeps the visible order, highlighted physical row and scroll position unchanged. Native selection keys remapped to Ctrl+F take precedence. Identity includes both provider and ID.
- **Favorites scope:** show only saved favorites in the available/session catalogue, across providers. Toggle results reconcile membership in the existing match order without re-sorting, including fresh external changes. A surviving selected tuple stays selected; otherwise its row index selects the next neighbor (or previous at the end). Removing the last keeps the query and Favorites scope with “No favorites yet”. Search with no matching favorites shows “No matching models”.
- On opening, an actual query edit/clear, or an actual scope change, favorites are ranked in their saved order, then the current nonfavorite, then provider/ID. Merely switching pane focus or navigating models never re-sorts. Opening selects the current model if favorite, otherwise the first available favorite, otherwise current, otherwise first. Search tiers remain primary, with favorites in saved order within each tier and the remaining fuzzy order retained.

The tasks-inspired floating overlay is centered at 95% terminal width and at most 85% height / 22 rows, with inset spacing, a rounded frame, one-cell inner padding and muted pane/rule dividers. Its small title and accent cursor / bold selection replace a heavy row background; the active sidebar scope stays accented even while browsing models. It uses the active Pi theme and stays above host widgets/footer instead of competing for editor space. Narrow or short terminals show only the focused pane and progressively omit decoration; Tab still switches panes. Whole footer hints prioritize Enter save (or back to models) and Escape clear/close. `[session]` identifies a restricted catalogue. The unframed component supports 20 columns × 4 rows (long remapped keys may need more); the host must also have room for the overlay inset. Insufficient space shows “Resize required”, disables editing/navigation/confirmation/favorite toggles, and allows Escape to close. Raw terminal resize before repaint also disables mutations until a new usable frame is visible. Confirmation and favorite toggles wait until the selected row has rendered. Retained viewports minimally reveal selection and clamp on resize/tail removal; page keys use the actual body row count. Frame height stays stable across membership changes, including empty Favorites. Identifiers are width-clipped safely, and the search Input retains Pi cursor/IME support. Rows show model IDs within a provider, or provider/ID in All and Favorites. The hidden sidebar's scope appears once on narrow layouts. Redundant pane headings, browsing tutorials and permanent model metadata rows are omitted; the footer adapts to available width.

## Catalogue and defaults

Opening uses the cached available registry; it does not discover providers, refresh credentials or make model API calls. A nonempty `ctx.scopedModels` strictly limits both panes and search. Cycling scope is never changed. There is no background refresh; reopen after Pi updates its catalogue.

The native `/model` command and `app.model.select` remain unchanged. This extension does not patch Pi internals or manage roles. It requires interactive terminal mode, not RPC/print/JSON.

Each confirmed selection loads a fresh public `SettingsManager` using the current project trust state. Load errors prevent switching. A failed model switch never saves the global default. A thrown switch reports that the active model **may have changed**: Pi can assign it before a transcript write fails. Successful switches persist the paired global default using native locking and field merging, preserving unrelated/concurrent valid settings edits. Both load and queued save errors are checked; a switched-but-unsaved result is reported explicitly, without pretending to roll back the session.

Trusted **project settings override global defaults**. CLI options and restored sessions can also override startup selection. This extension does not update Pi's in-memory settings cache: the native selector's saved-default marker can remain stale until **reload or restart**. It never reloads automatically.

### Settings safety boundary

Existing malformed JSON and non-object global roots (arrays, null, scalars) are rejected before loading and checked again immediately before saving. Missing and empty files follow Pi's native semantics. Invalid JSON introduced before the native locked write is rejected by Pi without overwriting it.

Pi 0.84.4 does not validate object roots inside its locked write, and its file storage is not exported through the public package API. A concurrent edit to a **valid JSON array** in the tiny interval after the final preflight check but before the queued native write can therefore be normalized/overwritten by Pi. Preflight validation cannot eliminate that native race. No private imports or alternate settings storage are used. Native writes also do not promise atomic-rename/crash durability.

## Favorites and legacy compatibility

Favorites use the existing `getAgentDir()/model-favorites.json` object with a `favorites` array of nonempty `provider/id` strings. IDs can contain slashes; saved identities are never split. Unavailable favorites remain stored but cannot broaden the cached/session-constrained catalogue. New favorites append; removing and readding moves them to the end. There are no favorite sections or management screens, and native `/model` stays untouched.

Opening reads without writing. Only an explicit Ctrl+F toggle writes; cancel and default-model save do not touch favorites. Each toggle rereads the file, preserves unrelated JSON fields and unavailable IDs, then uses a same-directory temporary file and atomic rename, retaining existing permissions and cleaning temporary files on failure. A missing file (or missing `favorites` field in an object) is empty. Invalid JSON, non-object roots, malformed arrays/members and unreadable files are rejected without repair, migration or deletion. Symlinks/non-regular files are refused; read-only files can be read but cannot be replaced. Correct the file/access externally and retry or reopen. Errors remain visible without preventing browsing or default-model saving; stars update only after successful persistence. At minimum height, a compact favorites-error search prefix preserves the row, cursor and primary controls.

Atomic replacement is **not multi-process locking** or crash durability: simultaneous external writers can still race between the fresh read and rename, losing an intervening update or changing the target's type/permissions. There is no background synchronization; reopen to pick up external changes, or toggle to reread. This is deliberately not a new storage engine.

## Replacing the old extension

The old `model-favorites` prototype-patching extension has been removed; its saved favorites are reused by this standalone picker.

Deployment uses the existing directory-wide extensions symlink; no setup or settings changes are needed. **Fully restart Pi after deploying this replacement** to remove any old in-process selector patches. `/reload` alone cannot undo patches installed by the removed extension. Worktrees are not automatically deployed by the home symlink.

## Tests

```sh
npm --prefix pi/extensions/model-picker test
npm --prefix pi/extensions/prefix-keybinds test
```

Tests use Node's built-in runner, the globally installed Pi runtime/TUI and temporary favorites/SettingsManager directories; no dependency installs, model requests or real user configuration writes. Runtime tests load both extensions through Pi's real loader, check native selector prototype stability, and drive the installed TUI/host overlay through an in-memory terminal with a ten-line below-editor widget. They exercise real collapsed paste storage, direct prefix dispatch during streaming/compaction, cancel/confirm/errors, resize visibility, and the installed AgentSession mutation-before-throw path. No physical PTY or live model service is exercised. Node must support `--experimental-strip-types` and `module.registerHooks` (tested with Node 26.8.1 / Pi 0.84.4).
