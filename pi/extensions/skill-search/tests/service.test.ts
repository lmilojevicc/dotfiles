import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addRepository, configPath, readConfig, removeRepository } from "../src/config.ts";
import { GitHubClient, LIMITS, type FetchLike, type GitTreeEntry } from "../src/github.ts";
import { parseSkillMarkdown, SkillSearchService } from "../src/skills.ts";

interface FileSpec {
	data: string | Uint8Array;
	mode?: "100644" | "100755";
	size?: number;
	sha?: string;
}

interface Snapshot {
	commit: string;
	treeSha: string;
	files: Record<string, FileSpec>;
	extra?: GitTreeEntry[];
	truncated?: boolean;
}

interface RepositoryState {
	defaultBranch?: string;
	current: string;
	snapshots: Record<string, Snapshot>;
	failure?: { status: number; headers?: Record<string, string> };
}

function bytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function blobSha(value: Uint8Array): string {
	return createHash("sha1").update(Buffer.from(`blob ${value.byteLength}\0`)).update(value).digest("hex");
}

function snapshot(character: string, files: Record<string, FileSpec>, extra: GitTreeEntry[] = []): Snapshot {
	return { commit: character.repeat(40), treeSha: (character === "f" ? "e" : String.fromCharCode(character.charCodeAt(0) + 1)).repeat(40), files, extra };
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function createRemote(states: Record<string, RepositoryState>) {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		requests.push({ url: url.href, init });
		assert.equal(init?.redirect, "manual");
		assert.equal(init?.credentials, "omit");
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		if (url.hostname === "api.github.com" && parts[0] === "repos") {
			const repository = `${parts[1]}/${parts[2]}`;
			const state = states[repository];
			if (!state) return jsonResponse({}, 404);
			if (state.failure) return jsonResponse({}, state.failure.status, state.failure.headers);
			const selected = state.snapshots[state.current];
			if (parts.length === 3) return jsonResponse({ default_branch: state.defaultBranch ?? "main" });
			if (parts[3] === "commits") return jsonResponse({ sha: selected.commit, commit: { tree: { sha: selected.treeSha } } });
			if (parts[3] === "git" && parts[4] === "trees") {
				const target = Object.values(state.snapshots).find((entry) => entry.treeSha === parts[5]);
				if (!target) return jsonResponse({}, 404);
				const tree = Object.entries(target.files).map(([path, file]) => {
					const content = bytes(file.data);
					return { path, mode: file.mode ?? "100644", type: "blob", sha: file.sha ?? blobSha(content), size: file.size ?? content.byteLength };
				});
				return jsonResponse({ truncated: target.truncated ?? false, tree: [...tree, ...(target.extra ?? [])] });
			}
		}
		if (url.hostname === "raw.githubusercontent.com") {
			const repository = `${parts[0]}/${parts[1]}`;
			const commit = parts[2];
			const path = parts.slice(3).join("/");
			const target = Object.values(states[repository]?.snapshots ?? {}).find((entry) => entry.commit === commit);
			const file = target?.files[path];
			if (!file) return new Response("", { status: 404 });
			return new Response(bytes(file.data), { status: 200 });
		}
		return jsonResponse({}, 404);
	};
	return { fetch, requests };
}

async function stalledMetadataFixture(branch?: string) {
	const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Stalled metadata.\n---\n" } });
	const baseRemote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	let releaseStarted!: () => void;
	let releaseMetadata!: () => void;
	const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
	const metadataReleased = new Promise<void>((resolve) => { releaseMetadata = resolve; });
	const fetch: FetchLike = async (input, init) => {
		if (String(input).includes("raw.githubusercontent.com")) {
			releaseStarted();
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(new DOMException("Aborted", "AbortError"));
				if (init?.signal?.aborted) return abort();
				init?.signal?.addEventListener("abort", abort, { once: true });
				void metadataReleased.then(() => {
					init?.signal?.removeEventListener("abort", abort);
					resolve();
				});
			});
		}
		return baseRemote.fetch(input, init);
	};
	const directory = await mkdtemp(join(tmpdir(), "skill-search-stalled-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills", branch);
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(fetch), directory);
	return { directory, agentDir, service, started, releaseMetadata };
}

