import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { CHILD_POLICY_MARKER, CHILD_PREFIXES, LEGACY_END, LEGACY_START, NATIVE_CHILD_BOUNDARIES, NATIVE_STRUCTURED_OUTPUT_SUFFIX, POLICY_SECTION, policySection, selectAgentName, selectProfile, stripOwnedBlocks, type PolicyProfile } from "../child-profile.ts";
import { installAgentPolicy, POLICY_ID } from "../runtime.ts";
import { parseBBPolicySignal, type BBPolicySignal } from "../bb-profile.ts";
import { loadSystemPromptBuilder } from "./pi-package.ts";

// Render prompts with the installed Pi, so a forced prompt and a structured section cannot be confused.
const { buildSystemPrompt } = await loadSystemPromptBuilder();
const blocks = (prompt: string) => prompt.split("<agent_policy>").length - 1;

// Stand-in for the removed legacy Chadineer hook: an enabled peer appending a legacy-marked block.
// It appends to the prompt options like a well-behaved extension; returning systemPrompt would force
// the whole prompt and drop every section a later handler adds.
const CHADINEER_PROMPT = "Chadineer development guidelines\n\nKeep it concise.";
function chadineer(pi: any) {
	pi.on("before_agent_start", (event: any) => {
		if (event.systemPrompt.includes(CHILD_POLICY_MARKER)) return;
		const options = event.systemPromptOptions;
		options.appendSystemPrompt = `${options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n` : ""}${LEGACY_START}\n${CHADINEER_PROMPT}\n${LEGACY_END}`;
	});
}

type Handler = (...args: any[]) => any;
function harness(t: any, { backgroundChild = false, bbSignal = undefined as BBPolicySignal | undefined, bbOrigin = false, register = undefined as any, legacyFirst = false, legacy = false, deployed = false, configure = (_directory: string) => {} } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "agent-policy-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "common.md"), "COMMON draft");

	for (const role of ["worker", "reviewer", "scout"]) writeFileSync(join(directory, `${role}.md`), `${role} overlay`);
	writeFileSync(join(directory, "main.md"), "MAIN draft");
	writeFileSync(join(directory, "main-bb.md"), "MAIN BB draft");
	writeFileSync(join(directory, "child.md"), "CHILD draft");
	const initialConfig = { common: ["common.md"], main: ["main.md"], mainBb: ["main-bb.md"], child: ["child.md"], agents: { worker: ["worker.md"], reviewer: ["reviewer.md"], scout: ["scout.md"] } };
	if (deployed) {
		for (const file of ["common.md", "child.md", "worker.md", "reviewer.md", "scout.md"]) writeFileSync(join(directory, file), "");
		writeFileSync(join(directory, "main.md"), readFileSync(new URL("../prompts/main.md", import.meta.url)));
		writeFileSync(join(directory, "main-bb.md"), readFileSync(new URL("../prompts/main-bb.md", import.meta.url)));
		initialConfig.agents = { worker: [], reviewer: [], scout: [] };
	}
	writeFileSync(join(directory, "config.json"), JSON.stringify(initialConfig));
	const handlers = new Map<string, Handler[]>();
	const notices: string[] = [];
	const noticeTypes: string[] = [];
	const registrations: any[] = [];
	let disposed = 0;
	let sessionFile: string | undefined = "/sessions/parent.jsonl";
	let sessionId = "uuid-parent";
	const api = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand() {}, appendEntry() {},
	};
	const ctx: any = {
		hasUI: true,
		// A TUI keeps the stderr mirror quiet; the non-TUI paths are asserted explicitly.
		mode: "tui",
		ui: { notify(message: string, type: string) { assert.ok(type === "warning" || type === "error"); notices.push(message); noticeTypes.push(type); }, setStatus() {} },
		sessionManager: {
			getSessionFile: () => sessionFile, getSessionId: () => sessionId,
			getBranch: () => [],
		},
	};
	function install() {
		if (legacy && legacyFirst) chadineer(api as any);
		installAgentPolicy(api as any, {
			policyDir: directory, extensionPath: join(directory, "index.ts"), backgroundChild, bbSignal, bbOrigin,
			register: register ?? ((input: any) => { registrations.push(input); return { dispose() { disposed++; } }; }),
		});
		if (legacy && !legacyFirst) chadineer(api as any);
	}
	configure(directory);
	install();
	const cwd = join(directory, "project");
	function render(prompt: string, sections: Record<string, string> = {}) {
		return buildSystemPrompt({ cwd, customPrompt: prompt, selectedTools: [], sections });
	}
	function sourceText(bodies: string) {
		const files: Record<string, string> = { "COMMON draft": "common.md", "MAIN draft": "main.md", "MAIN BB draft": "main-bb.md", "CHILD draft": "child.md", "worker overlay": "worker.md", "reviewer overlay": "reviewer.md", "scout overlay": "scout.md" };
		return bodies.split("\n\n").map((body) => `## Policy source: ${join(directory, files[body])}\nResolve this source's relative file references against ${directory}.\n\n${body}`).join("\n\n");
	}
	function expectedSection(profile: PolicyProfile, bodies: string) {
		return policySection(profile, sourceText(bodies));
	}
	function emit(event: string, input: any = {}) { for (const fn of handlers.get(event) ?? []) fn(input, ctx); }
	/** One run: Pi starts from fresh base options, so only this run's mutations are observed. */
	function before(prompt = "root role") {
		const options: any = { cwd, customPrompt: prompt, selectedTools: [], sections: {} };
		const returns: any[] = [];
		for (const fn of handlers.get("before_agent_start") ?? []) {
			// Like Pi: each handler sees the prompt rendered from the options earlier handlers mutated.
			const result = fn({ systemPrompt: buildSystemPrompt(options), systemPromptOptions: options }, ctx);
			if (result) returns.push(result);
		}
		return { systemPrompt: buildSystemPrompt(options), options, sections: options.sections as Record<string, string>, returns };
	}
	return {
		directory, registrations, notices, noticeTypes, ctx,
		expectedSection,
		/** The rendered prompt for a run that composes nothing (`agent_policy` unset). */
		base: (prompt: string) => render(prompt),
		expected(prompt: string, profile: PolicyProfile, bodies: string) {
			const section = expectedSection(profile, bodies);
			return render(prompt, section === undefined ? {} : { [POLICY_SECTION]: section });
		},
		get disposed() { return disposed; }, emit,
		reload() {
			emit("session_shutdown", { reason: "reload" });
			handlers.clear();
			install();
			emit("session_start", { reason: "reload" });
		},
		identity(file: string | undefined, uuid: string) { sessionFile = file; sessionId = uuid; },
		before,
		section(prompt = "root role") { return before(prompt).sections[POLICY_SECTION]; },
	};
}

test("native adapter distinguishes root, foreground/fork, background and explicit fanout", () => {
	assert.equal(selectProfile("root role", false), "main");
	for (const prefix of CHILD_PREFIXES) assert.equal(selectProfile(`\n${prefix}\nworker role`, false), "subagent");
	assert.equal(selectProfile("background role", true), "subagent");
	assert.equal(selectProfile(`quoted later: ${CHILD_PREFIXES[0]}`, false), "main");
});

