import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { piModuleUrl } from "../../_test-support/pi-package.mjs";
import { boundedTitleSignal } from "../index.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("bounded title signals follow the session abort", () => {
	const controller = new AbortController();
	const bounded = boundedTitleSignal(controller.signal, 60_000);
	assert.equal(bounded.aborted, false);
	controller.abort();
	assert.equal(bounded.aborted, true, "the session signal still cancels the naming request");
});

test("a naming request that ignores timeoutMs is cancelled by its own bound and reported", async () => {
	// The extension asks for the documented 10 second bound; shorten it so the test stays fast. A provider
	// adapter that ignores `timeoutMs` (local OpenAI-compatible servers, Google, Bedrock) hangs forever
	// without this bound, which is why it must exist outside the adapter.
	const requestedDelays: number[] = [];
	const originalTimeout = AbortSignal.timeout;
	AbortSignal.timeout = (delay: number) => {
		requestedDelays.push(delay);
		return originalTimeout.call(AbortSignal, Math.min(delay, 20));
	};

	const agentDir = mkdtempSync(join(tmpdir(), "pi-session-auto-rename-timeout-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		// Pi's extension loader is not an exported subpath, so load it from the package the shared loader resolved.
		const { createExtensionRuntime, loadExtensions } = await import(piModuleUrl("dist/core/extensions/loader.js"));
		const runtime = createExtensionRuntime();
		const notifications: string[] = [];
		let sessionName: string | undefined;
		runtime.getSessionName = () => sessionName;
		runtime.setSessionName = (name: string) => {
			sessionName = name;
		};

		const signals: AbortSignal[] = [];
		const adapterTimeouts: Array<number | undefined> = [];
		const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
		const loaded = await loadExtensions([extensionPath], dirname(extensionPath), undefined, runtime);
		assert.deepEqual(loaded.errors, []);
		const handlers = loaded.extensions[0].handlers;
		const model = { provider: "test", id: "fast", name: "Fast" };
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { notify: (message: string) => notifications.push(message) },
			model,
			modelRegistry: {
				getAvailable: () => [model],
				complete: (
					_model: unknown,
					_context: unknown,
					options: { signal: AbortSignal; timeoutMs?: number },
				) => {
					signals.push(options.signal);
					adapterTimeouts.push(options.timeoutMs);
					// Model an adapter that only ends the request when the signal aborts.
					return new Promise((_resolve, reject) => {
						options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				},
			},
			sessionManager: { getBranch: () => [] },
		};
		const invoke = (event: string, ...args: unknown[]) => {
			const handler = handlers.get(event)?.[0];
			assert.ok(handler, `${event} handler was registered`);
			return handler(...args);
		};
		const userPrompt = (prompt: string) => invoke("before_agent_start", { messageType: "user", prompt }, ctx);

		invoke("session_start", {}, ctx);
		userPrompt("Hanging prompt");
		assert.equal(signals.length, 1);
		assert.deepEqual(requestedDelays, [10_000], "the request carries the documented 10 second bound");
		assert.equal(adapterTimeouts[0], 10_000, "the adapter hint is still passed");
		assert.equal(signals[0].aborted, false);

		await once(signals[0], "abort");
		await settle();
		assert.equal(signals[0].aborted, true, "the naming request is cancelled by its own bound");
		assert.equal(sessionName, undefined, "an abandoned name never renames the session");
		assert.equal(notifications.at(-1), "Session auto-rename failed.");

		// The same signal still belongs to the session: a shutdown cancels it silently.
		const notificationsBeforeShutdown = notifications.length;
		invoke("session_start", {}, ctx);
		userPrompt("Second prompt");
		const shutdownSignal = signals.at(-1);
		assert.ok(shutdownSignal);
		assert.equal(shutdownSignal.aborted, false);
		invoke("session_shutdown", {}, ctx);
		await settle();
		assert.equal(shutdownSignal.aborted, true, "session shutdown cancels the naming request");
		assert.equal(notifications.length, notificationsBeforeShutdown, "cancellation is not reported as a failure");
	} finally {
		AbortSignal.timeout = originalTimeout;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
