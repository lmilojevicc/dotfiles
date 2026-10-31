import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskGlyphs } from "../src/ui/task-glyphs.ts";

test("resolves the exact upstream glyph inventory", () => {
	assert.deepEqual(resolveTaskGlyphs(undefined), {
		completed: "✔", inProgress: "◼", pending: "◻",
		spinner: ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
		completedSummary: "✔", header: "●", overflow: "…", blocked: "›",
		inputTokens: "↑", outputTokens: "↓", statsSeparator: "·", trailingEllipsis: "…", truncation: "...",
	});
});

test("accepts printable multichar glyphs and inherits completed summary", () => {
	const glyphs = resolveTaskGlyphs({ completed: "[x]", pending: " ", spinner: ["ab", "🟢"] });
	assert.equal(glyphs.completed, "[x]");
	assert.equal(glyphs.completedSummary, "[x]");
	assert.equal(glyphs.pending, " ");
	assert.deepEqual(glyphs.spinner, ["ab", "🟢"]);
});

test("unsafe fields fall back independently and one bad frame resets the spinner", () => {
	const glyphs = resolveTaskGlyphs({ header: "\u001b]0;bad", pending: "P", blocked: "\u202e", spinner: ["ok", "\n"] });
	assert.equal(glyphs.header, "●");
	assert.equal(glyphs.pending, "P");
	assert.equal(glyphs.blocked, "›");
	assert.equal(glyphs.spinner.length, 11);
});
