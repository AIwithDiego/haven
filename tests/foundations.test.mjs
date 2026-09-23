import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('direct dependency versions exactly match the lockfile without moving resolved packages', () => {
  const manifest = JSON.parse(fs.readFileSync('package.json'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json'));
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section])) {
      assert.match(version, /^\d+\.\d+\.\d+(?:[-+].+)?$/, name);
      assert.equal(version, lock.packages[`node_modules/${name}`].version, name);
      assert.equal(version, lock.packages[''][section][name], name);
    }
  }
});
