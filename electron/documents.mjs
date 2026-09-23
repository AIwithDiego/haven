import fs from 'node:fs/promises';
import path from 'node:path';
import { readMarkdown, readBounded, rasterType } from './markdown.mjs';

export const documentExtensions = ['md', 'markdown', 'csv', 'tsv', 'txt', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'swift', 'sql', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'ini', 'conf', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
export const isDocumentPath = value => typeof value === 'string' && (documentExtensions.includes(path.extname(value).slice(1).toLowerCase()) || ['Dockerfile', 'Makefile', 'LICENSE', 'README', '.gitignore'].includes(path.basename(value)));

// Quoted commas, CRLF, escaped quotes and embedded newlines are handled without
// evaluating cells. Bound the table returned to the renderer as well as the file.
export function parseDelimited(content, delimiter = ',') {
  const rows = []; let row = [], cell = '', quoted = false, totalRows = 0, maxColumns = 0, cells = 0;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => {
    endCell(); totalRows++; maxColumns = Math.max(maxColumns, row.length);
    if (rows.length < 10000 && cells + Math.min(row.length, 200) <= 100000) { rows.push(row.slice(0, 200)); cells += Math.min(row.length, 200); }
    row = [];
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (quoted && content[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else cell += ch;
    } else if (ch === delimiter && !quoted) endCell();
    else if ((ch === '\n' || ch === '\r') && !quoted) { endRow(); if (ch === '\r' && content[i + 1] === '\n') i++; }
    else cell += ch;
  }
  if (cell || row.length || (content && !/[\r\n]$/.test(content))) endRow();
  return { rows, totalRows, columns: Math.min(maxColumns, 200), truncated: totalRows > rows.length || maxColumns > 200, warning: quoted ? 'An unfinished quoted cell was found. Check the source file.' : '' };
}

export async function documentPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 16384 || /[\x00-\x1f]/.test(value)) throw new Error('Choose a local file.');
  let resolved;
  try { resolved = await fs.realpath(value); } catch { throw new Error('This file is missing or cannot be accessed.'); }
  if (!isDocumentPath(resolved)) throw new Error('This file type opens in its default app.');
  return resolved;
}

export async function readDocument(value, fragment = '') {
  const resolved = await documentPath(value), extension = path.extname(resolved).slice(1).toLowerCase();
  if (['md', 'markdown'].includes(extension)) return readMarkdown(resolved, fragment);
  const { bytes, info } = await readBounded(resolved, images.has(extension) ? 5 * 1024 * 1024 : 2 * 1024 * 1024, 'This file');
  const base = { path: resolved, name: path.basename(resolved), size: bytes.length, modifiedAt: info.mtimeMs, fragment };
  if (images.has(extension)) {
    const type = rasterType(bytes);
    if (!type || !type.width || !type.height || type.width * type.height > 20000000) throw new Error('This image is invalid or exceeds the 20 megapixel preview limit.');
    return { ...base, kind: 'image', content: '', data: `data:${type.mime};base64,${bytes.toString('base64')}`, width: type.width, height: type.height };
  }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Save this file as UTF-8 text to preview it in Haven.'); }
  if (content.includes('\0')) throw new Error('This file contains binary data and cannot be previewed as text.');
  const table = ['csv', 'tsv'].includes(extension) ? parseDelimited(content, extension === 'tsv' ? '\t' : ',') : undefined;
  return { ...base, kind: table ? 'table' : 'text', content, table, extension };
}

export async function documentLinkBase(value) {
  const resolved = await documentPath(value);
  if (!(await fs.stat(resolved)).isFile()) throw new Error('This document is no longer available.');
  return path.dirname(resolved);
}
