import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { platform, arch, release, cpus, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createNativeRedactor } from "../src/native.ts";
import { installRedaction } from "../src/index.ts";
import { workloads, localPii, warmup, samples, batch } from "./workloads.mjs";

const [temp, output] = process.argv.slice(2);
assert.ok(temp && output, "Use benchmarks/run.sh, with an optional output path");
// Upstream extension must NEVER load configuration from the actual user home.
assert.equal(resolve(homedir()), resolve(temp, "home"));
const cold = {};
const upstream = name => import(pathToFileURL(join(temp, "upstream", "dist", name)).href);
const comparatorImportStart = performance.now();
const { DEFAULT_CONFIG } = await upstream("config.js");
const { redactText } = await upstream("layers/index.js");
const { default: installUpstream } = await upstream("index.js");
cold.comparatorModulesImportMs = performance.now() - comparatorImportStart;
const fair = { ...DEFAULT_CONFIG, minLength: 1, layers: Object.fromEntries(Object.keys(DEFAULT_CONFIG.layers).map(key => [key, key === "pii"])) };
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const dlopenStart = performance.now();
const native = createRequire(import.meta.url)("../native/redaction.node");
cold.nativeDlopenMs = performance.now() - dlopenStart;
const sourceHash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const tasks = workloads();
await writeFile(join(temp, "tasks.json"), JSON.stringify(tasks));
const coreStart = performance.now();
const core = JSON.parse(execFileSync(join(temp, "target", "release", "pi-redaction-corpus-benchmark"), [join(temp, "tasks.json")], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
cold.coreProcessWithAllScansMs = performance.now() - coreStart; // NOT a scan or setup timing.

function host() {
  const hooks = new Map();
  return { hooks, api: { on(name, fn) { hooks.set(name, fn); }, registerCommand() {}, registerTool() {} } };
}
async function localHook(config) {
  const start = performance.now();
  const h = host();
  await installRedaction(h.api, {
    loadConfig: async () => ({ state: "active", path: join(temp, "synthetic-policy.json"), config: { ...config, sources: { toolResults: true, userMessages: false, systemPrompt: false } } }),
    loadTools: async () => Object.fromEntries(["Read", "Edit", "Write"].map(name => [`create${name}ToolDefinition`, () => ({ name: name.toLowerCase() })])),
  });
  const ctx = { sessionManager: { getBranch: () => [] } };
  return { run: event => h.hooks.get("tool_result")(event, ctx), setupMs: performance.now() - start };
}
async function upstreamHook(config) {
  const dir = join(temp, "home", ".pi", "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pi-redact-all.json"), JSON.stringify(config));
  const start = performance.now();
  const h = host();
  installUpstream(h.api);
  return { run: h.hooks.get("tool_result"), setupMs: performance.now() - start };
}
function normalize(text) {
  return text.replace(/\[EMAIL_\d+\]|\[REDACTED:Email\]/g, "§EMAIL§").replace(/\[PHONE_\d+\]|\[REDACTED:Phone\]/g, "§PHONE§");
}
function check(text, task) {
  const remaining = task.secrets.filter(secret => text.includes(secret));
  return { passed: remaining.length === 0 && (task.secrets.length !== 0 || text === task.text), expectedIdentities: task.secrets.length, remainingIdentities: remaining.length };
}
let sink;
async function measure(run) {
  for (let i = 0; i < warmup; i++) sink = await run();
  const times = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    for (let j = 0; j < batch; j++) sink = await run();
    times.push((performance.now() - start) / batch);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return { samplesMs: times, p50Ms: sorted[Math.ceil(samples * 0.5) - 1], p95Ms: sorted[Math.ceil(samples * 0.95) - 1] };
}
const rows = [];
for (const task of tasks) {
  const constructorStart = performance.now();
  const raw = new native.NativeRedactor(JSON.stringify(task.config));
  const rawSetupMs = performance.now() - constructorStart;
  const bridge = createNativeRedactor(task.config);
  const hook = await localHook(task.config);
  const event = { toolName: "synthetic_tool", toolCallId: "synthetic-id", input: {}, content: [{ type: "text", text: task.text }], isError: false };
  const runs = [
    { implementation: "local-napi-json", run: () => raw.redact(task.text), text: value => JSON.parse(value).text, setupMs: rawSetupMs },
    { implementation: "local-ts-bridge", run: () => bridge.redact(task.text), text: value => value.text, setupMs: null },
    { implementation: "local-tool-result-hook", run: () => hook.run(event), text: value => value.content[0].text, setupMs: hook.setupMs },
  ];
  if (task.scope === "pii") {
    const ctx = { config: fair, partialPrivateKeyPaths: new Set() };
    const upstreamFairHook = await upstreamHook(fair);
    runs.push({ implementation: "upstream-pii-min1-layers", run: () => redactText(task.text, ctx), text: value => value.text, setupMs: null });
    runs.push({ implementation: "upstream-pii-min1-tool-result-hook", run: () => upstreamFairHook.run(event), text: value => value?.content?.[0]?.text ?? task.text, setupMs: upstreamFairHook.setupMs });
    const defaultCtx = { config: DEFAULT_CONFIG, partialPrivateKeyPaths: new Set() };
    const defaultHook = await upstreamHook(DEFAULT_CONFIG);
    runs.push({ implementation: "upstream-defaults-layers-NOT-EQUIVALENT", run: () => redactText(task.text, defaultCtx), text: value => value.text, setupMs: null });
    runs.push({ implementation: "upstream-defaults-tool-result-hook-NOT-EQUIVALENT", run: () => defaultHook.run(event), text: value => value?.content?.[0]?.text ?? task.text, setupMs: defaultHook.setupMs });
  }
  const expected = createNativeRedactor(task.config).redact(task.text);
  assert.equal(expected.matches.length, task.expectedMatches, task.id);
  assert.ok(check(expected.text, task).passed, task.id);
  for (const entry of runs) {
    const start = performance.now();
    const result = entry.text(await entry.run());
    const firstCallMs = performance.now() - start;
    const correctness = check(result, task);
    const nonEquivalent = entry.implementation.includes("NOT-EQUIVALENT");
    if (!nonEquivalent) {
      assert.ok(correctness.passed, `${entry.implementation}: ${task.id}`);
      assert.equal(normalize(result), normalize(expected.text), `${entry.implementation}: ${task.id}`);
    }
    const measurement = await measure(entry.run);
    rows.push({ id: task.id, implementation: entry.implementation, setupMs: entry.setupMs, firstCallMs,
      correctness, ...measurement, throughputMiBs: task.bytes / 1048576 / (measurement.p50Ms / 1000) });
  }
}
assert.ok(sink !== undefined);
const probes = [];
for (const text of ["a@example.com", "+14155550132", "US: 415-555-0132", "_: (415)555-0132", "Call 415-555-0132 ext.12", "info@example."]) {
  const local = createNativeRedactor(localPii).redact(text);
  probes.push({ syntheticInput: text, local: local.text, fair: redactText(text, { config: fair, partialPrivateKeyPaths: new Set() }).text,
    defaults: redactText(text, { config: DEFAULT_CONFIG, partialPrivateKeyPaths: new Set() }).text,
    piiWithDefaultMin32: redactText(text, { config: { ...fair, minLength: 32 }, partialPrivateKeyPaths: new Set() }).text });
}
const setupEvidence = JSON.parse(await readFile(join(temp, "setup.json"), "utf8"));
const result = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  environment: { platform: platform(), architecture: arch(), osRelease: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, node: process.version,
    rustc: setupEvidence.toolchain.rustc, cargo: setupEvidence.toolchain.cargo, npm: setupEvidence.toolchain.npm },
  revisions: { contractCommit: "ebc02e6", local: "integrated uncommitted source handoffs; content hashes authoritative", comparator: "a1a189f970f53c81f90c8de587c59c72cefec5ee", comparatorVersion: "0.2.5" },
  hashes: { nativeSource: await sourceHash(join(root, "native/src/lib.rs")), nativeCargoLock: await sourceHash(join(root, "native/Cargo.lock")), corpus: await sourceHash(join(root, "fixtures/corpus.json")),
    bridge: await sourceHash(join(root, "src/native.ts")), hook: await sourceHash(join(root, "src/index.ts")), sanitizer: await sourceHash(join(root, "src/sanitize.ts")),
    runner: await sourceHash(join(root, "benchmarks/run.mjs")), workloads: await sourceHash(join(root, "benchmarks/workloads.mjs")), core: await sourceHash(join(root, "benchmarks/core/src/main.rs")),
    comparatorArchive: await sourceHash(join(temp, "comparator.tar.gz")), comparatorConfig: await sourceHash(join(temp, "upstream/src/config.ts")), comparatorPii: await sourceHash(join(temp, "upstream/src/layers/layer-8-pii.ts")) },
  configuration: { localPii, upstreamFair: fair, upstreamDefaults: DEFAULT_CONFIG, sourceFlags: { toolResults: true, userMessages: false, systemPrompt: false }, warmup, samples, batch,
    quantiles: "nearest rank of 21 batch means, 3 scans per batch", coreBuild: "cargo release --locked; default features (no N-API)", nativeBuild: "cargo release --locked --features node" },
  limitations: ["Shared inputs contain only email/compact E.164 phone; upstream PII toggle also scans IP/cards/SSN/IBAN and has different phone semantics.", "Literal scaling has no upstream counterpart; no equivalent speedup claim.", "N-API JSON excludes parse/UTF-16 conversion; bridge and local hook include those. JS paths include awaited dispatch for each invocation.", "Tool-result hooks are actually registered callbacks, not a live Pi runtime/provider, file operation, or full request pipeline; upstream hook includes its stats re-scan.", "Per-row setup excludes module import/build/npm/source acquisition; those are separate one-off cold diagnostics. First-call measurements are diagnostic, not a fresh-process cold startup distribution. Local TypeScript module imports occur before timing.", "Timing defaults with correctness misses is diagnostic only, never a speed-win comparison.", "UTF-8 target sizes rounded up to complete chunks; Unicode corpus uses emoji/CJK/accent prose around ASCII detectors.", "One machine and one sequential run; small timings include scheduling/JIT/GC noise; batch means are not individual-call latency tails."],
  cold, setupEvidence,
  workloads: tasks.map(({ text, secrets, config, ...meta }) => ({ ...meta, sha256: createHash("sha256").update(text).digest("hex"), expectedIdentities: secrets.length })),
  correctnessProbes: probes, measurements: [...core, ...rows],
};
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(`Saved ${result.measurements.length} measurements; all non-default correctness assertions passed.`);
