export type BBPolicySignal = Readonly<{ workflowWorker: boolean; diagnostic?: string }>;

type BBPolicyEnvironment = {
	PI_AGENT_POLICY_BB_PROFILE?: string;
	PI_AGENT_POLICY_BB_THREAD_ID?: string;
	BB_THREAD_ID?: string;
};

function validThreadId(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256
		&& value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

/** Policy-only routing metadata; never grants native child capabilities or role overlays. */
export function parseBBPolicySignal(env: BBPolicyEnvironment): BBPolicySignal {
	const profile = env.PI_AGENT_POLICY_BB_PROFILE;
	if (profile === undefined) return { workflowWorker: false };
	if (profile !== "workflow-worker:v1" && profile !== "none:v1") {
		return { workflowWorker: false, diagnostic: "agent-policy: invalid BB policy profile; using native/main routing." };
	}
	if (!validThreadId(env.BB_THREAD_ID) || !validThreadId(env.PI_AGENT_POLICY_BB_THREAD_ID)
		|| env.BB_THREAD_ID !== env.PI_AGENT_POLICY_BB_THREAD_ID) {
		return { workflowWorker: false, diagnostic: "agent-policy: invalid or mismatched BB policy identity; using native/main routing." };
	}
	return { workflowWorker: profile === "workflow-worker:v1" };
}
