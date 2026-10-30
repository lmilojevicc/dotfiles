import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { piModuleUrl } from "../../_test-support/pi-package.mjs";

type Deferred = {
	promise: Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
};

function deferred(): Deferred {
	let resolve!: (value: unknown) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const successfulTitle = {
	role: "assistant",
	content: [{ type: "text", text: "Generated title" }],
	stopReason: "stop",
};

test("background naming returns immediately and ignores stale completions", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-session-auto-rename-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		// Pi's extension loader is not an exported subpath, so load it from the package the shared loader resolved.
		const { createExtensionRuntime, loadExtensions } = await import(piModuleUrl("dist/core/extensions/loader.js"));
		const completions: Deferred[] = [];
		const notifications: string[] = [];
		let sessionName: string | undefined;
		const runtime = createExtensionRuntime();
		runtime.getSessionName = () => sessionName;
		runtime.setSessionName = (name: string) => {
			sessionName = name;
		};

		const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
		const loaded = await loadExtensions([extensionPath], dirname(extensionPath), undefined, runtime);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const handlers = loaded.extensions[0].handlers;
		const model = { provider: "test", id: "fast", name: "Fast" };
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { notify: (message: string) => notifications.push(message) },
			model,
			modelRegistry: {
				getAvailable: () => [model],
				complete: () => {
					const completion = deferred();
					completions.push(completion);
					return completion.promise;
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
		const settle = () => new Promise((resolve) => setImmediate(resolve));

		invoke("session_start", {}, ctx);
		assert.equal(userPrompt("First prompt"), undefined);
		assert.equal(completions.length, 1, "completion launched synchronously in the background");
		completions[0].resolve(successfulTitle);
		await settle();
		assert.equal(sessionName, "Generated title", "fresh completion set the generated title");

		sessionName = undefined;
		invoke("session_start", {}, ctx);
		userPrompt("Manual name prompt");
		assert.equal(completions.length, 2);
		sessionName = "Manual title";
		invoke("session_info_changed", { name: sessionName }, ctx);
		completions[1].resolve(successfulTitle);
		await settle();
		assert.equal(sessionName, "Manual title", "manual name was not overwritten");

		sessionName = undefined;
		invoke("session_start", {}, ctx);
		userPrompt("Old session prompt");
		assert.equal(completions.length, 3);
		invoke("session_start", {}, ctx);
		completions[2].resolve(successfulTitle);
		await settle();
		assert.equal(sessionName, undefined, "completion from an invalidated session was ignored");

		invoke("session_start", {}, ctx);
		userPrompt("Rejected prompt");
		const secret = "secret-token\u001b[31m";
		completions[3].reject(new Error(secret));
		await settle();
		assert.equal(notifications.at(-1), "Session auto-rename failed.");
		assert.equal(notifications.some((message) => message.includes(secret)), false);

		// A custom-triggered run carries `message` instead of `prompt`; it must neither crash nor use up
		// the session's only naming attempt.
		sessionName = undefined;
		invoke("session_start", {}, ctx);
		const completionsBeforeCustom = completions.length;
		assert.equal(
			invoke("before_agent_start", {
				messageType: "custom",
				message: { customType: "injected", content: "Injected turn" },
			}, ctx),
			undefined,
			"custom-message run is ignored without throwing",
		);
		assert.equal(completions.length, completionsBeforeCustom, "custom-message run started no naming request");
		userPrompt("First real prompt");
		assert.equal(completions.length, completionsBeforeCustom + 1, "custom run did not consume eligibility");
		completions.at(-1)?.resolve(successfulTitle);
		await settle();
		assert.equal(sessionName, "Generated title", "first real user prompt still named the session");

		// One-shot runs end right after the turn, so they must not spend a provider request on a name.
		for (const mode of ["print", "json"]) {
			sessionName = undefined;
			const oneShotCtx = { ...ctx, mode };
			invoke("session_start", {}, oneShotCtx);
			const completionsBeforeOneShot = completions.length;
			invoke("before_agent_start", { messageType: "user", prompt: `${mode} prompt` }, oneShotCtx);
			assert.equal(completions.length, completionsBeforeOneShot, `${mode} mode started no naming request`);
			assert.equal(sessionName, undefined);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
