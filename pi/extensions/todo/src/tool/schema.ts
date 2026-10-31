import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
	MAX_ACTIVE_FORM_LENGTH,
	MAX_DESCRIPTION_LENGTH,
	MAX_METADATA_KEYS,
	MAX_OWNER_LENGTH,
	MAX_SUBJECT_LENGTH,
} from "../domain/invariants.js";

const Id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Subject = Type.String({ minLength: 1, maxLength: MAX_SUBJECT_LENGTH });
const Description = Type.String({ maxLength: MAX_DESCRIPTION_LENGTH });
const ActiveForm = Type.String({ maxLength: MAX_ACTIVE_FORM_LENGTH });
const Owner = Type.String({ maxLength: MAX_OWNER_LENGTH });
const NullableDescription = Type.Union([Description, Type.Null()]);
const NullableActiveForm = Type.Union([ActiveForm, Type.Null()]);
const NullableOwner = Type.Union([Owner, Type.Null()]);
const Metadata = Type.Record(Type.String(), Type.Unknown(), { maxProperties: MAX_METADATA_KEYS });
const NullableMetadata = Type.Record(Type.String(), Type.Union([Type.Unknown(), Type.Null()]), { maxProperties: MAX_METADATA_KEYS });
const BatchTarget = Type.Union([
	Id,
	Type.Object({ ref: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
const BatchCreate = Type.Object(
	{
		op: Type.Literal("create"),
		ref: Type.Optional(Type.String({ minLength: 1 })),
		subject: Subject,
		description: Type.Optional(Description),
		activeForm: Type.Optional(ActiveForm),
		blockedBy: Type.Optional(Type.Array(BatchTarget)),
		owner: Type.Optional(Owner),
		metadata: Type.Optional(Metadata),
	},
	{ additionalProperties: false },
);
const BatchUpdate = Type.Object(
	{
		op: Type.Literal("update"),
		target: BatchTarget,
		subject: Type.Optional(Subject),
		description: Type.Optional(NullableDescription),
		activeForm: Type.Optional(NullableActiveForm),
		status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
		addBlockedBy: Type.Optional(Type.Array(BatchTarget)),
		removeBlockedBy: Type.Optional(Type.Array(BatchTarget)),
		owner: Type.Optional(NullableOwner),
		metadata: Type.Optional(NullableMetadata),
	},
	{ additionalProperties: false },
);
const BatchDelete = Type.Object(
	{ op: Type.Literal("delete"), target: BatchTarget },
	{ additionalProperties: false },
);

// Keep the original strict schema for validation before execution. The advertised
// batch grammar below saves repeated task fields, not runtime checks.
export const TodoRuntimeParameters = Type.Object(
	{
		action: StringEnum(["create", "update", "batch", "list", "get", "delete", "clear"] as const),
		expectedRevision: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Mutations only; must match current revision" })),
		id: Type.Optional(Id),
		subject: Type.Optional(Subject),
		description: Type.Optional(NullableDescription),
		activeForm: Type.Optional(NullableActiveForm),
		status: Type.Optional(StringEnum(["pending", "in_progress", "completed", "deleted"] as const)),
		blockedBy: Type.Optional(Type.Array(Id)),
		addBlockedBy: Type.Optional(Type.Array(Id)),
		removeBlockedBy: Type.Optional(Type.Array(Id)),
		owner: Type.Optional(NullableOwner),
		metadata: Type.Optional(NullableMetadata),
		includeDeleted: Type.Optional(Type.Boolean()),
		operations: Type.Optional(Type.Array(Type.Union([BatchCreate, BatchUpdate, BatchDelete]), { minItems: 1, maxItems: 50 })),
	},
	{ additionalProperties: false },
);

export const TodoParameters = Type.Object(
	{
		...TodoRuntimeParameters.properties,
		// Typed optional batch fields would change Pi's null/coercion behavior
		// before the original strict schema can validate them in execute().
		operations: Type.Optional(Type.Array(Type.Object({}, {
			additionalProperties: true,
			description: 'Batch shapes (? = optional): {op:"create",subject,ref?,description?,activeForm?,blockedBy?,owner?,metadata?}; {op:"update",target,subject?,description?,activeForm?,status?,addBlockedBy?,removeBlockedBy?,owner?,metadata?}; {op:"delete",target}. Task fields follow top-level types/limits; create strings cannot be null. ref is a nonempty string. target and dependency array entries are IDs or {ref:"name"} naming preceding creates. No other fields.',
		}), { minItems: 1, maxItems: 50 })),
	},
	{ additionalProperties: false },
);

export type TodoParametersType = Static<typeof TodoRuntimeParameters>;
