import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Pad a line to its visible width, truncating overflow with an ellipsis. */
export function padLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Wrap raw preview text at grapheme boundaries without discarding columns or whitespace. */
export function wrapRawLines(text: string, width: number): string[] {
	const columns = Math.max(1, width);
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	return text.split("\n").flatMap((line) => {
		const rows: string[] = [];
		let current = "";
		let used = 0;
		for (const { segment } of segmenter.segment(line)) {
			const size = visibleWidth(segment);
			if (used > 0 && used + size > columns) {
				rows.push(current);
				current = "";
				used = 0;
			}
			current += segment;
			used += size;
		}
		rows.push(current);
		return rows;
	});
}
