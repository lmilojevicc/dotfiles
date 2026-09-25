// Adapted from @aliou/pi-processes 0.12.0 extensions/processes/message-renderer.ts.
import { Container, Text, type Component } from '@earendil-works/pi-tui';
import type { Theme, MessageRenderOptions } from '@earendil-works/pi-coding-agent';
import type { NotificationDetails, RuntimeEvent } from '../types.ts';
import { safeText, safeData } from '../status.ts';
import { state } from './actions.ts';
import { record, run as validRun, validAttention, count, timestamp } from './validation.ts';

export interface MessageDetails {
  id: string; kind: 'completion'|'watch'; attention: 'turn'|'context'|'ignore';
  event?: NotificationDetails;
}
const clean = (value: unknown) => safeText(value).slice(0, 200);
export function notificationMessage(event: Extract<RuntimeEvent, {type:'notification'}>): MessageDetails {
  return { id: clean(event.id), kind: event.kind, attention: event.attention,
    ...(event.details?.version === 1 ? { event: safeData(structuredClone(event.details)) } : {}) };
}
export function renderNotification(message: {content?: unknown;details?: unknown}, options: MessageRenderOptions, theme: Theme): Component {
  const data = record(message.details), event = record(data?.event);
  const watch = record(event?.watch);
  const valid = !!data && typeof data.id === 'string' && (data.kind === 'watch' || data.kind === 'completion') &&
    validAttention(data.attention) && event?.version === 1 && timestamp(event.timestamp) &&
    (event.kind === 'suppression' ? count(event.suppressedCount) :
      event.kind === 'completion' ? data.kind === 'completion' && validRun(event.run) :
      event.kind === 'watch' ? data.kind === 'watch' && validRun(event.run) && !!watch &&
        typeof watch.pattern === 'string' && watch.mode === 'literal' &&
        (watch.stream === 'stdout' || watch.stream === 'stderr') &&
        typeof watch.line === 'string' && count(watch.matcherIndex) : false);
  const container = new Container(), pad = options.outputPad ?? 0;
  const add = (line: string) => container.addChild(new Text(line, pad, 0));
  if (valid && event?.kind === 'suppression') {
    add(theme.fg('muted', `[process] ${event.suppressedCount} watch matches suppressed`));
  } else if (valid && event && (event.kind === 'watch' || event.kind === 'completion') && validRun(event.run)) {
    const run = event.run;
    const name = theme.fg('accent', clean(run.name));
    if (event.kind === 'watch' && watch) {
      add(`${name} ${theme.fg('accent', 'matched')} ${clean(watch.stream)}: ${clean(watch.line)}`);
      if (options.expanded) add(`${theme.fg('muted', 'pattern:')} ${clean(watch.pattern)}  ${theme.fg('muted', 'id:')} ${clean(run.id)}  ${theme.fg('muted', 'notify:')} ${clean(data?.attention)}`);
    } else if (event.kind === 'completion') {
      const seconds = Math.floor(((run.endedAt ?? event.timestamp as number) - run.startedAt) / 1000);
      const duration = run.startedAt > 0 && Number.isFinite(seconds) ? ` · ${Math.max(0, seconds)}s` : '';
      const exit = run.exitCode !== undefined ? ` · exit ${run.exitCode}` : run.signal ? ` · ${clean(run.signal)}` : '';
      const tone = run.outcome === 'failed' ? 'error' : run.outcome === 'successful' ? 'success' : 'warning';
      add(`${name} ${theme.fg(tone, state(run))}${duration}${exit}`);
      if (run.error) add(theme.fg('warning', `warning: ${clean(run.error)}`));
      if (options.expanded) { add(`${theme.fg('muted', 'id:')} ${clean(run.id)}  ${theme.fg('muted', 'notify:')} ${clean(data?.attention)}`); add(`${theme.fg('muted', 'command:')} ${clean(run.command)}`); }
    }
  } else {
    // Older persisted messages have only plain content. Never depend on a live runtime.
    add(theme.fg('warning', `[process] ${data ? 'notification unavailable · malformed details' : safeText(typeof message.content === 'string' ? message.content : '', true).slice(0, 500) || 'notification unavailable'}`));
  }
  return container;
}
