import assert from 'node:assert/strict';
import test from 'node:test';
import { executeProcess, listRuns, processParameters, registerProcessTool } from './tool.ts';
import { createRuntime } from './runtime.ts';
import type { Run, Runtime } from './types.ts';
const run = (id: string, extra = {}): Run => ({ id, name: id, command: 'true', cwd: '/', phase: 'running', startedAt: Number(id) || 0, acknowledged: false, stopRequested: false, notify: {}, ...extra });
const params = (action: any, extra = {}): any => ({ action, ...extra });
function fixture() {
  const calls: any[] = [], runs = [run('1')];
  const runtime = { snapshot: () => ({ runs }),
    start: async (input: any) => { calls.push(['start', input]); return runs[0]; },
    output: async (...args: any[]) => { calls.push(['output', ...args]); return { text: 'out', rotated: false, truncated: false }; },
    write: async (...args: any[]) => { calls.push(['write', ...args]); },
    update: (...args: any[]) => { calls.push(['update', ...args]); return runs[0]; },
    stop: async (...args: any[]) => { calls.push(['stop', ...args]); return runs[0]; },
    clear: (...args: any[]) => { calls.push(['clear', ...args]); return 1; },
  } as unknown as Runtime;
  return { runtime, calls, runs };
}

test('tool routes all compatibility actions, exact bytes/EOF, default/explicit cwd and explicit force', async () => {
  const { runtime, calls } = fixture();
  await executeProcess(runtime, params('start', { name: 'n', command: 'echo x' }), '/default');
  assert.deepEqual(calls.pop(), ['start', { name: 'n', command: 'echo x', cwd: '/default', notify: undefined }]);
  await executeProcess(runtime, params('start', { name: 'n', command: 'x', cwd: '/other', notify: { onFailure: 'ignore' } }), '/default');
  assert.equal(calls.pop()[1].cwd, '/other');
  assert.equal((await executeProcess(runtime, params('list'), '/') as any).runs[0].status, 'running');
  await executeProcess(runtime, params('output', { id: '1', stream: 'stderr', tailLines: 3, pattern: 'needle', mode: 'literal' }), '/');
  assert.deepEqual(calls.pop(), ['output', '1', { stream: 'stderr', tailLines: 3, pattern: 'needle', mode: 'literal' }]);
  await executeProcess(runtime, params('write', { id: '1', input: 'exact' }), '/');
  assert.deepEqual(calls.pop(), ['write', '1', 'exact', false]);
  await executeProcess(runtime, params('write', { id: '1', end: true }), '/');
  assert.deepEqual(calls.pop(), ['write', '1', '', true]);
  const watches = { mode: 'remove', items: [{ index: 0 }] };
  await executeProcess(runtime, params('update', { id: '1', name: 'new', watches }), '/');
  assert.deepEqual(calls.pop(), ['update', '1', { name: 'new', watches }]);
  await executeProcess(runtime, params('stop', { id: '1' }), '/');
  assert.deepEqual(calls.pop(), ['stop', '1', false]);
  await executeProcess(runtime, params('stop', { id: '1', force: true }), '/');
  assert.deepEqual(calls.pop(), ['stop', '1', true]);
  await executeProcess(runtime, params('clear'), '/'); assert.deepEqual(calls.pop(), ['clear', undefined]);
  await executeProcess(runtime, params('clear', { id: '1' }), '/'); assert.deepEqual(calls.pop(), ['clear', '1']);
});

test('tool rejects missing requirements and regex before routing, schema clearly warns legacy regex unsupported', async () => {
  const { runtime, calls } = fixture();
  for (const action of ['start', 'output', 'write', 'update', 'stop']) await assert.rejects(executeProcess(runtime, params(action), '/'), /required/);
  for (const p of [params('output', { id: '1', mode: 'regex' }), params('start', { notify: { logMatches: [{ pattern: 'x', mode: 'regex' }] } }), params('update', { id: '1', watches: { mode: 'append', items: [{ pattern: 'x', mode: 'regex' }] } })]) await assert.rejects(executeProcess(runtime, p, '/'), /Regex is unsupported/);
  assert.equal(calls.length, 0);
  assert.match(JSON.stringify(processParameters), /regex is unsupported/);
});

test('list legacy filters preserve outcomes and timeout failures, five sorts and bounded limit', () => {
  const runs = [run('1', { name: 'b', phase: 'starting' }), run('2', { name: 'a', phase: 'stopping' }), run('3', { phase: 'stop-timeout' }), run('4', { phase: 'terminal', outcome: 'successful' }), run('5', { phase: 'terminal', outcome: 'failed', acknowledged: true }), run('6', { phase: 'terminal', outcome: 'failed', signal: 'SIGTERM' }), run('7', { phase: 'terminal', outcome: 'user-stopped', signal: 'SIGTERM' })];
  for (const [filter, expected] of [['running', ['1']], ['terminating', ['2']], ['terminate_timeout', ['3']], ['finished', ['4']], ['failed', ['6', '5', '3']], ['killed', ['7', '6']]] as const) assert.deepEqual(listRuns(runs, params('list', { statuses: [filter] })).map(r => r.id), expected);
  assert.equal(listRuns(runs, params('list', { sortBy: 'startTime_asc' }))[0].id, '1');
  assert.equal(listRuns(runs, params('list', { sortBy: 'startTime_desc' }))[0].id, '7');
  assert.equal(listRuns(runs.slice(0, 2), params('list', { sortBy: 'name_asc' }))[0].id, '2');
  assert.equal(listRuns(runs.slice(0, 2), params('list', { sortBy: 'name_desc' }))[0].id, '1');
  assert.equal(listRuns(runs, params('list', { sortBy: 'status_asc' }))[0].id, '5');
  assert.equal(listRuns(runs, params('list', { limit: 2 })).length, 2);
  for (const limit of [0, -1, 1.5, 10001, Infinity]) assert.throws(() => listRuns(runs, params('list', { limit })), /limit/);
});

