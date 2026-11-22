/**
 * Plumbing the background panel's built-in bridges share. Each bridge is a plain provider of the
 * `background-jobs:v1` protocol (see ../protocol.ts and README.md), so what every provider needs
 * lives here once: publish only a changed, protocol-valid snapshot; withdraw the source instead of
 * publishing an empty tab; and answer `background-jobs:v1:action` requests on the reply channel.
 * The raw event shapes an outside package copies are documented in README.md.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
	type BackgroundJob,
	type BackgroundJobActionName,
	type BackgroundJobsTab,
	MAX_BACKGROUND_JOBS_ID_CODE_UNITS,
	MAX_BACKGROUND_JOBS_OUTPUT_CODE_UNITS,
	MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS,
	BACKGROUND_JOBS_ACTION_EVENT,
	BACKGROUND_JOBS_ACTION_REPLY_EVENT,
	BACKGROUND_JOBS_PROTOCOL_VERSION,
	BACKGROUND_JOBS_SNAPSHOT_EVENT,
} from "../protocol.ts";

/** How often an active bridge asks its package what is running. */
export const BRIDGE_POLL_MS = 1000;

/** `title`/`badge`/labels must fit the protocol's 512-code-unit bound to survive validation. */
export function boundedText(
	value: string,
	max: number = MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS,
): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Output must fit the protocol's 256 KiB bound to survive validation. */
export function boundedOutput(value: string): string {
	if (value.length <= MAX_BACKGROUND_JOBS_OUTPUT_CODE_UNITS) return value;
	const note = "\n\n*… truncated*";
	return `${value.slice(0, MAX_BACKGROUND_JOBS_OUTPUT_CODE_UNITS - note.length)}${note}`;
}

/** An action request addressed to this source, or undefined when it is not one to answer. */
export interface BridgeActionRequest {
	requestId: string;
	jobId: string;
	action: BackgroundJobActionName;
}

export function bridgeActionRequest(
	value: unknown,
	source: string,
): BridgeActionRequest | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const request = value as Record<string, unknown>;
	if (request.version !== BACKGROUND_JOBS_PROTOCOL_VERSION) return undefined;
	if (request.source !== source) return undefined;
	const { requestId, jobId, action } = request;
	if (
		typeof requestId !== "string" ||
		requestId.length === 0 ||
		requestId.length > MAX_BACKGROUND_JOBS_ID_CODE_UNITS
	)
		return undefined;
	if (
		typeof jobId !== "string" ||
		jobId.length === 0 ||
		jobId.length > MAX_BACKGROUND_JOBS_ID_CODE_UNITS
	)
		return undefined;
	if (action !== "stop" && action !== "open" && action !== "output") return undefined;
	return { requestId, jobId, action };
}

/**
 * Publishes one source's snapshots on `background-jobs:v1:snapshot`: a snapshot is sent only when
 * the job list changed, and a source with no jobs is withdrawn (or never published) rather than
 * shown as an empty tab. Answers on `background-jobs:v1:action-reply` with the request's own
 * `requestId`.
 */
export class BridgePublisher {
	private readonly events: EventBus | undefined;
	private readonly source: string;
	private readonly tab: BackgroundJobsTab;
	private lastKey = "";
	private publishedOnce = false;
	private handler: ((request: BridgeActionRequest) => void) | undefined;

	constructor(events: EventBus | undefined, source: string, tab: BackgroundJobsTab) {
		this.events = events;
		this.source = source;
		this.tab = tab;
		if (!events) return;
		events.on(BACKGROUND_JOBS_ACTION_EVENT, (value) => this.answer(value));
	}

	/** Whether a snapshot of this source is currently in the panel. */
	published(): boolean {
		return this.publishedOnce;
	}

	/** Sends the snapshot when it differs from the last one; returns whether something was sent. */
	publish(jobs: readonly BackgroundJob[]): boolean {
		if (!this.events) return false;
		if (jobs.length === 0) {
			this.remove();
			return false;
		}
		const key = jobs
			.map(
				(job) =>
					`${job.id}>${job.parentId ?? ""}/${job.order ?? ""}=${job.status}${job.badge ?? ""}:${job.title}`,
			)
			.join(",");
		if (key === this.lastKey) return false;
		this.lastKey = key;
		this.publishedOnce = true;
		this.events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: BACKGROUND_JOBS_PROTOCOL_VERSION,
			source: this.source,
			tab: this.tab,
			jobs,
		});
		return true;
	}

	/** Withdraws the source, such as when its bridge is turned off. */
	remove(): void {
		if (!this.events || !this.publishedOnce) return;
		this.publishedOnce = false;
		this.lastKey = "";
		this.events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: BACKGROUND_JOBS_PROTOCOL_VERSION,
			source: this.source,
			remove: true,
		});
	}

	/** The action requests of this source, for the bridge to handle; unaddressed ones never arrive. */
	onAction(handler: (request: BridgeActionRequest) => void): void {
		this.handler = handler;
	}

	private answer(value: unknown): void {
		const request = bridgeActionRequest(value, this.source);
		if (request) this.handler?.(request);
	}

	reply(requestId: string, ok: boolean, extra: { error?: string; output?: unknown } = {}): void {
		this.events?.emit(BACKGROUND_JOBS_ACTION_REPLY_EVENT, {
			requestId,
			ok,
			...(extra.error !== undefined ? { error: extra.error } : {}),
			...(extra.output !== undefined ? { output: extra.output } : {}),
		});
	}

	replyError(requestId: string, error: string): void {
		this.reply(requestId, false, { error: boundedText(error) });
	}
}
