import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
function packageRoot(path, expectedVersion) {
  try {
    const root = realpathSync(path);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest.name !== packageName || !versionPattern.test(manifest.version) ||
        (expectedVersion !== undefined && manifest.version !== expectedVersion)) throw new Error("package name/version mismatch");
    const bin = manifest.bin?.pi;
    if (typeof bin !== "string" || isAbsolute(bin) || relative(root, resolve(root, bin)).startsWith("..") ||
        !statSync(join(root, bin)).isFile() || !statSync(join(root, "dist/index.d.ts")).isFile()) throw new Error("missing/invalid Pi executable or declarations");
    return root;
  } catch (error) {
    throw new Error(`Invalid Pi package root ${path}: ${error.message}. Set PI_PACKAGE_ROOT to a complete ${packageName} installation.`);
  }
}
function managedHost(install) {
  const current = join(install, "current-version");
  let version;
  try { version = readFileSync(current, "utf8").replace(/\n$/, ""); }
  catch { throw new Error(`Cannot read managed Pi version ${current}. Repair the managed install or set PI_PACKAGE_ROOT.`); }
  if (!versionPattern.test(version)) throw new Error(`Invalid managed Pi version in ${current}. Repair current-version or set PI_PACKAGE_ROOT.`);
  const release = join(install, "releases", version);
  const root = packageRoot(join(release, "node_modules", packageName), version);
  if (!existsSync(join(release, "node_modules/.bin/pi"))) throw new Error(`Managed Pi launcher target is missing in ${release}. Repair the managed install or set PI_PACKAGE_ROOT.`);
  return root;
}
export function installedLauncher(env = process.env) {
  const bin = env.PI_BIN || "pi";
  const lookup = spawnSync("which", [bin], { encoding: "utf8", env });
  if (lookup.status !== 0) throw new Error(`Cannot locate ${bin}. Put the managed Pi launcher on PATH or set PI_BIN / PI_PACKAGE_ROOT.`);
  return realpathSync(lookup.stdout.trim());
}
export function installedHost(env = process.env) {
  if (env.PI_PACKAGE_ROOT) return packageRoot(env.PI_PACKAGE_ROOT);
  if (env.PI_MANAGED_INSTALL_ROOT) return managedHost(resolve(env.PI_MANAGED_INSTALL_ROOT));
  const launcher = installedLauncher(env);
  const install = join(dirname(dirname(launcher)), "install");
  if (existsSync(install)) return managedHost(install);
  let directory = dirname(launcher);
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      let name;
      try { name = JSON.parse(readFileSync(manifest, "utf8")).name; }
      catch { throw new Error(`Cannot inspect package manifest ${manifest}. Repair it or set PI_PACKAGE_ROOT.`); }
      if (name === packageName) return packageRoot(directory);
    }
    if (directory === dirname(directory)) break;
    directory = dirname(directory);
  }
  throw new Error(`Cannot find installed Pi package from ${launcher}. Set PI_PACKAGE_ROOT to the package directory, or PI_MANAGED_INSTALL_ROOT to the install directory containing current-version and releases/.`);
}
export function resolveTui(root) {
  const nested = join(root, "node_modules/@earendil-works/pi-tui/dist/index.js");
  const sibling = join(dirname(root), "pi-tui/dist/index.js");
  const path = existsSync(nested) ? nested : sibling;
  if (!existsSync(path)) throw new Error("Installed Pi TUI is required for width/keybinding tests.");
  return pathToFileURL(path).href;
}
