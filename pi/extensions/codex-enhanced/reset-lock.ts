import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, type Stats } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type ResetLockAvailability = "available" | "busy" | "legacy" | "python" | "platform" | "storage";
export class ResetLockError extends Error {
	readonly availability: Exclude<ResetLockAvailability, "available">;
	constructor(availability: Exclude<ResetLockAvailability, "available">) {
		super(resetLockMessage(availability));
		this.availability = availability;
	}
}
export function resetLockMessage(state: ResetLockAvailability): string {
	switch (state) {
		case "available": return "";
		case "busy": return "Reset in progress in another session";
		case "legacy": return "Old reset lock; see README";
		case "python": return "Python 3 required; see README";
		case "platform": return "Reset locking requires macOS or Linux; see README";
		case "storage": return "Reset journal/lock unavailable; see README";
	}
}

let python: string | undefined;
let resolvedPython = false;
/** First use selects the first executable python3 in an absolute PATH entry. No shell or cwd lookup. */
function pythonExecutable(): string {
	if (!resolvedPython) {
		resolvedPython = true;
		for (const directory of (process.env.PATH ?? "").split(delimiter)) {
			if (!isAbsolute(directory)) continue;
			try {
				const candidate = realpathSync(join(directory, "python3"));
				accessSync(candidate, constants.X_OK);
				if (lstatSync(candidate).isFile()) { python = candidate; break; }
			} catch { /* Try the next explicit search directory. */ }
		}
	}
	if (!python) throw new ResetLockError("python");
	return python;
}

const SCRIPT = `import errno, fcntl, sys
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError as e:
    if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
        sys.stdout.write("busy\\n")
        sys.exit(75)
    raise
sys.stdout.write("locked\\n")
`;

/** Never LOCK_UN: the child's fd 3 and Node's fd share the same open-file description. */
async function flock(fd: number, executable: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, ["-I", "-S", "-c", SCRIPT], {
			cwd: "/", env: {}, stdio: ["ignore", "pipe", "pipe", fd],
		});
		let failed = false;
		let output = "";
		let bytes = 0;
		const stop = () => { failed = true; child.kill("SIGKILL"); };
		const timer = setTimeout(stop, 2_000);
		child.on("error", () => { failed = true; });
		child.stdout!.on("data", (data: Buffer) => {
			bytes += data.length;
			if (bytes > 1024) stop(); else output += data.toString();
		});
		child.stderr!.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 1024) stop(); });
		// close, not a timeout/exit notification, is the boundary at which the inherited copy is gone.
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (!failed && !signal && code === 0 && output === "locked\n") resolve();
			else reject(new ResetLockError(!failed && !signal && code === 75 && output === "busy\n" ? "busy" : "python"));
		});
	});
}

export function checkPrivateStat(stat: Stats, directory: boolean): void {
	if ((directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0
		|| (process.getuid && stat.uid !== process.getuid()) || (!directory && stat.nlink !== 1)) throw new ResetLockError("storage");
}

/** Synchronous path inspection is advisory only; regular file existence never means busy. */
export function inspectResetLock(path: string): ResetLockAvailability {
	try {
		const stat = lstatSync(path);
		if (stat.isDirectory()) return "legacy";
		checkPrivateStat(stat, false);
		return "available";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "available" : "storage";
	}
}

/** The caller owns this fresh descriptor until close; it must never unlink/replace the lock inode. */
export async function acquireResetLock(path: string, create: boolean): Promise<number | undefined> {
	if (process.platform !== "darwin" && process.platform !== "linux") throw new ResetLockError("platform");
	const executable = pythonExecutable();
	const state = inspectResetLock(path);
	if (state !== "available") throw new ResetLockError(state);
	let fd: number | undefined;
	try {
		try {
			fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0), 0o600);
		} catch (error) {
			if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if (inspectResetLock(path) === "legacy") throw new ResetLockError("legacy");
			throw error;
		}
		const stat = fstatSync(fd);
		checkPrivateStat(stat, false);
		await flock(fd, executable);
		const current = lstatSync(path);
		checkPrivateStat(current, false);
		if (current.dev !== stat.dev || current.ino !== stat.ino) throw new ResetLockError("storage");
		return fd;
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		throw error instanceof ResetLockError ? error : new ResetLockError("storage");
	}
}

type LocalLockActivity = { operations: Set<Promise<void>>; probe?: Promise<ResetLockAvailability> };
const localActivity = new Map<string, LocalLockActivity>();
function activityFor(path: string): LocalLockActivity {
	let activity = localActivity.get(path);
	if (!activity) { activity = { operations: new Set() }; localActivity.set(path, activity); }
	return activity;
}
function forgetIdle(path: string, activity: LocalLockActivity): void {
	if (!activity.operations.size && !activity.probe && localActivity.get(path) === activity) localActivity.delete(path);
}

/** Priority over this module's advisory probes only. Competing operations still independently flock. */
export async function withResetFileLock<T>(path: string, work: (fd: number) => Promise<T>): Promise<T> {
	const activity = activityFor(path);
	let finished!: () => void;
	const completion = new Promise<void>((resolve) => { finished = resolve; });
	activity.operations.add(completion);
	try {
		// A probe has bounded lifetime and never waits for an authoritative operation.
		await activity.probe;
		const fd = (await acquireResetLock(path, true))!;
		try { return await work(fd); }
		finally { closeSync(fd); }
	} finally {
		activity.operations.delete(completion);
		finished();
		forgetIdle(path, activity);
	}
}

/** Local-only, coalesced separate descriptor; no creation, journal write or fsync. */
export function probeResetLock(directory: string, path: string, signal?: AbortSignal): Promise<ResetLockAvailability> {
	if (signal?.aborted) return Promise.resolve("storage");
	const activity = activityFor(path);
	// Deferred probes are deliberately NOT activity.probe: spend attempts never queue behind operations.
	if (activity.operations.size) return new Promise<ResetLockAvailability>((resolve) => {
		const abort = () => { signal?.removeEventListener("abort", abort); resolve("storage"); };
		signal?.addEventListener("abort", abort, { once: true });
		void Promise.all([...activity.operations]).then(() => {
			signal?.removeEventListener("abort", abort);
			resolve(signal?.aborted ? "storage" : probeResetLock(directory, path, signal));
		});
	});
	if (activity.probe) return activity.probe;
	const probe = (async (): Promise<ResetLockAvailability> => {
		try {
			try { checkPrivateStat(lstatSync(directory), true); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const fd = await acquireResetLock(path, false);
			if (fd !== undefined) closeSync(fd);
			return "available";
		} catch (error) { return error instanceof ResetLockError ? error.availability : "storage"; }
	})();
	activity.probe = probe;
	void probe.finally(() => { activity.probe = undefined; forgetIdle(path, activity); });
	return probe;
}
