import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transcriptMarkdown } from "../transcript.ts";

const entry = (message: unknown) => JSON.stringify({ type: "message", message });

describe("transcript markdown", () => {
	it("reads a session as markdown: task, thinking, text, tool calls and short results", () => {
		const jsonl = [
			JSON.stringify({ type: "session", id: "x" }),
			entry({ role: "system", content: "You are a scout." }),
			entry({ role: "user", content: [{ type: "text", text: "List the files" }] }),
			entry({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Use ls." },
					{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls -la" } },
					{ type: "toolCall", id: "2", name: "read", arguments: { path: "/etc/os-release" } },
				],
			}),
			entry({
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "a\nb\nc\nd\ne\nf\ng\n" }],
			}),
			entry({
				role: "toolResult",
				toolName: "read",
				content: [{ type: "text", text: "NAME=NixOS\nID=nixos" }],
			}),
			entry({
				role: "toolResult",
				toolName: "grep",
				isError: true,
				content: [{ type: "text", text: "no such file\nmore" }],
			}),
			entry({ role: "assistant", content: [{ type: "text", text: "## Done\n\nTwo files." }] }),
			"not json",
		].join("\n");
		assert.equal(
			transcriptMarkdown(jsonl),
			[
				"> **Task**\n> \n> List the files",
				"> *Thinking:* Use ls.",
				"● **bash** `ls -la`",
				"● **read** `/etc/os-release`",
				"*… 1 earlier lines*\n\n```\nb\nc\nd\ne\nf\ng\n```",
				"*↳ 2 lines*",
				"**✗** no such file more",
				"## Done\n\nTwo files.",
			].join("\n\n"),
		);
	});

	it("quotes long thinking, caps the task, and fences around backticks", () => {
		const long = "x".repeat(700);
		const task = Array.from({ length: 14 }, (_, index) => `line ${index}`).join("\n");
		const markdown = transcriptMarkdown(
			[
				entry({ role: "user", content: [{ type: "text", text: task }] }),
				entry({ role: "assistant", content: [{ type: "thinking", thinking: long }] }),
				entry({
					role: "assistant",
					content: [{ type: "toolCall", name: "bash", arguments: { command: "echo `hi`" } }],
				}),
				entry({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "out" }] }),
			].join("\n"),
		);
		assert.ok(markdown.includes("line 11"));
		assert.ok(markdown.includes("*… 2 more lines*"));
		assert.ok(markdown.includes(`> *Thinking:* ${"x".repeat(600)}…`));
		assert.ok(markdown.includes("● **bash** `` echo `hi` ``"));
		assert.ok(markdown.includes("```\nout\n```"));
	});

	it("skips non-message entries and returns empty for blank input", () => {
		assert.equal(transcriptMarkdown(""), "");
		assert.equal(transcriptMarkdown(JSON.stringify({ type: "summary" })), "");
	});
});
