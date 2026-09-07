import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Keep synthetic key names, but exercise the installed TUI's actual ANSI/cell layout.
const require = createRequire(import.meta.url);
let tuiPath;
try { tuiPath = require.resolve("@earendil-works/pi-tui/dist/utils.js"); }
catch {
	tuiPath = require.resolve("@earendil-works/pi-tui/dist/utils.js", {
		paths: [process.env.PI_TEST_AGENT_PACKAGE ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent"],
	});
}
const tui = await import(pathToFileURL(tuiPath).href);
export const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = tui;
export function matchesKey(data, key) { return data === key; }
