export type RunId = string;
export type Phase = 'starting'|'running'|'stopping'|'stop-timeout'|'terminal';
export type Outcome = 'successful'|'failed'|'user-stopped';
export type Attention = 'turn'|'context'|'ignore';
export type Stream = 'stdout'|'stderr'|'both';
export type MatchMode = 'literal'|'regex';
export interface Watch {
  pattern: string; mode?: MatchMode; stream?: Stream;
  repeat?: boolean; on?: Attention;
}
export interface Notify {
  onSuccess?: Attention; onFailure?: Attention; onKilled?: Attention;
  logMatches?: Watch[];
}
export interface StartInput {
  name: string; command: string; cwd: string; notify?: Notify;
}
export interface Run {
  id: RunId; name: string; command: string; cwd: string; pid?: number;
  phase: Phase; outcome?: Outcome; startedAt: number; endedAt?: number;
  exitCode?: number; signal?: string; error?: string;
  stopRequested: boolean; acknowledged: boolean; notify: Notify;
  stdoutFile?: string; stderrFile?: string;
}
export interface Snapshot {
  version: 1; revision: number; runs: readonly Run[];
  active: number; unacknowledgedFailed: number;
}
export interface OutputQuery {
  stream?: Stream; tailLines?: number; pattern?: string; mode?: MatchMode;
}
export interface OutputResult {
  text: string; truncated: boolean; rotated: boolean;
  stdoutFile?: string; stderrFile?: string;
}
export interface WatchUpdate {
  mode: 'append'|'replace'|'remove'|'clear';
  items?: (Partial<Watch> & { index?: number })[];
}
export interface UpdateInput { name?: string; watches?: WatchUpdate }
export type NotificationDetails =
  | { version: 1; timestamp: number; kind: 'completion'; run: Run }
  | { version: 1; timestamp: number; kind: 'watch'; run: Run;
      watch: { pattern: string; mode: 'literal'; stream: 'stdout'|'stderr'; line: string; matcherIndex: number } }
  | { version: 1; timestamp: number; kind: 'suppression'; suppressedCount: number };
export type RuntimeEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'output'; id: RunId }
  | { type: 'notification'; key: string; id: RunId;
      kind: 'completion'|'watch'; attention: Attention; text: string; details?: NotificationDetails };
export interface RuntimeOptions {
  logRoot?: string; maxLogBytes?: number; maxRuns?: number;
  stopGraceMs?: number;
}
export interface Runtime {
  snapshot(): Snapshot;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  start(input: StartInput): Promise<Run>;
  output(id: RunId, query?: OutputQuery): Promise<OutputResult>;
  write(id: RunId, input: string, end?: boolean): Promise<void>;
  update(id: RunId, input: UpdateInput): Run;
  stop(id: RunId, force?: boolean): Promise<Run>;
  acknowledge(id: RunId): void;
  clear(id?: RunId): number;
  dispose(): Promise<void>;
}
