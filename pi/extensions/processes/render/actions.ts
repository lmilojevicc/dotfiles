// Adapted action-specific layouts from @aliou/pi-processes 0.12.0
// extensions/processes/tools/{start,list,output,update,write,stop,clear}/render.ts.
// See UPSTREAM.md for exact source mapping and retained notices.
import { Container, Text, type Component } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Run, Watch } from '../types.ts';
import { safeText } from '../status.ts';
import type { ProcessParams } from '../tool.ts';
import { ToolLayout } from './tool-layout.ts';
import { formatPatternForDisplay, quoteFilter } from './watch.ts';
import { record, run, watch, query, presentation as validPresentation, count, validStream } from './validation.ts';

export interface Presentation {
  run?: Run;
  before?: Watch[];
  query?: { stream?: string; pattern?: string; tailLines?: number };
  name?: string;
}
export interface RenderDetails { version: 1; action: ProcessParams['action']; data: unknown; presentation: Presentation }
const actions = new Set(['start', 'list', 'output', 'write', 'update', 'stop', 'clear']);
const clean = (v: unknown, multiline = false) => Array.from(safeText(v, multiline)).slice(0, 50000).join('');
const warning = (v: string) => `warning: ${Array.from(clean(v)).slice(0, 160).join('')}${Array.from(clean(v)).length > 160 ? '…' : ''}`;
function outputTail(text: string): { text: string; clipped: boolean } {
  // Sanitize the entire bounded Runtime tail before selecting its newest display characters.
  const sourceClipped = text.length > 100000;
  const source = sourceClipped ? text.slice(-100000) : text;
  const safe = Array.from(safeText(Buffer.from(source).toString('utf8'), true));
  return { text: safe.slice(-50000).join(''), clipped: sourceClipped || safe.length > 50000 };
}
const duration = (r: Run, at = Date.now()) => {
  const seconds = Math.floor(((r.endedAt ?? at) - r.startedAt) / 1000);
  return r.startedAt > 0 && Number.isFinite(seconds) ? `${Math.max(0, seconds)}s` : undefined;
};
const tone = (r: Run): 'success'|'error'|'warning'|'muted' => r.phase === 'stop-timeout' ? 'warning' : r.outcome === 'failed' ? 'error' : r.outcome === 'successful' || r.phase === 'running' ? 'success' : r.outcome === 'user-stopped' ? 'warning' : 'muted';
export function state(r: Run): string {
  if (r.phase === 'stop-timeout') return 'still active · stop timed out';
  if (r.outcome === 'user-stopped') return 'stopped by user';
  if (r.outcome === 'successful') return 'completed';
  if (r.outcome === 'failed') return 'failed';
  return r.phase === 'terminal' ? 'finished' : r.phase;
}
// The upstream ToolLayout composes action sections using native Pi components.
class ActionLayout extends ToolLayout {
  private body = new Container();
  constructor() { super(); this.setBody(this.body); }
  add(text: string): this { this.body.addChild(new Text(text, 0, 0)); return this; }
}
function field(label: string, value: unknown, theme: Theme) { return `${theme.fg('muted', label + ':')} ${clean(value)}`; }
function watchLine(w: Watch, theme: Theme): string {
  const attention = w.on ?? 'turn';
  const color = attention === 'turn' ? 'warning' : attention === 'context' ? 'success' : 'muted';
  return `${theme.fg('muted', `[${clean(w.stream ?? 'both')}] literal`)}  ${theme.fg(color, attention + (w.repeat ? ' (repeat)' : ''))}  ${theme.fg('accent', quoteFilter(formatPatternForDisplay(clean(w.pattern)), 'literal'))}`;
}
function expandedRun(r: Run, theme: Theme, command = true): string[] {
  const lines = [field('name', r.name, theme), field('state', state(r), theme), field('id', r.id, theme)];
  if (r.pid !== undefined) lines.push(field('pid', r.pid, theme));
  if (command) lines.push(field('command', r.command, theme));
  lines.push(field('cwd', r.cwd, theme));
  const elapsed = duration(r); if (elapsed) lines.push(field('runtime', elapsed, theme));
  if (r.exitCode !== undefined) lines.push(field('exit', r.exitCode, theme));
  if (r.signal) lines.push(field('signal', r.signal, theme));
  if (r.stdoutFile) lines.push(field('stdout (currently retained)', r.stdoutFile, theme));
  if (r.stderrFile) lines.push(field('stderr (currently retained)', r.stderrFile, theme));
  if (r.error) lines.push(theme.fg('warning', `warning: ${clean(r.error)}`));
  return lines;
}
function safeFallback(result: { content?: unknown; details?: unknown }, expanded: boolean, theme: Theme, error: boolean): Component {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const content = blocks.filter((c): c is {type:'text';text:string} => record(c)?.type === 'text' && typeof record(c)?.text === 'string').map(c => c.text).join('\n');
  // Old results can contain JSON dumps: show a bounded safe excerpt, not control bytes.
  const lines = clean(content || (error ? 'Process failed' : 'Process result unavailable'), true).split('\n');
  const structured = !!record(result.details) || /^\s*[{[]/.test(content);
  if (structured && !error) return new ActionLayout().add(theme.fg('warning', 'Process result unavailable · malformed or unsupported structured details'));
  return new ActionLayout().add(theme.fg(error ? 'error' : 'toolOutput', (expanded ? lines.slice(0, 100) : lines.slice(0, 3)).join('\n') + (lines.length > (expanded ? 100 : 3) ? '\n… expand for more' : '')));
}
export function renderCall(args: ProcessParams, theme: Theme, expanded = false): Component {
  const layout = new ActionLayout();
  const label = `process ${clean(args.action)}${args.name ? ` ${clean(args.name)}` : args.id ? ` ${clean(args.id)}` : ''}`;
  layout.add(theme.fg('toolTitle', label));
  if (args.command) layout.add(theme.fg('muted', `$ ${clean(args.command).slice(0, expanded ? 4000 : 160)}`));
  if (expanded && args.cwd) layout.add(field('cwd', args.cwd, theme));
  return layout;
}
export function renderResult(result: {details?: unknown;content?: unknown}, options: {expanded?: boolean;isPartial?: boolean}, theme: Theme, context?: {isError?: boolean; args?: ProcessParams}): Component {
  if (options.isPartial) return new ActionLayout().add(theme.fg('muted', 'process running…'));
  if (context?.isError) return safeFallback(result, !!options.expanded, theme, true);
  const envelope = record(result.details);
  // Versioned envelope is independent of model JSON. Legacy details remain readable.
  const valid = envelope?.version === 1 && typeof envelope.action === 'string' && actions.has(envelope.action) && validPresentation(envelope.presentation);
  if (envelope?.version !== undefined && !valid) return safeFallback(result, !!options.expanded, theme, false);
  const legacyAction = context?.args && actions.has(context.args.action) ? context.args.action : undefined;
  const action = valid ? envelope.action as ProcessParams['action'] : legacyAction;
  const data = valid ? record(envelope.data) : record(result.details);
  if (!action || !data) return safeFallback(result, !!options.expanded, theme, false);
  const presentation = valid ? envelope!.presentation as Presentation : { query: { stream: context?.args?.stream, pattern: context?.args?.pattern } };
  if (!validPresentation(presentation)) return safeFallback(result, !!options.expanded, theme, false);
  const expanded = !!options.expanded, layout = new ActionLayout();
  const current = run(data) ? data : undefined;
  switch (action) {
    case 'start': case 'stop': case 'update': {
      if (!current) return safeFallback(result, expanded, theme, false);
      const name = clean(current.name);
      layout.add(`${theme.fg('accent', name)} · ${theme.fg(tone(current), state(current))}${action === 'stop' && current.phase === 'stop-timeout' ? ' · explicit force available' : ''}`);
      if (action === 'update' && presentation.run && presentation.run.name !== current.name) layout.add(theme.fg('muted', `renamed ${clean(presentation.run.name)} → ${name}`));
      if (action === 'update' && presentation.before) layout.add(theme.fg('muted', `watches ${presentation.before.length} → ${(current.notify?.logMatches ?? []).length}`));
      if (action === 'start' && current.notify?.logMatches?.length) layout.add(theme.fg('muted', `${current.notify.logMatches.length} watches`));
      if (current.error && !expanded) layout.add(theme.fg('warning', `warning: ${clean(current.error)}`));
      if (expanded) {
        for (const line of expandedRun(current, theme)) layout.add(line);
        if (action === 'update' && presentation.before?.length) for (const w of presentation.before) layout.add(`- ${watchLine(w, theme)}`);
        for (const w of current.notify?.logMatches ?? []) layout.add(watchLine(w, theme));
      }
      break;
    }
    case 'list': {
      if (!Array.isArray(data.runs) || !data.runs.every(run)) return safeFallback(result, expanded, theme, false);
      const runs = data.runs as Run[];
      const active = runs.filter(r => r.phase !== 'terminal').length;
      const failed = runs.filter(r => r.outcome === 'failed').length;
      layout.add(theme.fg('muted', `${runs.length} processes · ${active} active · ${failed} failed`));
      for (const r of runs.slice(0, expanded ? 100 : 2)) {
        layout.add(`${theme.fg('accent', clean(r.name))}  ${theme.fg(tone(r), state(r))}${duration(r) ? `  ${duration(r)}` : ''}${r.exitCode !== undefined ? `  exit ${r.exitCode}` : ''}`);
        if (r.error && !expanded) layout.add(theme.fg('warning', `  ${warning(r.error)}`));
        if (expanded) { layout.add(theme.fg('muted', `  $ ${clean(r.command)}`)); layout.add(field('  id', r.id, theme)); layout.add(field('  cwd', r.cwd, theme)); if (r.error) layout.add(theme.fg('warning', `  warning: ${clean(r.error)}`)); }
      }
      if (runs.length > (expanded ? 100 : 2)) {
        layout.add(theme.fg('muted', `… ${runs.length - (expanded ? 100 : 2)} more`));
        if (!expanded && runs.slice(2).some(r => r.error)) layout.add(theme.fg('warning', 'warning: additional process cleanup warnings · expand to inspect'));
      }
      break;
    }
    case 'output': {
      if (typeof data.text !== 'string' || typeof data.truncated !== 'boolean' || typeof data.rotated !== 'boolean' ||
        (data.stdoutFile !== undefined && typeof data.stdoutFile !== 'string') ||
        (data.stderrFile !== undefined && typeof data.stderrFile !== 'string')) return safeFallback(result, expanded, theme, false);
      const r = presentation.run, name = r?.name ?? presentation.name;
      layout.add(theme.fg('muted', `${name ? clean(name) + ' · ' : ''}${clean(presentation.query?.stream ?? 'both')} output${r ? ` · ${state(r)}` : ''}`));
      const tail = outputTail(data.text), lines = tail.text.split('\n');
      const selected = expanded ? lines.slice(-2000) : lines.slice(-2);
      const preview = expanded ? selected : selected.map(line => Array.from(line).slice(-500).join(''));
      const clipped = tail.clipped || lines.length > selected.length || (!expanded && selected.some((line, i) => Array.from(line).length > Array.from(preview[i]).length));
      layout.add(theme.fg('toolOutput', preview.join('\n') || (presentation.query?.pattern ? 'No matching lines' : 'No output yet')));
      if (clipped || data.truncated || data.rotated) layout.add(theme.fg('warning', [clipped && 'display clipped', data.truncated && 'truncated preview', data.rotated && 'rotated retained log'].filter(Boolean).join(' · ')));
      if (r?.error && !expanded) layout.add(theme.fg('warning', warning(r.error)));
      if (expanded) {
        if (presentation.query?.pattern) layout.add(field('filter (literal)', presentation.query.pattern, theme));
        if (r) for (const line of expandedRun(r, theme)) layout.add(line);
        for (const key of ['stdoutFile', 'stderrFile']) if (typeof data[key] === 'string' && !r?.[key as 'stdoutFile'|'stderrFile']) layout.add(field(`${key} (currently retained)`, data[key], theme));
      }
      break;
    }
    case 'write': {
      if (!count(data.writtenBytes) || typeof data.stdinClosed !== 'boolean' || typeof data.id !== 'string') return safeFallback(result, expanded, theme, false);
      layout.add(theme.fg('success', `wrote ${Number.isSafeInteger(data.writtenBytes) ? data.writtenBytes : 0} bytes${data.stdinClosed === true ? ' · stdin closed (EOF)' : ''}`));
      if (expanded) { if (presentation.name) layout.add(field('name', presentation.name, theme)); if (data.id) layout.add(field('id', data.id, theme)); }
      break;
    }
    case 'clear': if (!count(data.cleared)) return safeFallback(result, expanded, theme, false); layout.add(theme.fg(data.cleared > 0 ? 'success' : 'muted', `${Number.isSafeInteger(data.cleared) ? data.cleared : 0} processes cleared`)); break;
  }
  return layout;
}
