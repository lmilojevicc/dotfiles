import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import chadineer, { CHADINEER_PROMPT, CHADINEER_STATE_ENTRY } from "../../chadineer/index.ts";
import { appendPolicy, CHILD_PREFIXES, NATIVE_CHILD_BOUNDARIES, NATIVE_STRUCTURED_OUTPUT_SUFFIX, CHILD_POLICY_MARKER, LEGACY_START, LEGACY_END, POLICY_START, POLICY_END, selectAgentName, selectProfile, selectRole } from "../child-profile.ts";
import { installAgentPolicy, POLICY_ID } from "../runtime.ts";
import { parseBBPolicySignal, type BBPolicySignal } from "../bb-profile.ts";

type Handler = (...args: any[]) => any;
function harness(t: any, { backgroundChild = false, bbSignal = undefined as BBPolicySignal | undefined, register = undefined as any, legacyFirst = false, legacy = false, deployed = false, configure = (_directory: string) => {} } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "agent-policy-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "COMMON_APPEND_SYSTEM.md"), "COMMON draft");
	mkdirSync(join(directory, "roles"));
	for (const role of ["worker", "reviewer", "scout"]) writeFileSync(join(directory, "roles", `${role}.md`), `${role} overlay`);
	writeFileSync(join(directory, "ORCHESTRATOR_APPEND_SYSTEM.md"), "MAIN draft");
	writeFileSync(join(directory, "SUBAGENT_APPEND_SYSTEM.md"), "CHILD draft");
	if (deployed) {
		for (const file of ["ORCHESTRATOR_APPEND_SYSTEM.md", "COMMON_APPEND_SYSTEM.md", "SUBAGENT_APPEND_SYSTEM.md", "roles/worker.md", "roles/reviewer.md", "roles/scout.md"]) {
			writeFileSync(join(directory, file), readFileSync(new URL(`../${file}`, import.meta.url)));
		}
	}
	const handlers = new Map<string, Handler[]>();
	const notices: string[] = [];
	const registrations: any[] = [];
	let disposed = 0;
	let sessionFile: string | undefined = "/sessions/parent.jsonl";
	let sessionId = "uuid-parent";
	const api = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand() {}, appendEntry() {},
	};
	const ctx = {
		hasUI: true,
		ui: { notify(message: string) { notices.push(message); }, setStatus() {} },
		sessionManager: {
			getSessionFile: () => sessionFile, getSessionId: () => sessionId,
			getBranch: () => [{ type: "custom", customType: CHADINEER_STATE_ENTRY, data: { enabled: true } }],
		},
	};
	function install() {
		if (legacy && legacyFirst) chadineer(api as any);
		installAgentPolicy(api as any, {
			policyDir: directory, extensionPath: join(directory, "index.ts"), backgroundChild, bbSignal,
			register: register ?? ((input: any) => { registrations.push(input); return { dispose() { disposed++; } }; }),
		});
		if (legacy && !legacyFirst) chadineer(api as any);
	}
	configure(directory);
	install();
	function emit(event: string, input: any = {}) { for (const fn of handlers.get(event) ?? []) fn(input, ctx); }
	return {
		directory, registrations, notices, get disposed() { return disposed; }, emit,
		reload() {
			emit("session_shutdown", { reason: "reload" });
			handlers.clear();
			install();
			emit("session_start", { reason: "reload" });
		},
		identity(file: string | undefined, uuid: string) { sessionFile = file; sessionId = uuid; },
		before(systemPrompt = "root role") {
			const returns: any[] = [];
			for (const fn of handlers.get("before_agent_start") ?? []) {
				const result = fn({ systemPrompt }, ctx);
				if (result) { returns.push(result); systemPrompt = result.systemPrompt; }
			}
			return { systemPrompt, returns };
		},
	};
}

test("native adapter distinguishes root, foreground/fork, background and explicit fanout", () => {
	assert.equal(selectProfile("root role", false), "main");
	for (const prefix of CHILD_PREFIXES) assert.equal(selectProfile(`\n${prefix}\nworker role`, false), "subagent");
	assert.equal(selectProfile("background role", true), "subagent");
	assert.equal(selectProfile(`quoted later: ${CHILD_PREFIXES[0]}`, false), "main");
});

