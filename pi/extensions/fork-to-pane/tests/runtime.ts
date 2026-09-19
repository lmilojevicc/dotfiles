import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function findPiPackageRoot(): string {
  let current = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
  while (current !== dirname(current)) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        if (JSON.parse(readFileSync(packagePath, "utf8")).name === "@earendil-works/pi-coding-agent") return current;
      } catch {}
    }
    current = dirname(current);
  }
  throw new Error("Could not locate the installed Pi package");
}

const piRoot = findPiPackageRoot();
const { createJiti } = await import(pathToFileURL(join(piRoot, "node_modules/jiti/lib/jiti.mjs")).href);
const jiti = createJiti(join(piRoot, "dist/core/extensions/loader.js"), { interopDefault: false });

export function loadModule<T>(path: string): Promise<T> {
  return jiti.import(resolve(import.meta.dirname, path)) as Promise<T>;
}

export function loadPi<T>(): Promise<T> {
  return jiti.import("@earendil-works/pi-coding-agent") as Promise<T>;
}
