import { readFileSync } from "node:fs";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const CHADINEER_STATE_ENTRY = "dotfiles.chadineer";
export const CHADINEER_STATUS_KEY = "chadineer";
export const CHADINEER_USAGE = "Usage: /chadineer [on|off|status]";

export const CHADINEER_PROMPT = readFileSync(
	new URL("./PROMPT.md", import.meta.url),
	"utf8",
).trim();

type ChadineerState = {
	enabled: boolean;
};

export type ChadineerCommand =
	| { kind: "toggle" }
	| { kind: "set"; enabled: boolean }
	| { kind: "status" }
	| { kind: "invalid" };

export function parseChadineerCommand(args: string): ChadineerCommand {
	const value = args.trim().toLowerCase();
	if (value === "") return { kind: "toggle" };
	if (value === "on") return { kind: "set", enabled: true };
	if (value === "off") return { kind: "set", enabled: false };
	if (value === "status") return { kind: "status" };
	return { kind: "invalid" };
}

function parseStoredState(data: unknown): boolean | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const enabled = (data as Partial<ChadineerState>).enabled;
	return typeof enabled === "boolean" ? enabled : undefined;
}

export function restoreChadineerState(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== CHADINEER_STATE_ENTRY) continue;
		const enabled = parseStoredState(entry.data);
		if (enabled !== undefined) return enabled;
	}
	return false;
}

export default function chadineerExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function render(ctx: ExtensionContext): void {
		ctx.ui.setStatus(CHADINEER_STATUS_KEY, enabled ? "chadineer" : undefined);
	}

	function describe(prefix = "Chadineer is"): string {
		return `${prefix} ${enabled ? "on" : "off"}`;
	}

	function restore(ctx: ExtensionContext): void {
		enabled = restoreChadineerState(ctx.sessionManager.getBranch());
		render(ctx);
	}

	function transition(next: boolean, ctx: ExtensionContext): void {
		if (next === enabled) {
			ctx.ui.notify(describe("Chadineer is already"), "info");
			return;
		}
		enabled = next;
		pi.appendEntry<ChadineerState>(CHADINEER_STATE_ENTRY, { enabled });
		render(ctx);
		ctx.ui.notify(describe(), "info");
	}

	pi.registerCommand("chadineer", {
		description: "Toggle concise development guidelines",
		handler: (args, ctx) => {
			const command = parseChadineerCommand(args);
			switch (command.kind) {
				case "toggle":
					transition(!enabled, ctx);
					return;
				case "set":
					transition(command.enabled, ctx);
					return;
				case "status":
					ctx.ui.notify(describe(), "info");
					return;
				case "invalid":
					ctx.ui.notify(CHADINEER_USAGE, "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", (event) => {
		if (!enabled) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${CHADINEER_PROMPT}` };
	});
}
