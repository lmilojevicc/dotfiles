import assert from "node:assert/strict";
import test from "node:test";
import {
	clampUsedPercent,
	epochSeconds,
	formatResetShort,
	formatStatus,
	formatUsedPercent,
	requireProviderAuth,
	statusUsedPercent,
	usageBar,
	windowLabel,
	ProviderStateError,
} from "../core.ts";
import { adapterContext } from "./helpers.ts";

test("used percentages clamp to 0..100, round for display only, and show ?% when unknown", () => {
	assert.equal(formatUsedPercent(57.4), "57%");
	assert.equal(formatUsedPercent(57.5), "58%");
	assert.equal(formatUsedPercent(99.6), "100%");
	assert.equal(formatUsedPercent(140), "100%");
	assert.equal(formatUsedPercent(-5), "0%");
	assert.equal(formatUsedPercent(undefined), "?%");
	assert.equal(clampUsedPercent(140), 100);
	assert.equal(clampUsedPercent(-1), 0);
});

test("usage bar fills Math.round(used / 10) of 10 cells", () => {
	assert.equal(usageBar(0), "░░░░░░░░░░");
	assert.equal(usageBar(4), "░░░░░░░░░░");
	assert.equal(usageBar(5), "█░░░░░░░░░");
	assert.equal(usageBar(57), "██████░░░░");
	assert.equal(usageBar(100), "██████████");
	assert.equal(usageBar(250), "██████████");
	assert.equal(usageBar(undefined), "░░░░░░░░░░");
});

test("window labels derive from window minutes", () => {
	assert.equal(windowLabel(300), "5h");
	assert.equal(windowLabel(10_080), "weekly");
	assert.equal(windowLabel(60), "1h");
	assert.equal(windowLabel(1440), "1d");
	assert.equal(windowLabel(45), "45m");
	assert.equal(windowLabel(undefined, "primary"), "primary");
	assert.equal(windowLabel(Number.NaN), "window");
});

test("reset countdown matches the codex-enhanced short format", () => {
	const now = 1_000_000_000_000;
	const at = (ms: number) => (now + ms) / 1000;
	assert.equal(formatResetShort(undefined, now), "reset ?");
	assert.equal(formatResetShort(at(-1), now), "~now");
	assert.equal(formatResetShort(at(30 * 60_000), now), "~30m");
	assert.equal(formatResetShort(at(104 * 60_000), now), "~1h");
	assert.equal(formatResetShort(at((3 * 24 + 9) * 3_600_000), now), "~3d 9h");
});

test("epoch seconds accept seconds, milliseconds and date strings", () => {
	assert.equal(epochSeconds(1_700_000_000), 1_700_000_000);
	assert.equal(epochSeconds(1_700_000_000_123), 1_700_000_000);
	assert.equal(epochSeconds("2030-01-01T00:00:00Z"), Date.parse("2030-01-01T00:00:00Z") / 1000);
	assert.equal(epochSeconds("soon"), undefined);
	assert.equal(epochSeconds(0), undefined);
});

test("footer value keeps the raw percentage and formats as used", () => {
	const snapshot = {
		providerId: "p", title: "P", observedAt: 0,
		rows: [
			{ label: "empty", windows: [{ label: "x" }] },
			{ label: "main", windows: [{ label: "5h", usedPercent: 25.4 }, { label: "weekly", usedPercent: 99.6 }] },
			{ label: "other", windows: [{ label: "1h", usedPercent: 100 }] },
		],
	};
	assert.equal(statusUsedPercent(snapshot), 99.6, "highest raw value of the first row with data");
	assert.equal(statusUsedPercent({ ...snapshot, statusPercent: 12.5 }), 12.5);
	assert.equal(statusUsedPercent({ ...snapshot, rows: [] }), undefined);
	assert.equal(formatStatus("opencode-go", 57.4), "opencode-go 57% used");
	assert.equal(formatStatus("openai-codex", 140), "openai-codex 100% used");
});

test("requireProviderAuth reports auth needing refresh instead of a generic failure", async () => {
	await assert.rejects(requireProviderAuth(adapterContext(), "opencode-go"), (error: unknown) =>
		error instanceof ProviderStateError && error.state === "auth-refresh" && error.message === "Auth needs refresh · run /login opencode-go");
	const auth = await requireProviderAuth(adapterContext({ getProviderAuth: async () => ({ apiKey: "k", baseUrl: "u" }) }), "x");
	assert.deepEqual(auth, { apiKey: "k", baseUrl: "u" });
});
