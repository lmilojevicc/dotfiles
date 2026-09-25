import assert from 'node:assert/strict';
import test from 'node:test';
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from '@earendil-works/pi-tui';
import { createUIState, ProcessesUI } from './ui.ts';
import type { Run, Runtime, RuntimeEvent, Snapshot } from './types.ts';
const enter = '\r', esc = '\x1b', down = '\x1b[B', up = '\x1b[A';
const tick = () => new Promise(resolve => setImmediate(resolve));
const run = (id: string, extra = {}): Run => ({ id, name: id, command: 'echo test', cwd: '/safe', phase: 'running', startedAt: 1, acknowledged: false, stopRequested: false, notify: {}, ...extra });
function setup(initial = [run('a'), run('b')], overrides: any = {}, options: any = {}) {
  let runs = initial, revision = 0, height = 18, width = 100, closed = 0, renders = 0;
  let text = Array.from({ length: 30 }, (_, n) => `line ${n}`).join('\n');
  const listeners = new Set<(e: RuntimeEvent) => void>(), calls: any[] = [];
  const snapshot = (): Snapshot => ({ version: 1, revision, runs, active: 0, unacknowledgedFailed: 0 });
  const emit = (event: RuntimeEvent) => listeners.forEach(fn => fn(event));
  const runtime = {
    snapshot, subscribe: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
    output: async (id: string, query: any) => { calls.push(['output', id, query]); return { text, rotated: false, truncated: false }; },
    stop: async (...args: any[]) => { calls.push(['stop', ...args]); return runs[0]; },
    write: async (...args: any[]) => { calls.push(['write', ...args]); },
    acknowledge: (id: string) => { calls.push(['ack', id]); },
    clear: (id: string) => { calls.push(['clear', id]); return 1; },
    ...overrides,
  } as Runtime;
  const state = createUIState();
  const component = new ProcessesUI({ runtime, state, theme: { fg: (_color: string, text: string) => text, bold: (s: string) => s } as any,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS), getHeight: () => height, getWidth: () => width,
    onClose: () => closed++, onChange: () => renders++, act: async (_id, action) => action(), ...options });
  component.focused = true;
  const render = () => component.render(width).join('\n');
  render();
  return { component, state, calls, runtime, render, snapshot,
    update(next: Run[]) { runs = next; revision++; emit({ type: 'snapshot', snapshot: snapshot() }); },
    output(next: string) { text = next; emit({ type: 'output', id: state.selected! }); },
    dimensions(w: number, h: number) { width = w; height = h; }, closed: () => closed, renders: () => renders, listeners };
}
const details = (f: ReturnType<typeof setup>) => { f.component.handleInput(enter); f.render(); };
const logs = async (f: ReturnType<typeof setup>) => { details(f); f.component.handleInput(enter); await tick(); f.render(); };

test('TUI list/details/logs navigation preserves selected ID through reorder and supports contextual search/help/back', async () => {
  const f = setup();
  f.component.handleInput(down); assert.equal(f.state.selected, 'b');
  f.update([run('b'), run('a')]); assert.equal(f.state.selected, 'b');
  f.render(); details(f);
  assert.match(f.render(), /\$ echo test/); assert.match(f.render(), /cwd: \/safe/);
  f.component.handleInput('?'); assert.match(f.render(), /Start\/rerun via process tool/);
  f.component.handleInput(esc); f.render(); f.component.handleInput(enter); await tick();
  assert.match(f.render(), /Retained tail/);
  f.component.handleInput(esc); assert.match(f.render(), /cwd:/);
  f.component.handleInput(esc); f.render(); f.component.handleInput('/'); f.component.handleInput('a'); f.component.handleInput(enter);
  assert.equal(f.state.query, 'a');
  f.render(); f.component.handleInput(esc); assert.equal(f.closed(), 1); assert.equal(f.listeners.size, 0);
});

