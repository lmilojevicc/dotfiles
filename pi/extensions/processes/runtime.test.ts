import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    await rt.write(run.id, 'REA'); await delay(30); await rt.write(run.id, 'DY\n');
    await until(() => notices(events), e => e.length === 2);
    assert.equal(notices(events)[0].attention, 'context');
    await rt.write(run.id, 'READYREADY\n'); await delay(40); assert.equal(notices(events).length, 2);
    await delay(40); await rt.write(run.id, 'READY\n');
    await delay(40); assert.equal(notices(events).length, 2);
    rt.update(run.id, { watches: { mode: 'append', items: [{ pattern: 'READY', on: 'context' }] } });
    await delay(30); assert.equal(notices(events).length, 2);
    await rt.write(run.id, 'READY\n'); await until(() => notices(events), e => e.length === 3);
    rt.update(run.id, { watches: { mode: 'remove', items: [{ index: 3 }] } });
    await rt.write(run.id, 'READY\n'); await delay(30); assert.equal(notices(events).length, 3);
    assert.throws(() => rt.update(run.id, { name: 'must not change', watches: { mode: 'replace', items: [{ pattern: 'x', mode: 'regex' }] } }), /unsupported/);
    assert.equal(rt.snapshot().runs[0].name, 'test');
    rt.update(run.id, { watches: { mode: 'replace', items: [{ pattern: 'NEW' }] } });
    await rt.write(run.id, 'NEW\n'); await until(() => notices(events), e => e.length === 4);
    rt.update(run.id, { watches: { mode: 'clear' } });
    await rt.write(run.id, 'NEW\n'); await delay(30); assert.equal(notices(events).length, 4);
    assert.equal(new Set(notices(events).map(e => e.key)).size, 4);
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
    assert.equal(notices(events).filter(e => e.kind === 'watch').length, 0); // Oversized lines are deliberately skipped.
    assert.match((await rt.output(run.id)).text, /MATCH$/);
    assert.throws(() => rt.update(run.id, { name: 'late' }), /terminal/);
  } finally { await cleanup(rt); }
});

test('runtime upstream bash-login execution returns real raw retained paths and deletes only owned files', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'processes-paths-'));
  writeFileSync(join(parent, 'keep'), 'caller data');
  const rt = createRuntime({ logRoot: parent });
  try {
    const run = await rt.start(input('test -n "$BASH_VERSION" && shopt -q login_shell && printf "\\033[31mLOGIN\\033[0m\\n" && printf "ERR\\n" >&2'));
    assert.match(run.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.notEqual(run.id, String(run.pid));
    await terminal(rt, run.id);
    assert.equal(rt.snapshot().runs[0].outcome, 'successful');
    const output = await rt.output(run.id);
    assert.equal(output.stdoutFile, run.stdoutFile);
    assert.equal(output.stderrFile, run.stderrFile);
    assert.match(readFileSync(run.stdoutFile!, 'utf8'), /\x1b\[31mLOGIN/);
    assert.equal(readFileSync(run.stderrFile!, 'utf8'), 'ERR\n');
    assert.equal((await rt.output(run.id, { stream: 'stdout' })).text, 'LOGIN');
    assert.doesNotMatch(output.text, /\x1b/);
    rt.clear(run.id);
    assert.equal(existsSync(run.stdoutFile!), false);
    assert.equal(existsSync(run.stderrFile!), false);
  } finally { await rt.dispose(); assert.deepEqual(readdirSync(parent), ['keep']); rmSync(parent, { recursive: true }); }
});