test("root reapplies its initialization snapshot to each base prompt until runtime reload", (t) => {
	const runtime = harness(t);
	runtime.emit("session_start");
	const first = runtime.before();
	assert.deepEqual(Object.keys(first.returns[0]), ["systemPrompt"]);
	assert.ok(first.systemPrompt.startsWith("root role"));
	assert.match(first.systemPrompt, /MAIN draft/);
	assert.match(first.systemPrompt, /COMMON draft/);
	assert.doesNotMatch(first.systemPrompt, /CHILD draft/);
	assert.ok(first.systemPrompt.indexOf("COMMON draft") < first.systemPrompt.indexOf("MAIN draft"));
	writeFileSync(join(runtime.directory, "ORCHESTRATOR_APPEND_SYSTEM.md"), "MAIN edited");
	writeFileSync(join(runtime.directory, "COMMON_APPEND_SYSTEM.md"), "COMMON edited");
	assert.equal(runtime.before().systemPrompt, first.systemPrompt);
	assert.equal(runtime.before(first.systemPrompt).systemPrompt, first.systemPrompt);
	assert.equal(runtime.registrations.length, 1);
	runtime.reload();
	const next = runtime.before(first.systemPrompt).systemPrompt;
	assert.equal(next.split(POLICY_START).length - 1, 1);
	assert.match(next, /MAIN edited/);
	assert.match(next, /COMMON edited/);
	assert.doesNotMatch(next, /MAIN draft|COMMON draft/);
	assert.equal(runtime.registrations.length, 2);
	assert.equal(runtime.disposed, 1);
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
		const result = runtime.before(prompt).systemPrompt;
		assert.ok(result.startsWith(prompt));
		assert.match(result, /CHILD draft/);
		assert.ok(result.includes(CHILD_POLICY_MARKER));
		assert.doesNotMatch(result, /MAIN draft/);
		writeFileSync(join(runtime.directory, "SUBAGENT_APPEND_SYSTEM.md"), "CHILD edited");
		assert.equal(runtime.before(result).systemPrompt, result);
		runtime.reload();
		assert.match(runtime.before(result).systemPrompt, /CHILD edited/);
	});
}

test("fork drops only owned parent policy blocks, retaining deliberate role/legacy text", () => {
	const parent = appendPolicy("parent role", "main", "MAIN draft");
	const child = appendPolicy(`${CHILD_PREFIXES[0]}\nreviewer role\n${parent}\n${CHADINEER_PROMPT}`, "subagent", "CHILD draft");
	assert.doesNotMatch(child, /MAIN draft/);
	assert.match(child, /parent role/);
	assert.match(child, /reviewer role/);
	assert.ok(child.includes(CHADINEER_PROMPT), "unmarked user-supplied instructions are not heuristically removed");
});

for (const legacyFirst of [true, false]) {
	test(`enabled inherited Chadineer deduplicates child in ${legacyFirst ? "legacy-first" : "policy-first"} order; root still works`, (t) => {
		const runtime = harness(t, { legacy: true, legacyFirst });
		runtime.emit("session_start");
		const root = runtime.before("root role").systemPrompt;
		assert.ok(root.includes(CHADINEER_PROMPT));
		const child = runtime.before(`${CHILD_PREFIXES[0]}\nworker role`).systemPrompt;
		assert.doesNotMatch(child, /Chadineer development guidelines/);
		assert.match(child, /CHILD draft/);
		assert.doesNotMatch(child, /chadineer:v1/);
	});
}

test("multiple owned policy/legacy blocks are removed, never other sections", () => {
	const own = `${POLICY_START}\nstale\n${POLICY_END}`;
	const legacy = `${LEGACY_START}\nlegacy\n${LEGACY_END}`;
	const output = appendPolicy(`${CHILD_PREFIXES[0]}\nrole\n${own}\n${own}\n${legacy}\nother section`, "subagent", "new");
	assert.equal(output.split(POLICY_START).length - 1, 1);
	assert.doesNotMatch(output, /stale|legacy/);
	assert.match(output, /other section/);
	assert.throws(() => appendPolicy(POLICY_START, "main", "new"), /unterminated/);
});

