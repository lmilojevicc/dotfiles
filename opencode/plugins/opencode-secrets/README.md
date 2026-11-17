# opencode-secrets

pi-secrets-parity secret firewall for OpenCode (v2, server plugin). One
self-contained file, no dependencies.

Real secrets never reach the model or the transcript: registered values
become reversible `$$[LABEL_]12CHARS$$` placeholders in prompts, outgoing
model messages (including assistant thinking and tool arguments), and tool
results — including error-path results — and are restored into tool inputs
right before execution, so edits and shell commands work on real bytes.

- Learn-on-first-sight captures credential-shaped values (vendor tokens,
  credential-named assignments, URL passwords), labels them
  self-documentingly (`SLACKTOKEN`, `GITHUBTOKEN`, `MYAPIKEY`, …), and
  persists them so placeholders restore across sessions.
- One-way `replace` mode redacts permanently: same-length deterministic
  scrambled rewrite, no restore entry.
- Dump-style views (`xxd`, `base64`, `od -c`, hex rows) are decoded and
  scrubbed, so secrets shown through them are caught.

## Quick start

1. Enable in `~/.config/opencode/opencode.jsonc`:

   ```jsonc
   { "plugins": [{ "package": "./plugins/opencode-secrets", "options": { "enabled": true } }] }
   ```

2. Create the registry at `~/.config/opencode/opencode-secrets.json`
   (user-maintained, never tracked):

   ```jsonc
   {
     "$schema": "./plugins/opencode-secrets/registry.schema.json",
     "entries": [
       { "friendlyName": "GITHUB_TOKEN", "value": "ghp_..." }
     ]
   }
   ```

   The `$schema` pointer gives editors validation and is ignored by the
   plugin. Run `opencode reload` once after enabling; registry edits
   afterwards hot-reload (mtime check before every scrub batch).

3. Optional: pi-style implicit env scan via an `envScan` block — see
   [`docs/registry.md`](docs/registry.md).

## Files

| Path | Purpose |
| --- | --- |
| `~/.config/opencode/opencode-secrets.json` | Registry (user-maintained, never tracked) |
| `~/.local/share/opencode/opencode-secrets-learned.json` | Auto-learned values (0600); delete entries to forget |
| `~/.local/share/opencode/opencode-secrets.key` | HMAC key for placeholder hashes (0600); never edit |

## Docs

- [`docs/registry.md`](docs/registry.md) — full registry schema, entry
  fields, `envScan`, editor validation, hot reload
- [`docs/behavior.md`](docs/behavior.md) — placeholder format, built-in
  patterns, learn gates, dump-view decoding, persistence and forgetting,
  known limits

Off by default: remove the entry or set `"enabled": false` and `/reload`.
