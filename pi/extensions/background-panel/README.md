# background-panel

One place for everything running in the background, after OpenCode v2's composer. It is a private dotfiles plugin: the bridges read other packages' internals, which is why it does not ship as a public package.

- A status, `↓ 1 workflow · 3 subagents · 1 shell`, counts what runs. It is published as Pi's native `background-jobs` status key; [zentui-status-bridge](../zentui-status-bridge) can move it into the zentui editor border (`$jobs` in `pi/zentui.json`, and it is in that extension's `include` there).
- The open key (default **↓**) on an empty, focused editor opens the panel in the editor's place: tabs on top (Subagents, Shell, Terminals), up to five rows, key hints below.
  - **↑/↓** move between rows; ↑ on the first row closes the panel, like **Esc**.
  - **←/→** switch tabs.
  - **Enter** opens the selected job's output in a bordered overlay: it follows new output until you scroll (**↑/↓**, **PgUp/PgDn**, **Home**), **End** follows again, **Esc** goes back to the panel. A subagent's output is its own Pi session rendered as markdown (task, thinking, tool calls with short results, the answer), like the main session.
  - On the Terminals tab, **Enter** attaches instead: the panel closes and pi-interactive-shell's own interactive overlay opens (`/attach <id>` — sent when the agent is idle, otherwise placed in the editor with a notice), so you can type into the terminal, for example a password a command is waiting for. **Ctrl+O** shows its screen read-only.
  - **Ctrl+D** kills a shell or stops a subagent; **Ctrl+A** switches between running and finished jobs.
- Jobs with a `parentId` are listed under their parent: multi-step runs render as a header row (`Workflow: <name>`, `Chain: a → b`, `Parallel: a, b, c +N`, badge `Running · done/total`) with `├─`/`└─` children in run order. The count line shows running parents as workflows and running leaves with the tab's noun.
- TUI only; in RPC (BB), print and JSON modes it does nothing. Loading the extension enables it — there is no `enabled` flag.

## Config file

Optional JSON file `background-panel.json` in the agent dir (`~/.pi/agent/background-panel.json`), or a path in `PI_BACKGROUND_PANEL_CONFIG`. All fields are optional; a missing file means defaults, an invalid file means defaults with one warning. The file is read once, when the first session starts.

```json
{
	"openKey": "down",
	"tabOrder": {},
	"bridges": { "piSubagents": true, "piInteractiveShell": true },
	"hideNativeWidgets": true
}
```

- `openKey` (`down`, `up`, or `ctrl+j`; default `down`): the key that opens the panel when the editor is empty, focused, and jobs exist. Other keys always stay with the editor.
- `tabOrder`: per-tab order overrides by tab id; a tab without an entry keeps its provider's `order` (default 100).
- `bridges` (default both `true`): whether the built-in bridges below may publish their tabs. A bridge whose package is not loaded publishes nothing, so no empty tab appears.
- `hideNativeWidgets` (default `true`): remove widgets the panel replaces — pi-interactive-shell's `bg-sessions` background session list. They return when their extension reinstalls them and the panel is gone.

## Sources

