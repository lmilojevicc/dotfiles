import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	groupAlive,
	type Task,
	TaskTable,
	removeStaleTables,
	type RunOptions,
	runCommand,
} from "../tasks.ts";

const tables: TaskTable[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
		await sleep(20);
	}
}

function table(): { table: TaskTable; ended: Task[] } {
	const created = new TaskTable(mkdtempSync(join(tmpdir(), "tasks-")));
	const ended: Task[] = [];
	created.bind({ ended: (task) => ended.push(task), changed: () => {} });
	tables.push(created);
	return { table: created, ended };
}

function options(
	command: string,
	extra: Partial<RunOptions> = {},
): RunOptions & { output: () => string } {
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
	const { table: tasks } = table();
	const run = options("echo hi; echo err >&2; exit 3");
	const result = await runCommand(tasks, run);
	assert.deepEqual(result, { kind: "exited", exitCode: 3 });
	assert.equal(run.output(), "hi\nerr\n");
	assert.deepEqual(
		readdirSync(tasks.dir).filter((name) => name.endsWith(".log")),
		[],
	);
	assert.equal(tasks.tasks.size, 0);
});

test("a command still running after the wait keeps running as a background task", async () => {
	const { table: tasks, ended } = table();
	const run = options("echo begin; sleep 1; echo finish", { waitMs: 300 });
	const result = await runCommand(tasks, run);
	assert.equal(result.kind, "background");
	const task = (result as { task: Task }).task;
	assert.equal(task.id, 1);
	assert.equal(task.reason, "waited");
	assert.equal(run.output(), "begin\n");
	assert.ok(task.running);
	assert.match(task.logPath, /task-1\.log$/);
	await task.ended;
	assert.equal(task.exitStatus(), 0);
	assert.equal(task.end, "exit");
	assert.equal(task.tail(), "begin\nfinish\n");
	assert.deepEqual(ended, [task]);
	// Output after the move goes only to the log.
	assert.equal(run.output(), "begin\n");
});

test("a command that exits but leaves processes running becomes a task", async () => {
	const { table: tasks } = table();
	for (const command of ["sleep 30 >/dev/null 2>&1 &", "sleep 30 &"]) {
		const started = Date.now();
		const result = await runCommand(tasks, options(command));
		assert.equal(result.kind, "background", command);
		const task = (result as { task: Task }).task;
		assert.equal(task.reason, "leftover");
		assert.ok(Date.now() - started < 2000, `${command} took ${Date.now() - started}ms`);
		assert.ok(groupAlive(task.pid));
		await task.stop("stopped");
		assert.ok(!groupAlive(task.pid));
	}
});

test("processes that end soon after the shell do not become tasks", async () => {
	const { table: tasks } = table();
	const result = await runCommand(tasks, options("(sleep 0.2; echo late) &"));
	assert.deepEqual(result, { kind: "exited", exitCode: 0 });
	assert.equal(tasks.tasks.size, 0);
});

test(
	"a process that escaped the group cannot hold the call open through the pipes",
	{ skip: !hasCommand("setsid") },
	async () => {
		const { table: tasks } = table();
		for (const command of [
			"setsid sleep 3 &",
			"setsid bash -c 'for i in $(seq 100); do echo x; sleep 0.05; done' &",
		]) {
			const started = Date.now();
			const result = await runCommand(tasks, options(command));
			assert.equal(result.kind, "exited", command);
			assert.ok(Date.now() - started < 2500, `${command} took ${Date.now() - started}ms`);
		}
	},
);

test("the timeout kills a command in the foreground", async () => {
	const { table: tasks } = table();
	await assert.rejects(
		runCommand(tasks, options("sleep 30", { timeoutSeconds: 0.3 })),
		/^Error: timeout:0\.3$/,
	);
	assert.equal(tasks.tasks.size, 0);
});

test("the timeout stops a task in the background and reports it", async () => {
	const { table: tasks, ended } = table();
	const result = await runCommand(tasks, options("sleep 30", { waitMs: 200, timeoutSeconds: 0.6 }));
	const task = (result as { task: Task }).task;
	await task.ended;
	assert.equal(task.end, "timeout");
	assert.deepEqual(ended, [task]);
	assert.ok(!groupAlive(task.pid));
});

