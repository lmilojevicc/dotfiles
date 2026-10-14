import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { readInjectionSnapshot } from "../injections.ts";

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "agent-policy-injections-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, "config");
	mkdirSync(directory);
	const skill = join(root, "SKILL.md");
	writeFileSync(skill, "body\n");
	const configPath = join(directory, "injections.json");
	return { root, directory, skill, configPath, config(value: unknown) { writeFileSync(configPath, JSON.stringify(value)); } };
}

test("injections snapshot resolves relative, absolute and home paths in order with full bodies and reference headers", (t) => {
	const f = fixture(t);
	const body = "\n# Full instruction body\r\nRead [reference](references/check.md).\r\n---\r\nKeep this later delimiter.\r\n";
	writeFileSync(f.skill, `\uFEFF---\r\nname: fixture\r\ndisable-model-invocation: true\r\n---\r\n${body}`);
	// ~/ expansion can point outside home without writing there.
	const homePath = `~/${relative(homedir(), f.skill)}`;
	f.config({ main: ["../SKILL.md", f.skill, homePath], agents: JSON.parse('{"__proto__":["../SKILL.md"],"constructor":[],"security-reviewer":["../SKILL.md"]}') });
	const snapshot = readInjectionSnapshot(f.directory);
	assert.equal(snapshot.main.length, 3);
	for (const text of snapshot.main) {
		assert.equal(text, `## Injected skill: ${f.skill}\nResolve this skill's relative file references against ${dirname(f.skill)}.\n\n${body}`);
		assert.doesNotMatch(text, /name: fixture|disable-model-invocation/);
	}
	assert.deepEqual(snapshot.agents.get("__proto__"), [snapshot.main[0]]);
	assert.deepEqual(snapshot.agents.get("constructor"), []);
	assert.equal(snapshot.agents.get("toString"), undefined);
	assert.deepEqual(snapshot.agents.get("security-reviewer"), [snapshot.main[0]]);
});

test("absent config is optional, but present JSON, field typos and mapping shapes fail explicitly", (t) => {
	const f = fixture(t);
	assert.deepEqual(readInjectionSnapshot(f.directory), { main: [], agents: new Map() });
	for (const invalid of [null, [], {}, { main: [] }, { agents: {} }, { main: [], agents: {}, version: 1 }, { main: [], agent: {} }, { main: "file", agents: {} }, { main: [], agents: [] }, { main: [1], agents: {} }, { main: [" "], agents: {} }, { main: [], agents: { worker: "file" } }, { main: [], agents: { worker: [null] } }]) {
		f.config(invalid);
		assert.throws(() => readInjectionSnapshot(f.directory), (error: any) => {
			assert.ok(error.message.includes(f.configPath));
			assert.match(error.message, /agent-policy:.*expected/);
			assert.ok(error.cause);
			return true;
		});
	}
	writeFileSync(f.configPath, "{bad JSON");
	assert.throws(() => readInjectionSnapshot(f.directory), /agent-policy:.*JSON/);
	rmSync(f.configPath);
	mkdirSync(f.configPath);
	assert.throws(() => readInjectionSnapshot(f.directory), /agent-policy:.*EISDIR/);
});

test("all configured files, even unused agent mappings, must be readable at initialization with mapping/file causes", (t) => {
	const f = fixture(t);
	f.config({ main: [], agents: { unused: ["missing.md"] } });
	assert.throws(() => readInjectionSnapshot(f.directory), (error: any) => {
		assert.match(error.message, /agents\["unused"\]\[0\].*missing.md.*ENOENT/);
		assert.equal(error.cause.cause.code, "ENOENT");
		return true;
	});
	f.config({ main: [f.root], agents: {} });
	assert.throws(() => readInjectionSnapshot(f.directory), /main\[0\].*EISDIR/);
});

test("frontmatter delimiters must be complete and exact; blank bodies omit, plain Markdown remains verbatim", (t) => {
	const f = fixture(t);
	f.config({ main: [f.skill], agents: {} });
	for (const malformed of ["---\nname: x", "---", "--- \nname: x\n---\nbody", "---\nname: x\n--- \nbody", "---\nname: x\n---broken\nbody"]) {
		writeFileSync(f.skill, malformed);
		assert.throws(() => readInjectionSnapshot(f.directory), /agent-policy:.*main\[0\].*SKILL.md.*frontmatter/);
	}
	for (const blank of [" \n", "---\nname: x\n---", "\uFEFF---\r\nname: x\r\n---\r\n \r\n"]) {
		writeFileSync(f.skill, blank);
		assert.deepEqual(readInjectionSnapshot(f.directory).main, []);
	}
	for (const body of ["# Body\n\n---\nunchanged\n", "---not-frontmatter\nbody\n"]) {
		writeFileSync(f.skill, body);
		assert.ok(readInjectionSnapshot(f.directory).main[0].endsWith(body));
	}
});

test("initial deployed config has only approved worker/reviewer Chadineer inputs and empty main", () => {
	const config = JSON.parse(readFileSync(new URL("../injections.json", import.meta.url), "utf8"));
	assert.deepEqual(config, { main: [], agents: { worker: ["~/Projects/skills/skills/chadineer/SKILL.md"], reviewer: ["~/Projects/skills/skills/chadineer/SKILL.md"] } });
});
