import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('the Electron check includes every main module and rejects invalid Electron options in JavaScript', t => {
  const config = JSON.parse(fs.readFileSync('tsconfig.electron.json'));
  assert.equal(config.compilerOptions.checkJs, true); assert.equal(config.compilerOptions.allowJs, true);
  const files = spawnSync('npx', ['--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.electron.json', '--listFilesOnly'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(files.status, 0, files.stdout + files.stderr);
  for (const file of ['main.mjs', 'agents.mjs', 'workspace.mjs', 'core.mjs', 'preload.cjs']) assert.ok(files.stdout.includes(path.resolve('electron', file)));
  assert.match(JSON.parse(fs.readFileSync('package.json')).scripts.build, /tsconfig\.electron\.json/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-js-types-')), file = path.join(root, 'invalid.mjs'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, '/** @type {Electron.BrowserWindowConstructorOptions} */\nconst options = { webPreferences: { sandbox: \'not a boolean\' } };\nexport { options };');
  const fixtureConfig = path.join(root, 'tsconfig.json'); fs.writeFileSync(fixtureConfig, JSON.stringify({ extends: path.resolve('tsconfig.electron.json'), include: [file, path.resolve('node_modules/electron/electron.d.ts')], compilerOptions: { types: [] } }));
  const result = spawnSync('npx', ['--no-install', 'tsc', '--noEmit', '-p', fixtureConfig], { encoding: 'utf8', timeout: 20000 });
  assert.notEqual(result.status, 0); assert.match(result.stdout, /invalid\.mjs.*TS2322/);
});
