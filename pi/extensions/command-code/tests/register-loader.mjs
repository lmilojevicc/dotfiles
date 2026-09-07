import { registerHooks } from "node:module";

// Unit tests need no installed SDK; production normalization is extension-local.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui") {
			return { url: new URL("./mocks/pi-tui.mjs", import.meta.url).href, shortCircuit: true };
		}
		if (specifier === "@earendil-works/pi-ai") {
			return { url: new URL("./mocks/pi-ai.mjs", import.meta.url).href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
