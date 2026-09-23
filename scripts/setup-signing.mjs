// One-time local signing identity. Never called by builds or app startup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('Local signing requires macOS.');
process.umask(0o077);
const identity = 'Haven Local';
const run = (bin, args) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`${path.basename(bin)} failed: ${String(error.stderr || 'macOS signing setup needs attention').slice(0, 1200)}`); }
};
const identities = () => run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
// Private key material lives outside the repository, in an absolute folder you
// choose with HAVEN_SIGNING_DIR.
const configured = process.env.HAVEN_SIGNING_DIR;
const root = configured && path.isAbsolute(configured) ? path.resolve(configured) : '';
if (identities().includes(`"${identity}"`)) {
  console.log('Reusing the existing Haven Local identity.');
  // Identities created before the key was removed after import still have a plaintext copy.
  if (root && fs.existsSync(path.join(root, 'Haven-Local.key'))) console.log(`Note: a plaintext copy of the Haven Local private key is still at ${path.join(root, 'Haven-Local.key')}. The keychain holds the identity; once your keychain is backed up, you can delete that file.`);
} else {
  if (!root) throw new Error('Set HAVEN_SIGNING_DIR to an absolute folder outside this repository for the signing key and certificate.');
  const repo = fs.realpathSync(process.cwd());
  if (root === repo || root.startsWith(repo + path.sep)) throw new Error('HAVEN_SIGNING_DIR must be outside the repository.');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cert = path.join(root, 'Haven-Local.crt'), key = path.join(root, 'Haven-Local.key');
  if (fs.existsSync(cert) && !fs.existsSync(key)) throw new Error('A Haven Local certificate exists but its private key was removed after import and the keychain no longer has the identity. Restore the identity from a keychain backup, or delete Haven-Local.crt to create a new identity (macOS will ask for permissions again).');
  if (!fs.existsSync(cert) && fs.existsSync(key)) throw new Error('Incomplete signing identity: Haven-Local.key exists without its certificate. Recover it instead of generating a new identity.');
  const config = path.join(root, 'certificate.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=signing\nprompt=no\n[dn]\nCN=Haven Local\n[signing]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n', { mode: 0o600 });
  if (!fs.existsSync(cert)) run('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:3072', '-x509', '-nodes', '-days', '3650', '-config', config, '-keyout', key, '-out', cert]);
  const password = randomBytes(32).toString('hex'), passwordFile = path.join(root, 'import-password'), archive = path.join(root, 'identity.p12');
  fs.writeFileSync(passwordFile, password, { mode: 0o600 });
  try {
    run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-name', identity, '-out', archive, '-passout', `file:${passwordFile}`]);
    const keychain = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
    run('/usr/bin/security', ['import', archive, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, cert]);
    if (!identities().includes(`"${identity}"`)) throw new Error('Haven Local needs approval in Keychain Access before signing.');
    // The private key now lives only in the login keychain. Remove the plaintext copy.
    fs.rmSync(key, { force: true }); fs.rmSync(config, { force: true });
    console.log('Haven Local is ready. Its private key is in your login keychain only; back up the keychain. Builds reuse this identity.');
  } finally {
    fs.rmSync(passwordFile, { force: true }); fs.rmSync(archive, { force: true });
  }
}
