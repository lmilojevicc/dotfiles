import test from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
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
import { DEFAULT_TASKS_CONFIG, loadTasksConfig, saveTasksConfig } from "../src/config/tasks-config.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "tasks-config-"));
	const cwd = join(root, "project");
	const agent = join(root, "agent");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(agent, { recursive: true });
	return { root, cwd, agent, project: join(cwd, ".pi", "tasks-config.json"), global: join(agent, "tasks-config.json") };
}

test("defaults and independent invalid-value fallback are safe", () => {
	const f = fixture();
	writeFileSync(f.project, JSON.stringify({ collapseCompleted: "yes", maxVisible: -1, sortOrder: "wat", hiddenAt: "side" }));
	assert.deepEqual(loadTasksConfig(f.cwd, f.agent), DEFAULT_TASKS_CONFIG);
});

test("valid project fields override global while invalid scalars and glyphs fall through", () => {
	const f = fixture();
	writeFileSync(f.global, JSON.stringify({
		collapseCompleted: true,
		showAll: false,
		maxVisible: 30,
		sortOrder: "status",
		hiddenAt: "top",
		glyphs: { pending: "P", completed: "C", spinner: ["1", "2"], header: "H" },
	}));
	writeFileSync(f.project, JSON.stringify({
		collapseCompleted: "yes",
		showAll: true,
		maxVisible: -1,
		sortOrder: "recent",
		hiddenAt: "side",
		glyphs: { pending: "", completed: "c", spinner: [], header: "h" },
	}));
	assert.deepEqual(loadTasksConfig(f.cwd, f.agent), {
		collapseCompleted: true,
		showAll: true,
		maxVisible: 30,
		sortOrder: "recent",
		hiddenAt: "top",
		glyphs: { pending: "P", completed: "c", spinner: ["1", "2"], header: "h" },
	});
});

test("project overrides global and glyphs merge one level deeper", () => {
	const f = fixture();
	writeFileSync(f.global, JSON.stringify({ showAll: true, maxVisible: 30, glyphs: { pending: "P", completed: "C" } }));
	writeFileSync(f.project, JSON.stringify({ maxVisible: 5, glyphs: { pending: "p" } }));
	assert.deepEqual(loadTasksConfig(f.cwd, f.agent), { ...DEFAULT_TASKS_CONFIG, showAll: true, maxVisible: 5, glyphs: { pending: "p", completed: "C" } });
});

test("atomic project save keeps unknown architecture keys and writes only display overrides", () => {
	const f = fixture();
	writeFileSync(f.global, JSON.stringify({ showAll: true, maxVisible: 10 }));
	writeFileSync(f.project, JSON.stringify({ taskScope: "project", future: { keep: true }, showAll: false }));
	saveTasksConfig({ ...DEFAULT_TASKS_CONFIG, showAll: true, maxVisible: 20 }, f.cwd, f.agent);
	const saved = JSON.parse(readFileSync(f.project, "utf8"));
	assert.deepEqual(saved, { taskScope: "project", future: { keep: true }, maxVisible: 20 });
	assert.equal(readFileSync(f.project, "utf8").includes("\n  \""), true);
});

test("malformed existing project config is unchanged when save is rejected", () => {
	const f = fixture();
	const malformed = "{ not json\n";
	writeFileSync(f.project, malformed);
	assert.throws(() => saveTasksConfig(DEFAULT_TASKS_CONFIG, f.cwd, f.agent), /malformed JSON/);
	assert.equal(readFileSync(f.project, "utf8"), malformed);
	assert.deepEqual(readdirSync(join(f.cwd, ".pi")), ["tasks-config.json"]);
});

test("unreadable existing project config is unchanged when save is rejected", {
	skip: process.platform === "win32" ? "POSIX read permission bits are unavailable on Windows" : false,
}, () => {
	const f = fixture();
	const original = JSON.stringify({ future: { keep: true } });
	writeFileSync(f.project, original);
	chmodSync(f.project, 0o000);
	try {
		assert.throws(() => saveTasksConfig(DEFAULT_TASKS_CONFIG, f.cwd, f.agent), /Could not read existing task config/);
	} finally {
		chmodSync(f.project, 0o600);
	}
	assert.equal(readFileSync(f.project, "utf8"), original);
	assert.deepEqual(readdirSync(join(f.cwd, ".pi")), ["tasks-config.json"]);
});

test("save rejects a symlinked .pi directory without changing the escaped config", (t) => {
	const f = fixture();
	const outside = join(f.root, "outside");
	const escaped = join(outside, "tasks-config.json");
	mkdirSync(outside);
	writeFileSync(escaped, JSON.stringify({ future: "unchanged" }));
	rmSync(join(f.cwd, ".pi"), { recursive: true });
	try {
		symlinkSync(outside, join(f.cwd, ".pi"), process.platform === "win32" ? "junction" : "dir");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
			t.skip(`directory symlinks unavailable: ${code}`);
			return;
		}
		throw error;
	}
	assert.throws(() => saveTasksConfig(DEFAULT_TASKS_CONFIG, f.cwd, f.agent), /symlinked directory/);
	assert.deepEqual(JSON.parse(readFileSync(escaped, "utf8")), { future: "unchanged" });
});

test("save rejects an existing config symlink that resolves outside the project root", (t) => {
	const f = fixture();
	const escaped = join(f.root, "escaped-config.json");
	writeFileSync(escaped, JSON.stringify({ future: "unchanged" }));
	try {
		symlinkSync(escaped, f.project, "file");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
			t.skip(`file symlinks unavailable: ${code}`);
			return;
		}
		throw error;
	}
	assert.throws(() => saveTasksConfig(DEFAULT_TASKS_CONFIG, f.cwd, f.agent), /outside the project root/);
	assert.deepEqual(JSON.parse(readFileSync(escaped, "utf8")), { future: "unchanged" });
});

test("save creates and writes a real .pi directory inside the canonical project root", () => {
	const f = fixture();
	rmSync(join(f.cwd, ".pi"), { recursive: true });
	saveTasksConfig({ ...DEFAULT_TASKS_CONFIG, showAll: true }, f.cwd, f.agent);
	assert.deepEqual(JSON.parse(readFileSync(f.project, "utf8")), { showAll: true });
});
