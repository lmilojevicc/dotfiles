import assert from "node:assert/strict";
import test from "node:test";
import { parseMatcher, patternProblem } from "../patterns.ts";

test("a threshold keeps its version and everything newer", () => {
	const gemini = parseMatcher("gemini-3.8+");
	assert.ok(gemini.matches("gemini-3.8"));
	assert.ok(gemini.matches("gemini-3.8-flash"));
	assert.ok(gemini.matches("gemini-3.8-flash-lite"));
	assert.ok(gemini.matches("gemini-3.9-flash"));
	assert.ok(gemini.matches("gemini-3.10-pro"));
	assert.ok(gemini.matches("gemini-4-flash"));
	assert.ok(gemini.matches("GEMINI-3.8-FLASH"));

	assert.ok(!gemini.matches("gemini-3.7-flash"));
	assert.ok(!gemini.matches("gemini-3.1-pro"));
	assert.ok(!gemini.matches("gemini-2.5-pro"));
	assert.ok(!gemini.matches("gemini-pro-agent"));
	assert.ok(!gemini.matches("claude-opus-5"));
});

test("a threshold compares dashed and dotted versions per segment", () => {
	const opus = parseMatcher("claude-opus-5+");
	assert.ok(opus.matches("claude-opus-5"));
	assert.ok(opus.matches("claude-opus-5-5"));
	assert.ok(opus.matches("claude-opus-5-5-high"));
	assert.ok(opus.matches("claude-opus-6"));
	assert.ok(!opus.matches("claude-opus-4-6"));
	assert.ok(!opus.matches("claude-sonnet-5-5"));

	const exact = parseMatcher("claude-opus-5-5+");
	assert.ok(exact.matches("claude-opus-5-5-high"));
	assert.ok(!exact.matches("claude-opus-5"));

	// Trailing zeroes never change a version.
	assert.ok(parseMatcher("gemini-3.8+").matches("gemini-3.8.0"));
	assert.ok(!parseMatcher("gemini-3.8.1+").matches("gemini-3.8"));
});

test("negation, globs, and + outside a threshold keep their own meaning", () => {
	const gated = parseMatcher("!gemini-3.8+");
	assert.equal(gated.negated, true);
	assert.equal(gated.pattern, "!gemini-3.8+");
	assert.ok(gated.matches("gemini-4-pro"));
	assert.ok(!gated.matches("gemini-3.7-flash"));

	// Wildcards inside a threshold prefix are literal, and a non-trailing + stays a glob.
	assert.ok(!parseMatcher("gemini-*.8+").matches("gemini-3.8-flash"));
	assert.ok(parseMatcher("a+b(c)").matches("a+b(c)"));
	assert.equal(parseMatcher("gpt-6*").negated, false);
});

test("miswritten patterns are reported instead of silently matching nothing", () => {
	assert.equal(patternProblem("gpt-6*"), undefined);
	assert.equal(patternProblem("a+b(c)"), undefined);
	assert.equal(patternProblem("gemini-3.8+"), undefined);
	assert.equal(patternProblem("!gemini-3.8+"), undefined);

	assert.match(patternProblem("gemini-3.8-flash+")!, /without a numeric version/);
	assert.match(patternProblem("gpt-oss-120b+")!, /without a numeric version/);
	assert.match(patternProblem("a+")!, /without a numeric version/);
	assert.match(patternProblem("!+")!, /without a numeric version/);
	assert.match(patternProblem("3.8+")!, /without a model-id prefix/);
	assert.match(patternProblem("!")!, /negation without a pattern/);
});
