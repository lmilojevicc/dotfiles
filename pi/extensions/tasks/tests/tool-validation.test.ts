import test from "node:test";
import assert from "node:assert/strict";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { registerTodoTool } from "../src/tool/register.ts";
import { TodoRuntimeParameters } from "../src/tool/schema.ts";
import { reduceTasks } from "../src/domain/reducer.ts";
import type { TodoInput } from "../src/domain/types.ts";
import { resultDetails } from "../src/tool/result.ts";
import { commitSnapshot, getSnapshot, resetStore } from "../src/state/store.ts";
import { snapshot, task } from "./helpers.ts";

function registeredTool(): any {
	let tool: any;
	registerTodoTool({ registerTool(value: any) { tool = value; } } as any);
	return tool;
}

const originalTool = { name: "todo", description: "", parameters: TodoRuntimeParameters };
const call = (args: any) => ({ type: "toolCall" as const, id: "validation-test", name: "todo", arguments: args });
const batch = (...operations: any[]) => ({ action: "batch", operations });
const ctx = { sessionManager: { getSessionId: () => "validation-test" } };

// Exercise the real Pi validation -> registered execute path, not just schema checks.
async function execute(tool: any, args: any): Promise<any> {
	return tool.execute("validation-test", validateToolArguments(tool, call(args)), undefined, undefined, ctx);
}