test("whitespace-only main file is omitted from the initialization snapshot", (t) => {
	const runtime = harness(t, { configure(directory) {
		writeFileSync(join(directory, "ORCHESTRATOR_APPEND_SYSTEM.md"), "  \n");
	} });
	assert.equal(runtime.before().systemPrompt, appendPolicy("root role", "main", "COMMON draft"));
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
});

test("deployed orchestrator-only policy preserves exact SYSTEM text and empty child configuration", (t) => {
	const runtime = harness(t, { deployed: true });
	const main = readFileSync(new URL("../ORCHESTRATOR_APPEND_SYSTEM.md", import.meta.url), "utf8");
	assert.ok(main.trim());
	assert.equal(existsSync(new URL("../MAIN_APPEND_SYSTEM.md", import.meta.url)), false);
	const root = runtime.before().systemPrompt;
	assert.equal(root, `root role\n\n${POLICY_START}\n<!-- agent-policy:v1:main -->\n${main}\n${POLICY_END}`);
	for (const file of ["COMMON_APPEND_SYSTEM.md", "SUBAGENT_APPEND_SYSTEM.md", "roles/worker.md", "roles/reviewer.md", "roles/scout.md"]) {
		assert.equal(readFileSync(join(runtime.directory, file), "utf8"), "", file);
	}
	for (const backgroundChild of [false, true]) {
		const child = harness(t, { deployed: true, backgroundChild });
		for (const prefix of backgroundChild ? [""] : CHILD_PREFIXES) {
			for (const role of ["worker", "reviewer", "scout", "custom"]) {
				const prompt = `${prefix}\n<active_agent name="${role}"/>\nexisting role body  \n`;
				assert.equal(child.before(prompt).systemPrompt, prompt);
				const fork = child.before(`${prompt}\n${root}`).systemPrompt;
				assert.equal(fork, `${prompt}\nroot role`);
				assert.equal(child.before(fork).systemPrompt, fork);
			}
		}
	}
	for (const legacyFirst of [true, false]) {
		const child = harness(t, { deployed: true, legacy: true, legacyFirst });
		child.emit("session_start");
		const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="worker"/>\nrole`;
		assert.equal(child.before(prompt).systemPrompt, `${prompt}\n\n${LEGACY_START}\n${CHADINEER_PROMPT}\n${LEGACY_END}`);
		const inherited = `${prompt}\n${root}\n${LEGACY_START}\n${CHADINEER_PROMPT}\n${LEGACY_END}`;
		assert.equal(appendPolicy(inherited, "subagent", " \n"), `${prompt}\nroot role\n\n\n${LEGACY_START}\n${CHADINEER_PROMPT}\n${LEGACY_END}`);
	}
	const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="worker"/>\nrole`;
	writeFileSync(join(runtime.directory, "roles/worker.md"), "future worker overlay\n");
	assert.equal(runtime.before(prompt).systemPrompt, prompt);
	runtime.reload();
	const active = runtime.before(prompt).systemPrompt;
	assert.ok(active.includes("future worker overlay\n"));
	assert.ok(active.includes(CHILD_POLICY_MARKER));
	for (const blank of ["", " \t\n"]) {
		writeFileSync(join(runtime.directory, "roles/worker.md"), blank);
		writeFileSync(join(runtime.directory, "COMMON_APPEND_SYSTEM.md"), blank);
		writeFileSync(join(runtime.directory, "SUBAGENT_APPEND_SYSTEM.md"), blank);
		runtime.reload();
		assert.equal(runtime.before(active).systemPrompt, prompt);
		assert.equal(runtime.before(prompt).systemPrompt, prompt);
		writeFileSync(join(runtime.directory, "ORCHESTRATOR_APPEND_SYSTEM.md"), blank);
		runtime.reload();
		assert.equal(runtime.before(root).systemPrompt, "root role");
	}
	assert.throws(() => appendPolicy(POLICY_START, "subagent", ""), /unterminated/);
});

for (const role of ["worker", "reviewer", "scout"] as const) {
	test(`${role} composes common + generic child + exact overlay without changing builtin role text`, (t) => {
		const runtime = harness(t);
		const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>\nexisting ${role} duties`;
		assert.equal(selectRole(prompt, "subagent"), role);
		const output = runtime.before(prompt).systemPrompt;
		assert.ok(output.startsWith(prompt));
		assert.match(output, /COMMON draft/);
		assert.match(output, /CHILD draft/);
		assert.ok(output.includes(`${role} overlay`));
		assert.ok(output.indexOf("COMMON draft") < output.indexOf("CHILD draft"));
		assert.ok(output.indexOf("CHILD draft") < output.indexOf(`${role} overlay`));
		assert.equal(runtime.before(output).systemPrompt, output);
		writeFileSync(join(runtime.directory, "roles", `${role}.md`), `${role} edited`);
		assert.equal(runtime.before(output).systemPrompt, output);
		runtime.reload();
		assert.ok(runtime.before(output).systemPrompt.includes(`${role} edited`));
	});
}

test("root metadata cannot classify children; unknown/unsafe names and absent tags stay generic", (t) => {
	const runtime = harness(t);
	assert.match(runtime.before('<active_agent name="worker"/>').systemPrompt, /MAIN draft/);
	assert.equal(selectRole('<active_agent name="worker"/>', "main"), undefined);
	for (const name of ["custom", "researcher", "oracle", "delegate", "developer", "Worker", "pkg.worker", "../worker", "__proto__", "constructor", "worker&amp;", ""]) {
		const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${name}"/>\n<active_agent name="worker"/>\nquoted role`;
		assert.equal(selectRole(prompt, "subagent"), undefined, name);
		const output = runtime.before(prompt).systemPrompt;
		assert.match(output, /CHILD draft/);
		assert.doesNotMatch(output, /worker overlay|reviewer overlay|scout overlay/);
	}
	for (const tag of ["", '<active_agent name="worker"/ malformed>', 'quoted: <active_agent name="worker"/>']) {
		assert.equal(selectRole(`${CHILD_PREFIXES[0]}\n${tag}`, "subagent"), undefined);
	}
});

test("role and main/child transitions replace one owned block and preserve unmarked prose", (t) => {
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
	assert.equal(main.split(POLICY_START).length - 1, 1);
});

for (const filename of ["COMMON_APPEND_SYSTEM.md", "ORCHESTRATOR_APPEND_SYSTEM.md", "SUBAGENT_APPEND_SYSTEM.md", "roles/worker.md", "roles/reviewer.md", "roles/scout.md"]) {
	test(`missing ${filename} fails initialization even before profile selection; blanks omit only that layer`, (t) => {
		assert.throws(() => harness(t, { configure(directory) {
			unlinkSync(join(directory, filename));
		} }), (error: any) => {
			assert.match(error.message, /agent-policy:.*ENOENT/);
			assert.ok(error.message.includes(filename));
			assert.equal(error.cause.code, "ENOENT");
			return true;
		});
		const runtime = harness(t, { configure(directory) {
			writeFileSync(join(directory, filename), " \n");
		} });
		const role = filename.startsWith("roles/") ? filename.slice(6, -3) : "worker";
		const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>`;
		const remaining = [filename === "COMMON_APPEND_SYSTEM.md" ? "" : "COMMON draft", filename === "SUBAGENT_APPEND_SYSTEM.md" ? "" : "CHILD draft", filename.startsWith("roles/") ? "" : `${role} overlay`].filter(Boolean).join("\n\n");
		assert.equal(runtime.before(prompt).systemPrompt, appendPolicy(prompt, "subagent", remaining));
		const main = [filename === "COMMON_APPEND_SYSTEM.md" ? "" : "COMMON draft", filename === "ORCHESTRATOR_APPEND_SYSTEM.md" ? "" : "MAIN draft"].filter(Boolean).join("\n\n");
		assert.equal(runtime.before().systemPrompt, appendPolicy("root role", "main", main));
		assert.deepEqual(runtime.notices, []);
	});
}

test("unreadable policy fails initialization explicitly", (t) => {
	assert.throws(() => harness(t, { configure(directory) {
		const path = join(directory, "roles/scout.md");
		unlinkSync(path);
		mkdirSync(path);
	} }), /agent-policy:.*EISDIR/);
});

test("all six files are read once at initialization, never on runs or session/tree events", (t) => {
	const originalRead = fs.readFileSync;
	const reads = t.mock.method(fs, "readFileSync", (...args: any[]) => Reflect.apply(originalRead, fs, args));
	syncBuiltinESMExports();
	try {
		const runtime = harness(t);
		assert.equal(reads.mock.callCount(), 7);
		// Edits before even the first prompt must not leak into any profile/role.
		for (const call of reads.mock.calls.filter((call: any) => !String(call.arguments[0]).endsWith("injections.json"))) writeFileSync(call.arguments[0], "edited before first prompt");
		for (const reason of ["startup", "resume", "fork", "reload"]) runtime.emit("session_start", { reason });
		runtime.emit("session_tree");
		assert.match(runtime.before().systemPrompt, /MAIN draft/);
		for (const role of ["worker", "reviewer", "scout"]) {
			const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>`;
			const output = runtime.before(prompt).systemPrompt;
			assert.equal(output, appendPolicy(prompt, "subagent", `COMMON draft\n\nCHILD draft\n\n${role} overlay`));
			assert.equal(runtime.before(output).systemPrompt, output);
		}
		assert.equal(reads.mock.callCount(), 7);
		runtime.reload();
		assert.equal(reads.mock.callCount(), 14);
		assert.match(runtime.before().systemPrompt, /edited before first prompt/);
		rmSync(runtime.directory, { recursive: true });
		assert.match(runtime.before().systemPrompt, /edited before first prompt/);
		assert.equal(reads.mock.callCount(), 14);
		assert.throws(() => runtime.reload(), /agent-policy:.*ENOENT/);
	} finally {
		reads.mock.restore();
		syncBuiltinESMExports();
	}
});

