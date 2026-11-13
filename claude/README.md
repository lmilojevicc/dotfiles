# Claude Code config

Managed by dotty (`[packages.claude]` in `dotty.toml`):

| Source | Target |
| --- | --- |
| `settings.json` | `~/.claude/settings.json` |
| `themes/` | `~/.claude/themes/` |

Claude Code detects that `settings.json` is a symlink and watches the target, so its
own saves (theme, permission choices) land in this repo. Keep it free of secrets — auth
lives in `~/.claude/.credentials.json`, which is not managed here.

## settings.json

Validated against `https://json.schemastore.org/claude-code-settings.json` (the `$schema`
line). Keys that matter:

| Key | Value | Why |
| --- | --- | --- |
| `env.DISABLE_TELEMETRY` | `"1"` | opts out of telemetry; also disables GrowthBook feature-flag fetching |
| `env.DISABLE_ERROR_REPORTING` | `"1"` | opts out of error/sentry reporting |
| `env.CLAUDE_CODE_DISABLE_CRON` | `"1"` | no scheduled/cron tasks (env-var only, no settings key) |
| `disableArtifact` | `true` | drops the Artifact tool (private web pages on claude.ai) |
| `disableBundledSkills` | `true` | removes bundled skills + bundled workflows; built-in slash commands stay typable but are hidden from the model. Plugin and `~/.claude/skills` skills are unaffected |
| `feedbackSurveyRate` | `0` | kills the "how is Claude doing?" survey |
| `attribution` | `{"commit": "", "pr": ""}` | empty string hides commit/PR attribution. `includeCoAuthoredBy` is deprecated in favour of this |

Not enabled, available if wanted: `disableWorkflows` (drops the Workflow tool, the single
biggest prompt saving), `disableClaudeAiConnectors`, `autoUpdatesChannel: "stable"`,
`cleanupPeriodDays`, and the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` / `MAX_THINKING_TOKENS` /
`MAX_MCP_OUTPUT_TOKENS` caps.

### Permissions

`permissions.deny` is a mechanical translation of the path policy in
`pi/extensions/pi-permission-system/config.json` (114 `deny` globs), emitted as both
`Read(...)` and `Edit(...)` rules — in Claude Code those two rule families cover *all*
file-reading and file-editing tools (`Write(...)`/`MultiEdit(...)` rules are accepted but
never matched). No `Bash(...)` rules: the source policy is path-based only.

Glob translation: `~/...` stays home-relative, a leading `/` becomes `//` (absolute inside
a rule; a single `/` would anchor at the working directory), and a bare glob such as
`*id_rsa*` becomes `//**/*id_rsa*` (absolute path anywhere).

Where the pi policy re-allows a pattern, the deny is narrowed so the exception survives —
a Claude Code `deny` always wins, so the blanket globs cannot be kept:

| pi | pi allows | here |
| --- | --- | --- |
| `*.env.*` | `*.env.example` | enumerated suffixes (`.local`, `.production`, `.test`, `.staging`, `.ci`, `.preview`, `.secrets`, `.vault`, `.prod`, `.dev`, …) |
| `*credentials.json*`, `*service-account.json*` | `.example`, `.template`, `.sample` | the exact basename plus enumerated suffixes (`.bak`, `.old`, `.json`, …) |
| `*id_rsa*` (`dsa`, `ed25519`, `ecdsa`) | `*id_*.pub` | the exact basename plus backup suffixes, so `id_rsa.pub` stays readable |

Residual differences from pi: `.env.<suffix>` outside the enumerated list is not denied,
and pi's `*/testdata/*` / `*/fixtures/*` re-allowances cannot be expressed, so those
fixtures stay denied. Add suffixes to the lists in this file if you need more coverage.

The seven tool-name entries (`PushNotification`, `RemoteTrigger`, `SendUserFile`,
`EndConversation`, `SendFeedback`, `DesignSync`, plus `Artifact`/`ShareOnboardingGuide`)
predate this change and are kept as-is. Note the published schema's rule pattern does not
list those newer tool names, so an editor will flag them even though Claude honours them.

Deny rules are a guardrail, not a security boundary — they cover Claude's file tools, not
Bash. Current count: 380 rules (190 paths × Read/Edit, plus the 8 tool names).

## Themes

### `catppuccin-mocha.json`

`base: "dark-ansi"` (Claude's builtin terminal-palette preset) plus pinned Catppuccin
Mocha values:

- Surfaces/accents match `pi/themes/catppuccin-mocha.json` (`userMessageBg` = mantle,
  `text` = `#cdd6f4`, peach/blue/mauve/teal accents): user-message text goes from 3.0:1
  (stock `ansi:blackBright` fill) to 12.1:1, selection from 1.1:1 to 4.6:1.
- Diffs: only the same-line (word-level) tokens are overridden —
  `diffAddedWord: ansi256(22)` (`#005f00`) and `diffRemovedWord: ansi256(88)`
  (`#870000`), i.e. the accent green/red darkened into the page (what a ~35-40% alpha
  tint gives), text 5.5:1 / 7.2:1. The four row tokens (`diffAdded`, `diffRemoved`,
  `*Dimmed`) stay at the builtin `dark-ansi` references (`ansi:green` / `ansi:red`).
- Why indices for those two, when everything else here is hex: in this session hex values
  in these two tokens render as their 256-colour quantisation (`#2f5b3c` -> `#444444`,
  `#6b3140` -> `#4e4e4e`, both neutral greys) even though Claude's process has
  `COLORTERM=truecolor`/`FORCE_COLOR=3` and *does* emit 24-bit escapes for other tokens
  (verified: `38;2;108;112;134` promptBorder, `48;2;24;24;37` message background), and
  herdr round-trips 24-bit backgrounds unmangled (verified with `herdr pane read`).
  Indices sidestep whatever that path is doing.
- Why not copy the builtin light theme: its diff reads well because of polarity — light
  tints (`#dcffdc` / `#ffdcdc`) under dark `#333333` text. A dark theme cannot borrow that
  without inverting the global text colour.
- The surface/accent hex values are only exact with 24-bit output; a 256-colour process
  quantises them (`#181825` → `#1c1c1c`, `#cdd6f4` → `#d7d7ff`), which is harmless for
  neutral surfaces. Claude fixes that colour level at start-up from its own environment —
  settings.json `env` only reaches tool subprocesses, so it cannot be forced from here.
