import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { coordinateReset, readResetJournal, resetAccountStatus, resetPaths, withResetAccountLock, type ResetOperation } from "../resets.ts";

const accountKey = "account:synthetic";
function usage(percent = 100, count = 2) {
	return { limits: [{ limitId: "codex", secondary: { usedPercent: percent, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 3600 } }], resetCredits: { availableCount: count, credits: [] } };
}
function fixture(t: { after: (fn: () => void) => void }) {
	const agentDir = mkdtempSync(join(tmpdir(), "codex-resets-test-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const posts: Array<[string, string]> = [];
	const op: ResetOperation = {
		agentDir, accountKey, mode: "auto", validate: async () => {}, checkBeforePost: () => {},
		readUsage: async () => usage(),
		readCredits: async () => ({ availableCount: 2, credits: [{ id: "late", expiresAt: "2099-01-01T00:00:00Z" }, { id: "soon", expiresAt: "2090-01-01T00:00:00Z" }] }),
		consume: async (creditId, requestId) => {
			const journal = readResetJournal(agentDir, accountKey)!;
			assert.equal(journal.phase, "pending");
			assert.equal(journal.creditId, creditId);
			assert.equal(journal.requestId, requestId);
			assert.equal(statSync(resetPaths(agentDir, accountKey).journal).mode & 0o777, 0o600);
			posts.push([creditId, requestId]);
			return { outcome: "reset" };
		},
		refresh: async () => {},
	};
	return { op, posts, agentDir };
}

test("resets journal precedes POST; stale success snapshots do not rearm across restart", async (t) => {
	const { op, posts, agentDir } = fixture(t);
	assert.equal((await coordinateReset(op)).result?.outcome, "reset");
	assert.equal(posts[0]?.[0], "soon");
	assert.equal(statSync(resetPaths(agentDir, accountKey).directory).mode & 0o777, 0o700);
	assert.equal(existsSync(resetPaths(agentDir, accountKey).lock), false);
	for (let i = 0; i < 3; i++) await coordinateReset({ ...op }); // independent callers/reload
	assert.equal(posts.length, 1);
	op.readUsage = async () => usage(45);
	await coordinateReset(op);
	assert.equal(readResetJournal(agentDir, accountKey)?.recovered, true);
	assert.equal(posts.length, 1);
	op.readUsage = async () => usage();
	await coordinateReset({ ...op });
	assert.equal(posts.length, 2);
	assert.notEqual(posts[0]?.[1], posts[1]?.[1]);
});

test("resets never rearm on unknown, stale, five-hour-only or failed recovery reads", async (t) => {
	const { op, posts } = fixture(t);
	await coordinateReset(op);
	for (const snapshot of [
		{ limits: [] },
		{ limits: [{ limitId: "codex", primary: { windowMinutes: 300, usedPercent: 0, resetsAt: Date.now() / 1000 + 100 } }] },
		{ limits: [{ limitId: "codex", secondary: { windowMinutes: 10080, usedPercent: 0, resetsAt: 1 } }] },
	]) {
		await coordinateReset({ ...op, readUsage: async () => snapshot });
	}
	await coordinateReset({ ...op, readUsage: async () => { throw new Error("read failed"); } });
	await coordinateReset(op);
	assert.equal(posts.length, 1);
});

for (const outcome of ["nothing_to_reset", "no_credit"] as const) {
	test(`resets ${outcome} is auto-guarded, explicit manual R token allows new intent without clearing auto guard`, async (t) => {
		const { op, posts, agentDir } = fixture(t);
		const consume = op.consume;
		op.consume = async (...args) => { await consume(...args); return { outcome }; };
		await coordinateReset(op);
		const first = readResetJournal(agentDir, accountKey)!;
		await coordinateReset(op);
		await coordinateReset({ ...op, mode: "manual" });
		assert.equal(posts.length, 1);
		await coordinateReset({ ...op, mode: "manual", manualAfterRequestId: first.requestId });
		assert.equal(posts.length, 2);
		assert.notEqual(posts[0]?.[1], posts[1]?.[1]);
		await coordinateReset(op);
		// A different process cannot reuse an old explicit refresh token.
		await coordinateReset({ ...op, mode: "manual", manualAfterRequestId: first.requestId });
		assert.equal(posts.length, 2);
	});
}

for (const outcome of ["ambiguous", "unknown", "pending"] as const) {
	test(`resets ${outcome} survives restart/recovery and permits only manual same-ID retry`, async (t) => {
		const { op, posts, agentDir } = fixture(t);
		if (outcome === "pending") {
			await withResetAccountLock(agentDir, accountKey, async (save) => {
				save({ version: 1, accountKey, phase: "pending", recovered: false, requestId: "saved-id", creditId: "saved-credit" });
			});
		} else {
			const consume = op.consume;
			await coordinateReset({ ...op, consume: async (...args) => {
				await consume(...args);
				if (outcome === "ambiguous") throw new Error("secret transport body must not persist");
				return { outcome: "unknown" };
			} });
		}
		const saved = readResetJournal(agentDir, accountKey)!;
		const before = posts.length;
		await coordinateReset({ ...op, readUsage: async () => usage(0) });
		await coordinateReset(op);
		assert.equal(posts.length, before);
		await coordinateReset({ ...op, mode: "manual", readUsage: async () => { throw new Error("must not read on exact retry"); }, consume: async (...args) => {
			await op.consume(...args); return { outcome: "already_redeemed" };
		} });
		assert.deepEqual(posts.at(-1), [saved.creditId, saved.requestId]);
		assert.equal(readResetJournal(agentDir, accountKey)?.phase, "already_redeemed");
		assert.doesNotMatch(readFileSync(resetPaths(agentDir, accountKey).journal, "utf8"), /secret|transport/);
	});
}

test("resets no-credit summary/detail misses and read failures send no POST, persist no intent, can later find credit", async (t) => {
	const { op, posts, agentDir } = fixture(t);
	await coordinateReset({ ...op, readUsage: async () => usage(100, 0), readCredits: async () => { throw new Error("unnecessary detail"); } });
	assert.equal(readResetJournal(agentDir, accountKey), undefined);
	await coordinateReset({ ...op, readCredits: async () => ({ availableCount: 2, credits: [] }) });
	await coordinateReset({ ...op, readCredits: async () => { throw new Error("read failed"); } });
	await coordinateReset({ ...op, readUsage: async () => { throw new Error("read failed"); } });
	assert.equal(posts.length, 0);
	assert.equal(readResetJournal(agentDir, accountKey), undefined);
	await coordinateReset(op);
	assert.equal(posts.length, 1);
});

test("resets manual allows five-hour-only reset while auto requires weekly exhaustion before detail", async (t) => {
	const { op, posts } = fixture(t);
	let details = 0;
	const readCredits = op.readCredits;
	op.readCredits = async () => { details++; return readCredits(); };
	op.readUsage = async () => usage(99.6);
	await coordinateReset(op);
	assert.equal(details, 0);
	await coordinateReset({ ...op, mode: "manual" });
	assert.equal(posts.length, 1);
});

test("resets cancellation at every async validation boundary stays retryable with no unsent intent", async (t) => {
	for (let boundary = 1; boundary <= 4; boundary++) {
		const { op, posts, agentDir } = fixture(t);
		let checks = 0;
		op.validate = async () => { if (++checks === boundary) throw new Error("disabled/account/model/shutdown changed"); };
		await coordinateReset(op);
		assert.equal(posts.length, 0, `boundary ${boundary}`);
		assert.equal(readResetJournal(agentDir, accountKey), undefined);
		await coordinateReset(op);
		assert.equal(posts.length, 1, `later valid check after boundary ${boundary}`);
	}
});

test("resets manual-auto overlap excludes pre-spend observations and duplicate POST", async (t) => {
	const { op, posts } = fixture(t);
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void;
	const wait = new Promise<void>((resolve) => { release = resolve; });
	const first = coordinateReset({ ...op, readUsage: async () => { entered(); await wait; return usage(); } });
	await started;
	let otherReads = 0;
	await coordinateReset({ ...op, mode: "manual", readUsage: async () => { otherReads++; return usage(0); } });
	assert.equal(otherReads, 0);
	release();
	await first;
	await coordinateReset(op);
	assert.equal(posts.length, 1);
});

test("resets corrupt journal and orphan lock fail closed; neither is erased", async (t) => {
	const { op, posts, agentDir } = fixture(t);
	await withResetAccountLock(agentDir, accountKey, async () => {});
	const paths = resetPaths(agentDir, accountKey);
	writeFileSync(paths.journal, "not-json", { mode: 0o600 });
	assert.match((await coordinateReset(op)).status, /Paused/);
	assert.equal(readFileSync(paths.journal, "utf8"), "not-json");
	assert.match(resetAccountStatus(agentDir, accountKey), /preserve the journal/);
	assert.equal(posts.length, 0);
});

function child(agentDir: string, mode: string) {
	return fork(new URL("./fixtures/reset-process.ts", import.meta.url), [agentDir, mode], {
		execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
}

test("resets TWO PROCESSES sharing an agent dir perform only one POST", async (t) => {
	const { agentDir } = fixture(t);
	const a = child(agentDir, "hold");
	t.after(() => a.kill());
	assert.equal((await once(a, "message"))[0], "posted");
	const b = child(agentDir, "auto");
	t.after(() => b.kill());
	const bExit = once(b, "exit");
	assert.equal((await once(b, "message"))[0], "blocked");
	await bExit;
	const aExit = once(a, "exit");
	a.send("release");
	await aExit;
	const c = child(agentDir, "auto");
	const cExit = once(c, "exit");
	assert.equal((await once(c, "message"))[0], "blocked");
	await cExit;
});

test("resets hard crash retains pending intent and exclusion; verified operator unlock enables exact manual retry only", async (t) => {
	const { op, posts, agentDir } = fixture(t);
	const a = child(agentDir, "hold");
	assert.equal((await once(a, "message"))[0], "posted");
	const exit = once(a, "exit");
	a.kill("SIGKILL");
	await exit;
	const paths = resetPaths(agentDir, accountKey);
	const saved = readResetJournal(agentDir, accountKey)!;
	assert.equal(saved.phase, "pending");
	assert.equal(existsSync(paths.lock), true);
	await coordinateReset(op);
	await coordinateReset({ ...op, mode: "manual" });
	assert.equal(posts.length, 0);
	// Simulated operator: all test children have exited; remove ONLY the orphan lock.
	rmSync(paths.lock, { recursive: true });
	await coordinateReset(op);
	assert.equal(posts.length, 0);
	await coordinateReset({ ...op, mode: "manual" });
	assert.deepEqual(posts, [[saved.creditId, saved.requestId]]);
});

test("resets crash before POST preserves durable pending intent rather than minting a new ID", async (t) => {
	const { op, posts, agentDir } = fixture(t);
	const a = child(agentDir, "before-post");
	assert.equal((await once(a, "message"))[0], "intent");
	const saved = readResetJournal(agentDir, accountKey)!;
	const exit = once(a, "exit");
	a.kill("SIGKILL");
	await exit;
	await coordinateReset(op);
	assert.equal(posts.length, 0);
	// Simulated exclusive operator recovery: child exited, journal is retained unchanged.
	rmSync(resetPaths(agentDir, accountKey).lock, { recursive: true });
	await coordinateReset({ ...op, mode: "manual" });
	assert.deepEqual(posts, [[saved.creditId, saved.requestId]]);
});

for (const expiry of ["elapsed", "credit", "weekly"] as const) {
	for (const boundary of ["final-auth", "after-save"] as const) {
		test(`resets ${expiry} expiry at ${boundary} leaves a later valid automatic check retryable`, async (t) => {
			const { op, posts, agentDir } = fixture(t);
			let clock = Date.now();
			t.mock.method(Date, "now", () => clock);
			if (expiry === "credit") op.readCredits = async () => ({ availableCount: 1, credits: [{ id: "expiring", expiresAt: new Date(clock + 1_000).toISOString() }] });
			if (expiry === "weekly") op.readUsage = async () => ({ limits: [{ limitId: "codex", secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: clock / 1000 + 1 } }] });
			let validations = 0;
			let checks = 0;
			const expire = () => { clock += expiry === "elapsed" ? 31_000 : 1_000; };
			op.validate = async () => { if (++validations === 4 && boundary === "final-auth") expire(); };
			op.checkBeforePost = () => { if (++checks === 2 && boundary === "after-save") expire(); };
			await coordinateReset(op);
			assert.equal(posts.length, 0);
			assert.equal(readResetJournal(agentDir, accountKey), undefined);
			await coordinateReset(op);
			assert.equal(posts.length, 1);
		});
	}
}

for (const prior of ["none", "guarded", "recovered", "ambiguous", "pending", "unknown"] as const) {
	for (const boundary of ["final-auth", "after-save"] as const) {
		test(`resets unsent ${boundary} cancellation preserves ${prior} journal and original IDs`, async (t) => {
			const { op, posts, agentDir } = fixture(t);
			const paths = resetPaths(agentDir, accountKey);
			if (prior !== "none") await withResetAccountLock(agentDir, accountKey, async (save) => save({
				version: 1, accountKey, phase: prior === "guarded" || prior === "recovered" ? "reset" : prior,
				recovered: prior === "recovered", requestId: "original-request", creditId: "original-credit",
			}));
			const original = prior === "none" ? undefined : readFileSync(paths.journal, "utf8");
			let validations = 0;
			let checks = 0;
			const uncertain = ["ambiguous", "pending", "unknown"].includes(prior);
			await coordinateReset({ ...op,
				mode: prior === "guarded" || uncertain ? "manual" : "auto", manualAfterRequestId: "original-request",
				validate: async () => { if (++validations === (uncertain ? 2 : 4) && boundary === "final-auth") throw new Error("auth cancelled"); },
				checkBeforePost: () => { if (++checks === 2 && boundary === "after-save") throw new Error("consent/lifecycle changed"); },
			});
			assert.equal(posts.length, 0);
			assert.equal(existsSync(paths.journal) ? readFileSync(paths.journal, "utf8") : undefined, original);
			await coordinateReset(op);
			assert.equal(posts.length, prior === "none" || prior === "recovered" ? 1 : 0);
			if (uncertain) {
				await coordinateReset({ ...op, mode: "manual" });
				assert.deepEqual(posts, [["original-credit", "original-request"]]);
			}
		});
	}
}
