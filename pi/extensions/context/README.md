# Context usage command

Local port of [`/context` from pi-cc-extensions v0.9.5](https://github.com/minuque/pi-cc-extensions/blob/v0.9.5/extensions/feature/context.ts). See [LICENSE](LICENSE) for upstream MIT copyright and license. Only the command and the two small display/mouse helpers it uses are included; no other upstream UI features or configuration are installed.

`/context` shows an estimated breakdown of system prompt, memory, skills, tool definitions, tool results, conversation context, other usage, and free space. In the TUI, select a category with the arrow keys or mouse and press Enter/click to preview its contents; Esc closes each view. The interactive dialog is available only in the TUI. In other modes the command calls Pi's notification API, which some hosts do not display or serialize; do not rely on `/context` for non-TUI output. Category token counts are estimates based on content, reconciled with available context usage, not provider-reported per-category accounting.

Pi discovers `index.ts` through the extension directory symlink. Restart Pi after adding the extension. Run `npm test` in this directory to test the command and dialog without making a provider request.
