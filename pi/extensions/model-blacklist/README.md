# Model blacklist

Hides configured model IDs on configured providers from every in-session model surface. `/model`, `Ctrl+P` cycling, `/scoped-models`, and exact-ID lookups see the provider's catalogue without the blacklisted models. The extension reads `~/.pi/agent/model-blacklist.json` on each application and never creates or repairs it.

- **Automatic:** applied on every `session_start`, including reload, resume, and fork.
- **Manual:** `/model-blacklist` re-reads the config and applies it immediately, without a reload.

## Configuration

Edit **`~/.pi/agent/model-blacklist.json`** (repository: `pi/model-blacklist.json`). The loader uses `join(getAgentDir(), "model-blacklist.json")`, so a custom `PI_CODING_AGENT_DIR` relocates the file to that agent directory:

```json
{
	"providers": {
		"openai": ["!gpt-6*"],
		"antigravity": ["!gemini-3.8+", "!claude-opus-5+", "!claude-sonnet-5+"],
		"opencode-go": ["glm-5.3-flash", "grok-4.6"],
		"openrouter": ["x-ai/*", "*-free"],
		"cliproxyapi": ["gpt-6.1-sol"]
	},
	"global": ["*-preview"]
}
```

- `providers` maps a provider ID to the model-ID patterns hidden on that provider. A lone `"*"` hides every model the provider exposes, e.g. `"openai-codex": ["*"]` keeps that provider's auth and quota surfaces while removing all of its models from selection.
- `global` lists patterns hidden on every provider that currently exposes a model.
- Patterns are case-insensitive full-string globs: `*` matches any run (including empty), `?` matches one character. A pattern without wildcards is an exact ID match. Regex characters are literal.
- A `!`-prefixed pattern negates, like `grep -v`: it hides every model on that provider the glob does **not** match, while an unprefixed pattern hides only what it matches. `"openai": ["!gpt-6*"]` therefore shows the GPT-6 family and hides the provider's `gpt-4*`, `gpt-5*`, `o*`, and every later family.
- A trailing `+` makes the pattern a version threshold: it matches its version and every newer one, so `gemini-3.8+` keeps `gemini-3.8-flash`, `gemini-3.10-pro` and `gemini-4-flash` while hiding `gemini-3.7-flash`. Versions compare per numeric segment, dotted or dashed, so `claude-opus-5+` keeps `claude-opus-5-5-high` but hides `claude-opus-4-6`. Wildcards are literal inside a threshold prefix. `"antigravity": ["!gemini-3.8+", "!claude-opus-5+", "!claude-sonnet-5+"]` therefore shows only Gemini 3.8-or-newer and Claude Opus/Sonnet 5.0-or-newer from that provider.
- Plain patterns win over negations, so `["!gpt-6*", "gpt-6-sol"]` hides `gpt-6-sol` even though it matches the negation. A negation inside a provider list gates only that provider: a provider with no `!` pattern is unaffected. A negation in `global` gates every provider that exposes a model, so use one deliberately.
- `!` always negates and is never escaped; a negation with no glob (`"!"`) is invalid and warns.
- A trailing `+` is always a threshold, so a miswritten one (`"gemini-3.8-flash+"`, `"3.8+"`) is invalid and warns instead of silently matching nothing.
- Keys starting with `_` are inert, so examples can live next to the live rules.
- Missing file or `{}` hides nothing. Malformed JSON or a non-object root warns and hides nothing. Invalid individual entries warn and are skipped.
- A provider listed in the config but not currently registered is reported by `/model-blacklist`, not at startup.

## Mechanism and limits

On each application the extension wraps the live provider object with `pi.registerProvider()` in its native form, delegating authentication, login, streaming, discovery, and refresh to the original provider. The wrapper:

- removes blacklisted models from `getModels()` and `getAllModels()`;
- removes them from `filterModels()` and `filterAllModels()`, chaining the provider's own policy.

This works uniformly for built-in Pi providers, providers from `models.json`, and providers registered by extensions (legacy config or native object form). Removing a rule restores the provider on the next application instead of waiting for a restart.

Some providers register again after `session_start`. Command Code, for example, loads its live catalogue in the background and calls `pi.registerProvider()` again, which would replace the wrapper. Pi has no event for registry changes, so the first application also patches `registerProvider` and `registerNativeProvider` on the session's `ModelRuntime` (reached through `ctx.modelRegistry.runtime`). Any later registration of a targeted provider is wrapped with the current rules as it lands. The patch is installed once per runtime and reads the latest rules, so it survives `/reload`. On hosts that don't expose the runtime, the patch is skipped and `/model-blacklist` re-applies by hand.

Known limits:

- **Startup resolution is not filtered.** `pi --list-models`, `--model`/`--provider`/`--models`, and the `defaultModel` setting resolve before `session_start`, so a blacklisted model can still start a session or appear in `--list-models`. It is not shown by any in-session surface afterwards.
- **`models.json` model definitions stay in the raw catalogue.** `models.json` is composed above the provider, so those IDs remain visible to `getModels()` even though availability filtering hides them from the picker, cycling, and scoped models. Built-in and extension-provider models are removed from both.
- **No hard block.** A blacklisted model already active or passed at startup keeps working; the extension only hides it from selection surfaces.
- **Non-chat models** (image, classifier) are filtered too, since the wrapper overrides `filterAllModels`.

## Tests

From this directory:

```sh
npm test
```
