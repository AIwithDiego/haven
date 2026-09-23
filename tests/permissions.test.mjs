import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeProfileOptions } from '../electron/permissions.mjs';
import { Workspace } from '../electron/workspace.mjs';
import { CodexAdapter } from '../electron/agents.mjs';

test('a permission change during connection applies only to the next turn', async () => {
  const calls = [], session = { id: 'task', cwd: '/project', profile: 'autonomous', model: '', effort: '' };
  let connected;
  const adapter = new CodexAdapter({ persist() {}, finish() {} });
  adapter.connect = () => new Promise(resolve => { connected = resolve; });
  adapter.request = async (method, params) => { calls.push({ method, params }); return method === 'thread/start' ? { thread: { id: 'remote' }, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } } : method === 'turn/start' ? { turn: { id: 'turn' } } : {}; };
  const pending = adapter.send(session, 'Work', []); session.profile = 'normal'; connected(); await pending;
  assert.equal(calls.find(c => c.method === 'turn/start').params.approvalPolicy, 'never');
});

test('The gated profile exposes only the chosen project and gates MCP calls before execution', async () => {
  const servers = { one: { type: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=one' }, two: { type: 'http', url: 'https://mcp.supabase.com/mcp?project_ref=two' } };
  let answer, calls = 0;
  const host = { ask: async () => { calls++; return { allow: answer }; } };
  const session = { id: 'task', cwd: '/project', profile: 'gated', gatedServer: 'one' };
  const options = claudeProfileOptions(session, host, servers);
  assert.equal(options.permissionMode, 'default'); assert.notEqual(options.allowDangerouslySkipPermissions, true);
  assert.deepEqual(Object.keys(options.mcpServers), ['one']); assert.equal(options.strictMcpConfig, true);
  assert.ok(!options.settingSources.includes('project') && !options.settingSources.includes('local'));
  const gate = options.hooks.PreToolUse[0].hooks[0];
  assert.ok(new RegExp(options.hooks.PreToolUse[0].matcher).test('Bash'));
  answer = false;
  assert.equal((await gate({ tool_name: 'mcp__one__execute_sql', tool_input: { query: 'select 1' } }, 'a', { signal: new AbortController().signal })).hookSpecificOutput.permissionDecision, 'deny');
  answer = true;
  assert.equal((await gate({ tool_name: 'mcp__one__execute_sql', tool_input: { query: 'select 1' } }, 'b', { signal: new AbortController().signal })).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(calls, 2);
  assert.equal((await gate({ tool_name: 'mcp__two__execute_sql', tool_input: {} }, 'c', {})).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(calls, 2);
  answer = false;
  assert.equal((await gate({ tool_name: 'Bash', tool_input: { command: 'psql --version' } }, 'shell', {})).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(calls, 3, 'User-level shell allow rules must not bypass the gated human gate');
  assert.deepEqual(await gate({ tool_name: 'Read', tool_input: { file_path: '/project/README.md' } }, 'read', {}), {});
  assert.deepEqual(claudeProfileOptions({ ...session, gatedServer: '' }, host, servers).mcpServers, {});
  assert.throws(() => claudeProfileOptions({ ...session, gatedServer: 'missing' }, host, servers), /connection/);
  assert.doesNotThrow(() => claudeProfileOptions({ ...session, cwd: os.homedir() }, host, servers));
});

test('fresh context drops elevated permissions but retains the previous task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-fresh-permissions-'));
  const workspace = new Workspace(root, path.resolve('helpers'));
  try {
    const id = workspace.create({ name: 'Fresh', engine: 'claude', cwd: root, profile: 'autonomous' });
    const result = await workspace.send(id, '/clear');
    assert.equal(workspace.store.get(result.id).profile, 'normal');
    assert.equal(workspace.store.get(id).archived, true);
  } finally { await workspace.shutdown(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('home is a valid working folder for creation, permission switching and reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-home-permissions-'));
  const { Store } = await import('../electron/core.mjs'); const store = new Store(root);
  try {
    const s = store.create({ name: 'Home task', cwd: os.homedir(), engine: 'codex', profile: 'autonomous' });
    store.patch(s.id, { profile: 'normal' }); store.patch(s.id, { profile: 'autonomous' }); store.save();
    assert.equal(new Store(root).get(s.id).profile, 'autonomous');
  } finally { clearTimeout(store.timer); fs.rmSync(root, { recursive: true, force: true }); }
});
