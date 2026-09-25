import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
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
  const component = new ProcessesUI({ runtime, state, theme: { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (s: string) => s } as any,
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
  f.update([run('a', { phase: 'stop-timeout' })]); f.render(); f.component.handleInput('x');
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
  assert.match(f.render(), /Delete record and *\nretained logs\?/);
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

const ansiTheme = {
  fg: (color: string, text: string) => `\x1b[${color === 'success' ? 32 : color === 'error' ? 31 : color === 'accent' ? 36 : 90}m${text}\x1b[39m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const plain = (text: string) => stripVTControlCharacters(text);

test('context-style frame aligns themed borders, Unicode and selected background without stale theme strings', () => {
  let accent = 36;
  const theme = { ...ansiTheme, fg: (color: string, text: string) => color === 'accent' ? `\x1b[${accent}m${text}\x1b[39m` : ansiTheme.fg(color, text) };
  const f = setup([run('a', { name: '编译 👩🏽‍💻 é' }), run('b', { phase: 'terminal', outcome: 'failed' })], {}, { theme });
  for (const width of [40, 80, 120]) {
    f.dimensions(width, 18);
    const lines = f.component.render(width), text = lines.join('\n');
    assert.match(plain(lines[0]), /^╭─+╮$/); assert.match(plain(lines.at(-1)!), /^╰─+╯$/);
    assert.ok(lines.every(line => visibleWidth(line) === width));
    assert.equal(lines.length, 7 + (width === 40 ? 2 : 1));
    assert.match(text, /\x1b\[32mrunning/); assert.match(text, /\x1b\[31mfailed/);
    const selection = lines.find(line => line.includes('›'))!;
    assert.match(selection, /\x1b\[44m/); assert.match(plain(selection), /编译 👩🏽‍💻 é/);
    assert.equal(visibleWidth(selection.slice(selection.indexOf('\x1b[44m'), selection.indexOf('\x1b[49m'))), width - 2);
  }
  accent = 35; f.component.invalidate();
  assert.match(f.render(), /\x1b\[35mProcesses/); assert.doesNotMatch(f.render(), /\x1b\[36mProcesses/);
  f.component.dispose();
});

test('selected-row background survives truncation resets through ellipsis and padding, but not borders', () => {
  const backgrounds = (line: string): (number | undefined)[] => {
    let background: number | undefined;
    const cells: (number | undefined)[] = [];
    for (const token of line.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
      if (token[1] !== undefined) {
        for (const code of token[1].split(';').map(Number)) {
          if (code === 0 || code === 49) background = undefined;
          else if (code >= 40 && code <= 47) background = code;
        }
      } else cells.push(...Array(visibleWidth(token[2])).fill(background));
    }
    return cells;
  };
  for (const reset of [39, 0]) for (const name of ['编译 👩🏽‍💻 é', 'long name '.repeat(8), '界👩🏽‍💻é'.repeat(12)]) {
    let background = 44;
    const theme = {
      ...ansiTheme,
      fg: (color: string, text: string) => `\x1b[${color === 'success' ? 32 : 90}m${text}\x1b[${reset}m`,
      bg: (color: string, text: string) => { assert.equal(color, 'selectedBg'); return `\x1b[${background}m${text}\x1b[49m`; },
    };
    const f = setup([run('a', { name }), run('b')], {}, { theme });
    f.dimensions(40, 18);
    for (const color of [44, 45]) {
      background = color; f.component.invalidate();
      const lines = f.component.render(40), selection = lines.find(line => line.includes('›'))!;
      assert.equal(visibleWidth(selection), 40);
      assert.deepEqual(backgrounds(selection), [undefined, ...Array(38).fill(color), undefined], `${reset}: ${name}`);
      assert.deepEqual(backgrounds(lines.find(line => plain(line).includes('b · running'))!), Array(40).fill(undefined));
      if (name === '编译 👩🏽‍💻 é') assert.ok(plain(selection).includes(name));
      else { assert.match(plain(selection), /… +│$/); assert.match(selection, /\x1b\[0m/); }
      assert.doesNotMatch(plain(selection), /�/);
    }
    f.component.dispose();
  }
});

test('all views budget chrome, hints and focused input across narrow and short terminals', async () => {
  for (const screen of ['list', 'details', 'logs', 'help', 'details-help', 'logs-help', 'stop', 'force', 'clear', 'search', 'logs-search', 'write', 'write-confirm', 'eof']) {
    const f = setup([run('a', { name: '编译 😀 é', ...(screen === 'clear' ? { phase: 'terminal', outcome: 'failed' } : screen === 'force' ? { phase: 'stop-timeout' } : {}) })], {}, { theme: ansiTheme });
    if (screen.startsWith('logs')) await logs(f);
    else if (['details', 'details-help', 'clear', 'write', 'write-confirm', 'eof'].includes(screen)) details(f);
    if (screen.endsWith('help')) f.component.handleInput('?');
    if (screen === 'stop') f.component.handleInput('x');
    if (screen === 'force') f.component.handleInput('x');
    if (screen === 'clear') f.component.handleInput('c');
    if (screen === 'eof') f.component.handleInput('e');
    if (screen.endsWith('search')) f.component.handleInput('/');
    if (screen.startsWith('write')) f.component.handleInput('w');
    if (screen.endsWith('search') || screen.startsWith('write')) { f.render(); f.component.handleInput('界😀xk'); }
    if (screen === 'write-confirm') f.component.handleInput(enter);
    for (const width of [1, 20, 24, 40, 80, 120]) for (const height of [1, 2, 5, 6, 10, 18, 24]) {
      f.dimensions(width, height);
      const lines = f.component.render(width), text = plain(lines.join('\n'));
      assert.ok(lines.length <= height, `${screen} ${width}x${height}: height`);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `${screen} ${width}x${height}: width`);
      if (text.startsWith('╭')) {
        assert.ok(lines.every(line => visibleWidth(line) === width));
        assert.match(plain(lines.at(-1)!), /^╰─+╯$/);
      }
      if (width < 24 || height < 6) { f.component.handleInput('y'); assert.equal(f.calls.filter(call => call[0] !== 'output').length, 0); }
      else if (!text.includes('Resize required')) {
        if (['stop', 'force', 'clear', 'eof', 'write-confirm'].includes(screen)) {
          const content = text.replace(/[│\n]/g, ' ').replace(/ +/g, ' ');
          assert.match(content, /y confirm/); assert.match(content, /n cancel/);
          assert.match(content, /编译 😀 é/);
          assert.match(content, screen === 'stop' ? /Send SIGTERM to owned live group\?/ : screen === 'force' ? /Send SIGKILL to owned live group\?/ : screen === 'clear' ? /Delete record and retained logs\?/ : screen === 'eof' ? /Close stdin permanently \(EOF\)\?/ : /Send exact text \(no newline\)\?/);
        }
        if (screen.endsWith('search') || screen === 'write') assert.ok(lines.join('\n').includes(CURSOR_MARKER));
      }
    }
    f.component.dispose();
  }
});

test('list actions use selected ID, preserve reorder, require visible confirmation and gate force by timeout', async () => {
  const f = setup();
  assert.match(f.render(), /x Stop/); assert.doesNotMatch(f.render(), /x Force kill/);
  f.component.handleInput(down); f.component.handleInput('x'); assert.doesNotMatch(f.render(), /Confirm stop/);
  f.update([run('b'), run('a')]); f.render(); assert.equal(f.state.selected, 'b');
  f.component.handleInput('k'); assert.doesNotMatch(f.render(), /Confirm force/);
  f.component.handleInput('x'); f.component.handleInput('y'); assert.equal(f.calls.length, 0);
  assert.match(f.render(), /SIGTERM/); f.component.handleInput('y'); await tick();
  assert.deepEqual(f.calls.pop(), ['stop', 'b', false]);
  f.update([run('a'), run('b', { phase: 'stop-timeout' })]);
  assert.match(f.render(), /x Force kill/);
  f.component.handleInput('?'); assert.match(f.render(), /x Force kill/);
  f.component.handleInput(esc); f.render(); f.component.handleInput('x');
  assert.match(f.render(), /SIGKILL/); f.component.handleInput('y'); await tick();
  assert.deepEqual(f.calls.pop(), ['stop', 'b', true]);
  f.update([run('b', { phase: 'terminal', outcome: 'failed' })]);
  assert.doesNotMatch(f.render(), /x Stop|x Force kill/);
  for (const key of ['x', 'k']) { f.component.handleInput(key); f.render(); }
  assert.equal(f.calls.length, 0); f.component.dispose();
});

test('list confirmations cancel on removal/reselection and revalidate phase before executing', async () => {
  for (const transition of ['removed', 'selected', 'terminal', 'force-running']) {
    const f = setup([run('a', { phase: 'stop-timeout' }), run('b')]);
    f.component.handleInput('x'); f.render();
    if (transition === 'removed') f.update([run('b')]);
    if (transition === 'selected') { f.state.selected = 'b'; f.update([run('a'), run('b')]); }
    if (transition === 'terminal') f.update([run('a', { phase: 'terminal', outcome: 'successful' }), run('b')]);
    if (transition === 'force-running') f.update([run('a'), run('b')]);
    f.component.handleInput('y'); assert.equal(f.calls.length, 0);
    f.render(); f.component.handleInput('y'); await tick(); assert.equal(f.calls.length, 0);
    if (['terminal', 'force-running'].includes(transition)) assert.match(f.render(), /Error: Process is no longer eligible/);
    f.component.dispose();
  }
});

test('list search and paste isolate x/k; async stop failures remain visible in framed list', async () => {
  const f = setup([run('a', { phase: 'stop-timeout' })], { stop: async () => { throw Error('stop denied'); } });
  f.component.handleInput('/'); f.render(); f.component.handleInput('x'); f.component.handleInput('k');
  assert.match(f.render(), /xk/); assert.equal(f.calls.length, 0);
  f.component.handleInput(esc); f.render();
  f.component.handleInput('\x1b[200~'); f.component.handleInput('xky'); f.component.handleInput('\x1b[201~');
  assert.doesNotMatch(f.render(), /Confirm/);
  f.component.handleInput('x'); f.render(); f.component.handleInput('y'); await tick();
  assert.match(f.render(), /Error: stop denied/); assert.match(f.render(), /x Force kill/);
  f.component.dispose();
});

test('list pages and log follow use actual body capacity after wrapped footer, input and errors', async () => {
  const f = setup(Array.from({ length: 50 }, (_, n) => run(`job${n}`)));
  f.dimensions(40, 18); f.render();
  const initialRows = f.component.render(40).filter(line => /job\d+/.test(line)).length;
  f.component.handleInput('\x1b[6~'); assert.equal(f.state.selected, `job${initialRows}`);
  assert.match(f.render(), new RegExp(`› job${initialRows} · running`));
  await logs(f);
  const numbers = () => [...f.render().matchAll(/line (\d+)/g)].map(match => Number(match[1]));
  assert.equal(numbers().at(-1), 29);
  const page = numbers().length;
  f.component.handleInput('\x1b[5~'); assert.equal(numbers().at(-1), 29 - page);
  const paused = numbers(); f.output('replacement'); await tick(); assert.deepEqual(numbers(), paused);
  f.component.handleInput('/'); f.render(); assert.ok(f.render().includes(CURSOR_MARKER));
  f.component.handleInput(esc); f.render(); f.component.handleInput('f'); await tick(); assert.match(f.render(), /replacement/);
  f.output(Array.from({ length: 50 }, (_, n) => `line ${n}`).join('\n')); await tick();
  for (const [width, height] of [[24, 6], [40, 10], [80, 24]]) {
    f.dimensions(width, height); assert.equal(numbers().at(-1), 49, `follow ${width}x${height}`);
  }
  f.component.dispose();
});

test('short error layouts keep async failures, focused input and all log controls above chrome', async () => {
  const f = setup([run('a')], { output: async () => { throw Error('read failed'); } });
  await logs(f); f.dimensions(24, 6);
  assert.match(f.render(), /Error: read failed/);
  for (const hint of ['f follow', 't stream', '/ search', 'Esc back']) assert.ok(f.render().includes(hint));
  assert.doesNotMatch(f.render(), /Resize required/);
  f.component.handleInput('/');
  assert.match(f.render(), /Error: read failed/); assert.ok(f.render().includes(CURSOR_MARKER));
  assert.ok(f.component.render(24).length <= 6);
  f.component.dispose();
});

test('narrow footer never drops selected-row controls and confirms only after resize warning is visible', async () => {
  const f = setup([run('a', { phase: 'stop-timeout' })]);
  f.dimensions(24, 6);
  for (const hint of ['j/k select', 'Enter details', 'x Force kill', '/ search', '? help', 'Esc close']) assert.ok(f.render().includes(hint));
  f.component.handleInput('x'); f.render();
  f.dimensions(20, 6); f.component.handleInput('y'); assert.equal(f.calls.length, 0);
  f.render(); f.component.handleInput('y'); assert.equal(f.calls.length, 0);
  f.dimensions(24, 6); f.component.handleInput('y'); assert.equal(f.calls.length, 0);
  const warning = f.render().replace(/\s+/g, ' ');
  assert.match(warning, /Send SIGKILL to owned live group\?/);
  f.component.handleInput('y'); await tick(); assert.deepEqual(f.calls.pop(), ['stop', 'a', true]);
  f.component.dispose();
});

test('list execution rechecks runtime eligibility even without a published snapshot', async () => {
  let latest = run('a', { phase: 'stop-timeout' });
  const f = setup([latest], { snapshot: () => ({ version: 1, revision: 1, runs: [latest], active: 1, unacknowledgedFailed: 0 }) });
  f.component.handleInput('x'); f.render();
  latest = run('a', { phase: 'terminal', outcome: 'successful' });
  f.component.handleInput('y'); await tick();
  assert.equal(f.calls.length, 0); assert.match(f.render(), /Error: Process is no longer eligible/);
  f.component.dispose();
});

test('j/k selects by ID with clamped edges and preserves configured arrow/page bindings', () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
    'tui.select.up': 'ctrl+p', 'tui.select.down': 'ctrl+n',
    'tui.select.pageUp': 'ctrl+u', 'tui.select.pageDown': 'ctrl+d',
  });
  const f = setup(Array.from({ length: 50 }, (_, i) => run(`job${i}`)), {}, { keybindings });
  f.component.handleInput('k'); assert.equal(f.state.selected, 'job0');
  f.component.handleInput('j'); assert.equal(f.state.selected, 'job1');
  f.component.handleInput('\x0e'); assert.equal(f.state.selected, 'job2');
  f.component.handleInput('\x10'); assert.equal(f.state.selected, 'job1');
  f.component.handleInput('k'); assert.equal(f.state.selected, 'job0');
  const page = f.component.render(100).filter(line => /job\d+/.test(line)).length;
  f.component.handleInput('\x04'); assert.equal(f.state.selected, `job${page}`);
  f.component.handleInput('\x15'); assert.equal(f.state.selected, 'job0');
  for (let i = 0; i < 55; i++) f.component.handleInput('j');
  assert.equal(f.state.selected, 'job49'); assert.deepEqual(f.calls, []);
  f.component.dispose();
});

test('j/k scrolls details and contextual help without changing selection or invoking controls', async () => {
  for (const screen of ['details', 'list-help', 'details-help', 'logs-help']) {
    const f = setup([run('a', { command: 'long command '.repeat(30), phase: 'stop-timeout' }), run('b')]);
    if (screen === 'logs-help') await logs(f);
    else if (screen.startsWith('details')) details(f);
    if (screen.endsWith('help')) f.component.handleInput('?');
    f.dimensions(40, 8);
    const before = f.render(); assert.doesNotMatch(before, /Resize required/);
    f.component.handleInput('j'); const after = f.render();
    assert.notEqual(after, before, screen);
    f.component.handleInput('k'); assert.equal(f.render(), before, screen);
    assert.equal(f.state.selected, 'a');
    assert.ok(f.calls.every(call => call[0] === 'output'));
    f.component.dispose();
  }
});

test('j/k log scrolling pauses follow, freezes new output, and never enables destructive controls', async () => {
  const f = setup([run('a', { phase: 'stop-timeout' })]); await logs(f);
  const view = f.state.logs.get('a')!, tail = view.offset;
  f.component.handleInput('k'); assert.equal(view.offset, tail - 1); assert.equal(view.follow, false);
  f.render(); f.component.handleInput('j'); assert.equal(view.offset, tail); assert.equal(view.follow, false);
  f.output('new output'); await tick(); assert.match(f.render(), /paused \+new/);
  assert.doesNotMatch(f.render(), /new output/);
  for (const key of ['x', 's', 'y', 'c', 'w', 'e']) { f.component.handleInput(key); f.render(); }
  assert.ok(f.calls.every(call => call[0] === 'output'));
  f.component.handleInput('f'); await tick(); assert.equal(view.follow, true); assert.match(f.render(), /new output/);
  f.component.dispose();
});

test('search and stdin receive literal j/k/x keys and segmented pasted keys, not navigation or stop', async () => {
  for (const screen of ['list', 'logs', 'stdin']) {
    const f = setup([run('a', { name: 'jkxjkx' }), run('b')]);
    if (screen === 'logs') await logs(f);
    if (screen === 'stdin') details(f);
    f.component.handleInput(screen === 'stdin' ? 'w' : '/'); f.render();
    for (const key of ['j', 'k', 'x']) f.component.handleInput(key);
    f.component.handleInput('\x1b[200~');
    for (const key of ['j', 'k', 'x']) f.component.handleInput(key);
    f.component.handleInput('\x1b[201'); f.component.handleInput('~');
    assert.match(f.render(), /jkxjkx/); assert.equal(f.state.selected, 'a');
    assert.ok(f.calls.every(call => call[0] === 'output'));
    f.component.handleInput(enter); await tick();
    if (screen === 'list') assert.equal(f.state.query, 'jkxjkx');
    else if (screen === 'logs') assert.equal(f.calls.at(-1)[2].pattern, 'jkxjkx');
    else {
      assert.match(f.render(), /Send exact text/); f.component.handleInput('y'); await tick();
      assert.deepEqual(f.calls.at(-1), ['write', 'a', 'jkxjkx', false]);
    }
    f.component.dispose();
  }
});

test('paste remains isolated when selection removal cancels editing and when payload contains Escape', () => {
  const f = setup(); f.component.handleInput('/'); f.render();
  f.component.handleInput('\x1b[200~'); f.component.handleInput(esc); f.component.handleInput('jkx');
  assert.match(f.render(), /Literal search/);
  f.update([run('b', { phase: 'stop-timeout' })]); f.render();
  for (const key of ['x', 'y', 'j', 'k']) { f.component.handleInput(key); f.render(); }
  f.component.handleInput('\x1b[201'); f.component.handleInput('~');
  assert.doesNotMatch(f.render(), /Confirm/); assert.deepEqual(f.calls, []);
  assert.equal(f.state.selected, 'b');
  f.component.handleInput('x'); assert.match(f.render(), /SIGKILL/);
  f.component.handleInput('n'); f.render(); f.component.handleInput('/'); f.render();
  for (const key of ['j', 'k', 'x']) f.component.handleInput(key);
  f.component.handleInput(enter); assert.equal(f.state.query, 'jkx', 'new prompt has no stale paste buffer');
  f.component.dispose();
});

test('x confirms TERM for active phases, force only at timeout; k never stops in list or details', async () => {
  for (const screen of ['list', 'details']) for (const phase of ['starting', 'running', 'stopping', 'stop-timeout', 'terminal'] as const) {
    const f = setup([run('a', { phase })]);
    if (screen === 'details') details(f);
    f.component.handleInput('k'); f.render(); f.component.handleInput('y');
    assert.deepEqual(f.calls, [], `${screen} ${phase}: k`);
    assert.doesNotMatch(f.render(), /Confirm/);
    f.component.handleInput('x'); f.component.handleInput('y'); assert.deepEqual(f.calls, [], 'unrendered y');
    if (phase === 'terminal') assert.doesNotMatch(f.render(), /Confirm|x [Ss]top|x [Ff]orce/);
    else {
      assert.match(f.render(), phase === 'stop-timeout' ? /SIGKILL/ : /SIGTERM/);
      f.component.handleInput('k'); assert.deepEqual(f.calls, []);
      f.component.handleInput('y'); await tick();
      assert.deepEqual(f.calls, [['stop', 'a', phase === 'stop-timeout']]);
    }
    f.component.dispose();
  }
});

test('captured x confirmation survives reorder but never silently upgrades TERM after timeout', async () => {
  for (const screen of ['list', 'details']) {
    const f = setup(); f.component.handleInput('j'); f.render();
    if (screen === 'details') details(f);
    f.component.handleInput('x'); assert.match(f.render(), /SIGTERM/);
    f.update([run('b', { phase: 'stop-timeout' }), run('a')]);
    f.component.handleInput('y'); assert.deepEqual(f.calls, []);
    assert.match(f.render(), /SIGTERM/); f.component.handleInput('y'); await tick();
    assert.deepEqual(f.calls.pop(), ['stop', 'b', false]);
    f.render(); f.component.handleInput('x'); assert.match(f.render(), /SIGKILL/);
    f.update([run('b', { phase: 'stopping' }), run('a')]); f.render();
    f.component.handleInput('y'); await tick(); assert.deepEqual(f.calls, []);
    assert.match(f.render(), /no longer eligible/); f.component.dispose();
  }
});

test('busy x action blocks navigation/repetition and rechecks eligibility inside deferred act', async () => {
  let release: () => void = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = setup([run('a', { phase: 'stop-timeout' }), run('b')], {}, {
    act: async (_id: string, operation: () => Promise<unknown>) => { await waiting; return operation(); },
  });
  f.component.handleInput('x'); f.render(); f.component.handleInput('y');
  assert.match(f.render(), /Working/);
  for (const key of ['j', 'k', 'x', 'y']) { f.component.handleInput(key); f.render(); }
  assert.equal(f.state.selected, 'a'); assert.deepEqual(f.calls, []);
  f.update([run('a', { phase: 'terminal', outcome: 'successful' }), run('b')]);
  release(); await tick(); assert.deepEqual(f.calls, []);
  assert.match(f.render(), /no longer eligible/); f.component.dispose();
});

test('details s remains a graceful-only alias even after timeout', async () => {
  const f = setup([run('a', { phase: 'stop-timeout' })]); details(f);
  f.component.handleInput('s'); assert.match(f.render(), /SIGTERM/);
  f.component.handleInput('y'); await tick();
  assert.deepEqual(f.calls, [['stop', 'a', false]]); f.component.dispose();
});
