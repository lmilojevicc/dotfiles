const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const TERMINAL_STRING = /(?:\u001b[\]P_X^]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESCAPE_SEQUENCE = /\u001b[ -/]*[0-~]/g;
const BIDI_CONTROL = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function stripTerminalControls(value: unknown): string {
	return String(value ?? "")
		.replace(TERMINAL_STRING, "")
		.replace(CSI, "")
		.replace(ESCAPE_SEQUENCE, "")
		.replace(/\u001b/g, "")
		.replace(CONTROL, "")
		.replace(BIDI_CONTROL, "");
}

/** Strip terminal control sequences while preserving ordinary Unicode and line meaning. */
export function sanitizeTerminalText(value: unknown): string {
	return stripTerminalControls(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** Sanitize editable single-line search text without changing legitimate spacing. */
export function sanitizeSearchInput(value: unknown): string {
	return stripTerminalControls(value).replace(/[\r\n\t]+/g, " ");
}