test('runtime late genuine exit after stop timeout remains active then completes exactly once', async () => {
  const rt = createRuntime({ stopGraceMs: 30 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input(node("process.on('SIGTERM',()=>setTimeout(()=>{process.stdout.write('FINAL');process.exit(0)},120));console.log('READY');setInterval(()=>{},1000)"), { notify: { logMatches: [{ pattern: 'FINAL' }] } }));
    await ready(rt, run.id);
    const timed = await rt.stop(run.id);
    assert.equal(timed.phase, 'stop-timeout'); assert.equal(timed.endedAt, undefined);
    assert.equal(timed.outcome, undefined); assert.equal(rt.snapshot().active, 1);
    assert.equal(notices(events).length, 0);
    await terminal(rt, run.id);
    await until(() => notices(events), e => e.length === 2);
    assert.deepEqual(notices(events).map(e => e.kind), ['watch', 'completion']);
    const completed = notices(events)[1];
    assert.equal(completed.details?.kind, 'completion');
    assert.equal(completed.details!.kind !== 'suppression' && completed.details!.run.outcome, 'user-stopped');
    assert.equal(completed.attention, 'context');
    await delay(40); assert.equal(notices(events).length, 2);
  } finally { await rt.dispose(); }
});

test('ProcessRuntimeController stdout EOF flushes only stdout watches while owner and stderr remain open', async () => {
  const rt = createRuntime({ stopGraceMs: 60 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input(node("const b=Buffer.from('READY🧪');process.stdout.write(b.subarray(0,7));process.stdout.write(b.subarray(7));process.stderr.write('LATER');process.stdout.end();process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('\\n');process.stderr.end()});setTimeout(()=>process.exit(0),1500).unref()"), { notify: { onSuccess: 'ignore', logMatches: [{ pattern: 'READY🧪', stream: 'stdout' }, { pattern: 'LATER', stream: 'stderr' }] } }));
    await until(() => notices(events).filter(e => e.kind === 'watch'), e => e.length === 1, 500);
    assert.equal(rt.snapshot().runs[0].phase, 'running');
    assert.equal(notices(events)[0].details?.kind, 'watch');
    assert.equal(notices(events)[0].details?.kind === 'watch' && notices(events)[0].details.watch.line, 'READY🧪');
    assert.equal((await rt.output(run.id, { stream: 'stderr' })).text, 'LATER');
    await rt.write(run.id, '', true); await terminal(rt, run.id);
    await until(() => notices(events).filter(e => e.kind === 'watch'), e => e.length === 2);
    assert.deepEqual(notices(events).map(e => e.kind), ['watch', 'watch']);
    assert.equal(notices(events)[1].details?.kind === 'watch' && notices(events)[1].details.watch.line, 'LATER');
    await delay(40); assert.equal(notices(events).length, 2);
  } finally { await rt.dispose(); }
});

test('ProcessRuntimeController stderr EOF flushes only stderr watches while owner and stdout remain open', async () => {
  const rt = createRuntime({ stopGraceMs: 60 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input(node("process.stdout.write('LATER');process.stderr.write('READY');process.stderr.end();process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('\\n');process.stdout.end()});setTimeout(()=>process.exit(0),1500).unref()"), { notify: { onSuccess: 'ignore', logMatches: [{ pattern: 'READY', stream: 'stderr' }, { pattern: 'LATER', stream: 'stdout' }] } }));
    await until(() => notices(events).filter(e => e.kind === 'watch'), e => e.length === 1, 500);
    assert.equal(rt.snapshot().runs[0].phase, 'running');
    assert.equal(notices(events)[0].details?.kind === 'watch' && notices(events)[0].details.watch.stream, 'stderr');
    assert.equal((await rt.output(run.id, { stream: 'stdout' })).text, 'LATER');
    await rt.write(run.id, '', true); await terminal(rt, run.id);
    await until(() => notices(events).filter(e => e.kind === 'watch'), e => e.length === 2);
    assert.deepEqual(notices(events).map(e => e.kind), ['watch', 'watch']);
    assert.equal(notices(events)[1].details?.kind === 'watch' && notices(events)[1].details.watch.stream, 'stdout');
    await delay(40); assert.equal(notices(events).length, 2);
  } finally { await rt.dispose(); }
});

