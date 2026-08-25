import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: new URL("./mocks/pi-coding-agent.mjs", import.meta.url).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
