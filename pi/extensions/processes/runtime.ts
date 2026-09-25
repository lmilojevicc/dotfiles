import { ProcessManager } from './backend/manager/index.ts';
import { createNotificationRegistry, createNotificationService } from './backend/notifications/service.ts';
import { createNotificationThrottle } from './backend/notifications/throttle.ts';
import type { ProcessNotificationDetails } from './backend/notifications/types.ts';
import type { ProcessInfo } from './backend/types.ts';
import { integer, pattern, streamName, validateNotify, validateWatch } from './backend/validation.ts';
import { safe } from './backend/utils/safe-text.ts';
import type { NotificationDetails, Notify, Run, Runtime, RuntimeEvent, RuntimeOptions, Snapshot, Watch } from './types.ts';

const RESPONSE_BYTES = 50 * 1024;
const copy = <T>(value: T): T => structuredClone(value);
const bounded = (text: string, limit: number): string => safe(text).slice(0, limit);

/** Compatibility facade: ownership, files, output assembly and reaping live in the adapted upstream manager. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  if (process.platform === 'win32') throw new Error('Process runtime requires POSIX');
  const cap = integer(options.maxLogBytes ?? 64 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxLogBytes');
  const maxRuns = options.maxRuns === undefined ? undefined : integer(options.maxRuns, 1, 10000, 'maxRuns');
  const grace = integer(options.stopGraceMs ?? 3000, 1, 60000, 'stopGraceMs');
  const manager = new ProcessManager({ logRoot: options.logRoot, maxLogBytes: cap, stopGraceMs: grace });
  const registry = createNotificationRegistry();
  const metadata = new Map<string, { acknowledged: boolean; notify: Notify }>();
  const outputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let revision = 0;
  let sequence = 0;
  let prunePending = false;
  let closing = false;
  let disposal: Promise<void> | undefined;

  function project(info: ProcessInfo): Run {
    const meta = metadata.get(info.id) ?? { acknowledged: false, notify: {} };
    const terminal = info.status === 'exited' || info.status === 'killed';
    return {
      id: info.id, name: bounded(info.name, 512), command: bounded(info.command, 8192), cwd: bounded(info.cwd, 4096),
      ...(info.pid > 0 ? { pid: info.pid } : {}),
      phase: ({ starting: 'starting', running: 'running', terminating: 'stopping',
        terminate_timeout: 'stop-timeout', exited: 'terminal', killed: 'terminal' } as const)[info.status],
      ...(terminal ? { outcome: info.stopRequested ? 'user-stopped' as const : info.success ? 'successful' as const : 'failed' as const } : {}),
      startedAt: info.startTime, ...(info.endTime !== null ? { endedAt: info.endTime } : {}),
      ...(info.exitCode !== null ? { exitCode: info.exitCode } : {}),
      ...(info.signal ? { signal: info.signal.name } : {}),
      ...(info.errorMessage ? { error: bounded(info.errorMessage, 4000) } : {}),
      stopRequested: info.stopRequested, acknowledged: meta.acknowledged, notify: copy(meta.notify),
      stdoutFile: info.stdoutFile, stderrFile: info.stderrFile,
    };
  }
  function snapshot(): Snapshot {
    const runs = manager.list().map(project);
    return { version: 1, revision, runs, active: runs.filter(r => r.phase !== 'terminal').length,
      unacknowledgedFailed: runs.filter(r => r.outcome === 'failed' && !r.acknowledged).length };
  }
  function emit(event: RuntimeEvent): void {
    for (const listener of [...listeners]) {
      try { Promise.resolve(listener(copy(event))).catch(() => {}); }
      catch { /* Observers cannot interrupt lifecycle handling. */ }
    }
  }
  function changed(): void { revision++; emit({ type: 'snapshot', snapshot: snapshot() }); }
  function accepting(): void { if (closing) throw new Error('Runtime is disposed'); }
  function get(id: string): ProcessInfo {
    const info = manager.get(id);
    if (!info) throw new Error('Unknown process ID');
    return info;
  }
  const unsubscribe = manager.onEvent(event => {
    if (event.type === 'process_output_changed') {
      if (!closing && metadata.has(event.id) && !outputTimers.has(event.id)) {
        outputTimers.set(event.id, setTimeout(() => {
          outputTimers.delete(event.id);
          if (!closing && manager.get(event.id)) emit({ type: 'output', id: event.id });
        }, 30));
      }
    } else if (event.type !== 'process_started') {
      // Clear can be called reentrantly from a final-tail watch. Keep policy
      // tombstones through this synchronous completion dispatch, not authority.
      if (!prunePending) {
        prunePending = true;
        queueMicrotask(() => {
          prunePending = false;
          for (const id of metadata.keys()) if (!manager.get(id)) {
            metadata.delete(id); registry.unregister(id);
            clearTimeout(outputTimers.get(id)); outputTimers.delete(id);
          }
        });
      }
      changed();
    }
  });
  function deliver(payload: ProcessNotificationDetails): void {
    if (closing) return;
    let details: NotificationDetails;
    let text: string;
    let kind: 'completion'|'watch';
    if (payload.kind === 'log_match_suppressed') {
      details = { version: 1, timestamp: payload.timestamp, kind: 'suppression', suppressedCount: payload.suppressedCount ?? 0 };
      text = payload.summary;
      kind = 'watch';
    } else {
      if (!payload.info) return;
      const run = copy(payload.run ?? project(payload.info));
      if (payload.kind === 'log_match' && payload.logMatch) {
        const match = payload.logMatch;
        details = { version: 1, timestamp: payload.timestamp, kind: 'watch', run,
          watch: { pattern: bounded(match.pattern, 500), mode: 'literal', stream: match.stream,
            line: bounded(match.line, 160), matcherIndex: match.matcherIndex } };
        text = `${run.name}: matched ${details.watch.pattern}`;
        kind = 'watch';
      } else {
        details = { version: 1, timestamp: payload.timestamp, kind: 'completion', run };
        text = `${run.name}: ${run.outcome}${run.error ? ` — ${run.error}` : ''}`;
        kind = 'completion';
      }
    }
    emit({ type: 'notification', key: `${payload.processId}:${kind}:${sequence++}`, id: payload.processId,
      kind, attention: payload.attention === 'ignore' ? 'context' : payload.attention,
      text: bounded(text, 5000), details });
  }
  const throttle = createNotificationThrottle(deliver);
  const notifications = createNotificationService({ manager, registry, getProcess: id => manager.get(id), captureRun: project, deliver: throttle.send });

  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start(input) {
      accepting();
      if (maxRuns !== undefined && manager.list().length >= maxRuns) throw new Error('Process capacity reached; clear terminal records');
      for (const key of ['name', 'command', 'cwd'] as const) {
        if (typeof input[key] !== 'string' || !input[key].length || input[key].includes('\0')) throw new Error(`Invalid ${key}`);
      }
      const notify = validateNotify(input.notify);
      const info = manager.start(input.name, input.command, input.cwd);
      metadata.set(info.id, { acknowledged: false, notify });
      registry.register(info.id, copy(notify));
      changed();
      await manager.waitSpawn(info.id);
      return project(get(info.id));
    },
    async output(id, query = {}) {
      accepting();
      const info = get(id);
      const stream = streamName(query.stream);
      const tail = integer(query.tailLines ?? 100, 1, 2000, 'tailLines');
      if (query.pattern !== undefined) pattern(query.pattern, query.mode);
      else if (query.mode !== undefined) pattern('x', query.mode);
      const retained = manager.getRetainedOutput(id, stream);
      const scanned = safe(retained.lines.slice(-5000).join('\n')).split('\n');
      const matches = query.pattern === undefined ? scanned : scanned.filter(line => line.includes(query.pattern!));
      let truncated = retained.rotated || retained.byteLimited || retained.lines.length > 5000 || matches.length > tail;
      let text = matches.slice(-tail).join('\n');
      const prefix = () => `${retained.rotated ? '[retained log rotated]\n' : ''}${truncated ? '[output truncated]\n' : ''}`;
      if (Buffer.byteLength(prefix() + text) > RESPONSE_BYTES) {
        truncated = true;
        const bytes = Buffer.from(text);
        let start = bytes.length - (RESPONSE_BYTES - Buffer.byteLength(prefix()));
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
        text = bytes.subarray(start).toString('utf8');
      }
      return { text: prefix() + text, truncated, rotated: retained.rotated, stdoutFile: info.stdoutFile, stderrFile: info.stderrFile };
    },
    async write(id, input, end = false) {
      accepting(); get(id);
      await manager.writeToStdin(id, input, { end });
    },
    update(id, input) {
      accepting(); const info = get(id);
      if (info.status === 'exited' || info.status === 'killed') throw new Error('Cannot update a terminal process');
      if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.length)) throw new Error('Invalid name');
      const meta = metadata.get(id)!;
      const update = input.watches;
      let items: Watch[] = [];
      if (update) {
        const old = meta.notify.logMatches ?? [];
        const specs = update.items ?? [];
        if (specs.length > 20) throw new Error('At most 20 watches');
        for (const spec of specs) if (spec.mode !== undefined) pattern(spec.pattern ?? 'x', spec.mode);
        if (update.mode === 'append' || update.mode === 'replace') {
          items = specs.map(w => validateWatch(w as Watch));
          if (items.length + (update.mode === 'append' ? old.length : 0) > 20) throw new Error('At most 20 watches');
        } else if (update.mode === 'remove') {
          for (const item of specs) {
            // Reject legacy regex even when index takes precedence.
            if (item.mode !== undefined) pattern(item.pattern ?? 'x', item.mode);
            if (item.index !== undefined) integer(item.index, 0, old.length - 1, 'watch index');
            else pattern(item.pattern!, item.mode);
          }
        } else if (update.mode !== 'clear') throw new Error('Invalid watch update');
      }
      // Deliver already assembled lines against the old generation, not new watches.
      if (update) {
        manager.flushOutputEvents(id);
        const result = update.mode === 'append' ? registry.appendWatches(id, items)
          : update.mode === 'replace' ? registry.replaceWatches(id, items)
          : update.mode === 'clear' ? registry.clearWatches(id)
          : registry.removeWatches(id, update.items ?? []);
        meta.notify.logMatches = result!.logMatches.map(({ identity: _identity, ...watch }) => watch);
      }
      if (input.name !== undefined) manager.rename(id, input.name);
      else changed();
      return project(get(id));
    },
    async stop(id, force = false) {
      accepting(); get(id);
      const result = await manager.kill(id, { signal: force ? 'SIGKILL' : 'SIGTERM', timeoutMs: grace });
      return project(result.info);
    },
    acknowledge(id) {
      accepting(); get(id); const meta = metadata.get(id)!;
      if (!meta.acknowledged) { meta.acknowledged = true; changed(); }
    },
    clear(id) { accepting(); return manager.clearFinished(id); },
    dispose() {
      if (disposal) return disposal;
      closing = true;
      for (const timer of outputTimers.values()) clearTimeout(timer);
      outputTimers.clear();
      notifications.dispose(); throttle.dispose(); registry.clear();
      disposal = Promise.resolve().then(async () => {
        try { await manager.cleanup(); }
        finally { unsubscribe(); listeners.clear(); }
      });
      return disposal;
    },
  };
}
