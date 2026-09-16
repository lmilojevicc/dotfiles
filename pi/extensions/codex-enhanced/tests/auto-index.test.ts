import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexEnhanced, { __testing } from "../index.ts";
import { getConfigPath, readAutoResetPreference, readConfig, writeAutoResetPreference } from "../core.ts";
import { readResetJournal, resetPaths, withResetAccountLock } from "../resets.ts";

const canonical = { id: "synthetic-model", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
let nextAccount = 0;
function token(account: string) {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}
async function until(condition: () => boolean) {
	for (let i = 0; i < 1000; i++) {
		if (condition()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("condition did not settle");
}
async function drain() { for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5)); }

function fixture(t: any) {
	const dir = mkdtempSync(join(tmpdir(), "codex-auto-index-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	});
	const identity = `synthetic-${++nextAccount}`;
	const state = { renderOnRequest: false, renders: 0, frame: "", account: identity, percent: 100, count: 2, usageReads: 0, detailReads: 0, posts: [] as any[], confirmCalls: 0, statuses: [] as Array<string | undefined> };
	let component: any;
	let renderQueued = false;
	let disposed = false;
	let done: (() => void) | undefined;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx: any = {
		mode: "tui", hasUI: true, model: { ...canonical },
		modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: token(state.account), baseUrl: canonical.baseUrl } }) },
		sessionManager: { getSessionId: () => identity },
		ui: {
			theme, setStatus: (_key: string, value?: string) => { state.statuses.push(value); }, notify: () => {},
			confirm: () => { state.confirmCalls++; throw new Error("Automatic resets must never prompt"); },
			custom: (factory: any) => new Promise<void>((resolve) => {
				done = () => { disposed = true; component?.dispose?.(); resolve(); };
				component = factory({ requestRender: () => {
					state.renders++;
					if (!state.renderOnRequest || renderQueued) return;
					renderQueued = true;
					setImmediate(() => {
						renderQueued = false;
						if (!disposed) state.frame = component.render(80).join("\n");
					});
				} }, theme, {}, done);
			}),
		},
	};
	const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
	const fetch = async (url: any, init: any) => {
		assert.match(String(url), /^https:\/\/chatgpt.com\/backend-api\/wham\//);
		if (init.method === "POST") {
			state.posts.push(JSON.parse(init.body));
			return json({ code: "reset" });
		}
		if (String(url).endsWith("/usage")) {
			state.usageReads++;
			return json({ rate_limit: { secondary_window: { used_percent: state.percent, limit_window_seconds: 604800, reset_at: Date.now() / 1000 + 3600 } }, rate_limit_reset_credits: { available_count: state.count } });
		}
		assert.ok(String(url).endsWith("/rate-limit-reset-credits"));
		state.detailReads++;
		return json({ available_count: state.count, credits: [{ id: "synthetic-credit", status: "available" }] });
	};
	t.mock.method(globalThis, "fetch", fetch);
	return { dir, ctx, state, fetch, path: getConfigPath(dir), key: `account:${identity}`, component: () => component, close: () => done?.() };
}

async function waitForFrame(condition: () => boolean) {
	const deadline = Date.now() + 3_000;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(condition(), "file watcher did not update the open component");
}

test("Resets open component clears settled auto lock contention read-only and watches journal changes", async (t) => {
	const f = fixture(t); f.state.renderOnRequest = true;
	const l = lifecycle(t, f.ctx);
	const paths = resetPaths(f.dir, f.key);
	const terminal = { version: 1 as const, accountKey: f.key, phase: "reset" as const, recovered: true,
		requestId: "preserved-request", creditId: "preserved-credit" };
	await withResetAccountLock(f.dir, f.key, async (save) => save(terminal));
	const bytes = readFileSync(paths.journal, "utf8");
	{ rmSync(paths.lock, { force: true }); mkdirSync(paths.lock, { mode: 0o700 }); }
	writeAutoResetPreference(f.path, f.key, true);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); c.handleInput("tab");
	await waitForFrame(() => /Old reset lock; see README/.test(f.state.frame));
	assert.match(f.state.frame, /Old reset lock; see README/);
	assert.doesNotMatch(f.state.frame, /local recovery|A acknowledge|Ctrl\+R/);
	let auth = 0; const resolve = f.ctx.modelRegistry.getProviderAuth;
	f.ctx.modelRegistry.getProviderAuth = async () => { auth++; return resolve(); };
	const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
	c.handleInput("ctrl+r"); c.handleInput("ctrl+r"); c.handleInput("a"); await drain();
	assert.equal(auth, 0);
	assert.equal(readFileSync(paths.journal, "utf8"), bytes);
	assert.doesNotMatch(c.render(80).join("\n"), /Use 1 banked|acknowledge completion|Ctrl\+R/);
	rmSync(paths.lock, { recursive: true }); // Synthetic cooperating owner releases its fixture lock.
	await waitForFrame(() => !/Old reset lock; see README|local recovery/.test(f.state.frame));
	assert.equal(f.component(), c, "same menu remains open");
	assert.match(f.state.frame, /Auto reset +on/);
	assert.match(f.state.frame, /Manual reset · R refresh first/);
	assert.doesNotMatch(f.state.frame, /A acknowledge|Ctrl\+R/);
	assert.equal(readFileSync(paths.journal, "utf8"), bytes);
	writeFileSync(paths.journal, JSON.stringify({ ...terminal, recovered: false }));
	await waitForFrame(() => /Waiting for weekly recovery/.test(f.state.frame));
	writeFileSync(paths.journal, "not-json");
	await waitForFrame(() => /Reset journal unavailable; see README/.test(f.state.frame));
	const renders = f.state.renders;
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(f.state.renders, renders, "unchanged files do not continuously redraw");
	assert.equal(auth, 0, "watchers never resolve auth");
	assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts, "watchers never GET or POST");
	c.handleInput("escape"); await menu;
});

for (const ending of ["close", "shutdown"] as const) {
	test(`Resets account watcher rebinds singly, ignores old callbacks and stops on ${ending}`, async (t) => {
		const fs = (await import("node:fs")).default;
		const { syncBuiltinESMExports } = await import("node:module");
		const watch = fs.watchFile, unwatch = fs.unwatchFile;
		const listeners = new Map<string, Set<() => void>>();
		t.mock.method(fs, "watchFile", ((path: string, options: any, listener: () => void) => {
			const active = listeners.get(path) ?? new Set(); active.add(listener); listeners.set(path, active);
			return watch(path, options, listener);
		}) as any);
		t.mock.method(fs, "unwatchFile", ((path: string, listener: () => void) => {
			listeners.get(path)?.delete(listener); unwatch(path, listener);
		}) as any);
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		const f = fixture(t); f.state.renderOnRequest = true;
		const l = lifecycle(t, f.ctx);
		await l.handlers.get("session_start")({}, f.ctx); await drain();
		const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
		const c = f.component(); c.handleInput("tab");
		const oldPaths = resetPaths(f.dir, f.key);
		const oldCallbacks = [oldPaths.lock, oldPaths.journal].flatMap((path) => [...listeners.get(path)!]);
		assert.equal(oldCallbacks.length, 2);
		c.handleInput("r"); await drain();
		for (const path of [oldPaths.lock, oldPaths.journal]) assert.equal(listeners.get(path)?.size, 1, "same account never duplicates watchers");
		f.state.account = "synthetic-new-bound-account";
		c.handleInput("r"); await drain();
		const newPaths = resetPaths(f.dir, `account:${f.state.account}`);
		for (const path of [oldPaths.lock, oldPaths.journal]) assert.equal(listeners.get(path)?.size, 0);
		for (const path of [newPaths.lock, newPaths.journal]) assert.equal(listeners.get(path)?.size, 1);
		let renders = f.state.renders;
		for (const callback of oldCallbacks) callback();
		assert.equal(f.state.renders, renders, "queued old-account callbacks cannot render");
		{ rmSync(oldPaths.lock, { force: true }); mkdirSync(oldPaths.lock, { mode: 0o700 }); }
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.doesNotMatch(f.state.frame, /Old reset lock; see README|local recovery/);
		const callbacks = [...listeners.values()].flatMap((active) => [...active]);
		assert.equal(callbacks.length, 3, "one config watcher and two bound-account watchers");
		if (ending === "close") c.handleInput("escape");
		else await l.handlers.get("session_shutdown")({}, f.ctx);
		await menu; await drain();
		assert.ok([...listeners.values()].every((active) => active.size === 0));
		renders = f.state.renders;
		for (const callback of callbacks) callback();
		{ rmSync(newPaths.lock, { force: true }); mkdirSync(newPaths.lock, { mode: 0o700 }); }
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(f.state.renders, renders, "closed menu never redraws");
	});
}

test("automatic index path is default-off, account scoped and requires no UI prompt", async (t) => {
	const f = fixture(t);
	const signal = new AbortController().signal;
	await __testing.runCoordinatedReset(f.ctx, "auto", signal, () => true);
	assert.equal(f.state.usageReads, 0);
	assert.equal(f.state.posts.length, 0);
	writeAutoResetPreference(f.path, "account:other", true);
	await __testing.runCoordinatedReset(f.ctx, "auto", signal, () => true);
	assert.equal(f.state.posts.length, 0);
	writeAutoResetPreference(f.path, f.key, true);
	await __testing.runCoordinatedReset(f.ctx, "auto", signal, () => true);
	assert.equal(f.state.posts.length, 1);
	assert.equal(f.state.confirmCalls, 0);
});