test("root owns one prompt section from its initialization snapshot on each run until runtime reload", (t) => {
	const runtime = harness(t);
	runtime.emit("session_start");
	const first = runtime.before();
	assert.deepEqual(first.returns, [], "a returned systemPrompt would force the prompt and drop later sections");
	assert.equal(first.options.forceSystemPrompt, undefined);
	assert.ok(first.systemPrompt.startsWith("root role"));
	assert.match(first.systemPrompt, /MAIN draft/);
	assert.match(first.systemPrompt, /COMMON draft/);
	assert.doesNotMatch(first.systemPrompt, /CHILD draft/);
	assert.ok(first.systemPrompt.indexOf("COMMON draft") < first.systemPrompt.indexOf("MAIN draft"));
	assert.equal(first.sections[POLICY_SECTION], runtime.expectedSection("main", "COMMON draft\n\nMAIN draft"));
	assert.equal(blocks(first.systemPrompt), 1);
	writeFileSync(join(runtime.directory, "main.md"), "MAIN edited");
	writeFileSync(join(runtime.directory, "common.md"), "COMMON edited");
	assert.equal(runtime.before().systemPrompt, first.systemPrompt);
	assert.equal(runtime.registrations.length, 1);
	runtime.reload();
	const next = runtime.before();
	assert.equal(blocks(next.systemPrompt), 1);
	assert.match(next.systemPrompt, /MAIN edited/);
	assert.match(next.systemPrompt, /COMMON edited/);
	assert.doesNotMatch(next.systemPrompt, /MAIN draft|COMMON draft/);
	assert.equal(runtime.registrations.length, 2);
	assert.equal(runtime.disposed, 1);
});

test("a section inherited as prompt text is replaced in place, never duplicated", (t) => {
	const runtime = harness(t);
	const first = runtime.before();
	// A fork or a child role body can carry the parent's rendered prompt as its own text.
	const inherited = runtime.before(first.systemPrompt);
	assert.equal(blocks(inherited.systemPrompt), 1);
	assert.equal(inherited.sections[POLICY_SECTION], first.sections[POLICY_SECTION]);
	assert.equal(blocks(inherited.options.customPrompt), 0, "the inherited block is removed from the text it came from");
	// A launch header inherited inside the text is not the run's own launch metadata.
	const child = runtime.before(`${CHILD_PREFIXES[0]}\nworker role\n${first.systemPrompt}`);
	assert.equal(blocks(child.systemPrompt), 1);
	assert.equal(child.sections[POLICY_SECTION], runtime.expectedSection("subagent", "COMMON draft\n\nCHILD draft"));
	assert.doesNotMatch(child.systemPrompt, /MAIN draft/);
});

for (const [name, prompt, backgroundChild] of [
	["fresh foreground", `${CHILD_PREFIXES[0]}\nworker role`, false],
	["fork", `${CHILD_PREFIXES[0]}\nreviewer role`, false],
	["explicit fanout", `${CHILD_PREFIXES[1]}\nfanout role`, false],
	["background", "worker role", true],
] as const) {
	test(`${name} injects child profile and preserves role`, (t) => {
		const runtime = harness(t, { backgroundChild });
		runtime.emit("session_start");
		const result = runtime.before(prompt);
		assert.ok(result.systemPrompt.startsWith(prompt));
		assert.match(result.systemPrompt, /CHILD draft/);
		assert.ok(result.sections[POLICY_SECTION]?.includes(CHILD_POLICY_MARKER));
		assert.doesNotMatch(result.systemPrompt, /MAIN draft/);
		writeFileSync(join(runtime.directory, "child.md"), "CHILD edited");
		assert.equal(runtime.before(prompt).systemPrompt, result.systemPrompt);
		runtime.reload();
		assert.match(runtime.before(prompt).systemPrompt, /CHILD edited/);
	});
}

test("fork drops only owned parent policy blocks, retaining deliberate role/legacy text", () => {
	const parentSection = policySection("main", "MAIN draft");
	const inherited = `${CHILD_PREFIXES[0]}\nreviewer role\nparent role\n\n<agent_policy>\n${parentSection}\n</agent_policy>\n\n${CHADINEER_PROMPT}`;
	const child = stripOwnedBlocks(inherited, "subagent");
	assert.doesNotMatch(child, /MAIN draft/);
	assert.match(child, /parent role/);
	assert.match(child, /reviewer role/);
	assert.ok(child.includes(CHADINEER_PROMPT), "unmarked user-supplied instructions are not heuristically removed");
	const marked = `${inherited}\n${LEGACY_START}\nlegacy peer block\n${LEGACY_END}`;
	assert.doesNotMatch(stripOwnedBlocks(marked, "subagent"), /legacy peer block/);
	assert.match(stripOwnedBlocks(marked, "main"), /legacy peer block/, "a main layer keeps the peer's block");
});

for (const legacyFirst of [true, false]) {
	test(`enabled inherited Chadineer deduplicates child in ${legacyFirst ? "legacy-first" : "policy-first"} order; root still works`, (t) => {
		const runtime = harness(t, { legacy: true, legacyFirst });
		runtime.emit("session_start");
		const root = runtime.before("root role");
		assert.ok(root.systemPrompt.includes(CHADINEER_PROMPT));
		assert.equal(blocks(root.systemPrompt), 1);
		const child = runtime.before(`${CHILD_PREFIXES[0]}\nworker role`);
		assert.doesNotMatch(child.systemPrompt, /Chadineer development guidelines/);
		assert.match(child.systemPrompt, /CHILD draft/);
		assert.doesNotMatch(child.systemPrompt, /chadineer:v1/);
		assert.ok(!child.options.appendSystemPrompt, "no peer block survives a composed child layer");
	});
}

test("multiple owned policy/legacy blocks are removed, never other sections", () => {
	const own = `<agent_policy>\n${policySection("subagent", "stale")}\n</agent_policy>`;
	const legacy = `${LEGACY_START}\nlegacy\n${LEGACY_END}`;
	const output = stripOwnedBlocks(`${CHILD_PREFIXES[0]}\nrole\n${own}\n${own}\n${legacy}\nother section`, "subagent");
	assert.equal(output.split("<agent_policy>").length - 1, 0);
	assert.doesNotMatch(output, /stale|legacy/);
	assert.match(output, /other section/);
	assert.match(stripOwnedBlocks(legacy, "subagent", false), /chadineer:v1/, "an empty composition keeps the peer's block");
	assert.throws(() => stripOwnedBlocks("<agent_policy>\nunterminated", "main"), /unterminated/);
	assert.throws(() => stripOwnedBlocks(LEGACY_START, "subagent"), /unterminated/);
});

test("whitespace-only main file is omitted from the initialization snapshot", (t) => {
	const runtime = harness(t, { configure(directory) {
		writeFileSync(join(directory, "main.md"), "  \n");
	} });
	assert.equal(runtime.before().systemPrompt, runtime.expected("root role", "main", "COMMON draft"));
});

