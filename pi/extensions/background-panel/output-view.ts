/**
 * A job's output in a bordered overlay, like OpenCode's "Shell output" dialog: it rereads the
 * output every second through the `output` action of the background-jobs protocol, follows the end
 * until the user scrolls up, and goes back to the panel on Esc. Markdown output (a subagent's
 * transcript) renders with Pi's own Markdown component, as in the session. Framed like
 * pi-interactive-shell's popup: rounded corners in the theme's border color, no fill, the command
 * in accent with its status on the right, a dim info row, `├─┤` around the body (`── ↑ scrolled ──`
 * while not following) and one blank column outside each side, so the chat behind never touches
 * the border.
 */
import {
	isKeyRelease,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { PanelTheme } from "./panel.ts";
import type { BackgroundJobOutput } from "./protocol.ts";
import type { TabJob } from "./registry.ts";

const POLL_MS = 1000;
const MAX_LINES = 5000;

const STATUS_TEXT: Record<TabJob["status"], string> = {
	running: "Running",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
};

/** Plain text output: strip colors and keep only what each `\r` redraw left on the line. */
export function cleanOutput(text: string): string[] {
	const lines = stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		// A carriage return redraws the line (progress bars): keep what was drawn last.
		.split("\n")
		.map((line) => line.slice(line.lastIndexOf("\r") + 1).replace(/\t/g, "    "));
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines.slice(-MAX_LINES);
}

/** Reads the job's output through the protocol; rejects when the action fails or times out. */
export type OutputLoader = (job: TabJob) => Promise<BackgroundJobOutput | undefined>;

export class OutputView {
	private output: BackgroundJobOutput | undefined;
	private error: string | undefined;
	/** Lines scrolled up from the end; 0 follows new output. */
	private fromEnd = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private loading = false;
	private pageRows = 10;

	private readonly title: string;
	private readonly current: () => TabJob | undefined;
	private readonly job: TabJob;
	private readonly theme: PanelTheme;
	private readonly rows: () => number;
	private readonly load: OutputLoader;
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private readonly markdownTheme: MarkdownTheme | undefined;
	private markdown: { text: string; width: number; lines: string[] } | undefined;

	constructor(
		title: string,
		current: () => TabJob | undefined,
		job: TabJob,
		theme: PanelTheme,
		rows: () => number,
		load: OutputLoader,
		done: () => void,
		requestRender: () => void,
		markdownTheme?: MarkdownTheme,
	) {
		this.markdownTheme = markdownTheme;
		this.title = title;
		this.current = current;
		this.job = job;
		this.theme = theme;
		this.rows = rows;
		this.load = load;
		this.done = done;
		this.requestRender = requestRender;
		void this.loadOutput();
		this.timer = setInterval(() => void this.loadOutput(), POLL_MS);
		this.timer.unref?.();
	}

	private async loadOutput(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		try {
			this.output = await this.load(this.job);
			this.error = this.output ? undefined : "The output is no longer available.";
		} catch (error) {
			this.output = undefined;
			this.error = `Could not read the output: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.loading = false;
		}
		this.requestRender();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q")
			return this.close();
		if (matchesKey(data, "up") || data === "k") this.fromEnd += 1;
		else if (matchesKey(data, "down") || data === "j") this.fromEnd = Math.max(0, this.fromEnd - 1);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u"))
			this.fromEnd += this.pageRows;
		else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d"))
			this.fromEnd = Math.max(0, this.fromEnd - this.pageRows);
		else if (matchesKey(data, "home") || data === "g") this.fromEnd = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, "end") || data === "G") this.fromEnd = 0;
		else return;
		this.requestRender();
	}

	private close(): void {
		this.dispose();
		this.done();
	}

	/** Body lines at `inner` columns: rendered markdown, or plain output wrapped. */
	private bodyLines(inner: number): string[] {
		const { theme, output } = this;
		if (this.error) return [theme.fg("warning", this.error)];
		if (output === undefined) return [theme.fg("muted", "Loading…")];
		if (output.format === "markdown" && this.markdownTheme && output.text.trim()) {
			if (this.markdown?.text !== output.text || this.markdown.width !== inner) {
				const lines = new Markdown(output.text, 0, 0, this.markdownTheme).render(inner);
				this.markdown = { text: output.text, width: inner, lines: [...lines] };
			}
			return this.markdown.lines;
		}
		return cleanOutput(output.text).flatMap((line) =>
			line === "" ? [""] : wrapTextWithAnsi(line, inner),
		);
	}

	render(width: number): string[] {
		const { theme } = this;
		// One blank column outside each side, so the chat behind never touches the border.
		const frame = Math.max(14, width - 2);
		// "│ " + content + " │"
		const inner = frame - 4;
		const height = Math.max(10, this.rows());
		const border = (text: string) => theme.fg("border", text);
		const dim = (text: string) => theme.fg("dim", text);
		const row = (content = ""): string => {
			const text = truncateToWidth(content, inner, "…");
			return `${border("│ ")}${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))}${border(" │")}`;
		};
		const rule = (left: string, right: string) => border(`${left}${"─".repeat(frame - 2)}${right}`);

		const job = this.current() ?? this.job;
		const status = theme.fg(
			job.status === "failed" ? "error" : job.status === "running" ? "success" : "muted",
			job.badge ?? STATUS_TEXT[job.status],
		);
		const right = `${status}  ${dim("esc")}`;
		const [first = job.title, ...rest] = (this.output?.heading ?? job.title)
			.split("\n")
			.map((part) => part.replace(/\s+/g, " ").trim())
			.filter(Boolean);
		const title = truncateToWidth(first, Math.max(1, inner - visibleWidth(right) - 1), "...");
		const header = `${theme.fg("accent", title)}${" ".repeat(Math.max(1, inner - visibleWidth(title) - visibleWidth(right)))}${right}`;
		const info = dim([this.title, ...rest].join(" • "));
		const top = [rule("╭", "╮"), row(header), row(info), rule("├", "┤")];

		const bodyRows = Math.max(1, height - top.length - 3);
		this.pageRows = Math.max(1, bodyRows - 1);
		const body = this.bodyLines(inner);
		const lines = body.length > 0 ? body : [theme.fg("muted", "(no output yet)")];
		const maxFromEnd = Math.max(0, lines.length - bodyRows);
		this.fromEnd = Math.min(this.fromEnd, maxFromEnd);
		const end = lines.length - this.fromEnd;
		const visible = lines.slice(Math.max(0, end - bodyRows), end).map((text) => row(text));
		while (visible.length < bodyRows) visible.push(row());

		const scrolled = "── ↑ scrolled ──";
		const pad = Math.max(0, Math.floor((frame - 2 - visibleWidth(scrolled)) / 2));
		const divider =
			this.fromEnd > 0
				? `${border("├")}${dim(`${" ".repeat(pad)}${scrolled}${" ".repeat(Math.max(0, frame - 2 - pad - visibleWidth(scrolled)))}`)}${border("┤")}`
				: rule("├", "┤");
		return [...top, ...visible, divider, row(this.hints()), rule("╰", "╯")].map(
			(line) => ` ${line} `,
		);
	}

	private hints(): string {
		const { theme } = this;
		const hint = (label: string, key: string) =>
			`${theme.bold(theme.fg("text", label))} ${theme.fg("muted", key)}`;
		// OpenCode's hints; PgUp/PgDn and Home work too.
		return [hint("scroll", "↑/↓"), hint("follow", "end"), hint("back", "esc")].join("  ");
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
