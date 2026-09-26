# Widget presentation

The above-editor checklist follows the [reference](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-todo/docs/overlay.jpg): `● Tasks (done/total)`, dim tree branches, `✓` completed subjects with strikethrough, `◐` active subjects, and `○` pending subjects. A distinct, nonempty active form follows the active subject in dim parentheses. Colors use the current theme's accent, success, warning, dim, and text roles rather than fixed RGB values.

Each row is clipped to the available terminal columns. The widget adds no border, IDs, elapsed time, token counters, or keyboard hints. Blocked tasks retain their blocker IDs. One trailing blank row separates the checklist from adjacent telemetry.

Display preferences remain unchanged: sorting, completed collapse, visible-task limit, top/bottom overflow, and show-all. Overflow and completed-summary rows participate in the tree. Deleted tasks do not contribute to counts. `Ctrl+Shift+T` temporarily inverts show-all without saving settings; session/branch resets restore the configured view. For short terminals, keep a compact visible-task limit; the widget does not own terminal height or focus. Full details and existing management actions remain in `/tasks-board` and `/tasks`.

## Custom glyphs and activity

Valid JSON `glyphs` overrides still apply. Checklist defaults are widget-local; board/menu defaults are unchanged. Without an explicit valid `spinner`, the widget uses `inProgress` or `◐` and needs no animation timer. An explicit `spinner` takes precedence over `inProgress`; multiple frames animate every 150 ms while a task is active. Single-frame spinners remain static. Invalid overrides fall back independently.

Activity collection is unchanged and remains visible in the board. Elapsed time and input/output counters are ephemeral, session-scoped presentation data. Counters attribute the parent assistant turn's full input/output usage while the task is active; they are not execution or subagent telemetry. Activity starts fresh after reload, session/branch changes, or a different task starts, and is preserved across compaction only while the same task remains active.

## Verification

`tests/widget.test.ts` covers the seven-task reference, semantic colors, active-form deduplication, preferences and tree endings, explicit glyphs/spinners, timer cleanup, temporary toggling, live theme/width changes, sanitization, Unicode clipping, and non-mutation. The full task suite also covers unchanged board interactions and state/tool contracts.

In Pi, check 80/40/20/5/1-column resizing, a short terminal, theme changes, and `Ctrl+Shift+T`. Confirm the default active glyph is static, custom multi-frame spinners animate and stop, and the editor retains focus. A reference-style sample must use an isolated configuration to show all seven rows, not overwrite global preferences.
