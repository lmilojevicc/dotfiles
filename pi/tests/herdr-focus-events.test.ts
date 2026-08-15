import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { FocusEventScanner } from "../extensions/herdr-focus-cursor/focus-events.ts";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

test("finds coalesced focus reports in order", () => {
	const scanner = new FocusEventScanner();

	assert.deepEqual(scanner.scan(`prefix\x1b[Osuffix\x1b[I`), [false, true]);
});

test("reassembles focus reports split across stdin chunks", () => {
	const scanner = new FocusEventScanner();

	assert.deepEqual(scanner.scan("input\x1b"), []);
	assert.deepEqual(scanner.scan("[O"), [false]);
	assert.deepEqual(scanner.scan("\x1b["), []);
	assert.deepEqual(scanner.scan("I"), [true]);
});

test("ignores focus-looking data inside bracketed paste at every chunk boundary", () => {
	const stream = `${PASTE_START}before${FOCUS_OUT}${FOCUS_IN}after${PASTE_END}${FOCUS_OUT}`;

	for (let split = 0; split <= stream.length; split++) {
		const scanner = new FocusEventScanner();
		const changes = [...scanner.scan(stream.slice(0, split)), ...scanner.scan(stream.slice(split))];
		assert.deepEqual(changes, [false], `split at ${split}`);
	}

	const scanner = new FocusEventScanner();
	const changes = [...stream].flatMap((character) => scanner.scan(character));
	assert.deepEqual(changes, [false]);
});

test("reset clears bracketed-paste and partial-marker lifecycle state", () => {
	const scanner = new FocusEventScanner();

	assert.deepEqual(scanner.scan(`${PASTE_START}${FOCUS_OUT}\x1b[20`), []);
	scanner.reset();
	assert.deepEqual(scanner.scan(FOCUS_OUT), [false]);
});

test("a prepended listener sees focus before an existing fullscreen listener", () => {
	const stdin = new EventEmitter();
	const scanner = new FocusEventScanner();
	const calls: string[] = [];
	stdin.on("data", () => calls.push("fullscreen"));
	stdin.prependListener("data", (data: string) => {
		for (const focused of scanner.scan(data)) calls.push(`focus:${focused}`);
	});

	stdin.emit("data", "\x1b[O");

	assert.deepEqual(calls, ["focus:false", "fullscreen"]);
});

test("ignores unrelated terminal input and clears pending state", () => {
	const scanner = new FocusEventScanner();

	assert.deepEqual(scanner.scan("\x1b"), []);
	scanner.reset();
	assert.deepEqual(scanner.scan("[O"), []);
	assert.deepEqual(scanner.scan("\x1b[A"), []);
});
