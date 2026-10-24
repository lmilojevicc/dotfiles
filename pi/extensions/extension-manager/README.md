# Extension manager

`/extensions-manager` opens a menu for enabling and disabling global Pi extensions without deleting their files or uninstalling their packages.

1. Run `/extensions-manager`.
2. Type to search by extension source or path. Use Pi's configured selection keys (normally Up/Down and Page Up/Page Down) to navigate.
3. Press Enter on an extension to stage a toggle. Space also toggles while the search field is empty.
4. In the TUI, press `ctrl+s` from any extension or search query to save immediately; the on-screen footer shows **ctrl+s Save** (abbreviated **^S Save** on narrow frames). Plain letters, including `s`, are always typed into the search field. In RPC, select **Save changes** (RPC selection does not accept arbitrary keypresses). On a usable menu `ctrl+s` saves even if confirm or cancel is remapped onto it; stale or resize-required frames still cannot save.

The menu includes extensions auto-discovered under `~/.pi/agent/extensions/` and extensions supplied by globally installed Pi packages. It writes Pi's native resource filters to `~/.pi/agent/settings.json` through `SettingsManager`. Reload Pi after saving for the changes to take effect; the current runtime is not reloaded automatically. Existing unrelated resource patterns and package filters for skills, prompts, and themes are preserved.

The list stays compact as the terminal changes size and shows exact `↑ N more` / `↓ N more` counts for matching extensions outside the viewport. Filtering does not discard staged toggles.

The manager marks itself as required and cannot disable itself. This keeps `/extensions-manager` available for re-enabling anything previously disabled. Escape (or the configured cancel binding) in the TUI, and **Cancel** or dismissing the selection in RPC, exit immediately when there are no net staged changes. Otherwise, cancellation asks before discarding (including when a disabled manager needs repair). The TUI prompt defaults to **Keep editing**; use the selection keys to choose **Discard changes** and confirm explicitly. Escape during the prompt keeps editing, preserving the search and staged toggles. RPC asks for confirmation; declining returns to the menu with the same staged changes. Toggling an extension back to its original state removes its pending change.

Pi does not apply package resource filters when a package source points directly to a local file. The menu marks those rows unavailable and will not pretend to save a toggle; configure the source as a directory package if it needs per-extension filtering.

Project-local resources and project override settings are deliberately outside this command's scope. Use `pi config -l` for those.

## Tests

```sh
npm --prefix pi/extensions/extension-manager test
```
