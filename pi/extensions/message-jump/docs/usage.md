# Message jump

`/jump` opens a searchable picker of **actual user-message entries on the active branch**, oldest to newest, with the latest message initially selected. `/jump words` prefills the search. Search is case-insensitive across the full prompt (including text beyond the preview); whitespace-separated terms must all match. Type to filter (the latest match is selected after each query change), use the configured selection keys to navigate and confirm, or **Escape** to cancel. Up goes older, Down newer, and both wrap at the ends. No default shortcut is registered.

Multiline prompts get single-line previews; images are counted (`[1 image]`), and empty prompts are labeled. Duplicate prompts remain separate entries, selected by stable session entry ID—not by text. The picker does not include abandoned branches or queued, unpersisted drafts. Each preview has a `Message N of total` metadata line using its original chronological active-branch number, even when filtering.

Selection scrolls the existing fullscreen transcript, disables automatic end-following, and returns focus to the editor. Near the end, viewport clamping can leave the selected prompt visible rather than exactly top-aligned. Use Pi's normal jump-to-end action (default Ctrl+End) to resume following new output. The extension never forks, navigates the session tree, appends session entries, sends model messages, changes context/model, or calls editor-draft setters. The picker uses public nonoverlay `ctx.ui.custom()` to replace the editor area inline, like native `/fork`, with full-width themed borders, two-line message rows and an integrated search field. Pi internally saves the existing editor text and restores it when the picker closes, on jump or cancel; the final draft remains unchanged. Pi's normal slash-command submission behavior still applies before the picker opens.

**Ctrl+Y** copies the highlighted message's full original text to the system clipboard, preserving newlines and Unicode. It keeps the picker open and leaves the search, selection, transcript and draft unchanged. Feedback appears in the existing spacer below the search field. Compacted/unavailable messages can still be copied; image-only/empty messages report that there is no text to copy. Clipboard errors are shown without closing the picker. Ctrl+Y is reserved for copying inside this picker, even if a selector action is rebound to it.

## Load and supported modes

Supported host: **Pi 1.0.4, interactive fullscreen, standard transcript layout, one InteractiveMode instance per process**. From this checkout:

```sh
pi --tui-mode fullscreen -e ./pi/extensions/message-jump/index.ts
```

Or let Pi discover this directory when deployed to its extensions directory. Load it only once. Restart Pi after first adding the extension: an initial `/reload` cannot observe the already-mounted transcript safely. Once loaded at startup, subsequent `/reload` retains the observed component map and transfers ownership safely.

Regular mode delegates scrollback to the terminal; `/jump` explains how to choose fullscreen in `/settings`. RPC, print, and JSON modes cannot display the picker and report that interactive fullscreen is required (stderr in modes without UI). Other Pi versions fail closed with upgrade/bridge-update guidance, rather than pretending to scroll.

The picker honors `tui.select.up/down/pageUp/pageDown/confirm/cancel` from the injected keybindings manager. Escape always cancels, even if the cancel action has been rebound. Search editing uses Pi TUI's `Input` and its configured editing actions. Preview rendering uses Pi TUI's terminal-column-aware truncation, theme callbacks, propagated input focus, and height/width-responsive layout (up to ten messages, reduced on shorter terminals and when headers wrap). Only the selected prompt is bold; its caret is accent-colored. A native-style bottom position indicator appears when the filtered list exceeds the visible window.

## Unavailable destinations and session changes

Messages absent from the current rendered transcript stay searchable and have an `[unavailable]` marker. Selecting one explains that it cannot be jumped to. In Pi 1.0.4, this includes compacted-away history and image-only/empty prompts (the host renders no user component for them). No transcript reconstruction or context rewriting is attempted.

While the picker is open its list is a snapshot. On confirmation the entry ID is resolved again on the current branch, and its message identity and current component presence are checked. New live output is measured at confirmation, as is resized layout. Session switch/shutdown cancels the picker; stale selections and compaction removals fail safely. Reopen `/jump` to refresh the list.

## Private bridge contract

There is **no public ExtensionUIContext transcript-scroll API** in Pi 1.0.4. All private access is isolated in `bridge.ts`:

- Version-pinned, shape-checked wrappers observe `InteractiveMode.mountInteractiveTui` and `addMessageToChat`, forwarding each original exactly once. They do not replace the editor, footer, rendering tree, or session controls.
- A weak map associates original user message objects with newly rendered non-Spacer components. Restored entry conversion and live `message_start` → `message_end` persistence preserve those objects on the tested host. Skills can create two components: the first marks the beginning of the prompt. No text/ordinal matching fallback exists.
- The adapter requires the standard document/chat Container renderers, transcript child, current terminal-wide stretch VStack root, and ScrollView width/scroll methods. It calls the host renderer's `renderNow()` before measuring to refresh viewport metrics, then sums real rendered line counts of document/chat predecessors at `getContentWidth(terminal.columns)`. Movement uses public `ScrollView.scrollTo(row, {disableFollow:true})` and `requestRender()`.
- Global symbol ownership prevents duplicate installation, checks wrapper identity, and preserves read-only capture across reload/session replacement. Shutdown closes the inline picker; quit restores only wrappers still owned and drops references. No timers, terminal listeners, or persistent entries are created by this extension.

Transcript/layout wrappers that alter document or chat width/rendering are rejected with actionable feedback. **Reader-mode compatibility is not claimed**: the neighboring reader-mode extension guards a different Pi version. A future reader/layout wrapper needs a new validated width contract, not an optimistic text search or guessed row offset. Same-version private API changes and arbitrary third-party layout-node mutations can still invalidate this integration; use the standard host layout and rerun the integration smoke after host changes.

## Verification

```sh
cd pi/extensions/message-jump
PATH=/opt/homebrew/bin:$PATH npm test
PATH=/opt/homebrew/bin:$PATH npm run test:real-pi
```

Requires Node with `--experimental-strip-types` and `node:module.registerHooks` (tested on Node 26.10.0), installed Pi/TUI on PATH (or `PI_PACKAGE_ROOT` / `PI_BIN`), plus Python 3 and existing `fd`/`rg` for the offline PTY smoke. No npm dependencies or global installations are needed. Focused tests mock the coding-agent host seam while using the actual installed TUI for keys, Unicode widths, containers, and ScrollView.

The real integration launches installed **bundled Pi 1.0.4** in temporary isolated HOME/agent/cwd/session directories, offline and without API keys, project resources or other extensions. It verifies restored history, duplicate entry destinations, live message identity through the actual AgentSession event/persistence path, actual viewport scrollTop and follow state, unchanged session/model/branch/context/draft/focus, inline mounting in the editor container, chronological navigation, Escape, resize, reload ownership, compacted-history rejection, /new session replacement with fresh live messages, and truthful regular-mode feedback. At 100×50 and 65×32 it also compares ANSI-styled picker output against the installed native `/fork` selector source rendered offscreen (never mounted), substituting only jump-specific header copy, removing the added search line, and adjusting the visible row count for terminal height. This verifies native spacing, full-width borders, chronological prompt/metadata/blank rows, selected caret/bold styling and bottom position indicator. The test-only probe injects user lifecycle events without calling a model and uses the host's real compaction entry/context rebuild. It does not test network model streaming or model-generated compaction; session-switch races while a picker is open and altered-width wrappers are covered by focused tests. No installed Pi or live configuration is modified.
