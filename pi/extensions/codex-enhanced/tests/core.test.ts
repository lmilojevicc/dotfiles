import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	getConfigPath,
	injectFastServiceTier,
	isCanonicalCodexModel,
	parseResetResult,
	parseUsagePayload,
	readConfig,
	selectResetCredit,
	toggleFastConfig,
	toggleResponsesCompactConfig,
	weeklyUsageLeft,
	writeFastConfig,
	writeResponsesCompactConfig,
} from "../core.ts";

const canonicalModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

test("recognizes only canonical Codex subscription models", () => {
	assert.equal(isCanonicalCodexModel(canonicalModel), true);
	assert.equal(isCanonicalCodexModel({ ...canonicalModel, baseUrl: undefined }), true);
	assert.equal(isCanonicalCodexModel({ ...canonicalModel, baseUrl: "https://chatgpt.com/backend-api/" }), true);
	assert.equal(isCanonicalCodexModel({ ...canonicalModel, provider: "openai" }), false);
	assert.equal(isCanonicalCodexModel({ ...canonicalModel, api: "openai-responses" }), false);
	assert.equal(isCanonicalCodexModel({ ...canonicalModel, baseUrl: "http://chatgpt.com/backend-api" }), false);
	assert.equal(isCanonicalCodexModel({ ...canonicalModel, baseUrl: "https://chatgpt.com.evil.test/backend-api" }), false);
	assert.equal(isCanonicalCodexModel({ ...canonicalModel, baseUrl: "https://chatgpt.com/backend-api/codex" }), false);
});

test("parses quota windows, reset credits, and weekly usage", () => {
	const snapshot = parseUsagePayload({
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 25, limit_window_seconds: 18_000, resets_at: 1_700_000_000 },
			secondary_window: { used_percent: 40, window_minutes: 10_080, reset_at: 1_800_000_000 },
		},
		additional_rate_limits: [{
			metered_feature: "review",
			limit_name: "Code review",
			rate_limit: { primary: { used_percent: 10, window_minutes: 60 } },
		}],
		rate_limit_reset_credits: {
			available_count: "2",
			credits: [{ id: "credit-1", status: "available", expires_at: "2030-01-01T00:00:00Z" }, null],
		},
	});

	assert.equal(snapshot.planType, "plus");
	assert.deepEqual(snapshot.limits[0], {
		limitId: "codex",
		primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_700_000_000 },
		secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: 1_800_000_000 },
	});
	assert.deepEqual(snapshot.limits[1], {
		limitId: "review",
		limitName: "Code review",
		primary: { usedPercent: 10, windowMinutes: 60, resetsAt: undefined },
		secondary: undefined,
	});
	assert.deepEqual(snapshot.resetCredits, {
		availableCount: 2,
		credits: [{ id: "credit-1", status: "available", expiresAt: "2030-01-01T00:00:00Z" }],
	});
	assert.equal(weeklyUsageLeft(snapshot), 60);
});

test("normalizes a lone weekly window and parses reset outcomes safely", () => {
	const snapshot = parseUsagePayload({
		rate_limit: { primary_window: { used_percent: 140, window_minutes: 10_080 } },
	});
	assert.equal(snapshot.limits[0]?.primary, undefined);
	assert.deepEqual(snapshot.limits[0]?.secondary, { usedPercent: 140, windowMinutes: 10_080, resetsAt: undefined });
	assert.equal(weeklyUsageLeft(snapshot), 0);
	assert.deepEqual(parseResetResult({ code: "already_redeemed", windows_reset: "2" }), {
		outcome: "already_redeemed",
		windowsReset: 2,
	});
	assert.deepEqual(parseResetResult({ code: "unexpected", windows_reset: -4 }), {
		outcome: "unknown",
		windowsReset: 0,
	});
});

test("migrates the Fast-only config and preserves unknown fields for both toggles", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "codex-enhanced-"));
	try {
		const configPath = getConfigPath(agentDir);
		assert.equal(configPath, join(agentDir, "codex-enhanced.json"));
		assert.deepEqual(readConfig(configPath), {
			fast: false,
			compaction: { responsesCompactEnabled: false },
		});

		writeFileSync(configPath, `${JSON.stringify({ retained: "value", fast: false, compaction: { future: 7 } })}\n`);
		assert.deepEqual(writeFastConfig(true, configPath), { ok: true });
		assert.deepEqual(writeResponsesCompactConfig(true, configPath), { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
			retained: "value",
			fast: true,
			compaction: { future: 7, responsesCompactEnabled: true },
		});
		assert.deepEqual(toggleFastConfig(configPath), { ok: true, fast: false });
		assert.deepEqual(toggleResponsesCompactConfig(configPath), { ok: true, responsesCompactEnabled: false });
		assert.deepEqual(readConfig(configPath), {
			fast: false,
			compaction: { responsesCompactEnabled: false },
		});

		writeFileSync(configPath, "not json");
		assert.deepEqual(readConfig(configPath), {
			fast: false,
			compaction: { responsesCompactEnabled: false },
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("selects the soonest-expiring usable reset credit deterministically", () => {
	const now = Date.parse("2030-01-01T00:00:00Z");
	assert.equal(selectResetCredit([
		{ id: "later", status: "available", expiresAt: "2030-01-03T00:00:00Z" },
		{ id: "tie-b", status: "available", expiresAt: "2030-01-02T00:00:00Z" },
		{ id: "tie-a", status: "available", expiresAt: "2030-01-02T00:00:00Z" },
		{ id: "expired", status: "available", expiresAt: "2029-12-31T00:00:00Z" },
		{ id: "used", status: "consumed", expiresAt: "2030-01-01T01:00:00Z" },
		{ status: "available", expiresAt: "2030-01-01T01:00:00Z" },
	], now)?.id, "tie-a");
	assert.equal(selectResetCredit([{ status: "available" }], now), undefined);
	assert.equal(selectResetCredit([
		{ id: "malformed", status: "available", expiresAt: "not-a-timestamp" },
		{ id: "finite", status: "available", expiresAt: "2030-01-01T01:00:00Z" },
	], now)?.id, "finite");
});

test("injects priority only for eligible requests without an explicit tier", () => {
	const payload = { input: "hello" };
	assert.deepEqual(injectFastServiceTier(payload, canonicalModel, true), { input: "hello", service_tier: "priority" });
	assert.deepEqual(payload, { input: "hello" });
	assert.equal(injectFastServiceTier({ ...payload, service_tier: "standard" }, canonicalModel, true), undefined);
	assert.equal(injectFastServiceTier(payload, canonicalModel, false), undefined);
	assert.equal(injectFastServiceTier(payload, { ...canonicalModel, baseUrl: "https://api.openai.com/v1" }, true), undefined);
	assert.equal(injectFastServiceTier("not an object", canonicalModel, true), undefined);
});