for (const mutation of ["account", "auth", "model", "disable", "off-on", "shutdown"] as const) {
	for (const stage of ["usage", "detail", "pre-post-auth"] as const) {
		test(`automatic index suppresses ${mutation} race after ${stage}`, async (t) => {
			const f = fixture(t);
			const controller = new AbortController();
			let changed = false;
			const change = () => {
				if (changed) return;
				changed = true;
				if (mutation === "account") f.state.account = "synthetic-other";
				if (mutation === "auth") f.ctx.modelRegistry.getProviderAuth = async () => ({ auth: { apiKey: "invalid", baseUrl: canonical.baseUrl } });
				if (mutation === "model") f.ctx.model = { ...canonical, id: "different-model" };
				if (mutation === "disable" || mutation === "off-on") writeAutoResetPreference(f.path, f.key, false);
				if (mutation === "off-on") writeAutoResetPreference(f.path, f.key, true);
				if (mutation === "shutdown") controller.abort();
			};
			writeAutoResetPreference(f.path, f.key, true);
			const auth = f.ctx.modelRegistry.getProviderAuth;
			let authCalls = 0;
			f.ctx.modelRegistry.getProviderAuth = async () => {
				if (++authCalls === 6 && stage === "pre-post-auth") change();
				return changed && mutation === "auth" ? { auth: { apiKey: "invalid", baseUrl: canonical.baseUrl } } : auth();
			};
			t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
				const result = await f.fetch(url, init);
				if (init.method !== "POST" && ((stage === "usage" && String(url).endsWith("/usage"))
					|| (stage === "detail" && String(url).endsWith("/rate-limit-reset-credits")))) change();
				return result;
			});
			await __testing.runCoordinatedReset(f.ctx, "auto", controller.signal, () => true);
			assert.equal(changed, true);
			assert.equal(f.state.posts.length, 0);
			assert.equal(readResetJournal(f.dir, f.key), undefined, "definitely-unsent cancellation must not pause later auto checks");
			f.state.account = f.key.slice("account:".length);
			f.ctx.modelRegistry.getProviderAuth = auth;
			f.ctx.model = { ...canonical };
			writeAutoResetPreference(f.path, f.key, true);
			await __testing.runCoordinatedReset(f.ctx, "auto", new AbortController().signal, () => true);
			assert.equal(f.state.posts.length, 1, "later valid automatic check succeeds");
		});
	}
}

test("automatic index disable after POST preserves intent/outcome and sends no second credit", async (t) => {
	const f = fixture(t);
	writeAutoResetPreference(f.path, f.key, true);
	t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
		const result = await f.fetch(url, init);
		if (init.method === "POST") writeAutoResetPreference(f.path, f.key, false);
		return result;
	});
	await __testing.runCoordinatedReset(f.ctx, "auto", new AbortController().signal, () => true);
	assert.equal(f.state.posts.length, 1);
	assert.equal(readResetJournal(f.dir, f.key)?.phase, "reset");
	writeAutoResetPreference(f.path, f.key, true);
	await __testing.runCoordinatedReset(f.ctx, "auto", new AbortController().signal, () => true);
	assert.equal(f.state.posts.length, 1);
});

function lifecycle(t: any, ctx: any) {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const timers = new Map<any, () => void>();
	t.mock.method(globalThis, "setInterval", (fn: () => void, ms: number) => {
		assert.equal(ms, 60_000);
		const id = { unref() {} };
		timers.set(id, fn);
		return id;
	});
	t.mock.method(globalThis, "clearInterval", (id: any) => { timers.delete(id); });
	codexEnhanced({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, command: any) => commands.set(name, command) } as never);
	assert.equal(timers.size, 0, "no factory timers");
	t.after(async () => { await handlers.get("session_shutdown")({}, ctx); });
	return { handlers, commands, timers };
}

test("Resets actual Enter/Space toggles spending consent once, auto never prompts, Ctrl+R still two-step, R does not clear automatic guard", async (t) => {
	const f = fixture(t);
	const l = lifecycle(t, f.ctx);
	l.handlers.get("session_start")({}, f.ctx);
	await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
	await until(() => f.component() && f.state.detailReads > 0);
	await drain();
	const component = f.component();
	component.handleInput("tab");
	const resetText = component.render(240).join("\n");
	assert.match(resetText, /Auto reset +off · Weekly 0% · soonest expiry first · no prompts/);
	assert.doesNotMatch(resetText, /this account|Automatic spending off|fresh usage|settled turns|permission to spend|R refresh never/);
	component.handleInput("enter");
	await until(() => f.state.posts.length === 1);
	await drain();
	assert.equal(readAutoResetPreference(f.path, f.key).enabled, true);
	assert.equal(f.state.confirmCalls, 0);
	assert.match(component.render(240).join("\n"), /no prompts/);
	component.handleInput("space");
	await until(() => !readAutoResetPreference(f.path, f.key).enabled);
	component.handleInput("r");
	await drain();
	component.handleInput("ctrl+r");
	await drain();
	assert.equal(f.state.posts.length, 1);
	assert.match(component.render(240).join("\n"), /Use 1 banked reset\?/);
	component.handleInput("ctrl+r");
	await until(() => f.state.posts.length === 2);
	await drain();
	component.handleInput("enter");
	await drain();
	assert.equal(f.state.posts.length, 2, "manual R and toggles did not clear auto episode guard");
	component.handleInput("escape");
	await menu;
});

test("automatic scheduler checks settled turns and every idle minute, coalesces overlap, stops on model/shutdown, restarts once", async (t) => {
	const f = fixture(t);
	const l = lifecycle(t, f.ctx);
	writeAutoResetPreference(f.path, f.key, true);
	f.state.percent = 99.6;
	l.handlers.get("session_start")({}, f.ctx);
	await drain();
	assert.equal(l.timers.size, 1);
	assert.equal(f.state.posts.length, 0);
	f.state.percent = 100;
	const tick = [...l.timers.values()][0]!;
	tick();
	l.handlers.get("agent_settled")({}, f.ctx);
	tick();
	await until(() => f.state.posts.length === 1);
	await drain();
	assert.equal(f.state.posts.length, 1);
	f.ctx.model = { ...canonical, provider: "other" };
	l.handlers.get("model_select")({}, f.ctx);
	await drain();
	const before = f.state.usageReads; // success invalidates the footer cache; model event may refresh it
	tick();
	await drain();
	assert.equal(f.state.usageReads, before, "ineligible model has no auto quota reads; footer stays cached");
	await l.handlers.get("session_shutdown")({}, f.ctx);
	assert.equal(l.timers.size, 0);
	tick(); // stale scheduled callback cannot act
	await drain();
	assert.equal(f.state.posts.length, 1);
	f.ctx.model = { ...canonical };
	l.handlers.get("session_start")({}, f.ctx);
	await drain();
	assert.equal(l.timers.size, 1);
	assert.equal(f.state.posts.length, 1, "restart sees durable weekly guard");
});

for (const mode of ["rpc", "json", "print"]) {
	test(`automatic scheduler never starts resources or spends in ${mode}`, async (t) => {
		const f = fixture(t);
		f.ctx.mode = mode;
		writeAutoResetPreference(f.path, f.key, true);
		const l = lifecycle(t, f.ctx);
		l.handlers.get("session_start")({}, f.ctx);
		l.handlers.get("agent_settled")({}, f.ctx);
		await drain();
		assert.equal(l.timers.size, 0);
		assert.equal(f.state.posts.length, 0);
	});
}

test("Resets manual account switches invalidate both confirmation presses until current usage is refreshed", async (t) => {
	const f = fixture(t); f.state.renderOnRequest = true;
	const l = lifecycle(t, f.ctx);
	l.handlers.get("session_start")({}, f.ctx);
	await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
	await until(() => Boolean(f.component()));
	await drain();
	const component = f.component();
	component.handleInput("tab");
	f.state.account = "synthetic-switch-before-first";
	component.handleInput("ctrl+r");
	await drain();
	assert.equal(f.state.posts.length, 0);
	assert.doesNotMatch(component.render(240).join("\n"), /Use 1 banked reset\?/);
	component.handleInput("ctrl+r");
	await drain();
	assert.match(component.render(240).join("\n"), /Use 1 banked reset\?/);
	f.state.account = "synthetic-switch-before-second";
	component.handleInput("ctrl+r");
	await drain();
	assert.equal(f.state.posts.length, 0);
	assert.doesNotMatch(component.render(240).join("\n"), /Use 1 banked reset\?/);
	component.handleInput("ctrl+r");
	await drain();
	assert.equal(f.state.posts.length, 0);
	component.handleInput("ctrl+r");
	await until(() => f.state.posts.length === 1);
	assert.equal(f.state.posts[0].account_id, "synthetic-switch-before-second");
	await drain();
	component.handleInput("escape");
	await menu;
});

