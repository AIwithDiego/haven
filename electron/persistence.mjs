import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function loadWorkspace(file, validate) {
  const storage = { notices: [], saveError: '', readOnly: false };
  const read = name => validate(JSON.parse(fs.readFileSync(name, 'utf8')), storage.notices);
  if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return { storage, recovered: false };
  try { return { saved: read(file), storage, recovered: false }; }
  catch {
    storage.notices = [];
    try {
      const saved = read(file + '.bak');
      storage.notices.unshift('Haven recovered the last readable workspace backup. The damaged file will be preserved for recovery; recent changes may be missing.');
      return { saved, storage, recovered: true };
    } catch {
      storage.notices = ['Haven could not read the workspace or its backup. Both files and all attachments are preserved. Repair or restore workspace.json, then reopen Haven.'];
      storage.readOnly = true;
      return { storage, recovered: false };
    }
  }
}
function flushedWrite(file, data) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function saveWorkspace(file, state, recovered) {
  const temp = `${file}.tmp-${randomUUID()}`, backupTemp = `${file}.bak.tmp-${randomUUID()}`;
  try {
    const data = JSON.stringify(state);
    flushedWrite(temp, data);
    if (fs.existsSync(file)) {
      if (recovered) fs.renameSync(file, `${file}.corrupt-${Date.now()}-${randomUUID()}`);
      else {
        const previous = fs.readFileSync(file, 'utf8'); JSON.parse(previous);
        flushedWrite(backupTemp, previous); fs.renameSync(backupTemp, file + '.bak');
      }
    } else if (!fs.existsSync(file + '.bak')) { flushedWrite(backupTemp, data); fs.renameSync(backupTemp, file + '.bak'); }
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error; } finally { fs.closeSync(directory); }
  } finally {
    for (const name of [temp, backupTemp]) { try { fs.rmSync(name, { force: true }); } catch { /* Preserve recoverability even when cleanup fails. */ } }
  }
}