function internalSearchState(service: SkillSearchService): { issued: Map<string, unknown>; activeSearches: Set<unknown> } {
	return service as unknown as { issued: Map<string, unknown>; activeSearches: Set<unknown> };
}

async function fixture(repositories: Array<{ repository: string; branch?: string }>, states: Record<string, RepositoryState>) {
	const directory = await mkdtemp(join(tmpdir(), "skill-search-service-"));
	const agentDir = join(directory, "agent");
	for (const repository of repositories) await addRepository(configPath(agentDir), repository.repository, repository.branch);
	const remote = createRemote(states);
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(remote.fetch), directory);
	return { directory, agentDir, service, remote };
}

const PDF_SKILL = `---\nname: pdf-tools\ndescription: >-\n  Extract PDF text and tables, then\n  inspect document metadata.\nmetadata:\n  author: example\n---\n# PDF tools\n`;

const DUPLICATE_SKILL = `---\nname: pdf-tools\ndescription: 'Create searchable PDF files with OCR.'\n---\n# OCR\n`;

test("uses Pi's YAML parser for plain continuations, quoted values, folding, indentation, and chomping", () => {
	assert.deepEqual(parseSkillMarkdown(PDF_SKILL), {
		name: "pdf-tools",
		description: "Extract PDF text and tables, then inspect document metadata.",
	});
	assert.deepEqual(parseSkillMarkdown(DUPLICATE_SKILL), { name: "pdf-tools", description: "Create searchable PDF files with OCR." });
	assert.deepEqual(parseSkillMarkdown("---\nname: demo\ndescription: This is a long\n  valid YAML continuation.\n---\n"), {
		name: "demo",
		description: "This is a long valid YAML continuation.",
	});
	assert.deepEqual(parseSkillMarkdown("---\nname: demo\ndescription: >-\n  first line\n    indented code\n  final line\n---\n"), {
		name: "demo",
		description: "first line\n  indented code\nfinal line",
	});
	assert.equal(parseSkillMarkdown("---\nname: demo\ndescription: |+\n  first\n  second\n\n---\n").description.endsWith("\n"), true);
	assert.throws(() => parseSkillMarkdown("---\nname: Bad_Name\ndescription: x\n---\n"), /name rules/);
	assert.throws(() => parseSkillMarkdown("---\nname: okay\n---\n"), /description/);
	assert.throws(() => parseSkillMarkdown("---\n- not-a-mapping\n---\n"), /mapping|name rules/);
});

