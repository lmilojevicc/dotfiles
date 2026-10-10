# pi-local-redaction

Opt-in Rust-backed **text** redaction for Pi. Not a sandbox or a guarantee of anonymity.

Build the local native bridge with `node scripts/build-native.mjs` (Cargo required), then explicitly try `pi -e ./pi/extensions/redaction/index.ts`. Nothing installs or activates itself. Node 22.18+; Pi supplies the declared peer dependencies. Tested adapter contracts against Pi 1.0.4.

Private policy: `$XDG_CONFIG_HOME/pi-redaction/config.json`, or `~/.config/pi-redaction/config.json`. Create it yourself outside this repository, owner-only (`chmod 600`), inside an owner-controlled directory. Start from `config.example.json`: **every source and detector is off**. Enable sources plus selected detectors and/or `literals` mappings (`original` → unique `alias`). No project overrides. `/redaction-status` shows flags/counts, never values. Reload after policy changes.

With `toolResults` enabled, read/edit/write use observed file-scoped aliases and refuse stale/ambiguous edits; read first, preserve complete tokens, and use Pi's `edits[]` array. Files are not changed on read. User text is separate: with `userMessages: false`, intentionally typed direct user text reaches the model unchanged, even if tools mask the same value. This exemption does not apply to summaries/custom messages. Protected images/binary content is withheld, not OCR-redacted.

Invalid policy or sanitizer/native failure censors protected results and replaces instrumented requests with an empty payload until reload. This is **not universal transport enforcement**. Compaction, summarized tree navigation and speculative cache warming are disabled while active; start a fresh session when context fills. `/bug` model summaries and transcript sharing are **unprotected**. Signed/opaque data, subagents, other extensions, subprocess networking, session logs and streaming UI also have coverage gaps. Read [coverage and API details](docs/pi-adapter.md) before relying on it. New code is MIT; third-party obligations are separate.