test("Resets toggle suppresses an account-switch race instead of enabling unseen account consent", async (t) => {
	const f = fixture(t);
	const l = lifecycle(t, f.ctx);
	l.handlers.get("session_start")({}, f.ctx);
	await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
	await until(() => Boolean(f.component()));
	await drain();
	const component = f.component();
	component.handleInput("tab");
	f.state.account = "synthetic-new-toggle-account";
	component.handleInput("enter");
	await drain();
	assert.equal(readAutoResetPreference(f.path, "account:synthetic-new-toggle-account").enabled, false);
	assert.equal(f.state.posts.length, 0);
	assert.match(component.render(240).join("\n"), /No spending preference changed/);
	component.handleInput("space");
	await until(() => f.state.posts.length === 1);
	assert.equal(f.state.confirmCalls, 0);
	assert.equal(f.state.posts[0].account_id, "synthetic-new-toggle-account");
	await drain();
	component.handleInput("escape");
	await menu;
});

test("unresolved legacy pending IDs are durably preserved at startup even while auto is off", async (t) => {
	const f = fixture(t);
	const symbol = Symbol.for("codex-enhanced.reset-request-store");
	const prior = Reflect.get(globalThis, symbol);
	Reflect.set(globalThis, symbol, new Map([[f.key, { phase: "pending", requestId: "legacy-request", creditId: "legacy-credit", message: "must not persist raw error" }]]));
	t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
	const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx);
	const saved = readResetJournal(f.dir, f.key)!;
	assert.equal(saved.phase, "legacy_blocked");
	assert.deepEqual(saved.legacyBlocked, { requestId: "legacy-request", creditId: "legacy-credit", phase: "pending", active: false, settled: false });
	assert.doesNotMatch(JSON.stringify(saved), /raw error/);
	Reflect.deleteProperty(globalThis, symbol); // restart no longer has the old in-memory map
	await drain(); // Let the startup default-off scheduler finish before enabling this independent caller.
	writeAutoResetPreference(f.path, f.key, true);
	const automatic = await __testing.runCoordinatedReset(f.ctx, "auto", new AbortController().signal, () => true);
	assert.match(automatic.status, /previous reset needs recovery/);
	const manual = await __testing.runCoordinatedReset(f.ctx, "manual", new AbortController().signal, () => true, undefined, undefined, undefined, undefined, { kind: "spend" });
	assert.match(manual.status, /previous reset needs recovery/);
	assert.equal(f.state.posts.length, 0);
});

for (const tab of ["quota", "resets"]) {
	test(`automatic reconciliation updates open ${tab}, credit balance and footer without rearming`, async (t) => {
		const f = fixture(t);
		const l = lifecycle(t, f.ctx);
		await l.handlers.get("session_start")({}, f.ctx);
		await drain();
		const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
		await drain();
		const component = f.component();
		if (tab === "resets") component.handleInput("tab");
		assert.equal(f.state.statuses.at(-1), "Codex weekly: 0% left");
		t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
			const result = await f.fetch(url, init);
			if (init.method === "POST") { f.state.percent = 25; f.state.count = 1; }
			return result;
		});
		writeAutoResetPreference(f.path, f.key, true);
		const tick = [...l.timers.values()][0]!;
		tick();
		await drain();
		assert.equal(f.state.posts.length, 1);
		assert.equal(f.state.statuses.at(-1), "Codex weekly: 75% left");
		assert.match(component.render(240).join("\n"), tab === "quota" ? /75%/ : /1 banked reset/);
		component.handleInput(tab === "quota" ? "tab" : "shift+tab");
		assert.match(component.render(240).join("\n"), tab === "quota" ? /1 banked reset/ : /75%/);
		assert.equal(readResetJournal(f.dir, f.key)?.recovered, false, "reconciliation is display-only");
		f.state.percent = 100;
		tick();
		await drain();
		assert.equal(f.state.posts.length, 1, "reconciliation recovery did not authorize a second spend");
		component.handleInput("escape");
		await menu;
		await drain();
		assert.equal(f.state.statuses.at(-1), "Codex weekly: 75% left", "closing menu retains updated footer cache");
	});
}

test("automatic reconciliation supersedes older pending initial menu and footer GETs", async (t) => {
	const f = fixture(t);
	const l = lifecycle(t, f.ctx);
	let release!: () => void;
	const wait = new Promise<void>((resolve) => { release = resolve; });
	let waiting = 0;
	t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
		const result = await f.fetch(url, init);
		if (init.method === "POST") { f.state.percent = 25; f.state.count = 1; }
		if (init.method !== "POST" && String(url).endsWith("/usage") && waiting < 2) {
			waiting++;
			await wait;
		}
		return result;
	});
	await l.handlers.get("session_start")({}, f.ctx);
	await until(() => waiting === 1);
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
	await until(() => waiting === 2);
	const component = f.component();
	writeAutoResetPreference(f.path, f.key, true);
	[...l.timers.values()][0]!();
	await drain();
	assert.equal(f.state.posts.length, 1);
	assert.match(component.render(240).join("\n"), /75%/);
	assert.equal(f.state.statuses.at(-1), "Codex weekly: 75% left");
	release();
	await drain();
	assert.match(component.render(240).join("\n"), /75%/);
	assert.equal(f.state.statuses.at(-1), "Codex weekly: 75% left");
	component.handleInput("tab");
	assert.match(component.render(240).join("\n"), /1 banked reset/);
	component.handleInput("escape");
	await menu;
});

for (const mutation of ["account", "model", "shutdown"] as const) {
	test(`automatic reconciliation suppresses stale display after ${mutation} race`, async (t) => {
		const f = fixture(t);
		const l = lifecycle(t, f.ctx);
		await l.handlers.get("session_start")({}, f.ctx);
		await drain();
		const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
		await drain();
		const component = f.component();
		component.handleInput("tab");
		let release!: () => void;
		const wait = new Promise<void>((resolve) => { release = resolve; });
		let waiting = false;
		t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
			const result = await f.fetch(url, init);
			if (init.method === "POST") { f.state.percent = 25; f.state.count = 1; }
			if (f.state.posts.length && init.method !== "POST" && String(url).endsWith("/rate-limit-reset-credits") && !waiting) {
				waiting = true;
				await wait;
			}
			return result;
		});
		writeAutoResetPreference(f.path, f.key, true);
		[...l.timers.values()][0]!();
		await until(() => waiting);
		f.state.percent = 60;
		f.state.count = 7;
		let shutdown: Promise<void> | undefined;
		if (mutation === "shutdown") shutdown = l.handlers.get("session_shutdown")({}, f.ctx);
		else {
			if (mutation === "account") f.state.account = "synthetic-reconciliation-other";
			else f.ctx.model = { ...canonical, id: "changed-during-reconciliation" };
			l.handlers.get("model_select")({}, f.ctx);
			if (mutation === "account") component.handleInput("r");
			await drain();
		}
		release();
		await shutdown;
		await drain();
		assert.equal(f.state.statuses.includes("Codex weekly: 75% left"), false, "old reconciliation never reaches footer");
		assert.doesNotMatch(component.render(240).join("\n"), /1 banked reset/);
		if (mutation === "account") {
			assert.match(component.render(240).join("\n"), /7 banked resets/);
			assert.equal(f.state.statuses.at(-1), "Codex weekly: 40% left");
		}
		assert.equal(readResetJournal(f.dir, f.key)?.recovered, false);
		if (mutation !== "shutdown") component.handleInput("escape");
		await menu;
	});
}

for (const failure of ["held", "orphan", "corrupt"] as const) {
	for (const tab of ["quota", "resets"]) {
		test(`R in ${tab} refreshes display with ${failure} coordination but grants no manual rearm`, async (t) => {
			const f = fixture(t);
			const l = lifecycle(t, f.ctx);
			await l.handlers.get("session_start")({}, f.ctx);
			await drain();
			const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
			await drain();
			const component = f.component();
			if (tab === "resets") component.handleInput("tab");
			await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key,
				phase: "reset", recovered: false, creditId: "prior-credit", requestId: "prior-request" }));
			const paths = resetPaths(f.dir, f.key);
			const terminal = readFileSync(paths.journal, "utf8");
			let release!: () => void;
			let held: Promise<void> | undefined;
			if (failure === "held") {
				let entered!: () => void; const ready = new Promise<void>((r) => { entered = r; });
				held = withResetAccountLock(f.dir, f.key, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
				await ready;
			}
			else if (failure === "orphan") { rmSync(paths.lock, { force: true }); mkdirSync(paths.lock, { mode: 0o700 }); }
			else writeFileSync(paths.journal, "not-json");
			const saved = readFileSync(paths.journal, "utf8");
			f.state.percent = 35;
			f.state.count = 0; // No detail-cache involvement in this read-only refresh.
			const before = f.state.usageReads;
			component.handleInput("r");
			await drain();
			assert.ok(f.state.usageReads > before, "quota GET remains available");
			assert.match(component.render(240).join("\n"), tab === "quota" ? /65%/ : /0 banked resets/);
			assert.equal(readFileSync(paths.journal, "utf8"), saved, "R does not change journal");
			if (tab === "quota") component.handleInput("tab");
			component.handleInput("ctrl+r"); await drain();
			component.handleInput("ctrl+r"); await drain();
			assert.equal(f.state.posts.length, 0, "spending remains fail-closed");
			assert.equal(readFileSync(paths.journal, "utf8"), saved);
			component.handleInput("r"); await drain(); // Do not consume this failed-coordination refresh before recovery.
			// Synthetic operator recovery only: restore the existing terminal guard after
			// releasing test ownership. A failed-coordination R must not authorize it.
			if (failure === "held") { release(); await held; }
			else if (failure === "orphan") rmSync(paths.lock, { recursive: true });
			else writeFileSync(paths.journal, terminal);
			f.state.count = 2;
			component.handleInput("ctrl+r"); await drain();
			component.handleInput("ctrl+r"); await drain();
			assert.equal(f.state.posts.length, 0, "failed coordinated refresh issued no rearm token");
			await waitForFrame(() => /Manual reset · R refresh first/.test(component.render(240).join("\n")));
			assert.equal(readFileSync(paths.journal, "utf8"), terminal);
			component.handleInput("escape");
			await menu;
		});
	}
}

