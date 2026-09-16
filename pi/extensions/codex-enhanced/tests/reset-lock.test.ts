import assert from "node:assert/strict";
import childProcess, { fork } from "node:child_process";
import { once } from "node:events";
import fs, { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Duplex } from "node:stream";
import { acquireResetLock, probeResetLock } from "../reset-lock.ts";
import { coordinateReset, readResetJournal, resetAccountState, resetPaths, withResetAccountLock } from "../resets.ts";

const key = "account:synthetic";
function fixture(t: any) {
	const dir = mkdtempSync(join(tmpdir(), "codex-kernel-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function child(t: any, dir: string, mode: string, env = process.env) {
	const p = fork(new URL("./fixtures/reset-process.ts", import.meta.url), [dir, mode], {
		execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc", ...(mode === "inherited-helper" ? ["pipe" as const] : [])],
		env: { ...env, HOME: dir, PI_CODING_AGENT_DIR: dir },
	});
	t.after(() => { if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); });
	return p;
}
async function kill(p: ReturnType<typeof fork>) { const exit = once(p, "exit"); p.kill("SIGKILL"); await exit; }
function operation(dir: string, posts: string[][], mode: "auto" | "manual" = "auto") {
	return { agentDir: dir, accountKey: key, mode,
		manualAction: resetAccountState(dir, key).manualAction,
		validate: async () => {}, checkBeforePost: () => {},
		readUsage: async () => ({ limits: [{ limitId: "codex", secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 3600 } }] }),
		readCredits: async () => ({ availableCount: 1, credits: [{ id: "new-credit" }] }),
		consume: async (credit: string, request: string) => { posts.push([credit, request]); return { outcome: "reset" as const }; }, refresh: async () => {},
	};
}

test("reset-lock independent descriptors/module instances/probes never unlock the owner; separate accounts proceed", async (t) => {
	const dir = fixture(t); const path = join(dir, "lock");
	const owner = (await acquireResetLock(path, true))!;
	const independent = openSync(path, "r+"); closeSync(independent);
	const other = await import(`../reset-lock.ts?instance=${Date.now()}`);
	assert.equal(await other.probeResetLock(dir, path), "busy");
	assert.equal(await probeResetLock(dir, path), "busy");
	const different = (await acquireResetLock(join(dir, "other"), true))!; closeSync(different);
	closeSync(owner);
	assert.equal(await probeResetLock(dir, path), "available");
	assert.equal(lstatSync(path).mode & 0o777, 0o600);
	assert.throws(() => mkdirSync(path), { code: "EEXIST" });
});

test("reset-lock live and SIGSTOP owner excludes despite ancient timestamps; SIGKILL releases unchanged inode", async (t) => {
	const dir = fixture(t); const p = child(t, dir, "acquired");
	assert.equal((await once(p, "message"))[0], "acquired");
	const paths = resetPaths(dir, key);
	utimesSync(paths.lock, 1, 1); const before = lstatSync(paths.lock);
	p.kill("SIGSTOP");
	for (let i = 0; i < 3; i++) assert.equal(await probeResetLock(paths.directory, paths.lock), "busy");
	await kill(p);
	assert.equal(await probeResetLock(paths.directory, paths.lock), "available");
	assert.equal(lstatSync(paths.lock).ino, before.ino);
	assert.equal(lstatSync(paths.lock).mtimeMs, before.mtimeMs);
	assert.equal(readResetJournal(dir, key), undefined);
});

for (const legacy of ["active", "orphan"]) test(`reset-lock ${legacy} mkdir is never reclaimed`, async (t) => {
	const dir = fixture(t); const paths = resetPaths(dir, key);
	mkdirSync(paths.directory, { mode: 0o700 }); mkdirSync(paths.lock, { mode: 0o700 });
	writeFileSync(join(paths.lock, "owner.json"), JSON.stringify({ pid: legacy === "active" ? process.pid : 99999999 }));
	const before = lstatSync(paths.lock).ino;
	assert.equal(await probeResetLock(paths.directory, paths.lock), "legacy");
	await assert.rejects(withResetAccountLock(dir, key, async () => assert.fail("entered")), /Old reset lock/);
	assert.equal(lstatSync(paths.lock).ino, before);
});

