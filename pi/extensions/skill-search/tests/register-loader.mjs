import { registerHooks } from "node:module";

const mocks = new Map([
	["@earendil-works/pi-coding-agent", new URL("./mocks/pi-coding-agent.mjs", import.meta.url).href],
	["@earendil-works/pi-ai", new URL("./mocks/pi-ai.mjs", import.meta.url).href],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		const url = mocks.get(specifier);
		return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
	},
});
