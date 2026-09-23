import test from 'node:test';
import assert from 'node:assert/strict';
import { registerVoiceToggle } from '../electron/voice-shortcuts.mjs';
test('independent voice toggle starts and stops only a ready helper and reports registration failure', () => {
  let callback, status = 'loading'; const commands = [];
  const shortcuts = { register: (key, fn) => { assert.equal(key, 'CommandOrControl+Shift+Space'); callback = fn; return true; } };
  assert.equal(registerVoiceToggle(shortcuts, () => status, command => commands.push(command)), true);
  callback(); status = 'ready'; callback(); status = 'recording'; callback(); status = 'transcribing'; callback();
  assert.deepEqual(commands, ['start', 'stop']);
  assert.equal(registerVoiceToggle({ register: () => false }, () => 'ready', () => {}), false);
});
