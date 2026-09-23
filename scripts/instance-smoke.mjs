import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Store } from '../electron/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-instance-ui-')), store = new Store(root);
const task = store.create({ name: 'Only one writer', engine: 'claude', cwd: root, draft: 'Preserve my draft' }); store.save();
const env = { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env }); let second;
try {
  const page = await app.firstWindow(); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  const before = fs.readFileSync(store.file, 'utf8');
  second = spawn(electronPath, ['.'], { env, cwd: process.cwd(), stdio: 'ignore' });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Second launch did not exit.')), 5000); second.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Second launch exited ${code}`)); }); second.once('error', reject); });
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Preserve my draft');
  assert.equal(await page.evaluate(async () => (await window.haven.invoke('state')).sessions.length), 1);
  console.log(JSON.stringify({ ok: true, tested: ['second isolated launch exits', 'primary workspace and draft remain unchanged'], task: task.id, data: root }));
} finally { if (second && second.exitCode === null) second.kill(); await app.close(); }
