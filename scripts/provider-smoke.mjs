import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Workspace } from '../electron/workspace.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-provider-'));
process.env.HAVEN_TEST_MODE = '1'; process.env.HAVEN_DATA_DIR = root;
let workspace = new Workspace(root, path.resolve('helpers'));
const results = {};
const ids = {};
const engines = process.argv.includes('--codex-only') ? ['codex'] : ['codex', 'claude'];
workspace.on('log', message => { if (/error|failed/i.test(message)) console.error(message.slice(0, 500)); });
const timeout = setTimeout(() => { console.error('Provider check timed out'); workspace.shutdown().finally(() => process.exit(1)); }, 120000);
try {
  const models = await workspace.codex.models();
  results.codex = { connected: true, modelCount: models.length, models: models.map(m => m.value) };
  console.log('Codex handshake and model discovery passed.');
  const discovered = await workspace.claude.models();
  assert.ok(discovered.length > 0);
  const id = workspace.create({ name: 'Haven Claude connection check', engine: 'claude', cwd: root, profile: 'normal' });
  const client = await workspace.claude.open(workspace.store.get(id));
  const claudeModels = await client.query.supportedModels();
  results.claude = { connected: true, modelCount: claudeModels.length, models: claudeModels.map(m => m.value) };
  console.log('Claude handshake and model discovery passed.');
  async function sendAndWait(sid, text) {
    const before = workspace.store.get(sid).messages.length;
    const completed = new Promise((resolve, reject) => {
      const listener = event => {
        if (event.id !== sid || ['working', 'waiting', 'starting'].includes(workspace.store.get(sid).status)) return;
        workspace.off('attention', listener); const s = workspace.store.get(sid);
        s.error ? reject(new Error(s.error)) : resolve(s.messages.slice(before).filter(m => m.role === 'assistant').map(m => m.text).join('\n'));
      };
      workspace.on('attention', listener);
    });
    await workspace.send(sid, text, []); return completed;
  }
  if (process.argv.includes('--conversation') || process.argv.includes('--resume')) {
    for (const engine of engines) {
      const sid = engine === 'claude' ? id : workspace.create({ name: 'Haven Codex response check', engine, cwd: root, profile: 'autonomous' });
      ids[engine] = sid;
      results[engine].response = await sendAndWait(sid, `This is a transport verification. Reply with exactly HAVEN_${engine.toUpperCase()}_OK. Do not invoke any tools, inspect files, or change anything.`);
      assert.match(results[engine].response, new RegExp(`HAVEN_${engine.toUpperCase()}_OK`));
      results[engine].remoteId = workspace.store.get(sid).remoteId;
      console.log(`${engine} response received: ${results[engine].response.slice(0, 150)}`);
    }
  }
  if (process.argv.includes('--resume')) {
    await workspace.shutdown();
    workspace = new Workspace(root, path.resolve('helpers'));
    for (const engine of engines) {
      const response = await sendAndWait(ids[engine], 'Repeat the exact verification marker you replied with earlier in this conversation. Reply with the marker alone. Do not use any tools.');
      assert.match(response, new RegExp(`HAVEN_${engine.toUpperCase()}_OK`));
      assert.equal(workspace.store.get(ids[engine]).remoteId, results[engine].remoteId);
      results[engine].resumedSameConversation = true;
      console.log(`${engine} resumed the same conversation and recalled its previous marker.`);
    }
  }
  for (const result of Object.values(results)) delete result.remoteId;
  console.log(JSON.stringify(results, null, 2));
} finally { clearTimeout(timeout); await workspace.shutdown(); }
