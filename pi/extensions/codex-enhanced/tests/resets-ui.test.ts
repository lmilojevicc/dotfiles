import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { __testing } from "../index.ts";

const theme: any = { fg: (color: string, text: string) => `\x1b[${color === "accent" ? "36" : color === "warning" ? "33" : "37"}m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const expiry = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const credit = (days: number) => ({ id: `synthetic-${days}`, expiresAt: expiry(days) });
const widths = [32, 39, 40, 41, 53, 54, 59, 60, 61, 79, 80, 81];

const samples = [
	{ name: "loading", usage: undefined, loading: true, enabled: undefined, status: "Checking account…" },
	{ name: "unknown", usage: { limits: [] }, status: "" },
	{ name: "zero", usage: { limits: [], resetCredits: { availableCount: 0, credits: [] } }, status: "" },
	{ name: "one", usage: { limits: [], resetCredits: { availableCount: 1, credits: [credit(2)] } }, status: "" },
	{ name: "many", usage: { limits: [], resetCredits: { availableCount: 7, credits: [credit(4), credit(2), credit(3), credit(8)] } }, status: "" },
	{ name: "partial", usage: { limits: [], resetCredits: { availableCount: 3, credits: [credit(2), { id: "no-expiry" }, { id: "invalid", expiresAt: "bad" }] } }, status: "" },
	{ name: "safety", usage: { limits: [] }, status: "Paused: previous reset needs review" },
	{ name: "uncertain", usage: { limits: [] }, status: "Paused: previous reset unconfirmed" },
	{ name: "storage", usage: { limits: [] }, status: "Paused: local recovery required" },
	{ name: "applying", usage: { limits: [] }, status: "Applying reset…" },
	{ name: "armed", usage: { limits: [] }, status: "Use 1 banked reset?" },
	{ name: "error", usage: { error: "synthetic failure" }, status: "Could not refresh balance" },
	{ name: "success", usage: { limits: [] }, status: "Completion saved locally; no reset used" },
	{ name: "guard", usage: { limits: [] }, status: "Waiting for weekly recovery" },
];

for (const width of widths) test(`formatResetLines preserves balance/policy/status with actual ANSI cell utilities at ${width}`, () => {
	for (const sample of samples) for (const enabled of [false, true]) {
		const lines = __testing.formatResetLines(theme, sample.usage as any, sample.loading ?? false, sample.name === "loading" ? undefined : enabled, sample.status, width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${sample.name}: ${visibleWidth(line)} > ${width}`);
		const plain = lines.map(stripVTControlCharacters);
		const text = plain.join("\n");
		assert.match(text, /no prompts/);
		assert.match(text, /Auto reset (on|off|—)/);
		assert.match(text, /Weekly 0%/);
		assert.match(text, /expiry first/);
		const policyIndex = plain.findIndex((line) => line.includes("Auto reset"));
		assert.ok(plain[policyIndex]!.includes("no prompts") || plain[policyIndex + 1]!.includes("no prompts"), "wrap at most once");
		if (width >= 60) assert.match(plain[policyIndex]!, /no prompts/, "one compact row when it fits");
		assert.doesNotMatch(text, /this account|Automatic spending off|Monitoring|never expires|README|Available:/);
		assert.doesNotMatch(text, /\n\s*\n\s*\n/);
		if (sample.name === "zero") { assert.match(text, /0 banked resets/); assert.doesNotMatch(text, /Next expiry|Expiry unknown/); }
		if (sample.name === "unknown") assert.match(text, /Banked resets: unknown/);
		if (sample.name === "one") assert.match(text, /1 banked reset\n/);
		if (sample.name === "many") assert.match(text, /7 banked resets/, "server balance, not four details");
		if (sample.name === "one" || sample.name === "many" || sample.name === "partial") assert.match(text, /Next expiry in ~2d/);
	}
});

test("formatResetCreditExpiries excludes expired/malformed/unavailable/ineligible detail from next expiry", () => {
	const details = [
		{ id: "expired", expiresAt: "2000-01-01T00:00:00Z" },
		{ id: "malformed", expiresAt: "soon" },
		{ id: "metadata", expiresAt: expiry(1), invalidMetadata: true as const },
		{ id: "unavailable", expiresAt: expiry(1), status: "redeemed" },
		{ id: "wrong-type", expiresAt: expiry(1), resetType: "other" },
		{ expiresAt: expiry(1) },
		{ id: "no-expiry" }, credit(7), credit(2), credit(4),
	];
	const text = __testing.formatResetCreditExpiries(details, 10).join("\n");
	assert.match(text, /^Next expiry in ~2d · then ~4d, ~7d/);
	assert.match(text, /Other expiry details unknown/);
	assert.doesNotMatch(text, /expired|~1d|never/);
	assert.deepEqual(__testing.formatResetCreditExpiries([{ id: "no-expiry" }], 1), ["Expiry unknown"]);
	assert.deepEqual(__testing.formatResetCreditExpiries([], 7), ["Expiry unknown"]);
});

test("real TUI utilities measure ANSI, wide glyphs and graphemes; reset wrapping uses terminal cells", () => {
	assert.equal(visibleWidth("\x1b[31m界e\u0301\x1b[0m"), 3);
	assert.equal(visibleWidth("界界"), 4);
	assert.equal(visibleWidth("\x1b[1mon\x1b[22m"), 2);
	for (const width of widths) {
		const sample = `${theme.fg("accent", "界界 e\u0301 👩‍💻")} · no prompts · ${"wide 界 ".repeat(12)}`;
		const expected = wrapTextWithAnsi(sample, width - 2);
		const actual = __testing.resetWrappedLines(sample, width);
		assert.deepEqual(actual, expected.map((line: string) => `  ${line}`));
		assert.ok(actual.every((line: string) => visibleWidth(line) <= width));
		assert.match(actual.map(stripVTControlCharacters).join("\n"), /no prompts/);
	}
});
