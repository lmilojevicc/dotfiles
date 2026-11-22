import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanOutput, OutputView, type OutputLoader } from "../output-view.ts";
import type { PanelTheme } from "../panel.ts";
import type { BackgroundJobOutput } from "../protocol.ts";
import type { TabJob } from "../registry.ts";

const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
};

/** Plain text: every style is dropped, so rows can be matched as text. */
const plain: PanelTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const identity = (text: string) => text;
const markdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function job(overrides: Partial<TabJob> = {}): TabJob {
	return {
		id: "1",
		source: "bash",
		key: "bash:1",
		title: "make build",
		status: "running",
		depth: 0,
		last: false,
		childCount: 0,
		...overrides,
	};
}

/** A bordered overlay line without its outer blank columns and `│` sides. */
const unbox = (line: string) => line.trim().replace(/^│ /, "").replace(/ │$/, "").trimEnd();

async function view(
	load: OutputLoader,
	options: {
		title?: string;
		job?: TabJob;
		current?: () => TabJob | undefined;
		rows?: () => number;
		markdown?: boolean;
	} = {},
): Promise<{
	render: (width: number) => string[];
	handleInput: (data: string) => void;
	dispose: () => void;
	isClosed: () => boolean;
}> {
	const entry = options.job ?? job();
	let closed = false;
	const instance = new OutputView(
		options.title ?? "Shell output",
		options.current ?? (() => entry),
		entry,
		plain,
		options.rows ?? (() => 20),
		load,
		() => {
			closed = true;
		},
		() => {},
		options.markdown ? markdownTheme : undefined,
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	return {
		render: (width: number) => instance.render(width),
		handleInput: (data: string) => instance.handleInput(data),
		dispose: () => instance.dispose(),
		isClosed: () => closed,
	};
}

describe("cleanOutput", () => {
	it("strips colors, keeps the last redraw of a line, and drops trailing blanks", () => {
		assert.deepEqual(cleanOutput("\x1b[31mred\x1b[0m\r\nstep 1\rstep 2\n\n"), ["red", "step 2"]);
	});

	it("expands tabs and bounds the kept lines", () => {
		const lines = cleanOutput(
			`a\tb\n${Array.from({ length: 6000 }, (_, i) => `l${i}`).join("\n")}`,
		);
		assert.ok(lines.length <= 5000);
		assert.equal(lines[0], "l1000");
	});
});

describe("output view", () => {
	it("frames like pi-interactive-shell: rounded border, blank outer columns, status and hints", async () => {
		const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
		const instance = await view(() => Promise.resolve({ heading: "$ yes", text }));
		const raw = instance.render(60);
		assert.ok(raw.length > 10);
		for (const line of raw) {
			assert.equal(line.startsWith(" "), true);
			assert.equal(line.endsWith(" "), true);
			assert.equal(line.length, 60);
		}
		const lines = raw.map(unbox);
		assert.match(lines[0], /^╭─+╮$/);
		assert.match(lines[1], /\$ yes +Running {2}esc$/);
		assert.equal(lines[2], "Shell output");
		assert.match(lines[3], /^├─+┤$/);
		assert.equal(
			lines.some((line) => line === "line 50"),
			true,
		);
		assert.match(lines.at(-3) ?? "", /^├─+┤$/);
		assert.equal(lines.at(-2), "scroll ↑/↓  follow end  back esc");
		assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
		instance.dispose();
	});

	it("follows the end until scrolled, shows the scrolled divider, and Esc closes", async () => {
		const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n");
		const instance = await view(() => Promise.resolve({ text }));
		let lines = instance.render(60).map(unbox);
		assert.equal(
			lines.some((line) => line === "line 50"),
			true,
		);
		assert.match(lines.at(-3) ?? "", /^├─+┤$/);
		instance.handleInput(KEY.up);
		lines = instance.render(60).map(unbox);
		assert.equal(
			lines.some((line) => line === "line 50"),
			false,
		);
		assert.equal(
			lines.some((line) => line === "line 49"),
			true,
		);
		assert.ok((lines.at(-3) ?? "").includes("── ↑ scrolled ──"));
		instance.handleInput(KEY.home);
		lines = instance.render(60).map(unbox);
		assert.equal(
			lines.some((line) => line === "line 1"),
			true,
		);
		instance.handleInput(KEY.end);
		assert.equal(
			instance
				.render(60)
				.map(unbox)
				.some((line) => line === "line 50"),
			true,
		);
		instance.handleInput(KEY.pageUp);
		instance.handleInput(KEY.pageDown);
		assert.equal(
			instance
				.render(60)
				.map(unbox)
				.some((line) => line === "line 50"),
			true,
		);
		instance.handleInput(KEY.escape);
		assert.equal(instance.isClosed(), true);
	});

	it("shows the error when loading fails or the output is gone, then recovers", async () => {
		const output: BackgroundJobOutput | undefined = { text: "fine" };
		const instance = await view(() => Promise.resolve(output));
		assert.equal(
			instance
				.render(60)
				.map(unbox)
				.some((line) => line === "fine"),
			true,
		);
		await new Promise((resolve) => setTimeout(resolve, 1050));
		assert.equal(
			instance
				.render(60)
				.map(unbox)
				.some((line) => line === "fine"),
			true,
		);
		instance.dispose();
		const failing = await view(() => Promise.reject(new Error("boom")));
		assert.equal(
			failing
				.render(60)
				.map(unbox)
				.some((line) => line.includes("Could not read the output: boom")),
			true,
		);
		failing.dispose();
		const gone = await view(() => Promise.resolve(undefined));
		assert.equal(
			gone
				.render(60)
				.map(unbox)
				.some((line) => line.includes("no longer available")),
			true,
		);
		gone.dispose();
	});

	it("renders markdown like an assistant message and keeps plain output wrapped", async () => {
		const markdown = await view(
			() =>
				Promise.resolve({
					text: "# Findings\n\n- **one** thing\n- two",
					format: "markdown" as const,
				}),
			{ markdown: true, title: "Subagent output" },
		);
		const lines = markdown.render(60).map(unbox);
		assert.equal(
			lines.some((line) => line === "Findings"),
			true,
		);
		assert.equal(
			lines.some((line) => /^• one thing$|^- one thing$/.test(line)),
			true,
		);
		assert.equal(
			lines.some((line) => line.includes("**")),
			false,
		);
		markdown.dispose();

		const long = "word ".repeat(30).trim();
		const plainText = await view(() => Promise.resolve({ text: long }));
		assert.equal(
			plainText.render(40).every((line) => line.length <= 40),
			true,
		);
		plainText.dispose();
	});

	it("reflects the job's live status through the current getter", async () => {
		let entry = job();
		const instance = await view(() => Promise.resolve({ text: "x" }), {
			current: () => entry,
			job: entry,
		});
		assert.match(instance.render(60).map(unbox)[1], /Running/);
		entry = job({ status: "failed", badge: "Exited 1" });
		assert.match(instance.render(60).map(unbox)[1], /make build +Exited 1 {2}esc$/);
		instance.dispose();
	});

	it("shows no output yet for empty text", async () => {
		const instance = await view(() => Promise.resolve({ text: "" }));
		assert.equal(
			instance
				.render(60)
				.map(unbox)
				.some((line) => line === "(no output yet)"),
			true,
		);
		instance.dispose();
	});
});
