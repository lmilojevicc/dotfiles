# Experimental Reader Mode

Constrains Pi's complete interactive session UI to one horizontally centered column. The transcript, pending messages, status, widgets, editor, and footer share the same width. Overlays remain terminal-relative, and fullscreen's primary `ScrollView` remains full-terminal-width so its scrollbar stays at the terminal edge.

The default maximum is 110 columns. Terminals at or below the maximum render normally with no margins. When the unused width is odd, the right margin is one column wider.

## Command

- `/reader` toggles reader mode and retains the current width.
- `/reader on` enables it.
- `/reader off` disables it and retains the current width.
- `/reader <positive integer>` sets the maximum width and enables it.

Invalid or compound arguments do not change state. State is appended as Pi custom session entries (`dotfiles.reader-mode`) and restored from the latest entry on session start, reload, switch, or resume after the extension has observed the interactive root layout. The extension does not create a global preferences file.

A first installation through `/reload` happens after Pi has already mounted that layout, and Pi 0.84.2 exposes no safe way for the extension to remount it. Until a patched mount is observed, `/reader on`, an enabling `/reader` toggle, and `/reader <width>` show an acknowledgement dialog on every attempt. Confirming, dismissing, or letting it time out does not change or persist state, wrap existing roots, request a render, or trigger a private action. Restart Pi or switch TUI mode in `/settings`, then rerun the desired `/reader` command. Before observation, `/reader off` is an idempotent silent no-op because reader mode is already off; non-TUI and no-UI command contexts are also inert.

## Private-internals warning

**This is an experimental, private-internals implementation.** Pi 0.84.2 has no supported root content-width API. The extension therefore patches the non-public `InteractiveMode.prototype.mountInteractiveTui` method and wraps the seven root region components' `render(width)` methods by identity. It expects the layout built in `dist/modes/interactive/interactive-mode.js` around the fullscreen `ScrollView`/dock and regular seven-region mount.

The patch checks Pi's public `VERSION` before changing the prototype, then checks the method and mounted layout shapes as defense in depth. Centering uses the renderer terminal width, not the transcript's scrollbar-adjusted width, so fullscreen `auto`, `always`, and `hidden` scrollbar layouts share a left edge. Rendered margins are inserted after leading OSC 133 A/B/C prompt markers, and exact empty image-reservation rows remain empty.

A process-global Symbol prevents duplicate wrapping and method identities are restored on final session shutdown when Pi's lifecycle permits. Pi reuses its mounted component tree during extension reload and session replacement, so an accepted runtime's non-final shutdown leaves the patch installed but disabled and explicitly releases ownership for the next extension runtime to reclaim. Reload of an extension that has already observed the layout remains supported, as do renderer mode switches for that same `InteractiveMode` object.

**Intentional limitation:** exactly one `InteractiveMode` instance is supported per process. If a genuinely second instance mounts, reader mode fails closed process-wide: all wrapped render methods and the original prototype method are restored, the second instance is left unpatched, and a small permanent tombstone prevents any extension runtime from reclaiming the patch until Pi restarts. Commands and lifecycle handlers then remain inert and report a bounded error without changing session state. This explicit fail-safe avoids process-global state crossing between concurrent sessions. If the guarded seam, version, ownership, or layout changes, reader mode stays off and reports an error rather than applying a partial Markdown/editor-only layout.

A full Pi restart is recommended after changing this package. Run unit/contract tests and the PATH-discovered installed-host smoke check with:

```sh
npm test
npm run test:real-pi
```

The host smoke requires a Pi 0.84.2 executable on `PATH`; set `PI_BIN=/path/to/pi` when it is installed elsewhere. It resolves the package from that executable and does not assume a Homebrew path.
