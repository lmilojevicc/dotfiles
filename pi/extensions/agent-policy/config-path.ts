import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Env override from the config-unification convention (`PI_PREFIX_KEYBINDS_CONFIG` et al.). */
export const CONFIG_ENV_VAR = "PI_AGENT_POLICY_CONFIG";

/**
 * Policy config file lookup, in order:
 *   1. `PI_AGENT_POLICY_CONFIG` env var (expanded: `~/` → home, otherwise relative to cwd);
 *   2. `<agentDir>/agent-policy.json` — the unified location every extension config shares;
 *   3. `<extensionDir>/config.json` — legacy pre-unification location, kept so a checkout
 *      that has not been migrated yet keeps working. Remove after all machines migrated.
 */
export function resolvePolicyConfigPath(
	value: string | undefined,
	agentDir = join(homedir(), ".pi", "agent"),
	extensionDir = dirname(fileURLToPath(import.meta.url)),
): string {
	if (value) return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
	const unified = join(agentDir, "agent-policy.json");
	if (existsSync(unified)) return unified;
	return join(extensionDir, "config.json");
}
