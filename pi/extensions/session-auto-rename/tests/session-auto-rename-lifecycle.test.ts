import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

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
		const piExecutable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
		const loaderUrl = pathToFileURL(join(dirname(piExecutable), "core/extensions/loader.js")).href;
		const { createExtensionRuntime, loadExtensions } = await import(loaderUrl);
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

		invoke("session_start", {}, ctx);
		assert.equal(invoke("before_agent_start", { prompt: "First prompt" }, ctx), undefined);
		assert.equal(completions.length, 1, "completion launched synchronously in the background");
		completions[0].resolve(successfulTitle);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sessionName, "Generated title", "fresh completion set the generated title");

		sessionName = undefined;
		invoke("session_start", {}, ctx);
		invoke("before_agent_start", { prompt: "Manual name prompt" }, ctx);
		assert.equal(completions.length, 2);
		sessionName = "Manual title";
		invoke("session_info_changed", { name: sessionName }, ctx);
		completions[1].resolve(successfulTitle);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sessionName, "Manual title", "manual name was not overwritten");

		sessionName = undefined;
		invoke("session_start", {}, ctx);
		invoke("before_agent_start", { prompt: "Old session prompt" }, ctx);
		assert.equal(completions.length, 3);
		invoke("session_start", {}, ctx);
		completions[2].resolve(successfulTitle);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(sessionName, undefined, "completion from an invalidated session was ignored");

		invoke("session_start", {}, ctx);
		invoke("before_agent_start", { prompt: "Rejected prompt" }, ctx);
		const secret = "secret-token\u001b[31m";
		completions[3].reject(new Error(secret));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(notifications.at(-1), "Session auto-rename failed.");
		assert.equal(notifications.some((message) => message.includes(secret)), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
