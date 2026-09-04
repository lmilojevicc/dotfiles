# Prefix Keybinds

A Pi extension that turns one prefix key into a configurable command layer.

## Commands

- `/prefix-keybinds` or `/prefix-keybinds show`: show mappings.
- `/prefix-keybinds config`: open the configuration wizard.
- `/prefix-keybinds actions`: list supported Pi and extension actions.
- `/prefix-keybinds prefix <key>`: set the prefix key.
- `/prefix-keybinds set <key> <action>`: add or update a mapping.
- `/prefix-keybinds unset <key>`: remove a mapping.
- `/prefix-keybinds reset`: restore defaults after confirmation.
- `/prefix-keybinds-config`: open the configuration wizard directly.

`?` is reserved for prefix help and cannot be assigned by the configuration command.

## Configuration

Configuration is merged in this precedence order (later files override earlier values and bindings):

1. Global: `~/.pi/agent/prefix-keybinds.json`
2. Project: `<cwd>/.pi/prefix-keybinds.json`
3. Environment override: `PI_PREFIX_KEYBINDS_CONFIG` (an absolute path, or a path relative to `<cwd>`)

The extension preserves its existing hardcoded `.pi` path behavior. Writes target the environment override when set, then an existing project file, then the last loaded file, otherwise the global file. Configuration supports `prefixKey`, `timeoutMs`, `showHelp`, `cancelKeys`, `replaceDefaults`, and `bindings`.

The default `m` mapping is `pi.model-picker`: browse providers/models, switch this session and save the global startup default. It uses the public `model-picker:open` Pi event with a synchronous acknowledgement callback, never editor submission, so drafts and expanded pastes survive streaming/compaction. An absent picker produces a warning without inserting a command or changing the draft. Other slash actions retain their existing submission behavior. Install the sibling [model-picker](../model-picker/README.md) extension. Native `/model` and `app.model.select` are unchanged; explicitly map `m` (or another key) to `app.model.select` to use the native selector instead. Global/project/environment overrides remain authoritative, including unsetting `m`.

Press the configured prefix to activate the layer, then press a mapped key. The layer cancels on a configured cancel key (default: Escape or Ctrl-C) or after `timeoutMs` (default: 2000 ms). Unknown second keys are consumed and reported. Press prefix then `?` for the help palette.

The editor wrapper is installed on a deferred timer after `session_start`, so editor/theme extensions can install first. It wraps the active editor factory, forwards ordinary input, and composes disposal with the original editor.

## Tests

The focused tests use Node's built-in test runner and local module stubs; they install no dependencies and make no network requests.

```sh
npm test
```
