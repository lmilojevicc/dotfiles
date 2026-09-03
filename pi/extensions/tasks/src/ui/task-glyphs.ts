/**
 * Display glyph behavior adapted from @tintinweb/pi-tasks 0.9.0.
 * See THIRD_PARTY_NOTICES.md for the upstream MIT license and source revision.
 */
export interface TaskGlyphs {
	completed: string;
	inProgress: string;
	pending: string;
	spinner: readonly string[];
	completedSummary: string;
	header: string;
	overflow: string;
	blocked: string;
	inputTokens: string;
	outputTokens: string;
	statsSeparator: string;
	trailingEllipsis: string;
	truncation: string;
}

export type TaskGlyphsConfig = Partial<Omit<TaskGlyphs, "spinner">> & { spinner?: string[] };

const DEFAULT_GLYPHS: Omit<TaskGlyphs, "completedSummary"> = {
	completed: "✔",
	inProgress: "◼",
	pending: "◻",
	spinner: ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"],
	header: "●",
	overflow: "…",
	blocked: "›",
	inputTokens: "↑",
	outputTokens: "↓",
	statsSeparator: "·",
	trailingEllipsis: "…",
	truncation: "...",
};

const UNSAFE_GLYPH = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const isGlyph = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !UNSAFE_GLYPH.test(value);
const isSpinner = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(isGlyph);
const GLYPH_KEYS = [
	"completed", "inProgress", "pending", "completedSummary", "header", "overflow", "blocked",
	"inputTokens", "outputTokens", "statsSeparator", "trailingEllipsis", "truncation",
] as const;

/** Retain only glyph entries that the renderer can safely use. */
export function normalizeTaskGlyphsConfig(value: unknown): TaskGlyphsConfig {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const source = value as Record<string, unknown>;
	const normalized: TaskGlyphsConfig = {};
	for (const key of GLYPH_KEYS) {
		if (isGlyph(source[key])) normalized[key] = source[key];
	}
	if (isSpinner(source.spinner)) normalized.spinner = [...source.spinner];
	return normalized;
}

export function resolveTaskGlyphs(glyphs: TaskGlyphsConfig | undefined): TaskGlyphs {
	const glyph = (value: unknown, fallback: string) => isGlyph(value) ? value : fallback;
	const completed = glyph(glyphs?.completed, DEFAULT_GLYPHS.completed);
	return {
		completed,
		inProgress: glyph(glyphs?.inProgress, DEFAULT_GLYPHS.inProgress),
		pending: glyph(glyphs?.pending, DEFAULT_GLYPHS.pending),
		spinner: isSpinner(glyphs?.spinner) ? [...glyphs.spinner] : DEFAULT_GLYPHS.spinner,
		completedSummary: glyph(glyphs?.completedSummary, completed),
		header: glyph(glyphs?.header, DEFAULT_GLYPHS.header),
		overflow: glyph(glyphs?.overflow, DEFAULT_GLYPHS.overflow),
		blocked: glyph(glyphs?.blocked, DEFAULT_GLYPHS.blocked),
		inputTokens: glyph(glyphs?.inputTokens, DEFAULT_GLYPHS.inputTokens),
		outputTokens: glyph(glyphs?.outputTokens, DEFAULT_GLYPHS.outputTokens),
		statsSeparator: glyph(glyphs?.statsSeparator, DEFAULT_GLYPHS.statsSeparator),
		trailingEllipsis: glyph(glyphs?.trailingEllipsis, DEFAULT_GLYPHS.trailingEllipsis),
		truncation: glyph(glyphs?.truncation, DEFAULT_GLYPHS.truncation),
	};
}
