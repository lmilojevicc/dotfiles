/**
 * End to end through a real Pi session: a faux model reads a large file over several turns, the
 * extension summarizes in the background, and the summary call is held open on a gate so the tests
 * can show the agent keeps working while it is pending.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAutoCompact } from "../index.ts";
import {
	SEGMENT_CAPABILITY_EVENT,
	SEGMENT_EVENT,
	VARIABLE_CAPABILITY_EVENT,
	VARIABLE_EVENT,
} from "../zentui.ts";

/** Stands in for Zentui on Pi's event bus: always active, records every value it is sent. */
interface ZentuiLog {
	variables: Map<string, string>;
	/** Every distinct value each key has held, in order. */
	history: Map<string, string[]>;
	segments: string[];
}

function fakeZentui(log: ZentuiLog) {
	return (pi: ExtensionAPI) => {
		pi.events.on(VARIABLE_CAPABILITY_EVENT, (probe: any) => Object.assign(probe, { supported: true, active: true }));
		pi.events.on(SEGMENT_CAPABILITY_EVENT, (probe: any) => Object.assign(probe, { supported: true, active: true }));
		pi.events.on(VARIABLE_EVENT, ({ key, text }: any) => {
			if (text) log.variables.set(key, text);
			else log.variables.delete(key);
			const seen = log.history.get(key) ?? [];
			if (seen.at(-1) !== text) seen.push(text);
			log.history.set(key, seen);
		});
		pi.events.on(SEGMENT_EVENT, ({ text }: any) => {
			if (log.segments.at(-1) !== text) log.segments.push(text);
		});
	};
}

const plain = (text: string | undefined) => text?.replace(/\x1b\[[0-9;]*m/g, "");

const SUMMARY = "## Goal\nSUMMARY-MARKER";
const FIRST_PROMPT = "FIRST-PROMPT read the big file";

interface Gate {
	open: () => void;
	promise: Promise<void>;
}

function gate(): Gate {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, promise };
}

interface HarnessOptions {
	/** Extension config written to the temp agent dir. */
	config: unknown;
	/** Agent responses: `reads` tool-call turns, then a final text answer. */
	reads: number;
	/** Pi's own compaction settings (shared by Pi and the extension). */
	compaction?: Record<string, unknown>;
	contextWindow?: number;
}

interface Harness {
	session: AgentSession;
	summaryGate: Gate;
	summaryCalls: () => number;
	agentCalls: () => number;
	/** Agent calls made while a summary call was pending. */
	callsDuringSummary: () => number;
	/** Serialized context of every agent request. */
	agentContexts: string[];
	compactions: () => Array<{ firstKeptEntryId: string | null; summary: string }>;
	zentui: ZentuiLog;
	close: () => Promise<void>;
}

