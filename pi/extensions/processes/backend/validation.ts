import type { Notify, Stream, Watch } from '../types.ts';
import { safe } from './utils/safe-text.ts';
export function integer(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
export function pattern(pattern: string, mode?: string): void {
  if (mode === 'regex') throw new Error('Regex is unsupported in v1; use literal matching');
  if (mode !== undefined && mode !== 'literal') throw new Error('Invalid match mode');
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 500) throw new Error('Pattern must contain 1–500 characters');
}
export function attention(on: unknown): void {
  if (on !== undefined && !['turn', 'context', 'ignore'].includes(on as string)) throw new Error('Invalid attention');
}
export function streamName(stream: string = 'both'): Stream {
  if (!['stdout', 'stderr', 'both'].includes(stream)) throw new Error('Invalid stream');
  return stream as Stream;
}
export function validateWatch(watch: Watch): Watch {
  pattern(watch.pattern, watch.mode);
  if (safe(watch.pattern) !== watch.pattern) throw new Error('Watch patterns must contain safe display text');
  streamName(watch.stream);
  attention(watch.on);
  if (watch.repeat !== undefined && typeof watch.repeat !== 'boolean') throw new Error('Invalid repeat');
  return { pattern: watch.pattern,
    ...(watch.mode !== undefined ? { mode: watch.mode } : {}),
    ...(watch.stream !== undefined ? { stream: watch.stream } : {}),
    ...(watch.repeat !== undefined ? { repeat: watch.repeat } : {}),
    ...(watch.on !== undefined ? { on: watch.on } : {}) };
}
export function validateNotify(input: Notify = {}): Notify {
  attention(input.onSuccess); attention(input.onFailure); attention(input.onKilled);
  if (input.logMatches && (!Array.isArray(input.logMatches) || input.logMatches.length > 20)) throw new Error('At most 20 watches');
  return {
    ...(input.onSuccess !== undefined ? { onSuccess: input.onSuccess } : {}),
    ...(input.onFailure !== undefined ? { onFailure: input.onFailure } : {}),
    ...(input.onKilled !== undefined ? { onKilled: input.onKilled } : {}),
    ...(input.logMatches ? { logMatches: input.logMatches.map(validateWatch) } : {}) };
}