test("UUID identity for file-backed and in-memory sessions, session events, and shutdown dispose only owned registration", (t) => {
	const runtime = harness(t);
	runtime.emit("session_start");
	assert.deepEqual(runtime.registrations[0], { sessionId: "uuid-parent", extensions: [{ id: POLICY_ID, path: join(runtime.directory, "index.ts") }] });
	runtime.before();
	assert.equal(runtime.registrations.length, 1);
	runtime.identity("/sessions/renamed.jsonl", "uuid-parent");
	runtime.before();
	assert.equal(runtime.disposed, 0);
	assert.equal(runtime.registrations.length, 1);
	runtime.identity(undefined, "memory-uuid");
	runtime.before();
	assert.equal(runtime.disposed, 1);
	assert.equal(runtime.registrations[1].sessionId, "memory-uuid");
	runtime.emit("session_shutdown", { reason: "reload" });
	runtime.emit("session_shutdown");
	assert.equal(runtime.disposed, 2);
	runtime.emit("session_start", { reason: "reload" });
	assert.equal(runtime.registrations.length, 3);
	runtime.identity("/sessions/fork.jsonl", "fork-uuid");
	runtime.emit("session_start", { reason: "fork" });
	assert.equal(runtime.disposed, 3);
	assert.equal(runtime.registrations.at(-1).sessionId, "fork-uuid");
	runtime.emit("session_shutdown", { reason: "quit" });
	assert.equal(runtime.disposed, 4);
});

test("registry conflicts surface, never overwrite or dispose another owner", (t) => {
	let calls = 0;
	const runtime = harness(t, { register() { calls++; throw new Error("already registered by another owner"); } });
	assert.throws(() => runtime.emit("session_start"), /another owner/);
	assert.throws(() => runtime.before(), /another owner/);
	assert.equal(runtime.disposed, 0);
	assert.equal(calls, 2);
	assert.equal(runtime.notices.length, 2);
	assert.deepEqual(runtime.noticeTypes, ["error", "error"]);
});

test("deployed main source loads for roots only; empty children and missing skill-only children keep Chadineer independent", (t) => {
	const runtime = harness(t, { deployed: true });
	const mainHeader = `## Policy source: ${join(runtime.directory, "main.md")}`;
	assert.equal(existsSync(new URL("../MAIN_APPEND_SYSTEM.md", import.meta.url)), false);
	const root = runtime.before().systemPrompt;
	assert.ok(root.includes(mainHeader), "shipped main prompt must load non-empty");
	assert.match(root, /<!-- agent-policy:v1:main -->/);
	const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="worker"/>\nrole`;
	assert.equal(runtime.section(prompt), undefined, "empty child composition sets no section");
	assert.equal(runtime.before(prompt).systemPrompt, runtime.base(prompt));
	writeFileSync(join(runtime.directory, "worker.md"), "not automatically loaded");
	runtime.reload();
	assert.equal(runtime.before(prompt).systemPrompt, runtime.base(prompt));
	writeFileSync(join(runtime.directory, "config.json"), JSON.stringify({ agents: { worker: ["worker.md"] } }));
	runtime.reload();
	const active = runtime.before(`${prompt}\n${root}`);
	assert.match(active.systemPrompt, /not automatically loaded/);
	assert.ok(!active.systemPrompt.includes(mainHeader), "an inherited root main block is stripped from children");
	assert.ok(active.sections[POLICY_SECTION]!.includes(CHILD_POLICY_MARKER));
	assert.equal(blocks(active.systemPrompt), 1);
	for (const legacyFirst of [true, false]) {
		const child = harness(t, { deployed: true, legacy: true, legacyFirst, configure(directory) {
			writeFileSync(join(directory, "config.json"), JSON.stringify({ agents: { worker: ["missing.md"] } }));
		} });
		child.emit("session_start");
		assert.equal(child.notices.length, 1);
		// An empty child composition keeps the peer's own block, which it added through the options.
		assert.ok(child.before(prompt).systemPrompt.includes(CHADINEER_PROMPT));
		assert.equal(child.before(prompt).options.appendSystemPrompt, `${LEGACY_START}\n${CHADINEER_PROMPT}\n${LEGACY_END}`);
		const inherited = policySection("subagent", "stale skill");
		const observed = child.before(`${prompt}\n\n<agent_policy>\n${inherited}\n</agent_policy>`);
		assert.doesNotMatch(observed.systemPrompt, /stale skill/);
		assert.equal(observed.systemPrompt.includes(CHADINEER_PROMPT), legacyFirst === false, "legacy hook can observe and skip an inherited child marker before cleanup");
		assert.equal(blocks(observed.systemPrompt), 0);
	}
	writeFileSync(join(runtime.directory, "worker.md"), " \n");
	runtime.reload();
	// The inherited prompt still carries the old child block; an empty composition drops it and adds nothing.
	const cleared = runtime.before(active.systemPrompt);
	assert.equal(cleared.sections[POLICY_SECTION], undefined);
	assert.equal(blocks(active.systemPrompt), 1);
	assert.equal(blocks(cleared.systemPrompt), 0);
	assert.match(cleared.systemPrompt, /root role/);
	assert.doesNotMatch(cleared.systemPrompt, /not automatically loaded|agent-policy:v1:subagent/);
	assert.throws(() => stripOwnedBlocks("<agent_policy>", "subagent"), /unterminated/);
});

for (const role of ["worker", "reviewer", "scout"] as const) {
	test(`${role} composes common + generic child + exact configured source without changing builtin role text`, (t) => {
		const runtime = harness(t);
		const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>\nexisting ${role} duties`;
		assert.equal(selectAgentName(prompt, "subagent"), role);
		const output = runtime.before(prompt);
		assert.ok(output.systemPrompt.startsWith(prompt));
		assert.match(output.systemPrompt, /COMMON draft/);
		assert.match(output.systemPrompt, /CHILD draft/);
		assert.ok(output.systemPrompt.includes(`${role} overlay`));
		assert.ok(output.systemPrompt.indexOf("COMMON draft") < output.systemPrompt.indexOf("CHILD draft"));
		assert.ok(output.systemPrompt.indexOf("CHILD draft") < output.systemPrompt.indexOf(`${role} overlay`));
		assert.equal(runtime.before(prompt).systemPrompt, output.systemPrompt);
		writeFileSync(join(runtime.directory, `${role}.md`), `${role} edited`);
		assert.equal(runtime.before(prompt).systemPrompt, output.systemPrompt);
		runtime.reload();
		assert.ok(runtime.before(prompt).systemPrompt.includes(`${role} edited`));
	});
}

