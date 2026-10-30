import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AdapterContext, ProviderAdapter, ProviderSnapshot } from "../core.ts";
import { __testing } from "../index.ts";
import { PROVIDER_ADAPTERS } from "../providers/index.ts";
import { codexSnapshot, parseCodexUsagePayload } from "../providers/openai-codex.ts";
import { parseOpencodeGoPayload } from "../providers/opencode-go.ts";
import { formatFrame, formatProviderLines, formatTabBar, formatUsageTable, type TabState } from "../render.ts";
import { adapterContext, fakeFetch, jsonResponse, plain, settle, theme, widths } from "./helpers.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const nowSeconds = now / 1000;

const tabSets = [
	["Codex"],
	["Codex", "OpenCode Go", "CLIProxyAPI"],
	["Codex", "OpenCode Go", "CLIProxyAPI", "Kimi For Coding", "GitHub Copilot", "OpenRouter", "DeepSeek", "Z.AI"],
];

for (const titles of tabSets) for (const width of widths) {
	test(`tab bar for ${titles.length} tabs fits ${width} columns and never drops the active tab`, () => {
		for (let active = 0; active < titles.length; active += 1) {
			const line = formatTabBar(theme, titles, active, width);
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
			const text = plain([line])[0]!;
			assert.ok(text.includes(titles[active]!), `active "${titles[active]}" visible in "${text}"`);
			const shown = titles.filter((title) => text.includes(title));
			assert.deepEqual(shown, titles.filter((title) => shown.includes(title)), "tab order preserved");
		}
	});
}

test("tab bar uses the full separator when it fits, then tighter forms with overflow markers", () => {
	const titles = tabSets[1]!;
	assert.equal(plain([formatTabBar(theme, titles, 1, 80)])[0], "  Codex  /  OpenCode Go  /  CLIProxyAPI");
	assert.equal(plain([formatTabBar(theme, titles, 1, 38)])[0], "  Codex / OpenCode Go / CLIProxyAPI");
	const narrow = plain([formatTabBar(theme, titles, 1, 32)])[0]!;
	assert.match(narrow, /OpenCode Go/);
	assert.match(narrow, /‹|›/);
	assert.equal(plain([formatTabBar(theme, ["An extremely long provider title"], 0, 20)])[0], "  An extremely long…");
});

const usedVector = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 25, limit_window_seconds: 18_000, resets_at: nowSeconds + 3600 },
		secondary_window: { used_percent: 99.6, window_minutes: 10_080, reset_at: nowSeconds + 86_400 },
	},
	additional_rate_limits: [{ metered_feature: "review", limit_name: "Code review", rate_limit: { primary: { used_percent: 10, window_minutes: 60 } } }],
};
const snapshots: Record<string, ProviderSnapshot> = {
	codex: codexSnapshot(parseCodexUsagePayload(usedVector), nowSeconds),
	opencode: parseOpencodeGoPayload({ usage: { rolling: { status: "ok", percent: 8 }, weekly: { status: "ok", percent: 22 }, monthly: { status: "maintenance" } } }, nowSeconds),
	cliproxy: {
		providerId: "cliproxyapi", title: "CLIProxyAPI", subtitle: "127.0.0.1:8317", observedAt: nowSeconds,
		rows: [
			{ group: "Traffic", label: "antigravity", windows: [], state: "15 ok · 2 failed · latest 13:59 1/1" },
			{ group: "antigravity", label: "someone.with.a.long.address@example.test", windows: [], state: "cooling down until 15:30 · quota exhausted for gemini-3-pro · priority 1" },
			{ group: "antigravity", label: "日本語のアカウント", windows: [{ label: "gemini 5h", usedPercent: 75, resetsAt: nowSeconds + 7200, note: "Gemini Pro" }] },
		],
		notes: ["Normalized quota needs a CLIProxyAPI quota plugin.", "Management key from ~/.cli-proxy-api/.management-password."],
	},
};
const states: Array<[string, TabState | undefined]> = [
	["loading", undefined],
	["error", { error: { message: "Codex request failed (503 Service Unavailable)" }, loading: false }],
	["auth-refresh", { error: { message: "Auth needs refresh · run /login openai-codex", state: "auth-refresh" }, loading: false }],
	["blocked-retrying", { error: { message: "Proxy banned this host's IP · retry in 29m59s", state: "blocked" }, loading: true }],
	...Object.entries(snapshots).flatMap(([name, snapshot]): Array<[string, TabState]> => [
		[name, { snapshot, loading: false }],
		[`${name}-refreshing`, { snapshot, loading: true }],
	]),
];

