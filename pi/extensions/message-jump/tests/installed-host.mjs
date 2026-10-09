import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function installedHost() {
  if (process.env.PI_PACKAGE_ROOT) return process.env.PI_PACKAGE_ROOT;
  const lookup = spawnSync("which", [process.env.PI_BIN || "pi"], { encoding: "utf8" });
  if (lookup.status !== 0) throw new Error("Tests require installed Pi on PATH, or PI_PACKAGE_ROOT.");
  let directory = dirname(realpathSync(lookup.stdout.trim()));
  while (directory !== dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return directory;
    directory = dirname(directory);
  }
  throw new Error("Cannot find installed Pi package root.");
}
export function resolveTui(root) {
  const nested = join(root, "node_modules/@earendil-works/pi-tui/dist/index.js");
  const sibling = join(dirname(root), "pi-tui/dist/index.js");
  const path = existsSync(nested) ? nested : sibling;
  if (!existsSync(path)) throw new Error("Installed Pi TUI is required for width/keybinding tests.");
  return pathToFileURL(path).href;
}
