import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Store } from '../electron/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-lifecycle-ui-')), store = new Store(root);
const task = store.create({ name: 'Retry and commands', engine: 'claude', cwd: root }); store.save();
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
const failures = [], passed = [];
const check = async (name, fn) => { try { await fn(); passed.push(name); } catch (error) { failures.push({ name, message: error.message }); } };
try {
  const page = await app.firstWindow();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  // Patch only this disposable process's provider boundary. Real IPC validation,
  // workspace transitions and React reconciliation still run end to end.
  await app.evaluate(async (_, file) => {
    const { Workspace } = process.getBuiltinModule('module').createRequire(file)(new URL(file).pathname);
    const send = Workspace.prototype.send, commands = Workspace.prototype.listCommands;
    globalThis.__discoveryCalls = 0;
    Workspace.prototype.send = function (...args) { this.claude.send = async () => { throw new Error('Simulated connection failure'); }; return send.apply(this, args); };
    Workspace.prototype.listCommands = function (id, reload, localOnly) {
      if (!localOnly) globalThis.__discoveryCalls++;
      return commands.call(this, id, reload, true);
    };
  }, pathToFileURL(path.resolve('electron/workspace.mjs')).href);
  const field = page.getByRole('textbox', { name: 'Message', exact: true });
  await check('typing a slash uses only the local catalogue', async () => {
    await field.fill('/'); await page.getByRole('listbox', { name: 'Slash commands' }).waitFor(); await page.waitForTimeout(200);
    assert.equal(await app.evaluate(() => globalThis.__discoveryCalls), 0); await field.press('Escape');
    await page.getByRole('button', { name: 'Commands, skills and protocols' }).click();
    await page.getByRole('listbox', { name: 'Available commands' }).waitFor();
    assert.ok(await app.evaluate(() => globalThis.__discoveryCalls) > 0); await page.getByRole('button', { name: 'Close dialog' }).click();
  });
  await check('immediate provider failure restores a draft after the send response', async () => {
    await field.fill('Please keep this unsent thought'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Simulated connection failure' }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea[data-composer]').value === 'Please keep this unsent thought', undefined, { timeout: 2000 });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(async id => (await window.haven.invoke('state')).sessions.find(s => s.id === id).draft, task.id), 'Please keep this unsent thought');
  });
  await check('task names save trimmed text on blur', async () => {
    const name = page.getByRole('textbox', { name: 'Task name', exact: true }); await name.fill('  A clean name  '); await name.blur();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Task name"]').value === 'A clean name');
  });
} finally { await app.close(); }
console.log(JSON.stringify({ ok: !failures.length, passed, failures, data: root }, null, 2)); if (failures.length) process.exitCode = 1;
