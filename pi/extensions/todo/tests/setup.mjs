// Suite-specific resolution on top of _test-support/register-loader.mjs: the sources import their
// siblings with ".js" specifiers (what tsc's NodeNext output needs), which node's type stripping does
// not rewrite, so load the matching ".ts" file when it exists.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
			const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
			if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
