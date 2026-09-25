import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from './runtime.ts';
import type { Run, Runtime, RuntimeEvent } from './types.ts';

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const node = (source: string) => `exec ${quote(process.execPath)} -e ${quote(source)}`;
const input = (command: string, extra = {}) => ({ name: 'test', command, cwd: tmpdir(), ...extra });
async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  do { const value = await read(); if (predicate(value)) return value; await delay(10); } while (Date.now() < end);
  throw new Error('Test observation deadline exceeded');
}
const terminal = (rt: Runtime, id: string): Promise<Run> => until(() => rt.snapshot().runs.find(r => r.id === id)!, r => r.phase === 'terminal');
const ready = (rt: Runtime, id: string) => until(() => rt.output(id), r => r.text.includes('READY'));
const notices = (events: RuntimeEvent[]) => events.filter(e => e.type === 'notification');
async function cleanup(rt: Runtime) { await rt.dispose(); }

test('runtime natural outcomes, opaque IDs, real liveness, attention and history', async () => {
  const rt = createRuntime({ stopGraceMs: 100 });
  const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const good = await rt.start(input('exit 0'));
    const bad = await rt.start(input('exit 7', { notify: { onFailure: 'ignore' } }));
    const external = await rt.start(input(node("process.kill(process.pid, 'SIGTERM')")));
    await Promise.all([good, bad, external].map(r => terminal(rt, r.id)));
    await until(() => notices(events), e => e.length === 3);
    const runs = rt.snapshot().runs;
    assert.equal(runs.find(r => r.id === good.id)!.outcome, 'successful');
    assert.equal(runs.find(r => r.id === bad.id)!.exitCode, 7);
    assert.equal(runs.find(r => r.id === external.id)!.outcome, 'failed');
    assert.equal(runs.find(r => r.id === external.id)!.signal, 'SIGTERM');
    assert.equal(rt.snapshot().unacknowledgedFailed, 2);
    rt.acknowledge(bad.id);
    assert.equal(rt.snapshot().unacknowledgedFailed, 1);
    assert.equal(rt.snapshot().runs.find(r => r.id === bad.id)!.outcome, 'failed');
    assert.equal((await rt.stop(good.id)).outcome, 'successful');
    assert.equal(new Set(notices(events).map(e => e.key)).size, 3);
    assert.equal(notices(events).find(e => e.id === bad.id)!.attention, 'context');
    assert.equal(notices(events).find(e => e.id === external.id)!.attention, 'context');
    await assert.rejects(rt.stop(String(good.pid)), /Unknown/);
    assert.equal(rt.clear(), 3);
    await assert.rejects(rt.output(good.id), /Unknown/);
    assert.throws(() => rt.acknowledge(good.id), /Unknown/);
  } finally { await cleanup(rt); }
});

test('runtime spawn failure is terminal, sanitized, and deduplicated', async () => {
  const rt = createRuntime(); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input('echo never', { cwd: join(tmpdir(), `nonexistent-${Date.now()}`) }));
    assert.equal(run.phase, 'terminal'); assert.equal(run.outcome, 'failed');
    assert.match(run.error!, /ENOENT/);
    assert.equal(run.pid, undefined);
    await until(() => notices(events), e => e.length === 1);
    await delay(30); assert.equal(notices(events).length, 1);
  } finally { await cleanup(rt); }
});

test('runtime explicit stdin writes/EOF and payload/concurrency bounds', async () => {
  const rt = createRuntime({ stopGraceMs: 100 });
  try {
    const run = await rt.start(input(node("process.stdin.pipe(process.stdout)")));
    process.kill(run.pid!, 0);
    assert.throws(() => rt.clear(run.id), /live/);
    await assert.rejects(rt.write(run.id, 'x'.repeat(50 * 1024 + 1)), /50 KiB/);
    const first = rt.write(run.id, 'no newline');
    await assert.rejects(rt.write(run.id, 'overlap'), /pending/);
    await first;
    assert.equal((await until(() => rt.output(run.id), o => o.text.includes('no newline'))).text, 'no newline');
    assert.equal(rt.snapshot().active, 1);
    await rt.write(run.id, ' EOF', true);
    assert.equal((await terminal(rt, run.id)).outcome, 'successful');
    assert.equal((await rt.output(run.id)).text, 'no newline EOF');
    await assert.rejects(rt.write(run.id, ''), /closed/);
  } finally { await cleanup(rt); }
});

