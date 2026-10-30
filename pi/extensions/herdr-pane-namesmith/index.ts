import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readHerdrPaneLabel, renameHerdrPane } from "./herdr.ts";

export interface NamesmithDependencies {
	env: NodeJS.ProcessEnv;
	read: typeof readHerdrPaneLabel;
	rename: typeof renameHerdrPane;
}

type Target = {
	paneId: string;
	socketPath: string;
};

type Rename = Target & {
	name: string | undefined;
	warn: () => void;
};

function sameTarget(left: Target | undefined, right: Target): boolean {
	return !!left && left.paneId === right.paneId && left.socketPath === right.socketPath;
}

function sameRename(left: Rename | undefined, right: Rename): boolean {
	return sameTarget(left, right) && left!.name === right.name;
}

export function createHerdrPaneNamesmith(
	pi: ExtensionAPI,
	dependencies: NamesmithDependencies = { env: process.env, read: readHerdrPaneLabel, rename: renameHerdrPane },
): void {
	let closed = false;
	let pending: Rename | undefined;
	let running: Promise<void> | undefined;
	let successful: Rename | undefined;
	// The last non-empty label this runtime sent to a pane: the only label it may clear again.
	let ownLabel: (Target & { name: string }) | undefined;
	let failed: Rename | undefined;
	let warned: Rename | undefined;
	let shutdown: Promise<void> | undefined;

	async function drain(): Promise<void> {
		while (!closed && pending) {
			const rename = pending;
			pending = undefined;
			if (sameRename(successful, rename)) continue;
			// Even a failed request may have changed this target's label.
			if (rename.name !== undefined) {
				ownLabel = { paneId: rename.paneId, socketPath: rename.socketPath, name: rename.name };
			}
			try {
				await dependencies.rename(rename.paneId, rename.socketPath, rename.name);
				successful = rename;
				failed = undefined;
				warned = undefined;
			} catch {
				// Failed requests may have changed the pane; only acknowledged success deduplicates.
				successful = undefined;
				failed = rename;
				// One warning per failure streak; a different target or name is a new streak.
				if (!closed && !(warned && sameRename(warned, rename))) {
					warned = rename;
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
		const target = { paneId: HERDR_PANE_ID, socketPath: HERDR_SOCKET_PATH };
		const normalized = name || undefined;
		// Nothing to clear: an unnamed session must not delete a label this runtime never wrote.
		if (normalized === undefined && !(ownLabel && sameTarget(ownLabel, target))) return;
		pending = {
			...target,
			name: normalized,
			warn: () => ctx.ui.notify("Herdr pane name sync failed; will retry on the next name/session event.", "warning"),
		};
		startDrain();
	}

	pi.on("session_start", (_event, ctx) => synchronize(pi.getSessionName(), ctx));
	pi.on("session_info_changed", (event, ctx) => synchronize(event.name, ctx));
	// A transient failure (startup socket hiccup, lost response, reloading herdr) is not re-queued by
	// a timer; the next settled agent run re-attempts the name that failed.
	pi.on("agent_settled", (_event, ctx) => {
		const retry = failed;
		if (!retry || closed || pending || running) return;
		synchronize(retry.name, ctx);
	});
	// Pi creates a fresh extension runtime after reload/new/resume/fork; never reopen this one.
	pi.on("session_shutdown", (event) => {
		if (shutdown) return shutdown;
		closed = true;
		pending = undefined;
		shutdown = (async () => {
			await running;
			if (event.reason !== "quit" || !ownLabel) return;
			const { paneId, socketPath, name } = ownLabel;
			try {
				// Only remove the label this runtime wrote; a newer user or tool label stays untouched.
				if ((await dependencies.read(paneId, socketPath)) !== name) return;
				await dependencies.rename(paneId, socketPath, undefined);
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
