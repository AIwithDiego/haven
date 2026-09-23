import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, startClock, stopClock } from '../electron/core.mjs';
import { Workspace } from '../electron/workspace.mjs';
import { CodexAdapter, ClaudeAdapter } from '../electron/agents.mjs';
import { parseCommand } from '../electron/commands.mjs';
const setup = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-controls-')); return { root, w: new Workspace(root, path.resolve('helpers')) }; };

test('slash parsing accepts arguments and aliases while leaving literal paths and escaped slashes alone', () => {
  assert.deepEqual(parseCommand(' /model gpt-example \n'), { name: 'model', args: 'gpt-example' });
  assert.deepEqual(parseCommand('/quit'), { name: 'exit', args: '' });
  assert.equal(parseCommand('/Users/me/file.txt'), null);
  assert.equal(parseCommand('//model'), null);
  assert.equal(parseCommand('Please explain /exit'), null);
});

test('Haven commands never consume a model turn, and unknown commands preserve drafts and attachments', async () => {
  const { root, w } = setup();
  try {
    const id = w.create({ engine: 'codex', name: 'Commands', cwd: root }), s = w.store.get(id); let sends = 0;
    w.modelLists.codex.push({ value: 'example-model', label: 'Example', efforts: [] });
    w.codex.send = async () => { sends++; }; w.codex.commands = async () => [];
    s.draft = '/unknown'; const a = w.attachments.create(Buffer.from('draft'), 'draft.txt', 'text/plain'); s.attachments.push(a);
    assert.equal((await w.send(id, '/model')).effect, 'model');
    await w.send(id, '/model example-model'); assert.equal(s.model, 'example-model');
    await w.send(id, '/pin'); assert.equal(s.pinned, true);
    assert.equal((await w.send(id, '/status')).effect, 'details');
    s.draft = '/unknown';
    await assert.rejects(w.send(id, '/unknown', [a.id]), /not available/);
    assert.equal(sends, 0); assert.equal(s.messages.length, 0); assert.equal(s.draft, '/unknown'); assert.ok(fs.existsSync(a.path));
    await w.send(id, '//model'); assert.equal(sends, 1); w.finish(id);
  } finally { await w.shutdown(); }
});

test('Claude skill commands remain first even with shared notices, and native content stays a string', async () => {
  const { root, w } = setup();
  try {
    const id = w.create({ engine: 'claude', name: 'Skills', cwd: root }); w.create({ engine: 'codex', name: 'Peer', cwd: root });
    w.claude.commands = async () => [{ name: 'review', kind: 'skill', description: 'Review' }]; let sent;
    w.claude.send = async (_s, text) => { sent = text; };
    await w.send(id, '/review this change');
    assert.match(sent, /^\/review this change\n\n\[Haven workspace notice:/); w.finish(id);
    const adapter = new ClaudeAdapter({}); let input;
    const s = w.store.get(id);
    adapter.clients.set(id, { profile: s.profile, model: s.model, effort: s.effort, input: { push(value) { input = value; } }, query: { supportedModels: async () => [] } });
    await adapter.send(s, '/review this change', [], { name: 'review', kind: 'skill' });
    assert.equal(input.message.content, '/review this change');
  } finally { await w.shutdown(); }
});

test('Codex skill selection becomes an explicit skill input with its discovered path', async () => {
  const calls = [], s = { id: 's', cwd: '/project', name: 'Skill', profile: 'normal' };
  const adapter = new CodexAdapter({ persist() {} }); adapter.connect = async () => {};
  adapter.request = async (method, params) => { calls.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'remote' } } : method === 'turn/start' ? { turn: { id: 'turn' } } : {}; };
  await adapter.send(s, 'Review this', [], { name: 'review', path: '/project/.agents/skills/review/SKILL.md' });
  assert.deepEqual(calls.find(c => c.method === 'turn/start').params.input[1], { type: 'skill', name: 'review', path: '/project/.agents/skills/review/SKILL.md' });
});