test("root metadata cannot classify children; unknown/unsafe names and absent tags stay generic", (t) => {
	const runtime = harness(t);
	// A bare tag is only a lookalike when nothing follows it; Pi always renders a <cwd> section after custom text.
	assert.equal(selectProfile('<active_agent name="worker"/>\n\n<cwd>\n/tmp/project\n</cwd>', false), "subagent");
	assert.match(runtime.before('root role\n<active_agent name="worker"/>').systemPrompt, /MAIN draft/);
	assert.equal(selectAgentName('<active_agent name="worker"/>', "main"), undefined);
	for (const name of ["custom", "researcher", "oracle", "delegate", "developer", "Worker", "pkg.worker", "../worker", "__proto__", "constructor", "worker&amp;", ""]) {
		const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${name}"/>\n<active_agent name="worker"/>\nquoted role`;
		assert.equal(selectAgentName(prompt, "subagent"), name.replace(/&amp;/g, "&") || undefined, name);
		const output = runtime.before(prompt).systemPrompt;
		assert.match(output, /CHILD draft/);
		assert.doesNotMatch(output, /worker overlay|reviewer overlay|scout overlay/);
	}
	for (const tag of ["", '<active_agent name="worker"/ malformed>', 'quoted: <active_agent name="worker"/>']) {
		assert.equal(selectAgentName(`${CHILD_PREFIXES[0]}\n${tag}`, "subagent"), undefined);
	}
});

test("role and main/child transitions replace one owned section and preserve unmarked prose", (t) => {
	const runtime = harness(t);
	const root = runtime.before().systemPrompt;
	const worker = runtime.before(`${CHILD_PREFIXES[0]}\n<active_agent name="worker"/>\n${root}`).systemPrompt;
	assert.doesNotMatch(worker, /MAIN draft/);
	const reviewer = runtime.before(worker.replace('name="worker"', 'name="reviewer"')).systemPrompt;
	assert.doesNotMatch(reviewer, /worker overlay/);
	assert.match(reviewer, /reviewer overlay/);
	const generic = runtime.before(reviewer.replace('name="reviewer"', 'name="custom"')).systemPrompt;
	assert.doesNotMatch(generic, /reviewer overlay/);
	const main = runtime.before(generic.replace(CHILD_PREFIXES[0], "root")).systemPrompt;
	assert.match(main, /MAIN draft/);
	assert.doesNotMatch(main, /CHILD draft/);
	assert.equal(blocks(main), 1);
});

for (const filename of ["common.md", "main.md", "child.md", "worker.md", "reviewer.md", "scout.md"]) {
	test(`missing configured ${filename} warns before prompt, preserves siblings, and blanks omit quietly`, (t) => {
		const runtime = harness(t, { configure(directory) { unlinkSync(join(directory, filename)); } });
		runtime.emit("session_start");
		assert.equal(runtime.notices.length, 1);
		assert.ok(runtime.notices[0].includes(filename));
		assert.match(runtime.notices[0], /ENOENT/);
		const role = filename.endsWith("er.md") || filename === "scout.md" ? filename.slice(0, -3) : "worker";
		const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>`;
		const output = runtime.before(prompt).systemPrompt;
		assert.ok(output.startsWith(prompt));
		if (filename !== "common.md") assert.match(output, /COMMON draft/);
		if (filename !== "child.md") assert.match(output, /CHILD draft/);
		runtime.emit("session_start", { reason: "resume" });
		runtime.before();
		assert.equal(runtime.notices.length, 1);
		const blank = harness(t, { configure(directory) { writeFileSync(join(directory, filename), " \n"); } });
		blank.before(prompt);
		assert.deepEqual(blank.notices, []);
	});
}

test("unreadable source warns rather than aborting runtime creation", (t) => {
	const runtime = harness(t, { configure(directory) {
		unlinkSync(join(directory, "scout.md")); mkdirSync(join(directory, "scout.md"));
	} });
	runtime.before();
	assert.match(runtime.notices[0], /agents\["scout"\]\[0\].*EISDIR/);
	assert.match(runtime.before().systemPrompt, /MAIN draft/);
});

test("config and all unique sources are read once at initialization, never on runs or session/tree events", (t) => {
	const originalRead = fs.readFileSync;
	const reads = t.mock.method(fs, "readFileSync", (...args: any[]) => Reflect.apply(originalRead, fs, args));
	syncBuiltinESMExports();
	try {
		const runtime = harness(t);
		assert.equal(reads.mock.callCount(), 8);
		for (const call of reads.mock.calls.filter((call: any) => !String(call.arguments[0]).endsWith("config.json"))) writeFileSync(call.arguments[0], "edited before first prompt");
		for (const reason of ["startup", "resume", "fork", "reload"]) runtime.emit("session_start", { reason });
		runtime.emit("session_tree");
		assert.match(runtime.before().systemPrompt, /MAIN draft/);
		for (const role of ["worker", "reviewer", "scout"]) {
			const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>`;
			const output = runtime.before(prompt);
			assert.equal(output.systemPrompt, runtime.expected(prompt, "subagent", `COMMON draft\n\nCHILD draft\n\n${role} overlay`));
			assert.equal(runtime.before(prompt).systemPrompt, output.systemPrompt);
		}
		assert.equal(reads.mock.callCount(), 8);
		runtime.reload();
		assert.equal(reads.mock.callCount(), 16);
		assert.match(runtime.before().systemPrompt, /edited before first prompt/);
		rmSync(runtime.directory, { recursive: true });
		assert.match(runtime.before().systemPrompt, /edited before first prompt/);
		assert.equal(reads.mock.callCount(), 16);
		runtime.reload();
		assert.equal(runtime.section(), undefined);
		assert.equal(runtime.before().systemPrompt, runtime.base("root role"));
		assert.match(runtime.notices[0], /config.json.*ENOENT/);
	} finally { reads.mock.restore(); syncBuiltinESMExports(); }
});

const bbTuple = { PI_AGENT_POLICY_BB_PROFILE: "workflow-worker:v1", BB_THREAD_ID: "bb-thread", PI_AGENT_POLICY_BB_THREAD_ID: "bb-thread" };
const bbStates = [
	{}, { BB_THREAD_ID: "bb-thread" }, bbTuple,
	{ ...bbTuple, PI_AGENT_POLICY_BB_PROFILE: "none:v1" },
	{ ...bbTuple, PI_AGENT_POLICY_BB_PROFILE: "unknown" },
	{ ...bbTuple, PI_AGENT_POLICY_BB_THREAD_ID: undefined },
	{ ...bbTuple, PI_AGENT_POLICY_BB_THREAD_ID: "other" },
];

test("BB-only tuple composes generic child, never arbitrary/inherited named sources", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal(bbTuple) });
	for (const role of ["worker", "reviewer", "scout", "custom"]) {
		const prompt = `<active_agent name="${role}"/>\nBB instructions\nquoted: ${CHILD_PREFIXES[0]}`;
		const output = runtime.before(prompt);
		assert.equal(output.systemPrompt, runtime.expected(prompt, "subagent", "COMMON draft\n\nCHILD draft"));
		assert.deepEqual(output.returns, []);
		assert.equal(runtime.before(prompt).systemPrompt, output.systemPrompt);
	}
	assert.deepEqual(runtime.notices, []);
	assert.equal(runtime.registrations.length, 1);
	assert.deepEqual(runtime.registrations[0], { sessionId: "uuid-parent", extensions: [{ id: POLICY_ID, path: join(runtime.directory, "index.ts") }] });
});

