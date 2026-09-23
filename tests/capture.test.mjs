import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, Attachments } from '../electron/core.mjs';
import { captureTask } from '../electron/capture.mjs';

test('capture modes control visibility and persist without exposing foreign files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-capture-'));
  const store = new Store(root), attachments = new Attachments(path.join(root, 'attachments'));
  const task = store.create({ engine: 'claude', name: 'Capture', cwd: root });
  let hidden = 0, shown = 0, regions = 0, pages = 0;
  const context = { store, attachments, window: { hide: () => hidden++, webContents: { capturePage: async () => { pages++; return { toPNG: () => Buffer.from('image') }; } } }, show: () => shown++, exec: async (_bin, args) => { regions++; fs.writeFileSync(args.at(-1), 'image'); } };
  try {
    await captureTask(context, task.id, 'area'); assert.equal(hidden, 1); assert.equal(shown, 1);
    await captureTask(context, task.id, 'area-including-haven'); assert.equal(hidden, 1); assert.equal(shown, 1);
    await captureTask(context, task.id, 'haven-window'); assert.equal(pages, 1); assert.equal(regions, 2);
    await captureTask(context, task.id); assert.equal(pages, 2);
    store.save(); assert.equal(new Store(root).get(task.id).captureMode, 'haven-window');
    await assert.rejects(captureTask(context, task.id, 'arbitrary'), /Invalid capture mode/);
    const count = task.attachments.length;
    context.exec = async () => { throw Object.assign(new Error('Cancelled'), { code: 1 }); };
    assert.equal(await captureTask(context, task.id, 'area'), null);
    assert.equal(task.attachments.length, count); assert.equal(hidden, 2); assert.equal(shown, 2);
    assert.equal(fs.readdirSync(attachments.root).length, count);
  } finally { clearTimeout(store.timer); fs.rmSync(root, { recursive: true, force: true }); }
});

test('denied screen access is detected before hiding or launching another permission prompt', async () => {
  let calls = 0;
  const context = { store: { get: () => ({}), changed() {} }, attachments: {}, window: { hide: () => calls++ }, exec: () => calls++, show: () => calls++, screenAccess: () => 'denied' };
  await assert.rejects(captureTask(context, 'task', 'area'), /restart|reopen/i);
  assert.equal(calls, 0);
});
