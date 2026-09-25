import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderCall, renderResult } from './render/actions.ts';
import { notificationMessage, renderNotification } from './render/notification.ts';
import { buildMatcherLine } from './render/watch.ts';
import { registerProcessTool } from './tool.ts';
import type { Run } from './types.ts';

const theme: any = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
const run = (extra: Partial<Run> = {}): Run => ({ id: 'opaque-uuid', name: 'dev-server', command: 'npm run dev', cwd: '/project', phase: 'running', startedAt: Date.now() - 12000, stopRequested: false, acknowledged: false, notify: {}, ...extra });
const draw = (component: {render(width: number): string[]}, width = 80) => component.render(width).join('\n').trimEnd();
const show = (action: string, data: unknown, expanded = false, presentation = {}, width = 80) => draw(renderResult({details: {version: 1, action, data, presentation}}, {expanded}, theme), width);

test('all action layouts have meaningful collapsed and expanded fields, without JSON dumps or false flags', () => {
  const r = run();
  for (const action of ['start', 'stop', 'update']) {
    const collapsed = show(action, r); assert.match(collapsed, /dev-server · running/);
    assert.doesNotMatch(collapsed, /opaque-uuid|startedAt|stopRequested|npm run dev|false/);
    const expanded = show(action, r, true); assert.match(expanded, /id: opaque-uuid/); assert.match(expanded, /command: npm run dev/); assert.match(expanded, /cwd: \/project/);
  }
  const list = {runs: [r, run({id:'other', name:'builder', phase:'terminal', outcome:'failed', exitCode: 2, endedAt: Date.now(), error:'build failed'})]};
  assert.match(show('list', list), /2 processes · 1 active · 1 failed/);
  assert.doesNotMatch(show('list', list), /opaque-uuid|startedAt|npm run dev/);
  assert.match(show('list', list, true), /builder.*failed.*exit 2/);
  assert.match(show('list', list, true), /warning: build failed/);
  assert.match(show('write', {id:r.id,writtenBytes:7,stdinClosed:true}), /wrote 7 bytes · stdin closed \(EOF\)/);
  assert.doesNotMatch(show('write', {id:r.id,writtenBytes:7,stdinClosed:true}), /opaque-uuid/);
  assert.match(show('clear', {cleared:2}), /2 processes cleared/);
  const updated = {...r, name:'new', notify:{logMatches:[{pattern:'ready'}]}};
  assert.match(show('update', updated, false, {run:r,before:[]}), /renamed dev-server → new/);
  assert.match(show('update', updated, true, {run:r,before:[]}), /watches 0 → 1/);
});

test('output renders real lines, rotation/truncation and paths only when present; timeout and warnings are honest', () => {
  const output = {text:'first line\nsecond line\nthird line',truncated:false,rotated:false};
  const collapsed = show('output', output, false, {run: run(),query:{stream:'stderr'}});
  assert.match(collapsed, /second line\s*\nthird line/);
  assert.doesNotMatch(collapsed, /\\n|truncated|rotated|opaque-uuid|startedAt/);
  const expanded = show('output', {...output,truncated:true,rotated:true,stdoutFile:'/private/log'}, true, {run:run(),query:{pattern:'line'}});
  assert.match(expanded, /first line\s*\nsecond line\s*\nthird line/);
  assert.match(expanded, /truncated preview · rotated retained log/);
  assert.match(expanded, /currently retained.*\/private\/log/);
  assert.match(expanded, /filter \(literal\): line/);
  const timeout = show('stop', run({phase:'stop-timeout',stopRequested:true,error:'descendants may remain'}));
  assert.match(timeout, /still active · stop timed out · explicit force available/);
  assert.match(timeout, /warning: descendants may remain/);
  assert.doesNotMatch(timeout, /stopped by user/);
});

test('untrusted content and metadata are sanitized and fit narrow Unicode columns', () => {
  const attack = '\x1b]52;c;secret\x07\x1b[31mvisible\u202e';
  for (const width of [12, 18, 40]) {
    for (const component of [renderCall({action:'start',name:'界😀'+attack,command:attack} as any,theme),
      renderResult({details:{version:1,action:'output',data:{text:'界😀'+attack+'\nsecond',truncated:false,rotated:false},presentation:{}}},{expanded:true},theme)]) {
      const rows = component.render(width); assert.ok(rows.every(row => !row.includes('secret') && !row.includes('\x1b') && !row.includes('\u202e')));
      assert.ok(rows.length > 0);
      assert.ok(rows.every(row => visibleWidth(row) <= width), `overflow at ${width}`);
    }
  }
});

test('partial/error/missing/unknown-version/legacy details fail safely', () => {
  assert.match(draw(renderResult({content:[{type:'text',text:'still running'}]},{isPartial:true},theme)), /process running/);
  assert.match(draw(renderResult({content:[{type:'text',text:'\x1b]52;c;secret\x07bad input'}]},{},theme,{isError:true})), /bad input/);
  for (const details of [undefined,{version:2,action:'start',data:run(),presentation:{}},{version:1,action:'other',data:{},presentation:{}}]) {
    const text = draw(renderResult({details,content:[{type:'text',text:'{"id":"sensitive"}'}]},{},theme));
    assert.doesNotMatch(text, /sensitive|secret|\x1b/);
  }
  assert.match(draw(renderResult({details:run()},{},theme,{args:{action:'start'} as any})), /dev-server · running/);
  assert.match(draw(renderResult({details:{text:'one\ntwo',truncated:false,rotated:false}},{},theme,{args:{action:'output'} as any})), /one\s*\ntwo/);
});

