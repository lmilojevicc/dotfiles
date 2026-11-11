import assert from "node:assert/strict";
import { test } from "node:test";
import { describeReady, parseReady } from "../ready.ts";

test("ready conditions parse, and placeholders for unset fields count as unset", () => {
	assert.equal(parseReady(undefined), undefined);
	assert.equal(parseReady(""), undefined);
	assert.equal(parseReady({ port: 0, log: " ", host: "" }), undefined);
	assert.deepEqual(parseReady({ port: "3000" }), {
		port: 3000,
		hosts: ["127.0.0.1", "::1"],
		log: undefined,
		timeoutSeconds: 30,
	});
	assert.deepEqual(parseReady('{"log": "ready", "timeout": 5000}'), {
		port: undefined,
		hosts: ["127.0.0.1", "::1"],
		log: /ready/,
		timeoutSeconds: 600,
	});
	assert.deepEqual(parseReady({ port: 8080, host: "0.0.0.0", timeout: 5 }), {
		port: 8080,
		hosts: ["0.0.0.0"],
		log: undefined,
		timeoutSeconds: 5,
	});
});

test("bad ready conditions say what is wrong", () => {
	assert.equal(parseReady({ port: 70000 }), "ready.port must be a TCP port, not 70000");
	assert.match(parseReady({ log: "(" }) as string, /^ready\.log is not a valid regular expression/);
	assert.equal(parseReady({ timeout: 10 }), "ready needs a port or a log pattern");
	assert.equal(
		parseReady({ port: 1, timeout: -1 }),
		"ready.timeout must be a number of seconds, not -1",
	);
	assert.match(parseReady("port 3000") as string, /^ready must be an object/);
	assert.match(parseReady([3000]) as string, /^ready must be an object/);
});

test("ready conditions read as plain words", () => {
	assert.equal(describeReady(parseReady({ port: 3000 }) as never), "port 3000");
	assert.equal(
		describeReady(parseReady({ port: 3000, host: "::1", log: "up" }) as never),
		"port 3000 on ::1 and the log matching /up/",
	);
});
