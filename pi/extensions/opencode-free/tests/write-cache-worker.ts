/**
 * Child process for the cache tests: writes the same cache file repeatedly so a
 * parent can watch the document while it changes. Not a test file.
 */
import { writeCache } from "../index.ts";

const prefix = process.argv[2] ?? "worker";
const iterations = Number(process.argv[3] ?? "10");

for (let index = 0; index < iterations; index++) {
	writeCache({ versionSource: `${prefix}-${index}`, versionCheckedAt: Date.now() });
}
