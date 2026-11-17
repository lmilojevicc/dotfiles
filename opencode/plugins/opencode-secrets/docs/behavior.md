# Behavior

## Placeholder format (v2)

Placeholders are `$$[LABEL_]12CHARS$$` where `12CHARS` is 12 characters from
an `A-Z0-9` alphabet encoding the first 8 bytes of `HMAC-SHA256(key, value)`
(pi's scheme). Same value + same key ⇒ same placeholder, so placeholders are
stable across sessions for registered values.

The v1 format (`$$NAME_10HEX$$`) is gone: **placeholders already written to
past session files under the old format stop restoring.** That breakage was
accepted at migration; values re-encountered get fresh placeholders in the
new format. The `:U/:L/:C/:M` case suffix pi appends is deliberately not
used.

## Built-in credential patterns

Every pattern carries its own label instead of a shared `VENDOR_KEY`:
`GITHUBTOKEN`, `GITLABTOKEN`, `ANTHROPICKEY`, `OPENAIKEY`, `AWSACCESSKEY`
(AKIA/ASIA), `GOOGLEAPIKEY`, `SLACKTOKEN`, `NPMTOKEN`, `STRIPEKEY`
(sk/rk live/test), `STRIPEWEBHOOKSECRET` (whsec_), `HUGGINGFACETOKEN`,
`SENDGRIDKEY` (SG.···.···), `JWT` (eyJ…), `BEARERTOKEN` (`Bearer <20+>`),
`PRIVATEKEY` (PEM `-----BEGIN … PRIVATE KEY-----` blocks),
`SHOPIFYTOKEN` (shpat_/shpca_/shppa_), `POSTMANTOKEN`, `PULUMITOKEN`
(pul-), `DIGITALOCEANTOKEN` (dop_v1_), `GRAFANACLOUDTOKEN` (glc_),
`TWILIOKEY` (SK + 32 hex), `ALIBABAKEYID` (LTAI). Matching is gated by cheap
literal-prefix probes (`sk-`, `ghp_`, `eyJ`, …) before the regex runs, so
plain text pays almost nothing.

Matched vendor tokens are also persisted to the learned file so their
placeholders restore in later sessions — unless the match itself looks like
a regex source (`\s\S`, `(?s)`-style flags, or a `-----BEGIN … -----END`
block), in which case it is never persisted (self-learn pollution guard).
Practical consequence: PEM private keys are scrubbed within a session but
are not auto-persisted across sessions; add an explicit registry entry if
you need PEM placeholders to restore later.

## Learn-on-first-sight gates

- **Name gate**: a credential keyword (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`,
  `PASSWD`, `PASS`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`) must sit at an
  underscore or camelCase word boundary — `AUTH` does not match `Author`.
- **Veto shapes (never learned)**: scheme words (`bearer`, `oauth2`, …), ISO
  datetimes, unix s/ms timestamps, versions (`x.y.z`), paths, wordlists,
  plain lowercase/uppercase words, digit runs, UUIDs named `*_ID`.
- **Mask shapes (learned, ≥8 chars)**: vendor prefixes, hex digests ≥24,
  mixed-case alnum runs ≥20, values containing credential symbols
  (`&!?~%^*+#=@`), and PASSWORD-named values at **any** length.
- **Sub-floor values** (short passwords, short URL passwords) that pass the
  mask gate get span-local `$$12CHAR$$` placeholders: reversible within the
  session, but never registered or persisted, so they do not survive a
  reload. Learned values require ≥8 characters; explicit registry/learned
  values require ≥6.
- **URL passwords** (`scheme://user:pass@host`) must be credential-shaped
  (mixed case, or containing a credential symbol) in *both* the capture path
  and the span-hash path — example URLs like
  `postgres://user:postgres@localhost` with plain-word passwords are left
  alone.
- **evictContradicted**: when a credential-named variable is later shown
  holding an obviously code-shaped value (dotted reference like
  `process.env.FOO`, JS literal, punctuated code) and *that exact value* was
  previously auto-captured, it is un-learned and removed from the learned
  file. Registered registry values are never evicted. A bare echo like
  `MY_API_KEY=process.env.MY_API_KEY` does not evict a previously captured
  real token — the contradiction must show the captured value itself.

## Dump-view decoding

Dump-style views are decoded and scrubbed so secrets shown through them are
caught: `od -c` output, `xxd`/`hexdump` rows, addressless hex rows,
char-code-per-line (`[x]`, `('x')`, `ord('x')`), and base64 runs. Folding
runs only when a cheap gate suspects dump material (hex-pair density, base64
runs, address rows), and is skipped for strings over 64 KiB and base64 runs
over 32 KiB — those strings are still scrubbed directly. Regions are only
rewritten when decoding actually produces a placeholder, so clean dumps
round-trip byte-identical.

## Persistence and forgetting

- Learned values persist to `~/.local/share/opencode/opencode-secrets-learned.json`
  (0600 on creation) so placeholders in resumed sessions still restore.
- **Delete-to-forget**: entries are re-read before every scrub batch
  (mtime/size stat only). Deleting an entry — or the whole file — from the
  learned file (or removing an entry from the registry) takes effect without
  a reload.
- The placeholder key lives at `~/.local/share/opencode/opencode-secrets.key`
  (0600 on creation, 64 hex chars). It is created with an exclusive write so
  concurrent processes converge on one key; a corrupt key file is a hard
  error with a loud console message (placeholders from the old key would
  silently stop restoring); if the key cannot be persisted, a
  process-ephemeral key is used with a warning. Changing the key changes
  every placeholder minted after it.
- **Key self-protection**: the key file's own content is registered as a
  replace-mode secret, so any tool that reads
  `~/.local/share/opencode/` sees scrambled bytes, not the raw key.
  Registry and learned values are already scrubbed as registered values.

## Other behavior

- **System prompt note**: a one-line note that secrets appear as
  `$$FRIENDLY_12CHARS$$` placeholders and are resolved when tools run is
  appended idempotently to the outgoing system prompt
  (`context`/`compaction`/`generate` hooks).
- **Mention offsets**: when a prompt scrub rewrites the text, attachment
  `mention` offsets (`files`/`agents`/`skills`) are relocated by re-finding
  the mention text in the rewritten prompt; mentions that no longer resolve
  (e.g. the mention text itself contained a secret) have their `mention`
  field dropped while the attachment is kept. Drafts without mention arrays
  are untouched.
- **Observability**: no slash commands in server plugins. The plugin logs a
  single startup line with counts and **labels only** — real values are
  never logged, shown in warnings, or written anywhere except the key/learned
  files.
- **Hot reload**: registry + learned file mtimes/size are re-stat'ed before
  each scrub batch; a changed file rebuilds the store (stat only, cheap).

## Known limits (vs pi-secrets)

- No paint-time reveal in the transcript: your own redacted text shows as
  `$$…$$`; a TUI plugin part could add it later.
- Learned-file values loaded at startup are treated like registry values for
  scrubbing but remain evictable (auto-captured) — a contradiction can
  unlearn them, including their persisted entry.
- Registry entries are JSON-only (no YAML parser is bundled); pi's
  `secrets.yml` schema maps 1:1 onto the JSON form (see
  [`registry.md`](registry.md)).
- Sub-floor span placeholders and `replace`-mode rewrites are not
  cross-session restorable by design.
- The learned file is written whole from the plugin's in-memory map: two
  concurrent OpenCode instances can lose each other's learned updates
  (last-writer-wins).