for (const source of ["success", "ambiguous", "unknown"] as const) {
	test(`legacy ${source} surviving producer repairs matching lossy startup marker without spending`, async (t) => {
		const f = fixture(t);
		const symbol = Symbol.for("codex-enhanced.reset-request-store");
		const prior = Reflect.get(globalThis, symbol);
		const ids = { requestId: "original-request", creditId: "original-credit" };
		Reflect.set(globalThis, symbol, new Map([[f.key, { ...ids,
			phase: source === "ambiguous" ? "ambiguous" : "locked", promise: undefined,
			message: source === "success" ? { kind: "info", text: "Codex rate limits reset." }
				: { kind: "error", text: "Reset response was not recognized; refreshed usage." },
		}]]));
		t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
		await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key,
			phase: "legacy_blocked", recovered: false, legacyBlocked: ids }));
		const l = lifecycle(t, f.ctx);
		await l.handlers.get("session_start")({}, f.ctx);
		assert.equal(f.state.posts.length, 0);
		assert.equal(readResetJournal(f.dir, f.key)?.phase, source === "success" ? "reset" : source);
		assert.equal(readResetJournal(f.dir, f.key)?.legacyBlocked, undefined);
		const migrated = readFileSync(resetPaths(f.dir, f.key).journal, "utf8");
		await l.handlers.get("session_start")({}, f.ctx); // repeated /reload with original map retained
		assert.equal(readFileSync(resetPaths(f.dir, f.key).journal, "utf8"), migrated);
		writeAutoResetPreference(f.path, f.key, true);
		await __testing.runCoordinatedReset(f.ctx, "auto", new AbortController().signal, () => true);
		assert.equal(f.state.posts.length, 0);
		const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
		await drain();
		const component = f.component();
		component.handleInput("tab");
		assert.doesNotMatch(component.render(240).join("\n"), /legacy|previous reset needs recovery|this account|Automatic spending off/);
		assert.match(component.render(240).join("\n"), /Auto reset +on · Weekly 0% · soonest expiry first · no prompts/);
		if (source !== "success") {
			component.handleInput("ctrl+r"); await drain();
			assert.equal(f.state.posts.length, 0);
			component.handleInput("ctrl+r"); await drain();
			assert.equal(f.state.posts.length, 1);
			assert.equal(f.state.posts[0].credit_id, ids.creditId);
			assert.equal(f.state.posts[0].redeem_request_id, ids.requestId);
		}
		component.handleInput("escape");
		await menu;
	});
}

test("legacy pending promise remains owned by old producer until finally; reload then migrates success", async (t) => {
	const f = fixture(t);
	const symbol = Symbol.for("codex-enhanced.reset-request-store");
	const prior = Reflect.get(globalThis, symbol);
	const state = { requestId: "live-original-request", creditId: "live-original-credit", phase: "pending",
		promise: new Promise(() => {}) as Promise<unknown> | undefined,
		message: undefined as { kind: string; text: string } | undefined };
	Reflect.set(globalThis, symbol, new Map([[f.key, state]]));
	t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
	const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx);
	assert.equal(readResetJournal(f.dir, f.key), undefined);
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
	await drain();
	f.component().handleInput("tab");
	assert.match(f.component().render(240).join("\n"), /previous reset still running/);
	for (const mode of ["manual", "auto"] as const) {
		if (mode === "auto") writeAutoResetPreference(f.path, f.key, true);
		assert.match((await __testing.runCoordinatedReset(f.ctx, mode, new AbortController().signal, () => true)).status, /still running/);
	}
	state.phase = "locked";
	state.message = { kind: "info", text: "Codex rate limits reset." };
	await l.handlers.get("session_start")({}, f.ctx);
	assert.equal(readResetJournal(f.dir, f.key), undefined, "then callback is not finally settlement");
	state.promise = undefined;
	await l.handlers.get("session_start")({}, f.ctx);
	await drain();
	assert.equal(readResetJournal(f.dir, f.key)?.phase, "reset");
	assert.equal(readResetJournal(f.dir, f.key)?.recovered, false);
	assert.equal(f.state.posts.length, 0);
	await menu; // reload closes the prior menu via the existing shutdown signal
});

test("legacy startup re-reads producer state after each account's awaited migration", async (t) => {
	const f = fixture(t);
	const symbol = Symbol.for("codex-enhanced.reset-request-store");
	const prior = Reflect.get(globalThis, symbol);
	const first = { requestId: "first-request", creditId: "first-credit", phase: "locked",
		message: { kind: "info", text: "Codex rate limits reset." } };
	const second = { requestId: "second-request", creditId: "second-credit", phase: "ambiguous",
		promise: undefined as Promise<unknown> | undefined };
	Reflect.set(globalThis, symbol, new Map([["account:synthetic-first", first], [f.key, second]]));
	t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
	const l = lifecycle(t, f.ctx);
	queueMicrotask(() => { second.phase = "pending"; second.promise = new Promise(() => {}); });
	await l.handlers.get("session_start")({}, f.ctx);
	assert.equal(readResetJournal(f.dir, "account:synthetic-first")?.phase, "reset");
	assert.equal(readResetJournal(f.dir, f.key), undefined, "second account is now live, not settled ambiguity");
	assert.equal(f.state.posts.length, 0);
});

async function recoveryMenu(t: any) {
	const f = fixture(t);
	const original = { version: 1 as const, accountKey: f.key, phase: "legacy_blocked" as const, recovered: false,
		legacyBlocked: { requestId: "synthetic-old-request", creditId: "synthetic-old-credit" } };
	await withResetAccountLock(f.dir, f.key, async (save) => save(original));
	const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	f.component().handleInput("tab");
	const bytes = () => readFileSync(resetPaths(f.dir, f.key).journal, "utf8");
	return { ...f, l, menu, bytes, original };
}

for (const choice of ["1", "2"]) {
	test(`Resets A→${choice}→Enter explicitly acknowledges locally, no GET/POST or spend/refresh chain`, async (t) => {
		const f = await recoveryMenu(t);
		const c = f.component(); const before = f.bytes();
		const preference = readAutoResetPreference(f.path, f.key);
		let auth = 0; const resolve = f.ctx.modelRegistry.getProviderAuth;
		f.ctx.modelRegistry.getProviderAuth = async () => { auth++; return resolve(); };
		const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
		assert.match(c.render(60).join("\n"), /A acknowledge completion/);
		c.handleInput("a"); await drain();
		assert.equal(f.bytes(), before, "A only opens");
		assert.match(c.render(40).join("\n"), /Choose the confirmed/);
		c.handleInput("enter"); await drain();
		assert.equal(f.bytes(), before, "no silently selected successful outcome");
		c.handleInput(choice);
		assert.match(c.render(80).join("\n"), /no old request is\s+running/);
		c.handleInput("enter"); c.handleInput("enter"); await drain();
		const journal = readResetJournal(f.dir, f.key)!;
		assert.equal(journal.phase, choice === "1" ? "reset" : "already_redeemed");
		assert.equal(journal.recovered, false);
		assert.equal(journal.requestId, f.original.legacyBlocked.requestId);
		assert.equal(journal.creditId, f.original.legacyBlocked.creditId);
		assert.deepEqual(journal.legacyAcknowledgement?.original, f.original);
		assert.equal(Object.hasOwn(journal, "legacyBlocked"), false);
		assert.equal(auth, 3, "identity resolves on open, confirmation and again inside the acquired lock");
		assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
		assert.deepEqual(readAutoResetPreference(f.path, f.key), preference);
		assert.equal(f.state.confirmCalls, 0, "inline substate, no nested dialogs");
		const rendered = c.render(60).join("\n");
		assert.match(rendered, /Completion saved locally; no reset used/);
		assert.doesNotMatch(rendered, /needs review|A acknowledge|Use 1 banked reset\?/);
		assert.match(rendered, /Manual reset · R refresh first/);
		// Neither acknowledgement nor stale keys granted a manual-refresh token.
		c.handleInput("ctrl+r"); await drain(); c.handleInput("ctrl+r"); await drain();
		assert.equal(f.state.posts.length, 0);
		for (const width of [40, 60]) {
			assert.equal(c.render(width).join("\n").match(/Manual reset · R refresh first/g)?.length, 1, "guarded attempt has one footer action only");
		}
		c.handleInput("r"); await drain();
		c.handleInput("ctrl+r"); await drain(); assert.equal(f.state.posts.length, 0);
		c.handleInput("ctrl+r"); await drain(); assert.equal(f.state.posts.length, 1);
		c.handleInput("escape"); await f.menu;
	});
}

