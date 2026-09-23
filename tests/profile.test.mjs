import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults, Store } from '../electron/core.mjs';
import { validateSettings } from '../electron/validation.mjs';
import { isProfilePhoto, normalizeProfileName, readProfilePhoto, MAX_PROFILE_PHOTO_BYTES, MAX_PROFILE_PHOTO_DATA_LENGTH } from '../electron/profile.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=', 'base64');
const photo = `data:image/png;base64,${png.toString('base64')}`;
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('profile name validation trims names and rejects blank, long, and hidden control text', () => {
  assert.equal(normalizeProfileName('  Alex   Rivera '), 'Alex Rivera');
  assert.equal(normalizeProfileName('Zoë 🌻'), 'Zoë 🌻');
  for (const name of ['', '   ', null, 42, 'a'.repeat(81), 'Alex\nRivera', 'Alex\u202ebad']) assert.throws(() => normalizeProfileName(name));
});

test('only bounded embedded PNG avatars survive settings validation', () => {
  assert.equal(isProfilePhoto(photo), true);
  assert.equal(isProfilePhoto(''), true);
  const largeDimensions = Buffer.from(png); largeDimensions.writeUInt32BE(257, 16);
  const invalid = ['https://example.com/photo.png', '/tmp/photo.png', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,broken', `data:image/png;base64,${largeDimensions.toString('base64')}`, `data:image/png;base64,${'A'.repeat(MAX_PROFILE_PHOTO_DATA_LENGTH)}`];
  for (const value of invalid) {
    assert.equal(isProfilePhoto(value), false);
    const notices = [], saved = validateSettings({ profileName: '  Alex Rivera ', profilePhoto: value }, defaults, notices);
    assert.equal(saved.profileName, 'Alex Rivera'); assert.equal(saved.profilePhoto, ''); assert.ok(notices.some(n => n.includes('profile photo')));
  }
  const notices = [], saved = validateSettings({ profileName: '', profilePhoto: photo }, defaults, notices);
  assert.equal(saved.profileName, 'You'); assert.equal(saved.profilePhoto, photo); assert.ok(notices.some(n => n.includes('profile name')));
});

test('profile persists through a real workspace save, restart, and photo removal', t => {
  const root = temporary(t), store = new Store(root);
  assert.equal(store.state.settings.profileName, 'You'); assert.equal(store.state.settings.profilePhoto, '');
  store.state.settings.profileName = 'Alex Rivera'; store.state.settings.profilePhoto = photo;
  assert.equal(store.save(), true);
  const restored = new Store(root);
  assert.equal(restored.state.settings.profileName, 'Alex Rivera'); assert.equal(restored.state.settings.profilePhoto, photo);
  restored.state.settings.profilePhoto = ''; assert.equal(restored.save(), true);
  assert.equal(new Store(root).state.settings.profilePhoto, '');
});

test('choosing a photo crops and resizes a copy and preserves original bytes', async t => {
  const root = temporary(t), file = path.join(root, 'portrait.png'); fs.writeFileSync(file, png);
  const calls = [];
  const image = { isEmpty: () => false, getSize: () => ({ width: 2048, height: 1024 }), crop: bounds => { calls.push(bounds); return image; }, resize: options => { calls.push(options); return image; }, toPNG: () => png };
  const result = await readProfilePhoto(file, { createFromBuffer: bytes => { assert.deepEqual(bytes, png); return image; } });
  assert.equal(result, photo); assert.deepEqual(calls, [{ x: 512, y: 0, width: 1024, height: 1024 }, { width: 256, height: 256, quality: 'best' }]);
  assert.deepEqual(fs.readFileSync(file), png);
});

test('photo import rejects unsupported, oversized, corrupt, and huge images without changing saved settings', async t => {
  const root = temporary(t), file = path.join(root, 'portrait.png');
  const shouldNotDecode = { createFromBuffer: () => { throw new Error('should not decode'); } };
  await assert.rejects(readProfilePhoto('relative.png', shouldNotDecode), /Choose a PNG or JPEG/);
  await assert.rejects(readProfilePhoto(path.join(root, 'photo.svg'), shouldNotDecode), /Choose a PNG or JPEG/);
  fs.writeFileSync(file, '<svg/>'); await assert.rejects(readProfilePhoto(file, shouldNotDecode), /Choose a PNG or JPEG/);
  fs.truncateSync(file, MAX_PROFILE_PHOTO_BYTES + 1); await assert.rejects(readProfilePhoto(file, shouldNotDecode), /smaller than 15 MB/);
  fs.writeFileSync(file, png);
  await assert.rejects(readProfilePhoto(file, { createFromBuffer: () => ({ isEmpty: () => true }) }), /could not be opened/);
  await assert.rejects(readProfilePhoto(file, { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 20000, height: 20000 }) }) }), /40 megapixels/);
});