test("abort kills a command in the foreground", async () => {
	const { table: tasks } = table();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	await assert.rejects(
		runCommand(tasks, options("sleep 30", { signal: controller.signal })),
		/^Error: aborted$/,
	);
});

test("stopping a task escalates to SIGKILL when SIGTERM is ignored", async () => {
	const { table: tasks } = table();
	const result = await runCommand(
		tasks,
		options("trap '' TERM; while :; do sleep 0.1; done", { waitMs: 200 }),
	);
	const task = (result as { task: Task }).task;
	const started = Date.now();
	await task.stop("stopped", "SIGTERM", 300);
	assert.ok(!task.running);
	assert.ok(Date.now() - started < 2000);
	assert.ok(!groupAlive(task.pid));
});

test("a task that ends while a call waits on it counts as reported", async () => {
	const { table: tasks, ended } = table();
	const result = await runCommand(tasks, options("sleep 0.5", { waitMs: 100 }));
	const task = (result as { task: Task }).task;
	task.watchers++;
	await task.ended;
	assert.ok(task.reported);
	assert.deepEqual(ended, [task]);
});

test("stopAll stops every command without reporting it", async () => {
	const { table: tasks, ended } = table();
	const background = await runCommand(tasks, options("sleep 30", { waitMs: 100 }));
	const foreground = runCommand(tasks, options("sleep 30"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	await tasks.stopAll();
	assert.ok(!(background as { task: Task }).task.running);
	assert.equal((await foreground).kind, "exited");
	assert.deepEqual(ended, []);
});

test("tasks that end while no runtime is bound are delivered when one binds", async () => {
	const { table: tasks } = table();
	tasks.bind(undefined);
	const result = await runCommand(tasks, options("sleep 0.3", { waitMs: 100 }));
	const task = (result as { task: Task }).task;
	await task.ended;
	const delivered: Task[] = [];
	tasks.bind({ ended: (ended) => delivered.push(ended), changed: () => {} });
	assert.deepEqual(delivered, [task]);
});

test("unread output starts after what the foreground call showed and moves on with each read", async () => {
	const { table: tasks } = table();
	const run = options("echo first; sleep 0.4; echo second; sleep 0.4; echo third; sleep 30", {
		waitMs: 200,
	});
	const task = ((await runCommand(tasks, run)) as { task: Task }).task;
	assert.equal(run.output(), "first\n");
	await until(() => task.tail().includes("second"));
	assert.deepEqual(task.unread(), { text: "second\n", skipped: 0 });
	assert.deepEqual(task.unread(), { text: "", skipped: 0 });
	await until(() => task.tail().includes("third"));
	assert.deepEqual(task.unread(), { text: "third\n", skipped: 0 });
});

test("unread output keeps the newest part when too much arrived", async () => {
	const { table: tasks } = table();
	const task = (
		(await runCommand(tasks, options("seq 1 2000; sleep 30", { waitMs: 300 }))) as { task: Task }
	).task;
	task.readOffset = 0;
	const { text, skipped } = task.unread(100);
	assert.ok(skipped > 0);
	assert.ok(text.endsWith("2000\n"));
	assert.match(text, /^\d+\n/, "starts at a line boundary");
});

test("task directories of dead Pi processes are removed, others are kept", () => {
	const root = mkdtempSync(join(tmpdir(), "tables-"));
	const dead = execFileSync("bash", ["-c", "bash -c 'echo $$'"], { encoding: "utf8" }).trim();
	for (const name of [
		`session-${dead}`,
		`session-${process.pid}`,
		`session-${process.ppid}`,
		"unrelated",
	]) {
		mkdirSync(join(root, name));
	}
	removeStaleTables(root);
	assert.deepEqual(
		readdirSync(root).sort(),
		[`session-${process.pid}`, `session-${process.ppid}`, "unrelated"].sort(),
	);
});

test("a shell that cannot start rejects", async () => {
	const { table: tasks } = table();
	await assert.rejects(
		runCommand(tasks, options("true", { shell: "/nonexistent/shell" })),
		/ENOENT/,
	);
	assert.ok(existsSync(tasks.dir));
});
