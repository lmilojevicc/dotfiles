// Source: @aliou/pi-processes 0.12.0; local compatibility patches: ../UPSTREAM.md.
import { EventEmitter } from "node:events";

import type {
  KillResult,
  ManagerEvent,
  ProcessInfo,
} from "../types.ts";
import { formatProcess } from "./internal-types.ts";
import { ProcessLogStore } from "./process-log-store.ts";
import { ProcessOutput } from "./process-output.ts";
import { ProcessRegistry } from "./process-registry.ts";
import { ProcessRuntimeController } from "./process-runtime-controller.ts";

export interface ProcessManagerOptions {
  logRoot?: string;
  maxLogBytes?: number;
  stopGraceMs?: number;
  getConfiguredShellPath?: () => string | undefined;
}

export class ProcessManager {
  private events = new EventEmitter();
  private emit: (event: ManagerEvent) => void;

  private registry: ProcessRegistry;
  private logStore: ProcessLogStore;
  private output: ProcessOutput;
  private runtime: ProcessRuntimeController;

  constructor(options?: ProcessManagerOptions) {
    const emit = (event: ManagerEvent): void => {
      for (const listener of this.events.listeners("event")) {
        try { Promise.resolve(listener(structuredClone(event))).catch(() => {}); }
        catch { /* Observers never interrupt process lifecycle. */ }
      }
    };

    this.emit = emit;
    this.registry = new ProcessRegistry();
    this.logStore = new ProcessLogStore(options?.logRoot, { maxFileBytes: options?.maxLogBytes });

    this.output = new ProcessOutput({
      emit,
    });

    this.runtime = new ProcessRuntimeController({
      registry: this.registry,
      logs: this.logStore,
      output: this.output,
      emit,
      stopGraceMs: options?.stopGraceMs,
      getConfiguredShellPath:
        options?.getConfiguredShellPath ?? (() => undefined),
    });
  }

  onEvent(listener: (event: ManagerEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  start(name: string, command: string, cwd: string): ProcessInfo {
    const managed = this.runtime.start(name, command, cwd);
    return formatProcess(managed);
  }

  async waitSpawn(id: string): Promise<void> {
    await this.registry.getRecord(id)?.spawned;
  }

  flushOutputEvents(id: string): void {
    const record = this.registry.getRecord(id);
    if (record) this.output.flushEvents(record);
  }

  getRetainedOutput(id: string, stream: "stdout" | "stderr" | "both") {
    const record = this.registry.getRecord(id);
    if (!record) throw new Error("Unknown process ID");
    const path = stream === "stdout" ? record.stdoutFile : stream === "stderr" ? record.stderrFile : record.combinedFile;
    const lines = this.logStore.readTailLines(path, 5001);
    // A capped byte read is conservatively marked truncated even when many
    // invisible control bytes would otherwise produce a short visible tail.
    const bytes = this.logStore.fileSize(path);
    return { lines, rotated: this.logStore.isRotated(path), byteLimited: bytes > 2 * 1024 * 1024 };
  }

  list(): ProcessInfo[] {
    return this.registry.list();
  }

  get(id: string): ProcessInfo | null {
    return this.registry.getPublicInfo(id);
  }

  rename(id: string, name: string): ProcessInfo | null {
    const info = this.registry.rename(id, name);
    if (info) {
      this.emit({
        type: "processes_changed",
      } satisfies ManagerEvent);
    }
    return info;
  }

  getOutput(
    id: string,
    tailLines = 100,
  ): { stdout: string[]; stderr: string[]; status: string } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;

    return {
      stdout: this.logStore.readTailLines(managed.stdoutFile, tailLines),
      stderr: this.logStore.readTailLines(managed.stderrFile, tailLines),
      status: managed.status,
    };
  }

  /**
   * Return output capped at 16 MiB per stream. Use getLogFiles() and stream
   * the returned paths for currently retained raw bytes, never a promise of lifetime-complete output.
   */
  getFullOutput(id: string): { stdout: string; stderr: string } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;
    return {
      stdout: this.logStore.readFullFile(managed.stdoutFile),
      stderr: this.logStore.readFullFile(managed.stderrFile),
    };
  }

  getLogFiles(
    id: string,
  ): { stdoutFile: string; stderrFile: string; combinedFile: string } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;
    return {
      stdoutFile: managed.stdoutFile,
      stderrFile: managed.stderrFile,
      combinedFile: managed.combinedFile,
    };
  }

  getFileSize(id: string): { stdout: number; stderr: number } | null {
    const managed = this.registry.getRecord(id);
    if (!managed) return null;
    return this.logStore.getFileSize({
      stdoutFile: managed.stdoutFile,
      stderrFile: managed.stderrFile,
      combinedFile: managed.combinedFile,
    });
  }

  async kill(
    id: string,
    opts?: { signal?: NodeJS.Signals; timeoutMs?: number },
  ): Promise<KillResult> {
    return this.runtime.kill(id, opts);
  }

  writeToStdin(id: string, data: string, opts?: { end?: boolean }): Promise<void> {
    return this.runtime.writeToStdin(id, data, opts);
  }

  clearFinished(id?: string): number {
    return this.runtime.clearFinished(id);
  }

  cleanup(): Promise<void> {
    return this.runtime.cleanup();
  }

}

export type {
  KillResult,
  ManagerEvent,
  ProcessInfo,
  ProcessStatus,
} from "../types.ts";
