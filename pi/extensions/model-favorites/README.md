# Model Favorites

Adds favorites to pi's model selector. Highlight a model and press **Ctrl+F** to add or remove it.

Favorites appear first in saved order; the current model remains first among non-favorites. Models are identified by their full provider-qualified identity (`provider/model-id`), so equal model IDs from different providers remain distinct.

State is stored at `~/.pi/agent/model-favorites.json` (or `$PI_CODING_AGENT_DIR/model-favorites.json`) with this schema:

```json
{
  "favorites": ["provider/model-id"]
}
```

This extension globally patches pi's `ModelSelectorComponent` prototype. That affects every model selector in the process and relies on non-public selector behavior, so upstream selector changes or other global patches may conflict. A global symbol guard prevents this extension from applying its patch twice.

Run the focused tests with:

```sh
npm test
```
