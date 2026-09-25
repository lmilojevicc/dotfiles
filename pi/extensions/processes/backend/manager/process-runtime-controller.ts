// Source: @aliou/pi-processes 0.12.0; local compatibility patches: ../UPSTREAM.md.
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { SafeText, safe } from "../utils/safe-text.ts";

import type {
  KillResult,
  ManagerEvent,
} from "../types.ts";
import { LIVE_STATUSES } from "../types.ts";
import { isProcessGroupAlive, killProcessGroup } from "../utils/process-group.ts";
import { spawnCommand } from "../utils/command-executor.ts";
import { formatSignalInfo } from "../utils/signals.ts";
import type { ManagedProcessRecord } from "./internal-types.ts";
import { formatProcess } from "./internal-types.ts";
import {
  FINISHED_RECORD_GRACE_MS,
  MAX_FINISHED_RECORDS,
} from "./limits.ts";
import type { ProcessLogStore } from "./process-log-store.ts";
import type { ProcessOutput } from "./process-output.ts";
import type { ProcessRegistry } from "./process-registry.ts";

interface ProcessRuntimeControllerDeps {
  registry: ProcessRegistry;
  logs: ProcessLogStore;
  output: ProcessOutput;
  emit: (event: ManagerEvent) => void;
  getConfiguredShellPath: () => string | undefined;
  stopGraceMs?: number;
}

export class ProcessRuntimeController {
  private registry: ProcessRegistry;
  private logs: ProcessLogStore;
  private output: ProcessOutput;
  private emit: (event: ManagerEvent) => void;
  private getConfiguredShellPath: () => string | undefined;

  private watcher: ReturnType<typeof setInterval> | null = null;
  private finishedReapTimer: ReturnType<typeof setTimeout> | null = null;
  private completionSequence = 0;
  private shuttingDown = false;
  private stopGraceMs: number;
  private cleanupErrors = new Set<string>();
  private disposal?: Promise<void>;

  constructor(deps: ProcessRuntimeControllerDeps) {
    this.registry = deps.registry;
    this.logs = deps.logs;
    this.output = deps.output;
    this.emit = deps.emit;
    this.getConfiguredShellPath = deps.getConfiguredShellPath;
    this.stopGraceMs = deps.stopGraceMs ?? 3000;
  }

  start(name: string, command: string, cwd: string): ManagedProcessRecord {
    if (this.shuttingDown) throw new Error("Runtime is disposed");
    // Allocate all files before spawning; a filesystem failure must not orphan a child.
    const id = this.registry.nextId();
    const logPaths = this.logs.createLogs(id);
    let child: ChildProcess;
    try { child = spawnCommand(command, cwd, this.getConfiguredShellPath()); }
    catch (error) { this.logs.removeLogs(logPaths); throw error; }

    // Spawned commands run in detached process groups so TERM/KILL can target
    // the whole tree. `unref()` keeps the manager's Node process from staying
    // alive only because a managed child still exists; extension shutdown and
    // explicit cleanup remain responsible for killing live process groups.
    child.unref();

    const managed: ManagedProcessRecord = {
      id,
      name,
      pid: child.pid ?? -1,
      command,
      cwd,
      startTime: Date.now(),
      endTime: null,
      status: "starting",
      exitCode: null,
      success: null,
      stdoutFile: logPaths.stdoutFile,
      stderrFile: logPaths.stderrFile,
      endReason: null,
      signal: null,
      errorMessage: null,
      combinedFile: logPaths.combinedFile,
      stdin: child.stdin,
      stdinClosed: false,
      lastSignalSent: null,
      completionSequence: null,
      stdoutPendingLine: Buffer.alloc(0),
      stderrPendingLine: Buffer.alloc(0),
      stdoutLineOverflowed: false,
      stderrLineOverflowed: false,
      appendedLines: [],
      droppedLineCount: 0,
      stopRequested: false, child, ownerExited: false, closed: false,
      completed: false, writing: false,
      spawned: undefined!, exited: undefined!, resolveExit: undefined!,
      drained: undefined!, resolveDrained: undefined!,
    };

    managed.exited = new Promise(resolve => { managed.resolveExit = resolve; });
    managed.drained = new Promise(resolve => { managed.resolveDrained = resolve; });
    managed.spawned = new Promise(resolve => {
      child.once("spawn", () => {
        if (managed.status === "starting") this.transition(managed, "running");
        resolve();
      });
      child.once("error", () => resolve());
    });
    this.registry.add(managed);
    this.wireStdioHandlers(managed, child);
    this.emit({ type: "process_started", info: formatProcess(managed) });
    this.ensureWatcherRunning();
    return managed;
  }

