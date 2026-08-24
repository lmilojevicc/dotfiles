import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { normalizeRepository, readConfig, type SkillRepositoryConfig } from "./config.ts";
import { GitHubClient, LIMITS, type GitTreeEntry, type RepositorySnapshot } from "./github.ts";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OUTPUT_MARKDOWN_BYTES = 40 * 1024;
const OUTPUT_MARKDOWN_LINES = 1_800;

export interface SkillSearchMatch {
	skillId: string;
	name: string;
	description: string;
	repository: string;
	branch: string;
	revision: string;
	path: string;
	score: number;
}

export interface SkillSearchResult {
	query: string;
	matches: SkillSearchMatch[];
	errors: Array<{ repository: string; error: string }>;
}

export interface ReadSkillResult {
	name: string;
	description: string;
	repository: string;
	branch: string;
	revision: string;
	skillPath: string;
	materializedPath: string;
	skillMarkdownPath: string;
	skillMarkdown: string;
	markdownTruncated: boolean;
	fileCount: number;
	totalBytes: number;
}

interface ParsedSkill {
	name: string;
	description: string;
}

interface IssuedSkill extends ParsedSkill {
	repository: string;
	configuredBranch?: string;
	branch: string;
	commit: string;
	skillMarkdownPath: string;
	skillDirectory: string;
	tree: GitTreeEntry[];
}

interface ActiveSearch {
	controller: AbortController;
	repositories: Set<string>;
	repositoryGenerations: Map<string, number>;
	sessionGeneration: number;
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : "Unknown repository error.";
	return message.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").slice(0, 300);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${label} is not valid UTF-8.`);
	}
}

