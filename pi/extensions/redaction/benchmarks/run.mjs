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
import { workloads, eventFor, localPii, trials, warmup, warmupMs, samples, targetBatchMs, maxBatch } from "./workloads.mjs";

const [temp, output, trialFlag, trialArg] = process.argv.slice(2);
assert.ok(temp && output, "Use benchmarks/run.sh, with an optional output path");
assert.equal(process.version, "v26.10.0", "Benchmark requires the normal-shell Node26 executable");
// Upstream must never read the real user's configuration.
assert.equal(resolve(homedir()), resolve(temp, "home"));
const cold = {};
const upstream = name => import(pathToFileURL(join(temp, "upstream", "dist", name)).href);
const importStart = performance.now();
const { DEFAULT_CONFIG } = await upstream("config.js");
const { redactText } = await upstream("layers/index.js");
const { default: installUpstream } = await upstream("index.js");
cold.comparatorModulesImportMs = performance.now() - importStart;
const fair = { ...DEFAULT_CONFIG, minLength: 1, layers: Object.fromEntries(Object.keys(DEFAULT_CONFIG.layers).map(key => [key, key === "pii"])) };
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const dlopenStart = performance.now();
const native = createRequire(import.meta.url)("../native/redaction.node");
cold.nativeDlopenMs = performance.now() - dlopenStart;
assert.equal(typeof native.NativeRedactor.prototype.redactTextV1, "function");
assert.equal(typeof native.NativeRedactor.prototype.redactSpansUtf16V1, "function");
const sourceHash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
const hashJson = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tasks = workloads();
const textsFor = task => task.texts ?? [task.text];
const multiple = task => task.shape === "multi-text" || task.shape === "nested";
const normalize = text => text.replace(/\[EMAIL_\d+\]|\[REDACTED:Email\]/g, "§EMAIL§").replace(/\[PHONE_\d+\]|\[REDACTED:Phone\]/g, "§PHONE§");
const normalizeAll = texts => texts.map(normalize);
function host() {
  const hooks = new Map();
  return { hooks, api: { on(name, fn) { hooks.set(name, fn); }, registerCommand() {}, registerTool() {} } };
}
async function localHook(config) {
  const start = performance.now(), h = host();
  await installRedaction(h.api, {
    loadConfig: async () => ({ state: "active", path: join(temp, "synthetic-policy.json"), config: { ...config,
      sources: { toolResults: true, userMessages: false, systemPrompt: false } } }),
    loadTools: async () => Object.fromEntries(["Read", "Edit", "Write"].map(name => [`create${name}ToolDefinition`, () => ({ name: name.toLowerCase() })])),
  });
  const ctx = { sessionManager: { getBranch: () => [] } };
  return { run: event => h.hooks.get("tool_result")(event, ctx), input: text => h.hooks.get("input")({ text, source: "interactive" }, ctx),
    setupMs: performance.now() - start };
}
async function upstreamHook(config) {
  const dir = join(temp, "home", ".pi", "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pi-redact-all.json"), JSON.stringify(config));
  const start = performance.now(), h = host();
  installUpstream(h.api);
  return { run: h.hooks.get("tool_result"), setupMs: performance.now() - start };
}
function quantiles(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const q = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { p50Ms: q(.5), p95Ms: q(.95), minMs: sorted[0], maxMs: sorted.at(-1) };
}
let sink;
async function loop(entry, count) {
  const start = performance.now();
  for (let i = 0; i < count; i++) sink = await entry.run();
  return (performance.now() - start) / count;
}
async function paired(entries, trial) {
  for (const entry of entries) {
    const start = performance.now();
    let count = 0;
    do { sink = await entry.run(); count++; } while (count < warmup || performance.now() - start < warmupMs);
    entry.warmupIterations = count;
    let batch = 1, duration;
    do { duration = await loop(entry, batch); if (duration * batch >= targetBatchMs || batch === maxBatch) break;
      batch = Math.min(maxBatch, batch * 2); } while (true);
    entry.batch = batch;
    entry.samplesMs = [];
  }
  // Rotate the first implementation each sample; reverse every second trial/sample.
  for (let sample = 0; sample < samples; sample++) {
    let order = entries.map((_, i) => (i + sample + trial) % entries.length);
    if ((sample + trial) % 2) order = order.reverse();
    for (const index of order) entries[index].samplesMs.push(await loop(entries[index], entries[index].batch));
  }
}
async function entriesFor(task) {
  const config = task.config, texts = textsFor(task);
  const start = performance.now(), raw = new native.NativeRedactor(JSON.stringify(config));
  const rawSetupMs = performance.now() - start;
  const bridge = createNativeRedactor(config), hook = await localHook(config);
  function scanner(implementation, scan, setupMs = null) {
    let index = 0;
    return { implementation, setupMs, run: () => {
      const selected = multiple(task) ? texts : [texts[index++ % texts.length]];
      return selected.map(scan);
    }, project: value => value };
  }
  function hookEntry(implementation, instance) {
    let index = 0;
    return { implementation, setupMs: instance.setupMs, run: () => instance.run(eventFor(task, index++)),
      project: (value, event) => {
        const merged = { ...event, ...value };
        assert.equal(merged.isError, false, "Never time censorship as successful redaction");
        if (task.shape === "multi-text") {
          // The local sanitizer intentionally creates null-prototype records; compare every JSON value.
          assert.deepEqual(JSON.parse(JSON.stringify(merged.details)), event.details);
          assert.deepEqual(JSON.parse(JSON.stringify(merged.structuredContent)), event.structuredContent);
        }
        const result = merged.content.map(item => item.text);
        if (task.shape === "nested") result.push(...merged.details.rows.map(row => row.text), ...merged.structuredContent.result.messages);
        return result;
      } };
  }
  const entries = [
    scanner("local-napi-json-diagnostic", text => JSON.parse(raw.redact(text)).text, rawSetupMs),
    scanner("local-napi-text-v1", text => raw.redactTextV1(text) ?? text, rawSetupMs),
    scanner("local-ts-structured-bridge", text => bridge.redact(text).text),
    scanner("local-ts-text-bridge", text => bridge.redactText(text)),
    hookEntry("local-tool-result-hook", hook),
  ];
  // JSON diagnostic is deliberately parsed outside the timed scan, just as the old harness.
  let jsonIndex = 0;
  entries[0].run = () => (multiple(task) ? texts : [texts[jsonIndex++ % texts.length]]).map(text => raw.redact(text));
  entries[0].project = values => values.map(value => JSON.parse(value).text);
  if (task.scope === "pii") {
    const ctx = { config: fair, partialPrivateKeyPaths: new Set() };
    entries.push(scanner("upstream-pii-min1-layers", text => redactText(text, ctx).text));
    entries.push(hookEntry("upstream-pii-min1-tool-result-hook", await upstreamHook(fair)));
  }
  return entries;
}
// Enumerate the strings/key names in our plain-JSON synthetic tool events. This
// checks routing only; marker necessity comes from the actual native certificate.
function hookFields(event) {
  function jsonFields(value) {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(jsonFields);
    if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...jsonFields(item)]);
    return [];
  }
  return [...event.content.map(item => item.text), ...jsonFields(event.details), ...jsonFields(event.structuredContent)];
}
async function correctness(task, entries) {
  const texts = textsFor(task), oracle = createNativeRedactor(task.config);
  const expected = texts.map(text => oracle.redact(text));
  if (multiple(task)) assert.equal(expected.reduce((sum, value) => sum + value.matches.length, 0), task.expectedMatches, task.id);
  else for (const value of expected) assert.equal(value.matches.length, task.expectedMatches, task.id);
  for (let i = 0; i < texts.length; i++) {
    if (!expected[i].matches.length) assert.equal(expected[i].text, texts[i], task.id);
    for (const secret of task.secrets) assert.ok(!expected[i].text.includes(secret), task.id);
  }
  for (const entry of entries) {
    const routeCalls = { text: 0, spans: 0, legacy: 0, certificate: 0 };
    const prototype = native.NativeRedactor.prototype;
    const saved = {}, observedInputs = [], expectedFields = [];
    let descriptor;
    if (entry.implementation === "local-tool-result-hook") {
      for (const [name, key] of [["redact", "legacy"], ["redactTextV1", "text"], ["redactSpansUtf16V1", "spans"]]) {
        saved[name] = prototype[name];
        prototype[name] = function (...args) {
          routeCalls[key]++;
          if (key === "text") observedInputs.push(args[0]);
          return saved[name].apply(this, args);
        };
      }
      assert.equal(typeof prototype.negativeProofAsciiV1, "function", "Joined addon must offer certificate negotiation");
      saved.negativeProofAsciiV1 = prototype.negativeProofAsciiV1;
      prototype.negativeProofAsciiV1 = function () {
        routeCalls.certificate++;
        descriptor = saved.negativeProofAsciiV1.call(this);
        return descriptor;
      };
    }
    const first = performance.now();
    try {
      for (let index = 0; index < (multiple(task) ? 1 : texts.length); index++) {
        const event = eventFor(task, index), result = await entry.run();
        if (entry.implementation === "local-tool-result-hook") expectedFields.push(...hookFields(event));
        const projected = entry.project(result, event);
        const wanted = multiple(task) ? expected.map(value => value.text) : [expected[index].text];
        if (task.shape === "nested" && entry.implementation === "local-tool-result-hook") {
          assert.deepEqual(projected, [wanted[0], ...wanted, ...wanted]);
        } else if (entry.implementation.startsWith("upstream")) assert.deepEqual(normalizeAll(projected), normalizeAll(wanted), `${task.id}: ${entry.implementation}`);
        else assert.deepEqual(projected, wanted, `${task.id}: ${entry.implementation}`);
      }
      entry.firstSequenceCheckMs = performance.now() - first;
    } finally { for (const name of Object.keys(saved)) prototype[name] = saved[name]; }
    if (entry.implementation === "local-tool-result-hook") {
      assert.equal(routeCalls.certificate, 1, `${task.id}: actual native certificate negotiated once`);
      assert.ok(descriptor === null || typeof descriptor === "string");
      if (Object.keys(task.config.literals).length) assert.equal(descriptor, null, "Literals disable proof");
      const certified = field => field.length === 0 || (typeof descriptor === "string" && field.length <= 256 && ![...descriptor].some(marker => field.includes(marker)));
      const expectedNativeInputs = expectedFields.filter(field => !certified(field));
      // Exact forwarding of every long/marker/sensitive field; eligible fields may
      // use the approved proof, but no metadata/key traversal may disappear.
      assert.deepEqual(observedInputs, expectedNativeInputs, `${task.id}: proof/V1 field routing`);
      assert.equal(routeCalls.text, expectedNativeInputs.length);
      assert.equal(routeCalls.legacy, 0, `${task.id}: no legacy fallback`);
      assert.equal(routeCalls.spans, 0, `${task.id}: no spans in ordinary hook text`);
      entry.routeCallsBeforeTiming = { ...routeCalls, descriptor, fieldsChecked: expectedFields.length,
        certifiedFields: expectedFields.filter(field => field.length > 0 && certified(field)).length,
        validatedEmptyFields: expectedFields.filter(field => field.length === 0).length };
    }
  }
  // Statefulness, no-change reservation, idempotence and direct-user exemption on actual default hook.
  const tracker = { text: 0, spans: 0, legacy: 0 }, proto = native.NativeRedactor.prototype;
  const original = Object.fromEntries(["redact", "redactTextV1", "redactSpansUtf16V1"].map(name => [name, proto[name]]));
  try {
    for (const [name, key] of [["redact", "legacy"], ["redactTextV1", "text"], ["redactSpansUtf16V1", "spans"]]) {
      proto[name] = function (...args) { tracker[key]++; return original[name].apply(this, args); };
    }
    const hook = await localHook(localPii);
    assert.deepEqual(await hook.input("[EMAIL_90] [PHONE_80] a@example.com"), { action: "continue" });
    const run = text => hook.run(eventFor({ text }));
    const first = await run("[EMAIL_91] [PHONE_81]");
    assert.equal(first.content[0].text, "[EMAIL_91] [PHONE_81]");
    const next = await run("a@example.com +14155550132");
    assert.equal(next.content[0].text, "[EMAIL_92] [PHONE_82]");
    assert.equal((await run(next.content[0].text)).content[0].text, next.content[0].text);
    assert.equal((await run("b@example.com a@example.com")).content[0].text, "[EMAIL_93] [EMAIL_92]");
    assert.ok(tracker.text > 0);
    assert.equal(tracker.legacy, 0);
    // Token reservation may legitimately use structured scans; ordinary tool text uses V1 text.
  } finally { for (const name of Object.keys(original)) proto[name] = original[name]; }
  return { passed: true, exactLocalOutputs: true, normalizedUpstreamOutputs: task.scope === "pii", unchangedOutputs: true,
    hookV1TextInvocations: tracker.text, legacyInvocations: tracker.legacy, historyReservationAndIdentityStability: true };
}

