import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type JumpMessage = { id: string; message: object; text: string; preview: string; unavailable?: string };

/** Read only the active branch; entry IDs, never prompt text, are selection values. */
export function collectMessages(branch: readonly SessionEntry[]): JumpMessage[] {
	return branch.flatMap((entry): JumpMessage[] => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		const blocks = Array.isArray(content) ? content : [];
		const text = typeof content === "string" ? content : blocks.filter((c) => c.type === "text").map((c) => c.text).join("\n");
		const images = blocks.filter((c) => c.type === "image").length;
		const imageLabel = images ? `[${images} image${images === 1 ? "" : "s"}]` : "";
		// Do not let persisted prompt control sequences execute in the picker.
		const readable = text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/gu, " ").trim();
		return [{ id: entry.id, message: entry.message, text, preview: [readable, imageLabel].filter(Boolean).join(" ") || "[Empty prompt]" }];
	}).reverse();
}

export function filterMessages(messages: readonly JumpMessage[], query: string): JumpMessage[] {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	return messages.filter((item) => {
		const text = `${item.text} ${item.preview}`.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}
