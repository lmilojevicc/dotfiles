import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type UpstreamFactory = (pi: ExtensionAPI) => unknown | Promise<unknown>;

/** Host routing only: any nonblank BB ID, including unfamiliar formats, is BB-origin. */
export async function registerForHost(
	pi: ExtensionAPI,
	env: Readonly<Record<string, string | undefined>>,
	loadFactory: () => Promise<unknown>,
): Promise<unknown> {
	// Capture before any await. Policy profiles do not determine the host.
	const bbThreadId = env.BB_THREAD_ID;
	if (bbThreadId !== undefined && bbThreadId.trim().length > 0) return;
	const factory = await loadFactory();
	if (typeof factory !== "function") {
		throw new Error("pi-subagents-host-gate: pi-subagents public default export is not a factory");
	}
	return await (factory as UpstreamFactory)(pi);
}
