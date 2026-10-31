import test from "node:test";
import assert from "node:assert/strict";
import { TodoParameters, TodoRuntimeParameters } from "../src/tool/schema.ts";

test("advertised schema retains typed singular fields and bounds, compacting only batch items", () => {
	const advertised = JSON.parse(JSON.stringify(TodoParameters));
	const runtime = JSON.parse(JSON.stringify(TodoRuntimeParameters));
	assert.deepEqual(advertised.properties.operations.items.properties, {});
	assert.equal(advertised.properties.operations.items.additionalProperties, true);
	delete advertised.properties.operations.items;
	delete runtime.properties.operations.items;
	assert.deepEqual(advertised, runtime);
});

test("tool schema exposes the exact seven v1 actions and bounded batch", () => {
	const schema = TodoParameters as any;
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.properties.action.enum, ["create", "update", "batch", "list", "get", "delete", "clear"]);
	assert.equal(schema.properties.operations.minItems, 1);
	assert.equal(schema.properties.operations.maxItems, 50);
});

test("schema retains rpiv-compatible singular fields and expectedRevision", () => {
	const names = Object.keys(TodoParameters.properties);
	for (const field of ["id", "subject", "description", "activeForm", "status", "blockedBy", "addBlockedBy", "removeBlockedBy", "owner", "metadata", "includeDeleted", "expectedRevision"]) assert.ok(names.includes(field), field);
});

test("runtime schema retains string and metadata bounds, nullable patches and strict batch branches", () => {
	const properties = TodoRuntimeParameters.properties as any;
	assert.equal(properties.subject.minLength, 1);
	assert.equal(properties.subject.maxLength, 500);
	assert.equal(properties.description.anyOf[0].maxLength, 20_000);
	assert.equal(properties.activeForm.anyOf[0].maxLength, 500);
	assert.equal(properties.owner.anyOf[0].maxLength, 200);
	assert.equal(properties.metadata.maxProperties, 50);
	assert.equal(properties.id.minimum, 1);
	assert.equal(properties.id.maximum, Number.MAX_SAFE_INTEGER);
	assert.equal(properties.expectedRevision.minimum, 0);
	assert.equal(properties.expectedRevision.maximum, Number.MAX_SAFE_INTEGER);
	const [create, update, remove] = properties.operations.items.anyOf;
	assert.deepEqual(create.required, ["op", "subject"]);
	assert.deepEqual(update.required, ["op", "target"]);
	assert.deepEqual(remove.required, ["op", "target"]);
	for (const branch of [create, update, remove]) assert.equal(branch.additionalProperties, false);
	assert.equal(create.properties.ref.minLength, 1);
	for (const branch of [update, remove]) {
		assert.equal(branch.properties.target.anyOf[1].additionalProperties, false);
		assert.deepEqual(branch.properties.target.anyOf[1].required, ["ref"]);
	}
	for (const branch of [create, update]) {
		assert.equal(branch.properties.subject.maxLength, 500);
		assert.equal(branch.properties.metadata.maxProperties, 50);
	}
	for (const [field, maximum] of [["description", 20_000], ["activeForm", 500], ["owner", 200]] as const) {
		assert.equal(create.properties[field].maxLength, maximum);
		assert.equal(create.properties[field].type, "string");
		assert.equal(update.properties[field].anyOf[0].maxLength, maximum);
		assert.equal(update.properties[field].anyOf[1].type, "null");
	}
});
