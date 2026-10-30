// Suite-specific resolution on top of _test-support/register-loader.mjs: these tests replace Pi's SDK
// and TUI with local fakes. Deep @earendil-works/pi-tui/* paths are left to the shared loader, so the
// fake TUI still measures and keys against the installed Pi.
import { registerHooks } from "node:module";

const MOCKS = new Map([
	["@earendil-works/pi-coding-agent", new URL("./mocks/pi-coding-agent.mjs", import.meta.url).href],
	["@earendil-works/pi-tui", new URL("./mocks/pi-tui.mjs", import.meta.url).href],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		const mock = MOCKS.get(specifier);
		return mock ? { url: mock, shortCircuit: true } : nextResolve(specifier, context);
	},
});