test('runtime graceful stop and repeat calls do not duplicate completion', async () => {
  const rt = createRuntime({ stopGraceMs: 300 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input(node("process.on('SIGTERM',()=>process.exit(0));console.log('READY');setInterval(()=>{},1000)"), { notify: { onKilled: 'ignore' } }));
    await ready(rt, run.id);
    const [a, b] = await Promise.all([rt.stop(run.id), rt.stop(run.id)]);
    assert.equal(a.outcome, 'user-stopped'); assert.equal(b.outcome, 'user-stopped');
    await until(() => notices(events), e => e.length === 1);
    assert.equal(notices(events)[0].attention, 'context');
    assert.equal(rt.snapshot().active, 0);
    assert.equal(rt.snapshot().unacknowledgedFailed, 0);
  } finally { await cleanup(rt); }
});

test('runtime TERM timeout stays active until explicit force escalation', async () => {
  const rt = createRuntime({ stopGraceMs: 60 });
  try {
    const run = await rt.start(input(node("process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)")));
    await ready(rt, run.id);
    const timeout = await rt.stop(run.id);
    assert.equal(timeout.phase, 'stop-timeout'); assert.equal(timeout.outcome, undefined);
    assert.equal(rt.snapshot().active, 1); process.kill(run.pid!, 0);
    const stopped = await rt.stop(run.id, true);
    assert.equal(stopped.phase, 'terminal'); assert.equal(stopped.outcome, 'user-stopped');
    assert.equal(stopped.signal, 'SIGKILL');
    assert.throws(() => process.kill(run.pid!, 0), /ESRCH/);
  } finally { await cleanup(rt); }
});

test('runtime bounded private file logs, UTF-8, tails/search, control sanitization', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'processes-test-'));
  writeFileSync(join(parent, 'keep'), 'parent belongs to caller');
  const rt = createRuntime({ logRoot: parent, maxLogBytes: 512 });
  try {
    assert.deepEqual(readdirSync(parent), ['keep']);
    const run = await rt.start(input(node("process.stdout.write('🧪'.repeat(500)+'\\n');process.stdout.write('one\\ntwo\\nthree\\n');process.stderr.write('ERR\\n')")));
    await terminal(rt, run.id); await delay(30);
    const out = await rt.output(run.id, { stream: 'stdout', tailLines: 2 });
    assert.equal(out.rotated, true); assert.equal(out.truncated, true); assert.match(out.text, /two\nthree$/);
    assert.ok(!(await rt.output(run.id)).text.includes('�'));
    assert.match((await rt.output(run.id, { pattern: 'three' })).text, /three$/);
    assert.equal((await rt.output(run.id, { stream: 'stderr' })).text, 'ERR');
    const privateDir = readdirSync(parent).find(s => s.startsWith('pi-processes-'))!;
    assert.equal(statSync(join(parent, privateDir)).mode & 0o777, 0o700);
    for (const file of readdirSync(join(parent, privateDir))) {
      const path = join(parent, privateDir, file);
      assert.ok(statSync(path).size <= 512); assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    const echo = await rt.start(input(node('process.stdin.pipe(process.stdout)'), { name: '\x1b[31mName\x1b[0m\r\u202e' }));
    assert.equal(echo.name, 'Name');
    for (const piece of ['A\x1b]', '0;secret', '\x1b', '\\B\x1b[', '31mC\x1bP', 'hidden\x07still-hidden', '\x1b\\D\x00\r\u009b31mE\u202e\u2066\t\n', '🧪']) {
      await rt.write(echo.id, piece); await delay(10);
    }
    await rt.write(echo.id, '', true); await terminal(rt, echo.id);
    assert.equal((await rt.output(echo.id)).text, 'ABCDE\t\n🧪');
    assert.equal(rt.clear(), 2);
  } finally { await cleanup(rt); assert.deepEqual(readdirSync(parent), ['keep']); rmSync(parent, { recursive: true }); }
});

test('runtime response byte/scan bounds and split UTF-8 decoding', async () => {
  const rt = createRuntime();
  try {
    const run = await rt.start(input(node("process.stdout.write('line\\n'.repeat(6000));process.stdout.write('🧪'.repeat(20000))")));
    await terminal(rt, run.id); await delay(30);
    const out = await rt.output(run.id, { tailLines: 2000 });
    assert.ok(Buffer.byteLength(out.text) <= 50 * 1024); assert.equal(out.truncated, true); assert.ok(!out.text.includes('�'));
    const utf = await rt.start(input(node("const b=Buffer.from('🧪');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)")));
    await terminal(rt, utf.id); assert.equal((await rt.output(utf.id)).text, '🧪');
    await assert.rejects(rt.output(run.id, { mode: 'regex', pattern: '(a+)+$' }), /unsupported/);
    await assert.rejects(rt.output(run.id, { tailLines: 2001 }), /tailLines/);
  } finally { await cleanup(rt); }
});