test("all own marker states preserve native named sources, while roots follow the BB-origin main layer", (t) => {
	for (const env of bbStates) {
		const bbSignal = parseBBPolicySignal(env);
		for (const bbOrigin of [false, true]) {
			const root = harness(t, { bbSignal, bbOrigin });
			const layer = bbSignal.workflowWorker ? "subagent" : bbOrigin ? "main-bb" : "main";
			const body = bbSignal.workflowWorker ? "CHILD draft" : bbOrigin ? "MAIN BB draft" : "MAIN draft";
			assert.equal(root.before().systemPrompt, root.expected("root role", layer, `COMMON draft\n\n${body}`));
			for (const backgroundChild of [true, false]) {
				const native = harness(t, { backgroundChild, bbSignal, bbOrigin });
				for (const prefix of backgroundChild ? [""] : CHILD_PREFIXES) {
					for (const role of ["worker", "reviewer", "scout"]) {
						const prompt = `${prefix}\n<active_agent name="${role}"/>\nbody`;
						assert.equal(native.before(prompt).systemPrompt, native.expected(prompt, "subagent", `COMMON draft\n\nCHILD draft\n\n${role} overlay`));
					}
				}
			}
		}
	}
});

test("malformed own signal warns once per runtime, including headless; absence and neutral are quiet", (t) => {
	for (const env of bbStates) {
		const bbSignal = parseBBPolicySignal(env);
		const runtime = harness(t, { bbSignal });
		runtime.emit("session_start");
		runtime.before();
		runtime.emit("session_start", { reason: "resume" });
		runtime.before();
		assert.deepEqual(runtime.notices, bbSignal.diagnostic ? [bbSignal.diagnostic] : []);
		runtime.reload();
		assert.equal(runtime.notices.length, bbSignal.diagnostic ? 2 : 0);
	}
	const diagnostic = parseBBPolicySignal({ ...bbTuple, PI_AGENT_POLICY_BB_PROFILE: "secret" });
	const handlers = new Map<string, Handler>();
	const calls: string[] = [];
	t.mock.method(console, "error", (message: string) => calls.push(message));
	installAgentPolicy({ on(event: string, handler: Handler) { handlers.set(event, handler); } } as any, {
		policyDir: harness(t).directory, extensionPath: "fixture", backgroundChild: false, bbSignal: diagnostic,
		register: () => ({ dispose() {} }) as any,
	});
	const ctx = { hasUI: false, mode: "print", sessionManager: { getSessionId: () => "headless" }, ui: { notify() { assert.fail("headless warning must log instead"); } } };
	handlers.get("session_start")!({}, ctx);
	handlers.get("before_agent_start")!({ systemPrompt: "root", systemPromptOptions: { sections: {} } }, ctx);
	assert.deepEqual(calls, [diagnostic.diagnostic]);
});

test("a UI host outside the TUI reports diagnostics on stderr too, once per runtime", (t) => {
	// BB runs RPC: ctx.hasUI is true but its notify is dropped, so stderr is the channel that survives.
	const runtime = harness(t, { configure(directory) {
		writeFileSync(join(directory, "config.json"), JSON.stringify({ common: ["common.md"], typo: [] }));
	} });
	const errors: string[] = [];
	t.mock.method(console, "error", (message: string) => errors.push(message));
	runtime.ctx.mode = "rpc";
	runtime.emit("session_start");
	assert.equal(runtime.notices.length, 1);
	assert.deepEqual(errors, runtime.notices);
	runtime.emit("session_start", { reason: "resume" });
	runtime.before();
	assert.equal(runtime.notices.length, 1, "reported once per runtime");
	assert.equal(errors.length, 1);
	runtime.reload();
	assert.equal(errors.length, 2, "a fresh snapshot reports its own diagnostics");
	runtime.ctx.mode = "tui";
	const quiet: string[] = [];
	t.mock.method(console, "error", (message: string) => quiet.push(message));
	runtime.reload();
	assert.equal(runtime.notices.length, 3);
	assert.deepEqual(quiet, [], "a real TUI reports through notify only");
});

test("BB worker clears complete stale main/role blocks even with deployed empty child policy", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal(bbTuple), deployed: true });
	const prompt = '<active_agent name="worker"/>\nBB body';
	const staleMain = `<agent_policy>\n${policySection("main", "stale main")}\n</agent_policy>`;
	const staleRole = `<agent_policy>\n${policySection("subagent", "stale worker overlay")}\n</agent_policy>`;
	const cleaned = runtime.before(`${prompt}\n${staleMain}\n${staleRole}\ninherited unmarked prose`);
	assert.equal(runtime.section(prompt), undefined);
	assert.equal(cleaned.options.forceSystemPrompt, undefined, "an empty composition forces nothing either");
	assert.equal(cleaned.systemPrompt, runtime.base(`${prompt}\ninherited unmarked prose`));
	assert.equal(runtime.before(prompt).systemPrompt, runtime.base(prompt));
	assert.equal(runtime.before(prompt).systemPrompt, runtime.base(prompt), "a repeated run composes nothing again");
	assert.equal(blocks(cleaned.systemPrompt), 0);
});

test("BB env/prompt/history lookalikes alone cannot classify a root", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal({ BB_THREAD_ID: "bb-thread" }) });
	const prompt = `ROOT\nPI_AGENT_POLICY_BB_PROFILE=workflow-worker:v1\nPI_AGENT_POLICY_BB_THREAD_ID=bb-thread\n<active_agent name="worker"/>\nquoted: ${CHILD_PREFIXES[0]}`;
	assert.equal(runtime.before(prompt).systemPrompt, runtime.expected(prompt, "main", "COMMON draft\n\nMAIN draft"));
});

test("BB-origin roots replace the main layer, mark it distinctly and reject stale blocks", (t) => {
	const runtime = harness(t, { bbOrigin: true });
	const bbBodies = "COMMON draft\n\nMAIN BB draft";
	const first = runtime.before();
	assert.equal(first.systemPrompt, runtime.expected("root role", "main-bb", bbBodies));
	assert.match(first.systemPrompt, /<!-- agent-policy:v1:main-bb -->/);
	assert.doesNotMatch(first.systemPrompt, /<!-- agent-policy:v1:main -->/);
	assert.doesNotMatch(first.systemPrompt, /MAIN draft/);
	// An inherited ordinary main block is replaced, not appended to.
	const stale = `<agent_policy>\n${policySection("main", "stale ordinary main")}\n</agent_policy>`;
	const replaced = runtime.before(`root role\n\n${stale}`);
	assert.equal(replaced.systemPrompt, runtime.expected(`root role`, "main-bb", bbBodies));
	assert.doesNotMatch(replaced.systemPrompt, /stale ordinary main/);
	assert.equal(runtime.before(`root role\n\n${stale}`).sections[POLICY_SECTION], first.sections[POLICY_SECTION]);
	// A BB worker keeps child composition and never receives the BB main layer.
	const worker = `${CHILD_PREFIXES[0]}\nworker role`;
	assert.equal(runtime.before(worker).systemPrompt, runtime.expected(worker, "subagent", "COMMON draft\n\nCHILD draft"));
});

