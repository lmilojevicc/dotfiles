import type { Theme } from '@earendil-works/pi-coding-agent';
import { Input, getKeybindings, setKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type KeybindingsManager } from '@earendil-works/pi-tui';
import type { OutputResult, Run, Runtime, Snapshot, Stream } from './types.ts';
import { safeText } from './status.ts';

type LogView = { stream: Stream; query: string; follow: boolean; offset: number; lines: string[]; truncated: boolean; rotated: boolean; newer: boolean };
export type UIState = { selected?: string; query: string; logs: Map<string, LogView> };
export const createUIState = (): UIState => ({ query: '', logs: new Map() });
type Options = {
  runtime: Runtime; state: UIState; theme: Pick<Theme, 'fg' | 'bg' | 'bold'>; keybindings: KeybindingsManager;
  getHeight: () => number; getWidth?: () => number; onChange: () => void; onClose: () => void;
  act: <T>(id: string, operation: () => T | Promise<T>) => Promise<T>;
};
type Confirmation = { id: string; action: 'stop' | 'force' | 'clear' | 'write' | 'eof'; input?: string };

export class ProcessesUI implements Component, Focusable {
  private options: Options;
  private snapshot: Snapshot;
  private unsubscribe: () => void;
  private screen: 'list' | 'details' | 'logs' = 'list';
  private input = new Input();
  private editing: 'search' | 'write' | undefined;
  private confirmation: Confirmation | undefined;
  private help = false;
  private helpOffset = 0;
  private ignoringPaste = false;
  private pasteTail = '';
  private error = '';
  private busy = false;
  private closed = false;
  private request = 0;
  private detailsOffset = 0;
  private pageSize = 1;
  private usable = false;
  private rendered = false;
  private dimensions = '';
  private _focused = false;