const bbTuple = { PI_AGENT_POLICY_BB_PROFILE: "workflow-worker:v1", BB_THREAD_ID: "bb-thread", PI_AGENT_POLICY_BB_THREAD_ID: "bb-thread" };
const bbStates = [
	{}, { BB_THREAD_ID: "bb-thread" }, bbTuple,
	{ ...bbTuple, PI_AGENT_POLICY_BB_PROFILE: "none:v1" },
	{ ...bbTuple, PI_AGENT_POLICY_BB_PROFILE: "unknown" },
	{ ...bbTuple, PI_AGENT_POLICY_BB_THREAD_ID: undefined },
	{ ...bbTuple, PI_AGENT_POLICY_BB_THREAD_ID: "other" },
];

test("BB-only tuple composes generic child, never arbitrary/inherited canonical role overlays", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal(bbTuple) });
	for (const role of ["worker", "reviewer", "scout", "custom"]) {
		const prompt = `<active_agent name="${role}"/>\nBB instructions\nquoted: ${CHILD_PREFIXES[0]}`;
		const output = runtime.before(prompt);
		assert.equal(output.systemPrompt, appendPolicy(prompt, "subagent", "COMMON draft\n\nCHILD draft"));
		assert.deepEqual(Object.keys(output.returns[0]), ["systemPrompt"]);
		assert.equal(runtime.before(output.systemPrompt).systemPrompt, output.systemPrompt);
	}
	assert.deepEqual(runtime.notices, []);
	assert.equal(runtime.registrations.length, 1);
	assert.deepEqual(runtime.registrations[0], { sessionId: "uuid-parent", extensions: [{ id: POLICY_ID, path: join(runtime.directory, "index.ts") }] });
});

