# Chadineer

Chadineer is an opt-in Pi extension that adds concise development guidelines to the system prompt for the current session branch.

## Usage

- `/chadineer` toggles the guidelines.
- `/chadineer on` and `/chadineer off` set the state idempotently.
- `/chadineer status` reports the current state.

New sessions start with Chadineer off. State changes are stored in Pi session history and restored independently for each active branch. While enabled, the footer shows `chadineer`.

The prompt is bundled in the extension and appended during `before_agent_start`, so other extensions' earlier system-prompt changes are preserved. No prompt text is added to conversation history.

## Test

```sh
npm test
```

Pi discovers this package through the `~/.pi/agent/extensions` symlink. Restart Pi after adding the package or changing its entry point.
