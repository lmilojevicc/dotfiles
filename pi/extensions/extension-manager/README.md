# Extension manager

`/extensions` opens a menu for enabling and disabling global Pi extensions without deleting their files or uninstalling their packages.

1. Run `/extensions`.
2. Select extension rows to stage one or more toggles.
3. Select **Apply changes and reload**.

The menu includes extensions auto-discovered under `~/.pi/agent/extensions/` and extensions supplied by globally installed Pi packages. It writes Pi's native resource filters to `~/.pi/agent/settings.json` through `SettingsManager`, then reloads the current runtime so the changes take effect immediately. Existing unrelated resource patterns and package filters for skills, prompts, and themes are preserved.

The manager marks itself as required and cannot disable itself. This keeps `/extensions` available for re-enabling anything previously disabled. Press Escape or select **Cancel** to discard staged changes.

Pi does not apply package resource filters when a package source points directly to a local file. The menu marks those rows unavailable and will not pretend to save a toggle; configure the source as a directory package if it needs per-extension filtering.

Project-local resources and project override settings are deliberately outside this command's scope. Use `pi config -l` for those.

## Tests

```sh
npm --prefix pi/extensions/extension-manager test
```
