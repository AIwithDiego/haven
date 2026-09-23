import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { ClaudeAdapter, CodexAdapter, claudeModels } from '../electron/agents.mjs';
import { Workspace } from '../electron/workspace.mjs';

// Actual supportedModels() response from installed Claude Code 2.1.280.
const models = [
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
];
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-models-')), w = new Workspace(root, path.resolve('helpers'));
  w.allowTestModels = true; w.runCapture = async () => 'test 1';
  for (const engine of ['claude', 'codex']) w[engine].models = async () => claudeModels(models);
  t.after(async () => { await w.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, w };
}
function mockSpawn(t, implementation) {
  t.mock.method(childProcess, 'spawn', implementation); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function child() {
  const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.exitCode = null;
  proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); proc.emit('close', 0); proc.stdout.end(); return true; };
  return proc;
}

test('Claude labels include real resolved versions and preserve aliases, context, and supported efforts', () => {
  const normalized = claudeModels(models);
  assert.deepEqual(normalized.map(m => m.label), ['Default (recommended) · Opus 5.5', 'Opus 5.5 (1M context)', 'Fable 5.1', 'Sonnet 5', 'Haiku 4.5']);
  assert.deepEqual(normalized.map(m => m.value), models.map(m => m.value));
  assert.deepEqual(normalized[2].efforts, models[2].supportedEffortLevels);
  assert.deepEqual(claudeModels([{ value: 'custom-model', displayName: 'My model' }]), [{ value: 'custom-model', label: 'My model', efforts: [] }]);
  assert.equal(claudeModels([{ value: 'claude-fable-5-1[1m]', displayName: 'Fable 5.1' }])[0].label, 'Fable 5.1');
});
test('Claude model refresh bypasses old task initialization without closing or sending to that task', async () => {
  const adapter = new ClaudeAdapter({}); let opened = 0, closed = 0;
  const existing = { query: { supportedModels() { assert.fail('The old task catalog is stale'); }, close() { assert.fail('Do not interrupt the task'); } } };
  adapter.clients.set('active', existing);
  adapter.discovery = () => { opened++; return { supportedModels: async () => models, close: () => closed++ }; };
  assert.equal((await adapter.models())[1].label, 'Opus 5.5 (1M context)');
  assert.equal((await adapter.models())[2].label, 'Fable 5.1');
  assert.equal(opened, 2); assert.equal(closed, 2); assert.equal(adapter.clients.get('active'), existing);
  adapter.discovery = () => ({ supportedModels: async () => { throw new Error('offline'); }, close: () => closed++ });
  await assert.rejects(adapter.models(), /offline/); assert.equal(closed, 3); assert.equal(adapter.modelDiscoveries.size, 0);
});
test('sending on an old Claude task cannot overwrite a refreshed catalog', async () => {
  let sent = 0;
  const adapter = new ClaudeAdapter({ models() { assert.fail('Do not republish task-cached models'); } });
  const session = { id: 'old-task', model: '', effort: '', profile: 'normal' };
  adapter.clients.set(session.id, { ...session, input: { push() { sent++; } }, query: { supportedModels() { assert.fail('Old task model catalog must not be read'); } } });
  await adapter.send(session, 'Continue', []); assert.equal(sent, 1);
});
test('an externally updated Claude keeps its current turn and resumes through the new CLI on the next turn', async () => {
  const adapter = new ClaudeAdapter({}); let closed = 0, opened = 0, sent = 0;
  const session = { id: 'task', remoteId: 'same-conversation', hasConversation: true, model: 'opus[1m]', profile: 'normal', effort: '' };
  adapter.clients.set(session.id, { ...session, input: { end() {} }, query: { close() { closed++; } } });
  adapter.markUpdated(); assert.equal(closed, 0);
  adapter.open = async resumed => {
    assert.equal(resumed.remoteId, 'same-conversation'); assert.equal(resumed.hasConversation, true); opened++;
    return { ...session, input: { push() { sent++; } } };
  };
  await adapter.send(session, 'Continue', []); assert.equal(closed, 1); assert.equal(opened, 1); assert.equal(sent, 1);
});
test('Codex discovers models with a fresh process and leaves the task transport connected', async t => {
  let launches = 0;
  mockSpawn(t, () => {
    launches++; const proc = child();
    proc.stdin = new Writable({ write(chunk, _encoding, done) {
      const request = JSON.parse(chunk);
      if (request.id) queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: request.id, result: request.method === 'model/list' ? { data: [{ model: 'new-model', displayName: 'New model' }] } : {} }) + '\n'));
      done();
    } }); return proc;
  });
  const adapter = new CodexAdapter({ log() {}, disconnected() { assert.fail('The task transport must remain connected'); } });
  adapter.ready = Promise.resolve(); adapter.threads.set('thread', 'active');
  const ready = adapter.ready;
  assert.deepEqual(await adapter.models({ fresh: true }), [{ value: 'new-model', label: 'New model', efforts: [], defaultEffort: undefined }]);
  assert.equal(launches, 1); assert.equal(adapter.ready, ready); assert.equal(adapter.threads.get('thread'), 'active'); assert.equal(adapter.discoveries.size, 0);
});
test('external agent updates refresh models without disconnecting tasks, and unchanged versions skip discovery', async t => {
  const { root, w } = setup(t); let version = 'old', reads = 0;
  const id = w.create({ name: 'Active work', engine: 'claude', cwd: root }); w.store.get(id).status = 'working';
  w.runCapture = async () => version;
  w.claude.models = async options => { assert.equal(options.fresh, true); reads++; return claudeModels(models); };
  w.claude.close = () => assert.fail('Refreshing model options must not close active work');
  t.after(() => { w.claude.close = async () => {}; });
  await w.refreshAgent('claude'); assert.equal(reads, 1);
  await w.refreshAgent('claude', { onlyChanged: true }); assert.equal(reads, 1);
  version = 'updated'; await w.refreshAgent('claude', { onlyChanged: true }); assert.equal(reads, 2);
  assert.equal(w.diagnostics.claude.version, 'updated'); assert.equal(w.modelLists.claude[2].label, 'Fable 5.1'); assert.equal(w.store.get(id).status, 'working');
  await w.refreshAgent('claude'); assert.equal(reads, 3, 'Manual refresh also discovers account catalog changes');
});
test('concurrent model refreshes coalesce and failed discovery preserves the last catalog with a visible error', async t => {
  const { w } = setup(t); let resolve, reads = 0;
  w.claude.models = async () => { reads++; return new Promise(r => { resolve = r; }); };
  const first = w.refreshAgent('claude'), second = w.refreshAgent('claude'); await tick();
  assert.equal(reads, 1); resolve(claudeModels(models)); await Promise.all([first, second]);
  const previous = w.modelLists.claude; w.claude.models = async () => { throw new Error('Disconnected'); };
  await w.refreshAgent('claude'); assert.equal(w.modelLists.claude, previous); assert.match(w.diagnostics.claude.error, /Could not refresh models/); assert.equal(w.diagnostics.claude.connected, undefined);
});
test('updating awaits transport cleanup and refreshes models before unblocking new work', async t => {
  const { w } = setup(t), proc = child(); let releaseClose, resolveModels, launches = 0, reads = 0;
  mockSpawn(t, (_binary, args) => { assert.deepEqual(args, ['update']); launches++; return proc; });
  w.claude.close = () => new Promise(r => { releaseClose = r; });
  w.claude.models = async () => { reads++; return new Promise(r => { resolveModels = r; }); };
  const update = w.update('claude'); await tick();
  assert.equal(w.updates.claude.running, true); assert.equal(launches, 0);
  await w.refreshAgent('claude'); assert.equal(reads, 0, 'Manual refresh must not race the updater');
  releaseClose(); await update; assert.equal(launches, 1);
  w.claude.close = async () => {};
  proc.emit('exit', 0); await tick(); assert.equal(reads, 0, 'Wait for updater output to close');
  proc.emit('close', 0); await tick(); assert.equal(reads, 1); assert.equal(w.updates.claude.running, true);
  resolveModels(claudeModels(models)); await tick();
  assert.equal(w.updates.claude.running, false); assert.equal(w.updates.claude.success, true); assert.match(w.updates.claude.output, /Model list refreshed/); assert.equal(w.modelLists.claude[1].label, 'Opus 5.5 (1M context)');
});
test('failed updater spawn clears its busy state and leaves a useful failure plus refreshed models', async t => {
  const { w } = setup(t), proc = child();
  mockSpawn(t, () => proc); w.claude.close = async () => {};
  await w.update('claude'); proc.emit('error', new Error('Updater unavailable')); proc.emit('close', -2); await tick();
  assert.equal(w.updates.claude.running, false); assert.equal(w.updates.claude.success, false); assert.match(w.updates.claude.output, /Updater unavailable/); assert.match(w.updates.claude.output, /Model list refreshed/);
});
test('an updater waits for an older in-flight refresh so its stale catalog cannot replace the new result', async t => {
  const { w } = setup(t), proc = child(); let resolveOld, reads = 0, closes = 0, launches = 0;
  mockSpawn(t, () => { launches++; return proc; }); w.claude.close = async () => { closes++; };
  w.claude.models = async () => ++reads === 1 ? new Promise(r => { resolveOld = r; }) : claudeModels(models);
  const oldRefresh = w.refreshAgent('claude'); await tick();
  const update = w.update('claude'); await tick(); assert.equal(closes, 0); assert.equal(launches, 0);
  resolveOld([{ value: 'opus', label: 'Old Opus', efforts: [] }]); await oldRefresh; await update;
  assert.equal(closes, 1); assert.equal(launches, 1); proc.emit('close', 0); await tick();
  assert.equal(w.modelLists.claude[1].label, 'Opus 5.5 (1M context)'); assert.equal(w.updates.claude.running, false);
});
test('isolated preview refreshes never launch real model discovery', async t => {
  const { w } = setup(t), previous = process.env.HAVEN_TEST_MODE;
  process.env.HAVEN_TEST_MODE = '1'; w.allowTestModels = false;
  t.after(() => { if (previous === undefined) delete process.env.HAVEN_TEST_MODE; else process.env.HAVEN_TEST_MODE = previous; });
  w.runCapture = () => assert.fail('Do not start a real CLI from an isolated preview');
  await w.refreshAgent('claude'); await w.checkAgentUpdates();
});
