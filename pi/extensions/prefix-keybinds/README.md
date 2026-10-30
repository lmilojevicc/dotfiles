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

Keys are validated before they are saved and when a config file is read: a value Pi's key matcher cannot report (a typo such as `ctrl_+x`, or a bare word such as `foo`) is reported and ignored instead of disarming the layer. An action id given to `/prefix-keybinds set` must be a supported action; a mistyped one is reported with the closest matches instead of opening the action picker.

## Configuration

Configuration is merged in this precedence order (later files override earlier values and bindings):

1. Global: `~/.pi/agent/prefix-keybinds.json`
2. Project: `<cwd>/.pi/prefix-keybinds.json`
3. Environment override: `PI_PREFIX_KEYBINDS_CONFIG` (an absolute path, or a path relative to `<cwd>`)

The extension preserves its existing hardcoded `.pi` path behavior. Writes target the environment override when set, then an existing project file, then the last loaded file, otherwise the global file. Configuration supports `prefixKey`, `timeoutMs`, `showHelp`, `cancelKeys`, `replaceDefaults`, and `bindings`.

A command writes only what it changed into that one file: `prefix <key>` sets `prefixKey`, `set <key> <action>` adds that binding, and `unset <key>` writes `"<key>": false` so the binding is removed from the merge even when a default or a lower-precedence file defines it. Other keys in the target file, and every other config file, keep working — editing or deleting a binding in `~/.pi/agent/prefix-keybinds.json` stays authoritative for the keys the project file does not mention. `/prefix-keybinds reset` is the exception: it replaces the layer with the defaults, so it writes the complete default binding map together with `replaceDefaults: true`.

The config files are re-read when one of them changes (a stat signature is checked per key press), so edits apply without restarting Pi.

The default bindings are `m` (model picker), `r` (reload), `n` / `l` / `g` / `f` (session new, resume, tree, fork), `e` (external editor), `o` (tool output), `t` (thinking blocks) and `c` (copy). Because the layer owns `ctrl+x`, Pi's native `app.message.copy` shortcut is unreachable while it is installed; `c` maps the same action one key deeper, and `app.thinking.save` (`ctrl+s` natively) can be mapped the same way. Pi has no `/peek` command, so the layer offers no peek action: an unbound key after the prefix is reported instead of being submitted to the model.

The default `m` mapping is `pi.model-picker`: browse providers/models, switch this session and save the global startup default. It uses the public `model-picker:open` Pi event with a synchronous acknowledgement callback, never editor submission, so drafts and expanded pastes survive streaming/compaction. An absent picker produces a warning without inserting a command or changing the draft. Install the sibling [model-picker](../model-picker/README.md) extension. Native `/model` and `app.model.select` are unchanged; explicitly map `m` (or another key) to `app.model.select` to use the native selector instead. Global/project/environment overrides remain authoritative, including unsetting `m`. `/reload` is the only remaining slash action and keeps its existing submission behavior.

Press the configured prefix to activate the layer, then press a mapped key. The layer cancels on a configured cancel key (default: Escape or Ctrl-C) or after `timeoutMs` (default: 2000 ms). Unknown second keys are consumed and reported. Press prefix then `?` for the help palette.

The editor wrapper is installed on a deferred timer after `session_start`, so editor/theme extensions can install first. It wraps the active editor factory, forwards ordinary input, and composes disposal with the original editor. `session_shutdown` disarms a layer left active, because Pi replaces the patched editor without disposing it.

## Tests

The focused tests use Node's built-in test runner and local module stubs; they install no dependencies and make no network requests.

```sh
npm test
```
