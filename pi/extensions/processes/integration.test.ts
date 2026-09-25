import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Input, KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, TuiAltScreen, type Terminal, type TUI } from '@earendil-works/pi-tui';
import { registerProcesses } from './index.ts';
import { createRuntime } from './runtime.ts';
import { SNAPSHOT_REQUEST } from './status.ts';
import type { Run, Runtime, Snapshot } from './types.ts';

const directory = dirname(fileURLToPath(import.meta.url));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Integration observation deadline exceeded');
    await delay(10);
  }
}

// Only a memory sink: no real terminal, stdin, clipboard, or user session.
class MemoryTerminal implements Terminal {
  columns = 100;
  rows = 28;
  kittyProtocolActive = false;
  output = '';
  input = (_data: string) => {};
  resize = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.input = () => {}; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
}

function harness(tui?: TUI) {
  const root = mkdtempSync(join(tmpdir(), 'processes-integration-'));
  const handlers = new Map<string, any>(), commands = new Map<string, any>();
  const bus = new Map<string, Set<(value: any) => void>>();
  const statuses: (string | undefined)[] = [], messages: any[] = [], notices: string[] = [];
  const runtimes: Runtime[] = [];
  let tool: any;
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerTool: (definition: any) => { assert.equal(tool, undefined); tool = definition; },
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    sendMessage: (...args: any[]) => messages.push(args),
    events: {
      on: (name: string, fn: any) => { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name)!.add(fn); return () => bus.get(name)!.delete(fn); },
      emit: (name: string, value: any) => { for (const fn of bus.get(name) ?? []) fn(value); },
    },
  };
  const theme = { fg: (color: string, text: string) => `\x1b[${color === 'success' ? 32 : color === 'error' ? 31 : 39}m${text}\x1b[0m`, bold: (text: string) => text };
  const ctx: any = { mode: tui ? 'tui' : 'json', hasUI: !!tui, cwd: root, ui: {
    theme, setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify: (text: string) => notices.push(text),
    custom: (factory: any, options: any) => {
      assert.ok(tui, 'headless must not open a TUI'); assert.equal(options.overlay, true);
      return new Promise<void>(resolve => {
        const component = factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {
          component.dispose(); tui!.hideOverlay(); resolve();
        });
        tui!.showOverlay(component, options.overlayOptions); tui!.renderNow(true);
      });
    },
  } };
  registerProcesses(pi, () => {
    const runtime = createRuntime({ logRoot: root, stopGraceMs: 100 }); runtimes.push(runtime); return runtime;
  }, () => root);
  return {
    root, statuses, messages, notices, runtimes,
    start: () => handlers.get('session_start')({}, ctx),
    shutdown: () => handlers.get('session_shutdown')({}, ctx),
    open: () => commands.get('processes').handler('', ctx),
    async tool(params: any) { return (await tool.execute('integration', params, undefined, undefined, ctx)).details; },
    snapshot(): Snapshot | undefined { let snapshot: Snapshot | undefined; pi.events.emit(SNAPSHOT_REQUEST, { version: 1, reply: (value: Snapshot) => snapshot = value }); return snapshot; },
    async cleanup() { try { await handlers.get('session_shutdown')({}, ctx); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

test('installed Pi auto-discovers exactly one process extension without old package or duplicate registrations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'processes-discovery-'));
  try {
    mkdirSync(join(root, 'extensions'));
    symlinkSync(directory, join(root, 'extensions', 'processes'), 'dir');
    const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
    const { discoverAndLoadExtensions } = await import(new URL('./core/extensions/loader.js', entry).href);
    const result = await discoverAndLoadExtensions([], root, root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.deepEqual([...extension.tools.keys()], ['process']);
    assert.deepEqual([...extension.commands.keys()], ['processes']);
    assert.equal(extension.shortcuts.size, 0);
    assert.deepEqual([...extension.handlers.keys()].sort(), ['session_shutdown', 'session_start']);
    const settings = JSON.parse(readFileSync(join(directory, '../../settings.json'), 'utf8'));
    assert.ok(!settings.packages.includes('npm:@aliou/pi-processes'));
    assert.ok(!settings.packages.some((value: unknown) => typeof value === 'string' && value.includes('extensions/processes')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ['regular', 'fullscreen'] as const) test(`integrated ${mode} renderer: real process, status, logs, acknowledgment, clear, shutdown and editor preservation`, async () => {
  const terminal = new MemoryTerminal();
  const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const draft = new Input(); draft.setValue('untouched editor draft 界'); tui.addChild(draft); tui.setFocus(draft); tui.start();
  const f = harness(tui);
  const press = (key: string) => { tui.renderNow(true); terminal.input(key); tui.renderNow(true); };
  try {
    await f.start();
    const failed: Run = await f.tool({ action: 'start', name: 'integration failure', command: "printf 'integration retained log\\n'; exit 7" });
    await until(() => f.snapshot()!.unacknowledgedFailed === 1 && f.messages.length === 1);
    assert.match(f.statuses.at(-1)!, /\x1b\[31m1 failed/);
    assert.deepEqual(f.messages[0][1], { triggerTurn: true, deliverAs: 'steer' });
    const opening = f.open(); assert.equal(tui.hasOverlay(), true);
    press('\r'); press('\r');
    await until(() => { tui.renderNow(true); return terminal.output.includes('integration retained log'); });
    press('\x1b'); press('a');
    assert.equal(f.snapshot()!.unacknowledgedFailed, 0); assert.equal(f.statuses.at(-1), undefined);
    assert.equal((await f.tool({ action: 'list', statuses: ['failed'] })).runs[0].id, failed.id);
    press('c'); assert.match(terminal.output, /Delete record and retained logs/); press('y');
    await until(() => f.snapshot()!.runs.length === 0);
    press('\x1b'); await opening;
    assert.equal(f.messages.length, 1, 'UI navigation/ack/clear never wakes model');
    assert.equal(tui.hasOverlay(), false); assert.equal(draft.getValue(), 'untouched editor draft 界');
    assert.equal(draft.focused, true);
    const active: Run = await f.tool({ action: 'start', name: 'integration owned stdin', command: 'exec cat' });
    assert.match(f.statuses.at(-1)!, /\x1b\[32m1 active/);
    await f.tool({ action: 'write', id: active.id, input: 'owned\n' });
    const second = f.open();
    terminal.columns = 30; terminal.rows = 10; terminal.resize(); tui.renderNow(true);
    terminal.columns = 100; terminal.rows = 28; terminal.resize(); tui.renderNow(true);
    await f.shutdown(); await second;
    assert.equal(tui.hasOverlay(), false); assert.equal(f.snapshot(), undefined);
    assert.equal(f.statuses.at(-1), undefined); assert.deepEqual(f.notices, []);
    assert.deepEqual(readdirSync(f.root), []);
    assert.throws(() => process.kill(active.pid!, 0), /ESRCH/);
    assert.equal(f.runtimes[0].snapshot().runs.find(r => r.id === active.id)!.outcome, 'user-stopped');
    assert.equal(f.messages.length, 1, 'shutdown notifications suppressed');
  } finally { await f.cleanup(); tui.stop(); }
});

test('integrated headless command uses stderr and replacement loses session records/logs', async () => {
  const f = harness(); const stderr: string[] = [], stdout: unknown[] = [];
  const oldError = console.error, oldLog = console.log;
  console.error = (...args: unknown[]) => stderr.push(args.join(' ')); console.log = (...args: unknown[]) => stdout.push(args);
  try {
    await f.start();
    await f.tool({ action: 'start', name: 'headless owned', command: 'exit 0', notify: { onSuccess: 'ignore' } });
    await until(() => f.snapshot()!.runs[0].phase === 'terminal');
    await f.open(); assert.match(stderr[0], /headless owned · successful/); assert.deepEqual(stdout, []);
    await f.start(); assert.deepEqual(f.snapshot()!.runs, []); assert.deepEqual(readdirSync(f.root), []);
    await f.open(); assert.equal(stderr.at(-1), 'No processes'); assert.equal(f.messages.length, 0);
  } finally { console.error = oldError; console.log = oldLog; await f.cleanup(); }
});

test('confirmed UI stop retains runtime context-only completion despite configured turn attention', async () => {
  const terminal = new MemoryTerminal(), tui = new TuiMainScreen(terminal);
  tui.start();
  const f = harness(tui);
  const press = (key: string) => { tui.renderNow(true); terminal.input(key); tui.renderNow(true); };
  try {
    await f.start();
    const run: Run = await f.tool({ action: 'start', name: 'owned stop', command: 'exec cat',
      notify: { onSuccess: 'turn', onFailure: 'turn', onKilled: 'turn' } });
    const opening = f.open();
    press('\r'); press('s');
    assert.equal(f.messages.length, 0, 'navigation and confirmation feedback do not wake model');
    press('y');
    await until(() => f.messages.length === 1);
    assert.equal(f.snapshot()!.runs[0].outcome, 'user-stopped');
    assert.equal(f.messages[0][0].details.attention, 'context');
    assert.deepEqual(f.messages[0][1], { triggerTurn: false, deliverAs: 'nextTurn' });
    assert.throws(() => process.kill(run.pid!, 0), /ESRCH/);
    await f.shutdown(); await opening;
    assert.equal(f.messages.length, 1);
  } finally { await f.cleanup(); tui.stop(); }
});
