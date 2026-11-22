/**
 * background-jobs v1: how an extension lists its background work for this repo's background-panel
 * extension (the ↓ panel).
 *
 * Everything travels over `pi.events`, inside one Pi process, as plain JSON data: a provider
 * publishes a snapshot of its jobs, the panel validates it and renders it; user actions travel back
 * as request events, answered per `requestId`. Providers do not import this file: they copy the
 * event names and the shapes below (see README.md), so the protocol stays portable across hosts.
 * A message for another version is ignored, not answered.
 */

/** Protocol version; messages for other versions are ignored. */
export const BACKGROUND_JOBS_PROTOCOL_VERSION = 1;
/** Provider → panel: ask whether the panel listens. The panel answers in place, and re-announces on this channel when it becomes active. */
export const BACKGROUND_JOBS_CAPABILITY_EVENT = "background-jobs:v1:capability";
/** Provider → panel: a `BackgroundJobsSnapshot`, or `{ version, source, remove: true }` to withdraw a source. */
export const BACKGROUND_JOBS_SNAPSHOT_EVENT = "background-jobs:v1:snapshot";
/** Panel → provider: a `BackgroundJobsActionRequest`; the provider answers on the reply channel below. */
export const BACKGROUND_JOBS_ACTION_EVENT = "background-jobs:v1:action";
/** Provider → panel: a `BackgroundJobsActionReply`, matched by `requestId`. */
export const BACKGROUND_JOBS_ACTION_REPLY_EVENT = "background-jobs:v1:action-reply";

/**
 * Bounds. Every field is validated; a message that breaks one is ignored whole, so a provider for
 * another version cannot break the panel. Ids (`source`, `tab.id`, job `id`, `parentId`) are up to
 * 64 UTF-16 code units; titles and other labels (tab label, noun, badge, action labels, output
 * heading, reply error) up to 512; output text up to 256 KiB (262144); at most 200 jobs per source,
 * 32 sources, and 2 noun forms of up to 64 code units each.
 */
export const MAX_BACKGROUND_JOBS_ID_CODE_UNITS = 64;
export const MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS = 512;
export const MAX_BACKGROUND_JOBS_OUTPUT_CODE_UNITS = 256 * 1024;
export const MAX_BACKGROUND_JOBS_PER_SOURCE = 200;
export const MAX_BACKGROUND_JOBS_SOURCES = 32;

export type BackgroundJobStatus = "running" | "done" | "failed" | "stopped";
export type BackgroundJobActionName = "stop" | "open" | "output";
export type BackgroundJobOutputFormat = "text" | "markdown";

/** Which actions the panel offers for a job; the string values are the key-hint labels. */
export type BackgroundJobActions = {
	/** Stop the running job (Ctrl+D). The value is the hint label, such as `kill`. */
	stop?: string;
	/** Take the job over (Enter); the output view moves to Ctrl+O. The value is the hint label, such as `attach`. */
	open?: string;
	/** The job's output can be shown read-only. */
	output?: true;
};

export type BackgroundJob = {
	/** Unique within the source. */
	id: string;
	/** One line, such as the command or `Researcher: web exploration about cats`. */
	title: string;
	status: BackgroundJobStatus;
	/** Epoch ms. */
	startedAt?: number;
	endedAt?: number;
	/** Short text on the right of the row instead of the status, such as `Running · 1/3`. */
	badge?: string;
	/** Id of another job from the same source: this job is listed under its parent instead of the top level. */
	parentId?: string;
	/** Position among siblings; children follow their parent sorted by this, then by `startedAt`. */
	order?: number;
	actions?: BackgroundJobActions;
};

export type BackgroundJobsTab = {
	id: string;
	label: string;
	/** Count words for the summary: `["shell", "shells"]` → `2 shells`. */
	noun: [singular: string, plural: string];
	/** Lower comes first; sources with the same tab id share it. */
	order?: number;
};

/** A source's jobs: the tab they appear in, and the jobs themselves. An empty `jobs` removes the source. */
export type BackgroundJobsSnapshot = {
	version: typeof BACKGROUND_JOBS_PROTOCOL_VERSION;
	/** Stable source id, such as `bash-improved`. */
	source: string;
	tab: BackgroundJobsTab;
	jobs: BackgroundJob[];
};