test('runtime line watches wait for newline or EOF, never join streams, and skip oversized lines', async () => {
  const rt = createRuntime({ stopGraceMs: 60 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input(node("process.stdout.write('REA');process.stderr.write('DY\\n');process.stdout.write('\\n');process.stdin.pipe(process.stdout)"), { notify: { logMatches: [{ pattern: 'READY' }, { pattern: 'OVERSIZE' }] } }));
    await until(() => rt.output(run.id, { stream: 'stderr' }), o => o.text.includes('DY'));
    await delay(40); assert.equal(notices(events).length, 0);
    await rt.write(run.id, 'x'.repeat(10001) + 'OVERSIZE\n');
    await rt.write(run.id, 'REA'); await delay(40); await rt.write(run.id, 'DY');
    await until(() => rt.output(run.id), o => o.text.includes('READY'));
    await delay(40); assert.equal(notices(events).length, 0);
    await rt.write(run.id, '', true); await terminal(rt, run.id);
    await until(() => notices(events), e => e.length === 2);
    const detail = notices(events)[0].details!;
    assert.equal(detail.kind, 'watch');
    if (detail.kind === 'watch') assert.deepEqual(detail.watch, { pattern: 'READY', mode: 'literal', stream: 'stdout', line: 'READY', matcherIndex: 0 });
  } finally { await rt.dispose(); }
});

test('runtime notification details are detached event-time snapshots after rename, acknowledge, clear and disposal', async () => {
  const rt = createRuntime({ stopGraceMs: 60 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => { if (e.type === 'notification' && e.details?.kind !== 'suppression' && e.details) e.details.run.name = 'corrupted observer copy'; });
  rt.subscribe(e => events.push(e));
  const run = await rt.start(input(node('process.stdin.pipe(process.stdout)'), { name: '\x1b[31mOriginal', notify: { logMatches: [{ pattern: 'HELLO', on: 'ignore' }] } }));
  try {
    await rt.write(run.id, 'HELLO\n');
    await until(() => notices(events), e => e.length === 1);
    const watch = notices(events)[0];
    assert.equal(watch.attention, 'context'); assert.equal(watch.details!.version, 1);
    assert.equal(watch.details!.kind !== 'suppression' && watch.details!.run.name, 'Original');
    rt.update(run.id, { name: 'Renamed' }); rt.acknowledge(run.id);
    await rt.write(run.id, '', true); await terminal(rt, run.id);
    await until(() => notices(events), e => e.length === 2);
    const saved = JSON.stringify(notices(events));
    rt.clear(run.id); await rt.dispose();
    assert.equal(JSON.stringify(notices(events)), saved);
    const completion = notices(events)[1].details!;
    assert.equal(completion.kind !== 'suppression' && completion.run.name, 'Renamed');
    assert.equal(completion.kind !== 'suppression' && completion.run.acknowledged, true);
    assert.equal(watch.details!.kind !== 'suppression' && watch.details!.run.acknowledged, false);
  } finally { await rt.dispose(); }
});

test('runtime asynchronous log write/read/removal failures are visible, not empty output or successful cleanup', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'processes-fs-failure-'));
  const rt = createRuntime({ logRoot: parent, stopGraceMs: 60 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  let disposal: Promise<void> | undefined;
  try {
    const run = await rt.start(input(node('process.stdin.pipe(process.stdout)'), { notify: { onSuccess: 'ignore', logMatches: [{ pattern: 'MATCH' }] } }));
    // Corrupt only this test-owned file; never change caller directory permissions.
    rmSync(run.stdoutFile!); mkdirSync(run.stdoutFile!);
    await rt.write(run.id, 'MATCH\n');
    await until(() => rt.snapshot().runs[0], r => !!r.error);
    assert.match(rt.snapshot().runs[0].error!, /Log write failed/);
    await assert.rejects(rt.output(run.id, { stream: 'stdout' }));
    await rt.write(run.id, '', true); await terminal(rt, run.id);
    await until(() => notices(events), e => e.length === 2);
    assert.equal(notices(events)[1].attention, 'context');
    assert.match(notices(events)[1].text, /Log write failed/);
    assert.throws(() => rt.clear(run.id));
    disposal = rt.dispose(); await assert.rejects(disposal, /Process cleanup:.*Log write failed/);
    assert.equal(rt.dispose(), disposal);
    assert.deepEqual(readdirSync(parent), []);
  } finally { if (!disposal) await rt.dispose().catch(() => {}); rmSync(parent, { recursive: true, force: true }); }
});

