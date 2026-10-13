import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Snapshot } from './types.ts';

export const SNAPSHOT_REQUEST = 'processes:snapshot:request:v1';
export const SNAPSHOT_EVENT = 'processes:snapshot:v1';
const VARIABLE_CAPABILITY = 'zentui:variable-capability';
const VARIABLE_EVENT = 'zentui:variable';
const STATUS_VARIABLE = 'pi-processes:status';

// Adapter boundary: even snapshots and errors from an alternate runtime are data,
// never terminal instructions. Incomplete control strings consume the remainder.
export function safeText(value: unknown, multiline = false, preserveTabs = false): string {
  const text = String(value ?? '').slice(0, 100_000);
  let output = '', state = 'text', osc = false;
  for (const c of text) {
    const n = c.codePointAt(0)!;
    if (state === 'stringEscape') { state = c === '\\' || n === 0x9c ? 'text' : 'string'; continue; }
    if (state === 'string') {
      if (c === '\x1b') state = 'stringEscape';
      else if (n === 0x9c || (osc && n === 7)) state = 'text';
      continue;
    }
    if (state === 'csi') { if (n >= 0x40 && n <= 0x7e) state = 'text'; else if (n === 27) state = 'escape'; continue; }
    if (state === 'escape') {
      if (c === '[') state = 'csi';
      else if (']PX^_'.includes(c)) { state = 'string'; osc = c === ']'; }
      else if (n < 0x20 || n > 0x2f) state = 'text';
      continue;
    }
    if (n === 27) state = 'escape';
    else if (n === 0x9b) state = 'csi';
    else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(n)) { state = 'string'; osc = n === 0x9d; }
    else if (c === '\n') output += multiline ? '\n' : ' ';
    else if (c === '\t') output += preserveTabs ? '\t' : '    ';
    else if (n >= 32 && !(n >= 127 && n <= 159) && !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u.test(c)) output += c;
  }
  return output;
}

export function safeData<T>(value: T): T {
  // Keep permitted tabs in structured data so already byte-bounded output cannot grow.
  // Display renderers expand tabs separately through safeText's default policy.
  if (typeof value === 'string') return safeText(value, true, true) as T;
  if (Array.isArray(value)) return value.map(safeData) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeData(item)])) as T;
  return value;
}

export function statusText(snapshot: Snapshot, theme: Pick<Theme, 'fg'>): string | undefined {
  const active = snapshot.runs.filter(r => ['starting', 'running', 'stopping', 'stop-timeout'].includes(r.phase)).length;
  const failed = snapshot.runs.filter(r => r.outcome === 'failed' && !r.acknowledged).length;
  return [active ? theme.fg('success', `${active} active`) : '', failed ? theme.fg('error', `${failed} failed`) : ''].filter(Boolean).join(' · ') || undefined;
}

export function readDefaultStatus(agentDir: string, warn: (text: string) => void): boolean {
  try {
    const value = JSON.parse(readFileSync(join(agentDir, 'processes.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value.defaultStatus !== undefined && typeof value.defaultStatus !== 'boolean')) throw new Error('defaultStatus must be boolean');
    return value.defaultStatus !== false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`processes.json: ${safeText(error instanceof Error ? error.message : error)}`);
    return true;
  }
}

// Pi isolates bus listeners; additionally isolate synchronous emit failures and
// user-provided reply promises so neither can interrupt runtime observations.
export function isolate(fn: () => unknown): void {
  try { Promise.resolve(fn()).catch(() => {}); } catch { /* Receiver-owned failure. */ }
}

export function attachStatus(pi: ExtensionAPI, ctx: ExtensionContext, getSnapshot: () => Snapshot, enabled: boolean) {
  let closed = false, published = false;
  const clearVariable = () => {
    if (!published) return;
    isolate(() => {
      pi.events.emit(VARIABLE_EVENT, { key: STATUS_VARIABLE, text: undefined });
      published = false;
    });
  };
  const off = pi.events.on(SNAPSHOT_REQUEST, (data: unknown) => {
    if (closed || !data || typeof data !== 'object') return;
    const request = data as { version?: unknown; reply?: unknown };
    if (request.version !== 1 || typeof request.reply !== 'function') return;
    isolate(() => (request.reply as (s: Snapshot) => unknown)(safeData(getSnapshot())));
  });
  return {
    publish(snapshot: Snapshot) {
      if (closed) return;
      let text: string | undefined, active = false, custom = false;
      isolate(() => { if (ctx.hasUI && (enabled || ctx.mode === 'tui')) text = statusText(snapshot, ctx.ui.theme); });
      isolate(() => {
        if (!ctx.hasUI || ctx.mode !== 'tui' || closed) return;
        const capability: { supported: boolean; active: boolean; key: string; version?: number } = { supported: false, active: false, key: STATUS_VARIABLE };
        pi.events.emit(VARIABLE_CAPABILITY, capability);
        active = capability.supported === true && capability.active === true && capability.version === 1;
      });
      if (closed) return;
      if (active) isolate(() => {
        // Track before dispatch so even a throwing receiver can be cleared later.
        published = true;
        pi.events.emit(VARIABLE_EVENT, { key: STATUS_VARIABLE, text });
        published = !closed && text !== undefined;
        custom = true;
      });
      else clearVariable();
      if (closed) return;
      isolate(() => { if (ctx.hasUI) ctx.ui.setStatus('processes', enabled && !custom ? text : undefined); });
      if (!closed) isolate(() => pi.events.emit(SNAPSHOT_EVENT, safeData(snapshot)));
    },
    dispose() {
      if (closed) return;
      closed = true; isolate(off);
      clearVariable();
      isolate(() => { if (ctx.hasUI) ctx.ui.setStatus('processes', undefined); });
    },
  };
}
