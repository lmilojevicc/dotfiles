import { SettingsManager } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	discoverInventory,
	discoverLocalExtensions,
	isPinnedSource,
	localExtensionId,
	settingsSources,
} from "../discovery.ts";

test("pinned sources are refused and scoped names are not pins", () => {
	for (const source of ["npm:pi-subagents", "npm:@scope/pkg", "git:github.com/a/b", "./local"]) {
		assert.equal(isPinnedSource(source), false, source);
	}
	assert.equal(isPinnedSource("npm:pi-subagents@0.77.0"), true);
	assert.equal(isPinnedSource("npm:@scope/pkg@1.0.0"), true);
	assert.equal(isPinnedSource("npm:@narumitw/pi-goal"), false);
	assert.equal(isPinnedSource("git:github.com/a/b#v1"), true);
	assert.equal(isPinnedSource("https://example.com/x#v1"), true);
});

test("local ids are agent-relative and never climb out with ..", () => {
	assert.equal(localExtensionId("/agent", "/agent/extensions/x/index.ts"), "extensions/x/index.ts");
	assert.equal(localExtensionId("/agent", "/elsewhere/index.ts"), "/elsewhere/index.ts");
});

test("settings sources dedupe legacy object entries and keep their order", () => {
	assert.deepEqual(
		settingsSources(["npm:b", { source: "npm:a", extensions: [] }, "npm:b"]),
		["npm:b", "npm:a"],
	);
});

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "extension-manager-discovery-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, agentDir, cwd };
}

function file(path: string, body = "export default function () {}\n"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
}

function packageWithIndex(directory: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({
		name: directory.split("/").pop(),
		version: "1.0.0",
		pi: { extensions: ["./index.ts"] },
	}));
	file(join(directory, "index.ts"));
}

async function discover(agentDir: string, cwd: string, excludePaths?: string[]) {
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	return await discoverLocalExtensions({ cwd, agentDir, settingsManager, excludePaths });
}

test("local discovery reports every entrypoint with Pi's own enabled state", async (t) => {
	const { agentDir, cwd } = fixture(t);
	packageWithIndex(join(agentDir, "extensions", "on"));
	packageWithIndex(join(agentDir, "extensions", "off"));
	file(join(agentDir, "extensions", "loose.ts"));
	file(join(agentDir, "extensions", "config-only", "config.json"), "{}\n");
	file(join(agentDir, "extensions", "extension-manager", "loader.ts"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		extensions: ["extensions/extension-manager/loader.ts", "-extensions/off/index.ts", "-builtin:mcp"],
	}));

	const entries = await discover(agentDir, cwd, [join(agentDir, "extensions", "extension-manager", "loader.ts")]);
	assert.deepEqual(entries.map((entry) => [entry.id, entry.enabled]), [
		["extensions/loose.ts", true],
		["extensions/off/index.ts", false],
		["extensions/on/index.ts", true],
	]);
	assert.deepEqual(entries[2].path, join(agentDir, "extensions", "on", "index.ts"));
});

test("a hand-written exclusion without a config entry is still discovered as disabled", async (t) => {
	const { agentDir, cwd } = fixture(t);
	packageWithIndex(join(agentDir, "extensions", "off"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		extensions: ["-extensions/off/index.ts"],
	}));

	const entries = await discover(agentDir, cwd);
	assert.deepEqual(entries.map((entry) => [entry.id, entry.enabled]), [["extensions/off/index.ts", false]]);
});

test("the inventory lists settings packages, owned packages and local extensions", async (t) => {
	const { agentDir, cwd } = fixture(t);
	packageWithIndex(join(agentDir, "extensions", "local-ext"));
	const installed = new Set(["npm:installed", "git:github.com/a/b"]);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: ["npm:installed", { source: "npm:filtered", extensions: [] }],
	}));

	const inventory = await discoverInventory({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		ownedPackages: ["git:github.com/a/b", "npm:installed", "npm:gone"],
		probeInstalled: (source) => installed.has(source) ? `/installed/${source}` : undefined,
	});

	assert.deepEqual(inventory.entries.map((entry) => [entry.kind, entry.id, entry.kind === "package" ? entry.installed : true]), [
		["package", "npm:installed", true],
		["package", "npm:filtered", false],
		["package", "git:github.com/a/b", true],
		["package", "npm:gone", false],
		["local", "extensions/local-ext/index.ts", true],
	]);
});

test("discovery never installs a missing package", async (t) => {
	const { agentDir, cwd } = fixture(t);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: ["npm:missing-package"],
	}));
	const entries = await discover(agentDir, cwd);
	assert.deepEqual(entries, []);
});
