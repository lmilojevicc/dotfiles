import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TASKS_CONFIG, loadGlobalTasksConfig, saveGlobalTasksConfig, type TaskDisplayConfig } from "../src/config/tasks-config.ts";

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "tasks-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	return { root, cwd, agent, project: join(cwd, ".pi", "tasks-config.json"), global: join(agent, "tasks-config.json") };
}

function symlink(t: TestContext, target: string, path: string, directory = false): boolean {
	try {
		symlinkSync(target, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
			t.skip(`symlinks unavailable: ${code}`);
			return false;
		}
		throw error;
	}
}

test("global defaults and independent invalid-value fallback are safe", (t) => {
	const f = fixture(t);
	assert.deepEqual(loadGlobalTasksConfig(f.agent), DEFAULT_TASKS_CONFIG);
	writeFileSync(f.global, JSON.stringify({
		collapseCompleted: "yes", showAll: true, maxVisible: -1, sortOrder: "wat", hiddenAt: "side",
		glyphs: { pending: "", completed: "C", spinner: [], header: "\u001b[31m" },
	}));
	assert.deepEqual(loadGlobalTasksConfig(f.agent), { ...DEFAULT_TASKS_CONFIG, showAll: true, glyphs: { completed: "C" } });
});

test("global settings round-trip across cwd and respect PI_CODING_AGENT_DIR while legacy project settings stay untouched", (t) => {
	const f = fixture(t);
	const other = join(f.root, "other-project");
	mkdirSync(join(other, ".pi"), { recursive: true });
	const otherProject = join(other, ".pi", "tasks-config.json");
	const legacy = JSON.stringify({ showAll: false, maxVisible: 5, glyphs: { pending: "project" } });
	writeFileSync(f.project, legacy);
	writeFileSync(otherProject, "{ malformed legacy settings\n");
	const originalCwd = process.cwd();
	const originalAgent = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		process.chdir(originalCwd);
		if (originalAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgent;
	});
	process.env.PI_CODING_AGENT_DIR = f.agent;
	process.chdir(f.cwd);
	// No global file: project preferences are neither loaded nor promoted.
	assert.deepEqual(loadGlobalTasksConfig(), DEFAULT_TASKS_CONFIG);
	const config: TaskDisplayConfig = {
		collapseCompleted: true, showAll: true, maxVisible: 30, sortOrder: "active", hiddenAt: "top",
		glyphs: { pending: "P", completed: "C", spinner: ["1", "2"] },
	};
	saveGlobalTasksConfig(config);
	process.chdir(other);
	assert.deepEqual(loadGlobalTasksConfig(), config);
	saveGlobalTasksConfig({ maxVisible: 20 });
	process.chdir(f.cwd);
	assert.deepEqual(loadGlobalTasksConfig(), { ...config, maxVisible: 20 });
	assert.equal(readFileSync(f.project, "utf8"), legacy);
	assert.equal(readFileSync(otherProject, "utf8"), "{ malformed legacy settings\n");
	assert.deepEqual(readdirSync(join(f.cwd, ".pi")), ["tasks-config.json"]);
	assert.deepEqual(readdirSync(join(other, ".pi")), ["tasks-config.json"]);
});

test("global save retains unknown keys, custom sorts and glyphs while persisting explicit default values", (t) => {
	const f = fixture(t);
	const existing = {
		taskScope: "project", future: { keep: true }, showAll: true, maxVisible: 20,
		sortOrder: [{ field: "updatedAt", direction: "desc" }],
		glyphs: { pending: "P", spinner: ["a", "b"], futureGlyph: { keep: true } },
	};
	writeFileSync(f.global, JSON.stringify(existing));
	saveGlobalTasksConfig({ showAll: false, maxVisible: 10 }, f.agent);
	assert.deepEqual(JSON.parse(readFileSync(f.global, "utf8")), { ...existing, showAll: false, maxVisible: 10 });
	assert.deepEqual(loadGlobalTasksConfig(f.agent), {
		...DEFAULT_TASKS_CONFIG, sortOrder: existing.sortOrder, glyphs: { pending: "P", spinner: ["a", "b"] },
	});
	saveGlobalTasksConfig({ glyphs: { completed: "C" } }, f.agent);
	assert.deepEqual(JSON.parse(readFileSync(f.global, "utf8")).glyphs, { ...existing.glyphs, completed: "C" });
	saveGlobalTasksConfig({ collapseCompleted: true, hiddenAt: "top", sortOrder: "recent" }, f.agent);
	saveGlobalTasksConfig(DEFAULT_TASKS_CONFIG, f.agent);
	const saved = JSON.parse(readFileSync(f.global, "utf8"));
	for (const key of ["collapseCompleted", "showAll", "maxVisible", "sortOrder", "hiddenAt"] as const) {
		assert.deepEqual(saved[key], DEFAULT_TASKS_CONFIG[key]);
	}
	assert.deepEqual(saved.future, existing.future);
	assert.equal(readFileSync(f.global, "utf8").includes("\n  \""), true);
	assert.deepEqual(readdirSync(f.agent), ["tasks-config.json"]);
	if (process.platform !== "win32") assert.equal(lstatSync(f.global).mode & 0o777, 0o600);
	assert.equal(existsSync(f.project), false);
});

