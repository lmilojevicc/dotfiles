import { validateSnapshot } from "../domain/invariants.js";
import { cloneSnapshot, EMPTY_SNAPSHOT, type TaskSnapshot } from "../domain/types.js";
import { migrateLegacySnapshot } from "./migration.js";
import type { Slot } from "./store.js";

export const STATE_ENTRY = "pi-tasks-state";
export const SYNC_MESSAGE = "pi-tasks-sync";
/** Branch marker recording that this branch's legacy migration was already reported to the user. */
export const MIGRATION_ENTRY = "pi-tasks-migration";

export interface ReplayResult extends Slot {}

interface BranchEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	details?: unknown;
	message?: { role?: string; toolName?: string; details?: unknown };
}

interface EntryState {
	snapshot: TaskSnapshot;
	warning?: string;
}

function claimsModernSnapshot(value: unknown): boolean {
	return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "pi.tasks.snapshot";
}

function revisionOf(value: unknown): number | undefined {
	const revision = (value as { revision?: unknown } | undefined)?.revision;
	return typeof revision === "number" && Number.isSafeInteger(revision) ? revision : undefined;
}

/** Validate without cloning, so superseded entries cost no copy of their task list. */
function validSnapshot(value: unknown): TaskSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as TaskSnapshot;
	if (!Array.isArray(candidate.tasks)) return undefined;
	try {
		return validateSnapshot(candidate) ? undefined : candidate;
	} catch {
		return undefined;
	}
}

function isStateEntry(entry: BranchEntry): boolean {
	return (entry.type === "custom" && entry.customType === STATE_ENTRY)
		|| (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "todo");
}

/** State carried by one state-bearing entry, or undefined when the entry holds no replayable snapshot. */
function entryState(entry: BranchEntry): EntryState | undefined {
	if (entry.type === "custom") {
		const snapshot = validSnapshot(entry.data);
		return snapshot ? { snapshot } : undefined;
	}
	const details = entry.message?.details;
	const modern = validSnapshot(details);
	if (modern) return { snapshot: modern };
	// A result that claims the modern discriminator but fails validation must not be read as legacy.
	if (claimsModernSnapshot(details)) return undefined;
	return migrateLegacySnapshot(details);
}

/**
 * Newest human edit that was not announced yet. Candidate revisions are read without validating every
 * entry; only a candidate that would actually produce a reminder is validated, highest revision first.
 */
function unannouncedHumanRevision(candidates: ReadonlyArray<{ revision: number; data: unknown }>, announcedRevision: number): number | undefined {
	const pending = candidates.filter((candidate) => candidate.revision > announcedRevision).sort((a, b) => b.revision - a.revision);
	for (const candidate of pending) {
		if (validSnapshot(candidate.data)) return candidate.revision;
	}
	return undefined;
}

/**
 * Last valid branch-native snapshot wins across new tool, legacy tool, and human custom entries.
 * The branch is scanned backwards so only the newest snapshot is validated and cloned, whatever the
 * session length; earlier entries are inspected only for the cheap revisions replay also needs.
 */
export function replayBranch(branch: Iterable<unknown>): ReplayResult {
	const entries = (Array.isArray(branch) ? branch : [...branch]) as BranchEntry[];
	let newest: EntryState | undefined;
	let announcedRevision = 0;
	let migrationAnnounced = false;
	const humanRevisions: Array<{ revision: number; data: unknown }> = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "custom_message" && entry.customType === SYNC_MESSAGE) {
			const revision = revisionOf(entry.details);
			if (revision !== undefined) announcedRevision = Math.max(announcedRevision, revision);
			continue;
		}
		if (entry.type === "custom" && entry.customType === MIGRATION_ENTRY) {
			// A marker counts only when it was appended after the state entry being replayed.
			if (!newest) migrationAnnounced = true;
			continue;
		}
		if (!isStateEntry(entry)) continue;
		if (entry.type === "custom") {
			const revision = revisionOf(entry.data);
			if (revision !== undefined) humanRevisions.push({ revision, data: entry.data });
		}
		if (newest) continue;
		newest = entryState(entry);
	}
	const pendingHumanRevision = unannouncedHumanRevision(humanRevisions, announcedRevision);
	return {
		snapshot: cloneSnapshot(newest?.snapshot ?? EMPTY_SNAPSHOT),
		announcedRevision,
		...(pendingHumanRevision === undefined ? {} : { pendingHumanRevision }),
		...(newest?.warning
			? { migrationWarning: newest.warning, ...(migrationAnnounced ? { migrationAnnounced: true } : {}) }
			: {}),
	};
}
