// Test preload: puts stand-in `claude` and `codex` executables on PATH so the
// suite runs on machines without the real CLIs installed (CI, fresh clones).
// Tests mock child_process.spawn, so these stubs are only ever located, never
// relied on for behaviour. A real install found earlier on PATH still wins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-fake-cli-'));
for (const name of ['claude', 'codex']) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\necho "stub $0 $*" >&2\nexit 0\n', { mode: 0o755 });
}
process.env.PATH = `${process.env.PATH || '/usr/bin:/bin'}:${dir}`;
