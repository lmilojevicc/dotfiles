# Codex Enhanced

Pi extension for viewing current-account Codex subscription quota, safely consuming banked resets, opting canonical Codex requests into Fast processing, and optionally using OpenAI Responses server compaction.

Use `/codex-enhanced` to open the Quota, Resets, Fast, and Compaction tabs. The menu, quota, weekly status, reset credits, and reset redemption are available regardless of the selected model whenever current `openai-codex` provider authentication resolves. Account operations remain restricted to canonical `https://chatgpt.com/backend-api` subscription authentication.

Reset consumption requires a two-step confirmation. It deterministically chooses the soonest-expiring usable credit, sends the credit ID, current account ID, and idempotent redemption request ID, reuses both IDs after an ambiguous response, and blocks another reset until usage is refreshed.

Settings are stored globally at `~/.pi/agent/codex-enhanced.json` (or `$PI_CODING_AGENT_DIR/codex-enhanced.json` when that agent-directory override is set). Existing Fast-only files continue to work, settings default off, and writes preserve unknown top-level and nested compaction fields.

- **Fast mode** only adds `service_tier: "priority"` to eligible canonical Codex requests that do not already specify a tier.
- **Server compaction** only handles Pi compaction for eligible canonical OpenAI Codex Responses sessions. It requests OpenAI Responses Compaction V2, stores the returned encrypted compaction item in the Pi compaction entry, and replays that opaque history on later requests. Remote errors or missing encrypted content fall back to Pi's normal local compaction. A portable local summary remains in the session for ineligible models.

The extension handles provider requests, compaction, session/model lifecycle events, and settled turns to apply request-scoped settings and keep weekly quota status current.

Run tests without network access:

```sh
npm test
```
