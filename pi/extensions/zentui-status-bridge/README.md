# Zentui status bridge

Re-publishes Pi's `ctx.ui.setStatus()` extension statuses as [Zentui](https://github.com/lmilojevicc/pi-zentui) custom values, so any extension's status can render in the Minimalist editor border (for example bottom-right, before `$cwd`) instead of the footer.

Zentui's custom-value protocol (`zentui:variable`) and `setStatus` are separate surfaces: Zentui's own docs say *custom values do not automatically consume `ctx.ui.setStatus()`*. This extension is the missing adapter, and it is package-agnostic — it bridges whatever keys are configured, not just pi-lens.

## What it does

1. Wraps `ui.setStatus` on `session_start` and again on `before_agent_start`, `agent_end`.
2. For every bridged key it probes `zentui:variable-capability` (protocol v1) and, when Zentui is present and a template demands the key, emits `zentui:variable` with the same text.
3. On success it removes the host copy by forwarding `undefined`, so the value renders once — in the border, not the footer. Without Zentui (or with demand switched off) the status passes through unchanged.
4. `session_shutdown` removes every value it published.

The tap must sit *outside* Zentui's own `setStatus` wrapper, which hides keys by `extensionStatuses.visibility`. Zentui installs that wrapper on `session_start`; `before_agent_start` is the first event guaranteed to run after it, which is why the tap is re-asserted there. A tap that has been wrapped from the outside is re-installed on the next event and bridges only once (a depth guard stops the inner tap from publishing again).

## Configuration

`~/.pi/agent/zentui-status-bridge.json` (repository: `pi/zentui-status-bridge.json`), read on `session_start` and by `/status-bridge`. A missing file bridges every key with the defaults; the file is never created or repaired. Keys starting with `_` are inert.

| Key | Default | Meaning |
| --- | --- | --- |
| `include` | `[]` | Status keys to bridge. Empty means every key any extension publishes. |
| `exclude` | `[]` | Keys kept on the footer even when included. |
| `keyPrefix` | `""` | Prefix for the published Zentui key (for example `"status/"`). Prefix plus key must stay within 64 characters. |
| `suppressHostStatus` | `true` | Remove the footer copy once Zentui accepted the value. |
| `maxTextLength` | `256` | Truncate longer text, because Zentui drops a value above 256 UTF-16 code units instead of clipping it. |

An invalid field is reported once and reset to its default; valid fields survive. A key whose prefixed name would exceed 64 characters keeps its footer copy.

## Zentui wiring

Published keys are plain Zentui custom values, so they work with `$extensions` or through an alias:

```json
{
	"components": {
		"editor": {
			"styles": {
				"minimalist": {
					"variables": { "lens": "pi-lens-lsp" },
					"formats": {
						"topRight": "$cost$sep$model$sep$thinking$sep$context($sep$cache_hit)",
						"bottomRight": "$lens$join_sep($cwd)"
					}
				}
			}
		}
	}
}
```

- `variables` maps a local template name to a bridged key. An aliased key is excluded from the `$extensions` aggregate, so it renders once.
- `$join_sep(...)` drops the whole group when the bridge has no value, leaving a bare `$cwd`.
- The generated `topRight` default already contains `$extensions`. Override it if you do not want every bridged key there.
- Do not hide a bridged key with `components.extensionStatuses.visibility`: the bridge removes the footer copy itself, and a hidden key is invisible to it if load order ever puts the tap inside Zentui's wrapper.

`/status-bridge` prints the config path, effective settings, whether the tap is installed, and the keys it currently publishes.

## Limits

- **Only `setStatus` data is bridged.** A widget (`ui.setWidget`) is a different surface; pi-lens's diagnostics widget with its per-file rows and totals stays where it is. Zentui cannot adopt widget content.
- **Statuses published during an earlier extension's `session_start` can be missed** — the tap may not be installed yet, and Zentui may already have hidden them. The next publication of that key is bridged. In practice that is the first turn boundary for pi-lens.
- **TUI only.** In `rpc`/`print`/`json` modes there is no Zentui editor, so nothing is bridged.
- Text keeps its publisher's styling under Zentui's `original` color mode; `zentui` color mode strips it and applies the editor's extension-status color.
- A status that is very wide will yield in the border before the editor's own metadata, like any other custom value.

## Tests

From this directory:

```sh
npm test
```
