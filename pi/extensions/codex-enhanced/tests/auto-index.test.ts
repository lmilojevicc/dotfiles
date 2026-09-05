import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codexEnhanced, { __testing } from "../index.ts";
import { getConfigPath, readAutoResetPreference, writeAutoResetPreference } from "../core.ts";
import { readResetJournal, resetPaths, withResetAccountLock } from "../resets.ts";

const canonical = { id: "synthetic-model", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
let nextAccount = 0;
function token(account: string) {
	return `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
}
async function until(condition: () => boolean) {
	for (let i = 0; i < 500; i++) {
		if (condition()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.fail("condition did not settle");
}
async function drain() { for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }

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
	const state = { account: identity, percent: 100, count: 2, usageReads: 0, detailReads: 0, posts: [] as any[], confirmCalls: 0, statuses: [] as Array<string | undefined> };
	let component: any;
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
				done = () => { component?.dispose?.(); resolve(); };
				component = factory({ requestRender: () => {} }, theme, {}, done);
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
				if (++authCalls === 5 && stage === "pre-post-auth") change();
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
	assert.match(component.render(240).join("\n"), /Automatic banked reset.*off/);
	component.handleInput("enter");
	await until(() => f.state.posts.length === 1);
	await drain();
	assert.equal(readAutoResetPreference(f.path, f.key).enabled, true);
	assert.equal(f.state.confirmCalls, 0);
	assert.match(component.render(240).join("\n"), /WITHOUT prompts/);
	component.handleInput("space");
	await until(() => !readAutoResetPreference(f.path, f.key).enabled);
	component.handleInput("r");
	await drain();
	component.handleInput("ctrl+r");
	await drain();
	assert.equal(f.state.posts.length, 1);
	assert.match(component.render(240).join("\n"), /Reset armed/);
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
	const f = fixture(t);
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
	assert.doesNotMatch(component.render(240).join("\n"), /Reset armed/);
	component.handleInput("ctrl+r");
	await drain();
	assert.match(component.render(240).join("\n"), /Reset armed/);
	f.state.account = "synthetic-switch-before-second";
	component.handleInput("ctrl+r");
	await drain();
	assert.equal(f.state.posts.length, 0);
	assert.doesNotMatch(component.render(240).join("\n"), /Reset armed/);
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

test("legacy in-process intents are blocked and durably preserved at startup even while auto is off", async (t) => {
	const f = fixture(t);
	const symbol = Symbol.for("codex-enhanced.reset-request-store");
	const prior = Reflect.get(globalThis, symbol);
	Reflect.set(globalThis, symbol, new Map([[f.key, { phase: "ambiguous", requestId: "legacy-request", creditId: "legacy-credit", message: "must not persist raw error" }]]));
	t.after(() => { if (prior === undefined) Reflect.deleteProperty(globalThis, symbol); else Reflect.set(globalThis, symbol, prior); });
	const l = lifecycle(t, f.ctx);
	await l.handlers.get("session_start")({}, f.ctx);
	const saved = readResetJournal(f.dir, f.key)!;
	assert.equal(saved.phase, "legacy_blocked");
	assert.deepEqual(saved.legacyBlocked, { requestId: "legacy-request", creditId: "legacy-credit" });
	assert.doesNotMatch(JSON.stringify(saved), /raw error/);
	Reflect.deleteProperty(globalThis, symbol); // restart no longer has the old in-memory map
	writeAutoResetPreference(f.path, f.key, true);
	const automatic = await __testing.runCoordinatedReset(f.ctx, "auto", new AbortController().signal, () => true);
	assert.match(automatic.status, /legacy/);
	const manual = await __testing.runCoordinatedReset(f.ctx, "manual", new AbortController().signal, () => true);
	assert.match(manual.status, /legacy/);
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
		assert.match(component.render(240).join("\n"), tab === "quota" ? /75%/ : /Available: 1/);
		component.handleInput(tab === "quota" ? "tab" : "shift+tab");
		assert.match(component.render(240).join("\n"), tab === "quota" ? /Available: 1/ : /75%/);
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
	assert.match(component.render(240).join("\n"), /Available: 1/);
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
		assert.doesNotMatch(component.render(240).join("\n"), /Available: 1/);
		if (mutation === "account") {
			assert.match(component.render(240).join("\n"), /Available: 7/);
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
			if (failure === "held") held = withResetAccountLock(f.dir, f.key, async () => new Promise<void>((resolve) => { release = resolve; }));
			else if (failure === "orphan") mkdirSync(paths.lock, { mode: 0o700 });
			else writeFileSync(paths.journal, "not-json");
			const saved = readFileSync(paths.journal, "utf8");
			f.state.percent = 35;
			f.state.count = 0; // No detail-cache involvement in this read-only refresh.
			const before = f.state.usageReads;
			component.handleInput("r");
			await drain();
			assert.ok(f.state.usageReads > before, "quota GET remains available");
			assert.match(component.render(240).join("\n"), tab === "quota" ? /65%/ : /Available: 0/);
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
			assert.match(component.render(240).join("\n"), /Press R for an explicit fresh refresh/);
			assert.equal(readFileSync(paths.journal, "utf8"), terminal);
			component.handleInput("escape");
			await menu;
		});
	}
}
