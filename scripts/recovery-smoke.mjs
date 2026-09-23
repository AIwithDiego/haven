import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Store, Attachments } from '../electron/core.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-recovery-ui-'));
const store = new Store(root), copies = new Attachments(path.join(root, 'temporary-attachments'));
const task = store.create({ name: 'Recovered task', engine: 'claude', cwd: root, draft: 'Keep this draft' });
store.add(task.id, 'assistant', 'Keep this conversation'); store.save(); store.save();
const orphan = copies.create(Buffer.from('A file referenced by the damaged primary only'), 'Unrecovered.txt', 'text/plain');
fs.writeFileSync(store.file, '{broken');
const launch = () => electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, HAVEN_TEST_MODE: '1', HAVEN_DATA_DIR: root } });
let app = await launch();
try {
  let page = await app.firstWindow();
  await page.getByRole('alert').filter({ hasText: 'recovered' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Keep this draft');
  await page.getByText('Keep this conversation', { exact: true }).waitFor();
  assert.equal(fs.existsSync(orphan.path), true);
  await page.evaluate(() => window.haven.invoke('retrySave'));
  assert.ok(fs.readdirSync(root).some(name => name.startsWith('workspace.json.corrupt-')));
  await app.close(); app = await launch(); page = await app.firstWindow();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  assert.equal(fs.existsSync(orphan.path), true, 'Recovery must preserve unmatched attachments after another restart');
  console.log(JSON.stringify({ ok: true, tested: ['backup recovery notice', 'draft and conversation recovery', 'damaged file retention', 'attachment preservation across restart'], data: root }));
} finally { await app.close(); }
