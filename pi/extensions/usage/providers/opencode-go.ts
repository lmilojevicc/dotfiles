import {
	displayText,
	epochSeconds,
	isRecord,
	numberValue,
	requireProviderAuth,
	ProviderStateError,
	type ProviderAdapter,
	type ProviderSnapshot,
	type UsageWindow,
} from "../core.ts";
import { fetchBoundedJson } from "../network.ts";

const PROVIDER_ID = "opencode-go";
const OFFICIAL_ORIGIN = "https://opencode.ai";
const USAGE_URL = `${OFFICIAL_ORIGIN}/zen/go/v1/usage`;
const WINDOWS = [
	{ key: "rolling", label: "Rolling" },
	{ key: "weekly", label: "Weekly" },
	{ key: "monthly", label: "Monthly" },
] as const;
const PERCENT_FIELDS = ["percent", "used_percent", "usedPercent", "usage_percent"] as const;
const RESET_FIELDS = ["resetsAt", "resets_at", "reset_at", "resetAt"] as const;
const DISPLAYED_STATUSES = new Set(["ok", "rate-limited"]);

function firstValue<T>(raw: Record<string, unknown>, fields: readonly string[], parse: (value: unknown) => T | undefined): T | undefined {
	for (const field of fields) {
		const value = parse(raw[field]);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** Always yields the three plan windows; unknown shapes degrade to `?%` plus a note, never a throw. */
export function parseOpencodeGoPayload(payload: unknown, observedAt = Date.now() / 1000): ProviderSnapshot {
	const root = isRecord(payload) ? (isRecord(payload.usage) ? payload.usage : payload) : {};
	const notes: string[] = [];
	const windows: UsageWindow[] = WINDOWS.map(({ key, label }) => {
		const raw = root[key];
		if (!isRecord(raw)) return { label, note: "not reported" };
		const usedPercent = firstValue(raw, PERCENT_FIELDS, numberValue);
		const resetsAt = firstValue(raw, RESET_FIELDS, epochSeconds);
		const status = displayText(raw.status, 32);
		const note = status && !DISPLAYED_STATUSES.has(status) ? `status: ${status}`
			: status === "rate-limited" ? "rate-limited"
			: usedPercent === undefined ? "unrecognized fields" : undefined;
		return {
			label,
			...(usedPercent !== undefined ? { usedPercent } : {}),
			...(resetsAt !== undefined ? { resetsAt } : {}),
			...(note ? { note } : {}),
		};
	});
	if (windows.every((window) => window.usedPercent === undefined)) notes.push("OpenCode Go returned no recognizable usage percentages.");
	return {
		providerId: PROVIDER_ID,
		title: "OpenCode Go",
		rows: [{ label: "Zen Go plan", windows }],
		...(notes.length ? { notes } : {}),
		observedAt: Math.floor(observedAt),
	};
}

export function isOfficialOrigin(baseUrl: string | undefined): boolean {
	if (baseUrl === undefined) return true;
	try {
		return new URL(baseUrl).origin === OFFICIAL_ORIGIN;
	} catch {
		return false;
	}
}

export const opencodeGoAdapter: ProviderAdapter = {
	id: PROVIDER_ID,
	title: "OpenCode Go",
	async hasCredentials(ctx) {
		return ctx.hasProviderCredentials(PROVIDER_ID);
	},
	async fetch(ctx, signal) {
		const auth = await requireProviderAuth(ctx, PROVIDER_ID);
		// The key is only ever sent to the official origin.
		if (!isOfficialOrigin(auth.baseUrl)) throw new ProviderStateError("setup", "OpenCode Go usage requires the official https://opencode.ai origin.");
		const payload = await fetchBoundedJson(USAGE_URL, {
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${auth.apiKey}` },
			signal,
		}, { fetch: ctx.fetch, label: "OpenCode Go" });
		return parseOpencodeGoPayload(payload);
	},
};