  constructor(options: Options) {
    this.options = options;
    this.unsubscribe = options.runtime.subscribe(event => {
      if (this.closed) return;
      if (event.type === 'snapshot') {
        this.snapshot = event.snapshot; this.reconcile(); this.changed();
      } else if (event.type === 'output' && event.id === options.state.selected) {
        const view = this.logView();
        if (view.follow && this.screen === 'logs') void this.refreshLogs();
        else { view.newer = true; this.changed(); }
      }
    });
    this.snapshot = options.runtime.snapshot();
    this.reconcile();
    this.input.onEscape = () => { this.editing = undefined; this.focused = this._focused; this.changed(); };
    this.input.onSubmit = value => {
      const editing = this.editing;
      this.editing = undefined; this.focused = this._focused;
      if (editing === 'write' && this.options.state.selected) {
        this.confirmation = { id: this.options.state.selected, action: 'write', input: safeText(value) };
      } else if (this.screen === 'logs') {
        const view = this.logView(); view.query = safeText(value); view.offset = 0;
        void this.refreshLogs();
      } else { this.options.state.query = safeText(value); this.reconcile(); }
      this.changed();
    };
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value && !!this.editing; }
  private changed(): void { if (!this.closed) { this.rendered = false; this.options.onChange(); } }
  invalidate(): void { this.input.invalidate(); }
  dispose(): void { if (!this.closed) { this.closed = true; this.request++; this.unsubscribe(); } }
  private close(): void { this.dispose(); this.options.onClose(); }
  private selected(): Run | undefined { return this.snapshot.runs.find(r => r.id === this.options.state.selected); }
  private matches(): Run[] {
    const query = this.options.state.query.toLocaleLowerCase();
    return this.snapshot.runs.filter(r => safeText(`${r.name} ${r.command} ${r.cwd}`).toLocaleLowerCase().includes(query));
  }
  private reconcile(): void {
    const runs = this.screen === 'list' ? this.matches() : this.snapshot.runs;
    if (!runs.some(r => r.id === this.options.state.selected)) {
      this.options.state.selected = runs[0]?.id;
      this.screen = 'list'; this.confirmation = undefined; this.editing = undefined; this.request++;
    }
    if (this.confirmation && this.confirmation.id !== this.options.state.selected) this.confirmation = undefined;
    for (const id of this.options.state.logs.keys()) if (!this.snapshot.runs.some(r => r.id === id)) this.options.state.logs.delete(id);
  }
  private logView(): LogView {
    const id = this.options.state.selected ?? '';
    let view = this.options.state.logs.get(id);
    if (!view) {
      view = { stream: 'both', query: '', follow: true, offset: 0, lines: [], truncated: false, rotated: false, newer: false };
      this.options.state.logs.set(id, view);
    }
    return view;
  }
  private async refreshLogs(): Promise<void> {
    const id = this.options.state.selected;
    if (!id || this.closed) return;
    const view = this.logView(), request = ++this.request;
    try {
      const result: OutputResult = await this.options.runtime.output(id, { stream: view.stream, tailLines: 2000, ...(view.query ? { pattern: view.query, mode: 'literal' as const } : {}) });
      if (this.closed || request !== this.request || id !== this.options.state.selected) return;
      view.lines = safeText(result.text, true).split('\n');
      view.truncated = result.truncated; view.rotated = result.rotated; view.newer = false;
      if (view.follow) view.offset = Math.max(0, view.lines.length - this.pageSize);
      this.error = ''; this.changed();
    } catch (error) {
      if (!this.closed && request === this.request) { this.error = safeText(error instanceof Error ? error.message : error); this.changed(); }
    }
  }
  private edit(kind: 'search' | 'write'): void {
    this.editing = kind;
    this.input.setValue(kind === 'write' ? '' : this.screen === 'logs' ? this.logView().query : this.options.state.query);
    this.focused = this._focused; this.changed();
  }
  private async perform(confirmation: Confirmation): Promise<void> {
    if (this.busy || this.closed) return;
    this.confirmation = undefined; this.busy = true; this.error = ''; this.changed();
    try {
      await this.options.act(confirmation.id, async () => {
        const runtime = this.options.runtime;
        if (confirmation.action === 'stop' || confirmation.action === 'force') {
          const target = runtime.snapshot().runs.find(r => r.id === confirmation.id);
          if (this.options.state.selected !== confirmation.id || !target || target.phase === 'terminal' ||
            (confirmation.action === 'force' && target.phase !== 'stop-timeout')) throw new Error('Process is no longer eligible for this action');
          await runtime.stop(confirmation.id, confirmation.action === 'force');
        }
        else if (confirmation.action === 'clear') runtime.clear(confirmation.id);
        else await runtime.write(confirmation.id, confirmation.input ?? '', confirmation.action === 'eof');
      });
    } catch (error) {
      if (!this.closed) this.error = safeText(error instanceof Error ? error.message : error);
    } finally { if (!this.closed) { this.busy = false; this.changed(); } }
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (!this.editing && (this.ignoringPaste || data.includes('\x1b[200~'))) {
      const chunk = this.pasteTail + data;
      this.ignoringPaste = !chunk.includes('\x1b[201~');
      this.pasteTail = this.ignoringPaste ? chunk.slice(-5) : '';
      return;
    }
    const kb = this.options.keybindings;
    const cancel = kb.matches(data, 'tui.select.cancel');
    if (cancel) {
      if (this.editing) { this.editing = undefined; this.focused = this._focused; }
      else if (this.confirmation) this.confirmation = undefined;
      else if (this.help) this.help = false;
      else if (this.screen === 'logs') { this.screen = 'details'; this.request++; }
      else if (this.screen === 'details') { this.screen = 'list'; this.reconcile(); }
      else { this.close(); return; }
      this.changed(); return;
    }
    if (!this.usable || this.dimensions !== this.currentDimensions() || this.busy) return;
    if (this.editing) {
      const previous = getKeybindings();
      setKeybindings(kb);
      try { this.input.handleInput(data); } finally { setKeybindings(previous); }
      const clean = safeText(this.input.getValue());
      if (clean !== this.input.getValue()) this.input.setValue(clean);
      this.changed(); return;
    }
    if (this.confirmation) {
      if (matchesKey(data, 'n')) { this.confirmation = undefined; this.changed(); }
      else if (this.rendered && matchesKey(data, 'y')) void this.perform(this.confirmation);
      return;
    }
    const delta = kb.matches(data, 'tui.select.up') ? -1 : kb.matches(data, 'tui.select.down') ? 1 :
      kb.matches(data, 'tui.select.pageUp') ? -this.pageSize : kb.matches(data, 'tui.select.pageDown') ? this.pageSize : 0;
    if (this.help) {
      if (matchesKey(data, '?')) { this.help = false; this.changed(); }
      else if (delta) { this.helpOffset = Math.max(0, this.helpOffset + delta); this.changed(); }
      return;
    }
    if (delta) {
      if (this.screen === 'list') {
        const runs = this.matches(), index = runs.findIndex(r => r.id === this.options.state.selected);
        this.options.state.selected = runs[Math.max(0, Math.min(runs.length - 1, index + delta))]?.id;
      } else if (this.screen === 'logs') {
        const view = this.logView(); view.follow = false; this.request++;
        view.offset = Math.max(0, Math.min(Math.max(0, view.lines.length - this.pageSize), view.offset + delta));
      } else this.detailsOffset = Math.max(0, this.detailsOffset + delta);
      this.changed(); return;
    }
    const run = this.selected();
    if (run && kb.matches(data, 'tui.select.confirm') && this.rendered) {
      if (this.screen === 'list') { this.screen = 'details'; this.detailsOffset = 0; }
      else if (this.screen === 'details') { this.screen = 'logs'; if (this.logView().follow || !this.logView().lines.length) void this.refreshLogs(); }
      this.changed(); return;
    }
    if (matchesKey(data, '?')) { this.help = true; this.helpOffset = 0; this.changed(); return; }
    if (matchesKey(data, '/') && this.screen !== 'details') { this.edit('search'); return; }
    if (!run) return;
    if (this.screen === 'logs') {
      const view = this.logView();
      if (matchesKey(data, 'f')) { view.follow = !view.follow; if (view.follow) void this.refreshLogs(); else this.request++; this.changed(); }
      if (matchesKey(data, 't')) { view.stream = view.stream === 'both' ? 'stdout' : view.stream === 'stdout' ? 'stderr' : 'both'; view.offset = 0; void this.refreshLogs(); this.changed(); }
      return;
    }
    if (this.screen === 'list' && this.rendered) {
      const action = matchesKey(data, 'x') && run.phase !== 'terminal' ? 'stop' :
        matchesKey(data, 'k') && run.phase === 'stop-timeout' ? 'force' : undefined;
      if (action) { this.confirmation = { id: run.id, action }; this.changed(); }
      return;
    }
    if (this.screen !== 'details' || !this.rendered) return;
    if (matchesKey(data, 'a') && run.outcome === 'failed' && !run.acknowledged) {
      try { this.options.runtime.acknowledge(run.id); } catch (error) { this.error = safeText(error instanceof Error ? error.message : error); }
      this.changed(); return;
    }
    let action: Confirmation['action'] | undefined;
    if (matchesKey(data, 's') && run.phase !== 'terminal') action = 'stop';
    if (matchesKey(data, 'k') && run.phase === 'stop-timeout') action = 'force';
    if (matchesKey(data, 'c') && run.phase === 'terminal') action = 'clear';
    if (matchesKey(data, 'e') && run.phase === 'running') action = 'eof';
    if (matchesKey(data, 'w') && run.phase === 'running') { this.edit('write'); return; }
    if (action) { this.confirmation = { id: run.id, action }; this.changed(); }
  }
  private currentDimensions(): string { return `${this.options.getWidth?.() ?? ''}:${this.options.getHeight()}`; }
  render(width: number): string[] {
    const height = Math.max(1, this.options.getHeight());
    this.dimensions = this.currentDimensions(); this.usable = width >= 24 && height >= 6;
    const keyLabel = (key: string | undefined) => key === 'enter' ? 'Enter' : key === 'escape' ? 'Esc' : key ?? 'unbound';
    const confirmLabel = keyLabel(this.options.keybindings.getKeys(this.editing ? 'tui.input.submit' : 'tui.select.confirm')[0]);
    const cancelLabel = keyLabel(this.options.keybindings.getKeys('tui.select.cancel')[0]);
    const resize = () => {
      this.usable = false; this.rendered = false;
      return [width < 1 ? '' : truncateToWidth(`Resize required · ${cancelLabel} back`, width, '')];
    };
    if (!this.usable) return resize();
    const { theme } = this.options, run = this.selected();
    const listActions = run?.phase === 'stop-timeout' ? 'x Stop · k Force kill' : run && run.phase !== 'terminal' ? 'x Stop' : '';
    const warnings = { stop: 'Send SIGTERM to owned live group?', force: 'Send SIGKILL to owned live group?', clear: 'Delete record and retained logs?', write: 'Send exact text (no newline)?', eof: 'Close stdin permanently (EOF)?' };
    let title = 'Processes', hint = `Enter details${listActions ? ` · ${listActions}` : ''} · / search · ? help · Esc close`;
    if (this.help) {
      title = 'Processes · Help'; hint = '↑↓ scroll · ? close help · Esc back';
    } else if (this.confirmation) {
      title = `Confirm ${this.confirmation.action}`; hint = 'y confirm · n cancel · Esc back';
    } else if (this.screen === 'list') {
      title += this.options.state.query ? ` · ${safeText(this.options.state.query)}` : '';
    } else if (run && this.screen === 'details') {
      title = safeText(run.name);
      hint = `Enter logs · ${run.phase === 'terminal' ? 'c clear' : run.phase === 'stop-timeout' ? 'k force · s stop' : 's stop'}${run.outcome === 'failed' && !run.acknowledged ? ' · a ack' : ''}${run.phase === 'running' ? ' · w stdin · e EOF' : ''} · ? · Esc back`;
    } else if (run) {
      const view = this.logView();
      title = `${safeText(run.name)} · ${view.stream} · ${view.follow ? 'follow' : 'paused'}${view.newer ? ' +new' : ''}`;
      hint = '↑↓ scroll · f follow · t stream · / search · ? · Esc back';
    }
    if (this.editing) hint = `${this.editing === 'write' ? 'Exact stdin (no newline)' : 'Literal search'} · Enter apply · Esc cancel`;
    hint = (this.busy ? 'Working… · Esc back' : hint).replaceAll('Enter', confirmLabel).replaceAll('Esc', cancelLabel);
    const wrapHints = (columns: number): string[] => {
      const lines: string[] = [];
      for (const item of hint.split(' · ')) {
        const last = lines.at(-1), combined = last ? `${last} · ${item}` : item;
        if (last && visibleWidth(combined) <= columns) lines[lines.length - 1] = combined;
        else lines.push(...wrapTextWithAnsi(item, columns));
      }
      return lines;
    };
    // Budget controls first. Shed decoration before sacrificing warning/target or log rows.
    const layouts = [
      { frame: true, rules: true, title: true, padding: 1, chrome: 5, minimum: 3 },
      { frame: true, rules: false, title: true, padding: 0, chrome: 3, minimum: 2 },
      { frame: false, rules: false, title: true, padding: 0, chrome: 1, minimum: 1 },
      { frame: false, rules: false, title: false, padding: 0, chrome: 0, minimum: 1 },
    ].map(layout => {
      const columns = width - (layout.frame ? 2 : 0) - layout.padding * 2;
      const hints = wrapHints(columns);
      const bottom = (this.error ? 1 : 0) + (this.editing ? 1 : 0) + hints.length;
      const capacity = height - layout.chrome - bottom;
      const minimum = this.confirmation ? wrapTextWithAnsi(warnings[this.confirmation.action], columns).length + (this.confirmation.action === 'write' ? 2 : 1) :
        Math.max(layout.minimum, !this.help && this.screen === 'logs' ? 2 : 1);
      return { ...layout, columns, hints, capacity, minimum };
    });
    const layout = layouts.find(candidate => candidate.capacity >= candidate.minimum);
    if (!layout) return resize();
    const { columns, capacity } = layout;
    const wrap = (line: string) => wrapTextWithAnsi(line, columns);
    const label = (name: string, value: unknown) => `${theme.fg('muted', name)} ${safeText(value)}`;
    let body: string[] = [], selectedRow = -1;
    this.pageSize = capacity;
    if (this.help) {
      const help = this.screen === 'logs' ? ['↑↓/PgUp/PgDn scroll (pauses)', 'f follow · t stream · / literal search', 'Retained tail only; paused view freezes.', '? close help · Esc back'] :
        this.screen === 'list' ? ['Enter details · ↑↓/PgUp/PgDn select', ...(listActions ? [listActions] : []), '/ search', 'Start/rerun via process tool', 'No daemonized/detached descendants.'] :
          ['Enter details/logs · ↑↓ scroll', 's stop · k force after timeout', 'a acknowledge · c clear terminal', 'w single-line stdin · e EOF', 'Start/rerun via process tool', 'No daemonized/detached descendants.'];
      const wrapped = help.flatMap(line => wrap(line.replaceAll('Enter', confirmLabel).replaceAll('Esc', cancelLabel)));
      this.helpOffset = Math.min(this.helpOffset, Math.max(0, wrapped.length - capacity));
      body = wrapped.slice(this.helpOffset, this.helpOffset + capacity);
    } else if (this.confirmation) {
      const target = this.snapshot.runs.find(r => r.id === this.confirmation!.id);
      body = [...wrap(theme.fg('warning', warnings[this.confirmation.action])), safeText(target?.name),
        ...(this.confirmation.action === 'write' ? [safeText(this.confirmation.input)] : [label('$', target?.command), label('cwd:', target?.cwd)])];
    } else if (this.screen === 'list') {
      const runs = this.matches(), index = runs.findIndex(r => r.id === this.options.state.selected);
      const offset = Math.max(0, Math.min(index - capacity + 1, runs.length - capacity));
      selectedRow = index - offset;
      body = runs.slice(offset, offset + capacity).map(r => `${r.id === this.options.state.selected ? '›' : ' '} ${safeText(r.name)} · ${this.phase(r)}${r.error ? ' · !' : ''}`);
      if (!body.length) { body = [this.snapshot.runs.length ? 'No matches' : 'No processes']; selectedRow = -1; }
    } else if (run && this.screen === 'details') {
      const detail = [`${this.phase(run)}${run.acknowledged ? ' · acknowledged' : ''}`, label('ID:', run.id), label('$', run.command), label('cwd:', run.cwd),
        ...(run.pid !== undefined ? [label('PID:', run.pid)] : []),
        ...(run.exitCode !== undefined ? [label('Exit:', run.exitCode)] : []), ...(run.signal ? [label('Signal:', run.signal)] : []),
        ...(run.error ? [theme.fg('error', `Warning: ${safeText(run.error)}`)] : []),
        ...(run.phase === 'terminal' ? [theme.fg('muted', 'Tracked shell exited; descendants not guaranteed.')] : [])];
      const wrapped = detail.flatMap(wrap);
      this.detailsOffset = Math.min(this.detailsOffset, Math.max(0, wrapped.length - capacity));
      body = wrapped.slice(this.detailsOffset, this.detailsOffset + capacity);
    } else if (run) {
      const view = this.logView();
      const flags = `Retained tail${view.rotated ? ' · rotated' : ''}${view.truncated ? ' · truncated' : ''}${view.query ? ` · /${safeText(view.query)}` : ''}`;
      this.pageSize = capacity - 1;
      if (view.follow) view.offset = Math.max(0, view.lines.length - this.pageSize);
      body = [theme.fg('muted', flags), ...view.lines.slice(view.offset, view.offset + this.pageSize)];
    }
    const pad = (line: string, size: number) => {
      const clipped = truncateToWidth(line, size, '…');
      return clipped + ' '.repeat(Math.max(0, size - visibleWidth(clipped)));
    };
    const border = (line: string) => theme.fg('border', line);
    const row = (line: string, selected = false) => {
      const padded = ' '.repeat(layout.padding) + pad(line, columns) + ' '.repeat(layout.padding);
      // Truncation resets styling around the ellipsis; restore selection on each segment.
      const content = selected ? padded.split('\x1b[0m').map(part => theme.bg('selectedBg', part)).join('\x1b[0m') : padded;
      return layout.frame ? border('│') + content + border('│') : content;
    };
    // Input owns its cursor marker; all other data was sanitized before styling.
    const bottom = [...(this.error ? [theme.fg('error', `Error: ${this.error}`)] : []),
      ...(this.editing ? this.input.render(columns) : []), ...layout.hints.map(line => theme.fg('dim', line))];
    const rule = border(`├${'─'.repeat(width - 2)}┤`);
    this.rendered = true;
    return [...(layout.frame ? [border(`╭${'─'.repeat(width - 2)}╮`)] : []), ...(layout.title ? [row(theme.bold(theme.fg('accent', title)))] : []),
      ...(layout.rules ? [rule] : []), ...body.slice(0, capacity).map((line, index) => row(line, index === selectedRow)),
      ...(layout.rules ? [rule] : []), ...bottom.map(line => row(line)),
      ...(layout.frame ? [border(`╰${'─'.repeat(width - 2)}╯`)] : [])];
  }
  private phase(run: Run): string {
    const label = safeText(run.phase === 'terminal' ? run.outcome ?? 'terminal' : run.phase);
    return this.options.theme.fg(run.outcome === 'failed' ? 'error' : run.phase !== 'terminal' ? 'success' : 'muted', label);
  }
}
