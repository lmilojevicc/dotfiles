import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const expectedVersion = "0.84.2";
const configuredPi = process.env.PI_BIN;
const lookup = configuredPi
	? { status: 0, stdout: configuredPi }
	: spawnSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8" });

if (lookup.status !== 0 || !lookup.stdout.trim()) {
	console.log("SKIP real Pi smoke: pi is not on PATH (set PI_BIN to its executable)");
	process.exit(0);
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
assert.equal(host.VERSION, expectedVersion, `installed Pi must be ${expectedVersion}`);
assert.equal(typeof host.InteractiveMode, "function");
assert.equal(typeof host.InteractiveMode.prototype.init, "function");
assert.equal(typeof host.InteractiveMode.prototype.switchTuiMode, "function");
assert.equal(host.InteractiveMode.prototype.mountInteractiveTui.length, 2);

const originalMount = host.InteractiveMode.prototype.mountInteractiveTui;
const extension = await import("../index.ts?real-pi-smoke");
const handlers = new Map();
const commands = new Map();
const appended = [];
extension.default({
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: (name, options) => commands.set(name, options),
	appendEntry: (customType, data) => appended.push({ customType, data }),
});
assert.notEqual(host.InteractiveMode.prototype.mountInteractiveTui, originalMount);

const renderer = {
	terminal: { columns: 140 },
	renders: 0,
	addChild() {},
	requestRender() { this.renders += 1; },
};
const components = Array.from({ length: 7 }, (_, index) => ({
	render: (width) => [`host-region-${index}:${width}`],
}));
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
handlers.get("session_start")({ reason: "startup" }, ctx);
commands.get("reader").handler("", ctx);
assert.deepEqual(components[0].render(139), ["               host-region-0:110"]);
assert.deepEqual(appended, [{
	customType: extension.READER_STATE_ENTRY,
	data: { enabled: true, width: extension.DEFAULT_READER_WIDTH },
}]);
assert.equal(renderer.renders, 2);
assert.deepEqual(notifications, [{ message: "Reader mode on (110 columns)", level: "info" }]);

handlers.get("session_shutdown")({ reason: "quit" }, ctx);
assert.equal(host.InteractiveMode.prototype.mountInteractiveTui, originalMount);
console.log(`PASS real Pi ${host.VERSION} import/install seam smoke (${packageRoot})`);
