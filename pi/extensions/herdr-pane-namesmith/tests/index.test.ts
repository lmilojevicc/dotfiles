import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrPaneNamesmith, type NamesmithDependencies } from "../index.ts";

const validEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/own/socket", HERDR_PANE_ID: "own-pane" };
// One event-loop checkpoint lets the finite promise drain settle; no timer or polling.
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(env: NodeJS.ProcessEnv = { ...validEnv }, rename?: NamesmithDependencies["rename"]) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => void | Promise<void>>();
	let name: string | undefined;
	let nameReads = 0;
	const calls: { pane: string; socket: string; name: string | undefined; resolve: () => void; reject: (error: Error) => void }[] = [];
	const warnings: { message: string; level: string }[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: {
		notify: (message: string, level: string) => warnings.push({ message, level }),
	} } as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: any) => { handlers.set(event, handler); return () => {}; },
		getSessionName: () => { nameReads++; return name; },
	} as unknown as ExtensionAPI;
	createHerdrPaneNamesmith(pi, { env, rename: rename ?? ((pane, socket, nextName) => new Promise<void>((resolve, reject) => {
		calls.push({ pane, socket, name: nextName, resolve, reject });
	})) });
	const shutdown = (reason = "quit") => handlers.get("session_shutdown")!({ type: "session_shutdown", reason }, ctx);
	return {
		calls, warnings, ctx, env, nameReads: () => nameReads,
		start: (nextName: string | undefined, reason = "startup", context = ctx) => {
			name = nextName;
			return handlers.get("session_start")!({ type: "session_start", reason }, context);
		},
		change: (nextName: string | undefined, context = ctx) => handlers.get("session_info_changed")!({ type: "session_info_changed", name: nextName }, context),
		shutdown,
		// Existing naming tests explicitly acknowledge the additional normal-quit clear.
		settleQuit: async () => {
			const count = calls.length;
			const stopping = shutdown();
			await checkpoint();
			if (calls.length > count) {
				assert.equal(calls.length, count + 1);
				assert.equal(calls[count].name, undefined, "normal quit clears the label");
				calls[count].resolve();
			}
			await stopping;
		},
	};
}

test("factory only registers handlers; manual /name and automatic naming share metadata events", async () => {
	const h = harness();
	assert.equal(h.calls.length, 0);
	assert.equal(h.nameReads(), 0);
	h.change("Manual name");
	assert.equal(h.calls[0].name, "Manual name");
	h.calls[0].resolve();
	await checkpoint();
	h.change("Automatic title");
	assert.equal(h.calls[1].name, "Automatic title");
	assert.equal(h.nameReads(), 0, "metadata handler uses the normalized event name");
	h.calls[1].resolve();
	await h.settleQuit();
});

for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
	for (const name of ["Saved name", undefined]) {
		test(`session_start ${reason} reads ${name ?? "unnamed session"}`, async () => {
			const h = harness();
			h.start(name, reason);
			assert.equal(h.nameReads(), 1);
			assert.equal(h.calls[0].name, name);
			h.calls[0].resolve();
			await h.settleQuit();
		});
	}
}

for (const name of [undefined, ""]) {
	test(`cleared metadata name ${JSON.stringify(name)} queues a clear`, async () => {
		const h = harness();
		h.change(name);
		assert.equal(h.calls[0].name, undefined);
		h.calls[0].resolve();
		await h.settleQuit();
	});
}

for (const mode of ["rpc", "json", "print", undefined, "unknown"]) {
	for (const hasUI of [false, true]) {
		test(`inherited Herdr environment never renames for mode=${mode}, hasUI=${hasUI}`, async () => {
			const h = harness();
			const ctx = { ...h.ctx, mode, hasUI } as ExtensionContext;
			h.start("child", "startup", ctx);
			h.change("child", ctx);
			assert.equal(h.calls.length, 0);
			assert.equal(h.warnings.length, 0);
			await h.shutdown();
			assert.equal(h.calls.length, 0);
		});
	}
}

