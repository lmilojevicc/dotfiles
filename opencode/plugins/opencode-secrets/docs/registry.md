# Registry

The registry is the user-maintained list of secrets the plugin must protect.
It lives at `~/.config/opencode/opencode-secrets.json` (never tracked in git).
Override the path with the plugin option `{ "registry": "/path/to/file.json" }`.
Invalid entries are skipped with a console warning; a malformed registry is
never fatal.

## Full example

```jsonc
{
  // Optional: editor validation, ignored by the plugin
  "$schema": "./plugins/opencode-secrets/registry.schema.json",
  "entries": [
    // legacy form (still supported): plain obfuscate, label from "name"
    { "name": "GITHUB_TOKEN", "value": "ghp_..." },
    { "name": "OPENROUTER_KEY", "env": "OPENROUTER_API_KEY" },
    // explicit form
    { "friendlyName": "EMAIL_PERSONAL_1", "type": "plain", "mode": "obfuscate", "content": "..." },
    // one-way replace (never restored)
    { "type": "plain", "mode": "replace", "content": "internal-hostname" },
    // user regex patterns
    { "friendlyName": "CHAINSIG", "type": "regex", "content": "chain-internal-[a-z0-9]{24}", "mode": "obfuscate" },
    { "type": "regex", "content": "/chain-[a-z0-9]{24}/", "mode": "replace", "replacement": "[[SCRUBBED]]" }
  ],
  // optional; absent = no env scan
  "envScan": { "pattern": "(KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(_|$)", "minLength": 8 }
}
```

## Entry fields

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `type` | `plain` \| `regex` | `plain` | `plain`: `content`/`value` is a literal secret. `regex`: `content` is a pattern. |
| `mode` | `obfuscate` \| `replace` | `obfuscate` | `obfuscate`: reversible placeholder, restored into tool inputs. `replace`: one-way same-length rewrite, never restored. |
| `content` | string | — | The secret (`plain`) or pattern (`regex`). Regex entries also accept `/pattern/flags` literal form. Values under 6 characters are ignored. |
| `value` | string | — | Legacy alias for `content` (`plain` only). |
| `env` | string | — | Read the secret from this environment variable at store build time (`plain` only). |
| `friendlyName` | string | — | Label shown in the placeholder: `$$FRIENDLYNAME_12CHARS$$. Sanitized to `A-Z0-9`. |
| `name` | string | — | Legacy alias for `friendlyName`. |
| `replacement` | string | — | Fixed replacement text for `mode: "replace"` entries — regex **and** plain alike. Regex entries without one get a same-length scrambled rewrite that provably does not re-trigger the pattern. Plain-replace entries get no such re-match avoidance (the content is a literal, so it only matters if the replacement itself contains the content). |
| `flags` | string | — | RegExp flags for `type: "regex"` entries, e.g. `"i"`. Ignored for plain entries. |

Exactly one of `content` / `value` / `env` is required per entry. Unknown
entry fields are silently ignored by the plugin, but the JSON Schema marks
them as errors so editors catch typos.

## Editor validation (JSON Schema)

`registry.schema.json` next to the plugin entry point is a formal Draft-07
schema for this file. Point your registry at it:

```jsonc
{ "$schema": "./plugins/opencode-secrets/registry.schema.json", "entries": [ ... ] }
```

The `$schema` key is ignored by the plugin (unknown root keys are allowed),
and editors that resolve relative schema paths pick it up through the
`plugins` symlink. Validation catches: unknown/misspelled fields, entries
missing `content`/`value`/`env`, wrong enum values, and a malformed
`envScan`.

## Replicating pi's implicit env scan

By default only explicit `env:` entries are loaded. To scan the environment
the way pi does implicitly, add an `envScan` block: every env var whose name
matches `pattern` (case-insensitive, unanchored) and whose value is at least
`minLength` characters (default 8) is registered with the env var name as its
label. Include `(_|$)` in the pattern to enforce a word boundary — the
default pattern's suffix anchor is what keeps `AUTH` from matching `AUTHOR`
(and `KEY` from matching `MONKEY`). `envScan` also picks up connection-URL
passwords hidden inside env values (`scheme://user:pass@host`), including
URL-decoded variants.

## Hot reload

Registry edits apply without a server restart: the plugin stats the registry
(and learned file) before every scrub batch and rebuilds when the mtime/size
changed. No `/reload` needed for registry changes — only for enabling,
disabling, or upgrading the plugin itself.
