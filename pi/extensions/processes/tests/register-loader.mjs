import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const env = { ...process.env };
delete env.npm_config_prefix;
const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', env }).trim();
const parentURL = pathToFileURL(join(root, '@earendil-works/pi-coding-agent/package.json')).href;
const home = mkdtempSync(join(tmpdir(), 'processes-test-home-'));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, specifier === 'typebox' || specifier.startsWith('typebox/') || specifier.startsWith('@earendil-works/') ? { ...context, parentURL } : context);
  },
});
