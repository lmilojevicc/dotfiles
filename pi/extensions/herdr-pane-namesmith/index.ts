import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renameHerdrPane } from "./herdr.ts";

export interface NamesmithDependencies {
	env: NodeJS.ProcessEnv;
	rename: typeof renameHerdrPane;
}

type Rename = {
	paneId: string;
	socketPath: string;
	name: string | undefined;
	warn: () => void;
};

function sameRename(left: Rename | undefined, right: Rename): boolean {
	return left?.paneId === right.paneId && left.socketPath === right.socketPath && left.name === right.name;
}

export function createHerdrPaneNamesmith(
	pi: ExtensionAPI,
	dependencies: NamesmithDependencies = { env: process.env, rename: renameHerdrPane },
): void {
	let closed = false;
	let pending: Rename | undefined;
	let running: Promise<void> | undefined;
	let successful: Rename | undefined;
	let attemptedTarget: Pick<Rename, "paneId" | "socketPath"> | undefined;
	let shutdown: Promise<void> | undefined;
	let warned = false;

	async function drain(): Promise<void> {
		while (!closed && pending) {
			const rename = pending;
			pending = undefined;
			if (sameRename(successful, rename)) continue;
			// Even a failed request may have changed this target's label.
			attemptedTarget = { paneId: rename.paneId, socketPath: rename.socketPath };
			try {
				await dependencies.rename(rename.paneId, rename.socketPath, rename.name);
				successful = rename;
				warned = false;
			} catch {
				// Failed requests may have changed the pane; only acknowledged success deduplicates.
				successful = undefined;
				if (!closed && !warned) {
					warned = true;
					try {
						rename.warn();
					} catch {
						// Notifications must not turn background transport failures into rejections.
					}
				}
			}
		}
	}

	function startDrain(): void {
		if (closed || running || !pending) return;
		running = drain().then(() => {
			running = undefined;
			// A later explicit /name must reassert the label even after a manual Herdr rename.
			successful = undefined;
			// An event can enqueue work between drain's completion and this continuation.
			startDrain();
		});
	}

	function synchronize(name: string | undefined, ctx: ExtensionContext): void {
		const { HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID } = dependencies.env;
		if (closed || ctx.mode !== "tui" || HERDR_ENV !== "1" || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return;
		pending = {
			paneId: HERDR_PANE_ID,
			socketPath: HERDR_SOCKET_PATH,
			name: name || undefined,
			warn: () => ctx.ui.notify("Herdr pane name sync failed; will retry on the next name/session event.", "warning"),
		};
		startDrain();
	}

	pi.on("session_start", (_event, ctx) => synchronize(pi.getSessionName(), ctx));
	pi.on("session_info_changed", (event, ctx) => synchronize(event.name, ctx));
	// Pi creates a fresh extension runtime after reload/new/resume/fork; never reopen this one.
	pi.on("session_shutdown", (event) => {
		if (shutdown) return shutdown;
		closed = true;
		pending = undefined;
		shutdown = (async () => {
			await running;
			if (event.reason !== "quit" || !attemptedTarget) return;
			try {
				await dependencies.rename(attemptedTarget.paneId, attemptedTarget.socketPath, undefined);
			} catch {
				// Exit cleanup is bounded and best effort; never notify a stopped TUI.
			}
		})();
		return shutdown;
	});
}

export default function herdrPaneNamesmith(pi: ExtensionAPI): void {
	createHerdrPaneNamesmith(pi);
}
