const REASONING_BLOCK = /<(think|analysis)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/gu;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;
const PRESERVED_JOIN_CONTROLS = new Set(["\u200C", "\u200D"]);
const EDGE_JOIN_CONTROLS = /^[\u200C\u200D]+|[\u200C\u200D]+$/gu;
const MAX_TITLE_CODE_POINTS = 50;
const TRUNCATED_TITLE_CODE_POINTS = MAX_TITLE_CODE_POINTS - 3;

const SURROUNDING_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["“", "”"],
	["‘", "’"],
];

export function normalizeTitle(textParts: readonly string[]): string | undefined {
	const withoutReasoning = textParts.join("").replace(REASONING_BLOCK, "");
	const firstLine = withoutReasoning
		.split(LINE_BREAK)
		.map((line) => line
			.replace(CONTROL_OR_FORMAT, (character) => PRESERVED_JOIN_CONTROLS.has(character) ? character : " ")
			.replace(/\s+/gu, " ")
			.trim()
			.replace(EDGE_JOIN_CONTROLS, ""))
		.find(Boolean);
	if (!firstLine) return undefined;

	let title = firstLine;
	for (const [opening, closing] of SURROUNDING_PAIRS) {
		if (title.startsWith(opening) && title.endsWith(closing) && title.length >= opening.length + closing.length) {
			title = title.slice(opening.length, -closing.length);
			break;
		}
	}

	title = title.trim().replace(EDGE_JOIN_CONTROLS, "");
	if (!title) return undefined;

	const codePoints = Array.from(title);
	return codePoints.length <= MAX_TITLE_CODE_POINTS
		? title
		: `${codePoints.slice(0, TRUNCATED_TITLE_CODE_POINTS).join("")}...`;
}
