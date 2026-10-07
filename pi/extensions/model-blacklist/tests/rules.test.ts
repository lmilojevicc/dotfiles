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

test("empty config blocks nothing", () => {
	const rules = compileRules({ providers: {}, global: [] });
	assert.deepEqual(rules.providers, []);
	assert.equal(rules.patternCount, 0);
	assert.ok(!rules.isBlocked("any", "anything"));
	assert.deepEqual(rules.patternsFor("any"), []);
});
