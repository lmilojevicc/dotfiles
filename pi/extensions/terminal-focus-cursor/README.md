# Terminal focus cursor

Hides Pi's editor cursor while its terminal pane is unfocused.

Pi 1.4.0 does not draw the editor cursor with an SGR code the extension could strip. The editor emits
`CURSOR_MARKER` plus a zero-width APC fake-cursor pair around the cursor grapheme, and pi-tui resolves
that pair into inverse video and consumes the marker *after* the component renders. So the wrapper
strips all three markers from the blurred render, keeping the grapheme they wrap: with
`showHardwareCursor: false` the inverse-video block disappears, and with it enabled pi-tui no longer
finds a cursor position and hides the hardware cursor. Literal `\x1b[7m` spans are stripped too, for
editors that paint the cursor themselves.

Host focus changes are presentation-only: the wrapper leaves the editor's `focused` keyboard-ownership flag untouched and filters cursor output after rendering. This preserves other editor consumers such as Zentui's Working border. Genuine dialog/overlay focus transfers still use Pi's normal `focused` lifecycle.

When no other extension installed an editor factory, the wrapper falls back to its own `CustomEditor`
with Pi's default options (`embedWorkingStatus: true`), so the Working indicator stays in the editor's
top border. That fallback editor is created once per TUI and reused when Pi reinstalls editor
components (`/new`, `/resume`, `/fork`, `/clone`), which keeps in-memory prompt history and undo.

| Environment | Activation | Focus ingress | DECSET 1004 behavior |
| --- | --- | --- | --- |
| Herdr (including Herdr nested in tmux) | `HERDR_ENV=1` in TUI mode | Prepended raw-stdin scanner plus UI terminal input | Herdr fullscreen manages it; this extension writes nothing |
| tmux | `TMUX` set in TUI mode and not in Herdr | Prepended raw-stdin scanner plus UI terminal input | This extension enables on activation and disables on cleanup; Pi fullscreen may also issue the same idempotent mode changes |
| Other or RPC mode | None | None | None |

Herdr takes precedence because its per-pane emulator is the focus authority. Pi fullscreen consumes focus reports before extension UI listeners, so both supported platforms use a prepended raw listener to update focus first; the UI listener still consumes any reports that reach extension ingress. Editor wrapping is deferred so other `session_start` editor/theme extensions compose first.
