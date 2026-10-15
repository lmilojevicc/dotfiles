/** Host facts are ANDed per package; unlisted packages always load. */
export const KNOWN_CONDITIONS = ["bb", "pi", "tui", "headless"] as const;
export type Condition = (typeof KNOWN_CONDITIONS)[number];

export type HostEnv = Readonly<Record<string, string | undefined>>;

export function isKnownCondition(value: string): value is Condition {
	return (KNOWN_CONDITIONS as readonly string[]).includes(value);
}

/** BB origin is any nonblank BB_THREAD_ID, the same rule pi-subagents-host-gate used. */
export function hostConditions(env: HostEnv, isTTY: boolean): ReadonlySet<Condition> {
	const bbThreadId = env.BB_THREAD_ID;
	const bb = typeof bbThreadId === "string" && bbThreadId.trim().length > 0;
	return new Set<Condition>([bb ? "bb" : "pi", isTTY ? "tui" : "headless"]);
}

export type GateDecision = Readonly<{ load: boolean; unknown?: string }>;

/** Every listed condition must hold. Unknown conditions never load (fail-closed for that entry). */
export function decide(required: readonly string[] | undefined, conditions: ReadonlySet<Condition>): GateDecision {
	if (required === undefined || required.length === 0) return { load: true };
	for (const condition of required) {
		if (!isKnownCondition(condition)) return { load: false, unknown: condition };
		if (!conditions.has(condition)) return { load: false };
	}
	return { load: true };
}
