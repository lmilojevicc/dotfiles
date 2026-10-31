import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRequiredChildAPI } from "./peer.ts";
import { installAgentPolicy } from "./runtime.ts";
import { resolvePolicyConfigPath } from "./config-path.ts";
import { isBBOriginSession, parseBBPolicySignal } from "./bb-profile.ts";

export default async function agentPolicy(pi: ExtensionAPI): Promise<void> {
	// Child factories temporarily apply process env while loading. Capture it per runtime.
	const backgroundChild = process.env.PI_SUBAGENT_CHILD === "1";
	const bbSignal = parseBBPolicySignal(process.env);
	const bbOrigin = isBBOriginSession(process.env);
	const extensionPath = fileURLToPath(import.meta.url);
	const register = await loadRequiredChildAPI(import.meta.url, getAgentDir());
	installAgentPolicy(pi, {
		policyDir: dirname(extensionPath), configPath: resolvePolicyConfigPath(process.env.PI_AGENT_POLICY_CONFIG, getAgentDir(), dirname(extensionPath)),
		extensionPath, register, backgroundChild, bbSignal, bbOrigin,
	});
}
