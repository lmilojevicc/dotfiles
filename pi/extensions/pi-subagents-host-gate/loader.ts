import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSubagents } from "./peer.ts";
import { registerForHost } from "./runtime.ts";

export default async function piSubagentsHostGate(pi: ExtensionAPI): Promise<unknown> {
	return await registerForHost(pi, process.env, async () => {
		// Keep import inside the host-loader-transpiled extension: Pi's jiti propagates
		// its module mapping to the public entry and its transitive SDK peer imports.
		const upstream = await import(resolveSubagents(import.meta.url, getAgentDir()));
		return upstream.default;
	});
}
