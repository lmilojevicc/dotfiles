import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { CHILD_PREFIXES, POLICY_START } from "../child-profile.ts";
import { POLICY_ID } from "../runtime.ts";

// Test-host fixtures only; production resolves public peers and the Pi-managed npm anchor.
const sdkRoot = process.env.PI_POLICY_TEST_SDK ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const subagentsRoot = process.env.PI_POLICY_TEST_SUBAGENTS ?? join(process.env.HOME!, ".pi/agent/npm/node_modules/pi-subagents");
const available = existsSync(join(sdkRoot, "dist/index.js")) && existsSync(join(subagentsRoot, "src/api/required-child-extensions.js"));
const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
const mainDraft = readFileSync(new URL("../ORCHESTRATOR_APPEND_SYSTEM.md", import.meta.url), "utf8");
const fakeModel = { id: "offline-test", name: "offline-test", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 };


async function installed(relative: string, root: string) { return import(pathToFileURL(join(root, relative)).href); }

// No model requests are made. Real SDK session/loader + real native child planner/factory/hooks.
// The model catalog/auth boundary is restricted to temp files and refreshOnCreate:false.
test("installed SDK/native loader routes root, foreground, fork, runner, nested, fanout and recovery snapshots offline", { skip: !available }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-policy-native-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(agentDir, "npm/node_modules"), { recursive: true });
	symlinkSync(subagentsRoot, join(agentDir, "npm/node_modules/pi-subagents"), "dir");
	symlinkSync(fileURLToPath(new URL("../../../APPEND_SYSTEM.md", import.meta.url)), join(agentDir, "APPEND_SYSTEM.md"));
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChild = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	t.after(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = oldChild;
		rmSync(root, { recursive: true, force: true });
	});
	const sdk = await installed("dist/index.js", sdkRoot);
	const { buildSystemPrompt } = await installed("dist/core/system-prompt.js", sdkRoot);
	// pi-subagents is Pi-managed, not a plain Node SDK dependency. Use host aliases,
	// like Pi's extension loader, rather than install or mutate its missing peer links.
	const { createJiti } = await installed("dist/core/extensions/jiti-loader.js", sdkRoot);
	const hostRequire = createRequire(join(sdkRoot, "package.json"));
	const alias: Record<string, string> = {};
	for (const name of ["@earendil-works/pi-tui", "@earendil-works/pi-agent-core"]) {
		const manifest = hostRequire.resolve(`${name}/package.json`);
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		alias[name] = resolve(dirname(manifest), pkg.exports?.["."]?.import ?? pkg.main);
	}
	for (const name of ["typebox", "typebox/compile", "typebox/value"]) alias[name] = hostRequire.resolve(name);
	alias["@earendil-works/pi-coding-agent"] = join(sdkRoot, "dist/index.js");
	const aiManifest = join(sdkRoot, "node_modules/@earendil-works/pi-ai/package.json");
	const aiPackage = JSON.parse(readFileSync(aiManifest, "utf8"));
	alias["@earendil-works/pi-ai"] = resolve(dirname(aiManifest), aiPackage.exports["./compat"].import);
	const jiti = createJiti(import.meta.url, { alias, moduleCache: true });
	const { buildInProcessChildLaunch } = await jiti.import(join(subagentsRoot, "src/runs/shared/child-launch.js"));
	const { createDefaultChildSessionFactory, setChildSessionFactory } = await jiti.import(join(subagentsRoot, "src/runs/shared/child-session.js"));
	const { registerRequiredChildExtensions } = await installed("src/api/required-child-extensions.js", subagentsRoot);
	// Test observation only; production never imports or copies private registry internals.
	const { resolveRequiredChildExtensions } = await installed("src/shared/required-child-extensions.js", subagentsRoot);
	assert.equal(JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).version, "1.0.2");
	assert.equal(JSON.parse(readFileSync(join(subagentsRoot, "package.json"), "utf8")).version, "0.76.0");
	const errors: any[] = [];
	const sessions: any[] = [];
	const resources = new WeakMap<object, any>();
	const createModelRuntime = () => sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false });
	const host = {
		...sdk,
		ModelRuntime: { create: createModelRuntime },
		async createAgentSession(options: any) {
			const result = await sdk.createAgentSession({ ...options, model: fakeModel });
			sessions.push(result.session);
			resources.set(result.session, options.resourceLoader);
			return result;
		},
	};
	const settingsManager = sdk.SettingsManager.inMemory({});
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [extensionPath], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = sdk.SessionManager.create(cwd, join(root, "sessions"));
	const { session: parent } = await host.createAgentSession({ cwd, agentDir, modelRuntime: await createModelRuntime(), settingsManager, resourceLoader: loader, sessionManager: manager });
	await parent.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
	t.after(async () => { await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); parent.dispose(); });
	const parentId = manager.getSessionId();
	assert.ok(manager.getSessionFile());
	assert.deepEqual(resolveRequiredChildExtensions(manager.getSessionFile()), [], "file paths are not registry keys");
	const required = resolveRequiredChildExtensions(parentId);
	assert.deepEqual(required, [{ id: POLICY_ID, path: resolve(extensionPath) }]);
	assert.throws(() => registerRequiredChildExtensions({ sessionId: parentId, extensions: [] }), /already registered/);

	async function boundary(session: any, role?: string) {
		const resource = resources.get(session);
		const result = await session.extensionRunner.emitBeforeAgentStart("offline boundary only", undefined, { cwd, customPrompt: role ?? resource.getSystemPrompt(), appendSystemPrompt: resource.getAppendSystemPrompt().join("\n\n"), selectedTools: [] });
		assert.deepEqual(result.messages, []);
		assert.equal(typeof result.systemPromptOptions.forceSystemPrompt, "string");
		return buildSystemPrompt(result.systemPromptOptions);
	}
	const rootPrompt = await boundary(parent, "ROOT role");
	assert.ok(rootPrompt.startsWith("ROOT role"));
	assert.ok(rootPrompt.includes(mainDraft));
	assert.match(rootPrompt, /Tone and Behavior/);
	assert.equal(rootPrompt.split(POLICY_START).length - 1, 1);
	const misleadingRoot = await boundary(parent, '<active_agent name="worker"/>\nROOT role');
	assert.ok(misleadingRoot.includes(mainDraft));
	assert.equal(misleadingRoot.split(POLICY_START).length - 1, 1);
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => host });
	t.after(() => factory.dispose());
	let inherited: any;
	for (const mode of ["foreground", "fork", "background", "background-ambient", "nested", "fanout", "recovery"]) {
		const fanout = mode === "fanout";
		const launch = buildInProcessChildLaunch({
			cwd, parentSessionId: parentId, childAgentName: "worker", childIndex: 0,
			host: mode.startsWith("background") ? "runner" : "parent", sessionEnabled: false,
			inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false,
			tools: ["read"], extensions: mode === "background-ambient" ? undefined : [], allowNestedSubagents: fanout,
			systemPrompt: `${mode} role\n${mode === "fork" ? rootPrompt : ""}`, systemPromptMode: "replace", waitToolEnabled: false,
			...(mode === "nested" ? { inherited } : {}),
			...(mode === "recovery" ? { requiredExtensions: JSON.parse(JSON.stringify(required)) } : {}),
		});
		assert.deepEqual(launch.session.requiredExtensions, required);
		assert.ok(launch.session.extensionPaths.includes(extensionPath), "required self extension survives explicit empty extensions");
		assert.equal(launch.session.ambientExtensions, mode === "background-ambient");
		const child = await factory.create({ ...launch.session, onExtensionError: (error: any) => errors.push(error) });
		const session = sessions.at(-1);
		const childId = child.sessionId;
		assert.deepEqual(resolveRequiredChildExtensions(childId), required, "registered at session_start before boundary");
		const prompt = await boundary(session);
		assert.ok(prompt.startsWith(fanout ? CHILD_PREFIXES[1] : CHILD_PREFIXES[0]), prompt.slice(0, 150));
		assert.ok(prompt.includes(`${mode} role`));
		assert.match(prompt, /Tone and Behavior/);
		assert.doesNotMatch(prompt, /MUST use subagent-driven|## Orchestration|Never delegate these actions/);
		assert.ok(prompt.includes('<active_agent name="worker"/>'));
		assert.ok(!prompt.includes(mainDraft));
		assert.doesNotMatch(prompt, /agent-policy:v1:/);
		const repeated = await boundary(session, prompt);
		assert.doesNotMatch(repeated, /agent-policy:v1:/);
		inherited = launch.config;
		await child.dispose();
		assert.deepEqual(resolveRequiredChildExtensions(childId), []);
	}
	// Read actual builtin bodies/modes. Fixture launches use read only, avoiding
	// unrelated provider prerequisites; installed definitions are never modified.
	const { discoverAgents, resolveAgentName } = await jiti.import(join(subagentsRoot, "src/agents/agents.js"));
	const agents = discoverAgents(cwd, "project").agents;
	for (const selection of ["worker", "developer", "coder", "implementer", "develop", "reviewer", "scout", "delegate", "researcher", "oracle", "advisor"]) {
		const agent = resolveAgentName(selection, agents).agent;
		assert.ok(agent, selection);
		const launch = buildInProcessChildLaunch({
			cwd, parentSessionId: parentId, childAgentName: agent.name, childIndex: 0,
			host: "parent", sessionEnabled: false, tools: ["read"], extensions: [],
			inheritProjectContext: agent.inheritProjectContext, inheritGlobalContext: agent.inheritGlobalContext, inheritSkills: agent.inheritSkills,
			systemPrompt: agent.systemPrompt, systemPromptMode: agent.systemPromptMode, waitToolEnabled: false,
		});
		const child = await factory.create({ ...launch.session, onExtensionError: (error: any) => errors.push(error) });
		const prompt = await boundary(sessions.at(-1));
		assert.ok(prompt.includes(`<active_agent name="${agent.name}"/>`), selection);
		assert.ok(prompt.includes(agent.systemPrompt), "builtin body remains intact");
		assert.doesNotMatch(prompt, /agent-policy:v1:/);
		assert.ok(!prompt.includes(mainDraft));
		await child.dispose();
	}
	for (const name of ["custom-role", "../worker", 'worker"/><active_agent name="scout']) {
		const launch = buildInProcessChildLaunch({ cwd, parentSessionId: parentId, childAgentName: name, childIndex: 0, host: "parent", sessionEnabled: false, tools: ["read"], extensions: [], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, systemPrompt: "custom role body", systemPromptMode: "replace", waitToolEnabled: false });
		const child = await factory.create({ ...launch.session, onExtensionError: (error: any) => errors.push(error) });
		const prompt = await boundary(sessions.at(-1));
		assert.ok(prompt.includes("custom role body"));
		assert.doesNotMatch(prompt, /agent-policy:v1:/);
		await child.dispose();
	}

	// Actual executor lookup, not a path-keyed planner shortcut. Stop at its native
	// create seam before model resolution/request; the driver termination is simulated.
	const { createSubagentExecutor } = await jiti.import(join(subagentsRoot, "src/runs/foreground/subagent-executor.js"));
	const { createChildSafeState } = await jiti.import(join(subagentsRoot, "src/extension/fanout-child.js"));
	let captured: any;
	setChildSessionFactory({ async create(input: any) { captured = input; throw new Error("offline create capture"); }, async dispose() {} });
	t.after(() => setChildSessionFactory(undefined));
	const executor = createSubagentExecutor({
		pi: { events: { emit() {} }, getSessionName() { return undefined; }, getAllTools() { return []; } },
		state: createChildSafeState(), config: { artifactDir: "project", intercomBridge: { mode: "off" }, missions: { enabled: false } },
		asyncByDefault: false, tempArtifactsDir: join(root, "artifacts"), getSubagentSessionRoot: () => join(root, "executor-sessions"), expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents: agents.map((agent: any) => ({ ...agent, extensions: [] })) }),
	});
	async function executorLookup(manager: any, context: "fresh" | "fork" = "fresh") {
		captured = undefined;
		const result = await executor.execute("offline-contract", { agent: "developer", task: "Capture only", async: false, context, artifacts: false, output: false, progress: false, reads: false, skill: false, mission: false, acceptance: { level: "none", reason: "offline launch contract" } }, new AbortController().signal, undefined, { cwd, hasUI: false, sessionManager: manager, modelRegistry: { getAvailable: () => [] } });
		assert.ok(captured, JSON.stringify(result));
		assert.deepEqual(captured.requiredExtensions, required, "executor resolves registered UUID snapshot explicitly");
		assert.ok(captured.extensionPaths.includes(extensionPath));
		assert.equal(captured.ambientExtensions, false);
		assert.ok(captured.systemPrompt.startsWith('<active_agent name="worker"/>'), "executor normalizes developer alias before launch");
		assert.match(JSON.stringify(result), /offline create capture/);
	}
	await executorLookup(manager);
	// Synthetic stored history, no model call: exercise the installed resolver's real JSONL fork.
	manager.appendMessage({ role: "user", content: "stored fork fixture", timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic reply" }], api: "anthropic-messages", provider: "anthropic", model: "offline-test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
	await executorLookup(manager, "fork");
	assert.equal(captured.storage.kind, "file");
	assert.equal(JSON.parse(readFileSync(captured.storage.sessionFile, "utf8").split("\n")[0]).parentSession, manager.getSessionFile());
	const forkChild = await factory.create({ ...captured, parentProviderRegistry: parent.modelRuntime, onExtensionError: (error: any) => errors.push(error) });
	const forkSession = sessions.at(-1);
	const forkPrompt = await boundary(forkSession);
	assert.doesNotMatch(forkPrompt, /agent-policy:v1:/);
	assert.ok(forkPrompt.includes(resolveAgentName("worker", agents).agent.systemPrompt));
	assert.deepEqual(resolveRequiredChildExtensions(forkChild.sessionId), required);
	await forkChild.dispose();
	assert.deepEqual(resolveRequiredChildExtensions(forkChild.sessionId), []);
	assert.deepEqual(resolveRequiredChildExtensions(parentId), required);
	const memoryManager = sdk.SessionManager.inMemory(cwd);
	const memoryLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [extensionPath], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
	await memoryLoader.reload();
	const { session: memoryParent } = await host.createAgentSession({ cwd, agentDir, modelRuntime: await createModelRuntime(), settingsManager, resourceLoader: memoryLoader, sessionManager: memoryManager });
	await memoryParent.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
	assert.equal(memoryManager.getSessionFile(), undefined);
	assert.deepEqual(resolveRequiredChildExtensions(memoryManager.getSessionId()), required);
	await executorLookup(memoryManager);
	await memoryParent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	assert.deepEqual(resolveRequiredChildExtensions(memoryManager.getSessionId()), []);
	memoryParent.dispose();
	setChildSessionFactory(undefined);
	assert.throws(() => buildInProcessChildLaunch({ cwd, parentSessionId: parentId, childAgentName: "worker", childIndex: 0, host: "parent", sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: ["read"], capabilityCeiling: { version: 1, denyExtensions: true, sources: ["test-deny"] } }), /denies extensions/);
	assert.deepEqual(errors, []);
	assert.ok((await boundary(parent, "ROOT after runner role")).includes(mainDraft), "runner-host activity does not reclassify an already loaded root runtime");
	await parent.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
	assert.deepEqual(resolveRequiredChildExtensions(parentId), []);
	await parent.extensionRunner.emit({ type: "session_start", reason: "reload" });
	assert.deepEqual(resolveRequiredChildExtensions(parentId), required);
});

