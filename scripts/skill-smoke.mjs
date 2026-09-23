// Two bounded live skill invocations in temporary folders. No user-project files are used.
import { Workspace } from '../electron/workspace.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-live-skills-'));
process.env.HAVEN_TEST_MODE = '1'; process.env.HAVEN_DATA_DIR = root;
for (const folder of ['.agents', '.claude']) {
  const skill = path.join(root, folder, 'skills', 'haven-smoke-check'); fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: haven-smoke-check\ndescription: Verify native Haven skill dispatch with a fixed response.\n---\nDo not call tools or read or edit any files. Reply with exactly HAVEN_NATIVE_SKILL_OK.\n');
}
const w = new Workspace(path.join(root, 'data'), path.resolve('helpers'));
let failed = false;
try {
  for (const engine of ['codex', 'claude']) {
    const id = w.create({ name: 'Native skill check', engine, cwd: root });
    w.create({ name: 'Shared-folder awareness check', engine: engine === 'codex' ? 'claude' : 'codex', cwd: root });
    const catalog = await w.listCommands(id); const command = catalog.commands.find(c => c.name === 'haven-smoke-check');
    if (!command) { failed = true; console.log(JSON.stringify({ engine, ok: false, error: catalog.error || 'Test skill not discovered' })); continue; }
    await w.send(id, '/haven-smoke-check');
    const s = w.store.get(id), deadline = Date.now() + 45000;
    while (['working', 'waiting', 'starting'].includes(s.status) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    if (['working', 'waiting', 'starting'].includes(s.status)) { failed = true; await w.stop(id); console.log(JSON.stringify({engine, ok:false, error:'Live check exceeded 45 seconds'})); }
    else { const ok = s.messages.some(m => m.role === 'assistant' && m.text.includes('HAVEN_NATIVE_SKILL_OK')); failed ||= !ok; console.log(JSON.stringify({ engine, ok, status: s.status, error: s.error })); }
  }
} finally { await w.shutdown(); }
if (failed) process.exitCode = 1;
