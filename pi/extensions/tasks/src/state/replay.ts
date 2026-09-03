import { validateSnapshot } from "../domain/invariants.js";
import { cloneSnapshot, EMPTY_SNAPSHOT, type TaskSnapshot } from "../domain/types.js";
import { migrateLegacySnapshot } from "./migration.js";
import type { Slot } from "./store.js";

export const STATE_ENTRY = "pi-tasks-state";
export const SYNC_MESSAGE = "pi-tasks-sync";

export function parseSnapshot(value: unknown): TaskSnapshot | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as TaskSnapshot;
	if (!Array.isArray(candidate.tasks)) return undefined;
	try {
		if (validateSnapshot(candidate)) return undefined;
		return cloneSnapshot(candidate);
	} catch {
		return undefined;
	}
}

export interface ReplayResult extends Slot {}

function claimsModernSnapshot(value: unknown): boolean {
	return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "pi.tasks.snapshot";
}

/** Last valid branch-native snapshot wins across new tool, legacy tool, and human custom entries. */
export function replayBranch(branch: Iterable<unknown>): ReplayResult {
	let snapshot = cloneSnapshot(EMPTY_SNAPSHOT);
	let migrationWarning: string | undefined;
	let lastHumanRevision = 0;
	let announcedRevision = 0;
	for (const raw of branch) {
		const entry = raw as {
			type?: string;
			customType?: string;
			data?: unknown;
			details?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "todo") {
			const modern = parseSnapshot(entry.message.details);
			if (modern) {
				snapshot = modern;
				migrationWarning = undefined;
				continue;
			}
			if (claimsModernSnapshot(entry.message.details)) continue;
			const legacy = migrateLegacySnapshot(entry.message.details);
			if (legacy) {
				snapshot = legacy.snapshot;
				migrationWarning = legacy.warning;
			}
			continue;
		}
		if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
			const modern = parseSnapshot(entry.data);
			if (modern) {
				snapshot = modern;
				lastHumanRevision = Math.max(lastHumanRevision, modern.revision);
				migrationWarning = undefined;
			}
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === SYNC_MESSAGE) {
			const details = entry.details as { revision?: unknown } | undefined;
			if (Number.isSafeInteger(details?.revision)) announcedRevision = Math.max(announcedRevision, details!.revision as number);
		}
	}
	return {
		snapshot,
		announcedRevision,
		...(lastHumanRevision > announcedRevision ? { pendingHumanRevision: lastHumanRevision } : {}),
		...(migrationWarning ? { migrationWarning } : {}),
	};
}
