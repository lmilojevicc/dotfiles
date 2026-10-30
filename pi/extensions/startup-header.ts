import { homedir } from "node:os";
import { sep } from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	colorToRgb,
	foregroundAnsi,
	mixColors,
	rgbColor,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Color,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";

const logo = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];
const logoWidth = visibleWidth(logo[0]);
const animationDurationMs = 3000;
const frameDelayMs = 1000 / 60;
const palette: Color[] = [
	rgbColor(248, 79, 204), // magenta
	rgbColor(147, 98, 244), // purple
	rgbColor(0, 219, 228), // cyan
];
const white = rgbColor(255, 255, 255);

function clampChannel(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function animatedRow(row: string, progress: number, colorMode: TerminalColorMode, rowOffset = 0): string {
	const rowWidth = visibleWidth(row);
	if (rowWidth <= 0) return row;
	const offset = rowOffset * 0.3;
	const shinePosition = progress * (rowWidth + 4 + offset) - 2 - offset;
	let column = 0;
	return [...graphemes.segment(row)]
		.map(({ segment: cell }) => {
			const currentColumn = column;
			const cellWidth = visibleWidth(cell);
			column += cellWidth;
			if (cell === " " || cellWidth === 0) return cell;
			const position = ((currentColumn / rowWidth) * 1.6 + progress * 2.2 + rowOffset * 0.15) % palette.length;
			const first = Math.floor(position);
			const color = mixColors(palette[first], palette[(first + 1) % palette.length], position - first, "srgb");
			const shine = Math.max(0, 1 - Math.abs(currentColumn - shinePosition) / 2);
			const lit = colorToRgb(mixColors(color, white, shine * 0.45, "srgb"));
			const ansi = foregroundAnsi(rgbColor(clampChannel(lit.r), clampChannel(lit.g), clampChannel(lit.b)), colorMode);
			return `${ansi}${cell}\x1b[39m`;
		})
		.join("");
}

/**
 * Clip plain text to `width` visible columns.
 *
 * `truncateToWidth` appends an ANSI reset whenever it clips (with an empty ellipsis too), so its
 * result is not plain text. Colouring such a result turns the reset's `[`, `0` and `m` bytes into
 * animated glyphs and leaves a dangling `ESC` on the line, so strip it here.
 */
export function clipPlainText(text: string, width: number): string {
	if (width <= 0) return "";
	const plain = stripTerminalSequences(text);
	return stripTerminalSequences(truncateToWidth(plain, width, ""));
}

function center(line: string, width: number): string {
	const text = truncateToWidth(line, width, "");
	return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
}

function stripTerminalControls(text: string): string {
	return text
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x9d[^\x07\x9c]*(?:\x07|\x9c)/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

function displayCwd(cwd: string): string {
	const path = stripTerminalControls(cwd);
	const home = stripTerminalControls(homedir());
	return home && path === home ? "~" : home && path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export default function startupHeader(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let requestRender: (() => void) | undefined;
	let session = 0;

	function stopAnimation(): void {
		session++;
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		requestRender = undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		stopAnimation();
		if (ctx.mode !== "tui") return;

		const currentSession = session;
		const noColor = process.env.NO_COLOR !== undefined;
		// The gradient needs at least 256 colours to look like a gradient. This probe only decides whether
		// to animate; which SGR sequences are emitted follows Pi's theme mode below.
		const colorDepth = process.stdout.getColorDepth?.() ?? 0;
		const animate = process.env.PI_HEADER_ANIMATE !== "0" && !noColor && colorDepth >= 8;
		let progress = animate ? 0 : 1;
		let nextFrame = 1;
		const startTime = performance.now();
		const version = stripTerminalControls(`Pi Agent v${VERSION}`);
		const cwd = displayCwd(ctx.cwd);
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			// Emit the colour mode Pi negotiated for this terminal instead of probing stdout: in tmux with
			// TERM=screen-256color, Node's getColorDepth() claims truecolor while Pi (correctly) uses 256.
			const colorMode = theme.getColorMode();
			const blue = (text: string) => (noColor ? text : theme.fg("accent", text));
			return {
				invalidate() {},
				render(width: number): string[] {
					const logoLines = width < logoWidth ? ["π"] : logo;
					const renderRow = (text: string, rowOffset: number, colored = animate): string => {
						const clipped = clipPlainText(text, width);
						if (!clipped) return center("", width);
						return center(colored ? animatedRow(clipped, progress, colorMode, rowOffset) : blue(clipped), width);
					};
					return [
						"",
						...logoLines.map((line) => renderRow(line, 0, animate && width >= logoWidth)),
						"",
						renderRow(version, 6),
						renderRow(cwd, 7),
						"",
					];
				},
			};
		});

		function scheduleFrame(): void {
			const due = startTime + Math.min(nextFrame * frameDelayMs, animationDurationMs);
			timer = setTimeout(advance, Math.max(1, Math.ceil(due - performance.now())));
		}

		function advance(): void {
			if (currentSession !== session) return;
			timer = undefined;
			const elapsed = Math.max(0, performance.now() - startTime);
			progress = Math.min(1, elapsed / animationDurationMs);
			requestRender?.();
			if (progress < 1) {
				nextFrame = Math.max(nextFrame + 1, Math.floor(elapsed / frameDelayMs) + 1);
				scheduleFrame();
			}
		}
		if (animate) scheduleFrame();
	});

	pi.on("session_shutdown", () => stopAnimation());
}
