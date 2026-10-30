import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { groupAlive, type Job, JobTable, removeStaleTables, type RunOptions, runCommand } from "../jobs.ts";

const tables: JobTable[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
		await sleep(20);
	}
}

function table(): { table: JobTable; ended: Job[] } {
	const created = new JobTable(mkdtempSync(join(tmpdir(), "jobs-")));
	const ended: Job[] = [];
	created.bind({ ended: (job) => ended.push(job), changed: () => {} });
	tables.push(created);
	return { table: created, ended };
}

function options(command: string, extra: Partial<RunOptions> = {}): RunOptions & { output: () => string } {
	const chunks: Buffer[] = [];
	return {
		command,
		label: command,
		cwd: process.cwd(),
		env: process.env,
		shell: "bash",
		args: ["-c"],
		waitMs: 5000,
		reason: "waited",
		onData: (chunk) => chunks.push(chunk),
		output: () => Buffer.concat(chunks).toString(),
		...extra,
	};
}

/** Like `options`, but run the way the extension runs commands: with the job-control functions defined. */
function controlled(jobs: JobTable, command: string, extra: Partial<RunOptions> = {}): ReturnType<typeof options> {
	return options(jobs.withJobControl(command), { label: command, ...extra });
}

function hasCommand(name: string): boolean {
	try {
		execFileSync("bash", ["-c", `command -v ${name}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

afterEach(async () => {
	for (const created of tables.splice(0)) {
		await created.stopAll();
		created.dispose();
	}
});

test("a quick command finishes in the foreground and leaves no log", async () => {
	const { table: jobs } = table();
	const run = options("echo hi; echo err >&2; exit 3");
	const result = await runCommand(jobs, run);
	assert.deepEqual(result, { kind: "exited", exitCode: 3 });
	assert.equal(run.output(), "hi\nerr\n");
	assert.deepEqual(
		readdirSync(jobs.dir).filter((name) => name.endsWith(".log")),
		[],
	);
	assert.equal(jobs.jobs.size, 0);
});

test("a command still running after the wait keeps running as a background job", async () => {
	const { table: jobs, ended } = table();
	const run = options("echo begin; sleep 1; echo finish", { waitMs: 300 });
	const result = await runCommand(jobs, run);
	assert.equal(result.kind, "background");
	const job = (result as { job: Job }).job;
	assert.equal(job.id, 1);
	assert.equal(job.reason, "waited");
	assert.equal(run.output(), "begin\n");
	assert.ok(job.running);
	assert.match(job.logPath, /job-1\.log$/);
	await job.ended;
	assert.equal(job.exitStatus(), 0);
	assert.equal(job.end, "exit");
	assert.equal(job.tail(), "begin\nfinish\n");
	assert.deepEqual(ended, [job]);
	// Output after the move goes only to the log.
	assert.equal(run.output(), "begin\n");
});

test("a command that exits but leaves processes running becomes a job", async () => {
	const { table: jobs } = table();
	for (const command of ["sleep 30 >/dev/null 2>&1 &", "sleep 30 &"]) {
		const started = Date.now();
		const result = await runCommand(jobs, options(command));
		assert.equal(result.kind, "background", command);
		const job = (result as { job: Job }).job;
		assert.equal(job.reason, "leftover");
		assert.ok(Date.now() - started < 2000, `${command} took ${Date.now() - started}ms`);
		assert.ok(groupAlive(job.pid));
		await job.stop("stopped");
		assert.ok(!groupAlive(job.pid));
	}
});

test("processes that end soon after the shell do not become jobs", async () => {
	const { table: jobs } = table();
	const result = await runCommand(jobs, options("(sleep 0.2; echo late) &"));
	assert.deepEqual(result, { kind: "exited", exitCode: 0 });
	assert.equal(jobs.jobs.size, 0);
});

test("a process that escaped the group cannot hold the call open through the pipes", { skip: !hasCommand("setsid") }, async () => {
	const { table: jobs } = table();
	for (const command of ["setsid sleep 3 &", "setsid bash -c 'for i in $(seq 100); do echo x; sleep 0.05; done' &"]) {
		const started = Date.now();
		const result = await runCommand(jobs, options(command));
		assert.equal(result.kind, "exited", command);
		assert.ok(Date.now() - started < 2500, `${command} took ${Date.now() - started}ms`);
	}
});

test("the timeout kills a command in the foreground", async () => {
	const { table: jobs } = table();
	await assert.rejects(runCommand(jobs, options("sleep 30", { timeoutSeconds: 0.3 })), /^Error: timeout:0\.3$/);
	assert.equal(jobs.jobs.size, 0);
});

test("the timeout stops a job in the background and reports it", async () => {
	const { table: jobs, ended } = table();
	const result = await runCommand(jobs, options("sleep 30", { waitMs: 200, timeoutSeconds: 0.6 }));
	const job = (result as { job: Job }).job;
	await job.ended;
	assert.equal(job.end, "timeout");
	assert.deepEqual(ended, [job]);
	assert.ok(!groupAlive(job.pid));
});

test("abort kills a command in the foreground", async () => {
	const { table: jobs } = table();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	await assert.rejects(runCommand(jobs, options("sleep 30", { signal: controller.signal })), /^Error: aborted$/);
});

test("stopping a job escalates to SIGKILL when SIGTERM is ignored", async () => {
	const { table: jobs } = table();
	const result = await runCommand(jobs, options("trap '' TERM; while :; do sleep 0.1; done", { waitMs: 200 }));
	const job = (result as { job: Job }).job;
	const started = Date.now();
	await job.stop("stopped", "SIGTERM", 300);
	assert.ok(!job.running);
	assert.ok(Date.now() - started < 2000);
	assert.ok(!groupAlive(job.pid));
});

test("a job that ends while a call waits on it counts as reported", async () => {
	const { table: jobs, ended } = table();
	const result = await runCommand(jobs, options("sleep 0.5", { waitMs: 100 }));
	const job = (result as { job: Job }).job;
	job.watchers++;
	await job.ended;
	assert.ok(job.reported);
	assert.deepEqual(ended, [job]);
});

test("stopAll stops every command without reporting it", async () => {
	const { table: jobs, ended } = table();
	const background = await runCommand(jobs, options("sleep 30", { waitMs: 100 }));
	const foreground = runCommand(jobs, options("sleep 30"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	await jobs.stopAll();
	assert.ok(!(background as { job: Job }).job.running);
	assert.equal((await foreground).kind, "exited");
	assert.deepEqual(ended, []);
});

test("jobs that end while no runtime is bound are delivered when one binds", async () => {
	const { table: jobs } = table();
	jobs.bind(undefined);
	const result = await runCommand(jobs, options("sleep 0.3", { waitMs: 100 }));
	const job = (result as { job: Job }).job;
	await job.ended;
	const delivered: Job[] = [];
	jobs.bind({ ended: (ended) => delivered.push(ended), changed: () => {} });
	assert.deepEqual(delivered, [job]);
});

test("%N anywhere in a command reaches the background jobs of earlier commands", async () => {
	const { table: jobs } = table();
	const first = await runCommand(jobs, controlled(jobs, "sleep 0.8; echo built; exit 4", { waitMs: 200 }));
	const job = (first as { job: Job }).job;
	const run = controlled(jobs, "set -eu; jobs; wait %1 || echo status=$?");
	assert.deepEqual(await runCommand(jobs, run), { kind: "exited", exitCode: 0 });
	assert.equal(run.output(), `[%1]  Running  sleep 0.8; echo built; exit 4  (pid ${job.pid})\nstatus=4\n`);
	assert.ok(job.reported);
});

test("kill %N stops a background job from inside a larger command", async () => {
	const { table: jobs } = table();
	const first = await runCommand(jobs, controlled(jobs, "sleep 30", { waitMs: 200 }));
	const job = (first as { job: Job }).job;
	const run = controlled(jobs, "kill %1 && echo stopped");
	assert.deepEqual(await runCommand(jobs, run), { kind: "exited", exitCode: 0 });
	assert.equal(run.output(), "stopped\n");
	await job.ended;
	assert.equal(job.exitSignal, "SIGTERM");
	assert.ok(job.reported);
	// The job is gone, so %1 no longer reaches a process group that could be reused.
	const again = controlled(jobs, "kill %1");
	assert.deepEqual(await runCommand(jobs, again), { kind: "exited", exitCode: 1 });
	assert.match(again.output(), /no such job/);
});

test("a wait whose shell was killed still lets the job's end be reported", async () => {
	const { table: jobs, ended } = table();
	const first = await runCommand(jobs, controlled(jobs, "sleep 1", { waitMs: 100 }));
	const job = (first as { job: Job }).job;
	const controller = new AbortController();
	const waiting = runCommand(jobs, controlled(jobs, "wait %1", { signal: controller.signal }));
	// The job is still running and the shell has announced that it waits for it.
	await until(() => existsSync(join(jobs.dir, "job-1.waiting")));
	controller.abort();
	await assert.rejects(waiting, /^Error: aborted$/);
	await job.ended;
	// The result never reached anyone: the wait was killed before the job ended.
	assert.equal(job.reported, false);
	assert.deepEqual(ended, [job]);
});

test("kill -0 %N only asks whether a job is up, so its end is still reported", async () => {
	const { table: jobs, ended } = table();
	const first = await runCommand(jobs, controlled(jobs, "sleep 0.5", { waitMs: 100 }));
	const job = (first as { job: Job }).job;
	const run = controlled(jobs, "kill -0 %1 && echo alive");
	assert.deepEqual(await runCommand(jobs, run), { kind: "exited", exitCode: 0 });
	assert.equal(run.output(), "alive\n");
	await job.ended;
	assert.equal(job.reported, false);
	assert.deepEqual(ended, [job]);
});

test("a command's own jobs keep bash's meaning of %N", async () => {
	const { table: jobs } = table();
	await runCommand(jobs, controlled(jobs, "sleep 30", { waitMs: 200 }));
	const run = controlled(jobs, "sleep 5 & kill %1; wait %1; echo own=$?");
	assert.deepEqual(await runCommand(jobs, run), { kind: "exited", exitCode: 0 });
	assert.equal(run.output(), "own=143\n");
	assert.ok(jobs.get(1)?.running);
});

test("job directories of dead Pi processes are removed, others are kept", () => {
	const root = mkdtempSync(join(tmpdir(), "tables-"));
	const dead = execFileSync("bash", ["-c", "bash -c 'echo $$'"], { encoding: "utf8" }).trim();
	for (const name of [`session-${dead}`, `session-${process.pid}`, `session-${process.ppid}`, "unrelated"]) {
		mkdirSync(join(root, name));
	}
	removeStaleTables(root);
	assert.deepEqual(readdirSync(root).sort(), [`session-${process.pid}`, `session-${process.ppid}`, "unrelated"].sort());
});

test("a shell that cannot start rejects", async () => {
	const { table: jobs } = table();
	await assert.rejects(runCommand(jobs, options("true", { shell: "/nonexistent/shell" })), /ENOENT/);
	assert.ok(existsSync(jobs.dir));
});
