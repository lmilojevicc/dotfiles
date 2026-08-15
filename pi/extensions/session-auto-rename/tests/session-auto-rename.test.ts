import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTitle } from "../title.ts";

test("removes reasoning blocks and keeps the first nonblank title line", () => {
	assert.equal(
		normalizeTitle([
			"<think>considering options\ncarefully</think>\n",
			"<analysis>hidden</analysis>\nConcise title\nIgnored explanation",
		]),
		"Concise title",
	);
});

test("sanitizes candidates before selecting a line or stripping quotes", () => {
	assert.equal(normalizeTitle(["\u200B\nValid title"]), "Valid title");
	assert.equal(normalizeTitle(["\u200D\nValid title"]), "Valid title");
	assert.equal(normalizeTitle(["\u200B\"Quoted title\"\u200B"]), "Quoted title");
	assert.equal(normalizeTitle(["\u200D\"Quoted title\"\u200C"]), "Quoted title");
	assert.equal(normalizeTitle(["\"\u200DQuoted title\u200C\""]), "Quoted title");
	assert.equal(normalizeTitle(["`Code title`"]), "Code title");
});

test("replaces unsafe controls while preserving Unicode join controls", () => {
	assert.equal(normalizeTitle(["Safe\u0000title\u200B   here"]), "Safe title here");
	assert.equal(normalizeTitle(["👩‍💻 and می‌روم"]), "👩‍💻 and می‌روم");
});

test("recognizes Unicode and control line boundaries", () => {
	for (const separator of ["\r\n", "\r", "\n", "\v", "\f", "\u0085", "\u2028", "\u2029"]) {
		assert.equal(normalizeTitle([`First title${separator}Ignored explanation`]), "First title");
	}
});

test("rejects blank output", () => {
	assert.equal(normalizeTitle(["<think>only reasoning</think>\n\u200B"]), undefined);
});

test("truncates by Unicode code point without splitting astral characters", () => {
	const title = normalizeTitle(["😀".repeat(51)]);
	assert.equal(title, `${"😀".repeat(47)}...`);
	assert.equal(Array.from(title ?? "").length, 50);
});