| Tab       | Source                                                                                         | How                                                                                                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subagents | [pi-subagents](https://github.com/nicobailon/pi-subagents) async runs                          | Bridge: its `subagents:rpc:v1` `status` RPC lists the session's runs; titles from each run's `status.json`, output from each step's `sessionFile` as markdown (`output-<step>.log` without one); `stop` over the same RPC. |
| Shell     | [bash-improved](../bash-improved) background tasks                                             | Provider: bash-improved publishes its tasks with the protocol below over the `background-jobs:v1` events.                                                                                                                  |
| Terminals | [pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) background sessions | Bridge: its session manager on `globalThis`; Enter runs its `/attach <id>`.                                                                                                                                                |

A tab appears only when its source is loaded. Foreground (blocking) subagent runs are not listed; pi-subagents runs them async by default here (`fleetView`/`asyncWidget` are `false` in `pi/subagent.json`, otherwise pi-subagents also claims ↓).

The panel does not replace pi-interactive-shell's interactive overlay: a session the agent starts in interactive mode opens it as before, with keyboard focus. The panel lists the sessions that run in the background and attaches to them.

## Built-in bridges

Two bridges ship with the panel so it is useful the moment it loads. Each is a normal provider of the protocol below and doubles as a reference implementation for other authors (see `bridges/`). Both are gated by the config file's `bridges` fields and poll their package about once a second only while the panel's session runs; a bridge whose package is not loaded publishes nothing.

Both bridges read package internals — the RPC channel, the runs-directory layout, the `globalThis` manager key, `/attach` — which their packages do not guarantee as APIs. That is why they live here as opt-in bridges rather than in a public package: the recommended integration for any other package is to publish the protocol itself, as in the example below.

## background-jobs protocol (v1)

Any extension can add a tab. Everything goes over `pi.events` in one process, as plain data. The types are in [`protocol.ts`](protocol.ts); copy the event names instead of importing the file, as [bash-improved](../bash-improved/background-jobs.ts) does.

| Event                             | Direction        | Payload                                                                                                                           |
| --------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `background-jobs:v1:capability`   | probe / announce | `{ supported, active, version? }`: ask whether the panel listens; it answers in place and re-announces here when a session starts |
| `background-jobs:v1:snapshot`     | provider → panel | a snapshot, or `{ version, source, remove: true }` to withdraw                                                                    |
| `background-jobs:v1:action`       | panel → provider | `{ version, requestId, source, jobId, action }`                                                                                   |
| `background-jobs:v1:action-reply` | provider → panel | `{ requestId, ok, error?, output? }`                                                                                              |

Probe the capability before relying on the panel; it answers in place and announces on the same channel when a session starts, so providers republish:

```ts
const capability = { supported: false, active: false };
pi.events.emit("background-jobs:v1:capability", capability);
// The panel fills in: { supported: true, active, version: 1 }

if (capability.active) {
	pi.events.emit("background-jobs:v1:snapshot", {
		version: 1,
		source: "bash-improved",
		tab: { id: "shell", label: "Shell", noun: ["shell", "shells"], order: 20 },
		jobs: [
			{
				id: "1",
				title: "npm run dev",
				status: "running",
				startedAt: Date.now(),
				actions: { stop: "kill", output: true },
			},
		],
	});
}

// The list changed: send the full snapshot again.
// Remove the source on shutdown, or send a snapshot with jobs: [].
pi.events.emit("background-jobs:v1:snapshot", {
	version: 1,
	source: "bash-improved",
	remove: true,
});
```

`status` is one of `running`, `done`, `failed`, `stopped`; `badge` replaces the status text on the row (such as `Running · 1/3`). A job with `parentId` (same source) is drawn under its parent, siblings sorted by `order` then `startedAt`. `actions` declares what the panel offers: `stop` and `open` carry the key-hint labels, and `output: true` enables read-only output. Providers with the same `tab.id` share one tab.

The panel sends actions back on `background-jobs:v1:action`; answer on `background-jobs:v1:action-reply` with the same `requestId`, or the panel reports an error after three seconds:

```ts
pi.events.on("background-jobs:v1:action", (raw) => {
	const request = raw as {
		version: 1;
		requestId: string;
		source: string;
		jobId: string;
		action: "stop" | "open" | "output";
	};
	pi.events.emit("background-jobs:v1:action-reply", {
		requestId: request.requestId,
		ok: true,
		// For "output" only:
		output: { heading: "$ npm run dev", text: "listening on :3000" },
		// or format: "markdown" to render like an assistant message.
	});
});
```

`open` runs after the panel has closed and the editor is back — use it to attach the user to the job's own UI (an interactive terminal overlay); the panel never replaces it. The `output` action is polled once per second while the output view is open.

Every field is validated and bounded: ids (`source`, `tab.id`, job `id`, `parentId`) up to 64 UTF-16 code units; titles and labels (job title, tab label, noun forms, badge, action labels, output heading, reply error) up to 512; output text up to 256 KiB; at most 200 jobs per snapshot, 32 sources, and a two-entry noun pair up to 64 code units each. Times are epoch milliseconds; `order` is an integer. A message that breaks a bound, has a duplicate job id, or targets another version is ignored whole rather than partially applied. Snapshots sent outside a TUI session are ignored, not retained: providers should watch the capability channel and republish when the panel announces. Session replacement and shutdown drop published state; providers own their refresh and removal.