/** Withdraws a source, such as on publisher shutdown. */
export type BackgroundJobsRemoval = {
	version: typeof BACKGROUND_JOBS_PROTOCOL_VERSION;
	source: string;
	remove: true;
};

export type BackgroundJobsCapability = {
	supported: boolean;
	active: boolean;
	/** Present in protocol version 1 and later. */
	version?: number;
};

export type BackgroundJobsActionRequest = {
	version: typeof BACKGROUND_JOBS_PROTOCOL_VERSION;
	/** Matches the reply; unique per panel process. */
	requestId: string;
	source: string;
	jobId: string;
	action: BackgroundJobActionName;
};

export type BackgroundJobOutput = {
	/** Shown above the output, such as the full command. */
	heading?: string;
	/** As `text` (the default) terminal sequences are stripped; as `markdown` it renders like an assistant message. */
	text: string;
	format?: BackgroundJobOutputFormat;
};

export type BackgroundJobsActionReply = {
	requestId: string;
	ok: boolean;
	error?: string;
	/** Present for the `output` action. */
	output?: BackgroundJobOutput;
};

type EventRecord = Record<string, unknown>;

/**
 * Any plain-data value, as an untrusted event field may hold (the protocol carries plain data). The
 * validators below narrow it; a value outside this shape still fails their runtime checks.
 */
type PlainValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| PlainValue[]
	| { [key: string]: PlainValue };

function eventRecord(value: unknown): EventRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as EventRecord)
		: undefined;
}

/** Read data only: publisher getters must not run as part of the protocol. */
function eventField(record: EventRecord, key: string): PlainValue {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	if (descriptor && !("value" in descriptor)) throw new TypeError("Accessor event field");
	return descriptor?.value;
}

function boundedId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_BACKGROUND_JOBS_ID_CODE_UNITS
	);
}

function boundedText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS
	);
}

function epochMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function orderValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function jobStatus(value: unknown): BackgroundJobStatus | undefined {
	return value === "running" || value === "done" || value === "failed" || value === "stopped"
		? value
		: undefined;
}

function jobActions(value: unknown): BackgroundJobActions | undefined {
	const record = eventRecord(value);
	if (!record) return undefined;
	const actions: BackgroundJobActions = {};
	let hasAction = false;
	try {
		const stop = eventField(record, "stop");
		if (stop !== undefined) {
			if (!boundedText(stop)) return undefined;
			actions.stop = stop;
			hasAction = true;
		}
		const open = eventField(record, "open");
		if (open !== undefined) {
			if (!boundedText(open)) return undefined;
			actions.open = open;
			hasAction = true;
		}
		const output = eventField(record, "output");
		if (output !== undefined) {
			if (output !== true) return undefined;
			actions.output = true;
			hasAction = true;
		}
	} catch {
		return undefined;
	}
	return hasAction ? actions : undefined;
}

function job(value: unknown): BackgroundJob | undefined {
	const record = eventRecord(value);
	if (!record) return undefined;
	try {
		const id = eventField(record, "id");
		const title = eventField(record, "title");
		const status = eventField(record, "status");
		if (!boundedId(id) || !boundedText(title)) return undefined;
		const parsedStatus = jobStatus(status);
		if (parsedStatus === undefined) return undefined;
		const actions = eventField(record, "actions");
		const parsedActions = actions === undefined ? undefined : jobActions(actions);
		if (actions !== undefined && !parsedActions) return undefined;
		const startedAt = eventField(record, "startedAt");
		const endedAt = eventField(record, "endedAt");
		if (startedAt !== undefined && epochMs(startedAt) === undefined) return undefined;
		if (endedAt !== undefined && epochMs(endedAt) === undefined) return undefined;
		const badge = eventField(record, "badge");
		if (badge !== undefined && !boundedText(badge)) return undefined;
		const parentId = eventField(record, "parentId");
		if (parentId !== undefined && !boundedId(parentId)) return undefined;
		const order = eventField(record, "order");
		if (order !== undefined && orderValue(order) === undefined) return undefined;
		return {
			id,
			title,
			status: parsedStatus,
			...(startedAt !== undefined ? { startedAt: startedAt as number } : {}),
			...(endedAt !== undefined ? { endedAt: endedAt as number } : {}),
			...(badge !== undefined ? { badge: badge as string } : {}),
			...(parentId !== undefined ? { parentId: parentId as string } : {}),
			...(order !== undefined ? { order: order as number } : {}),
			...(parsedActions !== undefined ? { actions: parsedActions } : {}),
		};
	} catch {
		return undefined;
	}
}

