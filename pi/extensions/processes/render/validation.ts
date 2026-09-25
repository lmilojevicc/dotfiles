// Session replay can contain legacy or edited details; TypeScript shapes do not validate them.
import type { Run, Watch } from '../types.ts';

export const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const oneOf = (v: unknown, choices: readonly string[]) => typeof v === 'string' && choices.includes(v);
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const str = (v: unknown) => typeof v === 'string';
const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v);
const nonnegative = (v: unknown) => integer(v) && (v as number) >= 0;
export const validAttention = (v: unknown) => oneOf(v, ['turn', 'context', 'ignore']);
export const validStream = (v: unknown) => oneOf(v, ['stdout', 'stderr', 'both']);
export const validMode = (v: unknown) => oneOf(v, ['literal', 'regex']);
export function watch(v: unknown): v is Watch {
  const w = record(v);
  return !!w && str(w.pattern) && optional(w.mode, validMode) && optional(w.stream, validStream) &&
    optional(w.on, validAttention) && optional(w.repeat, v => typeof v === 'boolean');
}
export function run(v: unknown): v is Run {
  const r = record(v), notify = record(r?.notify);
  return !!r && str(r.id) && str(r.name) && str(r.command) && str(r.cwd) &&
    oneOf(r.phase, ['starting', 'running', 'stopping', 'stop-timeout', 'terminal']) &&
    optional(r.outcome, v => oneOf(v, ['successful', 'failed', 'user-stopped'])) &&
    finite(r.startedAt) && optional(r.endedAt, finite) && optional(r.pid, nonnegative) &&
    optional(r.exitCode, integer) && optional(r.signal, str) && optional(r.error, str) &&
    typeof r.stopRequested === 'boolean' && typeof r.acknowledged === 'boolean' && !!notify &&
    optional(notify.onSuccess, validAttention) && optional(notify.onFailure, validAttention) &&
    optional(notify.onKilled, validAttention) &&
    optional(notify.logMatches, v => Array.isArray(v) && v.every(watch)) &&
    optional(r.stdoutFile, str) && optional(r.stderrFile, str);
}
export function query(v: unknown): boolean {
  const q = record(v);
  return !!q && optional(q.stream, validStream) && optional(q.pattern, str) &&
    optional(q.tailLines, v => nonnegative(v) && (v as number) > 0);
}
export function presentation(v: unknown): boolean {
  const p = record(v);
  return !!p && optional(p.run, run) && optional(p.before, v => Array.isArray(v) && v.every(watch)) &&
    optional(p.query, query) && optional(p.name, str);
}
export const count = (v: unknown) => nonnegative(v);
export const timestamp = finite;
