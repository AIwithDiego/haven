import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Store, startClock } from '../electron/core.mjs';
import { Workspace } from '../electron/workspace.mjs';
import { ClaudeAdapter, CodexAdapter, agentEnv } from '../electron/agents.mjs';
import { parseCommand, mergeCommands } from '../electron/commands.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-lifecycle-')), w = new Workspace(root, path.resolve('helpers'));
  t.after(async () => { for (const watcher of w.watchers.values()) { try { await watcher.close(); } catch {} } w.watchers.clear(); await w.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = w.create({ name: 'Test task', engine: 'claude', cwd: root });
  return { root, w, id, s: w.store.get(id) };
}
test('foreign attachments cannot interrupt deletion of a task and its owned copies', t => {
  const { root, w, id, s } = setup(t), file = path.join(root, 'original.txt'); fs.writeFileSync(file, 'Keep');
  const owned = w.attachments.create(Buffer.from('Copy'), 'copy.txt', 'text/plain');
  s.attachments.push({ ...owned, path: file }, owned);
  assert.doesNotThrow(() => w.remove(id)); assert.equal(fs.existsSync(owned.path), false); assert.equal(fs.readFileSync(file, 'utf8'), 'Keep');
  assert.throws(() => new Store(root).get(id), /not found/);
});
test('a failed delete save retains the task and attachment for a retry', t => {
  const { w, id, s } = setup(t), owned = w.attachments.create(Buffer.from('Keep until committed'), 'copy.txt', 'text/plain');
  s.attachments.push(owned); w.store.save();
  const save = t.mock.method(w.store, 'save', () => { w.store.storage.saveError = 'Disk full'; return false; });
  assert.throws(() => w.remove(id), /Disk full/);
  assert.equal(w.store.get(id), s); assert.equal(fs.existsSync(owned.path), true);
  save.mock.restore(); w.remove(id); assert.equal(fs.existsSync(owned.path), false);
});
test('escaped slashes remain literal content blocks and the transcript reflects the sent text', async t => {
  const { w, id, s } = setup(t); let input;
  const adapter = new ClaudeAdapter({ models() {} });
  adapter.clients.set(id, { profile: s.profile, model: s.model, effort: s.effort, input: { push(value) { input = value; } }, query: { supportedModels: async () => [] } });
  w.claude.send = (...args) => adapter.send(...args);
  await w.send(id, '//status');
  assert.deepEqual(input.message.content, [{ type: 'text', text: '/status' }]); assert.equal(s.messages.find(m => m.role === 'user').text, '/status'); w.finish(id);
});
test('failed turns restore the submitted draft without replacing newer typing or restoring cancelled work', async t => {
  const { w, id, s } = setup(t); w.claude.send = async () => {};
  await w.send(id, 'First draft'); w.finish(id, 'Connection failed'); assert.equal(s.draft, 'First draft');
  await w.send(id, 'Second draft'); w.store.patch(id, { draft: 'A newer thought' }); w.finish(id, 'Connection failed'); assert.equal(s.draft, 'A newer thought');
  await w.send(id, 'Cancelled draft'); w.finish(id, null, true); assert.equal(s.draft, '');
});
test('model commands and renderer patches accept only available model IDs', async t => {
  const { w, id, s } = setup(t);
  await assert.rejects(w.send(id, '/model made-up\nunsafe'), /model/i); assert.equal(s.model, '');
  await assert.rejects(w.send(id, '/model definitely-unknown'), /model/i);
  assert.throws(() => w.patch(id, { model: 'unknown' }), /model/i);
  await w.send(id, '/model Sonnet'); assert.equal(s.model, 'sonnet');
});
test('suspending excludes sleep and resuming does not restart a finished or waiting clock', t => {
  const { w, id, s, root } = setup(t);
  const second = w.store.create({ name: 'Finishes while asleep', engine: 'codex', cwd: root });
  s.status = second.status = 'working'; startClock(s, 1000); startClock(second, 1000);
  w.suspend(4000); assert.equal(s.runningMs, 3000); assert.equal(s.runningSince, null);
  second.status = 'idle'; w.resume(100000); assert.equal(s.runningSince, 100000); assert.equal(second.runningSince, null);
  w.suspend(102000); s.status = 'waiting'; w.resume(200000); assert.equal(s.runningMs, 5000); assert.equal(s.runningSince, null); w.finish(id);
});
test('a rejected Codex initialize can be retried without reusing a dead promise', async t => {
  let launches = 0;
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(), attempt = ++launches; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) { const message = JSON.parse(chunk); if (message.id) queueMicrotask(() => child.stdout.write(JSON.stringify(attempt === 1 ? { id: message.id, error: { message: 'Handshake rejected' } } : { id: message.id, result: {} }) + '\n')); done(); } });
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); child.stdout.end(); return true; }; return child;
  }); syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const adapter = new CodexAdapter({ log() {}, disconnected() {} }); t.after(() => adapter.close());
  await assert.rejects(adapter.connect(), /Handshake rejected/); await adapter.connect(); assert.equal(launches, 2);
});
test('shutdown saves before cleanup and continues after one watcher throws', async t => {
  const { w } = setup(t), events = [];
  w.store.save = () => { events.push('save'); return true; };
  w.claude.close = () => { events.push('claude'); };
  w.watchers.set('one', { close: async () => { events.push('first'); throw new Error('Watcher failure'); } });
  w.watchers.set('two', { close: async () => { events.push('second'); } });
  await assert.doesNotReject(w.shutdown()); assert.equal(events[0], 'save'); assert.ok(events.includes('second'));
});
test('shutdown escalates only its own unresponsive child after the timeout', async () => {
  const { stopProcess } = await import('../electron/processes.mjs');
  const proc = new EventEmitter(), signals = []; proc.exitCode = null;
  proc.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') { proc.exitCode = 0; proc.emit('exit', 0); } return true; };
  await stopProcess(proc, undefined, 10); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});
test('watcher failures are visible in the workspace', t => {
  const { w, root } = setup(t); w.create({ name: 'Shared project', engine: 'codex', cwd: root });
  const watcher = [...w.watchers.values()][0]; watcher.emit('error', new Error('Watch limit reached'));
  assert.match(w.snapshot().storage.notices.join(' '), /Watch limit reached/);
  // Keep cleanup ownership; the fixture normally skips mocked watcher failures.
  t.after(() => watcher.close());
});
test('names are trimmed, Unicode commands parse, colliding skill aliases remain unique', t => {
  const { w, id, s } = setup(t); w.store.patch(id, { name: '  Clean name  ' }); assert.equal(s.name, 'Clean name');
  assert.deepEqual(parseCommand('/réviser maintenant'), { name: 'réviser', args: 'maintenant' });
  const merged = mergeCommands([{ name: 'pin' }, { name: 'skill:pin' }]); assert.equal(new Set(merged.map(c => c.name)).size, merged.length);
});
test('elevated tasks reject the filesystem root and child environments omit unrelated secrets', t => {
  const { w } = setup(t);
  assert.throws(() => w.store.create({ name: 'Root bypass', engine: 'codex', cwd: '/', profile: 'autonomous' }), /filesystem root/);
  const old = process.env.HAVEN_UNRELATED_SECRET; process.env.HAVEN_UNRELATED_SECRET = 'not-for-child';
  try { assert.equal(agentEnv().HAVEN_UNRELATED_SECRET, undefined); assert.ok(agentEnv().PATH); assert.equal(agentEnv().HOME, os.homedir()); }
  finally { if (old === undefined) delete process.env.HAVEN_UNRELATED_SECRET; else process.env.HAVEN_UNRELATED_SECRET = old; }
});
