import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, defaults, validatePatch } from '../electron/core.mjs';
import { validateWorkspace } from '../electron/validation.mjs';

test('task backgrounds and motion persist independently without changing conversations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-ambience-'));
  const store = new Store(root);
  try {
    const a = store.create({ name: 'Focus', engine: 'codex', cwd: root });
    const b = store.create({ name: 'Ideas', engine: 'claude', cwd: root });
    assert.equal(a.background, 'off'); assert.equal(a.backgroundPaused, false);
    store.add(a.id, 'user', 'Keep this conversation');
    store.patch(a.id, { background: 'ocean', backgroundPaused: true, draft: 'Keep this draft' });
    store.patch(b.id, { background: 'embers' });
    assert.equal(store.save(), true);
    const restored = new Store(root);
    assert.equal(restored.get(a.id).background, 'ocean'); assert.equal(restored.get(a.id).backgroundPaused, true);
    assert.equal(restored.get(a.id).draft, 'Keep this draft');
    assert.deepEqual(restored.get(a.id).messages.map(m => m.text), ['Keep this conversation']);
    assert.equal(restored.get(b.id).background, 'embers'); assert.equal(restored.get(b.id).backgroundPaused, false);
    store.patch(a.id, { background: 'off' });
    assert.equal(store.get(b.id).background, 'embers');
  } finally { clearTimeout(store.timer); fs.rmSync(root, { recursive: true, force: true }); }
});

test('task background validation allows known presets and rejects external or malformed values', () => {
  for (const background of ['off', 'aurora', 'ocean', 'embers', 'stars']) assert.deepEqual(validatePatch({ background }), { background });
  for (const background of ['url(https://example.test)', '../custom', null, true, {}, 1]) assert.throws(() => validatePatch({ background }), /Invalid task background/);
  for (const backgroundPaused of ['false', 0, 1, null]) assert.throws(() => validatePatch({ backgroundPaused }), /Invalid background motion/);
  assert.deepEqual(validatePatch({ backgroundPaused: false }), { backgroundPaused: false });
});

test('legacy and malformed saved backgrounds load safely as off without losing task data', () => {
  const legacy = { id: 'legacy', name: 'Existing task', engine: 'codex', cwd: os.tmpdir(), profile: 'normal', messages: [{ id: 'message', role: 'user', text: 'Existing text' }], attachments: [], draft: 'Existing draft' };
  const saved = { sessions: [legacy, { ...legacy, id: 'invalid', background: 'url(file:///private)', backgroundPaused: 'false' }, { ...legacy, id: 'valid', background: 'stars', backgroundPaused: true }] };
  const { sessions } = validateWorkspace(saved, defaults, []);
  for (const task of sessions.slice(0, 2)) { assert.equal(task.background, 'off'); assert.equal(task.backgroundPaused, false); assert.equal(task.draft, 'Existing draft'); assert.equal(task.messages[0].text, 'Existing text'); }
  assert.equal(sessions[2].background, 'stars'); assert.equal(sessions[2].backgroundPaused, true);
});
