import { coordinateReset } from "../../resets.ts";

const [agentDir, mode] = process.argv.slice(2);
let posted = false;
await coordinateReset({
	agentDir, accountKey: "account:synthetic", mode: "auto", validate: async () => {}, checkBeforePost: () => {},
	readUsage: async () => ({ limits: [{ limitId: "codex", secondary: {
		usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 3600,
	} }] }),
	readCredits: async () => ({ availableCount: 1, credits: [{ id: "synthetic-credit" }] }),
	consume: async () => {
		if (mode === "before-post") {
			process.send?.("intent"); // Durable intent exists, but the mock dispatch has not happened.
			await new Promise<void>((resolve) => process.once("message", () => resolve()));
		}
		posted = true;
		process.send?.("posted"); // Mock POST; never contacts any account or network.
		if (mode === "hold") await new Promise<void>((resolve) => process.once("message", () => resolve()));
		return { outcome: "reset" };
	},
	refresh: async () => {},
});
if (!posted) process.send?.("blocked");
process.disconnect?.();
