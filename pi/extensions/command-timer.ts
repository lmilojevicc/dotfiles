import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Timer = ReturnType<typeof setInterval>;

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) {
		return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	}

	if (totalMinutes > 0) {
		return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
	}

	return `${seconds}s`;
}

export default function commandTimer(pi: ExtensionAPI): void {
	let timer: Timer | undefined;
	let startedAt = 0;
	let activeCtx: ExtensionContext | undefined;

	function clearTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function render(): void {
		if (!activeCtx) return;
		const elapsedMs = Date.now() - startedAt;
		activeCtx.ui.setWorkingMessage(`Cooking · ${formatElapsed(elapsedMs)}`);
	}

	function reset(ctx?: ExtensionContext): void {
		clearTimer();
		activeCtx = undefined;
		startedAt = 0;
		ctx?.ui.setWorkingMessage();
	}

	pi.on("agent_start", (_event, ctx) => {
		reset();
		activeCtx = ctx;
		startedAt = Date.now();
		render();
		timer = setInterval(render, 1000);
	});

	pi.on("agent_end", (_event, ctx) => {
		reset(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		reset(ctx);
	});
}
