/**
 * The `tasks` command the model types into bash to manage background tasks. The extension answers it
 * itself, inside its bash tool, so it shows as an ordinary bash command in Pi and in BB.
 */

/** Default and longest wait of `tasks wait`, in seconds. */
export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 600;

export type Control =
	| { verb: "list" }
	| { verb: "output" | "stop"; id: string }
	| { verb: "wait"; id: string; timeout: number }
	| { verb: "usage"; error?: string };

export const USAGE = [
	"usage: tasks                              list background tasks",
	"       tasks output <id>                  what it printed since you last saw its output",
	`       tasks wait <id> [--timeout <secs>]  wait for it to exit (default ${DEFAULT_WAIT_SECONDS}s, at most ${MAX_WAIT_SECONDS}s)`,
	"       tasks stop <id>                    stop it (SIGTERM, then SIGKILL after 2s)",
].join("\n");

/** Shell syntax that makes a command more than one `tasks` call; such commands run in the shell instead. */
const COMPOUND = /[|;&<>`$(){}\n\\'"*?]/;

/**
 * The `tasks` call a bash command consists of, if it is one. A leading `cd <dir> &&` is allowed, since
 * models prefix it out of habit. Anything else (pipes, other commands) returns undefined and runs in the
 * shell, where a stand-in `tasks` explains that it only works as a command of its own.
 */
export function parseControl(command: string): Control | undefined {
	const line = command.trim().replace(/^cd\s+[^\s;&|]+\s*&&\s*/, "");
	if (!/^tasks(\s|$)/.test(line) || COMPOUND.test(line)) return undefined;
	const words = line.split(/\s+/).slice(1);
	let verb = words.shift() ?? "list";
	if (/^(%|#)?\d+$/.test(verb)) {
		words.unshift(verb);
		verb = "output";
	}
	if (verb === "kill") verb = "stop";
	if (verb === "ls") verb = "list";
	if (verb === "list") return words.length === 0 ? { verb } : { verb: "usage", error: `tasks list takes no arguments` };
	if (verb === "help" || verb === "--help" || verb === "-h") return { verb: "usage" };
	if (verb !== "output" && verb !== "wait" && verb !== "stop") return { verb: "usage", error: `tasks: unknown command ${verb}` };

	let id: string | undefined;
	let timeout: number | undefined;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const flag = /^(?:--timeout|-t)(?:=(.*))?$/.exec(word);
		if (flag) {
			const value = flag[1] ?? words[++i];
			timeout = Number(value);
			if (verb !== "wait" || value === undefined || !Number.isFinite(timeout) || timeout <= 0) {
				return { verb: "usage", error: `tasks ${verb}: bad option ${word}${flag[1] === undefined && value !== undefined ? ` ${value}` : ""}` };
			}
		} else if (id === undefined) {
			id = word;
		} else {
			return { verb: "usage", error: `tasks ${verb}: unexpected ${word}` };
		}
	}
	if (id === undefined) return { verb: "usage", error: `tasks ${verb} needs a task id` };
	if (verb !== "wait") return { verb, id };
	return { verb, id, timeout: Math.min(timeout ?? DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS) };
}

/**
 * A command that starts with `tasks` but goes on (`tasks stop 1; sleep 1; ss -ltn`): the `tasks` part
 * would only reach the stand-in and do nothing while the rest runs, so the whole command is refused.
 */
export function startsWithCompoundTasks(command: string): boolean {
	const line = command.trim().replace(/^cd\s+[^\s;&|]+\s*&&\s*/, "");
	return /^tasks(\s|$)/.test(line) && COMPOUND.test(line);
}

/** A task id as models write it: `3`, `%3`, `#3` or `task-3`. */
export function taskId(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : undefined;
	if (typeof value !== "string") return undefined;
	const id = Number(value.trim().replace(/^(%|#|task[-_ ]?)/i, ""));
	return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Stand-in for `tasks` on the shell's PATH, reached only when `tasks` is part of a larger command. */
export const SHIM = `#!/bin/sh
echo "tasks: run it as a bash command of its own, such as \\\`tasks output 3\\\`; it does not work in pipelines, scripts or after other commands." >&2
exit 2
`;