for (const stage of ["open", "outcome", "confirm-auth"] as const) {
	test(`Resets recovery cancellation at ${stage} is byte-identical and never spends`, async (t) => {
		const f = await recoveryMenu(t); const c = f.component(); const before = f.bytes();
		const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
		c.handleInput("a"); await drain();
		if (stage !== "open") c.handleInput("1");
		let release!: () => void;
		const auth = f.ctx.modelRegistry.getProviderAuth;
		if (stage === "confirm-auth") {
			f.ctx.modelRegistry.getProviderAuth = async () => { await new Promise<void>((resolve) => { release = resolve; }); return auth(); };
			c.handleInput("enter");
		}
		c.handleInput("escape");
		if (stage === "confirm-auth") { release(); f.ctx.modelRegistry.getProviderAuth = auth; }
		await drain();
		assert.equal(f.bytes(), before);
		assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
		assert.match(c.render(40).join("\n"), /A acknowledge completion/);
		f.close(); // no additional key needed to settle the custom component
		await f.menu;
	});
}

for (const stage of ["opening", "confirming"] as const) for (const race of ["account", "auth", "model", "model-off-on", "toggle", "off-on", "tab", "close", "shutdown", "journal", "journal-malformed", "corrupt", "lock", "legacy-live", "legacy-conflict"] as const) {
	test(`Resets acknowledgement cancels ${race} race while ${stage}`, async (t) => {
		const f = await recoveryMenu(t); const c = f.component();
		if (stage === "confirming") { c.handleInput("a"); await drain(); c.handleInput("1"); }
		const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
		const resolve = f.ctx.modelRegistry.getProviderAuth;
		let release!: () => void; let waiting = false;
		f.ctx.modelRegistry.getProviderAuth = async () => {
			if (!waiting) { waiting = true; await new Promise<void>((r) => { release = r; }); }
			if (race === "auth" && stage === "confirming") return { auth: { apiKey: token(f.state.account).replace("signature", "changed"), baseUrl: canonical.baseUrl } };
			return resolve();
		};
		c.handleInput(stage === "opening" ? "a" : "enter");
		await until(() => waiting);
		let shutdown: Promise<void> | undefined;
		const symbol = Symbol.for("codex-enhanced.reset-request-store"); const prior = Reflect.get(globalThis, symbol);
		if (race === "account" || (race === "auth" && stage === "opening")) f.state.account = "synthetic-other-recovery";
		if (race === "model" || race === "model-off-on") {
			f.ctx.model = { ...canonical, id: "synthetic-other-model" };
			f.l.handlers.get("model_select")({}, f.ctx);
			if (race === "model-off-on") { f.ctx.model = { ...canonical }; f.l.handlers.get("model_select")({}, f.ctx); }
		}
		if (race === "toggle" || race === "off-on") {
			writeAutoResetPreference(f.path, f.key, true);
			if (race === "off-on") writeAutoResetPreference(f.path, f.key, false);
		}
		if (race === "tab") c.handleInput("tab");
		if (race === "close") c.handleInput("ctrl+c");
		if (race === "shutdown") shutdown = f.l.handlers.get("session_shutdown")({}, f.ctx);
		if (race === "journal") await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key, phase: "pending", recovered: false, requestId: "competing-request", creditId: "competing-credit" }));
		if (race === "journal-malformed") writeFileSync(resetPaths(f.dir, f.key).journal, JSON.stringify({ ...f.original, legacyBlocked: { requestId: "missing-credit" } }));
		if (race === "corrupt") writeFileSync(resetPaths(f.dir, f.key).journal, "not-json");
		if (race === "lock") { rmSync(resetPaths(f.dir, f.key).lock, { force: true }); mkdirSync(resetPaths(f.dir, f.key).lock, { mode: 0o700 }); }
		if (race === "legacy-live" || race === "legacy-conflict") {
			Reflect.set(globalThis, symbol, new Map([[f.key, { ...f.original.legacyBlocked, phase: "pending",
				...(race === "legacy-live" ? { promise: new Promise(() => {}) } : { requestId: "conflicting-request" }) }]]));
			t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
		}
		const before = f.bytes(); release(); await drain(); await shutdown;
		assert.equal(f.bytes(), before);
		if (race !== "corrupt") assert.equal(readResetJournal(f.dir, f.key)?.legacyAcknowledgement, undefined);
		assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
		assert.equal(f.state.posts.length, 0);
		if (race !== "close" && race !== "shutdown") f.close();
		await f.menu;
	});
}

test("Resets recovery rejects identity lookup failure without quota/reset calls", async (t) => {
	const f = await recoveryMenu(t); const c = f.component(); const before = f.bytes();
	const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
	let auth = 0;
	f.ctx.modelRegistry.getProviderAuth = async () => { auth++; throw new Error("synthetic auth unavailable"); };
	c.handleInput("a"); await drain();
	assert.equal(auth, 1); assert.equal(f.bytes(), before);
	assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
	f.close(); await f.menu;
});

for (const phase of ["pending", "ambiguous", "unknown"] as const) {
	test(`Resets normal ${phase} never exposes A acknowledgement`, async (t) => {
		const f = await recoveryMenu(t); const c = f.component();
		await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key, phase, recovered: false, requestId: "synthetic-uncertain", creditId: "synthetic-uncertain-credit" }));
		const before = f.bytes();
		assert.doesNotMatch(c.render(40).join("\n"), /A acknowledge/);
		assert.match(c.render(40).join("\n"), /Ctrl\+R retry previous reset/);
		c.handleInput("a"); c.handleInput("1"); await drain();
		assert.equal(f.bytes(), before); assert.equal(f.state.posts.length, 0);
		c.handleInput("escape"); await f.menu;
	});
}

test("Resets armed Escape cancels before closing; Tab and R clear manual arms", async (t) => {
	const f = fixture(t); const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); c.handleInput("tab");
	for (const cancel of ["escape", "tab", "r"]) {
		c.handleInput("ctrl+r"); await drain(); assert.match(c.render(40).join("\n"), /Ctrl\+R use reset · Esc cancel/);
		c.handleInput(cancel); await drain(); if (cancel === "tab") c.handleInput("shift+tab");
		assert.doesNotMatch(c.render(40).join("\n"), /Use 1 banked reset\?/);
	}
	assert.equal(f.state.posts.length, 0);
	c.handleInput("escape"); await menu;
});

test("Resets actual component retains complete controls at 32/40/60/80 and boundary widths", async (t) => {
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const { stripVTControlCharacters } = await import("node:util");
	const f = await recoveryMenu(t); const c = f.component();
	// Synthetic ANSI theme render pass: exercise theme callbacks, not a no-colour mock.
	f.ctx.ui.theme.fg = (color: string, text: string) => `\x1b[${color === "accent" ? "36" : "37"}m${text}\x1b[0m`;
	f.ctx.ui.theme.bold = (text: string) => `\x1b[1m${text}\x1b[22m`;
	const widths = [32, 39, 40, 41, 59, 60, 61, 79, 80, 81];
	const check = (patterns: RegExp[], policy = false) => {
		for (const width of widths) {
			const lines = c.render(width);
			assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
			const text = lines.map(stripVTControlCharacters).join("\n");
			for (const pattern of patterns) assert.match(text, pattern, `${width}: ${text}`);
			if (policy) assert.match(text, /no prompts/);
		}
	};
	check([/A acknowledge completion/, /Space auto/, /R refresh/, /Tab next · Esc close/], true);
	c.handleInput("a"); await drain(); check([/1 reset · 2 already applied/, /Esc cancel/]);
	c.handleInput("1"); check([/Enter acknowledge · Esc cancel/, /no old request/]);
	c.handleInput("escape");
	await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key, phase: "unknown", recovered: false, requestId: "synthetic-unknown", creditId: "synthetic-unknown-credit" }));
	check([/Ctrl\+R retry previous reset/, /Tab next · Esc close/], true);
	c.handleInput("ctrl+r"); await drain(); check([/Retry previous reset\?/, /Ctrl\+R retry · Esc cancel/], true);
	c.handleInput("escape"); c.handleInput("escape"); await f.menu;
});

test("Resets applying reset is not account loading or its own local-lock error", async (t) => {
	const f = fixture(t); const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); c.handleInput("tab");
	let release!: () => void; let waiting = false;
	t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
		const response = await f.fetch(url, init);
		if (init.method === "POST") { waiting = true; await new Promise<void>((r) => { release = r; }); }
		return response;
	});
	c.handleInput("ctrl+r"); await drain(); c.handleInput("ctrl+r"); await until(() => waiting);
	assert.match(c.render(40).join("\n"), /Applying reset/);
	assert.doesNotMatch(c.render(40).join("\n"), /Checking account|local recovery|Ctrl\+R/);
	release(); await drain(); c.handleInput("escape"); await menu;
});