for (const width of widths) {
	test(`every frame line fits ${width} columns across loading/error/stale/data states`, () => {
		for (const [name, state] of states) {
			const lines = formatFrame(theme, {
				titles: tabSets[1]!, active: 1,
				body: formatProviderLines(theme, "OpenCode Go", state, width, now),
			}, width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${name}: ${visibleWidth(line)} > ${width}`);
			const text = plain(lines).join("\n");
			assert.doesNotMatch(text, /SECRET|Bearer|X-Management-Key/);
			assert.doesNotMatch(text, /\bleft\b/i, "percentages are used, never left");
			assert.match(plain(lines)[1]!, /OpenCode Go/, "active tab visible");
		}
	});
}

test("loading, error, auth-refresh and stale states follow codex-enhanced conventions", () => {
	const at = (state: TabState | undefined) => plain(formatProviderLines(theme, "Codex", state, 80, now));
	assert.deepEqual(at(undefined), ["  Loading Codex usage…"]);
	assert.deepEqual(at({ error: { message: "Codex request failed (503)" }, loading: false }), ["  Codex request failed (503)", "  Press R to retry."]);
	assert.deepEqual(at({ error: { message: "Auth needs refresh · run /login openai-codex", state: "auth-refresh" }, loading: false }),
		["  Auth needs refresh · run /login openai-codex", "  Press R to retry."]);
	const stale = at({ snapshot: snapshots.codex!, loading: true });
	assert.equal(stale[0], "  Codex · plus  refreshing…");
	assert.match(stale.join("\n"), /codex\s+5h\s+███░░░░░░░\s+25%\s+~1h/);
	assert.match(stale.join("\n"), /weekly\s+██████████\s+100%\s+~1d 0h/, "99.6% used rounds to 100% for display");
	assert.match(stale.join("\n"), /Code review\s+1h\s+█░░░░░░░░░\s+10%\s+reset \?/);
});

test("table columns use terminal cells, so wide characters stay aligned", () => {
	const lines = plain(formatUsageTable(theme, [
		{ label: "日本語", windows: [{ label: "5h", usedPercent: 1 }] },
		{ label: "abcdefgh", windows: [{ label: "5h", usedPercent: 2 }] },
	], 80, now));
	const offsets = lines.filter((line) => line.includes("5h")).map((line) => visibleWidth(line.slice(0, line.indexOf("5h"))));
	assert.equal(offsets.length, 2);
	assert.equal(offsets[0], offsets[1]);
});

test("the first table column has a header that lines up with the data columns", () => {
	const rows: UsageRow[] = [
		{ group: "antigravity", label: "account-a@example.test", state: "ok", windows: [{ label: "5h", usedPercent: 25, resetsAt: nowSeconds + 3600 }] },
		{ group: "antigravity", label: "account-b@example.test", state: "ok", windows: [{ label: "weekly", usedPercent: 50 }] },
	];
	const lines = plain(formatUsageTable(theme, rows, 80, now));
	const header = lines[0]!;
	const data = lines[3]!;
	assert.match(header, /^ {2}Item\s+Window\s+Used/, "the leading column is headed, not blank");
	assert.equal(header.indexOf("Window"), data.indexOf("5h"), "header cells line up with the data cells");
	assert.equal(header.indexOf("Used"), data.indexOf("█"), "the Used header sits on the bar column, as before");
	assert.equal(header.indexOf("Reset"), data.indexOf("~1h"), "every header cell lines up with its column");
});

test("narrow tables drop the bar column before clipping and keep the Used header", () => {
	const wide = plain(formatProviderLines(theme, "Codex", { snapshot: snapshots.codex!, loading: false }, 80, now)).join("\n");
	const narrow = plain(formatProviderLines(theme, "Codex", { snapshot: snapshots.codex!, loading: false }, 39, now)).join("\n");
	assert.match(wide, /█/);
	assert.doesNotMatch(narrow, /█|░/);
	assert.match(narrow, /Used/);
	assert.match(narrow, /25%/);
});

function fakeUi(rows?: number) {
	const ui = {
		component: undefined as any,
		renders: 0,
		notifications: [] as Array<[string, string]>,
		custom: (factory: any) => new Promise<void>((resolve) => {
			// Without `rows` the component sees no terminal size and falls back to frameHeight()'s default.
			const tui = { requestRender: () => { ui.renders += 1; }, ...(rows === undefined ? {} : { terminal: { rows, columns: 80 } }) };
			ui.component = factory(tui, theme, {}, () => resolve());
		}),
		notify: (message: string, level: string) => { ui.notifications.push([message, level]); },
		setStatus: () => {},
	};
	return ui;
}

function snapshotFor(id: string, used: number): ProviderSnapshot {
	return { providerId: id, title: id, rows: [{ label: id, windows: [{ label: "weekly", usedPercent: used }] }], observedAt: nowSeconds };
}

test("/usage builds tabs from credential presence, keeps not-ready logins as auth-refresh tabs, cycles and refreshes", async (t) => {
	__testing.clearSnapshotCache();
	const zen = { usage: { rolling: { status: "ok", percent: 8 }, weekly: { status: "ok", percent: 22 }, monthly: { status: "ok", percent: 57 } } };
	const { fetch, requests } = fakeFetch((request) => request.url === "https://opencode.ai/zen/go/v1/usage" ? jsonResponse(zen) : jsonResponse({}, 404));
	const context: AdapterContext = adapterContext({
		fetch,
		// Stored but unrefreshed Codex login: present, yet Pi cannot resolve it.
		hasProviderCredentials: (id) => id === "openai-codex" || id === "opencode-go",
		getProviderAuth: async (id) => id === "opencode-go" ? { apiKey: "sk-SECRET-zen" } : undefined,
	});
	const ui = fakeUi();
	const ctx = { mode: "tui", hasUI: true, model: { provider: "opencode-go" }, ui };
	const controller = new AbortController();
	const opened = __testing.openUsage(ctx as never, controller.signal, { adapters: PROVIDER_ADAPTERS, adapterContext: () => context });
	await settle();
	const frame = (width = 80) => plain(ui.component.render(width) as string[]);
	assert.equal(frame()[1], "  Codex  /  OpenCode Go", "cliproxyapi without a configured proxy has no tab");
	assert.match(frame().join("\n"), /Monthly\s+██████░░░░\s+57%/, "session model's provider opens first");
	ui.component.handleInput("\t");
	await settle();
	assert.match(frame().join("\n"), /Auth needs refresh · run \/login openai-codex/);
	assert.match(frame().join("\n"), /Press R to retry\./);
	ui.component.handleInput("\x1b[Z");
	await settle();
	assert.match(frame().join("\n"), /57%/);
	const before = requests.length;
	ui.component.handleInput("r");
	assert.match(frame()[3]!, /refreshing…/, "stale rows stay visible while refreshing");
	await settle();
	assert.equal(requests.length, before + 1, "R forces a refetch of the active tab");
	for (const width of widths) for (const line of ui.component.render(width) as string[]) assert.ok(visibleWidth(line) <= width);
	assert.doesNotMatch(frame().join("\n"), /SECRET/);
	ui.component.handleInput("\x1b");
	await opened;
});

test("/usage renders an explicit empty state, and dynamic adapters drive the tab list", async () => {
	__testing.clearSnapshotCache();
	const ui = fakeUi();
	const opened = __testing.openUsage({ mode: "tui", hasUI: true, ui } as never, new AbortController().signal, { adapters: PROVIDER_ADAPTERS, adapterContext: () => adapterContext() });
	assert.match(plain(ui.component.render(60)).join("\n"), /Checking providers…/);
	await settle();
	assert.match(plain(ui.component.render(60)).join("\n"), /No usage providers have credentials\./);
	ui.component.handleInput("\x03");
	await opened;

	let fetches = 0;
	const adapters: ProviderAdapter[] = ["alpha", "beta", "gamma"].map((id, index) => ({
		id, title: id,
		hasCredentials: async () => id !== "beta",
		fetch: async () => { fetches += 1; return snapshotFor(id, 10 * (index + 1)); },
	}));
	const second = fakeUi();
	const view = __testing.openUsage({ mode: "tui", hasUI: true, ui: second } as never, new AbortController().signal, { adapters, adapterContext: () => adapterContext() });
	await settle();
	assert.equal(plain(second.component.render(80))[1], "  alpha  /  gamma");
	second.component.handleInput("\t");
	await settle();
	assert.match(plain(second.component.render(80)).join("\n"), /gamma\s+weekly\s+███░░░░░░░\s+30%/);
	second.component.handleInput("\t");
	await settle();
	assert.equal(fetches, 2, "revisiting a loaded tab does not refetch");
	second.component.handleInput("\x1b");
	await view;
});

test("/usage opens the aliased provider's tab for a bridge session, like the footer does", async () => {
	__testing.clearSnapshotCache();
	const first: ProviderAdapter = { id: "codex", title: "Codex", hasCredentials: async () => true, fetch: async () => snapshotFor("codex", 10) };
	const aliased: ProviderAdapter = {
		id: "claude",
		title: "Claude",
		aliases: ["claude-bridge", "anthropic"],
		hasCredentials: async () => true,
		fetch: async () => snapshotFor("claude", 20),
	};
	const ui = fakeUi();
	const view = __testing.openUsage(
		{ mode: "tui", hasUI: true, model: { provider: "claude-bridge" }, ui } as never,
		new AbortController().signal,
		{ adapters: [first, aliased], adapterContext: () => adapterContext() },
	);
	await settle();
	const frame = plain(ui.component.render(80));
	assert.equal(frame[1], "  Codex  /  Claude", "both providers still have a tab");
	assert.equal(frame[3], "  claude", "the session provider's tab is active through its alias, not tab 0");
	ui.component.handleInput("\x1b");
	await view;
});

test("/usage is interactive-only", async () => {
	const ui = fakeUi();
	await __testing.openUsage({ mode: "rpc", hasUI: true, ui } as never, new AbortController().signal);
	assert.deepEqual(ui.notifications, [["/usage requires interactive terminal mode", "warning"]]);
	assert.equal(ui.component, undefined);
	await assert.rejects(__testing.openUsage({ mode: "print", hasUI: false, ui } as never, new AbortController().signal), {
		message: "/usage requires interactive terminal mode",
	});
});

test("/usage scrolls with j/k, pages with J/K and jumps with g/G", async () => {
	__testing.clearSnapshotCache();
	const rows: UsageRow[] = Array.from({ length: 40 }, (_, index) => ({
		group: index < 20 ? "group-a" : "group-b",
		label: `account-${index}`,
		windows: [{ label: "weekly", usedPercent: index }],
	}));
	const adapter: ProviderAdapter = {
		id: "fixture",
		title: "Fixture",
		hasCredentials: async () => true,
		fetch: async () => ({ providerId: "fixture", title: "Fixture", rows, observedAt: nowSeconds }),
	};
	// A short pane: 20 terminal rows minus the statusline reserve, so the band must window.
	const ui = fakeUi(20);
	const ctx = { mode: "tui", hasUI: true, model: { provider: "fixture" }, ui };
	const controller = new AbortController();
	void __testing.openUsage(ctx as never, controller.signal, { adapters: [adapter], adapterContext: () => adapterContext() });
	await settle();
	const frame = () => plain(ui.component.render(80) as string[]).join("\n");
	const range = () => {
		const match = /rows (\d+)-(\d+) of (\d+)/.exec(frame());
		return match ? { first: Number(match[1]), last: Number(match[2]), total: Number(match[3]) } : undefined;
	};
	const band = () => {
		const current = range()!;
		return current.last - current.first + 1;
	};

	const initial = range();
	assert.ok(initial, "an overflowing band reports its range");
	// 40 data rows plus the two section headings that scroll with them.
	assert.equal(initial!.total, 42);
	const initialBand = band();
	assert.ok(initialBand >= 2, `band should be usable, got ${initialBand}`);
	assert.ok(plain(ui.component.render(80) as string[]).length <= 18, "the frame honours the pane height");

	ui.component.handleInput("j");
	assert.equal(range()!.first, initial!.first + 1);
	assert.equal(band(), initialBand, "stepping keeps the band size");

	ui.component.handleInput("k");
	assert.equal(range()!.first, initial!.first);

	ui.component.handleInput("J");
	assert.equal(range()!.first, initial!.first + initialBand, "J pages down one band");
	assert.equal(band(), initialBand, "paging keeps the band size");

	ui.component.handleInput("K");
	assert.equal(range()!.first, initial!.first, "K pages back up");

	ui.component.handleInput("K");
	assert.equal(range()!.first, 1, "K at the top clamps instead of underflowing");

	ui.component.handleInput("G");
	assert.equal(range()!.last, 42, "G reaches the last row");
	assert.equal(range()!.last, range()!.total, "the final row is reachable, not hidden behind a clamp");

	ui.component.handleInput("g");
	assert.equal(range()!.first, 1, "g returns to the first row");

	assert.match(frame(), /↑↓\/jk scroll/, "hints name the keys that actually arrive");
	assert.match(frame(), /J\/K page/, "hints document paging without PgUp/PgDn");
	assert.doesNotMatch(frame(), /PgUp\/PgDn/, "unreachable keys in a multiplexer are not advertised");
});

test("/usage key bindings match through Pi's key matcher, so escaped letters keep working", async () => {
	__testing.clearSnapshotCache();
	const rows: UsageRow[] = Array.from({ length: 40 }, (_, index) => ({
		label: `account-${index}`,
		windows: [{ label: "weekly", usedPercent: index }],
	}));
	let fetches = 0;
	const adapter: ProviderAdapter = {
		id: "fixture-keys",
		title: "Fixture",
		hasCredentials: async () => true,
		fetch: async () => {
			fetches += 1;
			return { providerId: "fixture-keys", title: "Fixture", rows, observedAt: nowSeconds };
		},
	};
	const ui = fakeUi(20);
	const ctx = { mode: "tui", hasUI: true, model: { provider: "fixture-keys" }, ui };
	void __testing.openUsage(ctx as never, new AbortController().signal, { adapters: [adapter], adapterContext: () => adapterContext() });
	await settle();
	const frame = () => plain(ui.component.render(80) as string[]).join("\n");
	const range = () => {
		const match = /rows (\d+)-(\d+) of (\d+)/.exec(frame());
		return match ? { first: Number(match[1]), last: Number(match[2]), total: Number(match[3]) } : undefined;
	};

	// xterm modifyOtherKeys level 2 (Pi's fallback when the terminal has no Kitty support) sends
	// Shift+letter as CSI 27;2;<codepoint>~; the Kitty protocol sends CSI <codepoint>;<mod>u.
	const modifyOtherKeys = (letter: string) => `\x1b[27;2;${letter.toUpperCase().charCodeAt(0)}~`;
	const kittyShift = (letter: string) => `\x1b[${letter.charCodeAt(0)};2u`;

	const initial = range()!;
	const band = initial.last - initial.first + 1;
	ui.component.handleInput("j");
	assert.equal(range()!.first, initial.first + 1, "plain j still scrolls one row");
	ui.component.handleInput(modifyOtherKeys("k"));
	assert.equal(range()!.first, initial.first, "Shift+K pages up from an escaped key sequence");
	ui.component.handleInput("K");
	assert.equal(range()!.first, 1, "plain uppercase K still pages up and clamps at the top");
	ui.component.handleInput(modifyOtherKeys("j"));
	assert.equal(range()!.first, 1 + band, "Shift+J pages down from an escaped key sequence");
	ui.component.handleInput(kittyShift("j"));
	assert.equal(range()!.first, 1 + 2 * band, "Shift+J pages down from a Kitty CSI-u sequence too");
	ui.component.handleInput(modifyOtherKeys("g"));
	assert.equal(range()!.last, initial.total, "Shift+G jumps to the last row from an escaped key sequence");
	ui.component.handleInput(kittyShift("g"));
	assert.equal(range()!.last, initial.total, "Shift+G also matches as a Kitty CSI-u sequence");
	ui.component.handleInput("\x1b[103u");
	assert.equal(range()!.first, 1, "g still jumps to the first row, including as a CSI-u sequence");

	const before = fetches;
	ui.component.handleInput(modifyOtherKeys("r"));
	assert.match(frame(), /refreshing…/, "Shift+R refreshes from an escaped key sequence");
	await settle();
	assert.equal(fetches, before + 1);
	ui.component.handleInput("R");
	await settle();
	assert.equal(fetches, before + 2, "plain uppercase R still refreshes");
});

test("/usage paging through the handler always advances and terminates", async () => {
	__testing.clearSnapshotCache();
	const rows: UsageRow[] = Array.from({ length: 37 }, (_, index) => ({
		group: index < 18 ? "group-a" : "group-b",
		label: `account-${index}`,
		windows: [{ label: "weekly", usedPercent: index }],
	}));
	const adapter: ProviderAdapter = {
		id: "fixture-page",
		title: "Fixture",
		hasCredentials: async () => true,
		fetch: async () => ({ providerId: "fixture-page", title: "Fixture", rows, observedAt: nowSeconds }),
	};
	const ui = fakeUi(16);
	const ctx = { mode: "tui", hasUI: true, model: { provider: "fixture-page" }, ui };
	const controller = new AbortController();
	void __testing.openUsage(ctx as never, controller.signal, { adapters: [adapter], adapterContext: () => adapterContext() });
	await settle();
	const range = () => {
		const match = /rows (\d+)-(\d+) of (\d+)/.exec(plain(ui.component.render(80) as string[]).join("\n"));
		return match ? { first: Number(match[1]), last: Number(match[2]), total: Number(match[3]) } : undefined;
	};

	ui.component.handleInput("g");
	let previous = range()!.first;
	let steps = 0;
	while (range()!.last < range()!.total && steps < 40) {
		ui.component.handleInput("J");
		const current = range()!.first;
		assert.ok(current >= previous, `paging went backwards at step ${steps}`);
		assert.ok(current !== previous || range()!.last === range()!.total, `paging stalled at offset ${previous}`);
		previous = current;
		steps += 1;
	}
	const final = range()!;
	assert.equal(final.last, final.total, "paging reaches the final row");
	assert.ok(steps < 40, `paging terminated in ${steps} steps`);
	assert.ok(plain(ui.component.render(80) as string[]).length <= 14, "the frame fits the 16-row pane");
});
