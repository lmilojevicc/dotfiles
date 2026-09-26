import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { collectDetails, promptAttribution } from "../breakdown.ts";
import { visibleRange } from "../dialog.ts";

function mock(prompt: string, options: object, entries: object[] = []): any {
	return { getSystemPrompt: () => prompt, getSystemPromptOptions: () => options,
		sessionManager: { buildContextEntries: () => entries } };
}
test("prompt attribution counts exact nonoverlapping spans including memory wrappers and leaves skill intro in system", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-test-"));
	try {
		const file = join(dir, "SKILL.md"); writeFileSync(file, "# large source\n".repeat(100));
		const skill = { name: "foo", description: "Use <foo>", filePath: file };
		const advert = formatSkillsForPrompt([skill]).trim();
		const memory = '<project_instructions path="AGENTS.md">\nABCD\n</project_instructions>';
		const prompt = `prefix\n${memory}\n${advert}\nsuffix`;
		const categories = collectDetails(mock(prompt, { selectedTools: ["read"], contextFiles: [{ path: "AGENTS.md", content: "ABCD" }], skills: [skill] }), []);
		const [system, memories, skills] = categories;
		assert.equal(system.tokens + memories.tokens + skills.tokens, Math.ceil(prompt.length / 4));
		assert.equal(memories.items[0].content, memory);
		assert.match(skills.items[0].content, /<description>Use &lt;foo&gt;<\/description>/);
		assert.equal(skills.items[0].children?.[0].tokens, 0);
		assert.match(skills.items[0].children?.[0].source ?? "", /SOURCE — NOT LOADED/);
		assert.match(skills.items[0].children?.[0].content ?? "", /large source/);
		assert.ok(system.items.some((item) => item.content.includes("The following skills")));
		assert.ok(!skills.items[0].content.includes("The following skills"));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
test("forced prompt, repeated content and overlapping spans do not double count", () => {
	const data = promptAttribution("abcdabcd", [
		{ category: "Memory", label: "one", text: "abcd", source: "loaded" },
		{ category: "Memory", label: "two", text: "abcd", source: "loaded" },
		{ category: "Skills", label: "absent", text: "abcde", source: "loaded" },
	]).items;
	assert.equal(data.Memory.reduce((s, item) => s + item.tokens, 0), 2);
	assert.equal(data.Skills.length, 0);
	const forced = collectDetails(mock("opaque", { selectedTools: ["read"], contextFiles: [{ path: "a", content: "opaque" }] }), []);
	assert.equal(forced[1].tokens, 0);
	assert.equal(forced[0].tokens, 2);
});
test("active tools expose local registered schema; entries are locally inspectable", () => {
	const categories = collectDetails(mock("", { selectedTools: ["read"] }, [
		{ type: "message", message: { role: "user", content: "hello" } },
		{ type: "message", message: { role: "toolResult", toolName: "read", content: "output" } },
	]), [
		{ name: "read", description: "get file", parameters: { type: "object", properties: { path: { type: "string" } } } },
		{ name: "bash", description: "no", parameters: {} },
	] as any);
	assert.deepEqual(categories[3].items.map((item) => item.label), ["read"]);
	assert.match(categories[3].items[0].content, /"path"/);
	assert.match(categories[3].items[0].source, /not provider wire/);
	assert.match(categories[4].items[0].content, /output/);
	assert.match(categories[5].items[0].content, /hello/);
});
test("model-visible projection takes precedence over raw pre-edit messages and compacted history", () => {
	const ctx = mock("system", { selectedTools: [] }, [
		{ type: "message", message: { role: "user", content: "OLD-DROPPED" } },
		{ type: "message", message: { role: "toolResult", content: "OLD-RESULT" } },
	]);
	ctx.sessionManager.buildSessionProjection = () => ({ entries: [
		{ sourceEntry: { type: "compaction" }, messages: [{ role: "compactionSummary", summary: "CURRENT-SUMMARY" }] },
		{ sourceEntry: { type: "message" }, messages: [] }, // omitted by a context edit
		{ sourceEntry: { type: "message" }, messages: [{ role: "user", content: "REPLACED" }] },
		{ sourceEntry: { type: "message" }, messages: [{ role: "toolResult", toolName: "read", content: "NEW-RESULT" }] },
		{ sourceEntry: { type: "compaction" }, messages: [{ role: "system", content: "checkpoint" }] },
	] });
	const categories = collectDetails(ctx, []);
	assert.deepEqual(categories[5].items.map((item) => item.label), ["Message: compactionSummary", "Message: user"]);
	assert.match(categories[5].items[1].content, /REPLACED/);
	assert.doesNotMatch(JSON.stringify(categories), /OLD-DROPPED|OLD-RESULT|checkpoint/);
	assert.match(categories[4].items[0].content, /NEW-RESULT/);
	assert.match(categories[5].items[0].source, /MODEL-VISIBLE LOCAL SESSION PROJECTION/);
	assert.equal(categories[0].tokens, Math.ceil("system".length / 4));
});
test("raw entry fallback is compaction-aware but explicitly cannot reflect context edits", () => {
	const categories = collectDetails(mock("", { selectedTools: [] }, [
		{ type: "compaction", summary: "RETAINED-SUMMARY" },
		{ type: "message", message: { role: "user", content: "PRE-EDIT" } },
		{ type: "context_edit", targetId: "user", replacement: null },
	]), []);
	assert.deepEqual(categories[5].items.map((item) => item.label), ["Message: compactionSummary", "Message: user"]);
	assert.match(categories[5].items[0].content, /RETAINED-SUMMARY/);
	assert.match(categories[5].items[1].content, /PRE-EDIT/);
	assert.match(categories[5].items[1].source, /RAW COMPACTION-AWARE SESSION ENTRY.*context edits not applied; not necessarily model-visible/);
});
test("long lists keep selection inside viewport after resize", () => {
	assert.equal(visibleRange(99, 0, 100, 10), 90);
	assert.equal(visibleRange(4, 90, 100, 5), 4);
	assert.equal(visibleRange(99, 90, 100, 2), 98);
	assert.equal(visibleRange(0, 0, 0, 1), 0);
});
