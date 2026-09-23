import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MARKDOWN_BYTES = 1024 * 1024;
export const MAX_MARKDOWN_IMAGE_BYTES = 5 * 1024 * 1024;
export const isMarkdownPath = value => typeof value === 'string' && /\.(md|markdown)$/i.test(value);

async function markdownPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f]/.test(value) || value.length > 16384) throw new Error('Choose a local Markdown file.');
  let resolved;
  try { resolved = await fs.realpath(value); } catch { throw new Error('This Markdown file is missing or cannot be accessed.'); }
  if (!isMarkdownPath(resolved)) throw new Error('Choose a .md or .markdown file.');
  return resolved;
}

export async function readBounded(file, maxBytes, label) {
  // Nonblocking open also avoids hanging on a named pipe swapped in after resolution.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} must be a regular file.`);
    if (info.size > maxBytes) throw new Error(`${label} is too large to preview (limit ${Math.round(maxBytes / 1024 / 1024)} MB).`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > maxBytes) throw new Error(`${label} grew too large to preview.`);
    return { bytes: buffer.subarray(0, size), info };
  } finally { await handle.close(); }
}

export async function readMarkdown(value, fragment = '') {
  const resolved = await markdownPath(value);
  const { bytes, info } = await readBounded(resolved, MAX_MARKDOWN_BYTES, 'This Markdown file');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('This file is not UTF-8 text. Save it as UTF-8 to read it in Haven.'); }
  if (content.includes('\0')) throw new Error('This file contains binary data and cannot be read as Markdown.');
  return { kind: 'markdown', path: resolved, name: path.basename(resolved), content, size: bytes.length, modifiedAt: info.mtimeMs, fragment };
}

export async function markdownLinkBase(value) {
  const resolved = await markdownPath(value);
  if (!(await fs.stat(resolved)).isFile()) throw new Error('This Markdown document is no longer available.');
  return path.dirname(resolved);
}

export function rasterType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return { mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { mime: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L' && bytes[20] === 0x2f) return { mime: 'image/webp', width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return { mime: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  return null;
}

export async function readMarkdownImage(documentPath, source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 16384 || /[\u0000-\u001f]/.test(source) || source.startsWith('//')) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^file:/i.test(source)) return null;
  const base = await markdownLinkBase(documentPath);
  let imagePath;
  try {
    imagePath = /^file:/i.test(source) ? fileURLToPath(new URL(source)) : path.resolve(base, decodeURIComponent(source));
    imagePath = await fs.realpath(imagePath);
  } catch { return null; }
  const relative = path.relative(base, imagePath);
  // An embedded image cannot use symlinks or ../ to read outside this document's folder.
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !/\.(png|jpe?g|gif|webp)$/i.test(imagePath)) return null;
  const { bytes } = await readBounded(imagePath, MAX_MARKDOWN_IMAGE_BYTES, 'This image');
  const type = rasterType(bytes);
  if (!type || !type.width || !type.height || type.width * type.height > 20_000_000) return null;
  return `data:${type.mime};base64,${bytes.toString('base64')}`;
}