for (const [key, value] of [
	["HERDR_ENV", undefined], ["HERDR_ENV", ""], ["HERDR_ENV", "true"], ["HERDR_ENV", "0"],
	["HERDR_SOCKET_PATH", undefined], ["HERDR_SOCKET_PATH", ""],
	["HERDR_PANE_ID", undefined], ["HERDR_PANE_ID", ""],
] as const) {
	test(`guard rejects ${key}=${value}`, async () => {
		const h = harness({ ...validEnv, [key]: value });
		h.start("name");
		h.change("name");
		assert.equal(h.calls.length, 0);
		await h.shutdown();
		assert.equal(h.calls.length, 0);
	});
}

test("uses only own env pane and socket, snapshots identity, deduplicates only same target", async () => {
	const h = harness({ ...validEnv, HERDR_FOCUSED_PANE_ID: "wrong-pane" });
	h.change("name");
	assert.deepEqual([h.calls[0].pane, h.calls[0].socket], ["own-pane", "/own/socket"]);
	h.env.HERDR_PANE_ID = "other-own-pane";
	h.env.HERDR_SOCKET_PATH = "/other/socket";
	h.change("name");
	h.calls[0].resolve();
	await checkpoint();
	assert.deepEqual([h.calls[1].pane, h.calls[1].socket], ["other-own-pane", "/other/socket"]);
	h.calls[1].resolve();
	await h.settleQuit();
});

test("serializes requests and coalesces pending names to the latest, including clear", async () => {
	const h = harness();
	h.change("A");
	h.change("B");
	h.change("C");
	assert.equal(h.calls.length, 1);
	h.calls[0].resolve();
	await checkpoint();
	assert.deepEqual(h.calls.map((call) => call.name), ["A", "C"]);
	h.change("D");
	h.change(undefined);
	h.calls[1].resolve();
	await checkpoint();
	assert.deepEqual(h.calls.map((call) => call.name), ["A", "C", undefined]);
	h.calls[2].resolve();
	await h.settleQuit();
});

test("deduplicates only within a burst and reasserts idle names and clears", async () => {
	const h = harness();
	h.change("A");
	h.change("A");
	h.calls[0].resolve();
	await checkpoint();
	assert.equal(h.calls.length, 1, "in-flight duplicates share the successful write");
	h.change("A");
	assert.equal(h.calls.length, 2, "an idle /name A reasserts A");
	h.calls[1].resolve();
	await checkpoint();
	h.start("A", "resume");
	assert.equal(h.calls.length, 3, "a later session event also reasserts A");
	h.calls[2].resolve();
	await checkpoint();
	h.change(undefined);
	h.change("");
	h.calls[3].resolve();
	await checkpoint();
	assert.equal(h.calls.length, 4, "in-flight duplicate clears share the successful write");
	h.change("");
	assert.equal(h.calls.length, 5, "an idle clear reasserts the unnamed state");
	h.calls[4].resolve();
	await h.settleQuit();
});

test("repeating /name A restores A after a manual Herdr rename to B", async () => {
	let paneLabel: string | undefined;
	const h = harness({ ...validEnv }, async (_pane, _socket, name) => { paneLabel = name; });
	h.change("A");
	await checkpoint();
	assert.equal(paneLabel, "A");
	paneLabel = "B";
	h.change("A");
	await checkpoint();
	assert.equal(paneLabel, "A");
	await h.settleQuit();
});

test("new metadata event in drain-completion continuation is not lost", async () => {
	const h = harness();
	h.change("A");
	h.calls[0].resolve();
	await Promise.resolve();
	h.change("B");
	await checkpoint();
	assert.deepEqual(h.calls.map((call) => call.name), ["A", "B"]);
	h.calls[1].resolve();
	await h.settleQuit();
});

