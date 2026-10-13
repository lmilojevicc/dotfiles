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
  const ctx = { hasUI: true, mode: 'tui', ui: { theme, setStatus: (...args: any[]) => statuses.push(args) } } as any;
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
  const broadcast = emitted.find(([key]) => key === SNAPSHOT_EVENT);
  assert.ok(broadcast);
  broadcast[1].runs.length = 0;
  assert.equal(snapshot.runs.length, 1);
  fail = true; status.publish(snapshot);
  status.dispose(); status.dispose(); status.publish(snapshot);
  request({ version: 1, reply: () => replies++ });
  assert.equal(replies, 1); assert.equal(callbacks.size, 0);
  assert.deepEqual(statuses.at(-1), ['processes', undefined]);
  await new Promise(resolve => setImmediate(resolve));
});

const VARIABLE_CAPABILITY = 'zentui:variable-capability';
const VARIABLE_EVENT = 'zentui:variable';
const STATUS_VARIABLE = 'pi-processes:status';
const activeCapability = { supported: true, active: true, version: 1 };

function statusHarness(enabled = true, mode = 'tui', hasUI = true) {
  const callbacks = new Map<string, (data: any) => void>();
  const emitted: [string, any][] = [], statuses: any[][] = [], probes: any[] = [];
  const snapshot = snap([run('running')]);
  const receivers = {
    capability: undefined as Record<string, unknown> | undefined,
    onEmit: (_key: string, _data: any) => {},
    onStatus: () => {},
  };
  const pi = { events: {
    on: (key: string, cb: any) => { callbacks.set(key, cb); return () => { callbacks.delete(key); }; },
    emit: (key: string, data: any) => {
      emitted.push([key, data]);
      if (key === VARIABLE_CAPABILITY) { probes.push({ ...data }); Object.assign(data, receivers.capability); }
      receivers.onEmit(key, data);
    },
  } } as any;
  const ctx = { hasUI, mode, ui: { theme, setStatus: (...args: any[]) => { statuses.push(args); receivers.onStatus(); } } } as any;
  return {
    callbacks, emitted, statuses, probes, snapshot,
    events: (key: string) => emitted.filter(([event]) => event === key).map(([, data]) => data),
    status: attachStatus(pi, ctx, () => snapshot, enabled),
    setCapability: (value: typeof receivers.capability) => { receivers.capability = value; },
    setEmit: (fn: typeof receivers.onEmit) => { receivers.onEmit = fn; },
    setStatus: (fn: typeof receivers.onStatus) => { receivers.onStatus = fn; },
  };
}

test('attachStatus retains fallback for absent, inactive and unsupported Zentui protocol', () => {
  for (const capability of [undefined,
    { supported: true, active: false, version: 1 },
    { supported: false, active: true, version: 1 },
    { supported: true, active: true, version: 2 },
    { supported: true, active: true },
    { supported: 1, active: true, version: 1 },
    { supported: true, active: 'true', version: 1 },
    { supported: true, active: true, version: '1' },
  ]) {
    const h = statusHarness(); h.setCapability(capability);
    h.status.publish(h.snapshot);
    assert.deepEqual(h.probes, [{ supported: false, active: false, key: STATUS_VARIABLE }]);
    assert.deepEqual(h.events(VARIABLE_EVENT), []);
    assert.deepEqual(h.statuses, [['processes', '<success>1 active</success>']]);
    assert.equal(h.events(SNAPSHOT_EVENT).length, 1);
    h.status.dispose();
  }
});

test('attachStatus publishes current compact semantic colors and clears only its own footer fallback', () => {
  const h = statusHarness(); h.setCapability(activeCapability);
  const runs = ['starting', 'running', 'stopping', 'stop-timeout'].map(phase => run(phase as Run['phase']));
  runs.push(run('terminal', { outcome: 'failed' }), run('terminal', { outcome: 'failed', acknowledged: true }));
  const snapshot = snap(runs);
  h.status.publish(snapshot);
  assert.deepEqual(h.events(VARIABLE_EVENT), [{ key: STATUS_VARIABLE, text: '<success>4 active</success> · <error>1 failed</error>' }]);
  assert.deepEqual(h.statuses, [['processes', undefined]]);
  assert.deepEqual(h.events(SNAPSHOT_EVENT), [snapshot]);
  h.status.dispose();
});

