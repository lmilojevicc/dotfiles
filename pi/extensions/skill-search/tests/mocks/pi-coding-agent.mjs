export function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? "/tmp/pi-agent-test";
}

// Dependency test double for Pi's public YAML-backed parseFrontmatter export.
export function parseFrontmatter(content) {
	const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
	const closing = normalized.indexOf("\n---", 4);
	if (closing < 0) return { frontmatter: {}, body: normalized };
	const lines = normalized.slice(4, closing).split("\n");
	const frontmatter = {};
	for (let index = 0; index < lines.length;) {
		const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(lines[index]);
		if (!match) { index += 1; continue; }
		const [, key, raw = ""] = match;
		index += 1;
		if (key !== "name" && key !== "description") {
			while (index < lines.length && (/^\s/.test(lines[index]) || !lines[index])) index += 1;
			continue;
		}
		const block = /^([|>])([+-]?)$/.exec(raw);
		if (block) {
			const contentLines = [];
			while (index < lines.length && (!lines[index] || /^\s/.test(lines[index]))) contentLines.push(lines[index++]);
			const indentation = Math.min(...contentLines.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length));
			const stripped = contentLines.map((line) => line ? line.slice(indentation) : "");
			let value;
			if (block[1] === "|") value = stripped.join("\n");
			else {
				value = "";
				for (let lineIndex = 0; lineIndex < stripped.length; lineIndex += 1) {
					const line = stripped[lineIndex];
					value += line;
					if (lineIndex < stripped.length - 1) {
						const next = stripped[lineIndex + 1];
						value += !line || !next || /^\s/.test(line) || /^\s/.test(next) ? "\n" : " ";
					}
				}
			}
			if (block[2] === "-") value = value.replace(/\n+$/g, "");
			else if (block[2] !== "+") value = `${value.replace(/\n+$/g, "")}\n`;
			frontmatter[key] = value;
			continue;
		}
		let value = raw;
		const continuation = [];
		while (index < lines.length && /^\s+\S/.test(lines[index])) continuation.push(lines[index++].trim());
		if (continuation.length > 0) value = [value, ...continuation].join(" ");
		if (value.startsWith("\"") && value.endsWith("\"")) value = JSON.parse(value);
		else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
		frontmatter[key] = value;
	}
	return { frontmatter, body: normalized.slice(closing + 4).trim() };
}
