import assert from 'node:assert/strict';
import test from 'node:test';
import { KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
import { registerProcesses } from './index.ts';
import { SNAPSHOT_REQUEST, SNAPSHOT_EVENT } from './status.ts';
import type { Run, Runtime, RuntimeEvent } from './types.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
const run = (extra = {}): Run => ({ id: 'a', name: 'owned', command: 'true', cwd: '/', phase: 'running', startedAt: 1, stopRequested: false, acknowledged: false, notify: {}, ...extra });
function setup(mode = 'tui', hasUI = true) {
  const handlers = new Map<string, any>(), commands = new Map<string, any>(), bus = new Map<string, Set<any>>();
  const sent: any[] = [], statuses: any[] = [], notices: any[] = [], runtimes: any[] = [], events: any[] = [];
  let tool: any, component: any, customCalls = 0, doneCalls = 0;
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (d: any) => tool = d,
    registerCommand: (name: string, c: any) => commands.set(name, c),
    sendMessage: (...args: any[]) => sent.push(args),
    events: {
      on: (name: string, fn: any) => { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name)!.add(fn); return () => bus.get(name)!.delete(fn); },
      emit: (name: string, data: any) => { events.push([name, data]); for (const fn of bus.get(name) ?? []) { try { Promise.resolve(fn(data)).catch(() => {}); } catch {} } },
    },
  };
  const ctx: any = { mode, hasUI, cwd: '/test', ui: {
    theme: { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (s: string) => s },
    setStatus: (...args: any[]) => statuses.push(args), notify: (...args: any[]) => notices.push(args),
    custom: (factory: any, options: any) => {
      customCalls++; assert.equal(options.overlay, true);
      return new Promise<void>(resolve => {
        component = factory({ terminal: { rows: 24, columns: 100 }, requestRender() {} }, ctx.ui.theme, new KeybindingsManager(TUI_KEYBINDINGS), () => { doneCalls++; resolve(); });
        component.focused = true; component.render(100);
      });
    },
  } };
  const factory = (): Runtime => {
    const listeners = new Set<any>(), former: any[] = [];
    const item: any = { runs: [run()], disposed: 0, disposeWork: async () => {},
      snapshot: () => ({ version: 1, revision: 1, runs: structuredClone(item.runs), active: 1, unacknowledgedFailed: 0 }),
      subscribe: (fn: any) => { listeners.add(fn); former.push(fn); return () => listeners.delete(fn); },
      emit: (event: RuntimeEvent) => { for (const fn of listeners) fn(event); }, stale: (event: RuntimeEvent) => former.forEach(fn => fn(event)),
      start: async () => item.runs[0], output: async () => ({ text: 'out', rotated: false, truncated: false }),
      stop: async () => item.runs[0], acknowledge() {}, write: async () => {}, update: () => item.runs[0],
      clear: () => { item.emit({ type: 'notification', id: 'a', key: 'clear-warning', kind: 'completion', attention: 'turn', text: 'cleanup warning' }); return 1; },
      dispose: async () => { item.disposed++; await item.disposeWork(); }, listeners,
    };
    runtimes.push(item); return item;
  };
  registerProcesses(pi, factory, () => process.env.PI_CODING_AGENT_DIR!);
  return { pi, ctx, handlers, bus, sent, statuses, notices, runtimes, events, commands,
    start: () => handlers.get('session_start')({}, ctx), shutdown: () => handlers.get('session_shutdown')({}, ctx),
    open: () => commands.get('processes').handler('', ctx), tool: (params: any) => tool.execute('call', params, undefined, undefined, ctx),
    component: () => component, customCalls: () => customCalls, doneCalls: () => doneCalls };
}
const notification = (key: string, attention = 'turn'): any => ({ type: 'notification', id: 'a', key, kind: 'completion', attention, text: '\x1b]52;c;secret\x07complete' });

test('registration is lazy, no global shortcuts/footer replacements, one runtime and one protocol/status renderer per session', async () => {
  const f = setup(); assert.equal(f.runtimes.length, 0);
  assert.deepEqual([...f.commands.keys()], ['processes']);
  await f.start(); assert.equal(f.runtimes.length, 1); assert.equal(f.bus.get(SNAPSHOT_REQUEST)!.size, 1);
  assert.equal(f.events.filter(e => e[0] === SNAPSHOT_EVENT).length, 1);
  await f.tool({ action: 'list' }); assert.equal(f.runtimes.length, 1);
  await f.start(); assert.equal(f.runtimes[0].disposed, 1); assert.equal(f.runtimes[0].listeners.size, 0);
  assert.equal(f.bus.get(SNAPSHOT_REQUEST)!.size, 1); assert.equal(f.runtimes.length, 2);
  await f.shutdown(); assert.equal(f.bus.get(SNAPSHOT_REQUEST)!.size, 0); assert.deepEqual(f.statuses.at(-1), ['processes', undefined]);
  await f.shutdown(); assert.equal(f.runtimes[1].disposed, 1);
});

test('notification attention maps turn/context/ignore, dedups and rejects stale-generation callbacks', async () => {
  const f = setup(); await f.start(); const old = f.runtimes[0];
  old.emit(notification('one')); old.emit(notification('one')); old.emit(notification('two', 'context')); old.emit(notification('three', 'ignore'));
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[0][1], { triggerTurn: true, deliverAs: 'steer' });
  assert.deepEqual(f.sent[1][1], { triggerTurn: false, deliverAs: 'nextTurn' });
  assert.equal(f.sent[0][0].content, 'complete');
  await f.start(); old.stale(notification('stale')); assert.equal(f.sent.length, 2);
  f.runtimes[1].emit(notification('one')); assert.equal(f.sent.length, 3, 'dedup is session scoped');
  f.pi.sendMessage = () => { throw Error('delivery failed'); };
  f.runtimes[1].emit(notification('error')); assert.match(f.notices.at(-1)[0], /notification failed: delivery failed/);
  await f.shutdown();
});

