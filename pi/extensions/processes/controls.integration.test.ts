import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Input, KeybindingsManager, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { createRuntime } from './runtime.ts';
import { createUIState, ProcessesUI } from './ui.ts';
import type { RuntimeEvent } from './types.ts';

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('Controls observation deadline exceeded');
    await delay(10);
  }
}

// No real terminal, user input, clipboard, or external process targets.
class MemoryTerminal implements Terminal {
  columns = 100;
  rows = 28;
  kittyProtocolActive = false;
  input = (_data: string) => {};
  resize = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.input = () => {}; }
  async drainInput() {}
  write(_data: string) {}
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
}

for (const mode of ['regular', 'fullscreen'] as const) for (const ignoresTerm of [false, true]) {
  test(`controls ${mode}: x ${ignoresTerm ? 'timeout then explicit force' : 'graceful stop'} with real owned fixture`, { timeout: 15000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'processes-controls-'));
    const runtime = createRuntime({ logRoot: root, stopGraceMs: 100 });
    const events: RuntimeEvent[] = [];
    const off = runtime.subscribe(event => events.push(event));
    const terminal = new MemoryTerminal();
    const tui = mode === 'regular' ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
    const draft = new Input(); draft.setValue('unchanged draft'); tui.addChild(draft); tui.setFocus(draft); tui.start();
    const state = createUIState();
    let ui: ProcessesUI | undefined;
    const frame = () => ui!.render(terminal.columns).join('\n');
    const press = (key: string) => { tui.renderNow(true); terminal.input(key); tui.renderNow(true); };
    try {
      const source = `process.on('SIGTERM', () => { ${ignoresTerm ? '' : 'process.exit(0);'} });
        console.log(Array.from({length:60}, (_, i) => 'owned line ' + i).join('\\n'));
        console.log('READY'); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 8000);`;
      const run = await runtime.start({ name: 'controls owned fixture', cwd: root,
        command: `exec ${quote(process.execPath)} -e ${quote(source)}` });
      await until(async () => (await runtime.output(run.id)).text.includes('READY'));
      ui = new ProcessesUI({ runtime, state,
        theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text },
        keybindings: new KeybindingsManager(TUI_KEYBINDINGS), getWidth: () => terminal.columns,
        getHeight: () => terminal.rows, onChange: () => tui.requestRender(),
        onClose: () => tui.hideOverlay(), act: async (_id, operation) => operation(),
      });
      tui.showOverlay(ui, { width: '100%', maxHeight: '100%' }); tui.renderNow(true);
      press('k'); press('j');
      assert.equal(runtime.snapshot().runs[0].phase, 'running');
      assert.doesNotMatch(frame(), /Confirm/);
      press('\r'); press('\r');
      await until(() => !!state.logs.get(run.id)?.lines.includes('READY'));
      tui.renderNow(true);
      press('k'); assert.equal(state.logs.get(run.id)!.follow, false);
      press('j'); assert.equal(state.logs.get(run.id)!.follow, false);
      for (const key of ['x', 's', 'y']) press(key);
      assert.equal(runtime.snapshot().runs[0].phase, 'running', 'logs cannot stop');
      press('f'); await until(() => state.logs.get(run.id)!.follow);
      press('\x1b');
      if (mode === 'regular') press('\x1b'); // Cover both list and details controls.
      press('\x1b[200~'); press('x'); press('y'); press('\x1b[201~');
      assert.doesNotMatch(frame(), /Confirm/);
      press('x'); assert.match(frame(), /SIGTERM/);
      assert.equal(runtime.snapshot().runs[0].phase, 'running');
      press('y');
      await until(() => runtime.snapshot().runs[0].phase === (ignoresTerm ? 'stop-timeout' : 'terminal'));
      if (ignoresTerm) {
        process.kill(run.pid!, 0);
        assert.equal(runtime.snapshot().active, 1);
        press('k'); press('y');
        assert.equal(runtime.snapshot().runs[0].phase, 'stop-timeout', 'k never forces');
        assert.doesNotMatch(frame(), /Confirm/);
        press('x'); assert.match(frame(), /SIGKILL/);
        press('n'); assert.equal(runtime.snapshot().runs[0].phase, 'stop-timeout');
        press('x'); assert.match(frame(), /SIGKILL/); press('y');
        await until(() => runtime.snapshot().runs[0].phase === 'terminal');
        assert.equal(runtime.snapshot().runs[0].signal, 'SIGKILL');
      }
      assert.equal(runtime.snapshot().runs[0].outcome, 'user-stopped');
      assert.throws(() => process.kill(run.pid!, 0), /ESRCH/);
      await until(() => events.some(event => event.type === 'notification' && event.kind === 'completion'));
      const completions = events.filter(event => event.type === 'notification' && event.kind === 'completion');
      assert.equal(completions.length, 1); assert.equal(completions[0].attention, 'context');
      press('x'); assert.doesNotMatch(frame(), /Confirm/);
      for (const [width, height] of [[24, 6], [40, 10], [100, 28]]) {
        terminal.columns = width; terminal.rows = height; terminal.resize(); tui.renderNow(true);
        const lines = ui.render(width);
        assert.ok(lines.length <= height); assert.ok(lines.every(line => visibleWidth(line) <= width));
      }
      if (mode === 'fullscreen') press('\x1b');
      press('\x1b'); assert.equal(tui.hasOverlay(), false);
      assert.equal(draft.getValue(), 'unchanged draft'); assert.equal(draft.focused, true);
    } finally {
      ui?.dispose(); off(); tui.stop();
      try { await runtime.dispose(); assert.deepEqual(readdirSync(root), []); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
}
