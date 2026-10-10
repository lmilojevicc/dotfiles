# Redaction settings menu contract

## User request and scope

Add `/redaction` configuration menu, using Zentui's local menu patterns as a reference. Public package remains inside dotfiles; private config remains `~/.config/pi-redaction/config.json` / absolute XDG_CONFIG_HOME override. Do not enable any option or create/edit the user's real config during implementation. No Rust/scanner/sanitizer/history/file-tool/hot-path changes.

Zentui reference, READ ONLY: `~/Projects/zentui/AGENTS.md`, `extensions/zentui/settings-command.ts`, `settings-keys.ts`, `settings-list-selection.ts`, `editor-transfer.ts`. UI pattern: native Pi SettingsList, section tabs, theme-aware bounded lines, keyboard bindings, explicit action outcomes and local dialog loops. Write a concise original implementation rather than vendor Zentui. If any substantial code is copied/adapted, retain its MIT license/copyright in notices; do not import Zentui as a runtime dependency or modify it.

Read installed Pi docs/extensions.md and docs/tui.md completely, public API declarations and relevant examples. RPC custom UI is unsupported; this menu is human-command TUI only. Private dialog values must never pass through model messages, custom session entries, tool results, console logs or RPC UI requests.

## UX

- `/redaction` is available even when all filtering is off. `/redaction-status` remains compatible.
- Three sections: Sources, Detectors, Replacements. Source and detector switches are independent and preserve current schema. No new master flag, preset or implicit enabling.
- Sources: Tool results, User messages, System prompt. Detectors: Emails, Phones, API tokens, Private keys, URL credentials.
- Replacements: add/edit/delete exact value-to-alias mappings. Main lists show sanitized aliases/opaque ordinal IDs and masked originals; never raw source values. Raw values appear only in explicit local edit forms. Avoid embedding raw originals in item IDs, confirmation messages or notifications. Preserve exact value text, including whitespace/multiline values; do not silently trim literal rules. Avoid prototype-key hazards for values such as __proto__.
- Prefer native SettingsList, current theme, visible-width helpers; Tab/Shift-Tab section navigation, application-aware select up/down/confirm/cancel, Space toggles, an accessible Save & reload row/action and optional Ctrl+S shortcut. Escape cancels, confirming discard only when dirty. Test narrow/zero widths, resize, Unicode, control-sequence labels, all sections and binding overrides.
- Draft-only edits until explicit Save & reload. Open/cancel creates nothing. Clearly distinguish running state and pending draft; a source plus a rule is needed for active filtering. Keep copy minimal; contextual selected-row help only where necessary (not repeated descriptive paragraphs).
- Before saving reduced protection, one concise confirmation that previously protected content may be exposed; do not echo secrets. No default-on convenience preset.
- Validate JS schema and native rule compatibility before persistence. A rule-bearing draft requires available native validation even when sources are off, so invalid alias combinations aren't silently saved. All-off/no-rule drafts can be managed without the addon. Validation sends no model request. Missing backend gets a safe actionable build instruction; no raw errors.
- Wait for idle before save/reload; close custom UI first. Save successful config atomically, then call supported command-context reload. Never use old context/runtime after awaited reload. Reload failure must not claim new config active; return a generic restart-needed error. Do not mutate current engine/hooks in place or reset the failure latch manually.
- Cancellation/session lifecycle must not allow a late stale dialog to write/reload after the interaction was disposed. Use public cancellation/lifecycle APIs where appropriate. Preserve the main editor draft; never paste private form values into the ordinary prompt editor. If applying the expanded-paste draft preparation pattern, only transfer existing prompt text, not private forms.
- Non-TUI/RPC/headless invocation refuses without reading private configuration for UI, opening private dialogs, writing or reloading. Unknown command arguments yield constant usage text, never echo arbitrary values. No model-callable configuration tool.

## Secure persistence seam

