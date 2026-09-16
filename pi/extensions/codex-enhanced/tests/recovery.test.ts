import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acknowledgeLegacyReset, coordinateReset as coordinateResetImpl, offerLegacyAcknowledgement, preserveLegacyReset, readResetJournal, resetAccountState, resetPaths, withResetAccountLock, type LegacyResetIntent, type ResetJournal } from "../resets.ts";

const coordinateReset = (op: any) => coordinateResetImpl({ ...op, manualAction: resetAccountState(op.agentDir, op.accountKey).manualAction });
const key = "account:synthetic-recovery";
const ids = { requestId: "synthetic-original-request", creditId: "synthetic-original-credit" };
const noLegacy = () => undefined;
async function fixture(t: any, journal: unknown = { version: 1, accountKey: key, recovered: false, phase: "legacy_blocked", legacyBlocked: ids }) {
	const dir = mkdtempSync(join(tmpdir(), "codex-recovery-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	await withResetAccountLock(dir, key, async (save) => save(journal as ResetJournal));
	const paths = resetPaths(dir, key);
	const bytes = () => readFileSync(paths.journal, "utf8");
	const offer = offerLegacyAcknowledgement(dir, key, noLegacy);
	const apply = (options: Record<string, unknown> = {}) => {
		assert.ok(offer.eligible);
		return acknowledgeLegacyReset({ agentDir: dir, offer: offer.offer,
			attestation: { outcome: "reset", noPriorOperationInFlight: true }, legacyIntent: noLegacy, checkCurrent: () => {}, ...options } as any);
	};
	return { dir, paths, bytes, offer, apply };
}

for (const outcome of ["reset", "already_redeemed"] as const) {
	test(`acknowledgeLegacyReset ${outcome} preserves exact IDs/evidence, zero network and only a temporary-file nonce`, async (t) => {
		const f = await fixture(t);
		const original = JSON.parse(f.bytes());
		let network = 0;
		let nonces = 0;
		t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("forbidden"); });
		t.mock.method(crypto, "randomUUID", () => { nonces++; return "synthetic-lock-owner"; });
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		const result = await f.apply({ attestation: { outcome, noPriorOperationInFlight: true } });
		assert.equal(result.acknowledged, true);
		const saved = readResetJournal(f.dir, key)!;
		assert.equal(saved.phase, outcome);
		assert.equal(saved.recovered, false);
		assert.equal(saved.requestId, ids.requestId);
		assert.equal(saved.creditId, ids.creditId);
		assert.equal(Object.hasOwn(saved, "legacyBlocked"), false);
		assert.deepEqual(saved.legacyAcknowledgement?.original, original);
		assert.equal(saved.legacyAcknowledgement?.outcome, outcome);
		assert.equal(saved.legacyAcknowledgement?.noPriorOperationInFlight, true);
		assert.ok(saved.legacyAcknowledgement?.acknowledgedAt);
		assert.equal(nonces, 1, "only temporary-file nonce, no new redemption ID");
		assert.equal(network, 0, "outside callback assertion cannot be swallowed");
		assert.equal(existsSync(f.paths.lock), true);
		assert.equal(offerLegacyAcknowledgement(f.dir, key, noLegacy).eligible, false);
		const terminal = f.bytes();
		assert.equal((await f.apply()).acknowledged, false);
		assert.equal(f.bytes(), terminal, "duplicate offer cannot overwrite terminal record");
	});
}

for (const attestation of [undefined, {}, { outcome: "unknown", noPriorOperationInFlight: true }, { outcome: "reset", noPriorOperationInFlight: false }]) {
	test(`acknowledgeLegacyReset rejects absent/invalid attestation ${JSON.stringify(attestation)}`, async (t) => {
		const f = await fixture(t); const before = f.bytes();
		assert.equal((await f.apply({ attestation })).acknowledged, false);
		assert.equal(f.bytes(), before);
		assert.equal(existsSync(f.paths.lock), true);
	});
}