test("reset-lock missing Python fails closed in a clean runtime", async (t) => {
	const dir = fixture(t); const p = child(t, dir, "auto", { ...process.env, PATH: dir });
	const exit = once(p, "exit"); assert.equal((await once(p, "message"))[0], "blocked"); await exit;
	assert.equal(readResetJournal(dir, key), undefined);
});

for (const fault of ["launch", "import", "wrong-status", "wrong-success", "timeout", "output", "signal", "acquired-signal"]) {
	test(`reset-lock helper ${fault}: no protected callback, owned descriptor closed`, async (t) => {
		const dir = fixture(t); const paths = resetPaths(dir, key); const spawn = childProcess.spawn;
		let descriptor: number | undefined;
		t.mock.method(childProcess, "spawn", ((file: string, args: string[], options: any) => {
			assert.ok(file.startsWith("/")); assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-c"]);
			assert.deepEqual(options.env, {}); assert.equal(options.cwd, "/"); descriptor = options.stdio[3];
			if (fault === "acquired-signal") return spawn(file, [...args.slice(0, 3), args[3].replace('sys.stdout.write("locked\\n")', 'import os, signal; os.kill(os.getpid(), signal.SIGKILL)')], options);
			if (fault === "launch") return spawn(join(dir, "missing-python"), [], options);
			const script = fault === "import" ? "process.stderr.write('ImportError'); process.exit(1)"
				: fault === "wrong-status" ? "process.exit(75)" : fault === "wrong-success" ? "process.exit(0)"
				: fault === "timeout" ? "setInterval(()=>{},1000)" : fault === "output" ? "process.stdout.write('x'.repeat(2048)); setInterval(()=>{},1000)"
				: "process.kill(process.pid,'SIGKILL')";
			return spawn(process.execPath, ["-e", script], options);
		}) as any);
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		await assert.rejects(withResetAccountLock(dir, key, async () => assert.fail("callback entered")), /Python 3/);
		assert.notEqual(descriptor, undefined); assert.throws(() => fstatSync(descriptor!), { code: "EBADF" });
		t.mock.restoreAll(); syncBuiltinESMExports();
		assert.equal(await probeResetLock(paths.directory, paths.lock), "available");
		assert.equal(readResetJournal(dir, key), undefined);
	});
}

test("reset-lock helper SIGKILL cannot release a descriptor still owned by live Node", async (t) => {
	const dir = fixture(t); const path = join(dir, "lock"); const fd = openSync(path, "wx+", 0o600);
	t.after(() => closeSync(fd));
	// Test-only helper uses the same inherited-fd primitive but dies instead of acknowledging success.
	const p = childProcess.spawn("python3", ["-I", "-S", "-c", "import fcntl,os,signal; fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB); os.kill(os.getpid(),signal.SIGKILL)"], { env: {}, stdio: ["ignore", "ignore", "ignore", fd] });
	await once(p, "exit");
	assert.equal(await probeResetLock(dir, path), "busy");
});