test("failures retry on future events, bound warnings until success, and invalidate previous dedup", async () => {
	const h = harness();
	h.change("A");
	h.calls[0].resolve();
	await checkpoint();
	h.change("B");
	h.calls[1].reject(new Error("secret server detail"));
	await checkpoint();
	assert.equal(h.calls.length, 2, "no autonomous retry");
	assert.equal(h.warnings.length, 1);
	assert.equal(h.warnings[0].level, "warning");
	assert.ok(h.warnings[0].message.length < 120);
	assert.ok(!h.warnings[0].message.includes("secret"));
	h.change("B");
	h.calls[2].reject(new Error("still broken"));
	await checkpoint();
	assert.equal(h.warnings.length, 1);
	h.start("A", "resume");
	assert.equal(h.calls[3].name, "A", "failed request could have changed the previously successful label");
	h.calls[3].resolve();
	await checkpoint();
	h.change("B");
	h.calls[4].reject(new Error("new failure streak"));
	await checkpoint();
	assert.equal(h.warnings.length, 2);
	await h.settleQuit();
});

test("synchronous transport throws and notification throws stay nonfatal and retryable", async () => {
	let attempts = 0;
	const h = harness({ ...validEnv }, () => { attempts++; throw new Error("sync"); });
	h.ctx.ui.notify = () => { throw new Error("UI failed"); };
	h.change("A");
	await checkpoint();
	h.change("A");
	await checkpoint();
	assert.equal(attempts, 2);
	await h.settleQuit();
});

for (const reason of ["reload", "new", "resume", "fork"]) {
	test(`shutdown ${reason} drops pending writes, waits for in-flight settlement, and ignores stale contexts`, async () => {
		const h = harness();
		h.change("old in-flight");
		h.change("old pending");
		let stopped = false;
		const shutdown = Promise.resolve(h.shutdown(reason)).then(() => { stopped = true; });
		await Promise.resolve();
		assert.equal(stopped, false);
		h.change("stale name");
		h.start("stale start", reason);
		h.calls[0].reject(new Error("finishing during shutdown"));
		await shutdown;
		assert.equal(h.calls.length, 1);
		assert.equal(h.warnings.length, 0);
		await h.shutdown(reason);
		await h.shutdown("quit");
		assert.equal(h.calls.length, 1, "a closed replacement runtime never exit-clears");
		const fresh = harness();
		fresh.start(reason === "new" ? undefined : "fresh name", reason);
		assert.equal(fresh.calls.length, 1, "replacement factory has no stale dedup or closed state");
		fresh.calls[0].resolve();
		await fresh.settleQuit();
	});
}

test("TUI mode does not depend on the RPC-compatible hasUI flag", async () => {
	const h = harness();
	h.change("TUI name", { ...h.ctx, hasUI: false });
	assert.equal(h.calls.length, 1);
	h.calls[0].resolve();
	await h.settleQuit();
});

test("successful in-flight rename settles shutdown without sending the discarded pending name", async () => {
	const h = harness();
	h.change("in-flight");
	h.change("pending");
	const shutdown = h.shutdown("reload");
	h.calls[0].resolve();
	await shutdown;
	assert.equal(h.calls.length, 1);
	assert.equal(h.warnings.length, 0);
});

test("normal quit clears an idle named session and awaits the clear", async () => {
	const h = harness();
	h.start("Saved name");
	h.calls[0].resolve();
	await checkpoint();
	let stopped = false;
	const shutdown = Promise.resolve(h.shutdown()).then(() => { stopped = true; });
	await checkpoint();
	assert.deepEqual(h.calls.map(({ pane, socket, name }) => ({ pane, socket, name })), [
		{ pane: "own-pane", socket: "/own/socket", name: "Saved name" },
		{ pane: "own-pane", socket: "/own/socket", name: undefined },
	]);
	assert.equal(stopped, false, "Pi must wait for cleanup settlement");
	h.calls[1].resolve();
	await shutdown;
	assert.equal(stopped, true);
});

for (const fails of [false, true]) {
	test(`quit serializes clear after ${fails ? "failed" : "successful"} in-flight rename and drops pending updates`, async () => {
		const h = harness();
		h.change("in-flight");
		h.change("pending");
		const shutdown = h.shutdown();
		h.change("stale metadata");
		h.start("stale session");
		await checkpoint();
		assert.equal(h.calls.length, 1, "clear cannot overtake the in-flight request");
		if (fails) h.calls[0].reject(new Error("failed initial write"));
		else h.calls[0].resolve();
		await checkpoint();
		assert.deepEqual(h.calls.map((call) => call.name), ["in-flight", undefined]);
		h.calls[1].resolve();
		await shutdown;
		assert.equal(h.warnings.length, 0);
	});
}