test("all own marker states preserve native role overlays, while nonpositive BB roots remain main", (t) => {
	for (const env of bbStates) {
		const bbSignal = parseBBPolicySignal(env);
		const root = harness(t, { bbSignal });
		assert.equal(root.before().systemPrompt, appendPolicy("root role", bbSignal.workflowWorker ? "subagent" : "main", `COMMON draft\n\n${bbSignal.workflowWorker ? "CHILD" : "MAIN"} draft`));
		for (const backgroundChild of [true, false]) {
			const native = harness(t, { backgroundChild, bbSignal });
			for (const prefix of backgroundChild ? [""] : CHILD_PREFIXES) {
				for (const role of ["worker", "reviewer", "scout"]) {
					const prompt = `${prefix}\n<active_agent name="${role}"/>\nbody`;
					assert.equal(native.before(prompt).systemPrompt, appendPolicy(prompt, "subagent", `COMMON draft\n\nCHILD draft\n\n${role} overlay`));
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
	const ctx = { hasUI: false, sessionManager: { getSessionId: () => "headless" }, ui: { notify() { assert.fail("headless warning must log instead"); } } };
	handlers.get("session_start")!({}, ctx);
	handlers.get("before_agent_start")!({ systemPrompt: "root" }, ctx);
	assert.deepEqual(calls, [diagnostic.diagnostic]);
});

test("BB worker clears complete stale main/role blocks even with deployed empty child policy", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal(bbTuple), deployed: true });
	const prompt = '<active_agent name="worker"/>\nBB body';
	const staleMain = appendPolicy("inherited unmarked prose", "main", "stale main");
	const staleRole = appendPolicy("", "subagent", "stale worker overlay");
	assert.equal(runtime.before(`${prompt}\n${staleMain}\n${staleRole}`).systemPrompt, `${prompt}\ninherited unmarked prose`);
	assert.equal(runtime.before(prompt).systemPrompt, prompt);
	assert.equal(runtime.before(runtime.before(prompt).systemPrompt).systemPrompt, prompt);
});

test("BB env/prompt/history lookalikes alone cannot classify a root", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal({ BB_THREAD_ID: "bb-thread" }) });
	const prompt = `ROOT\nPI_AGENT_POLICY_BB_PROFILE=workflow-worker:v1\nPI_AGENT_POLICY_BB_THREAD_ID=bb-thread\n<active_agent name="worker"/>\nquoted: ${CHILD_PREFIXES[0]}`;
	assert.equal(runtime.before(prompt).systemPrompt, appendPolicy(prompt, "main", "COMMON draft\n\nMAIN draft"));
});


