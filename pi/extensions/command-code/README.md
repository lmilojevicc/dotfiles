# Command Code provider for Pi

Local Pi extension registering the `command-code` provider with Command Code's live model catalogue and an offline 59-model fallback.

## Requirements

- Pi with native `Provider.refreshModels` / generation-checked publication support (tested with 0.85.1)
- Command Code CLI with a compatible `~/.commandcode/auth.json` credential file
- Node.js 22.19+
- A Command Code account with access to the selected model

Authenticate with Command Code's official CLI first:

```sh
cmd login
```

The extension reads `~/.commandcode/auth.json` on each credential resolution. It never copies the API key into Pi's auth storage.

## Installation

From the repository root, install the local Pi package:

```sh
pi install ./pi/extensions/command-code
```

### Child sessions and isolated extension loading

A parent's provider registration is not inherited by child sessions. Each child selecting a `command-code` model must load this extension itself. Fallback membership helps failed discovery only after the extension loads; it cannot repair a missing provider extension.

When child extension discovery is disabled, explicitly allow the **absolute path** to this extension's `index.ts` through the launcher's supported configuration. For a Pi CLI launcher, Pi supports `--no-extensions -e /absolute/path/to/pi/extensions/command-code/index.ts` together. Replace the example path with the actual installed or worktree entry point; load one copy, not both.

For `pi-subagents`, use a custom agent definition's `extensions` field (not a per-call field or `/run` bracket option), for example this frontmatter:

```yaml
---
name: command-code-worker
description: Worker using the explicitly loaded Command Code provider
model: command-code/meta/muse-spark-1.3-contributor
thinking: high
async: true
extensions: /absolute/path/to/pi/extensions/command-code/index.ts
---
```

The installed launcher's agent docs support a single path, comma-separated paths, or a block list here. An explicit list loads exactly those extensions, while an empty field disables ambient extensions. Use background execution (`async: true`) for this provider-extension setup, consistent with the launcher's guidance. Keep existing tool allowlists and capability restrictions; an extension path does not override a policy that denies extensions.

**Existing `pi-subagents` limitation:** a cached model-not-found exclusion can reject an explicit per-call model selection before launching a child, even when the parent's current registry lists that exact model. Configured/inherited candidates have a stale-unavailable check against exact current registry membership, but explicit selections currently reject earlier. This extension does not fix that asymmetry or clear existing exclusions, and changing the thinking suffix does not resolve it. Do not clear all exclusions or bypass authentication/quota restrictions; provider loading and offline fallback are separate from launcher exclusion policy.

## Usage command

Run the following Pi command to open a responsive, dismissible account-usage view:

```text
/command-code-usage
```

It shows the current plan/status, cycle credits and requests, renewal timing, five-hour and weekly limits, and the account's full usage-page link. Press Enter or Escape to close it. The command makes non-inference `GET` requests to Command Code's authenticated `whoami`, billing credits, billing subscriptions, and usage summary endpoints; it does not consume model tokens.

The command reads the API key on demand through the same protected auth-file reader as the provider. The key is held only for the requests and is never copied, printed, or logged. Remote response bodies, raw network errors, and identity fields are not logged. The account slug is displayed only as part of the requested full-breakdown link. Requests reject redirects and have response-size and 15-second duration limits.

## Security checks

The auth file is opened without following symlinks, then checked through its open file descriptor. It must be:

- a regular file;
- owned by the current user;
- exactly mode `0600`;
- no larger than 64 KiB;
- JSON containing a non-empty string `apiKey`.

Errors never include the key, identity fields, provider response bodies, or raw network errors. Streams have bounded line, event, total-byte, and duration limits; redirects are rejected. If validation fails, run `cmd login` and repair the file ownership/permissions.

Long adjacent text/reasoning deltas are adaptively coalesced before Pi renders them. The burst threshold is measured in UTF-16 code units (JavaScript string length), not wire bytes, to avoid repeated encoding work. Parser yields provide a tested cooperative per-slice bound for a responsive or moderately slow consumer; they are not hard global backpressure because Pi's EventStream exposes no capacity or producer acknowledgement. Extremely slow/paused consumers and Pi's full-message Markdown rebuild remain Pi-core long-turn limits.

## History handoff and safe diagnostics

Outgoing history uses the extension-local `src/pi-0851-transform-messages.ts` compatibility adapter with the selected provider/API/model identity; stored history is not edited. It preserves the audited Pi 0.85.1 `transformMessages` behavior, with source provenance/hash in the adapter and the upstream MIT notice in `LICENSE.pi-normalization`. Pi 0.85.1's production loader aliases the Pi AI root in a way that breaks this helper's public subpath import, and the root does not export the helper. The adapter avoids that runtime subpath import without installation-path lookup, dynamic module discovery, or global loader changes. Real-SDK equivalence tests guard its behavior on upgrades. Foreign thinking becomes text (blank/redacted thinking is dropped), and foreign tool IDs use deterministic, bounded hash IDs with paired results. Valid same-target reasoning and tool IDs remain unchanged. Missing results use Pi's explicit `No result provided` error results before the next turn or at end-of-history.

