import assert from "node:assert/strict";
import test from "node:test";
import { registerForHost } from "../runtime.ts";

const pi = Object.freeze({ registerTool() { throw new Error("unexpected registration"); } }) as any;
for (const marker of [undefined, "", " \t\r\n", "\u00a0"]) {
	test(`absent/blank BB marker ${JSON.stringify(marker)} invokes upstream exactly once with same API`, async () => {
		let loads = 0;
		let calls = 0;
		const env = Object.freeze({ BB_THREAD_ID: marker, PI_AGENT_POLICY_BB_PROFILE: "workflow-worker:v1" });
		const result = await registerForHost(pi, env, async () => {
			loads++;
			return async (api: any) => { assert.equal(api, pi); calls++; await Promise.resolve(); return "native return"; };
		});
		assert.equal(result, "native return");
		assert.equal(loads, 1);
		assert.equal(calls, 1);
	});
}
for (const marker of ["bb-thread", " bb-thread ", "0", "unfamiliar/ID!?", "\u0000"]) {
	for (const profile of ["workflow-worker:v1", "none:v1"]) {
		test(`BB ${JSON.stringify(marker)} / ${profile} skips before resolution/import/registration`, async () => {
			const env = Object.freeze({ BB_THREAD_ID: marker, PI_AGENT_POLICY_BB_PROFILE: profile });
			assert.equal(await registerForHost(pi, env, async () => { throw new Error("upstream broken/missing: must never resolve or import"); }), undefined);
		});
	}
}

test("ordinary routing is snapshotted before resolution awaits and async registration is awaited", async () => {
	const env: Record<string, string | undefined> = {};
	let releaseLoad!: () => void;
	let releaseFactory!: () => void;
	let called = false;
	let settled = false;
	const loaded = new Promise<void>((resolve) => { releaseLoad = resolve; });
	const initialized = new Promise<void>((resolve) => { releaseFactory = resolve; });
	const result = registerForHost(pi, env, async () => {
		await loaded;
		return async (api: any) => { assert.equal(api, pi); called = true; await initialized; return 42; };
	});
	result.then(() => { settled = true; });
	env.BB_THREAD_ID = "new-BB-host";
	releaseLoad();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(called, true);
	assert.equal(settled, false);
	releaseFactory();
	assert.equal(await result, 42);
	assert.equal(env.BB_THREAD_ID, "new-BB-host", "gate never changes env");
});

for (const stage of ["load", "factory"]) {
	for (const message of ["missing public peer", "module import failed", "pi-subagents version changed: Restart Pi", "native registration failed"]) {
		test(`${stage} error is preserved: ${message}`, async () => {
			const error = new Error(message);
			await assert.rejects(registerForHost(pi, Object.freeze({}), async () => {
				if (stage === "load") throw error;
				return async () => { throw error; };
			}), (actual) => actual === error);
		});
	}
}
for (const value of [undefined, null, {}, "not a factory"]) {
	test(`nonfactory public default ${JSON.stringify(value)} is explicit`, async () => {
		await assert.rejects(registerForHost(pi, Object.freeze({}), async () => value), /pi-subagents-host-gate:.*not a factory/);
	});
}

test("new runtime re-evaluates routing, no shared host cache or env mutation", async () => {
	let calls = 0;
	const load = async () => () => { calls++; };
	const env: Record<string, string | undefined> = { BB_THREAD_ID: "BB" };
	const snapshot = { ...env };
	await registerForHost(pi, env, load);
	assert.deepEqual(env, snapshot);
	delete env.BB_THREAD_ID;
	await registerForHost(pi, env, load);
	env.BB_THREAD_ID = "BB";
	await registerForHost(pi, env, load);
	assert.equal(calls, 1);
});