for (const contents of ["{ not json\n", "null", "[]", "true", "42", '"text"']) {
	test(`invalid global root ${JSON.stringify(contents)} falls back and is unchanged when save is rejected`, (t) => {
		const f = fixture(t);
		writeFileSync(f.global, contents);
		assert.deepEqual(loadGlobalTasksConfig(f.agent), DEFAULT_TASKS_CONFIG);
		assert.throws(() => saveGlobalTasksConfig(DEFAULT_TASKS_CONFIG, f.agent), /malformed JSON|must contain a JSON object/);
		assert.equal(readFileSync(f.global, "utf8"), contents);
		assert.deepEqual(readdirSync(f.agent), ["tasks-config.json"]);
	});
}

test("unreadable global config falls back and is unchanged when save is rejected", {
	skip: process.platform === "win32" || process.getuid?.() === 0 ? "requires POSIX read permissions without root bypass" : false,
}, (t) => {
	const f = fixture(t);
	const original = JSON.stringify({ future: { keep: true } });
	writeFileSync(f.global, original);
	chmodSync(f.global, 0o000);
	try {
		assert.deepEqual(loadGlobalTasksConfig(f.agent), DEFAULT_TASKS_CONFIG);
		assert.throws(() => saveGlobalTasksConfig(DEFAULT_TASKS_CONFIG, f.agent), /Could not read existing task config/);
	} finally {
		chmodSync(f.global, 0o600);
	}
	assert.equal(readFileSync(f.global, "utf8"), original);
	assert.deepEqual(readdirSync(f.agent), ["tasks-config.json"]);
});

for (const targetKind of ["outside", "inside", "missing"] as const) {
	test(`global config symlink to ${targetKind} target is ignored and never replaced or written through`, (t) => {
		const f = fixture(t);
		const target = join(targetKind === "inside" ? f.agent : f.root, "target.json");
		const original = JSON.stringify({ showAll: true, future: "unchanged" });
		if (targetKind !== "missing") writeFileSync(target, original);
		if (!symlink(t, target, f.global)) return;
		assert.deepEqual(loadGlobalTasksConfig(f.agent), DEFAULT_TASKS_CONFIG);
		assert.throws(() => saveGlobalTasksConfig(DEFAULT_TASKS_CONFIG, f.agent), /symlinked task config/);
		assert.ok(lstatSync(f.global).isSymbolicLink());
		if (targetKind === "missing") assert.equal(existsSync(target), false);
		else assert.equal(readFileSync(target, "utf8"), original);
		assert.ok(readdirSync(f.agent).every((name) => !name.endsWith(".tmp")));
	});
}

test("global config directory is ignored and saving refuses to replace it", (t) => {
	const f = fixture(t);
	mkdirSync(f.global);
	writeFileSync(join(f.global, "keep"), "unchanged");
	assert.deepEqual(loadGlobalTasksConfig(f.agent), DEFAULT_TASKS_CONFIG);
	assert.throws(() => saveGlobalTasksConfig(DEFAULT_TASKS_CONFIG, f.agent), /not a regular file/);
	assert.equal(readFileSync(join(f.global, "keep"), "utf8"), "unchanged");
});

test("save supports a deliberately symlinked agent directory", (t) => {
	const f = fixture(t);
	const alias = join(f.root, "agent-alias");
	if (!symlink(t, f.agent, alias, true)) return;
	saveGlobalTasksConfig({ showAll: true }, alias);
	assert.deepEqual(loadGlobalTasksConfig(alias), { ...DEFAULT_TASKS_CONFIG, showAll: true });
	assert.deepEqual(JSON.parse(readFileSync(f.global, "utf8")), { showAll: true });
	assert.ok(lstatSync(alias).isSymbolicLink());
	assert.equal(existsSync(f.project), false);
});

test("save creates a missing global directory without creating project config", (t) => {
	const f = fixture(t);
	const agent = join(f.root, "missing", "agent");
	saveGlobalTasksConfig({ showAll: true }, agent);
	assert.deepEqual(loadGlobalTasksConfig(agent), { ...DEFAULT_TASKS_CONFIG, showAll: true });
	assert.equal(existsSync(f.project), false);
});

test("failed atomic serialization leaves existing global config intact and removes its temporary file", (t) => {
	const f = fixture(t);
	const original = JSON.stringify({ future: "unchanged" });
	writeFileSync(f.global, original);
	const circular: any = [];
	circular.push(circular);
	assert.throws(() => saveGlobalTasksConfig({ sortOrder: circular }, f.agent), /circular/i);
	assert.equal(readFileSync(f.global, "utf8"), original);
	assert.deepEqual(readdirSync(f.agent), ["tasks-config.json"]);
});

test("exclusive temporary-file creation never overwrites or removes an existing file", (t) => {
	const f = fixture(t);
	t.mock.method(Date, "now", () => 123);
	const temporary = `${f.global}.${process.pid}.123.tmp`;
	writeFileSync(temporary, "unchanged");
	assert.throws(() => saveGlobalTasksConfig(DEFAULT_TASKS_CONFIG, f.agent), /EEXIST/);
	assert.equal(readFileSync(temporary, "utf8"), "unchanged");
	assert.equal(existsSync(f.global), false);
});
