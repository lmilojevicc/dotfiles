# Tasks for Pi

Private Pi 0.84.4 extension for session-branch-native task tracking.

- One model tool: `todo` (`create`, `update`, `batch`, `list`, `get`, `delete`, `clear`)
- Human commands: `/tasks` and `/todos` (alias), using Pi-native task and settings menus
- `/tasks-board`: open a live, read-only floating inspector; search/filter locally and inspect task details without changing task truth or display settings
- `Ctrl+Shift+T`: toggle the above-editor widget between its configured limit and show-all
- Upstream-compatible display settings in global `<agent-dir>/tasks-config.json` and project `.pi/tasks-config.json`
- Stable numeric IDs, optimistic revisions, one active task, validated dependency DAG, and atomic batches
- Tool-result snapshots for model changes and custom session entries for interactive changes
- Legacy `@juicesharp/rpiv-todo` snapshot replay

The board supports arrows or `j`/`k`, `Enter` for details on one-pane layouts, `Tab` between wide panes, `/` search, `f` filter, `c` local completed visibility, page keys for detail scrolling, and `Esc`/`q` to close. It adapts from split panes at 96+ columns to compact one-pane layouts at 36+ columns. `/tasks` remains the management surface.

The above-editor widget leaves one blank row after nonempty Tasks content so adjacent telemetry remains visually separate. The sole `in_progress` task uses the upstream 11-frame spinner at 150 ms. Its elapsed time and `↑`/`↓` counters are ephemeral, session-scoped presentation data. The counters are the parent assistant turn's full input/output usage attributed while that task is active; they are not execution or subagent telemetry. Activity starts fresh after reload, session/branch changes, or a different task starts, and is preserved across compaction only while the same task remains active.

Display settings are `collapseCompleted`, `showAll`, `maxVisible`, `sortOrder`, `hiddenAt`, and `glyphs`. Project settings override global settings; glyph entries merge individually. Task truth remains exclusively in session branches.

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
