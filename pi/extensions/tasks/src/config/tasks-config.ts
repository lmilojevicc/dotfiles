import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { normalizeTaskGlyphsConfig, type TaskGlyphsConfig } from "../ui/task-glyphs.js";
import { isTaskSortOrder, type TaskSortOrder } from "../ui/task-sort.js";

export interface TaskDisplayConfig {
	collapseCompleted: boolean;
	showAll: boolean;
	maxVisible: number;
	sortOrder: TaskSortOrder;
	hiddenAt: "top" | "bottom";
	glyphs: TaskGlyphsConfig;
}

export const DEFAULT_TASKS_CONFIG: TaskDisplayConfig = {
	collapseCompleted: false,
	showAll: false,
	maxVisible: 10,
	sortOrder: "id",
	hiddenAt: "bottom",
	glyphs: {},
};

const DISPLAY_KEYS = ["collapseCompleted", "showAll", "maxVisible", "sortOrder", "hiddenAt", "glyphs"] as const;
type JsonObject = Record<string, unknown>;
type ConfigLayer = Partial<Omit<TaskDisplayConfig, "glyphs">> & { glyphs?: TaskGlyphsConfig };

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

function readObject(path: string): JsonObject {
	try {
		assertSafeExistingDestination(path);
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
	} catch {
		return {};
	}
}

function readExistingObject(path: string): JsonObject {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return {};
		throw new Error(`Could not read existing task config at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Existing task config at ${path} contains malformed JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Existing task config at ${path} must contain a JSON object`);
	}
	return value as JsonObject;
}

function objectValue(value: unknown): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function normalizeLayer(value: JsonObject): ConfigLayer {
	const normalized: ConfigLayer = {};
	if (typeof value.collapseCompleted === "boolean") normalized.collapseCompleted = value.collapseCompleted;
	if (typeof value.showAll === "boolean") normalized.showAll = value.showAll;
	if (Number.isSafeInteger(value.maxVisible) && Number(value.maxVisible) > 0) normalized.maxVisible = Number(value.maxVisible);
	if (isTaskSortOrder(value.sortOrder)) normalized.sortOrder = value.sortOrder;
	if (value.hiddenAt === "top" || value.hiddenAt === "bottom") normalized.hiddenAt = value.hiddenAt;
	const glyphs = normalizeTaskGlyphsConfig(value.glyphs);
	if (Object.keys(glyphs).length) normalized.glyphs = glyphs;
	return normalized;
}

export function normalizeTasksConfig(value: JsonObject): TaskDisplayConfig {
	const normalized = normalizeLayer(value);
	return { ...DEFAULT_TASKS_CONFIG, ...normalized, glyphs: normalized.glyphs ?? {} };
}

export function loadGlobalTasksConfig(agentDir = getAgentDir()): TaskDisplayConfig {
	return normalizeTasksConfig(readObject(join(agentDir, "tasks-config.json")));
}

function assertSafeDirectory(canonicalDirectory: string): void {
	if (!lstatSync(canonicalDirectory).isDirectory() || realpathSync(canonicalDirectory) !== canonicalDirectory) {
		throw new Error(`Task config parent is no longer the intended directory: ${canonicalDirectory}`);
	}
}

function assertSafeExistingDestination(path: string): void {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) throw new Error(`Refusing to use symlinked task config: ${path}`);
		if (!stats.isFile()) throw new Error(`Task config is not a regular file: ${path}`);
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

/** Merge display settings into the global file atomically, retaining unrelated keys. */
export function saveGlobalTasksConfig(config: Partial<TaskDisplayConfig>, agentDir = getAgentDir()): void {
	mkdirSync(agentDir, { recursive: true });
	// A deliberately symlinked agent directory is supported; writes stay at its canonical location.
	const canonicalDirectory = realpathSync(agentDir);
	assertSafeDirectory(canonicalDirectory);
	const path = join(canonicalDirectory, "tasks-config.json");
	assertSafeExistingDestination(path);

	const existing = readExistingObject(path);
	const next: JsonObject = { ...existing };
	for (const key of DISPLAY_KEYS) {
		if (config[key] === undefined) continue;
		next[key] = key === "glyphs" ? { ...objectValue(existing.glyphs), ...config.glyphs } : config[key];
	}

	assertSafeDirectory(canonicalDirectory);
	assertSafeExistingDestination(path);
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	let fd: number | undefined;
	let created = false;
	try {
		fd = openSync(temporary, "wx", 0o600);
		created = true;
		writeFileSync(fd, JSON.stringify(next, null, 2));
		closeSync(fd);
		fd = undefined;
		assertSafeDirectory(canonicalDirectory);
		assertSafeExistingDestination(path);
		renameSync(temporary, path);
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
		if (created) {
			try { unlinkSync(temporary); } catch {}
		}
		throw error;
	}
}