function nativeLayout(role: string, boundary: string, append = false, structured = false): string {
	const tagged = `<active_agent name="${role}"/>\n\nexisting ${role} role body`;
	const base = append ? `Pi base\n\n<addendum>\n${tagged}\n</addendum>\n\n<cwd>\n/tmp/project\n</cwd>` : tagged;
	return `${base}\n\n${boundary}${structured ? `\n\n${NATIVE_STRUCTURED_OUTPUT_SUFFIX}` : ""}`;
}

test("0.76.1 complete native ordinary/fanout replace/append layouts retain canonical overlays ahead of every BB signal", (t) => {
	for (const env of bbStates) {
		const runtime = harness(t, { bbSignal: parseBBPolicySignal(env) });
		for (const boundary of NATIVE_CHILD_BOUNDARIES) {
			for (const append of [false, true]) {
				for (const structured of [false, true]) {
					for (const role of ["worker", "reviewer", "scout", "custom", "../worker", "worker&amp;"]) {
						const prompt = nativeLayout(role, boundary, append, structured);
						assert.equal(selectProfile(prompt, false), "subagent");
						const overlay = ["worker", "reviewer", "scout"].includes(role) ? `\n\n${role} overlay` : "";
						const output = runtime.before(prompt).systemPrompt;
						assert.equal(output, appendPolicy(prompt, "subagent", `COMMON draft\n\nCHILD draft${overlay}`));
						assert.equal(runtime.before(output).systemPrompt, output, "complete owned tail preserves repeated native classification");
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
			assert.equal(runtime.before(prompt).systemPrompt, appendPolicy(prompt, "main", "COMMON draft\n\nMAIN draft"));
		}
	}
});

test("appended native layout cleans inherited main blocks with empty policy and keeps Chadineer independent", (t) => {
	for (const legacyFirst of [false, true]) {
		for (const deployed of [false, true]) {
			const runtime = harness(t, { legacy: true, legacyFirst, deployed });
			runtime.emit("session_start");
			const parent = appendPolicy("inherited parent prose", "main", "stale main");
			const prompt = nativeLayout("worker", NATIVE_CHILD_BOUNDARIES[0]).replace("existing worker role body", `existing worker role body\n${parent}`);
			const output = runtime.before(prompt).systemPrompt;
			assert.doesNotMatch(output, /stale main|MAIN draft/);
			assert.match(output, /inherited parent prose/);
			if (deployed) {
				assert.doesNotMatch(output, /agent-policy:v1:/);
				assert.ok(output.includes(CHADINEER_PROMPT));
			} else {
				assert.match(output, /CHILD draft[\s\S]*worker overlay/);
				assert.ok(!output.includes(CHADINEER_PROMPT));
			}
			assert.equal(runtime.before(output).systemPrompt, deployed
				? `${output}\n\n${LEGACY_START}\n${CHADINEER_PROMPT}\n${LEGACY_END}`
				: output);
		}
	}
});

test("complete appended layout routes its launch tag rather than quoted preamble or role tags", (t) => {
	const runtime = harness(t, { bbSignal: parseBBPolicySignal(bbTuple) });
	const prompt = nativeLayout("reviewer", NATIVE_CHILD_BOUNDARIES[0], true)
		.replace("Pi base", 'Pi base\n<active_agent name="scout"/>\nquoted preamble')
		.replace("existing reviewer role body", 'existing reviewer role body\n<active_agent name="worker"/>\nquoted role tag');
	assert.equal(selectRole(prompt, "subagent"), "reviewer");
	assert.equal(runtime.before(prompt).systemPrompt, appendPolicy(prompt, "subagent", "COMMON draft\n\nCHILD draft\n\nreviewer overlay"));
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
	writeFileSync(join(directory, "injections.json"), JSON.stringify({ main: ["first.md", "second.md"], agents: JSON.parse('{"worker":["second.md"],"reviewer":["first.md"],"security-reviewer":["first.md","second.md"],"__proto__":["first.md"],"constructor":["second.md"],"special&name":["second.md"]}') }));
}

test("runtime appends ordered full skills after policy layers, routes exact independent names, and replaces stale role blocks", (t) => {
	const runtime = harness(t, { configure: configureSkills });
	const root = runtime.before().systemPrompt;
	assert.match(root, /COMMON draft[\s\S]*MAIN draft[\s\S]*FIRST full body[\s\S]*SECOND full body/);
	assert.ok(root.includes(`Resolve this skill's relative file references against ${runtime.directory}.`));
	assert.doesNotMatch(root, /name: first/);
	for (const [name, first, second, overlay] of [["worker", false, true, true], ["reviewer", true, false, true], ["security-reviewer", true, true, false], ["unknown", false, false, false], ["developer", false, false, false], ["__proto__", true, false, false], ["constructor", false, true, false], ["toString", false, false, false], ["special&amp;name", false, true, false]] as const) {
		const prompt = `<active_agent name="${name}"/>\n\noriginal ${name} role\n${root}`;
		const output = runtime.before(prompt).systemPrompt;
		assert.equal(output.includes("FIRST full body"), first, name);
		assert.equal(output.includes("SECOND full body"), second, name);
		assert.equal(output.includes(`${name} overlay`), overlay, name);
		assert.doesNotMatch(output, /MAIN draft/);
		assert.match(output, /COMMON draft[\s\S]*CHILD draft/);
		assert.equal(output.split(POLICY_START).length - 1, 1);
		assert.match(output, new RegExp(`original ${name} role`));
		assert.equal(runtime.before(output).systemPrompt, output);
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
	writeFileSync(join(runtime.directory, "injections.json"), JSON.stringify({ main: ["second.md"], agents: { "security-reviewer": ["first.md"] } }));
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
		assert.equal(runtime.before(child).systemPrompt, child);
	});
}


test("canonical names decode only upstream XML escapes; older complete boundaries retain blank-body routing", () => {
	for (const [encoded, name] of [["special&amp;name", "special&name"], ["quoted&quot;name", 'quoted"name'], ["less&lt;greater&gt;", "less<greater>"], ["literal&amp;quot;", "literal&quot;"]] as const) {
		const prompt = `<active_agent name="${encoded}"/>\n\nbody`;
		assert.equal(selectProfile(prompt, false), "subagent");
		assert.equal(selectAgentName(prompt, "subagent"), name);
		assert.equal(selectRole(prompt, "subagent"), undefined);
	}
	for (const encoded of ["bad&name", "bad&unknown;", "bad&#34;"]) {
		assert.equal(selectProfile(`<active_agent name="${encoded}"/>\n\nbody`, false), "main");
	}
	for (const role of ["", "worker"]) {
		const prompt = `<active_agent name="${role}"/>\n\n\n\n${NATIVE_CHILD_BOUNDARIES[0]}`;
		assert.equal(selectProfile(prompt, false), "subagent", "old complete-boundary layout still works without a nonblank role body");
	}
});
