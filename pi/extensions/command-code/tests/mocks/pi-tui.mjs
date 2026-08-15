export function truncateToWidth(value, width) { return value.slice(0, width); }
export function visibleWidth(value) { return value.length; }
export function wrapTextWithAnsi(value, width) {
	if (!value) return [""];
	const lines = [];
	for (let index = 0; index < value.length; index += Math.max(1, width)) lines.push(value.slice(index, index + Math.max(1, width)));
	return lines;
}
