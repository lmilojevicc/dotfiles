# Session to Pane

A Pi extension that opens independent session copies in tmux or Herdr while leaving the source pane and session unchanged.

## Commands

```text
/fork-to-pane [horizontal|vertical|tab]
/tree-to-pane [horizontal|vertical|tab]
/clone-to-pane [horizontal|vertical|tab]
```

- `/fork-to-pane` keeps its original behavior: select a user prompt, copy only the path before it, and place that prompt in the new editor without submitting it.
- `/tree-to-pane` uses Pi's native-style tree selector, copies the complete session tree (including alternate branches), and opens at the selected position. Selecting a user or custom-message node places its text in the new editor, matching native `/tree` semantics. It never summarizes or navigates the source session.
- `/clone-to-pane` copies the complete tree at the current active position and carries the current unsent editor draft. It has no tree picker.

A tree or clone copy preserves all source entries and appends one `session-to-pane-position` custom entry. This non-context marker records the copied session's active position because Pi session headers do not persist a leaf pointer. It can appear in `/tree` views that show all custom nodes.

With no argument, the destination chooser offers **Right**, **Below**, and **New window** in tmux or **New tab** in Herdr. `horizontal`, `vertical`, and `tab` bypass that chooser. The source pane retains focus.

The host is detected on every invocation. tmux wins when `TMUX` is present, including tmux nested inside Herdr; otherwise Herdr is selected from its environment markers. Unsupported or stale selected-host identity fails closed without fallback. Both adapters pin the source identity, quote launch data, restore the draft through a protected bootstrap handoff, and report success only after atomic readiness acknowledgement. Tree and clone launch with the source's current runtime model and thinking level, matching native tree navigation without making a provider request.

## Installation

This repository's Dotty configuration links the whole `pi/extensions` directory to `~/.pi/agent/extensions`, so no package-specific activation entry is needed. Run `/reload` in an existing Pi session after changing the extension; new sessions discover `session-to-pane/index.ts` automatically.

## Test

```sh
cd pi/extensions/session-to-pane
npm test
```

A failed host launch can leave an unused copied session file, while the source remains unchanged. Pi's public full-tree copy API writes incrementally; this extension withholds launch until the finished copy and position marker verify successfully and removes only a failed output whose fresh identity and parent are proven.
