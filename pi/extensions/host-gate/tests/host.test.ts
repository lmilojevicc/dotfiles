import assert from "node:assert/strict";
import test from "node:test";
import { decide, hostConditions, isKnownCondition, KNOWN_CONDITIONS } from "../host.ts";

test("host facts: BB origin is any nonblank BB_THREAD_ID and TTY is its own axis", () => {
	for (const id of [undefined, "", " ", "\t\r\n"]) {
		assert.deepEqual([...hostConditions({ BB_THREAD_ID: id }, false)].sort(), ["headless", "pi"], JSON.stringify(id));
		assert.deepEqual([...hostConditions({ BB_THREAD_ID: id }, true)].sort(), ["pi", "tui"], JSON.stringify(id));
	}
	for (const id of ["bb-thread", " bb-thread ", "0", "thr_abc123!", "\u0000"]) {
		assert.deepEqual([...hostConditions({ BB_THREAD_ID: id }, false)].sort(), ["bb", "headless"], JSON.stringify(id));
		assert.deepEqual([...hostConditions({ BB_THREAD_ID: id }, true)].sort(), ["bb", "tui"], JSON.stringify(id));
	}
	assert.deepEqual([...hostConditions({}, false)].sort(), ["headless", "pi"]);
	assert.equal(isKnownCondition("pi"), true);
	assert.equal(isKnownCondition("tui"), true);
	assert.equal(isKnownCondition("PI"), false);
});

test("unlisted packages always load; listed conditions are ANDed", () => {
	const ordinaryTTY = hostConditions({}, true);
	const bbHeadless = hostConditions({ BB_THREAD_ID: "t" }, false);
	for (const required of [undefined, []]) assert.equal(decide(required, bbHeadless).load, true);
	assert.equal(decide(["pi"], ordinaryTTY).load, true);
	assert.equal(decide(["pi"], bbHeadless).load, false);
	assert.equal(decide(["tui"], ordinaryTTY).load, true);
	assert.equal(decide(["tui"], bbHeadless).load, false);
	assert.equal(decide(["pi", "tui"], ordinaryTTY).load, true);
	assert.equal(decide(["pi", "tui"], hostConditions({}, false)).load, false);
	assert.equal(decide(["bb", "tui"], hostConditions({ BB_THREAD_ID: "t" }, true)).load, true);
	assert.equal(decide(["headless"], bbHeadless).load, true);
});

test("unknown conditions never load and are reported for a warning", () => {
	const decision = decide(["pi", "Pin"], hostConditions({}, true));
	assert.equal(decision.load, false);
	assert.equal(decision.unknown, "Pin");
	assert.deepEqual(KNOWN_CONDITIONS, ["bb", "pi", "tui", "headless"]);
});
