import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const env = { ...process.env };
delete env.npm_config_prefix;

/** Locate Pi's SDK for either a managed install or a globally installed Pi. */
function findSdkPackageJson() {
	const managedRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? join(homedir(), ".pi", "agent", "install");
	const candidates = [process.env.PI_TEST_SDK_PACKAGE];
	try {
		const version = readFileSync(join(managedRoot, "current-version"), "utf8").trim();
		candidates.push(join(managedRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
	} catch {
		// No managed install; fall back to the global npm root below.
	}
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim();
		candidates.push(join(globalRoot, "@earendil-works/pi-coding-agent/package.json"));
	} catch {
		// npm may be unavailable; an explicit PI_TEST_SDK_PACKAGE still works.
	}
	const found = candidates.find((path) => path !== undefined && existsSync(path));
	if (!found) throw new Error("Cannot locate @earendil-works/pi-coding-agent; set PI_TEST_SDK_PACKAGE");
	return found;
}

const parentURL = pathToFileURL(findSdkPackageJson()).href;
const home = mkdtempSync(join(tmpdir(), "extension-manager-test-home-"));
const agentDir = join(home, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier, specifier.startsWith("@earendil-works/") ? { ...context, parentURL } : context);
	},
});
