import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachStatus, readDefaultStatus, safeData, safeText, statusText, SNAPSHOT_EVENT, SNAPSHOT_REQUEST } from './status.ts';
import type { Snapshot, Run } from './types.ts';

const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
const run = (phase: Run['phase'], extra = {}): Run => ({ id: 'a', name: 'test', command: 'true', cwd: '/', phase, startedAt: 1, notify: {}, stopRequested: false, acknowledged: false, ...extra });
const snap = (runs: Run[]): Snapshot => ({ version: 1, revision: 1, runs, active: 999, unacknowledgedFailed: 999 });

test('status counts all active phases and only unacknowledged failures, semantic colors, omission and hide', () => {
  assert.equal(statusText(snap([]), theme as any), undefined);
  const runs = ['starting', 'running', 'stopping', 'stop-timeout'].map(phase => run(phase as Run['phase']));
  assert.equal(statusText(snap(runs), theme as any), '<success>4 active</success>');
  runs.push(run('terminal', { outcome: 'failed' }), run('terminal', { outcome: 'failed', acknowledged: true }), run('terminal', { outcome: 'successful' }), run('terminal', { outcome: 'user-stopped' }));
  assert.equal(statusText(snap(runs), theme as any), '<success>4 active</success> · <error>1 failed</error>');
  assert.equal(statusText(snap([run('terminal', { outcome: 'failed' })]), theme as any), '<error>1 failed</error>');
  assert.equal(statusText(snap([run('terminal', { outcome: 'failed', acknowledged: true })]), theme as any), undefined);
});

test('independent sanitizer strips CSI/OSC/DCS/C1, incomplete sequences, CR and bidi; preserves Unicode', () => {
  assert.equal(safeText('界😀é\x1b[31mRED\x1b[0m\x1b]52;c;SECRET\x07ok\x1bPhidden\x1b\\\u202eevil\r\n\t'), '界😀éREDokevil     ');
  assert.equal(safeText('a\x9dhidden\x9cb\x9b31mc\x90hidden\x9cd'), 'abcd');
  assert.equal(safeText('safe\x1b]incomplete'), 'safe');
  assert.equal(safeText('a\nb', true), 'a\nb');
});

test('structured data preserves allowed tabs without expanding bounded output; display text expands separately', () => {
  const input = { text: '\t界\n\x1b]52;c;hidden\x07\tend\r\u202e' };
  const clean = safeData(input);
  assert.deepEqual(clean, { text: '\t界\n\tend' });
  assert.equal(safeText(clean.text, true), '    界\n    end');
  assert.ok(Buffer.byteLength(clean.text) <= Buffer.byteLength(input.text));
});

test('status configuration disables only renderer, validates malformed config and handles absence', () => {
  const root = mkdtempSync(join(tmpdir(), 'process-status-')), errors: string[] = [];
  try {
    assert.equal(readDefaultStatus(root, s => errors.push(s)), true);
    writeFileSync(join(root, 'processes.json'), '{"defaultStatus":false}');
    assert.equal(readDefaultStatus(root, s => errors.push(s)), false);
    writeFileSync(join(root, 'processes.json'), '{"defaultStatus":"no"}');
    assert.equal(readDefaultStatus(root, s => errors.push(s)), true);
    assert.match(errors[0], /defaultStatus must be boolean/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('versioned protocol clones replies/events, validates requests, isolates receiver failures and unsubscribes', async () => {
  const callbacks = new Map<string, (data: any) => void>();
  const emitted: any[] = [], statuses: any[] = [];
  const snapshot = snap([run('running', { name: '\x1b]52;c;secret\x07safe' })]);
  let fail = false;
  const pi = { events: { on: (key: string, cb: any) => { callbacks.set(key, cb); return () => callbacks.delete(key); }, emit: (key: string, data: any) => { emitted.push([key, data]); if (fail) throw Error('listener'); } } } as any;
  const ctx = { hasUI: true, ui: { theme, setStatus: (...args: any[]) => statuses.push(args) } } as any;
  const status = attachStatus(pi, ctx, () => snapshot, false);
  const request = callbacks.get(SNAPSHOT_REQUEST)!;
  let replies = 0;
  for (const bad of [null, {}, { version: 2, reply: () => replies++ }, { version: 1, reply: 'bad' }]) request(bad);
  assert.equal(replies, 0);
  request({ version: 1, reply: (s: any) => { replies++; assert.equal(s.runs[0].name, 'safe'); s.runs.length = 0; } });
  assert.equal(snapshot.runs.length, 1);
  request({ version: 1, reply: () => { throw Error('sync'); } });
  request({ version: 1, reply: () => Promise.reject(Error('async')) });
  status.publish(snapshot);
  assert.deepEqual(statuses, [['processes', undefined]]);
  assert.equal(emitted[0][0], SNAPSHOT_EVENT);
  emitted[0][1].runs.length = 0;
  assert.equal(snapshot.runs.length, 1);
  fail = true; status.publish(snapshot);
  status.dispose(); status.dispose(); status.publish(snapshot);
  request({ version: 1, reply: () => replies++ });
  assert.equal(replies, 1); assert.equal(callbacks.size, 0);
  assert.deepEqual(statuses.at(-1), ['processes', undefined]);
  await new Promise(resolve => setImmediate(resolve));
});
