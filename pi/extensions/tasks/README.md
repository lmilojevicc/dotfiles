# Tasks for Pi

Private Pi 0.84.4 extension for session-branch-native task tracking.

- One model tool: `todo` (`create`, `update`, `batch`, `list`, `get`, `delete`, `clear`)
- Human commands: `/tasks` and `/todos` (alias), using Pi-native task and settings menus
- `/tasks-board`: open a live floating inspector; search/filter locally, inspect task details, and delete the selected task after confirmation
- `Ctrl+Shift+T`: toggle the above-editor widget between its configured limit and show-all
- Global Task Settings shared across projects in `<agent-dir>/tasks-config.json`
- Stable numeric IDs, optimistic revisions, one active task, validated dependency DAG, and atomic batches
- Tool-result snapshots for model changes and custom session entries for interactive changes
- Legacy `@juicesharp/rpiv-todo` snapshot replay

The board supports arrows or `j`/`k`, `Enter` for details on one-pane layouts, `Tab` between wide panes, `/` search, `f` filter, `c` local completed visibility, lowercase `d` for confirmed deletion, page keys for detail scrolling, and `Esc`/`q` to close. Search editing treats `d` as ordinary query text. It adapts from split panes at 96+ columns to compact one-pane layouts at 36+ columns. The board remains inspection-first; `/tasks` provides all other human task management.

The above-editor widget leaves one blank row after nonempty Tasks content so adjacent telemetry remains visually separate. The sole `in_progress` task uses the upstream 11-frame spinner at 150 ms. Its elapsed time and `↑`/`↓` counters are ephemeral, session-scoped presentation data. The counters are the parent assistant turn's full input/output usage attributed while that task is active; they are not execution or subagent telemetry. Activity starts fresh after reload, session/branch changes, or a different task starts, and is preserved across compaction only while the same task remains active.

### Global Task Settings

`/tasks` → Settings saves each choice immediately for all projects in `<getAgentDir()>/tasks-config.json` (normally `~/.pi/agent/tasks-config.json`; respects `PI_CODING_AGENT_DIR`). Display settings keep the existing JSON format: `collapseCompleted`, `showAll`, `maxVisible`, `sortOrder`, `hiddenAt`, and JSON-only `glyphs`. Defaults are completed tasks expanded, show-all off, 10 visible tasks, ID sort, hidden tasks at the bottom, and built-in glyphs. Unknown global keys are retained.

Legacy project `.pi/tasks-config.json` files are ignored, left untouched, and not automatically imported. A symlinked agent directory is supported, but the config file itself must be a regular file, not a symlink. Missing or invalid global settings fall back to defaults; saving refuses malformed, unreadable, or unsafe existing files rather than overwriting them.

Successful menu changes apply to the current session immediately. Other running sessions pick them up on their next session start (including new/resume/fork) or `/reload`, not through live synchronization. Escape closes the menu without undoing saved choices. `Ctrl+Shift+T` and the board's search/filter/completed-visibility controls remain temporary views, not global settings. Task truth remains exclusively in session branches.

This extension tracks work only. Owner and metadata are inert. It does not launch agents or processes, expose upstream execution tools, cascade tasks, auto-clear tasks, or store task truth in config files.

Persisted fields are rejected rather than truncated when they exceed these limits: subject 500 characters, description 20,000 characters, active form 500 characters, owner 200 characters, and metadata 50 total keys, depth 8, or 64 KiB of serialized JSON.

The widget/menu/settings presentation is adapted under MIT from `@tintinweb/pi-tasks` 0.9.0 at commit `29180d72498bdd77d5601dc77a9093d25da42102`. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Development

```sh
npm install
npm test
npm run typecheck
pi --no-extensions -e "$PWD/index.ts" --no-session --offline -p "Reply with OK"
```

The interactive manager requires TUI mode. Persistent animation should be checked manually in Pi at 80, 40, 20, 5, and 1 columns.
