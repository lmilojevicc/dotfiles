import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type InjectionSnapshot = { main: string[]; agents: Map<string, string[]> };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip only initial, exactly delimited YAML frontmatter; keep the body verbatim. */
function skillBody(text: string): string {
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

/** Eager inputs only: hooks never reread config or skills, including unused mappings. */
export function readInjectionSnapshot(policyDir: string): InjectionSnapshot {
	const configPath = join(policyDir, "injections.json");
	let source: string;
	try {
		source = readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { main: [], agents: new Map() };
		throw new Error(`agent-policy: ${configPath}: ${String(error)}`, { cause: error });
	}
	try {
		const config: unknown = JSON.parse(source);
		if (!isObject(config) || Object.keys(config).some((key) => key !== "main" && key !== "agents")
			|| !Object.hasOwn(config, "main") || !Object.hasOwn(config, "agents") || !isObject(config.agents)) {
			throw new Error('expected exactly { "main": string[], "agents": { name: string[] } }');
		}
		function load(paths: unknown, mapping: string): string[] {
			if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path.trim())) {
				throw new Error(`${mapping}: expected an ordered array of nonblank file-path strings`);
			}
			return paths.map((input: string, index: number) => {
				const path = input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : resolve(dirname(configPath), input);
				try {
					const body = skillBody(readFileSync(path, "utf8"));
					return body.trim() ? `## Injected skill: ${path}\nResolve this skill's relative file references against ${dirname(path)}.\n\n${body}` : "";
				} catch (error) {
					throw new Error(`${mapping}[${index}] (${path}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
				}
			}).filter(Boolean);
		}
		return {
			main: load(config.main, "main"),
			agents: new Map(Object.entries(config.agents).map(([name, paths]) => [name, load(paths, `agents[${JSON.stringify(name)}]`)])),
		};
	} catch (error) {
		throw new Error(`agent-policy: ${configPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
