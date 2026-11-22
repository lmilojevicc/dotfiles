/**
 * New pi-interactive-shell sessions start in the background, so they show up in the panel's
 * Terminals tab instead of opening their overlay over the chat. The user opens one from the panel
 * (Enter attaches through `/attach <id>`), as with every other background job.
 *
 * pi-interactive-shell accepts `background: true` only with `mode: "dispatch"` for new sessions,
 * so an `interactive` or `hands-free` launch becomes a background dispatch. Dispatch ends a
 * session after a few quiet seconds by default; a converted session may be waiting for the user
 * (a password prompt prints nothing), so it keeps running unless the agent asked otherwise.
 */

/** The tool name pi-interactive-shell registers. */
export const INTERACTIVE_SHELL_TOOL = "interactive_shell";

type ToolInput = Record<string, unknown>;

function isRecord(value: unknown): value is ToolInput {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrites an `interactive_shell` call in place so a new session starts in the background.
 * Returns true when the input changed. Calls on existing sessions (query, input, kill, attach,
 * list, dismiss), monitors, and launches already in the background are left alone.
 */
export function startShellInBackground(input: unknown): boolean {
	if (!isRecord(input)) return false;
	const launches = input.command !== undefined || input.spawn !== undefined;
	const existing =
		input.sessionId !== undefined ||
		input.attach !== undefined ||
		input.listBackground !== undefined ||
		input.dismissBackground !== undefined;
	if (!launches || existing) return false;
	const mode = input.mode;
	if (mode === "monitor") return false;
	if (mode === "dispatch" && input.background === true) return false;

	const handsFree = isRecord(input.handsFree) ? input.handsFree : {};
	input.mode = "dispatch";
	input.background = true;
	// A dispatch the agent chose keeps dispatch's own quiet default; an interactive or hands-free
	// session waits for the user, so it is not ended for being quiet.
	if (mode !== "dispatch" && handsFree.autoExitOnQuiet === undefined) {
		input.handsFree = { ...handsFree, autoExitOnQuiet: false };
	}
	return true;
}
