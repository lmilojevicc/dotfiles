# Fork to Pane

A Pi extension that preserves the current session and opens a native-style fork in a new Herdr pane or tab. The selected user prompt is placed in the fork's editor without being submitted.

## Usage

```text
/fork-to-pane
/fork-to-pane horizontal
/fork-to-pane vertical
/fork-to-pane tab
```

With no argument, Pi offers exactly **Right**, **Below**, and **New tab** on every invocation; there is no configuration file. `horizontal` means a side-by-side split with the new pane on the right, `vertical` means a stacked split with the new pane below, and `tab` creates a tab in the originating pane's current Herdr workspace. Explicit arguments bypass the chooser. The source pane keeps focus and its session is not replaced.

The extension currently supports Herdr only. It refuses non-TUI use, busy or unsaved sessions, missing or stale pane identity, stale fork selections, and failed launches. A launch is successful only after the child validates the exact fork and restores the editor; startup or hydration timeout closes only the newly created pane or tab. For forks before the first prompt, it preserves any preceding model/thinking history and passes effective model/thinking startup overrides to the child when the retained history has no messages to restore that state itself.

## Installation

This repository's Dotty configuration links the whole `pi/extensions` directory to `~/.pi/agent/extensions`, so no package-specific activation entry is needed. Run `/reload` in an existing Pi session after changing the extension; newly started sessions discover `index.ts` automatically.

## Test

```sh
npm test
```

A failed handoff or launch can leave an unused fork session file even though the source session remains unchanged. A process crash can also leave the private handoff directory until temporary-file cleanup.