test('runtime missing retained file rejects reads instead of returning empty success', async () => {
  const rt = createRuntime();
  try {
    const run = await rt.start(input('printf retained >&2')); await terminal(rt, run.id);
    rmSync(run.stderrFile!);
    await assert.rejects(rt.output(run.id, { stream: 'stderr' }), /ENOENT/);
  } finally { await rt.dispose(); }
});

test('runtime clear before inherited-pipe drain captures warning and final watch before deleting record', async () => {
  const rt = createRuntime({ stopGraceMs: 60 }); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  const kill = process.kill; const sent: number[] = [];
  let disposal: Promise<void> | undefined;
  try {
    const run = await rt.start(input(`printf TAIL; ${quote(process.execPath)} -e ${quote('setTimeout(()=>{},450)')} & exit 0`, { notify: { onSuccess: 'ignore', logMatches: [{ pattern: 'TAIL' }] } }));
    await terminal(rt, run.id);
    process.kill = ((pid: number, sig?: string | number) => { sent.push(pid); return kill(pid, sig); }) as typeof process.kill;
    assert.equal(rt.clear(run.id), 1); assert.equal(rt.snapshot().runs.length, 0);
    const completion = notices(events).find(e => e.kind === 'completion')!;
    assert.equal(completion.attention, 'context');
    assert.match(completion.text, /cleared before pipes drained/);
    assert.equal(completion.details?.kind, 'completion');
    assert.equal(notices(events)[0].kind, 'watch');
    disposal = rt.dispose(); await assert.rejects(disposal, /cleared before pipes drained/);
    assert.deepEqual(sent, []);
    await delay(60); assert.equal(notices(events).length, 2);
  } finally { process.kill = kill; if (!disposal) await rt.dispose().catch(() => {}); await delay(500); }
});

// Source-named deterministic policy tests: no real 15s/60s/5-minute waits.
import { ProcessLogStore } from './backend/manager/process-log-store.ts';
import { ProcessRegistry } from './backend/manager/process-registry.ts';
import { ProcessOutput } from './backend/manager/process-output.ts';
import { ProcessRuntimeController } from './backend/manager/process-runtime-controller.ts';
import type { ManagedProcessRecord } from './backend/manager/internal-types.ts';
import type { ManagerEvent, ProcessInfo } from './backend/types.ts';
import { compileLogMatchers, evaluateLogMatchers } from './backend/notifications/log-matchers.ts';
import { createNotificationRegistry, createNotificationService } from './backend/notifications/service.ts';
import { createNotificationThrottle } from './backend/notifications/throttle.ts';
import type { ProcessNotificationDetails } from './backend/notifications/types.ts';
import { ProcessManager } from './backend/manager/index.ts';
import { MAX_LOG_FILE_BYTES, FINISHED_RECORD_GRACE_MS } from './backend/manager/limits.ts';

const infoFixture = (id = 'owned-unit-fixture'): ProcessInfo => ({ id, name: 'test', pid: -1, command: 'unit only', cwd: tmpdir(), startTime: 1,
  endTime: null, status: 'running', exitCode: null, success: null, stdoutFile: '', stderrFile: '', endReason: null, signal: null,
  errorMessage: null, stopRequested: false });
const recordFixture = (id: string, logs: ProcessLogStore): ManagedProcessRecord => ({ ...infoFixture(id), ...logs.createLogs(id),
  status: 'exited', endTime: 1000, success: false, exitCode: 1, completed: true, closed: true, ownerExited: true,
  child: { stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} } } as ManagedProcessRecord['child'],
  stdin: null, stdinClosed: true, lastSignalSent: null, completionSequence: 0, writing: false,
  spawned: Promise.resolve(), exited: Promise.resolve(), drained: Promise.resolve(), resolveExit() {}, resolveDrained() {},
  stdoutPendingLine: Buffer.alloc(0), stderrPendingLine: Buffer.alloc(0), stdoutLineOverflowed: false, stderrLineOverflowed: false,
  appendedLines: [], droppedLineCount: 0 });

