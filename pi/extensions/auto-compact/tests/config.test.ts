import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	loadConfig,
	parseConfig,
	resolveConfigPath,
	resolveForModel,
	thresholdTokens,
} from "../config.ts";

const flash = { provider: "deepseek", id: "deepseek-v4.1-flash" };

test("an empty object uses the defaults", () => {
	assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
});

test("a global threshold applies to every model", () => {
	const config = parseConfig({ thresholdPercent: 70 });
	assert.deepEqual(resolveForModel(config, flash), { enabled: true, thresholdPercent: 70, matched: undefined });
});

test("an exact provider/model entry wins over a bare model entry", () => {
	const config = parseConfig({
		thresholdPercent: 70,
		models: {
			"deepseek-v4.1-flash": { thresholdPercent: 60 },
			"deepseek/deepseek-v4.1-flash": { thresholdPercent: 50 },
		},
	});
	assert.equal(resolveForModel(config, flash).thresholdPercent, 50);
	assert.equal(resolveForModel(config, { provider: "openrouter", id: "deepseek-v4.1-flash" }).thresholdPercent, 60);
});

test("omitted override fields fall back to the global values", () => {
	const config = parseConfig({ thresholdPercent: 70, models: { "deepseek-v4.1-flash": { enabled: false } } });
	assert.deepEqual(resolveForModel(config, flash), {
		enabled: false,
		thresholdPercent: 70,
		matched: "deepseek-v4.1-flash",
	});
});

test("a global disable wins over a model entry", () => {
	const config = parseConfig({ enabled: false, models: { "deepseek-v4.1-flash": { enabled: true } } });
	assert.equal(resolveForModel(config, flash).enabled, false);
});

test("invalid values and unknown keys are rejected", () => {
	assert.throws(() => parseConfig({ thresholdPercent: 0 }), /greater than 0/);
	assert.throws(() => parseConfig({ thresholdPercent: 100 }), /less than 100/);
	assert.throws(() => parseConfig({ thresholdPercent: "80" }), /number/);
	assert.throws(() => parseConfig({ reserveTokens: 1 }), /Unknown key "reserveTokens"/);
	assert.throws(() => parseConfig({ models: { x: { thresholdTokens: 5 } } }), /Unknown key "thresholdTokens"/);
	assert.throws(() => parseConfig({ models: { " x": {} } }), /whitespace/);
	assert.throws(() => parseConfig({ models: { x: 60 } }), /must be an object/);
	assert.throws(() => parseConfig([]), /JSON object/);
});

test("the threshold is a share of the model's own window", () => {
	assert.equal(thresholdTokens(1_000_000, 80), 800_000);
	assert.equal(thresholdTokens(128_000, 75), 96_000);
	assert.equal(thresholdTokens(200_000, 62.5), 125_000);
});

test("the env var path wins over the agent dir", () => {
	assert.equal(resolveConfigPath("/agent", undefined), "/agent/auto-compact.json");
	assert.equal(resolveConfigPath("/agent", "/elsewhere/ac.json"), "/elsewhere/ac.json");
});

test("a missing file means defaults; an invalid file is an error", () => {
	const dir = mkdtempSync(join(tmpdir(), "auto-compact-config-"));
	const missing = loadConfig(join(dir, "none.json"));
	assert.equal(missing.ok && missing.missing, true);
	const broken = join(dir, "broken.json");
	writeFileSync(broken, "{");
	assert.equal(loadConfig(broken).ok, false);
});
