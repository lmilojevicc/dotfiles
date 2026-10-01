import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import chadineer, { CHADINEER_PROMPT, CHADINEER_STATE_ENTRY } from "../../chadineer/index.ts";
import { appendPolicy, CHILD_PREFIXES, CHILD_POLICY_MARKER, LEGACY_START, LEGACY_END, POLICY_START, POLICY_END, selectProfile, selectRole } from "../child-profile.ts";
import { installAgentPolicy, POLICY_ID } from "../runtime.ts";

type Handler = (...args: any[]) => any;
function harness(t: any, { backgroundChild = false, register = undefined as any, legacyFirst = false, legacy = false, deployed = false, configure = (_directory: string) => {} } = {}) {
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
			policyDir: directory, extensionPath: join(directory, "index.ts"), backgroundChild,
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
		assert.equal(reads.mock.callCount(), 6);
		// Edits before even the first prompt must not leak into any profile/role.
		for (const call of reads.mock.calls) writeFileSync(call.arguments[0], "edited before first prompt");
		for (const reason of ["startup", "resume", "fork", "reload"]) runtime.emit("session_start", { reason });
		runtime.emit("session_tree");
		assert.match(runtime.before().systemPrompt, /MAIN draft/);
		for (const role of ["worker", "reviewer", "scout"]) {
			const prompt = `${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>`;
			const output = runtime.before(prompt).systemPrompt;
			assert.equal(output, appendPolicy(prompt, "subagent", `COMMON draft\n\nCHILD draft\n\n${role} overlay`));
			assert.equal(runtime.before(output).systemPrompt, output);
		}
		assert.equal(reads.mock.callCount(), 6);
		runtime.reload();
		assert.equal(reads.mock.callCount(), 12);
		assert.match(runtime.before().systemPrompt, /edited before first prompt/);
		rmSync(runtime.directory, { recursive: true });
		assert.match(runtime.before().systemPrompt, /edited before first prompt/);
		assert.equal(reads.mock.callCount(), 12);
		assert.throws(() => runtime.reload(), /agent-policy:.*ENOENT/);
	} finally {
		reads.mock.restore();
		syncBuiltinESMExports();
	}
});
