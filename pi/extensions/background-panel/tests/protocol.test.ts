import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	backgroundJobsActionReply,
	backgroundJobsMessage,
	BACKGROUND_JOBS_PROTOCOL_VERSION,
	MAX_BACKGROUND_JOBS_ID_CODE_UNITS,
	MAX_BACKGROUND_JOBS_OUTPUT_CODE_UNITS,
	MAX_BACKGROUND_JOBS_PER_SOURCE,
	MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS,
} from "../protocol.ts";

const tab = {
	id: "shell",
	label: "Shell",
	noun: ["shell", "shells"] as [string, string],
	order: 20,
};
const job = { id: "1", title: "npm run dev", status: "running" as const };

describe("background-jobs message validation", () => {
	it("accepts a well-formed snapshot", () => {
		const message = backgroundJobsMessage({
			version: BACKGROUND_JOBS_PROTOCOL_VERSION,
			source: "bash-improved",
			tab,
			jobs: [
				{
					...job,
					startedAt: 123,
					endedAt: 456,
					badge: "Running · 1/2",
					order: 0,
					actions: { stop: "kill", open: "attach", output: true },
				},
			],
		});
		assert.deepEqual(message, {
			version: 1,
			source: "bash-improved",
			tab,
			jobs: [
				{
					id: "1",
					title: "npm run dev",
					status: "running",
					startedAt: 123,
					endedAt: 456,
					badge: "Running · 1/2",
					order: 0,
					actions: { stop: "kill", open: "attach", output: true },
				},
			],
		});
	});

	it("accepts a removal and an empty snapshot", () => {
		assert.deepEqual(
			backgroundJobsMessage({
				version: BACKGROUND_JOBS_PROTOCOL_VERSION,
				source: "bash-improved",
				remove: true,
			}),
			{ version: 1, source: "bash-improved", remove: true },
		);
		assert.deepEqual(
			backgroundJobsMessage({
				version: BACKGROUND_JOBS_PROTOCOL_VERSION,
				source: "bash-improved",
				tab,
				jobs: [],
			}),
			{ version: 1, source: "bash-improved", tab, jobs: [] },
		);
	});

	const rejectedMessages: Array<[string, Record<string, unknown>]> = [
		["another version", { version: 2, source: "s", tab, jobs: [job] }],
		["a missing source", { version: 1, tab, jobs: [job] }],
		[
			"an oversized source",
			{ version: 1, source: "s".repeat(MAX_BACKGROUND_JOBS_ID_CODE_UNITS + 1), tab, jobs: [job] },
		],
		["a missing tab", { version: 1, source: "s", jobs: [job] }],
		[
			"a tab without a noun pair",
			{ version: 1, source: "s", tab: { id: "t", label: "T", noun: ["x"] }, jobs: [job] },
		],
		[
			"a non-integer tab order",
			{ version: 1, source: "s", tab: { ...tab, order: 1.5 }, jobs: [job] },
		],
		["a missing jobs array", { version: 1, source: "s", tab }],
		[
			"jobs over the per-source cap",
			{
				version: 1,
				source: "s",
				tab,
				jobs: Array.from({ length: MAX_BACKGROUND_JOBS_PER_SOURCE + 1 }, (_, i) => ({
					...job,
					id: String(i),
				})),
			},
		],
	];
	for (const [name, value] of rejectedMessages) {
		it(`rejects ${name}`, () => {
			assert.equal(backgroundJobsMessage(value), undefined);
		});
	}

	const rejectedJobs: Array<[string, Array<Record<string, unknown>>]> = [
		["a job without an id", [{ ...job, id: "" }]],
		[
			"a job with an oversized id",
			[{ ...job, id: "j".repeat(MAX_BACKGROUND_JOBS_ID_CODE_UNITS + 1) }],
		],
		["a job without a title", [{ ...job, title: "" }]],
		[
			"a job with an oversized title",
			[{ ...job, title: "t".repeat(MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS + 1) }],
		],
		["a job with an unknown status", [{ ...job, status: "queued" }]],
		["a job with a fractional start", [{ ...job, startedAt: 1.5 }]],
		["a job with a negative end", [{ ...job, endedAt: -1 }]],
		[
			"a job with an oversized badge",
			[{ ...job, badge: "b".repeat(MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS + 1) }],
		],
		[
			"a job with an oversized parentId",
			[{ ...job, parentId: "p".repeat(MAX_BACKGROUND_JOBS_ID_CODE_UNITS + 1) }],
		],
		["a job with a fractional order", [{ ...job, order: 0.5 }]],
		["duplicate job ids", [job, job]],
		["an empty stop label", [{ ...job, actions: { stop: "" } }]],
		["output without true", [{ ...job, actions: { output: "yes" } }]],
		["a malformed actions field", [{ ...job, actions: "stop" }]],
	];
	for (const [name, jobs] of rejectedJobs) {
		it(`rejects ${name}`, () => {
			assert.equal(
				backgroundJobsMessage({
					version: BACKGROUND_JOBS_PROTOCOL_VERSION,
					source: "s",
					tab,
					jobs,
				}),
				undefined,
			);
		});
	}

	it("ignores non-object payloads, arrays, and accessor fields", () => {
		assert.equal(backgroundJobsMessage(undefined), undefined);
		assert.equal(backgroundJobsMessage("nope"), undefined);
		assert.equal(backgroundJobsMessage([job]), undefined);
		const message: Record<string, unknown> = {};
		Object.defineProperty(message, "version", {
			get: () => BACKGROUND_JOBS_PROTOCOL_VERSION,
		});
		assert.equal(backgroundJobsMessage(message), undefined);
	});
});

