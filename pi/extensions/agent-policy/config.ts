import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PolicySource = Readonly<{ path: string; text: string }>;
export type ConfigSnapshot = {
	common: PolicySource[];
	child: PolicySource[];
	main: PolicySource[];
	mainBb: PolicySource[];
	agents: Map<string, PolicySource[]>;
	warnings: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip only initial, exactly delimited YAML frontmatter; keep the body verbatim. */
function markdownBody(text: string): string {
	const source = text.replace(/^\uFEFF/, "");
	const opening = source.match(/^---[ \t]*(?:\r?\n|$)/);
	if (!opening) return source;
	if (!/^---(?:\r?\n|$)/.test(opening[0])) throw new Error("malformed opening frontmatter delimiter");
	const remainder = source.slice(opening[0].length);
	const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(remainder);
	if (!closing) throw new Error("unterminated initial YAML frontmatter (expected --- delimiter)");
	if (!/^---(?:\r?\n|$)/.test(closing[0])) throw new Error("malformed closing frontmatter delimiter");
	return remainder.slice(closing.index + closing[0].length);
}

/** Eager, fail-open file inputs, including mappings unused by the current session. */
export function readConfigSnapshot(policyDir: string, configPath: string = join(policyDir, "config.json")): ConfigSnapshot {
	const snapshot: ConfigSnapshot = { common: [], child: [], main: [], mainBb: [], agents: new Map(), warnings: [] };
	function warn(context: string, message: string): void {
		snapshot.warnings.push(`agent-policy: ${configPath}: ${context}: ${message}; skipping affected input.`);
	}
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		warn("config", error instanceof Error ? error.message : String(error));
		return snapshot;
	}
	if (!isObject(config)) {
		warn("config", "expected an object with optional common/all, child, main/orchestrator, mainBb and agents fields");
		return snapshot;
	}
	const mapping = config;
	for (const key of Object.keys(mapping)) {
		if (!["common", "all", "child", "main", "mainBb", "orchestrator", "agents"].includes(key)) warn(key, "unknown top-level key");
	}
	// Cache failures and blank bodies too: every normalized path is read only once.
	const sources = new Map<string, PolicySource | string>();
	function load(paths: unknown, mappingName: string): PolicySource[] {
		if (!Array.isArray(paths)) {
			warn(mappingName, "expected an ordered array of nonblank file-path strings");
			return [];
		}
		const result: PolicySource[] = [];
		for (const [index, input] of paths.entries()) {
			const context = `${mappingName}[${index}]`;
			if (typeof input !== "string" || !input.trim() || input.includes("\0")) {
				warn(context, "expected a nonblank file-path string without NUL characters");
				continue;
			}
			// Relative entries anchor to the policy (extension asset) directory, so the config file
			// keeps working wherever it lives — bundled prompts travel with the extension.
			// Resolution is a fail-open input too: a throwing homedir()/resolve must warn, not abort init.
			let path: string | undefined;
			let source: PolicySource | string;
			try {
				path = input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : resolve(policyDir, input);
				if (!sources.has(path)) {
					try {
						const body = markdownBody(readFileSync(path, "utf8"));
						sources.set(path, { path, text: body.trim() ? `## Policy source: ${path}\nResolve this source's relative file references against ${dirname(path)}.\n\n${body}` : "" });
					} catch (error) {
						sources.set(path, error instanceof Error ? error.message : String(error));
					}
				}
				source = sources.get(path)!;
			} catch (error) {
				source = error instanceof Error ? error.message : String(error);
			}
			if (typeof source === "string") warn(`${context}${path === undefined ? "" : ` (${path})`}`, source);
			else if (source.text) result.push(source);
		}
		return result;
	}
	function layer(canonical: "common" | "main", alias: "all" | "orchestrator"): PolicySource[] {
		if (Object.hasOwn(mapping, canonical) && Object.hasOwn(mapping, alias)) {
			warn(alias, `both ${canonical} and ${alias} are present; canonical ${canonical} wins`);
		}
		const key = Object.hasOwn(mapping, canonical) ? canonical : alias;
		return Object.hasOwn(mapping, key) ? load(mapping[key], key) : [];
	}
	snapshot.common = layer("common", "all");
	snapshot.main = layer("main", "orchestrator");
	// BB-origin main sessions replace, not extend, the main layer; there is no alias and no fallback.
	if (Object.hasOwn(mapping, "mainBb")) snapshot.mainBb = load(mapping.mainBb, "mainBb");
	if (Object.hasOwn(mapping, "child")) snapshot.child = load(mapping.child, "child");
	if (Object.hasOwn(mapping, "agents")) {
		if (!isObject(mapping.agents)) warn("agents", "expected an object mapping exact native agent names to path arrays");
		else for (const [name, paths] of Object.entries(mapping.agents)) {
			if (!name.trim() || /[\x00-\x1f\x7f]/.test(name)) warn(`agents[${JSON.stringify(name)}]`, "expected a nonblank exact native name without control characters");
			else snapshot.agents.set(name, load(paths, `agents[${JSON.stringify(name)}]`));
		}
	}
	return snapshot;
}

/** Layer order, then path order; the first normalized absolute source occurrence wins. */
export function composeSources(...layers: PolicySource[][]): string {
	const seen = new Set<string>();
	return layers.flat().filter((source) => {
		if (seen.has(source.path)) return false;
		seen.add(source.path);
		return true;
	}).map((source) => source.text).join("\n\n");
}
