import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// A clicked document may open in its default viewer; executable/unknown types
// are revealed in Finder rather than launched.
const documents = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.tif', '.tiff', '.bmp', '.svg', '.pdf', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.m4a']);
/** @returns {Promise<{kind:'external',url:string}|{kind:'local',path:string,action:string,fragment?:string}>} */
export async function resolveLink(value, cwd) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16384 || /[\u0000-\u001f]/.test(value)) throw new Error('This link is empty or invalid.');
  const href = value.trim();
  if (/^(https?:|mailto:)/i.test(href)) {
    try { return { kind: 'external', url: new URL(href).href }; }
    catch { throw new Error('This web link is invalid.'); }
  }
  if (href.startsWith('//')) throw new Error('Use a full https:// web address.');
  let file, fragment = '';
  if (/^file:/i.test(href)) {
    try { const url = new URL(href); if (url.host && url.host !== 'localhost') throw new Error(); file = fileURLToPath(url); fragment = url.hash.slice(1); }
    catch { throw new Error('This local file link is invalid.'); }
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(href)) throw new Error('This type of link is not supported.');
    try { file = decodeURIComponent(href); } catch { file = href; }
    if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
    if (!path.isAbsolute(file)) {
      if (!cwd || !path.isAbsolute(cwd)) throw new Error('This relative file link needs a task folder.');
      file = path.resolve(cwd, file);
    }
  }
  // Preserve actual filenames containing # or : before interpreting source-line suffixes.
  let info = await fs.stat(file).catch(() => null);
  if (!info) {
    const heading = file.match(/^(.*\.(?:md|markdown))#(.+)$/i);
    if (heading) {
      const candidate = await fs.stat(heading[1]).catch(() => null);
      if (candidate) { file = heading[1]; fragment = heading[2]; info = candidate; }
    }
  }
  if (!info) {
    const withoutLocation = file.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/, '');
    if (withoutLocation !== file) { file = withoutLocation; info = await fs.stat(file).catch(() => null); }
  }
  if (!info) throw new Error('This file is missing or cannot be accessed. It may have been moved or deleted.');
  const resolved = await fs.realpath(file);
  return { kind: 'local', path: resolved, ...(fragment ? { fragment } : {}), action: info.isFile() && !(info.mode & 0o111) && documents.has(path.extname(resolved).toLowerCase()) ? 'open' : 'reveal' };
}
// Folders and files that hold credentials. A chat link into one of these asks
// first even when it would open in Haven Reader.
const secretFolders = ['.ssh', '.aws', '.gnupg', '.config', '.claude', '.kube', '.docker', '.azure', 'Library/Keychains'];
const secretFile = /(?:\.(?:pem|key|p12|pfx|keychain-db)|^\.env(?:\..*)?|^\.netrc|^id_[a-z0-9]+)$/i;
const within = (root, target) => target === root || target.startsWith(root + path.sep);
const real = value => { try { return fsSync.realpathSync(value); } catch { return path.resolve(value); } };
/** For a local link from chat or from a document in Haven Reader: null when it
 * stays in the task folder, otherwise why to ask. `target` is the real path
 * resolveLink returned. A credential folder counts as inside only when the task
 * itself works in that folder (a task in ~ still asks before ~/.config). */
export function localLinkReview(target, cwd, home = os.homedir()) {
  const root = cwd && path.isAbsolute(cwd) ? real(cwd) : '';
  const inFolder = !!root && within(root, target);
  const homeReal = real(home);
  const secretFolder = secretFolders.map(folder => real(path.join(homeReal, folder))).find(folder => within(folder, target));
  if (secretFile.test(path.basename(target)) || (secretFolder && !(inFolder && within(secretFolder, root)))) return { kind: 'sensitive', path: target };
  return inFolder ? null : { kind: 'outside', path: target };
}
/** The folder a link inside a Reader document is judged against: the deepest
 * task folder that holds the document (an agent can write there), otherwise
 * the document's own folder. */
export function readerScope(documentFile, taskFolders = []) {
  const doc = real(documentFile);
  const holders = taskFolders.filter(folder => typeof folder === 'string' && path.isAbsolute(folder)).map(real).filter(folder => within(folder, doc));
  return holders.sort((a, b) => b.length - a.length)[0] || path.dirname(doc);
}
// Agent-written links can carry data they have read: in the query string or
// fragment, but also in path segments or subdomain labels. Any of these signals
// confirms the destination first, showing the full URL.
export const LINK_DATA_LIMIT = 100;   // query + fragment characters
export const LINK_PART_LIMIT = 32;    // one path segment or host label
export const LINK_HOST_LIMIT = 80;    // whole host name
export const LINK_LENGTH_LIMIT = 200; // whole URL
export const carriedData = href => { const url = new URL(href); return url.search.length + url.hash.length; };
const entropy = value => { const counts = {}; for (const c of value) counts[c] = (counts[c] || 0) + 1; return Object.values(counts).reduce((sum, n) => sum - n / value.length * Math.log2(n / value.length), 0); };
/** Hex, or base64/base32-like text: one unbroken token of mixed letters and digits with high character entropy. */
export const encodedBlob = part => part.length >= 16 && (/^[0-9a-f]+$/i.test(part) && /\d/.test(part) && /[a-f]/i.test(part)
  || /^[A-Za-z0-9+/_=-]+$/.test(part) && /[A-Za-z]/.test(part) && /\d/.test(part) && (part.match(/[-_]/g) || []).length <= part.length / 12 && entropy(part) >= 3.5);
// Article slugs made of plain words (how-do-i-undo-a-commit) are allowed up to LINK_DATA_LIMIT.
const wordSlug = part => part.split(/[-_]/).every(word => /^[a-z]{1,15}$/i.test(word) || /^\d{1,4}$/.test(word));
/** Why a web link may carry data: 'query', 'path', 'host' or 'length'; empty when it looks plain. */
export function linkDataSignals(href) {
  const url = new URL(href), signals = [];
  if (carriedData(url.href) > LINK_DATA_LIMIT) signals.push('query');
  const segments = url.pathname.split('/').filter(Boolean).map(segment => { try { return decodeURIComponent(segment); } catch { return segment; } });
  if (segments.some(segment => segment.length > (wordSlug(segment) ? LINK_DATA_LIMIT : LINK_PART_LIMIT) || encodedBlob(segment))) signals.push('path');
  if (url.hostname.length > LINK_HOST_LIMIT || url.hostname.split('.').some(label => label.length > LINK_PART_LIMIT || encodedBlob(label))) signals.push('host');
  if (url.href.length > LINK_LENGTH_LIMIT) signals.push('length');
  return signals;
}
/** `confirm` decides whether a flagged link opens; without one, flagged links are refused.
 * @param {(request: {kind: string, url?: string, carried?: number, signals?: string[], path?: string, reason?: string}) => Promise<boolean>} [confirm] */
export async function openLink(value, cwd, shell, confirm = async () => false) {
  const target = await resolveLink(value, cwd);
  if (target.kind === 'external') {
    const signals = linkDataSignals(target.url);
    if (signals.length && !(await confirm({ kind: 'data', url: target.url, carried: carriedData(target.url), signals }))) return;
    await shell.openExternal(target.url); return;
  }
  if (target.action === 'reveal') { shell.showItemInFolder(target.path); return; }
  const error = await shell.openPath(target.path);
  if (error) throw new Error('macOS could not open this file. Try opening it from Finder.');
}