test("empty mainBb stays empty for BB roots: no fallback to the ordinary main layer", (t) => {
	const runtime = harness(t, { bbOrigin: true, configure(directory) {
		writeFileSync(join(directory, "config.json"), JSON.stringify({ common: ["common.md"], main: ["main.md"], child: ["child.md"], agents: {} }));
	} });
	const output = runtime.before();
	assert.match(output.systemPrompt, /COMMON draft/);
	assert.match(output.systemPrompt, /<!-- agent-policy:v1:main-bb -->/);
	assert.doesNotMatch(output.systemPrompt, /MAIN draft|<!-- agent-policy:v1:main -->/);
	// Ordinary hosts are unaffected by the additional layer.
	const plain = harness(t);
	assert.equal(plain.before().systemPrompt, plain.expected("root role", "main", "COMMON draft\n\nMAIN draft"));
	const deployed = harness(t, { deployed: true, bbOrigin: true });
	const deployedBbHeader = `## Policy source: ${join(deployed.directory, "main-bb.md")}`;
	const deployedRoot = deployed.before().systemPrompt;
	assert.ok(deployedRoot.includes(deployedBbHeader), "shipped BB main prompt must load non-empty");
	assert.match(deployedRoot, /<!-- agent-policy:v1:main-bb -->/);
	assert.ok(!deployedRoot.includes(`## Policy source: ${join(deployed.directory, "main.md")}`), "BB roots never fall back to the ordinary main prompt");
});

test("missing main and mainBb prompt files warn, skip only that layer, and keep siblings plus the extension working", (t) => {
	const ordinary = harness(t, { configure(directory) { unlinkSync(join(directory, "main.md")); } });
	ordinary.emit("session_start");
	assert.equal(ordinary.notices.length, 1);
	assert.match(ordinary.notices[0], /main\[0\].*main\.md.*ENOENT/);
	const root = ordinary.before().systemPrompt;
	assert.match(root, /COMMON draft/);
	assert.ok(!root.includes(`## Policy source: ${join(ordinary.directory, "main.md")}`), "the missing main prompt is skipped, not synthesized");
	assert.match(root, /<!-- agent-policy:v1:main -->/);
	assert.equal(ordinary.registrations.length, 1, "the extension still registers for children");
	const child = ordinary.before(`${CHILD_PREFIXES[0]}\n<active_agent name="worker"/>\nworker role`).systemPrompt;
	assert.match(child, /COMMON draft[\s\S]*CHILD draft/);
	assert.match(child, /worker overlay/);
	assert.equal(ordinary.notices.length, 1, "the warning is reported once per runtime");

	const bb = harness(t, { bbOrigin: true, configure(directory) { unlinkSync(join(directory, "main-bb.md")); } });
	bb.emit("session_start");
	assert.equal(bb.notices.length, 1);
	assert.match(bb.notices[0], /mainBb\[0\].*main-bb\.md.*ENOENT/);
	const bbRoot = bb.before().systemPrompt;
	assert.match(bbRoot, /COMMON draft/);
	assert.ok(!bbRoot.includes(`## Policy source: ${join(bb.directory, "main-bb.md")}`), "the missing BB prompt is skipped, not synthesized");
	assert.ok(!bbRoot.includes(`## Policy source: ${join(bb.directory, "main.md")}`), "no fallback to the ordinary main prompt");
	assert.match(bbRoot, /<!-- agent-policy:v1:main-bb -->/);
	assert.equal(bb.registrations.length, 1);
});

function nativeLayout(role: string, boundary: string, append = false, structured = false): string {
	const tagged = `<active_agent name="${role}"/>\n\nexisting ${role} role body`;
	const base = append ? `Pi base\n\n<addendum>\n${tagged}\n</addendum>\n\n<cwd>\n/tmp/project\n</cwd>` : tagged;
	return `${base}\n\n${boundary}${structured ? `\n\n${NATIVE_STRUCTURED_OUTPUT_SUFFIX}` : ""}`;
}

test("0.76.1 complete native ordinary/fanout replace/append layouts retain named sources ahead of every BB signal", (t) => {
	for (const env of bbStates) {
		const runtime = harness(t, { bbSignal: parseBBPolicySignal(env) });
		for (const boundary of NATIVE_CHILD_BOUNDARIES) {
			for (const append of [false, true]) {
				for (const structured of [false, true]) {
					for (const role of ["worker", "reviewer", "scout", "custom", "../worker", "worker&amp;"]) {
						const prompt = nativeLayout(role, boundary, append, structured);
						assert.equal(selectProfile(prompt, false), "subagent");
						const overlay = ["worker", "reviewer", "scout"].includes(role) ? `\n\n${role} overlay` : "";
						const output = runtime.before(prompt);
						assert.equal(output.systemPrompt, runtime.expected(prompt, "subagent", `COMMON draft\n\nCHILD draft${overlay}`));
						assert.equal(blocks(output.systemPrompt), 1);
					}
				}
			}
		}
	}
});

test("native routing rejects misplaced/root-only tags and malformed launch layouts", (t) => {
	const runtime = harness(t);
	for (const boundary of NATIVE_CHILD_BOUNDARIES) {
		const valid = nativeLayout("worker", boundary);
		for (const prompt of [
			`ROOT\n\n${boundary}`,
			`ROOT\n\n<active_agent name="worker"/>\n\nrole\n\n${boundary}`,
			valid.replace('name="worker"/>', "name='worker'/>"),
			valid.replace('name="worker"/>', 'name="worker" extra="yes"/>'),
			valid.replace('/>\n\n', '/>\n'),
			nativeLayout("worker", boundary, true).replace('<addendum>\n', '<addendum>\nquoted text\n'),
			nativeLayout("worker", boundary, true).replace("\n</addendum>", ""),
		]) {
			assert.equal(selectProfile(prompt, false), "main", prompt);
			assert.equal(runtime.before(prompt).systemPrompt, runtime.expected(prompt, "main", "COMMON draft\n\nMAIN draft"));
		}
	}
});

test("appended native layout cleans inherited main blocks with empty policy and keeps Chadineer independent", (t) => {
	for (const legacyFirst of [false, true]) {
		for (const deployed of [false, true]) {
			const runtime = harness(t, { legacy: true, legacyFirst, deployed });
			runtime.emit("session_start");
			const parent = `<agent_policy>\n${policySection("main", "stale main")}\n</agent_policy>`;
			const prompt = nativeLayout("worker", NATIVE_CHILD_BOUNDARIES[0]).replace("existing worker role body", `existing worker role body\n${parent}`);
			const output = runtime.before(prompt);
			assert.doesNotMatch(output.systemPrompt, /stale main|MAIN draft/);
			assert.match(output.systemPrompt, /inherited parent prose|existing worker role body/);
			if (deployed) {
				assert.equal(blocks(output.systemPrompt), 0);
				assert.ok(output.options.appendSystemPrompt.includes(CHADINEER_PROMPT));
			} else {
				assert.match(output.systemPrompt, /CHILD draft[\s\S]*worker overlay/);
				assert.ok(!output.systemPrompt.includes(CHADINEER_PROMPT));
			}
			assert.equal(blocks(output.systemPrompt), deployed ? 0 : 1);
		}
	}
});

