import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Keep synthetic key names, but exercise the installed TUI's actual ANSI/cell layout.
const require = createRequire(import.meta.url);
function managedAgentPackage() {
	try {
		const root = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
		const version = readFileSync(join(root, "current-version"), "utf8").trim();
		return join(root, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	} catch {
		return undefined;
	}
}
let tuiPath;
try { tuiPath = require.resolve("@earendil-works/pi-tui/dist/utils.js"); }
catch {
	const paths = [process.env.PI_TEST_AGENT_PACKAGE, managedAgentPackage(), "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent"].filter(Boolean);
	tuiPath = require.resolve("@earendil-works/pi-tui/dist/utils.js", { paths });
}
const tui = await import(pathToFileURL(tuiPath).href);
export const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = tui;
const keys = await import(new URL("./keys.js", pathToFileURL(tuiPath)).href);
export function matchesKey(data, key) { return data === key || keys.matchesKey(data, key); }
