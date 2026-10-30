import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piPackageRoot } from "../../_test-support/pi-package.mjs";

// Pi's dist/ internals are not exported, so load them from the package the shared test loader resolved.
const piRoot = piPackageRoot();
const require = createRequire(join(piRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
// jiti resolves bare specifiers through require, which the shared loader's import hook does not cover.
const jiti = createJiti(join(piRoot, "dist/core/extensions/loader.js"), {
  interopDefault: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(piRoot, "dist/index.js"),
    "@earendil-works/pi-tui": fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
  },
});

export function loadModule<T>(path: string): Promise<T> {
  return jiti.import(resolve(import.meta.dirname, path)) as Promise<T>;
}

export function loadPi<T>(): Promise<T> {
  return jiti.import("@earendil-works/pi-coding-agent") as Promise<T>;
}

export function loadPiInternal<T>(path: string): Promise<T> {
  return jiti.import(join(piRoot, "dist", path)) as Promise<T>;
}

export function loadTui<T>(): Promise<T> {
  return jiti.import("@earendil-works/pi-tui") as Promise<T>;
}