Projection discards failed/aborted turns, empty assistants, opaque/blank reasoning that the gateway cannot represent, and orphan/duplicate/late tool results, including results of discarded failed calls. It does not manufacture successful calls or repair arbitrary malformed history (such as reused/duplicate call IDs).

HTTP and in-band stream 400s report only recognized fixed categories: `context_length_exceeded`, `tool_pairing_or_id`, `invalid_reasoning`, or `invalid_parameter`. Only the known context category triggers Pi's overflow recognition; unknown failures remain status-only. Successfully parsed embedded JSON is inspected through the same field allowlist as structured errors, never via its raw serialization or wrapper prose. Unknown fields (including paths/request IDs nested under `detail`) cannot contribute category tokens; recognized `detail` strings remain supported. Diagnostic inspection is bounded (64 KiB HTTP body, one-second read deadline, 16 KiB inspected text, 64 visits, container nesting depth 4 with root depth 0); read failure retains HTTP status, and caller cancellation still wins. No raw server messages, codes, paths, IDs, headers, or bodies are appended. Quota remains terminal; transient status/network errors retain their retry-recognizable messages.

This is defensive portability hardening, not a demonstrated fix for the original in-band 400. Separate synthetic Contributor baselines at 1,024 output tokens / low effort succeeded with fresh text, Codex text history, and Codex thinking plus a paired composite tool ID **before** normalization. The original cause, longer histories, the default output budget, and other upstream/model validation remain unverified.

## Catalogue and protocol caveat

The extension awaits Command Code's official unauthenticated `GET /provider/v1/models` endpoint **before registering the provider** at startup (including `/reload` and new extension instances). Requests reject redirects and have a three-second timeout and a 256 KiB response limit. A valid live list is authoritative for IDs, names, order, context windows, and removals. Startup HTTP, network, timeout, oversized, or schema failures silently use a 59-model fallback: the original 57-model membership captured from Command Code 1.31.0 on 2026-08-21 plus only `meta/muse-spark-1.3` and `meta/muse-spark-1.3-contributor`. Both additions have audited membership (`Sr`) and exact 1,048,576-token context literals (`Tr`) in official CLI 1.50.0's `dist/cli.mjs`, with the thinking snapshot below applied. They remain text-only with the conservative 64,000-token gateway output default and explicitly unknown prices. A later successful live list still removes any omitted fallback IDs.

The provider also implements Pi's native mid-session model refresh contract. When Pi refreshes this configured provider with network access allowed, it fetches and publishes a replacement list synchronously through Pi's generation-checked publication callback. Failures retain that instance's last-good list; cancellation and stale generations cannot replace it. Network-disabled refreshes do no I/O and keep current models. There is no background refresh timer, disk catalogue cache, stored-snapshot restoration, or catalogue persistence. Startup factory discovery remains a separate awaited request; the refresh context's network flag governs native refresh, not factory discovery. Pi's `models.json` overrides still apply above this native provider.

**Thinking is a separate checked-in snapshot**, not live discovery. `src/thinking.ts` records a baseline of exact IDs and explicit efforts from the installed official Command Code CLI **1.50.0**, `dist/cli.mjs`'s `yr` / `getSupportedEfforts` table, plus the explicitly sourced supplement below. It covers verified fallback IDs, including both Muse 1.3 IDs; it does not infer capabilities from model families or execute/scrape the CLI at runtime. Muse 1.1, 1.2, 1.2-contributor, and **1.3-contributor** expose low/medium/high/xhigh, **not max**. Plain Muse 1.3 also exposes max. Unsupported levels (including off/minimal) are hidden; the CLI's Default row is not treated as proof that thinking can be disabled. Omitting an explicit effort omits `reasoning_effort`, leaving the gateway default.

**DeepSeek V4.1 Flash** (`deepseek/deepseek-v4.1-flash`) additionally exposes **low/high/max**, with all other levels hidden. This exact-ID supplement follows Pi's refreshed `opencode-go/deepseek-flash` definition and its [models.dev base-model/effort metadata](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode-go/models/deepseek-flash.toml). It is inferred compatibility metadata, not a Command Code CLI 1.50.0 claim; live gateway acceptance has not been smoke-tested. It changes only Command Code's thinking controls: no OpenCode Go configuration, pricing, image support, output limits, or offline fallback membership is imported. Re-audit if Command Code publishes capabilities or rejects these efforts.

New live IDs absent from the thinking snapshot have no explicit reasoning controls. New IDs absent from the pricing/output snapshot remain text-only with the gateway's 64,000-token default output limit clamped to live context, and zero cost as an **unknown-price placeholder**, not a free-price claim. Both bundled Muse 1.3 IDs also use these conservative output and unknown-price defaults despite their verified thinking controls. The observed model endpoint publishes neither thinking capabilities nor prices. Refresh/reload alone cannot add missing capability or pricing facts: those require an audited extension metadata update.

