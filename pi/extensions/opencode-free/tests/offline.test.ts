/**
 * The offline switches are read once, when the extension module loads, so only
 * a child process can prove them end to end: the parent sets the flag in the
 * spawn environment and the child reports what it requested.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL("..", import.meta.url));

/** Run the worker with exactly these offline switches in its environment. */
function requestsUnder(flags: Record<string, string>): Promise<string[]> {
	const agentDir = mkdtempSync(join(tmpdir(), "opencode-free-offline-"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		// The test loader keeps the offline switches instead of scrubbing them.
		OPENCODE_FREE_TEST_OFFLINE: "1",
		OPENCODE_FREE_TEST_AGENT_DIR: agentDir,
	};
	// Only the switches under test may decide, never one inherited from the shell.
	delete env.PI_OFFLINE;
	delete env.OPENCODE_FREE_OFFLINE;
	Object.assign(env, flags);

	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--experimental-strip-types", "--import", new URL("../../_test-support/register-loader.mjs", import.meta.url).href, "--import", new URL("./setup.mjs", import.meta.url).href, "./tests/offline-worker.ts"],
			{ cwd: extensionDir, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			rmSync(agentDir, { recursive: true, force: true });
			if (code !== 0) {
				reject(new Error(`worker exited ${code}: ${stderr || stdout}`));
				return;
			}
			try {
				resolve(JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as string[]);
			} catch (error) {
				reject(new Error(`worker printed no request list: ${(error as Error).message}\n${stdout}`));
			}
		});
	});
}

test("OPENCODE_FREE_OFFLINE=1 makes no requests", async () => {
	assert.deepEqual(await requestsUnder({ OPENCODE_FREE_OFFLINE: "1" }), []);
});

test("PI_OFFLINE=1 makes no requests", async () => {
	assert.deepEqual(await requestsUnder({ PI_OFFLINE: "1" }), []);
});

test("PI_OFFLINE=0 still refreshes", async () => {
	const requested = await requestsUnder({ PI_OFFLINE: "0" });
	assert.ok(
		requested.some((url) => url.includes("/zen/v1/models")),
		`a falsy PI_OFFLINE is not offline; requests were ${JSON.stringify(requested)}`,
	);
});
