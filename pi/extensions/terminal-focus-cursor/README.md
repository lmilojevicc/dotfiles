# Terminal focus cursor

Hides Pi's inverse-video editor cursor while its terminal pane is unfocused.

| Environment | Activation | Focus ingress | DECSET 1004 behavior |
| --- | --- | --- | --- |
| Herdr (including Herdr nested in tmux) | `HERDR_ENV=1` in TUI mode | Prepended raw-stdin scanner plus UI terminal input | Herdr fullscreen manages it; this extension writes nothing |
| tmux | `TMUX` set in TUI mode and not in Herdr | Prepended raw-stdin scanner plus UI terminal input | This extension enables on activation and disables on cleanup; Pi fullscreen may also issue the same idempotent mode changes |
| Other or RPC mode | None | None | None |

Herdr takes precedence because its per-pane emulator is the focus authority. Pi fullscreen consumes focus reports before extension UI listeners, so both supported platforms use a prepended raw listener to update focus first; the UI listener still consumes any reports that reach extension ingress. Editor wrapping is deferred so other `session_start` editor/theme extensions compose first.
