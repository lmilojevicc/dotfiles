import { cloneSnapshot, EMPTY_SNAPSHOT, type TaskSnapshot } from "../domain/types.js";
import { taskActivity } from "./activity.js";

export interface Slot {
	snapshot: TaskSnapshot;
	pendingHumanRevision?: number;
	announcedRevision: number;
	migrationWarning?: string;
}

const slots = new Map<string, Slot>();
let foregroundSession = "";

function freshSlot(): Slot {
	return { snapshot: cloneSnapshot(EMPTY_SNAPSHOT), announcedRevision: 0 };
}

export function sessionId(ctx: { sessionManager: { getSessionId(): string | undefined } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

export function getSlot(id: string): Slot {
	return slots.get(id) ?? freshSlot();
}

export function getSnapshot(id: string): TaskSnapshot {
	return getSlot(id).snapshot;
}

export function commitSnapshot(id: string, snapshot: TaskSnapshot, human = false): void {
	const slot = slots.get(id) ?? freshSlot();
	slot.snapshot = snapshot;
	if (human) slot.pendingHumanRevision = snapshot.revision;
	slots.set(id, slot);
}

export function restoreSlot(id: string, slot: Slot): void {
	slots.set(id, slot);
}

export function evictSlot(id: string): void {
	slots.delete(id);
}

export function setForeground(id: string): void {
	foregroundSession = id;
}

export function getForeground(): string {
	return foregroundSession;
}

export function clearForeground(): void {
	foregroundSession = "";
}

export function foregroundSnapshot(): TaskSnapshot {
	return getSnapshot(foregroundSession);
}

export function markAnnounced(id: string, revision: number): void {
	const slot = slots.get(id) ?? freshSlot();
	slot.announcedRevision = Math.max(slot.announcedRevision, revision);
	if ((slot.pendingHumanRevision ?? 0) <= slot.announcedRevision) slot.pendingHumanRevision = undefined;
	slots.set(id, slot);
}

export function takeMigrationWarning(id: string): string | undefined {
	const slot = slots.get(id);
	if (!slot?.migrationWarning) return undefined;
	const warning = slot.migrationWarning;
	delete slot.migrationWarning;
	return warning;
}

export function resetStore(): void {
	slots.clear();
	taskActivity.clear();
	foregroundSession = "";
}
