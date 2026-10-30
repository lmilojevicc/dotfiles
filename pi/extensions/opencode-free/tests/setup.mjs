// Suite-specific environment on top of _test-support/register-loader.mjs: the cache race test spawns
// worker Pi processes that must write into this process's agent dir, and an ambient offline switch
// must not decide what discovery does inside a test, except in the child processes that prove those
// switches work (OPENCODE_FREE_TEST_OFFLINE=1).
import { join } from "node:path";

process.env.PI_CODING_AGENT_DIR = process.env.OPENCODE_FREE_TEST_AGENT_DIR ?? join(process.env.HOME, "agent");
if (!process.env.OPENCODE_FREE_TEST_OFFLINE) {
	delete process.env.PI_OFFLINE;
	delete process.env.OPENCODE_FREE_OFFLINE;
}
