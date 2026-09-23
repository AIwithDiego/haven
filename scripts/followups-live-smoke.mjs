import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Workspace } from '../electron/workspace.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-followups-live-'));
process.env.HAVEN_TEST_MODE = '1'; process.env.HAVEN_DATA_DIR = root;
const w = new Workspace(root, path.resolve('helpers')), results = {};
const timeout = setTimeout(() => { console.error('Live follow-up check timed out.'); void w.shutdown().finally(() => process.exit(1)); }, 170000);
async function until(predicate, ms = 60000) { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for provider state'); await delay(100); } }
try {
  for (const engine of process.argv.includes('--claude-only') ? ['claude'] : ['codex', 'claude']) {
    const id = w.create({ name: `Haven ${engine} follow-up transport check`, engine, cwd: root, profile: 'normal' }), s = w.store.get(id);
    // No data tools or project files are used. The only allowed tool is a sleep
    // in this isolated temporary directory, to create a real mid-turn boundary.
    const answer = async () => {
      if (s.approval) w.answer(id, { requestId: s.approval.id, allow: /sleep\s+4/.test(s.approval.details || s.approval.title) });
    };
    const approvalTimer = setInterval(answer, 100);
    try {
      await w.send(id, 'This is a Haven transport test in an empty temporary directory. Use your shell tool exactly once to run `sleep 4`. Do not inspect or edit any files, call MCP tools, use network tools, or spawn agents. After the sleep, reply with HAVEN_INITIAL_OK. Follow later user input if it arrives.');
      await until(() => s.messages.some(m => m.role === 'activity' && /sleep\s+4/.test(m.title + ' ' + m.text)) || s.status === 'error');
      assert.notEqual(s.status, 'error', s.error);
      assert.equal(s.status === 'working' || s.status === 'waiting', true);
      if (s.approval) await answer();
      await w.send(id, `Follow-up: include HAVEN_${engine.toUpperCase()}_FOLLOWUP_OK in your final reply. Do not use any more tools.`);
      await until(() => ['idle', 'error'].includes(s.status) && !s.pendingMessages?.length, 65000);
      assert.equal(s.status, 'idle', s.error);
      const text = s.messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
      assert.match(text, new RegExp(`HAVEN_${engine.toUpperCase()}_FOLLOWUP_OK`));
      const inventory = await w.connections(id);
      results[engine] = { receivedFollowup: true, delivery: s.messages.filter(m => m.role === 'user').at(-1).delivery, connectionSource: inventory.source, servers: inventory.servers.length, tools: inventory.servers.reduce((sum, server) => sum + server.tools.length, 0), statuses: Object.fromEntries([...new Set(inventory.servers.map(server => server.status))].map(status => [status, inventory.servers.filter(server => server.status === status).length])) };
      console.log(JSON.stringify({ engine, ...results[engine] }));
      fs.mkdirSync('artifacts/checks', { recursive: true });
      fs.writeFileSync(`artifacts/checks/0.5.0-live-${engine}.json`, JSON.stringify({ checkedAt: new Date().toISOString(), ...results[engine] }, null, 2));
    } finally { clearInterval(approvalTimer); }
  }
  fs.mkdirSync('artifacts/checks', { recursive: true });
  fs.writeFileSync('artifacts/checks/0.5.0-live-followups.json', JSON.stringify({ checkedAt: new Date().toISOString(), ...results }, null, 2));
} finally { clearTimeout(timeout); await w.shutdown(); }
