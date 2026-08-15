import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

type Model = { provider: string; id: string; name: string };
type ModelItem = { provider: string; id: string; model: Model };

function item(provider: string, id: string, name = id): ModelItem {
	return { provider, id, model: { provider, id, name } };
}

test("installed Pi selector prototype is patched and handles raw Ctrl+F once", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "model-favorites-runtime-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		writeFileSync(join(agentDir, "model-favorites.json"), `${JSON.stringify({ favorites: ["provider-b/favorite"] })}\n`);
		const piExecutable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
		const distDir = dirname(piExecutable);
		const loaderUrl = pathToFileURL(join(distDir, "core/extensions/loader.js")).href;
		const selectorUrl = pathToFileURL(join(distDir, "modes/interactive/components/model-selector.js")).href;
		const themeUrl = pathToFileURL(join(distDir, "modes/interactive/theme/theme.js")).href;
		const { clearExtensionCache, createExtensionRuntime, loadExtensions } = await import(loaderUrl);
		const { initTheme } = await import(themeUrl);
		initTheme("dark");
		const { ModelSelectorComponent } = await import(selectorUrl);
		const prototype = ModelSelectorComponent.prototype as any;
		const originalHandleInput = prototype.handleInput;
		const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
		const runtime = createExtensionRuntime();

		const firstLoad = await loadExtensions([extensionPath], dirname(extensionPath), undefined, runtime);
		assert.deepEqual(firstLoad.errors, []);
		assert.notEqual(prototype.handleInput, originalHandleInput, "production index patched the installed selector prototype");
		const patchedHandleInput = prototype.handleInput;
		clearExtensionCache();
		const secondLoad = await loadExtensions([extensionPath], dirname(extensionPath), undefined, runtime);
		assert.deepEqual(secondLoad.errors, []);
		assert.equal(prototype.handleInput, patchedHandleInput, "duplicate extension application did not wrap twice");

		const favorite = item("provider-b", "favorite", "Favorite");
		const current = item("provider-a", "current", "Current");
		const other = item("provider-c", "shared", "Other");
		const sameIdDifferentProvider = item("provider-d", "shared", "Other provider");
		const listChildren: unknown[] = [];
		let renders = 0;
		const selector = Object.assign(Object.create(prototype), {
			allModels: [other, current, sameIdDifferentProvider, favorite],
			scopedModelItems: [other, current, sameIdDifferentProvider, favorite],
			activeModels: [other, current, sameIdDifferentProvider, favorite],
			filteredModels: [other, current, sameIdDifferentProvider, favorite],
			selectedIndex: 0,
			currentModel: current.model,
			scope: "all",
			searchInput: { getValue: () => "", handleInput() {} },
			listContainer: {
				clear: () => { listChildren.length = 0; },
				addChild: (child: unknown) => listChildren.push(child),
			},
			tui: { requestRender: () => { renders += 1; } },
		});

		selector.allModels = selector.sortModels(selector.allModels);
		selector.scopedModelItems = selector.sortModels(selector.scopedModelItems);
		selector.activeModels = selector.allModels;
		selector.filteredModels = selector.activeModels;
		assert.deepEqual(selector.filteredModels.map((entry: ModelItem) => `${entry.provider}/${entry.id}`), [
			"provider-b/favorite",
			"provider-a/current",
			"provider-c/shared",
			"provider-d/shared",
		]);

		selector.selectedIndex = 1;
		selector.filterModels("current");
		assert.deepEqual(selector.filteredModels.map((entry: ModelItem) => entry.id), ["current"]);
		selector.filterModels("");
		assert.equal(selector.filteredModels[selector.selectedIndex]?.id, "current", "selection restored by identity");

		selector.selectedIndex = selector.filteredModels.findIndex(
			(entry: ModelItem) => entry.provider === "provider-d" && entry.id === "shared",
		);
		selector.handleInput("\x06");
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "model-favorites.json"), "utf8")).favorites, [
			"provider-b/favorite",
			"provider-d/shared",
		]);
		assert.equal(selector.filteredModels[selector.selectedIndex]?.provider, "provider-d");
		assert.equal(selector.filteredModels[selector.selectedIndex]?.id, "shared");
		assert.equal(renders, 1);
		assert.ok(listChildren.length > 0, "patched installed renderer populated the list");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