test('log follow scroll pause freezes view, new output never jumps, stream/query and back preserve state', async () => {
  const f = setup(); await logs(f);
  assert.match(f.render(), /line 29/);
  f.component.handleInput(up); const paused = f.render();
  assert.match(paused, /paused/); assert.doesNotMatch(paused, /line 29/);
  f.output('new only'); await tick();
  assert.match(f.render(), /\+new/); assert.match(f.render(), /line 28/); assert.doesNotMatch(f.render(), /new only/);
  f.component.handleInput(esc); f.render(); f.component.handleInput(enter); await tick();
  assert.match(f.render(), /line 28/);
  f.component.handleInput('f'); await tick(); assert.match(f.render(), /new only/);
  f.component.handleInput('t'); await tick(); assert.match(f.render(), /stdout/);
  f.component.handleInput('/'); f.component.handleInput('needle'); f.component.handleInput(enter); await tick();
  assert.equal(f.calls.at(-1)[2].pattern, 'needle'); assert.equal(f.calls.at(-1)[2].mode, 'literal');
  f.component.dispose();
});

test('details requires visible contextual confirmations, no start/rerun, ack and terminal-only clear', async () => {
  const f = setup(); details(f);
  for (const key of ['c', 'k', 'r', 'n']) { f.component.handleInput(key); f.render(); }
  assert.equal(f.calls.length, 0);
  f.component.handleInput('s'); f.component.handleInput('y'); assert.equal(f.calls.length, 0, 'unrendered confirmation');
  assert.match(f.render(), /SIGTERM/); f.component.handleInput('n'); f.render(); assert.equal(f.calls.length, 0);
  f.component.handleInput('s'); f.render(); f.component.handleInput('y'); await tick();
  assert.deepEqual(f.calls.pop(), ['stop', 'a', false]);
  f.update([run('a', { phase: 'stop-timeout' })]); f.render(); f.component.handleInput('k');
  assert.match(f.render(), /SIGKILL/); f.component.handleInput('y'); await tick();
  assert.deepEqual(f.calls.pop(), ['stop', 'a', true]);
  f.update([run('a', { phase: 'terminal', outcome: 'failed', error: 'Tracked shell exited; descendants may still be running.' })]);
  assert.match(f.render(), /descendants may still be running/);
  f.component.handleInput('a'); assert.deepEqual(f.calls.pop(), ['ack', 'a']); f.render();
  f.component.handleInput('c'); assert.match(f.render(), /Delete record and retained logs/);
  f.component.handleInput('y'); await tick(); assert.deepEqual(f.calls.pop(), ['clear', 'a']);
  f.component.dispose();
});

test('explicit stdin text/EOF is scoped to selected ID with Input focus and IME marker', async () => {
  const f = setup(); details(f); f.component.handleInput('w');
  assert.ok(f.render().includes(CURSOR_MARKER));
  f.component.focused = false; assert.ok(!f.render().includes(CURSOR_MARKER));
  f.component.focused = true;
  f.component.handleInput('界 exact'); f.component.handleInput(enter);
  assert.equal(f.calls.length, 0); assert.match(f.render(), /no newline/);
  f.component.handleInput('y'); await tick(); assert.deepEqual(f.calls.pop(), ['write', 'a', '界 exact', false]);
  f.render(); f.component.handleInput('e'); assert.match(f.render(), /EOF/); f.component.handleInput('y'); await tick();
  assert.deepEqual(f.calls.pop(), ['write', 'a', '', true]); f.component.dispose();
});