test('ProcessLogStore upstream per-file default and giant single append enforce cap including marker', () => {
  assert.equal(MAX_LOG_FILE_BYTES, 64 * 1024 * 1024);
  const logs = new ProcessLogStore(undefined, { maxFileBytes: 127 });
  try {
    const paths = logs.createLogs('owned-unit-giant');
    logs.appendStdout(paths.stdoutFile, Buffer.from('🧪'.repeat(10000) + 'FINAL\n'));
    assert.ok(statSync(paths.stdoutFile).size <= 127);
    assert.equal(statSync(paths.stdoutFile).mode & 0o777, 0o600);
    assert.equal(logs.isRotated(paths.stdoutFile), true);
    assert.equal(logs.isRotated(paths.stderrFile), false);
    assert.match(logs.readTailLines(paths.stdoutFile, 3).join('\n'), /FINAL$/);
    assert.doesNotMatch(logs.readFullFile(paths.stdoutFile), /�/);
    logs.appendStderr(paths.stderrFile, Buffer.from('[retained log rotated]\n'));
    assert.equal(logs.isRotated(paths.stderrFile), false); // User text is not rotation state.
    logs.removeLogs(paths); assert.equal(existsSync(paths.stdoutFile), false);
  } finally { logs.cleanup(); }
});

test('ProcessLogStore allocation failure occurs before spawn and preserves caller root', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'processes-allocation-'));
  const file = join(parent, 'not-a-directory'); writeFileSync(file, 'keep');
  const rt = createRuntime({ logRoot: file });
  try {
    await assert.rejects(rt.start(input('exit 0')), /ENOTDIR/);
    assert.equal(rt.snapshot().runs.length, 0); assert.equal(readFileSync(file, 'utf8'), 'keep');
  } finally { await rt.dispose(); rmSync(parent, { recursive: true }); }
});

test('ProcessRuntimeController reaps only excess finished records at the exact five-minute boundary', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const logs = new ProcessLogStore(); const registry = new ProcessRegistry(); const events: ManagerEvent[] = [];
  const output = new ProcessOutput({ emit: e => events.push(e) });
  const controller = new ProcessRuntimeController({ registry, logs, output, emit: e => events.push(e), getConfiguredShellPath: () => undefined });
  const policy = controller as unknown as { reapOldestFinished(): void; scheduleFinishedReap(): void };
  try {
    for (let i = 0; i < 52; i++) { const record = recordFixture(`owned-unit-${i}`, logs); record.completionSequence = i; registry.add(record); }
    // Recent records and a still-active timeout are not a hard 50-record quota.
    const live = recordFixture('owned-unit-live', logs); live.status = 'terminate_timeout'; live.endTime = null;
    live.completed = false; registry.add(live);
    policy.reapOldestFinished(); policy.scheduleFinishedReap(); assert.equal(registry.list().length, 53);
    t.mock.timers.tick(FINISHED_RECORD_GRACE_MS - 1); assert.equal(registry.list().length, 53);
    t.mock.timers.tick(1);
    assert.equal(registry.list().length, 51);
    assert.equal(registry.has('owned-unit-0'), false); assert.equal(registry.has('owned-unit-1'), false);
    assert.equal(registry.has('owned-unit-2'), true); assert.equal(registry.has('owned-unit-live'), true);
    assert.equal(events.filter(e => e.type === 'processes_changed').length, 1);
    t.mock.timers.tick(FINISHED_RECORD_GRACE_MS * 2); assert.equal(registry.list().length, 51);
  } finally { controller.beginShutdown(); controller.stopWatcher(); output.clearAll(); logs.cleanup(); t.mock.timers.reset(); }
});