async function harness(options: HarnessOptions): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "auto-compact-"));
	writeFileSync(join(dir, "big.txt"), `${"lorem ipsum dolor sit amet ".repeat(300)}\n`);
	writeFileSync(join(dir, "auto-compact.json"), JSON.stringify(options.config));
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			compaction: { enabled: false, keepRecentTokens: 1500, ...options.compaction },
			retry: { enabled: false },
		}),
	);

	const summaryGate = gate();
	const zentui: ZentuiLog = { variables: new Map(), history: new Map(), segments: [] };
	let summaryCalls = 0;
	let agentCalls = 0;
	let pendingSummaries = 0;
	let callsDuringSummary = 0;
	const agentContexts: string[] = [];
	let script = [
		...Array.from({ length: options.reads }, () =>
			fauxAssistantMessage(fauxToolCall("read", { path: "big.txt" }), { stopReason: "toolUse" }),
		),
		fauxAssistantMessage("DONE"),
	];

	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: options.contextWindow ?? 100_000 }],
	});
	const dispatch = async (context: unknown) => {
		const text = JSON.stringify(context);
		if (text.includes("context summarization assistant")) {
			summaryCalls++;
			pendingSummaries++;
			await summaryGate.promise;
			pendingSummaries--;
			return fauxAssistantMessage(SUMMARY);
		}
		agentCalls++;
		if (pendingSummaries > 0) callsDuringSummary++;
		agentContexts.push(text);
		const next = script.shift();
		assert.ok(next, "the agent ran out of scripted responses");
		return next;
	};
	faux.setResponses(Array.from({ length: 200 }, () => dispatch));

	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		extensionFactories: [createAutoCompact({ agentDir: dir }), fakeZentui(zentui)],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.create(dir, dir),
		tools: ["read"],
	});
	await session.bindExtensions({ mode: "rpc" });

	return {
		session,
		summaryGate,
		summaryCalls: () => summaryCalls,
		agentCalls: () => agentCalls,
		callsDuringSummary: () => callsDuringSummary,
		agentContexts,
		zentui,
		compactions: () =>
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction")
				.map((entry: any) => ({ firstKeptEntryId: entry.firstKeptEntryId, summary: entry.summary })),
		close: async () => {
			summaryGate.open();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
	};
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function finalText(session: AgentSession): string | undefined {
	const last = session.messages.filter((message) => message.role === "assistant").at(-1) as any;
	return last?.content?.map((part: any) => part.text ?? "").join("");
}

test("the agent keeps working while the summary is generated, then the summary lands mid-run", async () => {
	const h = await harness({ config: { thresholdPercent: 3 }, reads: 8 });
	try {
		const run = h.session.prompt(FIRST_PROMPT);
		await until(() => h.summaryCalls() > 0);
		const callsAtStart = h.agentCalls();
		// The agent is not blocked by the pending summary.
		await until(() => h.agentCalls() >= callsAtStart + 2);
		assert.equal(h.compactions().length, 0, "nothing is applied before the summary is ready");
		h.summaryGate.open();
		await run;

		assert.equal(finalText(h.session), "DONE", "the run finished normally, never aborted");
		// The compaction left usage above 3%, but the floor stops a re-summary on every later turn.
		assert.equal(h.summaryCalls(), 1);
		assert.ok(h.callsDuringSummary() >= 2, "agent requests ran while the summary was pending");
		const compactions = h.compactions();
		assert.ok(compactions.length >= 1);
		assert.equal(compactions[0].summary.includes("SUMMARY-MARKER"), true);
		assert.ok(compactions[0].firstKeptEntryId);

		// The last request was built from the compacted context: summary in, first prompt out.
		const last = h.agentContexts.at(-1)!;
		assert.equal(last.includes("SUMMARY-MARKER"), true);
		assert.equal(last.includes("FIRST-PROMPT"), false);
	} finally {
		await h.close();
	}
});

test("a summary that finishes after the run ends is applied while idle, without a second summary call", async () => {
	const h = await harness({ config: { thresholdPercent: 3 }, reads: 3 });
	try {
		await h.session.prompt(FIRST_PROMPT);
		assert.equal(finalText(h.session), "DONE");
		assert.equal(h.summaryCalls(), 1);
		assert.equal(h.compactions().length, 0);
		h.summaryGate.open();
		await until(() => h.compactions().length === 1);
		await h.session.waitForIdle();
		assert.equal(h.summaryCalls(), 1);
		assert.equal(h.compactions()[0].summary.includes("SUMMARY-MARKER"), true);
	} finally {
		await h.close();
	}
});

test("below the threshold nothing is summarized", async () => {
	const h = await harness({ config: { thresholdPercent: 95 }, reads: 3 });
	try {
		await h.session.prompt(FIRST_PROMPT);
		assert.equal(finalText(h.session), "DONE");
		assert.equal(h.summaryCalls(), 0);
		assert.equal(h.compactions().length, 0);
	} finally {
		await h.close();
	}
});

test("a per-model override replaces the global threshold", async () => {
	const h = await harness({
		config: { thresholdPercent: 3, models: { "faux/faux-1": { enabled: false } } },
		reads: 3,
	});
	try {
		await h.session.prompt(FIRST_PROMPT);
		assert.equal(h.summaryCalls(), 0);
	} finally {
		await h.close();
	}
});

test("when Pi's own threshold fires first it reuses the summary in flight", async () => {
	// Pi's backstop at window - reserve sits a little above ours, so it fires while ours is pending.
	const h = await harness({
		config: { thresholdPercent: 3 },
		reads: 8,
		contextWindow: 100_000,
		compaction: { enabled: true, reserveTokens: 95_500 },
	});
	try {
		const run = h.session.prompt(FIRST_PROMPT);
		await until(() => h.summaryCalls() > 0);
		// Pi now blocks on its own compaction, which waits for ours; release it.
		setTimeout(() => h.summaryGate.open(), 200);
		await run;
		assert.equal(finalText(h.session), "DONE");
		assert.ok(h.compactions().length >= 1);
		assert.equal(h.compactions()[0].summary.includes("SUMMARY-MARKER"), true);
		// Every compaction used exactly one summary: Pi's backstop never summarized on top of ours.
		assert.equal(h.summaryCalls(), h.compactions().length);
	} finally {
		await h.close();
	}
});

test("Zentui shows the compaction point as the window, and compaction progress on the Working line", async () => {
	const h = await harness({ config: { thresholdPercent: 3 }, reads: 8 });
	try {
		const run = h.session.prompt(FIRST_PROMPT);
		await until(() => h.summaryCalls() > 0);
		assert.match(h.zentui.segments.at(-1) ?? "", /^compacting \S+ in background$/);
		// 3% of the 100k window: the border reads against 3.0k, not 100k.
		assert.match(plain(h.zentui.variables.get("auto-compact:context")) ?? "", /^\d+%\/3\.0k$/);
		h.summaryGate.open();
		await run;
		assert.ok(h.zentui.segments.some((text) => /^compacted /.test(text ?? "")), "the segment reported the compaction");
		assert.equal(h.zentui.segments.at(-1), undefined, "the segment is removed when the run settles");
	} finally {
		await h.close();
	}
});

test("with auto-compact disabled the window is Pi's own backstop", async () => {
	const h = await harness({
		config: { enabled: false },
		reads: 1,
		compaction: { enabled: true, reserveTokens: 16_384 },
	});
	try {
		await h.session.prompt(FIRST_PROMPT);
		// 100,000 − 16,384 = 83,616 → 84k.
		assert.match(plain(h.zentui.variables.get("auto-compact:context")) ?? "", /^\d+%\/84k$/);
	} finally {
		await h.close();
	}
});

test("shutdown removes every published value", async () => {
	const h = await harness({ config: { thresholdPercent: 3 }, reads: 2 });
	await h.session.prompt(FIRST_PROMPT);
	assert.ok(h.zentui.variables.has("auto-compact:context"));
	await h.close();
	assert.equal(h.zentui.variables.size, 0);
});