test("complete appended layout routes its launch tag rather than quoted preamble or role tags", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal(bbTuple) });
	const prompt = nativeLayout("reviewer", NATIVE_CHILD_BOUNDARIES[0], true)
		.replace("Pi base", 'Pi base\n<active_agent name="scout"/>\nquoted preamble')
		.replace("existing reviewer role body", 'existing reviewer role body\n<active_agent name="worker"/>\nquoted role tag');
	assert.equal(selectAgentName(prompt, "subagent"), "reviewer");
	assert.equal(runtime.before(prompt).systemPrompt, runtime.expected(prompt, "subagent", "COMMON draft\n\nCHILD draft\n\nreviewer overlay"));
});

test("0.77.0 pre-boundary launch headers route strict replace/append layouts; exact root lookalikes are deliberately ambiguous", (t) => {
	const runtime = harness(t);
	for (const append of [false, true]) {
		const complete = nativeLayout("reviewer", NATIVE_CHILD_BOUNDARIES[0], append);
		const prompt = complete.slice(0, -NATIVE_CHILD_BOUNDARIES[0].length - 2);
		assert.equal(selectProfile(prompt, false), "subagent", "boundary is not yet installed at the ordinary hook");
		assert.match(runtime.before(prompt).systemPrompt, /CHILD draft[\s\S]*reviewer overlay/);
		assert.doesNotMatch(runtime.before(prompt).systemPrompt, /MAIN draft/);
		if (append) {
			assert.equal(selectProfile(prompt.replace("\n</addendum>", "\n</addendum> malformed"), false), "main");
			assert.equal(selectProfile('Pi base\n\n```xml\n\n<addendum>\n<active_agent name="reviewer"/>\n\nquoted body\n</addendum>\n```', false), "main");
		}
		// A root intentionally using this exact SYSTEM layout also routes as child.
		assert.equal(selectProfile(prompt, false), "subagent", "routing is not authentication");
		for (const suffix of ["quoted boundary", NATIVE_CHILD_BOUNDARIES[0].slice(0, -1), "more root instructions"]) {
			assert.equal(selectProfile(`${prompt}\n\n${suffix}`, false), "subagent", "valid launch header does not wait for/validate a later boundary");
		}
	}
	for (const prompt of ['<active_agent name="worker"/>', '<active_agent name="worker"/>\nroot', 'quoted: <active_agent name="worker"/>\n\nroot', '> <active_agent name="worker"/>\n\nroot', '<active_agent name=""/>\n\nroot', '<active_agent name="worker" extra="yes"/>\n\nroot', "<active_agent name='worker'/>\n\nroot", 'ROOT\n<active_agent name="worker"/>\n\nroot', 'Pi base\n\n<addendum>\nquoted\n<active_agent name="worker"/>\n\nroot\n</addendum>']) {
		assert.equal(selectProfile(prompt, false), "main", prompt);
	}
});

function configureSkills(directory: string) {
	writeFileSync(join(directory, "first.md"), "---\nname: first\n---\nFIRST full body\n[reference](refs/check.md)\n");
	writeFileSync(join(directory, "second.md"), "SECOND full body\n");
	writeFileSync(join(directory, "config.json"), JSON.stringify({ common: ["common.md"], child: ["child.md"], main: ["main.md", "first.md", "second.md"], agents: JSON.parse('{"worker":["worker.md","second.md"],"reviewer":["reviewer.md","first.md"],"security-reviewer":["first.md","second.md"],"__proto__":["first.md"],"constructor":["second.md"],"special&name":["second.md"]}') }));
}

test("runtime appends ordered full skills after policy layers, routes exact independent names, and replaces stale role blocks", (t) => {
	const runtime = harness(t, { configure: configureSkills });
	const root = runtime.before().systemPrompt;
	assert.match(root, /COMMON draft[\s\S]*MAIN draft[\s\S]*FIRST full body[\s\S]*SECOND full body/);
	assert.ok(root.includes(`Resolve this source's relative file references against ${runtime.directory}.`));
	assert.doesNotMatch(root, /name: first/);
	for (const [name, first, second, overlay] of [["worker", false, true, true], ["reviewer", true, false, true], ["security-reviewer", true, true, false], ["unknown", false, false, false], ["developer", false, false, false], ["__proto__", true, false, false], ["constructor", false, true, false], ["toString", false, false, false], ["special&amp;name", false, true, false]] as const) {
		const prompt = `<active_agent name="${name}"/>\n\noriginal ${name} role\n${root}`;
		const output = runtime.before(prompt).systemPrompt;
		assert.equal(output.includes("FIRST full body"), first, name);
		assert.equal(output.includes("SECOND full body"), second, name);
		assert.equal(output.includes(`${name} overlay`), overlay, name);
		assert.doesNotMatch(output, /MAIN draft/);
		assert.match(output, /COMMON draft[\s\S]*CHILD draft/);
		assert.equal(blocks(output), 1);
		assert.match(output, new RegExp(`original ${name} role`));
		assert.equal(runtime.before(prompt).systemPrompt, output);
	}
	const worker = runtime.before('<active_agent name="worker"/>\n\noriginal role').systemPrompt;
	const reviewer = runtime.before(worker.replace('name="worker"', 'name="reviewer"')).systemPrompt;
	assert.doesNotMatch(reviewer, /worker overlay|SECOND full body/);
	assert.match(reviewer, /reviewer overlay[\s\S]*FIRST full body/);
});

test("skills and config, including unused mappings, are eagerly frozen before first prompt until runtime reload", (t) => {
	const runtime = harness(t, { configure: configureSkills });
	writeFileSync(join(runtime.directory, "first.md"), "CHANGED FIRST");
	writeFileSync(join(runtime.directory, "second.md"), "CHANGED SECOND");
	writeFileSync(join(runtime.directory, "config.json"), JSON.stringify({ main: ["second.md"], agents: { "security-reviewer": ["first.md"] } }));
	runtime.emit("session_start", { reason: "reload" });
	runtime.emit("session_tree");
	assert.match(runtime.before().systemPrompt, /FIRST full body[\s\S]*SECOND full body/);
	const prompt = '<active_agent name="security-reviewer"/>\n\nrole';
	assert.match(runtime.before(prompt).systemPrompt, /FIRST full body[\s\S]*SECOND full body/);
	runtime.reload();
	assert.match(runtime.before().systemPrompt, /CHANGED SECOND/);
	assert.doesNotMatch(runtime.before().systemPrompt, /FIRST full body|CHANGED FIRST/);
	assert.match(runtime.before(prompt).systemPrompt, /CHANGED FIRST/);
	assert.doesNotMatch(runtime.before(prompt).systemPrompt, /CHANGED SECOND/);
	rmSync(runtime.directory, { recursive: true });
	assert.match(runtime.before(prompt).systemPrompt, /CHANGED FIRST/, "hooks perform no filesystem reads");
});