test("todo prompt examples execute through real validation and reduction", async () => {
	resetStore();
	const tool = registeredTool();
	// Parse the model-facing JSON itself so edits to guidance cannot drift from this test.
	const examples = tool.promptGuidelines.flatMap((rule: string) =>
		[...rule.matchAll(/`(\{[^`]+\})`/g)].map((match) => JSON.parse(match[1]!)),
	);
	assert.deepEqual(examples.map((example: any) => example.action), ["create", "update", "batch"]);
	const [createExample, updateExample, batchExample] = examples;

	const created = await execute(tool, createExample);
	assert.equal(created.isError, false);
	assert.equal(created.details.committed, true);
	assert.equal(created.details.tasks[0].status, "pending");
	assert.equal(updateExample.id, created.details.operationResults[0].id);
	const updated = await execute(tool, updateExample);
	assert.equal(updated.isError, false);
	assert.equal(updated.details.revision, 2);
	assert.deepEqual(updated.details.tasks.map((t: any) => [t.id, t.status]), [[updateExample.id, "in_progress"]]);

	const beforeInvalidCreate = getSnapshot("validation-test");
	const invalidCreate = await execute(tool, { ...createExample, status: "in_progress" });
	assert.equal(invalidCreate.details.error.code, "invalid_fields");
	assert.strictEqual(getSnapshot("validation-test"), beforeInvalidCreate);

	// The batch is an alternative, not a third step; seed another ID to exercise ref resolution.
	resetStore();
	commitSnapshot("validation-test", snapshot([task(7)]));
	const batched = await execute(tool, batchExample);
	assert.equal(batched.isError, false);
	assert.equal(batched.details.committed, true);
	assert.equal(batched.details.revision, 1);
	assert.deepEqual(batched.details.operationResults, [{ index: 0, op: "create", id: 8 }, { index: 1, op: "update", id: 8 }]);
	assert.deepEqual(batched.details.tasks.map((t: any) => [t.id, t.status]), [[7, "pending"], [8, "in_progress"]]);

	// The exact same batch rolls back its create if starting would violate single-active.
	const initial = snapshot([task(7, "in_progress")]);
	commitSnapshot("validation-test", initial);
	const rejected = await execute(tool, batchExample);
	assert.equal(rejected.isError, true);
	assert.equal(rejected.details.error.operationIndex, 1);
	assert.strictEqual(getSnapshot("validation-test"), initial);
});

test("compact advertised batch grammar supports a dependent create/update/delete transaction", async () => {
	resetStore();
	const tool = registeredTool();
	const grammar = tool.parameters.properties.operations.items.description;
	for (const shape of [
		'{op:"create",subject,ref?,description?,activeForm?,blockedBy?,owner?,metadata?}',
		'{op:"update",target,subject?,description?,activeForm?,status?,addBlockedBy?,removeBlockedBy?,owner?,metadata?}',
		'{op:"delete",target}',
		'Task fields follow top-level types/limits; create strings cannot be null',
		'ref is a nonempty string',
		'target and dependency array entries are IDs or {ref:"name"} naming preceding creates',
		'No other fields',
	]) assert.ok(grammar.includes(shape), shape);
	// Representative call constructed solely from the advertised grammar and task fields.
	const result = await execute(tool, batch(
		{ op: "create", ref: "base", subject: "Build base", description: "Details", activeForm: "Building", owner: "worker", metadata: { keep: true, remove: 1 } },
		{ op: "create", ref: "finish", subject: "Finish", blockedBy: [{ ref: "base" }] },
		{ op: "update", target: { ref: "base" }, status: "completed", description: null, activeForm: null, owner: null, metadata: { remove: null } },
		{ op: "update", target: { ref: "finish" }, status: "in_progress" },
		{ op: "update", target: { ref: "finish" }, removeBlockedBy: [{ ref: "base" }] },
		{ op: "delete", target: { ref: "base" } },
	));
	assert.equal(result.isError, false);
	assert.equal(result.details.revision, 1);
	assert.equal(result.details.nextId, 3);
	assert.deepEqual(result.details.tasks.map((t: any) => [t.id, t.status, t.blockedBy]), [[1, "deleted", []], [2, "in_progress", []]]);
	assert.deepEqual(result.details.tasks[0].metadata, { keep: true });
	for (const field of ["description", "activeForm", "owner"]) assert.equal(result.details.tasks[0][field], undefined);
});

test("private schema validation runs before even accessing session state", async () => {
	const tool = registeredTool();
	const args = batch({ op: "create", subject: "Valid first" }, { op: "delete", target: { ref: "missing", extra: true } });
	const advertised = validateToolArguments(tool, call(args));
	await assert.rejects(tool.execute("validation-test", advertised, undefined, undefined, {
		get sessionManager() { throw new Error("state accessed before validation"); },
	}), /Validation failed for tool "todo"/);
});

test("malformed batch objects retain Pi validation errors and cannot partially commit", async () => {
	const tool = registeredTool();
	const invalidOperations = [
		{}, { op: "unknown", target: 2 }, { op: "create" }, { op: "update" }, { op: "delete" },
		{ op: "create", subject: "x", extra: true }, { op: "create", subject: "x", status: "completed" },
		{ op: "update", target: 2, subject: {}, status: "completed" },
		{ op: "delete", target: 2, subject: "Ignored?" },
		{ op: "update", target: 2, blockedBy: [] }, { op: "update", target: 2, ref: "alias" },
		{ op: "create", subject: "x", ref: {} }, { op: "create", subject: "x", ref: "" },
		{ op: "delete", target: { ref: "x", extra: 1 } }, { op: "delete", target: {} },
		{ op: "delete", target: { ref: "" } }, { op: "delete", target: 0 },
		{ op: "delete", target: Number.MAX_SAFE_INTEGER + 1 },
		{ op: "create", subject: "x", blockedBy: [null] },
		{ op: "create", subject: "x", blockedBy: [{ ref: "x", extra: 1 }] },
	];
	for (const operation of invalidOperations) {
		resetStore();
		const initial = snapshot([task(1, "completed"), task(2)], 5);
		commitSnapshot("validation-test", initial);
		const args = batch({ op: "create", subject: "Must not commit" }, operation);
		let originalError: Error | undefined;
		try { validateToolArguments(originalTool, call(args)); } catch (error) { originalError = error as Error; }
		assert.ok(originalError, JSON.stringify(operation));
		await assert.rejects(execute(tool, args), { message: originalError.message });
		assert.strictEqual(getSnapshot("validation-test"), initial);
	}
});

test("advertised-to-private pipeline matches original validation and reducer across calls and coercions", async (t) => {
	t.mock.method(Date, "now", () => 100);
	const tool = registeredTool();
	const cases: any[] = [
		{ action: "create", subject: "Singular", description: null, activeForm: null, owner: null },
		{ action: "update", id: 2, description: null, activeForm: null, owner: null, metadata: { remove: null } },
		{ action: "update", id: 2, status: "in_progress", expectedRevision: "5" },
		{ action: "list" }, { action: "list", status: "deleted", includeDeleted: true },
		{ action: "get", id: "2" }, { action: "delete", id: 2 }, { action: "clear" },
		{ action: "clear", subject: "inapplicable" }, { action: "list", expectedRevision: 5 },
		{ action: "update", id: 2 }, { action: "update", id: 1, status: "pending" },
		{ action: "create", subject: "x", unexpected: true },
		...([null, 0, "invalid", true, [], {}].map((value) => batch(value))),
		batch({ op: "create", subject: "x", ref: " " }),
		batch({ op: "create", subject: "x", description: null, activeForm: null, owner: null, ref: null }),
		batch({ op: "update", target: 2, subject: null, status: "completed" }),
		{ ...batch({ op: "invalid" }), expectedRevision: "5" },
		batch(), batch(...Array.from({ length: 50 }, () => ({ op: "create", subject: "x" }))),
		batch(...Array.from({ length: 51 }, () => ({ op: "create", subject: "x" }))),
		batch({ op: "create", subject: "x", blockedBy: [{ ref: "later" }] }, { op: "create", subject: "y", ref: "later" }),
		batch({ op: "create", subject: "x", ref: "same" }, { op: "create", subject: "y", ref: "same" }),
		batch({ op: "create", subject: "x" }, { op: "delete", target: { ref: "unknown" } }),
		batch({ op: "update", target: 2, status: "in_progress" }, { op: "create", subject: "dependent", blockedBy: [2] }, { op: "update", target: 3, status: "in_progress" }),
		batch({ op: "create", subject: "dependent", blockedBy: [2] }, { op: "delete", target: 2 }),
		batch({ op: "create", subject: "x", metadata: { huge: "x".repeat(65_536) } }),
		{ ...batch({ op: "create", subject: "x" }), expectedRevision: 4 },
	];
	// Missing, null, primitive coercions, wrong containers, unknown fields and bounds.
	const values = [undefined, null, "", "2", 0, 2, 2.5, true, false, [], {}, { ref: "base" }, { ref: "base", extra: true }];
	for (const field of ["op", "ref", "subject", "description", "activeForm", "owner", "metadata", "status", "target", "blockedBy", "addBlockedBy", "removeBlockedBy", "extra"]) {
		for (const value of values) {
			for (const op of ["create", "update", "delete"]) {
				const operation: any = op === "create" ? { op, subject: "x" } : { op, target: 2 };
				if (value !== undefined) operation[field] = value;
				else delete operation[field];
				cases.push(batch(operation));
			}
		}
	}
	for (const [field, limit] of [["subject", 500], ["description", 20_000], ["activeForm", 500], ["owner", 200]] as const) {
		for (const length of [limit, limit + 1]) {
			const fields = { [field]: "x".repeat(length) };
			cases.push({ action: "create", subject: "x", ...fields }, batch({ op: "create", subject: "x", ...fields }), batch({ op: "update", target: 2, ...fields }));
		}
	}
	for (const count of [50, 51]) {
		const metadata = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), i]));
		cases.push({ action: "create", subject: "x", metadata }, batch({ op: "create", subject: "x", metadata }), batch({ op: "update", target: 2, metadata }));
	}
	for (const field of ["id", "expectedRevision", "includeDeleted", "operations"]) {
		for (const value of [...values, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
			cases.push({ action: "get", id: 2, [field]: value });
		}
	}
	for (const args of cases) {
		resetStore();
		const initial = snapshot([task(1, "completed"), { ...task(2), description: "Keep", metadata: { remove: 1 } }], 5);
		commitSnapshot("validation-test", initial);
		let validated: TodoInput | undefined;
		try { validated = validateToolArguments(originalTool, call(args)); } catch { /* Expected schema rejection. */ }
		if (!validated) {
			await assert.rejects(execute(tool, args), /Validation failed for tool "todo"/, JSON.stringify(args));
			assert.strictEqual(getSnapshot("validation-test"), initial);
			continue;
		}
		const advertised = validateToolArguments(tool, call(args));
		assert.deepEqual(validateToolArguments(originalTool, call(advertised)), validated);
		const expected = reduceTasks(initial, validated, 100);
		const actual = await execute(tool, args);
		assert.deepEqual(actual.details, resultDetails(validated.action, expected));
		assert.equal(actual.isError, Boolean(expected.error));
		assert.deepEqual(getSnapshot("validation-test"), expected.state);
		if (!expected.committed) assert.strictEqual(getSnapshot("validation-test"), initial);
	}
	t.diagnostic(`${cases.length} differential calls matched original validation/reducer behavior`);
});
