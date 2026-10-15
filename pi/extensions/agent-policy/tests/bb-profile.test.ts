import assert from "node:assert/strict";
import test from "node:test";
import { parseBBPolicySignal, isBBOriginSession } from "../bb-profile.ts";
import { CHILD_PREFIXES, selectProfile } from "../child-profile.ts";

const tuple = { PI_AGENT_POLICY_BB_PROFILE: "workflow-worker:v1", BB_THREAD_ID: "thread-123", PI_AGENT_POLICY_BB_THREAD_ID: "thread-123" };

test("BB parser accepts only the versioned own tuple and leaves env untouched", () => {
	const env = Object.freeze({ ...tuple });
	assert.deepEqual(parseBBPolicySignal(env), { workflowWorker: true });
	assert.deepEqual(env, tuple);
	assert.deepEqual(parseBBPolicySignal({ ...tuple, PI_AGENT_POLICY_BB_PROFILE: "none:v1" }), { workflowWorker: false });
	assert.deepEqual(parseBBPolicySignal({}), { workflowWorker: false });
	assert.deepEqual(parseBBPolicySignal({ BB_THREAD_ID: "thread-123" }), { workflowWorker: false });
	assert.deepEqual(parseBBPolicySignal({ PI_AGENT_POLICY_BB_THREAD_ID: "stale" }), { workflowWorker: false });
	const longest = "x".repeat(256);
	assert.equal(parseBBPolicySignal({ ...tuple, BB_THREAD_ID: longest, PI_AGENT_POLICY_BB_THREAD_ID: longest }).workflowWorker, true);
});

test("BB parser rejects unknown profiles and malformed or mismatched identities with redacted diagnostics", () => {
	for (const profile of ["", "workflow-worker", "workflow-worker:v2", "none", "NONE:v1", " workflow-worker:v1", "secret\nprofile"]) {
		const result = parseBBPolicySignal({ ...tuple, PI_AGENT_POLICY_BB_PROFILE: profile });
		assert.equal(result.workflowWorker, false);
		assert.match(result.diagnostic!, /invalid BB policy profile/);
		assert.ok(!result.diagnostic!.includes("secret"));
	}
	for (const profile of ["workflow-worker:v1", "none:v1"]) {
		for (const id of [undefined, "", " ", " thread-123", "thread-123 ", "x".repeat(257), "secret\nidentity", "x\x00", "x\x1f", "x\x7f", "x\x85", "x\x9f"]) {
			for (const key of ["BB_THREAD_ID", "PI_AGENT_POLICY_BB_THREAD_ID"]) {
				const result = parseBBPolicySignal({ ...tuple, PI_AGENT_POLICY_BB_PROFILE: profile, [key]: id });
				assert.equal(result.workflowWorker, false);
				assert.match(result.diagnostic!, /invalid or mismatched BB policy identity/);
				assert.ok(!result.diagnostic!.includes("secret"));
			}
		}
		const result = parseBBPolicySignal({ ...tuple, PI_AGENT_POLICY_BB_PROFILE: profile, PI_AGENT_POLICY_BB_THREAD_ID: "other-secret" });
		assert.equal(result.workflowWorker, false);
		assert.match(result.diagnostic!, /mismatched/);
		assert.ok(!result.diagnostic!.includes("other-secret"));
	}
});

test("BB host-origin detection is any nonblank BB_THREAD_ID and ignores the worker tuple", () => {
	const env = Object.freeze({ ...tuple });
	assert.equal(isBBOriginSession(env), true);
	assert.deepEqual(env, tuple);
	for (const value of [undefined, "", " ", "\t\n"]) assert.equal(isBBOriginSession({ BB_THREAD_ID: value }), false, JSON.stringify(value));
	// Unfamiliar but nonblank IDs still count: host routing, not validation or a security boundary.
	for (const value of ["thr_abc123", " bb ".trim(), "x".repeat(512), "thr_\u00e9"]) assert.equal(isBBOriginSession({ BB_THREAD_ID: value }), true, JSON.stringify(value));
	assert.equal(isBBOriginSession({ PI_AGENT_POLICY_BB_PROFILE: "none:v1" }), false, "the companion tuple alone is not BB origin");
	assert.equal(isBBOriginSession({ PI_AGENT_POLICY_BB_THREAD_ID: "thread-123" }), false, "the companion thread copy alone is not BB origin");
});

test("optional BB profile input preserves native callers and cannot demote native classification", () => {
	for (const env of [{}, { BB_THREAD_ID: "thread-123" }, tuple, { ...tuple, PI_AGENT_POLICY_BB_PROFILE: "none:v1" }, { ...tuple, PI_AGENT_POLICY_BB_PROFILE: "unknown" }, { ...tuple, PI_AGENT_POLICY_BB_THREAD_ID: "other" }]) {
		const bbWorker = parseBBPolicySignal(env).workflowWorker;
		assert.equal(selectProfile("root", false, bbWorker), bbWorker ? "subagent" : "main");
		assert.equal(selectProfile("root", true, bbWorker), "subagent");
		for (const prefix of CHILD_PREFIXES) assert.equal(selectProfile(`\n${prefix}`, false, bbWorker), "subagent");
	}
	assert.equal(selectProfile("root", false), "main");
	assert.equal(selectProfile(`quoted later: ${CHILD_PREFIXES[0]}`, false), "main");
});