export function parseSkillMarkdown(markdown: string): ParsedSkill {
	let parsed: unknown;
	try {
		parsed = parseFrontmatter(markdown).frontmatter;
	} catch {
		throw new Error("SKILL.md contains invalid YAML frontmatter.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("SKILL.md frontmatter must be a YAML mapping.");
	}
	const { name, description } = parsed as Record<string, unknown>;
	if (typeof name !== "string" || name.length > 64 || !SKILL_NAME.test(name) || name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
		throw new Error("Skill name does not satisfy Pi's skill name rules.");
	}
	if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
		throw new Error("Skill description must contain 1 to 1024 characters.");
	}
	return { name, description };
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/i;

function validateTreePath(path: string): string[] {
	if (!path || path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || posix.normalize(path) !== path) {
		throw new Error("Repository contains an unsafe tree path.");
	}
	const components = path.split("/");
	if (components.some((part) =>
		!part
		|| part === "."
		|| part === ".."
		|| part.includes(":")
		|| part.endsWith(".")
		|| part.endsWith(" ")
		|| WINDOWS_RESERVED_NAME.test(part)
		|| Buffer.byteLength(part) > 255
	)) {
		throw new Error("Repository contains an unsafe tree path.");
	}
	if (Buffer.byteLength(path) > 4096) throw new Error("Repository contains an overlong tree path.");
	return components;
}

function skillCandidates(snapshot: RepositorySnapshot): GitTreeEntry[] {
	const candidates = snapshot.tree.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"));
	for (const entry of candidates) {
		validateTreePath(entry.path);
		if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
			throw new Error("A discovered SKILL.md is not a regular file.");
		}
		if (entry.size !== undefined && entry.size > LIMITS.skillMarkdownBytes) {
			throw new Error("A discovered SKILL.md exceeds the size limit.");
		}
	}
	return candidates;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failure: unknown;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (failure === undefined) {
			const index = next++;
			if (index >= items.length) return;
			try {
				results[index] = await operation(items[index], index);
			} catch (error) {
				failure = error;
			}
		}
	});
	await Promise.all(workers);
	if (failure !== undefined) throw failure;
	return results;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function searchScore(name: string, description: string, query: string): number {
	const normalizedQuery = query.toLowerCase();
	const normalizedName = name.toLowerCase();
	const normalizedDescription = description.toLowerCase();
	const terms = [...new Set(normalizedQuery.split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
	let score = normalizedName === normalizedQuery ? 1000 : 0;
	if (normalizedName.includes(normalizedQuery)) score += 250;
	if (normalizedDescription.includes(normalizedQuery)) score += 120;
	for (const term of terms) {
		if (normalizedName.split("-").includes(term)) score += 60;
		else if (normalizedName.includes(term)) score += 35;
		if (normalizedDescription.includes(term)) score += 15;
	}
	return score;
}

function insideSkill(entryPath: string, directory: string): string | undefined {
	if (!directory) return entryPath;
	const prefix = `${directory}/`;
	return entryPath.startsWith(prefix) ? entryPath.slice(prefix.length) : undefined;
}

interface MaterializedFile {
	entry: GitTreeEntry;
	relativePath: string;
	executable: boolean;
}

function selectSkillFiles(issued: IssuedSkill): MaterializedFile[] {
	const files: MaterializedFile[] = [];
	const fileKeys = new Set<string>();
	const directoryKeys = new Set<string>();
	const spellings = new Map<string, string>();
	let declaredTotal = 0;
	for (const entry of issued.tree) {
		validateTreePath(entry.path);
		const relativePath = insideSkill(entry.path, issued.skillDirectory);
		if (relativePath === undefined || relativePath === "") continue;
		validateTreePath(relativePath);
		if (entry.type === "tree" && entry.mode === "040000") continue;
		if (entry.type === "commit" || entry.mode === "160000") throw new Error("Selected skill contains a submodule.");
		if (entry.mode === "120000") throw new Error("Selected skill contains a symbolic link.");
		if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
			throw new Error("Selected skill contains an unsupported object type.");
		}
		if (entry.size !== undefined && entry.size > LIMITS.fileBytes) throw new Error(`Selected skill contains a file larger than ${LIMITS.fileBytes} bytes.`);
		declaredTotal += entry.size ?? 0;
		if (declaredTotal > LIMITS.skillBytes) throw new Error(`Selected skill exceeds ${LIMITS.skillBytes} bytes.`);

		const parts = relativePath.split("/");
		const normalizedParts = parts.map((part) => part.normalize("NFC").toLowerCase());
		const fileKey = normalizedParts.join("/");
		const ancestors = normalizedParts.slice(0, -1).map((_, index) => normalizedParts.slice(0, index + 1).join("/"));
		const originalParts = parts.map((part) => part.normalize("NFC"));
		const originalAncestors = originalParts.slice(0, -1).map((_, index) => originalParts.slice(0, index + 1).join("/"));
		if (fileKeys.has(fileKey) || directoryKeys.has(fileKey) || ancestors.some((key) => fileKeys.has(key))) {
			throw new Error("Selected skill contains colliding destination paths.");
		}
		for (let index = 0; index < ancestors.length; index += 1) {
			const spelling = spellings.get(ancestors[index]);
			if (spelling !== undefined && spelling !== originalAncestors[index]) throw new Error("Selected skill contains colliding destination paths.");
			spellings.set(ancestors[index], originalAncestors[index]);
		}
		spellings.set(fileKey, originalParts.join("/"));
		fileKeys.add(fileKey);
		for (const key of ancestors) directoryKeys.add(key);
		files.push({ entry, relativePath, executable: entry.mode === "100755" });
	}
	if (files.length > LIMITS.skillFiles) throw new Error(`Selected skill contains more than ${LIMITS.skillFiles} files.`);
	if (!files.some((file) => file.relativePath === "SKILL.md")) throw new Error("Selected skill no longer contains SKILL.md.");
	return files;
}

function abortError(message = "Operation cancelled."): DOMException {
	return new DOMException(message, "AbortError");
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

async function assertExactEntry(parent: string, name: string, directory: boolean): Promise<void> {
	const entries = await readdir(parent, { withFileTypes: true });
	const exact = entries.find((entry) => entry.name === name);
	if (!exact || (directory ? !exact.isDirectory() : !exact.isFile())) {
		throw new Error("Selected skill contains colliding destination paths.");
	}
}

async function createExactDirectories(stage: string, files: readonly MaterializedFile[]): Promise<void> {
	const directories = new Set<string>();
	for (const file of files) {
		const parts = file.relativePath.split("/").slice(0, -1);
		for (let length = 1; length <= parts.length; length += 1) directories.add(parts.slice(0, length).join("/"));
	}
	const ordered = [...directories].sort((left, right) => left.split("/").length - right.split("/").length || compareText(left, right));
	for (const directory of ordered) {
		const parts = directory.split("/");
		const parent = resolve(stage, ...parts.slice(0, -1));
		const destination = resolve(parent, parts.at(-1)!);
		try {
			await mkdir(destination, { mode: 0o700 });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		await assertExactEntry(parent, parts.at(-1)!, true);
		await chmod(destination, 0o700);
	}
}

function composeSignal(parents: readonly (AbortSignal | undefined)[], timeoutMs?: number): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
	const controller = new AbortController();
	let timedOut = false;
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	for (const parent of parents) {
		if (!parent) continue;
		const listener = () => controller.abort(parent.reason ?? abortError());
		if (parent.aborted) listener();
		else {
			parent.addEventListener("abort", listener, { once: true });
			listeners.push({ signal: parent, listener });
		}
	}
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
		timedOut = true;
		controller.abort(abortError("Timed out."));
	}, timeoutMs);
	timer?.unref?.();
	return {
		signal: controller.signal,
		cleanup: () => {
			if (timer !== undefined) clearTimeout(timer);
			for (const entry of listeners) entry.signal.removeEventListener("abort", entry.listener);
		},
		timedOut: () => timedOut,
	};
}

