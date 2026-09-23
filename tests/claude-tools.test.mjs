import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeToolOptions } from '../electron/agents.mjs';
test('Claude opts SDK sessions into artifacts and keeps only the profile allow rules', () => {
  const options = claudeToolOptions({ allowedTools: ['Read'] }, { HOME: '/tmp', CLAUDE_CODE_ARTIFACT: '0' });
  assert.equal(options.env.CLAUDE_CODE_ARTIFACT, '0');
  assert.equal(claudeToolOptions({}, {}).env.CLAUDE_CODE_ARTIFACT, '1');
  assert.deepEqual(options.allowedTools, ['Read']);
  assert.equal(claudeToolOptions({ settingSources: ['user'] }, {}).allowedTools, undefined, 'Normal must not gain unscoped Grep or Glob');
  assert.deepEqual(options.tools, { type: 'preset', preset: 'claude_code' });
});
