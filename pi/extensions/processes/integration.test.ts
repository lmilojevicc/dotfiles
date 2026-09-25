import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Input, KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, TuiAltScreen, visibleWidth, type Terminal, type TUI } from '@earendil-works/pi-tui';
import { registerProcesses } from './index.ts';
import { createRuntime } from './runtime.ts';
import { SNAPSHOT_REQUEST, SNAPSHOT_EVENT, safeText } from './status.ts';
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
  const handlers = new Map<string, any>(), commands = new Map<string, any>(), renderers = new Map<string, any>();
  const bus = new Map<string, Set<(value: any) => void>>();
  const statuses: (string | undefined)[] = [], messages: any[] = [], notices: string[] = [];
  const runtimes: Runtime[] = [];
  const frames: { width: number; lines: string[] }[] = [];
  let tool: any;
  const pi: any = {
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerTool: (definition: any) => { assert.equal(tool, undefined); tool = definition; },
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    registerMessageRenderer: (name: string, renderer: any) => { assert.ok(!renderers.has(name)); renderers.set(name, renderer); },
    sendMessage: (...args: any[]) => messages.push(args),
    events: {
      on: (name: string, fn: any) => { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name)!.add(fn); return () => bus.get(name)!.delete(fn); },
      emit: (name: string, value: any) => { for (const fn of bus.get(name) ?? []) fn(value); },
    },
  };
  const theme = { fg: (color: string, text: string) => `\x1b[${color === 'success' ? 32 : color === 'error' ? 31 : 39}m${text}\x1b[0m`, bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`, bold: (text: string) => text };
  const ctx: any = { mode: tui ? 'tui' : 'json', hasUI: !!tui, cwd: root, ui: {
    theme, setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    notify: (text: string) => notices.push(text),
    custom: (factory: any, options: any) => {
      assert.ok(tui, 'headless must not open a TUI'); assert.equal(options.overlay, true);
      return new Promise<void>(resolve => {
        const component = factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {
          component.dispose(); tui!.hideOverlay(); resolve();
        });
        const render = component.render.bind(component);
        component.render = (width: number) => {
          const lines = render(width); frames.push({ width, lines }); return lines;
        };
        tui!.showOverlay(component, options.overlayOptions); tui!.renderNow(true);
      });
    },
  } };
  registerProcesses(pi, () => {
    const runtime = createRuntime({ logRoot: root, stopGraceMs: 100 }); runtimes.push(runtime); return runtime;
  }, () => root);
  return {
    root, statuses, messages, notices, runtimes, frames, pi, ctx, renderers, theme,
    definition: () => tool,
    result: (params: any) => tool.execute('integration', params, undefined, undefined, ctx),
    start: () => handlers.get('session_start')({}, ctx),
    shutdown: () => handlers.get('session_shutdown')({}, ctx),
    open: () => commands.get('processes').handler('', ctx),
    async tool(params: any) { return (await tool.execute('integration', params, undefined, undefined, ctx)).details.data; },
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
    assert.deepEqual([...extension.handlers.keys()].sort(), ['resources_discover', 'session_shutdown', 'session_start']);
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
    for (const [columns, rows] of [[30, 10], [24, 6], [1, 2], [100, 28]]) {
      terminal.columns = columns; terminal.rows = rows; terminal.resize(); tui.renderNow(true);
      const frame = f.frames.at(-1)!;
      assert.ok(frame.width <= columns);
      assert.ok(frame.lines.length <= Math.max(1, Math.min(24, rows - 2)));
      assert.ok(frame.lines.every(line => visibleWidth(line) <= frame.width));
      if (columns === 100) {
        assert.match(frame.lines[0], /╭─+╮/); assert.match(frame.lines.at(-1)!, /╰─+╯/);
        assert.ok(frame.lines.every(line => visibleWidth(line) === frame.width));
      }
    }
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

for (const mode of ['regular', 'fullscreen'] as const) test(`confirmed list stop in ${mode} retains context-only completion despite configured turn attention`, async () => {
  const terminal = new MemoryTerminal(), tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  tui.start();
  const f = harness(tui);
  const press = (key: string) => { tui.renderNow(true); terminal.input(key); tui.renderNow(true); };
  try {
    await f.start();
    const run: Run = await f.tool({ action: 'start', name: 'owned stop', command: 'exec cat',
      notify: { onSuccess: 'turn', onFailure: 'turn', onKilled: 'turn' } });
    const opening = f.open();
    assert.match(f.frames.at(-1)!.lines.join('\n'), /x Stop/);
    press('x');
    assert.match(f.frames.at(-1)!.lines.join('\n'), /SIGTERM/);
    assert.match(f.frames.at(-1)!.lines[0], /╭─+╮/);
    assert.match(f.frames.at(-1)!.lines.at(-1)!, /╰─+╯/);
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

for (const mode of ['regular', 'fullscreen'] as const) test(`installed ${mode} transcript shell renders source-backed tool results and persisted messages after teardown`, { timeout: 15000 }, async () => {
  const entry = import.meta.resolve('@earendil-works/pi-coding-agent');
  const { ToolExecutionComponent } = await import(new URL('./modes/interactive/components/tool-execution.js', entry).href);
  const { CustomMessageComponent } = await import(new URL('./modes/interactive/components/custom-message.js', entry).href);
  const { initTheme } = await import(new URL('./modes/interactive/theme/theme.js', entry).href);
  initTheme('dark', false);
  const terminal = new MemoryTerminal(), tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
  const f = harness(tui), examples: string[] = [];
  tui.start();
  const draw = (component: {render(width: number): string[]}, label: string) => {
    const text = safeText(component.render(90).join('\n'), true).split('\n').map(line => line.trimEnd()).join('\n').trim();
    examples.push(`## ${label}\n\n\`\`\`text\n${text}\n\`\`\``);
    assert.doesNotMatch(text, /"startedAt"|"stopRequested"|\[process-notification\]/);
    for (const width of [18, 40, 90]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width), label);
    return text;
  };
  const execute = async (params: any) => {
    const component = new ToolExecutionComponent('process', 'fixture', params, {}, f.definition(), tui, f.root);
    tui.addChild(component); component.setArgsComplete(); component.markExecutionStarted();
    const result = await f.result(params);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details.data);
    component.updateResult({ ...result, isError: false }); tui.renderNow(true);
    return { component, result, data: result.details.data };
  };
  try {
    await f.start();
    const command = `exec '${process.execPath}' -e 'setTimeout(()=>process.exit(2),8000).unref();process.stdin.on("data",d=>process.stdout.write(d));process.stdin.on("end",()=>process.exit(0));'`;
    const started = await execute({ action: 'start', name: 'transcript echo', command, notify: { logMatches: [{ pattern: 'ready', on: 'context' }] } });
    assert.match(draw(started.component, 'Running'), /transcript echo · running/);
    assert.match(f.statuses.at(-1)!, /\x1b\[32m1 active/);
    await execute({ action: 'write', id: started.data.id, input: 'ready\nfirst human line\nsecond human line\n' });
    await until(() => f.messages.some(([m]) => m.details.event?.kind === 'watch'));
    const output = await execute({ action: 'output', id: started.data.id });
    assert.match(draw(output.component, 'Output collapsed'), /first human line\n\s*second human line/);
    output.component.setExpanded(true);
    assert.match(draw(output.component, 'Output expanded'), /ready\n\s*first human line\n\s*second human line/);
    assert.match(readFileSync(output.data.stdoutFile, 'utf8'), /ready\nfirst human line/);
    await execute({ action: 'write', id: started.data.id, end: true });
    await until(() => f.messages.some(([m]) => m.details.event?.kind === 'completion'));
    const failed = await execute({ action: 'start', name: 'transcript failure', command: "printf 'failure detail\\n' >&2; exit 7" });
    await until(() => f.snapshot()!.unacknowledgedFailed === 1 && f.messages.filter(([m]) => m.details.event?.kind === 'completion').length === 2);
    const list = await execute({ action: 'list' });
    assert.match(draw(list.component, 'Completed and failed'), /transcript failure\s+failed.*exit 7/);
    assert.match(f.statuses.at(-1)!, /\x1b\[31m1 failed/);
    const persisted = structuredClone(f.messages.map(([m]) => m));
    const paths = [output.data.stdoutFile, output.data.stderrFile, failed.data.stdoutFile, failed.data.stderrFile];
    await execute({ action: 'clear' });
    for (const path of paths) assert.equal(existsSync(path), false);
    await f.shutdown();
    for (const message of persisted) {
      const replay = new CustomMessageComponent({ ...message, role: 'custom', timestamp: Date.now() }, f.renderers.get('process-notification'));
      tui.addChild(replay); tui.renderNow(true);
      const text = draw(replay, `Replayed ${message.details.event.kind}`);
      if (message.details.event.kind === 'completion') assert.match(text, /transcript (echo completed|failure failed).*exit (0|7)/);
      else assert.match(text, /matched stdout: ready/);
      replay.setExpanded(true); assert.match(draw(replay, 'Replay expanded'), /id: .*notify:/);
    }
    assert.ok(terminal.output.includes('second human line'));
    if (process.env.PROCESSES_RENDER_EVIDENCE_DIR) writeFileSync(join(process.env.PROCESSES_RENDER_EVIDENCE_DIR, `${mode}-renders.md`), examples.join('\n\n') + '\n');
  } finally { await f.cleanup(); tui.stop(); }
});