test("Resets acknowledgement clears stale auto pause and retains scheduler recovery→exhaustion guard", async (t) => {
	const f = await recoveryMenu(t); const c = f.component();
	writeAutoResetPreference(f.path, f.key, true);
	const tick = [...f.l.timers.values()][0]!;
	tick(); await drain();
	assert.match(c.render(80).join("\n"), /previous reset needs review/);
	const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
	c.handleInput("a"); await drain(); c.handleInput("1"); c.handleInput("enter"); await drain();
	assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
	assert.match(c.render(80).join("\n"), /Completion saved locally/);
	assert.equal(readResetJournal(f.dir, f.key)?.recovered, false);
	tick(); await drain(); assert.equal(f.state.posts.length, 0);
	assert.doesNotMatch(c.render(80).join("\n"), /needs review|Completion saved/);
	assert.match(c.render(80).join("\n"), /Waiting for weekly recovery/);
	f.state.percent = 50; tick(); await drain();
	assert.equal(readResetJournal(f.dir, f.key)?.recovered, true); assert.equal(f.state.posts.length, 0);
	f.state.percent = 100; tick(); await drain(); assert.equal(f.state.posts.length, 1);
	c.handleInput("escape"); await f.menu;
});

test("Resets acknowledgement durability failure releases lock and preserves prior review and no reset calls", async (t) => {
	const fs = (await import("node:fs")).default;
	const { syncBuiltinESMExports } = await import("node:module");
	const f = await recoveryMenu(t); const c = f.component(); const before = f.bytes();
	c.handleInput("a"); await drain(); c.handleInput("1");
	const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
	t.mock.method(fs, "renameSync", () => { throw new Error("synthetic acknowledgement fault"); }); syncBuiltinESMExports();
	c.handleInput("enter"); await drain();
	(fs.renameSync as any).mock.restore(); syncBuiltinESMExports();
	assert.equal(f.bytes(), before);
	assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
	const text = c.render(60).join("\n");
	assert.match(text, /previous reset needs review/);
	assert.match(text, /A acknowledge completion/);
	assert.doesNotMatch(text, /Completion saved|Ctrl\+R/);
	c.handleInput("escape"); await f.menu;
});

for (const cancellation of ["escape", "tab", "r"] as const) {
	test(`manual second-auth continuation cannot rearm after ${cancellation}`, async (t) => {
		const f = fixture(t); const l = lifecycle(t, f.ctx);
		await l.handlers.get("session_start")({}, f.ctx); await drain();
		const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
		const c = f.component(); c.handleInput("tab"); c.handleInput("ctrl+r"); await drain();
		assert.match(c.render(60).join("\n"), /Use 1 banked reset\?/);
		const auth = f.ctx.modelRegistry.getProviderAuth;
		let release!: () => void; let waiting = false;
		f.ctx.modelRegistry.getProviderAuth = async () => {
			if (!waiting) { waiting = true; await new Promise<void>((r) => { release = r; }); }
			return auth();
		};
		c.handleInput("ctrl+r"); await until(() => waiting);
		c.handleInput(cancellation); release(); await drain();
		if (cancellation === "tab") c.handleInput("shift+tab");
		assert.equal(f.state.posts.length, 0);
		assert.doesNotMatch(c.render(60).join("\n"), /Use 1 banked reset\?|Enter (?:retry|use reset)/);
		c.handleInput("ctrl+r"); await drain();
		assert.equal(f.state.posts.length, 0, "first fresh press only arms");
		assert.match(c.render(60).join("\n"), /Use 1 banked reset\?/);
		c.handleInput("ctrl+r"); await drain(); assert.equal(f.state.posts.length, 1);
		c.handleInput("escape"); await menu;
	});
}

for (const scenario of ["recovered", "newer-request"] as const) {
	test(`manual footer and input require exact terminal refresh for ${scenario}`, async (t) => {
		const f = await recoveryMenu(t); const c = f.component();
		const terminal = { version: 1 as const, accountKey: f.key, phase: "reset" as const, recovered: true,
			requestId: "terminal-original", creditId: "terminal-credit" };
		await withResetAccountLock(f.dir, f.key, async (save) => save(terminal));
		if (scenario === "newer-request") {
			c.handleInput("r"); await drain();
			assert.match(c.render(60).join("\n"), /Ctrl\+R use 1 reset/);
			await withResetAccountLock(f.dir, f.key, async (save) => save({ ...terminal, requestId: "terminal-newer" }));
		}
		const before = f.bytes(); const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
		c.handleInput("ctrl+r"); await drain(); c.handleInput("ctrl+r"); await drain();
		for (const width of [40, 60]) {
			const text = c.render(width).join("\n");
			assert.equal(text.match(/Manual reset · R refresh first/g)?.length, 1, "one footer action, never a duplicate body instruction");
			assert.doesNotMatch(text, /Ctrl\+R (use reset|confirm)|Use 1 banked reset\?/);
		}
		assert.equal(f.bytes(), before); assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
		c.handleInput("r"); await drain();
		assert.match(c.render(60).join("\n"), /Ctrl\+R use 1 reset/);
		c.handleInput("ctrl+r"); await drain(); assert.equal(f.state.posts.length, 0);
		c.handleInput("ctrl+r"); await drain(); assert.equal(f.state.posts.length, 1);
		c.handleInput("escape"); await f.menu;
	});
}

for (const blocker of ["lossy", "lock", "corrupt", "live"] as const) {
	test(`durable ${blocker} drops a stale manual arm, keeps disabled action visible and ignores Ctrl+R`, async (t) => {
		const f = await recoveryMenu(t); const c = f.component();
		await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key, phase: "unknown", recovered: false,
			requestId: "uncertain-request", creditId: "uncertain-credit" }));
		c.handleInput("ctrl+r"); await drain(); assert.match(c.render(60).join("\n"), /Ctrl\+R (?:retry|use reset)/);
		if (blocker === "lossy") await withResetAccountLock(f.dir, f.key, async (save) => save(f.original));
		if (blocker === "lock") { rmSync(resetPaths(f.dir, f.key).lock, { force: true }); mkdirSync(resetPaths(f.dir, f.key).lock, { mode: 0o700 }); }
		if (blocker === "corrupt") writeFileSync(resetPaths(f.dir, f.key).journal, "not-json");
		if (blocker === "live") {
			const symbol = Symbol.for("codex-enhanced.reset-request-store"); const prior = Reflect.get(globalThis, symbol);
			Reflect.set(globalThis, symbol, new Map([[f.key, { requestId: "live-request", creditId: "live-credit", phase: "pending", promise: new Promise(() => {}) }]]));
			t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
		}
		let auth = 0; const resolve = f.ctx.modelRegistry.getProviderAuth;
		f.ctx.modelRegistry.getProviderAuth = async () => { auth++; return resolve(); };
		const before = f.bytes(); const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
		// Input must drop the stale arm even without an intervening render.
		c.handleInput("ctrl+r"); await drain(); c.handleInput("ctrl+r"); await drain();
		for (const width of [40, 60]) {
			const text = c.render(width).join("\n");
			assert.doesNotMatch(text, /Ctrl\+R|Use 1 banked reset\?|Retry previous reset\?/);
			assert.match(text, /Manual reset unavailable/);
			if (blocker === "lossy") assert.match(text, /A acknowledge completion/);
		}
		assert.equal(auth, 0); assert.equal(f.bytes(), before);
		assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
		if (blocker === "lossy") { c.handleInput("a"); await drain(); assert.match(c.render(60).join("\n"), /Choose the confirmed/); c.handleInput("escape"); }
		c.handleInput("escape"); await f.menu;
	});
}

test("new uncertain request drops old manual arm and requires two fresh exact-ID retry presses", async (t) => {
	const f = await recoveryMenu(t); const c = f.component();
	const uncertain = { version: 1 as const, accountKey: f.key, phase: "unknown" as const, recovered: false, requestId: "old-uncertain", creditId: "old-credit" };
	await withResetAccountLock(f.dir, f.key, async (save) => save(uncertain));
	c.handleInput("ctrl+r"); await drain();
	await withResetAccountLock(f.dir, f.key, async (save) => save({ ...uncertain, requestId: "new-uncertain", creditId: "new-credit" }));
	assert.doesNotMatch(c.render(60).join("\n"), /Enter (?:retry|use reset)/);
	c.handleInput("ctrl+r"); await drain(); assert.equal(f.state.posts.length, 0);
	c.handleInput("ctrl+r"); await drain(); assert.equal(f.state.posts.length, 1);
	assert.equal(f.state.posts[0].redeem_request_id, "new-uncertain"); assert.equal(f.state.posts[0].credit_id, "new-credit");
	c.handleInput("escape"); await f.menu;
});