test('ProcessRuntimeController cancels excess-finished reaper on shutdown', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const logs = new ProcessLogStore(); const registry = new ProcessRegistry(); const events: ManagerEvent[] = [];
  const output = new ProcessOutput({ emit: e => events.push(e) });
  const controller = new ProcessRuntimeController({ registry, logs, output, emit: e => events.push(e), getConfiguredShellPath: () => undefined });
  try {
    for (let i = 0; i < 51; i++) registry.add(recordFixture(`owned-cancel-${i}`, logs));
    (controller as unknown as { scheduleFinishedReap(): void }).scheduleFinishedReap();
    controller.beginShutdown(); t.mock.timers.tick(FINISHED_RECORD_GRACE_MS * 2);
    assert.equal(registry.list().length, 51); assert.equal(events.length, 0);
  } finally { controller.beginShutdown(); output.clearAll(); logs.cleanup(); t.mock.timers.reset(); }
});

test('ProcessRuntimeController owner-exit guard covers signal, liveness, explicit force and cleanup', async () => {
  const logs = new ProcessLogStore(); const registry = new ProcessRegistry(); const output = new ProcessOutput({ emit() {} });
  const controller = new ProcessRuntimeController({ registry, logs, output, emit() {}, getConfiguredShellPath: () => undefined, stopGraceMs: 1 });
  const record = recordFixture('owned-stale-guard', logs); record.pid = 123456789;
  registry.add(record);
  const internals = controller as unknown as { signal(record: ManagedProcessRecord, signal: NodeJS.Signals): boolean; livenessTick(): void };
  const kill = process.kill; const signals: unknown[] = [];
  process.kill = ((...args: unknown[]) => { signals.push(args); throw new Error('No OS signal is authorized by this unit fixture'); }) as typeof process.kill;
  try {
    assert.equal(internals.signal(record, 'SIGTERM'), false);
    assert.equal(internals.signal(record, 'SIGKILL'), false);
    internals.livenessTick(); await controller.kill(record.id, { signal: 'SIGKILL' });
    // ChildProcess fields can reflect exit before the exit listener is dispatched.
    record.ownerExited = false; record.status = 'running'; record.child.exitCode = 0; record.child.signalCode = null;
    assert.equal(internals.signal(record, 'SIGKILL'), false); internals.livenessTick();
    record.ownerExited = true;
    await controller.cleanup(); assert.deepEqual(signals, []);
  } finally { process.kill = kill; logs.cleanup(); }
});

test('LogMatchers preserve upstream exact 15-second cooldown and bounded literal-only lines', () => {
  const matchers = compileLogMatchers({ logMatches: [{ pattern: 'READY', repeat: true }, { pattern: 'READY', stream: 'stderr' }] });
  const line = [{ type: 'stdout' as const, text: 'READY' }];
  assert.equal(evaluateLogMatchers(matchers, line, 0).length, 1);
  assert.equal(evaluateLogMatchers(matchers, line, 14999).length, 0);
  assert.equal(evaluateLogMatchers(matchers, line, 15000).length, 1);
  assert.equal(evaluateLogMatchers(matchers, [{ type: 'stdout', text: 'x'.repeat(10001) + 'READY' }], 30000).length, 0);
  assert.equal(evaluateLogMatchers(matchers, [{ type: 'stderr', text: 'READY' }], 30000).length, 2);
  assert.throws(() => compileLogMatchers({ logMatches: [{ pattern: '(a+)+$', mode: 'regex' }] }), /unsupported/);
});