Parent-owned `src/menu-contracts.ts` defines PrivateConfigSnapshot and PrivateConfigStore. Store writer exports `createPrivateConfigStore(path?:string): PrivateConfigStore` and a safe `ConfigStoreError` with one of the declared value-free codes, from `src/config-store.ts`.

- Read is side-effect-free, missing config yields offConfig. Existing invalid/unsafe config must not be silently overwritten/reset. Return a generic actionable error; manual repair can remain out of scope.
- Use existing schema/parser validation and native-compatible JSON serialization; enforce the existing 1MiB private-config file limit BEFORE large reads/writes and detect growth. No raw-value errors, error causes or debug dumps.
- Explicit save only: private directory0700 when newly created, file0600, correct owner, no unsafe writable directories/files or symlink target. Do not chmod unrelated existing directories/files. Refuse unsupported safety guarantees rather than pretending world-readable storage is private.
- Optimistic snapshot revision and file/parent identity checks prevent silently overwriting external edits/deletion/replacement. In-process queue plus a bounded cooperative cross-process lock is acceptable; never steal/delete another process's lock. No indefinite waits or automatic stale-lock deletion.
- Write bounded temporary file0600 in owned destination directory, fsync, atomic replacement/exclusive missing-file creation as appropriate, cleanup only owned temp/lock entries. No plaintext backups or metadata containing literal values. Precommit failures leave existing config intact. Once link/rename commits, return the applied snapshot; postcommit directory-sync/owned-cleanup issues use optional value-free snapshot.warnings (`durability`/`cleanup`), never a false unchanged-save error or rollback. Controller warns generically before reload. Revisions use stable facts and match subsequent reads, not stale pre-rename ctime/link counts/parentmtime. Crash durability remains qualified. Acknowledge remaining non-cooperating same-user filesystem race windows; do not claim OS CAS/sandbox.
- Revision is opaque local data, never displayed/logged/sent to model. Store itself validates schema/bounds; controller additionally validates native combinations before calling save.
- Read/save operate on explicitly injected temporary paths in tests; NEVER open the user's actual private config during development or verification.

## Ownership / topology

Multi-seam:

1. Store writer, isolated `feat-redaction-menu-store`: `src/config-store.ts`, optional `src/config-store/**`, `tests/config-store*.test.ts` only. Existing config.ts/runtime/hot paths and parent menu-contracts.ts read-only. Tests for permissions, missing no-create, atomic save/reload, malformed JSON/schema, bounds/growth, symlink/owner checks, stale edits, concurrent saves, lock cleanup, generic errors, prototype keys. No Pi dependency necessary.
2. UI writer, isolated `feat-redaction-menu-ui`: `src/settings-*.ts` (or src/settings/**), minimal `/redaction` registration in src/index.ts before inactive return, tests/settings-*.test.ts, minimal existing command-count assertions, package.json peer/script entries if needed, README concise usage, docs/settings.md; notices/license files only if copying licensed code. No store/native/scanner/sanitizer/file-tools edits. Store module imported through agreed seam; mock it for independent tests. TUI/native modules load lazily only on human invocation; inactive/source-only import must still work without addon/UI peers.
3. Integration-only writer, after both source handoffs: copy owned files into menu integration worktree, resolve glue/type/test mismatches, add actual menu+store+native tests. Do not rewrite privacy/runtime algorithms. Check default-off and no actual private-config access. Test public toolkit render/input behavior and an isolated TUI smoke if feasible; all npm tooling only TEMP. Parent performs all git operations and preserves unrelated main changes.
4. Fresh Astra review verifies UI/UX, secret handling, safe save/reload/lifecycle, inactive laziness and no redaction/performance regression. Parent final validation and commit only after fixes.

Every child uses openai-codex/gpt-6.1-sol except reviewer openai-codex/gpt-6-astra. No child git/gh, release/publish, global install, nested agents, or edits to live settings. No automatic reload of the operator's current Pi. No mutation of the Rust fast paths; existing benchmark is historical source-hashed evidence and must not be retimed/relabelled merely for a cold command registration change.