test('UI clear preserves genuine runtime completion policy; shutdown closes overlay and removes its subscriptions', async () => {
  const f = setup(); await f.start(); const r = f.runtimes[0]; r.runs = [run({ phase: 'terminal', outcome: 'failed' })];
  const opening = f.open(); const ui = f.component(); ui.handleInput('\r'); ui.render(100); ui.handleInput('c'); ui.render(100); ui.handleInput('y'); await tick();
  assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0][1], { triggerTurn: true, deliverAs: 'steer' });
  await f.shutdown(); await opening; assert.equal(r.listeners.size, 0); assert.equal(f.doneCalls(), 1);
});

for (const action of ['write', 'eof'] as const) test(`UI ${action} preserves turn/context completion and watch policy before and after write settles`, async () => {
  const f = setup(); await f.start(); const r = f.runtimes[0];
  let settle: () => void = () => {};
  const writes: unknown[][] = [];
  r.write = (...args: unknown[]) => { writes.push(args); return new Promise<void>(resolve => { settle = resolve; }); };
  const opening = f.open(), ui = f.component();
  const press = (key: string) => { ui.render(100); ui.handleInput(key); ui.render(100); };
  try {
    press('\r'); press(action === 'write' ? 'w' : 'e');
    if (action === 'write') { press('payload'); press('\r'); }
    press('y');
    assert.deepEqual(writes, [['a', action === 'write' ? 'payload' : '', action === 'eof']]);
    assert.equal(f.sent.length, 0, 'immediate navigation/control feedback emits no model message');
    for (const timing of ['pending', 'settled']) {
      if (timing === 'settled') { settle(); await tick(); }
      for (const kind of ['completion', 'watch']) for (const attention of ['turn', 'context']) {
        const event = { ...notification(`${timing}:${kind}:${attention}`, attention), kind };
        const before = f.sent.length;
        r.emit(event); r.emit(event);
        assert.equal(f.sent.length, before + 1, 'notification remains deduplicated');
        assert.equal(f.sent.at(-1)[0].details.attention, attention);
        assert.equal(f.sent.at(-1)[0].details.kind, kind);
        assert.deepEqual(f.sent.at(-1)[1], attention === 'turn'
          ? { triggerTurn: true, deliverAs: 'steer' } : { triggerTurn: false, deliverAs: 'nextTurn' });
      }
    }
    await f.start();
    r.stale(notification('stale-after-ui-action'));
    assert.equal(f.sent.length, 8, 'replacement rejects old runtime notifications');
  } finally { settle(); await f.shutdown(); await opening; }
});

test('replacement while tool completion pending discards result and old session cannot reinitialize after shutdown', async () => {
  const f = setup(); await f.start(); let resolve: any;
  f.runtimes[0].start = () => new Promise(r => resolve = r);
  const pending = f.tool({ action: 'start', name: 'test', command: 'true' });
  await f.start(); resolve(run()); await assert.rejects(pending, /session changed/);
  await f.shutdown(); await assert.rejects(f.tool({ action: 'list' }), /session is closing/);
});

test('overlapping lifecycle completions discard stale initialization and report dispose failures honestly', async () => {
  const f = setup(); await f.start(); let resolve: any;
  f.runtimes[0].disposeWork = () => new Promise(r => resolve = r);
  const replacing = f.start(); const shuttingDown = f.shutdown();
  let ended = false; void shuttingDown.then(() => { ended = true; });
  await tick(); assert.equal(ended, false, 'shutdown waits for prior disposal');
  resolve(); await replacing; await shuttingDown; assert.equal(f.runtimes.length, 1);
  await f.start(); f.runtimes[1].disposeWork = async () => { throw Error('descendants may still be running'); };
  await f.shutdown(); assert.match(f.notices.at(-1)[0], /Process cleanup failed: descendants may still be running/);
  assert.deepEqual(f.statuses.at(-1), ['processes', undefined]);
});

test('headless/RPC commands list without custom UI or model turn and tool works before session_start', async () => {
  for (const [mode, hasUI] of [['rpc', true], ['json', false]] as const) {
    const f = setup(mode, hasUI), lines: any[] = [];
    const log = console.error; console.error = (...args: any[]) => { lines.push(args); };
    try {
      await f.tool({ action: 'list' }); assert.equal(f.runtimes.length, 1);
      await f.open(); assert.equal(f.customCalls(), 0); assert.equal(f.sent.length, 0);
      assert.match(hasUI ? f.notices[0][0] : lines[0][0], /a · owned · running/);
    } finally { console.error = log; await f.shutdown(); }
  }
});

test('reopening creates fresh interaction without stale async finalizer closing its replacement', async () => {
  const f = setup(); await f.start(); const first = f.open(), old = f.component();
  await f.start(); const second = f.open(), fresh = f.component(); assert.notEqual(fresh, old);
  await first; assert.equal(f.customCalls(), 2); assert.equal(f.doneCalls(), 1);
  fresh.handleInput('\x1b'); await second; assert.equal(f.doneCalls(), 2); await f.shutdown();
});
