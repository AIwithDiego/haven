import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { codexContextUsage, claudeContextUsage, codexProviderUsage, claudeProviderUsage, normalizeStoredContext } from '../electron/usage.mjs';
import { CodexAdapter, ClaudeAdapter } from '../electron/agents.mjs';
import { Workspace } from '../electron/workspace.mjs';
import { Store } from '../electron/core.mjs';

const at = 1800000000000;
const codex = (used = 25) => ({ rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1800003600 }, secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1800100000 } } });
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-usage-')), w = new Workspace(root, path.resolve('helpers'));
  w.allowTestUsage = true; // Only mocked readers below may run in the isolated test mode.
  t.after(async () => { await w.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, w };
}

test('Codex context uses the latest request including completion, never cumulative totals', () => {
  const value = { total: { totalTokens: 1800000 }, last: { totalTokens: 48000 }, modelContextWindow: 192000 };
  assert.equal(codexContextUsage(value, at).usedPercent, 25);
  assert.equal(codexContextUsage({ ...value, last: { totalTokens: 24000 } }, at + 1).usedPercent, 12.5, 'compaction may lower current usage');
  assert.equal(codexContextUsage({ ...value, modelContextWindow: null }, at), undefined);
  assert.equal(codexContextUsage({ total: { totalTokens: 120 }, modelContextWindow: 1000 }, at), undefined);
});
test('Claude context uses the reported raw compaction window and labels estimates', () => {
  const usage = claudeContextUsage({ totalTokens: 220000, maxTokens: 180000, rawMaxTokens: 200000, percentage: 100, model: 'claude-test' }, at);
  assert.equal(usage.usedTokens, 220000); assert.equal(usage.contextWindow, 200000); assert.equal(usage.usedPercent, 110.00000000000001); assert.equal(usage.estimated, true);
  assert.equal(claudeContextUsage({ total_tokens: 50000, raw_max_tokens: 200000 }, at).usedPercent, 25);
  assert.equal(claudeContextUsage({ usage: { input_tokens: 5 }, modelUsage: { test: { inputTokens: 1000, contextWindow: 200000 } } }, at), undefined);
  for (const value of [undefined, {}, { ...usage, usedTokens: NaN }, { ...usage, contextWindow: 0 }, { ...usage, updatedAt: 'today' }]) assert.equal(normalizeStoredContext(value), undefined);
  assert.equal(normalizeStoredContext({ ...usage, usedPercent: 9999 }).usedPercent, usage.usedPercent);
});
test('Codex full reads and sparse global events retain real windows and reset units', () => {
  const initial = codexProviderUsage(codex(), at);
  assert.equal(initial.windows[0].label, '5-hour'); assert.equal(initial.windows[0].resetsAt, 1800003600000); assert.equal(initial.windows[1].label, '7-day');
  const next = codexProviderUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 35, windowDurationMins: null, resetsAt: null }, secondary: null, planType: null } }, at + 1, initial);
  assert.equal(next.windows[0].usedPercent, 35); assert.equal(next.windows[0].label, initial.windows[0].label); assert.equal(next.windows[0].resetsAt, initial.windows[0].resetsAt); assert.deepEqual(next.windows[1], initial.windows[1]); assert.equal(next.plan, 'plus');
  const multi = codexProviderUsage({ ...codex(), rateLimitsByLimitId: { codex: codex().rateLimits, model: { limitName: 'Fast model', primary: { usedPercent: 70, windowDurationMins: 300 } } } }, at);
  assert.equal(multi.windows.length, 3); assert.match(multi.windows[2].label, /^Fast model/);
  assert.equal(codexProviderUsage({ rateLimits: null }, at).status, 'unavailable');
  assert.equal(codexProviderUsage({ rateLimits: { primary: { usedPercent: null } } }, at).windows[0].usedPercent, undefined);
  assert.match(codexProviderUsage({ ...codex(1), ordinaryUsageAllowed: false }, at).message, /unavailable/);
});
test('Claude account percentages preserve unknown and zero, with no invented limits', () => {
  const value = claudeProviderUsage({ rate_limits_available: true, subscription_type: 'max', rate_limits: { five_hour: { utilization: 0, resets_at: '2027-01-15T09:00:00.000Z' }, seven_day: { utilization: null, resets_at: null }, seven_day_opus: { utilization: 48 } } }, at);
  assert.equal(value.windows[0].usedPercent, 0); assert.equal(value.windows[0].resetsAt, Date.parse('2027-01-15T09:00:00Z')); assert.equal(value.windows[1].usedPercent, undefined); assert.equal(value.windows[2].usedPercent, 48);
  assert.equal(claudeProviderUsage({ rate_limits_available: false, rate_limits: null }, at).status, 'unavailable');
  assert.equal(claudeProviderUsage({}, at).windows.length, 0);
});
test('Codex routes account updates without a thread and never uses child context for its parent', async () => {
  const account = [], contexts = [], adapter = new CodexAdapter({ usage: (...args) => account.push(args), context: (...args) => contexts.push(args) });
  adapter.threads.set('main', 'task'); adapter.childOwners.set('child', 'task');
  await adapter.receive({ method: 'account/rateLimits/updated', params: codex() });
  assert.equal(account.length, 1); assert.equal(account[0][0], 'codex'); assert.equal(account[0][2], true);
  for (const threadId of ['child', 'main']) await adapter.receive({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { last: { totalTokens: 20000 }, total: { totalTokens: 900000 }, modelContextWindow: 200000 } } });
  assert.equal(contexts.length, 1); assert.equal(contexts[0][0], 'task'); assert.equal(contexts[0][1].usedTokens, 20000);
  const calls = []; adapter.connect = async () => {}; adapter.request = async (...args) => { calls.push(args); return codex(); };
  assert.equal((await adapter.usage()).status, 'available'); assert.equal(calls[0][0], 'account/rateLimits/read'); assert.deepEqual(calls[0][1], {});
});
test('Claude uses control requests without model turns or unrelated transcript scans', async () => {
  let closed = 0, reads = 0;
  const adapter = new ClaudeAdapter({}); adapter.discovery = () => ({ async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) { assert.deepEqual(options, { skipBehaviors: true }); reads++; await tick(); return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 30 } } }; }, close() { closed++; } });
  const result = await Promise.all([adapter.usage(), adapter.usage()]);
  assert.equal(reads, 1); assert.equal(closed, 1); assert.equal(result[0].windows[0].usedPercent, 30);
});
test('Claude late context responses from replaced clients cannot overwrite the task', async () => {
  let resolve; const contexts = [], session = { id: 'task' };
  const adapter = new ClaudeAdapter({ context: (...args) => contexts.push(args) });
  const old = { query: { getContextUsage(options) { assert.deepEqual(options, { detail: 'summary' }); return new Promise(r => { resolve = r; }); } } };
  adapter.clients.set(session.id, old); const pending = adapter.refreshContext(session, old, true); await tick();
  adapter.clients.set(session.id, { query: {} }); resolve({ totalTokens: 100000, rawMaxTokens: 200000 }); await pending;
  assert.equal(contexts.length, 0);
});
test('Claude events refresh account reads and parent context only, ignoring billing totals', async () => {
  const contexts = [], accounts = [], session = { id: 'task' };
  const adapter = new ClaudeAdapter({ context: (_id, usage) => contexts.push(usage), refreshUsage: engine => accounts.push(engine), persist() {}, disconnected() {}, finish() {}, completeText() {} });
  const client = { query: (async function* () {
    yield { type: 'rate_limit_event', rate_limit_info: { utilization: 0.7, status: 'allowed_warning' } };
    yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'main', content: [] }, context_usage: { total_tokens: 20000, raw_max_tokens: 200000 } };
    yield { type: 'assistant', parent_tool_use_id: 'child-tool', message: { id: 'child', content: [] }, context_usage: { total_tokens: 100000, raw_max_tokens: 200000 } };
    yield { type: 'result', is_error: false, usage: { input_tokens: 9999999 }, modelUsage: { test: { inputTokens: 9999999, contextWindow: 200000 } } };
  })() };
  adapter.clients.set(session.id, client); await adapter.consume(session, client);
  assert.deepEqual(accounts, ['claude']); assert.equal(contexts.length, 1); assert.equal(contexts[0].usedTokens, 20000);
});
test('Claude context refresh coalesces streams but repeats after a completed turn', async () => {
  let resolve, reads = 0; const contexts = [], session = { id: 'task' };
  const adapter = new ClaudeAdapter({ context: (_id, value) => contexts.push(value) });
  const client = { query: { getContextUsage: async () => { if (++reads === 1) return new Promise(r => { resolve = r; }); return { totalTokens: 20000, rawMaxTokens: 200000 }; } } };
  adapter.clients.set(session.id, client);
  const pending = adapter.refreshContext(session, client, true); await tick();
  void adapter.refreshContext(session, client); void adapter.refreshContext(session, client, true);
  resolve({ totalTokens: 100000, rawMaxTokens: 200000 }); await pending;
  assert.equal(reads, 2); assert.equal(contexts.at(-1).usedTokens, 20000);
});
test('workspace usage refresh deduplicates, retains dated data on failure, and stops at shutdown', async t => {
  const { w } = setup(t); let reads = 0, resolve;
  w.codex.usage = async () => { reads++; return new Promise(r => { resolve = r; }); };
  const first = w.refreshUsage('codex'), second = w.refreshUsage('codex'); await tick();
  assert.equal(reads, 1); assert.equal(w.snapshot().providerUsage.codex.status, 'loading');
  resolve(codexProviderUsage(codex(), at)); await Promise.all([first, second]);
  w.codex.usage = async () => { throw new Error('sensitive provider error'); }; await w.refreshUsage('codex');
  assert.equal(w.providerUsage.codex.status, 'error'); assert.equal(w.providerUsage.codex.updatedAt, at); assert.equal(w.providerUsage.codex.windows[0].usedPercent, 25); assert.doesNotMatch(w.providerUsage.codex.message, /sensitive/);
  await assert.rejects(w.refreshUsage('terminal'), /Unknown agent/);
  await w.shutdown(); await w.refreshUsage('codex'); assert.equal(reads, 1);
});
test('initial diagnostics refresh reads both providers and installs a cleanup-owned refresh timer', async t => {
  const { w } = setup(t); const reads = [];
  w.runCapture = async () => 'test';
  for (const engine of ['claude', 'codex']) { w[engine].models = async () => []; w[engine].usage = async () => { reads.push(engine); return { status: 'unavailable', windows: [] }; }; }
  await w.refresh(); assert.deepEqual(reads.sort(), ['claude', 'codex']); assert.ok(w.usageTimer);
  const timer = w.usageTimer; await w.shutdown(); assert.equal(timer._destroyed, true);
});
test('later account events win over an earlier in-flight read and event bursts are coalesced', async t => {
  const { w } = setup(t); let resolve, reads = 0;
  w.codex.usage = async () => { reads++; return new Promise(r => { resolve = r; }); };
  const pending = w.refreshUsage('codex'); await tick();
  await w.codex.receive({ method: 'account/rateLimits/updated', params: codex(80) });
  resolve(codexProviderUsage(codex(20), at)); await pending;
  assert.equal(w.providerUsage.codex.windows[0].usedPercent, 80);
  for (let i = 0; i < 20; i++) w.scheduleUsageRefresh('codex');
  assert.equal(w.usageEventTimers.size, 1); assert.equal(reads, 1);
  const timer = w.usageEventTimers.get('codex'); await w.shutdown(); assert.equal(timer._destroyed, true);
});
test('a failed earlier read cannot mark a newer account event unavailable', async t => {
  const { w } = setup(t); let reject;
  w.codex.usage = async () => new Promise((_resolve, r) => { reject = r; });
  const pending = w.refreshUsage('codex'); await tick();
  await w.codex.receive({ method: 'account/rateLimits/updated', params: codex(42) });
  const updatedAt = w.providerUsage.codex.updatedAt; reject(new Error('late transport failure')); await pending;
  assert.equal(w.providerUsage.codex.status, 'available'); assert.equal(w.providerUsage.codex.updatedAt, updatedAt); assert.equal(w.providerUsage.codex.windows[0].usedPercent, 42);
});
test('isolated previews cannot launch usage readers via refresh IPC', async t => {
  const { w } = setup(t), old = process.env.HAVEN_TEST_MODE; process.env.HAVEN_TEST_MODE = '1'; w.allowTestUsage = false;
  t.after(() => { if (old === undefined) delete process.env.HAVEN_TEST_MODE; else process.env.HAVEN_TEST_MODE = old; });
  w.codex.usage = async () => { assert.fail('Must not read a live account'); };
  await w.refreshUsage('codex'); assert.equal(w.providerUsage.codex.status, 'unavailable');
});
test('current context survives isolated restart with validated fields; account snapshots do not', async t => {
  const { w, root } = setup(t), session = w.store.create({ name: 'Usage persistence', engine: 'codex', cwd: root });
  w.codex.threads.set('thread', session.id);
  await w.codex.receive({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', tokenUsage: { last: { totalTokens: 80000 }, total: { totalTokens: 900000 }, modelContextWindow: 200000 } } });
  w.providerUsage.codex = codexProviderUsage(codex(), at); w.store.save();
  const restored = new Store(root); assert.equal(restored.get(session.id).contextUsage.usedTokens, 80000); assert.equal(restored.get(session.id).contextUsage.usedPercent, 40); assert.equal(restored.state.providerUsage, undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8')); raw.sessions[0].contextUsage.usedTokens = 'bad'; fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify(raw));
  assert.equal(new Store(root).get(session.id).contextUsage, undefined);
});
