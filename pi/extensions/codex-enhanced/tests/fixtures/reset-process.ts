import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { coordinateReset, resetPaths, withResetAccountLock } from "../../resets.ts";

const [agentDir, mode] = process.argv.slice(2);
const accountKey = process.argv[4] ?? "account:synthetic";
const paths = resetPaths(agentDir, accountKey);
if (mode === "old-mkdir") {
	fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	try { fs.mkdirSync(paths.lock, { mode: 0o700 }); process.send?.("old-created"); }
	catch { process.send?.("old-blocked"); }
	process.disconnect?.();
	// This owned fixture has no background work. Never runs the new coordinator.
	await new Promise<void>((resolve) => setImmediate(resolve));
	process.exit(0);
}
function checkpoint(name: string): never {
	process.send?.(name);
	// Only the test parent may kill this owned synthetic process. No live process is touched.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	throw new Error("unreachable");
}
if (mode === "inherited-helper") {
	const spawn = childProcess.spawn;
	childProcess.spawn = ((file: string, args: string[], options: any) => {
		// fd 4 connects directly to the test parent and survives this Node process's death.
		const script = `${args[3]}\nimport os, select
sys.stdout.flush()
os.write(4, b"helper-holds-copy")
if select.select([4], [], [], 10)[0]:
    os.read(4, 1)
os.close(3)
os.write(4, b"helper-released-copy")
`;
		return spawn(file, [...args.slice(0, 3), script], { ...options, stdio: [...options.stdio, 4] });
	}) as any;
	syncBuiltinESMExports();
}
if (mode === "acquired") await withResetAccountLock(agentDir, accountKey, async () => checkpoint("acquired"));
const write = fs.writeFileSync, rename = fs.renameSync, unlink = fs.unlinkSync;
if (mode === "temp") fs.writeFileSync = ((path: any, ...args: any[]) => {
	(write as any)(path, ...args);
	if (typeof path === "number") checkpoint("temp");
}) as any;
if (mode === "terminal" || mode === "recovery") {
	let renames = 0;
	fs.renameSync = ((...args: any[]) => {
		(rename as any)(...args);
		if (++renames === (mode === "terminal" ? 2 : 1)) checkpoint(mode);
	}) as any;
}
if (mode === "rollback") fs.unlinkSync = ((path: any) => {
	if (path === paths.journal) checkpoint("rollback");
	unlink(path);
}) as any;
syncBuiltinESMExports();
let posted = false, checks = 0;
await coordinateReset({
	agentDir, accountKey, mode: mode === "manual" ? "manual" : "auto", manualAction: { kind: "spend" },
	validate: async () => {}, checkBeforePost: () => { if (mode === "rollback" && ++checks === 2) throw new Error("cancelled"); },
	readUsage: async () => ({ limits: [{ limitId: "codex", secondary: {
		usedPercent: mode === "recovery" ? 50 : 100, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 3600,
	} }] }),
	readCredits: async () => ({ availableCount: 1, credits: [{ id: "synthetic-credit" }] }),
	consume: async () => {
		if (mode === "before-post") checkpoint("intent"); // Durable, definitely not mock-dispatched yet.
		posted = true;
		if (mode === "hold") {
			process.send?.("posted"); // Mock server received request; response remains in flight.
			await new Promise<void>((resolve) => process.once("message", () => resolve()));
		} else if (mode !== "terminal") process.send?.("posted");
		return { outcome: "reset" };
	},
	refresh: async () => {},
});
if (!posted) process.send?.("blocked");
process.disconnect?.();
