import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "../config.ts";

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

test("config reads fresh; unreadable/non-file warn without repair", (t) => {
	const root = mkdtempSync(join(tmpdir(), "picker-config-path-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "config.json"), notices: string[] = [];
	const read = () => readConfig((message) => notices.push(message), path);
	writeFileSync(path, '{"vimMode":true}'); assert.equal(read().vimMode, true);
	writeFileSync(path, '{"vimMode":false}'); assert.equal(read().vimMode, false);
	chmodSync(path, 0); assert.equal(read().vimMode, false); assert.equal(notices.length, 1);
	chmodSync(path, 0o600); assert.equal(readFileSync(path, "utf8"), '{"vimMode":false}');
	rmSync(path); mkdirSync(path);
	assert.equal(read().vimMode, false); assert.equal(notices.length, 2);
	assert.ok(notices.every((message) => message.includes(path)));
	assert.equal(lstatSync(path).isDirectory(), true);
});

function isolatedHome(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "picker-config-home-"));
	const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = root;
	delete process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

test("config resolves default HOME and changing PI_CODING_AGENT_DIR at call time, never falling back or creating directories", (t) => {
	const home = isolatedHome(t);
	const defaultRoot = join(home, ".pi", "agent");
	mkdirSync(defaultRoot, { recursive: true });
	const defaultPath = join(defaultRoot, "model-picker.json");
	const bytes = '{"vimMode":true}\n';
	writeFileSync(defaultPath, bytes);
	const notices: string[] = [];
	const read = () => readConfig((message) => notices.push(message));
	assert.equal(read().vimMode, true);
	const first = join(home, "first-agent"), second = join(home, "second-agent");
	mkdirSync(first); mkdirSync(second);
	writeFileSync(join(first, "model-picker.json"), '{"vimMode":false}');
	writeFileSync(join(second, "model-picker.json"), bytes);
	process.env.PI_CODING_AGENT_DIR = first; assert.equal(read().vimMode, false);
	process.env.PI_CODING_AGENT_DIR = second; assert.equal(read().vimMode, true);
	const absent = join(home, "absent", "agent");
	process.env.PI_CODING_AGENT_DIR = absent;
	assert.equal(read().vimMode, false, "must not fall back to the default home config");
	assert.equal(existsSync(join(home, "absent")), false, "opening must not create agent directories or config");
	delete process.env.PI_CODING_AGENT_DIR;
	assert.equal(read().vimMode, true);
	rmSync(defaultPath);
	assert.equal(read().vimMode, false);
	assert.equal(existsSync(defaultPath), false);
	assert.deepEqual(notices, []);
	assert.equal(readFileSync(join(first, "model-picker.json"), "utf8"), '{"vimMode":false}');
	assert.equal(readFileSync(join(second, "model-picker.json"), "utf8"), bytes);
});

test("config follows an agent-root symlink read-only without replacing link or target", (t) => {
	const home = isolatedHome(t);
	const agent = join(home, "agent"); mkdirSync(agent);
	process.env.PI_CODING_AGENT_DIR = agent;
	const target = join(home, "dotfiles-model-picker.json"), path = join(agent, "model-picker.json");
	const bytes = '{"vimMode":true,"extra":123}\n';
	writeFileSync(target, bytes); chmodSync(target, 0o400);
	symlinkSync(target, path);
	const notices: string[] = [];
	assert.deepEqual(readConfig((message) => notices.push(message)), { vimMode: true });
	assert.deepEqual(notices, []);
	assert.equal(lstatSync(path).isSymbolicLink(), true);
	assert.equal(readlinkSync(path), target);
	assert.equal(readFileSync(target, "utf8"), bytes);
	assert.equal(lstatSync(target).mode & 0o777, 0o400);
});
