import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Use already-installed peers; PI_COMMAND_CODE_TEST_SDK can name a Pi package
// directory when its dependencies are not on this extension's resolution path.
const parentURL = process.env.PI_COMMAND_CODE_TEST_SDK
  ? pathToFileURL(resolve(process.env.PI_COMMAND_CODE_TEST_SDK, "package.json")).href
  : import.meta.url;
const peers = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/pi-coding-agent"]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, (peers.has(specifier) || specifier.startsWith("@earendil-works/pi-ai/api/") || specifier.startsWith("@earendil-works/pi-ai/utils/")) ? { ...context, parentURL } : context);
  },
});
