# Model blacklist

Hides configured model IDs on configured providers from every in-session model surface. `/model`, `Ctrl+P` cycling, `/scoped-models`, and exact-ID lookups see the provider's catalogue without the blacklisted models. The extension reads `~/.pi/agent/model-blacklist.json` on each application and never creates or repairs it.

- **Automatic:** applied on every `session_start`, including reload, resume, and fork.
- **Manual:** `/model-blacklist` re-reads the config and applies it immediately, without a reload.

## Configuration

Edit **`~/.pi/agent/model-blacklist.json`** (repository: `pi/model-blacklist.json`). The loader uses `join(getAgentDir(), "model-blacklist.json")`, so a custom `PI_CODING_AGENT_DIR` relocates the file to that agent directory:

```json
{
	"providers": {
		"opencode-go": ["glm-5.3-flash", "grok-4.6"],
		"openrouter": ["x-ai/*", "*-free"],
		"cliproxyapi": ["gpt-6.1-sol"]
	},
	"global": ["*-preview"]
}
```

- `providers` maps a provider ID to the model-ID patterns hidden on that provider.
- `global` lists patterns hidden on every provider that currently exposes a model.
- Patterns are case-insensitive full-string globs: `*` matches any run (including empty), `?` matches one character. A pattern without wildcards is an exact ID match. Regex characters are literal.
- Keys starting with `_` are inert, so examples can live next to the live rules.
- Missing file or `{}` hides nothing. Malformed JSON or a non-object root warns and hides nothing. Invalid individual entries warn and are skipped.
- A provider listed in the config but not currently registered is reported by `/model-blacklist`, not at startup.

## Mechanism and limits

On each application the extension wraps the live provider object with `pi.registerProvider()` in its native form, delegating authentication, login, streaming, discovery, and refresh to the original provider. The wrapper:

- removes blacklisted models from `getModels()` and `getAllModels()`;
- removes them from `filterModels()` and `filterAllModels()`, chaining the provider's own policy.

This works uniformly for built-in Pi providers, providers from `models.json`, and providers registered by extensions (legacy config or native object form). Removing a rule restores the provider on the next application instead of waiting for a restart.

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
