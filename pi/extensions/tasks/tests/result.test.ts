import test from "node:test";
import assert from "node:assert/strict";
import { resultDetails, resultText } from "../src/tool/result.ts";
import { snapshot, task } from "./helpers.ts";

test("atomic failures identify action, operation index, revision, and progress", () => {
	const details = resultDetails("batch", { state: snapshot([task(1)], 4), committed: false, error: { code: "bad", message: "broken", operationIndex: 2 } });
	const text = resultText({ action: "batch", operations: [] }, details);
	assert.match(text, /batch failed at operation 2/);
	assert.match(text, /Revision 4; 0\/1 done/);
});

test("mutation results include ids and current revision", () => {
	const details = resultDetails("create", { state: snapshot([task(3)], 7, 4), committed: true, operationResults: [{ index: 0, op: "create", id: 3 }] });
	assert.match(resultText({ action: "create", subject: "x" }, details), /create committed \(#3\).*Revision 7/);
});

test("list and get render deleted records explicitly", () => {
	const details = resultDetails("list", { state: snapshot([task(3, "deleted")], 7, 4), committed: false });
	const list = resultText({ action: "list", includeDeleted: true }, details);
	assert.match(list, /^\[deleted\] #3/);
	assert.doesNotMatch(list, /\[open\]/);
	const get = resultText({ action: "get", id: 3 }, { ...details, action: "get" });
	assert.match(get, /^\[deleted\] #3/);
	assert.doesNotMatch(get, /\[open\]/);
});
