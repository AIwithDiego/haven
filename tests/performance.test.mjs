import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Workspace } from '../electron/workspace.mjs';
import { Store } from '../electron/core.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 80));
test('snapshots exclude terminal replay and image previews; streaming patches only the changed task and message', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-patches-')), w = new Workspace(root, path.resolve('helpers'));
  t.after(async () => { await w.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const a = w.create({ name: 'Stream', engine: 'claude', cwd: root }), b = w.create({ name: 'Other', engine: 'codex', cwd: root });
  w.store.get(a).terminalBuffer = 'private-terminal-replay'.repeat(10000);
  w.store.get(a).attachments.push(w.attachments.create(Buffer.alloc(300000), 'Image.png'));
  w.store.add(b, 'assistant', 'unrelated transcript'.repeat(10000)); w.store.append(a, 'stream', 'Hello');
  const snapshot = w.snapshot(); assert.equal(snapshot.sessions[0].terminalBuffer, undefined); assert.equal(snapshot.sessions[0].attachments[0].preview, undefined);
  await pause(); const events = []; w.on('patch', value => events.push(structuredClone(value)));
  w.store.append(a, 'stream', ' there'); await pause();
  assert.equal(events.length, 1); assert.deepEqual(events[0].sessions.map(s => s.id), [a]);
  assert.equal(events[0].sessions[0].messages.upsert[0].text, 'Hello there'); assert.ok(JSON.stringify(events[0]).length < 3000);
});
test('applying incremental state keeps unchanged task and message objects stable', async () => {
  const { StatePublisher, applyPatch, filterTasks } = await import('../electron/patches.mjs');
  const publisher = new StatePublisher(), original = { sessions: [{ id: 'a', name: 'A', messages: [{ id: 'one', text: 'Hello' }, { id: 'two', text: 'Keep' }] }, { id: 'b', name: 'B', messages: [] }], activeId: 'a' };
  publisher.next(original);
  const next = structuredClone(original); next.sessions[0].messages[0].text = 'Hello world';
  const patch = publisher.next(next, new Set(['a'])).patch, merged = applyPatch(original, patch);
  assert.equal(merged.sessions[1], original.sessions[1]); assert.equal(merged.sessions[0].messages[1], original.sessions[0].messages[1]); assert.equal(merged.sessions[0].messages[0].text, 'Hello world');
  const forbidden = [{ name: 'Untouched', cwd: '/project', get messages() { throw new Error('Empty search read transcript'); } }];
  assert.equal(filterTasks(forbidden, '  '), forbidden);
});
test('transcript migration keeps full history outside workspace metadata and preserves it across reload', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-transcripts-')), store = new Store(root);
  t.after(() => { clearTimeout(store.timer); fs.rmSync(root, { recursive: true, force: true }); });
  const task = store.create({ name: 'Long history', engine: 'claude', cwd: root, draft: 'Keep draft' });
  for (let i = 0; i < 250; i++) store.add(task.id, 'assistant', `Message ${i}: ` + 'word '.repeat(100));
  store.save(); const saved = JSON.parse(fs.readFileSync(store.file));
  assert.equal(saved.sessions[0].messages, undefined); assert.ok(fs.statSync(store.file).size < 10000);
  const restored = new Store(root); assert.equal(restored.get(task.id).messages.length, 250); assert.equal(restored.get(task.id).draft, 'Keep draft');
  assert.equal(restored.get(task.id).messages.at(-1).text, task.messages.at(-1).text);
});
test('legacy inline transcripts migrate with a recoverable original and damaged transcript files use their own backup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-legacy-transcript-')), file = path.join(root, 'workspace.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = { version: 1, sessions: [{ id: 'legacy', name: 'Legacy', engine: 'claude', cwd: root, profile: 'normal', draft: 'Unsent', attachments: [], messages: [{ id: 'm', role: 'user', text: 'Original history', at: 1 }] }], settings: {}, activeId: 'legacy' };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const store = new Store(root); store.save();
  assert.equal(JSON.parse(fs.readFileSync(file + '.bak')).sessions[0].messages[0].text, 'Original history');
  const transcript = store.transcripts.file('legacy'); fs.writeFileSync(transcript, '{broken');
  const recovered = new Store(root); assert.equal(recovered.get('legacy').messages[0].text, 'Original history'); assert.equal(recovered.get('legacy').draft, 'Unsent');
  assert.match(recovered.storage.notices.join(' '), /transcript.*backup/); assert.equal(recovered.save(), true);
  assert.ok(fs.readdirSync(path.dirname(transcript)).some(name => name.includes('.corrupt-')));
});
