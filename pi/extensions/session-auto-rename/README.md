# Session Auto Rename

A Pi extension that names a genuinely new session from its first prompt. A session is eligible only when it has no existing name and its branch has no earlier user message. Title generation starts in the background, so it does not delay the main agent request.

## Model selection

In TUI mode, open the authenticated-model picker with:

```text
/session-auto-rename
```

The picker refreshes available models and searches their full `provider/model` IDs and display names. To select directly (and in non-TUI modes), run:

```text
/session-auto-rename provider/model
```

Only authenticated, currently available models can be selected. With no saved configuration, the active model is used when it is available.

The selection is stored with mode `0600` at `$PI_CODING_AGENT_DIR/session-auto-rename.json` (normally `~/.pi/agent/session-auto-rename.json`):

```json
{
  "model": "provider/model"
}
```

After installing or reloading extension changes, run `/reload` and then `/new`; auto-rename applies only to the first prompt of a new `/new` session, not the current session.

## Behavior and privacy

The first prompt is sent to the selected model in a separate background completion. It uses no tools, disables cache retention, uses a fresh session ID, allows no retries, and is bounded to 10 seconds and 64 output tokens. The model provider still receives that prompt, so its privacy terms apply.

The generated name uses the first nonblank output line, removes reasoning blocks, unsafe controls, and matching outer quotes, and is limited to 50 Unicode code points (longer names end in `...`). An existing or manually assigned name is never overwritten. Pending results are aborted or ignored when a manual name appears, the session changes, or the session shuts down, preventing stale completions from renaming another session.

## Test

```sh
npm test
```
