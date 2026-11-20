# opencode-fff

[FFF](https://github.com/dmtrKovalenko/fff) file and content search for OpenCode, as native
tools. It's the OpenCode counterpart of [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff),
which Pi uses. FFF has no OpenCode plugin of its own.

| Tool | What it does |
| --- | --- |
| `ffgrep` | Content search. Smart-case, regex auto-detected, frecency-ranked, git-aware, with context lines and cursor pagination. `literal: true` searches exact text. A regex with no match is retried as literal text; a plain pattern with no exact match falls back to fuzzy. |
| `fffind` | Fuzzy path search and glob search over the whole repo-relative path. An empty or `*` pattern with a path lists exactly that path. Pages come from one saved result, so paging returns every match once. Weak scattered matches are trimmed to a sample. |

Compared with the `fff-mcp` MCP server, these run in-process on one FFF index of the workspace,
sit on the provider's native tool list (`codemode: false`, like the built-in `grep`), and go
through OpenCode's permissions:

- `ffgrep` asks for `grep` on the pattern, and `fffind` asks for `glob`, the
  same checks the built-in `grep` and `glob` make. Like the built-ins, results are not filtered
  per file against `read` rules.
- A `path` outside the workspace (absolute, `~/…`, `../…`) is searched with its own index, after
  an `external_directory` request for that directory.
- `opencode-secrets` treats these tools as read-only, like `grep` and `glob`: placeholders are not
  restored in their inputs, and their results are scrubbed.

Frecency and query history are shared with fff.nvim when its databases exist
(`~/.cache/nvim/fff_nvim`, `~/.local/share/nvim/fff_queries`), the same lookup pi-fff uses.
Otherwise they live in `~/.local/share/opencode/fff/`.

## Install

```sh
cd opencode/plugins/opencode-fff && bun install
```

`node_modules/` is not tracked. Each machine installs `@ff-labs/fff-bun`, which brings the native
FFF library for its platform. Without it OpenCode cannot load the plugin, and loads it after
installation on its next reload.

```jsonc
"plugins": [{ "package": "./plugins/opencode-fff" }]
```

Options: `enabled`, `enableHomeDirScanning` (default `true`),
`enableFsRootScanning` (default `false`), `followSymlinks` (default `true`), `frecencyDb`,
`historyDb`.

## Layout

- `index.ts`: OpenCode wiring (tool registration, permissions, options).
- `tools.ts`: the tools, ported from pi-fff with Pi-only parts removed (TUI rendering,
  `@` autocomplete, modes) and without its multi-pattern grep.
- `fff/`: helpers vendored from pi-fff 0.11.0 (MIT); each file's header says what changed.

## Test

```sh
bun test tests/
```

The tests use a temporary workspace and temporary databases.