test('RPC status opt-out preserves versioned broadcasts, requests, notifications and replacement cleanup', { timeout: 10000 }, async () => {
  const f = harness();
  const snapshots: Snapshot[] = [];
  const off = f.pi.events.on(SNAPSHOT_EVENT, (snapshot: Snapshot) => { assert.equal(snapshot.version, 1); snapshots.push(snapshot); });
  try {
    f.ctx.mode = 'rpc'; f.ctx.hasUI = true;
    writeFileSync(join(f.root, 'processes.json'), '{"defaultStatus":false}');
    await f.start();
    const run = await f.tool({ action: 'start', name: 'opt-out fixture', command: 'exec cat' });
    assert.equal(f.snapshot()!.active, 1); assert.equal(snapshots.at(-1)!.active, 1);
    assert.ok(f.statuses.every(value => value === undefined));
    await f.open(); assert.match(f.notices.at(-1)!, /opt-out fixture · running/);
    const detached = f.snapshot()!; (detached.runs[0] as Run).name = 'mutated subscriber';
    assert.equal(f.snapshot()!.runs[0].name, 'opt-out fixture');
    let replied = false;
    f.pi.events.emit(SNAPSHOT_REQUEST, { version: 2, reply: () => { replied = true; } });
    assert.equal(replied, false);
    assert.equal(existsSync(run.stdoutFile), true);
    await f.start(); // Replacement cleans a live owned run, revokes the old generation, and reattaches once.
    assert.equal(existsSync(run.stdoutFile), false);
    assert.throws(() => process.kill(run.pid, 0), /ESRCH/);
    assert.equal(f.snapshot()!.runs.length, 0); assert.equal(f.messages.length, 0);
    await f.tool({ action: 'start', name: 'still notifies', command: 'exit 9' });
    await until(() => f.messages.length === 1);
    assert.deepEqual(f.messages[0][1], { triggerTurn: true, deliverAs: 'steer' });
    assert.equal(f.snapshot()!.unacknowledgedFailed, 1);
    assert.ok(f.statuses.every(value => value === undefined));
    await f.shutdown(); assert.equal(f.snapshot(), undefined);
  } finally { off(); await f.cleanup(); }
});
