/**
 * The cache file is shared by every Pi process that loads this extension (every
 * BB thread spawns one). Writes must be atomic so a concurrent reader never
 * sees a truncated document.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CACHE_PATH, writeCache } from "../index.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR as string;
const extensionDir = fileURLToPath(new URL("..", import.meta.url));

function tempFiles(directory = agentDir): string[] {
	try {
		return readdirSync(directory).filter((name) => name.startsWith(".opencode-free.") && name.endsWith(".tmp"));
	} catch {
		return [];
	}
}

type Worker = { prefix: string; iterations: number; agentDir: string };

function runWorker({ prefix, iterations, agentDir: dir }: Worker): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			// Workers must load the shared test loader too: it resolves Pi and gives them an agent dir.
			["--experimental-strip-types", "--import", new URL("../../_test-support/register-loader.mjs", import.meta.url).href, "--import", new URL("./setup.mjs", import.meta.url).href, "./tests/write-cache-worker.ts", prefix, String(iterations)],
			{ cwd: extensionDir, env: { ...process.env, OPENCODE_FREE_TEST_AGENT_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`worker ${prefix} exited ${code}: ${output}`));
		});
	});
}

test("writeCache merges the patch into a complete document", () => {
	writeCache({ version: "2.0.40", versionCheckedAt: 1 });
	writeCache({ versionSource: "tap" });
	const document = readFileSync(CACHE_PATH, "utf8");
	const cache = JSON.parse(document);
	assert.equal(cache.version, "2.0.40", "the earlier write is merged, not replaced");
	assert.equal(cache.versionSource, "tap");
	assert.ok(document.endsWith("\n"), "the document is newline terminated");
	assert.deepEqual(tempFiles(), [], "a write leaves no temporary file behind");
});

test("writeCache tolerates a truncated cache from an older writer", () => {
	writeFileSync(CACHE_PATH, '{"version": "2.0.4');
	writeCache({ versionSource: "tap" });
	const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
	assert.equal(cache.versionSource, "tap");
	assert.equal(cache.version, undefined, "unparseable content is discarded instead of failing the provider");
	assert.deepEqual(tempFiles(), []);
});

test("an unwritable agent directory does not fail and leaves no temporary file", async (t) => {
	if (process.getuid?.() === 0) {
		t.skip("running as root: directory permissions are not enforced");
		return;
	}
	const readOnly = mkdtempSync(join(tmpdir(), "opencode-free-readonly-"));
	t.after(() => {
		chmodSync(readOnly, 0o700);
		rmSync(readOnly, { recursive: true, force: true });
	});
	chmodSync(readOnly, 0o500);
	await runWorker({ prefix: "readonly", iterations: 2, agentDir: readOnly });
	assert.deepEqual(tempFiles(readOnly), [], "the failed write removes its temporary file");
});

test("concurrent writers never expose a truncated file", async () => {
	writeCache({ versionSource: "seed" });
	const workers = ["alpha", "beta", "gamma"].map((prefix) => runWorker({ prefix, iterations: 25, agentDir }));

	let running = true;
	let reads = 0;
	let failure: Error | undefined;
	const reader = (async () => {
		while (running) {
			try {
				const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
				assert.equal(typeof cache, "object");
				reads += 1;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					failure = new Error(`a concurrent reader saw an incomplete cache: ${(error as Error).message}`);
					return;
				}
			}
			await new Promise((resolve) => setImmediate(resolve));
		}
	})();

	await Promise.all(workers);
	running = false;
	await reader;
	assert.equal(failure, undefined);
	assert.ok(reads > 0, "the reader observed the file while it was being written");

	const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
	assert.match(String(cache.versionSource), /^(alpha|beta|gamma)-\d+$/, "the last complete write wins");
	assert.deepEqual(tempFiles(), []);
});
