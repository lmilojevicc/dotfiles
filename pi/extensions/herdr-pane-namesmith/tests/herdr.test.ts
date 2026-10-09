import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import test from "node:test";
import { renameHerdrPane } from "../herdr.ts";

class FakeSocket extends EventEmitter {
	writes: string[] = [];
	destroys = 0;
	writeError = false;
	write(data: string): boolean {
		if (this.writeError) throw new Error("write failed");
		this.writes.push(data);
		return true;
	}
	destroy(): this { this.destroys++; return this; }
	data(value: string | Buffer): void { this.emit("data", Buffer.from(value)); }
}

function harness(name?: string, platform: NodeJS.Platform = "darwin") {
	const socket = new FakeSocket();
	let endpoint: string | undefined;
	const promise = renameHerdrPane("own-pane", "own-socket", name, {
		platform,
		connect: (path) => { endpoint = path; return socket as unknown as Socket; },
	});
	socket.emit("connect");
	const request = JSON.parse(socket.writes[0]);
	return {
		socket, promise, request, endpoint,
		success: () => socket.data(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane: {} } })}\n`),
	};
}

for (const name of ["--clear", "--", "two words", `Pi's \"quoted\" pane — 名称`, "a\nb", "$(touch nope); `bad`", undefined]) {
	test(`socket JSON preserves exact label ${JSON.stringify(name)} and explicit own-pane identity`, async () => {
		const h = harness(name);
		assert.equal(h.endpoint, "own-socket");
		assert.equal(typeof h.request.id, "string");
		assert.ok(h.request.id.length > 0);
		assert.deepEqual(h.request, {
			id: h.request.id, method: "pane.rename", params: { pane_id: "own-pane", label: name ?? null },
		});
		assert.ok(h.socket.writes[0].endsWith("\n"));
		assert.equal(h.socket.writes[0].split("\n").length, 2, "embedded newlines are JSON-escaped");
		h.success();
		await h.promise;
		assert.equal(h.socket.destroys, 1);
	});
}

test("Windows uses the existing Herdr named-pipe normalization", async () => {
	const h = harness("name", "win32");
	assert.equal(h.endpoint, "\\\\.\\pipe\\own-socket");
	h.success();
	await h.promise;
});

test("fragmented newline-delimited response accepts split Unicode bytes only after newline", async () => {
	const h = harness();
	let settled = false;
	h.promise.then(() => { settled = true; });
	const response = Buffer.from(JSON.stringify({ id: h.request.id, result: { label: "名称" } }));
	const split = response.indexOf(Buffer.from("名")) + 1;
	h.socket.data(response.subarray(0, split));
	h.socket.data(response.subarray(split));
	await Promise.resolve();
	assert.equal(settled, false);
	h.socket.data("\n");
	await h.promise;
	assert.equal(h.socket.destroys, 1);
});

for (const [description, message] of [
	["server error", (id: string) => ({ id, error: { message: "rejected" } })],
	["wrong response id", () => ({ id: "wrong", result: {} })],
	["missing result", (id: string) => ({ id })],
	["null result", (id: string) => ({ id, result: null })],
	["scalar result", (id: string) => ({ id, result: true })],
	["array result", (id: string) => ({ id, result: [] })],
	["both result and error", (id: string) => ({ id, result: {}, error: null })],
] as const) {
	test(`rejects ${description} and destroys socket`, async () => {
		const h = harness();
		h.socket.data(`${JSON.stringify(message(h.request.id))}\n`);
		await assert.rejects(h.promise);
		assert.equal(h.socket.destroys, 1);
	});
}

test("malformed JSON is non-success", async () => {
	const h = harness();
	h.socket.data("not json\n");
	await assert.rejects(h.promise);
	assert.equal(h.socket.destroys, 1);
});

for (const event of ["end", "close", "error"]) {
	test(`premature ${event} rejects and destroys socket exactly once`, async () => {
		const h = harness();
		h.socket.data('{"partial":');
		h.socket.emit(event, new Error("detail"));
		await assert.rejects(h.promise);
		h.socket.emit("close");
		h.socket.emit("error", new Error("late"));
		assert.equal(h.socket.destroys, 1);
	});
}

test("response bytes are bounded at 16 KiB across fragments", async () => {
	const h = harness();
	h.socket.data(Buffer.alloc(16 * 1024, 32));
	assert.equal(h.socket.destroys, 0);
	h.socket.data(" ");
	await assert.rejects(h.promise, /too large/);
	assert.equal(h.socket.destroys, 1);
});

test("2-second wall-clock deadline bounds even a server dripping partial data", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	const rejection = assert.rejects(h.promise, /timed out/);
	t.mock.timers.tick(1_999);
	h.socket.data("{");
	assert.equal(h.socket.destroys, 0);
	t.mock.timers.tick(1);
	await rejection;
	assert.equal(h.socket.destroys, 1);
	h.success();
	assert.equal(h.socket.destroys, 1);
});

test("deadline also bounds a connection that never connects", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const socket = new FakeSocket();
	const promise = renameHerdrPane("pane", "socket", "name", {
		platform: "darwin", connect: () => socket as unknown as Socket,
	});
	const rejection = assert.rejects(promise, /timed out/);
	t.mock.timers.tick(2_000);
	await rejection;
	assert.equal(socket.writes.length, 0);
	socket.emit("connect");
	assert.equal(socket.writes.length, 0, "late connection cannot send after settlement");
	assert.equal(socket.destroys, 1);
});

test("successful settlement clears deadline and ignores late socket events", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.success();
	await h.promise;
	t.mock.timers.tick(2_000);
	h.socket.emit("end");
	h.socket.emit("error", new Error("late"));
	assert.equal(h.socket.destroys, 1);
});

test("synchronous connection and write errors reject without escaping", async () => {
	await assert.rejects(renameHerdrPane("pane", "socket", "name", {
		platform: "darwin", connect: () => { throw new Error("connect failed"); },
	}), /connect failed/);
	const socket = new FakeSocket();
	socket.writeError = true;
	const promise = renameHerdrPane("pane", "socket", "name", {
		platform: "darwin", connect: () => socket as unknown as Socket,
	});
	socket.emit("connect");
	await assert.rejects(promise, /request failed/);
	assert.equal(socket.destroys, 1);
});
