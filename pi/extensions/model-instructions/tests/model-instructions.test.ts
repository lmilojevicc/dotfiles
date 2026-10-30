import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import modelInstructionsExtension, { instructionsFor, PROMPT_SECTION, parseConfig } from "../index.ts";

type Handler = (...args: any[]) => any;

function runtime(t: test.TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-model-instructions-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "instructions.json");
	const handlers = new Map<string, Handler>();
	const notifications: Array<{ message: string; level: string }> = [];
	modelInstructionsExtension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as any, pathToFileURL(path));
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-6-astra" } as { provider: string; id: string } | undefined,
		hasUI: true,
		mode: "rpc" as string,
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
	};
	return {
		ctx, handlers, notifications,
		write(models: Record<string, unknown>) { writeFileSync(path, JSON.stringify({ models })); },
		raw(text: string) { writeFileSync(path, text); },
		remove() { unlinkSync(path); },
		/** One run: Pi starts from fresh base options, so only this run's mutation is observed. */
		before(sections: Record<string, string> = {}) {
			const options = { sections, systemPrompt: "Shared baseline\nEarlier extension instructions" };
			const result = handlers.get("before_agent_start")!(
				{ systemPrompt: options.systemPrompt, systemPromptOptions: options },
				ctx,
			);
			assert.equal(result, undefined, "the extension must never force the whole system prompt");
			return options.sections[PROMPT_SECTION];
		},
	};
}

test("exact model matching, provider override, and explicit empty override", () => {
	const config = parseConfig({ models: {
		"gpt-6-astra": [" Base rule "],
		"openai-codex/gpt-6-astra": ["Specific rule"],
		"disabled/gpt-6-astra": [],
	} });
	assert.deepEqual(instructionsFor(config, { provider: "openai", id: "gpt-6-astra" }), ["Base rule"]);
	assert.deepEqual(instructionsFor(config, { provider: "openai-codex", id: "gpt-6-astra" }), ["Specific rule"]);
	assert.deepEqual(instructionsFor(config, { provider: "disabled", id: "gpt-6-astra" }), []);
	for (const id of ["gpt-6-astra-mini", "GPT-6-ASTRA", "gpt-6", "constructor", "toString"]) {
		assert.deepEqual(instructionsFor(config, { provider: "openai", id }), []);
	}
});

test("supports namespaced model IDs and prototype-like keys as ordinary data", () => {
	const config = parseConfig(JSON.parse('{"models":{"vendor/model":["General"],"router/vendor/model":["Specific"],"__proto__":["Plain data"]}}'));
	assert.deepEqual(instructionsFor(config, { provider: "router", id: "vendor/model" }), ["Specific"]);
	assert.deepEqual(instructionsFor(config, { provider: "different", id: "vendor/model" }), ["General"]);
	assert.deepEqual(instructionsFor(config, { provider: "different", id: "__proto__" }), ["Plain data"]);
});

test("rejects malformed schema rather than partially applying rules", () => {
	for (const value of [
		null, [], "text", {}, { models: [] }, { models: null }, { models: {}, typo: true },
		{ models: { "": [] } }, { models: { " model": [] } }, { models: { "model ": [] } },
		{ models: { model: "text" } }, { models: { model: [null] } },
		{ models: { model: [1] } }, { models: { model: [""] } }, { models: { model: [" "] } },
		{ models: { valid: ["Rule"], invalid: false } },
	]) assert.throws(() => parseConfig(value));
	assert.equal(parseConfig({ models: {} }).size, 0);
	assert.deepEqual(parseConfig({ models: { model: [] } }).get("model"), []);
});

test("sets its own prompt section quietly without registering tools or persistent messages", (t) => {
	const r = runtime(t);
	assert.deepEqual([...r.handlers.keys()], ["before_agent_start"]);
	r.write({ "gpt-6-astra": ["First rule", "Second rule\nwith another line"] });
	const expected = "## Model-specific instructions\n\n- First rule\n- Second rule\nwith another line";
	assert.equal(r.before(), expected);
	assert.equal(r.before(), expected, "a new run receives the same base, not accumulated rules");
	assert.deepEqual(r.notifications, []);
});

test("reads the active model each run and never carries instructions across switches", (t) => {
	const r = runtime(t);
	r.write({ "gpt-6-astra": ["Astra rule"], "claude-sonnet-4-6": ["Claude rule"] });
	assert.match(r.before()!, /Astra rule/);
	r.ctx.model = { provider: "anthropic", id: "claude-sonnet-4-6" };
	assert.match(r.before()!, /Claude rule/);
	assert.doesNotMatch(r.before()!, /Astra rule/);
	r.ctx.model = { provider: "unknown", id: "unconfigured" };
	assert.equal(r.before(), undefined);
	r.ctx.model = undefined;
	assert.equal(r.before(), undefined);
	r.ctx.model = { provider: "openai-codex", id: "gpt-6-astra" };
	assert.match(r.before()!, /Astra rule/);
});

