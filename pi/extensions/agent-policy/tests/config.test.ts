import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { composeSources, readConfigSnapshot } from "../config.ts";
import { resolvePolicyConfigPath } from "../config-path.ts";

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
	assert.deepEqual(readConfigSnapshot(f.directory), { common: [], child: [], main: [], mainBb: [], agents: new Map(), warnings: [] });
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

test("mainBb is an independent optional layer with no alias and no fallback to main", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.directory, "bb.md"), "bb main");
	f.config({ main: [f.skill] });
	assert.deepEqual(readConfigSnapshot(f.directory).mainBb, [], "absent mainBb stays empty, never a main copy");
	f.config({ main: [f.skill], mainBb: ["bb.md"] });
	const s = readConfigSnapshot(f.directory);
	assert.match(composeSources(s.mainBb), /bb main/);
	assert.equal(composeSources(s.common, s.mainBb).includes("SKILL.md"), false, "main does not leak into the BB layer");
	assert.deepEqual(s.warnings, []);
	f.config({ mainBB: ["bb.md"] });
	const typo = readConfigSnapshot(f.directory);
	assert.deepEqual(typo.mainBb, [], "case variants are unknown keys, not aliases");
	assert.match(typo.warnings.join("\n"), /mainBB.*unknown top-level key/);
	f.config({ mainBb: "bb.md" });
	assert.match(readConfigSnapshot(f.directory).warnings[0], /mainBb.*expected an ordered array/);
	f.config({ mainBb: ["missing.md", "bb.md"] });
	const partial = readConfigSnapshot(f.directory);
	assert.equal(partial.mainBb.length, 1, "valid siblings survive a missing entry");
	assert.match(partial.warnings[0], /mainBb\[0\].*missing\.md.*ENOENT/);
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

test("deployed config smoke keeps its shape and loads the user-editable prompt files", () => {
	// The config file lives at the dotfiles pi/ root (unified config location); the policy
	// (extension asset) directory still resolves its relative entries.
	const directory = fileURLToPath(new URL("../", import.meta.url));
	const configPath = fileURLToPath(new URL("../../../agent-policy.json", import.meta.url));
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { common: [], child: [], main: ["./prompts/main.md"], mainBb: ["./prompts/main-bb.md"], agents: { worker: ["~/.agents/skills/chadineer/SKILL.md"], reviewer: ["~/.agents/skills/chadineer/SKILL.md"] } });
	assert.equal(resolvePolicyConfigPath(undefined, join(dirname(directory), ".virtual-agent-dir"), directory), join(directory, "config.json"), "resolver falls back to the legacy bundled location");
	const s = readConfigSnapshot(directory, configPath);
	assert.equal(s.main.length, 1, "shipped main prompt must load");
	assert.equal(s.mainBb.length, 1, "shipped BB main prompt must load");
	// Prompts are user-editable: only existence and a non-empty load are contractual.
	assert.ok(composeSources(s.main).trim(), "shipped main prompt must be non-empty");
	assert.ok(composeSources(s.mainBb).trim(), "shipped BB main prompt must be non-empty");
	// The Chadineer path is a user source: assert real load only where it is installed.
	if (existsSync(resolve(os.homedir(), ".agents/skills/chadineer/SKILL.md"))) {
		assert.deepEqual(s.warnings, [], "real deployed sources must currently exist");
		assert.equal(s.agents.get("worker")!.length, 1);
		assert.equal(s.agents.get("reviewer")!.length, 1);
	} else {
		assert.equal(s.agents.get("worker")!.length, 0);
		assert.match(s.warnings.join("\n"), /chadineer.*ENOENT/);
	}
});

test("explicit configPath override keeps relative sources anchored to the policy directory", (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "external.json"), JSON.stringify({ main: ["../SKILL.md"] }));
	const snapshot = readConfigSnapshot(f.directory, join(f.root, "external.json"));
	assert.deepEqual(snapshot.warnings, [], "override path reads its JSON, relative entries stay bundled");
	const text = `## Policy source: ${f.skill}\nResolve this source's relative file references against ${dirname(f.skill)}.\n\nbody\n`;
	assert.equal(composeSources(snapshot.main), text);
});

test("policy config path resolution: env override, unified agent-dir location, legacy fallback", (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-policy-config-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const unifiedAgentDir = join(root, "agent");
	mkdirSync(unifiedAgentDir);
	writeFileSync(join(unifiedAgentDir, "agent-policy.json"), "{}");
	const emptyAgentDir = join(root, "empty-agent");
	mkdirSync(emptyAgentDir);
	const legacyDir = join(root, "legacy");
	assert.equal(resolvePolicyConfigPath(undefined, unifiedAgentDir, legacyDir), join(unifiedAgentDir, "agent-policy.json"), "unified location wins when present");
	assert.equal(resolvePolicyConfigPath(undefined, emptyAgentDir, legacyDir), join(legacyDir, "config.json"), "legacy fallback without a unified file");
	assert.equal(resolvePolicyConfigPath(join(legacyDir, "custom.json"), unifiedAgentDir, legacyDir), join(legacyDir, "custom.json"), "env override always wins");
	assert.equal(resolvePolicyConfigPath("~/custom/policy.json", unifiedAgentDir, legacyDir), resolve(os.homedir(), "custom/policy.json"), "env home path expands");
	assert.equal(resolvePolicyConfigPath("relative.json", unifiedAgentDir, legacyDir), resolve("relative.json"), "env relative path resolves against cwd");
	assert.equal(resolvePolicyConfigPath("", unifiedAgentDir, legacyDir), join(unifiedAgentDir, "agent-policy.json"), "blank env value counts as unset");
	assert.equal(resolvePolicyConfigPath("", emptyAgentDir, legacyDir), join(legacyDir, "config.json"), "blank env value falls through");
});