for (const checkpoint of ["acquired", "temp", "before-post", "hold", "terminal", "recovery", "rollback"]) {
	test(`reset-lock crash at ${checkpoint}: successor obeys journal, never needs lock deletion`, async (t) => {
		const dir = fixture(t); const posts: string[][] = [];
		if (checkpoint === "recovery") await withResetAccountLock(dir, key, async (save) => save({ version: 1, accountKey: key, phase: "reset", recovered: false, requestId: "previous", creditId: "previous-credit" }));
		const p = child(t, dir, checkpoint);
		const message = (await once(p, "message"))[0];
		assert.equal(message, checkpoint === "before-post" ? "intent" : checkpoint === "hold" ? "posted" : checkpoint);
		const paths = resetPaths(dir, key); const inode = lstatSync(paths.lock).ino;
		await kill(p);
		const saved = readResetJournal(dir, key);
		assert.equal(await probeResetLock(paths.directory, paths.lock), "available");
		const op = operation(dir, posts);
		for (let i = 0; i < 3; i++) await coordinateReset(op);
		if (["before-post", "hold", "rollback"].includes(checkpoint)) {
			assert.equal(posts.length, 0); assert.equal(saved?.phase, "pending");
			assert.deepEqual(readResetJournal(dir, key), saved);
			await coordinateReset(operation(dir, posts, "manual"));
			assert.deepEqual(posts, [[saved!.creditId, saved!.requestId]]);
		} else if (checkpoint === "terminal") { assert.equal(posts.length, 0); assert.equal(saved?.recovered, false); }
		else assert.equal(posts.length, 1);
		assert.equal(lstatSync(paths.lock).ino, inode);
	});
}

test("reset-lock atomic first creation: concurrent auto/manual processes share a single intent", async (t) => {
	const dir = fixture(t); const a = child(t, dir, "auto"); const b = child(t, dir, "manual");
	const exits = [once(a, "exit"), once(b, "exit")];
	const messages = await Promise.all([once(a, "message"), once(b, "message")]); await Promise.all(exits);
	assert.deepEqual(messages.map(([message]) => message).sort(), ["blocked", "posted"]);
	assert.equal(readResetJournal(dir, key)?.phase, "reset");
});

for (const fault of ["symlink", "oversize", "wrong-owner", "public", "corrupt"]) {
	test(`reset-lock ${fault} journal stays blocked and byte-preserved`, async (t) => {
		const dir = fixture(t); const paths = resetPaths(dir, key);
		await withResetAccountLock(dir, key, async () => {});
		const bytes = fault === "oversize" ? "x".repeat(16385) : "invalid";
		const target = join(dir, "target"); writeFileSync(target, bytes, { mode: 0o600 });
		if (fault === "symlink") symlinkSync(target, paths.journal);
		else writeFileSync(paths.journal, bytes, { mode: fault === "public" ? 0o644 : 0o600 });
		if (fault === "wrong-owner") {
			const stat = fs.fstatSync;
			t.mock.method(fs, "fstatSync", ((fd: number) => { const value = stat(fd); if (value.size) value.uid += 1; return value; }) as any);
			syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		}
		const posts: string[][] = [];
		await coordinateReset(operation(dir, posts)); assert.equal(posts.length, 0);
		assert.equal(readFileSync(paths.journal, "utf8"), bytes);
	});
}

test("reset-lock unsupported platforms fail closed without entering work", async (t) => {
	const dir = fixture(t); const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...platform, value: "win32" });
	try { await assert.rejects(withResetAccountLock(dir, key, async () => assert.fail("entered")), /macOS or Linux/); }
	finally { Object.defineProperty(process, "platform", platform); }
});

for (const object of ["symlink", "public", "directory"]) test(`reset-lock rejects unexpected ${object} lock path unchanged`, async (t) => {
	const dir = fixture(t); const path = join(dir, "lock");
	if (object === "directory") mkdirSync(path, { mode: 0o700 });
	else if (object === "symlink") { writeFileSync(join(dir, "target"), "evidence", { mode: 0o600 }); symlinkSync(join(dir, "target"), path); }
	else writeFileSync(path, "evidence", { mode: 0o644 });
	const before = lstatSync(path).ino;
	await assert.rejects(acquireResetLock(path, true));
	assert.equal(lstatSync(path).ino, before);
});

test("reset-lock concurrent old mkdir/new regular-file rollout always fences one protocol", async (t) => {
	for (let i = 0; i < 4; i++) {
		const dir = fixture(t); const a = child(t, dir, "old-mkdir"); const b = child(t, dir, "auto");
		const exits = [once(a, "exit"), once(b, "exit")];
		const [[old], [updated]] = await Promise.all([once(a, "message"), once(b, "message")]); await Promise.all(exits);
		assert.deepEqual([old, updated], old === "old-created" ? ["old-created", "blocked"] : ["old-blocked", "posted"]);
		assert.equal(lstatSync(resetPaths(dir, key).lock).isDirectory(), old === "old-created");
	}
});