describe("background-jobs action reply validation", () => {
	it("accepts a success reply with output and an error reply", () => {
		assert.deepEqual(
			backgroundJobsActionReply({
				requestId: "r1",
				ok: true,
				output: { heading: "$ make", text: "done" },
			}),
			{ requestId: "r1", ok: true, output: { heading: "$ make", text: "done" } },
		);
		assert.deepEqual(
			backgroundJobsActionReply({ requestId: "r2", ok: false, error: "no such job" }),
			{
				requestId: "r2",
				ok: false,
				error: "no such job",
			},
		);
	});

	const rejected: Array<[string, Record<string, unknown>]> = [
		["a missing requestId", { ok: true }],
		[
			"an oversized requestId",
			{ requestId: "r".repeat(MAX_BACKGROUND_JOBS_ID_CODE_UNITS + 1), ok: true },
		],
		["a missing ok", { requestId: "r" }],
		[
			"oversized output text",
			{
				requestId: "r",
				ok: true,
				output: { text: "x".repeat(MAX_BACKGROUND_JOBS_OUTPUT_CODE_UNITS + 1) },
			},
		],
		["an unknown format", { requestId: "r", ok: true, output: { text: "x", format: "ansi" } }],
		[
			"an oversized heading",
			{
				requestId: "r",
				ok: true,
				output: { heading: "h".repeat(MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS + 1), text: "x" },
			},
		],
		[
			"an oversized error",
			{ requestId: "r", ok: false, error: "e".repeat(MAX_BACKGROUND_JOBS_TEXT_CODE_UNITS + 1) },
		],
		["a malformed output", { requestId: "r", ok: true, output: "text" }],
	];
	for (const [name, value] of rejected) {
		it(`rejects ${name}`, () => {
			assert.equal(backgroundJobsActionReply(value), undefined);
		});
	}

	it("keeps empty output text, which renders as no output yet", () => {
		assert.deepEqual(
			backgroundJobsActionReply({ requestId: "r", ok: true, output: { text: "" } }),
			{
				requestId: "r",
				ok: true,
				output: { text: "" },
			},
		);
	});
});
