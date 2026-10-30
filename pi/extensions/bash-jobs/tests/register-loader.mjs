import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";

// Resolve the real installed Pi package without installing anything: an explicit override first, then
// the managed install behind the `pi` launcher, then a global npm install.
function piPackageRoot() {
	const candidates = [];
	if (process.env.PI_PACKAGE_ROOT) candidates.push(process.env.PI_PACKAGE_ROOT);
	try {
		const launcher = realpathSync(execFileSync("which", [process.env.PI_BIN ?? "pi"], { encoding: "utf8" }).trim());
		const install = join(dirname(dirname(launcher)), "install");
		const version = readFileSync(join(install, "current-version"), "utf8").trim();
		candidates.push(join(install, "releases", version, "node_modules", packageName));
	} catch {
		// No managed launcher on PATH; try npm below.
	}
	try {
		const env = { ...process.env };
		delete env.npm_config_prefix;
		candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim(), packageName));
	} catch {
		// npm may be unavailable.
	}
	const root = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
	if (!root) throw new Error(`Cannot find ${packageName}. Set PI_PACKAGE_ROOT to the installed package directory.`);
	return root;
}

const parentURL = pathToFileURL(join(piPackageRoot(), "package.json")).href;
// Isolate Pi's agent dir and job logs before anything imports Pi.
const home = mkdtempSync(join(tmpdir(), "bash-jobs-test-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
process.env.TMPDIR = home;
process.env.PI_BASH_WAIT_SECONDS ??= "1";
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

registerHooks({
	resolve(specifier, context, nextResolve) {
		const fromPi = specifier.startsWith("@earendil-works/") || specifier === "typebox" || specifier.startsWith("typebox/");
		return nextResolve(specifier, fromPi ? { ...context, parentURL } : context);
	},
});
