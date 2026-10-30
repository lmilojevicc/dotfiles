# Usage

Provider quota usage in one tabbed view. `/usage` opens a full-screen panel with one tab per provider that has credentials, showing every quota as a **used** percentage (`used 57%`), never "left". It also publishes one footer status. Built on the codex-enhanced tab frame, caching and Codex parsing; see the MIT notice in `index.ts`. Reset credits stay in codex-enhanced; this extension only reads usage.

## `/usage`

- `Tab` / `Shift+Tab` cycle tabs, `R` refreshes the active tab, `Esc` / `Ctrl+C` close.
- Long lists scroll inside a fixed frame: `↑`/`↓` or `j`/`k` move one row, `J`/`K` move a full band, `g`/`G` jump to the first/last row. `PgUp`/`PgDn`/`Home`/`End` are also accepted where the terminal delivers them, but multiplexers such as herdr swallow those keys before they reach the app, which is why the letter bindings exist and the hints name them. Every binding is matched with Pi's key matcher, so the letters also work in terminals that encode them as escape sequences (the Kitty keyboard protocol, xterm `modifyOtherKeys`). A dim `rows A-B of C` indicator appears whenever the content overflows; notes are dropped before quota rows, and a `… +N more` marker discloses omitted notes.
- The panel opens on the tab for the current session model's provider, else the first tab. Like the footer, it matches that provider through the adapter's `aliases`, so a `claude-bridge` or `anthropic` session opens the Claude tab.
- A tab loads when first shown and reuses fresh data from the shared 5-minute cache. `R` always refetches. While a refresh runs, the previous rows stay visible with `refreshing…`. A failed load shows the message and `Press R to retry.`
- The tab bar is built from the visible providers. When the full bar does not fit, it uses a tighter separator, then a window around the active tab with `‹ ›` markers. Tables measure terminal cells (wide characters stay aligned), drop the bar column at narrow widths and then truncate as a last resort. The leading column (account, limit name or provider) is headed `Item` so the header row lines up with the data columns.
- Interactive TUI only. In other modes the command reports `/usage requires interactive terminal mode`: a warning notification when a UI exists, a thrown error otherwise.

### Tabs follow credential presence

A provider gets a tab when its credentials are **present**, not when they are ready. Pi providers are checked with `modelRegistry.getProviderAuthStatus(id).configured`, which reads stored, runtime, environment and `models.json` configuration without resolving or refreshing anything. A stored login that `pi auth check` reports as `not_ready` still gets a tab. If Pi then cannot resolve it, the tab shows `Auth needs refresh · run /login <provider>`. Providers without credentials have no tab. With no providers at all, the panel says so.

## Used percentages

- Display value: `used = clamp(usedPercent, 0, 100)`, shown as `Math.round(used)%`.
- Bar: 10 cells, `Math.round(used / 10)` filled.
- Unknown values show `?%` with an empty bar.
- Snapshots keep the raw, unrounded provider value (for example `99.6`, or `140`) for future threshold logic. Only the display rounds and clamps.
- Reset countdowns use the codex-enhanced short form: `~42m`, `~3h`, `~2d 4h`, `~now`, `reset ?`.

## Providers

