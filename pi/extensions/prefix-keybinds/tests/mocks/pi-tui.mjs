// Pi's cursor marker: terminal-focus-cursor/editor-focus.ts (loaded by these tests) strips it.
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export function matchesKey(data, key) {
	return data === key;
}

export function truncateToWidth(value, width, suffix = "") {
	return value.length <= width ? value : `${value.slice(0, Math.max(0, width - suffix.length))}${suffix}`;
}

export function visibleWidth(value) {
	return value.length;
}
