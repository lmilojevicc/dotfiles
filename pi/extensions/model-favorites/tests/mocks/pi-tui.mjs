export function fuzzyFilter(items, query, text) {
	const normalized = query.toLowerCase();
	return items.filter((item) => text(item).toLowerCase().includes(normalized));
}

export function matchesKey(data, key) {
	return data === key;
}

export class Spacer {
	constructor(size) { this.size = size; }
}

export class Text {
	constructor(text) { this.text = text; }
}
