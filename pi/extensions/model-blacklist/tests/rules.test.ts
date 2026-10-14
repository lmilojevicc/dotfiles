import assert from "node:assert/strict";
import test from "node:test";
import { compileRules, globToRegExp } from "../rules.ts";

test("patterns match the whole model id", () => {
	assert.ok(globToRegExp("glm-5.3").test("glm-5.3"));
	assert.ok(!globToRegExp("glm-5.3").test("glm-5.3-flash"));
	assert.ok(!globToRegExp("glm-5.3").test("xglm-5.3"));
	assert.ok(globToRegExp("*-preview").test("hy4-preview"));
	assert.ok(!globToRegExp("*-preview").test("hy4-preview-2"));
	assert.ok(globToRegExp("x-ai/*").test("x-ai/grok-4.7"));
	assert.ok(globToRegExp("gpt-?.1").test("gpt-5.1"));
	assert.ok(!globToRegExp("gpt-?.1").test("gpt-55.1"));
	assert.ok(globToRegExp("*").test("anything"));
});

test("patterns are case-insensitive and treat regex characters literally", () => {
	assert.ok(globToRegExp("GLM-5.3-Flash").test("glm-5.3-flash"));
	assert.ok(globToRegExp("gpt-5.1").test("GPT-5.1"));
	assert.ok(!globToRegExp("gpt-5.1").test("gpt-5x1"));
	assert.ok(globToRegExp("a+b(c)").test("a+b(c)"));
	assert.ok(!globToRegExp("a+b(c)").test("aab(c)"));
	assert.ok(globToRegExp("deepseek/v4[1]").test("deepseek/v4[1]"));
});

test("provider rules stay scoped and global rules apply everywhere", () => {
	const rules = compileRules({
		providers: { alpha: ["shared", "alpha-only"], beta: ["beta-*"] },
		global: ["*-preview"],
	});
	assert.deepEqual(rules.providers, ["alpha", "beta"]);
	assert.equal(rules.patternCount, 4);
	assert.equal(rules.globalPatternCount, 1);

	assert.ok(rules.isBlocked("alpha", "shared"));
	assert.ok(rules.isBlocked("alpha", "alpha-only"));
	assert.ok(!rules.isBlocked("beta", "shared"));
	assert.ok(!rules.isBlocked("beta", "alpha-only"));
	assert.ok(rules.isBlocked("beta", "beta-sonnet"));
	assert.ok(!rules.isBlocked("beta", "sonnet"));
	assert.ok(rules.isBlocked("alpha", "hy4-preview"));
	assert.ok(rules.isBlocked("gamma", "hy4-preview"));
	assert.ok(!rules.isBlocked("gamma", "hy4"));

	assert.deepEqual(rules.patternsFor("alpha"), ["shared", "alpha-only", "*-preview"]);
	assert.deepEqual(rules.patternsFor("gamma"), ["*-preview"]);
});

test("a negated pattern hides everything it does not match on that provider", () => {
	const rules = compileRules({ providers: { openai: ["!gpt-6*"] }, global: [] });
	assert.equal(rules.patternCount, 1);
	assert.deepEqual(rules.patternsFor("openai"), ["!gpt-6*"]);

	assert.ok(!rules.isBlocked("openai", "gpt-6-sol"));
	assert.ok(!rules.isBlocked("openai", "gpt-6.1-sol"));
	assert.ok(rules.isBlocked("openai", "gpt-5.6-sol"));
	assert.ok(rules.isBlocked("openai", "o3"));
	// The gate stays provider-scoped: an unconfigured provider is untouched.
	assert.ok(!rules.isBlocked("openai-codex", "gpt-5.5"));
});

test("plain patterns override the gate and the gate composes with global patterns", () => {
	const rules = compileRules({ providers: { alpha: ["!gpt-6*", "gpt-6-sol"] }, global: ["*-preview"] });
	assert.ok(!rules.isBlocked("alpha", "gpt-6-luna"));
	assert.ok(rules.isBlocked("alpha", "gpt-6-sol"));
	assert.ok(rules.isBlocked("alpha", "gpt-5.4"));
	assert.ok(rules.isBlocked("alpha", "gpt-6-preview"));
	assert.deepEqual(rules.patternsFor("alpha"), ["!gpt-6*", "gpt-6-sol", "*-preview"]);
});

test("a provider with only plain patterns keeps matching-only semantics", () => {
	const rules = compileRules({ providers: { alpha: ["gpt-5*"] }, global: [] });
	assert.ok(rules.isBlocked("alpha", "gpt-5.4"));
	assert.ok(!rules.isBlocked("alpha", "gpt-6-sol"));
});

test("a global negation gates every provider", () => {
	const rules = compileRules({ providers: {}, global: ["!gemini-*"] });
	assert.equal(rules.globalPatternCount, 1);
	assert.ok(!rules.isBlocked("beta", "gemini-3.6-flash"));
	assert.ok(rules.isBlocked("beta", "gpt-5.4"));
});

test("threshold patterns gate a provider like negations do", () => {
	const rules = compileRules({
		providers: { antigravity: ["!gemini-3.8+", "!claude-opus-5+", "!claude-sonnet-5+"] },
		global: [],
	});
	assert.equal(rules.patternCount, 3);
	assert.deepEqual(rules.patternsFor("antigravity"), ["!gemini-3.8+", "!claude-opus-5+", "!claude-sonnet-5+"]);

	for (const id of ["gemini-3.8-flash", "gemini-4-flash", "claude-opus-5-5", "claude-sonnet-6"])
		assert.ok(!rules.isBlocked("antigravity", id), id);
	for (const id of ["gemini-3.7-flash", "gemini-2.5-pro", "claude-opus-4-6", "claude-sonnet-4-6", "gpt-oss-120b"])
		assert.ok(rules.isBlocked("antigravity", id), id);
});

test("a plain threshold hides its version and newer", () => {
	const rules = compileRules({ providers: { alpha: ["gemini-3.8+"] }, global: [] });
	assert.ok(rules.isBlocked("alpha", "gemini-3.8-flash"));
	assert.ok(rules.isBlocked("alpha", "gemini-4-pro"));
	assert.ok(!rules.isBlocked("alpha", "gemini-3.7-flash"));
});

test("a lone * hides every model on its provider only", () => {
	const rules = compileRules({ providers: { "openai-codex": ["*"] }, global: [] });
	for (const id of ["gpt-5.3-codex-spark", "gpt-5.6-terra", "gpt-6-astra", "gpt-6.1-sol", "some-future-id"])
		assert.ok(rules.isBlocked("openai-codex", id), id);
	assert.ok(!rules.isBlocked("openai", "gpt-6.1-sol"));
});

test("empty config blocks nothing", () => {
	const rules = compileRules({ providers: {}, global: [] });
	assert.deepEqual(rules.providers, []);
	assert.equal(rules.patternCount, 0);
	assert.ok(!rules.isBlocked("any", "anything"));
	assert.deepEqual(rules.patternsFor("any"), []);
});
