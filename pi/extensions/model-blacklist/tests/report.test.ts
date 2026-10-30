import assert from "node:assert/strict";
import test from "node:test";
import { describeApplication, formatReport } from "../report.ts";
import { compileRules } from "../rules.ts";

test("only configured providers that are stored are applied", () => {
	const rules = compileRules({ providers: { alpha: ["drop"], missing: ["gone"] }, global: [] });
	const report = describeApplication(rules, ["alpha", "beta"]);

	assert.deepEqual(report, { known: true, applied: ["alpha"], missing: ["missing"] });
});

test("global patterns target every stored provider, configured ones first", () => {
	const rules = compileRules({ providers: { beta: ["x"] }, global: ["*-preview"] });
	const report = describeApplication(rules, ["alpha", "beta"]);

	assert.deepEqual(report.applied, ["beta", "alpha"]);
	assert.deepEqual(report.missing, []);
});

test("an unreadable store claims nothing", () => {
	const rules = compileRules({ providers: { alpha: ["drop"] }, global: ["*-preview"] });

	assert.deepEqual(describeApplication(rules, undefined), { known: false, applied: [], missing: [] });
});

test("the report lists patterns, unknown providers, and the empty configuration", () => {
	const rules = compileRules({ providers: { alpha: ["drop"], ghost: ["x"] }, global: ["*-preview"] });
	const lines = formatReport(rules, describeApplication(rules, ["alpha"]));

	assert.deepEqual(lines, [
		"Model blacklist: 3 pattern(s)",
		"  alpha: drop, *-preview",
		"Unknown providers (ignored): ghost",
	]);
});

test("global-only providers collapse into one report line", () => {
	const rules = compileRules({ providers: { beta: ["x"] }, global: ["*-preview"] });
	const lines = formatReport(rules, describeApplication(rules, ["alpha", "beta", "gamma"]));

	assert.deepEqual(lines, [
		"Model blacklist: 2 pattern(s)",
		"  beta: x, *-preview",
		"  all other providers: *-preview",
	]);
});

test("an empty configuration says so instead of an unknown-store line", () => {
	const rules = compileRules({ providers: {}, global: [] });

	assert.deepEqual(formatReport(rules, describeApplication(rules, ["alpha"])), [
		"Model blacklist: 0 pattern(s)",
		"No providers configured; no models are hidden",
	]);
	assert.deepEqual(formatReport(rules, describeApplication(rules, undefined)), ["Model blacklist: 0 pattern(s)"]);
});
