import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startShellInBackground } from "../shell-launch.ts";

describe("new interactive shells start in the background", () => {
	it("turns an interactive launch (the default mode) into a background dispatch that stays open", () => {
		const input: Record<string, unknown> = { command: "ssh host", reason: "Enter the password" };
		assert.equal(startShellInBackground(input), true);
		assert.deepEqual(input, {
			command: "ssh host",
			reason: "Enter the password",
			mode: "dispatch",
			background: true,
			handsFree: { autoExitOnQuiet: false },
		});
	});

	it("keeps the agent's own hands-free options and its explicit quiet setting", () => {
		const input: Record<string, unknown> = {
			command: "npm run dev",
			mode: "hands-free",
			handsFree: { quietThreshold: 3000, autoExitOnQuiet: true },
		};
		assert.equal(startShellInBackground(input), true);
		assert.equal(input.mode, "dispatch");
		assert.equal(input.background, true);
		assert.deepEqual(input.handsFree, { quietThreshold: 3000, autoExitOnQuiet: true });
	});

	it("moves a foreground dispatch to the background with dispatch's own quiet default", () => {
		const input: Record<string, unknown> = { command: "npm test", mode: "dispatch" };
		assert.equal(startShellInBackground(input), true);
		assert.deepEqual(input, { command: "npm test", mode: "dispatch", background: true });
	});

	it("starts a spawned agent in the background too", () => {
		const input: Record<string, unknown> = { spawn: { agent: "pi" } };
		assert.equal(startShellInBackground(input), true);
		assert.equal(input.background, true);
	});

	it("leaves background launches, monitors, and calls on existing sessions alone", () => {
		const calls: Array<Record<string, unknown>> = [
			{ command: "make", mode: "dispatch", background: true },
			{ command: "tail -f log", mode: "monitor", monitor: { strategy: "stream" } },
			{ sessionId: "abc", input: "y\n" },
			{ sessionId: "abc", kill: true },
			{ attach: "abc" },
			{ listBackground: true },
			{ dismissBackground: "abc" },
			{ sessionId: "abc", command: "ignored" },
		];
		for (const call of calls) {
			const before = structuredClone(call);
			assert.equal(startShellInBackground(call), false, JSON.stringify(before));
			assert.deepEqual(call, before);
		}
		assert.equal(startShellInBackground(undefined), false);
		assert.equal(startShellInBackground("command"), false);
	});
});
