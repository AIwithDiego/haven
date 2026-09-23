import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { Workspace } from '../electron/workspace.mjs';
import { ClaudeAdapter, CodexAdapter } from '../electron/agents.mjs';

function setup(t, engine = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-followups-')), w = new Workspace(root, path.resolve('helpers'));
  const id = w.create({ name: 'Follow-ups', engine, cwd: root }), s = w.store.get(id), sent = [];
  w[engine].send = async (...args) => { sent.push(args); };
  w[engine].steer = async () => false;
  t.after(async () => { await w.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { w, root, id, s, sent };
}
test('follow-ups queue in order and start automatically after each completed turn, retaining a newer draft', async t => {
  const { w, id, s, sent } = setup(t);
  await w.send(id, 'First'); await w.send(id, 'Second'); await w.send(id, 'Third', [], 'queue'); await tick();
  assert.equal(sent.length, 1); assert.equal(s.pendingMessages.length, 2);
  s.draft = 'Still typing'; w.finish(id); await tick();
  assert.equal(sent.length, 2); assert.equal(sent[1][1], 'Second'); assert.equal(s.draft, 'Still typing');
  w.finish(id); await tick(); assert.equal(sent.length, 3); assert.equal(sent[2][1], 'Third');
  assert.equal(s.messages.filter(m => m.role === 'user').length, 3);
  w.finish(id);
});
test('accepted steering preserves running permissions and attachments through a completion race', async t => {
  const { w, id, s } = setup(t); let accept;
  await w.send(id, 'Initial'); await tick(); const settings = s.turnSettings;
  const attachment = w.attachments.create(Buffer.from('keep until finished'), 'note.txt', 'text/plain'); s.attachments.push(attachment);
  w.codex.steer = async () => new Promise(resolve => { accept = resolve; });
  await w.send(id, 'Follow-up', [attachment.id]); await tick();
  w.finish(id); assert.equal(s.status, 'working'); assert.ok(fs.existsSync(attachment.path));
  accept(true); await tick();
  assert.equal(s.pendingMessages.length, 0); assert.equal(s.status, 'idle'); assert.equal(fs.existsSync(attachment.path), false);
  assert.equal(s.messages.filter(m => m.role === 'user').at(-1).delivery, 'sent-during-run');
  assert.equal(settings.profile, 'normal');
});
test('uncertain delivery pauses for review and never duplicates the input automatically', async t => {
  const { w, id, s, sent } = setup(t);
  await w.send(id, 'Initial'); await tick();
  w.codex.steer = async () => { throw new Error('Timeout after sending'); };
  await w.send(id, 'Possibly accepted'); await tick(); w.finish(id); await tick();
  assert.equal(sent.length, 1); assert.equal(s.pendingMessages[0].paused, true); assert.equal(s.messages.at(-1).delivery, 'unconfirmed');
});
test('stopping pauses queued work; withdrawing restores text and attachments without deleting originals', async t => {
  const { w, id, s, sent } = setup(t);
  w.codex.stop = async () => w.finish(id, null, true);
  await w.send(id, 'Initial'); const a = w.attachments.create(Buffer.from('csv'), 'data.csv', 'text/csv'); s.attachments.push(a);
  await w.send(id, 'Queued', [a.id], 'queue'); await w.stop(id); await tick();
  assert.equal(sent.length, 1); assert.equal(s.pendingMessages[0].paused, true); assert.ok(fs.existsSync(a.path));
  s.draft = 'New draft'; await w.queuedMessage(id, s.pendingMessages[0].id, 'withdraw');
  assert.equal(s.draft, 'New draft\n\nQueued'); assert.equal(s.attachments[0].id, a.id); assert.ok(fs.existsSync(a.path));
});
test('restart preserves queued attachment bytes and pauses rather than silently replaying', async t => {
  const { w, id, s, root } = setup(t);
  await w.send(id, 'Initial'); const a = w.attachments.create(Buffer.from('kept bytes'), 'file.txt', 'text/plain'); s.attachments.push(a);
  await w.send(id, 'On restart', [a.id], 'queue'); await w.shutdown();
  const resumed = new Workspace(root, path.resolve('helpers')); t.after(() => resumed.shutdown());
  const restored = resumed.store.get(id); assert.equal(restored.pendingMessages[0].paused, true); assert.equal(restored.messages.at(-1).delivery, 'paused');
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'kept bytes'); assert.notEqual(restored.messages.at(-1).attachments[0].expired, true);
});
test('approval waits retain their gate while follow-ups queue', async t => {
  const { w, id, s } = setup(t); let steered = 0;
  await w.send(id, 'Initial'); await tick(); w.codex.steer = async () => { steered++; return true; };
  const answer = w.ask(id, { title: 'Allow?', kind: 'approval' });
  await w.send(id, 'Extra instruction'); await tick();
  assert.equal(s.status, 'waiting'); assert.equal(steered, 0); assert.ok(s.approval);
  w.answer(id, { requestId: s.approval.id, allow: true }); await answer; await tick();
  assert.equal(steered, 1); assert.equal(s.status, 'working'); w.finish(id);
});
test('Codex steering uses the active turn guard and only retries explicit rejections', async () => {
  const a = new CodexAdapter({}), s = { remoteId: 'thread', turnId: 'turn', id: 'local' }; a.threads.set('thread', 'local');
  a.request = async (method, params) => { assert.equal(method, 'turn/steer'); assert.equal(params.expectedTurnId, 'turn'); assert.equal(params.input[0].text, 'Change'); };
  assert.equal(await a.steer(s, 'Change', []), true);
  a.request = async () => { throw new Error('No active turn'); }; assert.equal(await a.steer(s, 'Change', []), false);
  a.request = async () => { throw new Error('Timeout'); }; await assert.rejects(a.steer(s, 'Change', []), /could not be confirmed/);
});
test('Claude keeps working across native queued turns and a result cannot retire a later unconsumed UUID', async () => {
  let finishes = 0, afterFirst;
  const adapter = new ClaudeAdapter({ persist() {}, finish() { finishes++; }, disconnected() {} });
  const session = { id: 's' }, client = { pendingInputs: new Set(['one', 'two']), query: (async function* () {
    yield { type: 'result', user_message_uuids: ['one'], user_message_uuid: 'one', queued_turn_count: 0 };
    afterFirst = finishes;
    yield { type: 'result', user_message_uuids: ['two'], user_message_uuid: 'two', queued_turn_count: 0 };
  })() };
  adapter.clients.set('s', client); await adapter.consume(session, client);
  assert.equal(afterFirst, 0); assert.equal(finishes, 1); assert.equal(client.pendingInputs.size, 0);
});
test('/mcp is local even while working and never sends a model prompt', async t => {
  const { w, id, sent } = setup(t); await w.send(id, 'Initial');
  assert.equal((await w.send(id, '/mcp')).effect, 'connections'); assert.equal(sent.length, 1); w.finish(id);
});
test('Stop before the steering microtask runs never forwards a queued follow-up', async t => {
  const {w,id,s}=setup(t); let steers=0;
  await w.send(id,'Initial'); await tick();
  w.codex.steer=async()=>{steers++;return true;}; w.codex.stop=async()=>w.finish(id,null,true);
  const sending=w.send(id,'Do not deliver after stop'); const stopping=w.stop(id);
  await Promise.all([sending,stopping]); await tick();
  assert.equal(steers,0); assert.equal(s.pendingMessages[0].paused,true); assert.equal(s.status,'interrupted');
});
