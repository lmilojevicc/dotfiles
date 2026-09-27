# Extension manager

`/extensions-manager` opens a menu for enabling and disabling global Pi extensions without deleting their files or uninstalling their packages.

1. Run `/extensions-manager`.
2. Type to search by extension source or path. Use Pi's configured selection keys (normally Up/Down and Page Up/Page Down) to navigate.
3. Press Enter on an extension to stage a toggle. Space also toggles while the search field is empty.
4. Select **Apply changes and reload**.

The menu includes extensions auto-discovered under `~/.pi/agent/extensions/` and extensions supplied by globally installed Pi packages. It writes Pi's native resource filters to `~/.pi/agent/settings.json` through `SettingsManager`, then reloads the current runtime so the changes take effect immediately. Existing unrelated resource patterns and package filters for skills, prompts, and themes are preserved.

The list stays compact as the terminal changes size and shows exact `↑ N more` / `↓ N more` counts for matching extensions outside the viewport. Filtering does not discard staged toggles.

The manager marks itself as required and cannot disable itself. This keeps `/extensions-manager` available for re-enabling anything previously disabled. Press Escape (or the configured cancel binding) or select **Cancel** to discard staged changes.

Pi does not apply package resource filters when a package source points directly to a local file. The menu marks those rows unavailable and will not pretend to save a toggle; configure the source as a directory package if it needs per-extension filtering.

Project-local resources and project override settings are deliberately outside this command's scope. Use `pi config -l` for those.

## Tests

```sh
npm --prefix pi/extensions/extension-manager test
```
