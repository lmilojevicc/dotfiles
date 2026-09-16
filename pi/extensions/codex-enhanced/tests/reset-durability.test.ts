import assert from "node:assert/strict";
import fs, { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { coordinateReset, readResetJournal, resetAccountState, resetPaths, withResetAccountLock, type ResetJournal } from "../resets.ts";
import { probeResetLock } from "../reset-lock.ts";

const accountKey = "account:durability";
function fixture(t: any) {
	const agentDir = mkdtempSync(join(tmpdir(), "codex-durability-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const posts: string[][] = [];
	let percentage = 100;
	const op = { agentDir, accountKey, mode: "auto" as "auto" | "manual", validate: async () => {}, checkBeforePost: () => {},
		readUsage: async () => ({ limits: [{ limitId: "codex", secondary: { usedPercent: percentage, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 3600 } }] }),
		readCredits: async () => ({ availableCount: 2, credits: [{ id: "new-credit" }] }),
		consume: async (credit: string, request: string) => { posts.push([credit, request]); return { outcome: "reset" as const }; }, refresh: async () => {},
	};
	return { op, posts, paths: resetPaths(agentDir, accountKey), recover: () => { percentage = 50; } };
}
const terminal: ResetJournal = { version: 1, accountKey, phase: "reset", recovered: false, requestId: "saved-request", creditId: "saved-credit" };

for (const stage of ["pending", "terminal", "ambiguous", "recovery", "restore"] as const) {
	for (const fault of ["write", "file-sync", "rename", "directory-sync"] as const) {
		test(`reset durability ${stage}/${fault}: visible predecessor or successor is conservatively re-fsynced`, async (t) => {
			const f = fixture(t);
			if (stage === "recovery" || stage === "restore") await withResetAccountLock(f.op.agentDir, accountKey, async (save) => save(stage === "restore" ? { ...terminal, phase: "unknown" } : terminal));
			if (stage === "recovery") f.recover();
			let writes = 0, renamed = false, fired = false;
			const target = stage === "terminal" || stage === "ambiguous" || stage === "restore" ? 2 : 1;
			const write = fs.writeFileSync, sync = fs.fsyncSync, rename = fs.renameSync;
			const fail = () => { fired = true; throw new Error("synthetic durability fault"); };
			t.mock.method(fs, "writeFileSync", ((...args: any[]) => {
				if (typeof args[0] === "number") { writes++; if (writes === target && fault === "write") fail(); }
				return (write as any)(...args);
			}) as any);
			t.mock.method(fs, "fsyncSync", (fd: number) => {
				if (writes === target && !fired && (fault === "file-sync" && !fstatSync(fd).isDirectory()
					|| fault === "directory-sync" && renamed && fstatSync(fd).isDirectory())) fail();
				sync(fd);
			});
			t.mock.method(fs, "renameSync", ((...args: any[]) => {
				if (writes === target && fault === "rename") fail();
				(rename as any)(...args); renamed = writes === target;
			}) as any);
			syncBuiltinESMExports();
			let checks = 0;
			await coordinateReset({ ...f.op,
				mode: stage === "restore" ? "manual" : "auto", manualAction: resetAccountState(f.op.agentDir, accountKey).manualAction,
				checkBeforePost: () => { if (stage === "restore" && ++checks === 2) throw new Error("cancel after pending"); },
				consume: async (...args) => { const result = await f.op.consume(...args); if (stage === "ambiguous") throw new Error("transport"); return result; },
			});
			t.mock.restoreAll(); syncBuiltinESMExports();
			assert.equal(fired, true);
			assert.equal(f.posts.length, stage === "terminal" || stage === "ambiguous" ? 1 : 0);
			assert.equal(await probeResetLock(f.paths.directory, f.paths.lock), "available");
			const visible = readResetJournal(f.op.agentDir, accountKey);
			if (stage === "pending") {
				assert.equal(visible?.phase, fault === "directory-sync" ? "pending" : undefined);
			} else if (stage === "recovery") assert.equal(visible?.recovered, fault === "directory-sync");
			else if (stage === "restore") {
				assert.equal(visible?.requestId, terminal.requestId); assert.equal(visible?.creditId, terminal.creditId);
				assert.equal(visible?.phase, fault === "directory-sync" ? "unknown" : "pending");
			} else {
				assert.equal(visible?.phase, fault === "directory-sync" ? stage === "terminal" ? "reset" : "ambiguous" : "pending");
				assert.deepEqual([visible?.creditId, visible?.requestId], f.posts[0]);
			}
			const before = f.posts.length;
			await coordinateReset(f.op); await coordinateReset(f.op);
			assert.equal(f.posts.length, stage === "pending" && !visible ? 1 : before);
		});
	}
}

for (const fault of ["unlink", "directory-sync"]) test(`definitely-unsent rollback ${fault} preserves uncertainty or durable absence`, async (t) => {
	const f = fixture(t); let checks = 0, unlinked = false, fired = false;
	const unlink = fs.unlinkSync, sync = fs.fsyncSync;
	t.mock.method(fs, "unlinkSync", ((path: any) => {
		if (path === f.paths.journal && fault === "unlink") { fired = true; throw new Error("unlink fault"); }
		unlink(path); unlinked = true;
	}) as any);
	t.mock.method(fs, "fsyncSync", (fd: number) => {
		if (fault === "directory-sync" && unlinked) { fired = true; throw new Error("dir fault"); } sync(fd);
	}); syncBuiltinESMExports();
	await coordinateReset({ ...f.op, checkBeforePost: () => { if (++checks === 2) throw new Error("cancel"); } });
	t.mock.restoreAll(); syncBuiltinESMExports();
	assert.equal(fired, true); assert.equal(f.posts.length, 0);
	assert.equal(readResetJournal(f.op.agentDir, accountKey)?.phase, fault === "unlink" ? "pending" : undefined);
	await coordinateReset(f.op);
	assert.equal(f.posts.length, fault === "unlink" ? 0 : 1);
});

for (const state of ["absent", "terminal", "uncertain"]) test(`locked recovery fsync failure on ${state} never enters work or erases evidence`, async (t) => {
	const f = fixture(t);
	await withResetAccountLock(f.op.agentDir, accountKey, async (save) => {
		if (state !== "absent") save({ ...terminal, phase: state === "terminal" ? "reset" : "pending" });
	});
	const before = existsSync(f.paths.journal) ? readFileSync(f.paths.journal, "utf8") : undefined;
	let syncs = 0; const sync = fs.fsyncSync;
	t.mock.method(fs, "fsyncSync", (fd: number) => { if (++syncs === 4) throw new Error("revalidation fault"); sync(fd); }); syncBuiltinESMExports();
	await assert.rejects(withResetAccountLock(f.op.agentDir, accountKey, async () => assert.fail("entered work")));
	t.mock.restoreAll(); syncBuiltinESMExports();
	assert.equal(existsSync(f.paths.journal) ? readFileSync(f.paths.journal, "utf8") : undefined, before);
	await withResetAccountLock(f.op.agentDir, accountKey, async () => {});
});

test("manual confirmation never changes meaning during initial auth/lock awaits", async (t) => {
	const f = fixture(t);
	for (const previous of [undefined, { ...terminal, phase: "pending" as const }, terminal]) {
		if (previous) await withResetAccountLock(f.op.agentDir, accountKey, async (save) => save(previous));
		const confirmed = resetAccountState(f.op.agentDir, accountKey).manualAction;
		let validations = 0;
		await coordinateReset({ ...f.op, mode: "manual", manualAction: confirmed, manualAfterRequestId: previous?.requestId,
			validate: async () => { if (++validations === 1) await withResetAccountLock(f.op.agentDir, accountKey, async (save) => save({ ...terminal, phase: "unknown", requestId: "newer-request", creditId: "newer-credit" })); },
		});
		assert.equal(f.posts.length, 0);
		assert.equal(readResetJournal(f.op.agentDir, accountKey)?.requestId, "newer-request");
	}
});

test("deliberate retries preserve mock-server tuple; dispatch count is not credits charged", async (t) => {
	const f = fixture(t); const charged = new Set<string>(); const submitted: string[] = [];
	const consume = async (credit: string, request: string) => {
		const tuple = JSON.stringify([accountKey, credit, request]); submitted.push(tuple);
		// This mock explicitly guarantees single-use by tuple. Production semantics are undocumented.
		charged.add(tuple); throw new Error("response lost");
	};
	await coordinateReset({ ...f.op, consume });
	for (let i = 0; i < 3; i++) await coordinateReset({ ...f.op, consume });
	await coordinateReset({ ...f.op, mode: "manual", manualAction: resetAccountState(f.op.agentDir, accountKey).manualAction, consume,
		readCredits: async () => { assert.fail("retry must not select another credit"); } });
	assert.equal(submitted.length, 2); assert.equal(charged.size, 1); assert.equal(submitted[0], submitted[1]);
});