test("repeated and concurrent quit handlers share one awaited cleanup", async () => {
	const h = harness();
	h.change("name");
	const first = h.shutdown();
	const second = h.shutdown();
	assert.equal(first, second);
	h.calls[0].resolve();
	await checkpoint();
	const third = h.shutdown();
	assert.equal(first, third);
	assert.equal(h.calls.length, 2);
	h.calls[1].resolve();
	await Promise.all([first, second, third]);
	await h.shutdown();
	assert.equal(h.calls.length, 2);
});

test("a failed idle initial write still records the pane for quit cleanup", async () => {
	const h = harness();
	h.change("name");
	h.calls[0].reject(new Error("response lost after write"));
	await checkpoint();
	assert.equal(h.warnings.length, 1);
	const shutdown = h.shutdown();
	await checkpoint();
	assert.deepEqual([h.calls[1].pane, h.calls[1].socket, h.calls[1].name], ["own-pane", "/own/socket", undefined]);
	h.calls[1].resolve();
	await shutdown;
	assert.equal(h.warnings.length, 1);
});

test("a rejected quit clear stays nonfatal without warnings or retries", async () => {
	const h = harness();
	h.change("name");
	h.calls[0].resolve();
	await checkpoint();
	const shutdown = h.shutdown();
	await checkpoint();
	h.calls[1].reject(new Error("socket unavailable"));
	await shutdown;
	await h.shutdown();
	assert.equal(h.calls.length, 2);
	assert.equal(h.warnings.length, 0);
});

test("synchronous initial and cleanup throws remain nonfatal and cleanup is attempted once", async () => {
	const names: (string | undefined)[] = [];
	const h = harness({ ...validEnv }, (_pane, _socket, name) => {
		names.push(name);
		throw new Error("socket failed synchronously");
	});
	h.change("name");
	await checkpoint();
	await Promise.all([h.shutdown(), h.shutdown()]);
	await h.shutdown();
	assert.deepEqual(names, ["name", undefined]);
	assert.equal(h.warnings.length, 1, "cleanup never warns through the stopped TUI");
});

for (const pending of [false, true]) {
	test(`quit retains attempted own identity despite env change${pending ? " and a pending new target" : ""}`, async () => {
		const h = harness({ ...validEnv, HERDR_FOCUSED_PANE_ID: "focused-pane" });
		h.change("name");
		if (!pending) {
			h.calls[0].resolve();
			await checkpoint();
		}
		h.env.HERDR_PANE_ID = "changed-pane";
		h.env.HERDR_SOCKET_PATH = "/changed/socket";
		h.env.HERDR_ENV = "0";
		if (pending) {
			h.env.HERDR_ENV = "1";
			h.change("pending new target");
		}
		const shutdown = h.shutdown();
		if (pending) h.calls[0].resolve();
		await checkpoint();
		assert.deepEqual([h.calls[1].pane, h.calls[1].socket, h.calls[1].name], ["own-pane", "/own/socket", undefined]);
		h.calls[1].resolve();
		await shutdown;
		assert.equal(h.calls.length, 2);
	});
}

test("quit clears the last actually attempted target, not an earlier target", async () => {
	const h = harness();
	h.change("first");
	h.env.HERDR_PANE_ID = "second-pane";
	h.env.HERDR_SOCKET_PATH = "/second/socket";
	h.change("second");
	h.calls[0].resolve();
	await checkpoint();
	h.calls[1].resolve();
	await checkpoint();
	const shutdown = h.shutdown();
	await checkpoint();
	assert.deepEqual([h.calls[2].pane, h.calls[2].socket, h.calls[2].name], ["second-pane", "/second/socket", undefined]);
	h.calls[2].resolve();
	await shutdown;
});

test("a never-active runtime with valid inherited environment does not clear", async () => {
	const h = harness();
	await Promise.all([h.shutdown(), h.shutdown()]);
	h.start("too late");
	h.change("too late");
	await h.shutdown();
	assert.equal(h.calls.length, 0);
});
