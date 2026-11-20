/**
 * Zentui integration over its public event-bus protocols (v1): custom values for the editor
 * border, and keyed segments for the Working line. Both are probed before every publish; when
 * Zentui is absent or does not reference a key, callers fall back to Pi's own status slot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const VARIABLE_CAPABILITY_EVENT = "zentui:variable-capability";
export const VARIABLE_EVENT = "zentui:variable";
export const SEGMENT_CAPABILITY_EVENT = "zentui:working-line-segment-capability";
export const SEGMENT_EVENT = "zentui:working-line-segment";

/** `62%/800k`: usage against the point where compaction happens, not the raw model window. */
export const CONTEXT_KEY = "auto-compact:context";
/** Working-line segment while a run is active. */
export const SEGMENT_KEY = "auto-compact:compaction";

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
}

export interface ContextThresholds {
	warning: number;
	error: number;
}

export const DEFAULT_THRESHOLDS: ContextThresholds = { warning: 70, error: 90 };

/** Zentui's terminal-source defaults for contextNormal / contextWarning / contextError. */
const SGR = {
	normal: "\x1b[90m",
	warning: "\x1b[1;33m",
	error: "\x1b[1;31m",
	reset: "\x1b[0m",
};

/** Zentui's own `formatCount`, so the label reads exactly like its `$context`. */
export function formatCount(value: number): string {
	if (value < 1000) return value.toString();
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

/** Minimalist `percent-total` format and colour tiers, against the compaction point. */
export function contextLabel(
	tokens: number | null,
	limit: number,
	thresholds: ContextThresholds = DEFAULT_THRESHOLDS,
): string {
	if (!(limit > 0)) return "";
	const total = `/${formatCount(limit)}`;
	if (tokens == null || !Number.isFinite(tokens)) return `${SGR.normal}?${total}${SGR.reset}`;
	const percent = Math.round(Math.max(0, Math.min(999, (tokens / limit) * 100)));
	const tone =
		percent >= thresholds.error ? SGR.error : percent >= thresholds.warning ? SGR.warning : SGR.normal;
	return `${tone}${percent}%${total}${SGR.reset}`;
}

/** The Minimalist editor's thresholds from `<agentDir>/zentui.json`, so tiers match `$context`. */
export function readZentuiThresholds(agentDir: string): ContextThresholds {
	try {
		const config = JSON.parse(readFileSync(join(agentDir, "zentui.json"), "utf8"));
		const value = config?.components?.editor?.styles?.minimalist?.contextThresholds;
		const warning = Number(value?.warning);
		const error = Number(value?.error);
		if (Number.isFinite(warning) && Number.isFinite(error) && warning > 0 && error > warning) {
			return { warning, error };
		}
	} catch {
		// No Zentui config: its defaults.
	}
	return DEFAULT_THRESHOLDS;
}

function probe(events: EventBusLike, channel: string, key?: string): boolean {
	const capability: Record<string, unknown> = { supported: false, active: false };
	if (key) capability.key = key;
	try {
		events.emit(channel, capability);
	} catch {
		return false;
	}
	return capability.supported === true && capability.active === true;
}

/**
 * Publishes values to Zentui and remembers what it published, so a value is only re-sent when it
 * changes and is always removed once it no longer applies.
 */
export class ZentuiPublisher {
	private readonly variables = new Map<string, string>();
	private segment: string | undefined;
	private readonly events: EventBusLike;

	constructor(events: EventBusLike) {
		this.events = events;
	}

	/** Publishes or removes a custom value; false when Zentui does not show this key now. */
	variable(key: string, text: string | undefined): boolean {
		if (!text) {
			if (this.variables.delete(key)) this.events.emit(VARIABLE_EVENT, { key, text: undefined });
			return false;
		}
		if (!probe(this.events, VARIABLE_CAPABILITY_EVENT, key)) {
			this.variables.delete(key);
			return false;
		}
		// Zentui drops values on session replacement or loss of demand; re-send unconditionally
		// is cheap and keeps us correct after reactivation.
		this.variables.set(key, text);
		this.events.emit(VARIABLE_EVENT, { key, text });
		return true;
	}

	/** Publishes or removes the Working-line segment; false when the Working line is not Zentui's. */
	workingSegment(text: string | undefined): boolean {
		if (!text) {
			if (this.segment !== undefined) this.events.emit(SEGMENT_EVENT, { key: SEGMENT_KEY, text: undefined });
			this.segment = undefined;
			return false;
		}
		if (!probe(this.events, SEGMENT_CAPABILITY_EVENT)) {
			this.segment = undefined;
			return false;
		}
		this.segment = text;
		this.events.emit(SEGMENT_EVENT, { key: SEGMENT_KEY, text });
		return true;
	}

	clear(): void {
		for (const key of [...this.variables.keys()]) this.variable(key, undefined);
		this.workingSegment(undefined);
	}
}
