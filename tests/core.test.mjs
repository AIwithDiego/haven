import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, Attachments, canonicalFolder, sharedNotice } from '../electron/core.mjs';
import { CodexAdapter } from '../electron/agents.mjs';
import { Workspace } from '../electron/workspace.mjs';

test('sessions in the same folder retain independent conversations and native permission profiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-core-'));
  const store = new Store(root);
  const a = store.create({ name: 'Task A', engine: 'codex', cwd: root, profile: 'autonomous' });
  const b = store.create({ name: 'Task B', engine: 'claude', cwd: root });
  store.add(a.id, 'user', 'A private idea'); store.add(b.id, 'user', 'An unrelated thought');
  store.patch(a.id, { model: 'test-model', draft: 'Keep my draft' });
  a.status = 'working'; a.remoteId = 'codex-remote-A'; store.save();
  const restored = new Store(root);
  assert.equal(restored.get(a.id).status, 'interrupted');
  assert.equal(restored.get(a.id).draft, 'Keep my draft');
  assert.equal(restored.get(a.id).remoteId, 'codex-remote-A');
  assert.deepEqual(restored.get(b.id).messages.map(m => m.text), ['An unrelated thought']);
  assert.throws(() => store.patch(b.id, { color: 'url(evil)' }), /valid colour/);
  assert.throws(() => store.patch(a.id, { profile: 'gated' }), /Claude profile/);
  store.save(); restored.save();
});

test('shared workspace notice contains only task metadata and new filenames', () => {
  const current = { id: 'a', cwd: '/project', lastTurnAt: 100 };
  const sessions = [current, { id: 'b', cwd: '/project', name: 'Task B', engine: 'claude', status: 'working', messages: [{ text: 'secret prompt' }] }, { id: 'c', cwd: '/different', name: 'UnrelatedTaskElsewhere', engine: 'codex' }];
  const notice = sharedNotice(sessions, current, [{ file: 'old.ts', at: 99 }, { file: 'new.ts', at: 101 }]);
  assert.match(notice, /Task B/); assert.match(notice, /new.ts/); assert.doesNotMatch(notice, /secret prompt|old.ts|UnrelatedTaskElsewhere/);
});

test('attachment deletion is restricted to owned copies; clean up only consumed or discarded files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-attachments-'));
  const original = path.join(root, 'original.txt'); fs.writeFileSync(original, 'keep me');
  const store = new Attachments(path.join(root, 'owned'));
  const a = store.create(Buffer.from('copy'), 'Capture.png', 'image/png');
  const b = store.create(Buffer.from('draft'), 'draft.txt', 'text/plain');
  assert.throws(() => store.remove({ ...a, path: original }), /does not own/);
  store.remove(a); assert.equal(a.expired, true); assert.equal(fs.existsSync(a.path), false); assert.equal(fs.readFileSync(original, 'utf8'), 'keep me');
  const orphan = store.create(Buffer.from('orphan'), 'old.png'); store.sweep([b]);
  assert.equal(fs.existsSync(orphan.path), false); assert.equal(fs.existsSync(b.path), true);
  assert.throws(() => canonicalFolder(original), /not a file/);
});

test('switching Codex from full autonomy restores the captured native policy on the next turn', async () => {
  const calls = [], session = { id: 's', cwd: '/project', name: 'Example', profile: 'autonomous', model: '', effort: '' };
  const native = { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const adapter = new CodexAdapter({ persist() {}, finish() {} });
  adapter.connect = async () => {};
  adapter.request = async (method, params) => { calls.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'remote' }, approvalPolicy: 'on-request', sandbox: native, approvalsReviewer: 'user' } : method === 'turn/start' ? { turn: { id: 'turn' } } : {}; };
  await adapter.send(session, 'first', []); session.profile = 'normal'; await adapter.send(session, 'second', []);
  const turns = calls.filter(c => c.method === 'turn/start');
  assert.equal(turns[0].params.approvalPolicy, 'never'); assert.equal(turns[0].params.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(turns[1].params.approvalPolicy, 'on-request'); assert.deepEqual(turns[1].params.sandboxPolicy, native);
});

