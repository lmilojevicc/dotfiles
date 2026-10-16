# opencode-free

Pi provider for OpenCode Zen's zero-cost models. Zen only serves the free lane
to requests that look like the official OpenCode client, so this extension
injects that fingerprint and keeps the parts that rotate up to date on its own.

## How the gate works

Verified on 2026-10-16 by capturing real `opencode` v2.0.26 requests and
bisecting the differences against direct HTTP requests:

| Requirement | Detail |
| --- | --- |
| `User-Agent` | `opencode/<channel>/<version>/<client>`, e.g. `opencode/latest/2.0.31/cli`. Too old a version returns `426`. |
| `x-opencode-session` | Required, plus the `x-opencode-session-id` / `x-session-affinity` / `x-session-id` aliases. Must decode as an OpenCode `Identifier.descending()` id: `ses_` + 12 hex of `~(unix_ms * 4096 + counter)` + 14 base62 characters. A well-formed id with an implausible timestamp is rejected. |
| Tools | The tool array must contain a tool named `read`. A shell tool is not required, and neither the description nor the schema is inspected. Requests with no tools at all are only accepted when the system prompt matches OpenCode's own no-tool prompts (title generation). |
| Streaming | The request must stream. |
| Auth | `Authorization: Bearer public` selects the anonymous zero-cost lane. Paid model ids fail with `insufficient balance`. |

`x-opencode-project` is present in real requests but not enforced. The gateway
answers violations with `403 FreeTierError`.

## What the extension does about it

- **Fingerprint**: injects the headers above on every request and adds the
  required `read` tool when the payload does not already carry one (completions
  and responses shapes). A real `read` tool is never touched, and the injected
  marker is described as not executable. When the request offered no tools of
  its own, chat completions requests also get `tool_choice: "none"`, so the
  model cannot call the marker; the responses API only supports `auto`, so
  those requests rely on the description alone. If a model calls the marker
  anyway, Pi answers `Tool read not found` and the turn recovers. Pi already
  streams every request to these APIs, which the gateway also requires.
- **Version**: resolves the newest OpenCode version for the `User-Agent` from
  the homebrew tap formula, then the installed `opencode` binary, then a
  bundled fallback. Refreshed in the background every 6 hours, after any
  `FreeTierError`, and on a cold cache.
- **Models**: fetches `https://pi.dev/api/models/providers/opencode`
  (Pi's own catalog for the Zen provider) and intersects it with
  `https://opencode.ai/zen/v1/models` so new free models appear and removed
  ones disappear without editing this file. Zen rotates that list without
  notice: on 2026-10-16 it dropped `ll-alpha-free` and both
  `muse-spark-*-contributor-free` between two runs, and the next discovery
  removed them here.

  Limits and modalities come from the **upstream model**, never from Zen's
  free-lane policy numbers. Both Pi's catalog and models.dev advertise
  `glm-5.3-flash-free` as 200K/32K and `deepseek-v4.1-flash-free` as 200K/32K;
  probing the live gateway on 2026-10-16 (all free models, `Bearer public`)
  showed:

  | probe | result |
  | --- | --- |
  | `glm-5.3-flash-free`, 299,157 tokens, codeword at the end | recalled it |
  | `glm-5.3-flash-free`, 1,495,567 tokens | `400 context_length_exceeded`: *"This model's maximum context length is 1048576 tokens"* |
  | `deepseek-v4.1-flash-free`, 299,172 tokens, codeword at the end | recalled it |
  | `deepseek-v4.1-flash-free`, 997,077 tokens | accepted, codeword at the end recalled |
  | `deepseek-v4.1-flash-free`, 1.1M tokens | rejected |

  `x-opencode-upstream-model-id` shows why: the free lane routes to the paid
  model (`perplexity/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`,
  `xiaomi/mimo-v2.6-flash`). So the precedence is the **paid sibling** of the
  same id (without `-free`), then the **vendor's models.dev entry** for the
  canonical model (`https://models.dev/api.json`, fetched only when needed,
  cached 24 h), then the free entry's own numbers, then defaults. `big-pickle`
  has neither a sibling nor a canonical entry, so it keeps its advertised
  200K/32K even though it accepted 1,048,570 tokens in the same probe series.

  Pi restores its persisted catalog before any network refresh, so the
  availability filter replaces restored entries with the current discovery and
  drops ids the live endpoint no longer serves; unknown entries such as
  `models.json` additions are kept.
- **Caching**: results land in `~/.pi/agent/opencode-free.json` with a 15 minute
  freshness window, so print-mode runs and headless subagent processes do not
  re-fetch on every start. When both discovery endpoints are unreachable the
  last cache (or a bundled baseline) keeps the provider usable. Pi's models
  store receives the same list whenever Pi runs a catalog refresh.

The catalog is resolved inside an async extension factory, which Pi awaits
before startup model selection, so `pi --model opencode-free/...`, `/model` and
subagents all see the current list.

## When Zen changes the gate again

The error message for `FreeTierError` is explicit about it. To re-derive the
fingerprint, rerun the bisection against a real client:

1. Run `opencode run --standalone -m opencode/<free-model> "hi"` with a capture
   plugin that logs `http.request` headers and body (see the git history of
   this file for the plugin used on 2026-10-16).
2. Replay the captured request with the same headers, then mutate one dimension
   at a time (headers, session id timestamp, tool list, `stream`) until it 403s.
3. Update [`index.ts`](index.ts) accordingly and extend
   [`selftest.ts`](selftest.ts) with the case that changed.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `OPENCODE_FREE_UA` | Full `User-Agent` override |
| `OPENCODE_FREE_VERSION` | OpenCode version used to build the `User-Agent` |
| `OPENCODE_FREE_BASE_URL` | Inference base URL for every model |
| `OPENCODE_FREE_MODELS_URL` | Live model list endpoint |
| `OPENCODE_FREE_CATALOG_URL` | Pi catalog endpoint for the `opencode` provider |
| `OPENCODE_FREE_VERSION_URL` | Endpoint reporting the latest OpenCode version |
| `OPENCODE_FREE_OFFLINE=1` | Skip all discovery requests (use cache/baseline) |

## Test

```bash
bun run pi/extensions/opencode-free/selftest.ts
```

Covers identifier timestamps, fingerprint tool injection, free-model merging
and error rewriting. It does not hit the network; live gate behaviour is
verified by running a prompt:

```bash
pi --model opencode-free/big-pickle -p "Reply with exactly: PONG"
```
