import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const configuredPi = process.env.PI_BIN;
const lookup = configuredPi
	? { status: 0, stdout: configuredPi }
	: spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" });

if (lookup.status !== 0 || !lookup.stdout.trim()) {
	throw new Error("Real Pi smoke requires pi on PATH (set PI_BIN to its executable)");
}

function findPackageRoot(executable) {
	let directory = dirname(realpathSync(executable.split(/\r?\n/, 1)[0]));
	const root = parse(directory).root;
	while (directory !== root) {
		const manifestPath = join(directory, "package.json");
		if (existsSync(manifestPath)) {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (manifest.name === "@earendil-works/pi-coding-agent") return directory;
		}
		directory = dirname(directory);
	}
	throw new Error("Could not locate @earendil-works/pi-coding-agent from the pi executable");
}

const packageRoot = findPackageRoot(lookup.stdout.trim());
const executable = realpathSync(lookup.stdout.trim().split(/\r?\n/, 1)[0]);
assert.equal(executable, join(packageRoot, "dist/bundle/cli.js"), "smoke must launch the bundled Node CLI");
const hostEntry = pathToFileURL(join(packageRoot, "dist", "index.js")).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: hostEntry, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const host = await import(hostEntry);
const extension = await import("../index.ts?real-pi-smoke");
const expectedVersion = extension.SUPPORTED_PI_VERSION;
assert.equal(host.VERSION, expectedVersion, `installed Pi must be ${expectedVersion}`);
assert.equal(typeof host.InteractiveMode, "function");
assert.equal(typeof host.InteractiveMode.prototype.init, "function");
assert.equal(typeof host.InteractiveMode.prototype.switchTuiMode, "function");
assert.equal(host.InteractiveMode.prototype.mountInteractiveTui.length, 2);

const originalMount = host.InteractiveMode.prototype.mountInteractiveTui;
const handlers = new Map();
const commands = new Map();
const appended = [];
extension.default({
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: (name, options) => commands.set(name, options),
	appendEntry: (customType, data) => appended.push({ customType, data }),
});
assert.notEqual(host.InteractiveMode.prototype.mountInteractiveTui, originalMount);

const tuiRoot = join(packageRoot, "node_modules/@earendil-works/pi-tui/dist");
const { Container, Text, visibleWidth } = await import(pathToFileURL(join(tuiRoot, "index.js")).href);
const { renderLayoutFrame, getScrollViewBox } = await import(pathToFileURL(join(tuiRoot, "layout.js")).href);
const { createChatViewport } = await import(pathToFileURL(join(packageRoot, "dist/modes/interactive/chat-viewport.js")).href);
const renderer = Object.assign(new Container(), {
	terminal: { columns: 140 },
	renders: 0,
	requestRender() { this.renders += 1; },
});
const components = Array.from({ length: 7 }, (_, index) => {
	const region = new Container();
	region.addChild(new Text(`host-region-${index}`, 0, 0));
	return region;
});
const viewport = createChatViewport({
	document: components[0], pendingMessages: components[1], status: components[2],
	widgetsAbove: components[3], editor: components[4], widgetsBelow: components[5], footer: components[6],
});
host.InteractiveMode.prototype.mountInteractiveTui.call(
	{ version: host.VERSION },
	renderer,
	components,
);
const notifications = [];
const ctx = {
	mode: "tui",
	hasUI: true,
	ui: { notify: (message, level) => notifications.push({ message, level }) },
	sessionManager: { getBranch: () => [] },
};
await handlers.get("session_start")({ reason: "startup" }, ctx);
await commands.get("reader").handler("", ctx);
assert.equal(components[0].render(139)[0].trimEnd(), "               host-region-0");
for (const columns of [80, 110, 111, 140, 141]) {
	renderer.terminal.columns = columns;
	for (const scrollbar of ["auto", "always", "hidden"]) {
		viewport.transcript.setScrollbar(scrollbar);
		const frame = renderLayoutFrame(viewport.root, columns, 40, () => {});
		const transcript = getScrollViewBox(frame, viewport.transcript);
		assert.equal(transcript.rect.x, 0);
		assert.equal(transcript.rect.width, columns, "scrollbar viewport remains terminal-wide");
		assert.ok(frame.lines.every((line) => visibleWidth(line) <= columns));
		const margin = " ".repeat(Math.max(0, Math.floor((columns - extension.DEFAULT_READER_WIDTH) / 2)));
		for (let index = 0; index < 7; index++) {
			assert.ok(frame.lines.some((line) => stripVTControlCharacters(line).startsWith(`${margin}host-region-${index}`)), `${columns}/${scrollbar}/region-${index}`);
		}
	}
}
assert.deepEqual(appended, [{
	customType: extension.READER_STATE_ENTRY,
	data: { enabled: true, width: extension.DEFAULT_READER_WIDTH },
}]);
assert.equal(renderer.renders, 2);
assert.deepEqual(notifications, [{ message: "Reader mode on (110 columns)", level: "info" }]);

await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
assert.equal(host.InteractiveMode.prototype.mountInteractiveTui, originalMount);
console.log(`PASS real Pi ${host.VERSION} SDK seam and real seven-region layout (5 widths × 3 scrollbar modes)`);

const cliSmoke = spawnSync("python3", [
	fileURLToPath(new URL("./real-pi-pty.py", import.meta.url)),
	executable,
	fileURLToPath(new URL("../index.ts", import.meta.url)),
	fileURLToPath(new URL("./real-pi-probe.ts", import.meta.url)),
], { encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
assert.ifError(cliSmoke.error);
assert.equal(cliSmoke.status, 0, `${cliSmoke.stdout}\n${cliSmoke.stderr}`);
process.stdout.write(cliSmoke.stdout);