for (const stage of ["opening", "final"] as const) for (const changed of ["marker", "live", "conflict", "busy"] as const) {
	test(`acknowledgement ${stage} auth failure is visible but cannot mask changed ${changed} safety`, async (t) => {
		const f = await recoveryMenu(t); const c = f.component();
		if (stage === "final") { c.handleInput("a"); await drain(); c.handleInput("1"); }
		const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length]; const before = f.bytes();
		let auth = 0; const resolve = f.ctx.modelRegistry.getProviderAuth;
		f.ctx.modelRegistry.getProviderAuth = async () => { auth++; throw new Error("synthetic identity lookup failure"); };
		c.handleInput(stage === "opening" ? "a" : "enter"); await drain();
		for (const width of [40, 60]) {
			const text = c.render(width).join("\n");
			assert.match(text.replace(/\s+/g, " "), /Paused: could not verify account; completion not saved/);
			assert.equal(text.match(/Paused:/g)?.length, 1);
			assert.match(text, /A acknowledge completion/);
		}
		assert.equal(auth, 1); assert.equal(f.bytes(), before);
		assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
		if (changed === "marker") await withResetAccountLock(f.dir, f.key, async (save) => save({ ...f.original, legacyBlocked: { requestId: "new-marker", creditId: "new-marker-credit" } }));
		if (changed === "busy") { rmSync(resetPaths(f.dir, f.key).lock, { force: true }); mkdirSync(resetPaths(f.dir, f.key).lock, { mode: 0o700 }); }
		if (changed === "live" || changed === "conflict") {
			const symbol = Symbol.for("codex-enhanced.reset-request-store"); const prior = Reflect.get(globalThis, symbol);
			Reflect.set(globalThis, symbol, new Map([[f.key, { requestId: "other-request", creditId: "other-credit", phase: "pending",
				...(changed === "live" ? { promise: new Promise(() => {}) } : {}) }]]));
			t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
		}
		for (const width of [40, 60]) {
			const text = c.render(width).join("\n");
			assert.doesNotMatch(text, /could not verify|completion not saved/);
			assert.match(text, changed === "busy" ? /Old reset lock; see README/ : /Paused:/);
			if (changed === "live") assert.match(text, /still running/);
		}
		f.ctx.modelRegistry.getProviderAuth = resolve;
		c.handleInput("escape"); await f.menu;
	});
}

test("Fast/Compaction actual Enter/Space toggles once, compact status/footer, short save error, Quota/Resets byte-stable", async (t) => {
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const f = fixture(t); const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx);
	await until(() => f.component() && f.state.detailReads > 0); await drain();
	const c = f.component();
	const quota60 = c.render(60); const quota40 = c.render(40);
	c.handleInput("tab");
	const resets60 = c.render(60); const resets40 = c.render(40);
	c.handleInput("tab"); // Fast
	const text = (width: number) => c.render(width).join("\n");
	for (const width of [32, 40, 60, 80]) {
		const rendered = c.render(width);
		assert.ok(rendered.every((line: string) => visibleWidth(line) <= width));
		const frame = rendered.join("\n");
		assert.match(frame, /Fast mode  off/);
		assert.equal(frame.match(/Space toggle/g)?.length, 1, "toggle affordance lives only in the footer");
		assert.match(frame, /Tab next · Esc close/);
		assert.doesNotMatch(frame, /Enter\/Space|Enter or Space|Globally|persists|Current model/);
	}
	c.handleInput("enter"); await drain();
	assert.equal(readConfig(f.path).fast, true, "Enter toggles exactly once");
	assert.match(text(60), /Fast mode  on/);
	assert.equal(f.state.confirmCalls, 0, "no confirm prompts");
	f.ctx.model = { id: "synthetic-other-model", provider: "other", api: "other" };
	assert.match(text(40), /Requires a Codex model/);
	assert.equal(text(40).match(/Requires a Codex model/g)?.length, 1, "one meaningful status only");
	c.handleInput("space"); await drain();
	assert.equal(readConfig(f.path).fast, false, "Space toggles exactly once");
	assert.doesNotMatch(text(40), /Requires a Codex model|Could not save/);
	f.ctx.model = { ...canonical };
	c.handleInput("tab"); // Compaction
	c.handleInput("space"); await drain();
	assert.equal(readConfig(f.path).compaction.responsesCompactEnabled, true);
	assert.match(text(40), /Server compaction  on/);
	f.ctx.model = { id: "synthetic-other-model", provider: "other", api: "other" };
	assert.match(text(40), /Requires a Codex model/);
	f.ctx.model = { ...canonical };
	writeFileSync(`${f.path}.lock`, "synthetic occupied settings lock");
	c.handleInput("enter"); await drain();
	assert.equal(readConfig(f.path).compaction.responsesCompactEnabled, true, "failed save keeps the persisted value");
	const errorFrame = text(40);
	assert.equal(errorFrame.match(/Could not save setting/g)?.length, 1, "save error is short and singular");
	assert.match(errorFrame, /Server compaction  on/, "never displays the requested value as saved");
	assert.doesNotMatch(errorFrame, /ENOENT|EEXIST|Globally/);
	rmSync(`${f.path}.lock`);
	c.handleInput("enter"); await drain();
	assert.equal(readConfig(f.path).compaction.responsesCompactEnabled, false, "toggle retry saves");
	assert.doesNotMatch(text(40), /Could not save setting/);
	c.handleInput("shift+tab"); c.handleInput("shift+tab");
	assert.deepEqual(c.render(60), resets60);
	assert.deepEqual(c.render(40), resets40);
	c.handleInput("shift+tab");
	assert.deepEqual(c.render(60), quota60);
	assert.deepEqual(c.render(40), quota40);
	c.handleInput("escape");
	await menu;
});

test("manual raw U/u are no-ops before and after Ctrl+R arms", async (t) => {
	const f = fixture(t); const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); t.after(f.close); c.handleInput("\t");
	let auth = 0; const resolve = f.ctx.modelRegistry.getProviderAuth;
	f.ctx.modelRegistry.getProviderAuth = async () => { auth++; return resolve(); };
	for (const armed of [false, true]) {
		if (armed) { c.handleInput("\x12"); await drain(); }
		const frame = c.render(80);
		const counts = [auth, f.state.usageReads, f.state.detailReads, f.state.posts.length];
		const preference = readAutoResetPreference(f.path, f.key);
		const journal = readResetJournal(f.dir, f.key);
		for (const key of ["U", "u"]) {
			c.handleInput(key); await drain();
			assert.deepEqual(c.render(80), frame);
			assert.deepEqual([auth, f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
			assert.deepEqual(readAutoResetPreference(f.path, f.key), preference);
			assert.deepEqual(readResetJournal(f.dir, f.key), journal);
		}
	}
	f.close(); await menu;
});

for (const keys of [["\x12", "\x12"], ["\x12", "\r"]]) {
	test(`manual raw bytes ${JSON.stringify(keys)} confirm once without toggling auto`, async (t) => {
		const f = fixture(t); const l = lifecycle(t, f.ctx);
		f.ctx.model = { id: "other", provider: "other" }; // Manual is independent of selected model.
		await l.handlers.get("session_start")({}, f.ctx); await drain();
		const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
		const c = f.component(); c.handleInput("\t");
		const { visibleWidth } = await import("@earendil-works/pi-tui");
		const check = (patterns: RegExp[]) => {
			for (const width of [32, 39, 40, 41, 59, 60, 61, 79, 80, 81]) {
				const lines = c.render(width);
				assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
				for (const pattern of patterns) assert.match(lines.join("\n"), pattern);
			}
		};
		check([/Ctrl\+R use 1 reset/]);
		c.handleInput(keys[0]); await drain();
		check([/Use 1 banked reset\?/, /Ctrl\+R use reset · Esc cancel/]);
		c.handleInput("U"); c.handleInput("u"); await drain();
		assert.equal(f.state.posts.length, 0, "U/u never confirms");
		c.handleInput(keys[1]); await until(() => f.state.posts.length === 1); await drain();
		assert.equal(readAutoResetPreference(f.path, f.key).enabled, false, "armed Enter never toggles auto");
		assert.equal(f.state.posts.length, 1);
		assert.match(c.render(80).join("\n"), /Manual reset · R refresh first/);
		c.handleInput("\x1b"); await menu;
	});
}

for (const cancellation of ["\x1b", "\t", "r", " "]) {
	test(`Ctrl+R arm raw cancellation ${JSON.stringify(cancellation)} leaves no hidden confirmation`, async (t) => {
		const f = fixture(t); const l = lifecycle(t, f.ctx); f.state.percent = 50;
		await l.handlers.get("session_start")({}, f.ctx); await drain();
		const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
		const c = f.component(); c.handleInput("\t"); c.handleInput("\x12"); await drain();
		c.handleInput(cancellation); await drain();
		if (cancellation === "\t") c.handleInput("\x1b[Z");
		assert.doesNotMatch(c.render(80).join("\n"), /Use 1 banked reset\?/);
		assert.equal(f.state.posts.length, 0);
		c.handleInput("\x12"); await drain(); assert.equal(f.state.posts.length, 0);
		c.handleInput("\x1b"); c.handleInput("\x1b"); await menu;
	});
}

test("Ctrl+R retry remains deliberate with zero current credits and preserves IDs", async (t) => {
	const f = fixture(t); const l = lifecycle(t, f.ctx); f.state.count = 0;
	await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key, phase: "pending", recovered: false, requestId: "uncertain-id", creditId: "uncertain-credit" }));
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); c.handleInput("\t");
	assert.match(c.render(80).join("\n"), /Ctrl\+R retry previous reset/);
	c.handleInput("\x12"); await drain();
	for (const width of [32, 40, 60, 80]) {
		const text = c.render(width).join("\n");
		assert.match(text, /Retry previous reset\?/); assert.match(text, /Same credit and request ID/); assert.match(text, /Ctrl\+R retry · Esc cancel/);
	}
	c.handleInput("\r"); await until(() => f.state.posts.length === 1); await drain();
	assert.equal(f.state.posts[0].credit_id, "uncertain-credit"); assert.equal(f.state.posts[0].redeem_request_id, "uncertain-id");
	assert.equal(readAutoResetPreference(f.path, f.key).enabled, false);
	c.handleInput("\x1b"); await menu;
});

