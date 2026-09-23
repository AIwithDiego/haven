import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupRoot, createBackupDir } from '../scripts/install-backup.mjs';

test('installation backups go to a private folder outside every repository', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-backup-home-'));
  try {
    const dir = createBackupDir('0.5.1', { home, now: new Date(2026, 8, 23, 21, 48, 7) });
    assert.equal(dir, path.join(fs.realpathSync(home), 'Library/Application Support/Haven Backups/install-0.5.1-20260923-214807'));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(backupRoot(home)).mode & 0o777, 0o700);
    assert.ok(!dir.startsWith(path.resolve('.') + path.sep), 'Never inside the Haven repository');
    assert.ok(!dir.startsWith(path.join(fs.realpathSync(home), 'Library/Application Support/Haven') + path.sep), 'Never inside the data folder an installer copies');
    assert.throws(() => createBackupDir('0.5.1', { home, now: new Date(2026, 8, 23, 21, 48, 7) }), /EEXIST/, 'An existing backup is never reused or overwritten');
    assert.throws(() => createBackupDir('../x', { home }), /version/);
    fs.mkdirSync(path.join(home, '.git'));
    assert.throws(() => createBackupDir('0.5.2', { home }), /inside a repository/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
