import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyPrototypePatchOnce,
	fullModelId,
	readFavorites,
	sortWithFavorites,
	toggleFavorite,
	type ModelIdentity,
	type ModelItem,
} from "../favorites.ts";

function item(provider: string, id: string): ModelItem {
	return { provider, id, model: { provider, id } };
}

function withAgentDir(run: (agentDir: string) => void): void {
	const agentDir = mkdtempSync(join(tmpdir(), "model-favorites-"));
	try {
		run(agentDir);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("uses provider-qualified model identities", () => {
	const left = item("provider-a", "shared-id");
	const right = item("provider-b", "shared-id");

	assert.equal(fullModelId(left.model), "provider-a/shared-id");
	assert.equal(fullModelId(right.model), "provider-b/shared-id");
	assert.deepEqual(
		sortWithFavorites([left, right], undefined, ["provider-b/shared-id"]),
		[right, left],
	);
});

test("orders favorites first while keeping the current non-favorite stable", () => {
	const current = item("z-provider", "current");
	const firstFavorite = item("provider-b", "favorite-b");
	const secondFavorite = item("provider-a", "favorite-a");
	const other = item("a-provider", "other");
	const input = [other, secondFavorite, current, firstFavorite];

	const sorted = sortWithFavorites(input, current.model, [
		"provider-b/favorite-b",
		"provider-a/favorite-a",
	]);

	assert.deepEqual(sorted, [firstFavorite, secondFavorite, current, other]);
	assert.deepEqual(input, [other, secondFavorite, current, firstFavorite]);
});

test("persists toggles in a temporary agent directory", () => {
	withAgentDir((agentDir) => {
		const model: ModelIdentity = { provider: "provider-a", id: "model-1" };

		assert.equal(toggleFavorite(model, agentDir), true);
		assert.deepEqual(readFavorites(agentDir), ["provider-a/model-1"]);
		assert.deepEqual(
			JSON.parse(readFileSync(join(agentDir, "model-favorites.json"), "utf8")),
			{ favorites: ["provider-a/model-1"] },
		);

		assert.equal(toggleFavorite(model, agentDir), false);
		assert.deepEqual(readFavorites(agentDir), []);
	});
});

test("atomic persistence preserves permissions and cleans failed temporary files", () => {
	withAgentDir((agentDir) => {
		const path = join(agentDir, "model-favorites.json");
		writeFileSync(path, `${JSON.stringify({ favorites: [] })}\n`, { mode: 0o640 });
		chmodSync(path, 0o640);
		assert.equal(toggleFavorite({ provider: "provider", id: "model" }, agentDir), true);
		assert.equal(statSync(path).mode & 0o777, 0o640);
		assert.deepEqual(readdirSync(agentDir).filter((name) => name.includes(".tmp")), []);
	});

	withAgentDir((agentDir) => {
		const path = join(agentDir, "model-favorites.json");
		mkdirSync(path);
		writeFileSync(join(path, "old.txt"), "old content");
		assert.throws(() => toggleFavorite({ provider: "provider", id: "model" }, agentDir));
		assert.equal(readFileSync(join(path, "old.txt"), "utf8"), "old content");
		assert.deepEqual(readdirSync(agentDir).filter((name) => name.startsWith("model-favorites.json.") && name.endsWith(".tmp")), []);
	});
});

test("falls back to no favorites for malformed config", () => {
	for (const contents of ["not json", JSON.stringify({ favorites: "provider/model" })]) {
		withAgentDir((agentDir) => {
			writeFileSync(join(agentDir, "model-favorites.json"), contents, "utf8");
			assert.deepEqual(readFavorites(agentDir), []);
		});
	}
});

test("protects prototype patches from duplicate application", () => {
	const prototype = {};
	let applications = 0;

	assert.equal(applyPrototypePatchOnce(prototype, () => applications++), true);
	assert.equal(applyPrototypePatchOnce(prototype, () => applications++), false);
	assert.equal(applications, 1);
});
