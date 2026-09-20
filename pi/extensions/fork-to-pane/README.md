# Fork to Pane

A Pi extension that preserves the current session and opens a native-style fork in a new tmux or Herdr pane. The selected user prompt is placed in the fork's editor without being submitted.

## Usage

```text
/fork-to-pane
/fork-to-pane horizontal
/fork-to-pane vertical
/fork-to-pane tab
```

With no argument, Pi offers **Right**, **Below**, and a host-specific final destination: **New window** in tmux or **New tab** in Herdr. There is no configuration file. `horizontal` opens a detached side-by-side split on the right, `vertical` opens a detached stacked split below, and `tab` creates a detached window in the originating tmux session or a tab in the originating Herdr workspace. Explicit arguments bypass the chooser. The source pane keeps focus and its session is not replaced.

The host is detected on every invocation. When `TMUX` is present, tmux is always selected, including tmux nested inside Herdr; otherwise Herdr is selected when Herdr environment markers are present. An unsupported host is rejected before a picker or fork is created. A malformed or stale identity for the selected host fails closed without falling back to the other host.

Tmux operations derive the originating session from `TMUX`, resolve the pane/window inside that session, and pin the socket plus captured pane, window, session, and server identities rather than relying on the focused client or default server. Creation and timeout cleanup atomically recheck server ownership before mutating the pinned socket. Herdr operations retain their captured pane and workspace targeting. Both hosts refuse non-TUI use, busy or unsaved sessions, missing or stale identity, stale fork selections, and failed launches. A launch is successful only after the child validates the exact fork and restores the editor; startup or hydration timeout closes only a strictly proven newly created pane, tmux window, or Herdr tab. For forks before the first prompt, the extension preserves preceding model/thinking history and passes effective model/thinking startup overrides when retained history has no messages to restore that state itself.

## Installation

This repository's Dotty configuration links the whole `pi/extensions` directory to `~/.pi/agent/extensions`, so no package-specific activation entry is needed. Run `/reload` in an existing Pi session after changing the extension; newly started sessions discover `index.ts` automatically.

## Test

```sh
npm test
```

A failed handoff or launch can leave an unused fork session file even though the source session remains unchanged. A process crash can also leave the private handoff directory until temporary-file cleanup. If a host creates a target but returns an invalid identity, the extension deliberately does not guess which target to close.
