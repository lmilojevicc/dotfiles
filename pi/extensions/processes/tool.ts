import { Type, type Static } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Run, Runtime } from './types.ts';
import { safeData, safeText } from './status.ts';
import { renderCall, renderResult, type Presentation, type RenderDetails } from './render/actions.ts';

const attention = () => StringEnum(['turn', 'context', 'ignore'] as const);
const stream = () => StringEnum(['stdout', 'stderr', 'both'] as const);
const mode = () => StringEnum(['literal', 'regex'] as const, { description: 'Literal only in v1. Legacy regex requests are rejected explicitly; regex is unsupported.' });
const pattern = () => Type.String({ minLength: 1, maxLength: 500 });
const watchFields = {
  mode: Type.Optional(mode()), stream: Type.Optional(stream()), repeat: Type.Optional(Type.Boolean()), on: Type.Optional(attention()),
};
export const processParameters = Type.Object({
  action: StringEnum(['start', 'list', 'output', 'write', 'update', 'stop', 'clear'] as const),
  id: Type.Optional(Type.String({ description: 'Opaque session-owned ID, never a PID or name.' })),
  name: Type.Optional(Type.String({ minLength: 1 })), command: Type.Optional(Type.String({ minLength: 1 })),
  cwd: Type.Optional(Type.String({ description: 'Start directory; defaults to current agent directory.' })),
  notify: Type.Optional(Type.Object({
    onSuccess: Type.Optional(attention()), onFailure: Type.Optional(attention()), onKilled: Type.Optional(attention()),
    logMatches: Type.Optional(Type.Array(Type.Object({ pattern: pattern(), ...watchFields }), { maxItems: 20 })),
  }, { description: 'Success/failure default turn; external signals default context. Failure/watch ignore becomes context. Intentional stop is always context.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  sortBy: Type.Optional(StringEnum(['startTime_desc', 'startTime_asc', 'name_asc', 'name_desc', 'status_asc'] as const)),
  statuses: Type.Optional(Type.Array(StringEnum(['all', 'running', 'finished', 'failed', 'terminating', 'terminate_timeout', 'killed'] as const))),
  stream: Type.Optional(stream()), tailLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  pattern: Type.Optional(pattern()), mode: Type.Optional(mode()),
  input: Type.Optional(Type.String({ description: 'Exact stdin bytes; no automatic newline. At most 50 KiB.' })),
  end: Type.Optional(Type.Boolean({ description: 'Explicit EOF after input; defaults false.' })),
  force: Type.Optional(Type.Boolean({ description: 'Stop only: explicitly send SIGKILL to a still-live owned group; otherwise SIGTERM.' })),
  watches: Type.Optional(Type.Object({
    mode: StringEnum(['append', 'replace', 'remove', 'clear'] as const),
    items: Type.Optional(Type.Array(Type.Object({ index: Type.Optional(Type.Integer({ minimum: 0 })), pattern: Type.Optional(pattern()), ...watchFields }), { maxItems: 20 })),
  })),
});
export type ProcessParams = Static<typeof processParameters>;

export function legacyStatus(run: Run): string {
  if (run.phase === 'starting' || run.phase === 'running') return 'running';
  if (run.phase === 'stopping') return 'terminating';
  if (run.phase === 'stop-timeout') return 'terminate_timeout';
  if (run.signal) return 'killed';
  return run.outcome === 'successful' ? 'finished' : 'failed';
}

export function listRuns(runs: readonly Run[], params: ProcessParams): Run[] {
  const filters = params.statuses ?? ['all'];
  const result = runs.filter(r => filters.includes('all') || filters.some(filter =>
    filter === 'failed' ? r.outcome === 'failed' || r.phase === 'stop-timeout' :
    filter === 'finished' ? r.outcome === 'successful' :
    filter === 'killed' ? r.phase === 'terminal' && !!r.signal : legacyStatus(r) === filter));
  const sort = params.sortBy ?? 'startTime_desc';
  if (!['startTime_desc', 'startTime_asc', 'name_asc', 'name_desc', 'status_asc'].includes(sort)) throw new Error('Invalid sortBy');
  result.sort((a, b) => {
    const order = sort === 'name_asc' ? a.name.localeCompare(b.name) : sort === 'name_desc' ? b.name.localeCompare(a.name) :
      sort === 'status_asc' ? legacyStatus(a).localeCompare(legacyStatus(b)) : sort === 'startTime_asc' ? a.startedAt - b.startedAt : b.startedAt - a.startedAt;
    return order || a.id.localeCompare(b.id);
  });
  const limit = params.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('limit must be an integer from 1 to 10000');
  return result.slice(0, limit);
}

const required = (value: string | undefined, label: string): string => {
  if (typeof value !== 'string' || !value.length) throw new Error(`${label} is required`);
  return value;
};
const withStatus = (run: Run) => ({ ...run, status: legacyStatus(run) });
export async function executeProcess(runtime: Runtime, params: ProcessParams, cwd: string): Promise<unknown> {
  if (params.mode === 'regex' || params.notify?.logMatches?.some(w => w.mode === 'regex') || params.watches?.items?.some(w => w.mode === 'regex')) throw new Error('Regex is unsupported in v1; use literal matching');
  switch (params.action) {
    case 'start': return withStatus(await runtime.start({ name: required(params.name, 'name'), command: required(params.command, 'command'), cwd: params.cwd ?? cwd, notify: params.notify }));
    case 'list': return { runs: listRuns(runtime.snapshot().runs, params).map(withStatus) };
    case 'output': return runtime.output(required(params.id, 'id'), { stream: params.stream, tailLines: params.tailLines, pattern: params.pattern, mode: params.mode });
    case 'write': {
      if (params.input === undefined && params.end !== true) throw new Error('input or end=true is required');
      await runtime.write(required(params.id, 'id'), params.input ?? '', params.end ?? false);
      return { id: params.id, writtenBytes: Buffer.byteLength(params.input ?? ''), stdinClosed: params.end === true };
    }
    case 'update': return withStatus(runtime.update(required(params.id, 'id'), { name: params.name, watches: params.watches }));
    case 'stop': return withStatus(await runtime.stop(required(params.id, 'id'), params.force === true));
    case 'clear': return { cleared: runtime.clear(params.id) };
    default: throw new Error('Unknown process action');
  }
}

export function registerProcessTool(pi: ExtensionAPI, getRuntime: (ctx: ExtensionContext) => { runtime: Runtime; current: () => boolean }): void {
  pi.registerTool({
    name: 'process', label: 'Process', parameters: processParameters,
    promptSnippet: 'Manage session-owned long-running processes with process start/list/output/update/write/stop/clear. Start with specific names; notifications bring you back on exit or complete-line literal watches; do not sleep or poll.',
    promptGuidelines: [
      'Use process start instead of shell background patterns &, nohup, disown, or setsid; name each process specifically and check process list before starting noisy duplicates.',
      'After start, continue work or end your turn; no sleep, polling process output, or held turn. Use literal notify.logMatches for readiness and failures, remembering matches wait for newline or final EOF.',
      'turn attention wakes or steers now; context waits until the next prompt. Failure ignore becomes context. Intentional stop is context. Update noisy watches without restarting.',
      'Output returns a bounded currently-retained tail; do not refetch completion output redundantly when its notification suffices. For deeper inspection use only currently-retained stdoutFile/stderrFile paths returned by process.',
      'Read the pi-processes skill for ownership, bounded logs, /processes controls, and limits. No regex, daemon, PTY, automatic restart, or cross-session control.',
    ],
    description: 'Manage session-owned foreground shell commands: start/list/output/write/update/stop/clear. Use returned opaque IDs. No PTY, daemonization, cross-session control, or automatic restart. Start/rerun via this tool, not /processes. Literal log matching only; regex is rejected. Output is a bounded retained tail, not complete history. Terminal means tracked shell exited, not all descendants; inspect error warnings. Stop is TERM; force=true explicitly escalates KILL only while the tracked owner is live. Clear removes terminal records/logs only. EOF requires end=true.',
    async execute(_id, params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('Process tool aborted before execution');
      const { runtime, current } = getRuntime(ctx);
      let details: unknown;
      let presentation: Presentation = {};
      try {
        // Capture event-time presentation only; it never enters model content.
        const id = params.id;
        if (id && ['output', 'update', 'write'].includes(params.action)) {
          const before = runtime.snapshot().runs.find(r => r.id === id);
          if (before) presentation = { run: before, name: before.name,
            ...(params.action === 'update' ? { before: before.notify.logMatches ?? [] } : {}) };
        }
        if (params.action === 'output') presentation.query = { stream: params.stream, pattern: params.pattern, tailLines: params.tailLines };
        details = safeData(await executeProcess(runtime, params, ctx.cwd));
      }
      catch (error) {
        if (!current()) throw new Error('Process session changed; discard this result');
        throw new Error(safeText(error instanceof Error ? error.message : error));
      }
      if (!current()) throw new Error('Process session changed; discard this result');
      const envelope: RenderDetails = { version: 1, action: params.action, data: details, presentation: safeData(presentation) };
      return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }], details: envelope };
    },
    renderCall(args, theme, context) { return renderCall(args, theme, context?.expanded); },
    renderResult(result, options, theme, context) { return renderResult(result, options, theme, context); },
  });
}
