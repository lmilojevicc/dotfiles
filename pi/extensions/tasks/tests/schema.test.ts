import test from "node:test";
import assert from "node:assert/strict";
import { TodoParameters } from "../src/tool/schema.ts";

test("tool schema exposes the exact seven v1 actions and bounded batch", () => {
	const schema = TodoParameters as any;
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(schema.properties.action.enum, ["create", "update", "batch", "list", "get", "delete", "clear"]);
	assert.equal(schema.properties.operations.minItems, 1);
	assert.equal(schema.properties.operations.maxItems, 50);
});

test("schema retains rpiv-compatible singular fields and expectedRevision", () => {
	const names = Object.keys((TodoParameters as any).properties);
	for (const field of ["id", "subject", "description", "activeForm", "status", "blockedBy", "addBlockedBy", "removeBlockedBy", "owner", "metadata", "includeDeleted", "expectedRevision"]) assert.ok(names.includes(field), field);
});

test("schema mirrors domain string and metadata bounds, including nullable patches and batches", () => {
	const properties = (TodoParameters as any).properties;
	assert.equal(properties.subject.maxLength, 500);
	assert.equal(properties.description.anyOf[0].maxLength, 20_000);
	assert.equal(properties.activeForm.anyOf[0].maxLength, 500);
	assert.equal(properties.owner.anyOf[0].maxLength, 200);
	assert.equal(properties.metadata.maxProperties, 50);
	const [create, update] = properties.operations.items.anyOf;
	assert.equal(create.properties.subject.maxLength, 500);
	assert.equal(create.properties.description.maxLength, 20_000);
	assert.equal(create.properties.activeForm.maxLength, 500);
	assert.equal(create.properties.owner.maxLength, 200);
	assert.equal(create.properties.metadata.maxProperties, 50);
	assert.equal(update.properties.description.anyOf[0].maxLength, 20_000);
	assert.equal(update.properties.activeForm.anyOf[0].maxLength, 500);
	assert.equal(update.properties.owner.anyOf[0].maxLength, 200);
	assert.equal(update.properties.metadata.maxProperties, 50);
});
