import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSearchInput, sanitizeTerminalText } from "../src/ui/sanitize.ts";

test("terminal sanitizer removes ANSI, OSC, controls, tabs and newlines", () => {
	assert.equal(sanitizeTerminalText("a\u001b[31mred\u001b[0m\n\t\u001b]0;title\u0007b"), "ared b");
	assert.equal(sanitizeTerminalText("a\u0000\u0085b\r\n\tc"), "ab c");
	assert.equal(sanitizeTerminalText("left\u202eright\u2066end"), "leftrightend");
});

test("search sanitizer preserves editable spaces while removing terminal and line controls", () => {
	assert.equal(sanitizeSearchInput("  foo  bar  "), "  foo  bar  ");
	assert.equal(sanitizeSearchInput("foo\r\n\tbar"), "foo bar");
	assert.equal(sanitizeSearchInput("a\u001b[31mred\u001b[0m\u0000\u202eb"), "aredb");
});

test("terminal sanitizer removes RIS and DCS/APC control strings", () => {
	assert.equal(sanitizeTerminalText("a\u001bcb"), "ab");
	assert.equal(sanitizeTerminalText("a\u001bPprivate payload\u001b\\b"), "ab");
	assert.equal(sanitizeTerminalText("a\u001b_hidden payload\u001b\\b"), "ab");
	assert.equal(sanitizeTerminalText("a\u0090c1 payload\u009cb"), "ab");
});

test("terminal sanitizer drops unterminated OSC content and every remaining ESC byte", () => {
	assert.equal(sanitizeTerminalText("safe\u001b]0;untrusted title"), "safe");
	assert.equal(sanitizeTerminalText("left\u001b\u0001right"), "leftright");
	assert.doesNotMatch(sanitizeTerminalText("x\u001b?y"), /\u001b/);
});
