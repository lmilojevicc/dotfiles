import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ApprovedRepository {
	repository: string;
	branch?: string;
}

export interface SkillRepositoryConfig {
	version: 1;
	repositories: ApprovedRepository[];
}

export const EMPTY_CONFIG: SkillRepositoryConfig = { version: 1, repositories: [] };

export function configPath(agentDir: string): string {
	return join(agentDir, "skill-repositories.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRepository(input: string): string {
	const value = input.trim();
	if (!value) throw new Error("Repository is required.");

	let owner: string;
	let repository: string;
	if (/^https?:\/\//i.test(value) || /^github\.com\//i.test(value)) {
		const candidate = /^github\.com\//i.test(value) ? `https://${value}` : value;
		const authority = /^https?:\/\/([^/]+)/i.exec(candidate)?.[1] ?? "";
		if (authority.includes(":")) throw new Error("Repository URLs cannot contain ports.");
		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			throw new Error("Repository must be owner/repo or a github.com URL.");
		}
		if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
			throw new Error("Only https://github.com public repositories are supported.");
		}
		if (url.username || url.password || url.port || url.search || url.hash) {
			throw new Error("Repository URLs cannot contain credentials, ports, queries, or fragments.");
		}
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length !== 2) throw new Error("Repository URL must contain exactly owner/repo.");
		[owner, repository] = parts;
	} else {
		const parts = value.split("/");
		if (parts.length !== 2) throw new Error("Repository must be owner/repo.");
		[owner, repository] = parts;
	}

	if (repository.toLowerCase().endsWith(".git")) repository = repository.slice(0, -4);
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || owner.endsWith("-")) {
		throw new Error("Invalid GitHub owner name.");
	}
	if (!/^[A-Za-z0-9._-]{1,100}$/.test(repository) || repository === "." || repository === "..") {
		throw new Error("Invalid GitHub repository name.");
	}
	return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

export function validateBranch(input: string): string {
	const branch = input.trim();
	if (!branch || branch.length > 255 || branch !== input) throw new Error("Invalid branch name.");
	if (/\s|[~^:?*\\\[\x00-\x1f\x7f]/.test(branch)) throw new Error("Invalid branch name.");
	if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("//")) {
		throw new Error("Invalid branch name.");
	}
	if (branch.includes("..") || branch.includes("@{") || branch === "@") throw new Error("Invalid branch name.");
	if (branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
		throw new Error("Invalid branch name.");
	}
	return branch;
}

export function parseConfig(value: unknown): SkillRepositoryConfig {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.repositories)) {
		throw new Error("Expected { version: 1, repositories: [...] }.");
	}
	if (Object.keys(value).some((key) => key !== "version" && key !== "repositories")) {
		throw new Error("Unknown top-level configuration field.");
	}
	const repositories: ApprovedRepository[] = [];
	const identities = new Set<string>();
	for (const entry of value.repositories) {
		if (!isRecord(entry) || typeof entry.repository !== "string") throw new Error("Invalid repository entry.");
		const keys = Object.keys(entry);
		if (keys.some((key) => key !== "repository" && key !== "branch")) throw new Error("Unknown repository entry field.");
		if (entry.branch !== undefined && typeof entry.branch !== "string") throw new Error("Invalid repository branch.");
		const repository = normalizeRepository(entry.repository);
		const branch = entry.branch === undefined ? undefined : validateBranch(entry.branch);
		if (identities.has(repository)) throw new Error(`Duplicate repository: ${repository}.`);
		identities.add(repository);
		repositories.push(branch ? { repository, branch } : { repository });
	}
	return { version: 1, repositories };
}

export async function readConfig(path: string): Promise<SkillRepositoryConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { ...EMPTY_CONFIG, repositories: [] };
		throw new Error(`Could not read ${path}.`);
	}
	try {
		return parseConfig(JSON.parse(text) as unknown);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "invalid JSON";
		throw new Error(`Invalid ${path}: ${reason}`);
	}
}

export async function writeConfig(path: string, config: SkillRepositoryConfig): Promise<void> {
	const validated = parseConfig(config);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function addRepository(path: string, repositoryInput: string, branchInput?: string): Promise<SkillRepositoryConfig> {
	const config = await readConfig(path);
	const repository = normalizeRepository(repositoryInput);
	const branch = branchInput === undefined ? undefined : validateBranch(branchInput);
	if (config.repositories.some((entry) => entry.repository === repository)) {
		throw new Error(`${repository} is already approved; remove it before changing its branch.`);
	}
	const next: SkillRepositoryConfig = {
		version: 1,
		repositories: [...config.repositories, branch ? { repository, branch } : { repository }],
	};
	await writeConfig(path, next);
	return next;
}

export async function removeRepository(path: string, repositoryInput: string): Promise<SkillRepositoryConfig> {
	const config = await readConfig(path);
	const repository = normalizeRepository(repositoryInput);
	const next = config.repositories.filter((entry) => entry.repository !== repository);
	if (next.length === config.repositories.length) throw new Error(`${repository} is not approved.`);
	const updated: SkillRepositoryConfig = { version: 1, repositories: next };
	await writeConfig(path, updated);
	return updated;
}