test("installed SDK snapshots policy like native APPEND and actual session.reload recreates it", { skip: !available }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-policy-reload-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const policyDir = join(root, "policy");
	mkdirSync(cwd);
	mkdirSync(join(agentDir, "npm/node_modules"), { recursive: true });
	symlinkSync(subagentsRoot, join(agentDir, "npm/node_modules/pi-subagents"), "dir");
	cpSync(dirname(extensionPath), policyDir, { recursive: true });
	const appendPath = join(agentDir, "APPEND_SYSTEM.md");
	writeFileSync(appendPath, "native initial");
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const oldChild = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_CHILD;
	t.after(() => {
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		if (oldChild === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = oldChild;
		rmSync(root, { recursive: true, force: true });
	});
	const sdk = await installed("dist/index.js", sdkRoot);
	const { buildSystemPrompt } = await installed("dist/core/system-prompt.js", sdkRoot);
	const { resolveRequiredChildExtensions } = await installed("src/shared/required-child-extensions.js", subagentsRoot);
	const settingsManager = sdk.SettingsManager.inMemory({});
	const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: [join(policyDir, "index.ts")], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	// Change every profile before the first prompt, including initially empty roles.
	writeFileSync(appendPath, "native edited");
	for (const file of ["COMMON_APPEND_SYSTEM.md", "ORCHESTRATOR_APPEND_SYSTEM.md", "SUBAGENT_APPEND_SYSTEM.md", "roles/worker.md", "roles/reviewer.md", "roles/scout.md"]) {
		writeFileSync(join(policyDir, file), `edited ${file}`);
	}
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false });
	const { session } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model: fakeModel, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd) });
	const errors: any[] = [];
	await session.bindExtensions({ mode: "print", onError: (error: any) => errors.push(error) });
	t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
	const id = session.sessionManager.getSessionId();
	const required = [{ id: POLICY_ID, path: realpathSync(join(policyDir, "index.ts")) }];
	assert.deepEqual(resolveRequiredChildExtensions(id), required);
	async function boundary(prompt: string) {
		const result = await session.extensionRunner.emitBeforeAgentStart("offline only", undefined, { cwd, customPrompt: prompt, appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"), selectedTools: [] });
		assert.deepEqual(result.messages, []);
		return buildSystemPrompt(result.systemPromptOptions);
	}
	const initial = await boundary("ROOT role");
	assert.ok(initial.includes(mainDraft));
	assert.match(initial, /native initial/);
	assert.doesNotMatch(initial, /edited/);
	assert.equal(await boundary("ROOT role"), initial, "each base-prompt hook receives cached policy");
	await session.extensionRunner.emit({ type: "session_start", reason: "resume" });
	assert.equal(await boundary("ROOT role"), initial, "an event alone does not recreate the snapshot");
	for (const role of ["worker", "reviewer", "scout"]) {
		const prompt = await boundary(`${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>\nrole body`);
		assert.doesNotMatch(prompt, /agent-policy:v1:|edited/);
	}
	const oldRunner = session.extensionRunner;
	await session.reload();
	assert.notEqual(session.extensionRunner, oldRunner);
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.deepEqual(resolveRequiredChildExtensions(id), required, "old registration disposed before the new runtime starts");
	const updated = await boundary("ROOT role");
	assert.match(updated, /native edited/);
	assert.match(updated, /edited COMMON_APPEND_SYSTEM.md/);
	assert.match(updated, /edited ORCHESTRATOR_APPEND_SYSTEM.md/);
	assert.equal(updated.split(POLICY_START).length - 1, 1);
	assert.ok(!updated.includes(mainDraft));
	for (const role of ["worker", "reviewer", "scout"]) {
		const prompt = await boundary(`${CHILD_PREFIXES[0]}\n<active_agent name="${role}"/>\nrole body`);
		assert.ok(prompt.includes(`edited roles/${role}.md`));
		assert.match(prompt, /edited SUBAGENT_APPEND_SYSTEM.md/);
		assert.equal(prompt.split(POLICY_START).length - 1, 1);
	}
	unlinkSync(join(policyDir, "roles/scout.md"));
	assert.equal(await boundary("ROOT role"), updated, "removal does not trigger a per-run read");
	await session.reload();
	assert.equal(loader.getExtensions().errors.length, 1);
	assert.match(loader.getExtensions().errors[0].error, /agent-policy:.*ENOENT.*scout.md/);
	assert.deepEqual(resolveRequiredChildExtensions(id), [], "failed initialization leaves no registration");
	assert.deepEqual(errors, []);
});
