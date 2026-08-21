# Command Code provider for Pi

Local Pi extension registering the `command-code` provider with Command Code's live model catalogue and an offline 57-model fallback.

## Requirements

- Pi 0.84.2 or compatible
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

## Catalogue and protocol caveat

At startup the extension requests Command Code's official unauthenticated `GET /provider/v1/models` endpoint with a three-second timeout and a 256 KiB response limit. Valid live IDs, names, ordering, and context windows are overlaid on the checked-in rich metadata. HTTP, network, timeout, oversized, or schema failures silently use the complete 57-model fallback captured from Command Code 1.31.0 on 2026-08-21.

The catalogue is refreshed only when the extension starts; restart Pi to pick up later server changes. Future live IDs that are not in the fallback are exposed with limited metadata: text-only input, no reasoning controls, and the gateway's 64,000-token default output limit clamped to the live context window. Their zero cost is an unknown-price placeholder because the endpoint does not publish pricing, not a conservative pricing estimate. Curated metadata is added to the fallback as it becomes available. The four models added in this snapshot use rates from their official Command Code model pages, but remain text-only with reasoning controls disabled because the gateway's image and reasoning-effort contracts are not published.

Five max-output limits absent from Command Code's API use current OpenRouter metadata as **inferred compatibility metadata**, not as Command Code guarantees. Context values come from Command Code's Provider API:

| Command Code ID | Context | Max output | OpenRouter source |
|---|---:|---:|---|
| `zai-org/GLM-5.1` | 200,000 | 131,072 | `z-ai/glm-5.1` |
| `MiniMaxAI/MiniMax-M2.7` | 200,000 | 131,072 | `minimax/minimax-m2.7` |
| `Qwen/Qwen3.6-Max-Preview` | 200,000 | 65,536 | `qwen/qwen3.6-max-preview` |
| `Qwen/Qwen3.6-Plus` | 200,000 | 65,536 | `qwen/qwen3.6-plus` |
| `gpt-5.5` | 400,000 | 128,000 | `openai/gpt-5.5` |

All catalogue entries are currently text-only in this extension; image blocks are replaced with an omission notice rather than sent to an incompatible model. Provider-executed tools remain provider-side and are never exposed to Pi as client tool calls.

Model availability still depends on the user's Command Code plan. Server changes may break this undocumented integration. The gateway's observed `permissionMode: "standard"` and `mode: "agent"` values remain fixed compatibility values because no supported mapping for alternatives is documented.

Requests identify themselves with the audited Command Code client contract: `User-Agent: cli`, `x-cli-environment: production`, and `x-command-code-version: 1.22.0`. The version header is the protocol/catalogue compatibility snapshot audited by this extension; it is not the extension's own version. The official environment switches `CMD_ZDR=1` and `CMD_PROVIDER_DEEPSEEK_INTERNAL=1` are forwarded as their observed `"1"` routing headers when explicitly set. The extension does not synthesize `traceparent`, because it has no authentic Command Code trace/span context, and never logs request headers.

## Tests

From the repository root:

```sh
cd pi/extensions/command-code
npm test
```

Tests use Node's built-in test runner and Pi peer stubs, so they require no package installation. They are local and mocked; they make no network calls and use no real credentials.

## Optional paid smoke test

DeepSeek V4 Flash's exact Command Code ID is `deepseek/deepseek-v4-flash`.

After selecting `command-code/deepseek/deepseek-v4-flash` in Pi, send a short prompt such as `Reply with exactly: OK`. This makes a paid Command Code request; it is intentionally not part of the automated tests.
