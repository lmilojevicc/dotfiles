import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { FOCUS_IN, FOCUS_OUT, type EditorFocus } from "../editor-focus.ts";
import { createHerdrIngress } from "../herdr.ts";
import { createTmuxIngress, DISABLE_FOCUS_EVENTS, ENABLE_FOCUS_EVENTS } from "../tmux.ts";

function focusRecorder() {
	const focused: boolean[] = [];
	const terminalInput: string[] = [];
	const focus: EditorFocus = {
		setFocused(value) {
			focused.push(value);
		},
		handleTerminalInput(data) {
			terminalInput.push(data);
			return data === FOCUS_IN || data === FOCUS_OUT ? { consume: true } : undefined;
		},
		install() {},
		cleanup() {},
	};
	return { focus, focused, terminalInput };
}

function terminalUI() {
	let listener: ((data: string) => { consume: true } | undefined) | undefined;
	let unsubscribes = 0;
	return {
		ui: {
			onTerminalInput(next: typeof listener) {
				listener = next;
				return () => {
					unsubscribes += 1;
					if (listener === next) listener = undefined;
				};
			},
		},
		emit(data: string) {
			return listener?.(data);
		},
		unsubscribes: () => unsubscribes,
		isSubscribed: () => listener !== undefined,
	};
}

test("herdr prepends raw ingress, consumes UI reports, and removes both listeners", () => {
	const stdin = new EventEmitter();
	const calls: string[] = [];
	stdin.on("data", () => calls.push("fullscreen"));
	const recorder = focusRecorder();
	const originalSetFocused = recorder.focus.setFocused;
	recorder.focus.setFocused = (focused) => {
		calls.push(`focus:${focused}`);
		originalSetFocused(focused);
	};
	const terminal = terminalUI();
	const ingress = createHerdrIngress(recorder.focus, stdin as never);

	ingress.start(terminal.ui);
	stdin.emit("data", `prefix${FOCUS_OUT}${FOCUS_IN}`);
	assert.deepEqual(calls, ["focus:false", "focus:true", "fullscreen"]);
	assert.deepEqual(terminal.emit(FOCUS_OUT), { consume: true });
	assert.equal(terminal.emit("text"), undefined);

	ingress.start(terminal.ui);
	assert.equal(stdin.listenerCount("data"), 2, "one fullscreen and one replacement raw listener");
	ingress.cleanup();
	assert.equal(stdin.listenerCount("data"), 1);
	assert.equal(terminal.isSubscribed(), false);
	assert.equal(terminal.unsubscribes(), 2);
});

test("tmux observes raw focus before fullscreen and balances DEC mode writes", () => {
	const stdin = new EventEmitter();
	const calls: string[] = [];
	stdin.on("data", () => calls.push("fullscreen-consumed"));
	const recorder = focusRecorder();
	const originalSetFocused = recorder.focus.setFocused;
	recorder.focus.setFocused = (focused) => {
		calls.push(`focus:${focused}`);
		originalSetFocused(focused);
	};
	const terminal = terminalUI();
	const writes: string[] = [];
	const ingress = createTmuxIngress(recorder.focus, stdin as never, { write: (data) => writes.push(data) });

	ingress.start(terminal.ui);
	stdin.emit("data", `prefix${FOCUS_OUT}${FOCUS_IN}`);
	assert.deepEqual(calls, ["focus:false", "focus:true", "fullscreen-consumed"]);

	ingress.start(terminal.ui);
	assert.deepEqual(writes, [ENABLE_FOCUS_EVENTS]);
	assert.equal(stdin.listenerCount("data"), 2, "one fullscreen and one replacement raw listener");
	assert.deepEqual(terminal.emit(FOCUS_IN), { consume: true });
	assert.equal(terminal.emit("text"), undefined);
	assert.deepEqual(recorder.terminalInput, [FOCUS_IN, "text"]);

	ingress.cleanup();
	ingress.cleanup();
	assert.deepEqual(writes, [ENABLE_FOCUS_EVENTS, DISABLE_FOCUS_EVENTS]);
	assert.equal(stdin.listenerCount("data"), 1);
	assert.equal(terminal.isSubscribed(), false);
	assert.equal(terminal.unsubscribes(), 2);
});