test('output budget keeps newest sanitized Unicode tail and reports renderer clipping', () => {
  for (const prefix of ['x'.repeat(50050), '\t'.repeat(50050), '界😀'.repeat(26000)]) {
    for (const expanded of [false, true]) {
      const text = show('output', {text: prefix + '\nFINAL', truncated:false, rotated:false}, expanded, {run:run()});
      assert.match(text, /FINAL/, 'newest output must survive');
      assert.match(text, /display clipped/, 'display-only clipping must be explicit');
      assert.doesNotMatch(text, /\uFFFD|[\uD800-\uDFFF]/u, 'never split a surrogate pair');
    }
  }
  for (const expanded of [false, true]) {
    const text = show('output', {text:'q'.repeat(100500) + '\nFINAL',truncated:false,rotated:false},expanded);
    assert.match(text,/FINAL/);
    assert.match(text,/display clipped/);
  }
  const longLine = show('output', {text:'z'.repeat(1500) + 'FINAL',truncated:false,rotated:false});
  assert.match(longLine, /FINAL/);
  assert.match(longLine, /display clipped/);
});

test('malformed replay metadata cannot inject control sequences or masquerade as successful output', () => {
  const attack = '\x1b]52;c;secret\x07\x1b[31m\x1bPpayload\x1b\\\u202e';
  const badRun = run({phase:('running' + attack) as any, exitCode:('2' + attack) as any});
  const cases: {action:string; data:unknown; presentation?:unknown}[] = [
    {action:'start',data:badRun},
    {action:'start',data:run({outcome:('successful' + attack) as any})},
    {action:'start',data:run({startedAt:Infinity})},
    {action:'start',data:badRun,presentation:{run:run()}},
    {action:'start',data:run({name:'normal',notify:{onSuccess:('turn' + attack) as any}})},
    {action:'start',data:run({notify:{logMatches:[{pattern:'READY',stream:'stdout',mode:('regex' + attack) as any}]}})},
    {action:'list',data:{runs:[badRun]}},
    {action:'output',data:{text:'SAFE',truncated:false,rotated:false},presentation:{run:badRun}},
    {action:'output',data:{text:'SAFE',truncated:false,rotated:false},presentation:{query:{stream:'stdout' + attack}}},
    {action:'update',data:run({notify:{logMatches:[{pattern:'READY',mode:('literal' + attack) as any,stream:('stdout' + attack) as any,on:('turn' + attack) as any}]}})},
    {action:'write',data:{writtenBytes:Infinity,stdinClosed:false}},
    {action:'clear',data:{cleared:NaN}},
  ];
  for (const entry of cases) for (const expanded of [false,true]) {
    const versioned = draw(renderResult({details:{version:1,action:entry.action,data:entry.data,presentation:entry.presentation ?? {}}},{expanded},theme));
    const legacy = draw(renderResult({details:entry.data},{expanded},theme,{args:{action:entry.action,...(entry.action === 'output' ? {stream:('stdout' + attack) as any} : {})} as any}));
    for (const text of [versioned,legacy]) {
      assert.doesNotMatch(text, /\x1b|\u202e|secret|payload/);
      assert.match(text, /malformed|unavailable/i);
      assert.doesNotMatch(text, /running|wrote 0 bytes|0 processes cleared/);
    }
  }
  assert.match(draw(renderResult({details:{version:1,action:'start',data:run(),presentation:{run:badRun}}},{},theme)),/malformed/);
  const hiddenWarning = show('list',{runs:[run(),run({id:'2'}),run({id:'3',error:'retained descendant'})]});
  assert.match(hiddenWarning,/warning: additional process cleanup warnings/);
  const watchText = draw(buildMatcherLine({pattern:'READY',stream:('stdout' + attack) as any},theme,attack));
  assert.match(watchText,/malformed/);
  assert.doesNotMatch(watchText,/\x1b|\u202e|secret|payload/);
  const valid = show('output',{text:'SAFE',truncated:false,rotated:false},false,{query:{stream:'stdout'}});
  assert.match(valid,/SAFE/);
});

