# Widget presentation

The above-editor checklist follows the [reference](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/overlay.jpg): `● Tasks (done/total)`, dim tree branches, `✔` completed subjects with strikethrough, the original animated spinner for active subjects, and `◻` pending subjects. A distinct, nonempty active form follows the active subject in dim parentheses. Colors use the current theme's accent, success, warning, dim, and text roles rather than fixed RGB values.

Each row is clipped to the available terminal columns. The widget adds no border, IDs, elapsed time, token counters, or keyboard hints. Blocked tasks retain their blocker IDs. One trailing blank row separates the checklist from adjacent telemetry.

Display preferences remain unchanged: sorting, completed collapse, visible-task limit, top/bottom overflow, and show-all. Overflow and completed-summary rows participate in the tree. Deleted tasks do not contribute to counts. `Ctrl+Shift+T` temporarily inverts show-all without saving settings; session/branch resets restore the configured view. For short terminals, keep a compact visible-task limit; the widget does not own terminal height or focus. Full details and existing management actions remain in `/tasks-board` and `/tasks`.

## Custom glyphs and activity

Valid JSON `glyphs` overrides use the shared defaults and validation, unchanged in the board and menus. The default active spinner cycles through `✳ ✴ ✵ ✶ ✷ ✸ ✹ ✺ ✻ ✼ ✽` every 150 ms while a task is active. A valid `spinner` replaces these frames; a single frame remains static. `inProgress` (shared default `◼`) does not replace the widget's spinner. Invalid overrides fall back independently; an invalid spinner restores the default sequence. Timers stop when no task is active, a single-frame spinner is selected, the widget empties, the UI is rebound, or the widget is disposed.

Activity collection is unchanged and remains visible in the board. Elapsed time and input/output counters are ephemeral, session-scoped presentation data. Counters attribute the parent assistant turn's full input/output usage while the task is active; they are not execution or subagent telemetry. Activity starts fresh after reload, session/branch changes, or a different task starts, and is preserved across compaction only while the same task remains active.

## Verification

`tests/widget.test.ts` covers the seven-task reference, semantic colors, active-form deduplication, preferences and tree endings, shared default glyphs/spinner frames, explicit overrides, timer cleanup, temporary toggling, live theme/width changes, sanitization, Unicode clipping, and non-mutation. The full task suite also covers unchanged board interactions and state/tool contracts.

In Pi, check 80/40/20/5/1-column resizing, a short terminal, theme changes, and `Ctrl+Shift+T`. Confirm default and custom multi-frame spinners animate and stop, single-frame spinners stay static, and the editor retains focus. A reference-style sample must use an isolated configuration to show all seven rows, not overwrite global preferences.
