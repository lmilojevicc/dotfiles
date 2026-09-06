import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectAutoResetCredit, selectResetCredit, weeklyResetObservation, type ResetCredits, type ResetOutcome, type ResetResult, type UsageSnapshot } from "./core.ts";

export type LegacyResetIntent = {
	requestId?: string;
	creditId?: string;
	phase?: "pending" | "ambiguous" | "locked";
	outcome?: ResetOutcome;
	active: boolean;
	settled: boolean;
};

/** Exact messages/kinds emitted by the pre-auto runResetRequest producer, not arbitrary error text. */
export function legacyResetIntent(value: unknown): LegacyResetIntent {
	const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const id = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
	const phase = record.phase === "pending" || record.phase === "ambiguous" || record.phase === "locked" ? record.phase : undefined;
	const active = record.promise !== undefined;
	const message = record.message as { kind?: unknown; text?: unknown } | undefined;
	const outcomes = [
		["reset", "info", "Codex rate limits reset."],
		["already_redeemed", "info", "Reset already applied; refreshed usage."],
		["nothing_to_reset", "error", "No active Codex limit to reset."],
		["no_credit", "error", "No banked resets available."],
		["unknown", "error", "Reset response was not recognized; refreshed usage."],
	] as const;
	const outcome = phase === "locked" ? outcomes.find(([, kind, text]) => message?.kind === kind && message?.text === text)?.[0] ?? "unknown" : undefined;
	return { requestId: id(record.requestId), creditId: id(record.creditId), phase, outcome,
		active, settled: !active && (phase === "locked" || phase === "ambiguous") };
}

export type ResetJournal = {
	version: 1;
	accountKey: string;
	recovered: boolean;
	phase: "pending" | "ambiguous" | ResetOutcome | "legacy_blocked";
	requestId?: string;
	creditId?: string;
	legacyBlocked?: { requestId?: string; creditId?: string } & Partial<LegacyResetIntent>;
	legacyReset?: LegacyResetIntent;
};

const UNCERTAIN = new Set(["pending", "ambiguous", "unknown"]);
const PHASES = new Set(["pending", "ambiguous", "reset", "already_redeemed", "nothing_to_reset", "no_credit", "unknown", "legacy_blocked"]);
const MAX_JOURNAL_BYTES = 16_384;
const LEGACY_PAUSED = "Paused: previous reset needs recovery; see README.";
const LEGACY_ACTIVE = "Paused: previous reset still running. Wait, then /reload.";
const STORAGE_PAUSED = "Paused: reset journal/lock unavailable or uncertain. Verify no cooperating process is operating before removing ONLY an orphan lock; preserve the journal.";

export function resetPaths(agentDir: string, accountKey: string) {
	const directory = join(agentDir, "codex-enhanced-resets");
	const name = createHash("sha256").update(accountKey).digest("hex");
	return { directory, journal: join(directory, `${name}.json`), lock: join(directory, `${name}.lock`) };
}

function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

function checkPrivate(path: string, directory: boolean): void {
	const stat = lstatSync(path);
	if ((directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0
		|| (process.getuid && stat.uid !== process.getuid())) throw new Error(STORAGE_PAUSED);
}

export function readResetJournal(agentDir: string, accountKey: string): ResetJournal | undefined {
	const paths = resetPaths(agentDir, accountKey);
	try {
		checkPrivate(paths.directory, true);
		checkPrivate(paths.journal, false);
		if (lstatSync(paths.journal).size > MAX_JOURNAL_BYTES) throw new Error(STORAGE_PAUSED);
		const value = JSON.parse(readFileSync(paths.journal, "utf8"));
		if (!value || value.version !== 1 || value.accountKey !== accountKey || !PHASES.has(value.phase)
			|| typeof value.recovered !== "boolean"
			|| (value.phase !== "legacy_blocked" && (typeof value.requestId !== "string" || !value.requestId.trim()
				|| typeof value.creditId !== "string" || !value.creditId.trim()))
			|| (UNCERTAIN.has(value.phase) && value.recovered)) throw new Error(STORAGE_PAUSED);
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(STORAGE_PAUSED);
	}
}

export function resetJournalStatus(journal: ResetJournal | undefined): string {
	if (journal && (journal.phase === "legacy_blocked" || Object.hasOwn(journal, "legacyBlocked"))) return LEGACY_PAUSED;
	if (!journal || journal.recovered) return "Monitoring fresh weekly usage.";
	if (UNCERTAIN.has(journal.phase)) return "Paused: uncertain reset. Ctrl+R twice retries ONLY the saved credit and request ID; automatic retry is disabled.";
	return `Paused auto: ${journal.phase}. Waiting for fresh weekly recovery then exhaustion. Manual: R refresh, then Ctrl+R twice permits another spend.`;
}

export function resetAccountStatus(agentDir: string, accountKey: string, legacy?: LegacyResetIntent): string {
	if (legacy?.active) return LEGACY_ACTIVE;
	try {
		try { lstatSync(resetPaths(agentDir, accountKey).lock); return STORAGE_PAUSED; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return resetJournalStatus(readResetJournal(agentDir, accountKey));
	} catch { return STORAGE_PAUSED; }
}

/** No leases or stale-PID takeover: a crash requires verified operator unlock, never intent deletion. */
export async function withResetAccountLock<T>(agentDir: string, accountKey: string,
	work: (save: (journal: ResetJournal | undefined) => void) => Promise<T>): Promise<T> {
	const paths = resetPaths(agentDir, accountKey);
	let owned = false;
	let durable = true;
	const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
	const ownerPath = join(paths.lock, "owner.json");
	try {
		mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
		checkPrivate(paths.directory, true);
		syncDirectory(agentDir);
		mkdirSync(paths.lock, { mode: 0o700 });
		owned = true;
		writeFileSync(ownerPath, owner, { mode: 0o600, flag: "wx" });
		syncDirectory(paths.directory);
		return await work((journal) => {
			if (!journal) {
				// Only used to roll back a definitely-unsent new intent under this owned lock.
				durable = false;
				unlinkSync(paths.journal);
				syncDirectory(paths.directory);
				durable = true;
				return;
			}
			const serialized = `${JSON.stringify(journal)}\n`;
			if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) throw new Error(STORAGE_PAUSED);
			// If any durability step fails, retain exclusion as well as the old/new journal.
			durable = false;
			const temporary = join(paths.lock, "intent.tmp");
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, serialized); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, paths.journal);
			syncDirectory(paths.directory);
			durable = true;
		});
	} finally {
		if (owned && durable) {
			// Release only the lock still bearing our unique ownership marker.
			if (readFileSync(ownerPath, "utf8") !== owner) throw new Error(STORAGE_PAUSED);
			unlinkSync(ownerPath);
			rmdirSync(paths.lock);
			syncDirectory(paths.directory);
		}
	}
}

