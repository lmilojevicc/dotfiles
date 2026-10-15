export function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR ?? process.cwd();
}
