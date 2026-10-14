import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import { composeSources, readConfigSnapshot } from "../config.ts";

function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "agent-policy-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const directory = join(root, "config");
	mkdirSync(directory);
	const skill = join(root, "SKILL.md");
	writeFileSync(skill, "body\n");
	const configPath = join(directory, "config.json");
	return { root, directory, skill, configPath, config(value: unknown) { writeFileSync(configPath, JSON.stringify(value)); } };
}

test("config snapshot resolves relative, absolute and home paths; reads each normalized source once", (t) => {
	const f = fixture(t);
	const body = "\n# Full instruction body\r\nRead [reference](references/check.md).\r\n---\r\nKeep this later delimiter.\r\n";
	writeFileSync(f.skill, `\uFEFF---\r\nname: fixture\r\ndisable-model-invocation: true\r\n---\r\n${body}`);
	f.config({ common: ["../SKILL.md"], main: [f.skill, `~/${relative(os.homedir(), f.skill)}`], agents: JSON.parse('{"__proto__":["../SKILL.md"],"constructor":[],"security-reviewer":["../SKILL.md"]}') });
	const original = fs.readFileSync;
	const reads = t.mock.method(fs, "readFileSync", (...args: any[]) => Reflect.apply(original, fs, args));
	syncBuiltinESMExports();
	try {
		const snapshot = readConfigSnapshot(f.directory);
		assert.equal(reads.mock.callCount(), 2, "config plus one unique source");
		const text = `## Policy source: ${f.skill}\nResolve this source's relative file references against ${dirname(f.skill)}.\n\n${body}`;
		assert.equal(composeSources(snapshot.common, snapshot.main), text);
		assert.deepEqual(snapshot.agents.get("__proto__"), snapshot.common);
		assert.deepEqual(snapshot.agents.get("constructor"), []);
		assert.equal(snapshot.agents.get("toString"), undefined);
		assert.deepEqual(snapshot.agents.get("security-reviewer"), snapshot.common);
		assert.deepEqual(snapshot.warnings, []);
	} finally { reads.mock.restore(); syncBuiltinESMExports(); }
});

test("optional fields and aliases produce equivalent snapshots; canonical collisions warn and win", (t) => {
	const f = fixture(t);
	f.config({});
	assert.deepEqual(readConfigSnapshot(f.directory), { common: [], child: [], main: [], agents: new Map(), warnings: [] });
	f.config({ common: [f.skill], main: [f.skill], child: [], agents: {} });
	const canonical = readConfigSnapshot(f.directory);
	f.config({ all: [f.skill], orchestrator: [f.skill] });
	assert.deepEqual(readConfigSnapshot(f.directory), canonical);
	f.config({ common: [], all: ["missing.md"], main: [f.skill], orchestrator: ["missing.md"] });
	const collision = readConfigSnapshot(f.directory);
	assert.deepEqual(collision.common, []);
	assert.deepEqual(collision.main, canonical.main);
	assert.equal(collision.warnings.length, 2);
	assert.match(collision.warnings.join("\n"), /canonical common wins/);
	assert.match(collision.warnings.join("\n"), /canonical main wins/);
	f.config({ common: null, all: [f.skill] });
	assert.deepEqual(readConfigSnapshot(f.directory).common, [], "invalid canonical never falls back to alias");
});

test("dedup is first occurrence in assembled layer order then path order", (t) => {
	const f = fixture(t);
	for (const name of ["a", "b", "c", "d"]) writeFileSync(join(f.directory, `${name}.md`), name.toUpperCase());
	f.config({ common: ["b.md", "a.md", "b.md"], child: ["c.md", "a.md"], main: ["d.md", "a.md"], agents: { worker: ["a.md", "d.md", "c.md"] } });
	const s = readConfigSnapshot(f.directory);
	const paths = (text: string) => [...text.matchAll(/## Policy source: (.+)/g)].map((m) => m[1]);
	assert.deepEqual(paths(composeSources(s.common, s.child, s.agents.get("worker")!)), ["b", "a", "c", "d"].map((n) => join(f.directory, `${n}.md`)));
	assert.deepEqual(paths(composeSources(s.common, s.main)), ["b", "a", "d"].map((n) => join(f.directory, `${n}.md`)));
});

test("missing/unreadable config and malformed JSON warn with empty supplemental composition and no legacy fallback", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.directory, "ORCHESTRATOR_APPEND_SYSTEM.md"), "legacy ignored");
	writeFileSync(join(f.directory, "injections.json"), '{"main":["../SKILL.md"]}');
	for (const action of [() => {}, () => writeFileSync(f.configPath, "{bad JSON"), () => { rmSync(f.configPath); mkdirSync(f.configPath); }]) {
		action();
		const snapshot = readConfigSnapshot(f.directory);
		assert.equal(composeSources(snapshot.common, snapshot.main), "");
		assert.equal(snapshot.warnings.length, 1);
		assert.ok(snapshot.warnings[0].includes(f.configPath));
		assert.match(snapshot.warnings[0], /ENOENT|JSON|EISDIR/);
	}
});

