import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBlacklistConfig } from "../config.ts";

function withFile(contents: string | undefined, run: (path: string, notices: string[]) => void): void {
	const root = mkdtempSync(join(tmpdir(), "blacklist-config-"));
	try {
		const path = join(root, "model-blacklist.json");
		const notices: string[] = [];
		if (contents !== undefined) writeFileSync(path, contents);
		run(path, notices);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("missing file is empty and silent and is never created", () => {
	withFile(undefined, (path, notices) => {
		assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), { providers: {}, global: [] });
		assert.deepEqual(notices, []);
		assert.equal(existsSync(path), false);
	});
});

test("empty object is empty", () => {
	withFile("{}", (path, notices) => {
		assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), { providers: {}, global: [] });
		assert.deepEqual(notices, []);
	});
});

test("valid providers and global patterns parse, underscore keys stay inert", () => {
	const contents = JSON.stringify({
		providers: { "opencode-go": ["glm-5.3-flash", " grok-4.6 "], " openrouter ": ["x-ai/*"] },
		global: ["*-preview"],
		_examples: { providers: { nope: ["should-not-apply"] } },
		unknown: 123,
	});
	withFile(contents, (path, notices) => {
		assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), {
			providers: { "opencode-go": ["glm-5.3-flash", "grok-4.6"], openrouter: ["x-ai/*"] },
			global: ["*-preview"],
		});
		assert.deepEqual(notices, []);
		assert.equal(readFileSync(path, "utf8"), contents);
	});
});

test("malformed file discards everything with one warning", () => {
	for (const contents of ["", "{bad", "null", "[]", "true", "42", '"text"']) {
		withFile(contents, (path, notices) => {
			assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), { providers: {}, global: [] });
			assert.equal(notices.length, 1, contents);
			assert.ok(notices[0].includes(path));
			assert.match(notices[0], /no models are hidden/);
		});
	}
});

test("invalid entries are skipped individually", () => {
	const contents = JSON.stringify({
		providers: {
			"": ["x"],
			badContainer: "not-an-array",
			badEntry: ["keep", 42, "", "   ", null],
			empty: [],
		},
		global: "nope",
	});
	withFile(contents, (path, notices) => {
		assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), {
			providers: { badEntry: ["keep"] },
			global: [],
		});
		assert.equal(notices.length, 7);
		for (const notice of notices) assert.ok(notice.includes(path));
	});
});

test("negated patterns parse and a bare negation is rejected", () => {
	const contents = JSON.stringify({ providers: { openai: [" !gpt-6* ", "!"] }, global: ["!  "] });
	withFile(contents, (path, notices) => {
		assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), {
			providers: { openai: ["!gpt-6*"] },
			global: [],
		});
		assert.equal(notices.length, 2);
		assert.match(notices[0]!, /"global" contains a negation without a pattern; skipped/);
		assert.match(notices[1]!, /"providers.openai" contains a negation without a pattern; skipped/);
	});
});

test("threshold patterns parse and miswritten ones are skipped", () => {
	const contents = JSON.stringify({ providers: { antigravity: [" !gemini-3.8+ ", "gemini-3.8-flash+", "3.8+"] }, global: ["claude-opus-5+"] });
	withFile(contents, (path, notices) => {
		assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), {
			providers: { antigravity: ["!gemini-3.8+"] },
			global: ["claude-opus-5+"],
		});
		assert.equal(notices.length, 2);
		assert.match(notices[0]!, /"providers.antigravity" contains a trailing \+ without a numeric version/);
		assert.match(notices[1]!, /"providers.antigravity" contains a version threshold without a model-id prefix/);
	});
});

test("providers container of the wrong shape keeps global patterns", () => {
	withFile(JSON.stringify({ providers: ["nope"], global: ["*-preview"] }), (path, notices) => {
		assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), {
			providers: {},
			global: ["*-preview"],
		});
		assert.equal(notices.length, 1);
		assert.match(notices[0], /"providers" must be an object/);
	});
});

test("unreadable file warns and hides nothing", () => {
	withFile("{}", (path, notices) => {
		chmodSync(path, 0o000);
		try {
			assert.deepEqual(readBlacklistConfig((message) => notices.push(message), path), { providers: {}, global: [] });
			assert.equal(notices.length, 1);
			assert.match(notices[0], /no models are hidden/);
		} finally {
			chmodSync(path, 0o600);
		}
	});
});