function truncateMarkdown(markdown: string): { text: string; truncated: boolean } {
	const lines = markdown.split("\n");
	const lineBounded = lines.length > OUTPUT_MARKDOWN_LINES ? lines.slice(0, OUTPUT_MARKDOWN_LINES).join("\n") : markdown;
	const bytes = Buffer.from(lineBounded, "utf8");
	if (bytes.byteLength <= OUTPUT_MARKDOWN_BYTES) return { text: lineBounded, truncated: lineBounded !== markdown };
	let end = OUTPUT_MARKDOWN_BYTES;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export class SkillSearchService {
	private readonly issued = new Map<string, IssuedSkill>();
	private readonly activeReads = new Map<string, Set<AbortController>>();
	private readonly activeSearches = new Set<ActiveSearch>();
	private readonly repositoryGenerations = new Map<string, number>();
	private sessionGeneration = 0;
	private readonly configurationPath: string;
	private readonly github: GitHubClient;
	private readonly temporaryBase: string;
	private readonly configurationReader: (path: string) => Promise<SkillRepositoryConfig>;
	private sessionRootPromise?: Promise<string>;

	constructor(
		configurationPath: string,
		github: GitHubClient,
		temporaryBase: string = tmpdir(),
		configurationReader: (path: string) => Promise<SkillRepositoryConfig> = readConfig,
	) {
		this.configurationPath = configurationPath;
		this.github = github;
		this.temporaryBase = temporaryBase;
		this.configurationReader = configurationReader;
	}

	async search(queryInput: string, repositoryInput: string | undefined, limit: number, signal?: AbortSignal): Promise<SkillSearchResult> {
		const query = queryInput.trim();
		if (!query || queryInput.length > 200) throw new Error("Query must contain 1 to 200 characters.");
		if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Limit must be an integer from 1 to 20.");
		const sessionGeneration = this.sessionGeneration;
		const config = await this.configurationReader(this.configurationPath);
		if (this.sessionGeneration !== sessionGeneration) throw abortError("Search cancelled because the Pi session changed.");
		if (signal?.aborted) throw signal.reason ?? abortError();
		let repositories = config.repositories;
		if (repositoryInput !== undefined) {
			const repository = normalizeRepository(repositoryInput);
			const approved = repositories.find((entry) => entry.repository === repository);
			if (!approved) throw new Error(`${repository} is not an approved skill repository.`);
			repositories = [approved];
		}
		const active: ActiveSearch = {
			controller: new AbortController(),
			repositories: new Set(repositories.map((entry) => entry.repository)),
			repositoryGenerations: new Map(repositories.map((entry) => [entry.repository, this.repositoryGenerations.get(entry.repository) ?? 0])),
			sessionGeneration,
		};
		this.activeSearches.add(active);
		const errors: SkillSearchResult["errors"] = [];
		const discovered: Array<Omit<SkillSearchMatch, "skillId" | "score"> & { issued: IssuedSkill }> = [];
		try {
			await mapLimit(repositories, 2, async (approved) => {
				const operation = composeSignal([signal, active.controller.signal]);
				try {
					const snapshot = await this.github.resolve(approved.repository, approved.branch, operation.signal);
					const candidates = skillCandidates(snapshot);
					const parsed = await mapLimit(candidates, 4, async (entry) => {
						const bytes = await this.github.blob(snapshot.repository, snapshot.commit, entry.path, entry.sha, LIMITS.skillMarkdownBytes, operation.signal);
						const markdown = decodeUtf8(bytes, "SKILL.md");
						try {
							return { entry, metadata: parseSkillMarkdown(markdown) };
						} catch {
							return undefined;
						}
					});
					let invalid = 0;
					for (const item of parsed) {
						if (!item) { invalid += 1; continue; }
						const directory = posix.dirname(item.entry.path) === "." ? "" : posix.dirname(item.entry.path);
						const issued: IssuedSkill = {
							...item.metadata,
							repository: snapshot.repository,
							configuredBranch: approved.branch,
							branch: snapshot.branch,
							commit: snapshot.commit,
							skillMarkdownPath: item.entry.path,
							skillDirectory: directory,
							tree: snapshot.tree,
						};
						discovered.push({
							name: issued.name,
							description: issued.description,
							repository: issued.repository,
							branch: issued.branch,
							revision: issued.commit,
							path: issued.skillMarkdownPath,
							issued,
						});
					}
					if (invalid > 0) errors.push({ repository: approved.repository, error: `${invalid} skill(s) had invalid metadata and were skipped.` });
				} catch (error) {
					if (active.controller.signal.aborted) throw active.controller.signal.reason ?? abortError();
					if (signal?.aborted) throw signal.reason ?? abortError();
					errors.push({ repository: approved.repository, error: safeError(error) });
				} finally {
					operation.cleanup();
				}
			});
			if (active.controller.signal.aborted) throw active.controller.signal.reason ?? abortError();
			if (signal?.aborted) throw signal.reason ?? abortError();
			if (this.sessionGeneration !== active.sessionGeneration) throw abortError("Search cancelled because the Pi session changed.");
			const current = await this.configurationReader(this.configurationPath);
			if (active.controller.signal.aborted) throw active.controller.signal.reason ?? abortError();
			if (signal?.aborted) throw signal.reason ?? abortError();
			if (this.sessionGeneration !== active.sessionGeneration) throw abortError("Search cancelled because the Pi session changed.");
			for (const approved of repositories) {
				const generation = this.repositoryGenerations.get(approved.repository) ?? 0;
				const stillApproved = current.repositories.find((entry) => entry.repository === approved.repository);
				if (generation !== active.repositoryGenerations.get(approved.repository) || !stillApproved || stillApproved.branch !== approved.branch) {
					throw abortError("Search cancelled because a repository approval changed.");
				}
			}
			if (active.controller.signal.aborted) throw active.controller.signal.reason ?? abortError();
			if (signal?.aborted) throw signal.reason ?? abortError();
			if (this.sessionGeneration !== active.sessionGeneration) throw abortError("Search cancelled because the Pi session changed.");
			const matches = discovered
				.map((skill) => ({ skill, score: searchScore(skill.name, skill.description, query) }))
				.filter((entry) => entry.score > 0)
				.sort((left, right) => right.score - left.score || compareText(left.skill.name, right.skill.name) || compareText(left.skill.repository, right.skill.repository) || compareText(left.skill.path, right.skill.path))
				.slice(0, limit)
				.map(({ skill, score }) => {
					const skillId = `skill_${crypto.randomUUID()}`;
					this.issued.set(skillId, skill.issued);
					const { issued: _issued, ...metadata } = skill;
					return { skillId, ...metadata, score };
				});
			return { query, matches, errors };
		} finally {
			this.activeSearches.delete(active);
		}
	}

	invalidateRepository(repository: string): void {
		this.repositoryGenerations.set(repository, (this.repositoryGenerations.get(repository) ?? 0) + 1);
		for (const search of this.activeSearches) {
			if (search.repositories.has(repository)) search.controller.abort(abortError("Search cancelled because a repository approval changed."));
		}
		for (const [skillId, issued] of this.issued) {
			if (issued.repository === repository) this.issued.delete(skillId);
		}
		for (const controller of this.activeReads.get(repository) ?? []) {
			controller.abort(new Error("This skill ID was invalidated because its repository approval changed."));
		}
	}

	private registerRead(repository: string, controller: AbortController): void {
		const active = this.activeReads.get(repository) ?? new Set<AbortController>();
		active.add(controller);
		this.activeReads.set(repository, active);
	}

	private releaseRead(repository: string, controller: AbortController): void {
		const active = this.activeReads.get(repository);
		active?.delete(controller);
		if (active?.size === 0) this.activeReads.delete(repository);
	}

	private async assertApproved(skillId: string, issued: IssuedSkill): Promise<void> {
		const config = await readConfig(this.configurationPath);
		const approved = config.repositories.find((entry) => entry.repository === issued.repository);
		if (this.issued.get(skillId) !== issued || !approved || approved.branch !== issued.configuredBranch) {
			this.invalidateRepository(issued.repository);
			throw new Error("This skill ID was invalidated because its repository approval changed.");
		}
	}

	private async root(): Promise<string> {
		const existing = this.sessionRootPromise;
		if (existing) return existing;
		const initializing = (async () => {
			let root: string | undefined;
			try {
				root = await mkdtemp(join(this.temporaryBase, "pi-skill-search-"));
				await chmod(root, 0o700);
				return root;
			} catch (error) {
				if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
		})();
		this.sessionRootPromise = initializing;
		try {
			return await initializing;
		} catch (error) {
			if (this.sessionRootPromise === initializing) this.sessionRootPromise = undefined;
			throw error;
		}
	}

	async read(skillId: string, signal?: AbortSignal): Promise<ReadSkillResult> {
		if (!/^skill_[0-9a-f-]{36}$/.test(skillId)) throw new Error("Unknown or expired skill ID. Run search_skills again.");
		const issued = this.issued.get(skillId);
		if (!issued) throw new Error("Unknown or expired skill ID. Run search_skills again.");
		const invalidation = new AbortController();
		this.registerRead(issued.repository, invalidation);
		let operation: ReturnType<typeof composeSignal> | undefined;
		let stage: string | undefined;
		let target: string | undefined;
		try {
			await this.assertApproved(skillId, issued);
			const files = selectSkillFiles(issued);
			operation = composeSignal([signal, invalidation.signal], LIMITS.materializationMs);
			const root = await this.root();
			operation.signal.throwIfAborted();
			stage = await mkdtemp(join(root, ".stage-"));
			await chmod(stage, 0o700);
			target = join(root, `${issued.name}-${crypto.randomUUID()}`);
			await createExactDirectories(stage, files);
			let totalBytes = 0;
			await mapLimit(files, 4, async (file) => {
				operation!.signal.throwIfAborted();
				const bytes = await this.github.blob(issued.repository, issued.commit, file.entry.path, file.entry.sha, LIMITS.fileBytes, operation!.signal);
				totalBytes += bytes.byteLength;
				if (totalBytes > LIMITS.skillBytes) throw new Error(`Selected skill exceeds ${LIMITS.skillBytes} bytes.`);
				const destination = resolve(stage!, ...file.relativePath.split("/"));
				const containment = relative(stage!, destination);
				if (!containment || isAbsolute(containment) || containment.startsWith(`..${sep}`) || containment === ".." || resolve(destination) === resolve(stage!)) {
					throw new Error("Selected skill contains an unsafe destination path.");
				}
				let handle: Awaited<ReturnType<typeof open>>;
				try {
					handle = await open(destination, "wx", file.executable ? 0o700 : 0o600);
				} catch (error) {
					if (errorCode(error) === "EEXIST") throw new Error("Selected skill contains colliding destination paths.");
					throw error;
				}
				try { await handle.writeFile(bytes); } finally { await handle.close(); }
				await chmod(destination, file.executable ? 0o700 : 0o600);
				await assertExactEntry(dirname(destination), file.relativePath.split("/").at(-1)!, false);
			});
			operation.signal.throwIfAborted();
			await this.assertApproved(skillId, issued);
			operation.signal.throwIfAborted();
			await rename(stage, target);
			stage = undefined;
			await this.assertApproved(skillId, issued);
			const markdownPath = join(target, "SKILL.md");
			const fullMarkdown = await readFile(markdownPath, "utf8");
			operation.signal.throwIfAborted();
			await this.assertApproved(skillId, issued);
			operation.signal.throwIfAborted();
			const markdown = truncateMarkdown(fullMarkdown);
			return {
				name: issued.name,
				description: issued.description,
				repository: issued.repository,
				branch: issued.branch,
				revision: issued.commit,
				skillPath: issued.skillDirectory || ".",
				materializedPath: target,
				skillMarkdownPath: markdownPath,
				skillMarkdown: markdown.text,
				markdownTruncated: markdown.truncated,
				fileCount: files.length,
				totalBytes,
			};
		} catch (error) {
			await Promise.all([
				stage ? rm(stage, { recursive: true, force: true }).catch(() => undefined) : undefined,
				target ? rm(target, { recursive: true, force: true }).catch(() => undefined) : undefined,
			]);
			if (invalidation.signal.aborted) {
				throw invalidation.signal.reason instanceof Error ? invalidation.signal.reason : abortError();
			}
			if (operation?.timedOut()) throw new Error("Skill materialization timed out.");
			if (signal?.aborted) throw abortError();
			throw error;
		} finally {
			operation?.cleanup();
			this.releaseRead(issued.repository, invalidation);
		}
	}

	async cleanup(): Promise<void> {
		this.sessionGeneration += 1;
		for (const search of this.activeSearches) {
			search.controller.abort(abortError("Search cancelled because the Pi session changed."));
		}
		this.issued.clear();
		for (const controllers of this.activeReads.values()) {
			for (const controller of controllers) controller.abort(new Error("This skill ID expired because the Pi session changed."));
		}
		this.activeReads.clear();
		const rootPromise = this.sessionRootPromise;
		this.sessionRootPromise = undefined;
		if (!rootPromise) return;
		const root = await rootPromise.catch(() => undefined);
		if (root) await rm(root, { recursive: true, force: true });
	}
}