test('NotificationService upstream generations preserve duplicate one-shot identity through append/remove, reset replace/clear', () => {
  const registry = createNotificationRegistry(); const manager = new ProcessManager(); const info = infoFixture();
  let handler: (event: ManagerEvent) => void = () => {}; let subscribed = true;
  manager.onEvent = listener => { handler = listener; return () => { subscribed = false; }; };
  const delivered: ProcessNotificationDetails[] = [];
  const service = createNotificationService({ manager, registry, getProcess: () => info, deliver: e => delivered.push(e), now: () => 0 });
  const fire = () => handler({ type: 'process_output_changed', id: info.id, appendedText: [{ type: 'stdout', text: 'READY' }] });
  try {
    registry.register(info.id, { logMatches: [{ pattern: 'READY' }] }); fire(); assert.equal(delivered.length, 1);
    registry.appendWatches(info.id, [{ pattern: 'READY' }]);
    registry.removeWatches(info.id, [{ index: 0 }]);
    fire(); assert.equal(delivered.length, 2); // Newly appended duplicate is not the fired donor.
    fire(); assert.equal(delivered.length, 2);
    registry.replaceWatches(info.id, [{ pattern: 'READY' }]); fire(); assert.equal(delivered.length, 3);
    registry.clearWatches(info.id); fire(); assert.equal(delivered.length, 3);
    registry.appendWatches(info.id, [{ pattern: 'READY' }]); fire(); assert.equal(delivered.length, 4);
    service.dispose(); assert.equal(subscribed, false); fire(); assert.equal(delivered.length, 4);
  } finally { service.dispose(); }
});

test('NotificationThrottle delivers 20/minute then one context summary and cancels generation timers', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let now = 0; const delivered: ProcessNotificationDetails[] = [];
  const throttle = createNotificationThrottle(e => delivered.push(e), () => now);
  const payload: ProcessNotificationDetails = { kind: 'log_match', processId: 'owned-unit', processName: 'test', command: '', timestamp: 0, summary: 'match', attention: 'turn' };
  try {
    for (let i = 0; i < 23; i++) throttle.send(payload);
    assert.equal(delivered.length, 20);
    now = 59999; t.mock.timers.tick(59999); assert.equal(delivered.length, 20);
    now = 60000; t.mock.timers.tick(1);
    assert.equal(delivered.length, 21); assert.equal(delivered[20].kind, 'log_match_suppressed');
    assert.equal(delivered[20].suppressedCount, 3); assert.equal(delivered[20].attention, 'context');
    assert.equal(delivered[20].info, undefined);
    for (let i = 0; i < 21; i++) throttle.send(payload);
    assert.equal(delivered.length, 41);
    throttle.dispose(); now += 60000; t.mock.timers.tick(60000); throttle.send(payload);
    assert.equal(delivered.length, 41);
  } finally { throttle.dispose(); t.mock.timers.reset(); }
});

test('ProcessOutput upstream event buffers are bounded, split per stream, final-flushed and cancelable', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const logs = new ProcessLogStore(); const events: ManagerEvent[] = [];
  const output = new ProcessOutput({ emit: e => events.push(e) });
  const record = recordFixture('owned-output-unit', logs);
  try {
    output.onStdoutChunk(record, Buffer.from('REA'));
    output.onStderrChunk(record, Buffer.from('DY\n'));
    output.onStdoutChunk(record, Buffer.from('DY\n'));
    output.flush(record);
    const lines = events.flatMap(e => e.type === 'process_output_changed' ? e.appendedText ?? [] : []);
    assert.deepEqual(lines, [{ type: 'stderr', text: 'DY' }, { type: 'stdout', text: 'READY' }]);
    events.length = 0;
    output.onStdoutChunk(record, Buffer.from(('x'.repeat(40000) + '\n').repeat(3) + 'small\n'.repeat(5000)));
    assert.ok(record.appendedLines.length <= 4000);
    output.flush(record);
    for (const event of events) if (event.type === 'process_output_changed') {
      assert.ok((event.appendedText?.length ?? 0) <= 2000);
      assert.ok(event.appendedText?.every(line => Buffer.byteLength(line.text) <= 32 * 1024));
    }
    assert.ok(events.some(e => e.type === 'process_output_changed' && (e.droppedLines ?? 0) > 0));
    output.onStdoutChunk(record, Buffer.from('cancel\n')); output.clearAll();
    const count = events.length; t.mock.timers.tick(100); assert.equal(events.length, count);
  } finally { output.clearAll(); logs.cleanup(); t.mock.timers.reset(); }
});

