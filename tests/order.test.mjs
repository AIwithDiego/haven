import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/core.mjs';

const order = store => store.state.sessions.filter(s => !s.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.order - b.order).map(s => s.name);
test('task order persists across moves, pin boundaries and reloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-order-'));
  const store = new Store(root);
  try {
    const a = store.create({ name: 'A', engine: 'codex', cwd: root, pinned: true });
    const b = store.create({ name: 'B', engine: 'claude', cwd: root });
    const c = store.create({ name: 'C', engine: 'terminal', cwd: root });
    store.reorder(c.id, { targetId: b.id, position: 'before' });
    assert.deepEqual(order(store), ['A', 'C', 'B']);
    store.reorder(c.id, { direction: -1 });
    assert.equal(c.pinned, true); assert.deepEqual(order(store), ['C', 'A', 'B']);
    store.reorder(a.id, { targetId: b.id, position: 'after' });
    assert.equal(a.pinned, false); assert.deepEqual(order(store), ['C', 'B', 'A']);
    store.save(); const restored = new Store(root);
    assert.deepEqual(order(restored), ['C', 'B', 'A']);
    assert.equal(restored.get(c.id).pinned, true);
    assert.throws(() => store.reorder(b.id, { targetId: 'missing', position: 'before' }), /Task not found/);
    assert.throws(() => store.reorder(b.id, { direction: 7 }), /Invalid/);
    assert.notEqual(store.patch(b.id, { order: 'bad' }).order, 'bad');
  } finally { clearTimeout(store.timer); fs.rmSync(root, { recursive: true, force: true }); }
});

test('legacy tasks retain their relative order when order fields are missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-order-legacy-'));
  fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ sessions: [
    { id: '1', name: 'First', pinned: false, status: 'idle' },
    { id: '2', name: 'Pinned', pinned: true, status: 'idle' },
    { id: '3', name: 'Last', status: 'idle' },
  ].map(s => ({ ...s, engine: 'claude', cwd: root, profile: 'normal', messages: [], attachments: [] })) }));
  try {
    const store = new Store(root);
    assert.ok(store.state.sessions.every(s => Number.isFinite(s.order)));
    assert.deepEqual(order(store), ['Pinned', 'First', 'Last']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