test("reset-lock killed Node remains fenced until its inherited helper descriptor closes", { timeout: 10_000 }, async (t) => {
	const dir = fixture(t); const p = child(t, dir, "inherited-helper");
	const barrier = p.stdio[4] as Duplex;
	const closed = once(p, "close");
	t.after(async () => { barrier.end(); if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); await closed; });
	assert.equal((await once(barrier, "data"))[0].toString(), "helper-holds-copy");
	const paths = resetPaths(dir, key); const before = lstatSync(paths.lock).ino;
	await kill(p);
	assert.equal(await probeResetLock(paths.directory, paths.lock), "busy", "helper still owns a shared copy; never steal by Node PID");
	const released = once(barrier, "data");
	barrier.end("release");
	assert.equal((await released)[0].toString(), "helper-released-copy");
	await closed;
	assert.equal(await probeResetLock(paths.directory, paths.lock), "available");
	assert.equal(lstatSync(paths.lock).ino, before);
	assert.equal(readResetJournal(dir, key), undefined, "no protected operation began before helper exit acknowledgement");
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

/** Pause just the first real Python helper after flock, until the test explicitly closes stdin. */
function holdFirstHelper(t: any) {
	const spawn = childProcess.spawn;
	const entered = deferred();
	let first: ReturnType<typeof childProcess.spawn> | undefined;
	const descriptors: number[] = [];
	t.mock.method(childProcess, "spawn", ((file: string, args: string[], options: any) => {
		descriptors.push(options.stdio[3]);
		if (first) return spawn(file, args, options);
		first = spawn(file, [...args.slice(0, 3), `${args[3]}\nsys.stdout.flush(); sys.stdin.read(1)\n`], {
			...options, stdio: ["pipe", ...options.stdio.slice(1)],
		});
		first.stdout!.once("data", entered.resolve);
		return first;
	}) as any);
	syncBuiltinESMExports();
	t.after(() => { first?.stdin?.end("release"); t.mock.restoreAll(); syncBuiltinESMExports(); });
	return { entered: entered.promise, descriptors, release: () => first!.stdin!.end("release") };
}

test("reset-lock priority: manual waits for bounded running probe, new probes defer, simultaneous operations never queue", { timeout: 10_000 }, async (t) => {
	const dir = fixture(t); const paths = resetPaths(dir, key);
	await withResetAccountLock(dir, key, async () => {});
	const helper = holdFirstHelper(t);
	const probe = probeResetLock(paths.directory, paths.lock);
	assert.equal(probeResetLock(paths.directory, paths.lock), probe, "running probes coalesce");
	await helper.entered;
	const entered = deferred(), release = deferred();
	t.after(release.resolve);
	const posts: string[][] = [];
	const manual = coordinateReset({ ...operation(dir, posts, "manual"),
		consume: async (...args) => { const result = await operation(dir, posts).consume(...args); entered.resolve(); await release.promise; return result; },
	});
	// Flush the initial validate continuation: no timing sleep or acquisition retry.
	await Promise.resolve(); await Promise.resolve();
	assert.equal(helper.descriptors.length, 1, "manual cannot race the running probe's descriptor");
	const nextProbe = probeResetLock(paths.directory, paths.lock);
	assert.equal(helper.descriptors.length, 1, "new probe is suppressed behind pending manual acquisition");
	helper.release();
	assert.equal(await probe, "available");
	await entered.promise;
	assert.equal(helper.descriptors.length, 2, "only the authoritative helper follows the first probe");
	const competing = await coordinateReset(operation(dir, posts));
	assert.equal(competing.reason, "busy", "another authoritative operation does not queue behind the first");
	assert.equal(posts.length, 1);
	let otherEntered = false;
	await withResetAccountLock(dir, "account:independent", async () => { otherEntered = true; });
	assert.equal(otherEntered, true, "another account never waits for the pending probe/manual operation");
	release.resolve();
	await manual;
	assert.equal(await nextProbe, "available");
	assert.equal(posts.length, 1);
	assert.equal(readResetJournal(dir, key)?.phase, "reset");
});

for (const fault of ["probe-timeout", "authoritative-timeout", "authoritative-rejection"]) {
	test(`reset-lock priority ${fault} cleans local gate and owning descriptors`, { timeout: 10_000 }, async (t) => {
		const dir = fixture(t); const paths = resetPaths(dir, key);
		await withResetAccountLock(dir, key, async () => {});
		const helper = holdFirstHelper(t);
		if (fault === "probe-timeout") {
			const probe = probeResetLock(paths.directory, paths.lock);
			await helper.entered;
			let entered = false;
			const work = withResetAccountLock(dir, key, async () => { entered = true; });
			assert.equal(await probe, "python", "owned helper is terminated by the real bounded timeout");
			await work;
			assert.equal(entered, true, "probe failure cannot permanently block a later fresh authoritative acquisition");
		} else {
			const work = withResetAccountLock(dir, key, async () => { if (fault === "authoritative-rejection") throw new Error("synthetic callback rejection"); assert.fail("timeout entered work"); });
			const rejected = assert.rejects(work, fault === "authoritative-timeout" ? /Python 3/ : /callback rejection/);
			await helper.entered;
			const probe = probeResetLock(paths.directory, paths.lock);
			assert.equal(helper.descriptors.length, 1, "no helper for a deferred probe");
			if (fault === "authoritative-rejection") helper.release();
			await rejected;
			assert.equal(await probe, "available", "finally releases priority on every failure");
		}
		for (const fd of helper.descriptors) assert.throws(() => fstatSync(fd), { code: "EBADF" });
		await withResetAccountLock(dir, key, async () => {});
	});
}

test("reset-lock priority shutdown cancels deferred probe without launching after operation ends", { timeout: 10_000 }, async (t) => {
	const dir = fixture(t); const paths = resetPaths(dir, key);
	await withResetAccountLock(dir, key, async () => {});
	const helper = holdFirstHelper(t);
	const work = withResetAccountLock(dir, key, async () => {});
	await helper.entered;
	const controller = new AbortController();
	const probe = probeResetLock(paths.directory, paths.lock, controller.signal);
	controller.abort();
	assert.equal(await probe, "storage", "cancellation settles before the owner exits");
	assert.equal(helper.descriptors.length, 1);
	helper.release(); await work;
	await Promise.resolve();
	assert.equal(helper.descriptors.length, 1, "cancelled/debound menu never launches a deferred helper");
	await withResetAccountLock(dir, key, async () => {});
	assert.equal(helper.descriptors.length, 2, "authoritative priority was cleaned up");
});

test("reset-lock priority revalidates cancellation after waiting for a probe before any GET or POST", { timeout: 10_000 }, async (t) => {
	const dir = fixture(t); const paths = resetPaths(dir, key);
	await withResetAccountLock(dir, key, async () => {});
	const helper = holdFirstHelper(t);
	const probe = probeResetLock(paths.directory, paths.lock); await helper.entered;
	let valid = true, validations = 0, reads = 0;
	const posts: string[][] = [];
	const work = coordinateReset({ ...operation(dir, posts, "manual"),
		validate: async () => { validations++; if (!valid) throw new Error("cancelled context/consent/auth"); },
		readUsage: async () => { reads++; return { limits: [] }; },
	});
	await Promise.resolve(); await Promise.resolve();
	assert.equal(validations, 1);
	valid = false; helper.release(); await probe; await work;
	assert.equal(validations, 2); assert.equal(reads, 0); assert.equal(posts.length, 0);
	assert.equal(readResetJournal(dir, key), undefined);
	await withResetAccountLock(dir, key, async () => {});
});
