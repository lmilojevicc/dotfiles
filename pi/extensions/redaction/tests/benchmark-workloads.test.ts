import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createNativeRedactor } from "../src/native.ts";
import type { NativeConfig } from "../src/contracts.ts";

type Task = { id: string; scope: string; text: string; texts?: string[]; shape?: string;
  config: NativeConfig; bytes: number; expectedMatches: number; secrets: string[]; comparisonClass?: string };
const { workloads, eventFor } = createRequire(import.meta.url)("../benchmarks/workloads.mjs") as {
  workloads(): Task[]; eventFor(task: Task, index?: number): { content: Array<{ text: string }>;
    details?: unknown; structuredContent?: unknown };
};
const tasks = workloads();

test("benchmark workloads: preserve every original payload and all twelve shared cases", () => {
  const latest = JSON.parse(readFileSync(new URL("../benchmarks/results/latest.json", import.meta.url), "utf8"));
  const baseline = latest.historicalBaseline ?? latest;
  assert.equal(baseline.workloads.length, 32);
  assert.equal(baseline.workloads.filter((row: { scope: string }) => row.scope === "pii").length, 12);
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
  for (const row of baseline.workloads) {
    const task = tasks.find(task => task.id === row.id)!;
    assert.ok(task, row.id);
    assert.equal(createHash("sha256").update(task.text).digest("hex"), row.sha256, row.id);
    assert.equal(task.bytes, row.bytes, row.id);
    if (task.scope === "pii") assert.deepEqual(task.config, baseline.configuration.localPii);
  }
});

test("benchmark workloads: exact no-match preservation and correct new-case match counts", () => {
  for (const task of tasks.slice(32)) {
    const redactor = createNativeRedactor(task.config);
    const results = (task.texts ?? [task.text]).map(text => redactor.redact(text));
    const multi = task.shape === "multi-text" || task.shape === "nested";
    if (multi) assert.equal(results.reduce((sum, result) => sum + result.matches.length, 0), task.expectedMatches, task.id);
    else for (const result of results) assert.equal(result.matches.length, task.expectedMatches, task.id);
    for (const [index, result] of results.entries()) {
      const input = (task.texts ?? [task.text])[index];
      if (result.matches.length === 0) assert.equal(result.text, input, task.id);
      for (const secret of task.secrets) assert.ok(!result.text.includes(secret), task.id);
      assert.equal(redactor.redactText!(result.text), result.text, task.id);
    }
  }
});

test("benchmark workloads: changing identities and structured shapes are explicit, not exclusions", () => {
  assert.equal(tasks.find(task => task.id === "pii-short-0")!.comparisonClass, "diagnostic-upstream-minLength-bypass");
  assert.equal(tasks.filter(task => task.comparisonClass === "diagnostic-upstream-minLength-bypass").length, 1);
  const changing = tasks.find(task => task.id === "pii-changing-identities")!;
  assert.equal(new Set(changing.texts).size, 32);
  assert.notEqual(eventFor(changing, 0).content[0].text, eventFor(changing, 1).content[0].text);
  const multi = tasks.find(task => task.id === "pii-multi-text-tool-result")!;
  assert.equal(multi.scope, "pii");
  assert.equal(eventFor(multi).content.length, 4);
  assert.ok(eventFor(multi).details && eventFor(multi).structuredContent);
  const nested = tasks.find(task => task.id === "pii-nested-structured-local-only")!;
  assert.equal(nested.scope, "local-structured", "Upstream does not filter details/structuredContent");
  assert.ok(eventFor(nested).details && eventFor(nested).structuredContent);
});

test("benchmark workloads: unfavorable late-Unicode and late-marker controls remain comparable", () => {
  const lateUnicode = tasks.find(task => task.id === "pii-unicode-clean-after-long-ascii")!;
  assert.equal(lateUnicode.text, "ordinary clean log line\n".repeat(5700) + "🙂");
  assert.ok(lateUnicode.text.indexOf("🙂") > 63, "Unicode must be outside the native sample");
  const prefix = "🙂 名 café ordinary clean log line\n".repeat(3300);
  for (const [id, ending] of [["pii-unicode-email-only-at-end", "a@b.co"],
    ["pii-unicode-marker-only-at-end", "@"], ["pii-unicode-reserved-token-only-at-end", "[EMAIL_41]"]]) {
    const task = tasks.find(task => task.id === id)!;
    assert.equal(task.text, prefix + ending);
    assert.equal(task.scope, "pii");
    assert.equal(task.comparisonClass, "shared-pii");
    assert.deepEqual(task.config, lateUnicode.config);
  }
});