test('runtime watch split matching, stream selection, no replay, dedup and repeat throttling', async () => {
  const rt = createRuntime({ stopGraceMs: 100 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input(node('process.stdin.pipe(process.stdout)'), { notify: { logMatches: [
      { pattern: 'READY', on: 'ignore' }, { pattern: 'READY', stream: 'stderr' }, { pattern: 'READY', repeat: true },
    ] } }));
    await rt.write(run.id, 'REA'); await delay(30); await rt.write(run.id, 'DY');
    await until(() => notices(events), e => e.length === 2);
    assert.equal(notices(events)[0].attention, 'context');
    await rt.write(run.id, 'READYREADY'); await delay(40); assert.equal(notices(events).length, 2);
    await delay(1010); await rt.write(run.id, 'READY');
    await until(() => notices(events), e => e.length === 3);
    rt.update(run.id, { watches: { mode: 'append', items: [{ pattern: 'READY', on: 'context' }] } });
    await delay(30); assert.equal(notices(events).length, 3);
    await rt.write(run.id, 'READY'); await until(() => notices(events), e => e.length === 4);
    rt.update(run.id, { watches: { mode: 'remove', items: [{ index: 3 }] } });
    await rt.write(run.id, 'READY'); await delay(30); assert.equal(notices(events).length, 4);
    assert.throws(() => rt.update(run.id, { name: 'must not change', watches: { mode: 'replace', items: [{ pattern: 'x', mode: 'regex' }] } }), /unsupported/);
    assert.equal(rt.snapshot().runs[0].name, 'test');
    rt.update(run.id, { watches: { mode: 'replace', items: [{ pattern: 'NEW' }] } });
    await rt.write(run.id, 'NEW'); await until(() => notices(events), e => e.length === 5);
    rt.update(run.id, { watches: { mode: 'clear' } });
    await rt.write(run.id, 'NEW'); await delay(30); assert.equal(notices(events).length, 5);
    assert.equal(new Set(notices(events).map(e => e.key)).size, 5);
    await rt.write(run.id, '', true); await terminal(rt, run.id);
  } finally { await cleanup(rt); }
});

test('runtime snapshot isolation, synchronous revisions, subscriber isolation and capacity', async () => {
  const rt = createRuntime({ maxRuns: 2, stopGraceMs: 100 }); const revisions: number[] = [];
  let received = 0;
  rt.subscribe(async () => { throw new Error('async listener'); });
  rt.subscribe(e => { if (e.type === 'snapshot') { e.snapshot.runs[0].name = 'mutated'; throw new Error('listener'); } });
  const unsub = rt.subscribe(e => { received++; if (e.type === 'snapshot') revisions.push(e.snapshot.revision); });
  assert.equal(received, 0);
  try {
    const runs = await Promise.all([rt.start(input('exit 0')), rt.start(input('exit 1'))]);
    await assert.rejects(rt.start(input('exit 0')), /capacity/);
    await Promise.all(runs.map(r => terminal(rt, r.id)));
    assert.equal(rt.snapshot().runs[0].name, 'test');
    const snapshot = rt.snapshot(); snapshot.runs[0].notify.onSuccess = 'ignore';
    assert.equal(rt.snapshot().runs[0].notify.onSuccess, undefined);
    assert.ok(revisions.every((n, i) => i === 0 || n > revisions[i - 1]));
    const before = rt.snapshot().revision; rt.acknowledge(runs[1].id);
    assert.equal(rt.snapshot().revision, before + 1); assert.equal(revisions.at(-1), before + 1);
    unsub(); const count = received; rt.acknowledge(runs[0].id); assert.equal(received, count);
    await delay(30); rt.clear();
    await rt.start(input('exit 0'));
  } finally { await cleanup(rt); }
});

test('runtime rejects invalid watches before spawning or allocating resources', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'processes-validation-')); const rt = createRuntime({ logRoot: parent });
  try {
    for (const logMatches of [[{ pattern: 'x', mode: 'regex' }], [{ pattern: '' }], [{ pattern: 'x'.repeat(501) }], Array(21).fill({ pattern: 'x' }), [{ pattern: '\x1b[31mx' }]]) {
      await assert.rejects(rt.start(input('exit 0', { notify: { logMatches } })));
    }
    assert.equal(rt.snapshot().runs.length, 0); assert.deepEqual(readdirSync(parent), []);
  } finally { await cleanup(rt); rmSync(parent, { recursive: true }); }
});

