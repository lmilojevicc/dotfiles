import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { configPath, readConfig } from "../config.ts";

for (const [bytes, enabled, warning] of [
	[undefined, false, false], ["{}", false, false], ['{"vimMode":false}', false, false],
	['{"vimMode":true}', true, false], ['{"unknown":123}', false, false],
	['{"vimMode":true,"unknown":123}', true, false],
	["", false, true], ["{bad", false, true], ["null", false, true], ["[]", false, true],
	["true", false, true], ["42", false, true], ['"text"', false, true],
	['{"vimMode":"true"}', false, true], ['{"vimMode":1}', false, true],
	['{"vimMode":null}', false, true], ['{"vimMode":[]}', false, true],
] as const) test(`config reads without repair: ${bytes}`, (t) => {
	const root = mkdtempSync(join(tmpdir(), "picker-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "config.json"), notices: string[] = [];
	if (bytes !== undefined) writeFileSync(path, bytes);
	assert.deepEqual(readConfig((message) => notices.push(message), path), { vimMode: enabled });
	assert.equal(notices.length, warning ? 1 : 0);
	if (warning) {
		assert.ok(notices[0].includes(path));
		assert.match(notices[0], /using vimMode=false/);
		assert.equal(notices[0].split("\n").length, 1);
	}
	if (bytes === undefined) assert.equal(existsSync(path), false);
	else assert.equal(readFileSync(path, "utf8"), bytes);
});

test("config path is module-relative and reads fresh; unreadable/non-file warn", (t) => {
	assert.equal(configPath, fileURLToPath(new URL("../config.json", import.meta.url)));
	const root = mkdtempSync(join(tmpdir(), "picker-config-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "config.json"), notices: string[] = [];
	const read = () => readConfig((message) => notices.push(message), path);
	writeFileSync(path, '{"vimMode":true}'); assert.equal(read().vimMode, true);
	writeFileSync(path, '{"vimMode":false}'); assert.equal(read().vimMode, false);
	chmodSync(path, 0); assert.equal(read().vimMode, false); assert.equal(notices.length, 1);
	chmodSync(path, 0o600); rmSync(path); mkdirSync(path);
	assert.equal(read().vimMode, false); assert.equal(notices.length, 2);
	assert.ok(notices.every((message) => message.includes(path)));
});
