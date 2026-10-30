import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanOutput, formatDuration, parseJobControl, signalName } from "../control.ts";

test("job control is recognised only as the whole command", () => {
	assert.deepEqual(parseJobControl("jobs"), { kind: "jobs" });
	assert.deepEqual(parseJobControl("  jobs -l "), { kind: "jobs" });
	assert.deepEqual(parseJobControl("wait"), { kind: "wait", ids: "all" });
	assert.deepEqual(parseJobControl("wait %2 %10;"), { kind: "wait", ids: [2, 10] });
	assert.deepEqual(parseJobControl("kill %1"), { kind: "kill", signal: "SIGTERM", ids: [1] });
	assert.deepEqual(parseJobControl("kill -9 %1"), { kind: "kill", signal: "SIGKILL", ids: [1] });
	assert.deepEqual(parseJobControl("kill -KILL %1 %3"), { kind: "kill", signal: "SIGKILL", ids: [1, 3] });
	assert.deepEqual(parseJobControl("kill -s INT -- %4"), { kind: "kill", signal: "SIGINT", ids: [4] });
	assert.deepEqual(parseJobControl("kill -SIGHUP %2"), { kind: "kill", signal: "SIGHUP", ids: [2] });
	for (const command of [
		"wait 1234",
		"wait %1 && echo done",
		"kill 1234",
		"kill -- -1234",
		"kill %1; npm run dev",
		"jobs | cat",
		"kill -BOGUS %1",
		"kill",
		"kill -9",
		"sleep 1 & wait",
		"echo jobs",
		"wait\n%1",
	]) {
		assert.equal(parseJobControl(command), undefined, command);
	}
});

test("signal names accept numbers, bare names and SIG names", () => {
	assert.equal(signalName("9"), "SIGKILL");
	assert.equal(signalName("term"), "SIGTERM");
	assert.equal(signalName("SIGINT"), "SIGINT");
	assert.equal(signalName("NOPE"), undefined);
});

test("output is cleaned the way a terminal would show it", () => {
	const raw = "\x1b[32mready\x1b[0m on :3000\r\nprogress 10%\rprogress 50%\rprogress 100%\n\x1b]0;title\x07done\n\n";
	assert.equal(cleanOutput(raw), "ready on :3000\nprogress 100%\ndone");
	assert.equal(cleanOutput(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"), 3), "line 47\nline 48\nline 49");
});

test("durations read naturally", () => {
	assert.equal(formatDuration(400), "0s");
	assert.equal(formatDuration(59_400), "59s");
	assert.equal(formatDuration(61_000), "1m 1s");
	assert.equal(formatDuration(3_660_000), "1h 1m");
});