test('attachStatus retries demand each refresh, clears inactive publication and resumes fallback', () => {
  const h = statusHarness();
  h.status.publish(h.snapshot); // Startup before Zentui becomes active.
  h.setCapability(activeCapability); h.status.publish(h.snapshot);
  h.setCapability({ ...activeCapability, active: false }); h.status.publish(h.snapshot);
  assert.deepEqual(h.events(VARIABLE_EVENT), [
    { key: STATUS_VARIABLE, text: '<success>1 active</success>' },
    { key: STATUS_VARIABLE, text: undefined },
  ]);
  assert.deepEqual(h.statuses, [
    ['processes', '<success>1 active</success>'], ['processes', undefined], ['processes', '<success>1 active</success>'],
  ]);
  h.status.publish(h.snapshot);
  assert.equal(h.events(VARIABLE_EVENT).length, 2); // Already cleared.
  h.setCapability(activeCapability); h.status.publish(h.snapshot);
  assert.equal(h.events(VARIABLE_EVENT).at(-1).text, '<success>1 active</success>');
  assert.equal(h.probes.length, 5);
  assert.equal(h.events(SNAPSHOT_EVENT).length, 5);
  h.status.dispose();
});

test('attachStatus clears custom counts on zero and acknowledgement', () => {
  const h = statusHarness(); h.setCapability(activeCapability);
  h.status.publish(h.snapshot);
  h.status.publish(snap([]));
  h.status.publish(snap([run('terminal', { outcome: 'failed' })]));
  h.status.publish(snap([run('terminal', { outcome: 'failed', acknowledged: true })]));
  assert.deepEqual(h.events(VARIABLE_EVENT).map(value => value.text), [
    '<success>1 active</success>', undefined, '<error>1 failed</error>', undefined,
  ]);
  assert.ok(h.statuses.every(([key, text]) => key === 'processes' && text === undefined));
  h.status.dispose();
  assert.equal(h.events(VARIABLE_EVENT).length, 4); // Zero already removed the value.
});

test('attachStatus defaultStatus false disables only footer, not custom publication or snapshot protocol', () => {
  const h = statusHarness(false);
  h.status.publish(h.snapshot);
  h.setCapability(activeCapability); h.status.publish(h.snapshot);
  h.setCapability({ ...activeCapability, active: false }); h.status.publish(h.snapshot);
  assert.deepEqual(h.statuses, Array.from({ length: 3 }, () => ['processes', undefined]));
  assert.deepEqual(h.events(VARIABLE_EVENT), [
    { key: STATUS_VARIABLE, text: '<success>1 active</success>' }, { key: STATUS_VARIABLE, text: undefined },
  ]);
  assert.equal(h.events(SNAPSHOT_EVENT).length, 3);
  let reply: Snapshot | undefined;
  h.callbacks.get(SNAPSHOT_REQUEST)!({ version: 1, reply: (value: Snapshot) => { reply = value; } });
  assert.deepEqual(reply, h.snapshot);
  assert.notEqual(reply, h.snapshot);
  h.status.dispose();
});

test('attachStatus leaves headless and RPC behavior intact without Zentui events', () => {
  for (const [mode, hasUI] of [['print', false], ['rpc', true]] as const) {
    const h = statusHarness(true, mode, hasUI); h.setCapability(activeCapability);
    h.status.publish(h.snapshot);
    assert.deepEqual(h.probes, []);
    assert.deepEqual(h.events(VARIABLE_EVENT), []);
    assert.deepEqual(h.statuses, hasUI ? [['processes', '<success>1 active</success>']] : []);
    assert.equal(h.events(SNAPSHOT_EVENT).length, 1);
    h.status.dispose();
  }
});

