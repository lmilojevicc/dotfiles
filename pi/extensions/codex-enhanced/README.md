# Codex Enhanced

Pi extension for viewing Codex subscription quota, safely consuming banked resets, and opting canonical Codex requests into Fast processing.

Use `/codex-enhanced` to open the Quota, Resets, and Fast tabs.

Usage and reset requests are restricted to the canonical `https://chatgpt.com/backend-api` endpoint and canonical OpenAI Codex subscription authentication. Reset consumption requires a two-step confirmation, reuses the same request ID after an ambiguous response, and blocks another reset until usage is refreshed.

Fast mode is stored globally at `~/.pi/agent/codex-enhanced.json` (or `$PI_CODING_AGENT_DIR/codex-enhanced.json` when that agent-directory override is set). It only adds `service_tier: "priority"` to eligible canonical Codex requests that do not already specify a tier.

The extension handles `before_provider_request`, `session_start`, `model_select`, `agent_settled`, and `session_shutdown` to apply Fast mode and keep weekly quota status current.

Run tests without network access:

```sh
npm test
```
