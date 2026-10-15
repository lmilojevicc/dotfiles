import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { TestContext } from "node:test";
import type { AdapterContext } from "../core.ts";

export const theme: any = {
	fg: (color: string, text: string) => `\x1b[${color === "accent" ? "36" : color === "warning" ? "33" : color === "error" ? "31" : "37"}m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
export const widths = [32, 39, 40, 41, 59, 60, 61, 64, 65, 66, 79, 80, 81];

export function plain(lines: string[]): string[] {
	return lines.map(stripVTControlCharacters);
}

export function jsonResponse(body: unknown, status = 200, statusText = ""): Response {
	return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, statusText });
}

export type RecordedRequest = { url: string; method: string; headers: Headers; redirect?: RequestRedirect; body?: string };

/** Fake fetch that records every request; no real network I/O. */
export function fakeFetch(route: (request: RecordedRequest) => Response | Promise<Response>) {
	const requests: RecordedRequest[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const request: RecordedRequest = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			...(init?.redirect ? { redirect: init.redirect } : {}),
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		};
		requests.push(request);
		return await route(request);
	}) as typeof globalThis.fetch;
	return { fetch, requests };
}

export const noNetwork = (() => {
	throw new Error("unexpected network request");
}) as unknown as typeof globalThis.fetch;

export function tempDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

export function adapterContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
	return {
		getProviderAuth: async () => undefined,
		hasProviderCredentials: () => false,
		agentDir: "/nonexistent-pi-usage-agent",
		homeDir: "/nonexistent-pi-usage-home",
		env: {},
		fetch: noNetwork,
		...overrides,
	};
}

export function jwt(accountId: string): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
	return `header.${payload}.signature`;
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function settle(times = 10): Promise<void> {
	for (let index = 0; index < times; index += 1) await tick();
}
