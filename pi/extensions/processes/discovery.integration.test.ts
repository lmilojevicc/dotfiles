import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, rmSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const directory = dirname(fileURLToPath(import.meta.url));

for (const collision of [false, true]) test(`installed host advertises readable resource-discovered skill, collision=${collision}`, { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'processes-resource-test-'));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const agentDir = join(root, 'agent'), cwd = join(root, 'project');
    mkdirSync(join(agentDir, 'extensions'), { recursive: true }); mkdirSync(cwd);
    symlinkSync(directory, join(agentDir, 'extensions', 'processes'), 'dir');
    if (collision) {
      mkdirSync(join(agentDir, 'skills', 'pi-processes'), { recursive: true });
      writeFileSync(join(agentDir, 'skills', 'pi-processes', 'SKILL.md'), '---\nname: pi-processes\ndescription: Deliberate collision fixture.\n---\nFixture\n');
    }
    const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noThemes: true, noPromptTemplates: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0].tools.keys()], ['process']);
    assert.deepEqual([...loaded.extensions[0].commands.keys()], ['processes']);
    assert.deepEqual([...loaded.extensions[0].messageRenderers.keys()], ['process-notification']);
    assert.equal(loader.getSkills().skills.length, collision ? 1 : 0, 'nested skill is not automatically registered before resource discovery');
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ['read', 'process'] }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: error => errors.push(error) }); // Actual host session_start -> resources_discover -> extendResources -> prompt rebuild.
    const resources = loader.getSkills();
    assert.equal(resources.skills.length, 1);
    assert.equal(resources.skills[0].name, 'pi-processes');
    assert.equal(resources.skills[0].disableModelInvocation, false);
    assert.match(session.systemPrompt, /<name>pi-processes<\/name>/);
    assert.ok(session.systemPrompt.includes(resources.skills[0].filePath));
    assert.match(readFileSync(resources.skills[0].filePath, 'utf8'), /^---\nname: pi-processes/);
    if (collision) {
      assert.ok(resources.diagnostics.some(d => d.type === 'collision' && d.collision?.name === 'pi-processes'));
      assert.match(resources.skills[0].description, /Deliberate collision/);
    } else {
      assert.deepEqual(resources.diagnostics, []);
      assert.equal(realpathSync(resources.skills[0].filePath), join(directory, 'skills/pi-processes/SKILL.md'));
      assert.match(session.systemPrompt, /do not sleep or poll/);
      const oldTool = session.getToolDefinition('process')!;
      const oldContext = session.extensionRunner.createContext();
      const command = `exec '${process.execPath}' -e 'setTimeout(()=>process.exit(0),8000);process.stdin.resume()'`;
      const result = await oldTool.execute('discovery-owned', { action: 'start', name: 'reload-owned fixture', command }, undefined, undefined, oldContext);
      const started = JSON.parse(result.content[0].text);
      assert.equal(started.phase, 'running'); assert.ok(existsSync(started.stdoutFile));
      await session.reload();
      assert.equal(existsSync(started.stdoutFile), false);
      assert.throws(() => process.kill(started.pid, 0), /ESRCH/);
      await assert.rejects(() => oldTool.execute('stale', { action: 'list' }, undefined, undefined, oldContext), /closing|stale|changed/i);
      const current = await session.getToolDefinition('process')!.execute('fresh', { action: 'list' }, undefined, undefined, session.extensionRunner.createContext());
      assert.deepEqual(JSON.parse(current.content[0].text), { runs: [] });
      assert.equal(loader.getExtensions().extensions.length, 1);
      assert.equal(loader.getSkills().skills.length, 1);
      assert.deepEqual(loader.getSkills().diagnostics, []);
      assert.ok(session.systemPrompt.includes(loader.getSkills().skills[0].filePath));
    }
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); }
    rmSync(root, { recursive: true, force: true });
  }
});

test('pinned provenance archives and executable backend hashes match their source manifests', () => {
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const backend = JSON.parse(readFileSync(join(directory, 'backend/source-manifest.json'), 'utf8'));
  const transcript = JSON.parse(readFileSync(join(directory, 'render/source-manifest.json'), 'utf8'));
  for (const manifest of [backend, transcript]) {
    assert.equal(manifest.package, '@aliou/pi-processes'); assert.equal(manifest.version, '0.12.0');
    assert.equal(manifest.sourceCommit, '16c1080030e5efd175a268e44ce665fb97bcb68f');
  }
  for (const source of backend.sources) {
    assert.equal(hash(join(directory, 'backend', source.originalArchive)), source.sha256, source.source);
    assert.equal(hash(join(directory, 'backend', source.target)), source.adaptedSha256, source.target);
  }
  for (const source of transcript.mappings) {
    assert.equal(hash(join(directory, source.audit)), source.sha256, source.upstream);
    for (const target of source.adaptedTargets) assert.ok(readFileSync(join(directory, target)).length > 0);
  }
  const local = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(local.private, true); assert.equal(local.dependencies, undefined);
  assert.deepEqual(local.pi.extensions, ['./index.ts']);
  assert.equal(local.publishConfig, undefined);
  const supplied = JSON.parse(readFileSync(join(directory, 'backend/upstream-metadata/package.json'), 'utf8'));
  assert.equal(supplied.license, 'MIT'); assert.equal(supplied.author, undefined);
});

test('README and advertised skill describe the shipped control, watch and retained-log contracts', () => {
  const readme = readFileSync(join(directory, 'README.md'), 'utf8');
  const skill = readFileSync(join(directory, 'skills/pi-processes/SKILL.md'), 'utf8');
  for (const text of [readme, skill]) {
    for (const phrase of ['64 MiB', '50 KiB', 'five minutes', '15-second', 'newline', 'currently-retained', 'defaultStatus', 'processes:snapshot:v1', 'processes:snapshot:request:v1']) assert.ok(text.includes(phrase), phrase);
    assert.match(text, /[Tt]erminal (?:process )?completion notifications are not throttled/);
    assert.match(text, /excess.*finished.*above 50/);
    assert.doesNotMatch(text, /Fire on every job completion|When over 50 records|`k` force|once per watch per second/);
  }
  assert.ok(readme.indexOf("pi.events.on('processes:snapshot:v1'") < readme.indexOf("pi.events.emit('processes:snapshot:request:v1'"));
  assert.match(readme, /resources_discover/);
});