test("deletes a stale section when the active model has no instructions", (t) => {
	const r = runtime(t);
	r.write({ "gpt-6-astra": ["Astra rule"] });
	assert.match(r.before({ [PROMPT_SECTION]: "stale rules" })!, /Astra rule/);
	r.ctx.model = { provider: "anthropic", id: "claude-sonnet-4-6" };
	assert.equal(r.before({ [PROMPT_SECTION]: "stale rules" }), undefined);
	r.ctx.model = { provider: "openai-codex", id: "gpt-6-astra" };
	r.write({ "gpt-6-astra": [] });
	assert.equal(r.before({ [PROMPT_SECTION]: "stale rules" }), undefined, "an explicit empty entry removes the section");
});

test("config edits, empty entries, and deletions take effect on the next run", (t) => {
	const r = runtime(t);
	assert.equal(r.before(), undefined, "a missing config is a quiet no-op");
	r.write({ "gpt-6-astra": ["Old rule"] });
	assert.match(r.before()!, /Old rule/);
	r.write({ "gpt-6-astra": ["New rule"] });
	assert.match(r.before()!, /New rule/);
	assert.doesNotMatch(r.before()!, /Old rule/);
	r.write({ "gpt-6-astra": [] });
	assert.equal(r.before(), undefined);
	r.write({ "gpt-6-astra": ["Restored rule"] });
	r.remove();
	assert.equal(r.before({ [PROMPT_SECTION]: "stale rules" }), undefined, "a removed config clears the section too");
	assert.deepEqual(r.notifications, []);
});

test("invalid config warns once, skips stale rules, and recovers without reload", (t) => {
	const r = runtime(t);
	r.write({ "gpt-6-astra": ["Old rule"] });
	assert.match(r.before()!, /Old rule/);
	r.raw("{");
	assert.equal(r.before(), undefined);
	assert.equal(r.before(), undefined);
	assert.equal(r.notifications.length, 1);
	assert.equal(r.notifications[0].level, "warning");
	assert.match(r.notifications[0].message, /Model instructions skipped .*instructions.json/);
	r.write({ "gpt-6-astra": ["Recovered rule"] });
	assert.match(r.before()!, /Recovered rule/);
	r.raw("{");
	r.before();
	assert.equal(r.notifications.length, 2, "a successful read resets warning suppression");
	r.write({ "gpt-6-astra": "Wrong shape" });
	assert.equal(r.before(), undefined);
	assert.equal(r.notifications.length, 3, "a different error is reported");
});

test("warnings reach a non-terminal host on stderr, a TUI through notify only, and are deduplicated", (t) => {
	const r = runtime(t);
	const errors = t.mock.method(console, "error", () => {});
	const stdout = t.mock.method(console, "log", () => {});
	r.raw("[]");
	// RPC (BB) has a UI, but its notify is dropped; stderr is the only channel that survives.
	assert.equal(r.before(), undefined);
	assert.equal(errors.mock.callCount(), 1);
	assert.equal(r.notifications.length, 1);
	assert.equal(r.notifications[0].level, "warning");
	r.notifications.length = 0;
	r.ctx.mode = "tui";
	r.raw("{");
	assert.equal(r.before(), undefined);
	assert.equal(errors.mock.callCount(), 1, "a real TUI reports through notify only");
	assert.equal(r.notifications.length, 1);
	r.ctx.hasUI = false;
	r.ctx.mode = "print";
	r.raw('{"models":{"m":"text"}}');
	assert.equal(r.before(), undefined);
	assert.equal(errors.mock.callCount(), 2, "a headless host still logs to stderr");
	assert.equal(r.notifications.length, 1, "headless hosts have no UI notification");
	assert.equal(stdout.mock.callCount(), 0);
});

test("bundled Astra rules target UI copy without removing essential information", () => {
	const config = parseConfig(JSON.parse(readFileSync(new URL("../instructions.json", import.meta.url), "utf8")));
	const rules = instructionsFor(config, { provider: "openai-codex", id: "gpt-6-astra" }).join("\n");
	for (const text of ["UI/TUI", "redundant subtitles", "validation errors", "accessible names", "explicitly requested"]) {
		assert.ok(rules.includes(text), text);
	}
	assert.deepEqual(instructionsFor(config, { provider: "anthropic", id: "claude-sonnet-4-6" }), []);
});
