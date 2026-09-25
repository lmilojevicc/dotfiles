import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Attention, Notify, Run, Runtime, RuntimeEvent, RuntimeOptions, Snapshot, Stream, Watch } from './types.ts';

const RESPONSE_BYTES = 50 * 1024;
const DRAIN_MS = 200;
const DESCENDANTS = 'Tracked shell exited; descendants may still be running. Inherited output pipes were closed after the drain deadline. Background/daemonized descendants are unsupported.';

// Streaming terminal-control parser: never retain an unbounded escape sequence.
class SafeText {
  state: 'text'|'escape'|'csi'|'string'|'string-escape' = 'text';
  osc = false;
  push(text: string): string {
    let result = '';
    for (const c of text) {
      const n = c.codePointAt(0)!;
      if (this.state === 'string-escape') {
        this.state = c === '\\' || n === 0x9c ? 'text' : 'string';
        continue;
      }
      if (this.state === 'string') {
        if (c === '\x1b') this.state = 'string-escape';
        else if ((this.osc && n === 7) || n === 0x9c) this.state = 'text';
        continue;
      }
      if (this.state === 'csi') {
        if (n >= 0x40 && n <= 0x7e) this.state = 'text';
        else if (n === 0x1b) this.state = 'escape';
        continue;
      }
      if (this.state === 'escape') {
        if (c === '[') this.state = 'csi';
        else if (']PX^_'.includes(c)) { this.state = 'string'; this.osc = c === ']'; }
        else if (n < 0x20 || n > 0x2f) this.state = 'text';
        continue;
      }
      if (n === 0x1b) this.state = 'escape';
      else if (n === 0x9b) this.state = 'csi';
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(n)) { this.state = 'string'; this.osc = n === 0x9d; }
      else if (c === '\n' || c === '\t' || (n >= 0x20 && !(n >= 0x7f && n <= 0x9f) && !/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u.test(c))) result += c;
    }
    return result;
  }
}
const safe = (s: string): string => new SafeText().push(s);
const copy = <T>(value: T): T => structuredClone(value);
const message = (error: unknown): string => safe(error instanceof Error ? error.message : String(error));
function integer(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function pattern(pattern: string, mode?: string): void {
  if (mode === 'regex') throw new Error('Regex is unsupported in v1; use literal matching');
  if (mode !== undefined && mode !== 'literal') throw new Error('Invalid match mode');
  if (typeof pattern !== 'string' || !pattern.length || pattern.length > 500) throw new Error('Pattern must contain 1–500 characters');
}
function attention(on: unknown): void {
  if (on !== undefined && !['turn', 'context', 'ignore'].includes(on as string)) throw new Error('Invalid attention');
}
function streamName(stream: string = 'both'): Stream {
  if (!['stdout', 'stderr', 'both'].includes(stream)) throw new Error('Invalid stream');
  return stream as Stream;
}
function validateWatch(watch: Watch): Watch {
  pattern(watch.pattern, watch.mode);
  if (safe(watch.pattern) !== watch.pattern) throw new Error('Watch patterns must contain safe display text');
  streamName(watch.stream);
  attention(watch.on);
  if (watch.repeat !== undefined && typeof watch.repeat !== 'boolean') throw new Error('Invalid repeat');
  return copy(watch);
}
function validateNotify(input: Notify = {}): Notify {
  attention(input.onSuccess); attention(input.onFailure); attention(input.onKilled);
  if (input.logMatches && (!Array.isArray(input.logMatches) || input.logMatches.length > 20)) throw new Error('At most 20 watches');
  return { ...copy(input), ...(input.logMatches ? { logMatches: input.logMatches.map(validateWatch) } : {}) };
}

// Private fixed-size ring files. Synchronous bounded writes avoid an unbounded disk queue.
class Log {
  fd: number;
  size = 0;
  cursor = 0;
  rotated = false;
  readonly path: string;
  readonly cap: number;
  constructor(path: string, cap: number) {
    this.path = path; this.cap = cap;
    this.fd = openSync(path, 'wx+', 0o600);
  }
  append(text: string): void {
    let bytes = Buffer.from(text);
    if (!bytes.length) return;
    if (this.size + bytes.length > this.cap) this.rotated = true;
    if (bytes.length >= this.cap) {
      bytes = bytes.subarray(bytes.length - this.cap);
      this.cursor = 0;
      this.size = 0;
      ftruncateSync(this.fd, 0);
    }
    const first = Math.min(bytes.length, this.cap - this.cursor);
    this.write(bytes.subarray(0, first), this.cursor);
    if (first < bytes.length) this.write(bytes.subarray(first), 0);
    this.cursor = (this.cursor + bytes.length) % this.cap;
    this.size = Math.min(this.cap, this.size + bytes.length);
  }
  private write(bytes: Buffer, offset: number): void {
    let written = 0;
    while (written < bytes.length) written += writeSync(this.fd, bytes, written, bytes.length - written, offset + written);
  }
  text(): string {
    const bytes = Buffer.alloc(this.size);
    const start = this.size === this.cap ? this.cursor : 0;
    const first = Math.min(this.size, this.cap - start);
    readSync(this.fd, bytes, 0, first, start);
    if (first < this.size) readSync(this.fd, bytes, first, this.size - first, 0);
    let skip = 0;
    while (skip < bytes.length && (bytes[skip] & 0xc0) === 0x80) skip++;
    return bytes.subarray(skip).toString('utf8');
  }
  close(): void { if (this.fd !== -1) { closeSync(this.fd); this.fd = -1; } }
}
interface WatchState { watch: Watch; tail: string; fired: boolean; last: number; serial: number }
interface RecordState {
  run: Run; child: ChildProcessWithoutNullStreams; logs: Record<Stream, Log>;
  watches: WatchState[]; nextWatch: number; notification: number;
  exit: Promise<void>; resolveExit: () => void;
  drained: Promise<void>; resolveDrained: () => void;
  drainTimer?: ReturnType<typeof setTimeout>; outputTimer?: ReturnType<typeof setTimeout>;
  stopWait?: Promise<Run>; closed: boolean; completed: boolean; writing: boolean;
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  if (process.platform === 'win32') throw new Error('Process runtime requires POSIX');
  const cap = integer(options.maxLogBytes ?? 1024 * 1024, 1, 16 * 1024 * 1024, 'maxLogBytes');
  const maxRuns = integer(options.maxRuns ?? 100, 1, 10000, 'maxRuns');
  const grace = integer(options.stopGraceMs ?? 3000, 1, 60000, 'stopGraceMs');
  const records = new Map<string, RecordState>();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let revision = 0;
  let root: string | undefined;
  let closing = false;
  let disposal: Promise<void> | undefined;
  const cleanupErrors = new Set<string>();

  function snapshot(): Snapshot {
    const runs = [...records.values()].map(r => copy(r.run));
    return { version: 1, revision, runs, active: runs.filter(r => r.phase !== 'terminal').length,
      unacknowledgedFailed: runs.filter(r => r.outcome === 'failed' && !r.acknowledged).length };
  }
  function emit(event: RuntimeEvent): void {
    for (const listener of [...listeners]) {
      try { Promise.resolve(listener(copy(event))).catch(() => {}); }
      catch { /* Subscribers cannot interrupt lifecycle handling. */ }
    }
  }
  function changed(): void { revision++; emit({ type: 'snapshot', snapshot: snapshot() }); }
  function accepting(): void { if (closing) throw new Error('Runtime is disposed'); }
  function get(id: string): RecordState {
    const r = records.get(id);
    if (!r) throw new Error('Unknown process ID');
    return r;
  }
  function notify(r: RecordState, kind: 'completion'|'watch', on: Attention, text: string, key: string): void {
    if (!closing && on !== 'ignore') emit({ type: 'notification', id: r.run.id, kind, attention: on, text: safe(text), key: `${r.run.id}:${key}` });
  }
  function warning(r: RecordState, text: string): void {
    if (r.run.error?.includes(text)) return;
    r.run.error = r.run.error ? `${r.run.error}; ${text}` : text;
    cleanupErrors.add(`${r.run.id}: ${text}`);
    if (records.has(r.run.id)) changed();
  }
  function completion(r: RecordState): void {
    if (r.completed || r.run.phase !== 'terminal') return;
    r.completed = true;
    let on: Attention;
    if (r.run.outcome === 'user-stopped') on = 'context';
    else if (r.run.signal) on = r.run.notify.onKilled ?? 'context';
    else if (r.run.outcome === 'failed') on = r.run.notify.onFailure === 'ignore' ? 'context' : r.run.notify.onFailure ?? 'turn';
    else on = r.run.notify.onSuccess ?? 'turn';
    if (r.run.error && on === 'ignore') on = 'context';
    notify(r, 'completion', on, `${r.run.name}: ${r.run.outcome}${r.run.error ? ` — ${r.run.error}` : ''}`, 'completion');
  }
  function drained(r: RecordState): void {
    if (r.closed) return;
    r.closed = true;
    clearTimeout(r.drainTimer);
    r.resolveDrained();
    completion(r);
  }
  function finish(r: RecordState, code: number | null, signal: string | null, error?: unknown): void {
    if (r.run.phase === 'terminal') return;
    r.run.phase = 'terminal';
    r.run.endedAt = Date.now();
    if (code !== null) r.run.exitCode = code;
    if (signal !== null) r.run.signal = signal;
    if (error !== undefined) r.run.error = message(error);
    r.run.outcome = r.run.stopRequested ? 'user-stopped' : code === 0 && !signal && !error ? 'successful' : 'failed';
    // Exit belongs to the tracked shell, not a census of its descendants. Once
    // observed, revoke group signaling permanently: PGID reuse is unsafe.
    r.resolveExit();
    if (!r.closed) r.drainTimer = setTimeout(() => {
      if (!r.child.stdout.readableEnded || !r.child.stderr.readableEnded) warning(r, DESCENDANTS);
      r.child.stdout.destroy(); r.child.stderr.destroy(); r.child.stdin.destroy();
      drained(r);
    }, DRAIN_MS);
    changed();
    if (r.closed) completion(r);
  }
  function liveOwner(r: RecordState): boolean {
    return r.run.phase !== 'terminal' && r.child.pid !== undefined && r.child.exitCode === null && r.child.signalCode === null;
  }
  function signal(r: RecordState, sig: NodeJS.Signals): boolean {
    if (!liveOwner(r)) return false;
    try { process.kill(-r.child.pid!, sig); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  }
  function install(r: RecordState, watches: Watch[]): void {
    r.watches = watches.map(watch => ({ watch, tail: '', fired: false, last: -Infinity, serial: r.nextWatch++ }));
  }
  function receive(r: RecordState, stream: 'stdout'|'stderr', text: string): void {
    if (r.closed || !text) return;
    try { r.logs[stream].append(text); r.logs.both.append(text); }
    catch (error) { warning(r, `Log write failed: ${message(error)}`); }
    for (const state of r.watches) {
      const w = state.watch;
      if (w.stream && w.stream !== 'both' && w.stream !== stream) continue;
      const combined = state.tail + text;
      const matched = combined.includes(w.pattern);
      state.tail = combined.slice(-Math.max(0, w.pattern.length - 1));
      if (w.pattern.length === 1) state.tail = '';
      const now = Date.now();
      if (matched && (!state.fired || (w.repeat && now - state.last >= 1000))) {
        state.fired = true; state.last = now;
        notify(r, 'watch', w.on === 'ignore' ? 'context' : w.on ?? 'turn', `${r.run.name}: matched ${safe(w.pattern)}`, `watch:${state.serial}:${r.notification++}`);
      }
    }
    if (!r.outputTimer && !closing) r.outputTimer = setTimeout(() => {
      r.outputTimer = undefined;
      if (records.has(r.run.id) && !closing) emit({ type: 'output', id: r.run.id });
    }, 30);
  }
  async function waitExit(r: RecordState, ms: number): Promise<boolean> {
    if (r.run.phase === 'terminal') return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([r.exit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
  function closeLogs(r: RecordState): void {
    for (const log of Object.values(r.logs)) log.close();
  }

  const runtime: Runtime = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start(input) {
      accepting();
      if (records.size >= maxRuns) throw new Error('Process capacity reached; clear terminal records');
      for (const key of ['name', 'command', 'cwd'] as const) {
        if (typeof input[key] !== 'string' || !input[key].length || input[key].includes('\0')) throw new Error(`Invalid ${key}`);
      }
      const notify = validateNotify(input.notify);
      root ??= mkdtempSync(join(options.logRoot ?? tmpdir(), 'pi-processes-'));
      const id = randomUUID();
      const logs = {} as Record<Stream, Log>;
      try { for (const s of ['stdout', 'stderr', 'both'] as const) logs[s] = new Log(join(root, `${id}-${s}.log`), cap); }
      catch (error) { for (const log of Object.values(logs)) { log.close(); rmSync(log.path, { force: true }); } throw error; }
      let child: ChildProcessWithoutNullStreams;
      try { child = spawn('/bin/sh', ['-c', input.command], { cwd: input.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { for (const log of Object.values(logs)) { log.close(); rmSync(log.path, { force: true }); } throw error; }
      const r: RecordState = {
        run: { id, name: safe(input.name), command: safe(input.command), cwd: safe(input.cwd), phase: 'starting', startedAt: Date.now(), stopRequested: false, acknowledged: false, notify },
        child, logs, watches: [], nextWatch: 0, notification: 0,
        exit: undefined!, resolveExit: undefined!, drained: undefined!, resolveDrained: undefined!,
        closed: false, completed: false, writing: false,
      };
      r.exit = new Promise(resolve => { r.resolveExit = resolve; });
      r.drained = new Promise(resolve => { r.resolveDrained = resolve; });
      if (child.pid !== undefined) r.run.pid = child.pid;
      install(r, notify.logMatches ?? []);
      records.set(id, r);
      child.stdin.on('error', () => { /* write callbacks report failures; EOF races must not crash Pi. */ });
      for (const stream of ['stdout', 'stderr'] as const) {
        const decoder = new StringDecoder('utf8');
        const sanitizer = new SafeText();
        child[stream].on('data', (bytes: Buffer) => receive(r, stream, sanitizer.push(decoder.write(bytes))));
        child[stream].on('end', () => receive(r, stream, sanitizer.push(decoder.end())));
        child[stream].on('error', error => warning(r, `Output failed: ${message(error)}`));
      }
      child.once('error', error => finish(r, null, null, error));
      child.once('exit', (code, sig) => finish(r, code, sig));
      child.once('close', () => drained(r));
      const spawned = new Promise<void>(resolve => {
        child.once('spawn', () => { if (r.run.phase === 'starting') { r.run.phase = 'running'; changed(); } resolve(); });
        child.once('error', () => resolve());
      });
      changed();
      await spawned;
      return copy(r.run);
    },
    async output(id, query = {}) {
      accepting();
      const r = get(id);
      const stream = streamName(query.stream);
      const tail = integer(query.tailLines ?? 100, 1, 2000, 'tailLines');
      if (query.pattern !== undefined) pattern(query.pattern, query.mode);
      else if (query.mode !== undefined) pattern('x', query.mode);
      const log = r.logs[stream];
      const retained = log.text();
      const scanned: string[] = [];
      let cursor = retained.endsWith('\n') ? retained.length - 1 : retained.length;
      if (!retained.length) cursor = -1;
      while (cursor >= 0 && scanned.length < 5000) {
        const newline = cursor === 0 ? -1 : retained.lastIndexOf('\n', cursor - 1);
        scanned.push(retained.slice(newline + 1, cursor));
        cursor = newline;
      }
      scanned.reverse();
      const matches = query.pattern === undefined ? scanned : scanned.filter(line => line.includes(query.pattern!));
      let truncated = log.rotated || cursor >= 0 || matches.length > tail;
      let text = matches.slice(-tail).join('\n');
      const prefix = () => `${log.rotated ? '[retained log rotated]\n' : ''}${truncated ? '[output truncated]\n' : ''}`;
      if (Buffer.byteLength(prefix() + text) > RESPONSE_BYTES) {
        truncated = true;
        const bytes = Buffer.from(text);
        let start = bytes.length - (RESPONSE_BYTES - Buffer.byteLength(prefix()));
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        text = bytes.subarray(start).toString('utf8');
      }
      return { text: prefix() + text, truncated, rotated: log.rotated };
    },
    async write(id, input, end = false) {
      accepting();
      const r = get(id);
      if (!liveOwner(r) || r.child.stdin.destroyed || r.child.stdin.writableEnded) throw new Error('Process stdin is closed');
      if (typeof input !== 'string' || Buffer.byteLength(input) > RESPONSE_BYTES) throw new Error('Input exceeds 50 KiB');
      if (r.writing) throw new Error('A stdin write is already pending');
      r.writing = true;
      try {
        await new Promise<void>((resolve, reject) => {
          const stdin = r.child.stdin;
          const onClose = () => done(new Error('Process stdin closed before write completed'));
          const done = (error?: Error | null) => {
            stdin.off('error', done); stdin.off('close', onClose);
            error ? reject(new Error(message(error))) : resolve();
          };
          stdin.once('error', done); stdin.once('close', onClose);
          if (end) stdin.end(input, done);
          else stdin.write(input, done);
        });
      } finally { r.writing = false; }
    },
    update(id, input) {
      accepting(); const r = get(id);
      if (r.run.phase === 'terminal') throw new Error('Cannot update a terminal process');
      if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.length)) throw new Error('Invalid name');
      let next: Watch[] | undefined;
      const update = input.watches;
      if (update) {
        const old = r.run.notify.logMatches ?? [];
        const items = update.items ?? [];
        if (items.length > 20) throw new Error('At most 20 watches');
        if (update.mode === 'clear') next = [];
        else if (update.mode === 'append' || update.mode === 'replace') {
          const watches = items.map(w => validateWatch(w as Watch));
          next = update.mode === 'append' ? [...old, ...watches] : watches;
        } else if (update.mode === 'remove') {
          for (const item of items) {
            if (item.index !== undefined) integer(item.index, 0, old.length - 1, 'watch index');
            else pattern(item.pattern!, item.mode);
          }
          next = old.filter((w, i) => !items.some(item => item.index !== undefined ? item.index === i : item.pattern === w.pattern));
        } else throw new Error('Invalid watch update');
        if (next.length > 20) throw new Error('At most 20 watches');
      }
      if (input.name !== undefined) r.run.name = safe(input.name);
      if (next) {
        const oldStates = r.watches;
        r.run.notify.logMatches = next;
        if (update!.mode === 'append' || update!.mode === 'remove') {
          r.watches = next.map(watch => oldStates.find(s => s.watch === watch) ?? { watch, tail: '', fired: false, last: -Infinity, serial: r.nextWatch++ });
        } else install(r, next);
      }
      changed(); return copy(r.run);
    },
    async stop(id, force = false) {
      accepting(); const r = get(id);
      if (r.run.phase === 'terminal') return copy(r.run);
      if (!force && r.stopWait) return r.stopWait;
      // Signal first: a raced-away owner must not change a natural outcome.
      const sent = signal(r, force ? 'SIGKILL' : 'SIGTERM');
      if (sent) { r.run.stopRequested = true; r.run.phase = 'stopping'; changed(); }
      const wait = (async () => {
        if (!(await waitExit(r, grace)) && r.run.phase !== 'terminal') { r.run.phase = 'stop-timeout'; changed(); }
        return copy(r.run);
      })();
      r.stopWait = wait;
      try { return await wait; } finally { if (r.stopWait === wait) r.stopWait = undefined; }
    },
    acknowledge(id) {
      accepting(); const r = get(id);
      if (!r.run.acknowledged) { r.run.acknowledged = true; changed(); }
    },
    clear(id) {
      accepting();
      const targets = id === undefined ? [...records.values()].filter(r => r.run.phase === 'terminal') : [get(id)];
      if (targets.some(r => r.run.phase !== 'terminal')) throw new Error('Cannot clear a live process');
      for (const r of targets) {
        clearTimeout(r.outputTimer);
        if (!r.closed) {
          if (!r.child.stdout.readableEnded || !r.child.stderr.readableEnded) warning(r, 'Tracked shell exited; output cleared before pipes drained. Descendant cleanup is not guaranteed.');
          r.child.stdout.destroy(); r.child.stderr.destroy(); r.child.stdin.destroy(); drained(r);
        }
        closeLogs(r);
        for (const log of Object.values(r.logs)) rmSync(log.path, { force: true });
        records.delete(r.run.id);
      }
      if (targets.length) changed();
      return targets.length;
    },
    dispose() {
      if (disposal) return disposal;
      closing = true;
      // Defer work so a reentrant subscriber sees the same disposal promise.
      disposal = Promise.resolve().then(async () => {
        const owned = [...records.values()];
        for (const r of owned) {
          clearTimeout(r.outputTimer);
          try { if (signal(r, 'SIGTERM')) { r.run.stopRequested = true; r.run.phase = 'stopping'; changed(); } }
          catch (error) { warning(r, `Cleanup TERM failed: ${message(error)}`); }
        }
        await Promise.all(owned.map(r => waitExit(r, grace)));
        for (const r of owned) {
          try { signal(r, 'SIGKILL'); }
          catch (error) { warning(r, `Cleanup KILL failed: ${message(error)}`); }
        }
        await Promise.all(owned.map(r => waitExit(r, Math.min(grace, 1000))));
        for (const r of owned) {
          if (r.run.phase !== 'terminal') {
            warning(r, 'Cleanup deadline exceeded; tracked child exit was not observed');
            r.child.unref(); // An unobservable child must not veto host shutdown.
          } else await r.drained;
          r.child.stdin.destroy(); r.child.stdout.destroy(); r.child.stderr.destroy();
          drained(r);
          clearTimeout(r.drainTimer);
          try { closeLogs(r); } catch (error) { cleanupErrors.add(message(error)); }
        }
        if (root) { try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.add(message(error)); } }
        listeners.clear();
        if (cleanupErrors.size) throw new Error(`Process cleanup: ${[...cleanupErrors].join('; ')}`);
      });
      return disposal;
    },
  };
  return runtime;
}