test("search discovers nested skills, returns full descriptions, ranks metadata, and keeps duplicates distinct", async () => {
	const first = snapshot("a", {
		"catalog/pdf/SKILL.md": { data: PDF_SKILL },
		"catalog/ocr/SKILL.md": { data: DUPLICATE_SKILL },
		"catalog/web/SKILL.md": { data: "---\nname: web-search\ndescription: Search websites.\n---\n" },
	});
	const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
	try {
		const result = await context.service.search("PDF text", undefined, 10);
		assert.equal(result.matches.length, 2);
		assert.equal(result.matches[0].description, "Extract PDF text and tables, then inspect document metadata.");
		assert.equal(result.matches.every((entry) => entry.name === "pdf-tools"), true);
		assert.equal(new Set(result.matches.map((entry) => entry.skillId)).size, 2);
		assert.equal(result.matches[0].revision, "a".repeat(40));
		assert.equal(result.errors.length, 0);
		assert.equal((await readdir(context.directory)).some((name) => name.startsWith("pi-skill-search-")), false, "search must not materialize files");
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("search discovers a uniquely matching 501st skill without a per-repository count cap", async () => {
	const files = Object.fromEntries(Array.from({ length: 501 }, (_, index) => {
		const sequence = String(index).padStart(4, "0");
		const isTarget = index === 500;
		return [
			`catalog/skill-${sequence}/SKILL.md`,
			{
				data: isTarget
					? "---\nname: target-skill\ndescription: Unique needle capability.\n---\n"
					: `---\nname: helper-${index}\ndescription: General helper number ${index}.\n---\n`,
			},
		];
	}));
	const first = snapshot("a", files);
	const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
	try {
		const result = await context.service.search("needle capability", undefined, 1);
		assert.equal(result.matches.length, 1, "result count must respect the requested limit");
		assert.equal(result.matches[0].name, "target-skill");
		assert.equal(result.matches[0].path, "catalog/skill-0500/SKILL.md");
		assert.deepEqual(result.errors, []);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("search tie ordering is deterministic and independent of host locale", async () => {
	const metadata = "---\nname: tied-skill\ndescription: Matching helper.\n---\n";
	const first = snapshot("a", {
		"ä/SKILL.md": { data: metadata },
		"z/SKILL.md": { data: metadata },
	});
	const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
	try {
		const result = await context.service.search("matching", undefined, 10);
		assert.deepEqual(result.matches.map((entry) => entry.path), ["z/SKILL.md", "ä/SKILL.md"]);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("read binds to searched commit and materializes nested binary and executable assets without running them", async () => {
	const sentinelPath = join(tmpdir(), `pi-skill-search-must-not-exist-${crypto.randomUUID()}`);
	const first = snapshot("a", {
		"tools/demo/SKILL.md": { data: "---\nname: demo-skill\ndescription: Demo asset handling.\n---\n# Version one\n" },
		"tools/demo/references/guide.md": { data: "guide" },
		"tools/demo/assets/data.bin": { data: new Uint8Array([0, 255, 1, 2]) },
		"tools/demo/scripts/run.sh": { data: `#!/bin/sh\ntouch ${sentinelPath}\n`, mode: "100755" },
	});
	const second = snapshot("c", {
		"tools/demo/SKILL.md": { data: "---\nname: demo-skill\ndescription: Changed branch content.\n---\n# Version two\n" },
	});
	const state: RepositoryState = { current: "one", snapshots: { one: first, two: second } };
	const context = await fixture([{ repository: "acme/skills", branch: "main" }], { "acme/skills": state });
	try {
		const searched = await context.service.search("asset handling", undefined, 10);
		state.current = "two";
		const result = await context.service.read(searched.matches[0].skillId);
		assert.equal(result.revision, "a".repeat(40));
		assert.match(result.skillMarkdown, /Version one/);
		assert.deepEqual(new Uint8Array(await readFile(join(result.materializedPath, "assets/data.bin"))), new Uint8Array([0, 255, 1, 2]));
		assert.equal(await readFile(join(result.materializedPath, "references/guide.md"), "utf8"), "guide");
		assert.equal((await stat(join(result.materializedPath, "scripts/run.sh"))).mode & 0o777, 0o700);
		assert.equal(result.fileCount, 4);
		await assert.rejects(() => access(sentinelPath));
		assert.equal(context.remote.requests.some((request) => request.url.includes("/" + "a".repeat(40) + "/tools/demo/scripts/run.sh")), true);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
		await rm(sentinelPath, { force: true });
	}
});

test("read rejects fabricated IDs and invalidates IDs after approval changes", async () => {
	const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Find demo things.\n---\n" } });
	const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
	try {
		await assert.rejects(() => context.service.read(`skill_${crypto.randomUUID()}`), /Unknown or expired/);
		const searched = await context.service.search("demo", undefined, 10);
		await removeRepository(configPath(context.agentDir), "acme/skills");
		await assert.rejects(() => context.service.read(searched.matches[0].skillId), /approval changed/);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

const unsafeCases: Array<{ name: string; extra: GitTreeEntry; expected: RegExp }> = [
	{ name: "symlink", extra: { path: "demo/link", mode: "120000", type: "blob", sha: "b".repeat(40), size: 3 }, expected: /symbolic link/ },
	{ name: "submodule", extra: { path: "demo/sub", mode: "160000", type: "commit", sha: "b".repeat(40) }, expected: /submodule/ },
	{ name: "traversal", extra: { path: "demo/../escape", mode: "100644", type: "blob", sha: "b".repeat(40), size: 1 }, expected: /unsafe tree path/ },
	{ name: "Windows alternate data stream", extra: { path: "demo/file.txt:payload", mode: "100644", type: "blob", sha: "b".repeat(40), size: 1 }, expected: /unsafe tree path/ },
	{ name: "Windows reserved device", extra: { path: "demo/CON.txt", mode: "100644", type: "blob", sha: "b".repeat(40), size: 1 }, expected: /unsafe tree path/ },
	{ name: "Windows-trimmed trailing dot", extra: { path: "demo/trailing.", mode: "100644", type: "blob", sha: "b".repeat(40), size: 1 }, expected: /unsafe tree path/ },
];

for (const unsafe of unsafeCases) {
	test(`read rejects ${unsafe.name} entries`, async () => {
		const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Demo safety.\n---\n" } }, [unsafe.extra]);
		const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
		try {
			const searched = await context.service.search("safety", undefined, 10);
			await assert.rejects(() => context.service.read(searched.matches[0].skillId), unsafe.expected);
		} finally {
			await context.service.cleanup();
			await rm(context.directory, { recursive: true, force: true });
		}
	});
}

test("read rejects Unicode/case collisions and declared oversize files", async () => {
	for (const files of [
		{
			"demo/SKILL.md": { data: "---\nname: demo\ndescription: Collision safety.\n---\n" },
			"demo/Docs/a.txt": { data: "a" },
			"demo/docs/b.txt": { data: "b" },
		},
		{
			"demo/SKILL.md": { data: "---\nname: demo\ndescription: Size safety.\n---\n" },
			"demo/huge.bin": { data: "x", size: LIMITS.fileBytes + 1 },
		},
	]) {
		const first = snapshot("a", files);
		const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
		try {
			const searched = await context.service.search("safety", undefined, 10);
			await assert.rejects(() => context.service.read(searched.matches[0].skillId), /colliding|larger/);
		} finally {
			await context.service.cleanup();
			await rm(context.directory, { recursive: true, force: true });
		}
	}
});

test("non-simple Unicode casefold names never overwrite or merge on the target filesystem", async () => {
	const first = snapshot("a", {
		"demo/SKILL.md": { data: "---\nname: demo\ndescription: Unicode collision safety.\n---\n" },
		"demo/Σ.txt": { data: "capital sigma" },
		"demo/ς.txt": { data: "final sigma" },
	});
	const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
	try {
		const searched = await context.service.search("collision safety", undefined, 10);
		try {
			const result = await context.service.read(searched.matches[0].skillId);
			assert.equal(result.fileCount, 3);
			assert.equal(await readFile(join(result.materializedPath, "Σ.txt"), "utf8"), "capital sigma");
			assert.equal(await readFile(join(result.materializedPath, "ς.txt"), "utf8"), "final sigma");
		} catch (error) {
			assert.match(error instanceof Error ? error.message : String(error), /colliding destination paths/);
		}
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("tree truncation and rate limits surface safe repository errors while other repositories still return results", async () => {
	const good = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Useful PDF helper.\n---\n" } });
	const truncated = snapshot("c", { "bad/SKILL.md": { data: PDF_SKILL } });
	truncated.truncated = true;
	const reset = Math.floor(Date.now() / 1000) + 60;
	const context = await fixture(
		[{ repository: "good/skills" }, { repository: "bad/truncated" }, { repository: "limited/skills" }],
		{
			"good/skills": { current: "one", snapshots: { one: good } },
			"bad/truncated": { current: "one", snapshots: { one: truncated } },
			"limited/skills": { current: "none", snapshots: {}, failure: { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } } },
		},
	);
	try {
		const result = await context.service.search("PDF", undefined, 10);
		assert.equal(result.matches.length, 1);
		assert.equal(result.errors.length, 2);
		assert.match(result.errors.find((entry) => entry.repository === "bad/truncated")?.error ?? "", /truncated/);
		assert.match(result.errors.find((entry) => entry.repository === "limited/skills")?.error ?? "", /rate limit resets at/);
		assert.equal(JSON.stringify(result.errors).includes("{}"), false, "raw response bodies must not be exposed");
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("repository refresh has no aggregate deadline when each request meets its timeout", async () => {
	const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Slow but bounded metadata.\n---\n" } });
	const baseRemote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	const fetch: FetchLike = async (input, init) => {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, 20);
			const abort = () => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			};
			if (init?.signal?.aborted) abort();
			else init?.signal?.addEventListener("abort", abort, { once: true });
		});
		return baseRemote.fetch(input, init);
	};
	const directory = await mkdtemp(join(tmpdir(), "skill-search-no-aggregate-timeout-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(fetch, 100), directory);
	const mutableLimits = LIMITS as unknown as Record<string, number>;
	const previousRepositoryTimeout = mutableLimits.repositoryTimeoutMs;
	// The removed implementation read this key for one aggregate deadline; current code must ignore it.
	mutableLimits.repositoryTimeoutMs = 45;
	try {
		const result = await service.search("bounded metadata", undefined, 10);
		assert.equal(result.matches[0]?.name, "demo");
		assert.deepEqual(result.errors, []);
	} finally {
		if (previousRepositoryTimeout === undefined) delete mutableLimits.repositoryTimeoutMs;
		else mutableLimits.repositoryTimeoutMs = previousRepositoryTimeout;
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});

test("stalled SKILL.md metadata is bounded by the per-request timeout", async () => {
	const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Stalled metadata.\n---\n" } });
	const baseRemote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	const fetch: FetchLike = async (input, init) => {
		if (String(input).includes("raw.githubusercontent.com") && String(input).endsWith("/SKILL.md")) {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			});
		}
		return baseRemote.fetch(input, init);
	};
	const directory = await mkdtemp(join(tmpdir(), "skill-search-request-timeout-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(fetch, 25), directory);
	try {
		const result = await service.search("stalled", undefined, 10);
		assert.equal(result.matches.length, 0);
		assert.match(result.errors[0]?.error ?? "", /blob demo\/SKILL\.md timed out/);
	} finally {
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});

test("caller cancellation aborts search instead of returning partial results", async () => {
	const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Cancelled metadata.\n---\n" } });
	const baseRemote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	const fetch: FetchLike = async (input, init) => {
		if (String(input).includes("raw.githubusercontent.com")) {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			});
		}
		return baseRemote.fetch(input, init);
	};
	const directory = await mkdtemp(join(tmpdir(), "skill-search-cancel-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(fetch), directory);
	try {
		const controller = new AbortController();
		const searching = service.search("cancelled", undefined, 10, controller.signal);
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(() => searching, /cancel|abort/i);
	} finally {
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});

test("session cleanup during the initial config read prevents search registration and ID issuance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "skill-search-initial-config-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const remote = createRemote({ "acme/skills": { current: "one", snapshots: { one: snapshot("a", {}) } } });
	let signalStarted!: () => void;
	let releaseConfig!: () => void;
	const started = new Promise<void>((resolve) => { signalStarted = resolve; });
	const released = new Promise<void>((resolve) => { releaseConfig = resolve; });
	const service = new SkillSearchService(
		configPath(agentDir),
		new GitHubClient(remote.fetch),
		directory,
		async (path) => {
			signalStarted();
			await released;
			return readConfig(path);
		},
	);
	try {
		const searching = service.search("demo", undefined, 10);
		await started;
		await service.cleanup();
		releaseConfig();
		await assert.rejects(() => searching, /session changed|cancelled/i);
		assert.equal(internalSearchState(service).issued.size, 0);
		assert.equal(internalSearchState(service).activeSearches.size, 0);
	} finally {
		releaseConfig();
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});

test("caller cancellation during the final config read prevents ID issuance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "skill-search-final-config-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Final config cancellation.\n---\n" } });
	const remote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	let signalFinalRead!: () => void;
	let releaseFinalRead!: () => void;
	const finalReadStarted = new Promise<void>((resolve) => { signalFinalRead = resolve; });
	const finalReadReleased = new Promise<void>((resolve) => { releaseFinalRead = resolve; });
	let configReads = 0;
	const service = new SkillSearchService(
		configPath(agentDir),
		new GitHubClient(remote.fetch),
		directory,
		async (path) => {
			configReads += 1;
			if (configReads === 2) {
				signalFinalRead();
				await finalReadReleased;
			}
			return readConfig(path);
		},
	);
	const controller = new AbortController();
	try {
		const searching = service.search("final config", undefined, 10, controller.signal);
		await finalReadStarted;
		controller.abort();
		releaseFinalRead();
		await assert.rejects(() => searching, /abort|cancel/i);
		assert.equal(configReads, 2);
		assert.equal(internalSearchState(service).issued.size, 0);
		assert.equal(internalSearchState(service).activeSearches.size, 0);
	} finally {
		releaseFinalRead();
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});

test("repository removal aborts stalled search before IDs are issued", async () => {
	const context = await stalledMetadataFixture();
	try {
		const searching = context.service.search("stalled", undefined, 10);
		await context.started;
		await removeRepository(configPath(context.agentDir), "acme/skills");
		context.service.invalidateRepository("acme/skills");
		await assert.rejects(() => searching, /approval changed|cancelled/i);
		assert.equal(internalSearchState(context.service).issued.size, 0);
		assert.equal(internalSearchState(context.service).activeSearches.size, 0);
		assert.equal((await readdir(context.directory)).some((name) => name.startsWith("pi-skill-search-")), false);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("branch replacement aborts stalled search before IDs are issued", async () => {
	const context = await stalledMetadataFixture("main");
	try {
		const searching = context.service.search("stalled", undefined, 10);
		await context.started;
		await removeRepository(configPath(context.agentDir), "acme/skills");
		await addRepository(configPath(context.agentDir), "acme/skills", "next");
		context.releaseMetadata();
		await assert.rejects(() => searching, /approval changed|cancelled/i);
		assert.equal(internalSearchState(context.service).issued.size, 0);
		assert.equal(internalSearchState(context.service).activeSearches.size, 0);
		assert.equal((await readdir(context.directory)).some((name) => name.startsWith("pi-skill-search-")), false);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("session cleanup aborts stalled search and removes all search state", async () => {
	const context = await stalledMetadataFixture();
	try {
		const searching = context.service.search("stalled", undefined, 10);
		await context.started;
		await context.service.cleanup();
		await assert.rejects(() => searching, /session changed|cancelled/i);
		assert.equal(internalSearchState(context.service).issued.size, 0);
		assert.equal(internalSearchState(context.service).activeSearches.size, 0);
		assert.equal((await readdir(context.directory)).some((name) => name.startsWith("pi-skill-search-")), false);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("concurrent first reads share one temp root and cleanup removes it", async () => {
	const first = snapshot("a", {
		"demo/SKILL.md": { data: "---\nname: demo\ndescription: Concurrent reads.\n---\n" },
		"demo/reference.md": { data: "reference" },
	});
	const context = await fixture([{ repository: "acme/skills" }], { "acme/skills": { current: "one", snapshots: { one: first } } });
	try {
		const searched = await context.service.search("concurrent", undefined, 10);
		const results = await Promise.all([
			context.service.read(searched.matches[0].skillId),
			context.service.read(searched.matches[0].skillId),
		]);
		assert.equal(new Set(results.map((result) => result.materializedPath)).size, 2);
		const roots = (await readdir(context.directory)).filter((name) => name.startsWith("pi-skill-search-"));
		assert.equal(roots.length, 1);
		await context.service.cleanup();
		assert.equal((await readdir(context.directory)).some((name) => name.startsWith("pi-skill-search-")), false);
		await assert.rejects(() => context.service.read(searched.matches[0].skillId), /Unknown or expired/);
	} finally {
		await context.service.cleanup();
		await rm(context.directory, { recursive: true, force: true });
	}
});

test("approval removal aborts an in-progress materialization and removes staging", async () => {
	const first = snapshot("a", {
		"demo/SKILL.md": { data: "---\nname: demo\ndescription: Revocable read.\n---\n" },
		"demo/asset.txt": { data: "asset" },
	});
	const baseRemote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	let releaseStarted!: () => void;
	const started = new Promise<void>((resolve) => { releaseStarted = resolve; });
	let hangAsset = false;
	const fetch: FetchLike = async (input, init) => {
		if (hangAsset && String(input).endsWith("/demo/asset.txt")) {
			releaseStarted();
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			});
		}
		return baseRemote.fetch(input, init);
	};
	const directory = await mkdtemp(join(tmpdir(), "skill-search-revoke-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(fetch), directory);
	try {
		const searched = await service.search("revocable", undefined, 10);
		hangAsset = true;
		const reading = service.read(searched.matches[0].skillId);
		await started;
		await removeRepository(configPath(agentDir), "acme/skills");
		service.invalidateRepository("acme/skills");
		await assert.rejects(() => reading, /approval changed/);
		const roots = (await readdir(directory)).filter((name) => name.startsWith("pi-skill-search-"));
		assert.equal(roots.length, 1);
		assert.deepEqual(await readdir(join(directory, roots[0])), []);
	} finally {
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});

test("temp-root setup failure leaves no partial materialization state", async () => {
	const first = snapshot("a", { "demo/SKILL.md": { data: "---\nname: demo\ndescription: Setup failure.\n---\n" } });
	const directory = await mkdtemp(join(tmpdir(), "skill-search-setup-"));
	const blockedBase = join(directory, "not-a-directory");
	await writeFile(blockedBase, "blocked");
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const remote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(remote.fetch), blockedBase);
	try {
		const searched = await service.search("setup", undefined, 10);
		await assert.rejects(() => service.read(searched.matches[0].skillId));
		assert.deepEqual((await readdir(directory)).sort(), ["agent", "not-a-directory"]);
	} finally {
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});

test("abort removes staging files and cleanup removes the session root", async () => {
	const first = snapshot("a", {
		"demo/SKILL.md": { data: "---\nname: demo\ndescription: Abortable demo.\n---\n" },
		"demo/asset.txt": { data: "asset" },
	});
	const baseRemote = createRemote({ "acme/skills": { current: "one", snapshots: { one: first } } });
	let hangAssets = false;
	const fetch: FetchLike = async (input, init) => {
		if (hangAssets && String(input).endsWith("/demo/asset.txt")) {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			});
		}
		return baseRemote.fetch(input, init);
	};
	const directory = await mkdtemp(join(tmpdir(), "skill-search-abort-"));
	const agentDir = join(directory, "agent");
	await addRepository(configPath(agentDir), "acme/skills");
	const service = new SkillSearchService(configPath(agentDir), new GitHubClient(fetch), directory);
	try {
		const searched = await service.search("Abortable", undefined, 10);
		hangAssets = true;
		const controller = new AbortController();
		const reading = service.read(searched.matches[0].skillId, controller.signal);
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(() => reading, /cancel|abort/i);
		const roots = (await readdir(directory)).filter((name) => name.startsWith("pi-skill-search-"));
		assert.equal(roots.length, 1);
		assert.deepEqual(await readdir(join(directory, roots[0])), []);
		await service.cleanup();
		assert.equal((await readdir(directory)).some((name) => name.startsWith("pi-skill-search-")), false);
	} finally {
		await service.cleanup();
		await rm(directory, { recursive: true, force: true });
	}
});