| Tab | Visible when | Source | Semantics |
| --- | --- | --- | --- |
| Codex (`openai-codex`) | Pi has `openai-codex` credentials | `GET https://chatgpt.com/backend-api/wham/usage` | ChatGPT subscription limits: one row per limit (main `codex` plus each `additional_rate_limits[]` entry by `limit_name` or `metered_feature`). Each window is labelled from its duration: `5h`, `weekly` or a compact length. The plan type is the subtitle. |
| OpenCode Go (`opencode-go`) | Pi has `opencode-go` credentials | `GET https://opencode.ai/zen/go/v1/usage` | OpenCode Zen Go plan windows: Rolling, Weekly and Monthly, each with a used percentage and an optional reset. |
| CLIProxyAPI (`cliproxyapi`) | The local proxy answers `GET <origin>/healthz` with 200 within 1.5 s | Management API of the local proxy, plus the antigravity and OpenCode usage APIs for those credentials | Per-credential routing state plus a traffic summary, and per-credential upstream quota for `antigravity` and `opencode-go` credentials. Normalized quota for other providers appears only with a quota plugin. |
| Claude (`claude`) | A Claude Code login exists in the keychain (macOS) or `~/.claude/.credentials.json` | Live `anthropic-ratelimit-unified-*` response headers when available, else `GET https://api.anthropic.com/api/oauth/usage` | Subscription limits: `5h session` and `weekly · all models` (plus per-model weekly rows when the account has them), the weekly per-app share, and pay-as-you-go credits when enabled. `pro`/`max` is the subtitle. |
| Command Code (`commandcode`) | Pi has `commandcode` credentials | Command Code alpha APIs: `whoami`, `billing/credits`, `billing/subscriptions` and `usage/summary`, read with the account key | Credits: one line per `5h`/`weekly` window limit (percent of that window's cap) plus a `period` line (billing spend over remaining+spend). The plan is the subtitle; account, credit sources, usage totals and unavailable sections are notes. |

**Claude.** Two read-only sources, neither of which writes, refreshes or logs the credential:
- **Live headers.** `pi-claude-bridge` forwards Claude Code's `rate_limit_event` to pi's `after_provider_response` as `anthropic-ratelimit-unified-*` headers (the built-in provider uses the same names). Those arrive for free, so the tab and footer prefer them when a Claude request has happened in the session — they cost no request. Utilizations are fractions (`0.38` → `used 38%`), and a utilization header that is not a finite number counts as unknown (`?%`) instead of rendering `NaN%`. `anthropic-ratelimit-unified-status`, `-overage-status` and `-representative-claim` become notes or the subtitle.
- **OAuth usage endpoint.** `GET https://api.anthropic.com/api/oauth/usage` with the Claude Code login is what `/usage` shows, and it is the only source a manual refresh uses, so the figures are current even when Claude has been idle. The normalized `limits[]` array is preferred (`session`, `weekly_all`, per-model weekly); raw window buckets are the fallback, where a value above 1 is whole percent and a value at or below 1 is the documented fraction. `seven_day_breakdown.rows[]` renders as *Weekly usage share* (a share of weekly usage, not a limit) and `spend`/`extra_usage` render as credits only when the account has them enabled.
- The credential is read from the macOS keychain (`Claude Code-credentials`) or `~/.claude/.credentials.json`; `PI_USAGE_CLAUDE_TOKEN` and `PI_USAGE_CLAUDE_CREDENTIALS` override the source. It is never refreshed here — Claude Code owns that lifecycle, and rotating its refresh token from a second process could break the login — so an expired token keeps the tab visible with a "run claude to refresh" state instead of failing silently. The token never reaches a row, note, error message or the status line.
- The footer matches this tab for `claude-bridge` and `anthropic` sessions, so the status reads `claude 38% used` whichever provider id the session uses.

**Codex.** Pi's freshly resolved `openai-codex` token is sent as `Bearer`, along with `chatgpt-account-id` (from the JWT claim `https://api.openai.com/auth` → `chatgpt_account_id`), `OAI-Language: en` and `originator: pi`. The request is made only when the resolved base URL is canonical: `https://chatgpt.com/backend-api` or `…/codex`. Parsing matches codex-enhanced:
- Numbers are strict; numeric strings count as unknown.
- If `window_minutes` and `limit_window_seconds` disagree, the window length becomes unknown.
- A lone weekly window moves to the second slot.

Unlike codex-enhanced, Spark buckets are not filtered out.

**OpenCode Go.** Pi's resolved inference key is sent as `Bearer`, and only when the resolved origin is the official `https://opencode.ai`. Any other origin fails before the key is sent. The parser accepts `{usage:{rolling|weekly|monthly:{status, percent, resetsAt}}}` and the snake_case variants. All three windows always render. An unknown shape, a missing window or an unknown `status` shows `?%` with a note instead of failing. `rate-limited` windows keep their value and add a note.

**Command Code.** Adapted from the `pi-commandcode-provider` package (MIT), whose `/commandcode-quota` command reads the same alpha endpoints: `whoami`, `billing/credits`, `billing/subscriptions` and `usage/summary`, authenticated with the account's API key.
- Tab visibility and the key follow Pi's `commandcode` provider login: any credential state gets a tab, and the fetch uses `getProviderAuth("commandcode")`. The alpha origin is the chat provider's configured base with the `/provider/v1` suffix stripped, else `https://api.commandcode.ai`, so the key goes to the same origin the session's chat traffic already uses, as `Bearer`. Requests share the extension's bounded-fetch rules (size and time bounds, redirects refused rather than followed).
- `whoami` is blocking: a 401/403 is the auth-refresh state `Command Code rejected the API key · run /login commandcode`. Then `billing/credits` and `billing/subscriptions` are fetched together, the key rejections abort before any summary request, and `usage/summary` is queried with `orgId` from the account and `since` from the subscription's current period start.
- One `Credits` row: a line per window limit — `5h`, `weekly`, percent of that window's cap, its reset, and `<used> of <cap>` as status — plus a `period` line: billing-period spend over `remaining credits + spend`, the upstream "% used" figure. When credits are unavailable but the summary is known, the period line reports the spend without inventing a percent. An empty pool (nothing allocated, nothing spent) renders 0%.
- The plan is the subtitle; dim notes carry the account and key name, the monthly/purchased/free credit sources, billing-period usage (cost, request count, tokens) and the plan with status and renewal countdown. `resetAt` and period ends accept epoch, ISO or numeric-string shapes from the alpha APIs.
- A section the API does not recognize, cannot serve or times out becomes an explicit `credits: HTTP 500`-style note — sections are never shown as zero usage. When all three are unrecognized the tab fails with `Command Code returned no recognized usage data for the account.` The account key never reaches a row, note, status or error message.
- The footer publishes `commandcode <used>% used` for `commandcode` sessions; `statusPercent` is the worst known window or pool percentage.

**CLIProxyAPI.**
- Base URL: `PI_USAGE_CPA_BASE_URL`, else `baseUrl` in `<agent-dir>/pi-cliproxyapi-provider/config.json`. Only the origin is used.
- Credentials come from `GET /v0/management/auth-files`, falling back to `/v8/management/credentials` on 404. Each credential is one row, grouped by provider and labelled by `email`, then (OAuth only) `account`, `label`, `name` or `id`. For `api_key` credentials CLIProxyAPI's `account` is the plaintext upstream key, so it is never shown, and any other field containing it is dropped.
- A row's state comes from the fields v8 sends: `disabled` (or `status: disabled`), `cooling down until <time>` while `next_retry_after` is in the future, `unavailable`, any other non-`active` `status` (`error`, `pending`, `refreshing`, …) or `ok`. It adds `status_message`, the `failed` request count and `priority` when present. v8's `quota` object carries only `observed_at` and `signals`, so the older `quota.exceeded` / `quota.reason` / `quota.next_recover_at` fields (`exceeded`, cooling down) are read only as a fallback for pre-v8 proxies.
- A **Traffic** group comes first, from `GET /v0/management/api-key-usage` (v8: `/v8/management/observability/usage/api-keys`). It shows success and failed totals per provider plus the newest `recent_requests` bucket (the last element) summed across keys. The bucket's `time` is the proxy's local-time label such as `11:55-12:00` and is shown as-is. The `<base_url>|<api_key>` map keys are dropped while parsing and never rendered. An empty response renders the dim note `No API-key traffic recorded.` instead of silence.
- If `GET /v0/management/quota/providers` lists providers, each credential of a listed provider is queried with `POST /v0/management/quota/fetch` (`{auth_index, provider}`), at most 4 at a time. v8 has no quota routes, so there is no fallback. Its `groups[].buckets[]` render as used percentages, `100 - remainingFraction * 100`, labelled by the group's `displayName` and the bucket `window`. Otherwise one dim note says normalized quota needs a quota plugin.
- Per-credential **upstream quota** is fetched directly from the provider APIs for two credential types, using the token/key in the matching JSON file in `~/.cli-proxy-api` (located by the credential's `name` from the listing; plain `<name>.json` basenames only):
  - **antigravity** (`access_token`): `POST https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary` with body `{}`, falling back to `https://cloudcode-pa.googleapis.com` only on network failure or a 5xx. **This RPC is experimental and undocumented** (verified against a live response; it may change or disappear without notice) and requires the Antigravity CLI user agent, which is sent as `antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)`. Each `groups[]` becomes a section heading from its `displayName`; each bucket renders `used = (1 - remainingFraction) * 100` (raw, clamped only for display), labelled by `window` (falling back to the bucket `displayName`, then `bucketId`), with `resetTime` converted to the epoch reset. An unrecognized shape degrades to `?%` with a short note.
  - **opencode-go** (`api_key`, e.g. `provider-bundle-*.json`): `GET https://opencode.ai/zen/go/v1/usage`. **The endpoint sits behind a Cloudflare bot gate**: a plain request gets `403 Error 1010` even with a valid key, so every request carries the OpenCode client fingerprint — `User-Agent: opencode/latest/2.0.18/cli`, `x-opencode-client: cli` and a fresh random `x-opencode-session` (`ses_` + 12 hex + 14 base62, new per request). The response's `percent` is already a used percentage and is used as-is; `resetsAt` is the reset. Windows parse with the same rules as the OpenCode Go tab.
  - **Token freshness (antigravity):** when the file's `expired` is past (or within ~2 minutes), the tab triggers one `POST /v0/management/auth-files/refresh` per snapshot with `{"all": true}` — one call covers every stale file, matching the route's `{name | auth_index | all}` body (v8: `/v8/management/credentials/refresh`) — then re-reads the files and calls the provider with the fresh tokens. A token still expired afterwards skips the provider call and shows the `token expired` state instead.
  - Upstream fetches run at most 4 at a time (`forEachLimited`), a failing credential is isolated (it keeps its plain row and a dim note counts the failures), and the results ride the shared 5-minute snapshot cache; `R` forces a refetch. Tokens, keys and session ids never appear in rows, notes or error messages, and provider-derived strings are sanitized before rendering.
- Management requests never follow redirects. Fetch would re-send `X-Management-Key` to a cross-origin `Location`, so a redirect fails the request instead.
- When every management route answers 404 (CLIProxyAPI registers none until `remote-management.secret-key` is set), the tab stays visible and shows the setup state `Management API is off · set remote-management.secret-key in the CLIProxyAPI config`. `/healthz` answering 200 does not mean the management API is on.

### CLIProxyAPI management key

Candidates are tried in this order, and a candidate is accepted only after the proxy confirms it:

1. env `PI_USAGE_CPA_MANAGEMENT_KEY`
2. `managementKey` in `<agent-dir>/pi-cliproxyapi-provider/config.json`
3. `~/.cli-proxy-api/.management-password` (first line, trimmed)
4. `secret-key:` in `~/.cli-proxy-api/config.yaml`, read from that single line without a YAML parser. Values that look hashed (`$2a$`/`$2b$`/`$2y$` bcrypt, `$argon2…`) are skipped with a note and never sent. CLIProxyAPI hashes plaintext keys on startup.

Verification:
- The proxy confirms a key when one `GET /v0/management/config` with `X-Management-Key` returns 200. The accepted key is cached per origin for the Pi session, and the panel names its source (never its value).
- CLIProxyAPI bans an IP for 30 minutes after 5 failed attempts, after which even the right key gets 403. So each refresh tries at most one candidate, and a key value the proxy answered 401 to is never sent again in that Pi session. A 401 shows `Management key from <source> rejected · retry to try the next candidate`; the next refresh (`R`) tries the next one. A changed key value counts as a new candidate.
- A later 401 or 403 re-resolves once per refresh; concurrent requests that fail share that one re-resolution, and each retries once. Only a 401 drops the cached key and marks it rejected.
- A 403 whose body says the IP is banned for too many failed attempts, or any 429, is a separate state: `Proxy banned this host's IP · retry in <duration>` (or the rate-limit equivalent). It stops the candidate loop and does not count as a bad key.
- With no candidates, or none accepted, the tab shows `No management key …` or `No verified management key …`. The extension never guesses a key.

## Footer status

The extension publishes exactly one key, `usage`, via `ctx.ui.setStatus("usage", text)`, and only when `ctx.hasUI` is true. The text is `<providerId> <used>% used`, for example `opencode-go 57% used`. The provider is the current session model's provider when that provider has data, otherwise the first visible provider with data.

The value is the snapshot's `statusPercent` when the adapter sets one. Otherwise it is the highest known used percentage in the first row that has one; for Codex that is the main limit's 5h or weekly window. Without data the status is cleared with `undefined`, and it is also cleared on session shutdown.

The footer refreshes on session start, model change, settled agent runs and after `/usage` closes. It reads the shared per-provider cache (5-minute TTL, one in-flight request per provider). A failed refresh keeps the last good snapshot for the footer.

## Adding a provider

The contract lives in `core.ts`: `ProviderAdapter`, `AdapterContext`, `ProviderSnapshot`, `UsageRow`, `UsageWindow` and `ProviderStateError`. To add a provider, create `providers/<id>.ts` and append its adapter to `PROVIDER_ADAPTERS` in `providers/index.ts`; array order is tab order. Adapter rules:
- Report raw used percentages.
- Use epoch seconds for every timestamp.
- Make network calls only through `ctx.fetch`.
- Never put credentials in snapshots, notes or error messages.
- Throw `ProviderStateError` for auth-refresh, setup and blocked states.

## Tests

Pi discovers `index.ts` through the extension directory symlink. Restart Pi after adding the extension. Run `npm test` in this directory. Tests inject `fetch`, use temporary agent and home directories, and make no network requests. The TUI mock re-exports the installed `@earendil-works/pi-tui` utilities, resolved by the shared test loader ([`../_test-support`](../_test-support/README.md)) from Pi's managed install; set `PI_PACKAGE_ROOT` for a nonstandard installation.

## Caveats

- Tested on macOS arm64 with Node 26 and Pi 1.2.0. Nothing is platform-specific, but other platforms have not been run.
- The Codex, OpenCode Go and CLIProxyAPI management endpoints are undocumented or local APIs and may change. CLIProxyAPI field names and routes were checked against the CLIProxyAPI v8 source, not against a live management response.
- The antigravity quota RPC (`v1internal:retrieveUserQuotaSummary`) is an experimental, undocumented source verified against one live response; it can change or disappear without notice. The OpenCode usage endpoint's fingerprint headers mimic a specific client version and may need updating when OpenCode changes them.
- The Command Code alpha endpoints are parsed to the shapes `pi-commandcode-provider` 0.7.8 recognizes for the same integration; an upstream schema change degrades that section to an explicit unavailable note rather than wrong numbers.
- Clock times (`cooling down until 14:05`) use local time and add the date when it is not today.