test('async action/output errors remain visible, stale/disposed output never repaints', async () => {
  let resolve: (x: any) => void = () => {};
  const f = setup([run('a')], { stop: async () => { throw Error('\x1b[31mdenied'); }, output: () => new Promise(r => { resolve = r; }) });
  details(f); f.component.handleInput('s'); f.render(); f.component.handleInput('y'); await tick();
  assert.match(f.render(), /Error: denied/); assert.doesNotMatch(f.render(), /\x1b\[31m/);
  f.component.handleInput(enter); f.render(); f.component.handleInput(esc); const before = f.renders();
  resolve({ text: 'STALE', rotated: true, truncated: true }); await tick(); assert.equal(f.renders(), before);
  f.render(); f.component.handleInput(enter); f.component.dispose(); const after = f.renders();
  resolve({ text: 'DISPOSED', rotated: false, truncated: false }); await tick(); assert.equal(f.renders(), after);
  const bad = setup([run('a')], { output: async () => { throw Error('read failed'); } });
  await logs(bad); assert.match(bad.render(), /read failed/); bad.component.dispose();
});

test('malicious snapshot/output fields are independently sanitized, Unicode/narrow dimensions remain bounded', async () => {
  const attack = '\x1b]52;c;SECRET\x07\x1bPPRIVATE\x1b\\\x1b[31m界😀é\u202e\r\n';
  const f = setup([run('a', { name: attack, cwd: attack, command: attack, phase: 'terminal', outcome: 'failed', error: attack })], { output: async () => ({ text: attack, rotated: true, truncated: true }) });
  details(f); assert.doesNotMatch(f.render(), /SECRET|PRIVATE|\x1b|\u202e/);
  f.component.handleInput(enter); await tick();
  assert.match(f.render(), /rotated · truncated/); assert.doesNotMatch(f.render(), /SECRET|PRIVATE|\x1b|\u202e/);
  for (const height of [1, 2, 5, 6, 12, 20]) for (const width of [0, 1, 2, 8, 23, 24, 40, 80]) {
    f.dimensions(width, height); const lines = f.component.render(width);
    assert.ok(lines.length <= height);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${width}x${height}`);
  }
  f.component.dispose();
});

test('tiny/resized/unrendered selection cannot mutate, removed selection never retargets confirmation', async () => {
  const f = setup(); details(f);
  f.dimensions(1, 1); f.component.handleInput('s'); f.component.handleInput('y'); assert.equal(f.calls.length, 0);
  f.render(); f.dimensions(100, 18); f.render(); f.component.handleInput('s'); f.render();
  f.update([run('b')]); f.render(); f.component.handleInput('y'); await tick(); assert.equal(f.calls.length, 0);
  assert.equal(f.state.selected, 'b'); f.component.dispose();
});

test('segmented bracketed paste cannot activate controls or confirm destructive operations', async () => {
  const f = setup(); details(f);
  f.component.handleInput('\x1b[200~'); f.component.handleInput('s'); f.component.handleInput('\x1b[201'); f.component.handleInput('~');
  assert.doesNotMatch(f.render(), /Confirm stop/);
  f.component.handleInput('s'); f.render();
  f.component.handleInput('\x1b[200~'); f.component.handleInput('y'); f.component.handleInput('\x1b[201~'); await tick();
  assert.equal(f.calls.length, 0);
  f.component.handleInput('y'); await tick(); assert.deepEqual(f.calls.pop(), ['stop', 'a', false]); f.component.dispose();
});

test('minimum usable layout preserves destructive warning and contextual help remains scrollable', () => {
  const f = setup([run('a', { phase: 'terminal', outcome: 'failed' })]); details(f);
  f.dimensions(24, 6); f.render(); f.component.handleInput('c');
  assert.match(f.render(), /Delete record and\nretained logs\?/);
  f.component.handleInput(esc); f.render(); f.component.handleInput('?'); f.render();
  for (let i = 0; i < 6; i++) { f.component.handleInput(down); f.render(); }
  assert.match(f.render(), /Start\/rerun via process/);
  f.component.dispose();
});

test('injected navigation/input bindings and hints are honored without installing global shortcuts', () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    'tui.select.confirm': 'ctrl+s', 'tui.select.down': 'ctrl+n', 'tui.select.cancel': 'ctrl+q', 'tui.input.submit': 'ctrl+g',
  });
  const f = setup(undefined, {}, { keybindings });
  assert.match(f.render(), /ctrl\+s details/);
  f.component.handleInput('\x0e'); assert.equal(f.state.selected, 'b');
  f.render(); f.component.handleInput('\x13'); assert.match(f.render(), /cwd:/);
  f.component.handleInput('\x11'); f.render(); f.component.handleInput('/'); f.component.handleInput('owned');
  assert.match(f.render(), /ctrl\+g apply/); f.component.handleInput('\x07'); assert.equal(f.state.query, 'owned');
  f.render(); f.component.handleInput('\x11'); assert.equal(f.closed(), 1);
});
