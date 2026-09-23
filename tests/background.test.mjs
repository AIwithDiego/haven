import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter, CodexAdapter } from '../electron/agents.mjs';

test('Claude reports background task lifecycle without adding child text to the conversation', async () => {
  const updates = [], text = [], session = { id: 'task' };
  const host = { background: (id, work) => updates.push(work), persist() {}, disconnected() {}, completeText: (...args) => text.push(args), activity() {} };
  const adapter = new ClaudeAdapter(host);
  const client = { query: (async function* () {
    yield { type: 'system', subtype: 'task_started', task_id: 'child', description: 'Research sources', subagent_type: 'researcher' };
    yield { type: 'system', subtype: 'task_progress', task_id: 'child', description: 'Research sources', summary: 'Checking sources', usage: { total_tokens: 20, tool_uses: 2, duration_ms: 300 } };
    yield { type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'text', text: 'private child output' }] } };
    yield { type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed', summary: 'Sources checked' };
  })() };
  adapter.clients.set(session.id, client); await adapter.consume(session, client);
  assert.equal(updates.length, 3); assert.equal(updates[0].status, 'running'); assert.equal(updates[1].summary, 'Checking sources'); assert.equal(updates[2].status, 'completed'); assert.equal(text.length, 0);
});

test('Codex collaboration reports each receiver and keeps child completion separate', async () => {
  const updates = [], finished = [];
  const adapter = new CodexAdapter({ background: (id, work) => updates.push(work), activity() {}, finish: (...args) => finished.push(args) });
  adapter.threads.set('parent', 'task');
  await adapter.receive({ method: 'item/completed', params: { threadId: 'parent', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], agentsStates: { child: { status: 'running', message: null } }, prompt: 'Review accessibility' } } });
  await adapter.receive({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
  assert.equal(updates[0].id, 'child'); assert.equal(updates[0].status, 'running'); assert.equal(updates.at(-1).status, 'completed'); assert.equal(finished.length, 0);
});