test("open Resets detects synthetic owner SIGKILL with unchanged stats, no auth/network; probes coalesce and stop", async (t) => {
	const childProcess = (await import("node:child_process")).default;
	const { once } = await import("node:events"); const { statSync } = await import("node:fs");
	const { syncBuiltinESMExports } = await import("node:module");
	const f = fixture(t); const l = lifecycle(t, f.ctx); f.state.renderOnRequest = true;
	const child = childProcess.fork(new URL("./fixtures/reset-process.ts", import.meta.url), [f.dir, "acquired", f.key], {
		execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, HOME: f.dir, PI_CODING_AGENT_DIR: f.dir },
	});
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	assert.equal((await once(child, "message"))[0], "acquired");
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	let probes = 0, concurrent = 0, maximum = 0;
	const spawn = childProcess.spawn;
	t.mock.method(childProcess, "spawn", ((...args: any[]) => {
		probes++; concurrent++; maximum = Math.max(maximum, concurrent);
		const p = (spawn as any)(...args); p.once("close", () => { concurrent--; }); return p;
	}) as any); syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); c.handleInput("\t");
	await waitForFrame(() => /Reset in progress in another session/.test(f.state.frame));
	assert.match(f.state.frame, /Manual reset unavailable/);
	let auth = 0; const resolve = f.ctx.modelRegistry.getProviderAuth;
	f.ctx.modelRegistry.getProviderAuth = async () => { auth++; return resolve(); };
	const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
	const paths = resetPaths(f.dir, f.key); const before = statSync(paths.lock);
	const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
	await waitForFrame(() => /Ctrl\+R use 1 reset/.test(f.state.frame));
	const after = statSync(paths.lock);
	assert.deepEqual([after.ino, after.mtimeMs, after.ctimeMs], [before.ino, before.mtimeMs, before.ctimeMs]);
	assert.equal(auth, 0); assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
	const renderedProbes = probes;
	for (let i = 0; i < 100; i++) c.render(80);
	assert.equal(probes, renderedProbes, "renders never launch helpers"); assert.equal(maximum, 1);
	c.handleInput("\x1b"); await menu; await drain();
	const stoppedProbes = probes;
	await new Promise((resolve) => setTimeout(resolve, 1_200));
	assert.equal(probes, stoppedProbes, "no probe after menu close");
});

test("confirmation bound before later auth cannot consume a newer other-session uncertain intent", async (t) => {
	const f = fixture(t); const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); c.handleInput("\t"); c.handleInput("\x12"); await drain();
	const auth = f.ctx.modelRegistry.getProviderAuth; let calls = 0; let release!: () => void;
	f.ctx.modelRegistry.getProviderAuth = async () => {
		// startReset checks displayed identity after its first auth. Pause the following coordinator auth.
		if (++calls === 2) await new Promise<void>((r) => { release = r; });
		return auth();
	};
	c.handleInput("\r"); await until(() => calls === 2);
	await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key, phase: "unknown", recovered: false, requestId: "other-session-request", creditId: "other-session-credit" }));
	release(); await drain();
	assert.equal(f.state.posts.length, 0); assert.equal(readResetJournal(f.dir, f.key)?.requestId, "other-session-request");
	c.handleInput("\x1b"); await menu;
});

for (const interveningRender of [false, true]) test(`stale armed raw Enter cancels instead of enabling automatic spending (render=${interveningRender})`, async (t) => {
	const f = fixture(t); const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); c.handleInput("\t"); c.handleInput("\x12"); await drain();
	await withResetAccountLock(f.dir, f.key, async (save) => save({ version: 1, accountKey: f.key, phase: "pending", recovered: false, requestId: "competing-request", creditId: "competing-credit" }));
	// Watcher-driven rendering must not erase the meaning of the next confirmation Enter.
	if (interveningRender) assert.doesNotMatch(c.render(80).join("\n"), /Use 1 banked reset\?/);
	c.handleInput("\r"); c.handleInput("\r"); await drain();
	assert.equal(f.state.posts.length, 0); assert.equal(readAutoResetPreference(f.path, f.key).enabled, false);
	assert.doesNotMatch(c.render(80).join("\n"), /Retry previous reset\?|Use 1 banked reset\?/);
	c.handleInput("\x1b"); await menu;
});

for (const race of ["account", "token"] as const) test(`Resets acknowledgement revalidates ${race} after native acquisition wait`, { timeout: 10_000 }, async (t) => {
	const childProcess = (await import("node:child_process")).default;
	const { syncBuiltinESMExports } = await import("node:module");
	const f = await recoveryMenu(t); const c = f.component(); const before = f.bytes();
	t.after(f.close);
	c.handleInput("a"); await until(() => /Choose the confirmed/.test(c.render(80).join("\n")));
	c.handleInput("1");
	const counts = [f.state.usageReads, f.state.detailReads, f.state.posts.length];
	const preference = readAutoResetPreference(f.path, f.key);
	const spawn = childProcess.spawn;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => { entered = resolve; });
	let helper: ReturnType<typeof childProcess.spawn> | undefined;
	t.mock.method(childProcess, "spawn", ((file: string, args: string[], options: any) => {
		if (helper) return spawn(file, args, options);
		helper = spawn(file, [...args.slice(0, 3), `${args[3]}\nsys.stdout.flush(); sys.stdin.read(1)\n`], {
			...options, stdio: ["pipe", ...options.stdio.slice(1)],
		});
		helper.stdout!.once("data", (data) => { assert.equal(data.toString(), "locked\n"); entered(); });
		return helper;
	}) as any);
	syncBuiltinESMExports();
	t.after(() => { helper?.stdin?.end(); t.mock.restoreAll(); syncBuiltinESMExports(); });
	c.handleInput("\r"); await held;
	assert.equal(f.bytes(), before, "helper has flock but acknowledgement has not entered its callback");
	if (race === "account") f.state.account = "synthetic-changed-under-lock";
	else f.ctx.modelRegistry.getProviderAuth = async () => ({ auth: {
		apiKey: token(f.state.account).replace("signature", "changed-under-lock"), baseUrl: canonical.baseUrl,
	} });
	helper!.stdin!.end("release");
	await until(() => !/Checking account…/.test(c.render(80).join("\n")));
	assert.equal(f.bytes(), before, "changed identity cannot acknowledge the captured account's journal");
	assert.deepEqual([f.state.usageReads, f.state.detailReads, f.state.posts.length], counts);
	assert.deepEqual(readAutoResetPreference(f.path, f.key), preference);
	f.close(); await f.menu;
});

test("manual repeated raw Enter stays confirmation-only during a barrier-held POST and after completion", { timeout: 10_000 }, async (t) => {
	const f = fixture(t); const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx); await drain();
	const menu = l.commands.get("codex-enhanced").handler("", f.ctx); await drain();
	const c = f.component(); t.after(f.close);
	c.handleInput("\t"); c.handleInput("\x12");
	await until(() => /Use 1 banked reset\?/.test(c.render(80).join("\n")));
	let entered!: () => void, release!: () => void;
	const posted = new Promise<void>((resolve) => { entered = resolve; });
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	t.mock.method(globalThis, "fetch", async (url: any, init: any) => {
		const response = await f.fetch(url, init);
		if (init.method === "POST") { entered(); await barrier; }
		return response;
	});
	const preference = readAutoResetPreference(f.path, f.key);
	c.handleInput("\r"); await posted;
	assert.match(c.render(80).join("\n"), /Applying reset…/);
	c.handleInput("\r"); c.handleInput("\r"); await drain();
	assert.deepEqual(readAutoResetPreference(f.path, f.key), preference);
	assert.equal(f.state.posts.length, 1);
	release(); await until(() => /Manual reset · R refresh first/.test(c.render(80).join("\n")));
	c.handleInput("\r"); await drain();
	assert.deepEqual(readAutoResetPreference(f.path, f.key), preference, "completion render does not reinterpret repeated Enter");
	assert.equal(f.state.posts.length, 1);
	// Deliberate navigation restores the existing unarmed Enter compatibility.
	f.state.percent = 50;
	c.handleInput("\t"); c.handleInput("\x1b[Z"); c.handleInput("\r");
	await until(() => readAutoResetPreference(f.path, f.key).enabled);
	assert.equal(f.state.posts.length, 1);
	f.close(); await menu;
});
