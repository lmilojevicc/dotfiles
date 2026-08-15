import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function item(provider: string, id: string, name = id) {
	const model = { provider, id, name };
	return { provider, id, model };
}

test("actual selector patch orders, filters, restores selection, toggles, and applies once", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "model-favorites-selector-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(join(agentDir, "model-favorites.json"), `${JSON.stringify({ favorites: ["provider-b/favorite"] })}\n`);
		const codingAgent = await import("@earendil-works/pi-coding-agent");
		const { default: extension } = await import("../index.ts");
		extension({} as never);
		extension({} as never);

		const favorite = item("provider-b", "favorite", "Favorite");
		const current = item("provider-a", "current", "Current");
		const other = item("provider-c", "other", "Other");
		const listChildren: unknown[] = [];
		let renders = 0;
		const selector = Object.assign(new codingAgent.ModelSelectorComponent(), {
			allModels: [other, current, favorite],
			scopedModelItems: [other, current, favorite],
			activeModels: [other, current, favorite],
			filteredModels: [other, current, favorite],
			selectedIndex: 0,
			currentModel: current.model,
			scope: "all",
			searchInput: { getValue: () => "", handleInput() {} },
			listContainer: {
				clear: () => { listChildren.length = 0; },
				addChild: (child: unknown) => listChildren.push(child),
			},
			tui: { requestRender: () => renders++ },
		});

		await selector.loadModels();
		assert.deepEqual(selector.filteredModels.map((entry: any) => `${entry.provider}/${entry.id}`), [
			"provider-b/favorite", "provider-a/current", "provider-c/other",
		]);
		assert.equal(selector.selectedIndex, 0);

		selector.selectedIndex = 1;
		selector.filterModels("provider-a");
		assert.deepEqual(selector.filteredModels.map((entry: any) => entry.id), ["current"]);
		assert.equal(selector.selectedIndex, 0);
		selector.filterModels("");
		assert.equal(selector.filteredModels[selector.selectedIndex]?.id, "current", "selection restored by identity");

		selector.selectedIndex = selector.filteredModels.findIndex((entry: any) => entry.id === "other");
		selector.handleInput("ctrl+f");
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "model-favorites.json"), "utf8")).favorites, [
			"provider-b/favorite", "provider-c/other",
		]);
		assert.equal(selector.filteredModels[selector.selectedIndex]?.id, "other");
		assert.equal(renders, 1, "duplicate extension application did not double-toggle");
		assert.ok(listChildren.length > 0, "patched renderer populated the list");

		selector.handleInput("ordinary");
		assert.deepEqual((selector as any).originalInputs, ["ordinary"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