test('attachStatus disposal clears published variable, is idempotent and guards stale callbacks', () => {
  const h = statusHarness(); h.setCapability(activeCapability);
  const request = h.callbacks.get(SNAPSHOT_REQUEST)!;
  h.status.publish(h.snapshot);
  h.status.dispose();
  assert.deepEqual(h.events(VARIABLE_EVENT), [
    { key: STATUS_VARIABLE, text: '<success>1 active</success>' }, { key: STATUS_VARIABLE, text: undefined },
  ]);
  assert.equal(h.callbacks.size, 0);
  const before = [h.emitted.length, h.statuses.length];
  h.status.dispose(); h.status.publish(h.snapshot);
  request({ version: 1, reply: () => assert.fail('Disposed request replied') });
  assert.deepEqual([h.emitted.length, h.statuses.length], before);
});

test('attachStatus isolates capability, publisher, footer and snapshot receiver exceptions', () => {
  for (const failedEvent of [VARIABLE_CAPABILITY, VARIABLE_EVENT, SNAPSHOT_EVENT, 'setStatus']) {
    const h = statusHarness(); h.setCapability(activeCapability);
    h.setEmit(key => { if (key === failedEvent) throw Error('receiver'); });
    h.setStatus(() => { if (failedEvent === 'setStatus') throw Error('footer'); });
    assert.doesNotThrow(() => h.status.publish(h.snapshot));
    assert.equal(h.events(SNAPSHOT_EVENT).length, 1);
    assert.deepEqual(h.statuses, [['processes', [VARIABLE_CAPABILITY, VARIABLE_EVENT].includes(failedEvent) ? '<success>1 active</success>' : undefined]]);
    let replies = 0;
    h.callbacks.get(SNAPSHOT_REQUEST)!({ version: 1, reply: () => { replies++; } });
    assert.equal(replies, 1);
    h.setEmit(() => {}); h.setStatus(() => {});
    h.status.publish(h.snapshot); // Receiver recovery is retried, not latched off.
    assert.equal(h.events(VARIABLE_EVENT).at(-1).text, '<success>1 active</success>');
    h.status.dispose();
    assert.equal(h.events(VARIABLE_EVENT).at(-1).text, undefined);
  }
});

test('attachStatus retries a failed inactive clear and isolates disposal clear failures', () => {
  const h = statusHarness(); h.setCapability(activeCapability); h.status.publish(h.snapshot);
  h.setCapability(undefined);
  h.setEmit(key => { if (key === VARIABLE_EVENT) throw Error('clear'); });
  h.status.publish(h.snapshot);
  assert.equal(h.statuses.at(-1)![1], '<success>1 active</success>');
  h.setEmit(() => {}); h.status.publish(h.snapshot);
  assert.equal(h.events(VARIABLE_EVENT).length, 3);
  assert.equal(h.events(VARIABLE_EVENT).at(-1).text, undefined);
  h.setCapability(activeCapability); h.status.publish(h.snapshot);
  h.setEmit(key => { if (key === VARIABLE_EVENT) throw Error('dispose clear'); });
  assert.doesNotThrow(() => h.status.dispose());
  assert.equal(h.callbacks.size, 0);
  assert.deepEqual(h.statuses.at(-1), ['processes', undefined]);
  const count = h.emitted.length;
  h.status.dispose(); h.status.publish(h.snapshot);
  assert.equal(h.emitted.length, count);
});

test('attachStatus stops publication if a protocol receiver disposes it during dispatch', () => {
  for (const disposeEvent of [VARIABLE_CAPABILITY, VARIABLE_EVENT]) {
    const h = statusHarness(); h.setCapability(activeCapability);
    h.setEmit((key, data) => { if (key === disposeEvent && (key !== VARIABLE_EVENT || data.text !== undefined)) h.status.dispose(); });
    h.status.publish(h.snapshot);
    assert.deepEqual(h.statuses, [['processes', undefined]]);
    assert.deepEqual(h.events(SNAPSHOT_EVENT), []);
    assert.equal(h.callbacks.size, 0);
    if (disposeEvent === VARIABLE_EVENT) assert.equal(h.events(VARIABLE_EVENT).at(-1).text, undefined);
    const count = h.emitted.length;
    h.status.publish(h.snapshot); h.status.dispose();
    assert.equal(h.emitted.length, count);
  }
});
