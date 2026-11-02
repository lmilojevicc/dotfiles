import assert from "node:assert/strict";
import { test } from "node:test";
import { parseControl, taskId } from "../control.ts";

test("tasks commands parse, with a leading cd and the usual id spellings", () => {
	assert.deepEqual(parseControl("tasks"), { verb: "list" });
	assert.deepEqual(parseControl("  tasks ls "), { verb: "list" });
	assert.deepEqual(parseControl("tasks output 3"), { verb: "output", id: "3" });
	assert.deepEqual(parseControl("tasks %3"), { verb: "output", id: "%3" });
	assert.deepEqual(parseControl("cd /repo && tasks kill 2"), { verb: "stop", id: "2" });
	assert.deepEqual(parseControl("tasks wait 2"), { verb: "wait", id: "2", timeout: 30 });
	assert.deepEqual(parseControl("tasks wait 2 --timeout 90"), { verb: "wait", id: "2", timeout: 90 });
	assert.deepEqual(parseControl("tasks wait -t=5000 2"), { verb: "wait", id: "2", timeout: 600 });
});

test("anything that is more than one tasks call runs in the shell", () => {
	for (const command of ["tasks | head", "tasks output 1; ls", "echo tasks", "tasksx", "tasks output $(x)", "tasks && ls", "tasks output 1 > f"]) {
		assert.equal(parseControl(command), undefined, command);
	}
});

test("mistakes get the usage", () => {
	assert.deepEqual(parseControl("tasks stop"), { verb: "usage", error: "tasks stop needs a task id" });
	assert.deepEqual(parseControl("tasks frob"), { verb: "usage", error: "tasks: unknown command frob" });
	assert.deepEqual(parseControl("tasks output 1 --timeout 5"), { verb: "usage", error: "tasks output: bad option --timeout 5" });
	assert.deepEqual(parseControl("tasks wait 1 2"), { verb: "usage", error: "tasks wait: unexpected 2" });
	assert.deepEqual(parseControl("tasks help"), { verb: "usage" });
});

test("task ids", () => {
	assert.equal(taskId("3"), 3);
	assert.equal(taskId("%3"), 3);
	assert.equal(taskId("task-3"), 3);
	assert.equal(taskId(3), 3);
	assert.equal(taskId("x"), undefined);
	assert.equal(taskId("0"), undefined);
});
