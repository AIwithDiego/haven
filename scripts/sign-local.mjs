import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { signAsync } from '@electron/osx-sign';

// Personal local identity; no Developer ID, upload, notarization or TCC reset.
const root = path.resolve('release');
const app = path.join(root, `mac${process.arch === 'arm64' ? '-arm64' : ''}`, 'Haven.app');
if (process.platform !== 'darwin' || !fs.existsSync(path.join(app, 'Contents/MacOS/Haven'))) {
  throw new Error('Build the macOS Haven app before signing.');
}
if (!fs.realpathSync(app).startsWith(root + path.sep)) throw new Error('Refusing to sign outside the candidate build directory.');
const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
const matches = [...identities.matchAll(/([A-F0-9]{40}) "Haven Local"/g)];
if (matches.length !== 1) throw new Error('One valid Haven Local identity is required. Run node scripts/setup-signing.mjs once; do not regenerate the certificate between builds.');
await signAsync({ app, identity: matches[0][1], identityValidation: false, platform: 'darwin', type: 'development',
  preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  optionsForFile: () => ({ hardenedRuntime: true, entitlements: path.resolve('build/entitlements.mac.plist'), timestamp: 'none' }),
});
execFileSync(process.execPath, ['scripts/signature-smoke.mjs', app], { stdio: 'inherit' });
