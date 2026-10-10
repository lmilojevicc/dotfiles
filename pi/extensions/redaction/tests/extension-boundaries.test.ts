import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { offConfig } from "../src/config.ts";
import { installRedaction } from "../src/index.ts";
import { CENSORED } from "../src/sanitize.ts";

async function hooks(userOnly = false, invalid = false) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const sessionManager = { getBranch: () => [] };
  const config = offConfig();
  config.detectors.email = true;
  config.sources = { toolResults: false, systemPrompt: !userOnly, userMessages: userOnly };
  await installRedaction({ on(name: string, handler: (...args: any[]) => any) { handlers.set(name, (event, ctx = { sessionManager }) => handler(event, ctx)); }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI, {
    loadConfig: async () => invalid ? { state: "invalid", path: "/synthetic/private-config" } : { state: "active", path: "/synthetic/private-config", config },
    createRedactor: () => ({ redact(text) { return { text: text.replaceAll("synthetic@example.test", "PRIVATE_EMAIL"), matches: [] }; }, reset() {} }),
    loadTools: async () => { throw new Error("no tools in boundary test"); },
    createFileSession: () => { throw new Error("no files in boundary test"); },
  });
  return handlers;
}
test("forced system prompt is filtered before Pi's after-context projection; ordinary prompts are not frozen", async () => {
  const h = await hooks();
  assert.equal(h.get("before_agent_start")!({ systemPrompt: "synthetic@example.test", systemPromptOptions: {} }), undefined);
  assert.deepEqual(h.get("before_agent_start")!({ systemPrompt: "synthetic@example.test", systemPromptOptions: { forceSystemPrompt: "synthetic@example.test" } }), { systemPrompt: "PRIVATE_EMAIL" });
  const userOnly = await hooks(true);
  assert.equal(userOnly.get("before_agent_start")!({ systemPrompt: "synthetic@example.test", systemPromptOptions: { forceSystemPrompt: "synthetic@example.test" } }), undefined);
  const invalid = await hooks(false, true);
  assert.deepEqual(invalid.get("before_agent_start")!({ systemPrompt: "synthetic@example.test", systemPromptOptions: { forceSystemPrompt: "synthetic@example.test" } }), { systemPrompt: CENSORED });
});
test("compaction and branch summarization return supported cancellation contracts even when warning UI throws", async () => {
  for (const invalid of [false, true]) {
    const h = await hooks(false, invalid);
    assert.deepEqual(h.get("cache_warming_decision")!({ action: "warm" }), { action: "stop" });
    const notices: string[] = [];
    const ctx = { ui: { notify(text: string) { notices.push(text); } } };
    assert.deepEqual(h.get("session_before_compact")!({}, ctx), { cancel: true });
    assert.deepEqual(h.get("session_before_tree")!({ preparation: { userWantsSummary: true } }, ctx), { cancel: true });
    assert.equal(h.get("session_before_tree")!({ preparation: { userWantsSummary: false } }, ctx), undefined);
    assert.match(notices.join(" "), /compaction blocked/);
    const brokenUi = { ui: { notify() { throw new Error("UI unavailable"); } } };
    assert.deepEqual(h.get("session_before_compact")!({}, brokenUi), { cancel: true });
    assert.deepEqual(h.get("session_before_tree")!({ preparation: { userWantsSummary: true } }, brokenUi), { cancel: true });
  }
});