/** Never replace a normal/newer intent or infer settlement from age, usage or absent disk locks. */
function migrateLegacyReset(accountKey: string, journal: ResetJournal | undefined, intent: LegacyResetIntent): ResetJournal | undefined {
	if (intent.active) return journal;
	if (journal) {
		if (journal.phase !== "legacy_blocked") return journal;
		const saved = journal.legacyBlocked;
		if (!intent.requestId || !intent.creditId || saved?.requestId !== intent.requestId || saved?.creditId !== intent.creditId
			|| (journal.requestId !== undefined && journal.requestId !== intent.requestId)
			|| (journal.creditId !== undefined && journal.creditId !== intent.creditId)) return journal;
	}
	if (intent.settled && intent.requestId && intent.creditId) {
		return { version: 1, accountKey, recovered: false, requestId: intent.requestId, creditId: intent.creditId,
			phase: intent.phase === "ambiguous" ? "ambiguous" : intent.outcome ?? "unknown", legacyReset: intent };
	}
	return journal ?? { version: 1, accountKey, phase: "legacy_blocked", recovered: false, legacyBlocked: intent };
}

/** Migration is local-only. A live producer retains ownership; re-read its state on the next check. */
export async function preserveLegacyReset(agentDir: string, accountKey: string, intent: LegacyResetIntent): Promise<void> {
	if (intent.active) return;
	await withResetAccountLock(agentDir, accountKey, async (save) => {
		const journal = readResetJournal(agentDir, accountKey);
		const migrated = migrateLegacyReset(accountKey, journal, intent);
		if (migrated !== journal) save(migrated);
	});
}

export type ResetOperation = {
	agentDir: string;
	accountKey: string;
	mode: "auto" | "manual";
	/** Explicit successful R refresh observed this terminal intent, never an uncertain intent. */
	manualAfterRequestId?: string;
	/** Re-read the old producer after awaits; never take over a live operation. */
	legacyIntent?: () => LegacyResetIntent | undefined;
	/** Must re-resolve auth and check lifecycle/model/consent after every network await. */
	validate: () => Promise<void>;
	/** Synchronous lifecycle/consent check; must not dispatch or await. */
	checkBeforePost: () => void;
	readUsage: () => Promise<UsageSnapshot>;
	readCredits: () => Promise<ResetCredits | undefined>;
	consume: (creditId: string, requestId: string) => Promise<ResetResult>;
	refresh: () => Promise<void>;
};

export type ResetOperationResult = { status: string; result?: ResetResult };

