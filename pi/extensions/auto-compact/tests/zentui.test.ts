import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	contextLabel,
	formatCount,
	readZentuiThresholds,
	SEGMENT_CAPABILITY_EVENT,
	SEGMENT_EVENT,
	VARIABLE_CAPABILITY_EVENT,
	VARIABLE_EVENT,
	ZentuiPublisher,
} from "../zentui.ts";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("the label reads like Zentui's percent-total $context, against the compaction point", () => {
	assert.equal(plain(contextLabel(500_000, 800_000)), "63%/800k");
	assert.equal(plain(contextLabel(500_000, 983_616)), "51%/984k");
	assert.equal(plain(contextLabel(0, 1_000_000)), "0%/1.0M");
	assert.equal(plain(contextLabel(null, 800_000)), "?/800k");
	assert.equal(contextLabel(1, 0), "");
});

test("the label can pass 100% while a summary is still being written", () => {
	assert.equal(plain(contextLabel(824_000, 800_000)), "103%/800k");
});

test("colour tiers follow the thresholds", () => {
	assert.ok(contextLabel(100, 1000).startsWith("\x1b[90m"));
	assert.ok(contextLabel(700, 1000).startsWith("\x1b[1;33m"));
	assert.ok(contextLabel(900, 1000).startsWith("\x1b[1;31m"));
	assert.ok(contextLabel(500, 1000, { warning: 40, error: 60 }).startsWith("\x1b[1;33m"));
});

test("formatCount matches Zentui", () => {
	assert.deepEqual(
		[999, 1500, 96_000, 983_616, 1_000_000, 12_000_000].map(formatCount),
		["999", "1.5k", "96k", "984k", "1.0M", "12M"],
	);
});

test("thresholds come from zentui.json, with Zentui's defaults otherwise", () => {
	const dir = mkdtempSync(join(tmpdir(), "auto-compact-zentui-"));
	assert.deepEqual(readZentuiThresholds(dir), { warning: 70, error: 90 });
	writeFileSync(
		join(dir, "zentui.json"),
		JSON.stringify({
			components: { editor: { styles: { minimalist: { contextThresholds: { warning: 50, error: 80 } } } } },
		}),
	);
	assert.deepEqual(readZentuiThresholds(dir), { warning: 50, error: 80 });
});

function bus(active: { variables: boolean; segments: boolean }) {
	const sent: Array<{ channel: string; data: any }> = [];
	return {
		sent,
		emit(channel: string, data: any) {
			if (channel === VARIABLE_CAPABILITY_EVENT) Object.assign(data, { supported: true, active: active.variables });
			else if (channel === SEGMENT_CAPABILITY_EVENT) Object.assign(data, { supported: true, active: active.segments });
			else sent.push({ channel, data });
		},
	};
}

test("values are only published while Zentui shows them, and always removed", () => {
	const events = bus({ variables: true, segments: false });
	const publisher = new ZentuiPublisher(events);
	assert.equal(publisher.variable("auto-compact:context", "1%/800k"), true);
	assert.equal(publisher.workingSegment("compacting 800k"), false);
	publisher.clear();
	assert.deepEqual(events.sent, [
		{ channel: VARIABLE_EVENT, data: { key: "auto-compact:context", text: "1%/800k" } },
		{ channel: VARIABLE_EVENT, data: { key: "auto-compact:context", text: undefined } },
	]);
});

test("without Zentui nothing is sent", () => {
	const events = bus({ variables: false, segments: false });
	const publisher = new ZentuiPublisher(events);
	assert.equal(publisher.variable("auto-compact:context", "1%/800k"), false);
	publisher.clear();
	assert.deepEqual(events.sent, []);
});
