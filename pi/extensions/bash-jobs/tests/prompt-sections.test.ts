/**
 * Cross-extension regression through a real Pi session: agent-policy runs before bash-jobs and must
 * contribute a prompt section rather than a forced system prompt. A forced prompt collapses the
 * request's system messages into one un-sectioned text, which is how `background_jobs` disappeared.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installAgentPolicy } from "../../agent-policy/runtime.ts";
import modelInstructions from "../../model-instructions/index.ts";
import bashJobs from "../index.ts";

const POLICY_TEXT = "POLICY SENTINEL: verify before you answer.";
/** Long enough to outlive both turns, short enough not to hold the suite. */
const JOB_COMMAND = "sleep 4";

/** An agent-policy runtime over a one-file main layer, without the pi-subagents peer. */
function agentPolicy(policyDir: string) {
	return (pi: ExtensionAPI) => {
		installAgentPolicy(pi, {
			policyDir,
			extensionPath: join(policyDir, "index.ts"),
			backgroundChild: false,
			register: (() => ({ dispose() {} })) as never,
		});
	};
}

function policyDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "prompt-sections-policy-"));
	writeFileSync(join(directory, "main.md"), POLICY_TEXT);
	writeFileSync(join(directory, "config.json"), JSON.stringify({ main: ["./main.md"] }));
	return directory;
}

function bashJob(): FauxResponseStep {
	return fauxAssistantMessage(fauxToolCall("bash", { command: JOB_COMMAND, background: true }), { stopReason: "toolUse" });
}

/** Records the sections the request carries, then answers. */
function record(requests: Array<Record<string, string | null>>, text: string): FauxResponseStep {
	return (context) => {
		requests.push(sectionsIn(context as never));
		return fauxAssistantMessage(text);
	};
}

/** Fold the transcript's section patches the way a provider request sees them. */
function sectionsIn(context: { messages: Array<Record<string, any>> }): Record<string, string | null> {
	const folded: Record<string, string | null> = {};
	for (const message of context.messages) {
		if (message.role !== "system" || !message.sections) continue;
		for (const [name, text] of Object.entries(message.sections as Record<string, string | null>)) folded[name] = text;
	}
	return folded;
}

async function harness(factories: Array<(pi: ExtensionAPI) => void>, responses: (requests: Array<Record<string, string | null>>) => FauxResponseStep[]) {
	const dir = mkdtempSync(join(tmpdir(), "prompt-sections-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const requests: Array<Record<string, string | null>> = [];
	faux.setResponses(responses(requests));
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, extensionFactories: factories });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		tools: ["bash"],
	});
	await session.bindExtensions({ mode: "rpc" });
	return {
		session,
		requests,
		async close() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		},
	};
}

test("a later run's request keeps both the policy section and bash-jobs' background_jobs section", async () => {
	const policyDir = policyDirectory();
	const h = await harness([agentPolicy(policyDir), bashJobs], (requests) => [bashJob(), record(requests, "Started the job."), record(requests, "It is still running.")]);
	try {
		await h.session.prompt("start the job");
		await h.session.prompt("is it still running?");
		assert.equal(h.requests.length, 2, "one request per turn was recorded");
		const [afterTool, afterPrompt] = h.requests;
		assert.match(afterTool.agent_policy ?? "", /POLICY SENTINEL/, "the policy section reaches the provider");
		assert.match(afterPrompt.agent_policy ?? "", /POLICY SENTINEL/, "and survives the later run");
		assert.match(afterPrompt.agent_policy ?? "", /<!-- agent-policy:v1:main -->/);
		assert.match(afterPrompt.background_jobs ?? "", /sleep 4/, "the section a later extension added is still there");
	} finally {
		await h.close();
	}
});

test("model-instructions also adds a section, so bash-jobs' section survives after it", async () => {
	const policyDir = policyDirectory();
	const instructions = join(policyDir, "instructions.json");
	writeFileSync(instructions, JSON.stringify({ models: { "faux-1": ["MODEL SENTINEL: prefer small diffs."] } }));
	const h = await harness([
		(pi) => modelInstructions(pi, pathToFileURL(instructions)),
		bashJobs,
	], (requests) => [bashJob(), record(requests, "Started the job."), record(requests, "It is still running.")]);
	try {
		await h.session.prompt("start the job");
		await h.session.prompt("is it still running?");
		const afterPrompt = h.requests.at(-1)!;
		assert.match(afterPrompt.model_instructions ?? "", /MODEL SENTINEL/);
		assert.match(afterPrompt.background_jobs ?? "", /sleep 4/);
	} finally {
		await h.close();
	}
});

test("an agent-policy root keeps Pi's own sections in the request", async () => {
	const policyDir = policyDirectory();
	const h = await harness([agentPolicy(policyDir)], (requests) => [record(requests, "Hello.")]);
	try {
		await h.session.prompt("hi");
		const [request] = h.requests;
		assert.match(request.agent_policy ?? "", /POLICY SENTINEL/);
		assert.match(request.preamble ?? "", /expert coding assistant/, "Pi's preamble is still a section, not replaced text");
		assert.ok("rules" in request, "Pi's rules section is still part of the request");
	} finally {
		await h.close();
	}
});