/** Both entry points hold the same exclusion across observation, durable intent, POST and reconciliation. */
export async function coordinateReset(operation: ResetOperation): Promise<ResetOperationResult> {
	let spending = false;
	let stage = "eligibility";
	try {
		await operation.validate();
		stage = "storage";
		return await withResetAccountLock(operation.agentDir, operation.accountKey, async (save) => {
			let autoUsage: UsageSnapshot | undefined;
			let observedAt = 0;
			let autoCredit: ResetCredits["credits"][number] | undefined;
			let journal = readResetJournal(operation.agentDir, operation.accountKey);
			const legacy = operation.legacyIntent?.();
			if (legacy?.active) return { status: LEGACY_ACTIVE };
			if (legacy) {
				const migrated = migrateLegacyReset(operation.accountKey, journal, legacy);
				if (migrated !== journal) {
					save(migrated);
					// Migration itself never spends or observes recovery, even for a manual caller.
					return { status: resetJournalStatus(migrated) };
				}
			}
			if (journal && (journal.phase === "legacy_blocked" || Object.hasOwn(journal, "legacyBlocked"))) return { status: LEGACY_PAUSED };
			const uncertain = journal && UNCERTAIN.has(journal.phase);
			if (uncertain && operation.mode === "auto") return { status: resetJournalStatus(journal) };
			if (journal && !uncertain && operation.mode === "manual" && operation.manualAfterRequestId !== journal.requestId) {
				return { status: "Press R for an explicit fresh refresh, then Ctrl+R twice to permit a NEW manual spend (even in this weekly episode)." };
			}
			if (!uncertain) {
				// Acquired lock BEFORE starting this GET: pre-spend in-flight snapshots cannot rearm it.
				stage = "read";
				const usage = await operation.readUsage();
				observedAt = Date.now();
				stage = "eligibility";
				await operation.validate();
				const observation = weeklyResetObservation(usage);
				if (journal && !journal.recovered && operation.mode === "auto") {
					if (observation === "recovered") {
						journal = { ...journal, recovered: true };
						stage = "storage";
						save(journal);
					}
					return { status: resetJournalStatus(journal) };
				}
				if (operation.mode === "auto" && observation !== "exhausted") {
					return { status: observation === "unknown" ? "Paused: weekly usage is missing, invalid or stale." : "Monitoring fresh weekly usage." };
				}
				let credits: ResetCredits | undefined;
				if (usage.resetCredits?.availableCount !== 0) {
					stage = "read";
					credits = await operation.readCredits();
					stage = "eligibility";
					await operation.validate();
				}
				const credit = credits && credits.availableCount > 0
					? (operation.mode === "auto" ? selectAutoResetCredit : selectResetCredit)(credits.credits) : undefined;
				if (!credit?.id) return { status: "Paused: no usable detailed credit. No POST; a later fresh check may find one." };
				// Recheck timestamp/credit expiry after detail/auth reads, not display/cache values.
				if (operation.mode === "auto" && (weeklyResetObservation(usage) !== "exhausted"
					|| !selectAutoResetCredit([credit]))) return { status: "Paused: usage or credit expired during check." };
				if (operation.mode === "auto") { autoUsage = usage; autoCredit = credit; }
				journal = { version: 1, accountKey: operation.accountKey, recovered: false,
					phase: "pending", creditId: credit.id, requestId: randomUUID() };
			}
			stage = "eligibility";
			await operation.validate();
			const checkBeforePost = () => {
				operation.checkBeforePost();
				if (operation.legacyIntent?.()?.active) throw new Error(LEGACY_ACTIVE);
				if (operation.mode === "auto" && (!autoUsage || weeklyResetObservation(autoUsage) !== "exhausted"
					|| Date.now() - observedAt > 30_000 || !autoCredit || !selectAutoResetCredit([autoCredit]))) {
					throw new Error("Observation expired before POST");
				}
			};
			checkBeforePost();
			const previousJournal = readResetJournal(operation.agentDir, operation.accountKey);
			journal = { ...journal!, phase: "pending", recovered: false };
			stage = "storage";
			save(journal); // This durability boundary MUST precede any possible POST.
			try {
				// No await from here to dispatch. Synchronous storage can still outlast expiry
				// or overlap another process disabling consent.
				checkBeforePost();
			} catch {
				save(previousJournal); // Definitely unsent: restore even an uncertain prior intent verbatim.
				return { status: "Paused: eligibility changed before POST; no POST. A later check may retry; prior guard preserved." };
			}
			spending = true;
			let result: ResetResult;
			try {
				result = await operation.consume(journal.creditId!, journal.requestId!);
			} catch {
				save({ ...journal, phase: "ambiguous" });
				return { status: resetJournalStatus({ ...journal, phase: "ambiguous" }) };
			}
			journal = { ...journal, phase: result.outcome };
			save(journal); // Record even if disabled/shut down while POST was in flight.
			try {
				await operation.validate();
				await operation.refresh();
				await operation.validate();
			} catch {
				return { result, status: `${resetJournalStatus(journal)} Refresh unavailable; saved outcome preserved.` };
			}
			// Reconciliation is display-only. A later locked fresh GET must observe recovery.
			return { result, status: resetJournalStatus(journal) };
		});
	} catch {
		return { status: spending || stage === "storage" ? STORAGE_PAUSED
			: stage === "read" ? "Paused: fresh usage/credit read failed; no POST. A later check may retry the read."
				: "Paused: auth, account, model, consent or lifecycle changed; no new POST. Any saved intent is preserved." };
	}
}