  transition(managed: ManagedProcessRecord, next: typeof managed.status): void {
    if (managed.status === next) return;
    managed.status = next;

    this.emit({ type: "processes_changed" });
    this.ensureWatcherRunning();
    this.stopWatcherIfIdle();
  }

  private liveOwner(managed: ManagedProcessRecord): boolean {
    return !managed.ownerExited && LIVE_STATUSES.has(managed.status) &&
      managed.pid > 0 && managed.child.exitCode === null && managed.child.signalCode === null;
  }

  private signal(managed: ManagedProcessRecord, signal: NodeJS.Signals): boolean {
    // Child exit permanently revokes PGID authority, including liveness probes.
    if (!this.liveOwner(managed)) return false;
    try { killProcessGroup(managed.pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
    managed.lastSignalSent = signal;
    managed.stopRequested = true;
    this.transition(managed, "terminating");
    return true;
  }

  async kill(id: string, opts?: { signal?: NodeJS.Signals; timeoutMs?: number }): Promise<KillResult> {
    const managed = this.registry.getRecord(id);
    if (!managed) throw new Error("Unknown process ID");
    if (!LIVE_STATUSES.has(managed.status)) return { ok: true, info: formatProcess(managed) };
    const signal = opts?.signal ?? "SIGTERM";
    if (signal !== "SIGTERM" && signal !== "SIGKILL") throw new Error("Unsupported stop signal");
    if (signal === "SIGTERM" && managed.stopWait) return managed.stopWait;
    this.signal(managed, signal);
    const wait = (async (): Promise<KillResult> => {
      if (!(await this.waitExit(managed, opts?.timeoutMs ?? this.stopGraceMs)) && !managed.ownerExited) {
        // A timeout is not death. A later real exit must still finalize once.
        this.transition(managed, "terminate_timeout");
        return { ok: false, info: formatProcess(managed), reason: "timeout" };
      }
      return { ok: true, info: formatProcess(managed) };
    })();
    managed.stopWait = wait;
    try { return await wait; }
    finally { if (managed.stopWait === wait) managed.stopWait = undefined; }
  }

  async writeToStdin(id: string, data: string, opts?: { end?: boolean }): Promise<void> {
    const managed = this.registry.getRecord(id);
    if (!managed) throw new Error("Unknown process ID");
    const stdin = managed.stdin;
    if (!this.liveOwner(managed) || !stdin || stdin.destroyed || stdin.writableEnded) throw new Error("Process stdin is closed");
    if (typeof data !== "string" || Buffer.byteLength(data) > 50 * 1024) throw new Error("Input exceeds 50 KiB");
    if (managed.writing) throw new Error("A stdin write is already pending");
    managed.writing = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const onClose = () => done(new Error("Process stdin closed before write completed"));
        const done = (error?: Error | null) => {
          stdin.off("error", done); stdin.off("close", onClose);
          error ? reject(new Error(safe(error.message))) : resolve();
        };
        stdin.once("error", done); stdin.once("close", onClose);
        if (opts?.end) stdin.end(data, done);
        else stdin.write(data, done);
      });
    } finally { managed.writing = false; }
  }

  private async waitExit(managed: ManagedProcessRecord, ms: number): Promise<boolean> {
    if (managed.ownerExited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([managed.exited.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms);
      })]);
    } finally { clearTimeout(timer); }
  }

  clearFinished(id?: string): number {
    if (id !== undefined && !this.registry.has(id)) throw new Error("Unknown process ID");
    if (id !== undefined && LIVE_STATUSES.has(this.registry.getRecord(id)!.status)) throw new Error("Cannot clear a live process");
    let cleared = 0;
    for (const managed of this.registry.values()) {
      if (id !== undefined && managed.id !== id) continue;
      if (LIVE_STATUSES.has(managed.status)) {
        continue;
      }

      this.removeFinishedRecord(managed);
      cleared++;
    }

    if (cleared > 0) {
      this.emit({ type: "processes_changed" });
    }

    this.scheduleFinishedReap();
    this.stopWatcherIfIdle();
    return cleared;
  }

  stopWatcher(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  stopFinishedReaper(): void {
    if (!this.finishedReapTimer) return;
    clearTimeout(this.finishedReapTimer);
    this.finishedReapTimer = null;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
    this.stopFinishedReaper();
  }

  cleanup(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.beginShutdown();
    this.stopWatcher();
    this.disposal = Promise.resolve().then(async () => {
      const owned = [...this.registry.values()];
      for (const record of owned) {
        try { this.signal(record, "SIGTERM"); }
        catch (error) { this.warning(record, `Cleanup TERM failed: ${this.message(error)}`); }
      }
      await Promise.all(owned.map(r => this.waitExit(r, this.stopGraceMs)));
      for (const record of owned) {
        try { this.signal(record, "SIGKILL"); }
        catch (error) { this.warning(record, `Cleanup KILL failed: ${this.message(error)}`); }
      }
      await Promise.all(owned.map(r => this.waitExit(r, Math.min(this.stopGraceMs, 1000))));
      for (const record of owned) {
        if (record.ownerExited) await record.drained;
        else this.warning(record, "Cleanup deadline exceeded; tracked child exit was not observed");
        this.closePipes(record);
        this.drained(record);
      }
      this.output.clearAll();
      try { this.logs.cleanup(); }
      catch (error) { this.cleanupErrors.add(this.message(error)); }
      if (this.cleanupErrors.size) throw new Error(`Process cleanup: ${[...this.cleanupErrors].join("; ")}`);
    });
    return this.disposal;
  }

  private message(error: unknown): string {
    return safe(error instanceof Error ? error.message : String(error)).slice(0, 2000);
  }

  private warning(record: ManagedProcessRecord, message: string): void {
    message = safe(message).slice(0, 2000);
    if (record.errorMessage?.includes(message)) return;
    record.errorMessage = [record.errorMessage, message].filter(Boolean).join("; ").slice(-4000);
    this.cleanupErrors.add(`${record.id}: ${message}`);
    this.emit({ type: "processes_changed" });
  }

  private closePipes(record: ManagedProcessRecord): void {
    record.child.stdin?.destroy(); record.child.stdout?.destroy(); record.child.stderr?.destroy();
  }

  private drained(record: ManagedProcessRecord): void {
    if (record.closed) return;
    record.closed = true;
    clearTimeout(record.drainTimer);
    try { this.output.flush(record); }
    catch (error) { this.warning(record, `Log flush failed: ${this.message(error)}`); }
    record.resolveDrained();
    this.complete(record);
  }

  private complete(record: ManagedProcessRecord): void {
    if (!record.ownerExited || !record.closed || record.completed) return;
    record.completed = true;
    record.completionSequence ??= ++this.completionSequence;
    // Final tail and warnings are captured before completion is emitted.
    this.emit({ type: "process_ended", info: formatProcess(record) });
    if (!this.shuttingDown) {
      try { this.reapOldestFinished(); this.scheduleFinishedReap(); }
      catch (error) { this.warning(record, `Log reaping failed: ${this.message(error)}`); }
    }
  }

  private finish(record: ManagedProcessRecord, code: number | null, signal: NodeJS.Signals | null, error?: Error, lost = false): void {
    if (record.ownerExited) return;
    record.ownerExited = true;
    record.exitCode = code;
    record.endTime = Date.now();
    record.success = code === 0 && !signal && !error;
    record.signal = signal ? formatSignalInfo(signal) : null;
    record.endReason = lost ? "lost" : error ? "spawn_error" : signal ? "signal" : "exit";
    if (error) record.errorMessage = this.message(error);
    this.releaseRuntimeHandles(record);
    record.resolveExit();
    if (!record.closed) record.drainTimer = setTimeout(() => {
      if (!record.child.stdout?.readableEnded || !record.child.stderr?.readableEnded) {
        this.warning(record, "Tracked shell exited; descendants may still be running. Inherited output pipes were closed after the drain deadline. Background/daemonized descendants are unsupported.");
      }
      this.closePipes(record);
      this.drained(record);
    }, 200);
    this.transition(record, signal ? "killed" : "exited");
    this.complete(record);
  }

  private wireStdioHandlers(managed: ManagedProcessRecord, child: ChildProcess): void {
    child.stdin?.on("error", () => { /* Awaited write callbacks report failures. */ });
    for (const source of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      const sanitizer = new SafeText();
      const receive = (data: Buffer, eof = false) => {
        if (managed.closed) return;
        try {
          if (source === "stdout") this.logs.appendStdout(managed.stdoutFile, data);
          else this.logs.appendStderr(managed.stderrFile, data);
        } catch (error) { this.warning(managed, `Log write failed: ${this.message(error)}`); }
        const text = sanitizer.push(eof ? decoder.end() : decoder.write(data));
        try { this.logs.appendCombinedChunk(managed.combinedFile, text); }
        catch (error) { this.warning(managed, `Log write failed: ${this.message(error)}`); }
        if (source === "stdout") this.output.onStdoutChunk(managed, Buffer.from(text));
        else this.output.onStderrChunk(managed, Buffer.from(text));
      };
      child[source]?.on("data", (data: Buffer) => receive(data));
      child[source]?.on("end", () => {
        if (managed.closed) return;
        receive(Buffer.alloc(0), true);
        this.output.flushStream(managed, source);
      });
      child[source]?.on("error", error => this.warning(managed, `Output failed: ${this.message(error)}`));
    }
    child.once("exit", (code, signal) => this.finish(managed, code, signal));
    child.once("close", () => this.drained(managed));
    child.once("error", error => this.finish(managed, null, null, error));
  }

  private ensureWatcherRunning(): void {
    if (this.watcher || this.shuttingDown) return;
    if (!this.registry.hasAliveishProcesses()) return;

    this.watcher = setInterval(() => {
      this.livenessTick();
    }, 5000);
    this.watcher.unref?.();
  }

  private stopWatcherIfIdle(): void {
    if (!this.watcher) return;
    if (this.registry.hasAliveishProcesses()) return;

    this.stopWatcher();
  }

  private livenessTick(): void {
    for (const managed of this.registry.values()) {
      if (!this.liveOwner(managed)) continue;
      if (isProcessGroupAlive(managed.pid)) continue;
      // Loss detected while the tracked owner is still eligible permanently
      // revokes authority too; never probe or signal that PGID again.
      this.finish(managed, null, managed.lastSignalSent, undefined, true);
    }
  }

  private releaseRuntimeHandles(managed: ManagedProcessRecord): void {
    managed.stdin = null;
    managed.stdinClosed = true;
  }

  private reapOldestFinished(): void {
    const finished = this.finishedRecordsByAge();
    if (finished.length <= MAX_FINISHED_RECORDS) return;

    const cutoff = Date.now() - FINISHED_RECORD_GRACE_MS;
    let remaining = finished.length;
    let reaped = 0;
    for (const record of finished) {
      if (remaining <= MAX_FINISHED_RECORDS) break;
      if ((record.endTime ?? Number.POSITIVE_INFINITY) > cutoff) break;
      this.removeFinishedRecord(record);
      remaining--;
      reaped++;
    }

    if (reaped > 0) this.emit({ type: "processes_changed" });
  }

  private scheduleFinishedReap(): void {
    this.stopFinishedReaper();
    if (this.shuttingDown) return;
    const finished = this.finishedRecordsByAge();
    if (finished.length <= MAX_FINISHED_RECORDS) return;

    const oldest = finished[0];
    const delay = Math.max(
      0,
      (oldest.endTime ?? Date.now()) + FINISHED_RECORD_GRACE_MS - Date.now(),
    );
    this.finishedReapTimer = setTimeout(() => {
      this.finishedReapTimer = null;
      try { this.reapOldestFinished(); this.scheduleFinishedReap(); }
      catch (error) { this.warning(oldest, `Log reaping failed: ${this.message(error)}`); }
    }, delay);
    this.finishedReapTimer.unref?.();
  }

  private finishedRecordsByAge(): ManagedProcessRecord[] {
    return [...this.registry.values()]
      .filter(
        (record) =>
          record.completed && !LIVE_STATUSES.has(record.status) && record.endTime !== null,
      )
      .sort(
        (a, b) =>
          (a.endTime ?? 0) - (b.endTime ?? 0) ||
          (a.completionSequence ?? 0) - (b.completionSequence ?? 0),
      );
  }

  private removeFinishedRecord(record: ManagedProcessRecord): void {
    if (!record.closed) {
      if (!record.child.stdout?.readableEnded || !record.child.stderr?.readableEnded) {
        this.warning(record, "Tracked shell exited; output cleared before pipes drained. Descendant cleanup is not guaranteed.");
      }
      this.closePipes(record);
      this.drained(record);
    }
    this.logs.removeLogs({
      stdoutFile: record.stdoutFile,
      stderrFile: record.stderrFile,
      combinedFile: record.combinedFile,
    });
    this.output.clear(record.id);
    this.registry.delete(record.id);
  }
}
