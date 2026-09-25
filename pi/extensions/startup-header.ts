import { homedir } from "node:os";
import { sep } from "node:path";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const logo = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];
const logoWidth = visibleWidth(logo[0]);
const animationDurationMs = 3000;
const frameDelayMs = 1000 / 60;
const palette: [number, number, number][] = [
	[248, 79, 204], // magenta
	[147, 98, 244], // purple
	[0, 219, 228], // cyan
];

type Rgb = [number, number, number];

function blend(from: Rgb, to: Rgb, amount: number): Rgb {
	return from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount)) as Rgb;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function animatedRow(row: string, progress: number, colorDepth: number, rowOffset = 0): string {
	const rowWidth = visibleWidth(row);
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
			const color = blend(palette[first], palette[(first + 1) % palette.length], position - first);
			const shine = Math.max(0, 1 - Math.abs(currentColumn - shinePosition) / 2);
			const [red, green, blue] = blend(color, [255, 255, 255], shine * 0.45);
			const escape =
				colorDepth >= 24
					? `\x1b[38;2;${red};${green};${blue}m`
					: `\x1b[38;5;${16 + 36 * Math.round((red * 5) / 255) + 6 * Math.round((green * 5) / 255) + Math.round((blue * 5) / 255)}m`;
			return `${escape}${cell}\x1b[39m`;
		})
		.join("");
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
		const colorDepth = process.stdout.getColorDepth?.() ?? 24;
		const noColor = process.env.NO_COLOR !== undefined;
		const animate = process.env.PI_HEADER_ANIMATE !== "0" && !noColor && colorDepth >= 8;
		let progress = animate ? 0 : 1;
		let nextFrame = 1;
		const startTime = performance.now();
		const version = stripTerminalControls(`Pi Agent v${VERSION}`);
		const cwd = displayCwd(ctx.cwd);
		ctx.ui.setHeader((tui, theme) => {
			requestRender = () => tui.requestRender();
			const blue = (text: string) => (noColor ? text : theme.fg("accent", text));
			return {
				invalidate() {},
				render(width: number): string[] {
					const logoLines = width < logoWidth ? ["π"] : logo;
					const renderRow = (text: string, rowOffset: number, colored = animate): string => {
						const clipped = truncateToWidth(text, width, "");
						if (!clipped) return center("", width);
						return center(colored ? animatedRow(clipped, progress, colorDepth, rowOffset) : blue(clipped), width);
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
