import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Pad a line to its visible width, truncating overflow with an ellipsis. */
export function padLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "…");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}
