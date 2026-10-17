import type { ProviderAdapter } from "../core.ts";
import { claudeAdapter } from "./claude.ts";
import { cliproxyapiAdapter } from "./cliproxyapi.ts";
import { commandcodeAdapter } from "./commandcode.ts";
import { opencodeGoAdapter } from "./opencode-go.ts";
import { openaiCodexAdapter } from "./openai-codex.ts";

/** Tab order. Add a provider by creating `providers/<id>.ts` and appending its adapter here. */
export const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
	openaiCodexAdapter,
	claudeAdapter,
	opencodeGoAdapter,
	cliproxyapiAdapter,
	commandcodeAdapter,
];
