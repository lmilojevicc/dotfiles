# auto-compact

Compacts at a **percentage of the active model's context window** instead of a fixed token count,
and does it **without stopping the agent**.

Once usage reaches `thresholdPercent`, the summary is generated in the background with Pi's own
compaction prompt while the agent keeps calling tools. When the summary is ready it is attached at
the next turn boundary as a normal compaction entry. Everything after Pi's usual cut point is kept,
including the work done while the summary was being written. Nothing is aborted or retried.

| Situation | What happens |
| --- | --- |
| Summary ready mid-run | Attached at the next `turn_end`; the next request uses the compacted context |
| Summary ready after the run ended | Applied while idle (no second summary call) |
| Pi's own threshold (`window − compaction.reserveTokens`) fires first | Pi waits for the summary in flight and uses it instead of summarizing again |
| `/compact`, overflow recovery, `/tree` to another branch | The background summary is dropped; Pi does its own |
| Summary fails | Warning; retries only after usage grows another 5% of the window |
| Usage is still above the threshold after compacting | No new summary until usage grows another 5% of the window |

Pi's built-in compaction stays on as the hard backstop. `compaction.keepRecentTokens` (and its
`modelOverrides`) in Pi's `settings.json` still decide how much recent context is kept verbatim.

## Config

`PI_AUTO_COMPACT_CONFIG`, otherwise `<agentDir>/auto-compact.json` (`pi/auto-compact.json` in this
repo). A missing file uses the defaults; an invalid one disables the extension with a warning until
it is fixed. The file is re-read on every check, so edits apply without `/reload`.

```json
{
  "enabled": true,
  "thresholdPercent": 80,
  "models": {
    "opencode-go/deepseek-v4.1-flash": { "thresholdPercent": 50 },
    "deepseek-v4.1-flash": { "thresholdPercent": 60 },
    "faux/test": { "enabled": false }
  }
}
```

- `thresholdPercent`: greater than 0 and less than 100. The default is 80.
- `models` keys: an exact `provider/modelId` wins over a bare `modelId`, which matches every
  provider. Omitted fields fall back to the global value; a global `"enabled": false` wins.

## Zentui

Through Zentui's public event-bus protocols (probed before every publish):

| Key | Where | Shows |
| --- | --- | --- |
| `auto-compact:context` | custom value, alias `$ac_context` | `62%/800k`: usage against the point where compaction actually happens. That point is the threshold when auto-compact is on, otherwise Pi's backstop (`984k` for a 1M window), otherwise the raw window. Same format and 70/90 colour tiers as Minimalist's `$context`, with the tiers read from `zentui.json`. It can pass 100% while a summary is still being written. |
| `auto-compact:compaction` | Working-line segment | `compacting 27k in background` during the run, then `compacted 41k` until it settles |

`pi/zentui.json` uses `$ac_context` in the Minimalist `topRight` slot in place of
`$context`. Without this extension loaded that slot is empty. It updates on message and tool
boundaries rather than with every streamed token. Compaction progress is shown only on the Working line. When that
line is not showing (between runs, or without Zentui), Pi's `auto-compact` status shows it instead.

## BB

BB loads this extension too (`pi/bb/settings.json`), with the same `auto-compact.json`. BB's own
context meter still shows the raw model window, because BB's Pi provider reports Pi's
`getContextUsage()` and its UI ignores the snapshot's `autoCompactAtTokens`.

## Commands

- `/auto-compact` shows the config, the threshold for the current model, usage, Pi's backstop and
  the background summary state.
- `/auto-compact now` starts a background summary immediately, ignoring the threshold.

While a summary is pending, the `auto-compact` status reads `auto-compact: summarizing…`.

## Implementation notes

- `prepareCompaction` is not exported by Pi, so it is loaded from the running install
  (`dist/core/compaction/compaction.js` under `getPackageDir()`). If that fails (for example in a
  Bun binary build), the extension warns once and stays inactive; Pi's own compaction still works.
- `ctx.compact()` aborts the running turn, so the extension does not use it mid-run. It only uses
  it while idle, to apply a summary that is already finished.
- Compactions attached at a boundary are stored with `fromHook: true`, so Pi's next default
  compaction does not merge their file lists. The lists are still part of the summary text.

## Test

```sh
npm test
```