test('runtime shutdown is bounded/idempotent, kills only live owned groups, suppresses notices', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'processes-dispose-'));
  const rt = createRuntime({ stopGraceMs: 60, logRoot: parent }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input(node("process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)")));
    await ready(rt, run.id);
    const disposal = rt.dispose(); assert.equal(disposal, rt.dispose());
    await assert.rejects(rt.start(input('exit 0')), /disposed/);
    await disposal;
    assert.equal(rt.snapshot().runs[0].outcome, 'user-stopped');
    assert.throws(() => process.kill(run.pid!, 0), /ESRCH/);
    assert.equal(notices(events).length, 0); assert.deepEqual(readdirSync(parent), []);
  } finally { await cleanup(rt); rmSync(parent, { recursive: true }); }
});

test('runtime shutdown from synchronous starting snapshot handles spawn race', async () => {
  const rt = createRuntime({ stopGraceMs: 60 }); let disposal: Promise<void> | undefined;
  rt.subscribe(e => { if (e.type === 'snapshot' && e.snapshot.runs[0]?.phase === 'starting') disposal = rt.dispose(); });
  try {
    const run = await rt.start(input(node('setInterval(()=>{},1000)')));
    await disposal;
    assert.equal(rt.snapshot().active, 0);
    if (run.pid) assert.throws(() => process.kill(run.pid!, 0), /ESRCH/);
  } finally { await cleanup(rt); }
});

test('runtime exited shell with inherited pipes warns and never signals stale group', async () => {
  const rt = createRuntime({ stopGraceMs: 60 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  const kill = process.kill; const sent: number[] = [];
  let disposal: Promise<void> | undefined;
  try {
    // Self-expiring test-owned descendant; never discover or kill foreign PIDs.
    const command = `${quote(process.execPath)} -e ${quote("setTimeout(()=>{},700)")} & exit 0`;
    const run = await rt.start(input(command, { notify: { onSuccess: 'ignore' } }));
    await terminal(rt, run.id);
    process.kill = ((pid: number, sig?: string | number) => { sent.push(pid); return kill(pid, sig); }) as typeof process.kill;
    const after = await rt.stop(run.id, true);
    assert.equal(after.outcome, 'successful');
    await until(() => rt.snapshot().runs[0], r => !!r.error);
    assert.match(rt.snapshot().runs[0].error!, /descendants may still be running/);
    await until(() => notices(events), e => e.length === 1);
    assert.equal(notices(events)[0].attention, 'context');
    disposal = rt.dispose(); await assert.rejects(disposal, /descendants may still be running/);
    assert.deepEqual(sent, []);
    assert.equal(rt.dispose(), disposal);
  } finally {
    process.kill = kill;
    if (!disposal) await rt.dispose().catch(() => {});
    await delay(750); // Let only this harmless unsupported fixture expire naturally.
  }
});

test('runtime ignored success/external signal notifications remain suppressed, failures count', async () => {
  const rt = createRuntime(); const events: RuntimeEvent[] = []; rt.subscribe(e => events.push(e));
  try {
    const a = await rt.start(input('exit 0', { notify: { onSuccess: 'ignore' } }));
    const b = await rt.start(input(node("process.kill(process.pid,'SIGTERM')"), { notify: { onKilled: 'ignore' } }));
    await Promise.all([terminal(rt, a.id), terminal(rt, b.id)]); await delay(30);
    assert.equal(notices(events).length, 0); assert.equal(rt.snapshot().unacknowledgedFailed, 1);
  } finally { await cleanup(rt); }
});

test('runtime coalesces output invalidations without raw chunks and bounds unterminated watches', async () => {
  const rt = createRuntime({ maxLogBytes: 1024 }); const events: RuntimeEvent[] = [];
  const outputTimes: number[] = [];
  rt.subscribe(e => { events.push(e); if (e.type === 'output') outputTimes.push(performance.now()); });
  try {
    const run = await rt.start(input(node("process.stdout.write('x'.repeat(200000)+'MATCH')"), { notify: { logMatches: [{ pattern: 'MATCH' }] } }));
    await terminal(rt, run.id); await delay(50);
    const outputs = events.filter(e => e.type === 'output');
    assert.ok(outputs.length >= 1);
    assert.ok(outputTimes.every((time, i) => i === 0 || time - outputTimes[i - 1] >= 25));
    assert.ok(outputs.every(e => Object.keys(e).sort().join(',') === 'id,type'));
    assert.equal(notices(events).filter(e => e.kind === 'watch').length, 1);
    assert.match((await rt.output(run.id)).text, /MATCH$/);
    assert.throws(() => rt.update(run.id, { name: 'late' }), /terminal/);
  } finally { await cleanup(rt); }
});
