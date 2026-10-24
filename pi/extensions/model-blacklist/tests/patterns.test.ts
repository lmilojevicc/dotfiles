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

test("a version comparison reads the whole version number at its position", () => {
	const old = parseMatcher("*claude-{opus,sonnet,haiku}-<5.5*");
	for (const id of ["claude-opus-4-8", "claude-opus-5", "claude-opus-5-high", "claude-sonnet-5-4-thinking", "claude-haiku-4-5-20251001", "Claude-Opus-4.6"]) {
		assert.ok(old.matches(id), id);
	}
	for (const id of ["claude-opus-5-5", "claude-opus-5-5-high", "claude-opus-5-10", "claude-opus-6", "claude-fable-5-1", "claude-opus"]) {
		assert.ok(!old.matches(id), id);
	}

	// A version never starts mid-number, so gpt-15 is 15, not 5.
	const gpt = parseMatcher("*gpt-<6*");
	assert.ok(gpt.matches("gpt-5.6-luna"));
	assert.ok(gpt.matches("openai/gpt-4o"));
	assert.ok(!gpt.matches("gpt-6.1-sol"));
	assert.ok(!gpt.matches("gpt-15"));
	assert.ok(!gpt.matches("gpt-oss-120b"));
	assert.ok(!parseMatcher("*<6*").matches("gpt-15"));

	assert.ok(parseMatcher("*mimo-v<2.6*").matches("xiaomi/mimo-v2.5-pro"));
	assert.ok(!parseMatcher("*mimo-v<2.6*").matches("mimo-v2.10"));
	assert.ok(parseMatcher("*kimi-k<3*").matches("moonshotai/Kimi-K2.7-Code"));
	assert.ok(!parseMatcher("*kimi-k<3*").matches("kimi-k3"));
});

test("every comparison operator compares per segment", () => {
	assert.ok(parseMatcher("glm-<=5.3*").matches("glm-5.3-flash"));
	assert.ok(!parseMatcher("glm-<=5.3*").matches("glm-5.4"));
	assert.ok(parseMatcher("glm->5.3*").matches("glm-5.10"));
	assert.ok(!parseMatcher("glm->5.3*").matches("glm-5.3"));
	assert.ok(parseMatcher("glm->=5.3").matches("glm-5.3.0"));
	assert.ok(!parseMatcher("glm->=5.3").matches("glm-5.2"));
	// The version must be followed by what the pattern says.
	assert.ok(parseMatcher("glm-<5.3-air").matches("glm-5.2-air"));
	assert.ok(!parseMatcher("glm-<5.3-air").matches("glm-5.2"));
});

test("brace alternatives expand, including an empty alternative", () => {
	const o = parseMatcher("{,*/}o{1,3,4}*");
	for (const id of ["o1", "o3-mini", "openai/o4-mini"]) assert.ok(o.matches(id), id);
	for (const id of ["o2", "gpt-o3", "openai/gpt-4o"]) assert.ok(!o.matches(id), id);

	const negated = parseMatcher("!claude-{fable,mythos}-*");
	assert.equal(negated.negated, true);
	assert.ok(negated.matches("claude-mythos-5"));
	assert.ok(!negated.matches("claude-opus-5-5"));
});

test("miswritten braces and comparisons are reported", () => {
	assert.equal(patternProblem("*claude-{opus,sonnet}-<5.5*"), undefined);
	assert.equal(patternProblem("!{a,b}>=2"), undefined);
	assert.match(patternProblem("claude-{opus")!, /unclosed \{/);
	assert.match(patternProblem("claude-opus}")!, /without a matching \{/);
	assert.match(patternProblem("{a,{b,c}}")!, /nested/);
	assert.match(patternProblem("gpt-<*")!, /< or > without a numeric version/);
	assert.match(patternProblem("gpt->=x")!, /< or > without a numeric version/);
});