test('runtime cleanup filesystem rejection is awaited, reported and idempotent', async () => {
  const rt = createRuntime(); const original = ProcessLogStore.prototype.cleanup; let owned: ProcessLogStore | undefined;
  try {
    const run = await rt.start(input('exit 0')); await terminal(rt, run.id);
    ProcessLogStore.prototype.cleanup = function () { owned = this; throw new Error('owned fixture cleanup failure'); };
    const disposal = rt.dispose(); assert.equal(rt.dispose(), disposal);
    await assert.rejects(disposal, /owned fixture cleanup failure/);
    await assert.rejects(rt.start(input('exit 0')), /disposed/);
  } finally { ProcessLogStore.prototype.cleanup = original; if (owned) original.call(owned); else await rt.dispose(); }
});

test('runtime early EOF watch retains event-time policy after terminal clear', async () => {
  const rt = createRuntime(); const events: RuntimeEvent[] = [];
  rt.subscribe(e => events.push(e));
  try {
    const run = await rt.start(input('printf FINAL', { notify: { onSuccess: 'ignore', logMatches: [{ pattern: 'FINAL' }] } }));
    await until(() => events, e => notices(e).length > 0);
    await terminal(rt, run.id);
    assert.equal(rt.clear(run.id), 1);
    assert.equal(notices(events).length, 1);
    const detail = notices(events)[0].details!;
    assert.equal(detail.kind === 'watch' && detail.run.notify.onSuccess, 'ignore');
    assert.equal(detail.kind !== 'suppression' && detail.run.id, run.id);
  } finally { await rt.dispose(); }
});

test('runtime rejects legacy regex in every watch update mode without mutation', async () => {
  const rt = createRuntime({ stopGraceMs: 60 });
  try {
    const run = await rt.start(input(node('process.stdin.resume()'), { notify: { logMatches: [{ pattern: 'KEEP' }] } }));
    for (const mode of ['append', 'replace', 'remove', 'clear'] as const) {
      assert.throws(() => rt.update(run.id, { name: 'not applied', watches: { mode, items: [{ index: 0, pattern: '(a+)+$', mode: 'regex' }] } }), /unsupported/);
    }
    assert.equal(rt.snapshot().runs[0].name, 'test');
    assert.deepEqual(rt.snapshot().runs[0].notify.logMatches, [{ pattern: 'KEEP' }]);
    await rt.write(run.id, '', true); await terminal(rt, run.id);
  } finally { await rt.dispose(); }
});

test('ProcessRuntimeController cleanup signal failures are bounded and reported without claiming exit', async () => {
  const logs = new ProcessLogStore(); const registry = new ProcessRegistry(); const output = new ProcessOutput({ emit() {} });
  const controller = new ProcessRuntimeController({ registry, logs, output, emit() {}, getConfiguredShellPath: () => undefined, stopGraceMs: 1 });
  const record = recordFixture('owned-signal-failure', logs);
  record.pid = 123456789; record.status = 'running'; record.ownerExited = false; record.closed = false; record.completed = false;
  record.child.exitCode = null; record.child.signalCode = null; record.endTime = null;
  registry.add(record);
  const kill = process.kill; const signals: unknown[] = [];
  process.kill = ((...args: unknown[]) => { signals.push(args); throw Object.assign(new Error('owned fixture EPERM'), { code: 'EPERM' }); }) as typeof process.kill;
  try {
    const disposal = controller.cleanup(); assert.equal(controller.cleanup(), disposal);
    await assert.rejects(disposal, /TERM failed:.*KILL failed:.*deadline exceeded/);
    assert.equal(record.status, 'running'); assert.equal(record.stopRequested, false); assert.equal(record.endTime, null);
    assert.deepEqual(signals, [[-record.pid, 'SIGTERM'], [-record.pid, 'SIGKILL']]);
  } finally { process.kill = kill; output.clearAll(); logs.cleanup(); }
});