if (trialFlag === "--trial") {
  const trial = Number(trialArg), rows = [], coreTasks = [];
  for (const task of tasks) {
    const entries = await entriesFor(task);
    const evidence = await correctness(task, entries);
    const oracle = createNativeRedactor(task.config);
    coreTasks.push({ ...task, coreChecks: textsFor(task).map(text => {
      const result = oracle.redact(text); return { text, output: result.text, matches: result.matches.length };
    }) });
    await paired(entries, trial);
    for (const entry of entries) rows.push({ id: task.id, implementation: entry.implementation, trial,
      setupMs: entry.setupMs, firstSequenceCheckMs: entry.firstSequenceCheckMs, correctness: evidence,
      routeCallsBeforeTiming: entry.routeCallsBeforeTiming,
      warmupIterations: entry.warmupIterations, batch: entry.batch, samplesMs: entry.samplesMs, ...quantiles(entry.samplesMs) });
  }
  assert.ok(sink !== undefined);
  await writeFile(join(temp, `tasks-${trial}.json`), JSON.stringify(coreTasks));
  const start = performance.now();
  const core = JSON.parse(execFileSync(join(temp, "target", "release", "pi-redaction-corpus-benchmark"), [join(temp, `tasks-${trial}.json`)], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }));
  cold.coreProcessWithAllScansMs = performance.now() - start;
  await writeFile(output, JSON.stringify({ trial, cold, measurements: [...rows, ...core.map(row => ({ ...row, trial }))] }));
  console.log(`Trial ${trial + 1}: ${rows.length + core.length} checked measurement rows`);
} else {
  const baseline = JSON.parse(await readFile(join(root, "benchmarks/results/latest.json"), "utf8"));
  const historicalBaseline = baseline.schemaVersion === 1 ? baseline : baseline.historicalBaseline;
  assert.ok(historicalBaseline?.hashes?.nativeSource, "Preserve the original measured source identity");
  // Never silently change original payloads or configs when extending the harness.
  for (const old of historicalBaseline.workloads) {
    const task = tasks.find(task => task.id === old.id);
    assert.ok(task, old.id);
    assert.equal(createHash("sha256").update(task.text).digest("hex"), old.sha256, old.id);
    assert.equal(task.bytes, old.bytes, old.id);
    if (task.scope === "pii") assert.deepEqual(task.config, historicalBaseline.configuration.localPii);
  }
  assert.deepEqual(fair, historicalBaseline.configuration.upstreamFair);
  const independentTrials = [];
  for (let trial = 0; trial < trials; trial++) {
    const file = join(temp, `trial-${trial}.json`);
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), temp, file, "--trial", String(trial)], { stdio: "inherit" });
    independentTrials.push(JSON.parse(await readFile(file, "utf8")));
  }
  const measurements = [];
  for (const task of tasks) {
    const names = independentTrials[0].measurements.filter(row => row.id === task.id).map(row => row.implementation);
    for (const implementation of names) {
      const trialRows = independentTrials.map(trial => trial.measurements.find(row => row.id === task.id && row.implementation === implementation));
      const times = trialRows.flatMap(row => row.samplesMs);
      const stats = quantiles(times);
      // Throughput counts scanned text leaves, not serialized protocol/metadata byte size.
      const textBytes = textsFor(task).map(text => Buffer.byteLength(text));
      let bytes = multiple(task) ? textBytes.reduce((sum, value) => sum + value, 0) : textBytes.reduce((sum, value) => sum + value, 0) / textBytes.length;
      if (task.shape === "nested" && implementation === "local-tool-result-hook") bytes = 2 * textBytes.reduce((sum, value) => sum + value, 0) + textBytes.reduce((sum, value) => sum + value, 0) / textBytes.length;
      measurements.push({ id: task.id, implementation, ...stats, samplesMs: times, trials: trialRows,
        throughputMiBs: bytes / 1048576 / (stats.p50Ms / 1000), correctness: "passed" });
    }
  }
  const comparisons = tasks.filter(task => task.scope === "pii").map(task => {
    const local = measurements.find(row => row.id === task.id && row.implementation === "local-tool-result-hook");
    const upstream = measurements.find(row => row.id === task.id && row.implementation === "upstream-pii-min1-tool-result-hook");
    return { id: task.id, localP50Ms: local.p50Ms, localP95Ms: local.p95Ms, upstreamP50Ms: upstream.p50Ms, upstreamP95Ms: upstream.p95Ms,
      comparisonClass: task.comparisonClass ?? "shared-pii", comparable: task.comparisonClass !== "diagnostic-upstream-minLength-bypass",
      ratioLocalOverUpstream: local.p50Ms / upstream.p50Ms, worse: local.p50Ms >= upstream.p50Ms,
      trialRatios: local.trials.map((row, i) => row.p50Ms / upstream.trials[i].p50Ms) };
  });
  const setupEvidence = JSON.parse(await readFile(join(temp, "setup.json"), "utf8"));
  const probes = ["a@example.com", "+14155550132", "US: 415-555-0132", "_: (415)555-0132", "Call 415-555-0132 ext.12", "info@example."].map(text => ({ syntheticInput: text,
    local: createNativeRedactor(localPii).redact(text).text, fair: redactText(text, { config: fair, partialPrivateKeyPaths: new Set() }).text,
    defaults: redactText(text, { config: DEFAULT_CONFIG, partialPrivateKeyPaths: new Set() }).text,
    piiWithDefaultMin32: redactText(text, { config: { ...fair, minLength: 32 }, partialPrivateKeyPaths: new Set() }).text }));
  const result = {
    schemaVersion: 2, generatedAt: new Date().toISOString(),
    environment: { platform: platform(), architecture: arch(), osRelease: release(), cpu: cpus()[0].model, logicalCpus: cpus().length, node: process.version, ...setupEvidence.toolchain },
    revisions: { local: "integrated uncommitted corrected sources; hashes authoritative", comparator: "a1a189f970f53c81f90c8de587c59c72cefec5ee", comparatorVersion: "0.2.5" },
    hashes: Object.fromEntries(await Promise.all(Object.entries({ nativeSource: "native/src/lib.rs", nativeOptimizationTests: "native/src/optimization_tests.rs", nativeCargoLock: "native/Cargo.lock", corpus: "fixtures/corpus.json", bridge: "src/native.ts", hook: "src/index.ts", sanitizer: "src/sanitize.ts", history: "src/alias-history.ts", runner: "benchmarks/run.mjs", shell: "benchmarks/run.sh", workloads: "benchmarks/workloads.mjs", core: "benchmarks/core/src/main.rs" }).map(async ([name, path]) => [name, await sourceHash(join(root, path))]))),
    comparatorHashes: { archive: await sourceHash(join(temp, "comparator.tar.gz")), config: await sourceHash(join(temp, "upstream/src/config.ts")), pii: await sourceHash(join(temp, "upstream/src/layers/layer-8-pii.ts")), hook: await sourceHash(join(temp, "upstream/src/index.ts")), toolResult: await sourceHash(join(temp, "upstream/src/hooks/tool-result.ts")) },
    configuration: { localPii, upstreamFair: fair, upstreamDefaults: DEFAULT_CONFIG, sourceFlags: { toolResults: true, userMessages: false, systemPrompt: false }, trials, warmup, warmupMs, samples, targetBatchMs, maxBatch,
      quantiles: "Nearest rank over all 63 interleaved batch means (21 per independent fresh-process trial); not individual-call tails", coreBuild: "cargo release --locked; default features", nativeBuild: "cargo release --locked --features node" },
    limitations: ["Upstream PII also scans IPv4/cards/SSN/IBAN; local email/phone only. Required shared removals agree, entire policies do not.", "Literal and sensitive nested structured data are local-only: upstream lacks these capabilities; no comparable speed win.", "Raw core, native text, JSON diagnostic (no timed parsing), structured/text bridge and registered hooks are distinct layers.", "Mock host registration with actual production loaders/callbacks; not a live Pi/provider/filesystem benchmark. Stable benign history only.", "All measurements retained; batch means and tiny calls include JIT/GC/scheduling noise. Fresh engines/processes per trial, no repeat-input cache.", "Changing identities cycle 32 fictional distinct identities; state persists across calls. Multi-text raw scans measure its text array, hook includes metadata traversal.", "First-sequence verification (including checks/instrumentation), setup/import/build are separate diagnostics, not first-call latency or full fresh-process startup distributions.", "Historical baseline is retained verbatim, not remeasured with the new methodology; no baseline timing speedup claim."],
    cold: { parentImport: cold, independentTrials: independentTrials.map(({ trial, cold }) => ({ trial, ...cold })) }, setupEvidence,
    workloads: tasks.map(({ text, texts, secrets, config, ...meta }) => ({ ...meta, sha256: createHash("sha256").update(text).digest("hex"), payloadSha256: hashJson({ texts: textsFor({ text, texts }), event: eventFor({ text, texts, ...meta }) }), configSha256: hashJson(config), expectedIdentities: secrets.length, sequenceLength: texts?.length ?? 1 })),
    correctnessProbes: probes, comparisons, summary: { comparableCases: comparisons.filter(row => row.comparable).length, worseCases: comparisons.filter(row => row.comparable && row.worse).length,
      diagnostics: comparisons.filter(row => !row.comparable),
      latencyFloor: comparisons.reduce((best, row) => row.localP50Ms < best.localP50Ms ? row : best) }, measurements, historicalBaseline,
  };
  // Artifacts must not contain home/private or temporary absolute paths.
  const serialized = JSON.stringify(result, null, 2) + "\n";
  assert.ok(!serialized.includes(temp));
  assert.ok(!serialized.includes("/Users/"));
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, serialized);
  console.log(`Saved ${measurements.length} aggregate rows; ${result.summary.worseCases}/${result.summary.comparableCases} comparable local-hook losses; ${result.summary.diagnostics.length} explicit minLength-bypass diagnostic.`);
  for (const row of comparisons.filter(row => row.comparable && row.worse)) console.log(`BLOCKING ${row.id}: ${row.ratioLocalOverUpstream.toFixed(3)}x; trials ${row.trialRatios.map(ratio => ratio.toFixed(3)).join(", ")}`);
}