for (const change of [
	{ legacyBlocked: { requestId: ids.requestId } }, { legacyBlocked: { ...ids, phase: "pending" } },
	{ legacyBlocked: { ...ids, active: false, settled: false } }, { legacyBlocked: [] },
	{ legacyBlocked: { ...ids, creditId: " " } }, { requestId: "conflict" }, { creditId: "conflict" },
	{ recovered: true }, { legacyReset: {} }, { phase: "pending", ...ids },
	{ phase: "ambiguous", ...ids }, { phase: "unknown", ...ids }, { phase: "reset", ...ids },
]) {
	test(`offerLegacyAcknowledgement refuses non-lossy/malformed ${JSON.stringify(change)}`, async (t) => {
		const f = await fixture(t, { version: 1, accountKey: key, recovered: false, phase: "legacy_blocked", legacyBlocked: ids, ...change });
		const before = f.bytes();
		assert.equal(f.offer.eligible, false);
		assert.equal(f.bytes(), before);
	});
}

for (const legacy of [
	{ ...ids, active: true, settled: false },
	{ ...ids, active: false, settled: false, phase: "pending" },
	{ ...ids, active: false, settled: true, phase: "ambiguous" },
	{ ...ids, active: false, settled: true, phase: "locked", outcome: "unknown" },
	{ ...ids, requestId: "other", active: false, settled: false },
	{ ...ids, creditId: "other", active: false, settled: false },
	{ active: false, settled: false },
] as LegacyResetIntent[]) {
	test(`acknowledgeLegacyReset re-reads and rejects live/conflicting producer ${JSON.stringify(legacy)}`, async (t) => {
		const f = await fixture(t); const before = f.bytes();
		assert.equal(offerLegacyAcknowledgement(f.dir, key, () => legacy).eligible, false);
		assert.equal((await f.apply({ legacyIntent: () => legacy })).acknowledged, false);
		assert.equal(f.bytes(), before);
	});
}

