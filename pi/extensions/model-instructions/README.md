# Model instructions

Adds model-specific instructions to Pi's system prompt as one owned
`model_instructions` section, alongside the shared `APPEND_SYSTEM.md`. No tools,
commands, banners, or persistent chat messages. Because it sets a named section
instead of returning `systemPrompt`, sections other extensions add to the same run
(bash-jobs' `background_jobs`, for example) survive.

## Configuration

Edit [`instructions.json`](instructions.json) beside this extension. In these
dotfiles that is `pi/extensions/model-instructions/instructions.json`, also
reachable through `~/.pi/agent/extensions/model-instructions/instructions.json`.

```json
{
  "models": {
    "gpt-6-astra": [
      "Keep UI/TUI copy minimal; omit redundant explanations."
    ],
    "openai-codex/gpt-6-astra": [
      "Use concise UI/TUI labels. Preserve essential warnings and accessible names."
    ]
  }
}
```

- Keys match exact, case-sensitive model IDs or `provider/modelId`, not display
  names, globs, or thinking-level suffixes. Use the IDs from Pi's model picker.
- A `provider/modelId` entry **replaces** the model-ID entry; they do not stack.
  An empty array disables instructions for that entry.
- Model IDs containing `/` work too: `vendor/model` matches that model ID across
  providers; `router/vendor/model` specializes it for provider `router`.
- Values must be arrays of non-empty strings. Each becomes a bullet, in order.
  Use `\n` within a string for multiple lines. The only top-level field is `models`.
- The bundled rule targets Astra's excess UI/TUI copy. Add other models as needed.

Pi auto-discovers `index.ts` through the existing extensions-directory symlink.
Run `/reload` once after installing the extension (or restart Pi). JSON edits are
read at the next `before_agent_start`; no reload is needed for rule changes.
Selecting a different model takes effect on the next agent run. Instructions are
not persisted in conversation history or accumulated across runs.

Missing config means no additional instructions, and the section is removed. Invalid
or unreadable config skips all rules for that run and reports the error once until it
changes or recovers: a UI warning plus stderr on every host that is not the TUI (RPC
hosts such as BB accept the notification and drop it), stderr alone when headless. It
never overwrites your JSON or silently reuses old rules.

## Limits

This is prompt guidance, not behavioral enforcement or a security boundary.
It does not rewrite replies, truncate output, or alter provider payloads. Earlier
prompt content is preserved; later extensions can still modify the prompt.
Changes during an active run apply at the next run, not between its tool calls.
Nested model calls or child agents receive these rules only if their own runtime
loads this extension and fires `before_agent_start`; they are not intercepted.

## Tests

```sh
cd pi/extensions/model-instructions
npm test
```

Tests cover validation, matching/overrides, section composition and removal, model
switching, live config edits, missing/invalid files, and quiet/TUI/RPC/headless
diagnostics. A cross-extension session test in `pi/extensions/bash-jobs/tests` proves
the section survives alongside a later extension's section. They do not
assert that a live model will comply with the instructions.