Bundled prices are a checked-in snapshot of Command Code's [official pricing page](https://commandcode.ai/docs/resources/pricing-limits), retrieved at `2026-08-21T12:52:28Z`. Values use Pi's units of USD per one million input, output, cache-read, and cache-write tokens. The original 57 pricing entries are unchanged: the page published primary rates for 55 paid models and explicitly marked two models free (`poolside/laguna-s-2.1-free` and `stealth/ox-alpha`). The free offers are capacity/preview dependent and may end. The 59-model fallback additionally classifies both Muse 1.3 IDs as unknown-priced, not free; live IDs absent from the fallback also use the explicit unknown-price placeholder. Three docs-only models absent from the original 57-model snapshot were intentionally not added to the fallback.

These flat values are estimates, not guaranteed invoice totals. Command Code can vary the actual charge by upstream routing and ZDR, and its primary displayed rate can reflect temporary deals or time-of-day pricing (the DeepSeek entries use the advertised off-peak main rate). Pi's four cost fields cannot represent long-context tiers, media, web-search, reasoning, fixed-request, alternate cache-duration, or other conditional charges. Command Code's authenticated Usage page remains authoritative for each request. OpenRouter prices are not used because requests are billed by Command Code and the two services' rates differ.

Five max-output limits absent from Command Code's API use checked-in OpenRouter metadata as **inferred compatibility metadata**, not as Command Code guarantees or prices. Context values come from Command Code's Provider API:

| Command Code ID | Context | Max output | OpenRouter source |
|---|---:|---:|---|
| `zai-org/GLM-5.1` | 200,000 | 131,072 | `z-ai/glm-5.1` |
| `MiniMaxAI/MiniMax-M2.7` | 200,000 | 131,072 | `minimax/minimax-m2.7` |
| `Qwen/Qwen3.6-Max-Preview` | 200,000 | 65,536 | `qwen/qwen3.6-max-preview` |
| `Qwen/Qwen3.6-Plus` | 200,000 | 65,536 | `qwen/qwen3.6-plus` |
| `gpt-5.5` | 400,000 | 128,000 | `openai/gpt-5.5` |

All catalogue entries are currently text-only in this extension; image blocks are replaced with an omission notice rather than sent to an incompatible model. Provider-executed tools remain provider-side and are never exposed to Pi as client tool calls.

Model availability still depends on the user's Command Code plan. Server changes may break this undocumented integration. The gateway's observed `permissionMode: "standard"` and `mode: "agent"` values remain fixed compatibility values because no supported mapping for alternatives is documented.

Requests identify themselves with the audited Command Code client contract: `User-Agent: cli`, `x-cli-environment: production`, and `x-command-code-version: 1.22.0`. The version header is the protocol compatibility snapshot audited by this extension (independent of the thinking snapshot); it is not the extension's own version. The official environment switches `CMD_ZDR=1` and `CMD_PROVIDER_DEEPSEEK_INTERNAL=1` are forwarded as their observed `"1"` routing headers when explicitly set. The extension does not synthesize `traceparent`, because it has no authentic Command Code trace/span context, and never logs request headers.

## Tests

From the repository root:

```sh
cd pi/extensions/command-code
npm test
```

`npm test` uses Node's built-in test runner, root Pi peer stubs, and the production local normalization adapter. It needs no installed SDK or `PI_COMMAND_CODE_TEST_SDK` override.

Run the SDK suite against already-installed real Pi peers:

```sh
# If Pi peers are already resolvable locally:
npm run test:sdk
# Otherwise point to your installed pi-coding-agent package directory, e.g.:
PI_COMMAND_CODE_TEST_SDK=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent npm run test:sdk
```

The SDK suite directly compares the local adapter against the actual public `@earendil-works/pi-ai/api/transform-messages` helper (resolved only in test context), including immutable history, identity/signatures, tool ID/result mapping, synthetic missing results and image degradation. It also tests actual thinking helpers, stream request capture, safe HTTP/in-band diagnostics, overflow/retry recognition, payload serialization, native refresh/generation contracts, and provider composition.

`npm run test:sdk` additionally runs `npm run test:production-loader` in a separate process **without** the custom SDK test resolver. This offline test uses installed Pi 0.85.1's actual `loadExtensions`, production aliases and Jiti, awaits factory discovery, and verifies native provider registration and the exact synthetic model. Jiti filesystem and Node compile caches are disabled. You can run it separately with the same SDK-directory override. The loader test intentionally asserts Pi 0.85.1: re-audit it and adapter equivalence before accepting a different Pi version. It covers the installed unbundled Node runtime, not every bundled/binary distribution.

All suites mock service requests and use no real credentials or inference; none installs dependencies. The SDK override locates only the test host and is never consulted by production extension code.

## Optional paid smoke test

DeepSeek V4 Flash's exact Command Code ID is `deepseek/deepseek-v4-flash`.

After selecting `command-code/deepseek/deepseek-v4-flash` in Pi, send a short prompt such as `Reply with exactly: OK`. This makes a paid Command Code request; it is intentionally not part of the automated tests.