for (const change of ["journal", "same-bytes", "account", "guard", "guard-before-save", "live-before-save", "corrupt", "held", "orphan"] as const) {
	test(`acknowledgeLegacyReset fails closed after ${change}`, async (t) => {
		const f = await fixture(t);
		let release!: () => void;
		let held: Promise<void> | undefined;
		if (change === "journal") await withResetAccountLock(f.dir, key, async (save) => save({ version: 1, accountKey: key, ...ids, requestId: "newer", recovered: false, phase: "pending" }));
		if (change === "same-bytes") writeFileSync(f.paths.journal, f.bytes());
		if (change === "corrupt") writeFileSync(f.paths.journal, "not-json");
		if (change === "orphan") { rmSync(f.paths.lock); mkdirSync(f.paths.lock, { mode: 0o700 }); }
		if (change === "held") {
			let entered!: () => void; const ready = new Promise<void>((r) => { entered = r; });
			held = withResetAccountLock(f.dir, key, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
			await ready;
		}
		const before = f.bytes(); let checks = 0; let reads = 0;
		const options = change === "account" ? { offer: { ...(f.offer as any).offer, accountKey: "account:other" } }
			: change === "guard" || change === "guard-before-save" ? { checkCurrent: () => { if (++checks === (change === "guard" ? 1 : 3)) throw new Error("changed"); } }
			: change === "live-before-save" ? { legacyIntent: () => ++reads > 1 ? { ...ids, active: true, settled: false } : undefined } : {};
		assert.equal((await f.apply(options)).acknowledged, false);
		assert.equal(f.bytes(), before);
		if (held) { release(); await held; }
	});
}

for (const fault of ["write", "fsync", "rename", "directory-fsync"] as const) {
	test(`acknowledgeLegacyReset ${fault} durability fault releases exclusion and preserves conservative state`, async (t) => {
		const f = await fixture(t); const before = f.bytes();
		const originalWrite = fs.writeFileSync;
		const originalSync = fs.fsyncSync;
		let syncs = 0;
		if (fault === "write") t.mock.method(fs, "writeFileSync", ((path: any, ...args: any[]) => {
			if (typeof path === "number") throw new Error("synthetic write fault");
			return (originalWrite as any)(path, ...args);
		}) as any);
		if (fault === "fsync" || fault === "directory-fsync") t.mock.method(fs, "fsyncSync", (fd: number) => {
			if (++syncs === (fault === "fsync" ? 6 : 7)) throw new Error("synthetic sync fault");
			originalSync(fd);
		});
		if (fault === "rename") t.mock.method(fs, "renameSync", () => { throw new Error("synthetic rename fault"); });
		syncBuiltinESMExports();
		const result = await f.apply();
		t.mock.restoreAll(); syncBuiltinESMExports();
		assert.equal(result.acknowledged, false);
		assert.equal(existsSync(f.paths.lock), true);
		if (fault !== "directory-fsync") assert.equal(f.bytes(), before);
		await withResetAccountLock(f.dir, key, async () => {});
		assert.equal(readResetJournal(f.dir, key)?.recovered, false);
		assert.equal(resetAccountState(f.dir, key).reason, fault === "directory-fsync" ? "recovery" : "legacy");
	});
}

test("acknowledged restart guard survives stale map; only later valid recovery then exhaustion spends", async (t) => {
	const f = await fixture(t);
	const stale = { ...ids, active: false, settled: false };
	assert.equal((await f.apply({ legacyIntent: () => stale })).acknowledged, true);
	const terminal = f.bytes();
	for (const intent of [stale, { ...stale, phase: "locked", settled: true, outcome: "reset" } as LegacyResetIntent]) {
		await preserveLegacyReset(f.dir, key, intent);
		assert.equal(f.bytes(), terminal);
	}
	let percent: number | undefined = 100;
	let posts = 0; let details = 0; let reads = 0;
	const op = { agentDir: f.dir, accountKey: key, mode: "auto" as const, validate: async () => {}, checkBeforePost: () => {},
		legacyIntent: () => stale,
		readUsage: async () => { reads++; return { limits: [{ limitId: "codex", secondary: { windowMinutes: 10080, usedPercent: percent, resetsAt: Date.now() / 1000 + 3600 } }] }; },
		readCredits: async () => { details++; return { availableCount: 2, credits: [{ id: "synthetic-next" }] }; },
		consume: async () => { posts++; return { outcome: "reset" as const }; }, refresh: async () => {},
	};
	await coordinateReset({ ...op });
	percent = undefined; await coordinateReset({ ...op });
	assert.equal(readResetJournal(f.dir, key)?.recovered, false);
	assert.equal(posts, 0); assert.equal(details, 0);
	percent = 50; await coordinateReset({ ...op });
	assert.equal(readResetJournal(f.dir, key)?.recovered, true); assert.equal(posts, 0);
	percent = 100; await coordinateReset({ ...op });
	assert.equal(posts, 1); assert.equal(details, 1); assert.equal(reads, 4);
	const newer = f.bytes();
	assert.equal((await f.apply()).acknowledged, false);
	await preserveLegacyReset(f.dir, key, stale);
	assert.equal(f.bytes(), newer);
});

test("acknowledgement never dismisses actual live/other unresolved legacy operations", async (t) => {
	const f = await fixture(t); await f.apply();
	let reads = 0, posts = 0;
	for (const legacy of [{ ...ids, active: true, settled: false }, { ...ids, requestId: "other", phase: "pending", active: false, settled: false }] as LegacyResetIntent[]) {
		const result = await coordinateReset({ agentDir: f.dir, accountKey: key, mode: "manual", manualAfterRequestId: ids.requestId,
			validate: async () => {}, checkBeforePost: () => {}, legacyIntent: () => legacy,
			readUsage: async () => { reads++; return { limits: [] }; }, readCredits: async () => { reads++; return undefined; },
			consume: async () => { posts++; return { outcome: "reset" }; }, refresh: async () => { reads++; } });
		assert.match(result.status, /Paused/);
	}
	assert.equal(reads, 0); assert.equal(posts, 0);
});

test("acknowledged guard rechecks a conflicting old operation before new manual dispatch", async (t) => {
	const f = await fixture(t); await f.apply();
	let legacy: LegacyResetIntent | undefined; let posts = 0;
	await coordinateReset({ agentDir: f.dir, accountKey: key, mode: "manual", manualAfterRequestId: ids.requestId,
		validate: async () => {}, checkBeforePost: () => {}, legacyIntent: () => legacy,
		readUsage: async () => { legacy = { requestId: "other", creditId: "other-credit", phase: "pending", active: false, settled: false }; return { limits: [] }; },
		readCredits: async () => ({ availableCount: 1, credits: [{ id: "new-credit" }] }),
		consume: async () => { posts++; return { outcome: "reset" }; }, refresh: async () => {},
	});
	assert.equal(posts, 0);
	assert.equal(readResetJournal(f.dir, key)?.requestId, ids.requestId);
});