test('replayed notification metadata is validated before styling', () => {
  const attack = '\x1b]52;c;secret\x07\x1b[31m\x1bPpayload\x1b\\\u202e';
  const examples = [
    {kind:'watch',attention:'turn' + attack,event:{version:1,kind:'watch',run:run(),watch:{stream:'stdout' + attack,line:'READY',pattern:'READY',mode:'literal',matcherIndex:0},timestamp:12000}},
    {kind:'completion',attention:'turn',event:{version:1,kind:'completion',run:run({phase:'terminal',outcome:'successful',exitCode:('2' + attack) as any}),timestamp:12000}},
    {kind:'completion',attention:'turn',event:{version:1,kind:'completion',run:run({phase:('terminal' + attack) as any}),timestamp:12000}},
    {kind:'completion',attention:'turn',event:{version:1,kind:'completion',run:run({phase:'terminal',startedAt:Infinity}),timestamp:12000}},
    {kind:'watch',attention:'turn',event:{version:1,kind:'watch',run:run(),watch:{stream:'stdout',line:'READY',pattern:'READY',mode:('literal' + attack),matcherIndex:0},timestamp:12000}},
  ];
  for (const details of examples) for (const expanded of [false,true]) {
    const text = draw(renderNotification({details,content:'safe notification'},{expanded,outputPad:0},theme));
    assert.doesNotMatch(text,/\x1b|\u202e|secret|payload/);
    assert.match(text,/safe notification|unavailable|malformed/i);
    assert.doesNotMatch(text,/completed|matched stdout/);
  }
});

test('collapsed list and output retain bounded cleanup warnings', () => {
  const warning = 'descendants may remain ' + 'w'.repeat(2000);
  const r = run({error:warning});
  for (const expanded of [false,true]) {
    const list = show('list',{runs:[r]},expanded);
    const output = show('output',{text:'FINAL',truncated:false,rotated:false},expanded,{run:r});
    for (const text of [list,output]) {
      assert.match(text,/warning: descendants may remain/);
      if (!expanded) assert.ok(text.length < 800, 'collapsed warnings must be bounded');
    }
  }
});

test('model JSON remains original safe action data; presentation data is separate', async () => {
  let tool: any;
  const original = run({name:'\x1b]52;c;secret\x07safe'});
  const runtime: any = {snapshot:() => ({runs:[original]}),output:async () => ({text:'real\nlines',truncated:false,rotated:false}),write:async () => {}};
  registerProcessTool({registerTool:(d:unknown) => tool = d} as any,() => ({runtime,current:() => true}));
  assert.match(tool.promptSnippet, /do not sleep or poll/);
  assert.match(tool.promptGuidelines.join(' '), /&, nohup.*name each process specifically/);
  assert.match(tool.promptGuidelines.join(' '), /currently-retained/);
  assert.match(tool.promptGuidelines.join(' '), /do not refetch completion output redundantly/);
  const result = await tool.execute('id',{action:'output',id:'opaque-uuid'},undefined,undefined,{cwd:'/project'});
  assert.deepEqual(JSON.parse(result.content[0].text), result.details.data);
  assert.equal(result.details.version,1); assert.equal(result.details.presentation.run.id,'opaque-uuid');
  assert.ok(!('presentation' in JSON.parse(result.content[0].text)));
  assert.match(draw(tool.renderResult(result,{expanded:false},theme,{args:{action:'output'}})),/real\s*\nlines/);
});

test('event-time completion/watch/suppression rendering survives clear and never consults runtime', () => {
  const finished = run({phase:'terminal', outcome:'failed',exitCode:2,endedAt:12000,startedAt:2000,error:'descendant remains'});
  const make = (details: any, attention = 'turn') => notificationMessage({type:'notification',key:'k',id:finished.id,kind:details.kind === 'completion' ? 'completion':'watch',attention,text:'fallback',details} as any);
  const completion = make({version:1,timestamp:12000,kind:'completion',run:finished});
  finished.name = 'changed'; finished.error = undefined;
  const view = draw(renderNotification({details:completion},{expanded:false,outputPad:0},theme));
  assert.match(view,/dev-server failed · 10s · exit 2/); assert.match(view,/warning: descendant remains/); assert.doesNotMatch(view,/process-notification|changed/);
  const watch = make({version:1,timestamp:12000,kind:'watch',run:run(),watch:{pattern:'READY',mode:'literal',stream:'stdout',line:'READY now',matcherIndex:0}});
  assert.match(draw(renderNotification({details:watch},{expanded:true,outputPad:0},theme)),/matched stdout: READY now/);
  const suppressed = make({version:1,timestamp:12000,kind:'suppression',suppressedCount:7},'context');
  assert.match(draw(renderNotification({details:suppressed},{expanded:false,outputPad:0},theme)),/7 watch matches suppressed/);
  assert.match(draw(renderNotification({content:'\x1b]52;c;secret\x07old message'},{expanded:false,outputPad:0},theme)),/\[process\] old message/);
});

test('ported skill remains substantial and states actual backend limits and interface', () => {
  const skill = readFileSync(new URL('./skills/pi-processes/SKILL.md',import.meta.url),'utf8');
  assert.ok(skill.split('\n').length > 500);
  for (const phrase of ['/processes','64 MiB','50 KiB','five minutes','literal','15-second','no automatic SIGKILL','currently-retained','defaultStatus','newline','returned-opaque-id']) assert.ok(skill.includes(phrase),phrase);
  assert.match(skill,/Do not fetch output solely to repeat a completion notification/);
  assert.doesNotMatch(skill,/"mode": "regex"|`\/ps:logs`|proc_1/);
});
