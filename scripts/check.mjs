import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-check-'));
const env = { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root };
delete env.HAVEN_APP_PATH;
const run = (command, args) => {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
run('npm', ['test']);
run('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']);
run('npx', ['--no-install', 'tsc', '--noEmit']);
run('npx', ['--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.electron.json']);
run('npx', ['--no-install', 'vite', 'build']);
const smoke = process.argv.slice(2);
for (const name of smoke.length ? smoke : ['desktop', 'session-controls']) {
  if (!['desktop', 'session-controls', 'feedback', 'conversation', 'permissions', 'approval', 'recovery', 'accessibility', 'lifecycle', 'instance', 'usage-ambience', 'links-editing', 'personal-reader', 'workspace-updates'].includes(name)) throw new Error('Unknown desktop smoke check.');
  run('node', [`scripts/${name}-smoke.mjs`]);
}
console.log(`All isolated checks passed. Test data: ${root}`);