function tab(value: unknown): BackgroundJobsTab | undefined {
	const record = eventRecord(value);
	if (!record) return undefined;
	try {
		const id = eventField(record, "id");
		const label = eventField(record, "label");
		const noun = eventField(record, "noun");
		if (!boundedId(id) || !boundedText(label) || !Array.isArray(noun) || noun.length !== 2)
			return undefined;
		for (const word of noun)
			if (
				typeof word !== "string" ||
				word.length === 0 ||
				word.length > MAX_BACKGROUND_JOBS_ID_CODE_UNITS
			)
				return undefined;
		const order = eventField(record, "order");
		if (order !== undefined && orderValue(order) === undefined) return undefined;
		return {
			id,
			label,
			noun: [noun[0] as string, noun[1] as string],
			...(order !== undefined ? { order: order as number } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Validates a `background-jobs:v1:snapshot` message. Returns a snapshot, a removal, or undefined
 * when the message does not follow protocol version 1: wrong version, missing or over-limit fields,
 * duplicate job ids, or more jobs than `MAX_BACKGROUND_JOBS_PER_SOURCE` are all ignored whole.
 */
export function backgroundJobsMessage(
	value: unknown,
): BackgroundJobsSnapshot | BackgroundJobsRemoval | undefined {
	const record = eventRecord(value);
	if (!record) return undefined;
	try {
		const version = eventField(record, "version");
		if (version !== BACKGROUND_JOBS_PROTOCOL_VERSION) return undefined;
		const source = eventField(record, "source");
		if (!boundedId(source)) return undefined;
		const remove = eventField(record, "remove");
		if (remove !== undefined && remove !== true) return undefined;
		if (remove === true) return { version: BACKGROUND_JOBS_PROTOCOL_VERSION, source, remove: true };
		const jobs = eventField(record, "jobs");
		if (!Array.isArray(jobs) || jobs.length > MAX_BACKGROUND_JOBS_PER_SOURCE) return undefined;
		const parsedTab = tab(eventField(record, "tab"));
		if (!parsedTab) return undefined;
		const seen = new Set<string>();
		const parsedJobs: BackgroundJob[] = [];
		for (const entry of jobs) {
			const parsed = job(entry);
			if (!parsed || seen.has(parsed.id)) return undefined;
			seen.add(parsed.id);
			parsedJobs.push(parsed);
		}
		return {
			version: BACKGROUND_JOBS_PROTOCOL_VERSION,
			source,
			tab: parsedTab,
			jobs: parsedJobs,
		};
	} catch {
		return undefined;
	}
}

/** Validates a `background-jobs:v1:action-reply` message; anything else is ignored. */
export function backgroundJobsActionReply(value: unknown): BackgroundJobsActionReply | undefined {
	const record = eventRecord(value);
	if (!record) return undefined;
	try {
		const requestId = eventField(record, "requestId");
		if (!boundedId(requestId)) return undefined;
		const ok = eventField(record, "ok");
		if (typeof ok !== "boolean") return undefined;
		const error = eventField(record, "error");
		if (error !== undefined && !boundedText(error)) return undefined;
		const output = eventField(record, "output");
		let parsedOutput: BackgroundJobOutput | undefined;
		if (output !== undefined) {
			const outputRecord = eventRecord(output);
			if (!outputRecord) return undefined;
			const heading = eventField(outputRecord, "heading");
			if (heading !== undefined && !boundedText(heading)) return undefined;
			const text = eventField(outputRecord, "text");
			if (typeof text !== "string" || text.length > MAX_BACKGROUND_JOBS_OUTPUT_CODE_UNITS)
				return undefined;
			const format = eventField(outputRecord, "format");
			if (format !== undefined && format !== "text" && format !== "markdown") return undefined;
			parsedOutput = {
				...(heading !== undefined ? { heading: heading as string } : {}),
				text,
				...(format !== undefined ? { format: format as BackgroundJobOutputFormat } : {}),
			};
		}
		return {
			requestId,
			ok,
			...(error !== undefined ? { error: error as string } : {}),
			...(parsedOutput !== undefined ? { output: parsedOutput } : {}),
		};
	} catch {
		return undefined;
	}
}