test("BB-only workers get no main or named skills; native pre-boundary launch takes precedence", (t) => {
	const runtime = harness(t, { configure: configureSkills, bbSignal: parseBBPolicySignal(bbTuple) });
	const generic = runtime.before('<active_agent name="worker"/>\nBB body').systemPrompt;
	assert.doesNotMatch(generic, /full body|worker overlay|MAIN draft/);
	const native = runtime.before('<active_agent name="worker"/>\n\nnative body').systemPrompt;
	assert.match(native, /worker overlay[\s\S]*SECOND full body/);
	assert.doesNotMatch(native, /FIRST full body|MAIN draft/);
});

for (const legacyFirst of [true, false]) {
	test(`skill-only child composition preserves Chadineer strip/skip in ${legacyFirst ? "legacy-first" : "policy-first"} order`, (t) => {
		const runtime = harness(t, { deployed: true, legacy: true, legacyFirst, configure: configureSkills });
		runtime.emit("session_start");
		const prompt = '<active_agent name="worker"/>\n\noriginal worker body';
		const child = runtime.before(prompt).systemPrompt;
		assert.ok(child.includes(CHILD_POLICY_MARKER));
		assert.match(child, /SECOND full body/);
		assert.doesNotMatch(child, /chadineer:v1:|Chadineer development guidelines|FIRST full body/);
		assert.ok(child.startsWith(prompt));
		assert.equal(runtime.before(prompt).systemPrompt, child);
	});
}


test("canonical names decode only upstream XML escapes; older complete boundaries retain blank-body routing", () => {
	for (const [encoded, name] of [["special&amp;name", "special&name"], ["quoted&quot;name", 'quoted"name'], ["less&lt;greater&gt;", "less<greater>"], ["literal&amp;quot;", "literal&quot;"]] as const) {
		const prompt = `<active_agent name="${encoded}"/>\n\nbody`;
		assert.equal(selectProfile(prompt, false), "subagent");
		assert.equal(selectAgentName(prompt, "subagent"), name);
		assert.equal(selectAgentName(prompt, "subagent"), name);
	}
	for (const encoded of ["bad&name", "bad&unknown;", "bad&#34;"]) {
		assert.equal(selectProfile(`<active_agent name="${encoded}"/>\n\nbody`, false), "main");
	}
	for (const role of ["", "worker"]) {
		const prompt = `<active_agent name="${role}"/>\n\n\n\n${NATIVE_CHILD_BOUNDARIES[0]}`;
		assert.equal(selectProfile(prompt, false), "subagent", "old complete-boundary layout still works without a nonblank role body");
	}
});

test("manifest layers compose common then main or child then exact name, deduplicating first occurrences", (t) => {
	const runtime = harness(t, { configure(directory) {
		for (const name of ["a", "b", "c", "d"]) writeFileSync(join(directory, `${name}.md`), `${name.toUpperCase()} layer body`);
		writeFileSync(join(directory, "config.json"), JSON.stringify({ all: ["b.md", "a.md", "./b.md"], orchestrator: ["d.md", "a.md"], child: ["c.md", "a.md"], agents: { "security-reviewer": ["a.md", "d.md", "c.md"] } }));
	} });
	const bodies = (prompt: string) => [...prompt.matchAll(/([A-D]) layer body/g)].map((match) => match[1]);
	assert.deepEqual(bodies(runtime.before().systemPrompt), ["B", "A", "D"]);
	assert.deepEqual(bodies(runtime.before('<active_agent name="security-reviewer"/>\n\nNative persona').systemPrompt), ["B", "A", "C", "D"]);
	for (const prompt of [`${CHILD_PREFIXES[0]}\nunnamed persona`, '<active_agent name="unknown"/>\n\nNative persona']) {
		assert.deepEqual(bodies(runtime.before(prompt).systemPrompt), ["B", "A", "C"]);
	}
	assert.deepEqual(runtime.notices, []);
	const generic = harness(t, { bbSignal: parseBBPolicySignal(bbTuple), configure(directory) {
		writeFileSync(join(directory, "config.json"), JSON.stringify({ common: ["common.md"], child: ["child.md"], agents: { worker: ["worker.md"] } }));
	} });
	assert.match(generic.before('<active_agent name="worker"/>\nBB persona').systemPrompt, /COMMON draft[\s\S]*CHILD draft/);
	assert.doesNotMatch(generic.before('<active_agent name="worker"/>\nBB persona').systemPrompt, /worker overlay/);
});

test("file diagnostics reach UI once before first prompt and refresh only with a new runtime", (t) => {
	const runtime = harness(t, { configure(directory) {
		writeFileSync(join(directory, "config.json"), JSON.stringify({ common: ["common.md"], agents: { unused: ["missing.md"] }, typo: [] }));
	} });
	runtime.emit("session_start");
	assert.equal(runtime.notices.length, 2, "warnings precede the first prompt");
	assert.deepEqual(runtime.noticeTypes, ["warning", "warning"]);
	assert.match(runtime.notices.join("\n"), /unknown top-level key/);
	assert.match(runtime.notices.join("\n"), /agents\["unused"\]\[0\].*ENOENT/);
	writeFileSync(join(runtime.directory, "missing.md"), "now present");
	for (const reason of ["resume", "fork", "reload"]) runtime.emit("session_start", { reason });
	runtime.emit("session_tree");
	assert.match(runtime.before().systemPrompt, /COMMON draft/);
	assert.equal(runtime.notices.length, 2);
	runtime.reload();
	assert.equal(runtime.notices.length, 3, "only still-invalid input warns in new snapshot");
});

test("config diagnostics report on first before hook without session_start, headlessly once alongside BB diagnostics", (t) => {
	const directory = harness(t).directory;
	writeFileSync(join(directory, "config.json"), "{bad JSON");
	const diagnostic = parseBBPolicySignal({ ...bbTuple, PI_AGENT_POLICY_BB_PROFILE: "unknown" });
	const handlers = new Map<string, Handler>();
	const warnings: string[] = [];
	t.mock.method(console, "error", (message: string) => warnings.push(message));
	installAgentPolicy({ on(event: string, handler: Handler) { handlers.set(event, handler); } } as any, {
		policyDir: directory, extensionPath: "fixture", backgroundChild: false, bbSignal: diagnostic,
		register: () => ({ dispose() {} }) as any,
	});
	const ctx = { hasUI: false, mode: "print", sessionManager: { getSessionId: () => "headless-config" }, ui: { notify() { assert.fail("headless warning must log instead"); } } };
	const options: any = { sections: {} };
	assert.deepEqual(handlers.get("before_agent_start")!({ systemPrompt: "root", systemPromptOptions: options }, ctx), undefined);
	assert.deepEqual(options.sections, {});
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /config.json.*JSON/);
	assert.equal(warnings[1], diagnostic.diagnostic);
	for (const event of ["session_start", "before_agent_start", "session_start"]) handlers.get(event)!({ systemPrompt: "root", systemPromptOptions: { sections: {} } }, ctx);
	assert.equal(warnings.length, 2);
});
