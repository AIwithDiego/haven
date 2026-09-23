// Creates the folder for one installation backup (previous app + workspace data),
// outside every repository. Installers take their `backup` path from here.
//
//   node scripts/install-backup.mjs 0.5.1
//   → ~/Library/Application Support/Haven Backups/install-0.5.1-20260923-214807
//
// Backups hold every transcript, attachment and the Electron profile, so they
// must never sit in a working tree that agents search, zip, rsync or `git add -f`.
// The root is a sibling of Haven's data folder, not inside it: installers copy
// the data folder, and a backup inside it would copy every earlier backup too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const backupRoot = (home = os.homedir()) => path.join(home, 'Library/Application Support/Haven Backups');

// True when `folder` or any parent holds a .git entry (a repository or worktree).
function insideRepository(folder) {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}
const stamp = at => {
  const pad = n => String(n).padStart(2, '0');
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
};

/** @param {string} version @param {{home?: string, now?: Date}} [options] @returns {string} the new, empty, 0700 folder */
export function createBackupDir(version, { home = os.homedir(), now = new Date() } = {}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Give the version being installed, e.g. 0.5.1.');
  const root = backupRoot(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
  const real = fs.realpathSync(root);
  if (insideRepository(real)) throw new Error(`Refusing to keep Haven backups inside a repository: ${real}`);
  const dir = path.join(real, `install-${version}-${stamp(now)}`);
  fs.mkdirSync(dir, { mode: 0o700 }); // fails if it already exists
  return dir;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  console.log(createBackupDir(process.argv[2]));
}