test("invalid config types, unknown fields and bad path/mapping entries warn without losing valid siblings", (t) => {
	const f = fixture(t);
	for (const invalid of [null, [], 1, "file"]) {
		f.config(invalid);
		assert.match(readConfigSnapshot(f.directory).warnings[0], /expected an object/);
	}
	for (const invalid of [null, "file", {}, 1]) {
		f.config({ common: invalid, main: [f.skill], agents: invalid });
		const s = readConfigSnapshot(f.directory);
		assert.equal(s.main.length, 1);
		assert.equal(s.warnings.length, typeof invalid === "object" && invalid !== null ? 1 : 2);
	}
	f.config({ typo: [], common: [1, " ", null, "bad\u0000path", f.skill], agents: { worker: "file", unused: [false, f.skill], "": [f.skill], "bad\nname": [] } });
	const s = readConfigSnapshot(f.directory);
	assert.equal(s.common.length, 1);
	assert.equal(s.agents.get("unused")!.length, 1);
	assert.equal(s.warnings.length, 9);
	assert.ok(s.warnings.every((w) => w.includes(f.configPath)));
	assert.match(s.warnings.join("\n"), /unknown top-level key/);
	assert.match(s.warnings.join("\n"), /agents\["unused"\]\[0\]/);
});

test("missing/unreadable sources including unused mappings warn eagerly and retain working siblings", (t) => {
	const f = fixture(t);
	f.config({ main: [f.skill, f.root], agents: { unused: ["missing.md", f.skill] } });
	const s = readConfigSnapshot(f.directory);
	assert.equal(s.main.length, 1);
	assert.equal(s.agents.get("unused")!.length, 1);
	assert.equal(s.warnings.length, 2);
	assert.match(s.warnings.join("\n"), /main\[1\].*EISDIR/);
	assert.match(s.warnings.join("\n"), /agents\["unused"\]\[0\].*missing.md.*ENOENT/);
});

test("frontmatter delimiters must be complete and exact; blank bodies omit, plain Markdown remains verbatim", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.directory, "sibling.md"), "valid sibling");
	f.config({ main: [f.skill, "sibling.md"] });
	for (const malformed of ["---\nname: x", "---", "--- \nname: x\n---\nbody", "---\nname: x\n--- \nbody", "---\nname: x\n---broken\nbody"]) {
		writeFileSync(f.skill, malformed);
		const s = readConfigSnapshot(f.directory);
		assert.match(s.warnings[0], /main\[0\].*SKILL.md.*frontmatter/);
		assert.equal(s.main.length, 1);
		assert.match(composeSources(s.main), /valid sibling/);
	}
	for (const blank of [" \n", "---\nname: x\n---", "\uFEFF---\r\nname: x\r\n---\r\n \r\n"]) {
		writeFileSync(f.skill, blank);
		assert.equal(readConfigSnapshot(f.directory).main.length, 1);
		assert.deepEqual(readConfigSnapshot(f.directory).warnings, []);
	}
	for (const body of ["# Body\n\n---\nunchanged\n", "---not-frontmatter\nbody\n"]) {
		writeFileSync(f.skill, body);
		assert.ok(readConfigSnapshot(f.directory).main[0].text.endsWith(body));
	}
});

test("path-resolution failure warns and skips instead of aborting the snapshot", (t) => {
	const f = fixture(t);
	f.config({ main: [f.skill], child: ["~/broken.md"] });
	const home = t.mock.method(os, "homedir", () => { throw new Error("home unavailable"); });
	syncBuiltinESMExports();
	try {
		const s = readConfigSnapshot(f.directory);
		assert.equal(s.main.length, 1, "valid sibling still loads");
		assert.equal(s.child.length, 0);
		assert.equal(s.warnings.length, 1);
		assert.match(s.warnings[0], /child\[0\].*home unavailable/);
	} finally { home.mock.restore(); syncBuiltinESMExports(); }
});

test("deployed config smoke loads all approved sources and preserves exact moved main body", () => {
	const directory = fileURLToPath(new URL("../", import.meta.url));
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")), { common: [], child: [], main: ["./prompts/main.md"], agents: { worker: ["~/Projects/skills/skills/chadineer/SKILL.md"], reviewer: ["~/Projects/skills/skills/chadineer/SKILL.md"] } });
	const s = readConfigSnapshot(directory);
	assert.equal(s.main.length, 1, "shipped main prompt must load");
	assert.equal(createHash("sha1").update(readFileSync(join(directory, "prompts/main.md"))).digest("hex"), "5de0f6a003d01f7d362f90119662070103423d9f");
	// The Chadineer path is a user source: assert real load only where it is installed.
	if (existsSync(resolve(os.homedir(), "Projects/skills/skills/chadineer/SKILL.md"))) {
		assert.deepEqual(s.warnings, [], "real deployed sources must currently exist");
		assert.equal(s.agents.get("worker")!.length, 1);
		assert.equal(s.agents.get("reviewer")!.length, 1);
	} else {
		assert.equal(s.agents.get("worker")!.length, 0);
		assert.match(s.warnings.join("\n"), /chadineer.*ENOENT/);
	}
});
