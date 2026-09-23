import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const app = path.resolve(process.argv[2] || 'release/mac-arm64/Haven.app');
const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
assert.equal(verify.status, 0, verify.stderr);
const display = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', '--requirements', '-', app], { encoding: 'utf8' });
assert.equal(display.status, 0, display.stderr);
const info = display.stdout + display.stderr;
assert.doesNotMatch(info, /Signature=adhoc/, 'A rebuild must not acquire a new ad-hoc identity');
assert.match(info, /Authority=Haven Local/);
assert.match(info, /flags=.*runtime/);
assert.match(info, /identifier "local\.haven\.workspace"/);
const requirement = info.split('\n').find(line => line.startsWith('designated =>'));
assert.ok(requirement && !requirement.includes('cdhash'), 'Identity must survive binary changes');
// Fuses close the ELECTRON_RUN_AS_NODE / NODE_OPTIONS / --inspect paths to Haven's TCC grants.
const fuses = spawnSync(process.execPath, [path.resolve('node_modules/@electron/fuses/dist/bin.js'), 'read', '--app', app], { encoding: 'utf8' });
assert.equal(fuses.status, 0, fuses.stderr);
for (const [fuse, state] of [['RunAsNode', 'Disabled'], ['EnableNodeOptionsEnvironmentVariable', 'Disabled'], ['EnableNodeCliInspectArguments', 'Disabled'], ['EnableEmbeddedAsarIntegrityValidation', 'Enabled'], ['OnlyLoadAppFromAsar', 'Enabled'], ['GrantFileProtocolExtraPrivileges', 'Disabled']]) {
  assert.match(fuses.stdout, new RegExp(`${fuse} is .*${state}`), `${fuse} must be ${state}`);
}
console.log(JSON.stringify({ ok: true, app, requirement }));
