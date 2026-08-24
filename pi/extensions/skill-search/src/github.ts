import { createHash } from "node:crypto";
import { validateBranch } from "./config.ts";

export const LIMITS = {
	treeBytes: 8 * 1024 * 1024,
	treeEntries: 25_000,
	skillsPerRepository: 500,
	skillMarkdownBytes: 256 * 1024,
	skillFiles: 512,
	fileBytes: 10 * 1024 * 1024,
	skillBytes: 50 * 1024 * 1024,
	requestMs: 15_000,
	repositoryMs: 30_000,
	materializationMs: 60_000,
} as const;

export interface GitTreeEntry {
	path: string;
	mode: string;
	type: string;
	sha: string;
	size?: number;
}

export interface RepositorySnapshot {
	repository: string;
	branch: string;
	commit: string;
	tree: GitTreeEntry[];
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(message = "Operation cancelled."): Error {
	return new DOMException(message, "AbortError");
}

function composeSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
	const controller = new AbortController();
	let timeoutReached = false;
	const abort = () => controller.abort(parent?.reason ?? abortError());
	if (parent?.aborted) abort();
	else parent?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => {
		timeoutReached = true;
		controller.abort(abortError("Request timed out."));
	}, timeoutMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
		timedOut: () => timeoutReached,
	};
}

async function readBounded(response: Response, maximum: number, label: string): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared && Number.isFinite(Number(declared)) && Number(declared) > maximum) {
		throw new Error(`${label} exceeds the ${maximum}-byte limit.`);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximum) {
				await reader.cancel();
				throw new Error(`${label} exceeds the ${maximum}-byte limit.`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

function rateLimitContext(response: Response): string {
	const remaining = response.headers.get("x-ratelimit-remaining");
	const reset = response.headers.get("x-ratelimit-reset");
	if (remaining !== "0" && response.status !== 429) return "";
	if (!reset || !/^\d+$/.test(reset)) return " GitHub API rate limit was reached.";
	const date = new Date(Number(reset) * 1000);
	return Number.isNaN(date.getTime())
		? " GitHub API rate limit was reached."
		: ` GitHub API rate limit resets at ${date.toISOString()}.`;
}

function validateSha(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`GitHub returned an invalid ${label}.`);
	return value;
}

export class GitHubClient {
	private readonly fetchImpl: FetchLike;

	constructor(fetchImpl: FetchLike = globalThis.fetch) {
		this.fetchImpl = fetchImpl;
	}

	private async request(url: URL, maximum: number, label: string, signal?: AbortSignal, timeoutMs = LIMITS.requestMs): Promise<Uint8Array> {
		if (url.protocol !== "https:" || (url.hostname !== "api.github.com" && url.hostname !== "raw.githubusercontent.com")) {
			throw new Error("Refusing an unexpected GitHub host.");
		}
		const composed = composeSignal(signal, timeoutMs);
		try {
			const response = await this.fetchImpl(url, {
				method: "GET",
				headers: {
					Accept: url.hostname === "api.github.com" ? "application/vnd.github+json" : "application/octet-stream",
					"User-Agent": "pi-skill-search/1",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				redirect: "manual",
				credentials: "omit",
				cache: "no-store",
				signal: composed.signal,
			});
			if (response.status >= 300 && response.status < 400) throw new Error("GitHub redirects are not accepted.");
			if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}.${rateLimitContext(response)}`);
			return await readBounded(response, maximum, label);
		} catch (error) {
			if (composed.timedOut()) throw new Error(`${label} timed out.`);
			if (signal?.aborted) throw abortError();
			if (error instanceof Error) throw error;
			throw new Error(`${label} failed.`);
		} finally {
			composed.cleanup();
		}
	}

	private async json(url: URL, maximum: number, label: string, signal?: AbortSignal): Promise<unknown> {
		const bytes = await this.request(url, maximum, label, signal);
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
		} catch {
			throw new Error(`GitHub returned invalid JSON for ${label}.`);
		}
	}

	async resolve(repository: string, configuredBranch: string | undefined, signal?: AbortSignal): Promise<RepositorySnapshot> {
		const [owner, name] = repository.split("/");
		const outer = composeSignal(signal, LIMITS.repositoryMs);
		try {
			let branch = configuredBranch;
			if (!branch) {
				const metadata = await this.json(new URL(`https://api.github.com/repos/${owner}/${name}`), 1024 * 1024, "repository metadata", outer.signal);
				if (!isRecord(metadata) || typeof metadata.default_branch !== "string" || !metadata.default_branch) {
					throw new Error("GitHub returned an invalid default branch.");
				}
				branch = validateBranch(metadata.default_branch);
			}
			const commitData = await this.json(
				new URL(`https://api.github.com/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`),
				1024 * 1024,
				"branch resolution",
				outer.signal,
			);
			if (!isRecord(commitData) || !isRecord(commitData.commit) || !isRecord(commitData.commit.tree)) {
				throw new Error("GitHub returned invalid commit metadata.");
			}
			const commit = validateSha(commitData.sha, "commit SHA");
			const treeSha = validateSha(commitData.commit.tree.sha, "tree SHA");
			const treeData = await this.json(
				new URL(`https://api.github.com/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`),
				LIMITS.treeBytes,
				"repository tree",
				outer.signal,
			);
			if (!isRecord(treeData) || treeData.truncated === true || !Array.isArray(treeData.tree)) {
				if (isRecord(treeData) && treeData.truncated === true) throw new Error("GitHub returned a truncated repository tree.");
				throw new Error("GitHub returned an invalid repository tree.");
			}
			if (treeData.tree.length > LIMITS.treeEntries) throw new Error(`Repository tree exceeds ${LIMITS.treeEntries} entries.`);
			const tree: GitTreeEntry[] = treeData.tree.map((raw) => {
				if (!isRecord(raw) || typeof raw.path !== "string" || typeof raw.mode !== "string" || typeof raw.type !== "string") {
					throw new Error("GitHub returned an invalid tree entry.");
				}
				const size = raw.size === undefined ? undefined : raw.size;
				if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) < 0)) throw new Error("GitHub returned an invalid blob size.");
				return { path: raw.path, mode: raw.mode, type: raw.type, sha: validateSha(raw.sha, "object SHA"), size: size as number | undefined };
			});
			return { repository, branch, commit, tree };
		} catch (error) {
			if (outer.timedOut()) throw new Error(`Refreshing ${repository} timed out.`);
			if (signal?.aborted) throw abortError();
			throw error;
		} finally {
			outer.cleanup();
		}
	}

	async blob(repository: string, commit: string, path: string, expectedSha: string, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
		const [owner, name] = repository.split("/");
		const encodedPath = path.split("/").map(encodeURIComponent).join("/");
		const url = new URL(`https://raw.githubusercontent.com/${owner}/${name}/${commit}/${encodedPath}`);
		const bytes = await this.request(url, maximum, `blob ${path}`, signal);
		const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
		const actual = createHash("sha1").update(header).update(bytes).digest("hex");
		if (actual !== expectedSha) throw new Error(`Blob integrity check failed for ${path}.`);
		return bytes;
	}
}
