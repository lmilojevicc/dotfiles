/**
 * A Pi session file (session.jsonl) as markdown, so a subagent's run reads like a session: the task,
 * the assistant's text as markdown, thinking as a quote, and each tool call on one line with a short
 * result. Only the documented message entries are read; anything else is skipped. Used by bridges
 * that publish a subagent step's own Pi session as the `output` action's markdown.
 */

const MAX_BLOCKS = 300;
const THINKING_CHARS = 600;
const BASH_LINES = 6;
const TASK_LINES = 12;

type Part = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

interface Message {
	role?: string;
	content?: string | Part[];
	toolName?: string;
	isError?: boolean;
}

function texts(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function oneLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Backticks that survive any text inside: one more than the longest run in it. */
function inlineCode(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}${longest > 0 ? " " : ""}${text}${longest > 0 ? " " : ""}${fence}`;
}

function fenced(text: string): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	return `${fence}\n${text}\n${fence}`;
}

function quote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

function toolSummary(name: string, args: Record<string, unknown> = {}): string {
	const pick = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	const main =
		pick("command") ??
		pick("path") ??
		pick("file_path") ??
		pick("pattern") ??
		pick("query") ??
		pick("url");
	if (main) return oneLine(main, 160);
	const json = JSON.stringify(args);
	return json && json !== "{}" ? oneLine(json, 160) : "";
}

export function transcriptMarkdown(jsonl: string): string {
	const blocks: string[] = [];
	const pendingTools: string[] = [];
	for (const raw of jsonl.split("\n")) {
		if (!raw.trim()) continue;
		let entry: { type?: string; message?: Message };
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			const task = texts(message.content).trim();
			if (!task) continue;
			const lines = task.split("\n");
			const shown = lines.slice(0, TASK_LINES).join("\n");
			const more =
				lines.length > TASK_LINES ? `\n\n*… ${lines.length - TASK_LINES} more lines*` : "";
			blocks.push(quote(`**Task**\n\n${shown}${more}`));
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "text" && part.text?.trim()) blocks.push(part.text.trim());
				else if (part.type === "thinking" && part.thinking?.trim()) {
					const thought = part.thinking.trim();
					const short =
						thought.length > THINKING_CHARS ? `${thought.slice(0, THINKING_CHARS)}…` : thought;
					blocks.push(quote(`*Thinking:* ${short}`));
				} else if (part.type === "toolCall" && part.name) {
					const summary = toolSummary(part.name, part.arguments);
					blocks.push(`● **${part.name}**${summary ? ` ${inlineCode(summary)}` : ""}`);
					pendingTools.push(part.name);
				}
			}
		} else if (message.role === "toolResult") {
			const name = message.toolName ?? pendingTools.shift() ?? "";
			const output = texts(message.content).replace(/\s+$/, "");
			if (message.isError) {
				blocks.push(`**✗** ${oneLine(output || "failed", 200)}`);
			} else if (name === "bash" && output) {
				const lines = output.split("\n");
				const tail = lines.slice(-BASH_LINES).join("\n");
				const hidden =
					lines.length > BASH_LINES ? `*… ${lines.length - BASH_LINES} earlier lines*\n\n` : "";
				blocks.push(`${hidden}${fenced(tail)}`);
			} else if (output) {
				const count = output.split("\n").length;
				blocks.push(`*↳ ${count} line${count === 1 ? "" : "s"}*`);
			}
		}
	}
	const omitted =
		blocks.length > MAX_BLOCKS ? `*… ${blocks.length - MAX_BLOCKS} earlier entries*\n\n` : "";
	return omitted + blocks.slice(-MAX_BLOCKS).join("\n\n");
}
