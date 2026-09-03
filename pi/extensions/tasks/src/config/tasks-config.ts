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
import { isAbsolute, join, relative, sep } from "node:path";
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

export function loadTasksConfig(cwd: string, agentDir = getAgentDir()): TaskDisplayConfig {
	const global = normalizeTasksConfig(readObject(join(agentDir, "tasks-config.json")));
	const project = normalizeLayer(readObject(join(cwd, ".pi", "tasks-config.json")));
	return { ...global, ...project, glyphs: { ...global.glyphs, ...project.glyphs } };
}

const differs = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

function assertContained(projectRoot: string, destination: string): void {
	const pathFromRoot = relative(projectRoot, destination);
	if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
		throw new Error(`Refusing to save task config outside the project root: ${destination}`);
	}
}

function assertSafeProjectDirectory(projectRoot: string, projectDirectory: string): string {
	let stats;
	try {
		stats = lstatSync(projectDirectory);
	} catch (error) {
		if (!isMissing(error)) throw error;
		mkdirSync(projectDirectory);
		stats = lstatSync(projectDirectory);
	}
	if (stats.isSymbolicLink()) throw new Error(`Refusing to save task config through symlinked directory: ${projectDirectory}`);
	if (!stats.isDirectory()) throw new Error(`Task config parent is not a directory: ${projectDirectory}`);
	const canonicalDirectory = realpathSync(projectDirectory);
	assertContained(projectRoot, canonicalDirectory);
	return canonicalDirectory;
}

function assertSafeExistingDestination(projectRoot: string, path: string): void {
	try {
		assertContained(projectRoot, realpathSync(path));
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
}

/** Save display-only project overrides atomically while retaining unrelated upstream keys. */
export function saveTasksConfig(config: TaskDisplayConfig, cwd: string, agentDir = getAgentDir()): void {
	const projectRoot = realpathSync(cwd);
	const projectDirectory = join(projectRoot, ".pi");
	const canonicalDirectory = assertSafeProjectDirectory(projectRoot, projectDirectory);
	const path = join(canonicalDirectory, "tasks-config.json");
	assertSafeExistingDestination(projectRoot, path);

	const globalRaw = readObject(join(agentDir, "tasks-config.json"));
	const global = normalizeTasksConfig(globalRaw);
	const existing = readExistingObject(path);
	const next: JsonObject = { ...existing };
	for (const key of DISPLAY_KEYS) {
		if (key === "glyphs") continue;
		if (differs(config[key], global[key])) next[key] = config[key];
		else delete next[key];
	}
	const existingGlyphs = objectValue(existing.glyphs);
	const globalGlyphs = normalizeTaskGlyphsConfig(globalRaw.glyphs);
	const glyphs: JsonObject = { ...existingGlyphs };
	for (const [name, value] of Object.entries(config.glyphs)) {
		if (differs(value, (globalGlyphs as Record<string, unknown>)[name])) glyphs[name] = value;
		else delete glyphs[name];
	}
	if (Object.keys(glyphs).length) next.glyphs = glyphs;
	else delete next.glyphs;

	assertSafeProjectDirectory(projectRoot, projectDirectory);
	assertSafeExistingDestination(projectRoot, path);
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, JSON.stringify(next, null, 2));
		closeSync(fd);
		fd = undefined;
		assertSafeProjectDirectory(projectRoot, projectDirectory);
		assertSafeExistingDestination(projectRoot, path);
		renameSync(temporary, path);
	} catch (error) {
		if (fd !== undefined) {
			try { closeSync(fd); } catch {}
		}
		try { unlinkSync(temporary); } catch {}
		throw error;
	}
}