test('registered tool obtains fresh runtime, sanitizes result and rejects stale completions and pre-abort', async () => {
  let definition: any, current = true, calls = 0;
  const { runtime, runs } = fixture(); runs[0].name = '\x1b]52;c;secret\x07safe';
  registerProcessTool({ registerTool: (d: any) => definition = d } as any, () => { calls++; return { runtime, current: () => current }; });
  const execute = (p: any, signal?: AbortSignal) => definition.execute('call', p, signal, undefined, { cwd: '/' });
  const result = await execute(params('list'));
  assert.equal(result.details.runs[0].name, 'safe');
  assert.doesNotMatch(result.content[0].text, /secret/);
  current = false; await assert.rejects(execute(params('stop', { id: '1' })), /session changed/);
  await assert.rejects(execute(params('list'), AbortSignal.abort()), /aborted/);
  assert.equal(calls, 2);
});

test('combined adapter/runtime smoke starts only an owned harmless foreground command', async () => {
  const runtime = createRuntime({ stopGraceMs: 50 });
  try {
    const started = await executeProcess(runtime, params('start', { name: 'smoke', command: "printf 'hello\\n'" }), process.cwd()) as Run;
    for (let n = 0; n < 100 && runtime.snapshot().runs[0].phase !== 'terminal'; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runtime.snapshot().runs[0].outcome, 'successful');
    const output = await executeProcess(runtime, params('output', { id: started.id }), '/') as any;
    assert.match(output.text, /hello/);
    assert.equal((await executeProcess(runtime, params('list', { statuses: ['finished'] }), '/') as any).runs.length, 1);
  } finally { await runtime.dispose(); }
});

test('tool call/result renderers sanitize metadata and old untrusted results independently', () => {
  let tool: any;
  const { runtime } = fixture();
  registerProcessTool({ registerTool: (d: any) => tool = d } as any, () => ({ runtime, current: () => true }));
  const theme = { fg: (_color: string, text: string) => text };
  const attack = '\x1b]52;c;secret\x07\x1b[31mvisible\u202e';
  const call = tool.renderCall({ action: 'start', name: attack, command: attack, cwd: attack }, theme).render(80).join('\n');
  assert.match(call, /process start visible/); assert.match(call, /cwd: visible/);
  assert.doesNotMatch(call, /secret|\u202e|\x1b/);
  const result = tool.renderResult({ content: [{ type: 'text', text: attack }] }, { expanded: true }, theme, { isError: false }).render(80).join('\n');
  assert.match(result, /visible/); assert.doesNotMatch(result, /secret|\u202e|\x1b/);
  const collapsed = tool.renderResult({ content: [{ type: 'text', text: 'x\n'.repeat(20) }] }, { expanded: false }, theme, { isError: false }).render(80).join('\n');
  assert.match(collapsed, /expand for more/);
});

test('registered output tool preserves 50 KiB tab-heavy UTF-8 tails and accurate truncation markers', async () => {
  const runtime = createRuntime({ stopGraceMs: 100 });
  const completed = new Set<string>();
  const off = runtime.subscribe(event => { if (event.type === 'notification' && event.kind === 'completion') completed.add(event.id); });
  let tool: any;
  registerProcessTool({ registerTool: (definition: any) => tool = definition } as any, () => ({ runtime, current: () => true }));
  const execute = (params: any) => tool.execute('bounded-output', params, undefined, undefined, { cwd: process.cwd() });
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  try {
    for (const [expression, expected] of [
      ["'\\t'.repeat(51200)", '\t'.repeat(51200)],
      ["'\\t界😀'.repeat(8000)", '\t界😀'.repeat(8000)],
    ]) {
      const command = `exec ${quote(process.execPath)} -e ${quote(`process.stdout.write(${expression})`)}`;
      const started = (await execute({ action: 'start', name: 'bounded tabs', command })).details;
      const deadline = Date.now() + 3000;
      while (!completed.has(started.id)) {
        if (Date.now() >= deadline) throw Error('Owned output fixture did not complete');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(runtime.snapshot().runs.find(r => r.id === started.id)!.outcome, 'successful');
      const core = await runtime.output(started.id);
      const result = await execute({ action: 'output', id: started.id });
      assert.deepEqual(result.details, core, 'adapter must not expand or alter the bounded tail');
      assert.deepEqual(JSON.parse(result.content[0].text), core, 'model structured output retains the same tail');
      assert.ok(Buffer.byteLength(result.details.text) <= 50 * 1024);
      assert.ok(result.details.text.includes('\t'));
      assert.doesNotMatch(result.details.text, /�/);
      assert.equal(result.details.rotated, false);
      if (Buffer.byteLength(expected) <= 50 * 1024) {
        assert.equal(result.details.text, expected);
        assert.equal(result.details.truncated, false);
      } else {
        assert.equal(result.details.truncated, true);
        assert.ok(result.details.text.startsWith('[output truncated]\n'));
        assert.ok(expected.endsWith(result.details.text.slice('[output truncated]\n'.length)));
      }
    }
  } finally { off(); await runtime.dispose(); }
});