test('provider notifications route by thread, and unknown requests fail closed', async () => {
  const deltas = [], writes = [];
  const adapter = new CodexAdapter({ delta: (...a) => deltas.push(a) });
  adapter.threads.set('remote-A', 'session-A'); adapter.threads.set('remote-B', 'session-B'); adapter.write = value => writes.push(value);
  await adapter.receive({ method: 'item/agentMessage/delta', params: { threadId: 'remote-B', itemId: 'm', delta: 'B only' } });
  await adapter.receive({ id: 1, method: 'danger', params: { threadId: 'unknown' } });
  assert.deepEqual(deltas, [['session-B', 'm', 'B only']]); assert.equal(writes[0].error.code, -32601);
});

test('concurrent approvals queue in order, stale answers fail, and cancellation denies pending requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-approval-'));
  const workspace = new Workspace(root, path.resolve('helpers'));
  try {
    const id = workspace.create({ engine: 'codex', name: 'Approval check', cwd: root });
    const s = workspace.store.get(id); s.status = 'working';
    const first = workspace.ask(id, { title: 'First tool', kind: 'approval' });
    const firstId = s.approval.id;
    const abort = new AbortController();
    const second = workspace.ask(id, { title: 'Second tool', kind: 'approval' }, abort.signal);
    assert.equal(s.approval.title, 'First tool');
    workspace.answer(id, { requestId: firstId, allow: true });
    assert.equal((await first).allow, true); assert.equal(s.approval.title, 'Second tool');
    assert.throws(() => workspace.answer(id, { requestId: firstId, allow: true }), /no longer waiting/);
    abort.abort(); assert.equal((await second).allow, false); assert.equal(s.status, 'working');
    const third = workspace.ask(id, { title: 'Third tool', kind: 'approval' });
    workspace.finish(id, null, true);
    assert.equal((await third).allow, false); assert.equal(s.approval, undefined); assert.equal(workspace.approvals.size, 0);
  } finally { await workspace.shutdown(); }
});

test('Codex can switch back to native model and effort without retaining an override', async () => {
  const calls = [], session = { id: 's', cwd: '/project', name: 'Model check', profile: 'normal', model: 'selected-model', effort: 'high' };
  const adapter = new CodexAdapter({ persist() {}, finish() {} });
  adapter.connect = async () => {};
  adapter.request = async (method, params) => {
    calls.push({ method, params });
    return method === 'thread/start' ? { thread: { id: 'remote' }, model: 'native-model', reasoningEffort: 'medium' } : method === 'turn/start' ? { turn: { id: 'turn' } } : {};
  };
  await adapter.send(session, 'first', []);
  session.model = ''; session.effort = ''; await adapter.send(session, 'second', []);
  const turns = calls.filter(c => c.method === 'turn/start');
  assert.equal(turns[0].params.model, 'selected-model'); assert.equal(turns[0].params.effort, 'high');
  assert.equal(turns[1].params.model, 'native-model'); assert.equal(turns[1].params.effort, 'medium');
});

test('annotations reach the agent; failed turns retain owned attachments for retry and successful turns clear them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-turn-'));
  const workspace = new Workspace(root, path.resolve('helpers'));
  try {
    const id = workspace.create({ engine: 'codex', name: 'Attachment check', cwd: root });
    const s = workspace.store.get(id), a = workspace.attachments.create(Buffer.from('image-test'), 'capture.png');
    a.comment = 'Please adjust the marked area.'; s.attachments.push(a);
    let prompt;
    workspace.codex.send = async (_s, text) => { prompt = text; };
    await workspace.send(id, 'Check this image', [a.id]);
    assert.match(prompt, /Please adjust the marked area/); assert.equal(s.attachments.length, 0);
    workspace.finish(id, 'Temporary connection error');
    assert.equal(s.attachments[0].id, a.id); assert.equal(fs.existsSync(a.path), true);
    await workspace.send(id, 'Try again', [a.id]); workspace.finish(id);
    assert.equal(s.attachments.length, 0); assert.equal(fs.existsSync(a.path), false);
    assert.equal(s.messages.filter(m => m.role === 'user').every(m => m.attachments[0].expired), true);
  } finally { await workspace.shutdown(); }
});