test('closing a running turn waits for interruption, keeps history, and can reopen the same remote session', async () => {
  const { root, w } = setup();
  try {
    const id = w.create({ engine: 'codex', name: 'Close check', cwd: root }), s = w.store.get(id);
    w.codex.send = async () => {}; let stopped = false; w.codex.stop = async () => { stopped = true; };
    s.remoteId = 'same-thread'; await w.send(id, 'Keep this conversation');
    await w.send(id, '/exit'); assert.ok(stopped); assert.equal(s.closeRequested, true); assert.equal(s.closed, undefined);
    w.finish(id, null, true); assert.equal(s.closed, true); assert.equal(s.status, 'closed'); assert.ok(s.closedAt);
    await assert.rejects(w.send(id, 'Should not run'), /Reopen/);
    w.restore(id); assert.equal(s.remoteId, 'same-thread'); assert.equal(s.messages[0].text, 'Keep this conversation'); assert.equal(s.closed, false);
    w.archive(id); assert.ok(s.archivedAt); assert.equal(s.archived, true);
    w.restore(id); assert.equal(s.archived, false);
  } finally { await w.shutdown(); }
});

test('starting fresh retains the previous conversation and isolates new provider context', async () => {
  const { root, w } = setup();
  try {
    const id = w.create({ engine: 'codex', name: 'Fresh', cwd: root }), s = w.store.get(id);
    s.remoteId = 'old-thread'; w.store.add(id, 'user', 'Keep this history'); s.draft = '/clear';
    const result = await w.send(id, '/clear'); const fresh = w.store.get(result.id);
    assert.equal(s.archived, true); assert.equal(s.messages.length, 1); assert.equal(fresh.remoteId, undefined); assert.deepEqual(fresh.messages, []); assert.equal(w.store.state.activeId, fresh.id);
  } finally { await w.shutdown(); }
});

test('runtime excludes idle and approval waits, and restart stops at the last checkpoint', async () => {
  const { root, w } = setup();
  try {
    const id = w.create({ engine: 'codex', name: 'Clock', cwd: root }), s = w.store.get(id);
    startClock(s, 1000); stopClock(s, 4000); stopClock(s, 6000); startClock(s, 10000); stopClock(s, 12000); assert.equal(s.runningMs, 5000);
    s.status = 'working'; startClock(s);
    const approval = w.ask(id, { title: 'Allow?', kind: 'approval' }); assert.equal(s.runningSince, null);
    w.answer(id, { requestId: s.approval.id, allow: true }); await approval; assert.ok(s.runningSince); w.finish(id);
    s.status = 'working'; s.runningMs = 0; s.runningSince = Date.now() - 2000; w.store.save();
    const savedAt = w.store.state.savedAt; const recovered = new Store(root);
    assert.equal(recovered.get(id).runningMs, savedAt - s.runningSince); assert.equal(recovered.get(id).runningSince, null); assert.equal(recovered.get(id).status, 'interrupted'); recovered.save();
  } finally { await w.shutdown(); }
});

test('deleting rejects running work, deletes only owned copies, and keeps other tasks and original files', async () => {
  const { root, w } = setup();
  try {
    const original = path.join(root, 'original.txt'); fs.writeFileSync(original, 'Original');
    const id = w.create({ engine: 'codex', name: 'Delete me', cwd: root }), s = w.store.get(id);
    const peer = w.create({ engine: 'claude', name: 'Keep me', cwd: root }); w.store.patch(peer, { draft: 'A private draft' });
    const a = w.attachments.create(Buffer.from('copy'), 'original.txt', 'text/plain'); s.attachments.push(a);
    s.status = 'working'; assert.throws(() => w.remove(id), /Stop this task/); s.status = 'idle'; w.remove(id);
    assert.equal(fs.existsSync(a.path), false); assert.equal(fs.readFileSync(original, 'utf8'), 'Original'); assert.equal(w.store.get(peer).draft, 'A private draft');
    const recovered = new Store(root); assert.throws(() => recovered.get(id), /not found/); recovered.save();
  } finally { await w.shutdown(); }
});
